// Planification des recuperations automatiques (configurable depuis l'interface).
// PLUSIEURS horaires possibles par organisme (ex : URSSAF lundi 2h ET jeudi 2h).
// jour : 1=lundi … 7=dimanche ; heure : 0-23 (fuseau Europe/Paris).
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = resolve(__dirname, '..', 'data');
mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(resolve(DATA_DIR, 'planif.db'));
db.exec('PRAGMA journal_mode = WAL;');
db.exec(`CREATE TABLE IF NOT EXISTS planifs (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,
  actif  INTEGER DEFAULT 0,
  jour   INTEGER DEFAULT 2,
  heure  INTEGER DEFAULT 2
);`);

export const SOURCES = ['urssaf', 'carpimko', 'carmf', 'carcdsf', 'carpv'];

// Premiere execution : migre l'ancienne table (1 ligne par organisme) si presente,
// sinon valeurs par defaut (CARPIMKO mardi 2h, CARMF mercredi 2h actives).
{
  const vide = !db.prepare('SELECT 1 FROM planifs LIMIT 1').get();
  if (vide) {
    const ancienne = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'planifications'").get();
    const ins = db.prepare('INSERT INTO planifs (source, actif, jour, heure) VALUES (?, ?, ?, ?)');
    if (ancienne) {
      for (const p of db.prepare('SELECT source, actif, jour, heure FROM planifications').all()) ins.run(p.source, p.actif, p.jour, p.heure);
      db.exec('DROP TABLE planifications');
    } else {
      ins.run('carpimko', 1, 2, 2);
      ins.run('carmf', 1, 3, 2);
      ins.run('urssaf', 0, 4, 2);
      ins.run('carcdsf', 0, 5, 2);
      ins.run('carpv', 0, 6, 2);
    }
  }
}

export function listPlanifs() {
  return db
    .prepare('SELECT id, source, actif, jour, heure FROM planifs ORDER BY source, jour, heure')
    .all()
    .map((p) => ({ ...p, actif: !!p.actif }));
}

// Remplace TOUTE la planification par les lignes fournies (transaction) — l'interface
// envoie l'etat complet du tableau, ce qui gere ajouts, modifications et suppressions.
export function setToutesPlanifs(lignes) {
  const valides = (Array.isArray(lignes) ? lignes : [])
    .filter((l) => SOURCES.includes(l?.source))
    .map((l) => ({
      source: l.source,
      actif: l.actif ? 1 : 0,
      jour: Math.min(7, Math.max(1, Number(l.jour) || 2)),
      heure: Math.min(23, Math.max(0, Number.isFinite(Number(l.heure)) ? Number(l.heure) : 2)),
    }));
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM planifs').run();
    const ins = db.prepare('INSERT INTO planifs (source, actif, jour, heure) VALUES (?, ?, ?, ?)');
    for (const l of valides) ins.run(l.source, l.actif, l.jour, l.heure);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return listPlanifs();
}

export default db;
