// Serveur MCP expose en HTTP (transport « Streamable HTTP ») pour le connecteur
// distant de Claude. Memes outils que le MCP local (mcp-portail/) mais protege par
// OAuth (garde Bearer) et branche dans l'app Express du portail. Les outils appellent
// l'API HTTP locale du portail avec la cle API interne (donc toute la logique existante
// — validation, anti-doublon, verrous — est reutilisee).
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { getApiKey, regenererApiKey } from './auth.js';

const PORT = Number(process.env.PORT || 3003);
const LOCAL = `http://127.0.0.1:${PORT}`;

function cleInterne() {
  let k = getApiKey();
  if (!k) k = regenererApiKey(); // garantit un acces interne pour les appels du MCP
  return k;
}
async function apiFetch(path, opts = {}) {
  const r = await fetch(`${LOCAL}${path}`, {
    ...opts,
    headers: { 'Content-Type': 'application/json', 'X-API-Key': cleInterne(), ...(opts.headers || {}) },
  });
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

function buildServer() {
  const server = new McpServer({ name: 'portail-cabinet', version: '1.0.0' });

  server.tool('lister_clients',
    "Liste ou recherche les clients d'un organisme du Portail Cabinet (impots, urssaf, carpimko, carmf).",
    { source: SRC, recherche: z.string().optional().describe('Filtre par nom / identifiant / notes') },
    async ({ source, recherche }) => {
      try {
        const cfg = SOURCES[source];
        let cs = await apiFetch(cfg.clients);
        if (recherche) { const q = recherche.toLowerCase(); cs = cs.filter((c) => `${c.nom} ${c[cfg.cle] || ''} ${c.notes || ''}`.toLowerCase().includes(q)); }
        return txt(cs.map((c) => ({ id: c.id, nom: c.nom, [cfg.cle]: c[cfg.cle], documents: c.nb_docs ?? 0, verrouille: c.verrouille || false })));
      } catch (e) { return erreur(e); }
    });

  server.tool('ajouter_client',
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
    });

  server.tool('recuperer_documents',
    "Lance la récupération des documents d'un client (par son id et son organisme). Le robot tourne sur le serveur ; pour les Impôts une captcha manuelle reste nécessaire (vue noVNC du portail).",
    { source: SRC, client_id: z.number() },
    async ({ source, client_id }) => {
      try {
        const r = await apiFetch(SOURCES[source].scrape(client_id), { method: 'POST', body: JSON.stringify({}) });
        return txt({ ok: true, message: 'Récupération lancée.', ...r });
      } catch (e) { return erreur(e); }
    });

  server.tool('lister_documents',
    "Liste les documents déjà récupérés d'un client (id, nom, date). L'id sert ensuite à telecharger_document.",
    { source: SRC, client_id: z.number() },
    async ({ source, client_id }) => {
      try {
        const ds = await apiFetch(SOURCES[source].docs(client_id));
        return txt(ds.map((d) => ({ id: d.id, nom: d.libelle || nomFichier(d.fichier) || `document ${d.id}`, fichier: nomFichier(d.fichier), date: d.recupere_le || d.date || null })));
      } catch (e) { return erreur(e); }
    });

  server.tool('telecharger_document',
    "Génère un lien de téléchargement direct (usage unique, valable 10 min) pour un document, par son id et son organisme. Renvoie l'URL et le nom du fichier.",
    { source: SRC, document_id: z.number() },
    async ({ source, document_id }) => {
      try {
        const r = await apiFetch('/api/documents/lien', { method: 'POST', body: JSON.stringify({ source, document_id }) });
        return txt({ ok: true, filename: r.filename, url: r.url, note: 'Lien valable 10 minutes, usage unique.' });
      } catch (e) { return erreur(e); }
    });

  server.tool('etat_recuperation',
    "État de la récupération en cours sur le portail (progression + dernières lignes du journal).",
    {},
    async () => {
      try {
        const p = await apiFetch('/api/progress');
        return txt({ actif: p.actif, fait: p.fait, total: p.total, en_cours: p.courant, derniers_logs: (p.logs || []).slice(-8) });
      } catch (e) { return erreur(e); }
    });

  return server;
}

export function installMcp(app, guard) {
  app.post('/mcp', guard, async (req, res) => {
    try {
      const server = buildServer();
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined }); // sans session (stateless)
      res.on('close', () => { transport.close(); server.close(); });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (e) {
      if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: String(e.message) }, id: null });
    }
  });
  // Mode sans session : pas de flux SSE persistant ni de suppression de session.
  app.get('/mcp', guard, (req, res) => res.status(405).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method Not Allowed.' }, id: null }));
  app.delete('/mcp', guard, (req, res) => res.status(405).end());
}
