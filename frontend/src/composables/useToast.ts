import { ref } from 'vue';

export interface Toast { id: number; message: string; error: boolean }
export function useToast() {
  const toasts = ref<Toast[]>([]);
  let next = 0;
  const timers = new Map<number, ReturnType<typeof setTimeout>>();
  function dismiss(id: number) { toasts.value = toasts.value.filter(item => item.id !== id); clearTimeout(timers.get(id)); timers.delete(id); }
  function notify(message: string, error = false) {
    const id = ++next;
    toasts.value = [...toasts.value.slice(-4), { id, message, error }];
    timers.set(id, setTimeout(() => dismiss(id), 6500));
  }
  function stop() { for (const timer of timers.values()) clearTimeout(timer); }
  return { toasts, notify, dismiss, stop };
}
