import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers.mjs';

const auth = { Authorization: 'Bearer user_test' };
const endpoints = ['/v1/chat/completions', '/v1/messages', '/v1/responses'];
const events = text => text.split('\n').filter(line => line.startsWith('data: {')).map(line => JSON.parse(line.slice(6)));

// command-code@1.88.2 recognizes all three aliases in either raw or unified finish reason.
for (const alias of ['refusal', 'content_filter', 'content-filter']) for (const field of ['rawFinishReason', 'finishReason']) {
  test(`CLI 1.88.2 ${field}=${alias}: preserve refusal and usage across compatibility endpoints`, async () => {
    const s = await setup({ ndjson: [
      JSON.stringify({ type: 'text-delta', text: 'Unable to answer.' }),
      JSON.stringify({ type: 'finish-step', finishReason: 'stop' }),
      JSON.stringify({ type: 'finish', finishReason: 'stop', [field]: ` ${alias.toUpperCase()} `,
        totalUsage: { inputTokens: 10, outputTokens: 4, inputTokenDetails: { cacheReadTokens: 6 } } }),
    ] });
    try {
      for (const path of endpoints) for (const stream of [false, true]) {
        const res = await s.proxy.post(path, { model: 'm', stream, max_tokens: 64,
          ...(path.endsWith('/responses') ? { input: 'hi' } : { messages: [{ role: 'user', content: 'hi' }] }),
        }, auth);
        assert.equal(res.status, 200);
        const body = stream ? events(await res.text()) : await res.json();
        if (path.endsWith('/messages')) {
          const end = stream ? body.find(event => event.type === 'message_delta') : body;
          assert.equal(stream ? end?.delta.stop_reason : end.stop_reason, 'refusal');
          assert.equal(end.usage.cache_read_input_tokens, 6);
          assert.equal(end.usage.output_tokens, 4);
        } else if (path.endsWith('/responses')) {
          const end = stream ? body.find(event => event.type === 'response.incomplete')?.response : body;
          assert.equal(end?.status, 'incomplete');
          assert.deepEqual(end.incomplete_details, { reason: 'content_filter' });
          assert.equal(end.usage.input_tokens_details.cached_tokens, 6);
          assert.equal(end.usage.output_tokens, 4);
        } else {
          const end = stream ? body.find(event => event.choices?.[0]?.finish_reason) : body;
          assert.equal(end?.choices[0].finish_reason, 'content_filter');
          assert.equal(end.usage.prompt_tokens_details.cached_tokens, 6);
          assert.equal(end.usage.completion_tokens, 4);
        }
        assert.equal(s.mock.lastGenerate().headers['x-command-code-version'], '1.88.2');
      }
    } finally { await s.close(); }
  });
}

test('explicit content-filter completion with zero output is a refusal, not a retryable empty response', async () => {
  const s = await setup({ ndjson: [JSON.stringify({ type: 'finish', finishReason: 'content_filter',
    totalUsage: { inputTokens: 10, outputTokens: 0, cachedInputTokens: 6 } })] });
  try {
    for (const path of endpoints) for (const stream of [false, true]) {
      const res = await s.proxy.post(path, { model: 'm', stream, max_tokens: 64,
        ...(path.endsWith('/responses') ? { input: 'hi' } : { messages: [{ role: 'user', content: 'hi' }] }),
      }, auth);
      assert.equal(res.status, 200);
      const text = await res.text();
      assert.doesNotMatch(text, /zero output tokens|rate_limit_error|response.failed/);
      assert.match(text, /refusal|content_filter/);
    }
    assert.equal(s.mock.generateCount(), 6);
  } finally { await s.close(); }
});

for (const finalReason of ['stop', undefined]) test(`terminal finish (${finalReason ?? 'omitted reason'}) remains authoritative over a legacy finish-step refusal`, async () => {
  const s = await setup({ ndjson: [
    JSON.stringify({ type: 'text-delta', text: 'Completed answer.' }),
    JSON.stringify({ type: 'finish-step', finishReason: 'other', rawFinishReason: 'content_filter' }),
    JSON.stringify({ type: 'finish', finishReason: finalReason, totalUsage: { inputTokens: 10, outputTokens: 4 } }),
  ] });
  try {
    for (const path of endpoints) for (const stream of [false, true]) {
      const res = await s.proxy.post(path, { model: 'm', stream, max_tokens: 64,
        ...(path.endsWith('/responses') ? { input: 'hi' } : { messages: [{ role: 'user', content: 'hi' }] }),
      }, auth);
      assert.equal(res.status, 200);
      const body = stream ? events(await res.text()) : await res.json();
      if (path.endsWith('/messages')) {
        assert.equal(stream ? body.find(event => event.type === 'message_delta')?.delta.stop_reason : body.stop_reason, 'end_turn');
      } else if (path.endsWith('/responses')) {
        assert.equal(stream ? body.find(event => event.type === 'response.completed')?.response.status : body.status, 'completed');
      } else {
        assert.equal((stream ? body.find(event => event.choices?.[0]?.finish_reason) : body)?.choices[0].finish_reason, 'stop');
      }
    }
  } finally { await s.close(); }
});
