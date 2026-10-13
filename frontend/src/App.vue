<script setup lang="ts">
import { computed } from 'vue';
import { Activity, ArrowRight, Bell, Check, CheckCircle2, ChevronRight, CircleHelp, Copy, FileClock, KeyRound, Layers3, LayoutDashboard, LogOut, Menu, Moon, Plus, RefreshCw, Server, Settings2, ShieldCheck, Sun, Terminal, X } from 'lucide-vue-next';
import Modal from './Modal.vue';
import EntityDialog from './EntityDialog.vue';
import GroupsPanel from './GroupsPanel.vue';
import OverviewView from './views/OverviewView.vue';
import UpstreamsView from './views/UpstreamsView.vue';
import TestView from './views/TestView.vue';
import ModelsView from './views/ModelsView.vue';
import ClientsView from './views/ClientsView.vue';
import AuditView from './views/AuditView.vue';
import SettingsView from './views/SettingsView.vue';
import UsageView from './views/UsageView.vue';
import RequestsView from './views/RequestsView.vue';
import { provideConsole, type Page } from './composables/useConsole';
import { useAppearance } from './useAppearance';

const workspace = provideConsole();
const { isDark, label, cycleAppearance } = useAppearance();
const navigation: { id: Page; label: string; icon: typeof LayoutDashboard; group?: string }[] = [
  { id: 'overview', label: '总览', icon: LayoutDashboard, group: '工作空间' },
  { id: 'upstreams', label: '上游账号', icon: Server },
  { id: 'test', label: '账号测试', icon: Terminal },
  { id: 'models', label: '模型配置', icon: Layers3 },
  { id: 'usage', label: '用量统计', icon: Activity },
  { id: 'requests', label: '请求日志', icon: FileClock },
  { id: 'clients', label: '出口 key', icon: KeyRound, group: '访问管理' },
  { id: 'groups', label: '分组管理', icon: Layers3 },
  { id: 'audit', label: '操作审计', icon: FileClock },
  { id: 'settings', label: '安全设置', icon: ShieldCheck },
];
const currentNav = computed(() => navigation.find(item => item.id === workspace.page) || navigation[0]);
const descriptions: Record<Page, string> = { overview: '账号、模型与请求状态，一目了然。', upstreams: '让每个账号各尽其能，让每次请求有序抵达。', test: '从目录连通到真实生成，逐步验证上游状态。', models: '按账号精细配置模型，让可用能力清晰可控。', usage: '按时间和对象查看 token 与缓存命中。', requests: '检索每一次推理的状态、耗时和用量。', clients: '一个内网入口，为每个出口 key 划定独立边界。', groups: '为账号划定独立池，为出口 key 绑定对应账号。', audit: '每一次关键操作，都有迹可循。', settings: '管理你的凭据与会话，守护工作空间。' };
const confirmTitle: Record<string, string> = { rotate: '轮换出口密钥', revoke: '注销其他会话', disable: '停用仍有在途请求的账号', 'batch-disable': '批量停用上游账号', delete: '确认撤销并删除' };
const confirmButton: Record<string, string> = { rotate: '轮换密钥', revoke: '注销其他会话', disable: '停用账号', 'batch-disable': '停用所选账号', delete: '删除' };
function confirmLabel(action: string, kind: string) {
  if (action === 'delete' && kind === 'clients') return '撤销出口 key';
  if (action === 'delete' && kind === 'groups') return '删除分组';
  if (action === 'delete') return '删除账号';
  return confirmButton[action] || '确认';
}
const refreshed = computed(() => workspace.refreshedAt ? `${Math.max(0, Math.round((Date.now() - workspace.refreshedAt) / 1000))} 秒前刷新` : '尚未刷新');
</script>

<template>
  <div class="glacier-scene" aria-hidden="true" />
  <div v-if="workspace.booting" class="boot-screen"><div class="brand-mark"><Terminal :size="25" /></div><span>正在连接工作空间…</span></div>
  <div v-else-if="!workspace.auth?.email" class="login-layout">
    <section class="login-story">
      <a class="brand" href="/command/"><span class="brand-mark"><Terminal :size="24" /></span><span>CommandCode<span class="brand-caption">管理面</span></span></a>
      <div class="login-story-main"><span class="pill light"><span class="status-dot" /> 私有设计</span><h1>连接模型。<br />掌控每一次<span>调用。</span></h1><p>一个安静、有序的工作空间。<br />统一管理上游账号、模型与内网访问。</p>
        <div class="login-diagram"><div><Layers3 :size="20" /><span>模型集群</span></div><span class="diagram-line" /><div class="diagram-core"><Terminal :size="26" /></div><span class="diagram-line" /><div><ShieldCheck :size="20" /><span>私有网络</span></div></div>
      </div>
      <footer><span class="status-dot" /> 管理面与推理面严格隔离 <span>COMMANDCODE / 控制台</span></footer>
    </section>
    <main class="login-form-area"><button class="appearance-control login-appearance" :aria-label="`切换外观，当前为${label}`" @click="cycleAppearance"><Sun v-if="isDark" :size="16" /><Moon v-else :size="16" /><span>{{ label }}</span></button><form class="login-form" @submit.prevent="workspace.login"><span class="eyebrow">欢迎回来</span><h2>登录管理控制台</h2><p>继续管理你的 AI 基础设施。</p><div v-if="workspace.loginError" class="notice error" role="alert">{{ workspace.loginError }}</div><label>管理员邮箱<input v-model="workspace.email" name="email" type="email" required autocomplete="username" /></label><label>密码<input v-model="workspace.password" name="password" type="password" required autocomplete="current-password" placeholder="输入管理员密码" /></label><button class="button primary login-button" :disabled="workspace.loggingIn">{{ workspace.loggingIn ? '正在验证…' : '进入工作空间' }}<ArrowRight :size="18" /></button><div class="login-security"><ShieldCheck :size="16" /><span>安全会话 · 受限访问 · 全程审计</span></div></form><span class="login-footnote">仅供授权管理员使用</span></main>
  </div>
  <div v-else class="workspace">
    <div v-if="workspace.mobileNav" class="sidebar-shade" @click="workspace.mobileNav = false" />
    <aside id="workspace-nav" class="sidebar" :class="{ opened: workspace.mobileNav }">
      <a class="brand" href="#overview" @click.prevent="workspace.navigate('overview')"><span class="brand-mark"><Terminal :size="22" /></span><span>CommandCode<span class="brand-caption">管理面</span></span></a>
      <div class="workspace-label"><span class="workspace-avatar">CC</span><div>默认工作空间<small>私有网关 · 单管理员</small></div><ChevronRight :size="15" /></div>
      <nav aria-label="主导航"><template v-for="item in navigation" :key="item.id"><span v-if="item.group" class="nav-group">{{ item.group }}</span><button :class="['nav-item', { active: workspace.page === item.id }]" :aria-current="workspace.page === item.id ? 'page' : undefined" @click="workspace.navigate(item.id)"><component :is="item.icon" :size="19" /><span>{{ item.label }}</span><span v-if="item.id === 'upstreams'" class="nav-count">{{ workspace.upstreams.length }}</span><span v-if="item.id === 'overview' && workspace.openAlerts.length" class="nav-count">{{ workspace.openAlerts.length }}</span></button></template></nav>
      <div class="sidebar-bottom"><div class="network-note"><ShieldCheck :size="19" /><div>推理接口仅内网开放<small>{{ workspace.baseUrl || '内网地址未配置' }}</small></div></div><button class="profile" @click="workspace.navigate('settings')"><span class="avatar">A</span><span>Administrator<small>工作空间管理员</small></span><Settings2 :size="17" /></button></div>
    </aside>
    <div class="workspace-main">
      <header class="topbar"><div class="breadcrumb"><button class="icon-button menu-button" aria-label="打开导航" aria-controls="workspace-nav" :aria-expanded="workspace.mobileNav" @click="workspace.mobileNav = true"><Menu :size="20" /></button><span>工作空间</span><ChevronRight :size="14" /><strong>{{ currentNav.label }}</strong></div><div class="topbar-actions"><button class="appearance-control" :aria-label="`切换外观，当前为${label}`" @click="cycleAppearance"><span>{{ label }}</span><Sun v-if="isDark" :size="16" /><Moon v-else :size="16" /></button><span class="private-label"><span class="status-dot" /> {{ refreshed }}</span><span class="topbar-divider" /><button class="icon-button" aria-label="告警" :aria-expanded="workspace.alertsOpen" @click="workspace.alertsOpen = !workspace.alertsOpen"><Bell :size="17" /><span v-if="workspace.openAlerts.length" class="nav-count">{{ workspace.openAlerts.length }}</span></button><button class="icon-button" :disabled="workspace.loading" aria-label="刷新数据" @click="workspace.reload()"><RefreshCw :size="17" :class="{ spinning: workspace.loading }" /></button><button class="icon-button" aria-label="退出登录" @click="workspace.logout"><LogOut :size="17" /></button></div><div v-if="workspace.alertsOpen" class="alert-panel"><button v-for="item in workspace.alerts" :key="item.id" @click="workspace.openAlert(item)"><strong>{{ item.title }}</strong><span>{{ item.message }}</span></button><p v-if="!workspace.alerts.length">当前没有告警</p></div></header>
      <main class="page-content">
        <div v-if="!workspace.loaded" class="skeleton-grid" aria-hidden="true"><span /><span /><span /><span /></div>
        <template v-else>
        <header class="page-heading"><div><span class="eyebrow">工作空间 / {{ currentNav.label }}</span><h1>{{ workspace.page === 'overview' ? '工作空间总览' : currentNav.label }}<span v-if="workspace.page === 'overview'" class="heading-dot" /></h1><p>{{ descriptions[workspace.page] }}</p></div><button v-if="workspace.page === 'upstreams' || workspace.page === 'clients' || workspace.page === 'groups'" class="button primary" @click="workspace.editor = { kind: workspace.page }"><Plus :size="18" />{{ workspace.page === 'groups' ? '新建分组' : workspace.page === 'upstreams' ? '新建上游账号' : '创建出口 key' }}</button><span v-else-if="workspace.page === 'overview'" class="date-chip">{{ new Date().toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' }) }}</span></header>
        <OverviewView v-if="workspace.page === 'overview'" />
        <UpstreamsView v-else-if="workspace.page === 'upstreams'" />
        <TestView v-else-if="workspace.page === 'test'" />
        <ModelsView v-else-if="workspace.page === 'models'" />
        <UsageView v-else-if="workspace.page === 'usage'" />
        <RequestsView v-else-if="workspace.page === 'requests'" />
        <ClientsView v-else-if="workspace.page === 'clients'" />
        <GroupsPanel v-else-if="workspace.page === 'groups'" :groups="workspace.groups" :upstreams="workspace.upstreams" :clients="workspace.clients" :busy="!!workspace.busy" @edit="workspace.editor = { kind: 'groups', item: $event }" @remove="workspace.confirmation = { kind: 'groups', id: $event.id, name: $event.name, action: 'delete' }" @browse="workspace.browseGroup" />
        <AuditView v-else-if="workspace.page === 'audit'" />
        <SettingsView v-else-if="workspace.page === 'settings'" />
        <footer class="page-footer"><span>CommandCode 控制台</span><span>私有连接，清晰掌控。</span></footer>
        </template>
      </main>
    </div>
  </div>
  <div class="toast-stack">
    <div v-for="item in workspace.toasts" :key="item.id" :class="['toast', { error: item.error }]" :role="item.error ? 'alert' : 'status'"><CheckCircle2 v-if="!item.error" :size="19" /><CircleHelp v-else :size="19" /><span>{{ item.message }}</span><button aria-label="关闭提示" @click="workspace.dismiss(item.id)"><X :size="16" /></button></div>
  </div>
  <EntityDialog v-if="workspace.editor" :kind="workspace.editor.kind" :item="workspace.editor.item" :groups="workspace.groups" :default-group-id="workspace.groupFilter || 'default'" @close="workspace.editor = undefined" @saved="workspace.saved" />
  <Modal v-if="workspace.revealed" title="请妥善保存这枚密钥" @close="workspace.revealed = undefined"><div class="form-stack"><div class="notice"><ShieldCheck :size="18" /><span>这是唯一一次显示完整密钥的机会。关闭后无法再次查看，请存入安全的密码管理器。</span></div><label>{{ workspace.revealed.name }}<textarea class="secret-key mono" :value="workspace.revealed.key" readonly rows="3" aria-label="一次性 API 密钥" /></label><div class="form-grid"><button class="button secondary" @click="workspace.copyText(workspace.revealed.key)"><Copy :size="16" />复制密钥</button><button class="button secondary" @click="workspace.copyText(JSON.stringify({ base_url: workspace.baseUrl, api_key: workspace.revealed.key }, null, 2))"><Copy :size="16" />复制配置</button></div><footer class="modal-footer"><button class="button primary" @click="workspace.revealed = undefined"><Check :size="17" />我已安全保存</button></footer></div></Modal>
  <Modal v-if="workspace.confirmation" alert :title="confirmTitle[workspace.confirmation.action] || '确认操作'" @close="!workspace.busy && (workspace.confirmation = undefined)"><div class="form-stack"><p class="confirm-description">{{ workspace.confirmation.action === 'rotate' ? `即将为「${workspace.confirmation.name}」生成新密钥。请及时更新客户端配置。` : workspace.confirmation.action === 'revoke' ? '除当前会话外，所有登录会话将立即失效。' : workspace.confirmation.action === 'disable' ? `「${workspace.confirmation.name}」仍有在途请求。停用后新请求不再调度到它，已开始的请求会继续完成。` : workspace.confirmation.action === 'batch-disable' ? `即将停用${workspace.confirmation.name}。` : `「${workspace.confirmation.name}」将被删除，此操作不可撤销。已发送的请求不会重新播放。` }}</p><label v-if="workspace.confirmation.action === 'rotate'">新旧密钥并行窗口<select v-model.number="workspace.grace"><option :value="0">立即失效旧密钥（默认）</option><option :value="60">1 分钟</option><option :value="300">5 分钟</option><option :value="900">15 分钟</option><option :value="3600">1 小时</option></select><small>窗口结束后，旧密钥自动失效。</small></label><footer class="modal-footer"><button class="button secondary" :disabled="!!workspace.busy" @click="workspace.confirmation = undefined">取消</button><button :class="['button', workspace.confirmation.action === 'delete' ? 'destructive' : 'primary']" :disabled="!!workspace.busy" @click="workspace.confirmAction">{{ workspace.busy ? '正在处理…' : confirmLabel(workspace.confirmation.action, workspace.confirmation.kind) }}</button></footer></div></Modal>
</template>
