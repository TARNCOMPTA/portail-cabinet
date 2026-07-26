// Tests du cycle de vie de la QUARANTAINE (src/quarantaine.js) : un PDF rejeté par la
// vérification d'appartenance doit être listable, réintégrable (fichier remis à sa place
// + métadonnées pour recréer la ligne en base) et supprimable.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { Buffer } from 'node:buffer';
import { verifierEtClasser } from '../src/validation-pdf.js';
import { listerQuarantaine, cheminSur, reintegrer, supprimerQuarantaine, supprimerLot, nettoyerDossiersVides, QUARANTAINE_DIR } from '../src/quarantaine.js';

// PDF minimal contenant un texte donné (assez d'octets pour passer les garde-fous).
function pdf(texte) {
  const flux = `BT /F1 12 Tf 72 720 Td (${texte.replace(/[()\\]/g, '')}) Tj ET`;
  const objets = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${flux.length} >>\nstream\n${flux}\nendstream`,
  ];
  let s = '%PDF-1.4\n';
  const off = [];
  objets.forEach((o, i) => {
    off.push(s.length);
    s += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const x = s.length;
  s += `xref\n0 ${objets.length + 1}\n0000000000 65535 f \n`;
  for (const o of off) s += `${String(o).padStart(10, '0')} 00000 n \n`;
  s += `trailer\n<< /Size ${objets.length + 1} /Root 1 0 R >>\nstartxref\n${x}\n%%EOF\n`;
  return Buffer.from(s, 'latin1');
}

let tmp, dossierClient;
const CLIENT = { id: 4242, nom: 'ZZTEST QUARANTAINE', siret: '123456789' };
// Isole la quarantaine des tests du dossier reel.
const QDIR = resolve(QUARANTAINE_DIR, '_test_auto');

before(() => {
  tmp = mkdtempSync(resolve(tmpdir(), 'quarantaine-'));
  dossierClient = resolve(tmp, 'client');
  mkdirSync(dossierClient, { recursive: true });
});
after(() => {
  rmSync(tmp, { recursive: true, force: true });
  rmSync(QDIR, { recursive: true, force: true });
});

// Met un document en quarantaine et renvoie son entrée listée.
async function mettreEnQuarantaine(nomFichier, meta) {
  const origine = resolve(dossierClient, nomFichier);
  writeFileSync(origine, pdf('Document appartenant a UNE AUTRE SOCIETE SANS RAPPORT'));
  const v = await verifierEtClasser({ fichier: origine, source: 'carmf', client: CLIENT, dossierQuarantaine: QDIR, meta });
  assert.equal(v.verdict, 'quarantaine', 'le document doit partir en quarantaine');
  assert.ok(!existsSync(origine), 'le fichier quitte le dossier client');
  return { origine, quarantaine: v.fichier };
}

test('un document rejeté est listé avec son motif et ses métadonnées', async () => {
  const { origine } = await mettreEnQuarantaine('appel-2026.pdf', { libelle: 'Appel de cotisations 2026', dateDoc: '2026' });
  const entree = listerQuarantaine().find((q) => q.fichier === 'appel-2026.pdf');
  assert.ok(entree, 'le document apparaît dans la liste');
  assert.equal(entree.source, 'carmf');
  assert.equal(entree.clientId, 4242);
  assert.equal(entree.clientNom, 'ZZTEST QUARANTAINE');
  assert.equal(entree.libelle, 'Appel de cotisations 2026');
  assert.equal(entree.origine, origine);
  assert.equal(entree.reintegrable, true, 'réintégrable car origine + client connus');
  assert.match(entree.raison, /introuvable/i);
});

test('réintégrer remet le fichier à sa place et rend les métadonnées d’enregistrement', async () => {
  const { origine } = await mettreEnQuarantaine('reintegre.pdf', { libelle: 'Relevé 2025', dateDoc: '2025' });
  const entree = listerQuarantaine().find((q) => q.fichier === 'reintegre.pdf');
  const r = reintegrer(entree.id);
  assert.equal(r.ok, true, r.error);
  assert.equal(r.destination, origine, 'remis exactement à son emplacement d’origine');
  assert.ok(existsSync(origine), 'le fichier est de retour dans le dossier client');
  assert.equal(r.meta.libelle, 'Relevé 2025');
  assert.equal(r.meta.dateDoc, '2025');
  assert.equal(r.meta.clientId, 4242);
  // Plus rien en quarantaine, manifeste compris.
  assert.ok(!listerQuarantaine().some((q) => q.fichier === 'reintegre.pdf'));
  assert.ok(!existsSync(`${cheminSur(entree.id)}.json`), 'le manifeste est retiré');
});

test('annuler() remet le document en quarantaine (échec d’enregistrement en base)', async () => {
  const { origine } = await mettreEnQuarantaine('rollback.pdf', { libelle: 'X', dateDoc: '2026' });
  const entree = listerQuarantaine().find((q) => q.fichier === 'rollback.pdf');
  const r = reintegrer(entree.id);
  assert.equal(r.ok, true);
  assert.ok(existsSync(origine));
  r.annuler();
  assert.ok(!existsSync(origine), 'le fichier a été retiré du dossier client');
  assert.ok(existsSync(cheminSur(entree.id)), 'et remis en quarantaine');
});

test('réintégrer n’écrase jamais un document déjà présent', async () => {
  const { origine } = await mettreEnQuarantaine('collision.pdf', { libelle: 'Y', dateDoc: '2026' });
  writeFileSync(origine, pdf('DOCUMENT DEJA PRESENT A CET EMPLACEMENT'));
  const entree = listerQuarantaine().find((q) => q.fichier === 'collision.pdf');
  const r = reintegrer(entree.id);
  assert.equal(r.ok, true);
  assert.notEqual(r.destination, origine, 'un suffixe est ajouté');
  assert.match(r.destination, /collision \(2\)\.pdf$/);
  assert.match(readFileSync(origine, 'latin1'), /DEJA PRESENT/, "l'existant est intact");
});

test('supprimer retire le document et son manifeste', async () => {
  await mettreEnQuarantaine('a-jeter.pdf', { libelle: 'Z', dateDoc: '2026' });
  const entree = listerQuarantaine().find((q) => q.fichier === 'a-jeter.pdf');
  const p = cheminSur(entree.id);
  assert.equal(supprimerQuarantaine(entree.id).ok, true);
  assert.ok(!existsSync(p));
  assert.ok(!existsSync(`${p}.json`));
  assert.equal(supprimerQuarantaine(entree.id).ok, false, 'seconde suppression refusée proprement');
});

test('supprimerLot vide un lot et retire les dossiers devenus vides', async () => {
  await mettreEnQuarantaine('lot-1.pdf', { libelle: 'A', dateDoc: '2026' });
  await mettreEnQuarantaine('lot-2.pdf', { libelle: 'B', dateDoc: '2026' });
  // On vide TOUT le dossier de test (c'est ce que fait « Vider la quarantaine ») : sinon
  // un reliquat laissé par un test précédent empêcherait légitimement le rmdir.
  const aJeter = listerQuarantaine().filter((q) => cheminSur(q.id).startsWith(resolve(QDIR)));
  assert.ok(aJeter.length >= 2);
  const dossier = dirname(cheminSur(aJeter[0].id));
  const r = supprimerLot([...aJeter.map((q) => q.id), 'carmf/9999_INCONNU/absent.pdf']);
  assert.equal(r.supprimes, aJeter.length);
  assert.equal(r.echecs.length, 1, 'un identifiant inconnu est signalé sans interrompre le lot');
  assert.ok(!existsSync(dossier), 'le dossier client vidé a été retiré');
  assert.ok(!listerQuarantaine().some((q) => cheminSur(q.id).startsWith(resolve(QDIR))), 'plus rien en quarantaine de test');
  assert.ok(existsSync(QUARANTAINE_DIR), 'la racine de quarantaine est conservée');
});

test('supprimerLot sans identifiant ne fait rien et ne casse pas', () => {
  assert.deepEqual(supprimerLot([]), { supprimes: 0, echecs: [] });
  assert.deepEqual(supprimerLot(undefined), { supprimes: 0, echecs: [] });
  assert.ok(existsSync(QUARANTAINE_DIR));
});

test('nettoyerDossiersVides ne supprime jamais la racine de quarantaine', () => {
  nettoyerDossiersVides();
  assert.ok(existsSync(QUARANTAINE_DIR), 'la racine survit même quand tout est vide');
});

test('cheminSur verrouille l’accès au dossier de quarantaine (anti-traversée)', () => {
  assert.equal(cheminSur('../../server.js'), null);
  assert.equal(cheminSur('../.env'), null);
  assert.ok(cheminSur('carmf/4242_X/doc.pdf'), 'un chemin interne reste autorisé');
});
