// Connecteur Playwright de l'espace adherent CARCDSF (adherents.carcdsf.fr).
// Connexion PAR CLIENT (identifiant adherent + mot de passe), distincte selon la
// PROFESSION : chirurgien-dentiste ('cd', .../carcdsf-cd) ou sage-femme ('sf',
// .../carcdsf-sf). Application type servlet « XAS » (rendu cote client).
//
// ETAT : squelette. La connexion est tentee de facon generique et un DIAGNOSTIC de la
// zone connectee (_diag_carcdsf.json + capture) est enregistre a chaque run, pour
// finaliser ensuite les chemins exacts (connexion + telechargement) apres exploration
// d'un compte reel de chaque profession. Tant que ce n'est pas finalise, la recuperation
// des documents renvoie 0 (et le diagnostic).

import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { addRun } from './carcdsf-db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DOWNLOADS_DIR = resolve(__dirname, '..', 'downloads', 'carcdsf');

// Points d'entree par profession (espaces distincts).
const LOGIN_URLS = {
  cd: process.env.CARCDSF_CD_URL || 'https://adherents.carcdsf.fr/carcdsf-cd',
  sf: process.env.CARCDSF_SF_URL || 'https://adherents.carcdsf.fr/carcdsf-sf',
};

function sanitize(name) { return String(name).replace(/[^\w.\- ]+/g, '_').replace(/\s+/g, '_').trim().slice(0, 120); }
function addRunSafe(clientId, run) { try { addRun(clientId, run); } catch (e) { console.warn(`(historique CARCDSF ${clientId}: ${e.message})`); } }
function launchArgs() { return process.platform === 'linux' ? ['--no-sandbox', '--disable-dev-shm-usage'] : []; }

/**
 * Recupere les documents d'un client CARCDSF (espace adherent).
 * @param {{id:number, nom:string, profession:'cd'|'sf', login:string, password:string, dossier?:string}} client
 * @param {{onLog?:(m:string)=>void, baseFolder?:string}} [opts]
 */
export async function scrapeClient(client, opts = {}) {
  const log = (m) => { const line = `[${client.nom}] ${m}`; console.log(line); opts.onLog?.(line); };
  const headless = String(process.env.HEADLESS ?? 'false').toLowerCase() === 'true';
  const navTimeout = Number(process.env.NAV_TIMEOUT ?? 45000);
  const profession = client.profession === 'sf' ? 'sf' : 'cd';
  const loginUrl = LOGIN_URLS[profession];

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
  try {
    // ---- 1. Connexion (generique, a affiner apres exploration) ----
    log(`Ouverture de l'espace CARCDSF (${profession === 'sf' ? 'sage-femme' : 'chirurgien-dentiste'})`);
    await page.goto(loginUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle').catch(() => {});
    const cookie = page.locator('button:has-text("Accepter"), button:has-text("J\'accepte"), #tarteaucitronPersonalize2').first();
    if (await cookie.isVisible().catch(() => false)) await cookie.click().catch(() => {});

    if (!client.password) { const e = new Error('Mot de passe vide pour ce client — re-saisis-le.'); e.kind = 'mdp'; throw e; }
    log('Tentative de saisie identifiant / mot de passe');
    const champU = page.locator('input[type="text"]:visible, input[name*="ogin" i]:visible, input[name*="dent" i]:visible, input[id*="ogin" i]:visible').first();
    const champP = page.locator('input[type="password"]:visible').first();
    if (await champU.isVisible().catch(() => false)) await champU.fill(client.login).catch(() => {});
    if (await champP.isVisible().catch(() => false)) await champP.fill(client.password).catch(() => {});
    await Promise.all([
      page.waitForLoadState('domcontentloaded').catch(() => {}),
      page.locator('button[type="submit"]:visible, input[type="submit"]:visible, button:has-text("Connexion"):visible, button:has-text("Se connecter"):visible').first().click().catch(() => {}),
    ]);
    await page.waitForLoadState('networkidle').catch(() => {});
    await page.waitForTimeout(1500);

    // ---- 2. Diagnostic de la zone connectee (pour finaliser les chemins) ----
    const diag = await page.evaluate(() => ({
      url: location.href,
      titre: document.title,
      inputs: Array.from(document.querySelectorAll('input,select')).slice(0, 40)
        .map((e) => ({ tag: e.tagName, type: e.type, name: e.name, id: e.id })),
      liens: Array.from(document.querySelectorAll('a')).slice(0, 80)
        .map((a) => ({ texte: (a.textContent || '').trim().slice(0, 60), href: a.getAttribute('href') }))
        .filter((l) => l.texte || l.href),
      frames: Array.from(document.querySelectorAll('iframe,frame')).map((f) => f.getAttribute('src')),
    })).catch(() => ({}));
    writeFileSync(resolve(clientDir, '_diag_carcdsf.json'), JSON.stringify(diag, null, 2));
    await page.screenshot({ path: resolve(clientDir, '_diag_carcdsf.png'), fullPage: true }).catch(() => {});
    log(`Zone connectée : ${diag.url || '(inconnue)'} — diagnostic enregistré.`);

    // ---- 3. Telechargement des documents : A FINALISER apres exploration ----
    addRunSafe(client.id, { statut: 'info', message: 'Connexion OK (diagnostic enregistré). Récupération des documents à finaliser après exploration.', nb_docs: 0 });
    log('Récupération des documents non encore implémentée (en attente d\'exploration du parcours).');
    return { ok: true, docs, dejaPresents: 0, diagnostic: true };
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
