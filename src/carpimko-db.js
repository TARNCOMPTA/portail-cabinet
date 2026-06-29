// Base SQLite CARPIMKO : un client = un identifiant CARPIMKO (login + mot de passe
// chiffre). Fichier SEPARE (carpimko.db) du module Impots, pour une isolation nette.
// Reutilise le chiffrement du portail (data/secret.key) via ./crypto.js.

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { encrypt, decrypt } from './crypto.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = resolve(__dirname, '..', 'data');
mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(resolve(DATA_DIR, 'carpimko.db'));
db.exec('PRAGMA journal_mode = WAL;');

db.exec(`
  CREATE TABLE IF NOT EXISTS clients (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    nom          TEXT NOT NULL,
    login        TEXT NOT NULL,
    password_enc TEXT NOT NULL,
    notes        TEXT,
    dossier      TEXT,
    created_at   TEXT DEFAULT (datetime('now')),
    updated_at   TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS documents (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id   INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    libelle     TEXT,
    fichier     TEXT,
    date_doc    TEXT,
    recupere_le TEXT DEFAULT (datetime('now')),
    UNIQUE(client_id, fichier)
  );
  CREATE TABLE IF NOT EXISTS runs (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id  INTEGER REFERENCES clients(id) ON DELETE CASCADE,
    statut     TEXT NOT NULL,
    message    TEXT,
    nb_docs    INTEGER DEFAULT 0,
    lance_le   TEXT DEFAULT (datetime('now'))
  );
`);

// ---- Clients --------------------------------------------------------------
export function listClients() {
  const rows = db.prepare(`
    SELECT c.id, c.nom, c.login, c.notes, c.dossier, c.created_at, c.updated_at,
           (SELECT COUNT(*) FROM documents d WHERE d.client_id = c.id) AS nb_docs,
           (SELECT lance_le FROM runs r WHERE r.client_id = c.id ORDER BY r.lance_le DESC, r.id DESC LIMIT 1) AS dernier_run,
           (SELECT statut   FROM runs r WHERE r.client_id = c.id ORDER BY r.lance_le DESC, r.id DESC LIMIT 1) AS dernier_statut,
           (SELECT message  FROM runs r WHERE r.client_id = c.id ORDER BY r.lance_le DESC, r.id DESC LIMIT 1) AS dernier_message
    FROM clients c ORDER BY c.nom COLLATE NOCASE
  `).all();
  // Verrou anti-blocage : dernier run echoue pour mot de passe ET client non modifie depuis.
  for (const r of rows) {
    r.verrouille = r.dernier_statut === 'echec_mdp' && (!r.dernier_run || r.updated_at <= r.dernier_run);
  }
  return rows;
}

export function clientVerrouille(id) {
  const c = listClients().find((x) => x.id === Number(id));
  return c ? { verrouille: !!c.verrouille, message: c.dernier_message } : { verrouille: false };
}

export function getClient(id) { return db.prepare('SELECT * FROM clients WHERE id = ?').get(id); }
// Vue "publique" d'un client : sans le mot de passe chiffre (pour les reponses API).
function clientPublic(id) { const c = getClient(id); if (!c) return null; const { password_enc, ...reste } = c; return reste; }

export function getClientCredentials(id) {
  const c = getClient(id);
  if (!c) return null;
  return { id: c.id, nom: c.nom, login: c.login, password: decrypt(c.password_enc), dossier: c.dossier || null };
}

export function createClient({ nom, login, password, notes, dossier }) {
  const info = db.prepare('INSERT INTO clients (nom, login, password_enc, notes, dossier) VALUES (?, ?, ?, ?, ?)')
    .run(nom, login, encrypt(password), notes ?? null, dossier ?? null);
  return clientPublic(info.lastInsertRowid);
}

export function updateClient(id, { nom, login, password, notes, dossier }) {
  const c = getClient(id);
  if (!c) return null;
  const password_enc = password ? encrypt(password) : c.password_enc;
  db.prepare(`UPDATE clients SET nom = ?, login = ?, password_enc = ?, notes = ?, dossier = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(nom ?? c.nom, login ?? c.login, password_enc, notes ?? c.notes, dossier !== undefined ? dossier : c.dossier, id);
  return clientPublic(id);
}

export function deleteClient(id) { db.prepare('DELETE FROM clients WHERE id = ?').run(id); }
export function getClientByLogin(login) { return db.prepare('SELECT * FROM clients WHERE login = ?').get(String(login).trim()); }

// Import en masse : cree, ou met a jour le client de meme numero de dossier (login).
export function importClients(rows) {
  const bilan = { crees: 0, maj: 0, ignores: 0, erreurs: [] };
  rows.forEach((r, i) => {
    const ligne = i + 1;
    const nom = (r.nom ?? '').toString().trim();
    const login = (r.login ?? '').toString().trim();
    const password = (r.password ?? '').toString();
    const notes = (r.notes ?? '').toString().trim() || null;
    if (!nom && !login) { bilan.ignores++; return; }
    if (!nom || !login) { bilan.erreurs.push({ ligne, raison: 'nom et numero de dossier obligatoires', valeur: nom || login }); return; }
    const existant = getClientByLogin(login);
    try {
      if (existant) {
        updateClient(existant.id, { nom, login, password: password || undefined, notes });
        bilan.maj++;
      } else {
        if (!password) { bilan.erreurs.push({ ligne, raison: 'mot de passe manquant pour un nouveau client', valeur: nom }); return; }
        createClient({ nom, login, password, notes });
        bilan.crees++;
      }
    } catch (e) { bilan.erreurs.push({ ligne, raison: e.message, valeur: nom }); }
  });
  return bilan;
}

// ---- Documents ------------------------------------------------------------
export function addDocument(client_id, { libelle, fichier, date_doc }) {
  db.prepare('INSERT OR IGNORE INTO documents (client_id, libelle, fichier, date_doc) VALUES (?, ?, ?, ?)')
    .run(client_id, libelle ?? null, fichier, date_doc ?? null);
}
export function listDocuments(client_id) {
  return db.prepare(`SELECT * FROM documents WHERE client_id = ? ORDER BY (date_doc IS NULL), date_doc DESC, recupere_le DESC, id DESC`).all(client_id);
}
export function listAllDocuments() {
  return db.prepare(`
    SELECT d.id, d.libelle, d.fichier, d.date_doc, d.recupere_le, d.client_id, c.nom AS client_nom
    FROM documents d LEFT JOIN clients c ON c.id = d.client_id
    ORDER BY (d.date_doc IS NULL), d.date_doc DESC, d.recupere_le DESC, d.id DESC
  `).all();
}

// ---- Runs -----------------------------------------------------------------
export function addRun(client_id, { statut, message, nb_docs }) {
  db.prepare('INSERT INTO runs (client_id, statut, message, nb_docs) VALUES (?, ?, ?, ?)')
    .run(client_id, statut, message ?? null, nb_docs ?? 0);
}
export function listRuns(limit = 200) {
  return db.prepare(`SELECT r.*, c.nom AS client_nom FROM runs r LEFT JOIN clients c ON c.id = r.client_id ORDER BY r.lance_le DESC, r.id DESC LIMIT ?`).all(limit);
}

export default db;
