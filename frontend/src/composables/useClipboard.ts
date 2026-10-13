export function useClipboard(notify: (message: string, error?: boolean) => void) {
  return async function copyText(value: string) {
    try { await navigator.clipboard.writeText(value); notify('已复制到剪贴板'); }
    catch { notify('剪贴板不可用，请手动选择复制', true); }
  };
}
