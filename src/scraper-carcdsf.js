// Connecteur CARCDSF (chirurgiens-dentistes & sages-femmes) — plateforme liberal_web.
// Moteur commun dans scraper-liberal-web.js. Base index selon la profession :
// chirurgien-dentiste = 0 (carcdsf-cd), sage-femme = 1 (carcdsf-sf).
// Les clients geres par le compte TIERS DELEGATAIRE (login « tiers:<dossier> », voir
// carcdsf-tiers.js) passent par la session tiers au lieu d'une connexion individuelle.
import { addDocument, addRun, listDocuments } from './carcdsf-db.js';
import { creerScraperLiberalWeb } from './scraper-liberal-web.js';

export const scrapeClientDirect = creerScraperLiberalWeb({
  nom: 'CARCDSF',
  sousDossier: 'carcdsf',
  host: process.env.CARCDSF_BASE_URL || 'https://adherents.carcdsf.fr',
  picristoken: process.env.CARCDSF_PICRISTOKEN || 'jkhkjhkjhkjhk',
  baseIndex: (client) => (client.profession === 'sf' ? 1 : 0),
  addDocument,
  addRun,
  listDocuments,
});

export async function scrapeClient(client, opts = {}) {
  if (!opts.session && String(client.login || '').startsWith('tiers:')) {
    // Import dynamique : carcdsf-tiers.js importe deja ce module (scrapeClientDirect).
    const { scrapeUnClientTiers } = await import('./carcdsf-tiers.js');
    return scrapeUnClientTiers(scrapeClientDirect, client, opts);
  }
  return scrapeClientDirect(client, opts);
}
