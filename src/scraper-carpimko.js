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
import { addDocument, addRun, listDocuments } from './carpimko-db.js';
import { launchArgs } from './navigateur.js';
import { sanitize, dateIso } from './scraper-commun.js';
import { verifierEtClasser } from './validation-pdf.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DOWNLOADS_DIR = resolve(__dirname, '..', 'downloads', 'carpimko');

const LOGIN_URL = process.env.CARPIMKO_LOGIN_URL || 'https://www2.carpimko.com/Comptes/Connexion?ReturnUrl=%2F';
const DOCUMENTS_URL = 'https://www2.carpimko.com/migration/MesDocuments?tab=docs';
const REGEX_APPEL = /appel\s*de\s*cotisation/i;
const TOUS_DOCUMENTS_DEFAUT = String(process.env.TOUS_DOCUMENTS ?? 'false').toLowerCase() === 'true';

function addRunSafe(clientId, run) {
  try {
    addRun(clientId, run);
  } catch (e) {
    console.warn(`(historique CARPIMKO ${clientId}: ${e.message})`);
  }
}

async function fermerCookies(page) {
  for (const sel of ['#tarteaucitronAllDenied2', '#tarteaucitronPersonalize2', 'button:has-text("Tout refuser")', 'button:has-text("Tout accepter")']) {
    const b = page.locator(sel).first();
    if (await b.isVisible().catch(() => false)) {
      await b.click().catch(() => {});
      return;
    }
  }
}

async function extraireDocuments(page) {
  return page.$$eval('table tr', (rows) =>
    rows
      .map((tr) => {
        const dl = tr.querySelector('a[href*="download"]');
        const view = tr.querySelector('a[href*="viewDocument"]');
        if (!dl && !view) return null;
        const cells = [...tr.querySelectorAll('td')].map((td) => td.innerText.trim());
        let fileName = '';
        if (view) {
          try {
            fileName = new URL(view.href).searchParams.get('fileName') || '';
          } catch {
            /* ignore */
          }
        }
        return { date: cells[0] || '', nom: cells[1] || (dl ? dl.innerText.trim() : ''), downloadHref: dl ? dl.href : view ? view.href : '', fileName };
      })
      .filter(Boolean),
  );
}

/**
 * Recupere les documents (appels de cotisations par defaut) d'un client.
 * @param {{id:number, nom:string, login:string, password:string, dossier?:string}} client
 * @param {{onLog?:(m:string)=>void, tousDocuments?:boolean, baseFolder?:string}} [opts]
 */
export async function scrapeClient(client, opts = {}) {
  const log = (m) => {
    const line = `[${client.nom}] ${m}`;
    console.log(line);
    opts.onLog?.(line);
  };
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
  const quarantaines = [];
  let nonVerifiables = 0;
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

    if (!client.password) {
      const e = new Error('Mot de passe vide pour ce client — re-saisis-le.');
      e.kind = 'mdp';
      throw e;
    }
    log('Saisie du numero de dossier et du mot de passe');
    const champUser = page.locator('#Login').first();
    const champPwd = page.locator('#MotDePasse').first();
    await champUser.waitFor({ state: 'visible', timeout: navTimeout });
    await champUser.click().catch(() => {});
    await champUser.fill(client.login).catch(() => {});
    await champPwd.waitFor({ state: 'visible', timeout: navTimeout });
    // Diagnostic : structure reelle du champ mot de passe (pour comprendre pourquoi il ne se remplit pas).
    try {
      const diag = await page.evaluate(() => {
        const f = document.querySelector('#MotDePasse');
        const cand = [...document.querySelectorAll('input[type="password"]')];
        return {
          nbMotDePasse: document.querySelectorAll('#MotDePasse').length,
          nbInputsPassword: cand.length,
          iframes: document.querySelectorAll('iframe').length,
          motDePasse: f
            ? { type: f.type, name: f.name, disabled: f.disabled, readOnly: f.readOnly, visible: !!f.offsetParent, outer: f.outerHTML.slice(0, 250) }
            : null,
          inputsPassword: cand.slice(0, 4).map((e) => ({ id: e.id, name: e.name, disabled: e.disabled, readOnly: e.readOnly, visible: !!e.offsetParent })),
        };
      });
      writeFileSync(resolve(clientDir, '_diag_mdp.json'), JSON.stringify(diag, null, 2), 'utf8');
      log(`Diag champ mdp : ${JSON.stringify(diag).slice(0, 500)}`);
    } catch (e) {
      log(`(diag champ mdp : ${e.message})`);
    }
    // Remplissage robuste, avec verification : 1) fill, 2) frappe clavier, 3) injection JS.
    const pwdRempli = async () => ((await champPwd.inputValue().catch(() => '')) || '').length > 0;
    await champPwd.click().catch(() => {});
    await champPwd.fill(client.password).catch(() => {});
    if (!(await pwdRempli())) {
      await champPwd.click().catch(() => {});
      await champPwd.pressSequentially(client.password, { delay: 30 }).catch(() => {});
    }
    if (!(await pwdRempli())) {
      await champPwd
        .evaluate((el, val) => {
          el.value = val;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }, client.password)
        .catch(() => {});
    }
    // Capture AVANT envoi (diagnostic : montre si le mot de passe est bien saisi).
    try {
      await page.screenshot({ path: resolve(clientDir, `_avant_envoi_${Date.now()}.png`), fullPage: true });
    } catch {
      /* ignore */
    }
    // Securite anti-blocage : si le champ est toujours vide, on N'ENVOIE PAS
    // (eviter de consommer une tentative CARPIMKO pour rien).
    if (!(await pwdRempli())) {
      const e = new Error('Impossible de saisir le mot de passe dans le champ CARPIMKO (champ special ?). Envoi annule pour ne pas consommer de tentative.');
      e.kind = 'mdp';
      throw e;
    }
    await Promise.all([page.waitForLoadState('domcontentloaded'), page.locator('#connexionForm button[type="submit"]').click()]);
    await page.waitForTimeout(2000);

    if (/Comptes\/Connexion/i.test(page.url())) {
      const erreur = await page
        .locator('.validation-summary-errors, .field-validation-error, .alert-danger')
        .first()
        .innerText()
        .catch(() => '');
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
      for (const d of lot) {
        const cle = d.fileName || d.downloadHref || `${d.date}|${d.nom}`;
        if (!vus.has(cle)) {
          vus.add(cle);
          tous.push(d);
        }
      }
      const suivant = page.locator('a[aria-label="Next"], a:has-text("›"), li:not(.disabled) > a[rel="next"]').first();
      if (await suivant.isVisible().catch(() => false)) {
        const avant =
          page.url() +
          (await page
            .locator('table')
            .first()
            .innerText()
            .catch(() => ''));
        await suivant.click().catch(() => {});
        await page.waitForTimeout(1500);
        const apres =
          page.url() +
          (await page
            .locator('table')
            .first()
            .innerText()
            .catch(() => ''));
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
      // Dedup EN BASE (date du document + libelle) : la CARPIMKO regenere le nom de
      // fichier a chaque visite (APPEL_..._<horodatage>_<adherent>_<aleatoire>.pdf),
      // le fichier sur disque ne suffit donc plus a reconnaitre un document deja pris.
      // Multiset : autorise N documents distincts partageant date + libelle.
      const dejaEnBase = new Map();
      for (const doc of listDocuments(client.id)) {
        const k = `${doc.date_doc || ''}|${doc.libelle || ''}`;
        dejaEnBase.set(k, (dejaEnBase.get(k) || 0) + 1);
      }
      const utilises = new Set();
      for (const d of cibles) {
        if (!d.downloadHref) continue;
        const cle = `${dateIso(d.date, 'sans-date')}|${d.date} — ${d.nom}`;
        const enBase = dejaEnBase.get(cle) || 0;
        if (enBase > 0) {
          dejaEnBase.set(cle, enBase - 1);
          dejaPresents++;
          continue;
        }
        // Nom : prefere le vrai nom de fichier du document, SANS son suffixe de
        // generation volatil (horodatage + n° adherent + aleatoire) ; sinon date + libelle.
        const nomDoc = (d.fileName ? d.fileName.replace(/\.[a-z0-9]+$/i, '') : d.nom || 'document').replace(/_\d{8}_\d{6}_\d+_[0-9a-f]{4,}$/i, '');
        const baseNom = `${dateIso(d.date, 'sans-date')}_${sanitize(nomDoc)}`;
        let dest = resolve(clientDir, `${baseNom}.pdf`);
        // Collision dans CE run (2 documents distincts -> meme nom) : on suffixe (2), (3)...
        if (utilises.has(dest.toLowerCase())) {
          let i = 2;
          do {
            dest = resolve(clientDir, `${baseNom} (${i++}).pdf`);
          } while (utilises.has(dest.toLowerCase()) && i < 100);
        }
        utilises.add(dest.toLowerCase());
        // Deja telecharge lors d'un run precedent (fichier present sur le disque).
        if (existsSync(dest) && statSync(dest).size > 100) {
          addDocument(client.id, { libelle: `${d.date} — ${d.nom}`, fichier: dest, date_doc: dateIso(d.date, 'sans-date') });
          dejaPresents++;
          continue;
        }
        try {
          const resp = await context.request.get(d.downloadHref, { timeout: navTimeout });
          if (!resp.ok()) throw new Error(`HTTP ${resp.status()}`);
          const buf = await resp.body();
          if (buf.length < 100 || buf.subarray(0, 4).toString() !== '%PDF') throw new Error('reponse non-PDF (lien expire ou page HTML)');
          writeFileSync(dest, buf);
          // Vérification d'appartenance : le PDF doit mentionner le n° d'adhérent ou le nom.
          const verif = await verifierEtClasser({ fichier: dest, source: 'carpimko', client });
          if (verif.verdict === 'quarantaine') {
            quarantaines.push(verif.raison);
            log(`⚠️ QUARANTAINE : ${verif.raison}`);
            continue; // pas d'addDocument -> retéléchargé et revérifié au prochain run
          }
          if (verif.verdict === 'non_verifiable') nonVerifiables++;
          addDocument(client.id, { libelle: `${d.date} — ${d.nom}`, fichier: dest, date_doc: dateIso(d.date, 'sans-date') });
          docsRecuperes.push({ libelle: d.nom, fichier: dest });
          log(`OK : ${dest.split(/[\\/]/).pop()} (${Math.round(buf.length / 1024)} Ko)`);
        } catch (e) {
          log(`Echec "${d.nom}" (${d.date}) : ${e.message}`);
        }
      }
    }

    const motBilan = tousDocuments ? 'document(s)' : 'appel(s) de cotisations';
    let bilan =
      `${docsRecuperes.length} nouveau(x) ${motBilan} telecharge(s)` +
      (dejaPresents > 0 ? `, ${dejaPresents} deja present(s) (ignore(s))` : '') +
      ` — ${cibles.length} detecte(s)`;
    if (nonVerifiables > 0) bilan += ` (${nonVerifiables} non verifiable(s) : PDF sans texte)`;
    if (quarantaines.length > 0) bilan = `⚠️ ${quarantaines.length} PDF mis en quarantaine — ${quarantaines.join(' ; ').slice(0, 300)}. ${bilan}`;
    addRunSafe(client.id, {
      statut: quarantaines.length > 0 ? 'echec' : docsRecuperes.length + dejaPresents > 0 || cibles.length === 0 ? 'succes' : 'echec',
      message: bilan,
      nb_docs: docsRecuperes.length,
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
