import { once } from 'node:events';
import { fail } from './auth.mjs';
import { json } from './http.mjs';
import { safeText } from './security.mjs';
import { upstreamFetch } from '../protocols.mjs';

const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
const MAX_EVENT_BYTES = 8 * 1024 * 1024;

export function validateResponses(body) {
  if (body.previous_response_id != null || (body.store !== undefined && body.store !== false) || (body.background !== undefined && body.background !== false)) {
    fail(400, 'invalid_request_error', 'This proxy is stateless: use store:false and send the full input each turn; background and previous_response_id are not supported');
  }
  if (typeof body.input !== 'string' && !Array.isArray(body.input)) fail(400, 'invalid_request_error', 'input must be a string or an array');
  if (Array.isArray(body.tools) && body.tools.some(tool => tool?.type === 'mcp')) fail(400, 'invalid_request_error', 'Run MCP tools on your client and declare them as function tools');
}

export async function requestResponses(body, credential, context, incomingHeaders = {}) {
  validateResponses(body);
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${credential}` };
  if (process.env.CMD_ZDR === '1' || incomingHeaders['x-cmd-zdr'] === '1') headers['x-cmd-zdr'] = '1';
  context.dispatched = true;
  try {
    const response = await upstreamFetch(`${context.apiBase.replace(/\/$/, '')}/provider/v1/responses`, {
      method: 'POST', headers, body: JSON.stringify({ ...body, store: false }), redirect: 'error',
      signal: AbortSignal.any([context.signal, AbortSignal.timeout(600000)].filter(Boolean)),
    });
    context.status = response.status;
    context.retryAfter = response.headers.get('retry-after');
    return response;
  } catch {
    context.status = 0;
    throw new Error('Upstream network request failed');
  }
}

export async function readProviderJson(response) {
  if (!response.body) throw new Error('Missing upstream body');
  const reader = response.body.getReader(); const chunks = []; let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      bytes += value.length;
      if (bytes > MAX_RESPONSE_BYTES) throw new Error('Upstream response exceeds size limit');
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally { await reader.cancel().catch(() => {}); }
}

export function providerError(error, credential) {
  const clean = value => safeText(String(value ?? '').split(credential).join('[redacted]'));
  return {
    message: clean(error?.message || 'Upstream request failed'),
    type: clean(error?.type || 'server_error'),
    code: error?.code == null ? null : clean(error.code),
    param: error?.param == null ? null : clean(error.param),
  };
}

export function recordProviderError(context, error) {
  const status = error?.statusCode ?? error?.status;
  context.status = Number.isInteger(status) && status >= 400 && status <= 599 ? status
    : error?.code === 'upgrade_required' || error?.type === 'permission_error' ? 403
    : error?.type === 'authentication_error' ? 401
    : error?.type === 'rate_limit_error' ? 429 : 502;
  if (error?.code === 'upgrade_required') context.disableProviderResponses = true;
}

// Keep successful frames unchanged, including tool deltas, opaque reasoning and usage.
export async function* providerSse(response, { onFirstByte, maxBytes = Infinity } = {}) {
  if (!response.body || !response.headers.get('content-type')?.includes('text/event-stream')) throw new Error('Expected upstream SSE');
  const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = ''; let bytes = 0;
  const frame = raw => {
    const dataText = raw.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, '')).join('\n');
    return { raw, data: !dataText || dataText === '[DONE]' ? null : JSON.parse(dataText) };
  };
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) { buffer += decoder.decode(); break; }
      if (!bytes) await onFirstByte?.();
      bytes += value.length;
      if (bytes > maxBytes) throw new Error('Upstream stream exceeds size limit');
      buffer += decoder.decode(value, { stream: true });
      let delimiter;
      while ((delimiter = /\r?\n\r?\n/.exec(buffer))) {
        const end = delimiter.index + delimiter[0].length;
        if (Buffer.byteLength(buffer.slice(0, end)) > MAX_EVENT_BYTES) throw new Error('Upstream event exceeds size limit');
        yield frame(buffer.slice(0, end)); buffer = buffer.slice(end);
      }
      if (Buffer.byteLength(buffer) > MAX_EVENT_BYTES) throw new Error('Upstream event exceeds size limit');
    }
    if (buffer.trim()) throw new Error('Truncated upstream SSE frame');
  } finally { await reader.cancel().catch(() => {}); }
}

export async function handleResponses(req, res, context) {
  const body = req.parsedBody;
  const credential = req.headers.authorization.slice(7);
  let terminal = false;
  try {
    const response = await requestResponses(body, credential, context, req.headers);
    if (context.retryAfter) res.setHeader('Retry-After', context.retryAfter);
    if (!response.ok) {
      let error;
      try { error = (await readProviderJson(response)).error; } catch { error = null; }
      if (error?.code === 'upgrade_required') context.disableProviderResponses = true;
      return json(res, response.status, { error: providerError(error, credential) });
    }
    if (body.stream !== true) {
      const result = await readProviderJson(response);
      if (result.object !== 'response' || !['completed', 'incomplete', 'failed'].includes(result.status)) throw new Error('Invalid upstream response');
      if (result.status === 'failed' || result.error) {
        recordProviderError(context, result.error);
        result.error = providerError(result.error, credential);
      }
      return json(res, response.status, result);
    }
    res.writeHead(response.status, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
    for await (const frame of providerSse(response)) {
      const data = frame.data;
      let raw = frame.raw;
      if (data?.type === 'response.completed' || data?.type === 'response.incomplete') terminal = true;
      if (data?.type === 'error' || data?.type === 'response.failed') {
        terminal = true;
        const error = data.response?.error || data.error || data;
        recordProviderError(context, error);
        const clean = providerError(error, credential);
        const outgoing = data.type === 'response.failed' ? { ...data, response: { ...data.response, error: clean } }
          : { ...data, ...(data.error ? { error: clean } : clean) };
        raw = `event: ${data.type}\ndata: ${safeText(JSON.stringify(outgoing).split(credential).join('[redacted]'))}\n\n`;
      }
      if (!res.write(raw)) await once(res, 'drain', { signal: context.signal });
    }
    if (!terminal) throw new Error('Upstream stream ended without a terminal event');
    res.end();
  } catch (error) {
    if (error.status) throw error;
    if (context.signal?.aborted || res.destroyed) return;
    context.status = 502;
    const outgoing = { type: 'error', code: 'upstream_error', message: 'Upstream response interrupted, timed out or invalid', param: null };
    if (!res.headersSent) json(res, 502, { error: outgoing });
    else if (!res.writableEnded) res.end(`event: error\ndata: ${JSON.stringify(outgoing)}\n\n`);
  }
}
