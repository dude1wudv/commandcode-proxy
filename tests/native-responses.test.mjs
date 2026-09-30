import assert from 'node:assert/strict';
import net from 'node:net';
import { createServer } from 'node:http';
import test from 'node:test';
import { createApplication } from '../lib/application.mjs';

const MASTER_KEY = Buffer.alloc(32, 0x73);
const CLIENT_KEY = 'sk-cc_native_responses_test_key';
const NATIVE_CREDENTIAL = 'user_native_secret_123';
const DISABLED_CREDENTIAL = 'user_disabled_secret_456';
const CHAT_ONLY_CREDENTIAL = 'user_chat_only_secret_789';
const COMPLEX_MODEL = 'gpt-native-complex';
const SSE_MODEL = 'gpt-native-stream';
const HANGING_MODEL = 'gpt-native-hanging';
const DISABLED_MODEL = 'gpt-responses-disabled';
const CHAT_ONLY_MODEL = 'gpt-chat-only';
const ERROR_MODELS = ['gpt-native-rate-limit', 'gpt-native-upgrade', 'gpt-native-failed', 'gpt-native-truncated'];
function listen(handler) {
  return new Promise((resolve, reject) => {
    const server = createServer(handler);
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve({ server, base: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

function close(server) {
  return new Promise(resolve => {
    if (!server?.listening) return resolve();
    server.close(() => resolve());
    server.closeAllConnections();
  });
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

async function fixture(t) {
  const requests = [];
  let providerStartedResolve;
  const providerStarted = new Promise(resolve => { providerStartedResolve = resolve; });
  let providerCancelledResolve;
  const providerCancelled = new Promise(resolve => { providerCancelledResolve = resolve; });
  const mock = await listen(async (req, res) => {
    const body = await readBody(req);
    requests.push({ method: req.method, path: new URL(req.url, 'http://localhost').pathname, authorization: req.headers.authorization, body: body ? JSON.parse(body) : null });
    if (req.url === '/provider/v1/models' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [
        { id: COMPLEX_MODEL, name: 'Complex model', supported_endpoints: ['/responses', '/chat/completions'] },
        { id: CHAT_ONLY_MODEL, supported_endpoints: ['/chat/completions'] },
      ] }));
      return;
    }
    if (req.url === '/provider/v1/responses' && req.method === 'POST') {
      if (requests.at(-1).body.model === HANGING_MODEL) {
        providerStartedResolve();
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('event: response.created\ndata: {"type":"response.created","response":{"id":"resp_hanging","status":"in_progress"}}\n\n');
        const cancelled = () => providerCancelledResolve();
        req.once('aborted', cancelled);
        res.once('close', cancelled);
        return;
      }
      if (requests.at(-1).body.model === 'gpt-native-rate-limit') {
        res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '19' });
        res.end(JSON.stringify({ error: { type: 'rate_limit_error', message: 'slow down' } }));
        return;
      }
      if (requests.at(-1).body.model === 'gpt-native-upgrade') {
        res.writeHead(403, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { code: 'upgrade_required', message: 'upgrade required' } }));
        return;
      }
      if (requests.at(-1).body.model === 'gpt-native-failed') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: 'resp_failed', object: 'response', status: 'failed', error: { code: 'server_error', message: 'generation failed' } }));
        return;
      }
      if (requests.at(-1).body.model === 'gpt-native-truncated' && requests.at(-1).body.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end('event: response.created\ndata: {"type":"response.created","response":{"id":"resp_truncated","status":"in_progress"}}\n\n');
        return;
      }
      if (requests.at(-1).body.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        const stream = [
          'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_stream","status":"in_progress"}}\n\n',
          'event: response.output_item.added\ndata: {"type":"response.output_item.added","output_index":0,"item":{"type":"function_call","call_id":"call_1","name":"lookup","arguments":""}}\n\n',
          'event: response.function_call_arguments.delta\ndata: {"type":"response.function_call_arguments.delta","item_id":"fc_1","output_index":0,"delta":"{\\"q\\":"}\n\n',
          'event: response.function_call_arguments.delta\ndata: {"type":"response.function_call_arguments.delta","item_id":"fc_1","output_index":0,"delta":"\\"weather\\"}"}\n\n',
          'event: response.function_call_arguments.done\ndata: {"type":"response.function_call_arguments.done","item_id":"fc_1","output_index":0,"arguments":"{\\"q\\":\\"weather\\"}"}\n\n',
          'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","output_index":0,"content_index":0,"delta":"你好"}\n\n',
          'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_stream","status":"completed","usage":{"input_tokens":11,"output_tokens":4,"total_tokens":15}}}\n\n',
        ].join('');
        for (const byte of Buffer.from(stream)) res.write(Buffer.of(byte));
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'resp_native', object: 'response', status: 'completed', output: [], usage: { input_tokens: 37, output_tokens: 9, total_tokens: 46 } }));
      return;
    }
    if (req.url === '/provider/v1/chat/completions' && req.method === 'POST') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'chat_native', object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: 'chat response' }, finish_reason: 'stop' }] }));
      return;
    }
    if (req.url === '/alpha/fingerprint/record' || req.url === '/alpha/lifecycle-events') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
      return;
    }
    if (req.url === '/alpha/generate') {
      await readBody(req);
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      res.end([
        '{"type":"text-start"}\n',
        '{"type":"text-delta","text":"chat response"}\n',
        '{"type":"finish","finishReason":"stop","totalUsage":{"inputTokens":8,"outputTokens":2}}\n',
      ].join(''));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 'not_found', message: 'unexpected fake-provider route' } }));
  });

  let app;
  let management;
  let inference;
  try {
    app = await createApplication({ databasePath: ':memory:', masterKey: MASTER_KEY, initialPassword: 'native-responses-test-password', apiBase: mock.base });
    management = await listen(app.management);
    inference = await listen(app.inference);

    const native = app.repo.createUpstream({
      name: 'native responses enabled', notes: '', enabled: true, priority: 0, load_factor: 1,
      max_concurrency: 4, whitelist: [COMPLEX_MODEL, SSE_MODEL, HANGING_MODEL, ...ERROR_MODELS], provider_responses_enabled: true,
    }, NATIVE_CREDENTIAL);
    native.health = 'healthy';
    native.models = [
      { id: COMPLEX_MODEL, supported_endpoints: ['/responses', '/chat/completions'] },
      { id: SSE_MODEL, supported_endpoints: ['/responses', '/chat/completions'] },
      { id: HANGING_MODEL, supported_endpoints: ['/responses', '/chat/completions'] },
      ...ERROR_MODELS.map(id => ({ id, supported_endpoints: ['/responses', '/chat/completions'] })),
    ];
    app.repo.save('upstreams', native);

    const disabled = app.repo.createUpstream({
      name: 'native responses disabled', notes: '', enabled: true, priority: 0, load_factor: 1,
      max_concurrency: 4, whitelist: [DISABLED_MODEL], provider_responses_enabled: false,
    }, DISABLED_CREDENTIAL);
    disabled.health = 'healthy';
    disabled.models = [{ id: DISABLED_MODEL, supported_endpoints: ['/responses', '/chat/completions'] }];
    app.repo.save('upstreams', disabled);

    const chatOnly = app.repo.createUpstream({
      name: 'chat endpoint only', notes: '', enabled: true, priority: 0, load_factor: 1,
      max_concurrency: 4, whitelist: [CHAT_ONLY_MODEL], provider_responses_enabled: true,
    }, CHAT_ONLY_CREDENTIAL);
    chatOnly.health = 'healthy';
    chatOnly.models = [{ id: CHAT_ONLY_MODEL, supported_endpoints: ['/chat/completions'] }];
    app.repo.save('upstreams', chatOnly);

    const client = app.repo.createClient({ name: 'native responses client', notes: '', enabled: true, expires_at: null, whitelist: [] }, CLIENT_KEY);
    t.after(async () => {
      await Promise.all([close(inference?.server), close(management?.server), close(mock.server)]);
      app?.close();
    });
    return { app, client, inferenceBase: inference.base, managementBase: management.base, apiBase: mock.base, requests, providerStarted, providerCancelled };
  } catch (error) {
    await Promise.all([close(inference?.server), close(management?.server), close(mock.server)]);
    app?.close();
    throw error;
  }
}

async function post(base, key, body, path = '/provider/v1/responses') {
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return { response, text, json: text && !response.headers.get('content-type')?.includes('text/event-stream') ? JSON.parse(text) : null };
}
async function getModels(base, key, path) {
  const response = await fetch(`${base}${path}`, { headers: { authorization: `Bearer ${key}` } });
  return { response, json: await response.json() };
}
async function managementSession(base) {
  const anonymous = await fetch(`${base}/command/api/auth/session`);
  const anonymousBody = await anonymous.json();
  const loginCookie = anonymous.headers.get('set-cookie')?.match(/cc_login=[^;]+/)?.[0];
  const login = await fetch(`${base}/command/api/auth/login`, {
    method: 'POST',
    headers: { origin: 'https://sub.sunmmyapi.xyz', cookie: loginCookie, 'x-csrf-token': anonymousBody.csrf, 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'admin@sub.sunmmyapi.xyz', password: 'native-responses-test-password' }),
  });
  assert.equal(login.status, 200);
  return {
    cookie: login.headers.get('set-cookie')?.match(/cc_session=[^;]+/)?.[0],
    csrf: (await login.json()).csrf,
  };
}

async function managementPost(base, session, path, body, signal) {
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { origin: 'https://sub.sunmmyapi.xyz', cookie: session.cookie, 'x-csrf-token': session.csrf, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  return { response, text: await response.text() };
}

test('native Responses preserves payload and SSE while scheduling only opted-in endpoint-capable accounts', async t => {
  const { app, client, inferenceBase, requests } = await fixture(t);
  const complexInput = [
    { role: 'user', content: [{ type: 'input_text', text: 'Describe this image.' }, { type: 'input_image', image_url: 'data:image/png;base64,aGVsbG8=', detail: 'high' }] },
    { type: 'function_call_output', call_id: 'call_prior', output: '{"ok":true}' },
    { type: 'reasoning', id: 'rs_prior', encrypted_content: 'opaque-encrypted-reasoning-payload', summary: [{ type: 'summary_text', text: 'private summary' }] },
  ];
  const tools = [
    { type: 'function', name: 'lookup', description: 'Look up data', parameters: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] }, strict: true },
    { type: 'web_search_preview', search_context_size: 'high' },
  ];
  const nativeBody = {
    model: COMPLEX_MODEL, input: complexInput, tools, tool_choice: 'auto', parallel_tool_calls: true,
    reasoning: { effort: 'high', summary: 'detailed' }, prompt_cache_key: 'cache-key-native-17', stream: false,
  };

  const plain = await post(inferenceBase, client.key, nativeBody);
  assert.equal(plain.response.status, 200, plain.text);
  assert.deepEqual(plain.json.usage, { input_tokens: 37, output_tokens: 9, total_tokens: 46 });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].path, '/provider/v1/responses');
  assert.equal(requests[0].authorization, `Bearer ${NATIVE_CREDENTIAL}`);
  assert.deepEqual(requests[0].body, { ...nativeBody, store: false });
  assert.equal(requests.some(request => request.path === '/alpha/generate'), false);

  const streamingBody = { model: SSE_MODEL, input: 'Call lookup with q=weather.', tools: [tools[0]], stream: true };
  const streamed = await post(inferenceBase, client.key, streamingBody);
  assert.equal(streamed.response.status, 200, streamed.text);
  assert.match(streamed.response.headers.get('content-type'), /text\/event-stream/i);
  assert.match(streamed.text, /event: response\.function_call_arguments\.delta/);
  assert.match(streamed.text, /"delta":"\\\"weather\\\"}"/);
  assert.match(streamed.text, /"delta":"你好"/);
  assert.match(streamed.text, /event: response\.completed/);
  assert.match(streamed.text, /"input_tokens":11,"output_tokens":4,"total_tokens":15/);
  assert.deepEqual(requests[1], { method: 'POST', path: '/provider/v1/responses', authorization: `Bearer ${NATIVE_CREDENTIAL}`, body: { ...streamingBody, store: false } });

  assert.equal(app.scheduler.acquire.length >= 3, true, 'scheduler must support endpoint-aware acquire(model, client, endpoint)');
  const rejected = await post(inferenceBase, client.key, { model: DISABLED_MODEL, input: 'must not route' });
  assert.notEqual(rejected.response.status, 200);
  const unsupported = await post(inferenceBase, client.key, { model: CHAT_ONLY_MODEL, input: 'must not route' });
  assert.notEqual(unsupported.response.status, 200);
  assert.equal(requests.length, 2, 'ineligible accounts must not receive native Responses calls');
  const exposed = app.scheduler.allowedModelCatalog(client, true);
  assert.equal(exposed.some(model => model.id === COMPLEX_MODEL && model.supported_endpoints?.includes('/responses') && model.responses_backend === 'provider'), true);
  assert.equal(exposed.some(model => model.id === DISABLED_MODEL), false);
  assert.equal(exposed.some(model => model.id === CHAT_ONLY_MODEL && model.supported_endpoints?.includes('/responses')), false);
  const nativeApiCatalog = await getModels(inferenceBase, client.key, '/provider/v1/models');
  const legacyApiCatalog = await getModels(inferenceBase, client.key, '/v1/models');
  assert.equal(nativeApiCatalog.response.status, 200);
  assert.equal(nativeApiCatalog.json.data.some(model => model.id === COMPLEX_MODEL && model.responses_backend === 'provider' && model.supported_endpoints.includes('/responses')), true);
  assert.equal(nativeApiCatalog.json.data.some(model => model.id === DISABLED_MODEL), false);
  assert.equal(legacyApiCatalog.json.data.some(model => model.id === DISABLED_MODEL), true);
  const legacyCatalog = app.scheduler.allowedModelCatalog(client, false);
  assert.equal(legacyCatalog.some(model => model.id === DISABLED_MODEL), true);
});
test('model refresh persists official endpoint metadata', async t => {
  const { app } = await fixture(t);
  const native = app.repo.list('upstreams').find(account => account.name === 'native responses enabled');
  const refreshed = await app.upstream.refresh(native.id);
  assert.deepEqual(refreshed.models.find(model => model.id === COMPLEX_MODEL), {
    id: COMPLEX_MODEL,
    name: 'Complex model',
    supported_endpoints: ['/responses', '/chat/completions'],
  });
});
test('native Responses uses the account-specific proxy', async t => {
  const { app, client, apiBase, inferenceBase, requests } = await fixture(t);
  const proxy = await listen(() => {});
  const targets = [];
  proxy.server.on('connect', (request, downstream, head) => {
    targets.push(request.url);
    const [host, port] = request.url.split(':');
    const upstream = net.connect(Number(port), host, () => {
      downstream.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      downstream.pipe(upstream);
      upstream.pipe(downstream);
    });
  });
  t.after(() => close(proxy.server));
  const native = app.repo.list('upstreams').find(account => account.name === 'native responses enabled');
  app.repo.setProxy(native.id, proxy.base);
  const response = await post(inferenceBase, client.key, { model: COMPLEX_MODEL, input: 'proxied native call' });
  assert.equal(response.response.status, 200, response.text);
  assert.equal(targets.length, 1);
  assert.equal(targets[0], new URL(apiBase).host);
  assert.equal(requests.at(-1).path, '/provider/v1/responses');
});
test('enabled accounts accept Chat at both API roots without invoking native Responses', async t => {
  const { inferenceBase, requests } = await fixture(t);
  for (const path of ['/provider/v1/chat/completions', '/v1/chat/completions']) {
    const result = await post(inferenceBase, CLIENT_KEY, { model: COMPLEX_MODEL, messages: [{ role: 'user', content: 'hello' }] }, path);
    assert.equal(result.response.status, 200, result.text);
    assert.equal(result.json.object, 'chat.completion');
    assert.equal(result.json.choices[0].message.content, 'chat response');
  }
  assert.equal(requests.filter(request => request.path === '/alpha/generate').length, 2);
  assert.equal(requests.some(request => request.path === '/provider/v1/responses'), false);
});

test('management test defaults to Chat and explicit Responses streams native SSE to completion', async t => {
  const { app, managementBase, requests } = await fixture(t);
  const session = await managementSession(managementBase);
  const account = app.repo.list('upstreams').find(item => item.name === 'native responses enabled');
  const defaultChat = await managementPost(managementBase, session, `/command/api/upstreams/${account.id}/test`, { model: COMPLEX_MODEL, prompt: 'default protocol' });
  assert.equal(defaultChat.response.status, 200, defaultChat.text);
  assert.match(defaultChat.text, /event: done\ndata: \{"success":true/);
  assert.equal(requests.some(request => request.path === '/alpha/generate'), true);
  assert.equal(requests.some(request => request.path === '/provider/v1/responses'), false);

  const native = await managementPost(managementBase, session, `/command/api/upstreams/${account.id}/test`, { model: COMPLEX_MODEL, prompt: 'native protocol', protocol: 'responses' });
  assert.equal(native.response.status, 200, native.text);
  assert.match(native.response.headers.get('content-type'), /text\/event-stream/i);
  assert.match(native.text, /event: text\ndata: \{"text":"你好"/);
  assert.match(native.text, /event: done\ndata: \{"success":true/);
  const providerRequest = requests.find(request => request.path === '/provider/v1/responses');
  assert.deepEqual(providerRequest.body, { model: COMPLEX_MODEL, input: 'native protocol', max_output_tokens: 256, stream: true, store: false });
});

test('management native test cancellation leaves account health and circuit state untouched and releases its lease', async t => {
  const { app, managementBase, providerStarted, providerCancelled } = await fixture(t);
  const session = await managementSession(managementBase);
  const account = app.repo.list('upstreams').find(item => item.name === 'native responses enabled');
  const controller = new AbortController();
  const pending = fetch(`${managementBase}/command/api/upstreams/${account.id}/test`, {
    method: 'POST',
    headers: { origin: 'https://sub.sunmmyapi.xyz', cookie: session.cookie, 'x-csrf-token': session.csrf, 'content-type': 'application/json' },
    body: JSON.stringify({ model: HANGING_MODEL, prompt: 'cancel this diagnostic', protocol: 'responses' }),
    signal: controller.signal,
  });
  const response = await pending;
  assert.equal(response.status, 200);
  await providerStarted;
  controller.abort();
  await providerCancelled;
  for (let attempt = 0; attempt < 20 && app.scheduler.view(app.repo.get('upstreams', account.id)).inflight !== 0; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  const after = app.repo.get('upstreams', account.id);
  assert.equal(after.health, 'healthy');
  assert.equal(after.circuit_level, account.circuit_level);
  assert.deepEqual(after.failures, account.failures);
  assert.equal(app.scheduler.view(after).inflight, 0, 'cancelled diagnostic must release its scheduler lease');
});

test('native Responses errors preserve retryability, disable only native access, and never count as success', async t => {
  const { app, client, inferenceBase, requests } = await fixture(t);
  const before = app.repo.get('clients', client.id);
  const rejected = await post(inferenceBase, client.key, { model: COMPLEX_MODEL, input: 'stateful', previous_response_id: 'resp_previous' });
  assert.equal(rejected.response.status, 400);
  assert.equal(requests.some(request => request.body.input === 'stateful'), false, 'unsupported state must be rejected before dispatch');


  const failed = await post(inferenceBase, client.key, { model: 'gpt-native-failed', input: 'fails upstream' });
  assert.equal(failed.json.status, 'failed');
  const truncated = await post(inferenceBase, client.key, { model: 'gpt-native-truncated', input: 'truncated', stream: true });
  assert.equal(truncated.response.status, 200);
  assert.match(truncated.text, /event: error/);
  const upgrade = await post(inferenceBase, client.key, { model: 'gpt-native-upgrade', input: 'needs upgrade' });
  assert.equal(upgrade.response.status, 403);
  const nativeAccount = app.repo.list('upstreams').find(account => account.name === 'native responses enabled');
  assert.equal(nativeAccount.provider_responses_enabled, false);

  const chat = await post(inferenceBase, client.key, { model: COMPLEX_MODEL, messages: [{ role: 'user', content: 'still chat' }] }, '/v1/chat/completions');
  assert.equal(chat.response.status, 200, chat.text);
  assert.equal(chat.json.object, 'chat.completion');

  const after = app.repo.get('clients', client.id);
  assert.equal(after.successes, before.successes + 1, 'only Chat should count as successful among these requests');
  assert.equal(after.errors, before.errors + 4);
});

test('native HTTP 429 preserves Retry-After and is not replayed', async t => {
  const { inferenceBase, requests } = await fixture(t);
  const limited = await post(inferenceBase, CLIENT_KEY, { model: 'gpt-native-rate-limit', input: 'one attempt' });
  assert.equal(limited.response.status, 429);
  assert.equal(limited.response.headers.get('retry-after'), '19');
  assert.equal(requests.filter(request => request.body.model === 'gpt-native-rate-limit').length, 1);
});

test('native endpoint rejects stateful flags without dispatch', async t => {
  const { inferenceBase, requests } = await fixture(t);
  for (const body of [
    { model: COMPLEX_MODEL, input: 'store requested', store: true },
    { model: COMPLEX_MODEL, input: 'background requested', background: true },
  ]) {
    const result = await post(inferenceBase, CLIENT_KEY, body);
    assert.equal(result.response.status, 400);
  }
  assert.equal(requests.length, 0);
});
