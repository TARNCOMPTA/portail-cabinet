// Compte TIERS DELEGATAIRE CARCDSF (cabinet) : UNE connexion pour tout le portefeuille
// d'adherents, au lieu d'un identifiant par client. La caisse impose une double
// authentification (code par e-mail) : le code est demande dans le bandeau du portail
// (src/captcha-relais.js), puis l'appareil est memorise (jeton chiffre) pour ne plus
// redemander de code tant que la caisse ne l'invalide pas.
//
// Circuit reconstitue depuis l'application adherents.carcdsf.fr (Flutter, main.dart.js) :
//   1. POST NonConnectes/<b>/internaute/connexion/V1 {pseudo, pwd, da, description}
//      -> double authentification requise : infos2FA {email, telephone, identifiant}
//   2. POST NonConnectes/<b>/internaute/code2FA/V1/<identifiant>/mail      (envoi du code)
//   3. POST NonConnectes/<b>/internaute/verifiercode2FA/V1/<identifiant>/<code>/email
//      (corps : description de l'appareil) -> { vrai: true }
//   4. reconnexion avec da = <identifiant> (le « jeton 2FA » que l'application memorise)
//   5. GET <b>/internaute/matriculeGere/V1/<refDelegataire> -> listeMatriculesGeres
//   6. par adherent : GET <b>/internaute/adhGere/V1/<matriculeNature> (selection), puis
//      les routes documents habituelles (scraper-liberal-web.js) avec ce dossier ;
//      adhGere/V1/0 rend la main au compte delegataire.
import { getSetting, setSetting } from './db.js';
import { encrypt, decrypt } from './crypto.js';
import * as captchaRelais from './captcha-relais.js';

const HOST = process.env.CARCDSF_BASE_URL || 'https://adherents.carcdsf.fr';
const PICRISTOKEN = process.env.CARCDSF_PICRISTOKEN || 'jkhkjhkjhkjhk';
// Meme description d'appareil a la connexion et a la verification du code : la caisse
// rattache le jeton 2FA a cet « appareil ».
const DESCRIPTION = JSON.stringify({
  isDesktop: true,
  isMobile: false,
  isWeb: true,
  operatingSystem: 'linux',
  defaultTargetPlatform: 'linux',
  web: { browserName: 'portail-cabinet' },
});
export const PREFIXE_LOGIN = 'tiers:'; // login des clients geres par le compte tiers : tiers:<matriculeNature>
const ATTENTE_CODE_MS = Number(process.env.CARCDSF_ATTENTE_CODE_MS || 10 * 60 * 1000);

// ---- Configuration (reglages chiffres) -------------------------------------
function lireSecret(cle) {
  const v = getSetting(cle, '') || '';
  return v ? decrypt(v) : '';
}

export function configTiers() {
  return {
    login: getSetting('carcdsf_tiers_login', '') || '',
    password: lireSecret('carcdsf_tiers_password_enc'),
    base: Number(getSetting('carcdsf_tiers_base', '0')) === 1 ? 1 : 0,
    jeton: lireSecret('carcdsf_tiers_jeton_enc'),
  };
}

export function tiersConfigure() {
  const c = configTiers();
  return !!(c.login && c.password);
}

let dernierTest = null; // { ok, message, adherents, le }

export function etatTiers() {
  const c = configTiers();
  return {
    login: c.login,
    base: c.base,
    mot_de_passe_defini: !!c.password,
    appareil_memorise: !!c.jeton,
    configure: !!(c.login && c.password),
    dernier_test: dernierTest,
  };
}

/** Enregistre le compte. Mot de passe vide = inchange ; `oublier_appareil` force un nouveau code ; `effacer` supprime tout. */
export function enregistrerTiers({ login, password, base, oublier_appareil, effacer } = {}) {
  if (effacer === true) {
    for (const k of ['carcdsf_tiers_login', 'carcdsf_tiers_password_enc', 'carcdsf_tiers_jeton_enc']) setSetting(k, '');
    dernierTest = null;
    return etatTiers();
  }
  if (typeof login === 'string') {
    const l = login.trim();
    // Changer de compte invalide l'appareil memorise (jeton rattache a l'ancien pseudo).
    if (l !== (getSetting('carcdsf_tiers_login', '') || '')) setSetting('carcdsf_tiers_jeton_enc', '');
    setSetting('carcdsf_tiers_login', l);
  }
  if (typeof password === 'string' && password) setSetting('carcdsf_tiers_password_enc', encrypt(password));
  if (base != null) setSetting('carcdsf_tiers_base', Number(base) === 1 ? '1' : '0');
  if (oublier_appareil === true) setSetting('carcdsf_tiers_jeton_enc', '');
  return etatTiers();
}

// ---- Appels HTTP -----------------------------------------------------------
const timeout = () => Number(process.env.NAV_TIMEOUT ?? 45000);

async function appel(url, { method = 'GET', headers = {}, body } = {}) {
  const r = await fetch(url, {
    method,
    headers: { picristoken: PICRISTOKEN, 'content-type': 'application/json', ...headers },
    body,
    signal: AbortSignal.timeout(timeout()),
  });
  const json = await r.json().catch(() => ({}));
  return { r, json };
}

const cles = (o) => (o && typeof o === 'object' ? Object.keys(o).join(',') : String(o));
const diagnostic = (j) => `codeInterne=${j.codeInterne ?? '?'} ; réponse=[${cles(j)}] ; 2FA=[${cles(j.infos2FA)}]`;

// Messages de refus de l'application CARCDSF (codes codeInterne).
const REFUS = {
  100: 'identifiant ou mot de passe incorrect',
  103: 'identifiant ou mot de passe incorrect',
  105: 'compte clôturé',
  106: 'compte bloqué (trop de tentatives ?)',
  108: 'changement de mot de passe exigé par la caisse',
  109: 'changement de mot de passe exigé par la caisse',
  110: 'compte invalide',
};

async function connexion(cfg, da) {
  const nc = `${HOST}/InternetWebServicesNonConnectes/${cfg.base}`;
  const { r, json } = await appel(`${nc}/internaute/connexion/V1`, {
    method: 'POST',
    body: JSON.stringify({ pseudo: cfg.login, pwd: cfg.password, da: da || '', description: DESCRIPTION }),
  });
  if (r.status >= 500 || r.status === 429) throw new Error(`Site CARCDSF indisponible (HTTP ${r.status}) — nouvelle tentative au prochain passage.`);
  return { r, json, authorization: r.headers.get('authorization') };
}

// Attend le code saisi dans le bandeau du portail ; chaque saisie est verifiee aupres de
// la caisse (un code faux laisse le bandeau ouvert). Resout avec le jeton (= identifiant 2FA).
async function obtenirCode2FA(cfg, infos, log) {
  const nc = `${HOST}/InternetWebServicesNonConnectes/${cfg.base}`;
  const id = String(infos.identifiant || '');
  if (!id) throw new Error(`Double authentification demandée mais identifiant 2FA absent. (${cles(infos)})`);
  const envoi = await appel(`${nc}/internaute/code2FA/V1/${encodeURIComponent(id)}/mail`, { method: 'POST' });
  if (envoi.json.codeRetour !== 0 && envoi.json.codeRetour != null)
    throw new Error(`Envoi du code refusé par la CARCDSF : ${(envoi.json.libelle || '').trim() || diagnostic(envoi.json)}`);
  const dest = infos.email ? ` à ${infos.email}` : '';
  log(`Double authentification : code envoyé par e-mail${dest}. Saisis-le dans le bandeau du portail.`);

  // Le relais est partage avec la captcha impots : attendre qu'il se libere.
  const limite = Date.now() + ATTENTE_CODE_MS;
  while (captchaRelais.etat().actif) {
    if (Date.now() > limite) throw new Error('Bandeau de saisie occupé (captcha impôts en cours) — réessaie plus tard.');
    await new Promise((ok) => setTimeout(ok, 2000));
  }

  return await new Promise((resoudre, rejeter) => {
    const minuterie = setTimeout(
      () => {
        captchaRelais.fermer();
        rejeter(new Error('Code de double authentification CARCDSF non saisi à temps — relance la récupération CARCDSF depuis le portail.'));
      },
      Math.max(1000, limite - Date.now()),
    );
    captchaRelais.ouvrir({
      titre: '🔐 Code CARCDSF — à toi de jouer',
      message: `La CARCDSF a envoyé un code à 6 caractères par e-mail${dest}. Recopie-le ci-dessous : la connexion du compte tiers et la récupération s'enchaînent toutes seules.`,
      soumettre: async (code) => {
        const c = String(code || '')
          .trim()
          .toUpperCase();
        if (c.length < 6) return { ok: false, refuse: true, error: 'Le code comporte 6 caractères.' };
        const v = await appel(`${nc}/internaute/verifiercode2FA/V1/${encodeURIComponent(id)}/${encodeURIComponent(c)}/email`, {
          method: 'POST',
          body: DESCRIPTION,
        });
        if (v.json.vrai !== true) return { ok: false, refuse: true, error: 'Code refusé par la CARCDSF — vérifie le dernier e-mail reçu.' };
        clearTimeout(minuterie);
        captchaRelais.fermer();
        resoudre(id);
        return { ok: true, connecte: true };
      },
    });
  });
}

/**
 * Ouvre une session du compte tiers. Peut attendre le code de double authentification.
 * @returns {Promise<{base:number, API:string, H:object, ref:number}>}
 */
export async function ouvrirSessionTiers({ log = () => {} } = {}) {
  const cfg = configTiers();
  if (!cfg.login || !cfg.password) throw new Error('Compte tiers CARCDSF non configuré (Paramètres ▸ Compte tiers CARCDSF).');
  log(`Connexion du compte tiers CARCDSF (${cfg.base === 1 ? 'sages-femmes' : 'chirurgiens-dentistes'})`);
  let { json, authorization } = await connexion(cfg, cfg.jeton);
  if (json.infos2FA) {
    if (cfg.jeton) log('Appareil mémorisé refusé par la caisse : nouveau code nécessaire.');
    setSetting('carcdsf_tiers_jeton_enc', '');
    const jeton = await obtenirCode2FA(cfg, json.infos2FA, log);
    ({ json, authorization } = await connexion(cfg, jeton));
    if (json.infos2FA) throw new Error(`Code accepté mais la caisse redemande la double authentification. (${diagnostic(json)})`);
    setSetting('carcdsf_tiers_jeton_enc', encrypt(jeton));
    log('Appareil mémorisé : plus de code demandé aux prochaines connexions.');
  }
  if (json.codeRetour !== 0 || !authorization) {
    const motif = REFUS[json.codeInterne] || (json.libelle || '').trim() || diagnostic(json);
    const e = new Error(`Connexion du compte tiers CARCDSF refusée : ${motif}`);
    e.kind = 'mdp';
    throw e;
  }
  const sig = json.signaletiqueAccueil || {};
  if (!sig.modeDelegataire || !sig.refDelegataire)
    throw new Error(`Ce compte n'est pas un compte « tiers délégataire » CARCDSF (signalétique=[${cles(sig)}]).`);
  log('Compte tiers connecté.');
  return {
    base: cfg.base,
    API: `${HOST}/InternetWebServices/${cfg.base}`,
    H: { picristoken: PICRISTOKEN, authorization, 'content-type': 'application/json' },
    ref: Number(sig.refDelegataire),
  };
}

/** Portefeuille du delegataire : [{ matriculeNature, matricule, nature, nom, prenom, titre, entite }]. */
export async function listerPortefeuille(session) {
  const { r, json } = await appel(`${session.API}/internaute/matriculeGere/V1/${session.ref}`, { headers: session.H });
  if (!r.ok) throw new Error(`Portefeuille CARCDSF illisible (HTTP ${r.status}).`);
  return (Array.isArray(json.listeMatriculesGeres) ? json.listeMatriculesGeres : []).map((a) => {
    const mn = Number(a.matriculeNature);
    return {
      matriculeNature: mn,
      matricule: Math.floor(mn / 100),
      nature: mn % 100,
      nom: String(a.nom || '').trim(),
      prenom: String(a.prenom || '').trim(),
      titre: String(a.titre || '').trim(),
      entite: a.entitePicris,
    };
  });
}

/** Selectionne un adherent du portefeuille (0 = revenir au compte delegataire). */
export async function selectionnerAdherent(session, matriculeNature) {
  const { r, json } = await appel(`${session.API}/internaute/adhGere/V1/${Number(matriculeNature) || 0}`, { headers: session.H });
  const auth = r.headers.get('authorization');
  if (auth) session.H = { ...session.H, authorization: auth }; // jeton renouvele par la caisse
  if (!r.ok || (json.codeRetour != null && json.codeRetour !== 0))
    throw new Error(`Sélection de l'adhérent ${matriculeNature} refusée (HTTP ${r.status}${json.libelle ? ` : ${json.libelle}` : ''}).`);
}

// ---- Rapprochement portefeuille <-> clients du portail ------------------------
const jetons = (s) =>
  String(s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/[^A-Z]+/g, ' ')
    .trim()
    .split(' ')
    .filter((m) => m.length > 1 && !['DR', 'MME', 'MR', 'M', 'MLLE'].includes(m))
    .sort()
    .join(' ');

/**
 * Trouve (ou cree) le client du portail d'un adherent du portefeuille. Un client individuel
 * de meme nom est BASCULE sur le compte tiers (identifiants individuels supprimes,
 * historique de documents conserve).
 */
export function clientPourAdherent(db, adh, base, log = () => {}) {
  const login = `${PREFIXE_LOGIN}${adh.matriculeNature}`;
  const existant = db.getClientByLogin(login);
  if (existant) return existant.id;
  const nomComplet = [adh.nom, adh.prenom].filter(Boolean).join(' ');
  const cle = jetons(nomComplet);
  const homonyme = db.listClients().find((c) => !String(c.login).startsWith(PREFIXE_LOGIN) && cle && jetons(c.nom) === cle);
  if (homonyme) {
    db.remplacerIdentifiants(homonyme.id, login, '');
    log(`[${homonyme.nom}] Compte individuel remplacé par le compte tiers (historique conservé).`);
    return homonyme.id;
  }
  const c = db.createClient({ nom: nomComplet || `Adhérent ${adh.matricule}`, profession: base === 1 ? 'sf' : 'cd', login, password: '' });
  log(`[${c.nom}] Nouveau client créé depuis le portefeuille tiers.`);
  return c.id;
}

// ---- Tournees ------------------------------------------------------------------
let sessionOccupee = false; // une seule session tiers a la fois (la selection d'adherent est cote caisse)

async function avecSession(log, fn) {
  if (sessionOccupee) throw new Error('Une récupération CARCDSF (compte tiers) est déjà en cours — attends sa fin.');
  sessionOccupee = true;
  try {
    const session = await ouvrirSessionTiers({ log });
    try {
      return await fn(session);
    } finally {
      await selectionnerAdherent(session, 0).catch(() => {});
    }
  } finally {
    sessionOccupee = false;
  }
}

// Recupere un adherent deja selectionne : le scraper recoit le matricule comme « login »
// (controle d'appartenance des PDF) et la session tiers au lieu d'identifiants.
function recupererAdherent(scraper, creds, adh, session, opts) {
  return scraper({ ...creds, login: String(adh.matricule) }, { ...opts, session: { base: session.base, H: session.H, dossier: adh.matriculeNature } });
}

/** Recuperation d'UN client gere par le compte tiers (bouton « Récupérer » d'un client). */
export async function scrapeUnClientTiers(scraper, creds, opts = {}) {
  const log = (m) => opts.onLog?.(`[${creds.nom}] ${m}`);
  const mn = Number(String(creds.login).slice(PREFIXE_LOGIN.length));
  try {
    return await avecSession(log, async (session) => {
      await selectionnerAdherent(session, mn);
      return recupererAdherent(scraper, creds, { matriculeNature: mn, matricule: Math.floor(mn / 100) }, session, opts);
    });
  } catch (e) {
    log(`ERREUR : ${e.message}`);
    return { ok: false, error: e.message, docs: [] };
  }
}

/** Test de connexion (Paramètres) : ouvre la session, compte le portefeuille. Tourne en tâche de fond. */
export async function testerTiers({ log = () => {} } = {}) {
  dernierTest = { en_cours: true, le: new Date().toISOString() };
  try {
    const n = await avecSession(log, async (session) => (await listerPortefeuille(session)).length);
    dernierTest = { ok: true, adherents: n, message: `Connecté — ${n} adhérent(s) dans le portefeuille.`, le: new Date().toISOString() };
  } catch (e) {
    dernierTest = { ok: false, message: e.message, le: new Date().toISOString() };
  }
  return dernierTest;
}

/**
 * Remplace la tournee « un compte par client » de la CARCDSF quand le compte tiers est
 * configure (sinon `defaut` = tournee historique). Branche dans creerRouteurSourceLogin.
 */
export function creerTourneeTiers({ db, scraper, ctx }) {
  const { enCours, progression, progLog, demarrerSuivi, terminerSuivi } = ctx;
  return function lancerTous(extra = {}, defaut) {
    if (!tiersConfigure()) return defaut(extra);
    if (enCours.has('carcdsf:all') || sessionOccupee) return { started: false };
    enCours.add('carcdsf:all');
    ctx.resetArret();
    demarrerSuivi(0);
    (async () => {
      try {
        await avecSession(progLog, async (session) => {
          const portefeuille = await listerPortefeuille(session);
          progLog(`Portefeuille tiers : ${portefeuille.length} adhérent(s).`);
          progression.total = portefeuille.length;
          const geres = new Set();
          for (const adh of portefeuille) {
            if (ctx.doitArreter()) {
              progLog('Arrêt demandé.');
              break;
            }
            let nom = `${adh.nom} ${adh.prenom}`.trim();
            let cle = null;
            try {
              const id = clientPourAdherent(db, adh, session.base, progLog);
              geres.add(id);
              const creds = db.getClientCredentials(id);
              nom = creds.nom;
              progression.courant = nom;
              cle = `carcdsf:${id}`;
              enCours.add(cle);
              await selectionnerAdherent(session, adh.matriculeNature);
              const rr = await recupererAdherent(scraper, creds, adh, session, { ...extra, onLog: progLog });
              progression.resultats.push({
                nom,
                ok: !!rr?.ok,
                message: rr?.ok ? `${rr.docs?.length ?? 0} nouveau(x)${rr.dejaPresents ? ` + ${rr.dejaPresents} déjà présent(s)` : ''}` : rr?.error || 'erreur',
                nb_docs: rr?.docs?.length ?? 0,
              });
            } catch (e) {
              progLog(`[${nom}] ERREUR : ${e.message}`);
              progression.resultats.push({ nom, ok: false, message: e.message, nb_docs: 0 });
            } finally {
              if (cle) enCours.delete(cle);
              progression.fait++;
            }
          }
          const horsPortefeuille = db.listClients().filter((c) => !geres.has(c.id));
          if (horsPortefeuille.length)
            progLog(
              `${horsPortefeuille.length} client(s) CARCDSF absent(s) du portefeuille tiers, non récupéré(s) : ${horsPortefeuille.map((c) => c.nom).join(', ')} — ajoute-les au portefeuille sur adherents.carcdsf.fr.`,
            );
        });
      } catch (e) {
        progLog(`ERREUR compte tiers CARCDSF : ${e.message}`);
      } finally {
        enCours.delete('carcdsf:all');
        terminerSuivi();
        progLog('Récupération CARCDSF (compte tiers) terminée.');
      }
    })();
    return { started: true, total: 0, ignores: [], deja: 0, tiers: true };
  };
}
