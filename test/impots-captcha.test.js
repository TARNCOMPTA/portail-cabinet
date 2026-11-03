// Connexion impots (src/scraper-impots.js, attendreConnexionManuelle) : apres une captcha
// REFUSEE, le site recharge le formulaire de connexion VIDE. Le robot doit re-remplir
// e-mail + mot de passe, que la captcha soit saisie dans le bandeau du portail ou
// directement dans le navigateur (noVNC). Les URL impots sont INTERCEPTEES (page.route) :
// aucun acces au vrai site. Chromium headless (skip si indisponible).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

const exe = () => (process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const LOGIN = 'cabinet@exemple.fr';
const PWD = 'MotDePasse!42';
// PNG 1x1 (le robot photographie l'image de la captcha pour le bandeau).
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const html = (corps) => ({ status: 200, contentType: 'text/html; charset=utf-8', body: `<!doctype html><html><body>${corps}</body></html>` });
const formulaire = (erreur = '') =>
  html(`${erreur ? `<p class="error">${erreur}</p>` : ''}
    <form method="post" action="/connexion">
      <input type="email" name="user"><input type="password" name="password">
      <img id="captcha-img" alt="captcha" style="width:80px;height:24px" src="data:image/png;base64,${PNG}">
      <input name="captcha"><button type="submit">Connexion</button>
    </form>`);

let browser;
let attendreConnexionManuelle;
let relais;
let navigateurOk = true;

before(async () => {
  ({ attendreConnexionManuelle } = await import('../src/scraper-impots.js'));
  relais = await import('../src/captcha-relais.js');
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

// Faux impots.gouv : accueil -> formulaire ; POST correct (identifiants + captcha BON) ->
// espace pro « mire » ; sinon le formulaire revient VIDE avec un message d'erreur.
async function fauxSite() {
  const context = await browser.newContext();
  const page = await context.newPage();
  const envois = [];
  // Tout le reste (favicon...) : 404 local, jamais le vrai site.
  await context.route(/impots\.gouv\.fr/, (r) => r.fulfill({ status: 404, body: '' }));
  await page.route('https://cfspro.impots.gouv.fr/', (r) => r.fulfill({ status: 302, headers: { location: 'https://idp.impots.gouv.fr/connexion' } }));
  await page.route('https://cfspro.impots.gouv.fr/mire/**', (r) => r.fulfill(html('<h1>Espace professionnel</h1>')));
  await page.route('https://idp.impots.gouv.fr/connexion', (r) => {
    if (r.request().method() !== 'POST') return r.fulfill(formulaire());
    const champs = Object.fromEntries(new URLSearchParams(r.request().postData() || ''));
    envois.push(champs);
    if (champs.user === LOGIN && champs.password === PWD && champs.captcha === 'BON')
      // Renvoi par la page (une redirection HTTP apres un POST echappe a l'interception
      // de Playwright et partirait vers le vrai site).
      return r.fulfill(html(`<script>location.href = 'https://cfspro.impots.gouv.fr/mire/accueil.do'</script>`));
    return r.fulfill(formulaire('Le code de sécurité est incorrect.'));
  });
  return { context, page, envois };
}

async function attendre(condition, ms = 10000) {
  const fin = Date.now() + ms;
  while (Date.now() < fin) {
    if (await condition()) return true;
    await new Promise((ok) => setTimeout(ok, 100));
  }
  return false;
}
const valeurs = async (page) => ({
  user: await page.locator('input[name="user"]').inputValue(),
  password: await page.locator('input[name="password"]').inputValue(),
});

test('captcha refusée dans le bandeau : identifiants remis, le second essai se connecte', async (t) => {
  if (!navigateurOk) return t.skip('Chromium indisponible');
  const { context, page, envois } = await fauxSite();
  try {
    const connexion = attendreConnexionManuelle(page, { login: LOGIN, password: PWD }, () => {});
    assert.ok(await attendre(() => relais.etat().actif), 'captcha publiée dans le bandeau');

    const refus = await relais.soumettre('FAUX');
    assert.equal(refus.refuse, true);
    assert.deepEqual(await valeurs(page), { user: LOGIN, password: PWD }, 'formulaire re-rempli après le refus');

    const ok = await relais.soumettre('BON');
    assert.equal(ok.connecte, true);
    await connexion;
    assert.equal(envois.length, 2);
    assert.deepEqual(envois[1], { user: LOGIN, password: PWD, captcha: 'BON' }, 'second envoi complet');
    assert.equal(relais.etat().actif, false, 'bandeau fermé après connexion');
  } finally {
    relais.fermer();
    await context.close();
  }
});

test('captcha refusée saisie dans le navigateur (noVNC) : identifiants remis au rechargement', async (t) => {
  if (!navigateurOk) return t.skip('Chromium indisponible');
  const { context, page, envois } = await fauxSite();
  try {
    const journal = [];
    const connexion = attendreConnexionManuelle(page, { login: LOGIN, password: PWD }, (m) => journal.push(m));
    assert.ok(await attendre(() => relais.etat().actif));

    // L'utilisateur tape une mauvaise captcha directement dans la page.
    await page.locator('input[name="captcha"]').fill('FAUX');
    await Promise.all([page.waitForEvent('load'), page.locator('button[type="submit"]').click()]);
    assert.ok(await attendre(async () => (await valeurs(page)).password === PWD), 'mot de passe re-rempli après le rechargement');
    assert.equal((await valeurs(page)).user, LOGIN);
    assert.ok(
      journal.some((m) => /pre-remplis a nouveau/.test(m)),
      journal.join(' | '),
    );

    await page.locator('input[name="captcha"]').fill('BON');
    await page.locator('button[type="submit"]').click();
    await connexion;
    assert.deepEqual(envois.at(-1), { user: LOGIN, password: PWD, captcha: 'BON' });
  } finally {
    relais.fermer();
    await context.close();
  }
});
