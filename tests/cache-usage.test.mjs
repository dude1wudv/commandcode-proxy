import test from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers.mjs';

for (const endpoint of ['chat/completions', 'responses', 'messages']) {
  for (const stream of [false, true]) {
    for (const variant of ['nested', 'flat', 'explicit-zero', 'missing']) {
      test(`${endpoint} stream=${stream}: ${variant} cache usage`, async () => {
        const expected = ['nested', 'flat'].includes(variant) ? 800 : 0;
        const usage = { inputTokens: 1000, outputTokens: 20 };
        if (variant === 'nested' || variant === 'explicit-zero') usage.inputTokenDetails = { cacheReadTokens: 800, cacheWriteTokens: 0 };
        if (variant === 'flat') usage.cachedInputTokens = 800;
        if (variant === 'explicit-zero') usage.cachedInputTokens = 0;
        const s = await setup({ndjson: [
          JSON.stringify({type:'text-start'}),
          JSON.stringify({type:'text-delta',text:'synthetic answer'}),
          JSON.stringify({type:'text-end'}),
          JSON.stringify({type:'finish-step',finishReason:'stop',usage}),
          JSON.stringify({type:'finish',finishReason:'stop',totalUsage:usage}),
        ]});
        try {
          const response = await s.proxy.post(`/v1/${endpoint}`, {
            model:'fixture', stream, max_tokens:100,
            messages:[{role:'user',content:'synthetic fixture'}], input:'synthetic fixture',
          }, {Authorization:'Bearer user_cachefixture'});
          assert.equal(response.status,200);
          const text = await response.text();
          const events = stream ? text.split('\n').filter(l=>l.startsWith('data: {')).map(l=>JSON.parse(l.slice(6))) : [JSON.parse(text)];
          const result = endpoint === 'responses' ? events.findLast(e=>e.response?.usage || e.usage) : events.findLast(e=>e.usage);
          assert.ok(result, 'terminal usage is present');
          const actual = result.response?.usage || result.usage;
          if (endpoint === 'messages') {
            assert.equal(actual.cache_read_input_tokens,expected);
            assert.equal(actual.input_tokens,1000-expected);
          } else if (endpoint === 'responses') {
            assert.equal(actual.input_tokens_details.cached_tokens,expected);
            assert.equal(actual.input_tokens,1000);
            assert.equal(actual.total_tokens,1020);
          } else {
            assert.equal(actual.prompt_tokens_details.cached_tokens,expected);
            assert.equal(actual.prompt_tokens,1000);
            assert.equal(actual.total_tokens,1020);
          }
        } finally { await s.close(); }
      });
    }
  }
}
