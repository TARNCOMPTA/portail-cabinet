import 'dotenv/config';
import express from 'express';
import JSZip from 'jszip';
import { dirname, resolve, basename, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readdirSync, statSync, readFileSync } from 'node:fs';
import {
  listClients,
  getClient,
  createClient,
  updateClient,
  deleteClient,
  getClientBySiret,
  importClients,
  listDocuments,
  listAllDocuments,
  getDocument,
  addDocument as addDocumentImpots,
  listRuns,
  getSetting,
  setSetting,
  documentAvecChemin,
  listCabinets,
  getCabinetFull,
  createCabinet,
  getCabinetByLogin,
  updateCabinet,
  deleteCabinet,
  cabinetsConfigure,
  listUsers,
  getUserByEmail,
  getUserById,
  createUser,
  updateUserPassword,
  setUserActif,
  setUserRole,
  deleteUser,
  deleteUserSessions,
  purgerSessionsExpirees,
  listeNoire,
  bannissementIp,
  setPaiementDocument,
  listCfeSansPaiement,
  resetPaiementCfe,
  stats as statsImpots,
} from './src/db.js';
import { verifierCle } from './src/crypto.js';
import { listerQuarantaine, cheminSur, reintegrer, supprimerQuarantaine, supprimerLot } from './src/quarantaine.js';
import { analyserEntree, indexerPortefeuille } from './src/quarantaine-tri.js';
import { scrapeClient, listerClients, scrapeAll, recupererHabilitations, dossierHabilitations } from './src/scraper-impots.js';
import { filtrerReprise, REPRISE_HEURES, creerDisjoncteur, ECHECS_CONSECUTIFS_MAX } from './src/reprise.js';
import * as carpimko from './src/carpimko-db.js';
import { scrapeClient as scrapeClientCarpimko } from './src/scraper-carpimko.js';
import * as carmf from './src/carmf-db.js';
import { scrapeClient as scrapeClientCarmf } from './src/scraper-carmf.js';
import * as carcdsf from './src/carcdsf-db.js';
import { scrapeClient as scrapeClientCarcdsf } from './src/scraper-carcdsf.js';
import * as carpv from './src/carpv-db.js';
import { scrapeClient as scrapeClientCarpv } from './src/scraper-carpv.js';
import { creerRouteurSourceLogin } from './src/routes/source-login.js';
import * as urssafDb from './src/urssaf-db.js';
import { scrapeClient as scrapeClientUrssaf, scrapeAll as scrapeAllUrssaf, listerClients as listerClientsUrssaf } from './src/scraper-urssaf.js';
import * as fusions from './src/fusions-db.js';
import * as planif from './src/planif-db.js';
import { verifierMaj, appliquerMaj, versionLocale } from './src/update.js';
import { installAuthRoutes, requireAuth, requireAdmin, hashPassword, verifyPassword, apiKeyDefinie, regenererApiKey, revoquerApiKey } from './src/auth.js';
import { installOAuth, requireBearer, baseUrl, CALLBACK_HOSTE } from './src/oauth.js';
import { installMcp } from './src/mcp-http.js';
import * as captchaRelais from './src/captcha-relais.js';
import * as oauthDb from './src/oauth-db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = resolve(__dirname, 'public');
const app = express();
app.set('trust proxy', 1); // derriere le reverse proxy HTTPS : lire X-Forwarded-Proto (cookie Secure)
app.disable('x-powered-by'); // ne pas divulguer « Express »
// En-tetes de securite (sans dependance) : anti-sniffing, anti-clickjacking, referrer discret,
// HTTPS force (HSTS), reduction de la surface d'API navigateur, isolation d'origine.
app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('X-Frame-Options', 'SAMEORIGIN');
  res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.set('Strict-Transport-Security', 'max-age=63072000; includeSubDomains; preload');
  res.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
  res.set('Cross-Origin-Opener-Policy', 'same-origin');
  // Content-Security-Policy : defense en profondeur par-dessus l'echappement XSS deja en
  // place. Tout vient de la meme origine ; seules exceptions justifiees :
  //  - script/style 'unsafe-inline' : l'interface est servie en fichiers STATIQUES (pas
  //    de gabarit serveur pour poser un nonce) et embarque un script de theme inline +
  //    de nombreux styles inline. La CSP bloque tout de meme les scripts d'origine
  //    EXTERNE (injection/exfiltration), le detournement de <base>, <object>/<embed> ;
  //  - img data: : la captcha est renvoyee en data:image/png base64.
  // frame-ancestors 'self' double le X-Frame-Options ; connect-src/form-action 'self'
  // empechent l'exfiltration et la soumission de formulaire vers une origine tierce.
  res.set(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "font-src 'self'",
      "connect-src 'self'",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'self'",
    ].join('; '),
  );
  next();
});
// Anti-brute-force applicatif : bloque tôt toute IP bannie (bans escaladés persistants).
app.use((req, res, next) => bannissementIp.porte(req, res, next));
app.use(express.json());

// --- Marque blanche : nom du cabinet configurable (Paramètres ▸ Collaborateurs) ---
const nomCabinet = () => (getSetting('nom_cabinet', '') || 'Portail Cabinet').trim();
const initialesCabinet = () => {
  const mots = nomCabinet().split(/\s+/).filter(Boolean);
  return ((mots[0]?.[0] || 'P') + (mots[1]?.[0] || mots[0]?.[1] || 'C')).toUpperCase();
};
// Endpoint PUBLIC (la page de login en a besoin) : nom + initiales, rien de sensible.
app.get('/api/branding', (req, res) => res.json({ nom: nomCabinet(), initiales: initialesCabinet() }));
// Controle de sante PUBLIC (pas de donnee sensible) : permet a une surveillance externe
// (n8n, UptimeRobot, docker healthcheck) de verifier que le portail repond vraiment —
// un conteneur « demarre » mais fige repond en erreur ou pas du tout.
app.get('/api/sante', (req, res) => {
  try {
    listCabinets(); // touche la base : detecte un disque plein / une base verrouillee
    res.json({ ok: true, version: versionLocale(), uptime_min: Math.round(process.uptime() / 60) });
  } catch (e) {
    res.status(503).json({ ok: false, erreur: e.message });
  }
});
// Favicon genere a la volee avec les initiales du cabinet (meme style que le logo).
app.get('/favicon.svg', (req, res) => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <rect width="64" height="64" rx="17" fill="#7c2d5e"/>
  <text x="32" y="43" font-family="'Hanken Grotesk', system-ui, 'Segoe UI', sans-serif" font-size="30" font-weight="800" fill="#fff" text-anchor="middle" letter-spacing="-1">${initialesCabinet()}</text>
</svg>`;
  res.set('Content-Type', 'image/svg+xml').set('Cache-Control', 'max-age=3600').send(svg);
});

// --- Assets accessibles SANS connexion (page de login) ---
for (const f of ['login.html', 'login.js', 'style.css', 'favicon.ico']) {
  app.get('/' + f, (req, res) =>
    res.sendFile(resolve(PUBLIC_DIR, f), (e) => {
      if (e) res.status(404).end();
    }),
  );
}
// Polices + icônes hébergées localement : non sensibles, accessibles sans session
// (la page de login en a besoin elle aussi). Cache long (les fichiers sont versionnés).
app.use('/vendor', express.static(resolve(PUBLIC_DIR, 'vendor'), { maxAge: '30d', immutable: true }));
installAuthRoutes(app);

// --- Connecteur MCP distant (OAuth 2.1) : endpoints PUBLICS, proteges par leur
//     propre couche (PKCE + jeton Bearer). A monter AVANT la porte de session. ---
installOAuth(app);
installMcp(app, requireBearer);
oauthDb.purge();

// --- Telechargement direct d'un document via jeton a usage unique (PUBLIC, gate
//     par le jeton genere cote authentifie ; 10 min, supprime apres usage). ---
app.get('/dl/:token', (req, res) => {
  const r = oauthDb.takeDl(String(req.params.token));
  if (!r || r.expires_at < Date.now() || !existsSync(r.path)) return res.status(404).send('Lien invalide ou expiré.');
  res.download(r.path, r.filename);
});

// --- Porte d'authentification : tout le reste exige une session valide ---
purgerSessionsExpirees();
app.use(requireAuth);

// --- Statique protege (index.html, app.js, ...) ---
app.use(express.static(PUBLIC_DIR));

const enCours = new Set();

// ---- Suivi d'avancement PAR SOURCE (en memoire, lu via /api/progress) -------
// Plusieurs organismes peuvent etre recuperes EN PARALLELE : chaque source a donc
// son propre suivi et son propre drapeau d'arret (avant : un objet + un drapeau
// globaux, le 2e lot effacait le suivi du 1er et « Arreter » coupait tout).
// Les objets sont crees UNE FOIS ici et MUTES sur place : src/routes/source-login.js
// capture la reference a la construction du routeur (au boot), un remplacement
// d'objet la rendrait fantome (panneau figé a 0/0, sans erreur).
const SOURCES = ['impots', 'urssaf', 'carpimko', 'carmf', 'carcdsf', 'carpv'];
const suivis = new Map(
  SOURCES.map((s) => [s, { source: s, actif: false, total: 0, fait: 0, courant: null, demarre_le: null, fini_le: null, resultats: [], logs: [] }]),
);
const suiviDe = (source) => suivis.get(source) || suivis.get('impots');
// Sources dont l'arret a ete demande par l'utilisateur (bouton « Arreter »).
const arrets = new Set();
const arretDemande = (source) => arrets.has(source);
// Clients RESERVES par un lot en cours (cle `source:id`). Les lots impots et URSSAF
// traitent leurs clients a l'interieur du scraper : sans reservation, le bouton
// « Recuperer » d'un client passait pendant le lot -> DEUX sessions simultanees sur le
// meme compte (captcha impots detournee, session URSSAF « collante » qui ramene les
// documents d'un autre dossier). Registre separe de `enCours` pour ne pas gonfler
// /api/status, sonde toutes les 4 s par l'interface.
const reserves = new Set();
const reserverClients = (source, ids) => {
  for (const id of ids) reserves.add(`${source}:${id}`);
};
const libererClients = (source, ids) => {
  for (const id of ids) reserves.delete(`${source}:${id}`);
};
const estReserve = (source, id) => reserves.has(`${source}:${id}`);

// Fenetre d'affichage de la vue AGREGEE (/api/progress sans parametre) : ouverte
// quand une source demarre alors qu'aucune ne tournait. Sa date doit rester STABLE
// tant que des sources s'enchainent, sinon l'interface reaffiche le panneau a chaque
// nouveau demarrage (public/app.js remet progressMasque a false quand elle change).
const fenetre = { demarre_le: null };

// Fabrique de journal : les scrapers recoivent un callback `onLog(ligne)` a UN seul
// argument (9 sites d'appel) — d'ou une fonction par source plutot qu'un parametre
// supplementaire qu'un site d'appel oublierait silencieusement.
function journalDe(source) {
  const p = suiviDe(source);
  return (ligne) => {
    p.logs.push(`${new Date().toLocaleTimeString('fr-FR')}  ${ligne}`);
    if (p.logs.length > 400) p.logs.splice(0, p.logs.length - 400);
  };
}
function demarrerSuivi(source, total) {
  if (!Number.isFinite(total)) throw new Error(`demarrerSuivi(${source}) : total invalide (${total})`);
  const p = suiviDe(source);
  p.actif = true;
  p.total = total;
  p.fait = 0;
  p.courant = null;
  p.resultats = [];
  p.logs = [];
  p.demarre_le = new Date().toISOString();
  p.fini_le = null;
  // Un nouveau lancement annule un arret demande SUR CETTE SOURCE uniquement
  // (a placer apres le garde 409 des routes, sinon un 2e POST effacerait le
  // drapeau du lot en cours).
  arrets.delete(source);
  // Nouvelle fenetre d'affichage seulement si aucune AUTRE source ne tournait.
  if (![...suivis.values()].some((x) => x !== p && x.actif)) fenetre.demarre_le = p.demarre_le;
}
function terminerSuivi(source) {
  const p = suiviDe(source);
  p.actif = false;
  p.courant = null;
  p.fini_le = new Date().toISOString();
  arrets.delete(source); // filet : l'arret ne doit pas fuir sur le lot suivant
  // Webhook sortant (n8n & co) : bilan de CETTE source, fire-and-forget.
  const ok = p.resultats.filter((r) => r.ok);
  const ko = p.resultats.filter((r) => !r.ok);
  envoyerWebhook('recuperation_terminee', {
    source,
    demarre_le: p.demarre_le,
    fini_le: p.fini_le,
    clients_traites: p.resultats.length,
    succes: ok.length,
    echecs: ko.length,
    nouveaux_documents: p.resultats.reduce((n, r) => n + (r.nb_docs || 0), 0),
    nouveaux_documents_detail: nouveauxDocsDepuis(source, p.demarre_le),
    echecs_detail: ko.slice(0, 50).map((r) => ({ nom: r.nom, message: r.message })),
    // Comptes verrouilles (mot de passe refuse) : ils sont EXCLUS des tournees tant que
    // personne ne ressaisit le mot de passe. Sans ce rappel dans le bilan, ils ne
    // figuraient que dans un journal ephemere -> clients oublies pendant des semaines.
    comptes_verrouilles: comptesVerrouilles(source),
  }).catch(() => {});
}

// Raccourcis pour les deux sources cablees en direct dans ce fichier (impots et
// urssaf) : les objets de suivi sont stables, les journaux sont crees une fois.
// Les 4 caisses passent par le routeur generique (voir ctxSource plus bas).
const suiviImpots = suiviDe('impots');
const suiviUrssaf = suiviDe('urssaf');
const journalImpots = journalDe('impots');
const journalUrssaf = journalDe('urssaf');

// Clients dont le compte est verrouille (dernier echec = mot de passe refuse) : ils sont
// exclus des tournees automatiques. Les impots n'ont pas cette notion (connexion par
// compte cabinet + captcha, pas de mot de passe par client).
function comptesVerrouilles(source) {
  try {
    const bases = { urssaf: urssafDb, carpimko, carmf, carcdsf, carpv };
    const base = bases[source];
    if (!base?.listClients) return [];
    return base
      .listClients()
      .filter((c) => c.verrouille)
      .slice(0, 100)
      .map((c) => ({ nom: c.nom, message: c.dernier_message || null }));
  } catch {
    return [];
  }
}

// Une recuperation de cette source a-t-elle eu lieu depuis l'horodatage donne ?
// Sert au controle « tournee manquee ». `lance_le` est stocke en UTC par SQLite.
function aEuUnRunDepuis(source, depuisMs) {
  try {
    const bases = { impots: { listRuns }, urssaf: urssafDb, carpimko, carmf, carcdsf, carpv };
    const base = bases[source];
    if (!base?.listRuns) return true; // source inconnue : ne pas alerter a tort
    return base.listRuns(50).some((r) => new Date(String(r.lance_le || '').replace(' ', 'T') + 'Z').getTime() >= depuisMs);
  } catch {
    return true; // en cas de doute, pas d'alerte
  }
}

// Detail des documents enregistres depuis le debut du suivi (pour le webhook :
// « quel client, quel document ») — plafonne a 200 entrees. Les messages de la
// messagerie impots (eventid MSG_<num>, fichier .txt) portent en plus leur texte
// (plafonne) pour pouvoir l'afficher directement dans un mail n8n.
function nouveauxDocsDepuis(source, demarreLe) {
  try {
    const fn = DOCS_PAR_SOURCE[source];
    if (!fn || !demarreLe) return [];
    const seuil = new Date(demarreLe).getTime();
    return fn()
      .filter((d) => new Date(String(d.recupere_le || '').replace(' ', 'T') + 'Z').getTime() >= seuil)
      .slice(0, 200)
      .map((d) => {
        const item = { id: d.id, client: d.client_nom || null, libelle: d.libelle || (d.fichier || '').split(/[\\/]/).pop() };
        // Avis CFE/TF : mode de paiement detecte (echeance|mensualise|aucun|inconnu).
        if (d.paiement) item.paiement = d.paiement;
        if (source === 'impots' && /^MSG_\d+$/.test(d.eventid || '') && d.fichier && existsSync(d.fichier)) {
          try {
            item.texte = readFileSync(d.fichier, 'utf8').slice(0, 3000);
          } catch {}
        }
        return item;
      });
  } catch {
    return [];
  }
}

// ---- Webhook sortant (integration n8n & co) ---------------------------------
// Notifie une URL externe a chaque fin de recuperation (bilan JSON). URL + secret
// optionnel configures dans Parametres ▸ Collaborateurs ▸ Integration n8n.
async function envoyerWebhook(evenement, data) {
  const url = (getSetting('webhook_url', '') || '').trim();
  if (!url) return { ok: false, error: 'Aucune URL de webhook configurée.' };
  const secret = getSetting('webhook_secret', '') || '';
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(secret ? { 'X-Webhook-Secret': secret } : {}) },
      body: JSON.stringify({ evenement, date: new Date().toISOString(), cabinet: nomCabinet(), portail: process.env.PUBLIC_URL || '', ...data }),
      signal: ctrl.signal,
    });
    clearTimeout(t);
    return { ok: r.ok, statut: r.status };
  } catch (e) {
    console.warn('[webhook] ' + e.message);
    return { ok: false, error: e.message };
  }
}

// ---- Utilisateurs (collaborateurs) ----------------------------------------
app.get('/api/me', (req, res) => res.json({ user: req.user }));

app.post('/api/me/password', (req, res) => {
  const np = String(req.body?.nouveau || '');
  if (np.length < 8) return res.status(400).json({ error: 'Mot de passe trop court (8 caractères minimum).' });
  // Re-authentification : le mot de passe ACTUEL est exige avant tout changement. Sans
  // cela, une session detournee (poste non verrouille, cookie exfiltre) permettait de
  // changer le mot de passe sans connaitre l'ancien — donc de verrouiller le compte
  // legitime. L'acces par cle API (viaApiKey) n'a pas de mot de passe : on le refuse ici.
  if (req.user.viaApiKey) return res.status(403).json({ error: 'Changement de mot de passe indisponible via clé API.' });
  const actuel = String(req.body?.actuel || '');
  const u = getUserByEmail(req.user.email);
  if (!u || !verifyPassword(actuel, u.password_hash)) return res.status(403).json({ error: 'Mot de passe actuel incorrect.' });
  updateUserPassword(req.user.id, hashPassword(np));
  deleteUserSessions(req.user.id);
  res.json({ ok: true });
});

app.get('/api/users', requireAdmin, (req, res) => res.json(listUsers()));

app.post('/api/users', requireAdmin, (req, res) => {
  const email = String(req.body?.email || '')
    .trim()
    .toLowerCase();
  const nom = String(req.body?.nom || '').trim();
  const pwd = String(req.body?.password || '');
  const role = req.body?.role === 'admin' ? 'admin' : 'membre';
  if (!email || !pwd) return res.status(400).json({ error: 'E-mail et mot de passe requis.' });
  if (pwd.length < 8) return res.status(400).json({ error: 'Mot de passe trop court (8 caractères minimum).' });
  if (getUserByEmail(email)) return res.status(409).json({ error: 'Un utilisateur avec cet e-mail existe déjà.' });
  res.status(201).json(createUser({ email, nom, password_hash: hashPassword(pwd), role }));
});

app.put('/api/users/:id', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const u = getUserById(id);
  if (!u) return res.status(404).json({ error: 'Utilisateur introuvable.' });
  if (typeof req.body?.role === 'string') {
    if (u.id === req.user.id && req.body.role !== 'admin') return res.status(400).json({ error: 'Tu ne peux pas retirer ton propre rôle admin.' });
    setUserRole(id, req.body.role === 'admin' ? 'admin' : 'membre');
  }
  if (typeof req.body?.actif === 'boolean') {
    if (u.id === req.user.id && !req.body.actif) return res.status(400).json({ error: 'Tu ne peux pas désactiver ton propre compte.' });
    setUserActif(id, req.body.actif);
    if (!req.body.actif) deleteUserSessions(id);
  }
  if (req.body?.password) {
    if (String(req.body.password).length < 8) return res.status(400).json({ error: 'Mot de passe trop court (8 caractères minimum).' });
    updateUserPassword(id, hashPassword(String(req.body.password)));
    deleteUserSessions(id);
  }
  res.json(getUserById(id));
});

app.delete('/api/users/:id', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  if (id === req.user.id) return res.status(400).json({ error: 'Tu ne peux pas supprimer ton propre compte.' });
  deleteUserSessions(id);
  deleteUser(id);
  res.json({ ok: true });
});

// ---- Clé API (pour le MCP / accès programmatique) -------------------------
// Le clair n'est renvoyé QU'À la (re)génération ; ensuite seul « definie » est visible.
app.get('/api/apikey', requireAdmin, (req, res) => {
  res.json({ definie: apiKeyDefinie() });
});
app.post('/api/apikey/regenerer', requireAdmin, (req, res) => {
  res.json({ key: regenererApiKey(), definie: true });
});
app.delete('/api/apikey', requireAdmin, (req, res) => {
  revoquerApiKey();
  res.json({ ok: true, definie: false });
});

// ---- Sécurité : IP bannies (anti-brute-force applicatif) ----
app.get('/api/securite/ip-bannies', requireAdmin, (req, res) => res.json(bannissementIp.liste()));
app.delete('/api/securite/ip-bannies/:ip', requireAdmin, (req, res) => {
  if (!bannissementIp.debloquer(req.params.ip)) return res.status(404).json({ error: 'IP non bannie' });
  res.json({ ok: true });
});

// ---- Connecteur MCP « organisation » (OAuth) : URL + Client ID/Secret -----
// Meme principe : le Client Secret n'est renvoyé qu'à la création/régénération.
app.get('/api/mcp-oauth/client', requireAdmin, (req, res) => {
  const c = oauthDb.getOrCreateStaticClient([CALLBACK_HOSTE]);
  res.json({ url: `${baseUrl(req)}/mcp`, client_id: c.client_id, client_secret: c.client_secret_clair || null, secret_defini: !!c.client_secret });
});
app.post('/api/mcp-oauth/regenerer', requireAdmin, (req, res) => {
  const c = oauthDb.regenStaticClient([CALLBACK_HOSTE]);
  res.json({ url: `${baseUrl(req)}/mcp`, client_id: c.client_id, client_secret: c.client_secret_clair, secret_defini: true });
});

// ---- Comptes cabinet ------------------------------------------------------
app.get('/api/cabinets', (req, res) => res.json(listCabinets()));

app.post('/api/cabinets', (req, res) => {
  const { libelle, login, password } = req.body || {};
  // Connexion manuelle (captcha) : le mot de passe est facultatif (juste pour mémo).
  if (!login) return res.status(400).json({ error: 'Identifiant du cabinet (e-mail) requis.' });
  if (getCabinetByLogin(login)) return res.status(409).json({ error: 'Un compte avec cet e-mail existe déjà.' });
  res.status(201).json(createCabinet({ libelle, login, password }));
});

app.put('/api/cabinets/:id', (req, res) => {
  const c = updateCabinet(Number(req.params.id), req.body || {});
  if (!c) return res.status(404).json({ error: 'Cabinet introuvable.' });
  res.json(c);
});

app.delete('/api/cabinets/:id', (req, res) => {
  deleteCabinet(Number(req.params.id));
  res.json({ ok: true });
});

// Synchronise le portefeuille d'UN cabinet (importe ses clients, rattaches a ce cabinet).
app.post('/api/cabinets/:id/sync', async (req, res) => {
  const id = Number(req.params.id);
  const cab = getCabinetFull(id);
  if (!cab) return res.status(404).json({ error: 'Cabinet introuvable.' });
  const key = 'sync:' + id;
  if (enCours.has(key)) return res.status(409).json({ error: 'Synchronisation déjà en cours pour ce cabinet.' });
  enCours.add(key);
  try {
    const rows = await listerClients(cab);
    // Liste noire : les clients supprimes volontairement ne sont pas recrees.
    const aImporter = rows.filter((r) => !listeNoire.estListeNoire(r.siret));
    const bilan = importClients(aImporter, id);
    res.json({ ...bilan, total: rows.length, liste_noire: rows.length - aImporter.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  } finally {
    enCours.delete(key);
  }
});

// ---- Tableau des habilitations (par compte espace pro) --------------------
// Liste les tableaux deja telecharges pour un compte.
app.get('/api/cabinets/:id/habilitations', (req, res) => {
  const cab = getCabinetFull(Number(req.params.id));
  if (!cab) return res.status(404).json({ error: 'Cabinet introuvable.' });
  const dir = dossierHabilitations(cab);
  let fichiers = [];
  try {
    fichiers = readdirSync(dir)
      .filter((f) => !f.startsWith('_diag') && !f.startsWith('.'))
      .map((f) => {
        // Un seul statSync par fichier (il y en avait deux, pour la meme donnee).
        const st = statSync(resolve(dir, f));
        return { nom: f, taille: st.size, modifie: st.mtime.toISOString() };
      })
      // Dates ISO, format fixe : comparaison binaire, pas de collation Intl.
      .sort((a, b) => (a.modifie < b.modifie ? 1 : a.modifie > b.modifie ? -1 : 0));
  } catch {
    /* dossier absent = aucun tableau */
  }
  res.json(fichiers);
});

// Sert un tableau d'habilitations (anti-LFI : nom simple, resolu DANS le dossier du compte).
app.get('/api/cabinets/:id/habilitations/file', (req, res) => {
  const cab = getCabinetFull(Number(req.params.id));
  if (!cab) return res.status(404).end();
  const nom = basename(String(req.query.name || ''));
  const dir = dossierHabilitations(cab);
  const chemin = resolve(dir, nom);
  if (!nom || nom.startsWith('_diag') || !chemin.startsWith(dir) || !existsSync(chemin)) return res.status(404).json({ error: 'Fichier introuvable.' });
  res.download(chemin, nom);
});

// Recupere le tableau d'habilitations SEUL (session captcha dediee).
app.post('/api/cabinets/:id/habilitations', async (req, res) => {
  const id = Number(req.params.id);
  const cab = getCabinetFull(id);
  if (!cab) return res.status(404).json({ error: 'Cabinet introuvable.' });
  const key = 'hab:' + id;
  if (enCours.has(key)) return res.status(409).json({ error: 'Récupération déjà en cours pour ce compte.' });
  enCours.add(key);
  res.json({ started: true });
  const suiviLocal = !suiviImpots.actif;
  if (suiviLocal) {
    demarrerSuivi('impots', 1);
    suiviImpots.courant = `Habilitations — ${cab.libelle || cab.login}`;
  }
  try {
    const r = await recupererHabilitations(cab, { onLog: journalImpots });
    if (suiviLocal)
      suiviImpots.resultats.push({
        nom: `Habilitations — ${cab.libelle || cab.login}`,
        ok: !!r?.ok,
        message: r?.ok ? 'tableau téléchargé' : r?.error || 'échec',
        nb_docs: r?.ok ? 1 : 0,
      });
  } finally {
    enCours.delete(key);
    if (suiviLocal) {
      suiviImpots.fait = 1;
      terminerSuivi('impots');
    }
  }
});

// ---- Clients --------------------------------------------------------------
app.get('/api/clients', (req, res) => res.json(listClients()));

app.post('/api/clients', (req, res) => {
  const { nom, siret, dossier, cabinet_id } = req.body || {};
  if (!nom || !siret) return res.status(400).json({ error: 'nom et SIRET sont requis.' });
  if (getClientBySiret(siret)) return res.status(409).json({ error: 'Un client avec ce SIRET existe déjà.' });
  listeNoire.retirerListeNoireParSiret(siret); // ajout volontaire = sortie de liste noire
  res.status(201).json(createClient({ nom, siret, dossier, cabinet_id: cabinet_id || null }));
});

app.post('/api/clients/import', (req, res) => {
  const clients = req.body?.clients;
  if (!Array.isArray(clients) || clients.length === 0) return res.status(400).json({ error: 'Aucune ligne à importer.' });
  if (clients.length > 5000) return res.status(400).json({ error: 'Trop de lignes (max 5000).' });
  for (const c of clients) listeNoire.retirerListeNoireParSiret(c?.siret); // import volontaire
  res.json(importClients(clients, req.body?.cabinet_id || null));
});

app.put('/api/clients/:id', (req, res) => {
  const c = updateClient(Number(req.params.id), req.body || {});
  if (!c) return res.status(404).json({ error: 'Client introuvable.' });
  res.json(c);
});

// Suppression = mise en liste noire (la synchro ne recreera pas ce client).
app.delete('/api/clients/:id', (req, res) => {
  const c = getClient(Number(req.params.id));
  if (c?.siret) listeNoire.ajouterListeNoire({ siret: c.siret, nom: c.nom, cabinet_id: c.cabinet_id });
  deleteClient(Number(req.params.id));
  res.json({ ok: true, liste_noire: !!c?.siret });
});

// ---- Liste noire (clients supprimes, proteges de la synchro) ---------------
app.get('/api/liste-noire', (req, res) => res.json(listeNoire.listListeNoire()));
app.post('/api/liste-noire/:id/reintegrer', (req, res) => {
  const entree = listeNoire.retirerListeNoire(Number(req.params.id));
  if (!entree) return res.status(404).json({ error: 'Entrée introuvable.' });
  if (getClientBySiret(entree.siret)) return res.json({ ok: true, nom: entree.nom, deja_present: true });
  const cabinetOk = entree.cabinet_id && getCabinetFull(entree.cabinet_id) ? entree.cabinet_id : null;
  const c = createClient({ nom: entree.nom || entree.siret, siret: entree.siret, cabinet_id: cabinetOk });
  res.json({ ok: true, nom: c.nom, client_id: c.id, sans_cabinet: !cabinetOk });
});

app.get('/api/clients/:id/documents', (req, res) => res.json(listDocuments(Number(req.params.id))));

// Tous les documents (tous clients), pour l'onglet « Documents ».
app.get('/api/documents', (req, res) => res.json(listAllDocuments()));

app.get('/api/documents/file', (req, res) => {
  const f = String(req.query.path || '');
  // Ne sert que des chemins correspondant a un document impots enregistre (anti-LFI).
  if (!f || !documentAvecChemin(f) || !existsSync(f)) return res.status(404).end();
  res.sendFile(f);
});

// ---- Messagerie impots (Mes echanges) : messages recuperes en .txt --------
// Un message = document impots dont l'eventid vaut MSG_<num> ; ses PJ = MSG_<num>_PJ<k>.
app.get('/api/messages', (req, res) => {
  const docs = listAllDocuments();
  const messages = docs.filter((d) => /^MSG_\d+$/.test(d.eventid || ''));
  const out = messages
    .map((m) => {
      const prefixe = `${m.eventid}_PJ`;
      const pjs = docs
        .filter((d) => (d.eventid || '').startsWith(prefixe))
        .map((p) => ({ id: p.id, nom: (p.fichier || '').split(/[\\/]/).pop(), fichier: p.fichier }));
      return { id: m.id, client_id: m.client_id, client_nom: m.client_nom, libelle: m.libelle, recupere_le: m.recupere_le, fichier: m.fichier, pieces: pjs };
    })
    .sort((a, b) => String(b.recupere_le || '').localeCompare(String(a.recupere_le || '')));
  res.json(out);
});
app.get('/api/messages/:id/texte', (req, res) => {
  const doc = getDocument(req.params.id);
  if (!doc || !doc.fichier || !existsSync(doc.fichier)) return res.status(404).json({ error: 'Message introuvable.' });
  let texte = '';
  try {
    texte = readFileSync(doc.fichier, 'utf8');
  } catch (e) {
    return res.status(500).json({ error: 'Lecture impossible.' });
  }
  res.json({ id: doc.id, libelle: doc.libelle, client_nom: doc.client_nom, texte });
});

// Toutes les listes de documents, par cle de source (resolution serveur par id).
const DOCS_PAR_SOURCE = {
  impots: listAllDocuments,
  carpimko: carpimko.listAllDocuments,
  carmf: carmf.listAllDocuments,
  urssaf: urssafDb.listAllDocuments,
  carcdsf: carcdsf.listAllDocuments,
  carpv: carpv.listAllDocuments,
};
// Resolution d'UN document par id : toujours en direct dans la base (les listes
// ci-dessus peuvent etre plafonnees — un document ancien en sortirait et
// deviendrait impossible a ouvrir alors que son fichier est intact).
const DOC_PAR_SOURCE = {
  impots: getDocument,
  carpimko: carpimko.getDocument,
  carmf: carmf.getDocument,
  urssaf: urssafDb.getDocument,
  carcdsf: carcdsf.getDocument,
  carpv: carpv.getDocument,
};
// Enregistrement d'un document, par source (utilise par la reintegration depuis la
// quarantaine). Impots et URSSAF indexent par `eventid`, les caisses par `date_doc`.
const AJOUT_PAR_SOURCE = {
  impots: (clientId, m) => addDocumentImpots(clientId, { libelle: m.libelle, fichier: m.fichier, eventid: m.eventid }),
  urssaf: (clientId, m) => urssafDb.addDocument(clientId, { libelle: m.libelle, fichier: m.fichier, eventid: m.eventid }),
  carpimko: (clientId, m) => carpimko.addDocument(clientId, { libelle: m.libelle, fichier: m.fichier, date_doc: m.dateDoc }),
  carmf: (clientId, m) => carmf.addDocument(clientId, { libelle: m.libelle, fichier: m.fichier, date_doc: m.dateDoc }),
  carcdsf: (clientId, m) => carcdsf.addDocument(clientId, { libelle: m.libelle, fichier: m.fichier, date_doc: m.dateDoc }),
  carpv: (clientId, m) => carpv.addDocument(clientId, { libelle: m.libelle, fichier: m.fichier, date_doc: m.dateDoc }),
};

// ---- Quarantaine (documents rejetes par la verification d'appartenance) -----
// Le scan du dossier est SYNCHRONE (des milliers de fichiers + leur manifeste) : le
// refaire a chaque affichage figerait la boucle d'evenements. On garde donc la liste en
// memoire, invalidee des qu'on y touche et rafraichie au bout d'une minute.
const CLIENTS_PAR_SOURCE = {
  impots: () => listClients(),
  urssaf: () => urssafDb.listClients(),
  carpimko: () => carpimko.listClients(),
  carmf: () => carmf.listClients(),
  carcdsf: () => carcdsf.listClients(),
  carpv: () => carpv.listClients(),
};
const QUARANTAINE_TTL = 60_000;
let cacheQuarantaine = { liste: null, le: 0 };
function quarantaineListe(forcer = false) {
  if (forcer || !cacheQuarantaine.liste || Date.now() - cacheQuarantaine.le > QUARANTAINE_TTL) {
    cacheQuarantaine = { liste: listerQuarantaine(), le: Date.now() };
  }
  return cacheQuarantaine.liste;
}
const invaliderQuarantaine = () => {
  cacheQuarantaine = { liste: null, le: 0 };
};

// Etat du tri automatique (une seule analyse a la fois, comme les recuperations).
const tri = {
  actif: false,
  total: 0,
  fait: 0,
  demarre_le: null,
  fini_le: null,
  erreur: null,
  compte: {},
  verdicts: new Map(), // id de quarantaine -> { verdict, motif, proprietaire? }
};
let triArret = false;
const compteVide = () => ({ client: 0, autre: 0, indetermine: 0, illisible: 0, erreur: 0 });
const etatTri = () => ({
  actif: tri.actif,
  total: tri.total,
  fait: tri.fait,
  demarre_le: tri.demarre_le,
  fini_le: tri.fini_le,
  erreur: tri.erreur,
  compte: tri.compte,
  analyses: tri.verdicts.size,
});

// Selection commune a l'affichage et au vidage : le bouton « Vider » doit porter
// EXACTEMENT sur ce que l'ecran montre, sans quoi on supprimerait plus que prevu.
function filtrerQuarantaine({ source, verdict, q }, tout = quarantaineListe()) {
  const texte = String(q || '')
    .trim()
    .toLowerCase();
  let liste = tout;
  if (source) liste = liste.filter((d) => d.source === String(source).trim());
  if (verdict) liste = liste.filter((d) => (tri.verdicts.get(d.id)?.verdict || 'non_analyse') === String(verdict).trim());
  if (texte) liste = liste.filter((d) => `${d.clientNom} ${d.fichier} ${d.source} ${d.libelle || ''}`.toLowerCase().includes(texte));
  return liste;
}

app.get('/api/quarantaine', (req, res) => {
  const tout = quarantaineListe(req.query.rafraichir === '1');
  const liste = filtrerQuarantaine(req.query, tout);
  const taille = Math.min(200, Math.max(10, Number(req.query.taille) || 50));
  const pages = Math.max(1, Math.ceil(liste.length / taille));
  const page = Math.min(pages, Math.max(1, Number(req.query.page) || 1));
  const parSource = {};
  for (const d of tout) parSource[d.source] = (parSource[d.source] || 0) + 1;
  res.json({
    total: tout.length,
    filtres: liste.length,
    page,
    pages,
    taille,
    parSource,
    tri: etatTri(),
    elements: liste.slice((page - 1) * taille, page * taille).map((d) => ({ ...d, tri: tri.verdicts.get(d.id) || null })),
  });
});

// Analyse (a blanc) : chaque PDF est repasse dans la regle actuelle et, s'il est toujours
// rejete, on cherche a quel client du cabinet il appartient reellement. Rien n'est
// deplace ni supprime ici : l'utilisateur applique ensuite ce qu'il valide.
async function analyserQuarantaine() {
  const liste = quarantaineListe(true);
  tri.actif = true;
  tri.total = liste.length;
  tri.fait = 0;
  tri.demarre_le = new Date().toISOString();
  tri.fini_le = null;
  tri.erreur = null;
  tri.compte = compteVide();
  tri.verdicts = new Map();
  const portefeuilles = new Map(); // source -> { clients, index }
  const portefeuille = (source) => {
    if (!portefeuilles.has(source)) {
      let clients = [];
      try {
        clients = CLIENTS_PAR_SOURCE[source] ? CLIENTS_PAR_SOURCE[source]() : [];
      } catch {
        clients = [];
      }
      portefeuilles.set(source, { clients, index: indexerPortefeuille(clients) });
    }
    return portefeuilles.get(source);
  };
  try {
    for (const e of liste) {
      if (triArret) break;
      const chemin = cheminSur(e.id);
      const { clients, index } = portefeuille(e.source);
      const client = e.clientId != null ? clients.find((c) => c.id === e.clientId) || null : null;
      const r = chemin ? await analyserEntree({ chemin, source: e.source, client, index }) : { verdict: 'erreur', motif: 'Chemin de quarantaine invalide.' };
      tri.verdicts.set(e.id, r);
      tri.compte[r.verdict] = (tri.compte[r.verdict] || 0) + 1;
      tri.fait++;
      // L'extraction PDF est gourmande : on rend la main regulierement pour que le
      // portail reste reactif pendant les longues analyses.
      if (tri.fait % 20 === 0) await new Promise((suite) => setImmediate(suite));
    }
  } catch (e) {
    tri.erreur = e.message;
  }
  tri.actif = false;
  tri.fini_le = new Date().toISOString();
}

app.post('/api/quarantaine/analyser', (req, res) => {
  if (tri.actif) return res.status(409).json({ error: 'Une analyse est déjà en cours.' });
  triArret = false;
  analyserQuarantaine().catch((e) => {
    tri.actif = false;
    tri.erreur = e.message;
  });
  res.json({ started: true });
});

app.get('/api/quarantaine/tri', (req, res) => res.json(etatTri()));

app.post('/api/quarantaine/tri/stop', (req, res) => {
  triArret = true;
  res.json({ ok: true });
});

// Applique les verdicts choisis.
//   « client » : le document est bien celui du client. Avec manifeste on le remet en
//                place et on recree sa ligne ; sinon on le retire de la quarantaine — la
//                prochaine recuperation le retelechargera et le classera proprement
//                (avec son identifiant d'evenement, donc sans doublon).
//   « autre »  : document d'un autre client, il n'a rien a faire la : suppression.
app.post('/api/quarantaine/appliquer', (req, res) => {
  if (tri.actif) return res.status(409).json({ error: 'Analyse en cours — attends la fin avant d’appliquer.' });
  const demandes = Array.isArray(req.body?.verdicts) ? req.body.verdicts.filter((v) => v === 'client' || v === 'autre') : [];
  if (!demandes.length) return res.status(400).json({ error: 'Aucun verdict à appliquer.' });
  const bilan = { reintegres: 0, supprimes: 0, echecs: 0, details: [] };
  for (const e of quarantaineListe()) {
    const v = tri.verdicts.get(e.id);
    if (!v || !demandes.includes(v.verdict)) continue;
    try {
      if (v.verdict === 'client' && e.reintegrable) {
        const r = reintegrer(e.id);
        if (!r.ok) throw new Error(r.error);
        const ajouter = AJOUT_PAR_SOURCE[r.meta.source];
        if (!ajouter) {
          r.annuler();
          throw new Error(`Source inconnue : ${r.meta.source}`);
        }
        try {
          ajouter(r.meta.clientId, {
            libelle: r.meta.libelle || basename(r.destination),
            fichier: r.destination,
            eventid: r.meta.eventid || null,
            dateDoc: r.meta.dateDoc || null,
          });
        } catch (err) {
          r.annuler();
          throw err;
        }
        bilan.reintegres++;
      } else {
        const r = supprimerQuarantaine(e.id);
        if (!r.ok) throw new Error(r.error);
        bilan.supprimes++;
      }
      tri.verdicts.delete(e.id);
    } catch (err) {
      bilan.echecs++;
      if (bilan.details.length < 20) bilan.details.push(`${e.clientNom} — ${e.fichier} : ${err.message}`);
    }
  }
  invaliderQuarantaine();
  tri.compte = compteVide();
  for (const v of tri.verdicts.values()) tri.compte[v.verdict] = (tri.compte[v.verdict] || 0) + 1;
  res.json(bilan);
});

// Sert le PDF pour verification visuelle (chemin verrouille dans le dossier de quarantaine).
app.get('/api/quarantaine/file', (req, res) => {
  const p = cheminSur(String(req.query.id || ''));
  if (!p || !existsSync(p) || p.endsWith('.json')) return res.status(404).json({ error: 'Document introuvable.' });
  res.sendFile(p);
});

// « C'est bien ce client » : remet le fichier a sa place ET recree la ligne en base
// (sans quoi il serait retelecharge puis remis en quarantaine au passage suivant).
app.post('/api/quarantaine/reintegrer', (req, res) => {
  const id = String(req.body?.id || '');
  const r = reintegrer(id);
  if (!r.ok) return res.status(400).json({ error: r.error });
  const ajouter = AJOUT_PAR_SOURCE[r.meta.source];
  if (!ajouter) {
    r.annuler();
    return res.status(400).json({ error: `Source inconnue : ${r.meta.source}` });
  }
  try {
    ajouter(r.meta.clientId, {
      libelle: r.meta.libelle || basename(r.destination),
      fichier: r.destination,
      eventid: r.meta.eventid || null,
      dateDoc: r.meta.dateDoc || null,
    });
  } catch (e) {
    r.annuler(); // la base a refuse : on remet le fichier en quarantaine
    return res.status(500).json({ error: `Enregistrement impossible : ${e.message}` });
  }
  tri.verdicts.delete(id);
  invaliderQuarantaine();
  res.json({ ok: true, destination: r.destination });
});

app.delete('/api/quarantaine', (req, res) => {
  const id = String(req.body?.id || req.query.id || '');
  const r = supprimerQuarantaine(id);
  if (!r.ok) return res.status(400).json({ error: r.error });
  tri.verdicts.delete(id);
  invaliderQuarantaine();
  res.json({ ok: true });
});

// Vide la quarantaine : supprime tout ce que les filtres courants selectionnent (aucun
// filtre = la totalite). Reserve aux administrateurs, comme les autres actions de masse.
// Un document supprime n'est PAS perdu : n'ayant jamais ete enregistre en base, il sera
// retelecharge puis reverifie a la recuperation suivante — a moins qu'il n'ait entre-temps
// disparu du site de l'organisme.
//
// L'appelant DOIT annoncer le nombre de documents qu'il croit supprimer : on refuse si
// notre propre selection en compte un autre. Sans ce garde-fou, un ecran laisse ouvert
// supprimerait bien plus que ce qu'il affiche — le filtre « Pas encore analyse » s'inverse
// en « tout » si l'analyse a ete relancee ou le portail redemarre entre-temps (l'etat des
// verdicts vit en memoire), et un filtre modifie juste avant le clic decale la selection.
app.delete('/api/quarantaine/tout', requireAdmin, (req, res) => {
  if (tri.actif) return res.status(409).json({ error: 'Analyse en cours — attends la fin avant de vider.' });
  const filtres = { source: req.body?.source || req.query.source, verdict: req.body?.verdict || req.query.verdict, q: req.body?.q ?? req.query.q };
  const attendu = Number(req.body?.attendu ?? req.query.attendu);
  if (!Number.isInteger(attendu) || attendu < 0) {
    return res.status(400).json({ error: 'Nombre de documents attendu manquant — actualise l’écran avant de vider.' });
  }
  const liste = filtrerQuarantaine(filtres);
  if (liste.length !== attendu) {
    return res.status(409).json({
      error: `La sélection a changé depuis l’affichage (${liste.length} document(s) au lieu de ${attendu}) — actualise l’écran avant de vider.`,
    });
  }
  if (!liste.length) return res.json({ supprimes: 0, echecs: 0, details: [] });
  const { supprimes, echecs } = supprimerLot(liste.map((d) => d.id));
  for (const d of liste) tri.verdicts.delete(d.id);
  tri.compte = compteVide();
  for (const v of tri.verdicts.values()) tri.compte[v.verdict] = (tri.compte[v.verdict] || 0) + 1;
  invaliderQuarantaine();
  res.json({ supprimes, echecs: echecs.length, details: echecs.slice(0, 20) });
});

// Genere un lien de telechargement direct (usage unique, 10 min) pour un document
// d'une source donnee. Resolu cote serveur via l'id (pas de chemin arbitraire).
app.post('/api/documents/lien', (req, res) => {
  const fn = DOC_PAR_SOURCE[String(req.body?.source || '')];
  if (!fn) return res.status(400).json({ error: 'Source inconnue.' });
  const doc = fn(req.body?.document_id);
  if (!doc || !doc.fichier || !existsSync(doc.fichier)) return res.status(404).json({ error: 'Document introuvable.' });
  const token = oauthDb.rnd(24);
  const filename = basename(doc.fichier);
  oauthDb.saveDl({ token, path: doc.fichier, filename, expires_at: Date.now() + 10 * 60 * 1000 });
  res.json({ url: `${baseUrl(req)}/dl/${token}`, filename });
});

// Telechargement EN MASSE : un ZIP des documents demandes ({items:[{source,id}]}),
// ranges par client. Resolution par id uniquement (aucun chemin fourni par le client).
app.post('/api/documents/zip', async (req, res) => {
  const items = Array.isArray(req.body?.items) ? req.body.items : [];
  if (!items.length) return res.status(400).json({ error: 'Aucun document sélectionné.' });
  if (items.length > 2000) return res.status(400).json({ error: 'Trop de documents (max 2000 par archive).' });
  const parSource = new Map();
  for (const it of items) {
    const src = String(it?.source || '');
    if (!DOCS_PAR_SOURCE[src]) return res.status(400).json({ error: `Source inconnue : ${src}` });
    if (!parSource.has(src)) parSource.set(src, new Set());
    parSource.get(src).add(Number(it.id));
  }
  const zip = new JSZip();
  const nomsPris = new Set();
  const propre = (s) =>
    String(s || '')
      // eslint-disable-next-line no-control-regex -- sanitisation volontaire des noms des entrees du zip
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
      .trim() || '_';
  let nb = 0;
  for (const [src, ids] of parSource) {
    for (const id of ids) {
      const doc = DOC_PAR_SOURCE[src](id);
      if (!doc || !doc.fichier || !existsSync(doc.fichier)) continue;
      let chemin = `${propre(doc.client_nom || 'Sans client')}/${propre(basename(doc.fichier))}`;
      for (let k = 2; nomsPris.has(chemin); k++) chemin = chemin.replace(/(\.[^./]*)?$/, ` (${k})$1`);
      nomsPris.add(chemin);
      zip.file(chemin, readFileSync(doc.fichier));
      nb++;
    }
  }
  if (!nb) return res.status(404).json({ error: 'Aucun fichier trouvé pour cette sélection.' });
  const nom = `documents_${new Date().toISOString().slice(0, 10)}.zip`;
  res.set('Content-Type', 'application/zip');
  res.set('Content-Disposition', `attachment; filename="${nom}"`);
  zip
    .generateNodeStream({ type: 'nodebuffer', streamFiles: true, compression: 'STORE' })
    .pipe(res)
    .on('error', () => res.end());
});

// ---- Integration n8n : webhook sortant + rappels API ------------------------
app.get('/api/integration', requireAdmin, (req, res) =>
  res.json({
    webhook_url: getSetting('webhook_url', '') || '',
    webhook_secret_defini: !!(getSetting('webhook_secret', '') || ''),
    base_api: `${baseUrl(req)}/api`,
    cle_api_definie: apiKeyDefinie(),
  }),
);
app.post('/api/integration', requireAdmin, (req, res) => {
  if (typeof req.body?.webhook_url === 'string') setSetting('webhook_url', req.body.webhook_url.trim());
  if (typeof req.body?.webhook_secret === 'string' && req.body.webhook_secret !== '') setSetting('webhook_secret', req.body.webhook_secret.trim());
  if (req.body?.effacer_secret === true) setSetting('webhook_secret', '');
  res.json({ ok: true, webhook_url: getSetting('webhook_url', '') || '', webhook_secret_defini: !!(getSetting('webhook_secret', '') || '') });
});
app.post('/api/integration/test', requireAdmin, async (req, res) => {
  res.json(await envoyerWebhook('test', { message: 'Webhook du portail opérationnel.' }));
});

// ---- Reglages -------------------------------------------------------------
// Nom du cabinet (marque blanche) — lecture publique via /api/branding (avant auth).
app.post('/api/branding', requireAdmin, (req, res) => {
  const nom = String(req.body?.nom || '')
    .trim()
    .slice(0, 60);
  setSetting('nom_cabinet', nom);
  res.json({ nom: nomCabinet(), initiales: initialesCabinet() });
});
app.get('/api/settings', (req, res) => res.json({ destinationFolder: getSetting('destination_folder', '') }));
app.post('/api/settings', (req, res) => {
  if (typeof req.body?.destinationFolder === 'string') setSetting('destination_folder', req.body.destinationFolder.trim());
  res.json({ destinationFolder: getSetting('destination_folder', '') });
});

// ---- Captcha impots relayee dans le portail --------------------------------
// L'image du captcha est capturee par le robot et affichee dans l'interface ;
// le code tape par l'utilisateur est recopie dans la vraie page (voir
// src/captcha-relais.js). noVNC reste disponible en secours.
app.get('/api/captcha', (req, res) => res.json(captchaRelais.etat()));
app.post('/api/captcha', async (req, res) => res.json(await captchaRelais.soumettre(req.body?.code)));
app.post('/api/captcha/rafraichir', async (req, res) => res.json(await captchaRelais.rafraichir()));

// ---- Recuperation ---------------------------------------------------------
// Phases impots demandees (defaut : tout) — { cfe, tf, messagerie }, chaque phase
// est incluse sauf « false » explicite. Permet des lots courts par type de document.
function phasesImpots(body) {
  // TVA : opt-in (récupérée seulement si explicitement demandée — case décochée par défaut).
  return { cfe: body?.cfe !== false, tf: body?.tf !== false, messagerie: body?.messagerie !== false, tva: body?.tva === true };
}
async function lancer(clientId, res, phases = {}) {
  const c = getClient(clientId);
  if (!c) return res?.status(404).json({ error: 'Client introuvable.' });
  if (!c.cabinet_id) return res?.status(400).json({ error: "Ce client n'est rattaché à aucun cabinet." });
  const cab = getCabinetFull(c.cabinet_id);
  if (!cab) return res?.status(400).json({ error: 'Le cabinet de ce client est introuvable.' });
  // Cle en CHAINE prefixee comme toutes les autres (avant : nombre brut, incoherent).
  const cle = `impots:${clientId}`;
  if (enCours.has(cle)) return res?.status(409).json({ error: 'Récupération déjà en cours pour ce client.' });
  if (estReserve('impots', clientId))
    return res
      ?.status(409)
      .json({ error: 'Ce client est traité par la récupération globale en cours — attends la fin (deux sessions impôts en parallèle détournent la captcha).' });
  enCours.add(cle);
  res?.json({ started: true, client: c.nom });
  const suiviLocal = !suiviImpots.actif; // ne pas ecraser un suivi de lot deja en cours
  if (suiviLocal) {
    demarrerSuivi('impots', 1);
    suiviImpots.courant = c.nom;
  }
  try {
    const r = await scrapeClient(c, { cabinet: cab, baseFolder: getSetting('destination_folder'), onLog: journalImpots, phases });
    if (suiviLocal)
      suiviImpots.resultats.push({
        nom: c.nom,
        ok: !!r?.ok,
        message: r?.ok ? `${r.docs?.length ?? 0} document(s)` : r?.error || 'erreur',
        nb_docs: r?.docs?.length ?? 0,
      });
  } finally {
    enCours.delete(cle);
    if (suiviLocal) {
      suiviImpots.fait = 1;
      terminerSuivi('impots');
    }
  }
}

// Toutes les phases par defaut ; envoyer { cfe/tf/messagerie: false } pour en sauter.
app.post('/api/clients/:id/scrape', (req, res) => lancer(Number(req.params.id), res, phasesImpots(req.body)));

// Traite un lot de clients : groupe par cabinet, UNE session par cabinet.
// Disjoncteur : N echecs consecutifs = site impots indisponible/session perdue -> arret
// du lot (la reprise repartira du premier dossier non recupere au prochain lancement).
async function lancerLot(clients, phases = {}, { habilitations = false } = {}) {
  const baseFolder = getSetting('destination_folder');
  const disj = creerDisjoncteur();
  let arretAuto = false;
  const parCabinet = new Map();
  for (const c of clients) {
    if (!c.cabinet_id) continue;
    if (!parCabinet.has(c.cabinet_id)) parCabinet.set(c.cabinet_id, []);
    parCabinet.get(c.cabinet_id).push(c);
  }
  // Reserve les clients du lot : le bouton « Recuperer » d'un de ces clients sera
  // refuse tant que le lot tourne (deux sessions impots = captcha detournee).
  const idsLot = clients.filter((c) => c.cabinet_id).map((c) => c.id);
  reserverClients('impots', idsLot);
  try {
    for (const [cabinetId, sousClients] of parCabinet) {
      if (arretDemande('impots') || arretAuto) break;
      const cab = getCabinetFull(cabinetId);
      if (!cab) continue;
      await scrapeAll(sousClients, {
        cabinet: cab,
        baseFolder,
        shouldStop: () => arretDemande('impots') || arretAuto,
        phases,
        habilitations, // tableau d'habilitations : une fois par compte, seulement en « Tout récupérer »
        onLog: journalImpots,
        onClient: (nom) => {
          suiviImpots.courant = nom;
        },
        onResult: (r) => {
          suiviImpots.resultats.push(r);
          suiviImpots.fait++;
          disj.noter(!!r.ok);
          if (disj.declenche() && !arretAuto) {
            arretAuto = true;
            journalImpots(
              `⚠ ${ECHECS_CONSECUTIFS_MAX} échecs consécutifs : le site des impôts semble indisponible ou la session déconnectée — arrêt du lot. La prochaine récupération reprendra au premier dossier non récupéré.`,
            );
          }
        },
      });
    }
  } finally {
    libererClients('impots', idsLot);
  }
}

// Tout recuperer : tous les clients de tous les cabinets. Reprise automatique :
// les clients deja recuperes avec succes recemment sont sautes (voir src/reprise.js).
app.post('/api/scrape-all', async (req, res) => {
  if (!cabinetsConfigure()) return res.status(400).json({ error: "Configure d'abord au moins un compte cabinet." });
  if (enCours.has('all')) return res.status(409).json({ error: 'Une récupération globale est déjà en cours.' });
  const { aFaire, ignores } = filtrerReprise(listClients());
  const total = aFaire.filter((c) => c.cabinet_id).length;
  enCours.add('all');
  demarrerSuivi('impots', total);
  if (ignores) journalImpots(`Reprise : ${ignores} dossier(s) déjà récupéré(s) il y a moins de ${REPRISE_HEURES} h, ignoré(s).`);
  const cabinets = new Set(aFaire.filter((c) => c.cabinet_id).map((c) => c.cabinet_id)).size;
  res.json({ started: true, total, cabinets, ignores });
  try {
    await lancerLot(aFaire, phasesImpots(req.body), { habilitations: req.body?.habilitations !== false });
  } finally {
    enCours.delete('all');
    terminerSuivi('impots');
  }
});

// Recuperer une SELECTION de clients (par ids).
app.post('/api/scrape-selection', async (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number) : [];
  if (!ids.length) return res.status(400).json({ error: 'Aucun client sélectionné.' });
  if (!cabinetsConfigure()) return res.status(400).json({ error: "Configure d'abord au moins un compte cabinet." });
  if (enCours.has('all')) return res.status(409).json({ error: 'Une récupération est déjà en cours.' });
  const clients = ids.map((id) => getClient(id)).filter(Boolean);
  enCours.add('all');
  demarrerSuivi('impots', clients.filter((c) => c.cabinet_id).length);
  res.json({ started: true, total: clients.filter((c) => c.cabinet_id).length });
  try {
    await lancerLot(clients, phasesImpots(req.body));
  } finally {
    enCours.delete('all');
    terminerSuivi('impots');
  }
});

// Arret d'une recuperation. { source: 'carmf' } n'arrete QUE cette source ; sans
// source (anciens appels), on arrete tout. La source est normalisee et validee :
// une valeur inconnue renverrait « ok » sans rien arreter — le pire pour ce bouton.
app.post('/api/scrape-all/stop', (req, res) => {
  const brut = String(req.body?.source || '')
    .trim()
    .toLowerCase();
  if (!brut) {
    for (const s of SOURCES) arrets.add(s);
    return res.json({ ok: true, sources: SOURCES });
  }
  if (!SOURCES.includes(brut)) return res.status(400).json({ error: `Source inconnue : ${brut}` });
  arrets.add(brut);
  res.json({ ok: true, sources: [brut] });
});

// ---- Mise a jour ----------------------------------------------------------
app.get('/api/version', (req, res) => res.json({ version: versionLocale() }));
app.get('/api/update/check', requireAdmin, async (req, res) => res.json(await verifierMaj()));
app.post('/api/update/apply', requireAdmin, async (req, res) => {
  try {
    res.json(await appliquerMaj((m) => console.log('[maj] ' + m)));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ---- Compteurs du tableau de bord -----------------------------------------
// UNE requete pour les indicateurs des 6 sources. Avant, l'interface en lancait 20
// toutes les 10 s (clients + documents + runs de chaque source, listes INTEGRALES)
// pour n'en garder que des .length : sur un portefeuille charge, plusieurs Mo de
// JSON par minute et par onglet, plus un tri temporaire SQLite a chaque appel.
// `parSource` alimente les compteurs de la barre laterale sans charger les listes.
app.get('/api/stats', (req, res) => {
  const bases = { impots: { stats: statsImpots }, urssaf: urssafDb, carpimko, carmf, carcdsf, carpv };
  const parSource = {};
  const total = { clients: 0, documents: 0, runs: 0 };
  for (const [nom, base] of Object.entries(bases)) {
    let s = { clients: 0, documents: 0, runs: 0 };
    try {
      if (base?.stats) s = base.stats();
    } catch {
      /* base indisponible : on n'ecroule pas tout le tableau de bord pour un compteur */
    }
    parSource[nom] = s;
    total.clients += s.clients;
    total.documents += s.documents;
    total.runs += s.runs;
  }
  let comptes = 0;
  try {
    comptes = listCabinets().length + urssafDb.listCabinets().length;
  } catch {
    /* idem */
  }
  res.json({ ...total, comptes, parSource });
});

// ---- Historique -----------------------------------------------------------
app.get('/api/runs', (req, res) => res.json(listRuns(500)));
app.get('/api/status', (req, res) => res.json({ enCours: [...enCours], cabinets: cabinetsConfigure() }));
// Avancement. `?source=carmf` renvoie le suivi de cette seule source. Sans parametre :
// vue AGREGEE de la fenetre en cours (champs historiques conserves — src/mcp-http.js et
// l'interface les lisent) ENRICHIE de `sources` (detail par organisme) et `actives`.
app.get('/api/progress', (req, res) => {
  const src = String(req.query.source || '')
    .trim()
    .toLowerCase();
  if (src) {
    if (!SOURCES.includes(src)) return res.status(400).json({ error: `Source inconnue : ${src}` });
    return res.json(suiviDe(src));
  }
  const dansFenetre = [...suivis.values()].filter((p) => p.demarre_le && (!fenetre.demarre_le || p.demarre_le >= fenetre.demarre_le));
  const actives = dansFenetre.filter((p) => p.actif);
  // Journaux fusionnes : prefixes par organisme (sinon illisible a plusieurs) et
  // tries sur leur horodatage de debut de ligne. Plafond global, pas 400 x 6.
  //
  // Comparaison BINAIRE et non localeCompare : les lignes commencent toutes par un
  // horodatage « HH:MM:SS » a format fixe, l'ordre est donc identique — mais
  // localeCompare instancie la collation Intl a chaque comparaison, soit ~2400 chaines
  // collationnees toutes les 2 secondes et par onglet ouvert (cette route est sondee
  // en continu pendant une tournee). C'etait le poste de calcul le plus lourd du serveur.
  const logs = dansFenetre
    .flatMap((p) => p.logs.map((l) => ({ cle: l, texte: dansFenetre.length > 1 ? `${p.source.toUpperCase()} · ${l}` : l })))
    .sort((a, b) => (a.cle < b.cle ? -1 : a.cle > b.cle ? 1 : 0))
    .map((x) => x.texte)
    .slice(-600);
  res.json({
    actif: actives.length > 0,
    total: dansFenetre.reduce((n, p) => n + p.total, 0),
    fait: dansFenetre.reduce((n, p) => n + p.fait, 0),
    courant:
      actives
        .map((p) => p.courant)
        .filter(Boolean)
        .join(' · ') || null,
    source: (actives.length ? actives : dansFenetre).map((p) => p.source).join(',') || null,
    demarre_le: fenetre.demarre_le,
    fini_le: actives.length ? null : dansFenetre.reduce((m, p) => (!m || (p.fini_le && p.fini_le > m) ? p.fini_le || m : m), null),
    resultats: dansFenetre.flatMap((p) => p.resultats.map((r) => ({ ...r, source: p.source }))),
    logs,
    sources: Object.fromEntries(dansFenetre.map((p) => [p.source, p])),
    actives: actives.map((p) => p.source),
  });
});
// Indique a l'interface si la vue navigateur a distance (noVNC) est disponible (serveur).
app.get('/api/config', (req, res) => res.json({ remoteBrowser: !!process.env.REMOTE_BROWSER }));

// ---- Fusions de clients (vue « Clients » transverse) ----------------------
app.get('/api/fusions', (req, res) => res.json(fusions.listFusions()));
app.post('/api/fusions', (req, res) => {
  try {
    res.status(201).json(fusions.createFusion(req.body?.nom, req.body?.membres));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});
app.delete('/api/fusions/:id', (req, res) => {
  fusions.deleteFusion(Number(req.params.id));
  res.json({ ok: true });
});

// ---- Planification des recuperations automatiques (plusieurs horaires/organisme) ----
app.get('/api/planifications', (req, res) => res.json(planif.listPlanifs()));
// L'interface envoie l'etat COMPLET du tableau (ajouts/modifs/suppressions en une fois).
app.put('/api/planifications', (req, res) => {
  try {
    res.json(planif.setToutesPlanifs(req.body?.lignes));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ---- Captures de debug (diagnostic scraping) ------------------------------
// Sert la capture .png la plus recente d'une source, pour la consulter dans le
// navigateur sans scp. ?source=carpimko|urssaf|impots ; ?list=1 pour la liste.
const DEBUG_DIRS = {
  carpimko: resolve(__dirname, 'downloads', 'carpimko'),
  urssaf: resolve(__dirname, 'downloads', 'urssaf'),
  impots: resolve(__dirname, 'downloads'),
};
function listerCaptures(base) {
  const out = [];
  const walk = (d) => {
    let entrees = [];
    try {
      entrees = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entrees) {
      const p = resolve(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.png$/i.test(e.name)) {
        try {
          out.push({ path: p, mtime: statSync(p).mtimeMs });
        } catch {
          /* ignore */
        }
      }
    }
  };
  walk(base);
  return out.sort((a, b) => b.mtime - a.mtime);
}
// Captures de diagnostic (screenshots des sessions de scraping) : elles peuvent montrer
// des ecrans de connexion aux caisses, donc des identifiants/PII clients. Reservees aux
// admins (avant : accessibles a tout collaborateur authentifie). Non appelees par l'UI.
app.get('/api/debug/captures', requireAdmin, (req, res) => {
  const base = DEBUG_DIRS[String(req.query.source || '').toLowerCase()] || DEBUG_DIRS.carpimko;
  res.json(
    listerCaptures(base)
      .slice(0, 50)
      .map((c) => ({ fichier: c.path.split(/[\\/]/).pop(), date: new Date(c.mtime).toISOString(), path: c.path })),
  );
});
app.get('/api/debug/last', requireAdmin, (req, res) => {
  const base = DEBUG_DIRS[String(req.query.source || '').toLowerCase()] || DEBUG_DIRS.carpimko;
  const caps = listerCaptures(base);
  if (!caps.length) return res.status(404).send('Aucune capture de debug pour cette source.');
  res.sendFile(caps[0].path);
});
app.get('/api/debug/file', requireAdmin, (req, res) => {
  // Sert une capture par chemin, en verrouillant l'acces au dossier downloads/.
  // Le confinement teste `racine + sep` : `startsWith(racine)` seul laissait passer un
  // dossier FRERE prefixe (ex. downloads-autre/…), une traversee hors du dossier vise.
  const p = resolve(String(req.query.path || ''));
  const racine = resolve(__dirname, 'downloads');
  if ((p !== racine && !p.startsWith(racine + sep)) || !/\.(png|json|txt)$/i.test(p) || !existsSync(p)) return res.status(404).end();
  res.type(/\.png$/i.test(p) ? 'image/png' : 'text/plain').sendFile(p);
});

// ===========================================================================
//  SOURCES "par login / mot de passe" (CARPIMKO, CARMF, CARCDSF, CARPV)
//  Routes generiques mutualisees (src/routes/source-login.js). Etat de progression
//  partage via ctxSource. Ajouter une caisse = une entree dans routeursSources.
// ===========================================================================
// Un contexte PAR SOURCE : chaque caisse a son suivi, son journal et son arret.
// `progression` doit etre l'objet STABLE (le routeur capture la reference au boot) et
// les fonctions sont deja liees a la source — le routeur appelle demarrerSuivi(total,
// source), le 2e argument est simplement ignore.
const ctxPour = (source) => ({
  enCours,
  progression: suiviDe(source),
  progLog: journalDe(source),
  demarrerSuivi: (total) => demarrerSuivi(source, total),
  terminerSuivi: () => terminerSuivi(source),
  doitArreter: () => arretDemande(source),
  resetArret: () => arrets.delete(source),
});
const routeursSources = {
  // navigateur: true -> le scraper pilote Chromium, donc UN navigateur partage par lot
  // (voir src/navigateur.js). CARCDSF/CARPV passent par une API JSON : aucun navigateur.
  carpimko: creerRouteurSourceLogin('carpimko', {
    db: carpimko,
    scraper: scrapeClientCarpimko,
    tousDocuments: true,
    navigateur: true,
    ctx: ctxPour('carpimko'),
  }),
  carmf: creerRouteurSourceLogin('carmf', { db: carmf, scraper: scrapeClientCarmf, navigateur: true, ctx: ctxPour('carmf') }),
  carcdsf: creerRouteurSourceLogin('carcdsf', { db: carcdsf, scraper: scrapeClientCarcdsf, ctx: ctxPour('carcdsf') }),
  carpv: creerRouteurSourceLogin('carpv', { db: carpv, scraper: scrapeClientCarpv, ctx: ctxPour('carpv') }),
};
for (const [srcNom, obj] of Object.entries(routeursSources)) app.use('/api/' + srcNom, obj.router);

// ===========================================================================
//  SOURCE URSSAF (module autonome : base urssaf.db, tiers declarant par SIRET)
//  Connexion login/mot de passe, sans captcha (navigateur invisible). Suivi de
//  progression partage avec les autres sources.
// ===========================================================================
app.get('/api/urssaf/cabinets', (req, res) => res.json(urssafDb.listCabinets()));
app.post('/api/urssaf/cabinets', (req, res) => {
  const { libelle, login, password } = req.body || {};
  if (!login) return res.status(400).json({ error: 'Identifiant du compte URSSAF (e-mail) requis.' });
  if (urssafDb.getCabinetByLogin(login)) return res.status(409).json({ error: 'Un compte avec cet e-mail existe déjà.' });
  res.status(201).json(urssafDb.createCabinet({ libelle, login, password }));
});
app.put('/api/urssaf/cabinets/:id', (req, res) => {
  const c = urssafDb.updateCabinet(Number(req.params.id), req.body || {});
  if (!c) return res.status(404).json({ error: 'Compte introuvable.' });
  res.json(c);
});
app.delete('/api/urssaf/cabinets/:id', (req, res) => {
  urssafDb.deleteCabinet(Number(req.params.id));
  res.json({ ok: true });
});

// Synchronise le portefeuille d'UN compte cabinet (importe ses clients par SIRET).
app.post('/api/urssaf/cabinets/:id/sync', async (req, res) => {
  const id = Number(req.params.id);
  const cab = urssafDb.getCabinetFull(id);
  if (!cab) return res.status(404).json({ error: 'Compte introuvable.' });
  const key = 'urssaf:sync:' + id;
  if (enCours.has(key)) return res.status(409).json({ error: 'Synchronisation déjà en cours pour ce compte.' });
  enCours.add(key);
  try {
    const rows = await listerClientsUrssaf(cab, { onLog: journalUrssaf });
    // Liste noire : les clients supprimes volontairement ne sont pas recrees.
    const aImporter = rows.filter((r) => !urssafDb.listeNoire.estListeNoire(r.siret));
    const bilan = urssafDb.importClients(aImporter, id);
    res.json({ ...bilan, total: rows.length, liste_noire: rows.length - aImporter.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  } finally {
    enCours.delete(key);
  }
});

app.get('/api/urssaf/clients', (req, res) => res.json(urssafDb.listClients()));
app.post('/api/urssaf/clients', (req, res) => {
  const { nom, siret, dossier, cabinet_id } = req.body || {};
  if (!nom || !siret) return res.status(400).json({ error: 'Nom et SIRET sont requis.' });
  if (urssafDb.getClientBySiret(siret)) return res.status(409).json({ error: 'Un client avec ce SIRET existe déjà.' });
  urssafDb.listeNoire.retirerListeNoireParSiret(siret); // ajout volontaire = sortie de liste noire
  res.status(201).json(urssafDb.createClient({ nom, siret, dossier, cabinet_id: cabinet_id || null }));
});
app.post('/api/urssaf/clients/import', (req, res) => {
  const clients = req.body?.clients;
  if (!Array.isArray(clients) || clients.length === 0) return res.status(400).json({ error: 'Aucune ligne à importer.' });
  if (clients.length > 5000) return res.status(400).json({ error: 'Trop de lignes (max 5000).' });
  for (const c of clients) urssafDb.listeNoire.retirerListeNoireParSiret(c?.siret); // import volontaire
  res.json(urssafDb.importClients(clients, req.body?.cabinet_id || null));
});
// Synchronise UNE fiche depuis le portefeuille URSSAF (nom, rattachement — pas les
// documents). Une session cabinet est ouverte, la ligne du SIRET est appliquée via
// importClients (donc verrou de nom et regles habituelles respectes).
app.post('/api/urssaf/clients/:id/sync', async (req, res) => {
  const c = urssafDb.getClient(Number(req.params.id));
  if (!c) return res.status(404).json({ error: 'Client introuvable.' });
  const cab = c.cabinet_id ? urssafDb.getCabinetFull(c.cabinet_id) : null;
  if (!cab) return res.status(400).json({ error: "Rattache d'abord ce client à un compte URSSAF." });
  if ([...enCours].some((k) => String(k).startsWith('urssaf'))) return res.status(409).json({ error: 'Une opération URSSAF est déjà en cours.' });
  const key = 'urssaf:syncclient:' + c.id;
  enCours.add(key);
  try {
    const rows = await listerClientsUrssaf(cab, { onLog: journalUrssaf });
    const siret = String(c.siret || '').replace(/\D/g, '');
    const ligne = rows.find((r) => String(r.siret || '').replace(/\D/g, '') === siret);
    if (!ligne) return res.json({ ok: false, introuvable: true, total: rows.length });
    urssafDb.importClients([ligne], c.cabinet_id);
    const maj = urssafDb.getClient(c.id);
    res.json({ ok: true, nom: maj.nom, nom_verrouille: !!maj.nom_verrouille, nom_urssaf: ligne.nom });
  } catch (e) {
    res.status(500).json({ error: e.message });
  } finally {
    enCours.delete(key);
  }
});

app.put('/api/urssaf/clients/:id', (req, res) => {
  const avant = urssafDb.getClient(Number(req.params.id));
  if (!avant) return res.status(404).json({ error: 'Client introuvable.' });
  const maj = { ...(req.body || {}) };
  // Renommage MANUEL -> verrou : la synchro du portefeuille n'ecrasera plus ce nom
  // (cas nom d'usage au cabinet different du nom connu de l'URSSAF).
  if (maj.suivre_urssaf === true) maj.nom_verrouille = 0;
  else if (typeof maj.nom === 'string' && maj.nom.trim() && maj.nom.trim() !== avant.nom) maj.nom_verrouille = 1;
  delete maj.suivre_urssaf;
  const c = urssafDb.updateClient(Number(req.params.id), maj);
  res.json(c);
});
// Suppression = mise en liste noire (la synchro ne recreera pas ce client).
app.delete('/api/urssaf/clients/:id', (req, res) => {
  const c = urssafDb.getClient(Number(req.params.id));
  if (c?.siret) urssafDb.listeNoire.ajouterListeNoire({ siret: c.siret, nom: c.nom, cabinet_id: c.cabinet_id });
  urssafDb.deleteClient(Number(req.params.id));
  res.json({ ok: true, liste_noire: !!c?.siret });
});

// ---- Liste noire URSSAF -----------------------------------------------------
app.get('/api/urssaf/liste-noire', (req, res) => res.json(urssafDb.listeNoire.listListeNoire()));
app.post('/api/urssaf/liste-noire/:id/reintegrer', (req, res) => {
  const entree = urssafDb.listeNoire.retirerListeNoire(Number(req.params.id));
  if (!entree) return res.status(404).json({ error: 'Entrée introuvable.' });
  if (urssafDb.getClientBySiret(entree.siret)) return res.json({ ok: true, nom: entree.nom, deja_present: true });
  const cabinetOk = entree.cabinet_id && urssafDb.getCabinetFull(entree.cabinet_id) ? entree.cabinet_id : null;
  const c = urssafDb.createClient({ nom: entree.nom || entree.siret, siret: entree.siret, cabinet_id: cabinetOk });
  res.json({ ok: true, nom: c.nom, client_id: c.id, sans_cabinet: !cabinetOk });
});
app.get('/api/urssaf/clients/:id/documents', (req, res) => {
  if (!urssafDb.getClient(Number(req.params.id))) return res.status(404).json({ error: 'Client introuvable.' });
  res.json(urssafDb.listDocuments(Number(req.params.id)));
});
app.get('/api/urssaf/documents', (req, res) => res.json(urssafDb.listAllDocuments()));
app.get('/api/urssaf/documents/:id/file', (req, res) => {
  const doc = urssafDb.getDocument(req.params.id);
  if (!doc || !existsSync(doc.fichier)) return res.status(404).json({ error: 'Fichier introuvable.' });
  res.download(doc.fichier, basename(doc.fichier));
});
app.get('/api/urssaf/runs', (req, res) => res.json(urssafDb.listRuns(300)));

app.post('/api/urssaf/clients/:id/scrape', async (req, res) => {
  const id = Number(req.params.id);
  const client = urssafDb.getClient(id);
  if (!client) return res.status(404).json({ error: 'Client introuvable.' });
  const cab = urssafDb.getCabinetFullByClient(id);
  if (!cab) return res.status(400).json({ error: "Ce client n'est rattaché à aucun compte URSSAF." });
  const key = 'urssaf:' + id;
  if (enCours.has(key)) return res.status(409).json({ error: 'Une récupération est déjà en cours pour ce client.' });
  // Deux sessions URSSAF sur le meme compte cabinet ramenent les documents d'un AUTRE
  // dossier (session « collante ») — le scraper l'interdit explicitement.
  if (estReserve('urssaf', id))
    return res.status(409).json({
      error: 'Ce client est traité par la récupération globale en cours — attends la fin (deux sessions URSSAF sur le même compte mélangent les dossiers).',
    });
  enCours.add(key);
  res.json({ started: true, client: client.nom });
  const suiviLocal = !suiviUrssaf.actif;
  if (suiviLocal) {
    demarrerSuivi('urssaf', 1);
    suiviUrssaf.courant = client.nom;
  }
  try {
    const r = await scrapeClientUrssaf(client, { cabinet: cab, baseFolder: getSetting('destination_folder'), onLog: journalUrssaf });
    if (suiviLocal)
      suiviUrssaf.resultats.push({
        nom: client.nom,
        ok: !!r?.ok,
        message: r?.ok ? `${r.docs?.length ?? 0} document(s)` : r?.error || 'erreur',
        nb_docs: r?.docs?.length ?? 0,
      });
  } catch (e) {
    journalUrssaf(`ERREUR : ${e.message}`);
    if (suiviLocal) suiviUrssaf.resultats.push({ nom: client.nom, ok: false, message: e.message, nb_docs: 0 });
  } finally {
    enCours.delete(key);
    if (suiviLocal) {
      suiviUrssaf.fait = 1;
      terminerSuivi('urssaf');
    }
  }
});

// Recuperation URSSAF de TOUS les clients (utilisee par la route ET la planification).
function lancerUrssafTous() {
  if (!urssafDb.cabinetsConfigure()) return { started: false, raison: 'compte' };
  if (enCours.has('urssaf:all')) return { started: false };
  const { aFaire, ignores } = filtrerReprise(urssafDb.listClients());
  const parCabinet = new Map();
  for (const c of aFaire) {
    if (!c.cabinet_id) continue;
    if (!parCabinet.has(c.cabinet_id)) parCabinet.set(c.cabinet_id, []);
    parCabinet.get(c.cabinet_id).push(c);
  }
  const total = [...parCabinet.values()].reduce((n, arr) => n + arr.length, 0);
  enCours.add('urssaf:all');
  // Reserve les clients du lot (voir reserverClients) : pas de 2e session sur le meme compte.
  const idsLot = [...parCabinet.values()].flat().map((c) => c.id);
  reserverClients('urssaf', idsLot);
  demarrerSuivi('urssaf', total);
  if (ignores) journalUrssaf(`Reprise : ${ignores} client(s) URSSAF déjà récupéré(s) il y a moins de ${REPRISE_HEURES} h, ignoré(s).`);
  const disj = creerDisjoncteur();
  let arretAuto = false;
  (async () => {
    try {
      for (const [cabinetId, sousClients] of parCabinet) {
        if (arretDemande('urssaf') || arretAuto) break;
        const cab = urssafDb.getCabinetFull(cabinetId);
        if (!cab) continue;
        await scrapeAllUrssaf(sousClients, {
          cabinet: cab,
          baseFolder: getSetting('destination_folder'),
          shouldStop: () => arretDemande('urssaf') || arretAuto,
          onLog: journalUrssaf,
          onClient: (nom) => {
            suiviUrssaf.courant = nom;
          },
          onResult: (r) => {
            suiviUrssaf.resultats.push(r);
            suiviUrssaf.fait++;
            disj.noter(!!r.ok);
            if (disj.declenche() && !arretAuto) {
              arretAuto = true;
              journalUrssaf(
                `⚠ ${ECHECS_CONSECUTIFS_MAX} échecs consécutifs : le site URSSAF semble indisponible ou la session déconnectée — arrêt du lot. La prochaine récupération reprendra au premier dossier non récupéré.`,
              );
            }
          },
        });
      }
    } finally {
      enCours.delete('urssaf:all');
      libererClients('urssaf', idsLot);
      terminerSuivi('urssaf');
      journalUrssaf('Récupération URSSAF terminée.');
    }
  })();
  return { started: true, total, ignores };
}
app.post('/api/urssaf/scrape-all', (req, res) => {
  const r = lancerUrssafTous();
  if (r.raison === 'compte') return res.status(400).json({ error: "Configure d'abord au moins un compte URSSAF." });
  if (!r.started) return res.status(409).json({ error: 'Une récupération URSSAF globale est déjà en cours.' });
  res.json(r);
});

// ---- Planificateur des recuperations automatiques (config en base, par organisme) ----
// Tourne sur le serveur (active par une variable SCHEDULE*). Lit chaque minute la config
// definie dans Parametres ▸ Planification (organisme actif, jour, heure ; fuseau Europe/Paris).
if (
  process.env.SCHEDULE ||
  process.env.SCHEDULE_CARPIMKO ||
  process.env.SCHEDULE_CARMF ||
  process.env.SCHEDULE_URSSAF ||
  process.env.SCHEDULE_CARCDSF ||
  process.env.SCHEDULE_CARPV
) {
  const LANCEURS = {
    urssaf: () => lancerUrssafTous(),
    carpimko: () => routeursSources.carpimko.lancerTous(),
    carmf: () => routeursSources.carmf.lancerTous(),
    carcdsf: () => routeursSources.carcdsf.lancerTous(),
    carpv: () => routeursSources.carpv.lancerTous(),
  };
  const JOURS_EN = [null, 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
  const dernier = {};
  setInterval(() => {
    try {
      const p = Object.fromEntries(
        new Intl.DateTimeFormat('en-GB', {
          timeZone: 'Europe/Paris',
          weekday: 'long',
          hour: '2-digit',
          day: '2-digit',
          month: '2-digit',
          year: 'numeric',
          hour12: false,
        })
          .formatToParts(new Date())
          .map((x) => [x.type, x.value]),
      );
      const jourCle = `${p.year}-${p.month}-${p.day}`;
      const heure = Number(p.hour);
      for (const pl of planif.listPlanifs()) {
        if (!pl.actif || !LANCEURS[pl.source]) continue;
        // Plusieurs horaires par organisme : anti-redeclenchement par LIGNE (cle stable
        // source+jour+heure, valable meme si la planification est re-enregistree).
        const cle = `${pl.source}:${pl.jour}:${pl.heure}`;
        if (JOURS_EN[pl.jour] === p.weekday && heure === pl.heure && dernier[cle] !== jourCle) {
          dernier[cle] = jourCle; // une seule fois par jour
          console.log(`\n  [planif] Récupération ${pl.source.toUpperCase()} automatique — ${jourCle}`);
          const lance = LANCEURS[pl.source]();
          // APRES le lancement : demarrerSuivi vide le journal, une ligne ecrite avant
          // disparaissait aussitot. Et seulement si le lot a demarre (sinon ligne fantome).
          if (lance?.started !== false) journalDe(pl.source)(`Récupération ${pl.source.toUpperCase()} automatique (planifiée).`);
        }
        // TOURNEE MANQUEE : 2 h apres l'heure prevue, si aucune recuperation de cette
        // source n'a eu lieu depuis, c'est que le portail etait eteint/fige ou que le
        // lancement a echoue. On alerte une fois par jour et par ligne. Le controle
        // s'appuie sur les RUNS en base (et non sur `dernier`, perdu au redemarrage —
        // or « le serveur etait eteint » est justement le cas qu'on veut detecter).
        const cleManque = `manque:${pl.source}:${pl.jour}:${pl.heure}`;
        if (JOURS_EN[pl.jour] === p.weekday && heure >= pl.heure + 2 && dernier[cleManque] !== jourCle) {
          dernier[cleManque] = jourCle;
          const depuis = Date.now() - (heure - pl.heure) * 3600000 - 15 * 60000; // marge 15 min
          if (!aEuUnRunDepuis(pl.source, depuis)) {
            console.warn(`  [planif] ⚠ Tournée ${pl.source.toUpperCase()} de ${pl.heure} h : AUCUNE exécution constatée.`);
            envoyerWebhook('tournee_manquee', {
              source: pl.source,
              prevue_a: `${String(pl.heure).padStart(2, '0')}:00`,
              jour: jourCle,
              message: `La récupération ${pl.source.toUpperCase()} planifiée à ${pl.heure} h n'a pas eu lieu (portail arrêté, figé, ou lancement refusé).`,
            }).catch(() => {});
          }
        }
      }
    } catch (e) {
      console.warn('[planif] ' + e.message);
    }
  }, 60000);
  console.log('  Planificateur actif (config : Paramètres ▸ Planification).');
}

// ---- Battement de coeur (« le portail est vivant ») -------------------------
// Le portail ne peut pas prevenir qu'il est TOMBE : c'est l'ABSENCE de ce signal qui
// doit alerter (interrupteur d'homme mort). Cote n8n : un workflow qui attend ce
// webhook et envoie un mail s'il ne recoit rien pendant ~2 h. Intervalle configurable
// (HEARTBEAT_MINUTES, 0 = desactive).
const HEARTBEAT_MIN = Number(process.env.HEARTBEAT_MINUTES ?? 60);
if (HEARTBEAT_MIN > 0) {
  const battre = () =>
    envoyerWebhook('portail_vivant', {
      version: versionLocale(),
      demarre_depuis_min: Math.round(process.uptime() / 60),
      recuperations_en_cours: [...suivis.values()].filter((s) => s.actif).map((s) => s.source),
    }).catch(() => {});
  setInterval(battre, HEARTBEAT_MIN * 60000);
  setTimeout(battre, 30000); // premier battement 30 s apres le demarrage
}

const PORT = Number(process.env.PORT || 3003);

// GARDE-FOU CLE DE CHIFFREMENT : si data/secret.key a ete perdue ou remplacee, tous les
// mots de passe clients deviennent illisibles (chaine vide) et le portail les traiterait
// comme « mot de passe vide » -> chaque client passe en echec_mdp donc verrouille, et les
// tournees se vident sans explication. Mieux vaut refuser de demarrer avec la consigne.
{
  const cle = verifierCle();
  if (!cle.ok) {
    console.error(`
  ============================================================
   ARRET : la cle de chiffrement ne correspond plus aux donnees
  ============================================================
   data/secret.key n'est pas celle qui a chiffre les mots de passe
   enregistres. Demarrer ainsi verrouillerait tous les comptes clients.

   Que faire :
    1. RESTAURER data/secret.key depuis la sauvegarde (solution normale),
       puis redemarrer ;
    2. si la cle est definitivement perdue : supprimer data/secret.check,
       redemarrer, puis RESSAISIR les mots de passe des comptes et des
       clients (ils sont irrecuperables sans la cle).
  ============================================================
`);
    process.exit(1);
  }
  if (cle.initialise) console.log('  Cle de chiffrement : temoin de controle initialise.');
}

// Mise a jour AUTOMATIQUE au demarrage : si une version plus recente est publiee, on
// l'installe sans rien demander (telechargement + staging + redemarrage applique par
// Demarrer.bat). Le serveur ne demarre pas tant que la maj n'est pas appliquee.
// Les donnees (data/, .env, downloads/) ne sont jamais touchees (hors de l'archive).
let majDeclenchee = false;
try {
  const etat = await verifierMaj();
  if (etat.updateAvailable && etat.url) {
    majDeclenchee = true;
    console.log(`\n  Mise a jour ${etat.latest} disponible — installation automatique...`);
    await appliquerMaj((m) => console.log('  ' + m));
    // appliquerMaj programme process.exit(0) : Demarrer.bat applique la maj puis relance.
  }
} catch (e) {
  console.log('  Verification de mise a jour ignoree (' + e.message + ').');
}

if (!majDeclenchee) {
  app.listen(PORT, () => console.log(`\n  Impots pro scraper -> http://localhost:${PORT}\n`));

  // Retro-analyse des avis CFE deja telecharges : detecte le mode de paiement
  // (prelevement a l'echeance / mensualisation / aucun) dans le texte des PDF.
  // Tache de fond, une seule fois par document ('inconnu' si rien de detectable).
  //
  // ATTENTION AU COUT : jusqu'a 10 000 documents, et pdf.js analyse le PDF de facon
  // essentiellement SYNCHRONE. La boucle d'origine ne rendait jamais la main : le
  // serveur ecoutait deja (app.listen juste au-dessus) mais toutes les requetes de
  // l'interface restaient en file derriere l'analyse. Incrementer PAIEMENT_CFE_VERSION
  // relance en plus l'analyse de TOUS les avis au demarrage suivant.
  //
  // Deux garde-fous :
  //  - `setImmediate` tous les LOT_CFE documents : la boucle d'evenements traite les
  //    requetes en attente entre deux paquets ;
  //  - demarrage differe de quelques secondes, pour laisser l'interface se charger.
  (async () => {
    const LOT_CFE = 20;
    const ATTENTE_AVANT_MS = 5000;
    try {
      const { extraireTextePdf, detecterPaiementCfe, PAIEMENT_CFE_VERSION } = await import('./src/validation-pdf.js');
      // Motifs de detection revises ? On oublie les modes memorises pour que
      // TOUS les avis soient re-analyses avec les nouveaux motifs.
      if (getSetting('cfe_detection_version') !== String(PAIEMENT_CFE_VERSION)) {
        resetPaiementCfe();
        setSetting('cfe_detection_version', String(PAIEMENT_CFE_VERSION));
      }
      const aFaire = listCfeSansPaiement();
      if (!aFaire.length) return;
      await new Promise((r) => setTimeout(r, ATTENTE_AVANT_MS));
      console.log(`  [cfe] Analyse du mode de paiement de ${aFaire.length} avis CFE existants (tache de fond)...`);
      let detectes = 0;
      let traites = 0;
      for (const d of aFaire) {
        if (++traites % LOT_CFE === 0) await new Promise((r) => setImmediate(r));
        if (!existsSync(d.fichier)) {
          setPaiementDocument(d.id, 'inconnu');
          continue;
        }
        const texte = await extraireTextePdf(d.fichier).catch(() => null);
        const p = (texte && detecterPaiementCfe(texte)) || 'inconnu';
        setPaiementDocument(d.id, p);
        if (p !== 'inconnu') detectes++;
      }
      console.log(`  [cfe] Terminé : mode de paiement détecté sur ${detectes}/${aFaire.length} avis.`);
    } catch (e) {
      console.warn('  [cfe] retro-analyse : ' + e.message);
    }
  })();
}
