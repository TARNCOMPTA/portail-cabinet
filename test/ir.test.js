// Tests du connecteur IMPOT SUR LE REVENU (src/scraper-ir.js) contre un site FACTICE local :
// connexion en deux temps (numero fiscal puis mot de passe), code de securite par e-mail,
// appareil memorise, page « Documents », lien « Declaration par un tiers ». La page de
// connexion est servie sur « localhost », l'espace sur « 127.0.0.1 » (deux hotes, comme
// cfspart-idp / cfspart). Ne teste PAS impots.gouv.fr. Chromium headless (skip si absent).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

const exe = () => (process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const PDF = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.from('% '.repeat(80)), Buffer.from('\n%%EOF\n')]);
const SPI = '1234567890123';
const CODE = '654321';
const page = (corps) => `<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>impots.gouv (factice)</title></head><body>${corps}</body></html>`;
const formLogin = (erreur = '') => `
  ${erreur ? `<p class="fr-error-text">${erreur}</p>` : ''}
  <form id="f" method="post" action="/login">
    <input id="spi_tmp" name="spi">
    <div id="etape2" style="display:none"><input id="pwd_tmp" name="pwd" type="password"><input type="checkbox" name="remember" value="1"></div>
    <button type="button" id="btnAction">Continuer</button>
  </form>
  <script>
    document.getElementById('btnAction').onclick = () => {
      const e2 = document.getElementById('etape2');
      if (e2.style.display === 'none') e2.style.display = 'block';
      else document.getElementById('f').submit();
    };
  </script>`;
const formOtp = (avecChoix, erreur = '') => `
  ${erreur ? `<p class="fr-error-text">${erreur}</p>` : ''}
  <form id="otpform" method="post" action="/otp">
    ${
      avecChoix
        ? `<input type="radio" id="otpchoicemail" name="dest" checked><label for="otpchoicemail">Envoyer à c***t@exemple.fr</label>
           <input type="radio" id="otpchoicecab" name="dest"><label for="otpchoicecab">Envoyer à o***p@tarncompta.fr</label>`
        : ''
    }
    <input id="otp_tmp" name="code"><button id="otpSubmit" type="submit">Valider</button>
  </form>`;
let otpAvecChoix = false;

let srv;
let port;
let scrapeClient;
let relais;
let boite;
let db;
let base;
const posts = [];
let navigateurOk = true;
const CODE_CABINET = '112233';
const TENANT = '00000000-1111-2222-3333-444444444444';
const CLIENT_ID = '00000000-1111-2222-3333-555555555555';
const BOITE_IR = 'otp@tarncompta.fr';
let messagesGraph = []; // alimente par chaque test qui en a besoin, relu par le faux Graph

before(async () => {
  srv = createServer(async (req, res) => {
    let corps = '';
    for await (const c of req) corps += c;
    const u = new URL(req.url, 'http://x');
    const hote = req.headers.host || '';
    const html = (c, h = {}) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', ...h });
      res.end(page(c));
    };
    const vers = (url, h = {}) => {
      res.writeHead(302, { location: url, ...h });
      res.end();
    };
    const espace = `http://127.0.0.1:${port}`;
    if (hote.startsWith('localhost')) {
      if (u.pathname === '/LoginAccess') return html(formLogin());
      if (req.method === 'POST' && u.pathname === '/login') {
        const f = new URLSearchParams(corps);
        posts.push(f.get('spi'));
        if (!['bon', 'avecchoix'].includes(f.get('pwd'))) return html(formLogin('Votre mot de passe est incorrect.'));
        if (/appareil=ok/.test(req.headers.cookie || '')) return vers(`${espace}/accueil`);
        otpAvecChoix = f.get('pwd') === 'avecchoix';
        return html(formOtp(otpAvecChoix));
      }
      if (req.method === 'POST' && u.pathname === '/otp') {
        const bon = otpAvecChoix ? CODE_CABINET : CODE;
        if (new URLSearchParams(corps).get('code') !== bon) return html(formOtp(otpAvecChoix, 'Code erroné'));
        return vers(`${espace}/accueil`, { 'set-cookie': 'appareil=ok; Path=/; Max-Age=86400' });
      }
    }
    if (u.pathname === `/msgraph-login/${TENANT}/oauth2/v2.0/token` && req.method === 'POST') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ access_token: 'G1', expires_in: 3600 }));
    }
    if (u.pathname === `/msgraph-api/users/${encodeURIComponent(BOITE_IR)}/messages`) {
      if (req.headers.authorization !== 'Bearer G1') {
        res.writeHead(401, { 'content-type': 'application/json' });
        return res.end('{}');
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ value: messagesGraph }));
    }
    if (u.pathname === '/accueil') return html(`<h1>Mon espace</h1><a href="/documents">Documents</a> <a href="/messagerie">Messagerie</a>`);
    if (u.pathname === '/documents')
      return html(`<h1>Mes documents</h1>
        <a href="/doc/avis2026.pdf">Avis d'impôt 2026 sur les revenus 2025</a>
        <a href="/doc/avis2021.pdf">Avis d'impôt 2021 sur les revenus 2020</a>
        <a href="/aide">Aide</a>
        <footer><a href="/doc/tiers">Déclaration par un tiers</a></footer>`);
    if (u.pathname.startsWith('/doc/')) {
      const h = { 'content-type': 'application/pdf' };
      if (u.pathname === '/doc/tiers') h['content-disposition'] = 'attachment; filename="declaration_tiers.pdf"';
      res.writeHead(200, h);
      return res.end(PDF);
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
  port = srv.address().port;
  process.env.IR_LOGIN_URL = `http://localhost:${port}/LoginAccess`;
  process.env.IR_HOTE_IDP = 'localhost';
  process.env.IR_DOMAINE = '127\\.0\\.0\\.1';
  process.env.IR_ATTENTE_CODE_MS = '15000';
  process.env.HEADLESS = 'true';
  process.env.NAV_TIMEOUT = '15000';
  process.env.GRAPH_LOGIN_URL = `http://127.0.0.1:${port}/msgraph-login`;
  process.env.GRAPH_API_URL = `http://127.0.0.1:${port}/msgraph-api`;
  ({ scrapeClient } = await import('../src/scraper-ir.js'));
  relais = await import('../src/captcha-relais.js');
  boite = await import('../src/boite-codes.js');
  db = await import('../src/ir-db.js');
  boite.enregistrerBoite({ effacer: true });
  base = mkdtempSync(resolve(tmpdir(), 'ir-test-'));
  try {
    const { chromium } = await import('playwright');
    await (await chromium.launch({ headless: true, ...exe() })).close();
  } catch {
    navigateurOk = false;
  }
});

const crees = [];
after(() => {
  for (const id of crees) {
    db?.deleteClient(id);
    rmSync(resolve('data', 'ir-appareils', `${id}.enc`), { force: true });
  }
  if (base) rmSync(base, { recursive: true, force: true });
  boite?.enregistrerBoite({ effacer: true });
  srv?.close();
});

const nouveauClient = (nom, password) => {
  const c = db.createClient({ nom, login: SPI, password });
  crees.push(c.id);
  return db.getClientCredentials(c.id);
};

test('client seul : code de sécurité saisi dans le bandeau, documents récupérés, 2021 écarté', async (t) => {
  if (!navigateurOk) return t.skip('Chromium indisponible');
  const client = nouveauClient('TEST IR UN', 'bon');
  const run = scrapeClient(client, { baseFolder: base });
  for (let i = 0; i < 200 && !relais.etat().actif; i++) await new Promise((ok) => setTimeout(ok, 50));
  assert.equal(relais.etat().actif, true, 'bandeau ouvert');
  assert.match(relais.etat().titre, /TEST IR UN/);
  assert.equal((await relais.soumettre('000000')).refuse, true, 'code faux refusé');
  assert.equal((await relais.soumettre(CODE)).connecte, true);
  const r = await run;
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(r.docs.map((d) => d.libelle).sort(), ["Avis d'impôt 2026 sur les revenus 2025", 'Déclaration par un tiers']);
  assert.equal(r.horsPeriode, 1, 'avis 2021 hors des 3 ans');
  const dossier = resolve(base, 'TEST_IR_UN');
  assert.ok(
    readdirSync(dossier).some((f) => /declaration_tiers\.pdf$/.test(f)),
    'nom de fichier du serveur conservé',
  );
  assert.ok(existsSync(resolve(dossier, '_diagnostic_ir.json')), 'diagnostic écrit');

  // 2e passage : appareil mémorisé -> aucun code, documents déjà présents.
  const r2 = await scrapeClient(client, { baseFolder: base });
  assert.equal(r2.ok, true, r2.error);
  assert.equal(r2.docs.length, 0);
  assert.equal(r2.dejaPresents, 2);
  assert.equal(relais.etat().actif, false);
});

test('mot de passe refusé : une seule tentative, client verrouillé (echec_mdp)', async (t) => {
  if (!navigateurOk) return t.skip('Chromium indisponible');
  const client = nouveauClient('TEST IR DEUX', 'faux');
  const avant = posts.length;
  const r = await scrapeClient(client, { baseFolder: base });
  assert.equal(r.ok, false);
  assert.equal(posts.length - avant, 1, 'un seul essai de connexion');
  assert.equal(db.clientVerrouille(client.id).verrouille, true);
});

test('tournée (navigateur partagé) : code exigé -> échec immédiat sans bandeau ni verrou', async (t) => {
  if (!navigateurOk) return t.skip('Chromium indisponible');
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true, ...exe() });
  try {
    const client = nouveauClient('TEST IR TROIS', 'bon');
    const r = await scrapeClient(client, { baseFolder: base, browser });
    assert.equal(r.ok, false);
    assert.match(r.error, /Code de sécurité exigé/);
    assert.equal(relais.etat().actif, false, 'pas de bandeau en tournée');
    assert.equal(db.clientVerrouille(client.id).verrouille, false, 'pas de verrou : ce n’est pas un mot de passe faux');
  } finally {
    await browser.close();
  }
});

const messageCodeDgfip = (code) => ({
  subject: 'Votre code de sécurité des impôts',
  from: { emailAddress: { address: 'noreply@dgfip.finances.gouv.fr' } },
  body: { content: `Bonjour,\r\n\r\nVotre code de sécurité à usage unique :\r\n\r\n${code}\r\n\r\nCe code est valable 15 minutes.` },
});

test('boîte des codes configurée : adresse du cabinet choisie, code lu automatiquement (client isolé)', async (t) => {
  if (!navigateurOk) return t.skip('Chromium indisponible');
  boite.enregistrerBoite({ tenant: TENANT, client_id: CLIENT_ID, client_secret: 'sec', boite: BOITE_IR });
  messagesGraph = [messageCodeDgfip(CODE_CABINET)];
  const client = nouveauClient('TEST IR QUATRE', 'avecchoix');
  const r = await scrapeClient(client, { baseFolder: base });
  assert.equal(r.ok, true, r.error);
  assert.equal(relais.etat().actif, false, 'bandeau refermé automatiquement');
  assert.equal(r.docs.length, 2);
  messagesGraph = [];
  boite.enregistrerBoite({ effacer: true });
});

test('tournée + boîte des codes : adresse du cabinet choisie, code lu automatiquement (pas d’échec)', async (t) => {
  if (!navigateurOk) return t.skip('Chromium indisponible');
  boite.enregistrerBoite({ tenant: TENANT, client_id: CLIENT_ID, client_secret: 'sec', boite: BOITE_IR });
  messagesGraph = [messageCodeDgfip(CODE_CABINET)];
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true, ...exe() });
  try {
    const client = nouveauClient('TEST IR CINQ', 'avecchoix');
    const r = await scrapeClient(client, { baseFolder: base, browser });
    assert.equal(r.ok, true, r.error);
    assert.equal(relais.etat().actif, false, 'aucun bandeau en tournée');
    assert.equal(r.docs.length, 2);
  } finally {
    await browser.close();
    messagesGraph = [];
    boite.enregistrerBoite({ effacer: true });
  }
});
