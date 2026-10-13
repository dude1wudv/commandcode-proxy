export const dateText = (value?: number | null) => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '尚无记录';
export const countText = (value = 0) => new Intl.NumberFormat('zh-CN').format(value);
export const splitRules = (value: string) => [...new Set(value.split(/[\n,，]/).map(item => item.trim()).filter(Boolean))];
export const rulePattern = /^[A-Za-z0-9][A-Za-z0-9_./:@+-]*\*?$/;
export function proxyError(value: string) {
  const text = value.trim();
  if (!text) return '';
  try {
    const url = new URL(text);
    if (!['http:', 'https:', 'socks5:'].includes(url.protocol) || !url.hostname) return '仅支持带主机名的 http、https 或 socks5 链接';
  } catch { return '代理链接需要是完整 URL'; }
  return '';
}
