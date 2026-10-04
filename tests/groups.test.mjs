import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Repository } from '../lib/repository.mjs';
import { Scheduler } from '../lib/scheduler.mjs';
import { createApplication } from '../lib/application.mjs';
import { listen, closeServer, startMockUpstream } from './helpers.mjs';

const MASTER_KEY = Buffer.alloc(32, 0x29);
const accountFields = (group_id = 'default') => ({ name: 'Account', notes: '', group_id, enabled: true, priority: 0, load_factor: 1, max_concurrency: 1, whitelist: [], provider_responses_enabled: true });
const clientFields = (group_id = 'default') => ({ name: 'Client', notes: '', group_id, enabled: true, whitelist: [], expires_at: null });
function account(repo, group_id, models = ['shared-model']) {
  const row = repo.createUpstream(accountFields(group_id), `user_${group_id}_credential123`);
  return repo.save('upstreams', { ...row, health: 'healthy', models: models.map(id => ({ id, name: group_id, supported_endpoints: ['/responses', '/chat/completions'] })) });
}

test('v1 migration preserves three accounts, both existing keys and protected data; restart is idempotent', t => {
  const directory = mkdtempSync(join(tmpdir(), 'commandcode-groups-'));
  const path = join(directory, 'test.sqlite');
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  let repo = new Repository(path, MASTER_KEY);
  for (let i = 0; i < 3; i++) {
    const row = account(repo, 'default');
    repo.setProxy(row.id, `http://agent:secret@localhost:${9000 + i}`);
    repo.save('upstreams', { ...repo.get('upstreams', row.id), health: 'healthy', requests: 30 + i, cooldown_until: Date.now() + 50000 });
  }
  const keys = ['sk-existing-key-one', 'sk-existing-key-two'];
  for (const key of keys) repo.createClient(clientFields(), key);
  repo.setAdmin('admin@example.test', 'existing-password-hash');
  repo.db.prepare('INSERT INTO sessions VALUES(?,?,?)').run('session-hash', 'existing-csrf', Date.now() + 10000);
  for (const kind of ['upstreams', 'clients']) {
    for (const row of repo.list(kind)) { delete row.group_id; repo.save(kind, row); }
  }
  repo.db.exec('DROP TABLE groups; DELETE FROM migrations WHERE version=2;');
  const previous = Object.fromEntries(['upstreams', 'clients'].map(kind => [kind, repo.list(kind)]));
  const protectedTables = ['client_keys', 'upstream_proxies', 'billing_sessions', 'sessions', 'admin'];
  const protectedRows = Object.fromEntries(protectedTables.map(table => [table, repo.db.prepare(`SELECT * FROM ${table}`).all()]));
  const credentials = repo.db.prepare('SELECT id,credential FROM upstreams').all();
  repo.close();
  repo = new Repository(path, MASTER_KEY);
  try {
    for (const kind of ['upstreams', 'clients']) assert.deepEqual(repo.list(kind), previous[kind].map(row => ({ ...row, group_id: 'default' })));
    for (const table of protectedTables) assert.deepEqual(repo.db.prepare(`SELECT * FROM ${table}`).all(), protectedRows[table]);
    assert.deepEqual(repo.db.prepare('SELECT id,credential FROM upstreams').all(), credentials);
    for (const key of keys) assert.equal(repo.authenticateClient(key).group_id, 'default');
    assert.equal(repo.db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    const other = repo.createGroup({ name: 'Other', notes: '' });
    const row = repo.list('upstreams')[0];
    repo.save('upstreams', { ...row, group_id: other.id });
    repo.close(); repo = new Repository(path, MASTER_KEY);
    assert.equal(repo.get('upstreams', row.id).group_id, other.id);
    assert.equal(repo.list('groups').length, 2);
    assert.deepEqual(repo.db.prepare('SELECT version FROM migrations ORDER BY version').all().map(row => row.version), [1, 2]);
  } finally { repo.close(); }
});

test('catalogs, metadata, scheduling, saturation and native permission remain confined to a group', t => {
  const repo = new Repository(':memory:', MASTER_KEY); t.after(() => repo.close());
  const scheduler = new Scheduler(repo);
  const other = repo.createGroup({ name: 'Other', notes: '' });
  const empty = repo.createGroup({ name: 'Empty', notes: '' });
  const first = account(repo, 'default', ['shared-model', 'default-only']);
  const second = account(repo, other.id, ['shared-model', 'other-only']);
  repo.save('upstreams', { ...first, priority: 100, provider_responses_enabled: false });
  const client = clientFields();
  assert.deepEqual(scheduler.allowedModels(client), ['default-only', 'shared-model']);
  assert.deepEqual(scheduler.allowedModelCatalog(client, true), []);
  assert.equal(scheduler.allowedModelCatalog(client)[1].name, 'default');
  assert.deepEqual(scheduler.allowedModels(clientFields(other.id)), ['other-only', 'shared-model']);
  const held = scheduler.acquire('shared-model', client);
  assert.equal(held.account.id, first.id);
  assert.throws(() => scheduler.acquire('shared-model', client), error => error.code === 'no_available_upstream');
  assert.throws(() => scheduler.acquire('other-only', client), error => error.code === 'model_not_allowed');
  assert.throws(() => scheduler.acquire('shared-model', client, '/responses'), error => error.code === 'unsupported_endpoint');
  for (const id of [empty.id, 'missing-group']) {
    assert.deepEqual(scheduler.allowedModelCatalog(clientFields(id)), []);
    assert.throws(() => scheduler.acquire('shared-model', clientFields(id)), error => error.code === 'model_not_allowed');
  }
  const isolated = scheduler.acquire('shared-model', clientFields(other.id), '/responses');
  assert.equal(isolated.account.id, second.id); isolated.release(); held.release();
  repo.save('upstreams', { ...repo.get('upstreams', first.id), health: 'credential_error' });
  assert.throws(() => scheduler.acquire('shared-model', client), error => error.code === 'no_available_upstream');
});

async function fixture(t) {
  const mock = await startMockUpstream({ onRequest(req, res) {
    if (req.url !== '/provider/v1/responses') return;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ id: 'resp_group', object: 'response', status: 'completed', output: [], usage: { input_tokens: 8, output_tokens: 2 } }));
  } });
  const app = await createApplication({ masterKey: MASTER_KEY, initialPassword: 'isolated-group-password', apiBase: `http://127.0.0.1:${mock.port}` });
  const management = await listen(app.management); const inference = await listen(app.inference);
  t.after(async () => { await closeServer(management.server); await closeServer(inference.server); app.close(); await mock.close(); });
  const request = async (base, path, method = 'GET', body, headers = {}) => {
    const response = await fetch(base + path, { method, headers: { ...headers, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await response.text(); let data; try { data = JSON.parse(text); } catch { data = text; }
    return { status: response.status, headers: response.headers, data, text };
  };
  const guest = await request(management.base, '/command/api/auth/session');
  const login = await request(management.base, '/command/api/auth/login', 'POST', { email: 'admin@sub.sunmmyapi.xyz', password: 'isolated-group-password' }, {
    origin: 'https://sub.sunmmyapi.xyz', 'x-csrf-token': guest.data.csrf, cookie: guest.headers.getSetCookie()[0].split(';')[0],
  });
  assert.equal(login.status, 200);
  const auth = { origin: 'https://sub.sunmmyapi.xyz', 'x-csrf-token': login.data.csrf, cookie: login.headers.getSetCookie()[0].split(';')[0] };
  return { app, mock, management, request, auth,
    manage: (path, method, body, headers) => request(management.base, '/command/api' + path, method, body, { ...auth, ...headers }),
    infer: (key, path, body, anthropic = false) => request(inference.base, path, body ? 'POST' : 'GET', body, anthropic ? { 'x-api-key': key } : { authorization: `Bearer ${key}` }),
  };
}

test('management protects group CRUD and bindings; moving and rotating a key keep its scope', async t => {
  const f = await fixture(t);
  assert.equal((await f.request(f.management.base, '/command/api/groups')).status, 401);
  assert.equal((await f.manage('/groups', 'POST', { name: 'Blocked' }, { 'x-csrf-token': '' })).status, 403);
  assert.equal((await f.manage('/groups', 'POST', { name: '' })).status, 400);
  const group = (await f.manage('/groups', 'POST', { name: 'Separate', notes: 'pool' })).data;
  assert.equal((await f.manage('/groups', 'POST', { name: 'Separate' })).status, 409);
  assert.equal((await f.manage(`/groups/${group.id}`, 'PATCH', { name: 'Renamed' })).data.name, 'Renamed');
  const a = (await f.manage('/upstreams', 'POST', { ...accountFields(group.id), credential: 'user_isolatedcredential' })).data;
  const c = (await f.manage('/clients', 'POST', clientFields(group.id))).data;
  assert.equal(c.group_id, group.id);
  assert.equal((await f.manage(`/groups/${group.id}`, 'DELETE')).status, 409);
  for (const kind of ['clients', 'upstreams']) {
    const body = kind === 'clients' ? clientFields('missing') : { ...accountFields('missing'), credential: 'user_testcredential' };
    assert.equal((await f.manage(`/${kind}`, 'POST', body)).status, 400);
    assert.equal((await f.manage(`/${kind}/${kind === 'clients' ? c.id : a.id}`, 'PATCH', { group_id: null })).status, 400);
  }
  const rotated = await f.manage(`/clients/${c.id}/rotate`, 'POST', { grace_seconds: 60 });
  assert.equal(rotated.data.group_id, group.id);
  assert.equal(f.app.repo.authenticateClient(c.key).group_id, group.id);
  assert.equal(f.app.repo.authenticateClient(rotated.data.key).group_id, group.id);
  await f.manage(`/upstreams/${a.id}`, 'PATCH', { group_id: 'default' });
  assert.equal((await f.manage(`/groups/${group.id}`, 'DELETE')).status, 409);
  await f.manage(`/clients/${c.id}`, 'PATCH', { group_id: 'default' });
  for (const key of [c.key, rotated.data.key]) assert.equal(f.app.repo.authenticateClient(key).group_id, 'default');
  assert.equal((await f.manage(`/groups/${group.id}`, 'DELETE')).status, 200);
  assert.equal((await f.manage('/groups/default', 'DELETE')).status, 409);
  assert.ok(f.app.repo.audits().some(row => row.action === 'groups.create'));
});

test('existing keys and both protocol roots route only to their own group over real local HTTP', async t => {
  const f = await fixture(t);
  const group = f.app.repo.createGroup({ name: 'Separate', notes: '' });
  const a = account(f.app.repo, 'default', ['shared-model', 'default-only']);
  const b = account(f.app.repo, group.id, ['shared-model', 'other-only']);
  const legacy = f.app.repo.createClient(clientFields(), 'sk-preserved-existing-key');
  const scoped = f.app.repo.createClient(clientFields(group.id));
  for (const [client, expected] of [[legacy, a], [scoped, b]]) {
    for (const root of ['/v1', '/provider/v1']) {
      const catalog = await f.infer(client.key, root + '/models');
      assert.equal(catalog.status, 200);
      assert.deepEqual(catalog.data.data.map(row => row.id).sort(), expected.models.map(row => row.id).sort());
    }
    for (const [path, body] of [
      ['/v1/chat/completions', { messages: [{ role: 'user', content: 'hello' }] }],
      ['/v1/messages', { messages: [{ role: 'user', content: 'hello' }], max_tokens: 32 }],
      ['/v1/responses', { input: 'hello' }],
      ['/provider/v1/chat/completions', { messages: [{ role: 'user', content: 'hello' }] }],
      ['/provider/v1/responses', { input: 'hello' }],
    ]) {
      for (const stream of path === '/provider/v1/responses' ? [false] : [false, true]) {
        const before = f.mock.seen.length;
        const result = await f.infer(client.key, path, { ...body, model: 'shared-model', stream }, path === '/v1/messages');
        assert.equal(result.status, 200, path);
        const generated = f.mock.seen.slice(before).filter(row => ['/alpha/generate', '/provider/v1/responses'].includes(row.url));
        assert.equal(generated.length, 1, path);
        assert.equal(generated[0].headers.authorization, `Bearer ${f.app.repo.credential(expected.id)}`, path);
        if (stream) assert.match(result.text, /hello/);
      }
    }
  }
  const before = f.mock.seen.length;
  for (const path of ['/v1/chat/completions', '/v1/messages', '/v1/responses', '/provider/v1/chat/completions', '/provider/v1/responses']) {
    assert.equal((await f.infer(legacy.key, path, { model: 'other-only', messages: [], input: 'blocked' })).status, 403);
  }
  assert.equal(f.mock.seen.length, before);
  f.app.repo.save('clients', { ...f.app.repo.get('clients', legacy.id), whitelist: ['default-only'] });
  assert.equal((await f.infer(legacy.key, '/v1/chat/completions', { model: 'shared-model', messages: [] })).status, 403);
  assert.deepEqual((await f.infer(legacy.key, '/v1/models')).data.data.map(row => row.id), ['default-only']);
});
