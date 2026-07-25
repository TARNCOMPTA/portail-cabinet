// Vérification d'appartenance d'un PDF téléchargé au client attendu : le texte du
// document doit contenir un identifiant du client (SIRET/SIREN, n° d'adhérent) ou son
// nom. Sans correspondance, le fichier est mis en QUARANTAINE (déplacé dans
// downloads/_quarantaine/<source>/<client>/) et NE DOIT PAS être enregistré via
// addDocument — l'anti-doublon le fera retélécharger et revérifier au run suivant.
// Un PDF sans texte extractible (scan) est « non vérifiable » : conservé, simple
// avertissement. verifierEtClasser ne lève jamais : une erreur interne de validation
// ne doit pas faire échouer un téléchargement légitime.

import { readFileSync, writeFileSync, mkdirSync, renameSync, copyFileSync, unlinkSync, existsSync } from 'node:fs';
import { resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { sanitize } from './scraper-commun.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const QUARANTAINE_DIR = resolve(__dirname, '..', 'downloads', '_quarantaine');

const SEP = '[\\s\\u00a0\\u202f.\\-]'; // séparateurs tolérés entre les chiffres d'un numéro imprimé

// Civilités, formes juridiques, PROFESSIONS et mots-outils ignorés dans le
// matching par nom. Les professions sont indispensables : les fiches sont
// nommées « MME MARRE Infirmiere » — sans exclusion, « infirmiere » (token le
// plus long) faisait matcher N'IMPORTE QUELLE infirmière avec n'importe quelle
// autre (cas réel : la recherche URSSAF ouvrait le dossier de la première
// infirmière de la liste, VIGUIER, pour toutes les autres).
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
  'infirmier',
  'infirmiere',
  'medecin',
  'specialiste',
  'generaliste',
  'kinesitherapeute',
  'masseur',
  'kine',
  'sage',
  'femme',
  'orthophoniste',
  'orthoptiste',
  'dentiste',
  'chirurgien',
  'veterinaire',
  'pharmacien',
  'pharmacienne',
  'podologue',
  'pedicure',
  'osteopathe',
  'psychologue',
  'dieteticien',
  'dieteticienne',
  'auxiliaire',
  'medical',
  'medicale',
  'medicaux',
  'liberal',
  'liberale',
  'remplacant',
  'remplacante',
  'titulaire',
  'huissier',
  'justice',
  'notaire',
  'avocat',
  'avocate',
  'gerant',
  'gerante',
  'majoritaire',
  'president',
  'presidente',
  'artisan',
  'commercant',
  'commercante',
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
  // Formes juridiques et prefixes vus dans les fiches reelles du cabinet
  // (INDI_, STEF_, STEP_, SLRL_, SPFL_, GIE_, GFA_, SCEA_, ASS_).
  'indi',
  'indivision',
  'stef',
  'step',
  'slrl',
  'spfl',
  'sepl',
  'gie',
  'gfa',
  'scea',
  'ass',
  'association',
  'holding',
  // Mentions d'etat civil : « nee », « epouse », « veuve » ne distinguent personne
  // et faussaient le compte des mots significatifs.
  'nee',
  'ne',
  'epouse',
  'epoux',
  'veuve',
  'veuf',
  'succession',
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

/** Mode de paiement mentionné sur un avis CFE. ATTENTION : TOUS les avis
 *  embarquent une FAQ générique citant mensualisation ET prélèvement à
 *  l'échéance (« résilier votre contrat de mensualisation ? », « vous êtes
 *  mensualisé et vous souhaitez... », « le prélèvement à l'échéance —
 *  avantages : ... ») : des mots isolés classaient TOUT en « mensualisé ».
 *  Seules les mentions PERSONNALISÉES sont fiables (constat sur avis réels
 *  2021-2025) :
 *    échéance   : « vous avez choisi le prélèvement à l'échéance »
 *    mensualisé : « contrat de mensualisation au nom de », « numéro de
 *                  contrat de prélèvement mensuel » (l'avis à l'échéance a un
 *                  « numéro de contrat de prélèvement » SANS « mensuel »),
 *                  « vous avez choisi/opté pour le prélèvement mensuel »
 *    aucun      : « vous n'avez pas adhéré à un prélèvement automatique »
 *  Renvoie 'aucun' | 'mensualise' | 'echeance' | null. */
// Version des motifs : l'incrémenter relance la retro-analyse de tous les avis
// au prochain démarrage du serveur (les modes mémorisés sont oubliés).
export const PAIEMENT_CFE_VERSION = 2;
export function detecterPaiementCfe(texte) {
  const t = normaliser(texte);
  if (!t) return null;
  if (/avez (choisi|opte pour) le prelevement a l.{0,2}echeance/.test(t)) return 'echeance';
  if (/contrat de mensualisation au nom de|numero de contrat de prelevement mensuel|avez (choisi|opte pour) le prelevement mensuel/.test(t))
    return 'mensualise';
  if (/pas adhere a un prelevement/.test(t)) return 'aucun';
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

/** Matching par tokens du nom : mots significatifs UNIQUES (≥ 3 lettres, hors civilités,
 *  formes juridiques, professions et mentions d'état civil), cherchés avec frontières de
 *  mot (MARTIN ne matche pas MARTINIQUE). Règle : un nom d'un seul mot distinctif doit y
 *  être ; dès qu'il y a plusieurs mots, il faut DEUX correspondances. Le mot le plus long
 *  n'est plus exigé (c'est souvent un prénom absent du document). Tolère l'ordre inversé,
 *  la civilité, les sigles pointés (« M.I.C. ») et les initiales espacées (« SCI M D P »). */
export function correspondanceNom(texte, nom) {
  const t = normaliser(texte);
  // Mots du nom, points retires : « M.I.C. » -> « mic » (sinon cette raison sociale
  // n'a aucun mot de 3 lettres et ne pourrait JAMAIS etre validee par le nom).
  const motsBruts = normaliser(nom)
    .split(/[^a-z0-9.]+/)
    .filter(Boolean);
  const mots = motsBruts.map((m) => m.replace(/\./g, ''));
  // Mots qui contenaient un point (« PRO.SEC » -> « prosec ») : leur recherche doit
  // tolerer le point, sinon le token nettoye ne se retrouve pas dans le document.
  const pointes = new Set(motsBruts.filter((m) => m.includes('.')).map((m) => m.replace(/\./g, '')));
  // Tokens UNIQUES et significatifs (>= 3 lettres, hors civilites / formes juridiques /
  // mots-outils). Deduplication indispensable : « MME BONNEMAISON nee BONNEMAISON
  // VERONIQUE » ne doit pas compter « bonnemaison » deux fois.
  let tokens = [...new Set(mots.filter((tok) => tok.length >= 3 && !STOPLIST.has(tok)))];
  // Sigles courts (« SCI 3C », « SCI M D P ») : aucun mot significatif -> on recolle les
  // initiales restantes en un seul token, reconnu ensuite avec ou sans separateurs.
  let sigle = false;
  if (!tokens.length) {
    const recolle = mots.filter((m) => !STOPLIST.has(m)).join('');
    if (recolle.length >= 2) {
      tokens = [recolle];
      sigle = true;
    }
  }
  if (!tokens.length) return false;
  // Les tokens COURTS sont des sigles : on tolere les separateurs entre les lettres,
  // car le token est nettoye (« mic ») alors que le document imprime « M.I.C. ».
  const present = (tok) => {
    const motif = sigle || tok.length <= 5 || pointes.has(tok) ? tok.split('').map(echapperRegex).join('[\\s.]*') : echapperRegex(tok);
    return new RegExp(`(?<![a-z0-9])${motif}(?![a-z0-9])`).test(t);
  };
  const trouves = tokens.filter(present).length;
  // Regle : un nom d'un seul mot distinctif (« CAMBON ») doit y etre ; des qu'il y a
  // plusieurs mots, il faut DEUX correspondances.
  //  - on n'exige plus le token le PLUS LONG : c'est souvent un prenom (« MME POUMIRAU
  //    nee CALMET CHRISTINE » -> « christine »), absent du document -> quarantaine a tort ;
  //  - un seul mot commun ne suffit plus : un courrier « SCM BOUISSOU DURAND ET BOAS »
  //    n'est plus attribue a « MME DURAND LUCIE » (mesure sur la base reelle : 1 client
  //    sur 5 etait validable par le document d'un autre). Compromis assume : un document
  //    qui n'imprimerait QUE le patronyme d'un client qui a un prenom part en quarantaine
  //    plutot que d'etre range dans le mauvais dossier.
  return tokens.length === 1 ? trouves === 1 : trouves >= 2;
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
 * @param {{libelle?:string, eventid?:string, dateDoc?:string}} [p.meta] métadonnées
 *   d'enregistrement du document. Elles sont écrites dans un manifeste à côté du PDF mis
 *   en quarantaine : sans elles, une réintégration depuis le portail ne pourrait pas
 *   recréer la ligne en base — le document serait retéléchargé puis remis en quarantaine
 *   au passage suivant, en boucle.
 * @returns {Promise<{verdict:'ok'|'quarantaine'|'non_verifiable', raison:string|null, fichier:string}>}
 *   verdict 'ok'             : enregistrer le document normalement ;
 *   verdict 'non_verifiable' : enregistrer, mais compter l'avertissement ;
 *   verdict 'quarantaine'    : fichier DÉPLACÉ — ne pas appeler addDocument.
 */
export async function verifierEtClasser({ fichier, source, client, attendus, dossierQuarantaine, meta }) {
  const nomFichier = basename(fichier);
  try {
    const cherche = attendus || attendusPour(source, client);
    const texte = await extraireTextePdf(fichier);
    if (texte == null || normaliser(texte).replace(/\s/g, '').length < 20)
      return { verdict: 'non_verifiable', raison: `"${nomFichier}" : texte non extractible (scan ?)`, fichier };
    const res = verifierCorrespondance(texte, cherche);
    if (res.ok) return { verdict: 'ok', raison: res.motif, fichier };
    const dossier = resolve(dossierQuarantaine || QUARANTAINE_DIR, source, sanitize(`${client.id}_${client.nom}`));
    const raison = `${libelleAttendus(cherche)} introuvable(s) dans "${nomFichier}"`;
    const dest = mettreEnQuarantaine(fichier, dossier);
    // Manifeste : tout ce qu'il faut pour reintegrer le document depuis le portail
    // (remettre le fichier a sa place ET recreer la ligne en base).
    try {
      writeFileSync(
        `${dest}.json`,
        JSON.stringify(
          {
            source,
            clientId: client?.id ?? null,
            clientNom: client?.nom ?? null,
            origine: fichier,
            libelle: meta?.libelle ?? null,
            eventid: meta?.eventid ?? null,
            dateDoc: meta?.dateDoc ?? null,
            raison,
            attendus: cherche,
            date: new Date().toISOString(),
          },
          null,
          2,
        ),
        'utf8',
      );
    } catch {
      /* manifeste best-effort : la mise en quarantaine reste valable sans lui */
    }
    return {
      verdict: 'quarantaine',
      raison: `${raison} — fichier déplacé en quarantaine`,
      fichier: dest,
    };
  } catch (e) {
    // La validation ne doit jamais bloquer une récupération légitime.
    return { verdict: 'non_verifiable', raison: `"${nomFichier}" : validation impossible (${e.message})`, fichier };
  }
}
