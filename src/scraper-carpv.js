// Connecteur CARPV (retraite des vétérinaires) — plateforme liberal_web.
// Moteur commun dans scraper-liberal-web.js. Une seule profession (base index 0).
import { addDocument, addRun, listDocuments } from './carpv-db.js';
import { creerScraperLiberalWeb } from './scraper-liberal-web.js';

export const scrapeClient = creerScraperLiberalWeb({
  nom: 'CARPV',
  sousDossier: 'carpv',
  host: process.env.CARPV_BASE_URL || 'https://adherents.carpv.fr',
  picristoken: process.env.CARPV_PICRISTOKEN || 'jkhkjhkjhkjhk',
  baseIndex: 0,
  addDocument,
  addRun,
  listDocuments,
});
