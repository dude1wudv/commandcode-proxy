<script setup lang="ts">
import { computed } from 'vue';
import { useConsole } from '../composables/useConsole';
import { countText } from '../utils/format';
const workspace = useConsole();
const max = computed(() => Math.max(1, ...(workspace.usage?.rows.map(row => row.tokens) || [1])));
const points = computed(() => {
  const rows = workspace.usage?.group_by === 'hour' ? workspace.usage.rows : [];
  if (rows.length < 2) return '';
  return rows.map((row, index) => `${(index / (rows.length - 1)) * 280},${70 - (row.tokens / max.value) * 60}`).join(' ');
});
</script>
<template>
  <div class="table-toolbar"><label>统计维度<select v-model="workspace.usageBy" aria-label="用量统计维度"><option value="hour">近 24 小时</option><option value="model">按模型</option><option value="client">按出口 key</option><option value="upstream">按上游账号</option></select></label><span class="muted">缓存命中 {{ workspace.usage ? Math.round(workspace.usage.cache_rate * 1000) / 10 : 0 }}% · 请求 {{ countText(workspace.usage?.requests) }}</span></div>
  <section class="panel"><header class="panel-header"><div><h3>用量趋势</h3><p>只统计模型、token 与状态，不保存提示词或响应正文</p></div></header><svg v-if="points" class="usage-chart" viewBox="0 0 280 80" role="img" aria-label="token 趋势"><polyline :points="points" fill="none" stroke="currentColor" stroke-width="2" /></svg><div v-else class="empty-state"><h3>这个时段还没有足够的请求</h3></div></section>
  <section class="panel table-panel"><div class="table-scroll"><table><thead><tr><th scope="col">{{ { hour: '时间', model: '模型', client: '出口 key', upstream: '上游账号' }[workspace.usageBy] }}</th><th scope="col">请求</th><th scope="col">token</th><th scope="col">缓存 token</th></tr></thead><tbody><tr v-for="row in workspace.usage?.rows || []" :key="row.key || 'empty'"><td>{{ row.key || '未记录' }}</td><td>{{ countText(row.requests) }}</td><td>{{ countText(row.tokens) }}</td><td>{{ countText(row.cached_tokens) }}</td></tr></tbody></table></div></section>
</template>
