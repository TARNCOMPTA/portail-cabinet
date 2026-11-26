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
import { mkdtempSync, rmSync, readFileSync, existsSync, readdirSync } from 'node:fs';
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
// Echanges de la messagerie. `forme` : 'deplie' = ligne depliee PrimeFaces commencant par
// « De : » (forme reelle du message de la SAS WAZAÏ, 20/11/2026) ; 'objet' = bloc « Objet :
// … De : … A : … » qui ne repete PAS le numero de l'echange. `pjs` : pieces jointes affichees.
const RELEVE = { nom: 'Releve_bancaire.pdf', texte: 'Releve de compte sans identifiant du titulaire' };
const attestation = (num) => ({
  nom: `ARF_${num}.pdf`,
  texte: `Attestation de regularite fiscale - SAS ZZTEST - SIREN ${SIREN.slice(0, 3)} ${SIREN.slice(3, 6)} ${SIREN.slice(6)}`,
});
const ECHANGES = [
  // Recent, avec une piece jointe sans identifiant (partira en quarantaine).
  {
    num: '1250402904',
    objet: 'Demande d’attestation de régularité fiscale',
    date: jjmmaaaa(6),
    corps: 'Serait-il possible d’avoir une attestation ?',
    pjs: [RELEVE],
  },
  // Ancien, au texte plus LONG : ouvert en premier (ordre chronologique), sa ligne depliee
  // reste ouverte quand on ouvre les suivants.
  {
    num: '1190000001',
    objet: 'Ma réclamation sur la TVA',
    date: jjmmaaaa(200),
    corps:
      'Je conteste la majoration appliquée sur la TVA de juin : la déclaration a été déposée dans les délais, voir l’accusé de réception joint. Merci de bien vouloir annuler la pénalité.',
    pjs: [],
  },
  {
    num: '1240000077',
    objet: 'Question de la DGFiP',
    date: jjmmaaaa(20),
    forme: 'objet',
    corps: 'Merci de nous transmettre le détail du chiffre d’affaires déclaré.',
    pjs: [],
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
      // Datatable « Mes echanges » (dans son bloc PrimeFaces) ; cliquer un N° deplie le
      // message et ses pieces jointes.
      const lignes = ECHANGES.map((e, i) => {
        const message =
          e.forme === 'objet'
            ? `Objet : ${e.objet}\nDe : SIE ALBI\nA : SAS ZZTEST\n\n${e.corps}`
            : `De :SAS ZZTEST\nMa demande N°${e.num}\n${e.date}\nA :CENTRE DE CONTACT DES PROS\n\nBonjour,\n\n${e.corps}\n\nAccusé\nRéception` +
              (e.reponse ? `\n\nDe :CENTRE DE CONTACT DES PROS\nA :SAS ZZTEST\n${e.reponse}` : '');
        const pjs = e.pjs
          .map((pj, k) => `<a id="listeDemandesForm:listeDemandes:${i}:pj:${k}:downloadFile" href="/pj?num=${e.num}&k=${k}">${pj.nom}</a>`)
          .join(' ');
        return (
          `<tr><td><a id="listeDemandesForm:listeDemandes:${i}:numDemande" href="#" onclick="document.getElementById('d${i}').style.display='';return false;">${e.num}</a></td>` +
          `<td>${e.objet}</td><td>CENTRE DE CONTACT DES PROS</td><td>En cours</td><td></td><td>${e.date}</td></tr>` +
          `<tr id="d${i}" class="ui-expanded-row-content" style="display:none"><td colspan="6"><div style="white-space:pre-line">${message}</div>${pjs}</td></tr>`
        );
      }).join('');
      return html(`<p>SIREN : ${SIREN}</p><div class="ui-datatable"><table>${lignes}</table></div>`);
    }
    if (u.pathname === '/pj') {
      const pj = ECHANGES.find((x) => x.num === u.searchParams.get('num')).pjs[Number(u.searchParams.get('k'))];
      telechargementsPj.push(pj.nom);
      res.writeHead(200, { 'content-type': 'application/pdf', 'content-disposition': `attachment; filename="${pj.nom}"` });
      return res.end(pdf(pj.texte));
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
  if (client) {
    db.deleteClient(client.id);
    const { QUARANTAINE_DIR } = await import('../src/quarantaine.js');
    const dir = resolve(QUARANTAINE_DIR, 'impots');
    if (existsSync(dir)) for (const d of readdirSync(dir)) if (d.startsWith(`${client.id}_`)) rmSync(resolve(dir, d), { recursive: true, force: true });
  }
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

test('1er passage : demandes enregistrées, chaque message avec SON texte', async (t) => {
  if (!navigateurOk) return t.skip('Chromium indisponible');
  const r = await passage();
  assert.equal(r.docs.length, 3, r.journal.join('\n'));
  assert.equal(r.quarantaines.length, 1, 'le relevé sans identifiant part en quarantaine');
  assert.match(message('1250402904'), /Ma demande N°1250402904/);
  assert.doesNotMatch(message('1250402904'), /1190000001|majoration/, 'pas le texte de l’autre échange (resté déplié)');
  assert.match(message('1190000001'), /majoration/);
  // Bloc « Objet : » sans son numéro : son propre bloc, pas tout le tableau des échanges.
  assert.match(message('1240000077'), /Objet : Question de la DGFiP[\s\S]*chiffre d’affaires/);
  assert.doesNotMatch(message('1240000077'), /1250402904|1190000001|En cours/, 'pas le tableau entier');
});

test('la DGFiP répond dans le même échange : réponse et attestation récupérées au passage suivant', async (t) => {
  if (!navigateurOk) return t.skip('Chromium indisponible');
  telechargementsPj.length = 0;
  // Reponse : l'attestation est listee AVANT le releve deja en quarantaine (rangs decales).
  ECHANGES[0].reponse = 'Réponse à votre demande N°1250402904 : veuillez trouver ci-joint votre attestation.';
  ECHANGES[0].pjs = [attestation('1250402904'), RELEVE];
  ECHANGES[1].reponse = 'Réponse à votre demande N°1190000001 : ci-joint.';
  ECHANGES[1].pjs = [attestation('1190000001')];
  const r = await passage();
  assert.ok(
    r.journal.some((m) => /2 récent\(s\) relu\(s\)/.test(m)),
    r.journal.join('\n'),
  );
  assert.deepEqual(telechargementsPj, ['ARF_1250402904.pdf'], 'seule l’attestation : ni le relevé en quarantaine, ni l’échange de plus de 90 jours');
  const pj = db.listDocuments(client.id).find((d) => /ARF_1250402904\.pdf$/.test(d.fichier));
  assert.ok(pj && existsSync(pj.fichier), 'attestation enregistrée');
  assert.match(message('1250402904'), /ci-joint votre attestation/, 'message mis à jour avec la réponse');
  assert.match(message('1240000077'), /^N° 1240000077[\s\S]*Objet : Question/, 'message sans numéro non réécrit');
});

test('passage suivant : rien n’est retéléchargé ni réécrit', async (t) => {
  if (!navigateurOk) return t.skip('Chromium indisponible');
  telechargementsPj.length = 0;
  const r = await passage();
  assert.equal(r.docs.length, 0, r.journal.join('\n'));
  assert.deepEqual(telechargementsPj, []);
});
