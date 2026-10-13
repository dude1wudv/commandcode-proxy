import { fail } from './auth.mjs';
import { dayStart, monthStart } from './usage-log.mjs';

const MINUTE = 60 * 1000;

export class ClientQuota {
  constructor(usageLog, now = Date.now) {
    this.usageLog = usageLog;
    this.now = now;
    this.rpm = new Map();
    this.inflight = new Map();
  }
  limit(client, key) {
    const value = client?.[key];
    return Number.isInteger(value) && value > 0 ? value : null;
  }
  usage(clientId) { return this.usageLog.usage(clientId, this.now()); }
  check(client) {
    const now = this.now();
    const rpm = this.limit(client, 'rpm_limit');
    if (rpm) {
      const stamps = (this.rpm.get(client.id) || []).filter(ts => now - ts < MINUTE);
      this.rpm.set(client.id, stamps);
      if (stamps.length >= rpm) fail(429, 'client_quota_exceeded', '出口 key 已达到每分钟请求上限', Math.max(1, Math.ceil((stamps[0] + MINUTE - now) / 1000)));
    }
    const concurrency = this.limit(client, 'max_concurrency');
    if (concurrency && (this.inflight.get(client.id) || 0) >= concurrency) fail(429, 'client_quota_exceeded', '出口 key 已达到并发上限', 1);
    const used = this.usage(client.id);
    const daily = this.limit(client, 'daily_token_limit');
    if (daily && used.day >= daily) fail(429, 'client_quota_exceeded', '出口 key 已达到当日 token 上限', Math.max(1, Math.ceil((dayStart(now) + 24 * 60 * 60 * 1000 - now) / 1000)));
    const monthly = this.limit(client, 'monthly_token_limit');
    if (monthly && used.month >= monthly) {
      const next = new Date(monthStart(now));
      next.setUTCMonth(next.getUTCMonth() + 1);
      fail(429, 'client_quota_exceeded', '出口 key 已达到当月 token 上限', Math.max(1, Math.ceil((next.getTime() - now) / 1000)));
    }
  }
  begin(client) {
    this.check(client);
    const now = this.now();
    if (this.limit(client, 'rpm_limit')) {
      const stamps = (this.rpm.get(client.id) || []).filter(ts => now - ts < MINUTE);
      stamps.push(now);
      this.rpm.set(client.id, stamps);
    }
    this.inflight.set(client.id, (this.inflight.get(client.id) || 0) + 1);
  }
  finish(clientId) { this.inflight.set(clientId, Math.max(0, (this.inflight.get(clientId) || 0) - 1)); }
}
