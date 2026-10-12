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
// `etat.jeton` = jeton de session de la zone « mire » (modifiable par les tests pour
// simuler un jeton renouvele).
function demarrerSiteFactice() {
  const etat = { jeton: 'TOK-A' };
  const srv = createServer((req, res) => {
    const u = new URL(req.url, 'http://localhost');
    const p = u.pathname;
    const siren = u.searchParams.get('siren') || '';
    const html = (c, titre = 'Espace pro (factice)', statut = 200) => {
      res.writeHead(statut, { 'content-type': 'text/html; charset=utf-8' });
      res.end(page(titre, c));
    };
    // --- Zone « mire » (refonte DSFR) : jeton de session dans les liens, ouverture d'un
    //     dossier par lien direct dossierSelect.do?idth=..&idDossier=<SIREN>&token=T ---
    if (p === '/mire/accueil.do')
      return html(`<h1>Mes services</h1><a href="/mire/afficherSelectionDossier.do?idth=consulter.avis.cfe&token=${etat.jeton}">Avis CFE</a>`);
    if (p === '/mire/afficherSelectionDossier.do')
      return html(
        `<p>2 résultat(s)</p>` +
          `<a href="dossierSelect.do?idth=consulter.avis.cfe&idDossier=111111111&token=${etat.jeton}">SARL ALPHA</a>` +
          `<a href="dossierSelect.do?idth=consulter.avis.cfe&idDossier=222222222&token=${etat.jeton}">M BETA</a>` +
          `<a href="afficherSelectionDossier.do?idth=consulter.avis.cfe&p=2&token=${etat.jeton}">Page 2</a>`,
      );
    if (p === '/mire/dossierSelect.do') {
      const id = u.searchParams.get('idDossier');
      if (u.searchParams.get('token') !== etat.jeton) return html('<p>Oups, une erreur s’est produite</p>', 'Erreur | Mon espace professionnel');
      if (id === '111111111') {
        res.writeHead(302, { location: '/adelie2mapi/xhtml/accueil/accueil.xhtml' });
        return res.end();
      }
      if (id === '333333333') return html('<p>Vous n’avez aucune habilitation pour ce dossier.</p>', 'Messagerie | Mon espace professionnel', 500);
      return html('<p>Oups, une erreur s’est produite</p>', 'Erreur | Mon espace professionnel');
    }
    if (p.startsWith('/adelie2mapi/')) return html('<h1>Accueil du compte fiscal des professionnels</h1>');
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
  return new Promise((ok) => srv.listen(0, '127.0.0.1', () => ok({ srv, port: srv.address().port, etat })));
}

let mock, navmod, chromium, browser, tmp;

before(async () => {
  mock = await demarrerSiteFactice();
  process.env.IMPOTS_ACCUEIL_URL = `http://127.0.0.1:${mock.port}/`;
  process.env.IMPOTS_MIRE_URL = `http://127.0.0.1:${mock.port}/mire`;
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

// ---- Zone « mire » (refonte DSFR de l'espace pro, oct. 2026) : jeton + ouverture d'un dossier ----

test('jetonMire lit le jeton de session sur les liens de l’accueil', async (t) => {
  if (!browser) return t.skip('Chromium indisponible');
  mock.etat.jeton = 'TOK-A';
  const ctx = await browser.newContext();
  const pg = await ctx.newPage();
  assert.equal(await navmod.jetonMire(pg), 'TOK-A');
  await ctx.close();
});

test('selectionnerDossier : SIREN connu -> redirige vers l’appli cible dans l’onglet courant', async (t) => {
  if (!browser) return t.skip('Chromium indisponible');
  mock.etat.jeton = 'TOK-A';
  const ctx = await browser.newContext();
  const pg = await ctx.newPage();
  const r = await navmod.selectionnerDossier(pg, '111111111', 'consulter.avis.cfe');
  assert.equal(r.ok, true);
  assert.equal(r.cible, pg, 'l’ouverture se fait dans l’onglet courant');
  assert.match(pg.url(), /adelie2mapi/);
  await ctx.close();
});

test('selectionnerDossier : SIREN hors portefeuille -> introuvable (pas une panne)', async (t) => {
  if (!browser) return t.skip('Chromium indisponible');
  mock.etat.jeton = 'TOK-A';
  const ctx = await browser.newContext();
  const pg = await ctx.newPage();
  const r = await navmod.selectionnerDossier(pg, '999999999', 'consulter.avis.cfe');
  assert.equal(r.ok, false);
  assert.equal(r.introuvable, true);
  await ctx.close();
});

test('selectionnerDossier : dossier sans habilitation (HTTP 500 « aucune habilitation ») -> cas normal', async (t) => {
  if (!browser) return t.skip('Chromium indisponible');
  mock.etat.jeton = 'TOK-A';
  const ctx = await browser.newContext();
  const pg = await ctx.newPage();
  const r = await navmod.selectionnerDossier(pg, '333333333', 'messagerie.gaia2.messagerie');
  assert.equal(r.ok, false);
  assert.equal(r.sansHabilitation, true);
  assert.ok(!r.introuvable);
  await ctx.close();
});

test('selectionnerDossier : jeton périmé -> relu sur l’accueil, puis nouvelle tentative réussie', async (t) => {
  if (!browser) return t.skip('Chromium indisponible');
  mock.etat.jeton = 'TOK-A';
  const ctx = await browser.newContext();
  const pg = await ctx.newPage();
  assert.equal(await navmod.jetonMire(pg), 'TOK-A'); // mis en cache
  mock.etat.jeton = 'TOK-B'; // la session renouvelle son jeton
  const r = await navmod.selectionnerDossier(pg, '111111111', 'consulter.avis.cfe');
  assert.equal(r.ok, true, 'le jeton rafraîchi doit être réutilisé');
  assert.equal(await navmod.jetonMire(pg), 'TOK-B');
  await ctx.close();
  mock.etat.jeton = 'TOK-A';
});

test('lireDossiersPage : un dossier par lien dossierSelect.do (nom + SIREN)', async (t) => {
  if (!browser) return t.skip('Chromium indisponible');
  mock.etat.jeton = 'TOK-A';
  const ctx = await browser.newContext();
  const pg = await ctx.newPage();
  await pg.goto(`${process.env.IMPOTS_MIRE_URL}/afficherSelectionDossier.do?idth=consulter.avis.cfe&token=TOK-A`);
  assert.deepEqual(await navmod.lireDossiersPage(pg), [
    { nom: 'SARL ALPHA', siren: '111111111' },
    { nom: 'M BETA', siren: '222222222' },
  ]);
  await ctx.close();
});

// NB : la récupération TVA (ADELIE : ouverture du dossier -> declarations_tva.xhtml ->
// téléchargement du tableau) n'est pas rejouée ici : le parcours ADELIE tokenisé par dossier
// est trop spécifique pour un site factice fidèle — le test masquerait plus qu'il ne prouve.
// Elle était validée en session réelle AVANT la refonte DSFR ; depuis, seuls l'ouverture du
// dossier (compte fiscal) et la présence du menu « déclarations TVA » ont été revérifiés à
// la main (oct. 2026) — le téléchargement du tableau reste à confirmer au prochain essai TVA.
