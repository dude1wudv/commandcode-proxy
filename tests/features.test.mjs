import assert from 'node:assert/strict';
import test from 'node:test';
import { Repository } from '../lib/repository.mjs';
import { UsageLog } from '../lib/usage-log.mjs';
import { ClientQuota } from '../lib/client-quota.mjs';
import { buildAlerts } from '../lib/alerts.mjs';
import { fields } from '../lib/http.mjs';

const key = Buffer.alloc(32, 9);

test('request log migration keeps older rows and summarizes tokens', () => {
  const repo = new Repository(':memory:', key);
  repo.setAdmin('admin@example.test', 'hash');
  assert.equal(repo.db.prepare('SELECT version FROM migrations WHERE version=3').get().version, 3);
  const log = new UsageLog(repo, { retentionDays: 30, now: () => 1_700_000_000_000 });
  log.record({ ts: 1_700_000_000_000, request_id: 'req-12345678', client_id: 'client-a', upstream_id: 'up-a', group_id: 'default', model: 'glm', endpoint: '/v1/chat/completions', stream: true, status: 200, duration_ms: 40, ttfb_ms: 12, input_tokens: 100, output_tokens: 20, cached_tokens: 80, retries: 1 });
  log.record({ ts: 1_000, request_id: 'req-oldoldold', client_id: 'client-a', model: 'old', endpoint: '/v1/messages', status: 500, duration_ms: 1, input_tokens: 5, output_tokens: 0, cached_tokens: 0, retries: 0 });
  assert.equal(log.purge(1_700_000_000_000), 1);
  const summary = log.summary({ from: 0, to: 2_000_000_000_000, groupBy: 'model' });
  assert.equal(summary.requests, 1);
  assert.equal(summary.cached_tokens, 80);
  assert.equal(summary.cache_rate, 0.8);
  assert.equal(summary.rows[0].key, 'glm');
  assert.equal(log.list({ model: 'glm' })[0].retries, 1);
  repo.close();
});

test('outlet key quota blocks before the next request and allows a small overage', () => {
  const repo = new Repository(':memory:', key);
  const log = new UsageLog(repo, { now: () => Date.now() });
  const quota = new ClientQuota(log);
  const client = { id: 'client-a', rpm_limit: 1, max_concurrency: null, daily_token_limit: 10, monthly_token_limit: null };
  quota.begin(client);
  assert.throws(() => quota.check(client), error => error.status === 429 && error.code === 'client_quota_exceeded');
  quota.finish(client.id);
  log.record({ client_id: client.id, model: 'm', endpoint: '/v1/chat/completions', status: 200, input_tokens: 8, output_tokens: 4, duration_ms: 1, request_id: 'req-quota01' });
  assert.throws(() => quota.check({ ...client, rpm_limit: null }), error => error.message.includes('当日'));
  const loose = fields({ name: 'key', rpm_limit: null, daily_token_limit: 100 }, 'clients');
  assert.equal(loose.rpm_limit, null);
  assert.equal(loose.daily_token_limit, 100);
  assert.throws(() => fields({ name: 'key', rpm_limit: 0 }, 'clients'));
  repo.close();
});

test('alerts summarize credential, balance, proxy and key usage without storing them', () => {
  const repo = new Repository(':memory:', key);
  const log = new UsageLog(repo);
  log.record({ client_id: 'key-1', model: 'm', endpoint: '/v1/responses', status: 200, input_tokens: 90, output_tokens: 0, duration_ms: 1, request_id: 'req-alert01' });
  const items = buildAlerts({
    accounts: [{ id: 'up-1', name: '主账号', health: 'credential_error', cooldown_until: 0, proxy_label: 'socks5://proxy.example:1080', proxy_probe: { success: false, message: '超时', checked_at: 1 }, billing: { monthly_remaining: 1 } }],
    clients: [{ id: 'key-1', name: '出口', enabled: true, expires_at: Date.now() + 86_400_000, daily_token_limit: 100 }],
    protocol: { drifted: true, latest: '9.9.9', implemented: '1.81.0' },
    balanceUsd: 5,
    quota: { usage: id => new UsageLog(repo).usage(id) },
  });
  assert.ok(items.some(item => item.kind === 'credential'));
  assert.ok(items.some(item => item.kind === 'balance'));
  assert.ok(items.some(item => item.kind === 'proxy'));
  assert.ok(items.some(item => item.kind === 'protocol'));
  assert.ok(items.some(item => item.kind === 'key_quota'));
  assert.equal(JSON.stringify(items).includes('user_'), false);
  repo.close();
});
