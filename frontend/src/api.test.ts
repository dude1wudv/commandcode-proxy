// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api, session } from './api';

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('api JSON guard', () => {
  it('maps HTML gateway bodies to a readable connection error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<!DOCTYPE html><html></html>', { status: 502, headers: { 'content-type': 'text/html' } })));
    await expect(api('/upstreams/a/billing/refresh', 'POST', {})).rejects.toMatchObject({
      message: '控制台连接中断，请稍后刷新',
      code: 'invalid_response',
      status: 502,
    });
  });

  it('keeps structured JSON error messages from the management API', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: { code: 'server_busy', message: '服务繁忙，请稍后刷新' } }), { status: 503, headers: { 'content-type': 'application/json' } })));
    await expect(api('/upstreams/a/billing/refresh', 'POST', {})).rejects.toMatchObject({
      message: '服务繁忙，请稍后刷新',
      code: 'server_busy',
      status: 503,
    });
  });

  it('guards session() against HTML bodies', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<!DOCTYPE html>', { status: 502 })));
    await expect(session()).rejects.toMatchObject({ message: '控制台连接中断，请稍后刷新' });
  });
});
