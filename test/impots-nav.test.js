// Test de la MECANIQUE de navigation des nouveaux parcours impots (habilitations + TVA),
// contre un site FACTICE local reproduisant les libelles decrits (Gerer > Consulter mes
// services > Tout telecharger ; Consulter > Compte fiscal > SIREN > Acces par impot > TVA
// > Declarations > Telecharger le tableau). Ne teste PAS impots.gouv.fr (login+captcha) :
// valide que cliquerParTexte trouve les libelles, capture le telechargement et range le
// fichier. Lance un Chromium headless (skip si indisponible).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

const page = (titre, corps) => `<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>${titre}</title></head><body>${corps}</body></html>`;

// Site factice : chaque page porte le libelle exact que le scraper doit cliquer.
function demarrerSiteFactice() {
  const srv = createServer((req, res) => {
    const u = new URL(req.url, 'http://localhost');
    const p = u.pathname;
    const siren = u.searchParams.get('siren') || '';
    const html = (c) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(page('Espace pro (factice)', c));
    };
    if (p === '/')
      return html(
        `<h1>Accueil</h1><a href="/eservices?idurlm=gerer.services&token=T" target="EServices">Gérer les services</a> <a href="/consulter">Consulter</a>`,
      );
    // --- Parcours HABILITATIONS : le lien ouvre l'appli E-Services dans une nouvelle fenetre ---
    if (p === '/eservices') return html(`<h2>Mes services</h2><a href="/dl?f=habilitations.csv">Tout télécharger</a>`);
    // --- Parcours TVA (par client) ---
    if (p === '/consulter') return html(`<a href="/cf">Compte fiscal</a>`);
    if (p === '/cf') return html(`<form action="/cf-res" method="get"><input type="text" name="siren" /><button type="submit">Consulter</button></form>`);
    if (p === '/cf-res') return html(`<p>SIREN ${siren}</p><a href="/acces?siren=${siren}">Accès par impôt</a>`);
    if (p === '/acces') return html(`<a href="/tva?siren=${siren}">Taxe sur la valeur ajoutée</a>`);
    if (p === '/tva') return html(`<a href="/tva-decl?siren=${siren}">Déclarations</a>`);
    if (p === '/tva-decl') return html(`<a href="/dl?f=TVA_${siren}.csv">Télécharger le tableau</a>`);
    // --- Telechargement (piece jointe) ---
    if (p === '/dl') {
      const f = u.searchParams.get('f') || 'fichier.csv';
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': `attachment; filename="${f}"` });
      return res.end('col1;col2\nA;B\n');
    }
    res.writeHead(404);
    res.end('nope');
  });
  return new Promise((ok) => srv.listen(0, '127.0.0.1', () => ok({ srv, port: srv.address().port })));
}

let mock, navmod, chromium, browser, tmp;

before(async () => {
  mock = await demarrerSiteFactice();
  process.env.IMPOTS_ACCUEIL_URL = `http://127.0.0.1:${mock.port}/`;
  navmod = await import('../src/scraper-impots.js');
  try {
    ({ chromium } = await import('playwright'));
    browser = await chromium.launch({ headless: true });
  } catch {
    browser = null; // Chromium indisponible -> tests skippes
  }
  tmp = mkdtempSync(resolve(tmpdir(), 'impots-nav-'));
});

after(async () => {
  await browser?.close().catch(() => {});
  mock?.srv.close();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  // Nettoie le dossier d'habilitations de test cree sous downloads/_habilitations/.
  try {
    rmSync(navmod.dossierHabilitations({ id: '_test', libelle: 'NAV_FACTICE' }), { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

test('cliquerParTexte trouve un lien par libellé (accent/casse tolérés)', async (t) => {
  if (!browser) return t.skip('Chromium indisponible');
  const ctx = await browser.newContext();
  const pg = await ctx.newPage();
  await pg.goto(process.env.IMPOTS_ACCUEIL_URL);
  const ok = await navmod.cliquerParTexte(pg, [/consulter/i]);
  assert.equal(ok, true, 'le lien « Consulter » doit être cliqué');
  await pg.waitForLoadState('domcontentloaded').catch(() => {});
  assert.match(await pg.content(), /Compte fiscal/, 'la navigation doit atteindre la page suivante');
  await ctx.close();
});

test('telechargerHabilitations : navigue et enregistre le tableau', async (t) => {
  if (!browser) return t.skip('Chromium indisponible');
  const ctx = await browser.newContext({ acceptDownloads: true });
  const pg = await ctx.newPage();
  const cabinet = { id: '_test', libelle: 'NAV_FACTICE', login: 'x@y.fr' };
  const r = await navmod.telechargerHabilitations(pg, cabinet, { navTimeout: 15000, log: () => {} });
  assert.equal(r.ok, true, `échec inattendu : ${r.error || ''}`);
  assert.ok(existsSync(r.fichier), 'le fichier téléchargé doit exister');
  assert.match(r.fichier, /habilitations/i);
  await ctx.close();
});

// NB : la récupération TVA (compte fiscal ADELIE : sélection dossier -> fenêtre EServices ->
// declarations_tva.xhtml) est VALIDÉE en session réelle (impots.gouv.fr). Elle n'est pas
// rejouée ici : le parcours (URL ADELIE tokenisée par dossier, fenêtre nommée réutilisée)
// est trop spécifique pour un site factice fidèle — le test masquerait plus qu'il ne prouve.
