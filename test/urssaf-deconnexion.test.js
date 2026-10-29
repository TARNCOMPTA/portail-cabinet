// Test du retour automatique sur https://tdbec.urssaf.fr/accueil quand l'URSSAF « deconnecte »
// le navigateur (bascule vers login.urssaf.fr/api/oauth/... au lieu du tableau de bord).
// Les URL URSSAF sont INTERCEPTEES (page.route) : aucun acces reseau au vrai site.
// Chromium headless (skip si indisponible).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

const exe = () => (process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const AUTH = 'https://login.urssaf.fr/api/oauth/v1/providerLogin?requestOrigin=x';
const html = (corps) => ({ status: 200, contentType: 'text/html; charset=utf-8', body: `<!doctype html><html><body>${corps}</body></html>` });

let browser;
let attendreTableauBord;
let navigateurOk = true;

before(async () => {
  ({ attendreTableauBord } = await import('../src/scraper-urssaf.js'));
  try {
    const { chromium } = await import('playwright');
    browser = await chromium.launch({ headless: true, ...exe() });
  } catch {
    navigateurOk = false;
  }
});
after(async () => {
  await browser?.close();
});

// Ouvre une page dont tdbec/accueil « deconnecte » les `nbDeconnexions` premieres visites
// (redirection vers l'authentification APRES chargement), puis affiche le tableau de bord.
async function pageAvecDeconnexions(nbDeconnexions) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const visites = { accueil: 0 };
  await page.route('https://login.urssaf.fr/**', (r) => r.fulfill(html('<h1>Authentification</h1>')));
  await page.route('https://tdbec.urssaf.fr/accueil', (r) => {
    visites.accueil++;
    if (visites.accueil <= nbDeconnexions)
      return r.fulfill(html(`<p>Chargement…</p><script>setTimeout(() => (location.href = ${JSON.stringify(AUTH)}), 200)</script>`));
    return r.fulfill(html('<input id="recherche" placeholder="Rechercher un compte">'));
  });
  await page.goto(AUTH);
  return { context, page, visites };
}

test('déconnexion URSSAF : retour sur tdbec/accueil jusqu’au tableau de bord', async (t) => {
  if (!navigateurOk) return t.skip('Chromium indisponible');
  const { context, page, visites } = await pageAvecDeconnexions(2);
  try {
    const journal = [];
    const t0 = Date.now();
    assert.equal(await attendreTableauBord(page, (m) => journal.push(m)), true);
    assert.equal(visites.accueil, 3, '2 déconnexions puis le tableau de bord');
    assert.ok(journal.filter((m) => /Deconnexion URSSAF/.test(m)).length >= 2, journal.join(' | '));
    assert.ok(Date.now() - t0 < 10000, 'pas d’attente de 12 s sur la page d’authentification');
  } finally {
    await context.close();
  }
});

test('déconnexion persistante : abandon après 4 retours (pas de boucle infinie)', async (t) => {
  if (!navigateurOk) return t.skip('Chromium indisponible');
  const { context, page, visites } = await pageAvecDeconnexions(99);
  try {
    assert.equal(await attendreTableauBord(page, () => {}), false);
    assert.equal(visites.accueil, 4);
  } finally {
    await context.close();
  }
});
