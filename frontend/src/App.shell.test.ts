// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import App from './App.vue';

const api = vi.hoisted(() => vi.fn(async (path: string, method = 'GET') => {
  if (path === '/auth/login' && method === 'POST') return { email: 'admin@example.test', csrf: 'csrf-token' };
  if (path === '/overview') return { accounts: 1, healthy: 1, models: 1, clients: 1, inflight: 0, requests: 3, successes: 3, errors: 0, recent_errors: [], internal_base_url: 'http://172.18.0.1:13050/v1' };
  if (path === '/upstreams') return { data: [{ id: 'account-1', name: '主账号', notes: '', enabled: true, whitelist: [], priority: 1, load_factor: 1, max_concurrency: 2, credential_prefix: 'user_ab…', health: 'healthy', scheduling: 'ready', inflight: 0, cooldown_until: 0, models: [], models_refreshed_at: null, models_error: null, last_test_at: null, latency_ms: null, last_error: null, requests: 3, successes: 3, errors: 0 }] };
  if (path === '/clients') return { data: [{ id: 'client-1', name: '编辑器', notes: '', enabled: true, whitelist: [], expires_at: null, key_prefix: 'sk-cc_ab…', requests: 1, successes: 1, errors: 0, last_used_at: null, group_id: 'default' }] };
  if (path === '/groups') return { data: [{ id: 'default', name: '默认分组', notes: '' }] };
  if (path === '/alerts') return { data: [] };
  if (path === '/health/details') return { version: '1.0.0', git_sha: 'abc', started_at: 1, uptime_ms: 1000, inflight: 0, database: 'ok', accounts: {}, protocol: { implemented: '1.53.1', latest: '1.53.1', drifted: false, error: null } };
  if (path === '/clients' && method === 'POST') return { id: 'client-2', name: '新出口', key: 'sk-cc_once.secret' };
  if (method === 'DELETE') return { ok: true };
  return { data: [] };
}));

vi.mock('./api', () => ({ api: api, session: vi.fn(async () => ({ csrf: 'login-csrf' })), testStream: vi.fn() }));

afterEach(() => { vi.clearAllMocks(); localStorage.clear(); location.hash = ''; });

describe('console shell', () => {
  it('logs in, follows the hash, lists upstreams, and names the delete confirmation', async () => {
    const wrapper = mount(App);
    await flushPromises();
    expect(wrapper.text()).toContain('登录管理控制台');
    await wrapper.find('input[name="password"]').setValue('secret-password');
    await wrapper.find('form').trigger('submit');
    await flushPromises();
    expect(wrapper.text()).toContain('工作空间总览');

    location.hash = '#upstreams';
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    await flushPromises();
    expect(wrapper.text()).toContain('主账号');
    expect(wrapper.text()).toContain('user_ab…');

    await wrapper.find('button[aria-label="删除 主账号"]').trigger('click');
    expect(wrapper.text()).toContain('删除账号');
    expect(wrapper.find('[role="alertdialog"]').exists()).toBe(true);
    wrapper.unmount();
  });
});
