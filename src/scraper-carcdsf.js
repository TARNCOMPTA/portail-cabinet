// Connecteur CARCDSF (chirurgiens-dentistes & sages-femmes) — plateforme liberal_web.
// Moteur commun dans scraper-liberal-web.js. Base index selon la profession :
// chirurgien-dentiste = 0 (carcdsf-cd), sage-femme = 1 (carcdsf-sf).
import { addDocument, addRun, listDocuments } from './carcdsf-db.js';
import { creerScraperLiberalWeb } from './scraper-liberal-web.js';

export const scrapeClient = creerScraperLiberalWeb({
  nom: 'CARCDSF',
  sousDossier: 'carcdsf',
  host: process.env.CARCDSF_BASE_URL || 'https://adherents.carcdsf.fr',
  picristoken: process.env.CARCDSF_PICRISTOKEN || 'jkhkjhkjhkjhk',
  baseIndex: (client) => (client.profession === 'sf' ? 1 : 0),
  addDocument,
  addRun,
  listDocuments,
});
