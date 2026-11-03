// Connexion CARPIMKO (src/scraper-carpimko.js, connecterCarpimko). Fin octobre 2026, le
// site a retire le choix « Affilie » (radio TypeUtilisateur) : le formulaire n'a plus
// que numero de dossier + mot de passe, et le robot attendait ce radio jusqu'au timeout
// (tous les clients en echec). Les URL CARPIMKO sont INTERCEPTEES (page.route) : aucun
// acces au vrai site. Chromium headless (skip si indisponible).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

const exe = () => (process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const CLIENT = { id: 1, nom: 'ZZTEST CARPIMKO', login: '1234567', password: 'Secret!42' };
const html = (corps) => ({ status: 200, contentType: 'text/html; charset=utf-8', body: `<!doctype html><html><body>${corps}</body></html>` });
// Formulaire releve sur le vrai site (03/11/2026), avec le bouton FranceConnect a cote.
const formulaire = ({ radio = false, erreur = '' } = {}) =>
  html(`${erreur ? `<div class="validation-summary-errors">${erreur}</div>` : ''}
    <form id="connexionForm" method="post" action="/Comptes/Connexion">
      ${radio ? '<input type="radio" id="ta" name="TypeUtilisateur" value="Affilie"><label for="ta">Affilié</label><input type="radio" id="tb" name="TypeUtilisateur" value="Autre"><label for="tb">Autre</label>' : ''}
      <label for="Login">Numéro de dossier</label><input class="form-control" type="text" id="Login" name="Login" value="">
      <label for="MotDePasse">Mot de passe</label><input type="password" class="form-control" id="MotDePasse" name="MotDePasse">
      <button type="submit">Se connecter</button>
    </form>
    <form method="post" action="/Comptes/FranceConnectConnexion"><button id="FranceConnectBtn" type="submit">FranceConnect</button></form>`);

let browser;
let connecterCarpimko;
let navigateurOk = true;
let tmp;

before(async () => {
  ({ connecterCarpimko } = await import('../src/scraper-carpimko.js'));
  tmp = mkdtempSync(resolve(tmpdir(), 'carpimko-'));
  try {
    const { chromium } = await import('playwright');
    browser = await chromium.launch({ headless: true, ...exe() });
  } catch {
    navigateurOk = false;
  }
});
after(async () => {
  await browser?.close();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

// Faux site : GET -> formulaire ; POST correct -> accueil de l'espace adherent (renvoi par
// la page : une redirection HTTP apres POST echapperait a l'interception) ; sinon refus.
async function fauxSite(opts) {
  const context = await browser.newContext();
  const page = await context.newPage();
  page.setDefaultTimeout(5000); // un champ attendu a tort echoue vite
  const envois = [];
  await page.route(/carpimko\.com/, (r) => {
    const u = new URL(r.request().url());
    if (u.pathname === '/Comptes/Connexion' && r.request().method() === 'POST') {
      const champs = Object.fromEntries(new URLSearchParams(r.request().postData() || ''));
      envois.push(champs);
      if (champs.Login === CLIENT.login && champs.MotDePasse === CLIENT.password)
        return r.fulfill(html(`<script>location.href = 'https://www2.carpimko.com/migration/Accueil'</script>`));
      return r.fulfill(formulaire({ ...opts, erreur: 'Numéro de dossier ou mot de passe incorrect.' }));
    }
    if (u.pathname === '/Comptes/Connexion') return r.fulfill(formulaire(opts));
    if (u.pathname === '/migration/Accueil') return r.fulfill(html('<h1>Mon espace</h1>'));
    return r.fulfill({ status: 404, body: '' });
  });
  return { context, page, envois };
}
const connecter = (page, client, journal) => connecterCarpimko(page, client, { navTimeout: 5000, headless: true, clientDir: tmp, log: (m) => journal.push(m) });

test('nouveau formulaire (sans choix « Affilié ») : connexion réussie', async (t) => {
  if (!navigateurOk) return t.skip('Chromium indisponible');
  const { context, page, envois } = await fauxSite({ radio: false });
  try {
    const journal = [];
    await connecter(page, CLIENT, journal);
    assert.ok(journal.includes('Connecte.'), journal.join(' | '));
    assert.equal(envois.length, 1);
    assert.equal(envois[0].Login, CLIENT.login);
    assert.equal(envois[0].MotDePasse, CLIENT.password);
  } finally {
    await context.close();
  }
});

test('ancien formulaire (avec choix « Affilié ») : toujours coché puis connexion', async (t) => {
  if (!navigateurOk) return t.skip('Chromium indisponible');
  const { context, page, envois } = await fauxSite({ radio: true });
  try {
    const journal = [];
    await connecter(page, CLIENT, journal);
    assert.ok(journal.includes('Connecte.'));
    assert.equal(envois[0].TypeUtilisateur, 'Affilie');
  } finally {
    await context.close();
  }
});

test('refus affiché par le site : erreur « mot de passe » (verrou anti-blocage)', async (t) => {
  if (!navigateurOk) return t.skip('Chromium indisponible');
  const { context, page } = await fauxSite({ radio: false });
  try {
    await assert.rejects(connecter(page, { ...CLIENT, password: 'faux' }, []), (e) => e.kind === 'mdp' && /incorrect/.test(e.message));
  } finally {
    await context.close();
  }
});
