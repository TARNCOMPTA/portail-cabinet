// Planification des recuperations automatiques, par organisme (configurable depuis
// l'interface). jour : 1=lundi … 7=dimanche ; heure : 0-23 (fuseau Europe/Paris).
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = resolve(__dirname, '..', 'data');
mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(resolve(DATA_DIR, 'planif.db'));
db.exec('PRAGMA journal_mode = WAL;');
db.exec(`CREATE TABLE IF NOT EXISTS planifications (
  source TEXT PRIMARY KEY,
  actif  INTEGER DEFAULT 0,
  jour   INTEGER DEFAULT 2,
  heure  INTEGER DEFAULT 2
);`);

export const SOURCES = ['urssaf', 'carpimko', 'carmf'];

// Valeurs par defaut au premier lancement (reprend l'existant : CARPIMKO mardi 2h,
// CARMF mercredi 2h ; URSSAF jeudi 2h mais desactive).
{
  const ins = db.prepare('INSERT OR IGNORE INTO planifications (source, actif, jour, heure) VALUES (?, ?, ?, ?)');
  ins.run('carpimko', 1, 2, 2);
  ins.run('carmf', 1, 3, 2);
  ins.run('urssaf', 0, 4, 2);
}

export function listPlanifs() {
  return db.prepare('SELECT source, actif, jour, heure FROM planifications').all().map((p) => ({ ...p, actif: !!p.actif }));
}
export function setPlanif(source, { actif, jour, heure }) {
  if (!SOURCES.includes(source)) throw new Error('Source inconnue.');
  const j = Math.min(7, Math.max(1, Number(jour) || 2));
  const h = Math.min(23, Math.max(0, Number.isFinite(Number(heure)) ? Number(heure) : 2));
  db.prepare(`INSERT INTO planifications (source, actif, jour, heure) VALUES (?, ?, ?, ?)
    ON CONFLICT(source) DO UPDATE SET actif = excluded.actif, jour = excluded.jour, heure = excluded.heure`)
    .run(source, actif ? 1 : 0, j, h);
  return listPlanifs().find((p) => p.source === source);
}

export default db;
