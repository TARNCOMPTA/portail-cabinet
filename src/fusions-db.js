// Fusions manuelles de clients (transverses aux sources) : permet de declarer que
// plusieurs fiches clients (eventuellement de sources differentes et de noms differents,
// ex. « EURL TARN COMPTA » et « SARL TARN COMPTA ») sont en realite le MEME client.
// Base SQLite dediee (data/fusions.db). Un membre = (source, client_id) appartient au
// plus a une fusion.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = resolve(__dirname, '..', 'data');
mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(resolve(DATA_DIR, 'fusions.db'));
db.exec('PRAGMA journal_mode = WAL;');
db.exec(`
  CREATE TABLE IF NOT EXISTS fusions (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    nom        TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS fusion_membres (
    fusion_id INTEGER NOT NULL REFERENCES fusions(id) ON DELETE CASCADE,
    source    TEXT NOT NULL,
    client_id INTEGER NOT NULL,
    UNIQUE(source, client_id)
  );
`);

export function listFusions() {
  const f = db.prepare('SELECT id, nom FROM fusions ORDER BY nom COLLATE NOCASE').all();
  const m = db.prepare('SELECT fusion_id, source, client_id FROM fusion_membres').all();
  return f.map((x) => ({ id: x.id, nom: x.nom, membres: m.filter((y) => y.fusion_id === x.id).map((y) => ({ source: y.source, client_id: y.client_id })) }));
}

// Cree une fusion a partir de membres [{source, id}]. Retire d'abord ces membres de
// toute fusion existante (un membre ne peut etre que dans une fusion), puis nettoie les
// fusions devenues vides ou a un seul membre.
export function createFusion(nom, membres) {
  const valides = (membres || [])
    .map((m) => ({ source: String(m?.source || ''), client_id: Number(m?.id ?? m?.client_id) }))
    .filter((m) => m.source && Number.isInteger(m.client_id));
  if (valides.length < 2) throw new Error('Sélectionne au moins 2 clients à fusionner.');
  const delM = db.prepare('DELETE FROM fusion_membres WHERE source = ? AND client_id = ?');
  for (const m of valides) delM.run(m.source, m.client_id);
  const info = db.prepare('INSERT INTO fusions (nom) VALUES (?)').run(String(nom || 'Client fusionné').trim() || 'Client fusionné');
  const ins = db.prepare('INSERT INTO fusion_membres (fusion_id, source, client_id) VALUES (?, ?, ?)');
  for (const m of valides) ins.run(info.lastInsertRowid, m.source, m.client_id);
  nettoyer();
  return { id: info.lastInsertRowid };
}

export function deleteFusion(id) {
  db.prepare('DELETE FROM fusion_membres WHERE fusion_id = ?').run(Number(id));
  db.prepare('DELETE FROM fusions WHERE id = ?').run(Number(id));
}

// Supprime les fusions vides ou ne contenant qu'un seul membre (plus une vraie fusion).
function nettoyer() {
  db.exec(`DELETE FROM fusions WHERE id IN (
    SELECT f.id FROM fusions f LEFT JOIN fusion_membres m ON m.fusion_id = f.id
    GROUP BY f.id HAVING COUNT(m.client_id) < 2)`);
  db.exec('DELETE FROM fusion_membres WHERE fusion_id NOT IN (SELECT id FROM fusions)');
}

export default db;
