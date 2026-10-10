import crypto from 'node:crypto';
import http from 'node:http';
import net from 'node:net';

export async function allocPort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

export async function listen(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

export async function closeServer(server) {
  if (!server?.listening) return;
  server.closeAllConnections?.();
  await new Promise(resolve => server.close(resolve));
}

export async function startProtocolServer({ apiBase, env = {} } = {}) {
  const previous = new Map();
  for (const [key, value] of Object.entries(env)) {
    previous.set(key, process.env[key]);
    process.env[key] = String(value);
  }
  let protocols;
  try {
    protocols = await import(`../protocols.mjs?test=${crypto.randomUUID()}`);
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }

  const logs = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args) => { logs.push(args.map(String).join(' ')); };
  console.error = (...args) => { logs.push(args.map(String).join(' ')); };
  const routes = new Map([
    ['/v1/chat/completions', protocols.handleChatCompletions],
    ['/v1/messages', protocols.handleMessages],
    ['/v1/responses', protocols.handleResponses],
  ]);
  const { server, base } = await listen(async (req, res) => {
    const handler = routes.get(new URL(req.url, 'http://localhost').pathname);
    if (!handler || req.method !== 'POST') {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{"error":"not found"}');
      return;
    }
    const controller = new AbortController();
    req.once('aborted', () => controller.abort());
    res.once('close', () => { if (!res.writableEnded) controller.abort(); });
    await protocols.runProtocol({ apiBase, signal: controller.signal }, () => handler(req, res));
  });
  return {
    base,
    logs: () => logs.join(''),
    post: (path, body, headers = {}) => fetch(base + path, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
    async close() {
      await closeServer(server);
      console.log = originalLog;
      console.error = originalError;
    },
  };
}

export async function startMockUpstream(opts = {}) {
  const seen = [];
  const { server, base } = await listen((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', async () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const item = { url: req.url, method: req.method, headers: req.headers, raw };
      seen.push(item);
      if (opts.onRequest) await opts.onRequest(req, res, item);
      if (res.writableEnded) return;
      if (opts.status && opts.status !== 200) {
        res.writeHead(opts.status, { 'content-type': 'application/json' });
        res.end(opts.errorBody || JSON.stringify({ error: { message: 'mock error' } }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      for (const line of opts.ndjson ?? [
        '{"type":"text-start"}',
        '{"type":"text-delta","text":"hello"}',
        '{"type":"text-end"}',
        '{"type":"finish-step","finishReason":"stop","usage":{"inputTokens":9,"outputTokens":3}}',
        '{"type":"finish","finishReason":"stop","totalUsage":{"inputTokens":9,"outputTokens":3,"cachedInputTokens":0}}',
      ]) res.write(line + '\n');
      res.end();
    });
  });
  return {
    port: String(new URL(base).port),
    seen,
    close: () => closeServer(server),
    lastGenerate: () => {
      const item = seen.filter(entry => entry.url === '/alpha/generate').pop();
      return item ? { raw: item.raw, body: JSON.parse(item.raw), headers: item.headers } : null;
    },
    generateCount: () => seen.filter(entry => entry.url === '/alpha/generate').length,
  };
}

export async function setup(opts = {}) {
  const mock = await startMockUpstream(opts);
  const proxy = await startProtocolServer({ apiBase: `http://127.0.0.1:${mock.port}`, env: opts.env });
  return { mock, proxy, async close() { await proxy.close(); await mock.close(); } };
}
