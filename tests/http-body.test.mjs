import assert from 'node:assert/strict';
import test from 'node:test';
import { Readable } from 'node:stream';
import { bodyJSON } from '../lib/http.mjs';
import { setup } from './helpers.mjs';

const MB = 1024 * 1024;

for (const [name, contentLength, expectedBytes, sizeNote] of [
  ['declared size', String(2.5 * MB), 2.5 * MB, '2.5MB'],
  ['chunked lower bound', undefined, MB + 32, '1.0MB+'],
  ['malformed length', '9000000oops', MB + 32, '1.0MB+'],
  ['underreported length', '64', MB + 32, '1.0MB+'],
]) {
  test(`console body limit reports ${name} without retaining content`, async () => {
    const req = Readable.from([Buffer.alloc(MB + 32, 'x')]);
    req.headers = { 'content-type': 'application/json', ...(contentLength ? { 'content-length': contentLength } : {}) };
    await assert.rejects(bodyJSON(req, MB), error => {
      assert.equal(error.status, 413);
      assert.equal(error.code, 'body_too_large');
      assert.equal(error.bodyBytes, expectedBytes);
      assert.equal(error.message, `Request body exceeds 1MB limit (body is ${sizeNote})`);
      return true;
    });
  });
}

test('body parser still accepts a JSON object exactly at the limit', async () => {
  const raw = Buffer.from('{"ok":true}');
  const req = Readable.from([raw]);
  req.headers = { 'content-type': 'application/json', 'content-length': String(raw.length) };
  assert.deepEqual(await bodyJSON(req, raw.length), { ok: true });
});

test('CLI compatibility endpoints share request-size diagnostics and never dispatch oversized bodies', async () => {
  const s = await setup({ env: { CC_MAX_BODY_MB: '1' } });
  try {
    const body = { model: 'mock-model', input: 'x'.repeat(2 * MB), messages: [{ role: 'user', content: 'test' }] };
    for (const endpoint of ['/v1/chat/completions', '/v1/messages', '/v1/responses']) {
      const response = await s.proxy.post(endpoint, body, { Authorization: 'Bearer user_test' });
      assert.equal(response.status, 413, endpoint);
      const result = await response.json();
      assert.match(result.error.message, /Request body exceeds 1MB limit \(body is 2\.0MB\)/, endpoint);
    }
    assert.equal(s.mock.generateCount(), 0);
  } finally { await s.close(); }
});
