// Moteur commun aux caisses sur la plateforme « liberal_web » (CARPV, CARCDSF, ...).
// Rejeu HTTP de l'API : login (picristoken + JSON) -> jeton Bearer -> attestations
// (POST generer) + courriers (GET telecharge). Headless, planifiable. Sans 2FA sur
// les comptes standard. Chaque caisse fournit son host + son base index (profession).
import { mkdirSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifierEtClasser } from './validation-pdf.js';
import { sanitize } from './scraper-commun.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const libProfession = (p) => (p === 'sf' ? 'sage-femme' : p === 'cd' ? 'chirurgien-dentiste' : '');

/**
 * @param {{nom:string, host:string, sousDossier:string, picristoken:string,
 *          baseIndex:number|((client:any)=>number), addDocument:Function, addRun:Function,
 *          listDocuments?:Function}} cfg
 * @returns {(client:any, opts?:any)=>Promise<any>} scrapeClient
 */
export function creerScraperLiberalWeb(cfg) {
  const { nom, host, sousDossier, picristoken, baseIndex, addDocument, addRun, listDocuments } = cfg;
  const DOWNLOADS_DIR = resolve(__dirname, '..', 'downloads', sousDossier);
  const addRunSafe = (clientId, run) => {
    try {
      addRun(clientId, run);
    } catch (e) {
      console.warn(`(historique ${nom} ${clientId}: ${e.message})`);
    }
  };

  return async function scrapeClient(client, opts = {}) {
    const log = (m) => {
      const line = `[${client.nom}] ${m}`;
      console.log(line);
      opts.onLog?.(line);
    };
    const timeout = Number(process.env.NAV_TIMEOUT ?? 45000);
    const b = typeof baseIndex === 'function' ? baseIndex(client) : baseIndex;
    const API = `${host}/InternetWebServices/${b}`;
    const APINC = `${host}/InternetWebServicesNonConnectes/${b}`;

    let clientDir;
    if (client.dossier && client.dossier.trim()) clientDir = client.dossier.trim();
    else if (opts.baseFolder && opts.baseFolder.trim()) clientDir = resolve(opts.baseFolder.trim(), sanitize(client.nom));
    else clientDir = resolve(DOWNLOADS_DIR, sanitize(`${client.id}_${client.nom}`));
    mkdirSync(clientDir, { recursive: true });

    const docs = [];
    let dejaPresents = 0;
    const quarantaines = [];
    let nonVerifiables = 0;
    try {
      if (!client.password) {
        const e = new Error('Mot de passe vide pour ce client — re-saisis-le.');
        e.kind = 'mdp';
        throw e;
      }

      // ---- 1. Connexion ----
      const pro = libProfession(client.profession);
      log(`Connexion ${nom}${pro ? ` (${pro})` : ''}`);
      const corps = JSON.stringify({ pseudo: client.login, pwd: client.password, da: '', description: 'portail-cabinet' });
      const rc = await fetch(`${APINC}/internaute/connexion/V1`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', picristoken },
        body: corps,
        signal: AbortSignal.timeout(timeout),
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
      const H = { picristoken, authorization, 'content-type': 'application/json' };

      // Dedup EN BASE (libelle + annee) : certaines caisses regenerent un courrier a
      // chaque visite (ex. CARPV « INT - Echeancier de prelevements » date du jour) —
      // un exemplaire deja en base pour la meme annee suffit, on ne le reprend pas.
      const dejaEnBase = new Set();
      if (listDocuments) for (const doc of listDocuments(client.id)) dejaEnBase.add(`${doc.date_doc || ''}|${doc.libelle || ''}`);

      const enregistrer = async (libelle, nomFichier, b64, annee) => {
        if (dejaEnBase.has(`${annee || ''}|${libelle}`)) {
          dejaPresents++;
          return;
        }
        const buf = Buffer.from(b64, 'base64');
        if (buf.length < 100 || buf.subarray(0, 4).toString() !== '%PDF') {
          log(`(${libelle} : réponse non-PDF, ignoré)`);
          return;
        }
        const nomF = sanitize(nomFichier || `${libelle}.pdf`).replace(/\.pdf$/i, '') + '.pdf';
        const dest = resolve(clientDir, `${annee ? annee + '_' : ''}${nomF}`);
        if (existsSync(dest) && statSync(dest).size > 100) {
          addDocument(client.id, { libelle, fichier: dest, date_doc: annee });
          dejaPresents++;
          return;
        }
        writeFileSync(dest, buf);
        // Vérification d'appartenance : le PDF doit mentionner le n° d'adhérent ou le nom.
        const verif = await verifierEtClasser({ fichier: dest, source: sousDossier, client });
        if (verif.verdict === 'quarantaine') {
          quarantaines.push(verif.raison);
          log(`⚠️ QUARANTAINE : ${verif.raison}`);
          return; // pas d'addDocument -> retéléchargé et revérifié au prochain run
        }
        if (verif.verdict === 'non_verifiable') nonVerifiables++;
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
        const ja = await (
          await fetch(`${API}/dossier/courrier/V1/${dossier}/1`, { headers: H, signal: AbortSignal.timeout(timeout) })
        )
          .json()
          .catch(() => ({}));
        const items = ja.liste && typeof ja.liste === 'object' ? Object.values(ja.liste) : [];
        log(`${items.length} attestation(s) trouvée(s).`);
        for (const it of items) {
          if (!it || it.noCourrier == null) continue;
          const annee = (String(it.libelle || '').match(/\b(20\d{2})\b/) || [])[1] || null;
          try {
            const c = await recupCourrier(`${API}/dossier/courrier/generer/V1/${dossier}/1/${it.noCourrier}`);
            if (c) await enregistrer(it.libelle || `Attestation ${it.noCourrier}`, c.nom, c.courrier, annee);
            else log(`(${it.libelle || it.noCourrier} : indisponible)`);
          } catch (e) {
            log(`Échec ${it.libelle || it.noCourrier} : ${e.message.split('\n')[0]}`);
          }
        }
      } catch (e) {
        log(`Attestations : ${e.message.split('\n')[0]}`);
      }

      // ---- 3. Courriers enregistrés (cotisations, administratifs) ----
      try {
        const jl = await (
          await fetch(`${API}/dossier/courrier/liste/V1/${dossier}/1`, { headers: H, signal: AbortSignal.timeout(timeout) })
        )
          .json()
          .catch(() => ({}));
        const groupes = jl.liste && typeof jl.liste === 'object' ? jl.liste : {};
        let nb = 0,
          ok = 0;
        for (const [categorie, liste] of Object.entries(groupes)) {
          for (const it of Array.isArray(liste) ? liste : []) {
            if (!it || it.identifiantCourrier == null) continue;
            nb++;
            try {
              const c = await recupCourrier(`${API}/dossier/courrier/telecharge/V1/${dossier}/1/${it.identifiantCourrier}`);
              if (c) {
                const annee = String(it.date || '').slice(0, 4) || null;
                await enregistrer((it.libelleCourrier || categorie || 'Courrier').trim(), c.nom, c.courrier, annee);
                ok++;
              } else log(`(${it.libelleCourrier || it.identifiantCourrier} : indisponible)`);
            } catch (e) {
              log(`Échec ${it.libelleCourrier || it.identifiantCourrier} : ${e.message.split('\n')[0]}`);
            }
          }
        }
        if (nb) log(`Courriers : ${ok}/${nb} récupéré(s).`);
      } catch (e) {
        log(`Courriers : ${e.message.split('\n')[0]}`);
      }

      let message = `${docs.length} document(s) récupéré(s)` + (dejaPresents ? `, ${dejaPresents} déjà présent(s)` : '');
      if (nonVerifiables > 0) message += ` (${nonVerifiables} non vérifiable(s) : PDF sans texte)`;
      if (quarantaines.length > 0) message = `⚠️ ${quarantaines.length} PDF mis en quarantaine — ${quarantaines.join(' ; ').slice(0, 300)}. ${message}`;
      addRunSafe(client.id, {
        statut: quarantaines.length > 0 ? 'echec' : docs.length + dejaPresents > 0 ? 'succes' : 'echec',
        message,
        nb_docs: docs.length,
      });
      log(`Terminé : ${docs.length} nouveau(x), ${dejaPresents} déjà présent(s).`);
      return { ok: true, docs, dejaPresents };
    } catch (err) {
      addRunSafe(client.id, { statut: err.kind === 'mdp' ? 'echec_mdp' : 'echec', message: err.message, nb_docs: docs.length });
      log(`ERREUR : ${err.message}`);
      return { ok: false, error: err.message, docs };
    }
  };
}
