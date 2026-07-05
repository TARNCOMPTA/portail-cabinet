// Base CARCDSF (chirurgiens-dentistes & sages-femmes) : connexion par client
// (identifiant + mot de passe chiffre) + colonne "profession" (cd/sf). Schema/fonctions
// mutualises dans creer-source-db.js. Fichier separe data/carcdsf.db.
import { creerSourceDb, PROFESSIONS } from './creer-source-db.js';

export { PROFESSIONS };
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
} = creerSourceDb('carcdsf.db', { profession: true });
