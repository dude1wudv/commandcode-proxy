<script setup lang="ts">
import { Layers3, Pencil, Server, KeyRound, Trash2 } from 'lucide-vue-next';
import type { Group, Upstream, Client } from './api';
defineProps<{ groups: Group[]; upstreams: Upstream[]; clients: Client[]; busy: boolean }>();
const emit = defineEmits<{ edit: [group: Group]; remove: [group: Group]; browse: [kind: 'upstreams' | 'clients', group: Group] }>();
</script>
<template>
  <div class="info-strip"><Layers3 :size="18" /><span>出口 key 仅调用同组账号；组内继续按优先级、权重和并发限制调度。空分组无法发起推理请求。</span></div>
  <section class="panel table-panel">
    <div class="table-scroll"><table>
      <thead><tr><th>分组</th><th>上游账号</th><th>出口 key</th><th class="align-right">操作</th></tr></thead>
      <tbody><tr v-for="group in groups" :key="group.id">
        <td><div class="entity-name"><span class="entity-avatar"><Layers3 :size="17" /></span><div><strong>{{ group.name }}</strong><small>{{ group.notes || (group.id === 'default' ? '现有账号与 key 的默认归属' : '独立账号池') }}</small></div></div></td>
        <td><button class="text-button" @click="emit('browse', 'upstreams', group)"><Server :size="15" />{{ upstreams.filter(row => row.group_id === group.id).length }} 个账号</button></td>
        <td><button class="text-button" @click="emit('browse', 'clients', group)"><KeyRound :size="15" />{{ clients.filter(row => row.group_id === group.id).length }} 个客户端</button></td>
        <td><div class="row-actions"><button class="icon-button" :aria-label="`编辑分组 ${group.name}`" @click="emit('edit', group)"><Pencil :size="16" /></button><button class="icon-button danger" :disabled="busy || group.id === 'default' || upstreams.some(row => row.group_id === group.id) || clients.some(row => row.group_id === group.id)" :aria-label="`删除分组 ${group.name}`" title="仅可删除没有账号和出口 key 的非默认分组" @click="emit('remove', group)"><Trash2 :size="16" /></button></div></td>
      </tr></tbody>
    </table></div>
  </section>
</template>
