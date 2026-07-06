// Base de donnees SQLite (module natif node:sqlite, Node >= 22).
// Stocke : clients (par SIRET), reglages (compte cabinet, dossier de destination),
// documents recuperes, et historique des executions.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { encrypt, decrypt } from './crypto.js';
import { creerListeNoire } from './liste-noire.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = resolve(__dirname, '..', 'data');
mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(resolve(DATA_DIR, 'impots.db'));
db.exec('PRAGMA journal_mode = WAL;');

// Liste noire des clients supprimes (la synchro ne les recree pas).
export const listeNoire = creerListeNoire(db);

db.exec(`
  CREATE TABLE IF NOT EXISTS clients (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    nom        TEXT NOT NULL,
    siret      TEXT NOT NULL,
    dossier    TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS documents (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id   INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    libelle     TEXT,
    fichier     TEXT,
    eventid     TEXT,
    recupere_le TEXT DEFAULT (datetime('now')),
    UNIQUE(client_id, eventid)
  );
  CREATE TABLE IF NOT EXISTS runs (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id INTEGER REFERENCES clients(id) ON DELETE CASCADE,
    statut    TEXT NOT NULL,
    message   TEXT,
    nb_docs   INTEGER DEFAULT 0,
    lance_le  TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS settings (
    cle    TEXT PRIMARY KEY,
    valeur TEXT
  );
`);

// Migration : mode de paiement detecte dans les avis CFE
// ('echeance' | 'mensualise' | 'aucun' | 'inconnu' | NULL = pas encore analyse).
try {
  db.exec('ALTER TABLE documents ADD COLUMN paiement TEXT');
} catch {
  /* colonne deja presente */
}

// ---- Reglages -------------------------------------------------------------
export function getSetting(cle, def = null) {
  const r = db.prepare('SELECT valeur FROM settings WHERE cle = ?').get(cle);
  return r ? r.valeur : def;
}
export function setSetting(cle, valeur) {
  db.prepare(
    `INSERT INTO settings (cle, valeur) VALUES (?, ?)
              ON CONFLICT(cle) DO UPDATE SET valeur = excluded.valeur`,
  ).run(cle, valeur ?? null);
}

// ---- Comptes espace pro impots.gouv.fr ------------------------------------
// Plusieurs comptes possibles ; chaque client est rattache a un compte. Connexion manuelle
// (captcha) : le mot de passe est facultatif (simple memo) et chiffre s'il est fourni.
db.exec(`CREATE TABLE IF NOT EXISTS cabinets (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  libelle      TEXT,
  login        TEXT NOT NULL,
  password_enc TEXT,
  created_at   TEXT DEFAULT (datetime('now'))
);`);
// Migration : rattachement des clients a un cabinet
{
  const cols = db
    .prepare('PRAGMA table_info(clients)')
    .all()
    .map((c) => c.name);
  if (!cols.includes('cabinet_id')) db.exec('ALTER TABLE clients ADD COLUMN cabinet_id INTEGER');
}
// Migration : ancien compte unique (settings) -> 1ere ligne de la table cabinets
{
  const nb = db.prepare('SELECT COUNT(*) AS n FROM cabinets').get().n;
  const oldLogin = getSetting('cabinet_login', '');
  const oldEnc = getSetting('cabinet_password_enc', '');
  if (nb === 0 && oldLogin && oldEnc) {
    const info = db.prepare('INSERT INTO cabinets (libelle, login, password_enc) VALUES (?, ?, ?)').run(oldLogin, oldLogin, oldEnc);
    db.prepare('UPDATE clients SET cabinet_id = ? WHERE cabinet_id IS NULL').run(info.lastInsertRowid);
  }
}
// Dedoublonnage par login (garde le plus petit id, rattache ses clients) + index unique :
// empeche tout cabinet en double (meme e-mail), y compris en cas d'insertion concurrente.
{
  const dups = db.prepare('SELECT MIN(id) AS keep FROM cabinets GROUP BY lower(login) HAVING COUNT(*) > 1').all();
  for (const { keep } of dups) {
    const login = db.prepare('SELECT login FROM cabinets WHERE id = ?').get(keep).login;
    db.prepare('UPDATE clients SET cabinet_id = ? WHERE cabinet_id IN (SELECT id FROM cabinets WHERE lower(login) = lower(?) AND id != ?)').run(
      keep,
      login,
      keep,
    );
    db.prepare('DELETE FROM cabinets WHERE lower(login) = lower(?) AND id != ?').run(login, keep);
  }
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_cabinets_login ON cabinets(lower(login))');
}

export function listCabinets() {
  return db
    .prepare(
      `
    SELECT c.id, c.libelle, c.login,
           (SELECT COUNT(*) FROM clients cl WHERE cl.cabinet_id = c.id) AS nb_clients,
           (c.password_enc IS NOT NULL) AS pwd_ok
    FROM cabinets c ORDER BY c.libelle COLLATE NOCASE, c.id
  `,
    )
    .all()
    .map((c) => ({ ...c, pwd_ok: !!c.pwd_ok }));
}
// Renvoie le cabinet avec mot de passe dechiffre (usage interne scraper).
export function getCabinetFull(id) {
  const c = db.prepare('SELECT * FROM cabinets WHERE id = ?').get(id);
  if (!c) return null;
  return { id: c.id, libelle: c.libelle, login: c.login, password: c.password_enc ? decrypt(c.password_enc) : '' };
}
export function getCabinetByLogin(login) {
  return db.prepare('SELECT id, libelle, login FROM cabinets WHERE lower(login) = lower(?)').get(String(login || '').trim());
}
export function createCabinet({ libelle, login, password }) {
  const info = db
    .prepare('INSERT INTO cabinets (libelle, login, password_enc) VALUES (?, ?, ?)')
    .run((libelle || login || '').trim(), String(login || '').trim(), password ? encrypt(String(password)) : null);
  return db.prepare('SELECT id, libelle, login FROM cabinets WHERE id = ?').get(info.lastInsertRowid);
}
export function updateCabinet(id, { libelle, login, password }) {
  const c = db.prepare('SELECT * FROM cabinets WHERE id = ?').get(id);
  if (!c) return null;
  const enc = password ? encrypt(String(password)) : c.password_enc;
  db.prepare('UPDATE cabinets SET libelle = ?, login = ?, password_enc = ? WHERE id = ?').run(libelle ?? c.libelle, login ?? c.login, enc, id);
  return db.prepare('SELECT id, libelle, login FROM cabinets WHERE id = ?').get(id);
}
export function deleteCabinet(id) {
  db.prepare('UPDATE clients SET cabinet_id = NULL WHERE cabinet_id = ?').run(id);
  db.prepare('DELETE FROM cabinets WHERE id = ?').run(id);
}
export function cabinetsConfigure() {
  // Connexion manuelle (captcha) : un cabinet est utilisable des qu'il existe (mot de passe facultatif).
  return db.prepare('SELECT COUNT(*) AS n FROM cabinets').get().n > 0;
}

// ---- Clients --------------------------------------------------------------
export function listClients() {
  return db
    .prepare(
      `
    SELECT c.id, c.nom, c.siret, c.dossier, c.cabinet_id, c.created_at, c.updated_at,
           (SELECT libelle FROM cabinets cab WHERE cab.id = c.cabinet_id) AS cabinet_libelle,
           (SELECT COUNT(*) FROM documents d WHERE d.client_id = c.id) AS nb_docs,
           (SELECT paiement FROM documents d WHERE d.client_id = c.id AND d.paiement IS NOT NULL AND d.paiement != 'inconnu'
              ORDER BY d.recupere_le DESC, d.id DESC LIMIT 1) AS paiement_cfe,
           (SELECT lance_le FROM runs r WHERE r.client_id = c.id ORDER BY r.lance_le DESC, r.id DESC LIMIT 1) AS dernier_run,
           (SELECT statut   FROM runs r WHERE r.client_id = c.id ORDER BY r.lance_le DESC, r.id DESC LIMIT 1) AS dernier_statut,
           (SELECT message  FROM runs r WHERE r.client_id = c.id ORDER BY r.lance_le DESC, r.id DESC LIMIT 1) AS dernier_message
    FROM clients c
    ORDER BY c.nom COLLATE NOCASE
  `,
    )
    .all();
}
export function getClient(id) {
  return db.prepare('SELECT * FROM clients WHERE id = ?').get(id);
}
export function getClientBySiret(siret) {
  return db.prepare('SELECT * FROM clients WHERE siret = ?').get(String(siret).replace(/\s+/g, ''));
}
export function listClientsByCabinet(cabinetId) {
  return db.prepare('SELECT * FROM clients WHERE cabinet_id = ? ORDER BY nom COLLATE NOCASE').all(cabinetId);
}
export function createClient({ nom, siret, dossier, cabinet_id }) {
  const info = db
    .prepare('INSERT INTO clients (nom, siret, dossier, cabinet_id) VALUES (?, ?, ?, ?)')
    .run(nom, String(siret).replace(/\s+/g, ''), dossier ?? null, cabinet_id ?? null);
  return getClient(info.lastInsertRowid);
}
export function updateClient(id, { nom, siret, dossier, cabinet_id }) {
  const c = getClient(id);
  if (!c) return null;
  db.prepare(`UPDATE clients SET nom = ?, siret = ?, dossier = ?, cabinet_id = ?, updated_at = datetime('now') WHERE id = ?`).run(
    nom ?? c.nom,
    siret !== undefined ? String(siret).replace(/\s+/g, '') : c.siret,
    dossier !== undefined ? dossier : c.dossier,
    cabinet_id !== undefined ? cabinet_id : c.cabinet_id,
    id,
  );
  return getClient(id);
}
export function deleteClient(id) {
  db.prepare('DELETE FROM clients WHERE id = ?').run(id);
}

// Import en masse : lignes { nom, siret }, rattachees au cabinet cabinetId.
export function importClients(rows, cabinetId = null) {
  const bilan = { crees: 0, maj: 0, ignores: 0, erreurs: [] };
  rows.forEach((r, i) => {
    const ligne = i + 1;
    const nom = (r.nom ?? '').toString().trim();
    const siret = (r.siret ?? '').toString().replace(/\s+/g, '');
    if (!nom && !siret) {
      bilan.ignores++;
      return;
    }
    if (!nom || !siret) {
      bilan.erreurs.push({ ligne, raison: 'nom et SIRET requis', valeur: nom || siret });
      return;
    }
    try {
      const ex = getClientBySiret(siret);
      if (ex) {
        updateClient(ex.id, { nom, siret, cabinet_id: cabinetId ?? ex.cabinet_id });
        bilan.maj++;
      } else {
        createClient({ nom, siret, cabinet_id: cabinetId });
        bilan.crees++;
      }
    } catch (e) {
      bilan.erreurs.push({ ligne, raison: e.message, valeur: nom });
    }
  });
  return bilan;
}

// ---- Documents & runs -----------------------------------------------------
export function addDocument(client_id, { libelle, fichier, eventid, paiement }) {
  db.prepare('INSERT OR IGNORE INTO documents (client_id, libelle, fichier, eventid, paiement) VALUES (?, ?, ?, ?, ?)').run(
    client_id,
    libelle ?? null,
    fichier,
    eventid ?? null,
    paiement ?? null,
  );
}
// ---- Mode de paiement des avis CFE (detecte dans le texte du PDF) ----------
export function setPaiementDocument(id, paiement) {
  db.prepare('UPDATE documents SET paiement = ? WHERE id = ?').run(paiement ?? null, Number(id));
}
// Avis CFE pas encore analyses (retro-analyse au demarrage du serveur).
export function listCfeSansPaiement(limit = 10000) {
  return db
    .prepare("SELECT id, fichier FROM documents WHERE eventid LIKE 'CFE\\_%' ESCAPE '\\' AND paiement IS NULL AND fichier IS NOT NULL LIMIT ?")
    .all(limit);
}
export function getDocumentByEventid(client_id, eventid) {
  return db.prepare('SELECT * FROM documents WHERE client_id = ? AND eventid = ?').get(client_id, eventid);
}
// Securite : ne sert un fichier par chemin QUE s'il correspond a un document enregistre
// (evite la lecture de fichier arbitraire sur /api/documents/file?path=...).
export function documentAvecChemin(fichier) {
  return db.prepare('SELECT id FROM documents WHERE fichier = ?').get(String(fichier || ''));
}
export function listDocuments(client_id) {
  return db.prepare('SELECT * FROM documents WHERE client_id = ? ORDER BY recupere_le DESC, id DESC').all(client_id);
}
// Tous les documents (tous clients), du plus recent au plus ancien, avec le nom du client.
export function listAllDocuments() {
  return db
    .prepare(
      `
    SELECT d.id, d.client_id, d.libelle, d.fichier, d.eventid, d.recupere_le, c.nom AS client_nom
    FROM documents d LEFT JOIN clients c ON c.id = d.client_id
    ORDER BY d.recupere_le DESC, d.id DESC
  `,
    )
    .all();
}
// Un document par id (avec le nom du client), pour servir un fichier directement.
export function getDocument(id) {
  return db.prepare('SELECT d.*, c.nom AS client_nom FROM documents d LEFT JOIN clients c ON c.id = d.client_id WHERE d.id = ?').get(Number(id));
}
export function addRun(client_id, { statut, message, nb_docs }) {
  db.prepare('INSERT INTO runs (client_id, statut, message, nb_docs) VALUES (?, ?, ?, ?)').run(client_id, statut, message ?? null, nb_docs ?? 0);
}
export function listRuns(limit = 50) {
  return db
    .prepare(
      `
    SELECT r.*, c.nom AS client_nom FROM runs r LEFT JOIN clients c ON c.id = r.client_id
    ORDER BY r.lance_le DESC, r.id DESC LIMIT ?
  `,
    )
    .all(limit);
}

// ---- Utilisateurs (collaborateurs du cabinet) & sessions ------------------
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    email         TEXT NOT NULL UNIQUE,
    nom           TEXT,
    password_hash TEXT NOT NULL,
    role          TEXT NOT NULL DEFAULT 'membre',
    actif         INTEGER NOT NULL DEFAULT 1,
    created_at    TEXT DEFAULT (datetime('now')),
    last_login    TEXT
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token      TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expire_le  TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );
`);

export function countUsers() {
  return db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
}
export function listUsers() {
  return db
    .prepare('SELECT id, email, nom, role, actif, created_at, last_login FROM users ORDER BY email COLLATE NOCASE')
    .all()
    .map((u) => ({ ...u, actif: !!u.actif }));
}
export function getUserByEmail(email) {
  return db.prepare('SELECT * FROM users WHERE email = ?').get(
    String(email || '')
      .trim()
      .toLowerCase(),
  );
}
export function getUserById(id) {
  return db.prepare('SELECT id, email, nom, role, actif FROM users WHERE id = ?').get(id);
}
export function createUser({ email, nom, password_hash, role }) {
  const info = db
    .prepare('INSERT INTO users (email, nom, password_hash, role) VALUES (?, ?, ?, ?)')
    .run(String(email).trim().toLowerCase(), nom ?? null, password_hash, role || 'membre');
  return getUserById(info.lastInsertRowid);
}
export function updateUserPassword(id, password_hash) {
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(password_hash, id);
}
export function setUserActif(id, actif) {
  db.prepare('UPDATE users SET actif = ? WHERE id = ?').run(actif ? 1 : 0, id);
}
export function setUserRole(id, role) {
  db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, id);
}
export function deleteUser(id) {
  db.prepare('DELETE FROM users WHERE id = ?').run(id);
}
export function touchUserLogin(id) {
  db.prepare("UPDATE users SET last_login = datetime('now') WHERE id = ?").run(id);
}

export function createSession(token, userId, expireISO) {
  db.prepare('INSERT INTO sessions (token, user_id, expire_le) VALUES (?, ?, ?)').run(token, userId, expireISO);
}
export function getSessionUser(token) {
  const r = db
    .prepare(
      `SELECT u.id, u.email, u.nom, u.role, u.actif, s.expire_le
    FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?`,
    )
    .get(token);
  if (!r) return null;
  if (Date.parse(r.expire_le) < Date.now()) {
    deleteSession(token);
    return null;
  }
  if (!r.actif) return null;
  return { id: r.id, email: r.email, nom: r.nom, role: r.role };
}
export function deleteSession(token) {
  db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}
export function deleteUserSessions(userId) {
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
}
export function purgerSessionsExpirees() {
  db.prepare("DELETE FROM sessions WHERE expire_le < datetime('now')").run();
}
