// Connecteur impots.gouv.fr - espace professionnel (SEMI-AUTOMATIQUE).
//
// A cause du CAPTCHA, la connexion est MANUELLE : le robot ouvre un navigateur visible,
// TU te connectes (identifiants + captcha) UNE fois par session, puis le robot enchaine.
//
// Parcours (verifie le 12/10/2026, apres la refonte DSFR de l'espace pro) :
//   1. cfspro.impots.gouv.fr -> connexion manuelle -> mire/accueil.do
//   2. Lecture du JETON de session (?token=...) sur les liens de l'accueil : toute URL de la
//      zone « mire » l'exige desormais (voir jetonMire / selectionnerDossier plus bas).
//   3. mire/dossierSelect.do?idth=consulter.adelie.le_compte_fiscal&idDossier=<SIREN>&token=T
//      -> redirige dans l'onglet courant vers ADELIE2 avec le dossier selectionne (entree
//      « compte fiscal » : c'est elle qui ouvre les avis de tous les dossiers ; « avis CFE »
//      en repli seulement — voir ouvrirDossierAvis).
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
const CFE_AVIS_URL = 'https://cfspro.impots.gouv.fr/adelie2mapi/xhtml/impots/cfe/avis_cfe.xhtml?emetteur=ADELIE_2';
const TF_AVIS_URL = 'https://cfspro.impots.gouv.fr/adelie2mapi/xhtml/impots/tf/avisTaxeFonciere.xhtml?emetteur=ADELIE_2';
// Messagerie securisee "Mes echanges" (appli gaia2), PAR DOSSIER.
const GAIA_URL = 'https://cfspro.impots.gouv.fr/gaia2-zu-mapi/pages/pro/portailpro.xhtml';

// Zone « mire » (choix du dossier). Depuis la refonte DSFR de l'espace pro (oct. 2026), les
// anciennes URLs directes (afficherChoisirDossier.do + saisie du SIREN dans 9 cases, liste de
// radios rechercherDossiers.do, afficherMesDossiers.do) n'existent plus — elles repondent en
// erreur HTTP. TOUTE URL de cette zone exige un JETON de session (?token=...), unique et
// stable pour la session, lisible sur les liens de la page d'accueil :
//   - liste des dossiers   : afficherSelectionDossier.do?idth=<habilitation>[&p=N]&token=T
//   - ouverture d'un dossier : dossierSelect.do?idth=<habilitation>&idDossier=<SIREN>&token=T
//     -> redirige dans l'ONGLET COURANT vers l'appli cible (ADELIE pour les avis et le compte
//     fiscal, gaia2 pour la messagerie). Un SIREN hors portefeuille => page « Erreur » ; un
//     dossier sans l'habilitation demandee => HTTP 500 + « aucune habilitation » (cas normal).
// Surchargeable (tests locaux contre un site factice) : IMPOTS_MIRE_URL.
const mireBase = () => process.env.IMPOTS_MIRE_URL || 'https://cfspro.impots.gouv.fr/mire';
const HAB_AVIS = 'consulter.avis.cfe';
const HAB_COMPTE_FISCAL = 'consulter.adelie.le_compte_fiscal';
const HAB_MESSAGERIE = 'messagerie.gaia2.messagerie';

// Lit les dossiers (nom + SIREN) presents sur une page « Mes dossiers » : un lien par carte,
// dossierSelect.do?...&idDossier=<SIREN>, dont le texte est le nom du dossier.
export function lireDossiersPage(page) {
  return page.evaluate(() => {
    const out = [];
    for (const a of document.querySelectorAll('a[href*="dossierSelect.do"]')) {
      const m = (a.getAttribute('href') || '').match(/[?&]idDossier=([^&#]+)/);
      const nom = (a.textContent || '')
        .replace(/\s+/g, ' ')
        .replace(/SIREN.*/i, '')
        .replace(/\s*-?\s*nouvelle fen[eê]tre\s*$/i, '')
        .trim();
      if (m && nom) out.push({ nom: nom.slice(0, 120), siren: decodeURIComponent(m[1]).replace(/\s/g, '') });
    }
    return out;
  });
}

// ---- Jeton de session « mire » + selection d'un dossier -----------------------
const jetonsMire = new WeakMap(); // contexte navigateur -> jeton

const lireJetonSurPage = (page) =>
  page
    .evaluate(() => {
      for (const a of document.querySelectorAll('a[href*="token="]')) {
        const m = (a.getAttribute('href') || '').match(/[?&]token=([^&#]+)/);
        if (m) return decodeURIComponent(m[1]);
      }
      return null;
    })
    .catch(() => null);

/** Jeton de session de la zone « mire », lu sur les liens de l'accueil (mis en cache par
 *  contexte). `forcer` : le relit. Leve si la session a expire (retour sur la connexion). */
export async function jetonMire(page, { forcer = false } = {}) {
  const ctx = page.context();
  if (!forcer && jetonsMire.has(ctx)) return jetonsMire.get(ctx);
  await page.goto(`${mireBase()}/accueil.do`, { waitUntil: 'domcontentloaded' }).catch(() => {});
  let jeton = await lireJetonSurPage(page);
  if (!jeton) {
    await page.waitForTimeout(1500); // rendu lent
    jeton = await lireJetonSurPage(page);
  }
  if (!jeton) throw new Error('Session impôts expirée ou jeton de session introuvable (page d’accueil modifiée ?).');
  jetonsMire.set(ctx, jeton);
  return jeton;
}

// Fenetre portant l'appli cible (ADELIE / gaia2), si l'ouverture du dossier s'y est faite
// dans une AUTRE fenetre que l'onglet courant (ancien comportement, garde en repli).
async function attendreFenetreCible(page, timeout = 3000) {
  const debut = Date.now();
  while (Date.now() - debut < timeout) {
    const p = page
      .context()
      .pages()
      .find((pg) => pg !== page && /adelie2mapi|gaia2-zu-mapi/i.test(pg.url()));
    if (p) {
      await p.waitForLoadState('domcontentloaded').catch(() => {});
      return p;
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  return null;
}

// SIREN affiche dans l'en-tete de l'appli cible (« SIREN ou IDSP : 087020095 » sur ADELIE,
// « SIREN : ... » sur gaia2) — sert a verifier que le dossier ouvert est bien celui demande.
// Libelle releve le 12/10/2026 (« ou IDSP » faisait 11 caracteres : marge elargie a 25).
const sirenAffiche = (p) => p.evaluate(() => (document.body?.innerText.match(/SIREN[^0-9]{0,25}(\d{9})/i) || [])[1] || null).catch(() => null);

// ADELIE peut repondre « Erreur technique inattendue (Exception servlet) » pour un dossier, puis rester
// COINCE sur ce dossier pour tout le reste de la session : ADELIE affiche son SIREN et son erreur
// quel que soit le dossier ouvert ensuite (releve le 14/10/2026 : SCI MGEA 844156125, puis tous les
// clients suivants ; meme mecanisme probable le 13/10). Sans ce controle, ces clients etaient notes
// « sans habilitation » et « succes » a 0 document (~470 dossiers sur 628 le 13/10, 183 sur 200 le 14/10).
const adelieEnErreur = (p) =>
  p.evaluate(() => /erreur technique/i.test(document.title || '') || /erreur technique inattendue/i.test(document.body?.innerText || '')).catch(() => false);

// Tente de repartir sur une session ADELIE saine en supprimant les cookies PROPRES a ADELIE
// (chemin /adelie2mapi) ; ceux de la zone « mire » (connexion) ne sont pas touches. Renvoie les noms
// supprimes (jamais les valeurs). A VERIFIER sur un vrai lot : si ADELIE garde son identifiant de
// session sur un chemin plus large, rien n'est supprime et le client reste en echec visible.
async function reinitialiserAdelie(page) {
  const ctx = page.context();
  const cookies = await ctx.cookies('https://cfspro.impots.gouv.fr/adelie2mapi/').catch(() => []);
  const adelie = cookies.filter((c) => /^\/adelie2mapi/i.test(c.path || ''));
  for (const c of adelie) await ctx.clearCookies({ name: c.name, domain: c.domain, path: c.path }).catch(() => {});
  return adelie.map((c) => c.name);
}

/** Ouvre le dossier `siren` sous l'habilitation `idth` (HAB_*). Renvoie :
 *   { ok: true, cible }                    cible = page portant l'appli (ADELIE / gaia2)
 *   { ok: false, sansHabilitation: true }   dossier sans le service demande (cas normal) : l'ouverture
 *                                           reste dans la zone « mire » (accueil du dossier, sans
 *                                           « Consulter » ; alors resteSurMire: true, et le dossier EST
 *                                           selectionne cote « mire ») ou repond « aucune habilitation » (HTTP 500)
 *   { ok: false, introuvable: true }        SIREN hors portefeuille / page d'erreur
 *   { ok: false, contexteIncoherent: true } l'appli affiche un AUTRE SIREN que celui demande
 *                                           (contexte du dossier precedent) : ne rien lire dessus
 *   { ok: false, adelieErreur: true }       ADELIE repond « Erreur technique » (affiche = SIREN lu)
 *  Leve si la session a expire. */
export async function selectionnerDossier(page, siren, idth) {
  const essayer = async (jeton) => {
    const url = `${mireBase()}/dossierSelect.do?idth=${encodeURIComponent(idth)}&idDossier=${encodeURIComponent(siren)}&token=${encodeURIComponent(jeton)}`;
    // Une reponse HTTP en erreur SANS corps fait lever goto : meme traitement qu'une page d'erreur.
    const leve = await page.goto(url, { waitUntil: 'domcontentloaded' }).then(
      () => false,
      () => true,
    );
    if (leve) return true;
    // Une ouverture reussie QUITTE dossierSelect.do (redirection vers l'appli cible).
    return /dossierSelect\.do/i.test(page.url()) || (/\/mire\//i.test(page.url()) && /erreur/i.test(await page.title().catch(() => '')));
  };
  const sansHabilitation = () => page.evaluate(() => /aucune habilitation/i.test(document.body?.innerText || '')).catch(() => false);

  let jeton = await jetonMire(page);
  let enErreur = await essayer(jeton);
  if (enErreur && (await sansHabilitation())) return { ok: false, sansHabilitation: true };
  if (enErreur) {
    // Jeton perime (session renouvelee) ? On le relit (leve si la session a expire) et,
    // s'il a change, on retente une fois.
    const neuf = await jetonMire(page, { forcer: true });
    if (neuf !== jeton) {
      jeton = neuf;
      enErreur = await essayer(jeton);
      if (enErreur && (await sansHabilitation())) return { ok: false, sansHabilitation: true };
    }
  }
  if (enErreur) return { ok: false, introuvable: true };
  // Ouverture reussie = on ATTERRIT sur l'appli cible (ADELIE / gaia2). Rester dans la zone
  // « mire » (accueil du dossier) signifie que ce dossier n'a pas le service demande : sans
  // ce controle, la page d'avis lue ensuite appartenait au dossier PRECEDENT (constate le
  // 12/10/2026 : des clients sans habilitation CFE « recevaient » les avis du client d'avant).
  let cible = page;
  if (!/adelie2mapi|gaia2-zu-mapi/i.test(page.url())) {
    cible = await attendreFenetreCible(page, 1500);
    if (!cible) return /\/mire\//i.test(page.url()) ? { ok: false, sansHabilitation: true, resteSurMire: true } : { ok: false, introuvable: true };
  }
  // Garde-fou : le SIREN affiche doit etre celui demande (rendu parfois tardif : 1 relecture).
  await cible.waitForLoadState('domcontentloaded').catch(() => {});
  let affiche = await sirenAffiche(cible);
  if (affiche && affiche !== siren) {
    await cible.waitForTimeout(2500);
    affiche = await sirenAffiche(cible);
  }
  if (/adelie2mapi/i.test(cible.url()) && (await adelieEnErreur(cible))) return { ok: false, adelieErreur: true, affiche };
  if (affiche && affiche !== siren) return { ok: false, contexteIncoherent: true, affiche };
  return { ok: true, cible };
}

/** Ouvre le dossier dans ADELIE pour lire ses avis CFE / taxe fonciere. Entree « compte fiscal »
 *  d'abord : c'est elle qui donne acces aux avis de TOUS les dossiers (constate le 12/10/2026 :
 *  EURL TBA SECU, pourtant dans la liste « avis CFE », restait sur l'accueil du dossier par
 *  l'entree « avis CFE » alors que le compte fiscal affichait bien ses 7 CFE + 4 TF).
 *  L'entree « avis CFE » ne sert plus qu'en repli. Meme retour que selectionnerDossier. */
export async function ouvrirDossierAvis(page, siren, log) {
  let sel = await ouvrirDossierAvisUneFois(page, siren);
  // ADELIE en erreur ou coince sur un autre dossier : on repart sur une session ADELIE neuve et on reessaie une fois.
  if (sel.adelieErreur || sel.contexteIncoherent) {
    const supprimes = await reinitialiserAdelie(page);
    log?.(`ADELIE ${sel.adelieErreur ? 'en erreur technique' : `coince sur le SIREN ${sel.affiche}`} : session ADELIE reinitialisee (${supprimes.length ? `cookies ${supprimes.join(', ')}` : 'aucun cookie ADELIE a supprimer'}), nouvel essai.`);
    sel = await ouvrirDossierAvisUneFois(page, siren);
    sel.reinitialise = supprimes.length;
  }
  return sel;
}

async function ouvrirDossierAvisUneFois(page, siren) {
  let sel = await selectionnerDossier(page, siren, HAB_COMPTE_FISCAL);
  if (!sel.ok && !sel.contexteIncoherent && !sel.adelieErreur) {
    const repli = await selectionnerDossier(page, siren, HAB_AVIS);
    if (repli.ok || repli.contexteIncoherent || repli.adelieErreur) sel = repli;
    // Dernier recours : les deux dossierSelect.do ont laisse le dossier selectionne sur l'accueil
    // « mire » (releve le 12/10/2026 : SARL SACILOTTO, 3 CFE, restait sur l'accueil par les deux
    // entrees alors que la tuile « Avis CFE » de son accueil ouvrait bien ses avis).
    else if (repli.resteSurMire) sel = await ouvrirAvisParRedirection(page, siren);
  }
  return sel;
}

/** Ouvre les avis CFE du dossier DEJA selectionne sur l'accueil « mire » par la tuile « Avis CFE »
 *  (mire/redirection.do?idth=...&token=T). Meme retour que selectionnerDossier. Rien n'est lu si le
 *  SIREN affiche n'est pas celui demande ou si ADELIE est en erreur. */
async function ouvrirAvisParRedirection(page, siren) {
  const jeton = await jetonMire(page);
  const leve = await page.goto(`${mireBase()}/redirection.do?idth=${encodeURIComponent(HAB_AVIS)}&token=${encodeURIComponent(jeton)}`, { waitUntil: 'domcontentloaded' }).then(
    () => false,
    () => true,
  );
  if (leve) return { ok: false, sansHabilitation: true };
  let cible = page;
  if (!/adelie2mapi/i.test(page.url())) {
    cible = await attendreFenetreCible(page, 1500);
    if (!cible) return { ok: false, sansHabilitation: true };
  }
  await cible.waitForLoadState('domcontentloaded').catch(() => {});
  let affiche = await sirenAffiche(cible);
  if (affiche && affiche !== siren) {
    await cible.waitForTimeout(2500);
    affiche = await sirenAffiche(cible);
  }
  if (await adelieEnErreur(cible)) return { ok: false, adelieErreur: true, affiche };
  // SIREN different = ADELIE coince sur un autre dossier : ce n'est PAS « sans habilitation » (fausse
  // etiquette a l'origine des ~470 faux « sans habilitation » du 13/10).
  if (affiche && affiche !== siren) return { ok: false, contexteIncoherent: true, affiche };
  return { ok: true, cible };
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
    await page.waitForURL(/cfspro\.impots\.gouv\.fr\/mire\/(accueil|afficherSelectionDossier|afficherChoisirDossier|rechercherDossiers)/, { timeout: 300000 });
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
      const verif = await verifierEtClasser({ fichier: dest, source: 'impots', client, meta: { libelle: `${prefixe} ${annee} ${ref}`, eventid: eid } });
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
    // 1. Ouverture du dossier sous l'habilitation « messagerie » : redirige vers gaia2
    //    (« Mes échanges ») dans l'onglet courant. Dossier sans cette habilitation => HTTP 500
    //    + « aucune habilitation » (detecte tout de suite : cas normal, pas une panne).
    const sel = await selectionnerDossier(page, siren, HAB_MESSAGERIE);
    if (sel.contexteIncoherent) {
      log(`Messagerie : le site affiche le SIREN ${sel.affiche} au lieu de ${siren} — rien lu.`);
      return { docs, existants, quarantaines, nonVerifiables, erreur: `Contexte messagerie incohérent (SIREN ${sel.affiche} affiché au lieu de ${siren})` };
    }
    if (!sel.ok) {
      log(
        sel.sansHabilitation
          ? 'Messagerie : pas d’habilitation pour ce dossier — passage au suivant.'
          : 'Messagerie : dossier introuvable dans l’espace professionnel — passage au suivant.',
      );
      return { docs, existants, info: sel.sansHabilitation ? 'sans habilitation messagerie' : 'dossier introuvable (messagerie)' };
    }
    const gaia = sel.cible;
    const popup = gaia !== page ? gaia : null; // fenetre ouverte a part (repli ancien comportement)
    if (!/gaia2/i.test(gaia.url())) await gaia.goto(GAIA_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
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
              const verif = await verifierEtClasser({
                fichier: destPj,
                source: 'impots',
                client,
                meta: { libelle: `PJ ${e.date} ${nomPj}`.slice(0, 150), eventid: `${eid}_PJ${k + 1}` },
              });
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

// Ferme les fenetres residuelles (ADELIE/gaia2/E-Services) d'un client precedent, au cas ou
// l'ouverture d'un dossier se serait faite dans une fenetre a part.
async function fermerFenetresAnnexes(page) {
  for (const p of page.context().pages()) {
    if (p !== page && /adelie2mapi|gaia2-zu-mapi|externRedirect/i.test(p.url())) {
      await p.close().catch(() => {});
    }
  }
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
    // Nettoie une eventuelle fenetre ADELIE d'un client precedent.
    await fermerFenetresAnnexes(page);
    // 1. Ouverture du dossier sous l'habilitation « compte fiscal » (lien direct avec le jeton
    //    de session) : redirige vers ADELIE dans l'onglet courant.
    const sel = await selectionnerDossier(page, siren, HAB_COMPTE_FISCAL);
    if (!sel.ok) {
      const raison = sel.sansHabilitation
        ? 'pas d’habilitation compte fiscal'
        : sel.contexteIncoherent
          ? 'contexte du dossier incohérent'
          : 'dossier introuvable (compte fiscal)';
      log(`TVA : ${raison} — ignoré.`);
      return { docs: [], existants: 0, info: raison };
    }
    const cf = sel.cible;
    await cf.waitForLoadState('domcontentloaded').catch(() => {});
    await cf.waitForTimeout(1500);
    // 2. Consultation ADELIE atteinte. Le menu porte des liens stables : on lit l'URL de
    //    l'entree « déclarations TVA » (#menuForm:tva_declarations -> declarations_tva.xhtml
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
    let infoAvis = null; // avis non recuperables pour ce dossier (message affiche dans l'historique)
    let avisIntrouvable = false; // SIREN hors portefeuille (≠ simple absence d'habilitation)
    if (phases.cfe || phases.tf) {
      // 1. Ouvrir le dossier dans ADELIE (lien direct + jeton de session, onglet courant).
      const sel = await ouvrirDossierAvis(page, siren, log);
      if (sel.ok) {
        // 2. Avis CFE
        if (phases.cfe) {
          await page.goto(CFE_AVIS_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
          await page.waitForTimeout(3000);
          if (await adelieEnErreur(page)) throw new Error('ADELIE répond « Erreur technique » sur la page des avis CFE — avis non lus.');
          cfe = await telechargerAvis(page, client, clientDir, 'CFE', '[id$="tableauAvisImposition_data"]', navTimeout, log);
        }
        // 3. Taxe fonciere
        if (phases.tf) {
          await page.goto(TF_AVIS_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
          await page.waitForTimeout(3000);
          if (await adelieEnErreur(page)) throw new Error('ADELIE répond « Erreur technique » sur la page de la taxe foncière — avis non lus.');
          tf = await telechargerAvis(page, client, clientDir, 'TF', '[id$="tableauAvisTaxeFonciere_data"]', navTimeout, log);
        }
      } else {
        if (sel.adelieErreur)
          throw new Error(`ADELIE répond « Erreur technique » pour ce dossier (SIREN affiché ${sel.affiche || 'inconnu'}) — avis non lus.`);
        if (sel.contexteIncoherent)
          throw new Error(`Contexte ADELIE incohérent : le site affiche le SIREN ${sel.affiche} au lieu de ${siren} — rien n’a été lu pour ce client.`);
        avisIntrouvable = !!sel.introuvable;
        infoAvis = sel.sansHabilitation ? 'pas d’habilitation CFE/TF pour ce dossier' : 'dossier introuvable dans l’espace professionnel (hors portefeuille ?)';
        log(`Avis CFE/TF : ${infoAvis} — passage à la suite.`);
      }
    }
    // 4. Messagerie
    if (phases.messagerie) msg = await recupererMessagerie(page, context, client, clientDir, navTimeout, log);
    if (msg.erreur) throw new Error(msg.erreur);
    // 5. Declarations de TVA (compte fiscal, par SIREN)
    if (phases.tva) tva = await telechargerTvaDeclarations(page, client, clientDir, siren, navTimeout, log);

    const nouveaux = cfe.docs.length + tf.docs.length + msg.docs.length + tva.docs.length;
    const existants = cfe.existants + tf.existants + msg.existants + tva.existants;
    const quarantaines = [...(cfe.quarantaines || []), ...(tf.quarantaines || []), ...(msg.quarantaines || [])];
    const nonVerifiables = (cfe.nonVerifiables || 0) + (tf.nonVerifiables || 0) + (msg.nonVerifiables || 0);
    const parts = [];
    if (infoAvis) parts.push(`avis : ${infoAvis}`);
    else {
      if (phases.cfe) parts.push(`${cfe.docs.length} CFE`);
      if (phases.tf) parts.push(`${tf.docs.length} taxe fonciere`);
    }
    if (phases.messagerie) parts.push(msg.info ? `messagerie : ${msg.info}` : `${msg.docs.length} message(s)`);
    if (phases.tva) parts.push(tva.info ? `TVA : ${tva.info}` : `${tva.docs.length} TVA`);
    let message = `${parts.join(' + ')}${infoAvis ? '' : ' recupere(s)'}` + (existants ? `, ${existants} deja present(s)` : '');
    if (nonVerifiables > 0) message += ` (${nonVerifiables} non verifiable(s) : PDF sans texte)`;
    if (quarantaines.length > 0) message = `⚠️ ${quarantaines.length} PDF mis en quarantaine — ${quarantaines.join(' ; ').slice(0, 300)}. ${message}`;
    // « Echec » = a regarder : quarantaine, ou SIREN introuvable alors que rien d'autre n'a abouti.
    // Une simple absence d'habilitation est un etat normal (comme « non assujetti » en TVA).
    const echec = quarantaines.length > 0 || (avisIntrouvable && nouveaux + existants === 0);
    addRunSafe(client.id, { statut: echec ? 'echec' : 'succes', message, nb_docs: nouveaux });
    log(`Termine : ${nouveaux} nouveau(x), ${existants} deja present(s).`);
    // ok:true meme si le dossier est introuvable : ce n'est pas une panne du site (le
    // disjoncteur de lot ne doit pas s'enclencher pour des clients hors portefeuille).
    return { ok: true, docs: [...cfe.docs, ...tf.docs, ...msg.docs, ...tva.docs], info: infoAvis ? message : undefined };
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

// Nombre de dossiers consecutifs sans acces aux avis a partir duquel on suspecte la session (voir scrapeAll).
const SERIE_SANS_ACCES_MAX = 10;

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
    const serieSansAcces = []; // clients consecutifs dont les avis n'ont pas pu etre ouverts
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
      const lancer = () => recupererClient(page, client, { baseFolder: opts.baseFolder, navTimeout, log: clog, context, phases: phasesDe(opts) });
      let r = await lancer();
      // Garde-fou de serie : « sans habilitation » / « introuvable » pour SERIE_SANS_ACCES_MAX clients
      // d'affilee n'est pas un etat normal (13/10/2026 : ~470 dossiers ratés en « succès » a 0 document).
      // 1) on reinitialise la session ADELIE et on retente ce client ; 2) si ca ne change rien, la serie est traitee comme
      // une panne : ses clients repassent en « echec » (donc refaits a la prochaine reprise) et le
      // disjoncteur du lot (echecs consecutifs) peut arreter la recuperation.
      if (r.ok && r.info) {
        serieSansAcces.push(client);
        if (serieSansAcces.length === SERIE_SANS_ACCES_MAX) {
          clog(`⚠ ${SERIE_SANS_ACCES_MAX} dossiers d'affilee sans acces aux avis : session ADELIE reinitialisee, nouvelle tentative.`);
          await reinitialiserAdelie(page).catch(() => {});
          r = await lancer();
          if (r.ok && !r.info) serieSansAcces.length = 0;
        }
      } else if (r.ok) serieSansAcces.length = 0;
      if (serieSansAcces.length >= SERIE_SANS_ACCES_MAX) {
        const raison = `Série de ${SERIE_SANS_ACCES_MAX}+ dossiers sans accès aux avis (session suspecte) : à refaire`;
        for (const c of serieSansAcces.length === SERIE_SANS_ACCES_MAX ? serieSansAcces : [client]) addRunSafe(c.id, { statut: 'echec', message: raison, nb_docs: 0 });
        r = { ok: false, error: raison, docs: [] };
      }
      resume.traites++;
      const msg = r.ok ? r.info || `${r.docs.length} document(s)` : r.error || 'erreur';
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

/** Liste les dossiers du cabinet (nom + SIREN) : liste « Mes dossiers » sous l'habilitation
 *  « avis CFE » (10 par page, pagination p=N, lien par dossier). Connexion manuelle. */
export async function listerClients(cabinet, opts = {}) {
  const log = (m) => {
    const line = `[sync] ${m}`;
    console.log(line);
    opts.onLog?.(line);
  };
  const { browser, page } = await ouvrirSession();
  try {
    await attendreConnexionManuelle(page, cabinet, log);
    const jeton = await jetonMire(page);
    const urlListe = (p) => `${mireBase()}/afficherSelectionDossier.do?idth=${HAB_AVIS}${p > 1 ? `&p=${p}` : ''}&token=${encodeURIComponent(jeton)}`;
    // Page 1
    await page.goto(urlListe(1), { waitUntil: 'domcontentloaded' }).catch(() => {});
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

    // Dernier numero de page affiche (liens de pagination « Page N » de la liste)
    const lirePageMax = () =>
      page
        .evaluate(() => {
          let max = 1;
          for (const a of document.querySelectorAll('a[href*="afficherSelectionDossier.do"]')) {
            const m = (a.getAttribute('href') || '').match(/[?&]p=(\d+)/);
            if (m) max = Math.max(max, parseInt(m[1], 10));
          }
          return max;
        })
        .catch(() => 1);
    let pageMax = await lirePageMax();
    const annonces = await page.evaluate(() => (document.body?.innerText.match(/(\d+)\s+résultat/) || [])[1] || null).catch(() => null);
    log(`Page 1 : ${rows.length} dossier(s) — ${pageMax} page(s)${annonces ? `, ${annonces} dossier(s) annoncé(s)` : ''}.`);

    // Pages suivantes : on suit directement les URL p=2..N (N relu a chaque page, il peut grandir)
    const plafond = 500;
    let p = 2,
      sansNouveau = 0;
    while (p <= Math.min(pageMax, plafond)) {
      await page.goto(urlListe(p), { waitUntil: 'domcontentloaded' }).catch(() => {});
      await page.waitForTimeout(1200);
      const lot = await lireDossiersPage(page);
      if (!lot.length) break; // plus de dossiers : on a depasse la derniere page
      const n = ajouter(lot);
      log(`Page ${p} : +${n} (total ${rows.length})`);
      if (n === 0) {
        if (++sansNouveau >= 2) break;
      } else sansNouveau = 0;
      pageMax = Math.max(pageMax, await lirePageMax());
      p++;
    }
    log(`${rows.length} dossier(s) liste(s) sur ${pageMax} page(s).`);
    if (annonces && rows.length < Number(annonces)) log(`⚠ ${rows.length} dossier(s) lus pour ${annonces} annoncé(s) — liste peut-être incomplète.`);
    return rows;
  } finally {
    await browser.close().catch(() => {});
  }
}
