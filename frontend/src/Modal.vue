<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref, nextTick } from 'vue';
import { X } from 'lucide-vue-next';
const props = defineProps<{ title: string; wide?: boolean; alert?: boolean }>();
const emit = defineEmits<{ close: [] }>();
const panel = ref<HTMLElement>();
let previous: HTMLElement | null = null;
const background: Element[] = [];
function keydown(event: KeyboardEvent) {
  if (event.key === 'Escape') emit('close');
  if (event.key !== 'Tab') return;
  const elements = Array.from(panel.value?.querySelectorAll<HTMLElement>('a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]') || []);
  if (!elements.length) return;
  const first = elements[0]; const last = elements[elements.length - 1];
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
}
onMounted(async () => {
  previous = document.activeElement as HTMLElement; document.addEventListener('keydown', keydown); document.body.classList.add('modal-open');
  document.querySelectorAll('.workspace, .login-layout, .boot-screen, .glacier-scene, .toast-stack').forEach(node => { node.setAttribute('inert', ''); background.push(node); });
  await nextTick();
  const field = panel.value?.querySelector<HTMLElement>('input:not(:disabled), select:not(:disabled), textarea:not(:disabled)');
  (field || panel.value?.querySelector<HTMLElement>('button.secondary, button:not(.icon-button)'))?.focus();
});
onBeforeUnmount(() => { document.removeEventListener('keydown', keydown); document.body.classList.remove('modal-open'); background.forEach(node => node.removeAttribute('inert')); previous?.focus(); });
</script>
<template>
  <div class="modal-backdrop" @click.self="emit('close')">
    <section ref="panel" class="modal" :class="{ wide }" :role="props.alert ? 'alertdialog' : 'dialog'" aria-modal="true" aria-labelledby="modal-title">
      <header class="modal-header"><div><span class="eyebrow">工作空间</span><h2 id="modal-title">{{ title }}</h2></div><button class="icon-button" aria-label="关闭弹窗" @click="emit('close')"><X :size="20" /></button></header>
      <slot />
    </section>
  </div>
</template>
