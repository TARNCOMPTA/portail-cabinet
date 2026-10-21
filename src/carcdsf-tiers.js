// Compte TIERS DELEGATAIRE CARCDSF (cabinet) : UNE connexion pour tout le portefeuille
// d'adherents, au lieu d'un identifiant par client. La caisse impose une double
// authentification (code par e-mail) : le code est lu dans la boite des codes Microsoft 365
// (src/boite-codes.js) ou saisi dans le bandeau du portail (src/captcha-relais.js), puis
// l'appareil est memorise (jeton chiffre) pour ne plus redemander de code tant que la caisse
// ne l'invalide pas.
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
import { boiteConfiguree, codesCarcdsfDepuis } from './boite-codes.js';

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
const ATTENTE_CODE_MS = Number(process.env.CARCDSF_ATTENTE_CODE_MS || 10 * 60 * 1000);

// ---- Configuration (reglages chiffres), un compte tiers PAR ESPACE -----------
// La CARCDSF a deux espaces (base 0 = chirurgiens-dentistes, base 1 = sages-femmes) avec
// chacun son compte tiers, son portefeuille et son appareil memorise.
export const ESPACES = { 0: 'chirurgiens-dentistes', 1: 'sages-femmes' };
const normBase = (b) => (Number(b) === 1 ? 1 : 0);
const cle = (base, nom) => `carcdsf_tiers_${base}_${nom}`;

function lireSecret(k) {
  const v = getSetting(k, '') || '';
  return v ? decrypt(v) : '';
}

// Reprise de la configuration a compte unique (1.13.12 a 1.13.14) dans l'espace choisi alors.
function migrerAncienneConfig() {
  const login = getSetting('carcdsf_tiers_login', '') || '';
  if (!login) return;
  const b = normBase(getSetting('carcdsf_tiers_base', '0'));
  if (!getSetting(cle(b, 'login'), '')) {
    setSetting(cle(b, 'login'), login);
    setSetting(cle(b, 'password_enc'), getSetting('carcdsf_tiers_password_enc', '') || '');
    setSetting(cle(b, 'jeton_enc'), getSetting('carcdsf_tiers_jeton_enc', '') || '');
  }
  for (const k of ['carcdsf_tiers_login', 'carcdsf_tiers_password_enc', 'carcdsf_tiers_jeton_enc', 'carcdsf_tiers_base']) setSetting(k, '');
}

export function configTiers(base = 0) {
  migrerAncienneConfig();
  const b = normBase(base);
  return { base: b, login: getSetting(cle(b, 'login'), '') || '', password: lireSecret(cle(b, 'password_enc')), jeton: lireSecret(cle(b, 'jeton_enc')) };
}

/** Espaces dont le compte tiers est renseigne (identifiant + mot de passe). */
export function espacesConfigures() {
  return [0, 1].filter((b) => {
    const c = configTiers(b);
    return !!(c.login && c.password);
  });
}

export function tiersConfigure() {
  return espacesConfigures().length > 0;
}

const derniersTests = {}; // base -> { ok, message, adherents, le } | { en_cours }

export function etatTiers() {
  return {
    configure: tiersConfigure(),
    comptes: [0, 1].map((b) => {
      const c = configTiers(b);
      return {
        base: b,
        espace: ESPACES[b],
        login: c.login,
        mot_de_passe_defini: !!c.password,
        appareil_memorise: !!c.jeton,
        configure: !!(c.login && c.password),
        dernier_test: derniersTests[b] || null,
      };
    }),
  };
}

/** Enregistre le compte d'un espace. Mot de passe vide = inchange ; `oublier_appareil` force un nouveau code ; `effacer` supprime ce compte. */
export function enregistrerTiers({ base = 0, login, password, oublier_appareil, effacer } = {}) {
  migrerAncienneConfig();
  const b = normBase(base);
  if (effacer === true) {
    for (const n of ['login', 'password_enc', 'jeton_enc']) setSetting(cle(b, n), '');
    delete derniersTests[b];
    return etatTiers();
  }
  if (typeof login === 'string') {
    const l = login.trim();
    // Changer de compte invalide l'appareil memorise (jeton rattache a l'ancien pseudo).
    if (l !== (getSetting(cle(b, 'login'), '') || '')) setSetting(cle(b, 'jeton_enc'), '');
    setSetting(cle(b, 'login'), l);
  }
  if (typeof password === 'string' && password) setSetting(cle(b, 'password_enc'), encrypt(password));
  if (oublier_appareil === true) setSetting(cle(b, 'jeton_enc'), '');
  return etatTiers();
}

// Login des clients geres par un compte tiers : « tiers:<dossier> » (dentistes, format
// historique) ou « tiers:1:<dossier> » (sages-femmes).
export const PREFIXE_LOGIN = 'tiers:';
export const loginTiers = (base, mn) => `${PREFIXE_LOGIN}${normBase(base) === 1 ? '1:' : ''}${mn}`;
export function lireLoginTiers(login) {
  const reste = String(login || '').slice(PREFIXE_LOGIN.length);
  const [a, b] = reste.split(':');
  return b === undefined ? { base: 0, matriculeNature: Number(a) } : { base: normBase(a), matriculeNature: Number(b) };
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

// Obtient le code de double authentification : lu AUTOMATIQUEMENT dans la boite des codes
// (Microsoft 365, src/boite-codes.js) si elle est configuree, et dans tous les cas saisissable
// dans le bandeau du portail — le premier code accepte par la caisse l'emporte. Resout avec le
// jeton (= identifiant 2FA) a memoriser.
async function obtenirCode2FA(cfg, infos, log) {
  const nc = `${HOST}/InternetWebServicesNonConnectes/${cfg.base}`;
  const id = String(infos.identifiant || '');
  if (!id) throw new Error(`Double authentification demandée mais identifiant 2FA absent. (${cles(infos)})`);
  const demandeLe = new Date(Date.now() - 60000).toISOString(); // marge pour l'horloge du serveur mail
  const envoi = await appel(`${nc}/internaute/code2FA/V1/${encodeURIComponent(id)}/mail`, { method: 'POST' });
  if (envoi.json.codeRetour !== 0 && envoi.json.codeRetour != null)
    throw new Error(`Envoi du code refusé par la CARCDSF : ${(envoi.json.libelle || '').trim() || diagnostic(envoi.json)}`);
  const dest = infos.email ? ` à ${infos.email}` : '';
  const auto = boiteConfiguree();
  log(
    `Double authentification : code envoyé par e-mail${dest}. ${auto ? 'Lecture automatique de la boîte des codes…' : 'Saisis-le dans le bandeau du portail.'}`,
  );

  const verifier = async (code) => {
    const c = String(code || '')
      .trim()
      .toUpperCase();
    if (c.length < 6) return false;
    const v = await appel(`${nc}/internaute/verifiercode2FA/V1/${encodeURIComponent(id)}/${encodeURIComponent(c)}/email`, {
      method: 'POST',
      body: DESCRIPTION,
    });
    return v.json.vrai === true;
  };
  const pause = (ms) => new Promise((ok) => setTimeout(ok, ms));

  return await new Promise((resoudre, rejeter) => {
    let fini = false;
    let banniere = false;
    const terminer = (err) => {
      if (fini) return;
      fini = true;
      clearTimeout(minuterie);
      if (banniere) captchaRelais.fermer();
      if (err) rejeter(err);
      else resoudre(id);
    };
    const minuterie = setTimeout(
      () => terminer(new Error('Code de double authentification CARCDSF non saisi à temps — relance la récupération CARCDSF depuis le portail.')),
      ATTENTE_CODE_MS,
    );

    // Bandeau (partage avec la captcha impots : on attend qu'il se libere).
    (async () => {
      while (!fini && captchaRelais.etat().actif) await pause(2000);
      if (fini) return;
      banniere = true;
      captchaRelais.ouvrir({
        titre: '🔐 Code CARCDSF — à toi de jouer',
        message: `La CARCDSF a envoyé un code à 6 chiffres par e-mail${dest}.${auto ? ' Le portail le cherche aussi dans la boîte des codes.' : ''} Recopie-le ci-dessous : la connexion du compte tiers et la récupération s'enchaînent toutes seules.`,
        soumettre: async (code) => {
          if (fini) return { ok: true, connecte: true };
          if (String(code || '').trim().length < 6) return { ok: false, refuse: true, error: 'Le code comporte 6 chiffres.' };
          if (!(await verifier(code))) return { ok: false, refuse: true, error: 'Code refusé par la CARCDSF — vérifie le dernier e-mail reçu.' };
          terminer();
          return { ok: true, connecte: true };
        },
      });
    })();

    // Lecture automatique de la boite (lecture seule, mails recus apres la demande).
    if (auto)
      (async () => {
        const essayes = new Set();
        while (!fini) {
          try {
            for (const code of await codesCarcdsfDepuis(demandeLe)) {
              if (fini || essayes.has(code)) continue;
              essayes.add(code);
              if (await verifier(code)) {
                log('Code lu automatiquement dans la boîte des codes et accepté par la CARCDSF.');
                return terminer();
              }
            }
          } catch (e) {
            log(`(boîte des codes : ${e.message} — le bandeau reste disponible)`);
            await pause(25000);
          }
          await pause(5000);
        }
      })();
  });
}

/**
 * Ouvre une session du compte tiers. Peut attendre le code de double authentification.
 * @returns {Promise<{base:number, API:string, H:object, ref:number}>}
 */
export async function ouvrirSessionTiers({ base = 0, log = () => {} } = {}) {
  const cfg = configTiers(base);
  if (!cfg.login || !cfg.password) throw new Error(`Compte tiers CARCDSF ${ESPACES[cfg.base]} non configuré (Paramètres ▸ Compte tiers CARCDSF).`);
  log(`Connexion du compte tiers CARCDSF (${ESPACES[cfg.base]})`);
  let { json, authorization } = await connexion(cfg, cfg.jeton);
  if (json.infos2FA) {
    if (cfg.jeton) log('Appareil mémorisé refusé par la caisse : nouveau code nécessaire.');
    setSetting(cle(cfg.base, 'jeton_enc'), '');
    const jeton = await obtenirCode2FA(cfg, json.infos2FA, log);
    ({ json, authorization } = await connexion(cfg, jeton));
    if (json.infos2FA) throw new Error(`Code accepté mais la caisse redemande la double authentification. (${diagnostic(json)})`);
    setSetting(cle(cfg.base, 'jeton_enc'), encrypt(jeton));
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
  log(`Compte tiers ${ESPACES[cfg.base]} connecté.`);
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
    .sort();

// Une lettre d'ecart par mot tolérée (mots de 5 lettres et plus) : la caisse ecrit
// « VEYSSIERE » quand la fiche du portail porte « VEYSSIERES ».
function uneLettreDEcart(a, b) {
  if (a === b) return true;
  if (Math.min(a.length, b.length) < 5 || Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  const [x, y] = [a.slice(i + (a.length >= b.length ? 1 : 0)), b.slice(i + (b.length >= a.length ? 1 : 0))];
  return x === y;
}
const memeNom = (a, b) => a.length > 0 && a.length === b.length && a.every((m, i) => uneLettreDEcart(m, b[i]));

/**
 * Trouve (ou cree) le client du portail d'un adherent du portefeuille. Un client individuel
 * de meme nom est BASCULE sur le compte tiers (identifiants individuels supprimes,
 * historique de documents conserve).
 */
export function clientPourAdherent(db, adh, base, log = () => {}) {
  const login = loginTiers(base, adh.matriculeNature);
  const existant = db.getClientByLogin(login);
  if (existant) return existant.id;
  const nomComplet = [adh.nom, adh.prenom].filter(Boolean).join(' ');
  const motsNom = jetons(nomComplet);
  const homonyme = db.listClients().find((c) => !String(c.login).startsWith(PREFIXE_LOGIN) && memeNom(jetons(c.nom), motsNom));
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

async function avecSession(base, log, fn) {
  if (sessionOccupee) throw new Error('Une récupération CARCDSF (compte tiers) est déjà en cours — attends sa fin.');
  sessionOccupee = true;
  try {
    const session = await ouvrirSessionTiers({ base, log });
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
  const { base, matriculeNature: mn } = lireLoginTiers(creds.login);
  try {
    return await avecSession(base, log, async (session) => {
      await selectionnerAdherent(session, mn);
      return recupererAdherent(scraper, creds, { matriculeNature: mn, matricule: Math.floor(mn / 100) }, session, opts);
    });
  } catch (e) {
    log(`ERREUR : ${e.message}`);
    return { ok: false, error: e.message, docs: [] };
  }
}

/** Test de connexion d'un espace (Paramètres) : ouvre la session, compte le portefeuille. Tourne en tâche de fond. */
export async function testerTiers({ base = 0, log = () => {} } = {}) {
  const b = normBase(base);
  derniersTests[b] = { en_cours: true, le: new Date().toISOString() };
  try {
    const n = await avecSession(b, log, async (session) => (await listerPortefeuille(session)).length);
    derniersTests[b] = { ok: true, adherents: n, message: `Connecté — ${n} adhérent(s) dans le portefeuille.`, le: new Date().toISOString() };
  } catch (e) {
    derniersTests[b] = { ok: false, message: e.message, le: new Date().toISOString() };
  }
  return derniersTests[b];
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
      const geres = new Set();
      let portefeuillesLus = 0;
      try {
        for (const base of espacesConfigures()) {
          if (ctx.doitArreter()) break;
          try {
            await avecSession(base, progLog, async (session) => {
              const portefeuille = await listerPortefeuille(session);
              portefeuillesLus++;
              progLog(`Portefeuille tiers ${ESPACES[base]} : ${portefeuille.length} adhérent(s).`);
              progression.total += portefeuille.length;
              for (const adh of portefeuille) {
                if (ctx.doitArreter()) {
                  progLog('Arrêt demandé.');
                  break;
                }
                let nom = `${adh.nom} ${adh.prenom}`.trim();
                let verrou = null;
                try {
                  const id = clientPourAdherent(db, adh, session.base, progLog);
                  geres.add(id);
                  const creds = db.getClientCredentials(id);
                  nom = creds.nom;
                  progression.courant = nom;
                  verrou = `carcdsf:${id}`;
                  enCours.add(verrou);
                  await selectionnerAdherent(session, adh.matriculeNature);
                  const rr = await recupererAdherent(scraper, creds, adh, session, { ...extra, onLog: progLog });
                  progression.resultats.push({
                    nom,
                    ok: !!rr?.ok,
                    message: rr?.ok
                      ? `${rr.docs?.length ?? 0} nouveau(x)${rr.dejaPresents ? ` + ${rr.dejaPresents} déjà présent(s)` : ''}`
                      : rr?.error || 'erreur',
                    nb_docs: rr?.docs?.length ?? 0,
                  });
                } catch (e) {
                  progLog(`[${nom}] ERREUR : ${e.message}`);
                  progression.resultats.push({ nom, ok: false, message: e.message, nb_docs: 0 });
                } finally {
                  if (verrou) enCours.delete(verrou);
                  progression.fait++;
                }
              }
            });
          } catch (e) {
            // Un espace en echec (connexion, code non saisi) n'empeche pas l'autre.
            progLog(`ERREUR compte tiers CARCDSF ${ESPACES[base]} : ${e.message}`);
          }
        }
        // Signalement seulement si tous les portefeuilles ont ete lus (sinon faux positifs).
        if (portefeuillesLus === espacesConfigures().length) {
          const horsPortefeuille = db.listClients().filter((c) => !geres.has(c.id));
          if (horsPortefeuille.length)
            progLog(
              `${horsPortefeuille.length} client(s) CARCDSF absent(s) des portefeuilles tiers, non récupéré(s) : ${horsPortefeuille.map((c) => c.nom).join(', ')} — ajoute-les au portefeuille sur adherents.carcdsf.fr.`,
            );
        }
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
