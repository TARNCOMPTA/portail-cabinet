// Messagerie de l'espace professionnel (src/scraper-impots.js, recupererMessagerie) : la
// DGFiP repond DANS le meme echange (meme numero), parfois des jours apres la demande, avec
// l'attestation en piece jointe. Un echange deja enregistre doit donc etre RELU tant qu'il
// est recent (cas reel : attestation de regularite fiscale de la SAS WAZAÏ, jamais
// recuperee car l'echange, enregistre au moment de la demande, n'etait plus rouvert).
// Faux espace professionnel servi en local (mire -> gaia2 « Mes echanges ») : aucun acces
// au vrai site. Chromium headless (skip si indisponible). Base data/impots.db : client de
// test cree puis supprime.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { Buffer } from 'node:buffer';

const exe = () => (process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const SIREN = '911111119';

// PDF minimal contenant un texte donne (meme fabrique que test/quarantaine.test.js).
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

const jjmmaaaa = (joursAvant) => {
  const d = new Date(Date.now() - joursAvant * 86400000);
  return `${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${d.getUTCFullYear()}`;
};
// Echanges de la messagerie : un recent (demande d'attestation) et un ancien (> 90 jours).
const ECHANGES = [
  { num: '1250402904', objet: 'Demande d’attestation de régularité fiscale', date: jjmmaaaa(6), corps: 'Serait-il possible d’avoir une attestation ?' },
  // Ancien, au texte plus LONG : ouvert en premier (ordre chronologique), sa ligne depliee
  // reste ouverte quand on ouvre le suivant.
  {
    num: '1190000001',
    objet: 'Ma réclamation sur la TVA',
    date: jjmmaaaa(200),
    corps:
      'Je conteste la majoration appliquée sur la TVA de juin : la déclaration a été déposée dans les délais, voir l’accusé de réception joint. Merci de bien vouloir annuler la pénalité.',
  },
];
const telechargementsPj = [];

function site() {
  return createServer((req, res) => {
    const u = new URL(req.url, 'http://localhost');
    const html = (corps) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><html><body>${corps}</body></html>`);
    };
    if (u.pathname === '/mire/accueil.do') return html('<a href="/mire/afficherSelectionDossier.do?token=TOK">Mes dossiers</a>');
    if (u.pathname === '/mire/dossierSelect.do') {
      res.writeHead(302, { location: `/gaia2-zu-mapi/pages/pro/portailpro.xhtml?s=${u.searchParams.get('idDossier')}` });
      return res.end();
    }
    if (u.pathname === '/gaia2-zu-mapi/pages/pro/portailpro.xhtml') {
      // Datatable « Mes echanges » ; cliquer un N° deplie le message et ses pieces jointes.
      const lignes = ECHANGES.map((e, i) => {
        // Meme forme que le message reel de la SAS WAZAÏ (20/11/2026) : ligne depliee
        // PrimeFaces commencant par « De : », sans « Objet : ».
        const message =
          `De :SAS ZZTEST\nMa demande N°${e.num}\n${e.date}\nA :CENTRE DE CONTACT DES PROS\n\nBonjour,\n\n${e.corps}\n\nAccusé\nRéception` +
          (e.reponse ? `\n\nDe :CENTRE DE CONTACT DES PROS\nA :SAS ZZTEST\n${e.reponse}` : '');
        const pj = e.pj ? `<a id="listeDemandesForm:listeDemandes:${i}:pj:0:downloadFile" href="/pj?num=${e.num}">${e.pj}</a>` : '';
        return (
          `<tr><td><a id="listeDemandesForm:listeDemandes:${i}:numDemande" href="#" onclick="document.getElementById('d${i}').style.display='';return false;">${e.num}</a></td>` +
          `<td>${e.objet}</td><td>CENTRE DE CONTACT DES PROS</td><td>En cours</td><td></td><td>${e.date}</td></tr>` +
          `<tr id="d${i}" class="ui-expanded-row-content" style="display:none"><td colspan="6"><div style="white-space:pre-line">${message}</div>${pj}</td></tr>`
        );
      }).join('');
      return html(`<p>SIREN : ${SIREN}</p><table>${lignes}</table>`);
    }
    if (u.pathname === '/pj') {
      const e = ECHANGES.find((x) => x.num === u.searchParams.get('num'));
      telechargementsPj.push(e.num);
      res.writeHead(200, { 'content-type': 'application/pdf', 'content-disposition': `attachment; filename="${e.pj}"` });
      return res.end(pdf(`Attestation de regularite fiscale - SAS ZZTEST - SIREN ${SIREN.slice(0, 3)} ${SIREN.slice(3, 6)} ${SIREN.slice(6)}`));
    }
    res.writeHead(404).end();
  });
}

let srv;
let browser;
let navigateurOk = true;
let db;
let recupererMessagerie;
let client;
let tmp;

before(async () => {
  srv = site();
  await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
  const base = `http://127.0.0.1:${srv.address().port}`;
  process.env.IMPOTS_ACCUEIL_URL = `${base}/`;
  process.env.IMPOTS_MIRE_URL = `${base}/mire`;
  db = await import('../src/db.js');
  ({ recupererMessagerie } = await import('../src/scraper-impots.js'));
  client = db.createClient({ nom: 'SAS ZZTEST', siret: SIREN });
  tmp = mkdtempSync(resolve(tmpdir(), 'impots-messagerie-'));
  try {
    const { chromium } = await import('playwright');
    browser = await chromium.launch({ headless: true, ...exe() });
  } catch {
    navigateurOk = false;
  }
});
after(async () => {
  await browser?.close();
  srv?.close();
  if (client) db.deleteClient(client.id);
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

async function passage() {
  const context = await browser.newContext();
  const page = await context.newPage();
  const journal = [];
  try {
    const r = await recupererMessagerie(page, context, client, tmp, 15000, (m) => journal.push(m));
    return { ...r, journal };
  } finally {
    await context.close();
  }
}
const message = (num) => {
  const d = db.getDocumentByEventid(client.id, `MSG_${num}`);
  return d ? readFileSync(d.fichier, 'utf8') : null;
};

test('1er passage : la demande seule est enregistrée (pas encore de réponse)', async (t) => {
  if (!navigateurOk) return t.skip('Chromium indisponible');
  const r = await passage();
  assert.equal(r.docs.length, 2, r.journal.join('\n'));
  assert.match(message('1250402904'), /Ma demande N°1250402904/);
  assert.doesNotMatch(message('1250402904'), /1190000001|majoration/, 'pas le texte de l’autre échange (resté déplié)');
  assert.match(message('1190000001'), /majoration/);
  assert.doesNotMatch(message('1250402904'), /ci-joint/);
});

test('la DGFiP répond dans le même échange : réponse et attestation récupérées au passage suivant', async (t) => {
  if (!navigateurOk) return t.skip('Chromium indisponible');
  for (const e of ECHANGES) {
    e.reponse = `Réponse à votre demande N°${e.num} : veuillez trouver ci-joint votre attestation.`;
    e.pj = `ARF_${e.num}.pdf`;
  }
  const r = await passage();
  assert.ok(
    r.journal.some((m) => /1 récent\(s\) relu\(s\)/.test(m)),
    r.journal.join('\n'),
  );
  const pj = db.getDocumentByEventid(client.id, 'MSG_1250402904_PJ1');
  assert.ok(pj && existsSync(pj.fichier), 'attestation enregistrée');
  assert.match(message('1250402904'), /ci-joint votre attestation/, 'message mis à jour avec la réponse');
  assert.deepEqual(telechargementsPj, ['1250402904'], 'l’échange de plus de 90 jours n’est pas relu');
});

test('passage suivant : rien n’est retéléchargé', async (t) => {
  if (!navigateurOk) return t.skip('Chromium indisponible');
  const r = await passage();
  assert.equal(r.docs.length, 0, r.journal.join('\n'));
  assert.deepEqual(telechargementsPj, ['1250402904'], 'pas de second téléchargement de l’attestation');
});
