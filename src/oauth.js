// Serveur d'autorisation OAuth 2.1 minimal pour le connecteur MCP distant de Claude.
// Conforme aux exigences Claude : PKCE S256 obligatoire, metadonnees de decouverte
// (.well-known), endpoints /authorize + /token, DCR (/register) et client statique
// (les « 2 cles » Client ID/Secret affichees dans le portail).
import crypto from 'node:crypto';
import express from 'express';
import * as oauthDb from './oauth-db.js';
import { verifyPassword } from './auth.js';
import { getUserByEmail, getUserById } from './db.js';

const CODE_TTL = 5 * 60 * 1000;          // code d'autorisation : 5 min
const ACCESS_TTL = 60 * 60 * 1000;       // jeton d'acces : 1 h
const CALLBACK_HOSTE = 'https://claude.ai/api/mcp/auth_callback'; // Claude web/Desktop/mobile
const SCOPES = ['mcp', 'offline_access'];

function baseUrl(req) {
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/$/, '');
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'https';
  return `${proto}://${req.headers.host}`;
}
function s256(verifier) { return crypto.createHash('sha256').update(verifier).digest('base64url'); }

// redirect_uri autorisee : callback Claude hoste, boucle locale (Claude Code, port
// variable) ou URI explicitement enregistree par le client (DCR).
function redirectOk(client, uri) {
  if (!uri) return false;
  if (uri === CALLBACK_HOSTE) return true;
  try {
    const u = new URL(uri);
    if ((u.hostname === 'localhost' || u.hostname === '127.0.0.1') && u.pathname === '/callback') return true;
  } catch { return false; }
  return (client?.redirect_uris || []).includes(uri);
}
function ensureStatic(req) {
  return oauthDb.getOrCreateStaticClient([CALLBACK_HOSTE]);
}

// ---- Page de consentement (login portail) ---------------------------------
function pageAutorisation(req, params, erreur = '') {
  const champs = Object.entries(params)
    .map(([k, v]) => `<input type="hidden" name="${k}" value="${String(v ?? '').replace(/"/g, '&quot;')}">`).join('');
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Autoriser le connecteur — Portail Cabinet</title>
<style>
  :root{--accent:#7c2d5e;--bg:#f7f3f0;--card:#fff;--bord:#ece5e0;--txt:#2c2329;--txt2:#6b5f64;}
  *{box-sizing:border-box} body{font-family:system-ui,Segoe UI,sans-serif;background:var(--bg);color:var(--txt);margin:0;display:flex;min-height:100vh;align-items:center;justify-content:center;padding:24px}
  .card{background:var(--card);border:1px solid var(--bord);border-radius:16px;padding:28px;max-width:380px;width:100%;box-shadow:0 12px 32px rgba(124,45,94,.10)}
  h1{font-size:18px;margin:0 0 4px} p{color:var(--txt2);font-size:14px;margin:0 0 18px;line-height:1.4}
  label{display:block;font-size:13px;color:var(--txt2);margin:12px 0 4px}
  input[type=email],input[type=password]{width:100%;padding:10px 12px;border:1px solid var(--bord);border-radius:10px;font-size:14px}
  button{margin-top:20px;width:100%;padding:11px;background:var(--accent);color:#fff;border:0;border-radius:10px;font-size:15px;font-weight:600;cursor:pointer}
  .err{background:#f8e6e2;color:#b3402f;padding:10px 12px;border-radius:10px;font-size:13px;margin-bottom:14px}
  .app{font-weight:600;color:var(--accent)}
</style></head><body>
<form class="card" method="post" action="/oauth/authorize">
  <h1>Connecter <span class="app">Claude</span> au Portail Cabinet</h1>
  <p>Claude demande l'accès à ton Portail Cabinet (clients & récupérations). Connecte-toi avec ton compte collaborateur pour autoriser.</p>
  ${erreur ? `<div class="err">${erreur}</div>` : ''}
  ${champs}
  <label>E-mail<input type="email" name="email" required autofocus placeholder="collaborateur@cabinet.fr"></label>
  <label>Mot de passe<input type="password" name="password" required placeholder="Mot de passe du portail"></label>
  <button type="submit">Autoriser l'accès</button>
</form></body></html>`;
}

export function installOAuth(app) {
  // --- Metadonnees de decouverte (RFC 8414 + protected resource) ---
  const asMeta = (req) => {
    const base = baseUrl(req);
    return {
      issuer: base,
      authorization_endpoint: `${base}/oauth/authorize`,
      token_endpoint: `${base}/oauth/token`,
      registration_endpoint: `${base}/oauth/register`,
      scopes_supported: SCOPES,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic', 'none'],
    };
  };
  const prMeta = (req) => {
    const base = baseUrl(req);
    return {
      resource: `${base}/mcp`,
      authorization_servers: [base],
      scopes_supported: SCOPES,
      bearer_methods_supported: ['header'],
    };
  };
  for (const p of ['/.well-known/oauth-authorization-server', '/.well-known/oauth-authorization-server/mcp']) {
    app.get(p, (req, res) => res.json(asMeta(req)));
  }
  for (const p of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp']) {
    app.get(p, (req, res) => res.json(prMeta(req)));
  }
  // OpenID-style alias (certains clients le sondent)
  app.get('/.well-known/openid-configuration', (req, res) => res.json(asMeta(req)));

  // --- /authorize : affiche le formulaire (GET) puis emet le code (POST) ---
  function validerAuthorizeParams(q) {
    const client = oauthDb.getClient(q.client_id);
    if (!client) return { err: 'Client inconnu (client_id).' };
    if (q.response_type !== 'code') return { err: 'response_type doit valoir « code ».' };
    if (q.code_challenge_method !== 'S256' || !q.code_challenge) return { err: 'PKCE S256 requis.' };
    if (!redirectOk(client, q.redirect_uri)) return { err: 'redirect_uri non autorisée.' };
    return { client };
  }
  app.get('/oauth/authorize', (req, res) => {
    ensureStatic(req);
    const v = validerAuthorizeParams(req.query);
    if (v.err) return res.status(400).send(`Paramètres OAuth invalides : ${v.err}`);
    res.set('Content-Type', 'text/html; charset=utf-8').send(pageAutorisation(req, req.query));
  });
  app.post('/oauth/authorize', express.urlencoded({ extended: true }), (req, res) => {
    const p = req.body || {};
    const v = validerAuthorizeParams(p);
    if (v.err) return res.status(400).send(`Paramètres OAuth invalides : ${v.err}`);
    const email = String(p.email || '').trim().toLowerCase();
    const u = getUserByEmail(email);
    if (!u || !u.actif || !verifyPassword(String(p.password || ''), u.password_hash)) {
      return res.status(401).set('Content-Type', 'text/html; charset=utf-8')
        .send(pageAutorisation(req, p, 'E-mail ou mot de passe incorrect.'));
    }
    const code = oauthDb.rnd(24);
    oauthDb.saveCode({
      code, client_id: p.client_id, redirect_uri: p.redirect_uri, code_challenge: p.code_challenge,
      scope: p.scope || 'mcp', user_id: u.id, resource: p.resource || null, expires_at: Date.now() + CODE_TTL,
    });
    const url = new URL(p.redirect_uri);
    url.searchParams.set('code', code);
    if (p.state) url.searchParams.set('state', p.state);
    res.redirect(url.toString());
  });

  // --- /token ---
  function authClient(req) {
    const b = req.body || {};
    let id = b.client_id, secret = b.client_secret;
    const h = req.headers.authorization || '';
    if (h.startsWith('Basic ')) {
      const [bid, bsec] = Buffer.from(h.slice(6), 'base64').toString().split(':');
      id = id || bid; secret = secret ?? bsec;
    }
    const client = id ? oauthDb.getClient(id) : null;
    return { client, secret };
  }
  function emettreJetons(res, client_id, user_id, scope) {
    const access = oauthDb.rnd(32), refresh = oauthDb.rnd(32);
    oauthDb.saveToken({ access_token: access, refresh_token: refresh, client_id, user_id, scope, expires_at: Date.now() + ACCESS_TTL });
    res.json({ access_token: access, token_type: 'Bearer', expires_in: Math.floor(ACCESS_TTL / 1000), refresh_token: refresh, scope });
  }
  app.post('/oauth/token', express.urlencoded({ extended: true }), (req, res) => {
    const b = req.body || {};
    const { client, secret } = authClient(req);
    if (!client) return res.status(401).json({ error: 'invalid_client' });
    if (client.client_secret && client.client_secret !== secret) return res.status(401).json({ error: 'invalid_client' });

    if (b.grant_type === 'authorization_code') {
      const row = oauthDb.takeCode(String(b.code || ''));
      if (!row || row.expires_at < Date.now()) return res.status(400).json({ error: 'invalid_grant', error_description: 'Code invalide ou expiré.' });
      if (row.client_id !== client.client_id) return res.status(400).json({ error: 'invalid_grant' });
      if (row.redirect_uri !== b.redirect_uri) return res.status(400).json({ error: 'invalid_grant', error_description: 'redirect_uri ne correspond pas.' });
      if (!b.code_verifier || s256(String(b.code_verifier)) !== row.code_challenge) {
        return res.status(400).json({ error: 'invalid_grant', error_description: 'PKCE invalide.' });
      }
      return emettreJetons(res, client.client_id, row.user_id, row.scope || 'mcp');
    }

    if (b.grant_type === 'refresh_token') {
      const row = oauthDb.getByRefresh(String(b.refresh_token || ''));
      if (!row || row.client_id !== client.client_id) return res.status(400).json({ error: 'invalid_grant' });
      oauthDb.deleteByRefresh(row.refresh_token); // rotation du refresh (OAuth 2.1)
      return emettreJetons(res, client.client_id, row.user_id, row.scope || 'mcp');
    }

    return res.status(400).json({ error: 'unsupported_grant_type' });
  });

  // --- /register : Dynamic Client Registration (RFC 7591) ---
  app.post('/oauth/register', (req, res) => {
    const b = req.body || {};
    const redirect_uris = Array.isArray(b.redirect_uris) ? b.redirect_uris : [];
    const isPublic = b.token_endpoint_auth_method === 'none';
    const client_id = 'dcr-' + oauthDb.rnd(12);
    const client_secret = isPublic ? null : oauthDb.rnd(32);
    oauthDb.createClient({ client_id, client_secret, redirect_uris, name: b.client_name || 'Client MCP', statique: 0 });
    const out = {
      client_id, redirect_uris,
      token_endpoint_auth_method: isPublic ? 'none' : 'client_secret_post',
      grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'],
    };
    if (client_secret) out.client_secret = client_secret;
    res.status(201).json(out);
  });
}

// --- Garde Bearer pour /mcp ---
export function requireBearer(req, res, next) {
  const base = baseUrl(req);
  const defie = () => res.status(401)
    .set('WWW-Authenticate', `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource"`)
    .json({ error: 'invalid_token', error_description: 'Jeton d\'accès requis.' });
  const h = req.headers.authorization || '';
  if (!h.startsWith('Bearer ')) return defie();
  const row = oauthDb.getByAccess(h.slice(7).trim());
  if (!row || row.expires_at < Date.now()) return defie();
  req.oauth = { user_id: row.user_id, scope: row.scope, client_id: row.client_id };
  next();
}

export { baseUrl, CALLBACK_HOSTE };
