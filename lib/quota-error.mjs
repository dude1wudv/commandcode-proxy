// Translate a known billing failure without exposing arbitrary upstream text.
export const QUOTA_COOLDOWN_MS = 20 * 60 * 1000;
export const QUOTA_MESSAGE = 'CommandCode 上游账号余额不足，已临时停止调度 20 分钟；请充值或检查账号套餐。';
export const QUOTA_CODE = 'insufficient_quota';

export function isInsufficientQuota(error) {
  if (typeof error === 'string') {
    try { error = JSON.parse(error); } catch { error = { message: error }; }
  }
  error = error?.error || error;
  if (!error || typeof error !== 'object') return false;
  const code = String(error.code || error.type || '').toLowerCase();
  if (['insufficient_quota', 'insufficient_credits', 'insufficient_balance', 'credit_balance_exhausted'].includes(code)) return true;
  return /\binsufficient (?:credits?|balance)\b|\bcredit balance (?:is )?(?:too low|exhausted)\b/i.test(String(error.message || ''));
}

export function quotaError(context, error, status) {
  if (status !== 402 && !isInsufficientQuota(error)) return null;
  if (context) {
    context.errorCode = QUOTA_CODE;
    context.status = 429;
    context.retryAfter = QUOTA_COOLDOWN_MS / 1000;
  }
  return {
    status: 429, code: QUOTA_CODE,
    body: { error: { message: QUOTA_MESSAGE, type: QUOTA_CODE, code: QUOTA_CODE }, retry_after: QUOTA_COOLDOWN_MS / 1000 },
  };
}
