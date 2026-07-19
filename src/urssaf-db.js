// Base SQLite URSSAF (module natif node:sqlite). Modele "tiers declarant" :
// comptes cabinet (login/mdp chiffre) + clients par SIRET, documents, runs.
// Fichier SEPARE (urssaf.db). Reutilise le chiffrement du portail (data/secret.key).

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { creerListeNoire } from './liste-noire.js';
import { creerCabinets } from './cabinets-db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = resolve(__dirname, '..', 'data');
mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(resolve(DATA_DIR, 'urssaf.db'));
db.exec('PRAGMA journal_mode = WAL;');

// Liste noire des clients supprimes (la synchro ne les recree pas).
export const listeNoire = creerListeNoire(db);

db.exec(`
  CREATE TABLE IF NOT EXISTS cabinets (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    libelle      TEXT,
    login        TEXT NOT NULL,
    password_enc TEXT,
    created_at   TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS clients (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    nom        TEXT NOT NULL,
    siret      TEXT NOT NULL,
    dossier    TEXT,
    cabinet_id INTEGER,
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
`);
// Migration : verrou de nom personnalise (un renommage manuel n'est plus ecrase
// par la synchronisation du portefeuille — cas nom d'usage vs nom URSSAF).
try {
  db.exec('ALTER TABLE clients ADD COLUMN nom_verrouille INTEGER DEFAULT 0');
} catch {
  /* colonne deja presente */
}

// ---- Comptes cabinet : CRUD mutualisé (voir cabinets-db.js) ----------------
// URSSAF : connexion AUTOMATIQUE -> un compte n'est « configuré » que s'il a un mot de
// passe enregistré => exigeMotDePasse: true. Index propre à cette base.
export const { listCabinets, getCabinetFull, getCabinetByLogin, createCabinet, updateCabinet, deleteCabinet, cabinetsConfigure } = creerCabinets(db, {
  indexName: 'idx_urssaf_cabinets_login',
  exigeMotDePasse: true,
});
export function getCabinetFullByClient(clientId) {
  const cl = getClient(clientId);
  return cl?.cabinet_id ? getCabinetFull(cl.cabinet_id) : null;
}

// ---- Clients --------------------------------------------------------------
export function listClients() {
  return db
    .prepare(
      `
    SELECT c.id, c.nom, c.siret, c.dossier, c.cabinet_id, c.nom_verrouille, c.created_at, c.updated_at,
           (SELECT libelle FROM cabinets cab WHERE cab.id = c.cabinet_id) AS cabinet_libelle,
           (SELECT COUNT(*) FROM documents d WHERE d.client_id = c.id) AS nb_docs,
           (SELECT lance_le FROM runs r WHERE r.client_id = c.id ORDER BY r.lance_le DESC, r.id DESC LIMIT 1) AS dernier_run,
           (SELECT statut   FROM runs r WHERE r.client_id = c.id ORDER BY r.lance_le DESC, r.id DESC LIMIT 1) AS dernier_statut,
           (SELECT message  FROM runs r WHERE r.client_id = c.id ORDER BY r.lance_le DESC, r.id DESC LIMIT 1) AS dernier_message
    FROM clients c ORDER BY c.nom COLLATE NOCASE
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
export function createClient({ nom, siret, dossier, cabinet_id }) {
  const info = db
    .prepare('INSERT INTO clients (nom, siret, dossier, cabinet_id) VALUES (?, ?, ?, ?)')
    .run(nom, String(siret).replace(/\s+/g, ''), dossier ?? null, cabinet_id ?? null);
  return getClient(info.lastInsertRowid);
}
export function updateClient(id, { nom, siret, dossier, cabinet_id, nom_verrouille }) {
  const c = getClient(id);
  if (!c) return null;
  db.prepare(`UPDATE clients SET nom = ?, siret = ?, dossier = ?, cabinet_id = ?, nom_verrouille = ?, updated_at = datetime('now') WHERE id = ?`).run(
    nom ?? c.nom,
    siret !== undefined ? String(siret).replace(/\s+/g, '') : c.siret,
    dossier !== undefined ? dossier : c.dossier,
    cabinet_id !== undefined ? cabinet_id : c.cabinet_id,
    nom_verrouille !== undefined ? (nom_verrouille ? 1 : 0) : (c.nom_verrouille ?? 0),
    id,
  );
  return getClient(id);
}
export function deleteClient(id) {
  db.prepare('DELETE FROM clients WHERE id = ?').run(id);
}

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
        // Nom verrouille (personnalise au cabinet) : la synchro ne l'ecrase pas.
        updateClient(ex.id, { nom: ex.nom_verrouille ? undefined : nom, siret, cabinet_id: cabinetId ?? ex.cabinet_id });
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
export function addDocument(client_id, { libelle, fichier, eventid }) {
  db.prepare(
    `INSERT INTO documents (client_id, libelle, fichier, eventid) VALUES (?, ?, ?, ?)
              ON CONFLICT(client_id, eventid) DO UPDATE SET libelle = excluded.libelle, fichier = excluded.fichier`,
  ).run(client_id, libelle ?? null, fichier, eventid ?? null);
}
export function getDocumentByEventid(client_id, eventid) {
  return db.prepare('SELECT * FROM documents WHERE client_id = ? AND eventid = ?').get(client_id, eventid);
}
export function listDocuments(client_id) {
  return db.prepare('SELECT * FROM documents WHERE client_id = ? ORDER BY recupere_le DESC, id DESC').all(client_id);
}
// Plafond LARGE : l'ancien plafond de 5000 faisait disparaitre de l'onglet Documents
// (et du lien MCP / du ZIP) les clients traites en debut de lot des que la tournee
// complete depassait 5000 documents (cas reel : BARTHE, ~5100 docs au total).
export function listAllDocuments(limit = 50000) {
  return db
    .prepare(`SELECT d.*, c.nom AS client_nom FROM documents d LEFT JOIN clients c ON c.id = d.client_id ORDER BY d.recupere_le DESC, d.id DESC LIMIT ?`)
    .all(limit);
}
// Un document par id — pour servir un fichier, ne PAS passer par listAllDocuments
// (plafonnée à 5000 : les documents anciens en sortent et deviendraient introuvables).
export function getDocument(id) {
  return db.prepare('SELECT d.*, c.nom AS client_nom FROM documents d LEFT JOIN clients c ON c.id = d.client_id WHERE d.id = ?').get(Number(id));
}
export function addRun(client_id, { statut, message, nb_docs }) {
  db.prepare('INSERT INTO runs (client_id, statut, message, nb_docs) VALUES (?, ?, ?, ?)').run(client_id, statut, message ?? null, nb_docs ?? 0);
}
export function listRuns(limit = 300) {
  return db
    .prepare(`SELECT r.*, c.nom AS client_nom FROM runs r LEFT JOIN clients c ON c.id = r.client_id ORDER BY r.lance_le DESC, r.id DESC LIMIT ?`)
    .all(limit);
}

export default db;
