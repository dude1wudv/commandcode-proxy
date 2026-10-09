import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApplication } from '../lib/application.mjs';
import { Repository } from '../lib/repository.mjs';
import { Scheduler } from '../lib/scheduler.mjs';
import { quotaError } from '../lib/quota-error.mjs';
import { mapCcError, mapCcEventError, runProtocol } from '../protocols.mjs';

const failure = { success: false, error: { code: 'BAD_REQUEST', message: 'You have insufficient credits to make this request. private-user-fixture' } };
const masterKey = Buffer.alloc(32, 31);
const fields = { name: 'synthetic', enabled: true, priority: 0, load_factor: 1, max_concurrency: 2, whitelist: [] };
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));
const close = server => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); });

for (const kind of ['http', 'event', 'payment', 'event-payment']) {
  test(`${kind} billing error produces a safe message and scheduling signal`, () => {
    const context = {};
    const result = runProtocol(context, () => kind === 'event-payment'
      ? mapCcEventError({ error: { message: '<402> Payment required' } })
      : kind === 'event'
      ? mapCcEventError({ error: { ...failure.error, statusCode: 400 } })
      : mapCcError(kind === 'payment' ? 402 : 400, kind === 'payment' ? '{}' : JSON.stringify(failure)));
    assert.equal(result.status, 429);
    assert.equal(result.body.error.code, 'insufficient_quota');
    assert.match(result.body.error.message, /余额不足/);
    assert.equal(result.body.retry_after, 1200);
    assert.equal(context.errorCode, 'insufficient_quota');
    assert.equal(context.status, 429);
    assert.doesNotMatch(JSON.stringify(result), /private-user-fixture/);
  });
}

test('arbitrary validation errors stay generic and never trip billing cooldown', () => {
  assert.equal(quotaError({}, { error: { message: 'Invalid tool private-secret' } }), null);
  const context = {};
  const result = runProtocol(context, () => mapCcError(400, JSON.stringify({ error: { code: 'BAD_REQUEST', message: 'Invalid tool private-secret' } })));
  assert.equal(result.status, 400);
  assert.equal(context.errorCode, undefined);
  assert.doesNotMatch(JSON.stringify(result), /private-secret/);
});

for (const path of ['/v1/chat/completions', '/v1/messages', '/v1/responses', '/provider/v1/responses']) {
  test(`${path} quota failure excludes just the affected account on the next request`, async t => {
    const seen = [];
    const upstream = createServer(async (req, res) => {
      for await (const _ of req) {}
      if (!['/alpha/generate', '/provider/v1/responses'].includes(req.url)) { res.end('{}'); return; }
      seen.push(req.headers.authorization);
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(failure));
    });
    const apiBase = await listen(upstream);
    const app = await createApplication({ masterKey, initialPassword: 'test-password-fixture', apiBase });
    const low = app.repo.createUpstream(fields, 'user_lowfixture');
    const backup = app.repo.createUpstream({ ...fields, priority: 2 }, 'user_backupfixture');
    for (const a of [low, backup]) app.repo.save('upstreams', { ...a, health: 'healthy', provider_responses_enabled: true, models: [{ id: 'model', supported_endpoints: ['/responses'] }] });
    const client = app.repo.createClient({ name: 'client', enabled: true, whitelist: [] });
    const server = createServer(app.inference); const base = await listen(server);
    t.after(async () => { await close(server); await close(upstream); app.close(); });
    const request = () => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${client.key}` }, body: JSON.stringify({ model: 'model', messages: [{ role: 'user', content: 'fixture' }], input: 'fixture', max_tokens: 10, stream: false }) });
    const first = await request(); const body = await first.json();
    assert.equal(first.status, 429);
    assert.match(body.error.message, /余额不足/);
    assert.equal(first.headers.get('retry-after'), '1200');
    const state = app.repo.get('upstreams', low.id);
    assert.equal(app.scheduler.state(state), 'cooling');
    assert.equal(state.cooldown_reason, 'insufficient_quota');
    assert.equal(state.enabled, true);
    const second = await request(); await second.text();
    assert.deepEqual(seen, ['Bearer user_lowfixture', 'Bearer user_backupfixture']);
  });
}

test('quota cooldown survives repository restart', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'cc-quota-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'fixture.sqlite');
  let repo = new Repository(path, masterKey);
  const account = repo.createUpstream(fields, 'user_fixture');
  new Scheduler(repo).result(account.id, { status: 400, errorCode: 'insufficient_quota', cancelled: true });
  repo.close();
  repo = new Repository(path, masterKey);
  try {
    assert.equal(new Scheduler(repo).state(repo.get('upstreams', account.id)), 'cooling');
    assert.match(repo.get('upstreams', account.id).last_error, /余额不足/);
  } finally { repo.close(); }
});
