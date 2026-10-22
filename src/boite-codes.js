// Boite mail des codes de double authentification (Microsoft 365, ex. caisses@tarncompta.fr).
// Le portail la lit via Microsoft Graph avec une application Entra ID (flux « client
// credentials », permission applicative Mail.Read restreinte a CETTE boite par l'admin
// Exchange). Lecture seule : rien n'est deplace ni marque lu ; on ne retient que les mails
// recus APRES la demande de code. Secret chiffre au repos, jamais renvoye a l'interface.
import { getSetting, setSetting } from './db.js';
import { encrypt, decrypt } from './crypto.js';

const LOGIN = process.env.GRAPH_LOGIN_URL || 'https://login.microsoftonline.com';
const GRAPH = process.env.GRAPH_API_URL || 'https://graph.microsoft.com/v1.0';
export const BOITE_PAR_DEFAUT = 'caisses@tarncompta.fr';

function config() {
  const s = getSetting('boite_codes_secret_enc', '') || '';
  return {
    tenant: getSetting('boite_codes_tenant', '') || '',
    clientId: getSetting('boite_codes_client_id', '') || '',
    secret: s ? decrypt(s) : '',
    boite: getSetting('boite_codes_adresse', '') || BOITE_PAR_DEFAUT,
  };
}

export function boiteConfiguree() {
  const c = config();
  return !!(c.tenant && c.clientId && c.secret);
}

export function etatBoite() {
  const c = config();
  return {
    tenant: c.tenant,
    client_id: c.clientId,
    boite: c.boite,
    secret_defini: !!c.secret,
    configuree: boiteConfiguree(),
    adresse_impots: getSetting('boite_codes_adresse_impots', '') || '',
  };
}

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Secret vide = inchange ; `effacer` supprime tout. */
export function enregistrerBoite({ tenant, client_id, client_secret, boite, adresse_impots, effacer } = {}) {
  if (effacer === true) {
    for (const k of ['boite_codes_tenant', 'boite_codes_client_id', 'boite_codes_secret_enc', 'boite_codes_adresse', 'boite_codes_adresse_impots'])
      setSetting(k, '');
    jeton = null;
    return etatBoite();
  }
  if (typeof tenant === 'string') {
    if (tenant.trim() && !GUID.test(tenant.trim())) throw new Error("L'ID de l'annuaire (locataire) est un identifiant du type 0000aaaa-11bb-…");
    setSetting('boite_codes_tenant', tenant.trim());
  }
  if (typeof client_id === 'string') {
    if (client_id.trim() && !GUID.test(client_id.trim())) throw new Error("L'ID d'application (client) est un identifiant du type 0000aaaa-11bb-…");
    setSetting('boite_codes_client_id', client_id.trim());
  }
  if (typeof client_secret === 'string' && client_secret.trim()) setSetting('boite_codes_secret_enc', encrypt(client_secret.trim()));
  if (typeof boite === 'string') {
    const b = boite.trim();
    if (b && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(b)) throw new Error('Adresse de la boîte invalide.');
    setSetting('boite_codes_adresse', b);
  }
  if (typeof adresse_impots === 'string') definirAdresseCodesImpots(adresse_impots);
  jeton = null; // identifiants changes : nouveau jeton au prochain appel
  return etatBoite();
}

// ---- Graph -----------------------------------------------------------------------
let jeton = null; // { valeur, expire }

async function jetonGraph(c) {
  if (jeton && jeton.expire > Date.now() + 60000) return jeton.valeur;
  const r = await fetch(`${LOGIN}/${encodeURIComponent(c.tenant)}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: c.clientId,
      client_secret: c.secret,
      scope: 'https://graph.microsoft.com/.default',
      grant_type: 'client_credentials',
    }),
    signal: AbortSignal.timeout(15000),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) {
    const d = String(j.error_description || j.error || `HTTP ${r.status}`).split('\r\n')[0];
    throw new Error(`Connexion Microsoft 365 refusée : ${d}`);
  }
  jeton = { valeur: j.access_token, expire: Date.now() + Number(j.expires_in || 3600) * 1000 };
  return jeton.valeur;
}

async function messagesRecus(depuisIso, top = 10) {
  const c = config();
  if (!boiteConfiguree()) throw new Error('Boîte des codes non configurée (Paramètres ▸ Boîte des codes).');
  const q = new URLSearchParams({
    $filter: `receivedDateTime ge ${depuisIso}`,
    $orderby: 'receivedDateTime desc',
    $top: String(top),
    $select: 'subject,from,receivedDateTime,body',
  });
  const r = await fetch(`${GRAPH}/users/${encodeURIComponent(c.boite)}/messages?${q}`, {
    headers: { authorization: `Bearer ${await jetonGraph(c)}`, prefer: 'outlook.body-content-type="text"' },
    signal: AbortSignal.timeout(15000),
  });
  const j = await r.json().catch(() => ({}));
  if (r.status === 401 || r.status === 403)
    throw new Error(
      `Accès à la boîte ${c.boite} refusé (HTTP ${r.status}) : vérifie la permission Mail.Read (consentement administrateur) et la restriction à cette boîte.`,
    );
  if (!r.ok) throw new Error(`Lecture de la boîte ${c.boite} impossible : ${j.error?.message || `HTTP ${r.status}`}`);
  return Array.isArray(j.value) ? j.value : [];
}

/** Extrait le code d'un mail CARCDSF « Votre code de sécurité CARCDSF » (6 chiffres seuls sur leur ligne). */
export function extraireCodeCarcdsf(message) {
  const de = String(message?.from?.emailAddress?.address || '').toLowerCase();
  if (!de.endsWith('@carcdsf.fr') || !/code/i.test(message?.subject || '')) return null;
  const m = String(message?.body?.content || '').match(/(?:^|\n)\s*(\d{6})\s*(?:\r?\n|$)/);
  return m ? m[1] : null;
}

/** Codes CARCDSF recus depuis `depuisIso`, du plus recent au plus ancien. */
export async function codesCarcdsfDepuis(depuisIso) {
  return (await messagesRecus(depuisIso)).map(extraireCodeCarcdsf).filter(Boolean);
}

// Adresse du cabinet vers laquelle router le code de securite de l'espace particulier
// impots.gouv (alias de la boite des codes, ex. otp@tarncompta.fr). Reglage facultatif ;
// a defaut on utilise l'adresse de la boite elle-meme.
export function adresseCodesImpots() {
  return (getSetting('boite_codes_adresse_impots', '') || config().boite || '').trim().toLowerCase();
}
export function definirAdresseCodesImpots(adresse) {
  const a = String(adresse || '').trim();
  if (a && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(a)) throw new Error('Adresse e-mail invalide.');
  setSetting('boite_codes_adresse_impots', a);
  return adresseCodesImpots();
}

/** Extrait le code de securite d'un mail impots.gouv / DGFiP (6 chiffres isoles). */
export function extraireCodeImpots(message) {
  const de = String(message?.from?.emailAddress?.address || '').toLowerCase();
  const sujet = String(message?.subject || '');
  const dgfip = /impots\.gouv\.fr$|finances\.gouv\.fr$/.test(de.split('@')[1] || '');
  const parleDeCode = /code|s[eé]curit|authentif/i.test(sujet) || /impots\.gouv/i.test(`${de} ${sujet}`);
  if (!dgfip && !parleDeCode) return null;
  const m = String(message?.body?.content || '').match(/(?:^|[^\d])(\d{6})(?:[^\d]|$)/);
  return m ? m[1] : null;
}

/** Codes impots.gouv recus par le cabinet depuis `depuisIso` (lus dans la boite des codes). */
export async function codesImpotsDepuis(depuisIso) {
  return (await messagesRecus(depuisIso)).map(extraireCodeImpots).filter(Boolean);
}

/** Test (Paramètres) : jeton + lecture des derniers messages de la boite. */
export async function testerBoite() {
  const c = config();
  try {
    const depuis = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
    await messagesRecus(depuis, 1);
    return { ok: true, message: `Accès à ${c.boite} : OK — les codes CARCDSF seront lus automatiquement.` };
  } catch (e) {
    return { ok: false, message: e.message };
  }
}
