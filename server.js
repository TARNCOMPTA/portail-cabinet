import 'dotenv/config';
import express from 'express';
import JSZip from 'jszip';
import { dirname, resolve, basename } from 'node:path';
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
  setPaiementDocument,
  listCfeSansPaiement,
  resetPaiementCfe,
} from './src/db.js';
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
import { installAuthRoutes, requireAuth, requireAdmin, hashPassword, apiKeyDefinie, regenererApiKey, revoquerApiKey } from './src/auth.js';
import { installOAuth, requireBearer, baseUrl, CALLBACK_HOSTE } from './src/oauth.js';
import { installMcp } from './src/mcp-http.js';
import * as captchaRelais from './src/captcha-relais.js';
import * as oauthDb from './src/oauth-db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = resolve(__dirname, 'public');
const app = express();
app.set('trust proxy', 1); // derriere le reverse proxy HTTPS : lire X-Forwarded-Proto (cookie Secure)
// En-tetes de securite (sans dependance) : anti-sniffing, anti-clickjacking, referrer discret.
app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('X-Frame-Options', 'SAMEORIGIN');
  res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});
app.use(express.json());

// --- Marque blanche : nom du cabinet configurable (Paramètres ▸ Collaborateurs) ---
const nomCabinet = () => (getSetting('nom_cabinet', '') || 'Portail Cabinet').trim();
const initialesCabinet = () => {
  const mots = nomCabinet().split(/\s+/).filter(Boolean);
  return ((mots[0]?.[0] || 'P') + (mots[1]?.[0] || mots[0]?.[1] || 'C')).toUpperCase();
};
// Endpoint PUBLIC (la page de login en a besoin) : nom + initiales, rien de sensible.
app.get('/api/branding', (req, res) => res.json({ nom: nomCabinet(), initiales: initialesCabinet() }));
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
let stopAll = false;

// ---- Suivi d'avancement (en memoire, lu par l'interface via /api/progress) --
const progression = {
  actif: false,
  total: 0,
  fait: 0,
  courant: null,
  demarre_le: null,
  fini_le: null,
  resultats: [],
  logs: [],
};
function progLog(ligne) {
  progression.logs.push(`${new Date().toLocaleTimeString('fr-FR')}  ${ligne}`);
  if (progression.logs.length > 400) progression.logs.splice(0, progression.logs.length - 400);
}
function demarrerSuivi(total, source = '') {
  progression.actif = true;
  progression.total = total;
  progression.source = source;
  progression.fait = 0;
  progression.courant = null;
  progression.resultats = [];
  progression.logs = [];
  progression.demarre_le = new Date().toISOString();
  progression.fini_le = null;
}
function terminerSuivi() {
  progression.actif = false;
  progression.courant = null;
  progression.fini_le = new Date().toISOString();
  // Webhook sortant (n8n & co) : bilan de la recuperation, fire-and-forget.
  const ok = progression.resultats.filter((r) => r.ok);
  const ko = progression.resultats.filter((r) => !r.ok);
  envoyerWebhook('recuperation_terminee', {
    source: progression.source || null,
    demarre_le: progression.demarre_le,
    fini_le: progression.fini_le,
    clients_traites: progression.resultats.length,
    succes: ok.length,
    echecs: ko.length,
    nouveaux_documents: progression.resultats.reduce((n, r) => n + (r.nb_docs || 0), 0),
    nouveaux_documents_detail: nouveauxDocsDepuis(progression.source, progression.demarre_le),
    echecs_detail: ko.slice(0, 50).map((r) => ({ nom: r.nom, message: r.message })),
  }).catch(() => {});
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
      .map((f) => ({ nom: f, taille: statSync(resolve(dir, f)).size, modifie: statSync(resolve(dir, f)).mtime.toISOString() }))
      .sort((a, b) => b.modifie.localeCompare(a.modifie));
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
  const suiviLocal = !progression.actif;
  if (suiviLocal) {
    demarrerSuivi(1, 'impots');
    progression.courant = `Habilitations — ${cab.libelle || cab.login}`;
  }
  try {
    const r = await recupererHabilitations(cab, { onLog: progLog });
    if (suiviLocal)
      progression.resultats.push({
        nom: `Habilitations — ${cab.libelle || cab.login}`,
        ok: !!r?.ok,
        message: r?.ok ? 'tableau téléchargé' : r?.error || 'échec',
        nb_docs: r?.ok ? 1 : 0,
      });
  } finally {
    enCours.delete(key);
    if (suiviLocal) {
      progression.fait = 1;
      terminerSuivi();
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
  if (enCours.has(clientId)) return res?.status(409).json({ error: 'Récupération déjà en cours pour ce client.' });
  enCours.add(clientId);
  res?.json({ started: true, client: c.nom });
  const suiviLocal = !progression.actif; // ne pas ecraser un suivi de lot deja en cours
  if (suiviLocal) {
    demarrerSuivi(1, 'impots');
    progression.courant = c.nom;
  }
  try {
    const r = await scrapeClient(c, { cabinet: cab, baseFolder: getSetting('destination_folder'), onLog: progLog, phases });
    if (suiviLocal)
      progression.resultats.push({
        nom: c.nom,
        ok: !!r?.ok,
        message: r?.ok ? `${r.docs?.length ?? 0} document(s)` : r?.error || 'erreur',
        nb_docs: r?.docs?.length ?? 0,
      });
  } finally {
    enCours.delete(clientId);
    if (suiviLocal) {
      progression.fait = 1;
      terminerSuivi();
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
  for (const [cabinetId, sousClients] of parCabinet) {
    if (stopAll || arretAuto) break;
    const cab = getCabinetFull(cabinetId);
    if (!cab) continue;
    await scrapeAll(sousClients, {
      cabinet: cab,
      baseFolder,
      shouldStop: () => stopAll || arretAuto,
      phases,
      habilitations, // tableau d'habilitations : une fois par compte, seulement en « Tout récupérer »
      onLog: progLog,
      onClient: (nom) => {
        progression.courant = nom;
      },
      onResult: (r) => {
        progression.resultats.push(r);
        progression.fait++;
        disj.noter(!!r.ok);
        if (disj.declenche() && !arretAuto) {
          arretAuto = true;
          progLog(
            `⚠ ${ECHECS_CONSECUTIFS_MAX} échecs consécutifs : le site des impôts semble indisponible ou la session déconnectée — arrêt du lot. La prochaine récupération reprendra au premier dossier non récupéré.`,
          );
        }
      },
    });
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
  stopAll = false;
  demarrerSuivi(total, 'impots');
  if (ignores) progLog(`Reprise : ${ignores} dossier(s) déjà récupéré(s) il y a moins de ${REPRISE_HEURES} h, ignoré(s).`);
  const cabinets = new Set(aFaire.filter((c) => c.cabinet_id).map((c) => c.cabinet_id)).size;
  res.json({ started: true, total, cabinets, ignores });
  try {
    await lancerLot(aFaire, phasesImpots(req.body), { habilitations: req.body?.habilitations !== false });
  } finally {
    enCours.delete('all');
    terminerSuivi();
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
  stopAll = false;
  demarrerSuivi(clients.filter((c) => c.cabinet_id).length, 'impots');
  res.json({ started: true, total: clients.filter((c) => c.cabinet_id).length });
  try {
    await lancerLot(clients, phasesImpots(req.body));
  } finally {
    enCours.delete('all');
    terminerSuivi();
  }
});

app.post('/api/scrape-all/stop', (req, res) => {
  stopAll = true;
  res.json({ ok: true });
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

// ---- Historique -----------------------------------------------------------
app.get('/api/runs', (req, res) => res.json(listRuns(500)));
app.get('/api/status', (req, res) => res.json({ enCours: [...enCours], cabinets: cabinetsConfigure() }));
app.get('/api/progress', (req, res) => res.json(progression));
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
app.get('/api/debug/captures', (req, res) => {
  const base = DEBUG_DIRS[String(req.query.source || '').toLowerCase()] || DEBUG_DIRS.carpimko;
  res.json(
    listerCaptures(base)
      .slice(0, 50)
      .map((c) => ({ fichier: c.path.split(/[\\/]/).pop(), date: new Date(c.mtime).toISOString(), path: c.path })),
  );
});
app.get('/api/debug/last', (req, res) => {
  const base = DEBUG_DIRS[String(req.query.source || '').toLowerCase()] || DEBUG_DIRS.carpimko;
  const caps = listerCaptures(base);
  if (!caps.length) return res.status(404).send('Aucune capture de debug pour cette source.');
  res.sendFile(caps[0].path);
});
app.get('/api/debug/file', (req, res) => {
  // Sert une capture par chemin, en verrouillant l'acces au dossier downloads/.
  const p = resolve(String(req.query.path || ''));
  const racine = resolve(__dirname, 'downloads');
  if (!p.startsWith(racine) || !/\.(png|json|txt)$/i.test(p) || !existsSync(p)) return res.status(404).end();
  res.type(/\.png$/i.test(p) ? 'image/png' : 'text/plain').sendFile(p);
});

// ===========================================================================
//  SOURCES "par login / mot de passe" (CARPIMKO, CARMF, CARCDSF, CARPV)
//  Routes generiques mutualisees (src/routes/source-login.js). Etat de progression
//  partage via ctxSource. Ajouter une caisse = une entree dans routeursSources.
// ===========================================================================
const ctxSource = {
  enCours,
  progression,
  progLog,
  demarrerSuivi,
  terminerSuivi,
  doitArreter: () => stopAll,
  resetArret: () => {
    stopAll = false;
  },
};
const routeursSources = {
  carpimko: creerRouteurSourceLogin('carpimko', { db: carpimko, scraper: scrapeClientCarpimko, tousDocuments: true, ctx: ctxSource }),
  carmf: creerRouteurSourceLogin('carmf', { db: carmf, scraper: scrapeClientCarmf, ctx: ctxSource }),
  carcdsf: creerRouteurSourceLogin('carcdsf', { db: carcdsf, scraper: scrapeClientCarcdsf, ctx: ctxSource }),
  carpv: creerRouteurSourceLogin('carpv', { db: carpv, scraper: scrapeClientCarpv, ctx: ctxSource }),
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
    const rows = await listerClientsUrssaf(cab, { onLog: progLog });
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
    const rows = await listerClientsUrssaf(cab, { onLog: progLog });
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
  enCours.add(key);
  res.json({ started: true, client: client.nom });
  const suiviLocal = !progression.actif;
  if (suiviLocal) {
    demarrerSuivi(1, 'urssaf');
    progression.courant = client.nom;
  }
  try {
    const r = await scrapeClientUrssaf(client, { cabinet: cab, baseFolder: getSetting('destination_folder'), onLog: progLog });
    if (suiviLocal)
      progression.resultats.push({
        nom: client.nom,
        ok: !!r?.ok,
        message: r?.ok ? `${r.docs?.length ?? 0} document(s)` : r?.error || 'erreur',
        nb_docs: r?.docs?.length ?? 0,
      });
  } catch (e) {
    progLog(`ERREUR : ${e.message}`);
    if (suiviLocal) progression.resultats.push({ nom: client.nom, ok: false, message: e.message, nb_docs: 0 });
  } finally {
    enCours.delete(key);
    if (suiviLocal) {
      progression.fait = 1;
      terminerSuivi();
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
  stopAll = false;
  demarrerSuivi(total, 'urssaf');
  if (ignores) progLog(`Reprise : ${ignores} client(s) URSSAF déjà récupéré(s) il y a moins de ${REPRISE_HEURES} h, ignoré(s).`);
  const disj = creerDisjoncteur();
  let arretAuto = false;
  (async () => {
    try {
      for (const [cabinetId, sousClients] of parCabinet) {
        if (stopAll || arretAuto) break;
        const cab = urssafDb.getCabinetFull(cabinetId);
        if (!cab) continue;
        await scrapeAllUrssaf(sousClients, {
          cabinet: cab,
          baseFolder: getSetting('destination_folder'),
          shouldStop: () => stopAll || arretAuto,
          onLog: progLog,
          onClient: (nom) => {
            progression.courant = nom;
          },
          onResult: (r) => {
            progression.resultats.push(r);
            progression.fait++;
            disj.noter(!!r.ok);
            if (disj.declenche() && !arretAuto) {
              arretAuto = true;
              progLog(
                `⚠ ${ECHECS_CONSECUTIFS_MAX} échecs consécutifs : le site URSSAF semble indisponible ou la session déconnectée — arrêt du lot. La prochaine récupération reprendra au premier dossier non récupéré.`,
              );
            }
          },
        });
      }
    } finally {
      enCours.delete('urssaf:all');
      terminerSuivi();
      progLog('Récupération URSSAF terminée.');
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
          progLog(`Récupération ${pl.source.toUpperCase()} automatique (planifiée).`);
          LANCEURS[pl.source]();
        }
      }
    } catch (e) {
      console.warn('[planif] ' + e.message);
    }
  }, 60000);
  console.log('  Planificateur actif (config : Paramètres ▸ Planification).');
}

const PORT = Number(process.env.PORT || 3003);

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
  (async () => {
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
      console.log(`  [cfe] Analyse du mode de paiement de ${aFaire.length} avis CFE existants...`);
      let detectes = 0;
      for (const d of aFaire) {
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
