import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMessagesUsage } from '../lib/messages-usage.mjs';
import { listen, closeServer } from './helpers.mjs';
import { Repository } from '../lib/repository.mjs';
import { UsageLog } from '../lib/usage-log.mjs';

const finish = usage => ({ type: 'finish', finishReason: 'stop', ...(usage ? { totalUsage: usage } : {}) });
const text = value => ({ type: 'text-delta', text: value });
const write = (res, event, newline = true) => res.write(JSON.stringify(event) + (newline ? '\n' : ''));
const parseSse = value => value.split('\n').filter(line => line.startsWith('data: {')).map(line => JSON.parse(line.slice(6)));

async function fixture(t, generate, { idle = 200, retries = 0 } = {}) {
  const previous = { idle: process.env.CC_STREAM_IDLE_MS, retries: process.env.CC_UPSTREAM_RETRY_MAX };
  process.env.CC_STREAM_IDLE_MS = String(idle);
  process.env.CC_UPSTREAM_RETRY_MAX = String(retries);
  const protocols = await import(`../protocols.mjs?messages-usage=${randomUUID()}`);
  for (const [key, value] of [['CC_STREAM_IDLE_MS', previous.idle], ['CC_UPSTREAM_RETRY_MAX', previous.retries]]) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  let generated = 0;
  let context;
  let settled = false;
  const upstream = await listen((req, res) => {
    req.resume();
    req.on('end', () => {
      if (req.url !== '/alpha/generate') { res.end('{}'); return; }
      generated++;
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      res.flushHeaders();
      generate(res, generated);
    });
  });
  const proxy = await listen(async (req, res) => {
    context = { apiBase: upstream.base, usage: null };
    settled = false;
    try { await protocols.runProtocol(context, () => protocols.handleMessages(req, res)); }
    finally { settled = true; }
  });
  t.after(async () => { await closeServer(proxy.server); await closeServer(upstream.server); });
  return {
    get context() { return context; },
    get generated() { return generated; },
    get settled() { return settled; },
    request: (stream = true, signal) => fetch(proxy.base + '/v1/messages', {
      method: 'POST', signal,
      headers: { 'content-type': 'application/json', authorization: 'Bearer user_synthetic_usage_fixture' },
      body: JSON.stringify({ model: 'synthetic-fixture', stream, max_tokens: 100, messages: [{ role: 'user', content: 'synthetic input' }] }),
    }),
  };
}

test('semantic estimate is invariant to delta boundaries and tool completion does not double count', () => {
  const content = '中文🚀abc';
  const expected = Math.ceil(Buffer.byteLength(content + '{"path":"x"}') / 4);
  for (const parts of [[content], [...content], content.split('')]) {
    const usage = createMessagesUsage();
    for (const part of parts) usage.observe(text(part));
    usage.observe({ type: 'tool-input-start', id: 'a', toolName: 'arbitrarily_long_name_that_is_not_billed' });
    usage.observe({ type: 'tool-input-delta', id: 'a', delta: '{"path":' });
    usage.observe({ type: 'tool-input-delta', id: 'a', delta: '"x"}' });
    usage.observe({ type: 'tool-call', toolCallId: 'a', toolName: 'tool', input: { path: 'x' } });
    assert.equal(usage.snapshot().output_tokens, expected);
    assert.equal(usage.snapshot().output_tokens_estimated, true);
    usage.apply({ inputTokens: 19, cachedInputTokens: 3, outputTokens: 0 }, true);
    assert.equal(usage.snapshot().input_tokens, 16);
    assert.equal(usage.snapshot().output_tokens, expected);
    usage.apply({ outputTokens: 2 }, true);
    assert.equal(usage.snapshot().output_tokens, 2, 'positive terminal usage overrides even a larger estimate');
    assert.equal(usage.snapshot().output_tokens_estimated, false);
  }
});

test('intermediate upstream usage covers its prefix and estimates only later output', () => {
  const usage = createMessagesUsage();
  usage.observe(text('a'.repeat(100)));
  usage.apply({ inputTokens: 19, outputTokens: 4 });
  assert.equal(usage.snapshot().output_tokens, 4);
  assert.equal(usage.snapshot().output_tokens_estimated, false);
  for (const char of 'tail') usage.observe(text(char));
  assert.equal(usage.snapshot().output_tokens, 5, '4 reported plus one estimated tail token, not a re-estimated prefix');
  assert.equal(usage.snapshot().output_tokens_estimated, true);
  usage.apply({ outputTokens: 0 }, true);
  assert.equal(usage.snapshot().output_tokens, 5, 'zero terminal usage does not erase known consumption');
  usage.apply({ outputTokens: 3 }, true);
  assert.equal(usage.snapshot().output_tokens, 3, 'positive final usage replaces the provisional prefix and tail');
  assert.equal(usage.snapshot().output_tokens_estimated, false);
});

test('error usage includes output received after an intermediate exact count', async t => {
  const s = await fixture(t, res => {
    write(res, text('a'.repeat(100)));
    write(res, { type: 'start-step', usage: { inputTokens: 19, outputTokens: 4 } });
    write(res, text('tail'));
    res.end();
  });
  const response = await s.request();
  const error = parseSse(await response.text()).find(event => event.type === 'error');
  assert.equal(error.usage.output_tokens, 5);
  assert.equal(error.usage.output_tokens_estimated, true);
  assert.equal(s.context.usage.output_tokens, 5);
});

for (const stream of [true, false]) {
  for (const [variant, parameters, expected] of [
    ['object', { args: { path: 'legacy-args' } }, { path: 'legacy-args' }],
    ['JSON string', { args: '{"path":"legacy-args"}' }, { path: 'legacy-args' }],
    ['null input', { input: null, args: { path: 'legacy-args' } }, { path: 'legacy-args' }],
    ['input priority', { input: { path: 'current-input' }, args: { path: 'ignored-legacy-args' } }, { path: 'current-input' }],
  ]) {
    test(`Messages legacy args stream=${stream} preserves ${variant} parameters and counts them once`, async t => {
      const s = await fixture(t, res => {
        write(res, { type: 'tool-call', toolCallId: 'legacy-a', toolName: 'tool', ...parameters });
        write(res, { ...finish(), finishReason: 'tool-calls' });
        res.end();
      });
      const response = await s.request(stream);
      const body = await response.text();
      const events = stream ? parseSse(body) : null;
      const result = stream ? null : JSON.parse(body);
      const actualInput = stream
        ? JSON.parse(events.find(event => event.delta?.type === 'input_json_delta').delta.partial_json)
        : result.content.find(block => block.type === 'tool_use').input;
      const usage = stream ? events.find(event => event.type === 'message_delta').usage : result.usage;
      assert.equal(response.status, 200);
      assert.deepEqual(actualInput, expected);
      assert.equal(usage.output_tokens, Math.ceil(Buffer.byteLength(JSON.stringify(expected)) / 4));
      assert.equal(usage.output_tokens_estimated, true);
      assert.equal(s.context.usage.output_tokens, usage.output_tokens);
    });
  }

  test(`Messages legacy args stream=${stream} retains parameter usage on incomplete EOF`, async t => {
    const args = { path: 'legacy-before-disconnect' };
    const s = await fixture(t, res => {
      write(res, { type: 'tool-call', toolCallId: 'legacy-a', toolName: 'tool', args });
      res.end();
    }, { retries: 2 });
    const response = await s.request(stream);
    const body = await response.text();
    const error = stream ? parseSse(body).find(event => event.type === 'error') : JSON.parse(body);
    const expected = Math.ceil(Buffer.byteLength(JSON.stringify(args)) / 4);
    assert.equal(response.status, stream ? 200 : 502);
    assert.equal(error.usage.output_tokens, expected);
    assert.equal(error.usage.output_tokens_estimated, true);
    assert.equal(s.context.usage.output_tokens, expected);
    assert.equal(s.generated, 1);
    assert.doesNotMatch(body, /event: message_stop/);
  });

  test(`Messages stream=${stream} consumes final usage without an NDJSON trailing newline`, async t => {
    const s = await fixture(t, res => {
      write(res, text('你好'));
      write(res, finish({ inputTokens: 19, outputTokens: 7, cachedInputTokens: 3 }), false);
      res.end();
    });
    const response = await s.request(stream);
    const body = await response.text();
    const usage = stream ? parseSse(body).find(event => event.type === 'message_delta').usage : JSON.parse(body).usage;
    assert.equal(response.status, 200);
    assert.deepEqual(usage, { input_tokens: 16, output_tokens: 7, cache_read_input_tokens: 3, cache_creation_input_tokens: 0, output_tokens_estimated: false });
    assert.equal(s.context.usage.input_tokens, 19);
    assert.equal(s.context.usage.output_tokens, 7);
    assert.doesNotMatch(body, /"type":"error"/);
  });

  for (const terminal of ['missing', 'zero', 'positive']) {
    test(`Messages stream=${stream} records text/thinking/tool parameters with ${terminal} terminal usage`, async t => {
      const semantic = '你' + 'think' + '{"path":"x"}';
      const expected = terminal === 'positive' ? 2 : Math.ceil(Buffer.byteLength(semantic) / 4);
      const s = await fixture(t, res => {
        write(res, { type: 'start', usage: { inputTokens: 19, cachedInputTokens: 3 } });
        write(res, { type: 'reasoning-delta', text: 'think' });
        write(res, text('你'));
        write(res, { type: 'tool-input-delta', id: 'a', delta: '{"path":"x"}' });
        write(res, { type: 'tool-call', toolCallId: 'a', toolName: 'tool', input: { path: 'x' } });
        write(res, finish(terminal === 'missing' ? undefined : { outputTokens: terminal === 'positive' ? 2 : 0 }));
        res.end();
      });
      const response = await s.request(stream);
      const body = await response.text();
      const usage = stream ? parseSse(body).find(event => event.type === 'message_delta').usage : JSON.parse(body).usage;
      assert.equal(usage.input_tokens, 16);
      assert.equal(usage.output_tokens, expected);
      assert.equal(usage.output_tokens_estimated, terminal !== 'positive');
      assert.equal(s.context.usage.output_tokens, expected, 'persisted snapshot matches the response');
      assert.equal(s.context.usage.output_tokens_estimated, terminal !== 'positive');
    });
  }
}

for (const failure of ['eof', 'reset', 'timeout', 'upstream-error']) {
  test(`Messages ${failure} preserves already received usage and never replays output`, async t => {
    const s = await fixture(t, res => {
      write(res, { type: 'start', usage: { inputTokens: 19, inputTokenDetails: { cacheReadTokens: 3, cacheWriteTokens: 2 } } });
      write(res, { type: 'reasoning-delta', text: '你好world' });
      if (failure === 'eof') res.end();
      if (failure === 'reset') setTimeout(() => res.destroy(), 20);
      if (failure === 'upstream-error') { write(res, { type: 'error', error: { message: 'synthetic overload', statusCode: 503 } }); res.end(); }
    }, { idle: 80, retries: 2 });
    const response = await s.request();
    const body = await response.text();
    const error = parseSse(body).find(event => event.type === 'error');
    assert.equal(response.status, 200);
    assert.equal(error.usage.input_tokens, 14);
    assert.equal(error.usage.cache_read_input_tokens, 3);
    assert.equal(error.usage.cache_creation_input_tokens, 2);
    assert.equal(error.usage.output_tokens, 3);
    assert.equal(error.usage.output_tokens_estimated, true);
    assert.equal(s.context.usage.output_tokens, 3);
    assert.ok(s.context.status >= 400);
    assert.doesNotMatch(body, /event: message_stop/);
    assert.equal(s.generated, 1);
  });
}

test('partial tool input is charged once on truncation before a complete tool-call', async t => {
  const s = await fixture(t, res => {
    write(res, { type: 'tool-input-start', id: 'a', toolName: 'tool' });
    write(res, { type: 'tool-input-delta', id: 'a', delta: '{"path":' });
    res.end();
  }, { retries: 2 });
  const response = await s.request();
  const events = parseSse(await response.text());
  assert.equal(response.status, 200);
  assert.equal(events.find(event => event.type === 'error').usage.output_tokens, 2);
  assert.equal(s.generated, 1);
});

test('empty output retains known input/cache but invents no output charge', async t => {
  const s = await fixture(t, res => {
    write(res, finish({ inputTokens: 19, outputTokens: 0, cachedInputTokens: 3 }));
    res.end();
  });
  const response = await s.request();
  const events = parseSse(await response.text());
  const error = events.find(event => event.type === 'error');
  assert.equal(error.usage.input_tokens, 16);
  assert.equal(error.usage.output_tokens, 0);
  assert.equal(error.usage.output_tokens_estimated, false);
  assert.equal(s.context.usage.input_tokens, 19);
  assert.equal(s.context.usage.cached_tokens, 3);
});

test('client disconnect preserves the cumulative snapshot for final request-log settlement', async t => {
  const s = await fixture(t, res => { write(res, text('partial output')); });
  const controller = new AbortController();
  const response = await s.request(true, controller.signal);
  const reader = response.body.getReader();
  await reader.read();
  controller.abort();
  const deadline = Date.now() + 2000;
  while (!s.settled && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(s.settled, true);
  assert.equal(s.context.usage.output_tokens, 4);
  assert.equal(s.context.usage.output_tokens_estimated, true);
  assert.equal(s.generated, 1);
});

test('active upstream bytes reset idle time even when total duration exceeds the deadline', async t => {
  const s = await fixture(t, res => {
    let ticks = 0;
    const timer = setInterval(() => {
      if (++ticks < 5) res.write('\n');
      else { clearInterval(timer); write(res, text('ok')); write(res, finish({ inputTokens: 1, outputTokens: 1 })); res.end(); }
    }, 35);
    res.once('close', () => clearInterval(timer));
  }, { idle: 80 });
  const response = await s.request();
  const body = await response.text();
  assert.match(body, /event: message_stop/);
  assert.doesNotMatch(body, /event: error/);
});

test('pre-content heartbeat commits SSE but does not refresh upstream idle time or replay the request', { timeout: 15000 }, async t => {
  const s = await fixture(t, () => {}, { idle: 11200, retries: 2 });
  const started = Date.now();
  const response = await s.request();
  const body = await response.text();
  const elapsed = Date.now() - started;
  assert.equal(response.status, 200);
  assert.match(body, /event: ping/);
  assert.match(body, /Response timeout/);
  assert.doesNotMatch(body, /event: message_stop/);
  assert.ok(elapsed >= 10000 && elapsed < 14000, `idle elapsed ${elapsed}`);
  assert.equal(s.generated, 1);
  assert.equal(parseSse(body).find(event => event.type === 'error').usage.output_tokens, 0);
});

test('request log migration preserves existing usage and records new estimates', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cc-usage-migration-'));
  const path = join(dir, 'synthetic.sqlite');
  const key = Buffer.alloc(32, 9);
  let repo = new Repository(path, key);
  try {
    new UsageLog(repo).record({ request_id: 'historical', input_tokens: 19, output_tokens: 2 });
    repo.db.exec('ALTER TABLE request_logs DROP COLUMN output_tokens_estimated; DELETE FROM migrations WHERE version=4;');
    const previous = repo.db.prepare('SELECT * FROM request_logs').all();
    repo.close();
    repo = new Repository(path, key);
    assert.equal(repo.db.prepare('SELECT version FROM migrations WHERE version=4').get().version, 4);
    assert.deepEqual(repo.db.prepare('SELECT * FROM request_logs').all().map(row => ({ ...row })), previous.map(row => ({ ...row, output_tokens_estimated: 0 })));
    const log = new UsageLog(repo);
    log.record({ request_id: 'partial', status: 502, output_tokens: 4, output_tokens_estimated: true });
    assert.equal(log.list()[0].output_tokens_estimated, 1);
    assert.equal(log.list()[1].output_tokens_estimated, 0);
  } finally { repo.close(); rmSync(dir, { recursive: true, force: true }); }
});
