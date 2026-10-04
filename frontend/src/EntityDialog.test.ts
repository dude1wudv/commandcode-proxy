// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
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

describe('EntityDialog group membership', () => {
  const groups = [{ id: 'default', name: '默认分组', notes: '' }, { id: 'pool-b', name: '独立分组', notes: '' }];
  it('moves an account with an explicit group binding while preserving native permission', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(upstream), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const wrapper = mount(EntityDialog, { props: { kind: 'upstreams', item: { ...upstream, group_id: 'pool-b' }, groups } });
    expect((wrapper.find('select[name="group_id"]').element as HTMLSelectElement).value).toBe('pool-b');
    await wrapper.find('select[name="group_id"]').setValue('default');
    await wrapper.find('form').trigger('submit');
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toMatchObject({ group_id: 'default', provider_responses_enabled: false });
    wrapper.unmount();
  });
  it('creates an outlet key in the selected group', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: 'client', key: 'synthetic-key' }), { status: 201 }));
    vi.stubGlobal('fetch', fetchMock);
    const wrapper = mount(EntityDialog, { props: { kind: 'clients', groups, defaultGroupId: 'pool-b' } });
    expect((wrapper.find('select[name="group_id"]').element as HTMLSelectElement).value).toBe('pool-b');
    await wrapper.find('input[name="name"]').setValue('Scoped client');
    await wrapper.find('select[name="group_id"]').setValue('pool-b');
    await wrapper.find('form').trigger('submit');
    await flushPromises();
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/command/api/clients');
    expect(JSON.parse(String(init.body))).toMatchObject({ group_id: 'pool-b' });
    expect(wrapper.emitted('saved')?.[0]?.[0]).toMatchObject({ key: 'synthetic-key' });
    wrapper.unmount();
  });
  it('creates a group using only its name and notes', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(groups[1]), { status: 201 }));
    vi.stubGlobal('fetch', fetchMock);
    const wrapper = mount(EntityDialog, { props: { kind: 'groups', groups } });
    expect(wrapper.find('select[name="group_id"]').exists()).toBe(false);
    await wrapper.find('input[name="name"]').setValue('独立分组');
    await wrapper.find('form').trigger('submit');
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/command/api/groups');
    expect(JSON.parse(String(init.body))).toEqual({ name: '独立分组', notes: '' });
    wrapper.unmount();
  });
});
