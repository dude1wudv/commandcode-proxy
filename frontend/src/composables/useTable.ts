import { computed, reactive, ref, watch, type Ref } from 'vue';

export function useTable<T>(source: Ref<T[]>, pageSize = 50) {
  const sortKey = ref('');
  const sortDir = ref<1 | -1>(1);
  const page = ref(1);
  const sorted = computed(() => {
    const key = sortKey.value;
    if (!key) return source.value;
    return [...source.value].sort((a, b) => {
      const left = (a as Record<string, unknown>)[key];
      const right = (b as Record<string, unknown>)[key];
      const result = typeof left === 'number' && typeof right === 'number' ? left - right : String(left ?? '').localeCompare(String(right ?? ''), 'zh-CN');
      return result * sortDir.value;
    });
  });
  const pages = computed(() => Math.max(1, Math.ceil(sorted.value.length / pageSize)));
  const rows = computed(() => sorted.value.slice((page.value - 1) * pageSize, page.value * pageSize));
  function sortBy(key: string) {
    if (sortKey.value === key) sortDir.value = sortDir.value === 1 ? -1 : 1;
    else { sortKey.value = key; sortDir.value = 1; }
    page.value = 1;
  }
  watch(source, () => { if (page.value > pages.value) page.value = pages.value; });
  watch(pages, value => { if (page.value > value) page.value = value; });
  return reactive({ sortKey, sortDir, page, pages, rows, sortBy });
}
