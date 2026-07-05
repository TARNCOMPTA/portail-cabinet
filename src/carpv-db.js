// Base CARPV (retraite des veterinaires) : connexion par client (login + mot de passe chiffre).
// Schema et fonctions mutualises dans creer-source-db.js. Fichier separe data/carpv.db.
import { creerSourceDb } from './creer-source-db.js';

export const {
  listClients,
  clientVerrouille,
  getClient,
  getClientCredentials,
  createClient,
  updateClient,
  deleteClient,
  getClientByLogin,
  importClients,
  addDocument,
  listDocuments,
  listAllDocuments,
  getDocument,
  addRun,
  listRuns,
} = creerSourceDb('carpv.db');
