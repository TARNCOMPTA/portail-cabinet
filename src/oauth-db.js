// Stockage OAuth 2.1 pour le connecteur MCP distant (Claude « custom connector »).
// Base SQLite separee data/oauth.db : clients (statique + DCR), codes d'autorisation
// (usage unique, courte duree) et jetons (acces + rafraichissement).
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = resolve(__dirname, '..', 'data');
mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(resolve(DATA_DIR, 'oauth.db'));
db.exec('PRAGMA journal_mode = WAL;');
db.exec(`
  CREATE TABLE IF NOT EXISTS clients (
    client_id     TEXT PRIMARY KEY,
    client_secret TEXT,
    redirect_uris TEXT,            -- JSON array
    name          TEXT,
    statique      INTEGER DEFAULT 0,
    created_at    TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS codes (
    code           TEXT PRIMARY KEY,
    client_id      TEXT NOT NULL,
    redirect_uri   TEXT,
    code_challenge TEXT,
    scope          TEXT,
    user_id        INTEGER,
    resource       TEXT,
    expires_at     INTEGER         -- epoch ms
  );
  CREATE TABLE IF NOT EXISTS tokens (
    access_token  TEXT PRIMARY KEY,
    refresh_token TEXT,
    client_id     TEXT,
    user_id       INTEGER,
    scope         TEXT,
    expires_at    INTEGER          -- epoch ms (jeton d'acces)
  );
  CREATE TABLE IF NOT EXISTS download_tokens (
    token      TEXT PRIMARY KEY,
    path       TEXT,
    filename   TEXT,
    expires_at INTEGER             -- epoch ms (usage unique)
  );
`);

const rnd = (n = 32) => crypto.randomBytes(n).toString('base64url');

// ---- Clients --------------------------------------------------------------
// Le client_secret est stocké HACHÉ (« sha256:<hex> ») : le clair n'est visible
// qu'à la création/régénération. Les anciens secrets en clair sont migrés au
// démarrage (hachés sur place) et restent valides.
const hashSecret = (s) => 'sha256:' + crypto.createHash('sha256').update(s).digest('hex');
for (const row of db.prepare("SELECT client_id, client_secret FROM clients WHERE client_secret IS NOT NULL AND client_secret NOT LIKE 'sha256:%'").all()) {
  db.prepare('UPDATE clients SET client_secret = ? WHERE client_id = ?').run(hashSecret(row.client_secret), row.client_id);
}

export function getClient(clientId) {
  const r = db.prepare('SELECT * FROM clients WHERE client_id = ?').get(clientId);
  if (r) r.redirect_uris = JSON.parse(r.redirect_uris || '[]');
  return r || null;
}
// Vrai si le secret fourni correspond au hachage stocké (client confidentiel).
export function verifierSecret(client, secret) {
  if (!client?.client_secret) return false;
  const attendu = Buffer.from(client.client_secret);
  const fourni = Buffer.from(hashSecret(String(secret ?? '')));
  return attendu.length === fourni.length && crypto.timingSafeEqual(attendu, fourni);
}
export function createClient({ client_id, client_secret, redirect_uris = [], name = '', statique = 0 }) {
  db.prepare(
    `INSERT INTO clients (client_id, client_secret, redirect_uris, name, statique)
              VALUES (?, ?, ?, ?, ?)
              ON CONFLICT(client_id) DO UPDATE SET
                client_secret = excluded.client_secret,
                redirect_uris = excluded.redirect_uris,
                name = excluded.name`,
  ).run(client_id, client_secret ? hashSecret(client_secret) : null, JSON.stringify(redirect_uris), name, statique ? 1 : 0);
  return getClient(client_id);
}
// Client « statique » (les 2 cles affichees dans le portail). Cree au besoin.
// À la CRÉATION, le clair est renvoyé une seule fois dans client_secret_clair.
export function getOrCreateStaticClient(redirectUris) {
  let row = db.prepare('SELECT * FROM clients WHERE statique = 1 ORDER BY created_at LIMIT 1').get();
  if (!row) {
    const secret = rnd(32);
    const cree = createClient({
      client_id: 'mcp-' + rnd(12),
      client_secret: secret,
      redirect_uris: redirectUris,
      name: 'Connecteur MCP (organisation)',
      statique: 1,
    });
    return { ...cree, client_secret_clair: secret };
  }
  row.redirect_uris = JSON.parse(row.redirect_uris || '[]');
  return row;
}
export function regenStaticClient(redirectUris) {
  db.prepare('DELETE FROM clients WHERE statique = 1').run();
  return getOrCreateStaticClient(redirectUris);
}

// ---- Codes d'autorisation (usage unique) ----------------------------------
export function saveCode(o) {
  db.prepare(
    `INSERT INTO codes (code, client_id, redirect_uri, code_challenge, scope, user_id, resource, expires_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(o.code, o.client_id, o.redirect_uri, o.code_challenge, o.scope, o.user_id, o.resource, o.expires_at);
}
export function takeCode(code) {
  // recupere puis supprime (usage unique)
  const r = db.prepare('SELECT * FROM codes WHERE code = ?').get(code);
  if (r) db.prepare('DELETE FROM codes WHERE code = ?').run(code);
  return r || null;
}

// ---- Jetons ---------------------------------------------------------------
export function saveToken(o) {
  db.prepare(
    `INSERT INTO tokens (access_token, refresh_token, client_id, user_id, scope, expires_at)
              VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(o.access_token, o.refresh_token, o.client_id, o.user_id, o.scope, o.expires_at);
}
export function getByAccess(token) {
  return db.prepare('SELECT * FROM tokens WHERE access_token = ?').get(token) || null;
}
export function getByRefresh(token) {
  return db.prepare('SELECT * FROM tokens WHERE refresh_token = ?').get(token) || null;
}
export function deleteByRefresh(token) {
  db.prepare('DELETE FROM tokens WHERE refresh_token = ?').run(token);
}

// ---- Jetons de telechargement (lien direct, usage unique) -----------------
export function saveDl(o) {
  db.prepare('INSERT INTO download_tokens (token, path, filename, expires_at) VALUES (?, ?, ?, ?)').run(o.token, o.path, o.filename, o.expires_at);
}
export function takeDl(token) {
  // recupere puis supprime (usage unique)
  const r = db.prepare('SELECT * FROM download_tokens WHERE token = ?').get(token);
  if (r) db.prepare('DELETE FROM download_tokens WHERE token = ?').run(token);
  return r || null;
}

export function purge() {
  const now = Date.now();
  db.prepare('DELETE FROM codes WHERE expires_at < ?').run(now);
  db.prepare('DELETE FROM download_tokens WHERE expires_at < ?').run(now);
  // jetons d'acces expires depuis > 60 j (on garde le refresh associe tant qu'il sert)
  db.prepare('DELETE FROM tokens WHERE expires_at < ?').run(now - 60 * 24 * 3600 * 1000);
}

export { rnd };
