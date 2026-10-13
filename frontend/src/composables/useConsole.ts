import { computed, inject, onBeforeUnmount, onMounted, provide, reactive, ref, watch, type InjectionKey } from 'vue';
import { api, session, testStream, type AlertItem, type Audit, type Client, type Group, type HealthDetails, type Overview, type RequestLog, type Session, type Upstream, type UsageSummary } from '../api';
import { splitRules } from '../utils/format';
import { useClipboard } from './useClipboard';
import { useHashRoute } from './useHashRoute';
import { useToast } from './useToast';

export type Page = 'groups' | 'overview' | 'upstreams' | 'test' | 'models' | 'clients' | 'audit' | 'settings' | 'usage' | 'requests';
export const pages = ['overview', 'upstreams', 'test', 'models', 'usage', 'requests', 'clients', 'groups', 'audit', 'settings'] as const;
export type ConfirmAction = { kind: 'upstreams' | 'clients' | 'groups' | 'sessions'; id: string; name: string; action: 'delete' | 'rotate' | 'revoke' | 'disable' | 'batch-disable' };
const key: InjectionKey<ConsoleStore> = Symbol('console');

export type ConsoleStore = ReturnType<typeof createStore>;
function createStore() { return reactive(createConsole()); }
export function useConsole() {
  const workspace = inject(key);
  if (!workspace) throw new Error('控制台状态尚未就绪');
  return workspace;
}
export function provideConsole() {
  const workspace = createStore();
  provide(key, workspace);
  return workspace;
}

function createConsole() {
  const { page, navigate: setPage, fromHash } = useHashRoute<Page>(pages, 'overview');
  const { toasts, notify, dismiss, stop } = useToast();
  const copyText = useClipboard(notify);
  const mobileNav = ref(false);
  const auth = ref<Session | null>(null);
  const booting = ref(true);
  const email = ref('admin@sub.sunmmyapi.xyz');
  const password = ref('');
  const loginError = ref('');
  const loggingIn = ref(false);
  const overview = ref<Overview>();
  const upstreams = ref<Upstream[]>([]);
  const clients = ref<Client[]>([]);
  const groups = ref<Group[]>([]);
  const audits = ref<Audit[]>([]);
  const alerts = ref<AlertItem[]>([]);
  const health = ref<HealthDetails>();
  const requests = ref<RequestLog[]>([]);
  const usage = ref<UsageSummary>();
  const usageBy = ref<'hour' | 'model' | 'client' | 'upstream'>('hour');
  const requestFilter = ref({ client: '', upstream: '', model: '', status: '' });
  const loaded = ref(false);
  const refreshedAt = ref(0);
  const loading = ref(false);
  const busy = ref('');
  const groupFilter = ref('');
  const search = ref('');
  const selected = ref<string[]>([]);
  const editor = ref<{ kind: 'upstreams' | 'clients' | 'groups'; item?: Upstream | Client | Group }>();
  const revealed = ref<{ name: string; key: string }>();
  const confirmation = ref<ConfirmAction>();
  const grace = ref(0);
  const accountId = ref('');
  const modelSearch = ref('');
  const modelDraft = ref<string[]>([]);
  const manualModels = ref('');
  const testModel = ref('');
  const prompt = ref('请简短回复：连接成功。');
  const testing = ref(false);
  const output = ref('');
  const events = ref<{ event: string; message: string; ms?: number }[]>([]);
  const testProtocol = ref<'chat' | 'responses'>('chat');
  const currentPassword = ref('');
  const newPassword = ref('');
  const repeatPassword = ref('');
  const alertsOpen = ref(false);
  const acknowledged = ref<string[]>(readAcknowledged());
  let abortTest: AbortController | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let hadSession = false;
  let intentionalLogout = false;
  const groupName = (id?: string) => groups.value.find(group => group.id === (id ?? 'default'))?.name || '未知分组';
  const filteredUpstreams = computed(() => upstreams.value.filter(row => (!groupFilter.value || row.group_id === groupFilter.value) && `${row.name} ${row.notes} ${row.credential_prefix} ${row.proxy_label || ''} ${row.proxy_probe?.exit_ip || ''}`.toLowerCase().includes(search.value.toLowerCase())));
  const filteredClients = computed(() => clients.value.filter(row => (!groupFilter.value || row.group_id === groupFilter.value) && `${row.name} ${row.notes} ${row.key_prefix}`.toLowerCase().includes(search.value.toLowerCase())));
  const account = computed(() => upstreams.value.find(row => row.id === accountId.value));
  const catalog = computed(() => account.value?.models.filter(model => model.id.toLowerCase().includes(modelSearch.value.toLowerCase())) || []);
  const testModels = computed(() => {
    const current = account.value;
    if (!current) return [];
    const rules = current.whitelist;
    return [...new Set([...current.models.map(model => model.id), ...rules.filter(model => !model.endsWith('*'))])].filter(model => !rules.length || rules.some(rule => rule.endsWith('*') ? model.startsWith(rule.slice(0, -1)) : rule === model)).filter(model => testProtocol.value !== 'responses' || (current.provider_responses_enabled && current.models.some(entry => entry.id === model && entry.supported_endpoints?.includes('/responses'))));
  });
  const successRate = computed(() => overview.value?.requests ? Math.round(overview.value.successes / overview.value.requests * 100) : 0);
  const openAlerts = computed(() => alerts.value.filter(item => !acknowledged.value.includes(item.id)));
  const baseUrl = computed(() => overview.value?.internal_base_url || '');
  function readAcknowledged() { try { return JSON.parse(localStorage.getItem('commandcode-alerts-ack') || '[]') as string[]; } catch { return []; } }
  function acknowledge(id: string) {
    acknowledged.value = [...new Set([...acknowledged.value, id])].slice(-200);
    try { localStorage.setItem('commandcode-alerts-ack', JSON.stringify(acknowledged.value)); } catch { /* The badge stays for this session. */ }
  }
  function navigate(id: Page) { setPage(id); mobileNav.value = false; alertsOpen.value = false; search.value = ''; groupFilter.value = ''; selected.value = []; }
  function unauthorized() {
    const expired = hadSession && !intentionalLogout;
    intentionalLogout = false; hadSession = false; auth.value = null; password.value = ''; revealed.value = undefined; editor.value = undefined; confirmation.value = undefined;
    upstreams.value = []; clients.value = []; groups.value = []; audits.value = []; alerts.value = []; requests.value = []; overview.value = undefined; loaded.value = false;
    abortTest?.abort(); output.value = ''; events.value = []; currentPassword.value = ''; newPassword.value = ''; repeatPassword.value = '';
    if (expired) loginError.value = '会话已过期，请重新登录';
    void session().catch(() => {});
  }
  async function reload(silent = false) {
    if (!auth.value?.email) return;
    if (!silent) loading.value = true;
    try {
      const [nextOverview, nextUpstreams, nextClients, nextGroups, nextAlerts, nextHealth] = await Promise.all([
        api<Overview>('/overview'), api<{ data: Upstream[] }>('/upstreams'), api<{ data: Client[] }>('/clients'), api<{ data: Group[] }>('/groups'), api<{ data: AlertItem[] }>('/alerts'), api<HealthDetails>('/health/details'),
      ]);
      if (!auth.value?.email) return;
      overview.value = nextOverview; upstreams.value = nextUpstreams.data || []; clients.value = nextClients.data || []; groups.value = nextGroups.data || []; alerts.value = nextAlerts.data || []; health.value = nextHealth; loaded.value = true; refreshedAt.value = Date.now();
      if (!accountId.value || !upstreams.value.some(row => row.id === accountId.value)) accountId.value = upstreams.value[0]?.id || '';
      if (page.value === 'audit') audits.value = (await api<{ data: Audit[] }>('/audit')).data || [];
      if (page.value === 'usage') await loadUsage();
      if (page.value === 'requests' && !requests.value.length) requests.value = (await api<{ data: RequestLog[] }>(requestQuery())).data || [];
    } catch (error) { if (!silent) notify((error as Error).message, true); }
    finally { loading.value = false; }
  }
  function requestQuery(before = '') {
    const query = new URLSearchParams();
    if (before) query.set('before', before);
    for (const [name, value] of Object.entries(requestFilter.value)) if (value) query.set(name, value);
    const text = query.toString();
    return `/requests${text ? `?${text}` : ''}`;
  }
  async function loadUsage() {
    const to = Date.now() + 1; const from = to - (usageBy.value === 'hour' ? 24 : 30 * 24) * 60 * 60 * 1000;
    usage.value = await api<UsageSummary>(`/usage/summary?from=${from}&to=${to}&group_by=${usageBy.value}`);
  }
  async function login() {
    loggingIn.value = true; loginError.value = '';
    try { await session(); auth.value = await api<Session>('/auth/login', 'POST', { email: email.value, password: password.value }); hadSession = true; password.value = ''; await reload(); }
    catch (error) { loginError.value = (error as Error).message; }
    finally { loggingIn.value = false; }
  }
  async function logout() {
    try { intentionalLogout = true; await api('/auth/session', 'DELETE'); unauthorized(); }
    catch (error) { intentionalLogout = false; notify((error as Error).message, true); }
  }
  async function saved(value: Upstream | Client | Group) {
    editor.value = undefined;
    if ('key' in value && value.key) revealed.value = { name: value.name, key: value.key };
    notify('已安全保存'); await reload(true);
  }
  async function run(id: string, work: () => Promise<void>) {
    if (busy.value) { notify('上一项操作仍在进行，请稍候', true); return; }
    busy.value = id;
    try { await work(); } catch (error) { notify((error as Error).message, true); } finally { busy.value = ''; }
  }
  async function toggle(kind: 'upstreams' | 'clients', row: Upstream | Client) {
    if (row.enabled && kind === 'upstreams' && (row as Upstream).inflight > 0) { confirmation.value = { kind, id: row.id, name: row.name, action: 'disable' }; return; }
    await run(row.id, async () => { await api(`/${kind}/${row.id}`, 'PATCH', { enabled: !row.enabled }); await reload(true); notify(row.enabled ? '已停用' : '已启用'); });
  }
  async function checkProxy(row: Upstream) { await run(`proxy:${row.id}`, async () => {
    const updated = await api<Upstream>(`/upstreams/${row.id}/proxy/check`, 'POST', {});
    const index = upstreams.value.findIndex(value => value.id === row.id); if (index >= 0) upstreams.value[index] = updated;
    const result = updated.proxy_probe;
    notify(result?.success ? `出口 ${result.exit_ip} · ${result.country_code || '地区未知'} · ${result.latency_ms} ms` : result?.message || '代理出口检测失败', !result?.success);
  }); }
  function toggleAll() { selected.value = selected.value.length === filteredUpstreams.value.length ? [] : filteredUpstreams.value.map(row => row.id); }
  async function batch(enabled: boolean) {
    if (!selected.value.length) return;
    if (!enabled) { confirmation.value = { kind: 'upstreams', id: '', name: `${selected.value.length} 个上游账号`, action: 'batch-disable' }; return; }
    await applyBatch(true);
  }
  async function applyBatch(enabled: boolean) { await run('batch', async () => { await api('/upstreams/batch', 'POST', { ids: selected.value, enabled }); selected.value = []; await reload(true); notify(enabled ? '已批量启用' : '已批量停用'); }); }
  async function confirmAction() {
    const value = confirmation.value; if (!value) return;
    if (value.action === 'batch-disable') { confirmation.value = undefined; await applyBatch(false); return; }
    if (value.action === 'disable') { confirmation.value = undefined; const row = upstreams.value.find(item => item.id === value.id); if (row) await run(row.id, async () => { await api(`/upstreams/${row.id}`, 'PATCH', { enabled: false }); await reload(true); notify('已停用'); }); return; }
    await run('confirm', async () => {
      if (value.action === 'rotate') { const result = await api<Client>(`/clients/${value.id}/rotate`, 'POST', { grace_seconds: grace.value }); confirmation.value = undefined; revealed.value = { name: value.name, key: result.key! }; }
      else if (value.kind === 'sessions') { await api('/auth/sessions/others', 'DELETE'); confirmation.value = undefined; notify('其他会话已全部注销'); }
      else { await api(`/${value.kind}/${value.id}`, 'DELETE'); confirmation.value = undefined; notify('已撤销并删除'); }
      await reload(true);
    });
  }
  function browseGroup(kind: 'upstreams' | 'clients', group: Group) { navigate(kind); groupFilter.value = group.id; }
  function selectAccount(id: string, destination: Page) { accountId.value = id; navigate(destination); }
  function openAlert(item: AlertItem) { acknowledge(item.id); alertsOpen.value = false; if (item.target && (item.page === 'upstreams' || item.page === 'test' || item.page === 'models')) selectAccount(item.target, item.page as Page); else navigate(item.page as Page); }
  function resetModelDraft() { modelDraft.value = account.value?.whitelist.filter(model => !model.endsWith('*')) || []; manualModels.value = account.value?.whitelist.filter(model => model.endsWith('*')).join('\n') || ''; }
  async function refreshModels() {
    if (!accountId.value) return;
    await run('refresh', async () => {
      const data = await api<Upstream>(`/upstreams/${accountId.value}/models/refresh`, 'POST', {});
      const index = upstreams.value.findIndex(row => row.id === data.id); if (index >= 0) upstreams.value[index] = data;
      notify(`目录验证通过，已拉取 ${data.models.length} 个模型`);
      if (page.value === 'test') events.value = [{ event: 'catalog', message: `凭据与网络验证通过 · ${data.models.length} 个模型`, ms: data.latency_ms ?? undefined }];
      await reload(true);
    });
  }
  function selectVisibleModels() { modelDraft.value = [...new Set([...modelDraft.value, ...catalog.value.map(model => model.id)])]; }
  async function saveModels() { await run('models', async () => { const whitelist = splitRules([...modelDraft.value, manualModels.value].join('\n')); await api(`/upstreams/${accountId.value}`, 'PATCH', { whitelist }); await reload(true); resetModelDraft(); notify('模型白名单已更新'); }); }
  async function startTest() {
    if (testing.value) return;
    testing.value = true; output.value = ''; events.value = []; abortTest = new AbortController();
    try {
      await testStream(accountId.value, { model: testModel.value, prompt: prompt.value, protocol: testProtocol.value }, abortTest.signal, (event, data) => {
        if (event === 'text') { output.value += String(data.text || ''); return; }
        events.value.push({ event, message: event === 'done' && !data.success ? String(data.error || '测试失败') : ({ connecting: '正在连接上游', connected: '上游连接已建立', first_byte: '收到首字节', done: '测试完成' } as Record<string, string>)[event] || event, ms: typeof data.elapsed_ms === 'number' ? data.elapsed_ms : undefined });
        if (event === 'done' && !data.success) notify(String(data.error || '测试失败'), true);
      });
    } catch (error) { events.value.push({ event: 'error', message: abortTest.signal.aborted ? '测试已停止' : (error as Error).message }); }
    finally { testing.value = false; await reload(true); }
  }
  async function changePassword() {
    if (newPassword.value !== repeatPassword.value) return notify('两次输入的新密码不一致', true);
    await run('password', async () => { await api('/auth/password', 'PATCH', { current_password: currentPassword.value, password: newPassword.value }); currentPassword.value = ''; newPassword.value = ''; repeatPassword.value = ''; notify('密码已修改，其他会话已注销'); });
  }
  async function moreAudits() { await run('audit', async () => { const last = audits.value.at(-1); if (!last) return; const result = await api<{ data: Audit[] }>(`/audit?before=${last.id}`); if (!result.data.length) notify('已加载全部记录'); else audits.value.push(...result.data); }); }
  async function moreRequests() { await run('requests', async () => { const last = requests.value.at(-1); if (!last) return; const result = await api<{ data: RequestLog[] }>(requestQuery(String(last.id))); if (!result.data.length) notify('已加载全部记录'); else requests.value.push(...result.data); }); }
  async function applyRequestFilter() { requests.value = []; await run('requests', async () => { requests.value = (await api<{ data: RequestLog[] }>(requestQuery())).data || []; }); }
  function onKeydown(event: KeyboardEvent) { if (event.key === 'Escape' && mobileNav.value && !confirmation.value && !editor.value && !revealed.value) mobileNav.value = false; }
  watch(filteredUpstreams, rows => { const ids = new Set(rows.map(row => row.id)); selected.value = selected.value.filter(id => ids.has(id)); });
  watch(accountId, resetModelDraft);
  watch(testModels, values => { if (!values.includes(testModel.value)) testModel.value = values[0] || ''; });
  watch(page, value => { if (value === 'models') resetModelDraft(); if (value === 'audit' || value === 'usage' || value === 'requests') void reload(true); if (value !== 'test') abortTest?.abort(); });
  watch(usageBy, () => { if (page.value === 'usage') void loadUsage().catch(error => notify((error as Error).message, true)); });
  onMounted(async () => {
    fromHash(); window.addEventListener('hashchange', fromHash); window.addEventListener('cc:unauthorized', unauthorized); window.addEventListener('keydown', onKeydown);
    try { const value = await session(); if (value.email) { auth.value = value; hadSession = true; await reload(); } }
    catch (error) { loginError.value = (error as Error).message; }
    finally { booting.value = false; }
    timer = setInterval(() => { if (auth.value?.email && !testing.value && !busy.value && !document.hidden) void reload(true); }, 15000);
  });
  onBeforeUnmount(() => { clearInterval(timer); stop(); abortTest?.abort(); window.removeEventListener('hashchange', fromHash); window.removeEventListener('cc:unauthorized', unauthorized); window.removeEventListener('keydown', onKeydown); });
  return {
    page, mobileNav, auth, booting, email, password, loginError, loggingIn, overview, upstreams, clients, groups, audits, alerts, health, requests, usage, usageBy, requestFilter, loaded, refreshedAt, loading, busy, groupFilter, search, selected, editor, revealed, confirmation, grace, accountId, modelSearch, modelDraft, manualModels, testModel, prompt, testing, output, events, testProtocol, currentPassword, newPassword, repeatPassword, alertsOpen, toasts, groupName, filteredUpstreams, filteredClients, account, catalog, testModels, successRate, openAlerts, baseUrl, notify, dismiss, copyText, navigate, login, logout, reload, saved, run, toggle, checkProxy, toggleAll, batch, confirmAction, browseGroup, selectAccount, openAlert, acknowledge, refreshModels, selectVisibleModels, saveModels, startTest, changePassword, moreAudits, moreRequests, applyRequestFilter, abortTest: () => abortTest?.abort(),
  };
}
export type ConsoleWorkspace = ReturnType<typeof createConsole>;
