// Connecteur URSSAF (tiers mandate) : recuperation des appels de cotisations PDF.
//
// Parcours (verifie sur compte reel) :
//   1. urssaf.fr/accueil/se-connecter -> combobox "Tiers mandate" -> login cabinet
//   2. tdbec.urssaf.fr/accueil -> recherche par SIRET (repli sur le nom) -> "Acceder"
//   3. webti.urssaf.fr -> onglet "Messagerie" -> dcl.urssaf.fr/messagerie
//   4. messages "APPEL DE COTISATIONS" (apercuMsg) -> showAttachement.action -> PDF.
//
// Fonctions exportees :
//   - listerClients(cabinet)        : liste tout le portefeuille (nom + SIRET) via l'API tdbec.
//   - scrapeClient(client, opts)    : un client (connexion dediee).
//   - scrapeAll(clients, opts)      : tous les clients sur UNE SEULE session cabinet (rapide).

import { chromium } from 'playwright';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { addDocument, addRun, getDocumentByEventid } from './urssaf-db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DOWNLOADS_DIR = resolve(__dirname, '..', 'downloads', 'urssaf');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';
const TDBEC_ACCUEIL = 'https://tdbec.urssaf.fr/accueil';

function sanitize(name) {
  return String(name).replace(/[^\w.\- ]+/g, '_').replace(/\s+/g, '_').trim().slice(0, 120);
}
// Nom de fichier lisible : garde les accents et les tirets (pour les dates),
// retire seulement les caracteres interdits par Windows.
function nomFichierDoc(libelle) {
  const base = String(libelle || 'document')
    .replace(/[<>:"/\\|?*]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 130) || 'document';
  return `${base}.pdf`;
}
// Convertit une date URSSAF "JJ/MM/AAAA" en "AAAA-MM-JJ" (triable). Sinon "".
function dateIso(d) {
  const m = String(d || '').match(/(\d{2})\/(\d{2})\/(\d{4})/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : '';
}
function addRunSafe(clientId, run) {
  try { addRun(clientId, run); } catch (e) { console.warn(`(historique non enregistre: ${e.message})`); }
}

async function fermerCookies(page) {
  for (let i = 0; i < 8; i++) {
    let done = false;
    for (const fr of page.frames()) {
      if (!/privacy|tmg|consent/i.test(fr.url())) continue;
      const b = fr.locator('button:has-text("Tout accepter")').first();
      if (await b.isVisible().catch(() => false)) { await b.click().catch(() => {}); done = true; break; }
    }
    if (!done) {
      const b = page.locator('button:has-text("Tout accepter")').first();
      if (await b.isVisible().catch(() => false)) { await b.click().catch(() => {}); done = true; }
    }
    if (done) break;
    await page.waitForTimeout(400);
  }
  await page.evaluate(() => { const c = document.querySelector('#privacy-container, #privacy-iframe'); if (c) c.remove(); }).catch(() => {});
}

function dossierClient(client, baseFolder) {
  if (client.dossier && client.dossier.trim()) return client.dossier.trim();
  if (baseFolder && baseFolder.trim()) return resolve(baseFolder.trim(), sanitize(client.nom));
  return resolve(DOWNLOADS_DIR, sanitize(`${client.id}_${client.nom}`));
}

// Page d'actualites affichee a la connexion (mon.urssaf.fr/actualites?mode=new) :
// bouton « Continuer » (onclick="backToHome();"). On la passe pour atteindre le tableau de bord.
async function passerActualites(page, log) {
  for (let i = 0; i < 4; i++) {
    if (!/\/actualites/i.test(page.url())) return; // deja sorti des actualites
    const btn = page.locator('button:has-text("Continuer"), [alt="Continuer"], button.btn-primary-urssaf').first();
    // Le bouton peut apparaitre apres un court delai : on l'attend (jusqu'a 6 s).
    const visible = await btn.waitFor({ state: 'visible', timeout: 6000 }).then(() => true).catch(() => false);
    if (visible) {
      log?.('Page d\'actualites — clic sur « Continuer ».');
      await Promise.all([page.waitForLoadState('domcontentloaded').catch(() => {}), btn.click().catch(() => {})]);
    } else {
      // Repli : appeler directement la fonction backToHome() de la page.
      await page.evaluate(() => { try { if (typeof backToHome === 'function') backToHome(); } catch {} }).catch(() => {});
    }
    await page.waitForLoadState('networkidle').catch(() => {});
    await page.waitForTimeout(600);
  }
  // Toujours bloque sur les actualites -> on force la sortie vers le tableau de bord.
  if (/\/actualites/i.test(page.url())) {
    log?.('Actualites toujours affichees — navigation forcee vers le tableau de bord.');
    await page.goto(TDBEC_ACCUEIL, { waitUntil: 'domcontentloaded' }).catch(() => {});
    await page.waitForLoadState('networkidle').catch(() => {});
  }
}

// Connexion au compte cabinet (tiers mandate) -> portail mon.urssaf.fr / tableau de bord.
async function connecterCabinet(page, cabinet, navTimeout, log) {
  log('Connexion au compte cabinet (tiers mandate)');
  await page.goto('https://www.urssaf.fr/accueil/se-connecter.html', { waitUntil: 'domcontentloaded' });
  await page.locator('#public-combo-search').waitFor({ state: 'visible', timeout: navTimeout }).catch(() => {});
  await fermerCookies(page);
  await page.locator('#public-combo-search').click().catch(() => {});
  // Attendre l'apparition de l'option « Tiers mandate » (au lieu d'un delai fixe).
  await page.waitForFunction(() => !!document.querySelector('[role="option"][data-value="login-tiers-declarant-tiers-mandate"]'), null, { timeout: 8000 }).catch(() => {});
  const ok = await page.evaluate(() => {
    const o = document.querySelector('[role="option"][data-value="login-tiers-declarant-tiers-mandate"]');
    if (o) { o.scrollIntoView(); o.click(); return true; }
    return false;
  });
  if (!ok) throw new Error("Option 'Tiers mandate' introuvable (page URSSAF modifiee ?).");
  await fermerCookies(page);
  // Attendre le champ identifiant (formulaire tiers mandate affiche).
  await page.locator('#login-tiers-declarant-tiers-mandate-identifiant').waitFor({ state: 'visible', timeout: 10000 });
  await page.locator('#login-tiers-declarant-tiers-mandate-identifiant').fill(cabinet.login);
  await page.locator('#login-tiers-declarant-tiers-mandate-password').fill(cabinet.password);
  await Promise.all([
    page.waitForLoadState('domcontentloaded').catch(() => {}),
    page.locator('#login-tiers-declarant-tiers-mandate-password').press('Enter'),
  ]);
  // Laisser la redirection post-login s'effectuer (attente conditionnelle).
  await page.waitForLoadState('networkidle').catch(() => {});
  await fermerCookies(page);

  // Echec d'authentification : on est reste sur la page de connexion.
  if (/se-connecter|Comptes\/Connexion/i.test(page.url())) {
    let urssafErr = '';
    try {
      urssafErr = await page.evaluate(() => {
        const sels = ['.error', '.alert', '[class*="erreur"]', '[class*="error"]', '.notification', '[role="alert"]'];
        for (const s of sels) { for (const e of document.querySelectorAll(s)) { const t = (e.innerText || '').trim(); if (t) return t; } }
        return '';
      });
    } catch { /* ignore */ }
    let shot = '';
    try {
      const dbg = resolve(DOWNLOADS_DIR, '_debug');
      mkdirSync(dbg, { recursive: true });
      shot = resolve(dbg, `login_${Date.now()}.png`);
      await page.screenshot({ path: shot, fullPage: true });
    } catch { /* ignore */ }
    if (urssafErr) log(`URSSAF affiche : ${urssafErr.replace(/\s+/g, ' ').slice(0, 300)}`);
    if (shot) log(`Capture de la page de connexion : ${shot}`);
    const e = new Error('Connexion cabinet refusee (identifiants cabinet ?)' + (urssafErr ? ` — URSSAF: ${urssafErr.replace(/\s+/g, ' ').slice(0, 160)}` : ''));
    e.kind = 'mdp'; throw e;
  }

  // Connexion OK. Le portail URSSAF a migre (mon.urssaf.fr) : une page d'actualites
  // s'affiche a la connexion. On la passe, puis on s'assure d'etre sur le tableau de
  // bord tiers declarant (champ de recherche present), quel que soit le domaine.
  await passerActualites(page, log);
  await fermerCookies(page);
  let pret = await page.locator('#recherche, input.input-search').first().isVisible().catch(() => false);
  if (!pret) {
    // Acces au tableau de bord tiers declarant. On PRIVILEGIE le lien « Tableau de
    // bord » du portail mon.urssaf.fr (qui etablit la session SSO vers tdbec) ; la
    // navigation directe vers tdbec peut tourner dans le vide (SSO non propage).
    const lienTdb = page.locator('a:has-text("Tableau de bord"), a[href*="tdbec"]').first();
    if (await lienTdb.isVisible().catch(() => false)) {
      log('Ouverture du tableau de bord via le lien du portail...');
      await Promise.all([page.waitForLoadState('domcontentloaded').catch(() => {}), lienTdb.click().catch(() => {})]);
    } else {
      log('Ouverture du tableau de bord tiers declarant (navigation directe)...');
      await page.goto(TDBEC_ACCUEIL, { waitUntil: 'domcontentloaded' }).catch(() => {});
    }
    await page.waitForLoadState('networkidle').catch(() => {});
    await fermerCookies(page);
    await passerActualites(page, log);
    await page.waitForSelector('#recherche, input.input-search', { timeout: 30000 }).catch(() => {});
    pret = await page.locator('#recherche, input.input-search').first().isVisible().catch(() => false);
  }
  await page.waitForTimeout(600);
  if (!pret) {
    try {
      const dbg = resolve(DOWNLOADS_DIR, '_debug');
      mkdirSync(dbg, { recursive: true });
      // Diagnostic : champs/boutons visibles de la page (pour trouver le bon selecteur de recherche).
      try {
        const diag = await page.evaluate(() => ({
          url: location.href,
          inputs: [...document.querySelectorAll('input')].filter((e) => e.offsetParent).slice(0, 12).map((e) => ({ id: e.id, name: e.name, type: e.type, placeholder: e.placeholder, cls: e.className })),
          boutons: [...document.querySelectorAll('button, a.btn')].filter((e) => e.offsetParent).slice(0, 12).map((e) => (e.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 30)),
        }));
        writeFileSync(resolve(dbg, 'dashboard_diag.json'), JSON.stringify(diag, null, 2), 'utf8');
        log(`Diag tableau de bord : ${JSON.stringify(diag).slice(0, 600)}`);
      } catch (e) { log(`(diag tableau de bord : ${e.message})`); }
      const shot = resolve(dbg, `dashboard_${Date.now()}.png`);
      await page.screenshot({ path: shot, fullPage: true });
      log(`Tableau de bord introuvable (${page.url()}) — capture : ${shot}`);
    } catch { /* ignore */ }
    throw new Error(`Tableau de bord tiers declarant introuvable apres connexion (${page.url()}).`);
  }
  log('Connecte au tableau de bord cabinet.');
}

/**
 * Liste TOUS les clients du portefeuille cabinet (nom + SIRET) via l'API tdbec.
 * @param {{login:string,password:string}} cabinet
 * @returns {Promise<Array<{nom:string, siret:string}>>}
 */
export async function listerClients(cabinet, opts = {}) {
  const log = (m) => { const line = `[sync] ${m}`; console.log(line); opts.onLog?.(line); };
  // Visible par defaut (sur serveur : ecran :99 -> noVNC). HEADLESS=true pour forcer l'invisible.
  const headless = String(process.env.HEADLESS ?? 'false').toLowerCase() === 'true';
  const navTimeout = Number(process.env.NAV_TIMEOUT ?? 45000);
  if (!cabinet?.login || !cabinet?.password) throw new Error('Compte cabinet URSSAF non configure.');

  const browser = await chromium.launch({ headless, args: process.platform === 'linux' ? ['--no-sandbox', '--disable-dev-shm-usage'] : [] });
  const context = await browser.newContext({ userAgent: UA, viewport: { width: 1600, height: 1000 }, locale: 'fr-FR' });
  const page = await context.newPage();
  page.setDefaultTimeout(navTimeout);

  let token = null, comptesUrl = null;
  page.on('request', (r) => {
    if (/api-tdbec\/v1\//i.test(r.url())) { const a = r.headers()['authorization']; if (a) token = a; }
    if (/api-tdbec\/v1\/comptes/i.test(r.url())) comptesUrl = r.url();
  });

  try {
    await connecterCabinet(page, cabinet, navTimeout, log);
    for (let i = 0; i < 20 && !token; i++) await page.waitForTimeout(500);
    if (!token) throw new Error("Jeton d'authentification non capture (page modifiee ?).");

    const base = (comptesUrl || 'https://api.urssaf.fr/api-tdbec/v1/comptes?etat=ACTIFS&page=0&size=10')
      .replace(/([?&])size=\d+/, '$1size=100');
    const rows = [];
    const vus = new Set();
    let totalPages = 1;
    for (let p = 0; p < 50; p++) {
      const url = base.replace(/([?&])page=\d+/, '$1page=' + p);
      const resp = await context.request.get(url, { headers: { authorization: token } });
      if (!resp.ok()) { log(`(page ${p} : HTTP ${resp.status()})`); break; }
      const j = await resp.json();
      totalPages = j.totalPages ?? totalPages;
      const arr = j.listeActive || j.content || j.comptes || [];
      for (const c of arr) {
        const nom = (c.raison_sociale || c.raisonSociale || c.nom || c.libelle || '').toString().trim();
        const siret = String(c.siret || c.siren || '').replace(/\s+/g, '');
        if (nom && siret && !vus.has(siret)) { vus.add(siret); rows.push({ nom, siret }); }
      }
      log(`Page ${p + 1}/${totalPages} : ${rows.length} client(s) cumules`);
      if (p >= totalPages - 1 || arr.length === 0) break;
    }
    log(`${rows.length} client(s) listes.`);
    return rows;
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

// Traite UN client sur une page deja connectee (positionnee sur le tableau de bord tdbec).
// Recherche -> Acceder -> Messagerie -> telechargement des appels. Enregistre le run.
// Ne ferme PAS les onglets : c'est l'appelant qui nettoie et revient au tableau de bord.
async function recupererAppelsClient(context, page, client, { baseFolder, navTimeout, log }) {
  const docs = [];
  const siret = String(client.siret || '').replace(/\s+/g, '');
  const clientDir = dossierClient(client, baseFolder);
  mkdirSync(clientDir, { recursive: true });

  try {
    // 1. Recherche (par identifiant, repli sur le nom)
    async function rechercher(terme) {
      const champ = page.locator('#recherche, input.input-search').first();
      await champ.fill('');
      await champ.fill(terme);
      await page.locator('button:has-text("Rechercher")').first().click().catch(() => {});
      // On attend l'apparition du bouton « Acceder » (resultat trouve) plutot
      // qu'un delai fixe : client present -> on continue tout de suite.
      const lien = page.locator('a:has-text("Accéder"), button:has-text("Accéder")').first();
      await lien.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
      return lien;
    }
    log(`Recherche du compte ${siret}`);
    let acceder = await rechercher(siret);
    if (!(await acceder.count()) && client.nom) {
      log(`Aucun resultat par identifiant — recherche par nom « ${client.nom} »`);
      acceder = await rechercher(client.nom);
    }
    if (!(await acceder.count())) throw new Error(`Aucun client trouve (${siret} / ${client.nom}).`);

    // 2. Acceder au dossier client (webti)
    const popupP = page.waitForEvent('popup', { timeout: 12000 }).catch(() => null);
    await acceder.click();
    const cli = (await popupP) || page;
    await cli.waitForLoadState('domcontentloaded').catch(() => {});
    await cli.waitForLoadState('networkidle').catch(() => {});
    await fermerCookies(cli);
    // On attend le lien « Messagerie » (signal que le dossier client est pret).
    const lienMsg = cli.locator('a:visible, button:visible', { hasText: 'Messagerie' }).first();
    await lienMsg.waitFor({ state: 'visible', timeout: 20000 }).catch(() => {});
    log('Acces au dossier client.');

    // 3. Messagerie
    const popup2P = cli.waitForEvent('popup', { timeout: 12000 }).catch(() => null);
    await lienMsg.click().catch(() => {});
    await cli.waitForTimeout(400);
    const msg = (await popup2P) || cli;
    log('Ouverture de la messagerie...');
    await msg.waitForURL(/dcl\.urssaf\.fr\/messagerie|Rico\.action/, { timeout: navTimeout }).catch(() => {});
    await msg.waitForLoadState('networkidle').catch(() => {});
    await msg
      .waitForFunction(() => document.querySelectorAll('[onclick*="apercuMsg"]').length > 0, null, { timeout: 30000 })
      .catch(() => log('Avertissement : liste des messages non detectee (delai).'));
    await msg.waitForTimeout(300);

    // 4. Tous les documents de la messagerie -> PDF.
    // Les liens de pieces jointes (showAttachement.action) sont DEJA presents
    // dans la liste des messages : on les recupere directement, sans ouvrir
    // chaque message (apercuMsg soumet un formulaire et recharge la page).
    // On lit le DOM affiche + la pagination RicoFil.action.
    const docsTrouves = await msg.evaluate(async () => {
      // Extrait, par message, {href, eid, objet, date}. Chaque message est un
      // bloc « div.row.urssaf-message » porteur de l'onclick apercuMsg, contenant
      // l'objet (.col-lg-5 / .col-md-6), la date (.urssaf_date_echange) et le
      // lien de la piece jointe (a[href*=showAttachement]).
      function texte(el) { return el ? (el.textContent || '').replace(/\s+/g, ' ').trim() : ''; }
      function extraire(racine) {
        // 1. Liens de pieces jointes groupes par EVENTID (resout l'association
        //    objet/date <-> document de facon fiable).
        const liensParId = {};
        for (const a of racine.querySelectorAll('a[href*="showAttachement"]')) {
          let href = a.getAttribute('href') || a.href || '';
          if (!href) continue;
          if (!/^https?:/i.test(href)) href = href.startsWith('/') ? location.origin + href : location.origin + '/messagerie/' + href;
          const id = (href.match(/[?&]EVENTID=([^&]+)/i) || href.match(/[?&]COURRIERID=([^&]+)/i) || [])[1] || '';
          (liensParId[id] = liensParId[id] || []).push(href);
        }
        // 2. Messages : objet + date, associes a leurs liens par identifiant.
        const items = [];
        for (const el of racine.querySelectorAll('[onclick*="apercuMsg"]')) {
          const m = (el.getAttribute('onclick') || '').match(/apercuMsg\('?(\d+)'?\)/);
          if (!m) continue;
          const eid = m[1];
          const hrefs = liensParId[eid];
          if (!hrefs || !hrefs.length) continue; // message sans piece jointe -> ignore
          const objet = texte(el.querySelector('.col-lg-5') || el.querySelector('.col-md-6'));
          const date = texte(el.querySelector('.urssaf_date_echange'));
          for (const href of hrefs) items.push({ href, eid, objet, date });
        }
        return items;
      }

      let items = extraire(document); // a) DOM affiche

      for (let p = 1; p <= 30; p++) { // b) pagination
        let html;
        try {
          const r = await fetch(`/messagerie/RicoFil.action?pageEnCours=${p}&timestamp=${Date.now()}`, { credentials: 'include' });
          html = await r.text();
        } catch { break; }
        if (!html || !/apercuMsg|showAttachement/i.test(html)) break;
        const doc = new DOMParser().parseFromString(html, 'text/html');
        items = items.concat(extraire(doc));
        if (!/apercuMsg/i.test(html)) break;
      }

      // Deduplication par lien (chaque piece jointe une seule fois).
      const vus = new Set();
      const out = [];
      for (const it of items) { if (it.href && !vus.has(it.href)) { vus.add(it.href); out.push(it); } }
      return out;
    });

    log(`${docsTrouves.length} document(s) detecte(s) dans la messagerie.`);

    // Diagnostic : si 0 document, on dump la structure de la messagerie pour
    // comprendre les cas particuliers (praticiens PAMC : infirmiers, osteo...).
    if (docsTrouves.length === 0) {
      try {
        const diag = { url: msg.url(), genere_le: new Date().toISOString(), contextes: [] };
        let cibleHtml = msg;
        for (const fr of [msg, ...msg.frames()]) {
          const info = await fr.evaluate(() => {
            const ex = (sel, attr) => { const e = document.querySelector(sel); return e ? (attr === 'html' ? e.outerHTML.slice(0, 300) : (e.getAttribute(attr) || e.href || e.textContent || '').toString().slice(0, 200)) : null; };
            return {
              url: location.href,
              nbApercu: document.querySelectorAll('[onclick*="apercuMsg"]').length,
              nbShowAttach: document.querySelectorAll('a[href*="showAttachement"]').length,
              nbLiensPdf: document.querySelectorAll('a[href*=".pdf"], a[href*="PDF"], a[href*="ocument"]').length,
              nbOnclick: document.querySelectorAll('[onclick]').length,
              exOnclick: ex('[onclick]', 'onclick'),
              exLienPdf: ex('a[href*=".pdf"], a[href*="ocument"], a[href*="ttach"]', 'href'),
              texteCourt: (document.body ? document.body.innerText.replace(/\s+/g, ' ').trim().slice(0, 400) : ''),
            };
          }).catch(() => null);
          if (info) {
            diag.contextes.push(info);
            if ((info.nbApercu > 0 || info.nbShowAttach > 0) && cibleHtml === msg && fr !== msg) cibleHtml = fr;
          }
        }
        // Page du dossier client (webti) : URL + onglets/liens visibles, pour
        // voir par ou atteindre les documents des praticiens PAMC.
        try {
          diag.dossier = {
            url: cli.url(),
            liens: await cli.evaluate(() => [...document.querySelectorAll('a, button, [role="tab"], [role="menuitem"]')]
              .filter((e) => e.offsetParent !== null)
              .map((e) => (e.textContent || '').replace(/\s+/g, ' ').trim())
              .filter((t) => t && t.length < 45)
              .slice(0, 80)),
          };
          const htmlDossier = await cli.content().catch(() => '');
          if (htmlDossier) writeFileSync(resolve(clientDir, '_diagnostic_dossier.html'), htmlDossier, 'utf8');
        } catch (e) { diag.dossier = { erreur: e.message }; }
        writeFileSync(resolve(clientDir, '_diagnostic.txt'), JSON.stringify(diag, null, 2), 'utf8');
        const html = await cibleHtml.content().catch(() => '');
        if (html) writeFileSync(resolve(clientDir, '_diagnostic_messagerie.html'), html, 'utf8');
        log(`Diagnostic (0 doc) ecrit dans ${clientDir}.`);
      } catch (e) { log(`(diagnostic non ecrit : ${e.message})`); }
    }

    let existants = 0;
    const utilises = new Set();
    for (const { href, eid, objet, date } of docsTrouves) {
      // Cle unique du document : DOCUMENTID si present, sinon EVENTID, sinon le lien.
      const docId = (href.match(/[?&]DOCUMENTID=([^&]+)/i) || [])[1] || eid || href;
      // Nom : « AAAA-MM-JJ Objet » (date en premier, comme l'URSSAF).
      const nomBase = [dateIso(date), objet || 'Document URSSAF'].filter(Boolean).join(' ');
      const libelleDoc = [date, objet].filter(Boolean).join(' — ').slice(0, 200) || 'Document URSSAF';
      try {
        // Economie : deja recupere ? (cle = identifiant unique du document)
        const deja = getDocumentByEventid(client.id, docId);
        if (deja && deja.fichier && existsSync(deja.fichier)) {
          existants++;
          log(`Deja present : ${deja.fichier.split(/[\\/]/).pop()} (ignore)`);
          continue;
        }
        // Nom de fichier lisible, unique dans le dossier.
        let dest = resolve(clientDir, nomFichierDoc(nomBase));
        if (utilises.has(dest.toLowerCase()) || existsSync(dest)) {
          const base = nomFichierDoc(nomBase).replace(/\.pdf$/i, '');
          let i = 2;
          do { dest = resolve(clientDir, `${base} (${i++}).pdf`); } while ((utilises.has(dest.toLowerCase()) || existsSync(dest)) && i < 100);
        }
        utilises.add(dest.toLowerCase());

        const resp = await msg.request.get(href, { timeout: navTimeout });
        if (!resp.ok()) throw new Error(`HTTP ${resp.status()}`);
        const buf = await resp.body();
        if (buf.length < 100 || buf.subarray(0, 4).toString() !== '%PDF') throw new Error('reponse non-PDF');
        writeFileSync(dest, buf);
        try { addDocument(client.id, { libelle: libelleDoc, fichier: dest, eventid: docId }); } catch (e) { log(`(doc non enregistre: ${e.message})`); }
        docs.push({ libelle: libelleDoc, fichier: dest });
        log(`OK : ${dest.split(/[\\/]/).pop()} (${Math.round(buf.length / 1024)} Ko)`);
      } catch (e) {
        log(`Echec document ${eid || docId} : ${e.message}`);
      }
    }

    const total = docsTrouves.length;
    let message;
    if (total === 0) { log('Aucun document (piece jointe) dans la messagerie de ce client.'); message = 'Aucun document disponible'; }
    else message = `${docs.length} nouveau(x) document(s), ${existants} deja present(s) sur ${total} piece(s) jointe(s)`;
    addRunSafe(client.id, { statut: 'succes', message, nb_docs: docs.length });
    log(`Termine : ${docs.length} nouveau(x), ${existants} deja present(s) sur ${total} document(s).`);
    return { ok: true, docs };
  } catch (err) {
    const shot = resolve(clientDir, `_debug_${Date.now()}.png`);
    await page.screenshot({ path: shot, fullPage: true }).catch(() => {});
    addRunSafe(client.id, { statut: err.kind === 'mdp' ? 'echec_mdp' : 'echec', message: err.message, nb_docs: docs.length });
    log(`ERREUR : ${err.message}`);
    return { ok: false, error: err.message, docs };
  }
}

// Ferme les onglets secondaires (webti/dcl) et revient au tableau de bord pour le client suivant.
async function retourTableauBord(context, page, navTimeout) {
  for (const p of context.pages()) { if (p !== page) await p.close().catch(() => {}); }
  await page.goto(TDBEC_ACCUEIL, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await passerActualites(page);
  // On attend le champ de recherche (tableau de bord pret) au lieu d'un delai fixe.
  await page.waitForSelector('#recherche, input.input-search', { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(600);
}

// La session cabinet URSSAF expire apres ~1h. On la considere vivante si on est
// bien sur tdbec avec le champ de recherche visible ; sinon il faut se reconnecter
// (sans quoi toutes les recherches suivantes echouent en « Aucun client trouve »).
async function sessionVivante(page) {
  if (!/tdbec\.urssaf\.fr/.test(page.url())) return false;
  const champ = page.locator('#recherche, input.input-search').first();
  return await champ.isVisible().catch(() => false);
}

/**
 * Recupere les appels de cotisations d'UN client (connexion dediee).
 * @param {{id:number, nom:string, siret:string, dossier?:string}} client
 * @param {{onLog?:(m:string)=>void, baseFolder?:string, cabinet?:{login:string,password:string}}} [opts]
 */
export async function scrapeClient(client, opts = {}) {
  const log = (m) => { const line = `[${client.nom}] ${m}`; console.log(line); opts.onLog?.(line); };
  // Visible par defaut (sur serveur : ecran :99 -> noVNC). HEADLESS=true pour forcer l'invisible.
  const headless = String(process.env.HEADLESS ?? 'false').toLowerCase() === 'true';
  const navTimeout = Number(process.env.NAV_TIMEOUT ?? 45000);
  const cabinet = opts.cabinet;
  if (!cabinet?.login || !cabinet?.password) {
    addRunSafe(client.id, { statut: 'echec', message: 'Compte cabinet URSSAF non configure (Reglages).', nb_docs: 0 });
    return { ok: false, error: 'Compte cabinet URSSAF manquant. Renseigne-le dans les reglages.' };
  }
  const browser = await chromium.launch({ headless, args: process.platform === 'linux' ? ['--no-sandbox', '--disable-dev-shm-usage'] : [] });
  const context = await browser.newContext({ acceptDownloads: true, userAgent: UA, viewport: { width: 1600, height: 1000 }, locale: 'fr-FR' });
  const page = await context.newPage();
  page.setDefaultTimeout(navTimeout);
  try {
    await connecterCabinet(page, cabinet, navTimeout, log);
    await page.waitForTimeout(200);
    return await recupererAppelsClient(context, page, client, { baseFolder: opts.baseFolder, navTimeout, log });
  } catch (err) {
    addRunSafe(client.id, { statut: err.kind === 'mdp' ? 'echec_mdp' : 'echec', message: err.message, nb_docs: 0 });
    log(`ERREUR : ${err.message}`);
    return { ok: false, error: err.message, docs: [] };
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

/**
 * Recupere les appels de cotisations de TOUS les clients sur UNE SEULE session cabinet.
 * @param {Array<{id:number,nom:string,siret:string,dossier?:string}>} clients
 * @param {{onLog?:(m:string)=>void, baseFolder?:string, cabinet?:{login:string,password:string}, shouldStop?:()=>boolean}} [opts]
 */
export async function scrapeAll(clients, opts = {}) {
  const log = (m) => { const line = `[lot] ${m}`; console.log(line); opts.onLog?.(line); };
  // Visible par defaut (sur serveur : ecran :99 -> noVNC). HEADLESS=true pour forcer l'invisible.
  const headless = String(process.env.HEADLESS ?? 'false').toLowerCase() === 'true';
  const navTimeout = Number(process.env.NAV_TIMEOUT ?? 45000);
  const cabinet = opts.cabinet;
  const resume = { total: clients.length, traites: 0, avecDocs: 0, docs: 0, echecs: 0 };
  if (!cabinet?.login || !cabinet?.password) return { ok: false, error: 'Compte cabinet URSSAF manquant.', resume };

  const browser = await chromium.launch({ headless, args: process.platform === 'linux' ? ['--no-sandbox', '--disable-dev-shm-usage'] : [] });
  const context = await browser.newContext({ acceptDownloads: true, userAgent: UA, viewport: { width: 1600, height: 1000 }, locale: 'fr-FR' });
  const page = await context.newPage();
  page.setDefaultTimeout(navTimeout);

  try {
    await connecterCabinet(page, cabinet, navTimeout, log);
    log(`Traitement de ${clients.length} client(s) sur une seule session...`);
    await page.waitForTimeout(200);

    let echecsConsecutifs = 0;
    for (let i = 0; i < clients.length; i++) {
      if (opts.shouldStop && opts.shouldStop()) { log('Arret demande, fin du lot.'); break; }
      const client = clients[i];
      const clog = (m) => { const line = `[${client.nom}] ${m}`; console.log(line); opts.onLog?.(line); };

      // Avant chaque client : si la session a expire (ou apres une serie d'echecs),
      // on se reconnecte au compte cabinet pour ne pas rater tout le reste du lot.
      if (!(await sessionVivante(page)) || echecsConsecutifs >= 3) {
        log(echecsConsecutifs >= 3 ? 'Plusieurs echecs d\'affilee -> reconnexion du compte cabinet...' : 'Session cabinet expiree -> reconnexion...');
        try {
          await connecterCabinet(page, cabinet, navTimeout, log);
          await page.waitForTimeout(300);
          echecsConsecutifs = 0;
        } catch (e) {
          log(`Echec de la reconnexion (${e.message}). Arret du lot.`);
          break;
        }
      }

      clog(`(${i + 1}/${clients.length})`);
      opts.onClient?.(client.nom);
      const r = await recupererAppelsClient(context, page, client, { baseFolder: opts.baseFolder, navTimeout, log: clog });
      echecsConsecutifs = r.ok ? 0 : echecsConsecutifs + 1;
      resume.traites++;
      if (r.ok) { if (r.docs && r.docs.length) { resume.avecDocs++; resume.docs += r.docs.length; } }
      else resume.echecs++;
      opts.onResult?.({ nom: client.nom, ok: !!r.ok, message: r.ok ? `${r.docs?.length ?? 0} document(s)` : (r.error || 'erreur'), nb_docs: r.docs?.length ?? 0 });
      // Retour au tableau de bord (ferme les onglets webti/dcl) pour le client suivant.
      await retourTableauBord(context, page, navTimeout).catch((e) => log(`(retour tableau de bord: ${e.message})`));
    }
    log(`Termine : ${resume.docs} document(s) pour ${resume.avecDocs}/${resume.traites} client(s) ; ${resume.echecs} echec(s).`);
    return { ok: true, resume };
  } catch (err) {
    log(`ERREUR session : ${err.message}`);
    return { ok: false, error: err.message, resume };
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}
