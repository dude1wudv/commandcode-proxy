// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { api, testStream } from './api';
import App from './App.vue';

vi.mock('./api', () => ({
  api: vi.fn(async (path: string) => {
    if (path === '/overview') return { accounts: 1, healthy: 1, models: 2, clients: 0, inflight: 0, requests: 0, successes: 0, errors: 0, recent_errors: [], internal_base_url: '' };
    if (path === '/upstreams') return { data: [{
      id: 'account-1', name: 'Native account', notes: '', enabled: true, whitelist: [], priority: 0, load_factor: 1,
      max_concurrency: 2, credential_prefix: 'user_…', provider_responses_enabled: true,
      health: 'healthy', scheduling: 'ready', inflight: 0, cooldown_until: 0,
      models: [
        { id: 'gpt-chat', supported_endpoints: ['/chat/completions'] },
        { id: 'gpt-native', supported_endpoints: ['/responses', '/chat/completions'] },
      ], models_refreshed_at: null, models_error: null, last_test_at: null, latency_ms: null,
      last_error: null, requests: 0, successes: 0, errors: 0,
    }] };
    if (path === '/clients') return { data: [] };
    return {};
  }),
  session: vi.fn(async () => ({ email: 'admin@example.test', csrf: 'test-csrf' })),
  testStream: vi.fn(async (_id: string, _body: unknown, _signal: AbortSignal, onEvent: (event: string, data: Record<string, unknown>) => void) => {
    onEvent('done', { success: true });
  }),
}));

afterEach(() => { vi.restoreAllMocks(); localStorage.clear(); });

describe('App account diagnostics protocol selection', () => {
  it('defaults to Chat, filters by Responses support, and submits the chosen protocol', async () => {
    const wrapper = mount(App);
    await flushPromises();
    await wrapper.findAll('nav button').find(button => button.text().includes('账号测试'))!.trigger('click');
    await flushPromises();

    const protocol = wrapper.find('select').element as HTMLSelectElement;
    expect(protocol.value).toBe('chat');
    const modelSelect = wrapper.findAll('select')[2];
    expect(modelSelect.text()).toContain('gpt-chat');
    expect(modelSelect.text()).toContain('gpt-native');
    await wrapper.findAll('button').find(button => button.text().includes('开始生成测试'))!.trigger('click');
    await flushPromises();
    expect(vi.mocked(testStream)).toHaveBeenLastCalledWith('account-1', expect.objectContaining({ model: 'gpt-chat', protocol: 'chat' }), expect.any(AbortSignal), expect.any(Function));

    await wrapper.find('select').setValue('responses');
    await flushPromises();
    expect(modelSelect.text()).not.toContain('gpt-chat');
    expect(modelSelect.text()).toContain('gpt-native');
    await wrapper.findAll('button').find(button => button.text().includes('开始生成测试'))!.trigger('click');
    await flushPromises();
    expect(vi.mocked(testStream)).toHaveBeenLastCalledWith('account-1', expect.objectContaining({ model: 'gpt-native', protocol: 'responses' }), expect.any(AbortSignal), expect.any(Function));
    expect(vi.mocked(api)).toHaveBeenCalled();
    wrapper.unmount();
  });
});
