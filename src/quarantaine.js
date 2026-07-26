// Gestion des documents mis en QUARANTAINE par la vérification d'appartenance
// (src/validation-pdf.js) : lister, servir, réintégrer, supprimer.
//
// Arborescence : downloads/_quarantaine/<source>/<clientId_nom>/<fichier>.pdf
// avec, à côté de chaque PDF, un manifeste <fichier>.pdf.json (source, client, chemin
// d'origine, libellé, eventid/date du document, raison du rejet). Sans ce manifeste on
// pourrait remettre le fichier en place mais pas recréer sa ligne en base : il serait
// retéléchargé puis remis en quarantaine au passage suivant, en boucle.
import { readdirSync, statSync, existsSync, readFileSync, mkdirSync, renameSync, copyFileSync, unlinkSync, rmdirSync } from 'node:fs';
import { resolve, dirname, basename, relative, sep } from 'node:path';
import { QUARANTAINE_DIR } from './validation-pdf.js';

export { QUARANTAINE_DIR };

/** Résout un identifiant relatif (« impots/12_DUPONT/avis.pdf ») en chemin absolu
 *  VERROUILLÉ dans le dossier de quarantaine. null si la cible en sort (anti-LFI). */
export function cheminSur(rel) {
  const cible = resolve(QUARANTAINE_DIR, String(rel || ''));
  const racine = resolve(QUARANTAINE_DIR);
  if (cible !== racine && !cible.startsWith(racine + sep)) return null;
  return cible;
}

const relatif = (abs) => relative(QUARANTAINE_DIR, abs).split(sep).join('/');

/** Liste les documents en quarantaine, du plus récent au plus ancien. */
export function listerQuarantaine() {
  const out = [];
  const racine = resolve(QUARANTAINE_DIR);
  if (!existsSync(racine)) return out;
  const parcourir = (dir) => {
    let entrees = [];
    try {
      entrees = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entrees) {
      const p = resolve(dir, e.name);
      if (e.isDirectory()) {
        parcourir(p);
        continue;
      }
      if (e.name.endsWith('.json')) continue; // manifeste, listé avec son PDF
      let st;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      let meta = {};
      try {
        if (existsSync(`${p}.json`)) meta = JSON.parse(readFileSync(`${p}.json`, 'utf8'));
      } catch {
        /* manifeste illisible : on liste quand meme le fichier */
      }
      // Repli quand le manifeste manque (fichier mis en quarantaine avant cette version) :
      // la source et le client se deduisent du chemin <source>/<clientId_nom>/...
      const parts = relatif(p).split('/');
      const idDossier = (parts[1] || '').match(/^(\d+)_/);
      out.push({
        id: relatif(p),
        fichier: e.name,
        taille: st.size,
        date: (meta.date || st.mtime.toISOString()).slice(0, 19).replace('T', ' '),
        source: meta.source || parts[0] || '',
        // Le client sert au tri automatique meme sans manifeste ; la reintegration, elle,
        // reste conditionnee au manifeste (seul lui connait le chemin d'origine exact).
        clientId: meta.clientId ?? (idDossier ? Number(idDossier[1]) : null),
        clientNom: meta.clientNom || (parts[1] || '').replace(/^\d+_/, '').replace(/_/g, ' '),
        raison: meta.raison || 'Document non attribuable à ce client (vérification d’appartenance).',
        libelle: meta.libelle || null,
        origine: meta.origine || null,
        reintegrable: !!(meta.origine && meta.clientId),
      });
    }
  };
  parcourir(racine);
  return out.sort((a, b) => String(b.date).localeCompare(String(a.date)));
}

/** Une entrée précise (ou null). */
export function trouverQuarantaine(id) {
  return listerQuarantaine().find((q) => q.id === id) || null;
}

// Déplacement robuste (volumes différents -> copie + suppression).
function deplacer(de, vers) {
  mkdirSync(dirname(vers), { recursive: true });
  try {
    renameSync(de, vers);
  } catch (e) {
    if (e.code !== 'EXDEV') throw e;
    copyFileSync(de, vers);
    unlinkSync(de);
  }
}

/** Supprime définitivement un document en quarantaine (et son manifeste). */
export function supprimerQuarantaine(id) {
  const p = cheminSur(id);
  if (!p || !existsSync(p)) return { ok: false, error: 'Document introuvable.' };
  unlinkSync(p);
  if (existsSync(`${p}.json`)) unlinkSync(`${p}.json`);
  return { ok: true };
}

/** Retire les dossiers devenus vides (la racine de quarantaine, elle, est conservée).
 *  Sans ça, vider la quarantaine laisserait des centaines de dossiers clients vides. */
export function nettoyerDossiersVides() {
  const racine = resolve(QUARANTAINE_DIR);
  if (!existsSync(racine)) return 0;
  let retires = 0;
  const parcourir = (dir) => {
    let entrees = [];
    try {
      entrees = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entrees) if (e.isDirectory()) parcourir(resolve(dir, e.name));
    if (dir === racine) return; // on ne supprime jamais le dossier de quarantaine lui-même
    try {
      if (!readdirSync(dir).length) {
        rmdirSync(dir);
        retires++;
      }
    } catch {
      /* dossier verrouillé ou déjà parti : sans conséquence */
    }
  };
  parcourir(racine);
  return retires;
}

/** Suppression en lot (vidage de la quarantaine), dossiers vides nettoyés au passage.
 *  @returns {{supprimes:number, echecs:string[]}} */
export function supprimerLot(ids) {
  let supprimes = 0;
  const echecs = [];
  for (const id of ids || []) {
    try {
      const r = supprimerQuarantaine(id);
      if (r.ok) supprimes++;
      else echecs.push(`${id} : ${r.error}`);
    } catch (e) {
      echecs.push(`${id} : ${e.message}`);
    }
  }
  nettoyerDossiersVides();
  return { supprimes, echecs };
}

/**
 * Remet un document à sa place (le dossier du client). N'ENREGISTRE PAS en base :
 * l'appelant le fait avec les métadonnées renvoyées, car seul lui connaît la base de
 * la source. En cas d'échec d'enregistrement, `annuler()` remet le fichier en quarantaine.
 * @returns {{ok:true, destination:string, meta:object, annuler:Function}|{ok:false,error:string}}
 */
export function reintegrer(id) {
  const p = cheminSur(id);
  if (!p || !existsSync(p)) return { ok: false, error: 'Document introuvable.' };
  let meta = {};
  try {
    meta = JSON.parse(readFileSync(`${p}.json`, 'utf8'));
  } catch {
    return {
      ok: false,
      error:
        'Métadonnées absentes : impossible de réintégrer automatiquement (télécharge le document et classe-le à la main, puis supprime-le de la quarantaine).',
    };
  }
  if (!meta.origine || !meta.clientId) return { ok: false, error: 'Métadonnées incomplètes (origine ou client manquant).' };
  // Ne jamais ecraser un document deja present a destination.
  let dest = meta.origine;
  if (existsSync(dest)) {
    const ext = (basename(dest).match(/\.[a-z0-9]+$/i) || [''])[0];
    const base = ext ? dest.slice(0, -ext.length) : dest;
    let i = 2;
    while (existsSync(dest) && i < 100) dest = `${base} (${i++})${ext}`;
  }
  deplacer(p, dest);
  if (existsSync(`${p}.json`)) unlinkSync(`${p}.json`);
  return {
    ok: true,
    destination: dest,
    meta,
    annuler: () => {
      try {
        deplacer(dest, p);
      } catch {
        /* best-effort */
      }
    },
  };
}
