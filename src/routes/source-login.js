// Routeur générique pour une "source par login/mot de passe" (CARPIMKO, CARMF, CARPV,
// CARCDSF). Toutes ces sources exposent les memes routes /api/<source>/* (clients CRUD,
// import, documents, runs, recuperation). On les mutualise ici : ajouter une caisse =
// une ligne dans server.js. L'etat de progression (partage entre toutes les sources)
// est fourni par server.js via `ctx`.
import express from 'express';
import { existsSync } from 'node:fs';
import { basename } from 'node:path';
import { filtrerReprise, REPRISE_HEURES, creerDisjoncteur, ECHECS_CONSECUTIFS_MAX } from '../reprise.js';

/**
 * @param {string} source  identifiant court (ex 'carmf') = prefixe d'URL et de verrou.
 * @param {{db:object, scraper:Function, tousDocuments?:boolean, ctx:object}} opts
 *   ctx = { enCours, progression, progLog, demarrerSuivi, terminerSuivi, doitArreter, resetArret }
 * @returns {{router:import('express').Router, lancerTous:(opts?:object)=>object}}
 */
export function creerRouteurSourceLogin(source, { db, scraper, tousDocuments = false, ctx }) {
  const r = express.Router();
  const { enCours, progression, progLog, demarrerSuivi, terminerSuivi } = ctx;
  const SRC = source.toUpperCase();
  const champId = source === 'carpimko' ? 'numéro de dossier' : 'identifiant';

  // ---- CRUD clients ----
  r.get('/clients', (req, res) => res.json(db.listClients()));
  r.post('/clients', (req, res) => {
    const { nom, login, password, notes, dossier, profession } = req.body || {};
    if (!nom || !login || !password) return res.status(400).json({ error: `Nom, ${champId} et mot de passe sont requis.` });
    if (db.getClientByLogin(login)) return res.status(409).json({ error: `Un client avec ce ${champId} existe déjà.` });
    res.status(201).json(db.createClient({ nom, login, password, notes, dossier, profession }));
  });
  r.post('/clients/import', (req, res) => {
    const clients = req.body?.clients;
    if (!Array.isArray(clients) || clients.length === 0) return res.status(400).json({ error: 'Aucune ligne à importer.' });
    if (clients.length > 5000) return res.status(400).json({ error: 'Trop de lignes (max 5000).' });
    res.json(db.importClients(clients));
  });
  r.put('/clients/:id', (req, res) => {
    const c = db.updateClient(Number(req.params.id), req.body || {});
    if (!c) return res.status(404).json({ error: 'Client introuvable.' });
    res.json(c);
  });
  r.delete('/clients/:id', (req, res) => {
    db.deleteClient(Number(req.params.id));
    res.json({ ok: true });
  });
  r.get('/clients/:id/documents', (req, res) => {
    if (!db.getClient(Number(req.params.id))) return res.status(404).json({ error: 'Client introuvable.' });
    res.json(db.listDocuments(Number(req.params.id)));
  });
  r.get('/documents', (req, res) => res.json(db.listAllDocuments()));
  r.get('/documents/:id/file', (req, res) => {
    const doc = db.getDocument(req.params.id);
    if (!doc || !existsSync(doc.fichier)) return res.status(404).json({ error: 'Fichier introuvable.' });
    res.download(doc.fichier, basename(doc.fichier));
  });
  r.get('/runs', (req, res) => res.json(db.listRuns(300)));

  // ---- Recuperation (un client) ----
  async function lancerUn(clientId, res, extra = {}) {
    const creds = db.getClientCredentials(clientId);
    if (!creds) return res?.status(404).json({ error: 'Client introuvable.' });
    const key = `${source}:${clientId}`;
    if (enCours.has(key)) return res?.status(409).json({ error: 'Une récupération est déjà en cours pour ce client.' });
    enCours.add(key);
    res?.json({ started: true, client: creds.nom });
    const suiviLocal = !progression.actif;
    if (suiviLocal) demarrerSuivi(1, source);
    progression.courant = creds.nom;
    try {
      const rr = await scraper(creds, { ...extra, onLog: progLog });
      if (suiviLocal)
        progression.resultats.push({
          nom: creds.nom,
          ok: !!rr?.ok,
          message: rr?.ok ? `${rr.docs?.length ?? 0} nouveau(x)${rr.dejaPresents ? ` + ${rr.dejaPresents} déjà présent(s)` : ''}` : rr?.error || 'erreur',
          nb_docs: rr?.docs?.length ?? 0,
        });
    } catch (e) {
      progLog(`ERREUR : ${e.message}`);
      if (suiviLocal) progression.resultats.push({ nom: creds.nom, ok: false, message: e.message, nb_docs: 0 });
    } finally {
      enCours.delete(key);
      if (suiviLocal) {
        progression.fait = 1;
        terminerSuivi();
      }
    }
  }

  // ---- Recuperation (tous les clients ; utilisee aussi par le planificateur) ----
  function lancerTous(extra = {}) {
    if (enCours.has(`${source}:all`)) return { started: false };
    const clients = db.listClients();
    const deverrouilles = clients.filter((c) => !c.verrouille);
    const ignores = clients.filter((c) => c.verrouille).map((c) => c.nom);
    const reprise = filtrerReprise(deverrouilles);
    const aTraiter = reprise.aFaire;
    enCours.add(`${source}:all`);
    ctx.resetArret();
    demarrerSuivi(aTraiter.length, source);
    if (ignores.length) progLog(`${ignores.length} client(s) verrouillé(s) ignoré(s) : ${ignores.join(', ')}`);
    if (reprise.ignores) progLog(`Reprise : ${reprise.ignores} client(s) ${SRC} déjà récupéré(s) il y a moins de ${REPRISE_HEURES} h, ignoré(s).`);
    // Disjoncteur : N echecs consecutifs = site de la caisse indisponible -> arret du lot
    // (la reprise repartira du premier client non recupere au prochain lancement).
    const disj = creerDisjoncteur();
    (async () => {
      try {
        for (const c of aTraiter) {
          if (ctx.doitArreter()) {
            progLog('Arrêt demandé.');
            break;
          }
          if (disj.declenche()) {
            progLog(
              `⚠ ${ECHECS_CONSECUTIFS_MAX} échecs consécutifs : le site ${SRC} semble indisponible — arrêt du lot. La prochaine récupération reprendra au premier client non récupéré.`,
            );
            break;
          }
          const key = `${source}:${c.id}`;
          if (enCours.has(key)) {
            progression.fait++;
            continue;
          }
          enCours.add(key);
          progression.courant = c.nom;
          try {
            const creds = db.getClientCredentials(c.id);
            if (creds) {
              const rr = await scraper(creds, { ...extra, onLog: progLog });
              disj.noter(!!rr?.ok);
              progression.resultats.push({
                nom: c.nom,
                ok: !!rr?.ok,
                message: rr?.ok ? `${rr.docs?.length ?? 0} nouveau(x)${rr.dejaPresents ? ` + ${rr.dejaPresents} déjà présent(s)` : ''}` : rr?.error || 'erreur',
                nb_docs: rr?.docs?.length ?? 0,
              });
            }
          } catch (e) {
            disj.noter(false);
            progLog(`[${c.nom}] ERREUR : ${e.message}`);
            progression.resultats.push({ nom: c.nom, ok: false, message: e.message, nb_docs: 0 });
          } finally {
            enCours.delete(key);
            progression.fait++;
          }
        }
      } finally {
        enCours.delete(`${source}:all`);
        terminerSuivi();
        progLog(`Récupération ${SRC} terminée.`);
      }
    })();
    return { started: true, total: aTraiter.length, ignores, deja: reprise.ignores };
  }

  r.post('/clients/:id/scrape', (req, res) => {
    const id = Number(req.params.id);
    const verrou = db.clientVerrouille(id);
    if (verrou.verrouille && !req.body?.force)
      return res.status(423).json({
        error: 'verrou_mdp',
        message: 'Compte verrouillé : la dernière connexion a échoué (mot de passe). Corrige-le ou force la tentative.',
        detail: verrou.message,
      });
    lancerUn(id, res, tousDocuments ? { tousDocuments: !!req.body?.tousDocuments } : {});
  });
  r.post('/scrape-all', (req, res) => {
    const resu = lancerTous(tousDocuments ? { tousDocuments: !!req.body?.tousDocuments } : {});
    if (!resu.started) return res.status(409).json({ error: `Une récupération ${SRC} globale est déjà en cours.` });
    res.json(resu);
  });

  return { router: r, lancerTous };
}
