// Connecteur IMPOT SUR LE REVENU : espace particulier impots.gouv.fr, un compte par client
// (numero fiscal 13 chiffres + mot de passe). Pas d'acces tiers possible cote DGFiP.
//
// Connexion (page cfspart-idp.impots.gouv.fr, relevee le 22/10/2026) :
//   #spi_tmp (numero fiscal) -> #btnAction « Continuer » -> #pwd_tmp + case « Se souvenir de
//   moi » (input[name=remember]) -> #btnAction. Depuis un appareil inconnu, impots.gouv peut
//   exiger un CODE DE SECURITE a 6 chiffres envoye a l'adresse e-mail DU CLIENT (#otpform,
//   champs .otpinput / #otp_tmp, choix courriel/SMS #otpchoicemail). L'appareil memorise
//   (etat du navigateur, chiffre, un par client) evite ce code aux connexions suivantes.
//
// Garde-fous (500 clients) :
//   - mot de passe refuse / espace verrouille -> echec_mdp : client verrouille, JAMAIS
//     retente automatiquement (un verrouillage DGFiP se debloque par courrier postal) ;
//   - code de securite exige pendant une TOURNEE -> echec immediat « code requis » (pas
//     d'attente) ; seule une recuperation d'UN client attend le code dans le bandeau.
//
// Documents : les pages de l'espace particulier ne sont pas encore cartographiees. Le
// connecteur parcourt l'accueil et les pages « Documents », telecharge les liens de
// documents (avis, declarations, « Declaration par un tiers »...) et ecrit un DIAGNOSTIC
// (_diagnostic_ir.json : pages, liens, boutons) pour affiner le parcours au premier essai.
import { mkdirSync, writeFileSync, readFileSync, existsSync, statSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { addDocument, addRun, listDocuments } from './ir-db.js';
import { ouvrirPour } from './navigateur.js';
import { sanitize, dansPeriode, anneeDe } from './scraper-commun.js';
import { verifierEtClasser } from './validation-pdf.js';
import { encrypt, decrypt } from './crypto.js';
import * as captchaRelais from './captcha-relais.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DOWNLOADS_DIR = resolve(__dirname, '..', 'downloads', 'ir');
const APPAREILS_DIR = resolve(__dirname, '..', 'data', 'ir-appareils');
const LOGIN_URL = process.env.IR_LOGIN_URL || 'https://cfspart.impots.gouv.fr/LoginAccess';
const ATTENTE_CODE_MS = Number(process.env.IR_ATTENTE_CODE_MS || 10 * 60 * 1000);
// Hote de la page de connexion (IdP) et domaine des pages de l'espace : surchargeables
// pour les tests contre un site factice local.
const HOTE_IDP = process.env.IR_HOTE_IDP || 'cfspart-idp.impots.gouv.fr';
const DOMAINE = new RegExp(process.env.IR_DOMAINE || 'impots\\.gouv\\.fr');
export const NOM_DIAGNOSTIC = '_diagnostic_ir.json';

// ---- Appareil memorise (etat du navigateur : cookies « se souvenir de moi ») ----------
const fichierAppareil = (id) => resolve(APPAREILS_DIR, `${Number(id)}.enc`);
function lireAppareil(id) {
  try {
    return JSON.parse(decrypt(readFileSync(fichierAppareil(id), 'utf8')));
  } catch {
    return undefined;
  }
}
async function memoriserAppareil(context, id) {
  try {
    mkdirSync(APPAREILS_DIR, { recursive: true });
    writeFileSync(fichierAppareil(id), encrypt(JSON.stringify(await context.storageState())), 'utf8');
  } catch {
    /* sans memoire d'appareil, un code pourra etre redemande : pas bloquant */
  }
}

export function dossierClient(client, opts = {}) {
  if (client.dossier && client.dossier.trim()) return client.dossier.trim();
  if (opts.baseFolder && opts.baseFolder.trim()) return resolve(opts.baseFolder.trim(), sanitize(client.nom));
  return resolve(DOWNLOADS_DIR, sanitize(`${client.id}_${client.nom}`));
}

// ---- Diagnostic : ce que voit le robot, pour cartographier l'espace particulier ------
async function relever(page) {
  return page
    .evaluate(() => {
      const txt = (e) => (e.innerText || e.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 140);
      return {
        url: location.href,
        titre: document.title,
        titres: [...document.querySelectorAll('h1,h2,h3')].map(txt).filter(Boolean).slice(0, 40),
        liens: [...document.querySelectorAll('a[href]')]
          .map((a) => ({ texte: txt(a) || a.getAttribute('title') || a.getAttribute('aria-label') || '', href: a.href }))
          .filter((l) => l.href && !l.href.startsWith('javascript:void'))
          .slice(0, 250),
        boutons: [...document.querySelectorAll('button, input[type=submit]')]
          .map((b) => txt(b) || b.value || b.id)
          .filter(Boolean)
          .slice(0, 60),
      };
    })
    .catch((e) => ({ url: page.url(), erreur: e.message }));
}

// ---- Connexion --------------------------------------------------------------------------
const MOTIF_REFUS = /incorrect|erron|invalide|verrouill|bloqu|n'est pas reconnu|inconnu/i;

async function messageErreur(page) {
  return page
    .evaluate(() =>
      [...document.querySelectorAll('.fr-error-text, .fr-alert, .alert, .erreur, [role=alert], #usernameMessage, #passwordMessage')]
        .filter((e) => e.offsetParent !== null)
        .map((e) => e.innerText.replace(/\s+/g, ' ').trim())
        .filter(Boolean)
        .join(' | ')
        .slice(0, 300),
    )
    .catch(() => '');
}

const surIdp = (page) => {
  try {
    return new URL(page.url()).host.startsWith(HOTE_IDP);
  } catch {
    return false;
  }
};
const formulaireCode = (page) => page.locator('#otpform, .otpinput, #otp_tmp').first();

async function saisirCode(page, code) {
  const c = String(code || '').replace(/\D/g, '');
  if (c.length !== 6) return { ok: false, refuse: true, error: 'Le code de sécurité comporte 6 chiffres.' };
  if (await page.locator('#otp_tmp').count()) await page.locator('#otp_tmp').fill(c);
  else {
    const cases = page.locator('.otpinput');
    const n = await cases.count();
    if (n >= 6) for (let i = 0; i < 6; i++) await cases.nth(i).fill(c[i]);
    else if (n === 1) await cases.first().fill(c);
  }
  const valider = page.locator('#otpSubmit, #otpSubmitOUI').first();
  if (await valider.count()) await valider.click().catch(() => {});
  else await page.evaluate(() => document.getElementById('otpform')?.submit());
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  await page.waitForTimeout(3000);
  if (!surIdp(page)) return { ok: true, connecte: true };
  const err = await messageErreur(page);
  return { ok: false, refuse: true, error: err || 'Code refusé par impots.gouv — vérifie le dernier e-mail reçu par le client.' };
}

// Attend le code saisi dans le bandeau (recuperation d'UN client seulement).
async function attendreCode(page, client, log) {
  const pause = (ms) => new Promise((ok) => setTimeout(ok, ms));
  const limite = Date.now() + ATTENTE_CODE_MS;
  while (captchaRelais.etat().actif) {
    if (Date.now() > limite) throw new Error('Bandeau de saisie occupé — relance la récupération de ce client plus tard.');
    await pause(2000);
  }
  log('Code de sécurité demandé par impots.gouv : à saisir dans le bandeau du portail.');
  await new Promise((resoudre, rejeter) => {
    const minuterie = setTimeout(() => {
      captchaRelais.fermer();
      rejeter(new Error('Code de sécurité impots.gouv non saisi à temps — relance la récupération de ce client.'));
    }, ATTENTE_CODE_MS);
    captchaRelais.ouvrir({
      titre: `🔐 Code impots.gouv — ${client.nom}`,
      message: `impots.gouv a envoyé un code de sécurité à 6 chiffres à l'adresse e-mail personnelle de ${client.nom}. Demande-le au client et recopie-le ci-dessous : l'appareil sera ensuite mémorisé.`,
      soumettre: async (code) => {
        const r = await saisirCode(page, code);
        if (r.connecte) {
          clearTimeout(minuterie);
          captchaRelais.fermer();
          resoudre();
        }
        return r;
      },
    });
  });
}

async function seConnecter(page, client, opts, log) {
  await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded' });
  await page.locator('#spi_tmp').waitFor({ state: 'visible' });
  await page.locator('#spi_tmp').fill(String(client.login).replace(/\D/g, ''));
  await page.locator('#btnAction').click();
  const mdp = page.locator('#pwd_tmp');
  await mdp.waitFor({ state: 'visible', timeout: 20000 }).catch(() => {});
  if (!(await mdp.isVisible().catch(() => false))) {
    const err = await messageErreur(page);
    const e = new Error(`Numéro fiscal refusé par impots.gouv${err ? ` : ${err}` : ''}`);
    if (!err || MOTIF_REFUS.test(err)) e.kind = 'mdp';
    throw e;
  }
  await mdp.fill(client.password);
  const souvenir = page.locator('input[name=remember]').first();
  if (await souvenir.count()) await souvenir.check({ force: true }).catch(() => {});
  await page.locator('#btnAction').click();
  // Issue : espace ouvert (on quitte l'IdP), code de securite, ou refus.
  await page
    .waitForFunction((hote) => !location.host.startsWith(hote) || document.querySelector('#otpform, .otpinput, #otp_tmp'), HOTE_IDP, { timeout: 30000 })
    .catch(() => {});
  if (surIdp(page) && (await formulaireCode(page).count())) {
    const parMail = page.locator('#otpchoicemail');
    if (await parMail.count()) {
      await parMail.check({ force: true }).catch(() => {});
      const envoyer = page.locator('#otpSubmitOUI, #otpSubmit').first();
      if (await envoyer.count()) await envoyer.click().catch(() => {});
      await page.waitForTimeout(2000);
    }
    if (opts.browser) {
      // Tournee : pas d'attente (500 clients). Le client reste deverrouille.
      throw new Error('Code de sécurité exigé par impots.gouv (envoyé au client) — lance la récupération de ce client seul pour le saisir.');
    }
    await attendreCode(page, client, log);
  }
  if (surIdp(page)) {
    const err = await messageErreur(page);
    const e = new Error(`Connexion impots.gouv refusée${err ? ` : ${err}` : ' (aucun message — page de connexion toujours affichée)'}`);
    if (err && MOTIF_REFUS.test(err)) e.kind = 'mdp'; // verrou : jamais retente automatiquement
    throw e;
  }
}

// ---- Documents --------------------------------------------------------------------------
const MOTIF_PAGE_DOCS = /documents?/i;
const MOTIF_DOC = /avis|d[ée]claration|accus[ée]|t[ée]l[ée]charg|pdf|tiers|imprimer|justificatif|attestation/i;
const estLienFichier = (l) => /\.pdf(\?|$)|download|telecharg|getDocument|affichage|consulter.*(pdf|doc)|tiers/i.test(l.href);

export async function scrapeClient(client, opts = {}) {
  const log = (m) => {
    const line = `[${client.nom}] ${m}`;
    console.log(line);
    opts.onLog?.(line);
  };
  const clientDir = dossierClient(client, opts);
  mkdirSync(clientDir, { recursive: true });
  const docs = [];
  let dejaPresents = 0;
  let horsPeriode = 0;
  let nonVerifiables = 0;
  const quarantaines = [];
  const diagnostic = { client: client.nom, le: new Date().toISOString(), pages: [], fichiers: [] };
  const addRunSafe = (run) => {
    try {
      addRun(client.id, run);
    } catch (e) {
      console.warn(`(historique IR ${client.id}: ${e.message})`);
    }
  };

  if (!client.password) {
    addRunSafe({ statut: 'echec_mdp', message: 'Mot de passe vide pour ce client — re-saisis-le.', nb_docs: 0 });
    return { ok: false, error: 'Mot de passe vide', docs };
  }
  const { context, page, fermer } = await ouvrirPour({ ...opts, contextOptions: { storageState: lireAppareil(client.id) } });
  try {
    log('Connexion à l’espace particulier impots.gouv');
    await seConnecter(page, client, opts, log);
    await memoriserAppareil(context, client.id);
    log('Connecté.');
    await page.waitForLoadState('domcontentloaded').catch(() => {});
    await page.waitForTimeout(1500);

    // Pages a explorer : l'accueil puis les pages « Documents » qu'il propose.
    const accueil = await relever(page);
    diagnostic.pages.push(accueil);
    const aVisiter = [...new Set((accueil.liens || []).filter((l) => MOTIF_PAGE_DOCS.test(l.texte) && DOMAINE.test(l.href)).map((l) => l.href))].slice(0, 4);
    const candidats = new Map(); // href -> texte
    const noter = (rel) => {
      for (const l of rel.liens || []) if (DOMAINE.test(l.href) && (estLienFichier(l) || MOTIF_DOC.test(l.texte))) candidats.set(l.href, l.texte);
    };
    noter(accueil);
    for (const url of aVisiter) {
      await page.goto(url, { waitUntil: 'domcontentloaded' }).catch(() => {});
      await page.waitForTimeout(1500);
      const rel = await relever(page);
      diagnostic.pages.push(rel);
      noter(rel);
    }

    const dejaEnBase = new Set(listDocuments(client.id).map((d) => `${d.date_doc || ''}|${d.libelle || ''}`));
    for (const [href, texte] of candidats) {
      const libelle = (texte || 'Document impots.gouv').slice(0, 120);
      const annee = anneeDe(`${texte} ${href}`);
      const trace = { libelle, href: href.slice(0, 200), resultat: '' };
      diagnostic.fichiers.push(trace);
      if (!dansPeriode(String(annee ?? ''))) {
        horsPeriode++;
        trace.resultat = 'hors période';
        continue;
      }
      if (dejaEnBase.has(`${annee || ''}|${libelle}`)) {
        dejaPresents++;
        trace.resultat = 'déjà présent';
        continue;
      }
      try {
        const r = await context.request.get(href, { timeout: 30000 });
        const buf = await r.body();
        const type = r.headers()['content-type'] || '';
        const nomServeur = (r.headers()['content-disposition'] || '').match(/filename\*?=(?:UTF-8'')?"?([^";]+)/i)?.[1];
        const estPdf = buf.subarray(0, 4).toString() === '%PDF';
        if (!r.ok() || (!estPdf && /text\/html/i.test(type))) {
          trace.resultat = `ignoré (${r.status()} ${type.split(';')[0]})`;
          continue;
        }
        const ext = estPdf ? '.pdf' : (nomServeur?.match(/\.[a-z0-9]{2,5}$/i)?.[0] ?? '.bin');
        const base = sanitize(`${annee ? annee + '_' : ''}${(nomServeur || libelle).replace(/\.[a-z0-9]{2,5}$/i, '')}`);
        const dest = resolve(clientDir, `${base}${ext}`);
        if (existsSync(dest) && statSync(dest).size > 100) {
          addDocument(client.id, { libelle, fichier: dest, date_doc: annee ? String(annee) : null });
          dejaPresents++;
          trace.resultat = 'déjà sur le disque';
          continue;
        }
        writeFileSync(dest, buf);
        if (estPdf) {
          const verif = await verifierEtClasser({ fichier: dest, source: 'ir', client, meta: { libelle, dateDoc: annee ? String(annee) : null } });
          if (verif.verdict === 'quarantaine') {
            quarantaines.push(verif.raison);
            trace.resultat = 'quarantaine';
            log(`⚠️ QUARANTAINE : ${verif.raison}`);
            continue;
          }
          if (verif.verdict === 'non_verifiable') nonVerifiables++;
        }
        addDocument(client.id, { libelle, fichier: dest, date_doc: annee ? String(annee) : null });
        docs.push({ libelle, fichier: dest });
        trace.resultat = 'récupéré';
        log(`OK : ${dest.split(/[\\/]/).pop()} (${Math.round(buf.length / 1024)} Ko)`);
      } catch (e) {
        trace.resultat = `erreur : ${e.message.split('\n')[0]}`;
      }
    }

    let message = `${docs.length} document(s) récupéré(s)` + (dejaPresents ? `, ${dejaPresents} déjà présent(s)` : '');
    if (!candidats.size) message += ' — aucun lien de document repéré (voir le diagnostic)';
    if (nonVerifiables) message += ` (${nonVerifiables} non vérifiable(s))`;
    if (quarantaines.length) message = `⚠️ ${quarantaines.length} PDF mis en quarantaine — ${quarantaines.join(' ; ').slice(0, 300)}. ${message}`;
    addRunSafe({ statut: quarantaines.length ? 'echec' : 'succes', message, nb_docs: docs.length });
    log(`Terminé : ${message}`);
    return { ok: true, docs, dejaPresents, horsPeriode };
  } catch (err) {
    diagnostic.erreur = err.message;
    diagnostic.pages.push(await relever(page));
    addRunSafe({ statut: err.kind === 'mdp' ? 'echec_mdp' : 'echec', message: err.message, nb_docs: docs.length });
    log(`ERREUR : ${err.message}`);
    return { ok: false, error: err.message, docs };
  } finally {
    try {
      writeFileSync(resolve(clientDir, NOM_DIAGNOSTIC), JSON.stringify(diagnostic, null, 2), 'utf8');
    } catch {
      /* ignore */
    }
    await fermer();
  }
}

/** Dernier diagnostic d'un client (pages vues, liens, fichiers tentes) — admin / connecteur MCP. */
export function lireDiagnostic(client) {
  try {
    return JSON.parse(readFileSync(resolve(dossierClient(client), NOM_DIAGNOSTIC), 'utf8'));
  } catch {
    return null;
  }
}
