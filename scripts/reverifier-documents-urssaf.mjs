// Re-vérification d'appartenance de TOUS les documents URSSAF déjà enregistrés.
// Utile après une contamination (documents d'un client classés chez un autre) :
// l'anti-doublon du scraper ne re-vérifie jamais un document déjà en base.
//
// Pour chaque document : extraction du texte du PDF, recherche du SIRET/SIREN
// ou du nom du client (mêmes règles que la quarantaine du scraper). Si le PDF
// ne correspond pas à son client, il est déplacé en quarantaine
// (downloads/_quarantaine/urssaf/<client>/) et sa ligne est supprimée de la
// base — le prochain run le retéléchargera depuis le BON dossier client.
//
// Usage :
//   node scripts/reverifier-documents-urssaf.mjs --dry-run   (constat, ne touche à rien)
//   node scripts/reverifier-documents-urssaf.mjs             (applique)

import { existsSync } from 'node:fs';
import db from '../src/urssaf-db.js';
import { extraireTextePdf, normaliser, attendusPour, verifierCorrespondance, verifierEtClasser } from '../src/validation-pdf.js';

const dryRun = process.argv.includes('--dry-run');
console.log(dryRun ? '== MODE CONSTAT (--dry-run) : aucune modification ==' : '== MODE APPLICATION : quarantaine + nettoyage de la base ==');

const docs = db
  .prepare(
    `SELECT d.id, d.client_id, d.libelle, d.fichier, c.nom, c.siret
     FROM documents d JOIN clients c ON c.id = d.client_id
     ORDER BY d.client_id, d.id`,
  )
  .all();
console.log(`${docs.length} document(s) à vérifier.\n`);

const bilan = { ok: 0, quarantaine: 0, nonVerifiable: 0, fichierManquant: 0 };
for (const doc of docs) {
  const etiquette = `doc#${doc.id} [${doc.nom}] ${doc.libelle || ''}`.slice(0, 110);
  if (!doc.fichier || !existsSync(doc.fichier)) {
    bilan.fichierManquant++;
    console.log(`  FICHIER ABSENT : ${etiquette}`);
    continue;
  }
  const client = { id: doc.client_id, nom: doc.nom, siret: doc.siret };
  const texte = await extraireTextePdf(doc.fichier);
  if (texte == null || normaliser(texte).replace(/\s/g, '').length < 20) {
    bilan.nonVerifiable++;
    console.log(`  NON VÉRIFIABLE (scan ?) : ${etiquette}`);
    continue;
  }
  if (verifierCorrespondance(texte, attendusPour('urssaf', client)).ok) {
    bilan.ok++;
    continue;
  }
  bilan.quarantaine++;
  if (dryRun) {
    console.log(`  À METTRE EN QUARANTAINE : ${etiquette}\n      ${doc.fichier}`);
    continue;
  }
  const verif = await verifierEtClasser({ fichier: doc.fichier, source: 'urssaf', client });
  if (verif.verdict === 'quarantaine') {
    db.prepare('DELETE FROM documents WHERE id = ?').run(doc.id);
    console.log(`  QUARANTAINE : ${etiquette}\n      -> ${verif.fichier}`);
  } else {
    // Ne devrait pas arriver (déjà jugé non conforme ci-dessus) : on ne touche pas.
    bilan.quarantaine--;
    bilan.nonVerifiable++;
    console.log(`  VERDICT INATTENDU (${verif.verdict}) — conservé : ${etiquette}`);
  }
}

console.log(
  `\nBilan : ${bilan.ok} conforme(s), ${bilan.quarantaine} ${dryRun ? 'à mettre' : 'mis'} en quarantaine, ` +
    `${bilan.nonVerifiable} non vérifiable(s), ${bilan.fichierManquant} fichier(s) absent(s).`,
);
if (dryRun && bilan.quarantaine > 0) console.log('Relance sans --dry-run pour appliquer.');
