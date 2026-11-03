// Recuperation URSSAF d'un client (src/scraper-urssaf.js, recupererAppelsClient) face a
// la QUARANTAINE, contre un FAUX tableau de bord tiers declarant servi en local
// (recherche -> dossier -> messagerie -> pieces jointes PDF) : aucun acces au vrai site.
//  - un courrier generique (sans identifiant du client) part seul en quarantaine : les
//    documents suivants sont recuperes, pas de « session collante », et il n'est plus
//    retelecharge ensuite (cas reel : 82 copies du meme PDF, documents suivants jamais
//    recuperes, reconnexion + nouvel essai chaque nuit) ;
//  - un PDF d'un AUTRE client du portefeuille arrete la messagerie (session collante) ;
//  - au-dela de 3 PDF rejetes dans une messagerie, elle est jugee suspecte.
// Chromium headless (skip si indisponible). Base data/urssaf.db : clients de test
// crees puis supprimes ; quarantaine de ces clients nettoyee.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { Buffer } from 'node:buffer';

const exe = () => (process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});

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

const GENERIQUE = 'Message de votre Urssaf. Declaration de vos revenus : pensez a declarer avant la date limite.';
const ALPHA = { nom: 'ZZTEST ALPHA', siret: '12345678900011' };
const BRAVO = { nom: 'ZZTEST BRAVO', siret: '98765432100022' };
const CHARLIE = { nom: 'ZZTEST CHARLIE', siret: '55544433300033' };
const docAlpha = (objet) => `${objet} - ZZTEST ALPHA - SIRET 123 456 789 00011`;
// Messagerie de chaque compte (par SIRET), dans l'ordre d'affichage.
const MESSAGERIES = {
  [ALPHA.siret]: [
    { eid: '101', objet: 'Declaration de vos revenus', date: '06/07/2026', texte: GENERIQUE },
    { eid: '102', objet: 'Echeancier des cotisations', date: '10/07/2026', texte: docAlpha('Echeancier des cotisations') },
    { eid: '103', objet: 'Notification 3en1', date: '12/08/2026', texte: docAlpha('Notification 3en1') },
  ],
  // Session collante simulee : la messagerie de BRAVO sert un document d'ALPHA.
  [BRAVO.siret]: [
    { eid: '201', objet: 'Echeancier des cotisations', date: '10/07/2026', texte: docAlpha('Echeancier des cotisations') },
    { eid: '202', objet: 'Appel de cotisations', date: '11/07/2026', texte: 'Appel - ZZTEST BRAVO - SIRET 987 654 321 00022' },
  ],
  [CHARLIE.siret]: ['301', '302', '303', '304'].map((eid, i) => ({ eid, objet: `Information ${i + 1}`, date: `0${i + 1}/09/2026`, texte: GENERIQUE })),
};

let srv;
let base;
let browser;
let navigateurOk = true;
let urssaf;
let recupererAppelsClient;
let dossierQuarantaine;
let tmp;
const clients = {};
const telecharges = [];

function site() {
  return createServer((req, res) => {
    const u = new URL(req.url, 'http://localhost');
    const html = (corps) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><html><body>${corps}</body></html>`);
    };
    if (u.pathname === '/accueil') {
      // Tableau de bord : la recherche (Entree) affiche les comptes correspondants.
      const comptes = JSON.stringify(Object.values(clients).map((c) => ({ nom: c.nom, siret: c.siret })));
      return html(`<input id="recherche"><div id="res"></div><script>
        const comptes = ${comptes};
        document.getElementById('recherche').addEventListener('keydown', (e) => {
          if (e.key !== 'Enter') return;
          const v = e.target.value.trim();
          const trouves = comptes.filter((c) => (v.replace(/\\D/g, '') && c.siret.includes(v.replace(/\\D/g, ''))) || c.nom.toLowerCase() === v.toLowerCase());
          document.getElementById('res').innerHTML = trouves
            .map((c) => '<div class="ligne"><span>' + c.nom + ' ' + c.siret + '</span> <a href="/webti?s=' + c.siret + '" target="_blank">Acceder</a></div>')
            .join('');
        });
      </script>`);
    }
    if (u.pathname === '/webti') return html(`<a href="/messagerie/Rico.action?s=${u.searchParams.get('s')}" target="_blank">Messagerie</a>`);
    if (u.pathname === '/messagerie/Rico.action') {
      const msgs = MESSAGERIES[u.searchParams.get('s')] || [];
      return html(
        msgs
          .map(
            (m) => `<div class="row urssaf-message" onclick="apercuMsg('${m.eid}')"><div class="col-lg-5">${m.objet}</div>
              <span class="urssaf_date_echange">${m.date}</span>
              <a href="/messagerie/showAttachement.action?EVENTID=${m.eid}&DOCUMENTID=D${m.eid}">piece jointe</a></div>`,
          )
          .join(''),
      );
    }
    if (u.pathname === '/messagerie/RicoFil.action') return html(''); // pas de page suivante
    if (u.pathname === '/messagerie/showAttachement.action') {
      const eid = u.searchParams.get('EVENTID');
      const m = Object.values(MESSAGERIES)
        .flat()
        .find((x) => x.eid === eid);
      telecharges.push(eid);
      res.writeHead(200, { 'content-type': 'application/pdf' });
      return res.end(pdf(m?.texte || 'vide'));
    }
    res.writeHead(404).end();
  });
}

before(async () => {
  urssaf = await import('../src/urssaf-db.js');
  ({ recupererAppelsClient } = await import('../src/scraper-urssaf.js'));
  ({ QUARANTAINE_DIR: dossierQuarantaine } = await import('../src/quarantaine.js'));
  for (const [cle, c] of Object.entries({ ALPHA, BRAVO, CHARLIE })) clients[cle] = urssaf.createClient(c);
  tmp = mkdtempSync(resolve(tmpdir(), 'urssaf-quarantaine-'));
  srv = site();
  await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
  base = `http://127.0.0.1:${srv.address().port}`;
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
  for (const c of Object.values(clients)) {
    urssaf.deleteClient(c.id);
    const dir = resolve(dossierQuarantaine, 'urssaf');
    let dossiers = [];
    try {
      dossiers = readdirSync(dir);
    } catch {
      /* rien en quarantaine */
    }
    for (const d of dossiers) if (d.startsWith(`${c.id}_`)) rmSync(resolve(dir, d), { recursive: true, force: true });
  }
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

async function recuperer(cle) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const journal = [];
  try {
    await page.goto(`${base}/accueil`);
    const r = await recupererAppelsClient(context, page, clients[cle], { baseFolder: tmp, navTimeout: 15000, log: (m) => journal.push(m) });
    return { r, journal };
  } finally {
    await context.close();
  }
}
const pdfsEnQuarantaine = (cle) => {
  const dir = resolve(dossierQuarantaine, 'urssaf');
  try {
    return readdirSync(dir)
      .filter((d) => d.startsWith(`${clients[cle].id}_`))
      .flatMap((d) => readdirSync(resolve(dir, d)).filter((f) => f.endsWith('.pdf')));
  } catch {
    return [];
  }
};
const dernierRun = (cle) => urssaf.listRuns(50).find((r) => r.client_id === clients[cle].id);

test('courrier générique : seul en quarantaine, documents suivants récupérés, pas de session collante', async (t) => {
  if (!navigateurOk) return t.skip('Chromium indisponible');
  const { r, journal } = await recuperer('ALPHA');
  assert.equal(r.ok, true, journal.join('\n'));
  assert.ok(!r.sessionSuspecte, 'pas de reconnexion / nouvel essai');
  assert.equal(r.docs.length, 2, 'les 2 documents après le courrier générique sont récupérés');
  assert.equal(pdfsEnQuarantaine('ALPHA').length, 1);
  const run = dernierRun('ALPHA');
  assert.equal(run.statut, 'succes');
  assert.match(run.message, /sans identifiant du client mis en quarantaine/);
});

test('nuit suivante : le courrier déjà en quarantaine n’est plus retéléchargé (pas de nouvelle copie)', async (t) => {
  if (!navigateurOk) return t.skip('Chromium indisponible');
  telecharges.length = 0;
  const { r, journal } = await recuperer('ALPHA');
  assert.equal(r.ok, true, journal.join('\n'));
  assert.deepEqual(telecharges, [], 'rien n’est retéléchargé');
  assert.equal(pdfsEnQuarantaine('ALPHA').length, 1, 'toujours un seul exemplaire');
  assert.ok(journal.some((m) => /Deja en quarantaine/.test(m)));
  assert.match(dernierRun('ALPHA').message, /1 deja en quarantaine/);
});

test('PDF d’un autre client du portefeuille : messagerie arrêtée, session collante signalée', async (t) => {
  if (!navigateurOk) return t.skip('Chromium indisponible');
  telecharges.length = 0;
  const { r, journal } = await recuperer('BRAVO');
  assert.equal(r.sessionSuspecte, true, journal.join('\n'));
  assert.deepEqual(telecharges, ['201'], 'arrêt au premier PDF d’un autre compte');
  assert.ok(journal.some((m) => /Document de ZZTEST ALPHA/.test(m)));
  assert.equal(dernierRun('BRAVO').statut, 'echec');
});

test('3 PDF rejetés dans une même messagerie : jugée suspecte', async (t) => {
  if (!navigateurOk) return t.skip('Chromium indisponible');
  telecharges.length = 0;
  const { r, journal } = await recuperer('CHARLIE');
  assert.equal(r.sessionSuspecte, true, journal.join('\n'));
  assert.deepEqual(telecharges, ['301', '302', '303'], 'arrêt au 3e PDF rejeté, le 4e n’est pas téléchargé');
});
