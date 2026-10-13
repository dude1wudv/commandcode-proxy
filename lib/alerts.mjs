const WEEK = 7 * 24 * 60 * 60 * 1000;

export function buildAlerts({ accounts, clients, protocol, balanceUsd, quota }) {
  const now = Date.now();
  const items = [];
  const push = item => items.push({ severity: 'warning', ...item });
  for (const account of accounts) {
    if (account.health === 'credential_error') push({ id: `credential:${account.id}`, severity: 'critical', kind: 'credential', page: 'upstreams', target: account.id, title: account.name, message: '上游凭据失效，已停止调度' });
    if (account.cooldown_reason === 'insufficient_quota' && account.cooldown_until > now) push({ id: `quota:${account.id}:${account.cooldown_until}`, severity: 'critical', kind: 'quota', page: 'upstreams', target: account.id, title: account.name, message: '余额不足，账号临时停调' });
    if (account.circuit_level > 0 && account.cooldown_until > now && account.cooldown_reason !== 'insufficient_quota') push({ id: `circuit:${account.id}:${account.cooldown_until}`, kind: 'circuit', page: 'test', target: account.id, title: account.name, message: '连续上游失败，熔断冷却中' });
    const remaining = account.billing?.monthly_remaining;
    if (typeof remaining === 'number' && remaining < balanceUsd) push({ id: `balance:${account.id}:${Math.floor(remaining)}`, kind: 'balance', page: 'upstreams', target: account.id, title: account.name, message: `月度剩余低于 ${balanceUsd} 美元` });
    if (account.proxy_label && account.proxy_probe && account.proxy_probe.success === false) push({ id: `proxy:${account.id}:${account.proxy_probe.checked_at || 0}`, kind: 'proxy', page: 'upstreams', target: account.id, title: account.name, message: account.proxy_probe.message || '代理出口检测失败' });
  }
  if (protocol?.drifted) push({ id: `drift:${protocol.latest || 'unknown'}`, severity: 'critical', kind: 'protocol', page: 'overview', target: '', title: '协议版本', message: `上游 CLI ${protocol.latest} 与已实现的 ${protocol.implemented} 不一致` });
  for (const client of clients) {
    if (client.enabled && client.expires_at && client.expires_at > now && client.expires_at - now < WEEK) push({ id: `expiry:${client.id}:${client.expires_at}`, kind: 'expiry', page: 'clients', target: client.id, title: client.name, message: '出口 key 将在 7 天内过期' });
    const used = quota.usage(client.id);
    for (const [key, label, amount] of [['daily_token_limit', '当日', used.day], ['monthly_token_limit', '当月', used.month]]) {
      const limit = client[key];
      if (Number.isInteger(limit) && limit > 0 && amount / limit >= 0.8) push({ id: `usage:${client.id}:${key}:${limit}`, kind: 'key_quota', page: 'clients', target: client.id, title: client.name, message: `${label} token 已用 ${Math.min(100, Math.round(amount / limit * 100))}%` });
    }
  }
  return items;
}
