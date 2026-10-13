import { ref } from 'vue';

export function useHashRoute<T extends string>(pages: readonly T[], initial: T) {
  const page = ref<T>(initial);
  function navigate(id: T) { page.value = id; location.hash = id; }
  function fromHash() {
    const value = location.hash.slice(1) as T;
    if (pages.includes(value)) page.value = value;
  }
  return { page, navigate, fromHash };
}
