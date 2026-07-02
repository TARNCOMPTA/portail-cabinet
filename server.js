import 'dotenv/config';
import express from 'express';
import { dirname, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readdirSync, statSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import {
  listClients, getClient, createClient, updateClient, deleteClient, getClientBySiret,
  importClients, listDocuments, listAllDocuments, listRuns, getSetting, setSetting,
  documentAvecChemin,
  listCabinets, getCabinetFull, createCabinet, getCabinetByLogin, updateCabinet, deleteCabinet, cabinetsConfigure,
  listUsers, getUserByEmail, getUserById, createUser, updateUserPassword,
  setUserActif, setUserRole, deleteUser, deleteUserSessions, purgerSessionsExpirees,
} from './src/db.js';
import { scrapeClient, listerClients, scrapeAll } from './src/scraper-impots.js';
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
import { installAuthRoutes, requireAuth, requireAdmin, hashPassword, getApiKey, regenererApiKey, revoquerApiKey } from './src/auth.js';
import { installOAuth, requireBearer, baseUrl, CALLBACK_HOSTE } from './src/oauth.js';
import { installMcp } from './src/mcp-http.js';
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

// --- Assets accessibles SANS connexion (page de login) ---
for (const f of ['login.html', 'login.js', 'style.css', 'favicon.ico']) {
  app.get('/' + f, (req, res) => res.sendFile(resolve(PUBLIC_DIR, f), (e) => { if (e) res.status(404).end(); }));
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
  actif: false, total: 0, fait: 0, courant: null,
  demarre_le: null, fini_le: null, resultats: [], logs: [],
};
function progLog(ligne) {
  progression.logs.push(`${new Date().toLocaleTimeString('fr-FR')}  ${ligne}`);
  if (progression.logs.length > 400) progression.logs.splice(0, progression.logs.length - 400);
}
function demarrerSuivi(total) {
  progression.actif = true; progression.total = total; progression.fait = 0;
  progression.courant = null; progression.resultats = []; progression.logs = [];
  progression.demarre_le = new Date().toISOString(); progression.fini_le = null;
}
function terminerSuivi() {
  progression.actif = false; progression.courant = null; progression.fini_le = new Date().toISOString();
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
  const email = String(req.body?.email || '').trim().toLowerCase();
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
app.get('/api/apikey', requireAdmin, (req, res) => {
  const key = getApiKey();
  res.json({ key: key || null, definie: !!key });
});
app.post('/api/apikey/regenerer', requireAdmin, (req, res) => {
  res.json({ key: regenererApiKey(), definie: true });
});
app.delete('/api/apikey', requireAdmin, (req, res) => {
  revoquerApiKey();
  res.json({ ok: true, definie: false });
});

// ---- Connecteur MCP « organisation » (OAuth) : URL + Client ID/Secret -----
app.get('/api/mcp-oauth/client', requireAdmin, (req, res) => {
  const c = oauthDb.getOrCreateStaticClient([CALLBACK_HOSTE]);
  res.json({ url: `${baseUrl(req)}/mcp`, client_id: c.client_id, client_secret: c.client_secret });
});
app.post('/api/mcp-oauth/regenerer', requireAdmin, (req, res) => {
  const c = oauthDb.regenStaticClient([CALLBACK_HOSTE]);
  res.json({ url: `${baseUrl(req)}/mcp`, client_id: c.client_id, client_secret: c.client_secret });
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

app.delete('/api/cabinets/:id', (req, res) => { deleteCabinet(Number(req.params.id)); res.json({ ok: true }); });

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
    const bilan = importClients(rows, id);
    res.json({ ...bilan, total: rows.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  } finally {
    enCours.delete(key);
  }
});

// ---- Clients --------------------------------------------------------------
app.get('/api/clients', (req, res) => res.json(listClients()));

app.post('/api/clients', (req, res) => {
  const { nom, siret, dossier, cabinet_id } = req.body || {};
  if (!nom || !siret) return res.status(400).json({ error: 'nom et SIRET sont requis.' });
  if (getClientBySiret(siret)) return res.status(409).json({ error: 'Un client avec ce SIRET existe déjà.' });
  res.status(201).json(createClient({ nom, siret, dossier, cabinet_id: cabinet_id || null }));
});

app.post('/api/clients/import', (req, res) => {
  const clients = req.body?.clients;
  if (!Array.isArray(clients) || clients.length === 0) return res.status(400).json({ error: 'Aucune ligne à importer.' });
  if (clients.length > 5000) return res.status(400).json({ error: 'Trop de lignes (max 5000).' });
  res.json(importClients(clients, req.body?.cabinet_id || null));
});

app.put('/api/clients/:id', (req, res) => {
  const c = updateClient(Number(req.params.id), req.body || {});
  if (!c) return res.status(404).json({ error: 'Client introuvable.' });
  res.json(c);
});

app.delete('/api/clients/:id', (req, res) => { deleteClient(Number(req.params.id)); res.json({ ok: true }); });

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
  const out = messages.map((m) => {
    const prefixe = `${m.eventid}_PJ`;
    const pjs = docs.filter((d) => (d.eventid || '').startsWith(prefixe))
      .map((p) => ({ id: p.id, nom: (p.fichier || '').split(/[\\/]/).pop(), fichier: p.fichier }));
    return { id: m.id, client_id: m.client_id, client_nom: m.client_nom, libelle: m.libelle, recupere_le: m.recupere_le, fichier: m.fichier, pieces: pjs };
  }).sort((a, b) => String(b.recupere_le || '').localeCompare(String(a.recupere_le || '')));
  res.json(out);
});
app.get('/api/messages/:id/texte', (req, res) => {
  const doc = listAllDocuments().find((d) => d.id === Number(req.params.id));
  if (!doc || !doc.fichier || !existsSync(doc.fichier)) return res.status(404).json({ error: 'Message introuvable.' });
  let texte = '';
  try { texte = readFileSync(doc.fichier, 'utf8'); } catch (e) { return res.status(500).json({ error: 'Lecture impossible.' }); }
  res.json({ id: doc.id, libelle: doc.libelle, client_nom: doc.client_nom, texte });
});

// Genere un lien de telechargement direct (usage unique, 10 min) pour un document
// d'une source donnee. Resolu cote serveur via l'id (pas de chemin arbitraire).
app.post('/api/documents/lien', (req, res) => {
  const sources = {
    impots: listAllDocuments, carpimko: carpimko.listAllDocuments,
    carmf: carmf.listAllDocuments, urssaf: urssafDb.listAllDocuments,
    carcdsf: carcdsf.listAllDocuments, carpv: carpv.listAllDocuments,
  };
  const fn = sources[String(req.body?.source || '')];
  if (!fn) return res.status(400).json({ error: 'Source inconnue.' });
  const doc = fn().find((d) => d.id === Number(req.body?.document_id));
  if (!doc || !doc.fichier || !existsSync(doc.fichier)) return res.status(404).json({ error: 'Document introuvable.' });
  const token = oauthDb.rnd(24);
  const filename = basename(doc.fichier);
  oauthDb.saveDl({ token, path: doc.fichier, filename, expires_at: Date.now() + 10 * 60 * 1000 });
  res.json({ url: `${baseUrl(req)}/dl/${token}`, filename });
});

// ---- Reglages -------------------------------------------------------------
app.get('/api/settings', (req, res) => res.json({ destinationFolder: getSetting('destination_folder', '') }));
app.post('/api/settings', (req, res) => {
  if (typeof req.body?.destinationFolder === 'string') setSetting('destination_folder', req.body.destinationFolder.trim());
  res.json({ destinationFolder: getSetting('destination_folder', '') });
});

// Selecteur de dossier natif Windows
app.post('/api/pick-folder', (req, res) => {
  if (process.platform !== 'win32') {
    return res.json({ folder: null, indisponible: true, message: 'Sélecteur natif indisponible sur le serveur : saisis le chemin à la main (ou laisse vide pour le dossier interne).' });
  }
  const script =
    'Add-Type -AssemblyName System.Windows.Forms;' +
    '$f = New-Object System.Windows.Forms.FolderBrowserDialog;' +
    '$f.Description = "Dossier de destination des appels de cotisations";' +
    '$top = New-Object System.Windows.Forms.Form; $top.TopMost = $true; $top.ShowInTaskbar = $false;' +
    'if ($f.ShowDialog($top) -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($f.SelectedPath) }';
  const ps = spawn('powershell.exe', ['-NoProfile', '-STA', '-NonInteractive', '-Command', script], { windowsHide: true });
  let out = '';
  const t = setTimeout(() => ps.kill(), 120000);
  ps.stdout.on('data', (d) => (out += d));
  ps.on('close', () => { clearTimeout(t); const p = out.trim(); res.json(p ? { folder: p } : { folder: null, annule: true }); });
  ps.on('error', (e) => { clearTimeout(t); res.status(500).json({ error: e.message }); });
});

// ---- Recuperation ---------------------------------------------------------
async function lancer(clientId, res, messagerie = false) {
  const c = getClient(clientId);
  if (!c) return res?.status(404).json({ error: 'Client introuvable.' });
  if (!c.cabinet_id) return res?.status(400).json({ error: 'Ce client n\'est rattaché à aucun cabinet.' });
  const cab = getCabinetFull(c.cabinet_id);
  if (!cab) return res?.status(400).json({ error: 'Le cabinet de ce client est introuvable.' });
  if (enCours.has(clientId)) return res?.status(409).json({ error: 'Récupération déjà en cours pour ce client.' });
  enCours.add(clientId);
  res?.json({ started: true, client: c.nom });
  const suiviLocal = !progression.actif; // ne pas ecraser un suivi de lot deja en cours
  if (suiviLocal) { demarrerSuivi(1); progression.courant = c.nom; }
  try {
    const r = await scrapeClient(c, { cabinet: cab, baseFolder: getSetting('destination_folder'), onLog: progLog, messagerie });
    if (suiviLocal) progression.resultats.push({ nom: c.nom, ok: !!r?.ok, message: r?.ok ? `${r.docs?.length ?? 0} document(s)` : (r?.error || 'erreur'), nb_docs: r?.docs?.length ?? 0 });
  } finally {
    enCours.delete(clientId);
    if (suiviLocal) { progression.fait = 1; terminerSuivi(); }
  }
}

app.post('/api/clients/:id/scrape', (req, res) => lancer(Number(req.params.id), res, !!req.body?.messagerie));

// Traite un lot de clients : groupe par cabinet, UNE session par cabinet.
async function lancerLot(clients, messagerie = false) {
  const baseFolder = getSetting('destination_folder');
  const parCabinet = new Map();
  for (const c of clients) {
    if (!c.cabinet_id) continue;
    if (!parCabinet.has(c.cabinet_id)) parCabinet.set(c.cabinet_id, []);
    parCabinet.get(c.cabinet_id).push(c);
  }
  for (const [cabinetId, sousClients] of parCabinet) {
    if (stopAll) break;
    const cab = getCabinetFull(cabinetId);
    if (!cab) continue;
    await scrapeAll(sousClients, {
      cabinet: cab, baseFolder, shouldStop: () => stopAll, messagerie,
      onLog: progLog,
      onClient: (nom) => { progression.courant = nom; },
      onResult: (r) => { progression.resultats.push(r); progression.fait++; },
    });
  }
}

// Tout recuperer : tous les clients de tous les cabinets.
app.post('/api/scrape-all', async (req, res) => {
  if (!cabinetsConfigure()) return res.status(400).json({ error: 'Configure d\'abord au moins un compte cabinet.' });
  if (enCours.has('all')) return res.status(409).json({ error: 'Une récupération globale est déjà en cours.' });
  const clients = listClients();
  const total = clients.filter((c) => c.cabinet_id).length;
  enCours.add('all');
  stopAll = false;
  demarrerSuivi(total);
  res.json({ started: true, total });
  try { await lancerLot(clients, !!req.body?.messagerie); } finally { enCours.delete('all'); terminerSuivi(); }
});

// Recuperer une SELECTION de clients (par ids).
app.post('/api/scrape-selection', async (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number) : [];
  if (!ids.length) return res.status(400).json({ error: 'Aucun client sélectionné.' });
  if (!cabinetsConfigure()) return res.status(400).json({ error: 'Configure d\'abord au moins un compte cabinet.' });
  if (enCours.has('all')) return res.status(409).json({ error: 'Une récupération est déjà en cours.' });
  const clients = ids.map((id) => getClient(id)).filter(Boolean);
  enCours.add('all');
  stopAll = false;
  demarrerSuivi(clients.filter((c) => c.cabinet_id).length);
  res.json({ started: true, total: clients.filter((c) => c.cabinet_id).length });
  try { await lancerLot(clients, !!req.body?.messagerie); } finally { enCours.delete('all'); terminerSuivi(); }
});

app.post('/api/scrape-all/stop', (req, res) => { stopAll = true; res.json({ ok: true }); });

// ---- Mise a jour ----------------------------------------------------------
app.get('/api/version', (req, res) => res.json({ version: versionLocale() }));
app.get('/api/update/check', async (req, res) => res.json(await verifierMaj()));
app.post('/api/update/apply', async (req, res) => {
  try { res.json(await appliquerMaj()); }
  catch (e) { res.status(400).json({ error: e.message }); }
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
  try { res.status(201).json(fusions.createFusion(req.body?.nom, req.body?.membres)); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.delete('/api/fusions/:id', (req, res) => { fusions.deleteFusion(Number(req.params.id)); res.json({ ok: true }); });

// ---- Planification des recuperations automatiques (par organisme) ---------
app.get('/api/planifications', (req, res) => res.json(planif.listPlanifs()));
app.put('/api/planifications/:source', (req, res) => {
  try { res.json(planif.setPlanif(req.params.source, req.body || {})); }
  catch (e) { res.status(400).json({ error: e.message }); }
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
    try { entrees = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entrees) {
      const p = resolve(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.png$/i.test(e.name)) { try { out.push({ path: p, mtime: statSync(p).mtimeMs }); } catch { /* ignore */ } }
    }
  };
  walk(base);
  return out.sort((a, b) => b.mtime - a.mtime);
}
app.get('/api/debug/captures', (req, res) => {
  const base = DEBUG_DIRS[String(req.query.source || '').toLowerCase()] || DEBUG_DIRS.carpimko;
  res.json(listerCaptures(base).slice(0, 50).map((c) => ({ fichier: c.path.split(/[\\/]/).pop(), date: new Date(c.mtime).toISOString(), path: c.path })));
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
  enCours, progression, progLog, demarrerSuivi, terminerSuivi,
  doitArreter: () => stopAll,
  resetArret: () => { stopAll = false; },
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
app.delete('/api/urssaf/cabinets/:id', (req, res) => { urssafDb.deleteCabinet(Number(req.params.id)); res.json({ ok: true }); });

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
    const bilan = urssafDb.importClients(rows, id);
    res.json({ ...bilan, total: rows.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
  finally { enCours.delete(key); }
});

app.get('/api/urssaf/clients', (req, res) => res.json(urssafDb.listClients()));
app.post('/api/urssaf/clients', (req, res) => {
  const { nom, siret, dossier, cabinet_id } = req.body || {};
  if (!nom || !siret) return res.status(400).json({ error: 'Nom et SIRET sont requis.' });
  if (urssafDb.getClientBySiret(siret)) return res.status(409).json({ error: 'Un client avec ce SIRET existe déjà.' });
  res.status(201).json(urssafDb.createClient({ nom, siret, dossier, cabinet_id: cabinet_id || null }));
});
app.post('/api/urssaf/clients/import', (req, res) => {
  const clients = req.body?.clients;
  if (!Array.isArray(clients) || clients.length === 0) return res.status(400).json({ error: 'Aucune ligne à importer.' });
  if (clients.length > 5000) return res.status(400).json({ error: 'Trop de lignes (max 5000).' });
  res.json(urssafDb.importClients(clients, req.body?.cabinet_id || null));
});
app.put('/api/urssaf/clients/:id', (req, res) => {
  const c = urssafDb.updateClient(Number(req.params.id), req.body || {});
  if (!c) return res.status(404).json({ error: 'Client introuvable.' });
  res.json(c);
});
app.delete('/api/urssaf/clients/:id', (req, res) => { urssafDb.deleteClient(Number(req.params.id)); res.json({ ok: true }); });
app.get('/api/urssaf/clients/:id/documents', (req, res) => {
  if (!urssafDb.getClient(Number(req.params.id))) return res.status(404).json({ error: 'Client introuvable.' });
  res.json(urssafDb.listDocuments(Number(req.params.id)));
});
app.get('/api/urssaf/documents', (req, res) => res.json(urssafDb.listAllDocuments()));
app.get('/api/urssaf/documents/:id/file', (req, res) => {
  const doc = urssafDb.listAllDocuments().find((d) => d.id === Number(req.params.id));
  if (!doc || !existsSync(doc.fichier)) return res.status(404).json({ error: 'Fichier introuvable.' });
  res.download(doc.fichier, basename(doc.fichier));
});
app.get('/api/urssaf/runs', (req, res) => res.json(urssafDb.listRuns(300)));

app.post('/api/urssaf/clients/:id/scrape', async (req, res) => {
  const id = Number(req.params.id);
  const client = urssafDb.getClient(id);
  if (!client) return res.status(404).json({ error: 'Client introuvable.' });
  const cab = urssafDb.getCabinetFullByClient(id);
  if (!cab) return res.status(400).json({ error: 'Ce client n\'est rattaché à aucun compte URSSAF.' });
  const key = 'urssaf:' + id;
  if (enCours.has(key)) return res.status(409).json({ error: 'Une récupération est déjà en cours pour ce client.' });
  enCours.add(key);
  res.json({ started: true, client: client.nom });
  const suiviLocal = !progression.actif;
  if (suiviLocal) { demarrerSuivi(1); progression.courant = client.nom; }
  try {
    const r = await scrapeClientUrssaf(client, { cabinet: cab, baseFolder: getSetting('destination_folder'), onLog: progLog });
    if (suiviLocal) progression.resultats.push({ nom: client.nom, ok: !!r?.ok, message: r?.ok ? `${r.docs?.length ?? 0} document(s)` : (r?.error || 'erreur'), nb_docs: r?.docs?.length ?? 0 });
  } catch (e) {
    progLog(`ERREUR : ${e.message}`);
    if (suiviLocal) progression.resultats.push({ nom: client.nom, ok: false, message: e.message, nb_docs: 0 });
  } finally {
    enCours.delete(key);
    if (suiviLocal) { progression.fait = 1; terminerSuivi(); }
  }
});

// Recuperation URSSAF de TOUS les clients (utilisee par la route ET la planification).
function lancerUrssafTous() {
  if (!urssafDb.cabinetsConfigure()) return { started: false, raison: 'compte' };
  if (enCours.has('urssaf:all')) return { started: false };
  const clients = urssafDb.listClients();
  const parCabinet = new Map();
  for (const c of clients) { if (!c.cabinet_id) continue; if (!parCabinet.has(c.cabinet_id)) parCabinet.set(c.cabinet_id, []); parCabinet.get(c.cabinet_id).push(c); }
  const total = [...parCabinet.values()].reduce((n, arr) => n + arr.length, 0);
  enCours.add('urssaf:all');
  stopAll = false;
  demarrerSuivi(total);
  (async () => {
    try {
      for (const [cabinetId, sousClients] of parCabinet) {
        if (stopAll) break;
        const cab = urssafDb.getCabinetFull(cabinetId);
        if (!cab) continue;
        await scrapeAllUrssaf(sousClients, {
          cabinet: cab, baseFolder: getSetting('destination_folder'), shouldStop: () => stopAll, onLog: progLog,
          onClient: (nom) => { progression.courant = nom; },
          onResult: (r) => { progression.resultats.push(r); progression.fait++; },
        });
      }
    } finally { enCours.delete('urssaf:all'); terminerSuivi(); progLog('Récupération URSSAF terminée.'); }
  })();
  return { started: true, total };
}
app.post('/api/urssaf/scrape-all', (req, res) => {
  const r = lancerUrssafTous();
  if (r.raison === 'compte') return res.status(400).json({ error: 'Configure d\'abord au moins un compte URSSAF.' });
  if (!r.started) return res.status(409).json({ error: 'Une récupération URSSAF globale est déjà en cours.' });
  res.json(r);
});

// ---- Planificateur des recuperations automatiques (config en base, par organisme) ----
// Tourne sur le serveur (active par une variable SCHEDULE*). Lit chaque minute la config
// definie dans Parametres ▸ Planification (organisme actif, jour, heure ; fuseau Europe/Paris).
if (process.env.SCHEDULE || process.env.SCHEDULE_CARPIMKO || process.env.SCHEDULE_CARMF || process.env.SCHEDULE_URSSAF || process.env.SCHEDULE_CARCDSF || process.env.SCHEDULE_CARPV) {
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
        new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Paris', weekday: 'long', hour: '2-digit', day: '2-digit', month: '2-digit', year: 'numeric', hour12: false })
          .formatToParts(new Date()).map((x) => [x.type, x.value]),
      );
      const jourCle = `${p.year}-${p.month}-${p.day}`;
      const heure = Number(p.hour);
      for (const pl of planif.listPlanifs()) {
        if (!pl.actif || !LANCEURS[pl.source]) continue;
        if (JOURS_EN[pl.jour] === p.weekday && heure === pl.heure && dernier[pl.source] !== jourCle) {
          dernier[pl.source] = jourCle; // une seule fois par jour
          console.log(`\n  [planif] Récupération ${pl.source.toUpperCase()} automatique — ${jourCle}`);
          progLog(`Récupération ${pl.source.toUpperCase()} automatique (planifiée).`);
          LANCEURS[pl.source]();
        }
      }
    } catch (e) { console.warn('[planif] ' + e.message); }
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
}
