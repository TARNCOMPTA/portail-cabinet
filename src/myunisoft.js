// Connexion a l'API MyUnisoft : base URL + jeton Bearer (+ secret tiers).
// Les secrets sont chiffres au repos (src/crypto.js) et ne sont jamais renvoyes a l'interface.
import { getSetting, setSetting } from './db.js';
import { encrypt, decrypt } from './crypto.js';

export const BASE_PAR_DEFAUT = 'https://api.myunisoft.fr/api/v1';

function secret(cle) {
  const v = getSetting(cle, '') || '';
  return v ? decrypt(v) : '';
}

export function baseMyunisoft() {
  return (getSetting('myunisoft_base_url', '') || BASE_PAR_DEFAUT).replace(/\/+$/, '');
}

export function etatMyunisoft() {
  return {
    base_url: baseMyunisoft(),
    token_defini: !!secret('myunisoft_token_enc'),
    secret_tiers_defini: !!secret('myunisoft_secret_tiers_enc'),
  };
}

/** Enregistre la configuration. Un secret vide est ignoré (on garde l'existant) ; `effacer` le supprime. */
export function enregistrerMyunisoft({ base_url, token, secret_tiers, effacer } = {}) {
  if (typeof base_url === 'string') {
    const b = base_url.trim();
    if (b && !/^https:\/\/[^\s/]+/i.test(b)) throw new Error("L'URL de l'API doit commencer par https://");
    setSetting('myunisoft_base_url', b);
  }
  if (typeof token === 'string' && token.trim()) setSetting('myunisoft_token_enc', encrypt(token.trim()));
  if (typeof secret_tiers === 'string' && secret_tiers.trim()) setSetting('myunisoft_secret_tiers_enc', encrypt(secret_tiers.trim()));
  if (effacer === true) {
    setSetting('myunisoft_token_enc', '');
    setSetting('myunisoft_secret_tiers_enc', '');
  }
  return etatMyunisoft();
}

/** Appel authentifie de l'API MyUnisoft (usage interne et test de connexion). */
export async function appelMyunisoft(chemin, { timeoutMs = 10000, headers = {} } = {}) {
  const token = secret('myunisoft_token_enc');
  if (!token) return { ok: false, error: "Aucun jeton MyUnisoft n'est configuré." };
  const tiers = secret('myunisoft_secret_tiers_enc');
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(baseMyunisoft() + chemin, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', ...(tiers ? { 'X-Third-Party-Secret': tiers } : {}), ...headers },
      signal: ctrl.signal,
    });
    const texte = await r.text();
    let data = null;
    try {
      data = JSON.parse(texte);
    } catch {
      /* corps non JSON */
    }
    const message = data?.error?.message || data?.message || '';
    return { ok: r.ok, statut: r.status, data, error: r.ok ? undefined : message || `HTTP ${r.status}` };
  } catch (e) {
    return { ok: false, error: e.name === 'AbortError' ? `Délai dépassé (${timeoutMs / 1000} s).` : e.message };
  } finally {
    clearTimeout(t);
  }
}

/** Appel authentifie renvoyant le corps brut (PDF, FEC texte...). `body` => requete JSON. */
export async function appelMyunisoftBinaire(chemin, { method = 'GET', body, headers = {}, timeoutMs = 60000, maxOctets = 25 * 1024 * 1024 } = {}) {
  const token = secret('myunisoft_token_enc');
  if (!token) return { ok: false, error: "Aucun jeton MyUnisoft n'est configuré." };
  const tiers = secret('myunisoft_secret_tiers_enc');
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(baseMyunisoft() + chemin, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(tiers ? { 'X-Third-Party-Secret': tiers } : {}),
        ...headers,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: ctrl.signal,
    });
    const buf = Buffer.from(await r.arrayBuffer());
    const type = r.headers.get('content-type') || 'application/octet-stream';
    if (!r.ok) {
      let message = '';
      try {
        const j = JSON.parse(buf.toString('utf8'));
        message = j?.error?.message || j?.message || '';
      } catch {
        /* corps non JSON */
      }
      return { ok: false, statut: r.status, error: message || `HTTP ${r.status}` };
    }
    if (buf.length > maxOctets) return { ok: false, statut: r.status, error: `Fichier trop volumineux (${Math.round(buf.length / 1048576)} Mo).` };
    return { ok: true, statut: r.status, buf, type };
  } catch (e) {
    return { ok: false, error: e.name === 'AbortError' ? `Délai dépassé (${timeoutMs / 1000} s).` : e.message };
  } finally {
    clearTimeout(t);
  }
}

/** Test de connexion : liste les sociétés accessibles avec ce jeton. */
export async function testerMyunisoft() {
  const r = await appelMyunisoft('/society');
  if (!r.ok) return { ok: false, statut: r.statut, error: r.error };
  const liste = Array.isArray(r.data) ? r.data : r.data?.array || r.data?.data || [];
  return { ok: true, statut: r.statut, societes: Array.isArray(liste) ? liste.length : null };
}
