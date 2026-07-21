// Nettoie les documents en double des caisses (CARPIMKO, CARPV, CARCDSF).
//
// Cause : la CARPIMKO regenere un nom de fichier a chaque visite (le meme appel de
// cotisations etait re-telecharge a chaque tournee), et la plateforme liberal_web
// (CARPV/CARCDSF) re-emet certains courriers dates du jour (« INT - Echeancier de
// prelevements »). Corrige dans les scrapers en 1.7.5 — ce script supprime les
// doublons deja accumules : memes client, libelle et date de document.
//
// On garde UN exemplaire par groupe : le plus ANCIEN pour la CARPIMKO (copies
// identiques du meme avis), le plus RECENT pour CARPV/CARCDSF (courrier regenere,
// la derniere version est la plus a jour). Les fichiers des doublons sont effaces.
//
// Usage :
//   node scripts/nettoyer-doublons-caisses.mjs --dry-run   (montre sans rien toucher)
//   node scripts/nettoyer-doublons-caisses.mjs             (supprime)
import { DatabaseSync } from 'node:sqlite';
import { existsSync, unlinkSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = resolve(__dirname, '..', 'data');
const dryRun = process.argv.includes('--dry-run');

// garder: 'ancien' = premier telecharge, 'recent' = dernier telecharge.
const SOURCES = [
  { db: 'carpimko.db', nom: 'CARPIMKO', garder: 'ancien' },
  { db: 'carpv.db', nom: 'CARPV', garder: 'recent' },
  { db: 'carcdsf.db', nom: 'CARCDSF', garder: 'recent' },
];

let totalSupprimes = 0;
for (const src of SOURCES) {
  const chemin = resolve(DATA_DIR, src.db);
  if (!existsSync(chemin)) {
    console.log(`[${src.nom}] pas de base (${src.db}) — ignore.`);
    continue;
  }
  const db = new DatabaseSync(chemin);
  const docs = db.prepare('SELECT id, client_id, libelle, date_doc, fichier FROM documents ORDER BY id').all();
  const groupes = new Map();
  for (const d of docs) {
    const cle = `${d.client_id}|${d.date_doc || ''}|${d.libelle || ''}`;
    if (!groupes.has(cle)) groupes.set(cle, []);
    groupes.get(cle).push(d);
  }
  let supprimes = 0;
  for (const [, grp] of groupes) {
    if (grp.length < 2) continue;
    // ORDER BY id : [0] = plus ancien, [n-1] = plus recent.
    const garde = src.garder === 'ancien' ? grp[0] : grp[grp.length - 1];
    for (const d of grp) {
      if (d.id === garde.id) continue;
      console.log(`[${src.nom}] doublon${dryRun ? ' (dry-run)' : ''} : #${d.id} « ${d.libelle} » (${d.date_doc || 'sans date'}) — garde #${garde.id}`);
      if (!dryRun) {
        db.prepare('DELETE FROM documents WHERE id = ?').run(d.id);
        if (d.fichier && d.fichier !== garde.fichier && existsSync(d.fichier)) {
          try {
            unlinkSync(d.fichier);
          } catch (e) {
            console.warn(`  (fichier non efface : ${e.message})`);
          }
        }
      }
      supprimes++;
    }
  }
  console.log(`[${src.nom}] ${supprimes} doublon(s)${dryRun ? ' detecte(s) (rien touche)' : ' supprime(s)'} sur ${docs.length} document(s).`);
  totalSupprimes += supprimes;
  db.close();
}
console.log(`\nTotal : ${totalSupprimes} doublon(s)${dryRun ? ' — relance sans --dry-run pour supprimer' : ' supprime(s)'}.`);
