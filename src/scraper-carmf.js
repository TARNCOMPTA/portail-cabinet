// Connecteur Playwright de l'espace personnel CARMF (extranet.carmf.fr, CakePHP).
// Connexion PAR CLIENT (identifiant CARMF + mot de passe). Pas de captcha.
// Formulaire : #AdherentIdentweb + #AdherentPassword (form #AdherentConnecterForm).
//
// Documents recuperes :
//   a) attestations / releves : chemins connus, PDF genere a la demande via le mecanisme
//      « jeton » (GET /pdf<chemin> -> jeton opaque -> GET /fichiers/open/<jeton>) ;
//   b) APPELS DE COTISATION (les plus utiles au cabinet) : page /duplicatas/appel_cotisation
//      « Vos derniers appels de cotisations » — acompte de l'annee en cours + solde de
//      l'exercice precedent. Le millesime vient du LIBELLE (« ... (acompte) 2026 »), jamais
//      de la date du jour. Le balisage exact de cette page n'etant pas connu, la detection
//      cumule plusieurs heuristiques et ecrit un diagnostic si elle ne trouve rien.

import { chromium } from 'playwright';
import { mkdirSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { addDocument, addRun, listDocuments } from './carmf-db.js';
import { launchArgs } from './navigateur.js';
import { sanitize } from './scraper-commun.js';
import { verifierEtClasser } from './validation-pdf.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DOWNLOADS_DIR = resolve(__dirname, '..', 'downloads', 'carmf');
// Surchargeable pour les tests locaux (site factice) : CARMF_BASE_URL.
const BASE = process.env.CARMF_BASE_URL || 'https://extranet.carmf.fr';
const LOGIN_URL = process.env.CARMF_LOGIN_URL || `${BASE}/adherents/connecter`;
// Page « Vos derniers appels de cotisations » (duplicatas). Les documents les plus utiles
// au cabinet sont la : appel (acompte) de janvier et appel (solde) apres declaration.
const APPELS_URL = process.env.CARMF_APPELS_URL || `${BASE}/duplicatas/appel_cotisation`;

function addRunSafe(clientId, run) {
  try {
    addRun(clientId, run);
  } catch (e) {
    console.warn(`(historique CARMF ${clientId}: ${e.message})`);
  }
}

// Millesime + type (acompte/solde) depuis le libelle affiche par CARMF, ex.
// « Votre appel de cotisations (acompte) 2026 ». L'annee vient TOUJOURS du libelle :
// en janvier la page liste l'acompte de l'annee en cours ET le solde de l'annee passee,
// donc la date du jour serait un mauvais millesime.
export function analyserLibelleAppel(texte) {
  const t = String(texte || '')
    .replace(/\s+/g, ' ')
    .trim();
  const annee = (t.match(/\b(20\d{2})\b/) || [])[1] || '';
  const m = t.match(/\b(acompte|solde|r[ée]gularisation)\b/i);
  const type = m ? m[1].toLowerCase().replace('é', 'e').replace('è', 'e') : '';
  return { annee, type, libelle: t.slice(0, 150) };
}

// Ecrit un diagnostic (HTML + capture) — appele UNIQUEMENT quand la detection echoue,
// pour ne pas polluer les dossiers clients a chaque run.
async function dumpDiag(page, dir, prefixe) {
  try {
    mkdirSync(dir, { recursive: true });
    await page.screenshot({ path: resolve(dir, `_diag_${prefixe}.png`), fullPage: true }).catch(() => {});
    const html = await page.content().catch(() => '');
    if (html) writeFileSync(resolve(dir, `_diag_${prefixe}.html`), html, 'utf8');
  } catch {
    /* diagnostic best-effort */
  }
}

// Liste les appels de cotisation proposes sur la page duplicatas. Le balisage exact n'est
// pas garanti (espace authentifie) : trois heuristiques HIERARCHISEES, de la plus fiable
// (lien dont le TEXTE parle d'appel de cotisation) a la plus large. Les replis ne servent
// QUE si la premiere ne trouve rien — sinon le bouton « Imprimer » de la page (qui imprime
// la page elle-meme, verifie en session reelle) serait pris pour un appel.
// Cible : { href, chemin, libelle } — href = lien direct, chemin = argument de printPDF
// (mecanisme jeton /pdf<chemin> -> /fichiers/open/<jeton>).
export async function listerAppels(page) {
  return page
    .evaluate(() => {
      const RE_APPEL = /appels?\s+de\s+cotisations?/i; // tolere singulier ET pluriel
      const RE_DL = /sendfile|\/pdf\/|fichiers\/open|\.pdf(\?|$)/i;
      const abs = (h) => {
        try {
          return new URL(h, location.href).href;
        } catch {
          return '';
        }
      };
      // Chemin de la page courante : le bouton « Imprimer » pointe dessus (impression de la
      // page, pas un document) -> a exclure quelle que soit l'heuristique.
      const pageCourante = location.pathname.replace(/\/+$/, '');
      const estPageCourante = (chemin) => {
        const c = String(chemin || '')
          .replace(/^\/pdf/, '')
          .split('?')[0]
          .replace(/\/+$/, '');
        return c !== '' && c === pageCourante;
      };
      const texteDe = (el) => ((el.closest('tr, li') || el).innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
      const cheminPrintPdf = (el) => {
        const src = `${el.getAttribute('onclick') || ''} ${el.getAttribute('href') || ''}`;
        const m = src.match(/printPDF\s*\(\s*['"`]([^'"`]+)['"`]/);
        return m ? m[1] : '';
      };
      const paquets = [[], [], []]; // 0 = libelle parlant, 1 = lien DL, 2 = printPDF quelconque
      const vus = new Set();
      const ajouter = (rang, href, chemin, libelle) => {
        const cle = `${href}|${chemin}`;
        if ((!href && !chemin) || vus.has(cle) || estPageCourante(chemin)) return;
        vus.add(cle);
        paquets[rang].push({ href: href || '', chemin: chemin || '', libelle: libelle || '' });
      };
      // 1. Elements cliquables dont le texte (ou celui de leur ligne) parle d'appel de cotisation.
      for (const el of document.querySelectorAll('a, button, [onclick]')) {
        const txt = texteDe(el);
        const chemin = cheminPrintPdf(el);
        const href = el.getAttribute('href') || '';
        const estDl = href && RE_DL.test(href);
        if (RE_APPEL.test(txt) && (chemin || estDl)) ajouter(0, estDl ? abs(href) : '', chemin, txt);
      }
      // 2. Repli : tout lien de telechargement de la page (sendfile / pdf).
      for (const a of document.querySelectorAll('a[href]')) {
        const href = a.getAttribute('href') || '';
        if (RE_DL.test(href)) ajouter(1, abs(href), '', texteDe(a));
      }
      // 3. Repli : tout printPDF de la page.
      for (const el of document.querySelectorAll('[onclick], a[href^="javascript:"]')) {
        const chemin = cheminPrintPdf(el);
        if (chemin) ajouter(2, '', chemin, texteDe(el));
      }
      // Le premier paquet non vide gagne : pas de melange des niveaux de fiabilite.
      return paquets.find((p) => p.length) || [];
    })
    .catch(() => []);
}

// Telecharge un PDF CARMF. Deux voies : lien direct (context.request partage la session
// du navigateur) ou mecanisme jeton (GET /pdf<chemin> -> jeton opaque -> /fichiers/open/<jeton>).
// Renvoie le buffer PDF valide, ou null (avec la raison) sans jamais lever.
export async function telechargerPdf(context, cible, navTimeout) {
  const lire = async (url) => {
    const r = await context.request.get(url, { timeout: navTimeout });
    if (!r.ok()) return { err: `HTTP ${r.status()}` };
    // CakePHP renvoie volontiers 200 + HTML (session expiree, « document indisponible ») :
    // le magic number est le seul juge fiable.
    const buf = await r.body();
    if (buf.length < 100 || buf.subarray(0, 4).toString() !== '%PDF') return { err: 'reponse non-PDF' };
    return { buf };
  };
  if (cible.href) return lire(cible.href);
  const chemin = cible.chemin.startsWith('/') ? cible.chemin : `/${cible.chemin}`;
  const urlJeton = chemin.startsWith('/pdf') ? BASE + chemin : `${BASE}/pdf${chemin}`;
  const tok = await context.request.get(urlJeton, { timeout: navTimeout });
  if (!tok.ok()) return { err: `jeton HTTP ${tok.status()}` };
  const jeton = (await tok.text()).trim().replace(/^"|"$/g, '');
  if (!jeton || /[<{>]/.test(jeton)) return { err: 'jeton invalide (session expiree ?)' };
  const r = await lire(`${BASE}/fichiers/open/${encodeURIComponent(jeton)}`);
  // Certaines configs Apache refusent un %2F encode dans le chemin : retry avec le jeton brut.
  if (r.err && /HTTP (400|404)/.test(r.err)) return lire(`${BASE}/fichiers/open/${jeton}`);
  return r;
}

/**
 * Recupere les documents PDF d'un client CARMF (espace adherent).
 * @param {{id:number, nom:string, login:string, password:string, dossier?:string}} client
 * @param {{onLog?:(m:string)=>void, baseFolder?:string}} [opts]
 */
export async function scrapeClient(client, opts = {}) {
  const log = (m) => {
    const line = `[${client.nom}] ${m}`;
    console.log(line);
    opts.onLog?.(line);
  };
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
  const quarantaines = [];
  let nonVerifiables = 0;
  try {
    // ---- 1. Connexion ----
    log('Ouverture de la page de connexion CARMF');
    await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded' });
    const notice = page.locator('button:has-text("J\'ai compris"), button:has-text("Accepter")').first();
    if (await notice.isVisible().catch(() => false)) await notice.click().catch(() => {});

    if (!client.password) {
      const e = new Error('Mot de passe vide pour ce client — re-saisis-le.');
      e.kind = 'mdp';
      throw e;
    }
    log("Saisie de l'identifiant et du mot de passe");
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
      page
        .locator('#AdherentConnecterForm input[type="submit"], #AdherentConnecterForm button[type="submit"], input[type="submit"]')
        .first()
        .click()
        .catch(() => {}),
    ]);
    await page.waitForLoadState('networkidle').catch(() => {});
    await page.waitForTimeout(1500);

    if (/\/adherents\/connecter/i.test(page.url())) {
      const err = await page
        .locator('.message, .error, .alert, .flash, [class*="erreur"], [class*="error"]')
        .first()
        .innerText()
        .catch(() => '');
      const e = new Error('Connexion refusée' + (err ? ` : ${err.replace(/\s+/g, ' ').slice(0, 160)}` : ' (identifiants incorrects ?)'));
      e.kind = 'mdp';
      throw e;
    }
    log("Connecté à l'espace CARMF.");

    // ---- 2. Recuperation des documents personnels ----
    // Mecanisme CARMF : printPDF(path) fait GET /pdf<path> -> renvoie un jeton, puis
    // le PDF est servi a /fichiers/open/<jeton>. On reproduit cet enchainement en HTTP.
    const annee = String(new Date().getFullYear()); // attestations : generees a l'instant
    // Dedup EN BASE (millesime + libelle) : un appel deja archive n'est pas repris meme si
    // le lien CARMF (identifiant sendfile) a change entre deux passages.
    const dejaEnBase = new Set();
    try {
      for (const d of listDocuments(client.id)) dejaEnBase.add(`${d.date_doc || ''}|${d.libelle || ''}`);
    } catch {
      /* base neuve */
    }

    // Enregistre un PDF telecharge : verification d'appartenance puis addDocument.
    const enregistrer = async (buf, dest, libelle, dateDoc) => {
      writeFileSync(dest, buf);
      const verif = await verifierEtClasser({ fichier: dest, source: 'carmf', client });
      if (verif.verdict === 'quarantaine') {
        quarantaines.push(verif.raison);
        log(`⚠️ QUARANTAINE : ${verif.raison}`);
        return; // pas d'addDocument -> retéléchargé et revérifié au prochain run
      }
      if (verif.verdict === 'non_verifiable') nonVerifiables++;
      addDocument(client.id, { libelle, fichier: dest, date_doc: dateDoc });
      docs.push({ libelle, fichier: dest });
      log(`OK : ${dest.split(/[\\/]/).pop()} (${Math.round(buf.length / 1024)} Ko)`);
    };

    // ---- 2a. Attestations et releves (chemins connus) ----
    const cibles = [
      { path: '/attestation_reglements', libelle: 'Attestation de règlements' },
      { path: '/comptes', libelle: 'Attestation de mise à jour du compte' },
      { path: '/affiliations', libelle: "Attestation d'affiliation" },
      { path: '/points_releves', libelle: 'Relevé de situation' },
      { path: '/points_releves/carriere', libelle: 'Relevé de carrière' },
    ];
    for (const c of cibles) {
      try {
        const libelle = `${c.libelle} ${annee}`;
        const dest = resolve(clientDir, `${annee}_${sanitize(c.libelle)}.pdf`);
        // Presence testee AVANT de demander le jeton : sinon CARMF genere un PDF a chaque
        // run pour un document deja archive.
        if (dejaEnBase.has(`${annee}|${libelle}`) || (existsSync(dest) && statSync(dest).size > 100)) {
          addDocument(client.id, { libelle, fichier: dest, date_doc: annee });
          dejaPresents++;
          continue;
        }
        const r = await telechargerPdf(context, { chemin: c.path }, navTimeout);
        if (r.err) {
          log(`(${c.libelle} : ${r.err})`);
          continue;
        }
        await enregistrer(r.buf, dest, libelle, annee);
      } catch (e) {
        log(`Échec ${c.libelle} : ${e.message.split('\n')[0]}`);
      }
    }

    // ---- 2b. Appels de cotisation (page « Vos derniers appels de cotisations ») ----
    // CARMF n'expose que les derniers appels (acompte de l'annee en cours, solde de
    // l'exercice precedent) : pas de selecteur d'annee, donc pas d'historique a parcourir.
    let pageAppelsAtteinte = false;
    let appelsDetectes = 0;
    try {
      await page.goto(APPELS_URL, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(1200);
      if (/\/adherents\/(connecter|compte_bloque)/i.test(page.url())) {
        log('Appels de cotisation : session expirée ou compte bloqué — ignoré.');
      } else {
        pageAppelsAtteinte = true;
        const trouves = await listerAppels(page);
        appelsDetectes = trouves.length;
        if (!trouves.length) {
          await dumpDiag(page, clientDir, 'carmf_appels');
          log('Appels de cotisation : aucun lien détecté (diagnostic _diag_carmf_appels.html écrit).');
        } else log(`${trouves.length} appel(s) de cotisation détecté(s).`);
        for (const cible of trouves) {
          try {
            const a = analyserLibelleAppel(cible.libelle);
            const millesime = a.annee || annee;
            const libelle = /appels? de cotisations?/i.test(a.libelle) ? a.libelle : `Appel de cotisations${a.type ? ` (${a.type})` : ''} ${millesime}`;
            const dest = resolve(clientDir, `${millesime}_Appel_cotisation${a.type ? `_${a.type}` : ''}.pdf`);
            if (dejaEnBase.has(`${millesime}|${libelle}`) || (existsSync(dest) && statSync(dest).size > 100)) {
              addDocument(client.id, { libelle, fichier: dest, date_doc: millesime });
              dejaPresents++;
              continue;
            }
            const r = await telechargerPdf(context, cible, navTimeout);
            if (r.err) {
              log(`(${libelle} : ${r.err})`);
              continue;
            }
            await enregistrer(r.buf, dest, libelle, millesime);
          } catch (e) {
            log(`Échec appel « ${String(cible.libelle).slice(0, 60)} » : ${e.message.split('\n')[0]}`);
          }
        }
      }
    } catch (e) {
      log(`Appels de cotisation : ${e.message.split('\n')[0]}`);
    }

    let message = `${docs.length} document(s) récupéré(s)` + (dejaPresents ? `, ${dejaPresents} déjà présent(s)` : '');
    if (pageAppelsAtteinte && appelsDetectes === 0) message += ' (aucun appel de cotisation en ligne)';
    if (nonVerifiables > 0) message += ` (${nonVerifiables} non vérifiable(s) : PDF sans texte)`;
    if (quarantaines.length > 0) message = `⚠️ ${quarantaines.length} PDF mis en quarantaine — ${quarantaines.join(' ; ').slice(0, 300)}. ${message}`;
    addRunSafe(client.id, {
      // Parcours deroule jusqu'au bout = succes, meme sans nouveau document : un adherent
      // peut legitimement n'avoir aucun appel en ligne (retraite, exonere, primo-affiliation).
      statut: quarantaines.length > 0 ? 'echec' : docs.length + dejaPresents > 0 || pageAppelsAtteinte ? 'succes' : 'echec',
      message,
      nb_docs: docs.length,
    });
    log(`Terminé : ${docs.length} nouveau(x), ${dejaPresents} déjà présent(s).`);
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
