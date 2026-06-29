// Connecteur Playwright de l'espace personnel CARPIMKO (espace "Affilie").
// Connexion PAR CLIENT (n° dossier 7 chiffres + mot de passe). Pas de captcha ;
// une eventuelle verification email/SMS se saisit via la vue noVNC (navigateur visible).
//
// Parcours verifie le 10/06/2026 :
//   1. Connexion : https://www2.carpimko.com/Comptes/Connexion (radio Affilie + #Login + #MotDePasse)
//   2. Documents : https://www2.carpimko.com/migration/MesDocuments?tab=docs
//   3. Filtrage des "appels de cotisations" (ou tous), telechargement HTTP authentifie.
// PDF nommes d'apres la DATE du document -> pas de doublon d'un run a l'autre.

import { chromium } from 'playwright';
import { mkdirSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { addDocument, addRun } from './carpimko-db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DOWNLOADS_DIR = resolve(__dirname, '..', 'downloads', 'carpimko');

const LOGIN_URL = process.env.CARPIMKO_LOGIN_URL || 'https://www2.carpimko.com/Comptes/Connexion?ReturnUrl=%2F';
const DOCUMENTS_URL = 'https://www2.carpimko.com/migration/MesDocuments?tab=docs';
const REGEX_APPEL = /appel\s*de\s*cotisation/i;
const TOUS_DOCUMENTS_DEFAUT = String(process.env.TOUS_DOCUMENTS ?? 'false').toLowerCase() === 'true';

function sanitize(name) { return String(name).replace(/[^\w.\- ]+/g, '_').replace(/\s+/g, '_').trim().slice(0, 120); }
function dateIso(fr) { const m = String(fr).match(/(\d{2})\/(\d{2})\/(\d{4})/); return m ? `${m[3]}-${m[2]}-${m[1]}` : 'sans-date'; }
function addRunSafe(clientId, run) { try { addRun(clientId, run); } catch (e) { console.warn(`(historique CARPIMKO ${clientId}: ${e.message})`); } }

async function fermerCookies(page) {
  for (const sel of ['#tarteaucitronAllDenied2', '#tarteaucitronPersonalize2', 'button:has-text("Tout refuser")', 'button:has-text("Tout accepter")']) {
    const b = page.locator(sel).first();
    if (await b.isVisible().catch(() => false)) { await b.click().catch(() => {}); return; }
  }
}

async function extraireDocuments(page) {
  return page.$$eval('table tr', (rows) =>
    rows.map((tr) => {
      const dl = tr.querySelector('a[href*="download"]');
      const view = tr.querySelector('a[href*="viewDocument"]');
      if (!dl && !view) return null;
      const cells = [...tr.querySelectorAll('td')].map((td) => td.innerText.trim());
      let fileName = '';
      if (view) { try { fileName = new URL(view.href).searchParams.get('fileName') || ''; } catch { /* ignore */ } }
      return { date: cells[0] || '', nom: cells[1] || (dl ? dl.innerText.trim() : ''), downloadHref: dl ? dl.href : view ? view.href : '', fileName };
    }).filter(Boolean)
  );
}

// Sur serveur Linux (Docker, root), Chromium exige --no-sandbox ; --disable-dev-shm-usage
// evite les plantages lies a la petite taille de /dev/shm en conteneur.
function launchArgs() { return process.platform === 'linux' ? ['--no-sandbox', '--disable-dev-shm-usage'] : []; }

/**
 * Recupere les documents (appels de cotisations par defaut) d'un client.
 * @param {{id:number, nom:string, login:string, password:string, dossier?:string}} client
 * @param {{onLog?:(m:string)=>void, tousDocuments?:boolean, baseFolder?:string}} [opts]
 */
export async function scrapeClient(client, opts = {}) {
  const log = (m) => { const line = `[${client.nom}] ${m}`; console.log(line); opts.onLog?.(line); };
  // Navigateur VISIBLE par defaut (sur serveur : ecran :99 -> noVNC pour une verif email/SMS).
  const headless = String(process.env.HEADLESS ?? 'false').toLowerCase() === 'true';
  const navTimeout = Number(process.env.NAV_TIMEOUT ?? 45000);
  const tousDocuments = opts.tousDocuments ?? TOUS_DOCUMENTS_DEFAUT;

  let clientDir;
  if (client.dossier && client.dossier.trim()) clientDir = client.dossier.trim();
  else if (opts.baseFolder && opts.baseFolder.trim()) clientDir = resolve(opts.baseFolder.trim(), sanitize(client.nom));
  else clientDir = resolve(DOWNLOADS_DIR, sanitize(`${client.id}_${client.nom}`));
  mkdirSync(clientDir, { recursive: true });
  log(`Destination : ${clientDir}`);

  const browser = await chromium.launch({ headless, args: launchArgs() });
  const context = await browser.newContext({ acceptDownloads: true, locale: 'fr-FR' });
  const page = await context.newPage();
  page.setDefaultTimeout(navTimeout);

  const docsRecuperes = [];
  let dejaPresents = 0;
  try {
    log('Ouverture de la page de connexion');
    await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded' });
    await fermerCookies(page);

    const radioAffilie = page.locator('input[name="TypeUtilisateur"]').first();
    await radioAffilie.waitFor({ state: 'visible' });
    await radioAffilie.check().catch(async () => {
      const id = await radioAffilie.getAttribute('id');
      if (id) await page.locator(`label[for="${id}"]`).click();
    });

    log('Saisie du numero de dossier et du mot de passe');
    await page.locator('#Login').fill(client.login);
    await page.locator('#MotDePasse').fill(client.password);
    await Promise.all([page.waitForLoadState('domcontentloaded'), page.locator('#connexionForm button[type="submit"]').click()]);
    await page.waitForTimeout(2000);

    if (/Comptes\/Connexion/i.test(page.url())) {
      const erreur = await page.locator('.validation-summary-errors, .field-validation-error, .alert-danger').first().innerText().catch(() => '');
      const detail = erreur ? erreur.trim().replace(/\s+/g, ' ') : '(identifiants incorrects ?)';
      const e = new Error(`Connexion refusee : ${detail}`);
      e.kind = 'mdp'; // -> verrou anti-blocage de compte
      throw e;
    }
    log('Connecte.');
    if (!headless) await page.waitForTimeout(1500); // laisser la main pour une verif email/SMS eventuelle

    log('Ouverture de « Mes documents & attestations »');
    await page.goto(DOCUMENTS_URL, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2500);

    const tous = [];
    const vus = new Set();
    for (let p = 0; p < 30; p++) {
      const lot = await extraireDocuments(page);
      for (const d of lot) { const cle = d.fileName || `${d.date}|${d.nom}`; if (!vus.has(cle)) { vus.add(cle); tous.push(d); } }
      const suivant = page.locator('a[aria-label="Next"], a:has-text("›"), li:not(.disabled) > a[rel="next"]').first();
      if (await suivant.isVisible().catch(() => false)) {
        const avant = page.url() + (await page.locator('table').first().innerText().catch(() => ''));
        await suivant.click().catch(() => {});
        await page.waitForTimeout(1500);
        const apres = page.url() + (await page.locator('table').first().innerText().catch(() => ''));
        if (avant === apres) break;
      } else break;
    }
    log(`${tous.length} document(s) liste(s) au total.`);

    const cibles = tousDocuments ? tous : tous.filter((d) => REGEX_APPEL.test(d.nom) || REGEX_APPEL.test(d.fileName.replace(/_/g, ' ')));
    if (cibles.length === 0) {
      log(tousDocuments ? 'Aucun document trouve.' : 'Aucun appel de cotisations trouve.');
      await page.screenshot({ path: resolve(clientDir, `_page_documents_${Date.now()}.png`), fullPage: true }).catch(() => {});
    } else {
      const motDoc = tousDocuments ? 'document(s)' : 'appel(s) de cotisations';
      log(`${cibles.length} ${motDoc} detecte(s).`);
      for (const d of cibles) {
        if (!d.downloadHref) continue;
        const base = `${dateIso(d.date)}_${sanitize(d.nom || 'document')}`;
        const dest = resolve(clientDir, `${base}.pdf`);
        if (existsSync(dest) && statSync(dest).size > 100) {
          addDocument(client.id, { libelle: `${d.date} — ${d.nom}`, fichier: dest, date_doc: dateIso(d.date) });
          dejaPresents++;
          continue;
        }
        try {
          const resp = await context.request.get(d.downloadHref, { timeout: navTimeout });
          if (!resp.ok()) throw new Error(`HTTP ${resp.status()}`);
          const buf = await resp.body();
          if (buf.length < 100 || buf.subarray(0, 4).toString() !== '%PDF') throw new Error('reponse non-PDF (lien expire ou page HTML)');
          writeFileSync(dest, buf);
          addDocument(client.id, { libelle: `${d.date} — ${d.nom}`, fichier: dest, date_doc: dateIso(d.date) });
          docsRecuperes.push({ libelle: d.nom, fichier: dest });
          log(`OK : ${base}.pdf (${Math.round(buf.length / 1024)} Ko)`);
        } catch (e) { log(`Echec "${d.nom}" (${d.date}) : ${e.message}`); }
      }
    }

    const motBilan = tousDocuments ? 'document(s)' : 'appel(s) de cotisations';
    const bilan = `${docsRecuperes.length} nouveau(x) ${motBilan} telecharge(s)` +
      (dejaPresents > 0 ? `, ${dejaPresents} deja present(s) (ignore(s))` : '') + ` — ${cibles.length} detecte(s)`;
    addRunSafe(client.id, {
      statut: docsRecuperes.length + dejaPresents > 0 || cibles.length === 0 ? 'succes' : 'echec',
      message: bilan, nb_docs: docsRecuperes.length,
    });
    log(`Termine : ${bilan}.`);
    return { ok: true, docs: docsRecuperes, dejaPresents };
  } catch (err) {
    const shot = resolve(clientDir, `_debug_${Date.now()}.png`);
    await page.screenshot({ path: shot, fullPage: true }).catch(() => {});
    addRunSafe(client.id, { statut: err.kind === 'mdp' ? 'echec_mdp' : 'echec', message: err.message, nb_docs: docsRecuperes.length });
    log(`ERREUR : ${err.message} (capture : ${shot})`);
    return { ok: false, error: err.message, docs: docsRecuperes };
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}
