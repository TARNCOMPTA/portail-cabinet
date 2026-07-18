// Authentification des collaborateurs du cabinet (multi-utilisateurs).
// Mots de passe haches (scrypt), sessions par cookie httpOnly stockees en base.
import crypto from 'node:crypto';
import { getUserByEmail, touchUserLogin, createSession, getSessionUser, deleteSession, getSetting, setSetting, bannissementIp } from './db.js';

// ---- Clé API (pour le MCP / accès programmatique) ----
// Une clé revocable, distincte des mots de passe des comptes. Donne un accès
// "service" (role admin) via l'en-tete X-API-Key (ou Authorization: Bearer).
// Seul le HACHAGE (SHA-256) est stocké : le clair n'est visible qu'à la
// génération. Migration : une ancienne clé stockée en clair (setting api_key)
// est hachée au premier accès et reste valide.
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
function getApiKeyHash() {
  const ancienne = getSetting('api_key', '') || '';
  if (ancienne) {
    setSetting('api_key_hash', sha256(ancienne));
    setSetting('api_key', '');
  }
  return getSetting('api_key_hash', '') || '';
}
export function apiKeyDefinie() {
  return !!getApiKeyHash();
}
export function regenererApiKey() {
  const k = crypto.randomBytes(24).toString('hex');
  setSetting('api_key_hash', sha256(k));
  setSetting('api_key', '');
  return k; // seul moment où le clair existe
}
export function revoquerApiKey() {
  setSetting('api_key_hash', '');
  setSetting('api_key', '');
}
// Clé de service INTERNE (appels du MCP HTTP vers l'API locale) : générée en
// mémoire à chaque démarrage, jamais stockée ni exposée.
const CLE_INTERNE = crypto.randomBytes(24).toString('hex');
export function getCleInterne() {
  return CLE_INTERNE;
}
function cleDeRequete(req) {
  const h = req.headers['x-api-key'];
  if (h) return String(h).trim();
  const m = String(req.headers['authorization'] || '').match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : '';
}

const COOKIE = 'portail_session';
const SESSION_MS = 7 * 24 * 60 * 60 * 1000; // 7 jours

export function hashPassword(pwd) {
  const salt = crypto.randomBytes(16);
  const dk = crypto.scryptSync(String(pwd), salt, 64);
  return `scrypt$${salt.toString('hex')}$${dk.toString('hex')}`;
}
export function verifyPassword(pwd, stored) {
  try {
    const [algo, saltHex, hashHex] = String(stored).split('$');
    if (algo !== 'scrypt') return false;
    const dk = crypto.scryptSync(String(pwd), Buffer.from(saltHex, 'hex'), 64);
    const ref = Buffer.from(hashHex, 'hex');
    return ref.length === dk.length && crypto.timingSafeEqual(ref, dk);
  } catch {
    return false;
  }
}

function parseCookies(req) {
  const out = {};
  const h = req.headers.cookie;
  if (!h) return out;
  for (const p of h.split(';')) {
    const i = p.indexOf('=');
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  }
  return out;
}
function secureReq(req) {
  return req.secure || req.headers['x-forwarded-proto'] === 'https';
}
function setCookie(req, res, token, maxAgeMs) {
  const parts = [`${COOKIE}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${Math.floor(maxAgeMs / 1000)}`];
  if (secureReq(req)) parts.push('Secure');
  res.append('Set-Cookie', parts.join('; '));
}
function clearCookie(req, res) {
  const parts = [`${COOKIE}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (secureReq(req)) parts.push('Secure');
  res.append('Set-Cookie', parts.join('; '));
}

export function currentUser(req) {
  const token = parseCookies(req)[COOKIE];
  return token ? getSessionUser(token) : null;
}

// Routes publiques d'authentification (connexion / deconnexion / qui-suis-je).
// ---- Anti-brute-force : throttle des connexions (en memoire) ----
// Deux compteurs independants : par IP (attaquant unique) ET par compte vise
// (attaque distribuee sur un meme e-mail depuis beaucoup d'adresses).
export function creerThrottle({ max, fenetreMs }) {
  const echecs = new Map(); // cle -> { n, resetAt }
  return {
    bloque(cle) {
      const e = echecs.get(cle);
      if (!e) return false;
      if (Date.now() > e.resetAt) {
        echecs.delete(cle);
        return false;
      }
      return e.n >= max;
    },
    echec(cle) {
      const e = echecs.get(cle);
      if (!e || Date.now() > e.resetAt) echecs.set(cle, { n: 1, resetAt: Date.now() + fenetreMs });
      else e.n++;
    },
    reussite(cle) {
      echecs.delete(cle);
    },
  };
}
const LOGIN_FENETRE = 15 * 60 * 1000; // fenetre de 15 min
const throttleIp = creerThrottle({ max: 10, fenetreMs: LOGIN_FENETRE });
const throttleCompte = creerThrottle({ max: 5, fenetreMs: LOGIN_FENETRE });

export function installAuthRoutes(app) {
  app.post('/api/auth/login', (req, res) => {
    const ip = req.ip || req.socket?.remoteAddress || 'inconnu';
    const email = String(req.body?.email || '')
      .trim()
      .toLowerCase();
    // Meme message pour IP et compte bloques : ne revele pas si l'e-mail existe.
    if (throttleIp.bloque(ip) || throttleCompte.bloque(email)) return res.status(429).json({ error: 'Trop de tentatives. Réessaie dans 15 minutes.' });
    const pwd = String(req.body?.password || '');
    const u = getUserByEmail(email);
    if (!u || !u.actif || !verifyPassword(pwd, u.password_hash)) {
      throttleIp.echec(ip);
      throttleCompte.echec(email);
      bannissementIp.echec(req, 2, 'connexion échouée'); // alimente le bannissement escaladé
      return res.status(401).json({ error: 'E-mail ou mot de passe incorrect.' });
    }
    throttleIp.reussite(ip); // connexion reussie : on remet les compteurs a zero
    throttleCompte.reussite(email);
    bannissementIp.reussite(req);
    const token = crypto.randomBytes(32).toString('hex');
    createSession(token, u.id, new Date(Date.now() + SESSION_MS).toISOString());
    touchUserLogin(u.id);
    setCookie(req, res, token, SESSION_MS);
    res.json({ user: { id: u.id, email: u.email, nom: u.nom, role: u.role } });
  });

  app.post('/api/auth/logout', (req, res) => {
    const token = parseCookies(req)[COOKIE];
    if (token) deleteSession(token);
    clearCookie(req, res);
    res.json({ ok: true });
  });

  app.get('/api/auth/me', (req, res) => {
    const u = currentUser(req);
    if (!u) return res.status(401).json({ error: 'Non authentifié.' });
    res.json({ user: u });
  });
}

// Porte : exige une session valide (sinon 401 pour l'API, redirection sinon).
export function requireAuth(req, res, next) {
  // Accès par clé API (MCP / programmatique) : en-tete X-API-Key ou Bearer.
  // Comparaison sur les hachages (longueur constante -> timingSafeEqual direct).
  const fournie = cleDeRequete(req);
  if (fournie) {
    const hFournie = sha256(fournie);
    const hStockee = getApiKeyHash();
    const ok =
      (hStockee && crypto.timingSafeEqual(Buffer.from(hFournie), Buffer.from(hStockee))) ||
      crypto.timingSafeEqual(Buffer.from(hFournie), Buffer.from(sha256(CLE_INTERNE)));
    if (ok) {
      req.user = { id: 0, email: 'api', nom: 'Accès API', role: 'admin', viaApiKey: true };
      return next();
    }
  }
  const u = currentUser(req);
  if (!u) {
    if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Non authentifié.' });
    return res.redirect('/login.html');
  }
  req.user = u;
  next();
}
// Exige le role admin (a placer apres requireAuth).
export function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: 'Réservé aux administrateurs.' });
  next();
}
