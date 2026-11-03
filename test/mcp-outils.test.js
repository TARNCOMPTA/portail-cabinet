// Tests des outils lister_quarantaine et historique_recuperations du connecteur Claude
// (src/mcp-http.js), via un vrai client MCP branche en memoire, contre une FAUSSE API
// locale du portail (/api/quarantaine paginee par 200, /api/urssaf/runs avec `depuis`).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

// 450 documents : 1 par heure en remontant depuis le 2026-11-03 09:00 (UTC).
const DOCS = Array.from({ length: 450 }, (_, i) => {
  const d = new Date(Date.UTC(2026, 10, 3, 9) - i * 3600000).toISOString().slice(0, 19).replace('T', ' ');
  return {
    id: `urssaf/1_DUPONT/doc${i}.pdf`,
    fichier: `doc${i}.pdf`,
    date: d,
    source: i % 2 ? 'urssaf' : 'carmf',
    clientId: 1,
    clientNom: 'DUPONT',
    raison: 'Ni le SIRET ni le nom du client dans le PDF',
    libelle: null,
    reintegrable: true,
    tri: i === 0 ? { verdict: 'autre', motif: 'Appartient a MARTIN' } : null,
  };
});
const RUNS = [
  { lance_le: '2026-11-03 07:10:00', client_id: 3, client_nom: 'C', statut: 'succes', message: '2 nouveau(x) document(s)', nb_docs: 2 },
  { lance_le: '2026-11-03 07:05:00', client_id: 2, client_nom: 'B', statut: 'echec_mdp', message: 'Connexion refusee', nb_docs: 0 },
  { lance_le: '2026-11-03 07:00:00', client_id: 1, client_nom: 'A', statut: 'echec', message: 'Deconnexion URSSAF', nb_docs: 0 },
  { lance_le: '2026-11-02 07:00:00', client_id: 1, client_nom: 'A', statut: 'echec', message: 'veille', nb_docs: 0 },
];
const runsDemandes = [];
const clientsDemandes = [];
const pagesDemandees = [];
let srv;
let client;

before(async () => {
  srv = createServer((req, res) => {
    const u = new URL(req.url, 'http://localhost');
    if (u.pathname === '/api/urssaf/runs') {
      // Comme le portail : `depuis` renvoie toute la periode, sinon les derniers passages.
      const depuis = u.searchParams.get('depuis');
      const clientId = u.searchParams.get('client_id');
      runsDemandes.push(depuis);
      clientsDemandes.push(clientId);
      let liste = depuis ? RUNS.filter((r) => r.lance_le >= depuis) : RUNS.slice(0, 2);
      // client_id : tout l'historique du client, y compris hors des derniers passages.
      if (clientId) liste = RUNS.filter((r) => r.client_id === Number(clientId));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(liste));
      return;
    }
    if (u.pathname !== '/api/quarantaine') {
      res.writeHead(404).end('{}');
      return;
    }
    const source = u.searchParams.get('source');
    const liste = source ? DOCS.filter((d) => d.source === source) : DOCS;
    const taille = Number(u.searchParams.get('taille'));
    const page = Number(u.searchParams.get('page'));
    pagesDemandees.push(page);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        total: DOCS.length,
        filtres: liste.length,
        parSource: { carmf: 225, urssaf: 225 },
        page,
        pages: Math.ceil(liste.length / taille),
        elements: liste.slice((page - 1) * taille, page * taille),
      }),
    );
  });
  await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
  process.env.PORT = String(srv.address().port); // lu au chargement de mcp-http.js
  const { buildServer } = await import('../src/mcp-http.js');
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
  const [cote1, cote2] = InMemoryTransport.createLinkedPair();
  await buildServer().connect(cote1);
  client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(cote2);
});
after(async () => {
  await client?.close();
  srv?.close();
});

const appeler = async (args) => {
  const r = await client.callTool({ name: 'lister_quarantaine', arguments: args });
  assert.ok(!r.isError, r.content?.[0]?.text);
  return JSON.parse(r.content[0].text);
};

test('lister_quarantaine : 50 plus récents par défaut, avec raison et verdict du tri', async () => {
  const r = await appeler({});
  assert.equal(r.total_en_quarantaine, 450);
  assert.equal(r.trouves, 450);
  assert.equal(r.documents.length, 50);
  assert.equal(r.documents[0].fichier, 'doc0.pdf');
  assert.deepEqual(r.documents[0].tri, { verdict: 'autre', motif: 'Appartient a MARTIN' });
  assert.equal(r.documents[1].tri, null);
  assert.match(r.documents[0].raison, /SIRET/);
});

test('lister_quarantaine : `depuis` parcourt les pages et s’arrête à la date', async () => {
  pagesDemandees.length = 0;
  // Depuis le 2026-10-26 00:00 : 8 jours + 9 h = 202 documents (doc0 à doc201, pile à 00:00 inclus), sur 2 pages.
  const r = await appeler({ depuis: '2026-10-26', limite: 200 });
  assert.deepEqual(pagesDemandees, [1, 2], 'page 2 pour finir la période, pas la page 3 (plus ancienne)');
  assert.equal(r.trouves, 202, 'toute la période est comptée');
  assert.equal(r.documents.length, 200);
  assert.ok(r.documents.every((d) => d.date >= '2026-10-26'));
});

test('lister_quarantaine : filtre par organisme transmis à l’API', async () => {
  const r = await appeler({ source: 'urssaf', limite: 5 });
  assert.ok(r.documents.every((d) => d.organisme === 'urssaf'));
  assert.equal(r.documents.length, 5);
});

test('historique_recuperations : `depuis` transmis à l’API et filtre `echecs` (echec + echec_mdp)', async () => {
  const r = await client.callTool({ name: 'historique_recuperations', arguments: { source: 'urssaf', depuis: '2026-11-03', statut: 'echecs' } });
  assert.ok(!r.isError, r.content?.[0]?.text);
  const lignes = JSON.parse(r.content[0].text);
  assert.equal(runsDemandes.at(-1), '2026-11-03');
  assert.deepEqual(
    lignes.map((l) => `${l.client}:${l.statut}`),
    ['B:echec_mdp', 'A:echec'],
  );
});

test('historique_recuperations : sans filtre, inchangé (derniers passages)', async () => {
  const r = await client.callTool({ name: 'historique_recuperations', arguments: { source: 'urssaf' } });
  assert.equal(runsDemandes.at(-1), null);
  assert.equal(JSON.parse(r.content[0].text).length, 2);
});

test('historique_recuperations : client_id transmis à l’API (historique complet du client)', async () => {
  const r = await client.callTool({ name: 'historique_recuperations', arguments: { source: 'urssaf', client_id: 1 } });
  const lignes = JSON.parse(r.content[0].text);
  assert.equal(clientsDemandes.at(-1), '1');
  assert.deepEqual(
    lignes.map((l) => l.date),
    ['2026-11-03 07:00:00', '2026-11-02 07:00:00'],
    'le passage de la veille (hors des 2 derniers passages) est inclus',
  );
});
