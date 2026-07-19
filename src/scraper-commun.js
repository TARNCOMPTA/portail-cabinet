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
