#!/usr/bin/env node
// Serveur MCP « Portail Cabinet » : permet de gérer les clients et lancer des
// récupérations directement depuis un chat Claude. Il parle à l'API HTTP du portail.
//
// Variables d'environnement :
//   PORTAIL_URL       (def. https://portail.tarncompta.fr)
//   PORTAIL_API_KEY   (recommandé — clé générée dans Paramètres ▸ Collaborateurs ▸ Clé API)
//   PORTAIL_EMAIL     (repli : compte collaborateur du portail)
//   PORTAIL_PASSWORD
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const BASE = (process.env.PORTAIL_URL || 'https://portail.tarncompta.fr').replace(/\/$/, '');
const API_KEY = process.env.PORTAIL_API_KEY || '';
const EMAIL = process.env.PORTAIL_EMAIL || '';
const PASSWORD = process.env.PORTAIL_PASSWORD || '';

let cookie = null;
async function login() {
  if (!EMAIL || !PASSWORD) throw new Error('Configure PORTAIL_API_KEY (recommandé) ou PORTAIL_EMAIL / PORTAIL_PASSWORD dans la config MCP.');
  const r = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: EMAIL, password: PASSWORD }) });
  if (!r.ok) throw new Error(`Connexion au portail refusée (HTTP ${r.status}). Vérifie l'URL et les identifiants.`);
  const sc = r.headers.get('set-cookie');
  if (sc) cookie = sc.split(';')[0];
}
async function apiFetch(path, opts = {}, retry = true) {
  // Auth par clé API si fournie (pas de login/cookie nécessaire), sinon session.
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  if (API_KEY) {
    headers['X-API-Key'] = API_KEY;
  } else {
    if (!cookie) await login();
    headers.cookie = cookie;
  }
  const r = await fetch(`${BASE}${path}`, { ...opts, headers });
  if (r.status === 401 && retry && !API_KEY) { cookie = null; return apiFetch(path, opts, false); }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `Erreur ${r.status}`);
  return data;
}

const SOURCES = {
  impots: { clients: '/api/clients', add: '/api/clients', scrape: (id) => `/api/clients/${id}/scrape`, docs: (id) => `/api/clients/${id}/documents`, cle: 'siret' },
  urssaf: { clients: '/api/urssaf/clients', add: '/api/urssaf/clients', scrape: (id) => `/api/urssaf/clients/${id}/scrape`, docs: (id) => `/api/urssaf/clients/${id}/documents`, cle: 'siret' },
  carpimko: { clients: '/api/carpimko/clients', add: '/api/carpimko/clients', scrape: (id) => `/api/carpimko/clients/${id}/scrape`, docs: (id) => `/api/carpimko/clients/${id}/documents`, cle: 'login' },
  carmf: { clients: '/api/carmf/clients', add: '/api/carmf/clients', scrape: (id) => `/api/carmf/clients/${id}/scrape`, docs: (id) => `/api/carmf/clients/${id}/documents`, cle: 'login' },
};
const nomFichier = (p) => (p || '').split(/[\\/]/).pop() || '';
const SRC = z.enum(['impots', 'urssaf', 'carpimko', 'carmf']);
const txt = (o) => ({ content: [{ type: 'text', text: typeof o === 'string' ? o : JSON.stringify(o, null, 2) }] });
const erreur = (e) => ({ isError: true, content: [{ type: 'text', text: `Erreur : ${e.message}` }] });

const server = new McpServer({ name: 'portail-cabinet', version: '1.0.0' });

server.tool(
  'lister_clients',
  "Liste ou recherche les clients d'un organisme du Portail Cabinet (impots, urssaf, carpimko, carmf).",
  { source: SRC, recherche: z.string().optional().describe('Filtre par nom / identifiant / notes') },
  async ({ source, recherche }) => {
    try {
      const cfg = SOURCES[source];
      let cs = await apiFetch(cfg.clients);
      if (recherche) { const q = recherche.toLowerCase(); cs = cs.filter((c) => `${c.nom} ${c[cfg.cle] || ''} ${c.notes || ''}`.toLowerCase().includes(q)); }
      return txt(cs.map((c) => ({ id: c.id, nom: c.nom, [cfg.cle]: c[cfg.cle], documents: c.nb_docs ?? 0, verrouille: c.verrouille || false })));
    } catch (e) { return erreur(e); }
  },
);

server.tool(
  'ajouter_client',
  "Enregistre un nouveau client. carpimko/carmf : 'identifiant' = identifiant de connexion + 'mot_de_passe' OBLIGATOIRE. impots/urssaf : 'identifiant' = SIRET/SIREN (rattacher à un compte via 'cabinet_id' si connu).",
  { source: SRC, nom: z.string(), identifiant: z.string(), mot_de_passe: z.string().optional(), notes: z.string().optional(), cabinet_id: z.number().optional() },
  async ({ source, nom, identifiant, mot_de_passe, notes, cabinet_id }) => {
    try {
      const body = { nom };
      if (source === 'carpimko' || source === 'carmf') {
        if (!mot_de_passe) throw new Error(`mot_de_passe requis pour ${source}.`);
        body.login = identifiant; body.password = mot_de_passe; if (notes) body.notes = notes;
      } else {
        body.siret = identifiant; if (cabinet_id) body.cabinet_id = cabinet_id;
      }
      const c = await apiFetch(SOURCES[source].add, { method: 'POST', body: JSON.stringify(body) });
      return txt({ ok: true, message: `Client « ${nom} » ajouté à ${source}.`, client: c });
    } catch (e) { return erreur(e); }
  },
);

server.tool(
  'recuperer_documents',
  "Lance la récupération des documents d'un client (par son id et son organisme). Le robot tourne sur le serveur ; pour les Impôts une captcha manuelle reste nécessaire (vue noVNC du portail).",
  { source: SRC, client_id: z.number() },
  async ({ source, client_id }) => {
    try {
      const r = await apiFetch(SOURCES[source].scrape(client_id), { method: 'POST', body: JSON.stringify({}) });
      return txt({ ok: true, message: 'Récupération lancée.', ...r });
    } catch (e) { return erreur(e); }
  },
);

server.tool(
  'lister_documents',
  "Liste les documents déjà récupérés d'un client (id, nom, date). L'id sert ensuite à telecharger_document.",
  { source: SRC, client_id: z.number() },
  async ({ source, client_id }) => {
    try {
      const ds = await apiFetch(SOURCES[source].docs(client_id));
      return txt(ds.map((d) => ({ id: d.id, nom: d.libelle || nomFichier(d.fichier) || `document ${d.id}`, fichier: nomFichier(d.fichier), date: d.recupere_le || d.date || null })));
    } catch (e) { return erreur(e); }
  },
);

server.tool(
  'telecharger_document',
  "Télécharge un document par son id et son organisme. Renvoie le FICHIER lui-même (joint dans la conversation sur les clients qui le supportent) + un lien de secours (usage unique, 10 min).",
  { source: SRC, document_id: z.number() },
  async ({ source, document_id }) => {
    try {
      const r1 = await apiFetch('/api/documents/lien', { method: 'POST', body: JSON.stringify({ source, document_id }) });
      const filename = r1.filename;
      const fr = await fetch(r1.url); // /dl est public (gate par le jeton)
      if (!fr.ok) throw new Error(`Téléchargement impossible (${fr.status}).`);
      const mime = fr.headers.get('content-type') || 'application/octet-stream';
      const buf = Buffer.from(await fr.arrayBuffer());
      const r2 = await apiFetch('/api/documents/lien', { method: 'POST', body: JSON.stringify({ source, document_id }) });
      const MAX = 8 * 1024 * 1024;
      const content = [{ type: 'text', text: JSON.stringify({ ok: true, filename, taille: buf.length, url: r2.url, note: 'Fichier joint ci-dessus si le client le supporte ; sinon lien valable 10 min (usage unique).' }) }];
      if (buf.length <= MAX) {
        content.unshift({ type: 'resource', resource: { uri: `portail://${source}/document/${document_id}/${encodeURIComponent(filename)}`, mimeType: mime, blob: buf.toString('base64') } });
      }
      return { content };
    } catch (e) { return erreur(e); }
  },
);

server.tool(
  'etat_recuperation',
  "État de la récupération en cours sur le portail (progression + dernières lignes du journal).",
  {},
  async () => {
    try {
      const p = await apiFetch('/api/progress');
      return txt({ actif: p.actif, fait: p.fait, total: p.total, en_cours: p.courant, derniers_logs: (p.logs || []).slice(-8) });
    } catch (e) { return erreur(e); }
  },
);

await server.connect(new StdioServerTransport());
console.error(`[portail-cabinet-mcp] connecté à ${BASE}`);
