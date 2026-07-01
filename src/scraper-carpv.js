// Connecteur CARPV (Caisse Autonome de Retraite et de Prévoyance des Vétérinaires).
// Meme plateforme « liberal_web » que la CARCDSF -> rejeu direct de l'API HTTP
// (headless, planifiable). Validé en réel (login sans 2FA, attestations + courriers).
//
// Parcours :
//  1. POST .../InternetWebServicesNonConnectes/0/internaute/connexion/V1
//       en-tete picristoken (constante client) + corps JSON {pseudo,pwd,da,description}
//       -> en-tete `authorization: Bearer …` + signaletiqueAccueil{matricule,nature}
//  2. dossier = matricule*100 + nature
//  3. attestations : GET .../dossier/courrier/V1/{dossier}/1 -> items {libelle,noCourrier}
//       PDF via POST .../dossier/courrier/generer/V1/{dossier}/1/{noCourrier}
//  4. courriers (cotisations, administratifs) : GET .../dossier/courrier/liste/V1/{dossier}/1
//       -> liste par categorie [{date,libelleCourrier,identifiantCourrier}]
//       PDF via GET .../dossier/courrier/telecharge/V1/{dossier}/1/{identifiantCourrier}
//     Reponse PDF = { courrier: { courrier: <base64>, nom } }.

import { mkdirSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { addDocument, addRun } from './carpv-db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DOWNLOADS_DIR = resolve(__dirname, '..', 'downloads', 'carpv');
const BASE = process.env.CARPV_BASE_URL || 'https://adherents.carpv.fr';
const PICRIS = process.env.CARPV_PICRISTOKEN || 'jkhkjhkjhkjhk';
const API = `${BASE}/InternetWebServices/0`;
const APINC = `${BASE}/InternetWebServicesNonConnectes/0`;

function sanitize(name) { return String(name).replace(/[^\w.\- ]+/g, '_').replace(/\s+/g, '_').trim().slice(0, 120); }
function addRunSafe(clientId, run) { try { addRun(clientId, run); } catch (e) { console.warn(`(historique CARPV ${clientId}: ${e.message})`); } }

/**
 * Recupere les documents CARPV d'un client (espace adherent, API HTTP).
 * @param {{id:number, nom:string, login:string, password:string, dossier?:string}} client
 * @param {{onLog?:(m:string)=>void, baseFolder?:string}} [opts]
 */
export async function scrapeClient(client, opts = {}) {
  const log = (m) => { const line = `[${client.nom}] ${m}`; console.log(line); opts.onLog?.(line); };
  const timeout = Number(process.env.NAV_TIMEOUT ?? 45000);

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
    log('Connexion CARPV');
    const corps = JSON.stringify({ pseudo: client.login, pwd: client.password, da: '', description: 'portail-cabinet' });
    const rc = await fetch(`${APINC}/internaute/connexion/V1`, {
      method: 'POST', headers: { 'content-type': 'application/json', picristoken: PICRIS }, body: corps, signal: AbortSignal.timeout(timeout),
    });
    const jc = await rc.json().catch(() => ({}));
    const authorization = rc.headers.get('authorization');
    if (!rc.ok || jc.codeRetour !== 0 || !authorization) {
      const msg = (jc.libelle || '').trim();
      const e = new Error('Connexion refusée' + (msg ? ` : ${msg}` : ' (identifiants incorrects ou double authentification requise ?)'));
      e.kind = 'mdp';
      throw e;
    }
    const sig = jc.signaletiqueAccueil || {};
    if (!sig.matricule) throw new Error('Numéro de dossier introuvable dans la réponse de connexion.');
    const dossier = Number(sig.matricule) * 100 + Number(sig.nature || 0);
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
    const recupCourrier = async (url) => {
      const r = await fetch(url, { method: url.includes('/generer/') ? 'POST' : 'GET', headers: H, signal: AbortSignal.timeout(timeout) });
      if (!r.ok) return null;
      const j = await r.json().catch(() => ({}));
      return j.courrier && j.courrier.courrier ? j.courrier : null;
    };

    // ---- 2. Attestations (generées) ----
    try {
      const ja = await (await fetch(`${API}/dossier/courrier/V1/${dossier}/1`, { headers: H, signal: AbortSignal.timeout(timeout) })).json().catch(() => ({}));
      const items = ja.liste && typeof ja.liste === 'object' ? Object.values(ja.liste) : [];
      log(`${items.length} attestation(s) trouvée(s).`);
      for (const it of items) {
        if (!it || it.noCourrier == null) continue;
        const annee = (String(it.libelle || '').match(/\b(20\d{2})\b/) || [])[1] || null;
        try {
          const c = await recupCourrier(`${API}/dossier/courrier/generer/V1/${dossier}/1/${it.noCourrier}`);
          if (c) enregistrer(it.libelle || `Attestation ${it.noCourrier}`, c.nom, c.courrier, annee);
          else log(`(${it.libelle || it.noCourrier} : indisponible)`);
        } catch (e) { log(`Échec ${it.libelle || it.noCourrier} : ${e.message.split('\n')[0]}`); }
      }
    } catch (e) { log(`Attestations : ${e.message.split('\n')[0]}`); }

    // ---- 3. Courriers enregistrés (cotisations, administratifs) ----
    try {
      const jl = await (await fetch(`${API}/dossier/courrier/liste/V1/${dossier}/1`, { headers: H, signal: AbortSignal.timeout(timeout) })).json().catch(() => ({}));
      const groupes = jl.liste && typeof jl.liste === 'object' ? jl.liste : {};
      let nb = 0, ok = 0;
      for (const [categorie, liste] of Object.entries(groupes)) {
        for (const it of (Array.isArray(liste) ? liste : [])) {
          if (!it || it.identifiantCourrier == null) continue;
          nb++;
          try {
            const c = await recupCourrier(`${API}/dossier/courrier/telecharge/V1/${dossier}/1/${it.identifiantCourrier}`);
            if (c) { const annee = String(it.date || '').slice(0, 4) || null; enregistrer((it.libelleCourrier || categorie || 'Courrier').trim(), c.nom, c.courrier, annee); ok++; }
            else log(`(${it.libelleCourrier || it.identifiantCourrier} : indisponible)`);
          } catch (e) { log(`Échec ${it.libelleCourrier || it.identifiantCourrier} : ${e.message.split('\n')[0]}`); }
        }
      }
      if (nb) log(`Courriers : ${ok}/${nb} récupéré(s).`);
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
