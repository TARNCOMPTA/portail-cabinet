// Connecteur impots.gouv.fr - espace professionnel (SEMI-AUTOMATIQUE).
//
// A cause du CAPTCHA, la connexion est MANUELLE : le robot ouvre un navigateur visible,
// TU te connectes (identifiants + captcha) UNE fois par session, puis le robot enchaine.
//
// Parcours (verifie le 12/06/2026) :
//   1. cfspro.impots.gouv.fr -> connexion manuelle -> mire/accueil.do
//   2. CONSULTER > Avis CFE -> afficherChoisirDossier (saisie SIREN, 9 cases) -> Valider
//   3. rechercherDossiers -> selection du dossier + bouton CONSULTER
//   4. ADELIE2 : avis_cfe.xhtml (colonne "Telecharger l'avis") + avisTaxeFonciere.xhtml
//      (icone PDF colonne "Avis principal") -> clic = telechargement du PDF.

import { chromium } from 'playwright';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { addDocument, addRun, getDocumentByEventid } from './db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DOWNLOADS_DIR = resolve(__dirname, '..', 'downloads');

const ACCUEIL_URL = 'https://cfspro.impots.gouv.fr/';
const CFE_CHOISIR_URL = 'https://cfspro.impots.gouv.fr/mire/afficherChoisirDossier.do?action=parTypeHablitation&idth=consulter.avis.cfe';
const CFE_AVIS_URL = 'https://cfspro.impots.gouv.fr/adelie2mapi/xhtml/impots/cfe/avis_cfe.xhtml?emetteur=ADELIE_2';
const TF_AVIS_URL = 'https://cfspro.impots.gouv.fr/adelie2mapi/xhtml/impots/tf/avisTaxeFonciere.xhtml?emetteur=ADELIE_2';
const TOUS_DOSSIERS_URL = 'https://cfspro.impots.gouv.fr/mire/afficherChoisirDossier.do?action=tousMesDossier&idth=consulter.avis.cfe';
// Pages suivantes de "tous mes dossiers" (10 dossiers/page) : afficherMesDossiers.do?p=N
const PAGE_DOSSIERS_URL = (p) => `https://cfspro.impots.gouv.fr/mire/afficherMesDossiers.do?p=${p}&action=tousMesDossier&idth=consulter.avis.cfe`;
// Messagerie securisee "Mes echanges" (appli gaia2), PAR DOSSIER (choix du SIREN).
const MSG_CHOISIR_URL = 'https://cfspro.impots.gouv.fr/mire/afficherChoisirDossier.do?action=parTypeHablitation&idth=messagerie.gaia2.messagerie';
const GAIA_URL = 'https://cfspro.impots.gouv.fr/gaia2-zu-mapi/pages/pro/portailpro.xhtml';

// Lit les dossiers (nom + SIREN) presents sur la page courante.
function lireDossiersPage(page) {
  return page.evaluate(() => {
    const out = [];
    for (const r of document.querySelectorAll('input[name="idDossier"]')) {
      const tr = r.closest('tr, li, div');
      const t = (tr?.innerText || '').replace(/\s+/g, ' ').trim();
      const siren = (t.match(/SIREN\s*:?\s*(\d[\d ]{8,})/i) || [])[1];
      const nom = t.replace(/SIREN.*/i, '').trim();
      if (nom && siren) out.push({ nom: nom.slice(0, 120), siren: siren.replace(/\s/g, '') });
    }
    return out;
  });
}

function sanitize(name) { return String(name).replace(/[^\w.\- ]+/g, '_').replace(/\s+/g, '_').trim().slice(0, 120); }
function addRunSafe(clientId, run) { try { addRun(clientId, run); } catch (e) { console.warn(`(historique: ${e.message})`); } }

// Champs de la page de connexion (idp.impots.gouv.fr). Cibles par "name" (les id ont un suffixe variable).
const LOGIN_USER_SEL = 'input[name="user"], input[type="email"]';
const LOGIN_PWD_SEL = 'input[name="password"], input[type="password"]';
const LOGIN_CAPTCHA_SEL = 'input[name="captcha"], #input-captcha';

// Connexion SEMI-AUTO : on pre-remplit e-mail + mot de passe ; il ne reste que la CAPTCHA a saisir.
async function attendreConnexionManuelle(page, cabinet, log) {
  log('Ouverture de la page de connexion impots...');
  await page.goto(ACCUEIL_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
  // Deja connecte ? sinon on attend l'accueil "mire" (max 5 min)
  if (/\/mire\//.test(page.url())) { log('Session deja active.'); return; }

  // Pre-remplissage des identifiants (la captcha reste manuelle).
  const champUser = page.locator(LOGIN_USER_SEL).first();
  await champUser.waitFor({ state: 'visible', timeout: 20000 }).catch(() => {});
  const login = (cabinet?.login || '').trim();
  const pwd = cabinet?.password || '';
  if (login && (await champUser.isVisible().catch(() => false))) {
    try {
      await champUser.fill(login);
      if (pwd) await page.locator(LOGIN_PWD_SEL).first().fill(pwd).catch(() => {});
      if (pwd) {
        log('E-mail et mot de passe pre-remplis. >>> SAISIS LA CAPTCHA puis clique sur Connexion. <<<');
        await page.locator(LOGIN_CAPTCHA_SEL).first().focus().catch(() => {});
      } else {
        log('E-mail pre-rempli. Saisis ton mot de passe + la captcha (aucun mot de passe enregistre).');
      }
    } catch (e) { log(`(pre-remplissage : ${e.message.split('\n')[0]})`); }
  } else {
    log('Connecte-toi dans le navigateur (identifiants + captcha).');
  }

  // Attend la connexion effective (redirection vers l'espace pro), max 5 min.
  await page.waitForURL(/cfspro\.impots\.gouv\.fr\/mire\/(accueil|afficherChoisirDossier|rechercherDossiers)/, { timeout: 300000 });
  log('Connexion detectee. Traitement en cours...');
  await page.waitForTimeout(1500);
}

// Telecharge tous les avis du tableau (selecteur fourni). Saute ceux deja telecharges.
async function telechargerAvis(page, client, clientDir, prefixe, tableSel, navTimeout, log) {
  let liens = page.locator(`${tableSel} a`);
  if (!(await liens.count().catch(() => 0))) liens = page.locator('[id$="_data"] a');
  const n = await liens.count().catch(() => 0);
  const docs = [];
  let existants = 0;
  for (let i = 0; i < n; i++) {
    const lien = liens.nth(i);
    const ligneTxt = (await lien.evaluate((el) => (el.closest('tr')?.innerText || '')).catch(() => '')).replace(/\s+/g, ' ');
    const ref = (ligneTxt.match(/\d{10,15}/) || [])[0] || `${prefixe}${i + 1}`;
    const annee = (ligneTxt.match(/\b20\d{2}\b/) || [])[0] || '';
    const eid = `${prefixe}_${ref}`;
    const dest = resolve(clientDir, `${prefixe}_${annee ? annee + '_' : ''}${ref}.pdf`);
    if (existsSync(dest) || getDocumentByEventid(client.id, eid)) {
      existants++;
      try { addDocument(client.id, { libelle: `${prefixe} ${annee} ${ref}`, fichier: dest, eventid: eid }); } catch {}
      continue;
    }
    try {
      const [dl] = await Promise.all([page.waitForEvent('download', { timeout: navTimeout }), lien.click()]);
      await dl.saveAs(dest);
      try { addDocument(client.id, { libelle: `${prefixe} ${annee} ${ref}`, fichier: dest, eventid: eid }); } catch {}
      docs.push({ libelle: `${prefixe} ${annee}`, fichier: dest });
      log(`OK : ${prefixe}_${annee}_${ref}.pdf`);
    } catch (e) {
      log(`(${prefixe} ${i + 1} : ${e.message.split('\n')[0]})`);
    }
  }
  return { docs, existants };
}

// Messagerie securisee "Mes echanges" (gaia2) d'un dossier : enregistre le TEXTE de
// chaque echange (+ pieces jointes si presentes) dans <clientDir>/Messagerie, par ordre
// chronologique. La liste est une datatable PrimeFaces ; ouvrir un N° deplie le message.
async function recupererMessagerie(page, context, client, clientDir, navTimeout, log) {
  const siren = String(client.siret || '').replace(/\D/g, '').slice(0, 9);
  const dir = resolve(clientDir, 'Messagerie');
  mkdirSync(dir, { recursive: true });
  const docs = [];
  let existants = 0;
  try {
    // 1. Choix du dossier sous l'habilitation "messagerie" (peut ouvrir un nouvel onglet)
    await page.goto(MSG_CHOISIR_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
    await page.waitForTimeout(1000);
    for (let i = 0; i < 9; i++) { const b = page.locator(`#siren${i}`); if (await b.count()) await b.fill(siren[i] || ''); }
    let popup = null;
    [popup] = await Promise.all([
      context.waitForEvent('page', { timeout: 8000 }).catch(() => null),
      page.locator('input[name="button.submitValider"], input[type="image"]').first().click().catch(() => {}),
    ]);
    await page.waitForTimeout(2500);
    if (/rechercherDossiers/i.test(page.url())) {
      const radio = page.locator('input[name="idDossier"], #sel0').first();
      if (await radio.count() && !(await radio.isChecked().catch(() => false))) await radio.check().catch(() => {});
      [popup] = await Promise.all([
        context.waitForEvent('page', { timeout: 8000 }).catch(() => popup),
        page.locator('input[name="button.submitValider"], input[type="image"]').first().click().catch(() => {}),
      ]);
      await page.waitForTimeout(2500);
    }
    const gaia = popup || page;
    if (popup) await popup.waitForLoadState('domcontentloaded').catch(() => {});
    else if (!/gaia2/i.test(page.url())) await page.goto(GAIA_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
    await gaia.waitForTimeout(2000);

    // 2. Enumeration des echanges (num + objet + date)
    const echanges = await gaia.evaluate(() => Array.from(document.querySelectorAll('a[id^="listeDemandesForm:listeDemandes:"][id$=":numDemande"]')).map((a) => {
      const tds = Array.from(a.closest('tr')?.querySelectorAll('td') || []).map((td) => (td.textContent || '').replace(/\s+/g, ' ').trim());
      return { num: (a.textContent || '').trim(), id: a.id, objet: tds[1] || '', service: tds[2] || '', date: tds[5] || '' };
    })).catch(() => []);
    if (!echanges.length) { log('Messagerie : aucun échange.'); if (popup) await popup.close().catch(() => {}); return { docs, existants }; }
    // ordre chronologique (date de création croissante)
    const cle = (d) => (d || '').split('/').reverse().join('');
    echanges.sort((a, b) => cle(a.date).localeCompare(cle(b.date)));
    log(`Messagerie : ${echanges.length} échange(s).`);

    for (const e of echanges) {
      const base = sanitize(`${(e.date || '').replace(/\//g, '-')}_${e.num}_${e.objet}`).slice(0, 110);
      const dest = resolve(dir, `${base}.txt`);
      const eid = `MSG_${e.num}`;
      if (existsSync(dest) || getDocumentByEventid(client.id, eid)) { existants++; try { addDocument(client.id, { libelle: `Message ${e.date} ${e.objet}`.slice(0, 150), fichier: dest, eventid: eid }); } catch {} continue; }
      try {
        await gaia.locator(`[id="${e.id}"]`).first().click({ timeout: navTimeout }).catch(() => {});
        await gaia.waitForTimeout(1400);
        // Texte du message : plus petit element contenant "Objet :" + "De :/A :"
        const texte = await gaia.evaluate(() => {
          let best = null, len = 1e9;
          for (const el of document.querySelectorAll('td,div,fieldset,section')) {
            const t = el.innerText || '';
            if (/Objet\s*:/.test(t) && /(De|A)\s*:/.test(t) && t.length > 120 && t.length < len) { best = el; len = t.length; }
          }
          return best ? best.innerText.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim() : '';
        }).catch(() => '');
        if (texte) {
          writeFileSync(dest, `N° ${e.num} — ${e.objet}\nService : ${e.service}\nDate : ${e.date}\n${'-'.repeat(60)}\n\n${texte}\n`, 'utf8');
          try { addDocument(client.id, { libelle: `Message ${e.date} ${e.objet}`.slice(0, 150), fichier: dest, eventid: eid }); } catch {}
          docs.push({ libelle: `Message ${e.date}`, fichier: dest });
          log(`OK : ${base}.txt`);
        } else { log(`(message ${e.num} : texte introuvable)`); }
        // Pieces jointes eventuelles (liens de telechargement dans le panneau ouvert)
        const pjLiens = gaia.locator('a[href$=".pdf"], a[href*="telecharger" i], a[href*="fichier" i], a[id*="telecharg" i]');
        const npj = await pjLiens.count().catch(() => 0);
        for (let k = 0; k < npj; k++) {
          try {
            const [dl] = await Promise.all([gaia.waitForEvent('download', { timeout: navTimeout }), pjLiens.nth(k).click()]);
            const nomPj = sanitize(dl.suggestedFilename() || `${e.num}_pj${k + 1}`);
            const destPj = resolve(dir, `${(e.date || '').replace(/\//g, '-')}_${nomPj}`);
            await dl.saveAs(destPj);
            try { addDocument(client.id, { libelle: `PJ ${e.date} ${nomPj}`.slice(0, 150), fichier: destPj, eventid: `${eid}_PJ${k + 1}` }); } catch {}
            docs.push({ libelle: `PJ ${e.date}`, fichier: destPj });
            log(`OK (PJ) : ${nomPj}`);
          } catch { /* pas de telechargement pour ce lien */ }
        }
      } catch (err) { log(`(message ${e.num} : ${err.message.split('\n')[0]})`); }
    }
    if (popup) await popup.close().catch(() => {});
  } catch (err) {
    log(`Messagerie : ${err.message.split('\n')[0]}`);
  }
  return { docs, existants };
}

// Traite UN client (SIREN) sur une page deja connectee. Telecharge CFE + taxe fonciere.
async function recupererClient(page, client, { baseFolder, navTimeout, log, context, messagerie }) {
  const siren = String(client.siret || '').replace(/\D/g, '').slice(0, 9);
  let clientDir;
  if (client.dossier && client.dossier.trim()) clientDir = client.dossier.trim();
  else if (baseFolder && baseFolder.trim()) clientDir = resolve(baseFolder.trim(), sanitize(client.nom));
  else clientDir = resolve(DOWNLOADS_DIR, sanitize(`${client.id}_${client.nom}`));
  mkdirSync(clientDir, { recursive: true });

  try {
    if (siren.length < 9) throw new Error('SIREN invalide (9 chiffres requis).');
    // 1. Choisir le dossier par SIREN
    await page.goto(CFE_CHOISIR_URL, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1200);
    for (let i = 0; i < 9; i++) { const box = page.locator(`#siren${i}`); if (await box.count()) await box.fill(siren[i] || ''); }
    await page.locator('input[name="button.submitValider"], input[type="image"]').first().click().catch(() => {});
    await page.waitForLoadState('domcontentloaded').catch(() => {});
    await page.waitForTimeout(2500);
    // 2. Liste de dossiers -> selection + CONSULTER
    if (/rechercherDossiers/i.test(page.url())) {
      const radio = page.locator('input[name="idDossier"], #sel0').first();
      if (await radio.count()) { if (!(await radio.isChecked().catch(() => false))) await radio.check().catch(() => {}); }
      await Promise.all([
        page.waitForLoadState('domcontentloaded').catch(() => {}),
        page.locator('input[name="button.submitValider"], input[type="image"]').first().click().catch(() => {}),
      ]);
      await page.waitForTimeout(3000);
    }
    // 3. Avis CFE
    await page.goto(CFE_AVIS_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
    await page.waitForTimeout(3000);
    const cfe = await telechargerAvis(page, client, clientDir, 'CFE', '[id$="tableauAvisImposition_data"]', navTimeout, log);
    // 4. Taxe fonciere
    await page.goto(TF_AVIS_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
    await page.waitForTimeout(3000);
    const tf = await telechargerAvis(page, client, clientDir, 'TF', '[id$="tableauAvisTaxeFonciere_data"]', navTimeout, log);

    // 5. Messagerie (optionnelle)
    let msg = { docs: [], existants: 0 };
    if (messagerie) msg = await recupererMessagerie(page, context, client, clientDir, navTimeout, log);

    const nouveaux = cfe.docs.length + tf.docs.length + msg.docs.length;
    const existants = cfe.existants + tf.existants + msg.existants;
    addRunSafe(client.id, {
      statut: 'succes',
      message: `${cfe.docs.length} CFE + ${tf.docs.length} taxe fonciere` + (messagerie ? ` + ${msg.docs.length} message(s)` : '') + ` recupere(s)` + (existants ? `, ${existants} deja present(s)` : ''),
      nb_docs: nouveaux,
    });
    log(`Termine : ${nouveaux} nouveau(x), ${existants} deja present(s).`);
    return { ok: true, docs: [...cfe.docs, ...tf.docs, ...msg.docs] };
  } catch (err) {
    const shot = resolve(clientDir, `_debug_${Date.now()}.png`);
    await page.screenshot({ path: shot, fullPage: true }).catch(() => {});
    addRunSafe(client.id, { statut: 'echec', message: err.message, nb_docs: 0 });
    log(`ERREUR : ${err.message}`);
    return { ok: false, error: err.message, docs: [] };
  }
}

// Session VISIBLE : connexion manuelle (captcha) PUIS recuperation. La fenetre est
// reduite (minimisee) des la connexion detectee -> la recup tourne en arriere-plan,
// hors de vue, mais avec la session intacte (impots refuse une session headless).
async function ouvrirSession() {
  const navTimeout = Number(process.env.NAV_TIMEOUT ?? 60000);
  // Sur serveur Linux (Docker, root), Chromium exige --no-sandbox ; --disable-dev-shm-usage evite
  // les plantages lies a la petite taille de /dev/shm en conteneur.
  const args = process.platform === 'linux' ? ['--no-sandbox', '--disable-dev-shm-usage'] : [];
  const browser = await chromium.launch({ headless: false, args }); // visible (captcha manuel)
  const context = await browser.newContext({ acceptDownloads: true, locale: 'fr-FR', viewport: { width: 1500, height: 950 } });
  const page = await context.newPage();
  page.setDefaultTimeout(navTimeout);
  return { browser, context, page, navTimeout };
}

// Reduit la fenetre Chromium (via CDP) : la recuperation se poursuit en arriere-plan.
async function minimiserFenetre(context, page, log) {
  try {
    const cdp = await context.newCDPSession(page);
    const { windowId } = await cdp.send('Browser.getWindowForTarget');
    await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'minimized' } });
    log('Connexion OK — fenetre reduite, recuperation en arriere-plan.');
  } catch (e) {
    log(`(reduction de la fenetre impossible : ${e.message.split('\n')[0]})`);
  }
}

/** Un client : connexion manuelle (visible) puis recuperation, fenetre reduite. */
export async function scrapeClient(client, opts = {}) {
  const log = (m) => { const line = `[${client.nom}] ${m}`; console.log(line); opts.onLog?.(line); };
  const { browser, context, page, navTimeout } = await ouvrirSession();
  try {
    await attendreConnexionManuelle(page, opts.cabinet, log);
    await minimiserFenetre(context, page, log);
    return await recupererClient(page, client, { baseFolder: opts.baseFolder, navTimeout, log, context, messagerie: opts.messagerie });
  } catch (err) {
    addRunSafe(client.id, { statut: 'echec', message: err.message, nb_docs: 0 });
    return { ok: false, error: err.message, docs: [] };
  } finally {
    await browser.close().catch(() => {});
  }
}

/** Tous les clients fournis : UNE connexion manuelle (visible), fenetre reduite, puis tout le lot. */
export async function scrapeAll(clients, opts = {}) {
  const log = (m) => { const line = `[lot] ${m}`; console.log(line); opts.onLog?.(line); };
  const resume = { total: clients.length, traites: 0, avecDocs: 0, docs: 0, echecs: 0 };
  const { browser, context, page, navTimeout } = await ouvrirSession();
  try {
    await attendreConnexionManuelle(page, opts.cabinet, log);
    await minimiserFenetre(context, page, log);
    log(`Traitement de ${clients.length} client(s)...`);
    for (let i = 0; i < clients.length; i++) {
      if (opts.shouldStop && opts.shouldStop()) { log('Arret demande.'); break; }
      const client = clients[i];
      const clog = (m) => { const line = `[${client.nom}] ${m}`; console.log(line); opts.onLog?.(line); };
      clog(`(${i + 1}/${clients.length})`);
      opts.onClient?.(client.nom);
      const r = await recupererClient(page, client, { baseFolder: opts.baseFolder, navTimeout, log: clog, context, messagerie: opts.messagerie });
      resume.traites++;
      const msg = r.ok ? `${r.docs.length} document(s)` : (r.error || 'erreur');
      opts.onResult?.({ nom: client.nom, ok: !!r.ok, message: msg, nb_docs: r.docs.length });
      if (r.ok) { if (r.docs.length) { resume.avecDocs++; resume.docs += r.docs.length; } }
      else resume.echecs++;
    }
    log(`Termine : ${resume.docs} document(s) pour ${resume.avecDocs}/${resume.traites} ; ${resume.echecs} echec(s).`);
    return { ok: true, resume };
  } catch (err) {
    log(`ERREUR session : ${err.message}`);
    return { ok: false, error: err.message, resume };
  } finally {
    await browser.close().catch(() => {});
  }
}

/** Liste les dossiers du cabinet (nom + SIREN) via "Voir tous mes dossiers". Connexion manuelle. */
export async function listerClients(cabinet, opts = {}) {
  const log = (m) => { const line = `[sync] ${m}`; console.log(line); opts.onLog?.(line); };
  const { browser, page } = await ouvrirSession();
  try {
    await attendreConnexionManuelle(page, cabinet, log);
    // Page 1
    await page.goto(TOUS_DOSSIERS_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
    await page.waitForTimeout(2000);
    const rows = [];
    const vus = new Set();
    const ajouter = (lot) => {
      let nouveaux = 0;
      for (const d of lot) { if (d.siren && !vus.has(d.siren)) { vus.add(d.siren); rows.push({ nom: d.nom, siret: d.siren }); nouveaux++; } }
      return nouveaux;
    };
    ajouter(await lireDossiersPage(page));
    log(`Page 1 : ${rows.length} dossier(s).`);

    // Nombre total de pages (le plus grand p=N parmi les liens de pagination)
    const pageMax = await page.evaluate(() => {
      let max = 1;
      for (const a of document.querySelectorAll('a[href*="afficherMesDossiers.do"]')) {
        const m = (a.getAttribute('href') || '').match(/[?&]p=(\d+)/);
        if (m) max = Math.max(max, parseInt(m[1], 10));
      }
      return max;
    }).catch(() => 1);

    // Pages suivantes : on suit directement les URL p=2..N (avec marge si N grandit en avancant)
    const plafond = 500;
    let p = 2, sansNouveau = 0;
    while (p <= plafond) {
      await page.goto(PAGE_DOSSIERS_URL(p), { waitUntil: 'domcontentloaded' }).catch(() => {});
      await page.waitForTimeout(1200);
      const lot = await lireDossiersPage(page);
      if (!lot.length) break; // plus de dossiers : on a depasse la derniere page
      const n = ajouter(lot);
      log(`Page ${p} : +${n} (total ${rows.length})`);
      if (n === 0) { if (++sansNouveau >= 2) break; } else sansNouveau = 0;
      // si on a atteint le max annonce et qu'aucune page suivante n'apparait, on s'arrete
      if (p >= pageMax) {
        const encore = await page.evaluate((cur) => {
          for (const a of document.querySelectorAll('a[href*="afficherMesDossiers.do"]')) {
            const m = (a.getAttribute('href') || '').match(/[?&]p=(\d+)/);
            if (m && parseInt(m[1], 10) > cur) return true;
          }
          return false;
        }, p).catch(() => false);
        if (!encore) break;
      }
      p++;
    }
    log(`${rows.length} dossier(s) liste(s) sur ${p >= pageMax ? p : pageMax} page(s).`);
    return rows;
  } finally {
    await browser.close().catch(() => {});
  }
}
