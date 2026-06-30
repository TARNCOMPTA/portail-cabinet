// Connecteur Playwright de l'espace personnel CARMF (extranet.carmf.fr).
// Connexion PAR CLIENT (identifiant CARMF + mot de passe). Pas de captcha.
// Formulaire : #AdherentIdentweb + #AdherentPassword (form #AdherentConnecterForm).
//
// NB : le parcours de telechargement des documents sera affine apres exploration
// d'un compte reel (un diagnostic de la zone connectee est enregistre a chaque run).

import { chromium } from 'playwright';
import { mkdirSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { addDocument, addRun } from './carmf-db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DOWNLOADS_DIR = resolve(__dirname, '..', 'downloads', 'carmf');
const LOGIN_URL = process.env.CARMF_LOGIN_URL || 'https://extranet.carmf.fr/adherents/connecter';

function sanitize(name) { return String(name).replace(/[^\w.\- ]+/g, '_').replace(/\s+/g, '_').trim().slice(0, 120); }
function addRunSafe(clientId, run) { try { addRun(clientId, run); } catch (e) { console.warn(`(historique CARMF ${clientId}: ${e.message})`); } }
function launchArgs() { return process.platform === 'linux' ? ['--no-sandbox', '--disable-dev-shm-usage'] : []; }

/**
 * Recupere les documents PDF d'un client CARMF (espace adherent).
 * @param {{id:number, nom:string, login:string, password:string, dossier?:string}} client
 * @param {{onLog?:(m:string)=>void, baseFolder?:string}} [opts]
 */
export async function scrapeClient(client, opts = {}) {
  const log = (m) => { const line = `[${client.nom}] ${m}`; console.log(line); opts.onLog?.(line); };
  const headless = String(process.env.HEADLESS ?? 'false').toLowerCase() === 'true';
  const navTimeout = Number(process.env.NAV_TIMEOUT ?? 45000);

  let clientDir;
  if (client.dossier && client.dossier.trim()) clientDir = client.dossier.trim();
  else if (opts.baseFolder && opts.baseFolder.trim()) clientDir = resolve(opts.baseFolder.trim(), sanitize(client.nom));
  else clientDir = resolve(DOWNLOADS_DIR, sanitize(`${client.id}_${client.nom}`));
  mkdirSync(clientDir, { recursive: true });

  const browser = await chromium.launch({ headless, args: launchArgs() });
  const context = await browser.newContext({ acceptDownloads: true, locale: 'fr-FR' });
  const page = await context.newPage();
  page.setDefaultTimeout(navTimeout);

  const docs = [];
  let dejaPresents = 0;
  try {
    // ---- 1. Connexion ----
    log('Ouverture de la page de connexion CARMF');
    await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded' });
    const notice = page.locator('button:has-text("J\'ai compris"), button:has-text("Accepter")').first();
    if (await notice.isVisible().catch(() => false)) await notice.click().catch(() => {});

    if (!client.password) { const e = new Error('Mot de passe vide pour ce client — re-saisis-le.'); e.kind = 'mdp'; throw e; }
    log('Saisie de l\'identifiant et du mot de passe');
    const champU = page.locator('#AdherentIdentweb').first();
    const champP = page.locator('#AdherentPassword').first();
    await champU.waitFor({ state: 'visible', timeout: navTimeout });
    await champU.click().catch(() => {});
    await champU.fill(client.login).catch(() => {});
    await champP.click().catch(() => {});
    await champP.fill(client.password).catch(() => {});
    if (!((await champP.inputValue().catch(() => '')) || '').length) {
      await champP.click().catch(() => {});
      await champP.pressSequentially(client.password, { delay: 25 }).catch(() => {});
    }
    await Promise.all([
      page.waitForLoadState('domcontentloaded').catch(() => {}),
      page.locator('#AdherentConnecterForm input[type="submit"], #AdherentConnecterForm button[type="submit"], input[type="submit"]').first().click().catch(() => {}),
    ]);
    await page.waitForLoadState('networkidle').catch(() => {});
    await page.waitForTimeout(1500);

    if (/\/adherents\/connecter/i.test(page.url())) {
      const err = await page.locator('.message, .error, .alert, .flash, [class*="erreur"], [class*="error"]').first().innerText().catch(() => '');
      const e = new Error('Connexion refusée' + (err ? ` : ${err.replace(/\s+/g, ' ').slice(0, 160)}` : ' (identifiants incorrects ?)'));
      e.kind = 'mdp';
      throw e;
    }
    log('Connecté à l\'espace CARMF.');

    // ---- 2. Diagnostic de la zone connectee (pour finaliser la recup de documents) ----
    try {
      const diag = await page.evaluate(() => ({
        url: location.href,
        menus: [...document.querySelectorAll('a')].filter((a) => a.offsetParent && /document|attestation|relev|cotisation|courrier|paiement|fiscal|justificatif/i.test(`${a.textContent || ''} ${a.getAttribute('href') || ''}`)).map((a) => ({ t: (a.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 40), href: (a.getAttribute('href') || '').slice(0, 130) })).slice(0, 40),
        pdfLinks: [...document.querySelectorAll('a[href*=".pdf"], a[href*="ocument"], a[href*="ownload"], a[href*="telecharg"]')].map((a) => ({ t: (a.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 40), href: (a.href || '').slice(0, 150) })).slice(0, 40),
      }));
      writeFileSync(resolve(clientDir, '_diag_carmf.json'), JSON.stringify(diag, null, 2), 'utf8');
      log(`Diag zone connectée : ${JSON.stringify(diag).slice(0, 400)}`);
    } catch (e) { log(`(diagnostic : ${e.message})`); }
    await page.screenshot({ path: resolve(clientDir, `_apres_connexion_${Date.now()}.png`), fullPage: true }).catch(() => {});

    // ---- 3. Telechargement generique des PDF presents (a affiner) ----
    const liens = await page.evaluate(() =>
      [...document.querySelectorAll('a')]
        .filter((a) => /\.pdf($|\?)|telecharg|\/document/i.test(a.href || ''))
        .map((a) => ({ href: a.href, nom: (a.textContent || '').replace(/\s+/g, ' ').trim() })));
    const utilises = new Set();
    for (const l of liens) {
      if (!l.href) continue;
      try {
        const base = sanitize(l.nom || 'document') || 'document';
        let dest = resolve(clientDir, `${base}.pdf`);
        if (utilises.has(dest.toLowerCase())) { let i = 2; do { dest = resolve(clientDir, `${base} (${i++}).pdf`); } while (utilises.has(dest.toLowerCase()) && i < 100); }
        utilises.add(dest.toLowerCase());
        if (existsSync(dest) && statSync(dest).size > 100) { addDocument(client.id, { libelle: l.nom, fichier: dest }); dejaPresents++; continue; }
        const resp = await context.request.get(l.href, { timeout: navTimeout });
        if (!resp.ok()) continue;
        const buf = await resp.body();
        if (buf.length < 100 || buf.subarray(0, 4).toString() !== '%PDF') continue;
        writeFileSync(dest, buf);
        addDocument(client.id, { libelle: l.nom || base, fichier: dest });
        docs.push({ libelle: l.nom, fichier: dest });
        log(`OK : ${dest.split(/[\\/]/).pop()} (${Math.round(buf.length / 1024)} Ko)`);
      } catch (e) { log(`Échec doc : ${e.message.split('\n')[0]}`); }
    }

    addRunSafe(client.id, { statut: 'succes', message: `${docs.length} document(s) PDF récupéré(s)` + (dejaPresents ? `, ${dejaPresents} déjà présent(s)` : '') + ' (parcours documents à finaliser)', nb_docs: docs.length });
    log(`Terminé : ${docs.length} nouveau(x), ${dejaPresents} déjà présent(s). (diagnostic enregistré pour finaliser le parcours)`);
    return { ok: true, docs, dejaPresents };
  } catch (err) {
    await page.screenshot({ path: resolve(clientDir, `_debug_${Date.now()}.png`), fullPage: true }).catch(() => {});
    addRunSafe(client.id, { statut: err.kind === 'mdp' ? 'echec_mdp' : 'echec', message: err.message, nb_docs: docs.length });
    log(`ERREUR : ${err.message}`);
    return { ok: false, error: err.message, docs };
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}
