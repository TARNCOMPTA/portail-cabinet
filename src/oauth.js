// Serveur d'autorisation OAuth 2.1 minimal pour le connecteur MCP distant de Claude.
// Conforme aux exigences Claude : PKCE S256 obligatoire, metadonnees de decouverte
// (.well-known), endpoints /authorize + /token, DCR (/register) et client statique
// (les « 2 cles » Client ID/Secret affichees dans le portail).
import crypto from 'node:crypto';
import express from 'express';
import * as oauthDb from './oauth-db.js';
import { verifierIdentifiants, creerThrottle } from './auth.js';
import { getSetting, getUserById } from './db.js';

/** Le collaborateur existe-t-il encore et est-il toujours actif ? */
const utilisateurActif = (userId) => {
  const u = userId != null ? getUserById(userId) : null;
  return !!(u && u.actif);
};

const nomCabinet = () => (getSetting('nom_cabinet', '') || 'Portail Cabinet').trim();

// Echappement HTML complet. La page de consentement est construite par concatenation
// (pas de gabarit a echappement automatique) : TOUTE valeur interpolee passe par ici.
const ENTITES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ENTITES[c]);

const CODE_TTL = 5 * 60 * 1000; // code d'autorisation : 5 min
const ACCESS_TTL = 60 * 60 * 1000; // jeton d'acces : 1 h
const CALLBACK_HOSTE = 'https://claude.ai/api/mcp/auth_callback'; // Claude web/Desktop/mobile
const SCOPES = ['mcp', 'offline_access'];

function baseUrl(req) {
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/$/, '');
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'https';
  return `${proto}://${req.headers.host}`;
}
function s256(verifier) {
  return crypto.createHash('sha256').update(verifier).digest('base64url');
}

// URI de retour digne de confiance EN SOI, sans dependre d'un enregistrement : le callback
// hoste de Claude, ou la boucle locale de Claude Code (port variable). Ce sont les deux
// seules destinations legitimes d'un code d'autorisation pour ce portail.
function uriDeConfiance(uri) {
  if (uri === CALLBACK_HOSTE) return true;
  try {
    const u = new URL(String(uri));
    return (u.hostname === 'localhost' || u.hostname === '127.0.0.1') && u.pathname === '/callback';
  } catch {
    return false;
  }
}

// redirect_uri autorisee : URI de confiance, ou URI explicitement enregistree par le
// client. Depuis le durcissement de /oauth/register, une URI enregistree est elle-meme
// forcement de confiance : la seconde branche ne couvre plus que les clients anterieurs.
function redirectOk(client, uri) {
  if (!uri) return false;
  if (uriDeConfiance(uri)) return true;
  return (client?.redirect_uris || []).includes(uri);
}
function ensureStatic(req) {
  return oauthDb.getOrCreateStaticClient([CALLBACK_HOSTE]);
}

// ---- Page de consentement (login portail) ---------------------------------
// Seuls ces parametres sont recopies en champs caches. Liste FERMEE : reprendre les cles
// de la requete laissait un nom de parametre arbitraire s'ecrire tel quel dans le HTML
// (`name="${k}"`), donc injecter du balisage actif sur le domaine du cabinet. Ce sont
// exactement les champs relus par le POST /oauth/authorize -> aucune perte fonctionnelle.
// email/password sont volontairement absents : ils ont deja leurs champs visibles, les
// dupliquer donnerait des valeurs en tableau et ferait echouer les tentatives suivantes.
const CHAMPS_OAUTH = ['client_id', 'response_type', 'redirect_uri', 'code_challenge', 'code_challenge_method', 'scope', 'state', 'resource'];

function pageAutorisation(req, params, erreur = '') {
  const champs = CHAMPS_OAUTH.filter((k) => params?.[k] != null)
    .map((k) => `<input type="hidden" name="${k}" value="${esc(params[k])}">`)
    .join('');
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Autoriser le connecteur — ${esc(nomCabinet())}</title>
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
  <h1>Connecter <span class="app">Claude</span> à ${esc(nomCabinet())}</h1>
  <p>Claude demande l'accès au portail ${esc(nomCabinet())} (clients & récupérations). Connecte-toi avec ton compte collaborateur pour autoriser.</p>
  ${erreur ? `<div class="err">${esc(erreur)}</div>` : ''}
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
    const email = String(p.email || '')
      .trim()
      .toLowerCase();
    // Meme anti-brute-force que /api/auth/login (throttle IP + compte, bannissement
    // escalade) : cette route publique verifie le meme mot de passe collaborateur.
    const auth = verifierIdentifiants(req, email, String(p.password || ''));
    if (auth.bloque) {
      return res
        .status(429)
        .set('Content-Type', 'text/html; charset=utf-8')
        .send(pageAutorisation(req, p, 'Trop de tentatives. Réessaie dans 15 minutes.'));
    }
    if (!auth.user) {
      return res
        .status(401)
        .set('Content-Type', 'text/html; charset=utf-8')
        .send(pageAutorisation(req, p, 'E-mail ou mot de passe incorrect.'));
    }
    const u = auth.user;
    const code = oauthDb.rnd(24);
    oauthDb.saveCode({
      code,
      client_id: p.client_id,
      redirect_uri: p.redirect_uri,
      code_challenge: p.code_challenge,
      scope: p.scope || 'mcp',
      user_id: u.id,
      resource: p.resource || null,
      expires_at: Date.now() + CODE_TTL,
    });
    const url = new URL(p.redirect_uri);
    url.searchParams.set('code', code);
    if (p.state) url.searchParams.set('state', p.state);
    res.redirect(url.toString());
  });

  // --- /token ---
  function authClient(req) {
    const b = req.body || {};
    let id = b.client_id,
      secret = b.client_secret;
    const h = req.headers.authorization || '';
    if (h.startsWith('Basic ')) {
      const [bid, bsec] = Buffer.from(h.slice(6), 'base64').toString().split(':');
      id = id || bid;
      secret = secret ?? bsec;
    }
    const client = id ? oauthDb.getClient(id) : null;
    return { client, secret };
  }
  function emettreJetons(res, client_id, user_id, scope) {
    const access = oauthDb.rnd(32),
      refresh = oauthDb.rnd(32);
    oauthDb.saveToken({ access_token: access, refresh_token: refresh, client_id, user_id, scope, expires_at: Date.now() + ACCESS_TTL });
    res.json({ access_token: access, token_type: 'Bearer', expires_in: Math.floor(ACCESS_TTL / 1000), refresh_token: refresh, scope });
  }
  app.post('/oauth/token', express.urlencoded({ extended: true }), (req, res) => {
    const b = req.body || {};
    const { client, secret } = authClient(req);
    if (!client) return res.status(401).json({ error: 'invalid_client' });
    if (client.client_secret && !oauthDb.verifierSecret(client, secret)) return res.status(401).json({ error: 'invalid_client' });

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
      // Compte desactive ou supprime : on ne renouvelle pas, et on brule le refresh au
      // passage — sinon un ancien collaborateur gardait un acces renouvelable sans fin.
      if (!utilisateurActif(row.user_id)) {
        oauthDb.deleteByRefresh(row.refresh_token);
        return res.status(400).json({ error: 'invalid_grant', error_description: 'Compte désactivé.' });
      }
      oauthDb.deleteByRefresh(row.refresh_token); // rotation du refresh (OAuth 2.1)
      return emettreJetons(res, client.client_id, row.user_id, row.scope || 'mcp');
    }

    return res.status(400).json({ error: 'unsupported_grant_type' });
  });

  // --- /register : Dynamic Client Registration (RFC 7591) ---
  // Endpoint PUBLIC (prevu par la spec MCP). Garde-fous contre l'abus : un throttle par IP,
  // un plafond du nombre de clients conserves, et surtout des URI de retour RESTREINTES.
  // Sans cette derniere, n'importe qui sur internet enregistrait un client pointant vers son
  // propre serveur, puis envoyait a un collaborateur un lien d'autorisation sur le vrai
  // domaine du cabinet : le code d'autorisation partait chez l'attaquant (PKCE ne protege
  // pas d'un client lui-meme malveillant).
  const regThrottle = creerThrottle({ max: 10, fenetreMs: 60 * 60 * 1000 });

  // Clients enregistres AVANT ce durcissement : ceux qui pointent ailleurs que vers Claude
  // ou la boucle locale n'auraient jamais du l'etre. On les retire au demarrage, avec leurs
  // jetons. Sur une installation saine il n'y en a aucun.
  for (const c of oauthDb.listerClientsDcr()) {
    if (c.redirect_uris.length && c.redirect_uris.every(uriDeConfiance)) continue;
    oauthDb.supprimerClient(c.client_id);
    console.warn(`[oauth] client « ${c.name || c.client_id} » supprimé : URI de retour non autorisée (${c.redirect_uris.join(', ') || 'aucune'}).`);
  }

  app.post('/oauth/register', (req, res) => {
    const ip = req.ip || req.socket?.remoteAddress || 'inconnu';
    if (regThrottle.bloque(ip)) return res.status(429).json({ error: 'too_many_requests' });
    regThrottle.echec(ip);
    const b = req.body || {};
    const redirect_uris = (Array.isArray(b.redirect_uris) ? b.redirect_uris : []).map(String);
    if (!redirect_uris.length || !redirect_uris.every(uriDeConfiance)) {
      return res.status(400).json({
        error: 'invalid_redirect_uri',
        error_description: `Seules ${CALLBACK_HOSTE} et la boucle locale (http://localhost:<port>/callback) sont acceptées comme URL de retour.`,
      });
    }
    const isPublic = b.token_endpoint_auth_method === 'none';
    const client_id = 'dcr-' + oauthDb.rnd(12);
    const client_secret = isPublic ? null : oauthDb.rnd(32);
    oauthDb.createClient({ client_id, client_secret, redirect_uris, name: b.client_name || 'Client MCP', statique: 0 });
    oauthDb.purgerClientsDcr(50); // ne conserve que les 50 clients DCR les plus recents
    const out = {
      client_id,
      redirect_uris,
      token_endpoint_auth_method: isPublic ? 'none' : 'client_secret_post',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    };
    if (client_secret) out.client_secret = client_secret;
    res.status(201).json(out);
  });
}

// --- Garde Bearer pour /mcp ---
export function requireBearer(req, res, next) {
  const base = baseUrl(req);
  const defie = () =>
    res
      .status(401)
      .set('WWW-Authenticate', `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource"`)
      .json({ error: 'invalid_token', error_description: "Jeton d'accès requis." });
  const h = req.headers.authorization || '';
  if (!h.startsWith('Bearer ')) return defie();
  const row = oauthDb.getByAccess(h.slice(7).trim());
  if (!row || row.expires_at < Date.now()) return defie();
  // Le jeton ne suffit pas : on revalide a CHAQUE appel le collaborateur et le client.
  // Sans ca, desactiver un compte (depart d'un salarie) ne coupait pas son connecteur —
  // ses jetons restaient acceptes, et son refresh token les renouvelait indefiniment.
  if (!utilisateurActif(row.user_id) || !oauthDb.getClient(row.client_id)) return defie();
  req.oauth = { user_id: row.user_id, scope: row.scope, client_id: row.client_id };
  next();
}

// pageAutorisation et uriDeConfiance sont exportees pour etre testables directement :
// ce sont les deux points ou une erreur redonne une faille (injection HTML / code
// d'autorisation envoye chez un tiers).
export { baseUrl, CALLBACK_HOSTE, pageAutorisation, uriDeConfiance, esc };
