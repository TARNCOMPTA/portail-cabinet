// Utilitaires purs partagés par les connecteurs de scraping (impots, urssaf, caisses)
// et par la validation PDF. Aucune dépendance : uniquement des helpers sans état.

// Nom de fichier sûr (Windows/Linux) : garde lettres/chiffres/._- et espaces->_, borne à 120.
export function sanitize(name) {
  return String(name)
    .replace(/[^\w.\- ]+/g, '_')
    .replace(/\s+/g, '_')
    .trim()
    .slice(0, 120);
}

// Date « JJ/MM/AAAA » -> « AAAA-MM-JJ » (triable). Repli configurable si non reconnue
// (URSSAF veut '' ; CARPIMKO veut 'sans-date').
export function dateIso(fr, defaut = '') {
  const m = String(fr ?? '').match(/(\d{2})\/(\d{2})\/(\d{4})/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : defaut;
}

// Fenetre de recuperation : on ne reprend que l'annee en cours et les 2 precedentes
// (3 annees civiles) pour tous les organismes. Un document dont l'annee est
// introuvable est conserve (dans le doute on ne perd rien).
export const ANNEES_RECUPEREES = 3;

export function anneeMinimale(ref = new Date()) {
  return ref.getFullYear() - (ANNEES_RECUPEREES - 1);
}

// Premiere annee 20xx trouvee dans un texte (date « JJ/MM/AAAA », « AAAA-MM-JJ », libelle...).
export function anneeDe(texte) {
  const m = String(texte ?? '').match(/\b(20\d{2})\b/);
  return m ? Number(m[1]) : null;
}

export function dansPeriode(texte, ref = new Date()) {
  const a = anneeDe(texte);
  return a === null || a >= anneeMinimale(ref);
}
