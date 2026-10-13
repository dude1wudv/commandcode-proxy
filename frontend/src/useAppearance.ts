import { computed, ref } from 'vue';

export type AppearancePreference = 'light' | 'dark' | 'system';
const preference = ref<AppearancePreference>('system');
const systemDark = ref(false);
const storageKey = 'commandcode-appearance';
let media: MediaQueryList | undefined;

function readPreference(): AppearancePreference | null {
  try {
    const saved = localStorage.getItem(storageKey);
    return saved === 'light' || saved === 'dark' || saved === 'system' ? saved : null;
  } catch { return null; }
}
function systemMatches() {
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches === true;
}
function resolvedDark() {
  return preference.value === 'system' ? systemDark.value : preference.value === 'dark';
}
function applyAppearance() {
  const dark = resolvedDark();
  document.documentElement.dataset.appearance = dark ? 'dark' : 'light';
  document.documentElement.dataset.themePreference = preference.value;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#0e2034' : '#d8e9f6');
}

export function initAppearance() {
  preference.value = readPreference() || 'system';
  systemDark.value = systemMatches();
  applyAppearance();
  if (!media) {
    media = window.matchMedia?.('(prefers-color-scheme: dark)');
    media?.addEventListener?.('change', event => { systemDark.value = event.matches; applyAppearance(); });
  }
}

export function useAppearance() {
  function cycleAppearance() {
    preference.value = preference.value === 'light' ? 'dark' : preference.value === 'dark' ? 'system' : 'light';
    applyAppearance();
    try { localStorage.setItem(storageKey, preference.value); } catch { /* Keep the session choice. */ }
  }
  const label = computed(() => preference.value === 'system' ? '跟随系统' : preference.value === 'dark' ? '深色' : '浅色');
  return { isDark: computed(resolvedDark), preference, label, cycleAppearance, toggleAppearance: cycleAppearance };
}
