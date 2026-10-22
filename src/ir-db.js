// Base IMPOT SUR LE REVENU (espace particulier impots.gouv.fr) : un compte par client,
// login = numero fiscal (13 chiffres) + mot de passe chiffre. Schema/fonctions mutualises
// dans creer-source-db.js. Fichier separe data/ir.db.
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
  stats,
} = creerSourceDb('ir.db');
