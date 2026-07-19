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
import { launchArgs } from './navigateur.js';
import { sanitize } from './scraper-commun.js';
import { verifierEtClasser, extraireTextePdf, detecterPaiementCfe } from './validation-pdf.js';
import * as captchaRelais from './captcha-relais.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DOWNLOADS_DIR = resolve(__dirname, '..', 'downloads');
// Tableaux d'habilitations : rangés par COMPTE espace pro (pas par client).
export const HABILITATIONS_DIR = resolve(DOWNLOADS_DIR, '_habilitations');

const ACCUEIL_URL = 'https://cfspro.impots.gouv.fr/';
// Page d'accueil de l'espace pro pour les NOUVEAUX parcours (habilitations, TVA).
// Surchargeable (tests locaux contre un site factice) : IMPOTS_ACCUEIL_URL.
const accueilUrl = () => process.env.IMPOTS_ACCUEIL_URL || ACCUEIL_URL;
const CFE_CHOISIR_URL = 'https://cfspro.impots.gouv.fr/mire/afficherChoisirDossier.do?action=parTypeHablitation&idth=consulter.avis.cfe';
// Compte fiscal (consultation ADELIE) : meme selecteur de dossier par SIREN que CFE (9 cases).
const CF_CHOISIR_URL = 'https://cfspro.impots.gouv.fr/mire/afficherChoisirDossier.do?action=parTypeHablitation&idth=consulter.adelie.le+compte+fiscal';
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

function addRunSafe(clientId, run) {
  try {
    addRun(clientId, run);
  } catch (e) {
    console.warn(`(historique: ${e.message})`);
  }
}

// Champs de la page de connexion (idp.impots.gouv.fr). Cibles par "name" (les id ont un suffixe variable).
const LOGIN_USER_SEL = 'input[name="user"], input[type="email"]';
const LOGIN_PWD_SEL = 'input[name="password"], input[type="password"]';
const LOGIN_CAPTCHA_SEL = 'input[name="captcha"], #input-captcha';

// Connexion SEMI-AUTO : on pre-remplit e-mail + mot de passe ; il ne reste que la CAPTCHA a saisir.
async function attendreConnexionManuelle(page, cabinet, log) {
  log('Ouverture de la page de connexion impots...');
  await page.goto(ACCUEIL_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
  // Deja connecte ? sinon on attend l'accueil "mire" (max 5 min)
  if (/\/mire\//.test(page.url())) {
    log('Session deja active.');
    return;
  }

  // Pre-remplissage des identifiants (la captcha reste manuelle).
  const champUser = page.locator(LOGIN_USER_SEL).first();
  await champUser.waitFor({ state: 'visible', timeout: 20000 }).catch(() => {});
  const login = (cabinet?.login || '').trim();
  const pwd = cabinet?.password || '';
  if (login && (await champUser.isVisible().catch(() => false))) {
    try {
      await champUser.fill(login);
      if (pwd)
        await page
          .locator(LOGIN_PWD_SEL)
          .first()
          .fill(pwd)
          .catch(() => {});
      if (pwd) {
        log('E-mail et mot de passe pre-remplis. >>> SAISIS LA CAPTCHA puis clique sur Connexion. <<<');
        await page
          .locator(LOGIN_CAPTCHA_SEL)
          .first()
          .focus()
          .catch(() => {});
      } else {
        log('E-mail pre-rempli. Saisis ton mot de passe + la captcha (aucun mot de passe enregistre).');
      }
    } catch (e) {
      log(`(pre-remplissage : ${e.message.split('\n')[0]})`);
    }
  } else {
    log('Connecte-toi dans le navigateur (identifiants + captcha).');
  }

  // Relais captcha : capture l'IMAGE du captcha et la publie dans le portail —
  // l'utilisateur la recopie dans l'interface, sans ouvrir noVNC (qui reste dispo).
  const capturerCaptcha = async () => {
    const img = page.locator('img[src*="captcha" i], img[id*="captcha" i], img[alt*="captcha" i]').first();
    if (await img.count().catch(() => 0)) return await img.screenshot().catch(() => null);
    // Repli : zone du champ captcha (l'image est a cote), a defaut rien.
    const champ = page.locator(LOGIN_CAPTCHA_SEL).first();
    if (await champ.count().catch(() => 0)) {
      const parent = champ.locator('xpath=ancestor::*[2]');
      return await parent.screenshot().catch(() => null);
    }
    return null;
  };
  const bufCaptcha = login && pwd ? await capturerCaptcha() : null;
  if (bufCaptcha) {
    captchaRelais.ouvrir({
      image: bufCaptcha,
      // Code tape dans le portail : on le recopie dans la page et on se connecte.
      soumettre: async (code) => {
        await page.locator(LOGIN_CAPTCHA_SEL).first().fill(code);
        const btn = page.locator('button[type="submit"], input[type="submit"], #submit, button:has-text("Connexion")').first();
        if (await btn.count().catch(() => 0)) await btn.click().catch(() => {});
        else
          await page
            .locator(LOGIN_CAPTCHA_SEL)
            .first()
            .press('Enter')
            .catch(() => {});
        await page.waitForTimeout(3500);
        if (/cfspro\.impots\.gouv\.fr\/mire\//.test(page.url())) return { ok: true, connecte: true };
        // Toujours sur la page de connexion : code refuse -> nouvelle image.
        const nouvelle = await capturerCaptcha();
        if (nouvelle) captchaRelais.majImage(nouvelle);
        return { ok: false, refuse: true, ...captchaRelais.etat() };
      },
      rafraichir: async () => {
        const b = await capturerCaptcha();
        if (b) captchaRelais.majImage(b);
      },
    });
    log('Captcha affichée dans le portail (bandeau en haut) : saisis le code directement — ou via la fenêtre « Captcha » (noVNC).');
  }

  // Attend la connexion effective (redirection vers l'espace pro), max 5 min.
  try {
    await page.waitForURL(/cfspro\.impots\.gouv\.fr\/mire\/(accueil|afficherChoisirDossier|rechercherDossiers)/, { timeout: 300000 });
  } finally {
    captchaRelais.fermer();
  }
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
  const quarantaines = [];
  let nonVerifiables = 0;
  for (let i = 0; i < n; i++) {
    const lien = liens.nth(i);
    const ligneTxt = (await lien.evaluate((el) => el.closest('tr')?.innerText || '').catch(() => '')).replace(/\s+/g, ' ');
    const ref = (ligneTxt.match(/\d{10,15}/) || [])[0] || `${prefixe}${i + 1}`;
    const annee = (ligneTxt.match(/\b20\d{2}\b/) || [])[0] || '';
    const eid = `${prefixe}_${ref}`;
    const dest = resolve(clientDir, `${prefixe}_${annee ? annee + '_' : ''}${ref}.pdf`);
    if (existsSync(dest) || getDocumentByEventid(client.id, eid)) {
      existants++;
      try {
        addDocument(client.id, { libelle: `${prefixe} ${annee} ${ref}`, fichier: dest, eventid: eid });
      } catch {}
      continue;
    }
    try {
      const [dl] = await Promise.all([page.waitForEvent('download', { timeout: navTimeout }), lien.click()]);
      await dl.saveAs(dest);
      // Verification d'appartenance : l'avis doit mentionner le SIREN ou le nom du client.
      const verif = await verifierEtClasser({ fichier: dest, source: 'impots', client });
      if (verif.verdict === 'quarantaine') {
        quarantaines.push(verif.raison);
        log(`⚠️ QUARANTAINE : ${verif.raison}`);
        continue; // pas d'addDocument -> retelecharge et reverifie au prochain run
      }
      if (verif.verdict === 'non_verifiable') nonVerifiables++;
      // Avis CFE et taxe fonciere : detection du mode de paiement mentionne
      // dans le PDF (prelevement a l'echeance / mensualisation / aucun).
      let paiement = null;
      if (prefixe === 'CFE' || prefixe === 'TF') {
        const texte = await extraireTextePdf(dest).catch(() => null);
        paiement = (texte && detecterPaiementCfe(texte)) || 'inconnu';
      }
      try {
        addDocument(client.id, { libelle: `${prefixe} ${annee} ${ref}`, fichier: dest, eventid: eid, paiement });
      } catch {}
      docs.push({ libelle: `${prefixe} ${annee}`, fichier: dest });
      log(`OK : ${prefixe}_${annee}_${ref}.pdf${paiement && paiement !== 'inconnu' ? ` (paiement : ${paiement})` : ''}`);
    } catch (e) {
      log(`(${prefixe} ${i + 1} : ${e.message.split('\n')[0]})`);
    }
  }
  return { docs, existants, quarantaines, nonVerifiables };
}

// Messagerie securisee "Mes echanges" (gaia2) d'un dossier : enregistre le TEXTE de
// chaque echange (+ pieces jointes si presentes) dans <clientDir>/Messagerie, par ordre
// chronologique. La liste est une datatable PrimeFaces ; ouvrir un N° deplie le message.
async function recupererMessagerie(page, context, client, clientDir, navTimeout, log) {
  const siren = String(client.siret || '')
    .replace(/\D/g, '')
    .slice(0, 9);
  const dir = resolve(clientDir, 'Messagerie');
  mkdirSync(dir, { recursive: true });
  const docs = [];
  let existants = 0;
  const quarantaines = [];
  let nonVerifiables = 0;
  try {
    // 1. Choix du dossier sous l'habilitation "messagerie" (peut ouvrir un nouvel onglet)
    await page.goto(MSG_CHOISIR_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
    await page.waitForTimeout(1000);
    await remplirCasesSiren(page, siren);
    // Detection rapide « Vous n'avez aucune habilitation... » : la page d'erreur revient
    // immediatement apres le clic ACCEDER -> inutile d'attendre le popup gaia (8 s x2).
    const sansHabilitation = () =>
      page
        .waitForFunction(() => /aucune habilitation/i.test(document.body?.innerText || ''), null, { timeout: 2500 })
        .then(() => true)
        .catch(() => false);
    let popup = null;
    const popupAttendu = context.waitForEvent('page', { timeout: 8000 }).catch(() => null);
    await page
      .locator('input[name="button.submitValider"], input[type="image"]')
      .first()
      .click()
      .catch(() => {});
    if (await sansHabilitation()) {
      log('Messagerie : pas d’habilitation pour ce dossier — passage au suivant.');
      return { docs, existants, info: 'sans habilitation messagerie' };
    }
    popup = await popupAttendu;
    if (/rechercherDossiers/i.test(page.url())) {
      const radio = page.locator('input[name="idDossier"], #sel0').first();
      if ((await radio.count()) && !(await radio.isChecked().catch(() => false))) await radio.check().catch(() => {});
      const popupAttendu2 = context.waitForEvent('page', { timeout: 8000 }).catch(() => popup);
      await page
        .locator('input[name="button.submitValider"], input[type="image"]')
        .first()
        .click()
        .catch(() => {});
      if (await sansHabilitation()) {
        log('Messagerie : pas d’habilitation pour ce dossier — passage au suivant.');
        return { docs, existants, info: 'sans habilitation messagerie' };
      }
      popup = await popupAttendu2;
    }
    const gaia = popup || page;
    if (popup) await popup.waitForLoadState('domcontentloaded').catch(() => {});
    else if (!/gaia2/i.test(page.url())) await page.goto(GAIA_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
    // Attendre le rendu de la datatable : liens de demandes OU « Aucune demande trouvée »
    // (sortie des que l'un apparait — plus rapide ET plus fiable qu'un delai fixe).
    await gaia
      .waitForFunction(
        () =>
          !!document.querySelector('a[id^="listeDemandesForm:listeDemandes:"][id$=":numDemande"]') ||
          /aucune demande trouv/i.test(document.body?.innerText || ''),
        null,
        { timeout: 12000 },
      )
      .catch(() => {});

    // 2. Enumeration des echanges (num + objet + date)
    const echanges = await gaia
      .evaluate(() =>
        Array.from(document.querySelectorAll('a[id^="listeDemandesForm:listeDemandes:"][id$=":numDemande"]')).map((a) => {
          const tds = Array.from(a.closest('tr')?.querySelectorAll('td') || []).map((td) => (td.textContent || '').replace(/\s+/g, ' ').trim());
          return { num: (a.textContent || '').trim(), id: a.id, objet: tds[1] || '', service: tds[2] || '', date: tds[5] || '' };
        }),
      )
      .catch(() => []);
    if (!echanges.length) {
      log('Messagerie : aucune demande — passage au suivant.');
      if (popup) await popup.close().catch(() => {});
      return { docs, existants, quarantaines, nonVerifiables };
    }
    // Comparaison IMMEDIATE des numeros avec la base : si aucun nouveau, on passe
    // au dossier suivant sans derouler la liste (les connus ne sont jamais rouverts).
    const nouveauxEchanges = echanges.filter((e) => !getDocumentByEventid(client.id, `MSG_${e.num}`));
    if (!nouveauxEchanges.length) {
      existants += echanges.length;
      log(`Messagerie : ${echanges.length} échange(s), aucun nouveau — passage au suivant.`);
      if (popup) await popup.close().catch(() => {});
      return { docs, existants, quarantaines, nonVerifiables };
    }
    existants += echanges.length - nouveauxEchanges.length;
    // ordre chronologique (date de création croissante)
    const cle = (d) => (d || '').split('/').reverse().join('');
    nouveauxEchanges.sort((a, b) => cle(a.date).localeCompare(cle(b.date)));
    log(`Messagerie : ${echanges.length} échange(s), ${nouveauxEchanges.length} nouveau(x).`);

    for (const e of nouveauxEchanges) {
      const base = sanitize(`${(e.date || '').replace(/\//g, '-')}_${e.num}_${e.objet}`).slice(0, 110);
      const dest = resolve(dir, `${base}.txt`);
      const eid = `MSG_${e.num}`;
      if (existsSync(dest) || getDocumentByEventid(client.id, eid)) {
        existants++;
        try {
          addDocument(client.id, { libelle: `Message ${e.date} ${e.objet}`.slice(0, 150), fichier: dest, eventid: eid });
        } catch {}
        continue;
      }
      try {
        // Texte de la page AVANT ouverture : sert au repli « diff » (le texte apparu
        // apres le clic est le contenu du message, quel que soit le markup gaia2).
        const avantClic = await gaia.evaluate(() => document.body.innerText || '').catch(() => '');
        await gaia
          .locator(`[id="${e.id}"]`)
          .first()
          .click({ timeout: navTimeout })
          .catch(() => {});
        await gaia.waitForTimeout(1400);
        // Extraction en cascade : 1) bloc "Objet :" + "De :/A :" ; 2) "Objet :" seul ;
        // 3) ligne de detail depliee PrimeFaces (row expansion) ; 4) dialogue visible.
        const extraireTexte = () =>
          gaia
            .evaluate(() => {
              const nettoyer = (t) =>
                String(t || '')
                  .replace(/[ \t]+\n/g, '\n')
                  .replace(/\n{3,}/g, '\n\n')
                  .trim();
              let best = null,
                len = 1e9;
              for (const el of document.querySelectorAll('td,div,fieldset,section')) {
                const t = el.innerText || '';
                if (/Objet\s*:/.test(t) && /(De|A)\s*:/.test(t) && t.length > 40 && t.length < len) {
                  best = el;
                  len = t.length;
                }
              }
              if (!best) {
                for (const el of document.querySelectorAll('td,div,fieldset,section')) {
                  const t = el.innerText || '';
                  if (/Objet\s*:/.test(t) && t.length > 20 && t.length < len) {
                    best = el;
                    len = t.length;
                  }
                }
              }
              if (best) return nettoyer(best.innerText);
              let detail = '';
              for (const tr of document.querySelectorAll('tr.ui-expanded-row-content')) {
                const t = (tr.innerText || '').trim();
                if (t.length > detail.length) detail = t;
              }
              if (detail.length > 10) return nettoyer(detail);
              for (const d of document.querySelectorAll('.ui-dialog')) {
                if (d.offsetParent !== null) {
                  const t = (d.querySelector('.ui-dialog-content')?.innerText || '').trim();
                  if (t.length > 10) return nettoyer(t);
                }
              }
              return '';
            })
            .catch(() => '');
        let texte = await extraireTexte();
        if (!texte) {
          // L'AJAX PrimeFaces peut etre lent a deplier le message : seconde chance.
          await gaia.waitForTimeout(2000);
          texte = await extraireTexte();
        }
        if (!texte && avantClic) {
          // Dernier repli : les lignes APPARUES depuis le clic = contenu du message.
          const apresClic = await gaia.evaluate(() => document.body.innerText || '').catch(() => '');
          const connues = new Set(avantClic.split('\n').map((l) => l.trim()));
          const nouvelles = apresClic
            .split('\n')
            .map((l) => l.trim())
            .filter((l) => l && !connues.has(l));
          if (nouvelles.join('').length > 10) texte = nouvelles.slice(0, 200).join('\n');
        }
        if (!texte) {
          // Diagnostic : capture de l'ecran pour comprendre l'affichage de ce type de message.
          await gaia.screenshot({ path: resolve(dir, `_diag_msg_${e.num}.png`), fullPage: true }).catch(() => {});
        }
        // Filet de securite : MEME sans texte extrait, on enregistre le message (sinon
        // il n'apparait pas dans l'onglet Messages alors que ses PJ sont recuperees).
        const corps =
          texte || '(Texte non extrait automatiquement — consulter la messagerie sur impots.gouv.fr. Pièces jointes récupérées ci-dessous le cas échéant.)';
        writeFileSync(dest, `N° ${e.num} — ${e.objet}\nService : ${e.service}\nDate : ${e.date}\n${'-'.repeat(60)}\n\n${corps}\n`, 'utf8');
        try {
          addDocument(client.id, { libelle: `Message ${e.date} ${e.objet}`.slice(0, 150), fichier: dest, eventid: eid });
        } catch {}
        docs.push({ libelle: `Message ${e.date}`, fichier: dest });
        log(texte ? `OK : ${base}.txt` : `OK (texte non extrait, message enregistré quand même) : ${base}.txt`);
        // Pieces jointes : liens PrimeFaces (id finissant par ":downloadFile", texte = nom
        // du fichier), limites a la ligne du message ouvert (index de la datatable).
        const idx = (e.id.match(/listeDemandes:(\d+):/) || [])[1];
        const pjSel = idx != null ? `a[id^="listeDemandesForm:listeDemandes:${idx}:"][id$="downloadFile"]` : 'a[id$="downloadFile"]';
        const pjLiens = gaia.locator(pjSel);
        const npj = await pjLiens.count().catch(() => 0);
        for (let k = 0; k < npj; k++) {
          try {
            const nomLien = (
              await pjLiens
                .nth(k)
                .innerText()
                .catch(() => '')
            ).trim();
            const [dl] = await Promise.all([gaia.waitForEvent('download', { timeout: navTimeout }), pjLiens.nth(k).click()]);
            const nomPj = sanitize(dl.suggestedFilename() || nomLien || `${e.num}_pj${k + 1}`);
            const destPj = resolve(dir, `${(e.date || '').replace(/\//g, '-')}_${nomPj}`);
            await dl.saveAs(destPj);
            // Verification d'appartenance des PJ au format PDF (les scans restent tolerés).
            if (/\.pdf$/i.test(destPj)) {
              const verif = await verifierEtClasser({ fichier: destPj, source: 'impots', client });
              if (verif.verdict === 'quarantaine') {
                quarantaines.push(verif.raison);
                log(`⚠️ QUARANTAINE : ${verif.raison}`);
                continue; // pas d'addDocument -> retelechargee et reverifiee au prochain run
              }
              if (verif.verdict === 'non_verifiable') nonVerifiables++;
            }
            try {
              addDocument(client.id, { libelle: `PJ ${e.date} ${nomPj}`.slice(0, 150), fichier: destPj, eventid: `${eid}_PJ${k + 1}` });
            } catch {}
            docs.push({ libelle: `PJ ${e.date}`, fichier: destPj });
            log(`OK (PJ) : ${nomPj}`);
          } catch {
            /* pas de telechargement pour ce lien */
          }
        }
      } catch (err) {
        log(`(message ${e.num} : ${err.message.split('\n')[0]})`);
      }
    }
    if (popup) await popup.close().catch(() => {});
  } catch (err) {
    log(`Messagerie : ${err.message.split('\n')[0]}`);
  }
  return { docs, existants, quarantaines, nonVerifiables };
}

// Phases de recuperation demandees (defaut : tout). opts.messagerie (ancien flag)
// reste accepte pour compatibilite (MCP, anciens appels).
// Dossier de rangement du tableau d'habilitations d'un compte espace pro.
export function dossierHabilitations(cabinet) {
  const cle = sanitize(`${cabinet?.id ?? 'compte'}_${cabinet?.libelle || cabinet?.login || 'espace_pro'}`);
  return resolve(HABILITATIONS_DIR, cle);
}

// Clique le 1er element (lien/bouton/onglet/menu) dont le libelle correspond a l'un des
// motifs. Robuste aux menus PrimeFaces (essaie plusieurs roles + texte brut). true si clique.
export async function cliquerParTexte(page, motifs, { timeout = 6000 } = {}) {
  for (const m of motifs) {
    const re = m instanceof RegExp ? m : new RegExp(m, 'i');
    const candidats = [
      page.getByRole('link', { name: re }),
      page.getByRole('button', { name: re }),
      page.getByRole('menuitem', { name: re }),
      page.getByRole('tab', { name: re }),
      page.locator('a, button, span[onclick], td[onclick], li[onclick]').filter({ hasText: re }),
    ];
    for (const loc of candidats) {
      const el = loc.first();
      if (await el.count().catch(() => 0)) {
        try {
          await el.scrollIntoViewIfNeeded({ timeout: 1500 }).catch(() => {});
          await el.click({ timeout });
          return true;
        } catch {
          /* candidat suivant */
        }
      }
    }
  }
  return false;
}

// Ecrit une capture + le HTML de la page (diagnostic pour caler les selecteurs a l'aveugle).
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

// Retrouve la fenetre ADELIE (consultation compte fiscal) parmi toutes les fenetres du
// contexte. La selection du dossier soumet vers une fenetre NOMMEE "EServices" (souvent
// reutilisee d'un client a l'autre) : le simple waitForEvent('page') ne suffit pas.
async function attendreFenetreAdelie(context, timeout = 12000) {
  const debut = Date.now();
  while (Date.now() - debut < timeout) {
    const p = context.pages().find((pg) => /adelie2mapi/i.test(pg.url()));
    if (p) {
      await p.waitForLoadState('domcontentloaded').catch(() => {});
      return p;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return null;
}

// Ferme les fenetres residuelles (ADELIE/EServices/liste de dossiers) d'un client precedent,
// pour que la fenetre nommee "EServices" soit recreee proprement au client suivant.
async function fermerFenetresAnnexes(page) {
  for (const p of page.context().pages()) {
    if (p !== page && /adelie2mapi|mesDossiers|externRedirect|rechercherDossiers/i.test(p.url())) {
      await p.close().catch(() => {});
    }
  }
}

// Remplit les 9 cases SIREN (#siren0..8) d'un sélecteur de dossier impots (mire). Renvoie
// le nombre de cases trouvées (9 si la page de choix du dossier est bien présente).
async function remplirCasesSiren(page, siren) {
  let n = 0;
  for (let i = 0; i < 9; i++) {
    const box = page.locator(`#siren${i}`);
    if (await box.count().catch(() => 0)) {
      await box.fill(siren[i] || '').catch(() => {});
      n++;
    }
  }
  return n;
}

// ITEM 1 — Tableau des habilitations du COMPTE (Gerer > Consulter mes services > Tout telecharger).
// Une fois par session. Ne leve jamais : renvoie {ok, fichier} ou {ok:false, error} + diagnostic.
export async function telechargerHabilitations(page, cabinet, { navTimeout, log }) {
  const dir = dossierHabilitations(cabinet);
  mkdirSync(dir, { recursive: true });
  try {
    log('Habilitations : ouverture de « Gérer ▸ Gérer les services ».');
    await page.goto(accueilUrl(), { waitUntil: 'domcontentloaded' }).catch(() => {});
    await page.waitForTimeout(1500);
    // Le lien « Gérer les services » ouvre l'appli E-Services dans une NOUVELLE fenetre
    // (target="EServices"), via /mire/externRedirect.do?idurlm=gerer.services&...&token=<session>.
    // On cible ce lien precisement (idurlm=gerer.services), on capture le popup ; a defaut on
    // rouvre son URL (avec le token) dans un nouvel onglet de la MEME session.
    const lien = page.locator('a[href*="gerer.services"]').first();
    if (!(await lien.count().catch(() => 0))) {
      await dumpDiag(page, dir, 'menu');
      throw new Error('lien « Gérer les services » introuvable');
    }
    let espace = null;
    const [popup] = await Promise.all([
      page
        .context()
        .waitForEvent('page', { timeout: 8000 })
        .catch(() => null),
      lien.click({ timeout: 6000 }).catch(() => {}),
    ]);
    espace = popup;
    if (!espace) {
      // Repli : ouvrir directement l'URL du lien (le token de session y est present).
      const href = await lien.getAttribute('href').catch(() => null);
      if (!href) {
        await dumpDiag(page, dir, 'menu');
        throw new Error('lien « Gérer les services » sans URL');
      }
      espace = await page.context().newPage();
      await espace.goto(new URL(href, page.url()).href, { waitUntil: 'domcontentloaded' }).catch(() => {});
    }
    await espace.waitForLoadState('domcontentloaded').catch(() => {});
    await espace.waitForTimeout(3000);
    // Page E-Services atteinte : diagnostic systematique (pour caler « Consulter mes services »
    // et le bouton de telechargement, dont on ignore le libelle exact).
    await dumpDiag(espace, dir, 'eservices');
    await cliquerParTexte(espace, [/consulter mes services/i]).catch(() => {});
    await espace.waitForTimeout(1500);
    await dumpDiag(espace, dir, 'services');
    // Telechargement du tableau (plusieurs libelles possibles).
    const clic = cliquerParTexte(espace, [
      /tout télécharger/i,
      /tout telecharger/i,
      /télécharger le tableau/i,
      /télécharger la liste/i,
      /exporter/i,
      /télécharger/i,
    ]);
    const [dl, ok] = await Promise.all([espace.waitForEvent('download', { timeout: navTimeout }).catch(() => null), clic]);
    if (!ok || !dl) {
      await dumpDiag(espace, dir, 'telecharger');
      await espace.close().catch(() => {});
      throw new Error('bouton de téléchargement introuvable ou aucun téléchargement');
    }
    const base = sanitize(dl.suggestedFilename() || 'habilitations.pdf');
    const dest = resolve(dir, `${new Date().toISOString().slice(0, 10)}_${base}`);
    await dl.saveAs(dest);
    await espace.close().catch(() => {});
    log(`Habilitations : tableau enregistré (${dest.split(/[\\/]/).pop()}).`);
    return { ok: true, fichier: dest };
  } catch (e) {
    log(`Habilitations : échec — ${e.message} (diagnostic dans ${dir}).`);
    return { ok: false, error: e.message };
  }
}

// ITEM 2 — Tableau des declarations de TVA d'un CLIENT (Consulter > Compte fiscal > SIREN >
// Consulter > Acces par impot > TVA > Declarations > Telecharger le tableau). Ne leve jamais :
// renvoie {docs, existants[, info]} comme les autres phases. Anti-doublon : 1 tableau / jour.
export async function telechargerTvaDeclarations(page, client, clientDir, siren, navTimeout, log) {
  const jour = new Date().toISOString().slice(0, 10);
  const eid = `TVA_DECL_${jour}`;
  if (getDocumentByEventid(client.id, eid)) {
    log('TVA : tableau déjà récupéré aujourd’hui — ignoré.');
    return { docs: [], existants: 1 };
  }
  try {
    log('TVA : accès au compte fiscal (sélection du dossier par SIREN).');
    // Nettoie une eventuelle fenetre ADELIE/EServices d'un client precedent (fenetre nommee reutilisee).
    await fermerFenetresAnnexes(page);
    // 1. Selecteur de dossier du compte fiscal (meme mecanique que CFE : 9 cases + bouton image).
    await page.goto(CF_CHOISIR_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
    await page.waitForTimeout(1500);
    const champs = await remplirCasesSiren(page, siren);
    if (champs < 9) {
      await dumpDiag(page, clientDir, 'tva_choisir');
      throw new Error('page de choix du dossier compte fiscal introuvable (cases SIREN absentes)');
    }
    // 1b. « Consulter » (submit) -> liste des dossiers (rechercherDossiers.do, meme onglet).
    await page
      .locator('input[name="button.submitValider"], input[type="image"]')
      .first()
      .click()
      .catch(() => {});
    await page.waitForLoadState('domcontentloaded').catch(() => {});
    await page.waitForTimeout(2500);
    let cf = page;
    // 2. Liste de dossiers -> selection du dossier + valider. Le formulaire soumet vers une
    //    fenetre NOMMEE "EServices" (ADELIE) : on capture le popup, avec repli sur le balayage
    //    de toutes les fenetres du contexte (fenetre reutilisee entre clients).
    if (/rechercherDossiers/i.test(page.url())) {
      const radio = page.locator('input[name="idDossier"], #sel0').first();
      if (await radio.count().catch(() => 0)) {
        if (!(await radio.isChecked().catch(() => false))) await radio.check().catch(() => {});
      }
      const [popup2] = await Promise.all([
        page
          .context()
          .waitForEvent('page', { timeout: 8000 })
          .catch(() => null),
        page
          .locator('input[name="button.submitValider"], input[type="image"]')
          .first()
          .click()
          .catch(() => {}),
      ]);
      cf = popup2 || (await attendreFenetreAdelie(page.context())) || page;
      await cf.waitForLoadState('domcontentloaded').catch(() => {});
      await cf.waitForTimeout(3000);
    }
    // 3. Consultation ADELIE atteinte. Le menu porte des liens stables : on lit l'URL de
    //    l'entree « déclarations TVA » (#menu_form:tva_declarations -> declarations_tva.xhtml
    //    ?emetteur=ADELIE_2&num_ocfi=<dossier>) et on y va directement (le num_ocfi varie par
    //    client -> impossible a figer, on le recupere sur la page).
    log(`TVA : page compte fiscal = ${cf.url()}`);
    const lienDecl = cf.locator('a#menu_form\\:tva_declarations, a[id$="tva_declarations"]').first();
    if (!(await lienDecl.count().catch(() => 0))) {
      // Sur ADELIE mais pas d'entree TVA = dossier non assujetti (asso, SCI a l'IR...) : cas normal.
      if (/adelie2mapi/i.test(cf.url())) {
        if (cf !== page) await cf.close().catch(() => {});
        log('TVA : ce dossier n’a pas d’accès « déclarations TVA » (non assujetti) — ignoré.');
        return { docs: [], existants: 0, info: 'pas d’accès TVA pour ce dossier' };
      }
      // Sinon la consultation compte fiscal n'a pas ete atteinte : vrai probleme.
      await dumpDiag(cf, clientDir, 'tva_comptefiscal');
      throw new Error(`compte fiscal non atteint — page ${cf.url()}`);
    }
    const hrefDecl = await lienDecl.getAttribute('href').catch(() => null);
    if (!hrefDecl) {
      await dumpDiag(cf, clientDir, 'tva_comptefiscal');
      throw new Error('lien « déclarations TVA » sans URL');
    }
    await cf.goto(new URL(hrefDecl, cf.url()).href, { waitUntil: 'domcontentloaded' }).catch(() => {});
    await cf.waitForTimeout(2500);
    log(`TVA : page déclarations = ${cf.url()}`);
    await dumpDiag(cf, clientDir, 'tva_declarations');
    // 4. Telechargement du tableau des declarations (sur declarations_tva.xhtml).
    const clic = cliquerParTexte(cf, [/télécharger le tableau/i, /telecharger le tableau/i, /exporter le tableau/i, /exporter/i, /télécharger/i]);
    const [dl, ok] = await Promise.all([cf.waitForEvent('download', { timeout: navTimeout }).catch(() => null), clic]);
    if (!ok || !dl) {
      await dumpDiag(cf, clientDir, 'tva_telecharger');
      throw new Error('bouton de téléchargement du tableau TVA introuvable ou aucun téléchargement');
    }
    const base = sanitize(dl.suggestedFilename() || `TVA_declarations_${siren}`);
    const dest = resolve(clientDir, `TVA_${jour}_${base}`);
    await dl.saveAs(dest);
    try {
      addDocument(client.id, { libelle: `Déclarations TVA (${jour})`, fichier: dest, eventid: eid });
    } catch {
      /* doublon éventuel ignoré */
    }
    log(`TVA : tableau des déclarations enregistré (${dest.split(/[\\/]/).pop()}).`);
    if (cf !== page) await cf.close().catch(() => {});
    return { docs: [{ libelle: 'Déclarations TVA', fichier: dest }], existants: 0 };
  } catch (e) {
    await fermerFenetresAnnexes(page).catch(() => {});
    log(`TVA : non récupéré — ${e.message} (diagnostic dans le dossier du client).`);
    return { docs: [], existants: 0, info: `non récupérée (${e.message})` };
  }
}

function phasesDe(opts = {}) {
  const p = opts.phases || {};
  return {
    cfe: p.cfe !== false,
    tf: p.tf !== false,
    messagerie: (p.messagerie ?? opts.messagerie) !== false,
    tva: p.tva === true, // opt-in : jamais activée sans demande explicite
  };
}

// Traite UN client (SIREN) sur une page deja connectee, selon les phases demandees
// (CFE, taxe fonciere, messagerie) — permet des lots plus courts par type de document.
async function recupererClient(page, client, { baseFolder, navTimeout, log, context, phases }) {
  const siren = String(client.siret || '')
    .replace(/\D/g, '')
    .slice(0, 9);
  let clientDir;
  if (client.dossier && client.dossier.trim()) clientDir = client.dossier.trim();
  else if (baseFolder && baseFolder.trim()) clientDir = resolve(baseFolder.trim(), sanitize(client.nom));
  else clientDir = resolve(DOWNLOADS_DIR, sanitize(`${client.id}_${client.nom}`));
  mkdirSync(clientDir, { recursive: true });

  try {
    if (siren.length < 9) throw new Error('SIREN invalide (9 chiffres requis).');
    let cfe = { docs: [], existants: 0, quarantaines: [], nonVerifiables: 0 };
    let tf = { docs: [], existants: 0, quarantaines: [], nonVerifiables: 0 };
    let msg = { docs: [], existants: 0, quarantaines: [], nonVerifiables: 0 };
    let tva = { docs: [], existants: 0 };
    // Le choix de dossier « avis CFE » ne sert qu'aux avis (la messagerie a son propre
    // parcours) : on le saute entierement en mode « messagerie seule ».
    if (phases.cfe || phases.tf) {
      // 1. Choisir le dossier par SIREN
      await page.goto(CFE_CHOISIR_URL, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(1200);
      await remplirCasesSiren(page, siren);
      await page
        .locator('input[name="button.submitValider"], input[type="image"]')
        .first()
        .click()
        .catch(() => {});
      await page.waitForLoadState('domcontentloaded').catch(() => {});
      await page.waitForTimeout(2500);
      // 2. Liste de dossiers -> selection + CONSULTER
      if (/rechercherDossiers/i.test(page.url())) {
        const radio = page.locator('input[name="idDossier"], #sel0').first();
        if (await radio.count()) {
          if (!(await radio.isChecked().catch(() => false))) await radio.check().catch(() => {});
        }
        await Promise.all([
          page.waitForLoadState('domcontentloaded').catch(() => {}),
          page
            .locator('input[name="button.submitValider"], input[type="image"]')
            .first()
            .click()
            .catch(() => {}),
        ]);
        await page.waitForTimeout(3000);
      }
      // 3. Avis CFE
      if (phases.cfe) {
        await page.goto(CFE_AVIS_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
        await page.waitForTimeout(3000);
        cfe = await telechargerAvis(page, client, clientDir, 'CFE', '[id$="tableauAvisImposition_data"]', navTimeout, log);
      }
      // 4. Taxe fonciere
      if (phases.tf) {
        await page.goto(TF_AVIS_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
        await page.waitForTimeout(3000);
        tf = await telechargerAvis(page, client, clientDir, 'TF', '[id$="tableauAvisTaxeFonciere_data"]', navTimeout, log);
      }
    }
    // 5. Messagerie
    if (phases.messagerie) msg = await recupererMessagerie(page, context, client, clientDir, navTimeout, log);
    // 6. Declarations de TVA (compte fiscal, par SIREN)
    if (phases.tva) tva = await telechargerTvaDeclarations(page, client, clientDir, siren, navTimeout, log);

    const nouveaux = cfe.docs.length + tf.docs.length + msg.docs.length + tva.docs.length;
    const existants = cfe.existants + tf.existants + msg.existants + tva.existants;
    const quarantaines = [...(cfe.quarantaines || []), ...(tf.quarantaines || []), ...(msg.quarantaines || [])];
    const nonVerifiables = (cfe.nonVerifiables || 0) + (tf.nonVerifiables || 0) + (msg.nonVerifiables || 0);
    const parts = [];
    if (phases.cfe) parts.push(`${cfe.docs.length} CFE`);
    if (phases.tf) parts.push(`${tf.docs.length} taxe fonciere`);
    if (phases.messagerie) parts.push(msg.info ? `messagerie : ${msg.info}` : `${msg.docs.length} message(s)`);
    if (phases.tva) parts.push(tva.info ? `TVA : ${tva.info}` : `${tva.docs.length} TVA`);
    let message = `${parts.join(' + ')} recupere(s)` + (existants ? `, ${existants} deja present(s)` : '');
    if (nonVerifiables > 0) message += ` (${nonVerifiables} non verifiable(s) : PDF sans texte)`;
    if (quarantaines.length > 0) message = `⚠️ ${quarantaines.length} PDF mis en quarantaine — ${quarantaines.join(' ; ').slice(0, 300)}. ${message}`;
    addRunSafe(client.id, {
      statut: quarantaines.length > 0 ? 'echec' : 'succes',
      message,
      nb_docs: nouveaux,
    });
    log(`Termine : ${nouveaux} nouveau(x), ${existants} deja present(s).`);
    return { ok: true, docs: [...cfe.docs, ...tf.docs, ...msg.docs, ...tva.docs] };
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
  const browser = await chromium.launch({ headless: false, args: launchArgs({ visible: true }) }); // visible (captcha manuel)
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
  const log = (m) => {
    const line = `[${client.nom}] ${m}`;
    console.log(line);
    opts.onLog?.(line);
  };
  const { browser, context, page, navTimeout } = await ouvrirSession();
  try {
    await attendreConnexionManuelle(page, opts.cabinet, log);
    await minimiserFenetre(context, page, log);
    return await recupererClient(page, client, { baseFolder: opts.baseFolder, navTimeout, log, context, phases: phasesDe(opts) });
  } catch (err) {
    addRunSafe(client.id, { statut: 'echec', message: err.message, nb_docs: 0 });
    return { ok: false, error: err.message, docs: [] };
  } finally {
    await browser.close().catch(() => {});
  }
}

/** Tous les clients fournis : UNE connexion manuelle (visible), fenetre reduite, puis tout le lot. */
export async function scrapeAll(clients, opts = {}) {
  const log = (m) => {
    const line = `[lot] ${m}`;
    console.log(line);
    opts.onLog?.(line);
  };
  const resume = { total: clients.length, traites: 0, avecDocs: 0, docs: 0, echecs: 0 };
  const { browser, context, page, navTimeout } = await ouvrirSession();
  try {
    await attendreConnexionManuelle(page, opts.cabinet, log);
    await minimiserFenetre(context, page, log);
    // Tableau d'habilitations : une fois par session (par compte), avant les clients.
    if (opts.habilitations !== false && opts.cabinet) {
      await telechargerHabilitations(page, opts.cabinet, { navTimeout, log }).catch(() => {});
    }
    log(`Traitement de ${clients.length} client(s)...`);
    for (let i = 0; i < clients.length; i++) {
      if (opts.shouldStop && opts.shouldStop()) {
        log('Arret demande.');
        break;
      }
      const client = clients[i];
      const clog = (m) => {
        const line = `[${client.nom}] ${m}`;
        console.log(line);
        opts.onLog?.(line);
      };
      clog(`(${i + 1}/${clients.length})`);
      opts.onClient?.(client.nom);
      const r = await recupererClient(page, client, { baseFolder: opts.baseFolder, navTimeout, log: clog, context, phases: phasesDe(opts) });
      resume.traites++;
      const msg = r.ok ? `${r.docs.length} document(s)` : r.error || 'erreur';
      opts.onResult?.({ nom: client.nom, ok: !!r.ok, message: msg, nb_docs: r.docs.length });
      if (r.ok) {
        if (r.docs.length) {
          resume.avecDocs++;
          resume.docs += r.docs.length;
        }
      } else resume.echecs++;
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

/** Tableau des habilitations SEUL : connexion manuelle (captcha) puis téléchargement. */
export async function recupererHabilitations(cabinet, opts = {}) {
  const log = (m) => {
    const line = `[habilitations] ${m}`;
    console.log(line);
    opts.onLog?.(line);
  };
  const { browser, context, page, navTimeout } = await ouvrirSession();
  try {
    await attendreConnexionManuelle(page, cabinet, log);
    await minimiserFenetre(context, page, log);
    return await telechargerHabilitations(page, cabinet, { navTimeout, log });
  } catch (err) {
    log(`ERREUR : ${err.message}`);
    return { ok: false, error: err.message };
  } finally {
    await browser.close().catch(() => {});
  }
}

/** Liste les dossiers du cabinet (nom + SIREN) via "Voir tous mes dossiers". Connexion manuelle. */
export async function listerClients(cabinet, opts = {}) {
  const log = (m) => {
    const line = `[sync] ${m}`;
    console.log(line);
    opts.onLog?.(line);
  };
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
      for (const d of lot) {
        if (d.siren && !vus.has(d.siren)) {
          vus.add(d.siren);
          rows.push({ nom: d.nom, siret: d.siren });
          nouveaux++;
        }
      }
      return nouveaux;
    };
    ajouter(await lireDossiersPage(page));
    log(`Page 1 : ${rows.length} dossier(s).`);

    // Nombre total de pages (le plus grand p=N parmi les liens de pagination)
    const pageMax = await page
      .evaluate(() => {
        let max = 1;
        for (const a of document.querySelectorAll('a[href*="afficherMesDossiers.do"]')) {
          const m = (a.getAttribute('href') || '').match(/[?&]p=(\d+)/);
          if (m) max = Math.max(max, parseInt(m[1], 10));
        }
        return max;
      })
      .catch(() => 1);

    // Pages suivantes : on suit directement les URL p=2..N (avec marge si N grandit en avancant)
    const plafond = 500;
    let p = 2,
      sansNouveau = 0;
    while (p <= plafond) {
      await page.goto(PAGE_DOSSIERS_URL(p), { waitUntil: 'domcontentloaded' }).catch(() => {});
      await page.waitForTimeout(1200);
      const lot = await lireDossiersPage(page);
      if (!lot.length) break; // plus de dossiers : on a depasse la derniere page
      const n = ajouter(lot);
      log(`Page ${p} : +${n} (total ${rows.length})`);
      if (n === 0) {
        if (++sansNouveau >= 2) break;
      } else sansNouveau = 0;
      // si on a atteint le max annonce et qu'aucune page suivante n'apparait, on s'arrete
      if (p >= pageMax) {
        const encore = await page
          .evaluate((cur) => {
            for (const a of document.querySelectorAll('a[href*="afficherMesDossiers.do"]')) {
              const m = (a.getAttribute('href') || '').match(/[?&]p=(\d+)/);
              if (m && parseInt(m[1], 10) > cur) return true;
            }
            return false;
          }, p)
          .catch(() => false);
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
