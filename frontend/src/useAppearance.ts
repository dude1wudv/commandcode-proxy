import { computed, ref } from 'vue';

const mode = ref<'light' | 'dark'>('light');
const storageKey = 'commandcode-appearance';

export function initAppearance() {
  let saved: string | null = null;
  try { saved = localStorage.getItem(storageKey); } catch { /* Use system preference. */ }
  mode.value = saved === 'light' || saved === 'dark' ? saved
    : window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  document.documentElement.dataset.appearance = mode.value;
}

export function useAppearance() {
  function toggleAppearance() {
    mode.value = mode.value === 'light' ? 'dark' : 'light';
    document.documentElement.dataset.appearance = mode.value;
    try { localStorage.setItem(storageKey, mode.value); } catch { /* Keep the session choice. */ }
  }
  return { isDark: computed(() => mode.value === 'dark'), toggleAppearance };
}
