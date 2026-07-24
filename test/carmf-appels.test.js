// Tests de la detection des APPELS DE COTISATION CARMF (src/scraper-carmf.js), contre un
// site FACTICE local reproduisant la page « Vos derniers appels de cotisations » telle que
// decrite par la CARMF (lien texte « Votre appel de cotisations (acompte) 2026 » ->
// /duplicatas/sendfile/<id>), plus les variantes plausibles (printPDF, tableau).
// Ne teste PAS extranet.carmf.fr (espace authentifie, un compte par medecin).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { Buffer } from 'node:buffer';

// PDF minimal valide (magic %PDF + assez d'octets pour passer le seuil des 100).
const PDF = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.from('% '.repeat(80)), Buffer.from('\n%%EOF\n')]);

const page = (corps) => `<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>eCARMF</title></head><body>${corps}</body></html>`;

// Site factice : page des appels + les deux voies de telechargement (sendfile direct et
// mecanisme jeton /pdf<chemin> -> /fichiers/open/<jeton>).
function demarrerSiteFactice() {
  const srv = createServer((req, res) => {
    const u = new URL(req.url, 'http://localhost');
    const p = u.pathname;
    const html = (c) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(page(c));
    };
    // Page « Vos derniers appels de cotisations » : forme decrite par la CARMF (liens sendfile)
    // + une entree via printPDF + une ligne de tableau, pour exercer les 3 heuristiques.
    if (p === '/duplicatas/appel_cotisation')
      return html(`
        <h1>Vos derniers appels de cotisations</h1>
        <p>Vous trouverez ci-dessous vos derniers appels de cotisations à télécharger.</p>
        <ul>
          <li><a href="/duplicatas/sendfile/8801">Votre appel de cotisations (acompte) 2026</a></li>
          <li><a href="/duplicatas/sendfile/8712">Votre appel de cotisations (solde) 2025</a></li>
        </ul>
        <table><tr><td>Appel de cotisations 2024</td>
          <td><a href="#" onclick="printPDF('/duplicatas/appel_cotisation/2024')">PDF</a></td></tr></table>
        <a href="#" onclick="printPDF('/duplicatas/appel_cotisation')" id="btn-imprimer">Imprimer</a>
        <a href="/adherents/deconnecter">Se déconnecter</a>`);
    // Voie 1 : lien direct
    if (/^\/duplicatas\/sendfile\/\d+$/.test(p)) {
      res.writeHead(200, { 'content-type': 'application/pdf' });
      return res.end(PDF);
    }
    // Voie 2 : jeton puis ouverture
    if (p.startsWith('/pdf/')) {
      res.writeHead(200, { 'content-type': 'text/plain' });
      return res.end(`"jeton-${p.replace(/\W+/g, '-')}"`);
    }
    if (p.startsWith('/fichiers/open/')) {
      res.writeHead(200, { 'content-type': 'application/pdf' });
      return res.end(PDF);
    }
    // Page SANS appel (adherent retraite/exonere) : aucun lien de telechargement.
    if (p === '/vide') return html('<h1>Vos derniers appels de cotisations</h1><p>Aucun document disponible.</p>');
    // Page dont le seul printPDF est le bouton « Imprimer » (pointe sur elle-meme).
    if (p === '/imprimer-seul') return html('<h1>Vos derniers appels de cotisations</h1><a href="#" onclick="printPDF(\'/imprimer-seul\')">Imprimer</a>');
    // Session expiree : CakePHP renvoie 200 + HTML au lieu du PDF.
    if (p === '/expire') {
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end(page('<form id="AdherentConnecterForm"></form>'));
    }
    res.writeHead(404);
    res.end('nope');
  });
  return new Promise((ok) => srv.listen(0, '127.0.0.1', () => ok({ srv, port: srv.address().port })));
}

let mock, mod, browser, base;

before(async () => {
  mock = await demarrerSiteFactice();
  base = `http://127.0.0.1:${mock.port}`;
  // AVANT l'import : le module lit CARMF_BASE_URL au chargement. Sans ça, le mécanisme
  // jeton taperait sur le vrai extranet.carmf.fr.
  process.env.CARMF_BASE_URL = base;
  mod = await import('../src/scraper-carmf.js');
  try {
    const { chromium } = await import('playwright');
    browser = await chromium.launch({ headless: true });
  } catch {
    browser = null; // Chromium indisponible -> tests navigateur skippes
  }
});

after(async () => {
  await browser?.close().catch(() => {});
  mock?.srv.close();
});

// ---- analyserLibelleAppel (fonction pure) ----

test('analyserLibelleAppel : millésime et type extraits du libellé', () => {
  assert.deepEqual(mod.analyserLibelleAppel('Votre appel de cotisations (acompte) 2026'), {
    annee: '2026',
    type: 'acompte',
    libelle: 'Votre appel de cotisations (acompte) 2026',
  });
  const solde = mod.analyserLibelleAppel('  Votre appel de cotisations   (solde)\n2025 ');
  assert.equal(solde.annee, '2025');
  assert.equal(solde.type, 'solde');
  assert.equal(solde.libelle, 'Votre appel de cotisations (solde) 2025', 'espaces normalisés');
});

test('analyserLibelleAppel : sans type ni année -> champs vides (pas de date du jour)', () => {
  const a = mod.analyserLibelleAppel('Appel de cotisations');
  assert.equal(a.annee, '');
  assert.equal(a.type, '');
  assert.equal(mod.analyserLibelleAppel('').annee, '');
  assert.equal(mod.analyserLibelleAppel(null).libelle, '');
});

test('analyserLibelleAppel : régularisation accentuée normalisée', () => {
  assert.equal(mod.analyserLibelleAppel('Appel de cotisations (Régularisation) 2025').type, 'regularisation');
});

// ---- listerAppels (détection dans une vraie page) ----

test('listerAppels : détecte les appels (sendfile) et le printPDF', async (t) => {
  if (!browser) return t.skip('Chromium indisponible');
  const ctx = await browser.newContext();
  const pg = await ctx.newPage();
  await pg.goto(`${base}/duplicatas/appel_cotisation`);
  const trouves = await mod.listerAppels(pg);
  // Les 2 appels sendfile + l'entrée printPDF doivent être présents.
  const hrefs = trouves.map((c) => c.href).filter(Boolean);
  assert.ok(
    hrefs.some((h) => h.includes('/duplicatas/sendfile/8801')),
    'appel acompte 2026 détecté',
  );
  assert.ok(
    hrefs.some((h) => h.includes('/duplicatas/sendfile/8712')),
    'appel solde 2025 détecté',
  );
  assert.ok(
    trouves.some((c) => c.chemin === '/duplicatas/appel_cotisation/2024'),
    'chemin printPDF extrait',
  );
  // Le libellé doit permettre de retrouver le millésime.
  const acompte = trouves.find((c) => c.href.includes('8801'));
  assert.equal(mod.analyserLibelleAppel(acompte.libelle).annee, '2026');
  assert.equal(mod.analyserLibelleAppel(acompte.libelle).type, 'acompte');
  // Aucune cible parasite : le lien de déconnexion ne doit pas être pris.
  assert.ok(!trouves.some((c) => /deconnecter/.test(c.href)), 'lien de déconnexion ignoré');
  // Régression constatée en session réelle : le bouton « Imprimer » pointe sur la PAGE
  // elle-même (printPDF('/duplicatas/appel_cotisation')) et produisait un faux appel.
  assert.ok(!trouves.some((c) => c.chemin === '/duplicatas/appel_cotisation'), 'bouton « Imprimer » (impression de la page) exclu');
  await ctx.close();
});

test('listerAppels : sans libellé parlant, le repli ne prend pas la page courante', async (t) => {
  if (!browser) return t.skip('Chromium indisponible');
  const ctx = await browser.newContext();
  const pg = await ctx.newPage();
  await pg.goto(`${base}/imprimer-seul`);
  // Page dont le SEUL printPDF est le bouton « Imprimer » : rien à récupérer.
  assert.deepEqual(await mod.listerAppels(pg), []);
  await ctx.close();
});

test('listerAppels : page sans appel -> liste vide (déclenche le diagnostic)', async (t) => {
  if (!browser) return t.skip('Chromium indisponible');
  const ctx = await browser.newContext();
  const pg = await ctx.newPage();
  await pg.goto(`${base}/vide`);
  assert.deepEqual(await mod.listerAppels(pg), []);
  await ctx.close();
});

// ---- telechargerPdf (les deux voies + rejet du non-PDF) ----

test('telechargerPdf : lien direct (sendfile) -> buffer PDF', async (t) => {
  if (!browser) return t.skip('Chromium indisponible');
  const ctx = await browser.newContext();
  const r = await mod.telechargerPdf(ctx, { href: `${base}/duplicatas/sendfile/8801` }, 10000);
  assert.equal(r.err, undefined, `erreur inattendue : ${r.err || ''}`);
  assert.equal(r.buf.subarray(0, 4).toString(), '%PDF');
  await ctx.close();
});

test('telechargerPdf : mécanisme jeton (printPDF) -> buffer PDF', async (t) => {
  if (!browser) return t.skip('Chromium indisponible');
  const ctx = await browser.newContext();
  const r = await mod.telechargerPdf(ctx, { chemin: '/duplicatas/appel_cotisation/2024' }, 10000);
  assert.equal(r.err, undefined, `erreur inattendue : ${r.err || ''}`);
  assert.equal(r.buf.subarray(0, 4).toString(), '%PDF');
  await ctx.close();
});

test('telechargerPdf : HTML renvoyé en 200 (session expirée) -> rejeté, pas de faux PDF', async (t) => {
  if (!browser) return t.skip('Chromium indisponible');
  const ctx = await browser.newContext();
  const r = await mod.telechargerPdf(ctx, { href: `${base}/expire` }, 10000);
  assert.equal(r.buf, undefined);
  assert.match(r.err, /non-PDF/);
  await ctx.close();
});

test('telechargerPdf : 404 -> erreur explicite sans lever', async (t) => {
  if (!browser) return t.skip('Chromium indisponible');
  const ctx = await browser.newContext();
  const r = await mod.telechargerPdf(ctx, { href: `${base}/introuvable` }, 10000);
  assert.match(r.err, /HTTP 404/);
  await ctx.close();
});
