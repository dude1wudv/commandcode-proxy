<script setup lang="ts">
import { computed, reactive, ref } from 'vue';
import Modal from './Modal.vue';
import { api, type Upstream, type Client, type Group } from './api';
import { proxyError, rulePattern, splitRules } from './utils/format';
const props = defineProps<{ kind: 'upstreams' | 'clients' | 'groups'; item?: Upstream | Client | Group; groups?: Group[]; defaultGroupId?: string }>();
const emit = defineEmits<{ close: []; saved: [value: Upstream | Client | Group] }>();
const source = props.item as Upstream | undefined;
const client = props.item as Client | undefined;
const form = reactive({ name: props.item?.name || '', notes: props.item?.notes || '', group_id: source?.group_id ?? (props.item ? 'default' : props.defaultGroupId || 'default'), enabled: source?.enabled ?? true, credential: '', proxy_url: '', remove_proxy: false, provider_responses_enabled: source?.provider_responses_enabled ?? false, priority: source?.priority ?? 0, load_factor: source?.load_factor ?? 1, max_concurrency: source?.max_concurrency ?? 2, whitelist: source?.whitelist?.join('\n') || '', expires: client?.expires_at ? localDate(client.expires_at) : '', rpm_limit: client?.rpm_limit ?? '', client_concurrency: client?.max_concurrency ?? '', daily_token_limit: client?.daily_token_limit ?? '', monthly_token_limit: client?.monthly_token_limit ?? '' });
const pending = ref(false); const error = ref('');
const proxyMessage = computed(() => props.kind === 'upstreams' ? proxyError(form.proxy_url) : '');
const rules = computed(() => splitRules(form.whitelist));
const whitelistMessage = computed(() => rules.value.find(rule => !rulePattern.test(rule)) ? `无法识别的规则：${rules.value.find(rule => !rulePattern.test(rule))}` : '');
const expiresMessage = computed(() => form.expires && new Date(form.expires).getTime() <= Date.now() ? '过期时间必须是未来时间' : '');
const limitMessage = computed(() => {
  if (props.kind !== 'clients') return '';
  for (const [label, value] of [['每分钟请求', form.rpm_limit], ['并发', form.client_concurrency], ['当日 token', form.daily_token_limit], ['当月 token', form.monthly_token_limit]] as const) {
    if (value === '' || value === null) continue;
    if (!Number.isInteger(Number(value)) || Number(value) < 1) return `${label} 需要是正整数，或留空表示不限制`;
  }
  return '';
});
function optionalLimit(value: string | number | null) { return value === '' || value === null ? null : Number(value); }
function localDate(value: number) { const d = new Date(value); return new Date(value - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16); }
async function save() {
  pending.value = true; error.value = '';
  try {
    const data: Record<string, unknown> = { name: form.name, notes: form.notes };
    if (proxyMessage.value || whitelistMessage.value || expiresMessage.value || limitMessage.value) { error.value = proxyMessage.value || whitelistMessage.value || expiresMessage.value || limitMessage.value; pending.value = false; return; }
    if (props.kind !== 'groups') Object.assign(data, { group_id: form.group_id, enabled: form.enabled, whitelist: rules.value });
    if (props.kind === 'upstreams') {
      Object.assign(data, { priority: form.priority, load_factor: form.load_factor, max_concurrency: form.max_concurrency, provider_responses_enabled: form.provider_responses_enabled });
      if (form.credential || !props.item) data.credential = form.credential;
      if (form.remove_proxy) data.proxy_url = null;
      else if (form.proxy_url.trim()) data.proxy_url = form.proxy_url.trim();
    } else if (props.kind === 'clients') Object.assign(data, { expires_at: form.expires ? new Date(form.expires).getTime() : null, rpm_limit: optionalLimit(form.rpm_limit), max_concurrency: optionalLimit(form.client_concurrency), daily_token_limit: optionalLimit(form.daily_token_limit), monthly_token_limit: optionalLimit(form.monthly_token_limit) });
    const result = await api<Upstream | Client | Group>(`/${props.kind}${props.item ? `/${props.item.id}` : ''}`, props.item ? 'PATCH' : 'POST', data);
    form.credential = ''; form.proxy_url = ''; emit('saved', result);
  } catch (e) { error.value = (e as Error).message; }
  finally { pending.value = false; }
}
</script>
<template>
  <Modal :title="`${item ? '编辑' : '新建'}${kind === 'groups' ? '分组' : kind === 'upstreams' ? '上游账号' : '出口 key'}`" @close="!pending && emit('close')">
    <form class="form-stack" @submit.prevent="save">
      <div v-if="error" class="notice error" role="alert">{{ error }}</div>
      <label>名称<input v-model="form.name" name="name" required maxlength="100" placeholder="例如：CommandCode 主账号" /></label>
      <label>备注 <span class="optional">可选</span><textarea v-model="form.notes" name="notes" rows="2" maxlength="2000" placeholder="记录用途，不要填写密钥或密码" /></label>
      <label v-if="kind !== 'groups'">所属分组<select v-model="form.group_id" name="group_id" required><option v-for="group in groups || [{ id: 'default', name: '默认分组' }]" :key="group.id" :value="group.id">{{ group.name }}</option></select><small>{{ kind === 'upstreams' ? '此账号仅接收同组出口 key 的请求。' : '此出口 key 仅使用同组上游账号，模型白名单继续生效。' }}</small></label>
      <template v-if="kind === 'upstreams'">
        <label>上游凭据 <span class="optional">{{ item ? '留空则不修改' : '仅加密保存' }}</span><input v-model="form.credential" name="credential" type="password" :required="!item" autocomplete="new-password" placeholder="user_…" /></label>
        <label>账号专属代理 <span class="optional">{{ source?.proxy_label ? `当前：${source.proxy_label}；留空则不修改` : '可选，留空沿用全局设置' }}</span><input v-model="form.proxy_url" name="proxy_url" type="password" maxlength="2048" autocomplete="new-password" :disabled="form.remove_proxy" :aria-invalid="!!proxyMessage" placeholder="socks5://user:pass@host:port 或 https://user:pass@host:port" /><small>每个上游账号可独立设置 HTTP、HTTPS 或 SOCKS5 代理，链接加密保存。</small><small v-if="proxyMessage" class="field-error">{{ proxyMessage }}</small></label>
        <label v-if="source?.proxy_label" class="check-label"><input v-model="form.remove_proxy" name="remove_proxy" type="checkbox" /><span>移除此账号的专属代理</span></label>
        <label class="check-label"><input v-model="form.provider_responses_enabled" name="provider_responses_enabled" type="checkbox" /><span>启用官方原生 Responses</span></label>
        <small>仅对已验证具备 Provider API 权限的账号开启（Go 不支持）。Chat/Messages 保持原链路；模型还须在白名单及官方 Responses 目录内。</small>
        <div class="form-grid thirds">
          <label>优先级<input v-model.number="form.priority" name="priority" type="number" min="0" max="1000" required /><small>数值越小越优先</small></label>
          <label>负载因子<input v-model.number="form.load_factor" name="load_factor" type="number" min="1" max="1000" required /><small>同层流量权重</small></label>
          <label>最大并发<input v-model.number="form.max_concurrency" name="max_concurrency" type="number" min="1" max="128" required /><small>单账号在途上限</small></label>
        </div>
      </template>
      <template v-else-if="kind === 'clients'">
        <label>过期时间 <span class="optional">留空则不过期</span><input v-model="form.expires" name="expires_at" type="datetime-local" /><small v-if="expiresMessage" class="field-error">{{ expiresMessage }}</small></label>
        <div class="form-grid">
          <label>每分钟请求 <span class="optional">留空不限制</span><input v-model="form.rpm_limit" name="rpm_limit" type="number" min="1" /></label>
          <label>并发上限 <span class="optional">留空不限制</span><input v-model="form.client_concurrency" name="client_concurrency" type="number" min="1" /></label>
          <label>当日 token <span class="optional">留空不限制</span><input v-model="form.daily_token_limit" name="daily_token_limit" type="number" min="1" /></label>
          <label>当月 token <span class="optional">留空不限制</span><input v-model="form.monthly_token_limit" name="monthly_token_limit" type="number" min="1" /></label>
        </div>
        <small v-if="limitMessage" class="field-error">{{ limitMessage }}</small>
      </template>
      <label v-if="kind !== 'groups'">模型白名单<textarea v-model="form.whitelist" name="whitelist" class="mono" rows="3" placeholder="每行一个模型，例如 claude-*&#10;留空表示不限制" /><small>精确名称或尾部 * 前缀匹配；实际权限仍受上游可用模型限制。</small><small v-if="rules.length">将保存 {{ rules.length }} 条规则：{{ rules.slice(0, 4).join('、') }}{{ rules.length > 4 ? '…' : '' }}</small><small v-if="whitelistMessage" class="field-error">{{ whitelistMessage }}</small></label>
      <label v-if="kind !== 'groups'" class="check-label"><input v-model="form.enabled" name="enabled" type="checkbox" /><span>启用{{ kind === 'upstreams' ? '此上游账号' : '此客户端 API' }}</span></label>
      <footer class="modal-footer"><button type="button" class="button secondary" :disabled="pending" @click="emit('close')">取消</button><button class="button primary" :disabled="pending">{{ pending ? '正在保存…' : item ? '保存更改' : '创建' }}</button></footer>
    </form>
  </Modal>
</template>
