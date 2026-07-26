// Tri automatique des documents en quarantaine.
//
// Pourquoi : la quarantaine accumule deux populations très différentes qu'on ne peut pas
// distinguer à l'œil sur des milliers de lignes —
//   1. des documents rejetés À TORT (la règle de reconnaissance du nom a été corrigée
//      depuis leur mise à l'écart : cf. correspondanceNom) ;
//   2. de vrais documents d'AUTRES clients, captés lors d'un incident de session côté
//      organisme (le portail tiers-déclarant reste collé sur un dossier et resert les
//      mêmes PDF pour les clients suivants).
//
// Ce module repasse chaque PDF dans la règle ACTUELLE puis, s'il est toujours rejeté,
// cherche à qui il appartient vraiment en recoupant les numéros imprimés dedans avec les
// identifiants du portefeuille. Verdicts : `client`, `autre`, `indetermine`, `illisible`,
// `erreur`. Il ne DÉPLACE ni ne supprime rien : il décide, l'appelant applique.
import { extraireTextePdf, normaliser, attendusPour, verifierCorrespondance, correspondanceNom } from './validation-pdf.js';

const chiffresSeuls = (v) => String(v || '').replace(/\D/g, '');

/**
 * Numéros à 9 chiffres et plus imprimés dans le document (SIREN, SIRET, n° d'adhérent),
 * ramenés à leurs 9 premiers chiffres — un SIRET commence par le SIREN.
 * Les séparateurs habituels (« 884 427 436 00024 ») sont tolérés.
 */
export function numerosDuTexte(texte) {
  const out = new Set();
  for (const brut of normaliser(texte).match(/\d(?:[ .]?\d){8,17}/g) || []) {
    const n = brut.replace(/[ .]/g, '');
    if (n.length >= 9) out.add(n.slice(0, 9));
  }
  return out;
}

/**
 * Index « 9 premiers chiffres → client » du portefeuille d'une source, pour retrouver
 * le propriétaire réel d'un document. Le premier client rencontré gagne (les doublons
 * d'identifiant sont anormaux et ne doivent pas décider d'une suppression).
 */
export function indexerPortefeuille(clients) {
  const index = new Map();
  for (const c of clients || []) {
    for (const brut of [c.siret, c.login]) {
      const n = chiffresSeuls(brut);
      if (n.length < 9) continue;
      const cle = n.slice(0, 9);
      if (!index.has(cle)) index.set(cle, c);
    }
  }
  return index;
}

/**
 * Verdict pour un document en quarantaine.
 * @param {{chemin:string, source:string, client:object|null, index:Map}} ctx
 * @returns {Promise<{verdict:string, motif:string, proprietaire?:{id:number,nom:string}}>}
 */
export async function analyserEntree({ chemin, source, client, index }) {
  let texte = null;
  try {
    // 3 pages suffisent : nom, adresse et identifiants sont en tête de courrier, et on
    // parcourt des milliers de fichiers.
    texte = await extraireTextePdf(chemin, { maxPages: 3 });
  } catch (e) {
    return { verdict: 'erreur', motif: `Lecture impossible : ${e.message}` };
  }
  if (texte === null) return { verdict: 'erreur', motif: 'Fichier illisible (PDF invalide).' };
  if (texte.trim().length < 20) return { verdict: 'illisible', motif: 'PDF sans texte (document scanné) — invérifiable.' };

  if (client) {
    const v = verifierCorrespondance(texte, attendusPour(source, client));
    if (v.ok) return { verdict: 'client', motif: `Le document mentionne bien ce client (${v.motif}) — rejeté à tort.` };
  }

  const mien = client ? chiffresSeuls(client.siret).slice(0, 9) : '';
  for (const numero of numerosDuTexte(texte)) {
    if (numero === mien) continue;
    const autre = index.get(numero);
    if (!autre || (client && autre.id === client.id)) continue;
    // Double confirmation avant d'accuser un autre dossier : le nom du propriétaire
    // présumé doit AUSSI figurer dans le document. Sans cela, deux nombres voisins
    // recollés par hasard suffiraient à proposer une suppression.
    if (!correspondanceNom(texte, autre.nom)) continue;
    return {
      verdict: 'autre',
      motif: `Document de ${autre.nom} (identifiant ${numero} et nom présents).`,
      proprietaire: { id: autre.id, nom: autre.nom },
    };
  }
  return { verdict: 'indetermine', motif: 'Ni le client attendu ni un autre client du cabinet n’est identifiable dans ce document.' };
}

/** Libellés des verdicts, pour l'interface et les journaux. */
export const LIB_VERDICT = {
  client: 'Appartient bien à ce client',
  autre: 'Appartient à un autre client',
  indetermine: 'Indéterminé',
  illisible: 'PDF sans texte',
  erreur: 'Illisible',
};
