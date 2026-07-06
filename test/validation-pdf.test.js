import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { Buffer } from 'node:buffer';
import {
  extraireTextePdf,
  normaliser,
  contientNumero,
  correspondanceNom,
  attendusPour,
  verifierCorrespondance,
  verifierEtClasser,
} from '../src/validation-pdf.js';

const TMP = resolve('_test_validation_pdf');
const QUAR = resolve(TMP, '_quarantaine');
const nettoyer = () => rmSync(TMP, { recursive: true, force: true });
nettoyer();
mkdirSync(TMP, { recursive: true });
after(nettoyer);

// ---- Générateur de PDF minimal (une page, texte non compressé, police Helvetica).
// Après échappement, la chaîne est 100 % ASCII : longueur = octets (offsets xref exacts).
function echapperPdf(t) {
  return [...t]
    .map((c) => {
      if (c === '\\' || c === '(' || c === ')') return `\\${c}`;
      const code = c.charCodeAt(0);
      return code > 126 ? `\\${code.toString(8).padStart(3, '0')}` : c;
    })
    .join('');
}
function pdfAvecTexte(texte) {
  const contenu = texte ? `BT /F1 12 Tf 72 720 Td (${echapperPdf(texte)}) Tj ET` : '';
  const objets = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    `<< /Length ${contenu.length} >>\nstream\n${contenu}\nendstream`,
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [];
  objets.forEach((o, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xrefPos = pdf.length;
  pdf += `xref\n0 ${objets.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) pdf += `${String(o).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objets.length + 1} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}
let seq = 0;
function fixture(texte, nom = `f${++seq}.pdf`) {
  const chemin = resolve(TMP, nom);
  writeFileSync(chemin, pdfAvecTexte(texte));
  return chemin;
}

// ---- extraireTextePdf ----

test('extraireTextePdf restitue le texte du PDF', async () => {
  const t = await extraireTextePdf(fixture('Avis de CFE — SIREN 123 456 789 — Cabinet Médical'));
  assert.match(t, /123 456 789/);
  assert.match(t, /Médical/);
});

test('extraireTextePdf renvoie du vide pour un PDF sans texte (scan)', async () => {
  const t = await extraireTextePdf(fixture(''));
  assert.equal((t || '').trim(), '');
});

test('extraireTextePdf renvoie null pour un fichier non-PDF', async () => {
  const chemin = resolve(TMP, 'pas-un-pdf.pdf');
  writeFileSync(chemin, 'ceci est du HTML <html></html>');
  assert.equal(await extraireTextePdf(chemin), null);
});

// ---- normaliser / contientNumero ----

test('normaliser : accents, casse, espaces insécables', () => {
  assert.equal(normaliser('HÉRAULT  Ça'), 'herault ca');
});

test('contientNumero tolère les séparateurs entre groupes', () => {
  assert.ok(contientNumero('SIREN : 123 456 789', '123456789'));
  assert.ok(contientNumero('SIREN 123 456 789', '123456789'));
  assert.ok(contientNumero('n° 123.456.789', '123456789'));
  assert.ok(contientNumero('SIRET 123 456 789 00012', '123456789')); // SIREN en tête de SIRET
});

test('contientNumero refuse un raccord au milieu d’un nombre', () => {
  assert.ok(!contientNumero('9123456789', '123456789'));
  assert.ok(!contientNumero('912 345 678 9', '123456789'));
  assert.ok(!contientNumero('rien ici', '123456789'));
});

// ---- correspondanceNom ----

test('correspondanceNom : accents, casse, ordre, civilités', () => {
  assert.ok(correspondanceNom('Madame Marie DUPONT', 'DUPONT Marie'));
  assert.ok(correspondanceNom('M. HERAULT Jean', 'Monsieur Jean HÉRAULT'));
  assert.ok(correspondanceNom('SELARL PHARMACIE DES LILAS', 'Pharmacie des Lilas'));
  assert.ok(correspondanceNom('DUPONT', 'DUPONT Marie')); // prénom absent : token le plus long présent
});

test('correspondanceNom : frontières de mot et non-correspondance', () => {
  assert.ok(!correspondanceNom('la MARTINIQUE', 'M. MARTIN'));
  assert.ok(!correspondanceNom('Docteur BERNARD Paul', 'DUPONT Marie'));
});

test('correspondanceNom : les professions ne suffisent JAMAIS à matcher (cas réel VIGUIER)', () => {
  // Les fiches sont nommées « MME X Infirmiere » : sans exclusion des professions,
  // « infirmiere » (token le plus long) faisait matcher n'importe quelle infirmière
  // avec n'importe quelle autre -> le scraper ouvrait le dossier VIGUIER pour toutes.
  assert.ok(!correspondanceNom('MME VIGUIER INFIRMIERE', 'MME MARRE Infirmiere'));
  assert.ok(correspondanceNom('MADAME MARRE Sophie, infirmière libérale', 'MME MARRE Infirmiere'));
  assert.ok(!correspondanceNom('MME PENARD Sage-femme', 'MME MASSE Sage-femme'));
  assert.ok(!correspondanceNom('MR DURAND Medecin specialiste', 'MME LAGARRIGUE Medecin specialiste'));
  assert.ok(correspondanceNom('LAGARRIGUE Anne', 'MME LAGARRIGUE Medecin specialiste'));
});

// ---- attendusPour / verifierCorrespondance ----

test('attendusPour dérive les identifiants selon la source', () => {
  assert.deepEqual(attendusPour('impots', { nom: 'X', siret: '123456789' }), { siren: '123456789', nom: 'X' });
  assert.deepEqual(attendusPour('urssaf', { nom: 'X', siret: '12345678900012' }), {
    siret: '12345678900012',
    siren: '123456789',
    nom: 'X',
  });
  assert.deepEqual(attendusPour('carpimko', { nom: 'X', login: ' 1234567 ' }), { adherent: '1234567', nom: 'X' });
});

test('verifierCorrespondance : ordre siret > siren > adhérent > nom', () => {
  assert.deepEqual(verifierCorrespondance('SIRET 123 456 789 00012', { siret: '12345678900012', siren: '123456789', nom: 'Z' }), {
    ok: true,
    motif: 'siret',
  });
  assert.deepEqual(verifierCorrespondance('adhérent 7654321', { adherent: '7654321', nom: 'Z' }), { ok: true, motif: 'adherent' });
  assert.deepEqual(verifierCorrespondance('Mme DUPONT', { siren: '123456789', nom: 'DUPONT Marie' }), { ok: true, motif: 'nom' });
  assert.equal(verifierCorrespondance('rien de tout ça', { siren: '123456789', nom: 'DUPONT Marie' }).ok, false);
});

// ---- verifierEtClasser (bout en bout) ----

const CLIENT = { id: 7, nom: 'DUPONT Marie', siret: '123456789' };

test('verifierEtClasser : correspondance -> ok, fichier en place', async () => {
  const f = fixture('Avis de CFE 2025 — SIREN 123 456 789', 'ok.pdf');
  const v = await verifierEtClasser({ fichier: f, source: 'impots', client: CLIENT, dossierQuarantaine: QUAR });
  assert.equal(v.verdict, 'ok');
  assert.ok(existsSync(f));
});

test('verifierEtClasser : non-correspondance -> quarantaine, fichier déplacé', async () => {
  const f = fixture('Avis de CFE 2025 — SIREN 987 654 321 — SARL AUTRE SOCIETE', 'mauvais.pdf');
  const v = await verifierEtClasser({ fichier: f, source: 'impots', client: CLIENT, dossierQuarantaine: QUAR });
  assert.equal(v.verdict, 'quarantaine');
  assert.ok(!existsSync(f), 'le fichier doit avoir quitté le dossier client');
  assert.ok(existsSync(v.fichier), 'le fichier doit être en quarantaine');
  assert.match(v.fichier.replace(/\\/g, '/'), /_quarantaine\/impots\/7_DUPONT_Marie\/mauvais\.pdf$/);
  assert.match(v.raison, /123456789/);
  assert.match(v.raison, /mauvais\.pdf/);
});

test('verifierEtClasser : collision en quarantaine -> suffixe (2)', async () => {
  const f = fixture('Avis de taxe foncière — SIREN 987 654 321 — SARL AUTRE SOCIETE', 'mauvais.pdf'); // même nom que le test précédent
  const v = await verifierEtClasser({ fichier: f, source: 'impots', client: CLIENT, dossierQuarantaine: QUAR });
  assert.equal(v.verdict, 'quarantaine');
  assert.match(v.fichier, /mauvais \(2\)\.pdf$/);
  const fichiers = readdirSync(resolve(QUAR, 'impots', '7_DUPONT_Marie'));
  assert.deepEqual(fichiers.sort(), ['mauvais (2).pdf', 'mauvais.pdf']);
});

test('verifierEtClasser : PDF sans texte -> non_verifiable, fichier conservé', async () => {
  const f = fixture('', 'scan.pdf');
  const v = await verifierEtClasser({ fichier: f, source: 'carpimko', client: { id: 1, nom: 'X Y', login: '123456' }, dossierQuarantaine: QUAR });
  assert.equal(v.verdict, 'non_verifiable');
  assert.ok(existsSync(f));
  assert.match(v.raison, /scan/);
});
