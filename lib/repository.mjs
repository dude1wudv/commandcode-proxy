import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { fail } from './auth.mjs';
import { encrypt, decrypt, mask, hashKey, verifyKey, token } from './security.mjs';

export const DEFAULT_GROUP_ID = 'default';
const entities = ['upstreams', 'clients', 'groups'];

export class Repository {
  constructor(path, masterKey) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.masterKey = masterKey;
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS migrations(version INTEGER PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS admin(id INTEGER PRIMARY KEY CHECK(id=1), email TEXT NOT NULL, password TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions(hash TEXT PRIMARY KEY, csrf TEXT NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS login_limits(bucket TEXT PRIMARY KEY, failures INTEGER NOT NULL, locked_until INTEGER NOT NULL, updated INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS upstreams(id TEXT PRIMARY KEY, data TEXT NOT NULL, credential TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS upstream_proxies(upstream_id TEXT PRIMARY KEY REFERENCES upstreams(id) ON DELETE CASCADE, url TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS billing_sessions(upstream_id TEXT PRIMARY KEY REFERENCES upstreams(id) ON DELETE CASCADE, credential TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS clients(id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS groups(id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS client_keys(id TEXT PRIMARY KEY, client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE, salt TEXT NOT NULL, hash TEXT NOT NULL, expires INTEGER, prefix TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY AUTOINCREMENT, time INTEGER NOT NULL, action TEXT NOT NULL, target TEXT, outcome TEXT NOT NULL, ip TEXT NOT NULL);
      INSERT OR IGNORE INTO migrations VALUES(1);`);
    if (!this.db.prepare('SELECT version FROM migrations WHERE version=2').get()) {
      this.transaction(() => {
        const group = { id: DEFAULT_GROUP_ID, name: '默认分组', notes: '', created_at: Date.now() };
        this.db.prepare('INSERT INTO groups VALUES(?,?)').run(group.id, JSON.stringify(group));
        for (const kind of ['upstreams', 'clients']) {
          for (const row of this.list(kind)) this.save(kind, { ...row, group_id: DEFAULT_GROUP_ID });
        }
        this.db.prepare('INSERT INTO migrations VALUES(2)').run();
      });
    }
    if (path !== ':memory:') chmodSync(path, 0o600);
  }
  close() { this.db.close(); }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  admin() { return this.db.prepare('SELECT * FROM admin WHERE id=1').get(); }
  setAdmin(email, password) { this.db.prepare('INSERT OR REPLACE INTO admin VALUES(1,?,?)').run(email, password); }
  audit(action, target = '', outcome = 'success', ip = '') {
    this.db.prepare('INSERT INTO audit(time,action,target,outcome,ip) VALUES(?,?,?,?,?)').run(Date.now(), action, target, outcome, ip);
  }
  audits(before = Number.MAX_SAFE_INTEGER) { return this.db.prepare('SELECT * FROM audit WHERE id < ? ORDER BY id DESC LIMIT 100').all(before); }
  list(kind) {
    if (!entities.includes(kind)) throw new Error('Invalid entity');
    return this.db.prepare(`SELECT data FROM ${kind} ORDER BY rowid`).all().map(row => JSON.parse(row.data));
  }
  get(kind, id) { return this.list(kind).find(row => row.id === id); }
  save(kind, data) {
    if (!entities.includes(kind)) throw new Error('Invalid entity');
    if (kind !== 'groups') this.requireGroup(data.group_id ?? DEFAULT_GROUP_ID);
    this.db.prepare(`UPDATE ${kind} SET data=? WHERE id=?`).run(JSON.stringify(data), data.id);
    return data;
  }
  createUpstream(fields, credential) {
    const group_id = this.requireGroup(fields.group_id ?? DEFAULT_GROUP_ID);
    const id = randomUUID();
    const data = { id, ...fields, group_id, credential_prefix: mask(credential), health: 'unknown', cooldown_until: 0, failures: [], circuit_level: 0, models: [], models_refreshed_at: null, models_error: null, last_test_at: null, latency_ms: null, last_error: null, requests: 0, successes: 0, errors: 0, created_at: Date.now() };
    this.db.prepare('INSERT INTO upstreams VALUES(?,?,?)').run(id, JSON.stringify(data), encrypt(credential, this.masterKey, id));
    return data;
  }
  credential(id) {
    const row = this.db.prepare('SELECT credential FROM upstreams WHERE id=?').get(id);
    return decrypt(row.credential, this.masterKey, id);
  }
  replaceCredential(id, value) {
    this.clearBilling(id);
    this.db.prepare('UPDATE upstreams SET credential=? WHERE id=?').run(encrypt(value, this.masterKey, id), id);
    const data = this.get('upstreams', id);
    // A replacement must be tested before clearing a credential-error quarantine.
    data.credential_prefix = mask(value);
    data.models = []; data.models_refreshed_at = null; data.provider_responses_enabled = false;
    return this.save('upstreams', data);
  }
  remove(kind, id) {
    if (!entities.includes(kind)) throw new Error('Invalid entity');
    if (kind === 'groups') {
      if (id === DEFAULT_GROUP_ID) fail(409, 'default_group', '默认分组不能删除');
      if (['upstreams', 'clients'].some(entity => this.list(entity).some(row => row.group_id === id))) fail(409, 'group_in_use', '请先移出分组内的账号和出口 key');
    }
    this.db.prepare(`DELETE FROM ${kind} WHERE id=?`).run(id);
  }
  requireGroup(id) {
    if (typeof id !== 'string' || !this.get('groups', id)) fail(400, 'invalid_group', '请选择有效的分组');
    return id;
  }
  groupFields(fields, existing) {
    if (this.list('groups').some(row => row.id !== existing?.id && row.name.toLowerCase() === fields.name.toLowerCase())) fail(409, 'duplicate_group', '分组名称已存在');
    return fields;
  }
  createGroup(fields) {
    this.groupFields(fields);
    const data = { id: randomUUID(), ...fields, created_at: Date.now() };
    this.db.prepare('INSERT INTO groups VALUES(?,?)').run(data.id, JSON.stringify(data));
    return data;
  }
  proxy(id) {
    const row = this.db.prepare('SELECT url FROM upstream_proxies WHERE upstream_id=?').get(id);
    return row ? decrypt(row.url, this.masterKey, `${id}:proxy`) : null;
  }
  setProxy(id, url) {
    if (this.proxy(id) === url) return;
    if (url === null) this.db.prepare('DELETE FROM upstream_proxies WHERE upstream_id=?').run(id);
    else this.db.prepare('INSERT INTO upstream_proxies(upstream_id,url) VALUES(?,?) ON CONFLICT(upstream_id) DO UPDATE SET url=excluded.url').run(id, encrypt(url, this.masterKey, `${id}:proxy`));
    const row = this.get('upstreams', id);
    if (row) {
      this.clearBilling(id);
      this.save('upstreams', { ...this.get('upstreams', id), health: 'unknown', cooldown_until: 0, failures: [], circuit_level: 0, last_error: null, last_test_at: null, latency_ms: null, proxy_probe: null });
    }
  }
  discardBillingSession(id) {
    this.db.prepare('DELETE FROM billing_sessions WHERE upstream_id=?').run(id);
  }
  clearBilling(id) {
    this.db.prepare('DELETE FROM billing_sessions WHERE upstream_id=?').run(id);
    const row = this.get('upstreams', id);
    if (row) this.save('upstreams', { ...row, billing_source: null, billing_authorized: false, billing: null, billing_error: null, billing_checked_at: null });
  }
  createClient(fields, legacyKey) {
    const group_id = this.requireGroup(fields.group_id ?? DEFAULT_GROUP_ID);
    return this.transaction(() => {
      const data = { id: randomUUID(), ...fields, group_id, requests: 0, successes: 0, errors: 0, last_used_at: null, created_at: Date.now() };
      this.db.prepare('INSERT INTO clients VALUES(?,?)').run(data.id, JSON.stringify(data));
      return this.issueKey(data.id, legacyKey);
    });
  }
  issueKey(id, legacyKey) {
    const keyId = randomUUID().replaceAll('-', '');
    const key = legacyKey || `sk-cc_${keyId}.${token()}`;
    const record = hashKey(key);
    this.db.prepare('INSERT INTO client_keys VALUES(?,?,?,?,NULL,?)').run(keyId, id, record.salt, record.hash, mask(key));
    const data = this.get('clients', id);
    data.key_prefix = mask(key);
    this.save('clients', data);
    return { ...data, key };
  }
  rotateClient(id, graceSeconds = 0) {
    return this.transaction(() => {
      if (!graceSeconds) this.db.prepare('DELETE FROM client_keys WHERE client_id=?').run(id);
      else this.db.prepare('UPDATE client_keys SET expires=MIN(COALESCE(expires,?),?) WHERE client_id=?').run(Date.now() + graceSeconds * 1000, Date.now() + graceSeconds * 1000, id);
      return this.issueKey(id);
    });
  }
  authenticateClient(key, now = Date.now()) {
    if (typeof key !== 'string' || key.length > 512) return null;
    const rows = this.db.prepare('SELECT * FROM client_keys WHERE expires IS NULL OR expires>?').all(now);
    for (const row of rows) {
      if (!verifyKey(key, row)) continue;
      const client = this.get('clients', row.client_id);
      if (client?.enabled && (!client.expires_at || client.expires_at > now)) return client;
    }
    return null;
  }
  countClient(id, success, started) {
    const row = this.get('clients', id);
    if (!row) return;
    row.requests++; row[success ? 'successes' : 'errors']++; row.last_used_at = started;
    this.save('clients', row);
  }
}
