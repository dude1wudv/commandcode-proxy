const DAY = 24 * 60 * 60 * 1000;

export function dayStart(ts) {
  const date = new Date(ts);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}
export function monthStart(ts) {
  const date = new Date(ts);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
}

export class UsageLog {
  constructor(repo, { retentionDays = 30, now = Date.now } = {}) {
    this.repo = repo;
    this.retentionDays = retentionDays;
    this.now = now;
    this.cache = new Map();
  }
  record(entry) {
    const row = {
      ts: entry.ts ?? this.now(),
      request_id: String(entry.request_id || '').slice(0, 64),
      client_id: String(entry.client_id || ''),
      upstream_id: entry.upstream_id || null,
      group_id: entry.group_id || null,
      model: String(entry.model || '').slice(0, 200),
      endpoint: String(entry.endpoint || '').slice(0, 80),
      stream: entry.stream ? 1 : 0,
      status: Number.isInteger(entry.status) ? entry.status : 0,
      error_code: entry.error_code ? String(entry.error_code).slice(0, 80) : null,
      duration_ms: Math.max(0, Number(entry.duration_ms) || 0),
      ttfb_ms: Number.isFinite(entry.ttfb_ms) ? Math.max(0, entry.ttfb_ms) : null,
      input_tokens: Math.max(0, Number(entry.input_tokens) || 0),
      output_tokens: Math.max(0, Number(entry.output_tokens) || 0),
      output_tokens_estimated: entry.output_tokens_estimated ? 1 : 0,
      cached_tokens: Math.max(0, Number(entry.cached_tokens) || 0),
      retries: Math.max(0, Number(entry.retries) || 0),
    };
    this.repo.db.prepare(`INSERT INTO request_logs(ts,request_id,client_id,upstream_id,group_id,model,endpoint,stream,status,error_code,duration_ms,ttfb_ms,input_tokens,output_tokens,output_tokens_estimated,cached_tokens,retries)
      VALUES(@ts,@request_id,@client_id,@upstream_id,@group_id,@model,@endpoint,@stream,@status,@error_code,@duration_ms,@ttfb_ms,@input_tokens,@output_tokens,@output_tokens_estimated,@cached_tokens,@retries)`).run(row);
    this.addCache(row.client_id, row.ts, row.input_tokens + row.output_tokens);
    return row;
  }
  addCache(clientId, ts, tokens) {
    if (!clientId || !tokens) return;
    const cached = this.cache.get(clientId);
    if (!cached) return;
    if (ts >= cached.day) cached.dayTokens += tokens;
    if (ts >= cached.month) cached.monthTokens += tokens;
  }
  tokensSince(clientId, since) {
    const row = this.repo.db.prepare('SELECT COALESCE(SUM(input_tokens + output_tokens), 0) AS tokens FROM request_logs WHERE client_id=? AND ts>=?').get(clientId, since);
    return Number(row?.tokens) || 0;
  }
  usage(clientId, now = this.now()) {
    const day = dayStart(now);
    const month = monthStart(now);
    const cached = this.cache.get(clientId);
    if (cached && cached.day === day && cached.month === month) return { day: cached.dayTokens, month: cached.monthTokens };
    const next = { day, month, dayTokens: this.tokensSince(clientId, day), monthTokens: this.tokensSince(clientId, month) };
    this.cache.set(clientId, next);
    return { day: next.dayTokens, month: next.monthTokens };
  }
  purge(now = this.now()) {
    if (!this.retentionDays) return 0;
    const cutoff = now - this.retentionDays * DAY;
    return this.repo.db.prepare('DELETE FROM request_logs WHERE ts < ?').run(cutoff).changes;
  }
  summary({ from = 0, to = Number.MAX_SAFE_INTEGER, groupBy = 'hour' } = {}) {
    const buckets = { hour: '%Y-%m-%dT%H:00:00Z', model: null, client: null, upstream: null };
    if (!Object.hasOwn(buckets, groupBy)) return [];
    const where = 'WHERE ts>=? AND ts<?';
    const totals = this.repo.db.prepare(`SELECT COUNT(*) AS requests, COALESCE(SUM(input_tokens),0) AS input_tokens, COALESCE(SUM(output_tokens),0) AS output_tokens, COALESCE(SUM(cached_tokens),0) AS cached_tokens, COALESCE(SUM(CASE WHEN status>=200 AND status<400 THEN 1 ELSE 0 END),0) AS successes FROM request_logs ${where}`).get(from, to);
    let rows;
    if (groupBy === 'hour') {
      rows = this.repo.db.prepare(`SELECT strftime('${buckets.hour}', ts/1000, 'unixepoch') AS key, COUNT(*) AS requests, COALESCE(SUM(input_tokens+output_tokens),0) AS tokens, COALESCE(SUM(cached_tokens),0) AS cached_tokens FROM request_logs ${where} GROUP BY key ORDER BY key`).all(from, to);
    } else {
      const column = groupBy === 'model' ? 'model' : groupBy === 'client' ? 'client_id' : 'upstream_id';
      rows = this.repo.db.prepare(`SELECT ${column} AS key, COUNT(*) AS requests, COALESCE(SUM(input_tokens+output_tokens),0) AS tokens, COALESCE(SUM(cached_tokens),0) AS cached_tokens, COALESCE(SUM(input_tokens),0) AS input_tokens FROM request_logs ${where} GROUP BY key ORDER BY tokens DESC LIMIT 20`).all(from, to);
    }
    const input = Number(totals.input_tokens) || 0;
    return { from, to, group_by: groupBy, requests: Number(totals.requests) || 0, successes: Number(totals.successes) || 0, input_tokens: input, output_tokens: Number(totals.output_tokens) || 0, cached_tokens: Number(totals.cached_tokens) || 0, cache_rate: input ? Number(totals.cached_tokens) / input : 0, rows };
  }
  list({ before = Number.MAX_SAFE_INTEGER, client = '', upstream = '', model = '', status = '', limit = 50 } = {}) {
    const filters = ['id < ?'];
    const params = [before];
    if (client) { filters.push('client_id=?'); params.push(client); }
    if (upstream) { filters.push('upstream_id=?'); params.push(upstream); }
    if (model) { filters.push('model=?'); params.push(model); }
    if (status === 'error') filters.push('status>=400');
    else if (status === 'ok') filters.push('status>=200 AND status<400');
    params.push(Math.min(100, Math.max(1, limit)));
    return this.repo.db.prepare(`SELECT * FROM request_logs WHERE ${filters.join(' AND ')} ORDER BY id DESC LIMIT ?`).all(...params);
  }
}
