#!/usr/bin/env node
// Serveur MCP « Portail Cabinet » : permet de gérer les clients et lancer des
// récupérations directement depuis un chat Claude. Il parle à l'API HTTP du portail.
//
// Variables d'environnement :
//   PORTAIL_URL       (def. https://portail.tarncompta.fr)
//   PORTAIL_EMAIL     (compte collaborateur du portail)
//   PORTAIL_PASSWORD
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const BASE = (process.env.PORTAIL_URL || 'https://portail.tarncompta.fr').replace(/\/$/, '');
const EMAIL = process.env.PORTAIL_EMAIL || '';
const PASSWORD = process.env.PORTAIL_PASSWORD || '';

let cookie = null;
async function login() {
  if (!EMAIL || !PASSWORD) throw new Error('PORTAIL_EMAIL / PORTAIL_PASSWORD non configurés dans la config MCP.');
  const r = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: EMAIL, password: PASSWORD }) });
  if (!r.ok) throw new Error(`Connexion au portail refusée (HTTP ${r.status}). Vérifie l'URL et les identifiants.`);
  const sc = r.headers.get('set-cookie');
  if (sc) cookie = sc.split(';')[0];
}
async function apiFetch(path, opts = {}, retry = true) {
  if (!cookie) await login();
  const r = await fetch(`${BASE}${path}`, { ...opts, headers: { 'Content-Type': 'application/json', ...(opts.headers || {}), cookie } });
  if (r.status === 401 && retry) { cookie = null; return apiFetch(path, opts, false); }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `Erreur ${r.status}`);
  return data;
}

const SOURCES = {
  impots: { clients: '/api/clients', add: '/api/clients', scrape: (id) => `/api/clients/${id}/scrape`, cle: 'siret' },
  urssaf: { clients: '/api/urssaf/clients', add: '/api/urssaf/clients', scrape: (id) => `/api/urssaf/clients/${id}/scrape`, cle: 'siret' },
  carpimko: { clients: '/api/carpimko/clients', add: '/api/carpimko/clients', scrape: (id) => `/api/carpimko/clients/${id}/scrape`, cle: 'login' },
  carmf: { clients: '/api/carmf/clients', add: '/api/carmf/clients', scrape: (id) => `/api/carmf/clients/${id}/scrape`, cle: 'login' },
};
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
