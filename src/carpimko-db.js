// Base CARPIMKO (kines, infirmiers, orthophonistes...) : connexion par client
// (numero de dossier + mot de passe chiffre). Schema/fonctions mutualises dans
// creer-source-db.js. Fichier separe data/carpimko.db.
import { creerSourceDb } from './creer-source-db.js';

export const {
  listClients, clientVerrouille, getClient, getClientCredentials, createClient, updateClient,
  deleteClient, getClientByLogin, importClients, addDocument, listDocuments, listAllDocuments, addRun, listRuns,
} = creerSourceDb('carpimko.db');
