import http from 'node:http';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApplication } from './lib/application.mjs';
import { readSecret } from './lib/security.mjs';
import { startProtocolMaintenance, upstreamProxyLabel } from './protocols.mjs';

process.umask(0o077);
const root = fileURLToPath(new URL('.', import.meta.url));
const key = Buffer.from(readSecret(process.env.CC_MASTER_KEY_FILE || '/run/secrets/master-key'), 'hex');
const passwordFile = process.env.CC_ADMIN_PASSWORD_FILE || '/run/secrets/admin-password';
const app = await createApplication({
  databasePath: process.env.CC_DATABASE || '/data/commandcode.sqlite', masterKey: key,
  initialPassword: readSecret(passwordFile),
  origin: process.env.CC_ORIGIN || 'https://sub.sunmmyapi.xyz',
  apiBase: process.env.CC_API_BASE || 'https://api.commandcode.ai',
  assetsPath: resolve(root, 'frontend/dist'), trustProxy: true,
  maxInflight: Number(process.env.CC_MAX_INFLIGHT || 4),
  maxBodyBytes: Number(process.env.CC_MAX_BODY_MB || 8) * 1024 * 1024,
  internalBaseUrl: process.env.CC_INTERNAL_BASE_URL || 'http://172.18.0.1:13050/v1',
  gitSha: process.env.CC_GIT_SHA || 'dev',
  metricsEnabled: process.env.CC_METRICS === '1',
  metricsToken: process.env.CC_METRICS_TOKEN || '',
  requestLogDays: Number(process.env.CC_REQUEST_LOG_DAYS || 30),
  alertBalanceUsd: Number(process.env.CC_ALERT_BALANCE_USD || 5),
  billingIntervalMs: Number(process.env.CC_BILLING_INTERVAL_MS || 2 * 60 * 60 * 1000),
});
const configuredKeepAliveTimeout = Number.parseInt(process.env.CC_KEEPALIVE_TIMEOUT_MS || '', 10);
const keepAliveTimeout = Number.isFinite(configuredKeepAliveTimeout) && configuredKeepAliveTimeout > 0
  ? configuredKeepAliveTimeout : 65000;
const serverOptions = requestTimeout => ({
  requestTimeout,
  keepAliveTimeout,
  headersTimeout: 10000,
});
const management = http.createServer(serverOptions(30000), app.management);
const inference = http.createServer(serverOptions(60000), app.inference);
management.listen(Number(process.env.PORT || 3050), process.env.HOST || '127.0.0.1');
inference.listen(Number(process.env.INFERENCE_PORT || 3051), process.env.HOST || '127.0.0.1');
const stopMaintenance = startProtocolMaintenance();
console.log(`CommandCode management and private inference listeners started; keepAliveTimeout ${keepAliveTimeout}ms (反代侧 keepalive_timeout 必须小于它); upstreamProxy ${upstreamProxyLabel()}`);
let stopping = false;
async function shutdown() {
  if (stopping) return; stopping = true; stopMaintenance();
  const deadline = setTimeout(() => { management.closeAllConnections(); inference.closeAllConnections(); }, 300000); deadline.unref();
  await Promise.all([management, inference].map(server => new Promise(resolve => server.close(resolve))));
  clearTimeout(deadline); app.close();
}
process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
