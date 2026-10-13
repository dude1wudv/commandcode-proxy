import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers.mjs';

const AUTH = { Authorization: 'Bearer user_test' };
const THREADS = {
  '12th Gen Intel(R) Core(TM) i7-12650H': 16,
  '12th Gen Intel(R) Core(TM) i5-12400F': 12,
  '12th Gen Intel(R) Core(TM) i9-12900K': 24,
  '13th Gen Intel(R) Core(TM) i7-13700K': 24,
  '13th Gen Intel(R) Core(TM) i5-13600K': 20,
  '13th Gen Intel(R) Core(TM) i9-13900K': 32,
  'Intel(R) Core(TM) Ultra 7 155H': 22,
  'Intel(R) Core(TM) Ultra 9 285H': 16,
  'Intel(R) Core(TM) i9-14900K': 32,
  'Intel(R) Core(TM) i7-14700K': 28,
  'AMD Ryzen 7 7800X3D': 16,
  'AMD Ryzen 9 7950X': 32,
  'AMD Ryzen 5 7600': 12,
  'AMD Ryzen 9 7900X': 24,
  'AMD Ryzen 7 5800X3D': 16,
};

const ok = [
  '{"type":"text-delta","text":"hello"}',
  '{"type":"finish","finishReason":"stop","totalUsage":{"inputTokens":8,"outputTokens":2}}',
];

test('指纹 cpuCount 使用逻辑处理器数，预请求带 User-Agent cli', async () => {
  const s = await setup({ ndjson: ok });
  try {
    const res = await s.proxy.post('/v1/chat/completions', {
      model: 'm', messages: [{ role: 'user', content: 'hi' }],
    }, AUTH);
    assert.equal(res.status, 200);
    const fp = s.mock.seen.find(entry => entry.url === '/alpha/fingerprint/record');
    assert.ok(fp, '应发送指纹预请求');
    assert.equal(fp.headers['user-agent'], 'cli');
    const body = JSON.parse(fp.raw);
    assert.equal(body.components.cpuCount, THREADS[body.components.cpuModel]);
  } finally { await s.close(); }
});

test('未提供会话头时按请求内容派生稳定 threadId，客户端头优先', async () => {
  const s = await setup({ ndjson: ok });
  try {
    const first = { model: 'm', messages: [{ role: 'user', content: 'same prefix' }] };
    await s.proxy.post('/v1/chat/completions', first, AUTH);
    await s.proxy.post('/v1/chat/completions', first, AUTH);
    await s.proxy.post('/v1/chat/completions', {
      model: 'm', messages: [{ role: 'user', content: 'different prefix' }],
    }, AUTH);
    await s.proxy.post('/v1/chat/completions', first, { ...AUTH, 'x-session-id': 'client-session-1' });
    const ids = s.mock.seen.filter(entry => entry.url === '/alpha/generate').map(entry => entry.headers['x-session-id']);
    assert.equal(ids.length, 4);
    assert.equal(ids[0], ids[1]);
    assert.notEqual(ids[2], ids[0]);
    assert.equal(ids[3], 'client-session-1');
    assert.match(ids[0], /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    const wire = JSON.parse(s.mock.seen.filter(entry => entry.url === '/alpha/generate')[0].raw);
    assert.equal(wire.threadId, ids[0]);
  } finally { await s.close(); }
});

test('tool_choice none 清空 tools 且不重写工具名', async () => {
  const s = await setup({ ndjson: ok });
  try {
    await s.proxy.post('/v1/chat/completions', {
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      tool_choice: 'none',
      tools: [{ type: 'function', function: { name: 'tool_search', parameters: { type: 'object' } } }],
    }, AUTH);
    await s.proxy.post('/v1/chat/completions', {
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ type: 'function', function: { name: 'tool_search', parameters: { type: 'object' } } }],
    }, AUTH);
    const bodies = s.mock.seen.filter(entry => entry.url === '/alpha/generate').map(entry => JSON.parse(entry.raw));
    assert.deepEqual(bodies[0].params.tools, []);
    assert.equal(bodies[0].params.tool_choice, undefined);
    assert.equal(bodies[1].params.tools[0].name, 'tool_search');
  } finally { await s.close(); }
});

test('未知 finishReason 折成 stop，裸 error 按可重试上游失败返回', async () => {
  const other = await setup({
    env: { CC_UPSTREAM_RETRY_MAX: '0' },
    ndjson: [
      '{"type":"text-delta","text":"done"}',
      '{"type":"finish","finishReason":"other","totalUsage":{"inputTokens":4,"outputTokens":2}}',
    ],
  });
  try {
    const res = await other.proxy.post('/v1/chat/completions', {
      model: 'm', messages: [{ role: 'user', content: 'hi' }],
    }, AUTH);
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.choices[0].finish_reason, 'stop');
  } finally { await other.close(); }

  const failed = await setup({
    env: { CC_UPSTREAM_RETRY_MAX: '0' },
    ndjson: [
      '{"type":"finish","finishReason":"error","totalUsage":{"inputTokens":4,"outputTokens":1}}',
    ],
  });
  try {
    const res = await failed.proxy.post('/v1/chat/completions', {
      model: 'm', messages: [{ role: 'user', content: 'hi' }],
    }, AUTH);
    const body = await res.json();
    assert.equal(res.status, 502);
    assert.match(body.error.message, /upstream connection failure/);
  } finally { await failed.close(); }
});

test('用户槽图片保留，并行工具图放在全部 tool result 之后', async () => {
  const s = await setup({ ndjson: ok });
  try {
    await s.proxy.post('/v1/responses', {
      model: 'm',
      input: [{
        type: 'message', role: 'user',
        content: [
          { type: 'input_text', text: '看图' },
          { type: 'input_image', image_url: 'data:image/png;base64,aGVsbG8=' },
        ],
      }],
    }, AUTH);
    const user = s.mock.lastGenerate().body.params.messages[0];
    assert.equal(user.content.some(part => part.type === 'image' && part.image.startsWith('data:image/png')), true);

    const img = 'data:image/png;base64,' + 'A'.repeat(1000);
    await s.proxy.post('/v1/responses', {
      model: 'm',
      input: [
        { type: 'message', role: 'user', content: 'parallel' },
        { type: 'function_call', call_id: 'call_a', name: 'shot', arguments: '{}' },
        { type: 'function_call', call_id: 'call_b', name: 'shot', arguments: '{}' },
        { type: 'function_call_output', call_id: 'call_a', output: [{ type: 'input_image', image_url: img }] },
        { type: 'function_call_output', call_id: 'call_b', output: [{ type: 'input_image', image_url: img }] },
      ],
    }, AUTH);
    const roles = s.mock.lastGenerate().body.params.messages.map(message => message.role);
    assert.deepEqual(roles, ['user', 'assistant', 'tool', 'tool', 'user']);
  } finally { await s.close(); }
});

test('Responses 流已经发出 created 后，零输出走 response.failed', async () => {
  const s = await setup({
    env: { CC_UPSTREAM_RETRY_MAX: '0' },
    ndjson: [
      '{"type":"finish","finishReason":"stop","totalUsage":{"inputTokens":3,"outputTokens":0}}',
    ],
  });
  try {
    const res = await s.proxy.post('/v1/responses', {
      model: 'm', stream: true, input: 'hi',
    }, AUTH);
    const text = await res.text();
    assert.equal(res.status, 200);
    assert.match(text, /response\.failed/);
    assert.doesNotMatch(text, /response\.completed/);
    assert.match(text, /zero output tokens/);
  } finally { await s.close(); }
});
