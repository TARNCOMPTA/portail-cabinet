// Connecteur CARCDSF (Caisse Autonome de Retraite des Chirurgiens-Dentistes et
// Sages-Femmes). L'espace adherent est une appli Flutter Web : l'automatisation DOM
// est impossible. On REJOUE donc directement l'API HTTP (reverse-engineered), ce qui
// rend le connecteur headless, rapide et planifiable.
//
// Parcours (validé, sans 2FA sur les comptes standard) :
//  1. POST .../InternetWebServicesNonConnectes/{b}/internaute/connexion/V1
//       en-tete picristoken = jeton client constant ; corps JSON {pseudo,pwd,da,description}
//       -> reponse : en-tete `authorization: Bearer …` + signaletiqueAccueil{matricule,nature}
//  2. dossier = matricule*100 + nature
//  3. Appels connectes : en-tetes picristoken (constante) + authorization (Bearer) + content-type
//  4. Attestations annuelles : GET .../dossier/courrier/V1/{dossier}/1 -> liste{0,1,…}
//       chaque item {libelle, noCourrier} ; PDF via POST .../dossier/courrier/generer/V1/{dossier}/1/{noCourrier}
//       -> reponse.courrier = { courrier: <PDF base64>, nom }
//  b (base) = 0 pour chirurgien-dentiste, 1 pour sage-femme (espaces carcdsf-cd / carcdsf-sf).

import { mkdirSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { addDocument, addRun } from './carcdsf-db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DOWNLOADS_DIR = resolve(__dirname, '..', 'downloads', 'carcdsf');
const BASE = process.env.CARCDSF_BASE_URL || 'https://adherents.carcdsf.fr';
// Jeton client (non lie a l'utilisateur) exige par l'API non-connectee.
const PICRIS = process.env.CARCDSF_PICRISTOKEN || 'jkhkjhkjhkjhk';

function sanitize(name) { return String(name).replace(/[^\w.\- ]+/g, '_').replace(/\s+/g, '_').trim().slice(0, 120); }
function addRunSafe(clientId, run) { try { addRun(clientId, run); } catch (e) { console.warn(`(historique CARCDSF ${clientId}: ${e.message})`); } }
const baseIndex = (profession) => (profession === 'sf' ? 1 : 0);

/**
 * Recupere les documents CARCDSF d'un client (espace adherent, API HTTP).
 * @param {{id:number, nom:string, profession:'cd'|'sf', login:string, password:string, dossier?:string}} client
 * @param {{onLog?:(m:string)=>void, baseFolder?:string}} [opts]
 */
export async function scrapeClient(client, opts = {}) {
  const log = (m) => { const line = `[${client.nom}] ${m}`; console.log(line); opts.onLog?.(line); };
  const timeout = Number(process.env.NAV_TIMEOUT ?? 45000);
  const b = baseIndex(client.profession);
  const API = `${BASE}/InternetWebServices/${b}`;
  const APINC = `${BASE}/InternetWebServicesNonConnectes/${b}`;

  let clientDir;
  if (client.dossier && client.dossier.trim()) clientDir = client.dossier.trim();
  else if (opts.baseFolder && opts.baseFolder.trim()) clientDir = resolve(opts.baseFolder.trim(), sanitize(client.nom));
  else clientDir = resolve(DOWNLOADS_DIR, sanitize(`${client.id}_${client.nom}`));
  mkdirSync(clientDir, { recursive: true });

  const docs = [];
  let dejaPresents = 0;
  try {
    if (!client.password) { const e = new Error('Mot de passe vide pour ce client — re-saisis-le.'); e.kind = 'mdp'; throw e; }

    // ---- 1. Connexion ----
    log(`Connexion CARCDSF (${client.profession === 'sf' ? 'sage-femme' : 'chirurgien-dentiste'})`);
    const corps = JSON.stringify({ pseudo: client.login, pwd: client.password, da: '', description: 'portail-cabinet' });
    const rc = await fetch(`${APINC}/internaute/connexion/V1`, {
      method: 'POST', headers: { 'content-type': 'application/json', picristoken: PICRIS }, body: corps,
      signal: AbortSignal.timeout(timeout),
    });
    const jc = await rc.json().catch(() => ({}));
    const authorization = rc.headers.get('authorization');
    if (!rc.ok || jc.codeRetour !== 0 || !authorization) {
      const msg = (jc.libelle || '').trim();
      // Une 2FA ou de mauvais identifiants empechent l'obtention du jeton.
      const e = new Error('Connexion refusée' + (msg ? ` : ${msg}` : ' (identifiants incorrects ou double authentification requise ?)'));
      e.kind = 'mdp';
      throw e;
    }
    const sig = jc.signaletiqueAccueil || {};
    const dossier = Number(sig.matricule) * 100 + Number(sig.nature || 0);
    if (!sig.matricule) throw new Error('Numéro de dossier introuvable dans la réponse de connexion.');
    log('Connecté. Récupération des documents.');
    const H = { picristoken: PICRIS, authorization, 'content-type': 'application/json' };

    const enregistrer = (libelle, nomFichier, b64, annee) => {
      const buf = Buffer.from(b64, 'base64');
      if (buf.length < 100 || buf.subarray(0, 4).toString() !== '%PDF') { log(`(${libelle} : réponse non-PDF, ignoré)`); return; }
      const nom = sanitize(nomFichier || `${libelle}.pdf`).replace(/\.pdf$/i, '') + '.pdf';
      const dest = resolve(clientDir, `${annee ? annee + '_' : ''}${nom}`);
      if (existsSync(dest) && statSync(dest).size > 100) { addDocument(client.id, { libelle, fichier: dest, date_doc: annee }); dejaPresents++; return; }
      writeFileSync(dest, buf);
      addDocument(client.id, { libelle, fichier: dest, date_doc: annee });
      docs.push({ libelle, fichier: dest });
      log(`OK : ${dest.split(/[\\/]/).pop()} (${Math.round(buf.length / 1024)} Ko)`);
    };
    const generer = async (noCourrier) => {
      const r = await fetch(`${API}/dossier/courrier/generer/V1/${dossier}/1/${noCourrier}`, { method: 'POST', headers: H, signal: AbortSignal.timeout(timeout) });
      if (!r.ok) return null;
      const j = await r.json().catch(() => ({}));
      return j.courrier && j.courrier.courrier ? j.courrier : null;
    };

    // ---- 2. Attestations annuelles (Loi Madelin, fiscale, …) ----
    try {
      const ra = await fetch(`${API}/dossier/courrier/V1/${dossier}/1`, { headers: H, signal: AbortSignal.timeout(timeout) });
      const ja = await ra.json().catch(() => ({}));
      const items = ja.liste && typeof ja.liste === 'object' ? Object.values(ja.liste) : [];
      log(`${items.length} attestation(s) annuelle(s) trouvée(s).`);
      for (const it of items) {
        if (!it || it.noCourrier == null) continue;
        const annee = (String(it.libelle || '').match(/\b(20\d{2})\b/) || [])[1] || null;
        try {
          const c = await generer(it.noCourrier);
          if (c) enregistrer(it.libelle || `Attestation ${it.noCourrier}`, c.nom, c.courrier, annee);
          else log(`(${it.libelle || it.noCourrier} : indisponible)`);
        } catch (e) { log(`Échec ${it.libelle || it.noCourrier} : ${e.message.split('\n')[0]}`); }
      }
    } catch (e) { log(`Attestations : ${e.message.split('\n')[0]}`); }

    // ---- 3. Appels de cotisations & courriers (best-effort) ----
    // La liste est accessible ; le telechargement PDF de ces courriers utilise un
    // mecanisme distinct non encore identifie (generer renvoie 404 sur identifiantCourrier).
    // On tente quand meme, et on ignore proprement si indisponible.
    try {
      const rl = await fetch(`${API}/dossier/courrier/liste/V1/${dossier}/1`, { headers: H, signal: AbortSignal.timeout(timeout) });
      const jl = await rl.json().catch(() => ({}));
      const groupes = jl.liste && typeof jl.liste === 'object' ? jl.liste : {};
      let nb = 0, ok = 0;
      for (const [categorie, liste] of Object.entries(groupes)) {
        for (const it of (Array.isArray(liste) ? liste : [])) {
          nb++;
          const c = await generer(it.identifiantCourrier).catch(() => null);
          if (c && c.courrier) {
            const annee = String(it.date || '').slice(0, 4) || null;
            enregistrer(`${categorie} — ${it.libelleCourrier || ''}`.trim(), c.nom, c.courrier, annee);
            ok++;
          }
        }
      }
      if (nb) log(`Courriers (cotisations…) : ${ok}/${nb} téléchargé(s)${ok < nb ? ' (les autres non disponibles via l\'API pour l\'instant)' : ''}.`);
    } catch (e) { log(`Courriers : ${e.message.split('\n')[0]}`); }

    addRunSafe(client.id, { statut: docs.length + dejaPresents > 0 ? 'succes' : 'echec', message: `${docs.length} document(s) récupéré(s)` + (dejaPresents ? `, ${dejaPresents} déjà présent(s)` : ''), nb_docs: docs.length });
    log(`Terminé : ${docs.length} nouveau(x), ${dejaPresents} déjà présent(s).`);
    return { ok: true, docs, dejaPresents };
  } catch (err) {
    addRunSafe(client.id, { statut: err.kind === 'mdp' ? 'echec_mdp' : 'echec', message: err.message, nb_docs: docs.length });
    log(`ERREUR : ${err.message}`);
    return { ok: false, error: err.message, docs };
  }
}
