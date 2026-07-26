// Tests du TRI AUTOMATIQUE de la quarantaine (src/quarantaine-tri.js).
//
// L'enjeu : ce module décide de suppressions en masse. Un faux « appartient à un autre
// client » supprimerait le document légitime d'un client — d'où la double confirmation
// (identifiant ET nom) qu'on vérifie ici explicitement.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { Buffer } from 'node:buffer';
import { analyserEntree, indexerPortefeuille, numerosDuTexte } from '../src/quarantaine-tri.js';

// PDF minimal contenant un texte donné (même fabrique que test/quarantaine.test.js).
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

const ATTENDU = { id: 1, nom: 'MME PENARD Infirmiere', siret: '88442743600024' };
const VOISIN = { id: 2, nom: 'MME BADUEL Infirmiere', siret: '51479147400034' };
const PORTEFEUILLE = [ATTENDU, VOISIN, { id: 3, nom: 'SARL FURLAN THOMAS', siret: '790123456' }];

let tmp;
const index = indexerPortefeuille(PORTEFEUILLE);
const ecrire = (nom, texte) => {
  const p = resolve(tmp, nom);
  writeFileSync(p, pdf(texte));
  return p;
};

before(() => {
  tmp = mkdtempSync(resolve(tmpdir(), 'tri-quarantaine-'));
});
after(() => rmSync(tmp, { recursive: true, force: true }));

test('numerosDuTexte ramène SIREN et SIRET, séparateurs tolérés', () => {
  const n = numerosDuTexte('n SIRET 884 427 436 00024 et compte 51479147400034');
  assert.ok(n.has('884427436'));
  assert.ok(n.has('514791474'));
});

test('indexerPortefeuille indexe sur les 9 premiers chiffres', () => {
  assert.equal(index.get('884427436').id, 1);
  assert.equal(index.get('514791474').id, 2);
  assert.equal(index.size, 3);
});

test('verdict « client » quand le document mentionne bien le client attendu', async () => {
  const chemin = ecrire('ok.pdf', 'Urssaf - cotisations de MME PENARD, SIRET 88442743600024');
  const r = await analyserEntree({ chemin, source: 'urssaf', client: ATTENDU, index });
  assert.equal(r.verdict, 'client');
});

test('verdict « client » aussi quand seul le nom figure (règle actuelle)', async () => {
  const chemin = ecrire('nom.pdf', 'Madame PENARD, votre echeancier de cotisations');
  const r = await analyserEntree({ chemin, source: 'urssaf', client: ATTENDU, index });
  assert.equal(r.verdict, 'client');
});

test('verdict « autre » : identifiant ET nom d’un autre client du cabinet', async () => {
  const chemin = ecrire('melange.pdf', 'A Montreuil, MME BADUEL Laure - n SIRET 51479147400034 - document a conserver');
  const r = await analyserEntree({ chemin, source: 'urssaf', client: ATTENDU, index });
  assert.equal(r.verdict, 'autre');
  assert.equal(r.proprietaire.id, 2);
  assert.match(r.motif, /BADUEL/);
});

test('identifiant d’un autre client SANS son nom → indéterminé, jamais « autre »', async () => {
  // Un numéro isolé (référence recopiée, chiffres recollés par hasard) ne doit pas
  // suffire à décider une suppression.
  const chemin = ecrire('numero-seul.pdf', 'Reference de votre dossier 51479147400034 - courrier Urssaf');
  const r = await analyserEntree({ chemin, source: 'urssaf', client: ATTENDU, index });
  assert.equal(r.verdict, 'indetermine');
});

test('document d’un tiers hors portefeuille → indéterminé', async () => {
  const chemin = ecrire('tiers.pdf', 'MONSIEUR INCONNU DUPRE - SIRET 11122233300011');
  const r = await analyserEntree({ chemin, source: 'urssaf', client: ATTENDU, index });
  assert.equal(r.verdict, 'indetermine');
});

test('PDF sans texte extractible → illisible (jamais supprimé automatiquement)', async () => {
  const chemin = ecrire('scan.pdf', '  ');
  const r = await analyserEntree({ chemin, source: 'urssaf', client: ATTENDU, index });
  assert.ok(['illisible', 'erreur'].includes(r.verdict));
});

test('fichier absent ou corrompu → erreur, sans exception', async () => {
  const p = resolve(tmp, 'corrompu.pdf');
  writeFileSync(p, Buffer.from('ceci n’est pas un PDF'));
  const r = await analyserEntree({ chemin: p, source: 'urssaf', client: ATTENDU, index });
  assert.equal(r.verdict, 'erreur');
});

test('sans client connu, le recoupement croisé fonctionne quand même', async () => {
  const chemin = ecrire('sans-client.pdf', 'MME BADUEL Laure - SIRET 51479147400034');
  const r = await analyserEntree({ chemin, source: 'urssaf', client: null, index });
  assert.equal(r.verdict, 'autre');
  assert.equal(r.proprietaire.id, 2);
});
