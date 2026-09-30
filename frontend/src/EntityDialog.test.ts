// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import EntityDialog from './EntityDialog.vue';

const upstream = {
  id: 'account-1', name: 'Account', notes: '', enabled: true, whitelist: ['gpt-4o'],
  priority: 0, load_factor: 1, max_concurrency: 2, credential_prefix: 'user_…',
  provider_responses_enabled: false, health: 'healthy', scheduling: 'ready', inflight: 0, cooldown_until: 0,
  models: [], models_refreshed_at: null, models_error: null, last_test_at: null, latency_ms: null,
  last_error: null, requests: 0, successes: 0, errors: 0,
};

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('EntityDialog native Responses account setting', () => {
  it('persists an explicit Responses opt-in in the account PATCH request', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(upstream), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    const wrapper = mount(EntityDialog, { props: { kind: 'upstreams', item: upstream } });

    await wrapper.find('input[name="provider_responses_enabled"]').setValue(true);
    await wrapper.find('form').trigger('submit');

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/command/api/upstreams/account-1');
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(String(init.body))).toMatchObject({ provider_responses_enabled: true });
    wrapper.unmount();
  });

  it('sends the default Chat-compatible false value when creating an account', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(upstream), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    const wrapper = mount(EntityDialog, { props: { kind: 'upstreams' } });

    await wrapper.find('input[name="name"]').setValue('New account');
    await wrapper.find('input[name="credential"]').setValue('user_test_credential');
    await wrapper.find('form').trigger('submit');

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toMatchObject({ provider_responses_enabled: false });
    wrapper.unmount();
  });
});
