// Vérification d'appartenance d'un PDF téléchargé au client attendu : le texte du
// document doit contenir un identifiant du client (SIRET/SIREN, n° d'adhérent) ou son
// nom. Sans correspondance, le fichier est mis en QUARANTAINE (déplacé dans
// downloads/_quarantaine/<source>/<client>/) et NE DOIT PAS être enregistré via
// addDocument — l'anti-doublon le fera retélécharger et revérifier au run suivant.
// Un PDF sans texte extractible (scan) est « non vérifiable » : conservé, simple
// avertissement. verifierEtClasser ne lève jamais : une erreur interne de validation
// ne doit pas faire échouer un téléchargement légitime.

import { readFileSync, mkdirSync, renameSync, copyFileSync, unlinkSync, existsSync } from 'node:fs';
import { resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const QUARANTAINE_DIR = resolve(__dirname, '..', 'downloads', '_quarantaine');

const SEP = '[\\s\\u00a0\\u202f.\\-]'; // séparateurs tolérés entre les chiffres d'un numéro imprimé

// Civilités, formes juridiques et mots-outils ignorés dans le matching par nom.
const STOPLIST = new Set([
  'm',
  'mr',
  'mme',
  'mlle',
  'dr',
  'docteur',
  'pr',
  'monsieur',
  'madame',
  'mademoiselle',
  'maitre',
  'cabinet',
  'selarl',
  'selas',
  'selasu',
  'selafa',
  'scm',
  'sci',
  'scp',
  'sarl',
  'eurl',
  'sas',
  'sasu',
  'sa',
  'snc',
  'ei',
  'eirl',
  'earl',
  'gaec',
  'sdf',
  'ste',
  'societe',
  'pharmacie',
  'de',
  'du',
  'des',
  'la',
  'le',
  'les',
  'et',
  'au',
  'aux',
  'sur',
  'sous',
  'chez',
  'en',
]);

function sanitize(name) {
  return String(name)
    .replace(/[^\w.\- ]+/g, '_')
    .replace(/\s+/g, '_')
    .trim()
    .slice(0, 120);
}

function echapperRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Extrait le texte des maxPages premières pages d'un PDF.
 *  Retourne null si le fichier est illisible (corrompu, chiffré, non-PDF),
 *  '' (ou presque) si le PDF ne contient pas de texte (scan). */
export async function extraireTextePdf(fichier, { maxPages = 8 } = {}) {
  let tache;
  try {
    const data = new Uint8Array(readFileSync(fichier));
    tache = getDocument({ data, isEvalSupported: false, useSystemFonts: true, verbosity: 0 });
    const doc = await tache.promise;
    const morceaux = [];
    const n = Math.min(doc.numPages, maxPages);
    for (let i = 1; i <= n; i++) {
      const page = await doc.getPage(i);
      const contenu = await page.getTextContent();
      morceaux.push(contenu.items.map((it) => it.str || '').join(' '));
    }
    return morceaux.join('\n');
  } catch {
    return null;
  } finally {
    if (tache) await tache.destroy().catch(() => {});
  }
}

/** Minuscules, accents retirés, espaces (y compris insécables) normalisés. */
export function normaliser(texte) {
  return String(texte || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/** Mode de paiement mentionné sur un avis CFE. Mentions constatées sur les avis :
 *  « PRÉLÈVEMENT À L'ÉCHÉANCE », « mensualisation »/« mensualisé », et
 *  « vous n'avez pas adhéré à un prélèvement automatique ». Un avis « sans
 *  prélèvement » INVITE souvent à adhérer aux deux options -> cette mention
 *  est prioritaire. Renvoie 'aucun' | 'mensualise' | 'echeance' | null. */
export function detecterPaiementCfe(texte) {
  const t = normaliser(texte);
  if (!t) return null;
  if (/pas adhere a un prelevement/.test(t)) return 'aucun';
  if (/mensualis/.test(t)) return 'mensualise';
  if (/prelevement[s]? a l.{0,2}echeance|preleve[e]? a l.{0,2}echeance/.test(t)) return 'echeance';
  return null;
}

/** Cherche une suite de chiffres dans le texte en tolérant des séparateurs entre les
 *  groupes (« 123 456 789 » matche '123456789'). Un SIREN matche aussi le début d'un
 *  SIRET imprimé. Refuse le raccord au milieu d'un nombre plus long à gauche. */
export function contientNumero(texte, numero) {
  const chiffres = String(numero || '').replace(/\D/g, '');
  if (chiffres.length < 4) return false;
  const motif = chiffres.split('').join(`${SEP}*`);
  return new RegExp(`(?<!\\d)(?<!\\d${SEP})${motif}`).test(String(texte || ''));
}

/** Matching par tokens du nom : tokens significatifs (≥ 3 lettres, hors civilités et
 *  formes juridiques), frontières de mot (MARTIN ne matche pas MARTINIQUE). OK si le
 *  token le plus long est présent ET au moins la moitié des tokens le sont —
 *  tolère prénom absent, ordre inversé, civilité. */
export function correspondanceNom(texte, nom) {
  const t = normaliser(texte);
  const tokens = normaliser(nom)
    .split(/[^a-z0-9]+/)
    .filter((tok) => tok.length >= 3 && !STOPLIST.has(tok));
  if (!tokens.length) return false;
  const present = (tok) => new RegExp(`(?<![a-z0-9])${echapperRegex(tok)}(?![a-z0-9])`).test(t);
  const plusLong = tokens.reduce((a, b) => (b.length > a.length ? b : a));
  if (!present(plusLong)) return false;
  const nbPresents = tokens.filter(present).length;
  return nbPresents >= Math.ceil(tokens.length / 2);
}

/** Identifiants attendus dans le PDF selon la source et la fiche client.
 *  impots  : la colonne siret contient le SIREN (9 chiffres).
 *  urssaf  : SIRET 14 chiffres ou SIREN selon la synchro.
 *  caisses : le login est le n° d'adhérent / de dossier. */
export function attendusPour(source, client) {
  const chiffres = String(client.siret || '').replace(/\D/g, '');
  const nom = client.nom || '';
  if (source === 'impots') return { siren: chiffres.slice(0, 9), nom };
  if (source === 'urssaf') return { siret: chiffres.length === 14 ? chiffres : '', siren: chiffres.length >= 9 ? chiffres.slice(0, 9) : '', nom };
  return { adherent: String(client.login || '').trim(), nom };
}

/** Verdict pur (testable sans fichier) : essaie siret > siren > adhérent > nom. */
export function verifierCorrespondance(texte, attendus) {
  const t = normaliser(texte);
  if (attendus.siret && contientNumero(t, attendus.siret)) return { ok: true, motif: 'siret' };
  if (attendus.siren && attendus.siren.length === 9 && contientNumero(t, attendus.siren)) return { ok: true, motif: 'siren' };
  const adh = attendus.adherent || '';
  if (adh.length >= 4) {
    const trouve = /^\d+$/.test(adh.replace(/\s/g, ''))
      ? contientNumero(t, adh)
      : new RegExp(`(?<![a-z0-9])${echapperRegex(normaliser(adh))}(?![a-z0-9])`).test(t);
    if (trouve) return { ok: true, motif: 'adherent' };
  }
  if (attendus.nom && correspondanceNom(t, attendus.nom)) return { ok: true, motif: 'nom' };
  return { ok: false, motif: null };
}

// Déplace le fichier vers la quarantaine (suffixe (2), (3)... si collision).
// renameSync d'abord ; repli copie+suppression si volumes différents (EXDEV).
function mettreEnQuarantaine(fichier, dossier) {
  mkdirSync(dossier, { recursive: true });
  const nom = basename(fichier);
  const ext = (nom.match(/\.[a-z0-9]+$/i) || [''])[0];
  const base = ext ? nom.slice(0, -ext.length) : nom;
  let dest = resolve(dossier, nom);
  let i = 2;
  while (existsSync(dest) && i < 100) dest = resolve(dossier, `${base} (${i++})${ext}`);
  try {
    renameSync(fichier, dest);
  } catch (e) {
    if (e.code !== 'EXDEV') throw e;
    copyFileSync(fichier, dest);
    unlinkSync(fichier);
  }
  return dest;
}

function libelleAttendus(attendus) {
  return [
    attendus.siret && `SIRET ${attendus.siret}`,
    !attendus.siret && attendus.siren && `SIREN ${attendus.siren}`,
    attendus.adherent && `n° ${attendus.adherent}`,
    attendus.nom && `nom « ${attendus.nom} »`,
  ]
    .filter(Boolean)
    .join(', ');
}

/**
 * Point d'entrée unique des scrapers, à appeler APRÈS l'écriture disque et AVANT
 * addDocument. Ne lève jamais.
 * @param {object} p
 * @param {string} p.fichier chemin du PDF fraîchement téléchargé
 * @param {'impots'|'urssaf'|'carpimko'|'carmf'|'carcdsf'|'carpv'} p.source
 * @param {{id:number, nom:string, siret?:string, login?:string}} p.client
 * @param {object} [p.attendus] identifiants à chercher (défaut : attendusPour(source, client))
 * @param {string} [p.dossierQuarantaine] racine de quarantaine (tests)
 * @returns {Promise<{verdict:'ok'|'quarantaine'|'non_verifiable', raison:string|null, fichier:string}>}
 *   verdict 'ok'             : enregistrer le document normalement ;
 *   verdict 'non_verifiable' : enregistrer, mais compter l'avertissement ;
 *   verdict 'quarantaine'    : fichier DÉPLACÉ — ne pas appeler addDocument.
 */
export async function verifierEtClasser({ fichier, source, client, attendus, dossierQuarantaine }) {
  const nomFichier = basename(fichier);
  try {
    const cherche = attendus || attendusPour(source, client);
    const texte = await extraireTextePdf(fichier);
    if (texte == null || normaliser(texte).replace(/\s/g, '').length < 20)
      return { verdict: 'non_verifiable', raison: `"${nomFichier}" : texte non extractible (scan ?)`, fichier };
    const res = verifierCorrespondance(texte, cherche);
    if (res.ok) return { verdict: 'ok', raison: res.motif, fichier };
    const dossier = resolve(dossierQuarantaine || QUARANTAINE_DIR, source, sanitize(`${client.id}_${client.nom}`));
    const dest = mettreEnQuarantaine(fichier, dossier);
    return {
      verdict: 'quarantaine',
      raison: `${libelleAttendus(cherche)} introuvable(s) dans "${nomFichier}" — fichier déplacé en quarantaine`,
      fichier: dest,
    };
  } catch (e) {
    // La validation ne doit jamais bloquer une récupération légitime.
    return { verdict: 'non_verifiable', raison: `"${nomFichier}" : validation impossible (${e.message})`, fichier };
  }
}
