// Sous-ensemble des polices d'icônes Phosphor (poste de dev uniquement).
//
// POURQUOI : le portail n'utilise que ~30 icônes sur les ~1500 de Phosphor. Les polices
// complètes pesaient 276 Ko de .woff2 servis à chaque nouveau visiteur, plus 164 Ko de
// CSS déclarant toutes les classes de la bibliothèque. Et comme le @font-face d'origine
// est en `font-display: block`, AUCUNE icône ne s'affichait avant la fin de ce
// téléchargement (trous dans la barre latérale sur connexion lente).
//
// CE QUE FAIT CE SCRIPT :
//   1. scanne public/*.html et public/*.js pour relever les classes `ph-<nom>` réellement
//      utilisées, en distinguant la variante pleine (`ph-fill`) de la variante normale ;
//   2. lit les codepoints correspondants dans la feuille de style d'origine ;
//   3. appelle pyftsubset (fontTools) pour produire un .woff2 réduit à ces glyphes ;
//   4. réécrit la CSS servie avec les seules classes utilisées, en `font-display: block`
//      -> `swap` (le texte/les icônes ne bloquent plus l'affichage).
//
// QUAND LE RELANCER : après avoir ajouté une icône dans l'interface. Un oubli se voit
// tout de suite (icône manquante), et la CSS générée liste les classes disponibles.
//
//   npm run icons
//
// PRÉREQUIS (poste de dev, pas le serveur) : Python + `pip install fonttools brotli`.
// Les polices COMPLÈTES sont conservées hors de public/, dans vendor-src/phosphor/,
// pour permettre la régénération ; elles ne sont ni servies, ni copiées dans l'image
// Docker, ni incluses dans l'archive de mise à jour.

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const RACINE = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = resolve(RACINE, 'public');
const SRC = resolve(RACINE, 'vendor-src', 'phosphor');

// Les deux variantes livrées : normale (classe `ph`) et pleine (classe `ph-fill`).
const VARIANTES = [
  { cle: 'regular', classe: 'ph', police: 'Phosphor', dossier: 'regular', fichier: 'Phosphor' },
  { cle: 'fill', classe: 'ph-fill', police: 'Phosphor-Fill', dossier: 'fill', fichier: 'Phosphor-Fill' },
];

// ---- 1. Icônes réellement utilisées dans l'interface ----------------------
// Les classes sont toujours écrites en clair dans le code (aucune construction
// dynamique du type `ph-${nom}`) : un relevé statique est donc exhaustif.
function iconesUtilisees() {
  const utilisees = { regular: new Set(), fill: new Set() };
  for (const f of readdirSync(PUBLIC)) {
    if (!/\.(html|js)$/i.test(f)) continue;
    const texte = readFileSync(resolve(PUBLIC, f), 'utf8');
    // class="ph ph-folders" / class="ph-fill ph-bank" (ordre : variante puis icône)
    for (const m of texte.matchAll(/class="(ph|ph-fill)((?:\s+ph-[a-z0-9-]+)+)"/g)) {
      const variante = m[1] === 'ph-fill' ? 'fill' : 'regular';
      for (const nom of m[2].trim().split(/\s+/)) utilisees[variante].add(nom);
    }
  }
  return utilisees;
}

// ---- 2. Codepoints, lus dans la CSS d'origine -----------------------------
function codepointsDe(variante) {
  const css = readFileSync(resolve(SRC, variante.dossier, 'style.css'), 'utf8');
  const table = new Map();
  // .ph.ph-folders:before { content: "\e3a2"; }  /  .ph-fill.ph-bank:before { ... }
  const motif = new RegExp(`\\.${variante.classe.replace('-', '\\-')}\\.(ph-[a-z0-9-]+):before\\s*\\{\\s*content:\\s*"\\\\([0-9a-f]+)"`, 'g');
  for (const m of css.matchAll(motif)) table.set(m[1], m[2]);
  return table;
}

// ---- 3. Sous-ensemble de la police ---------------------------------------
function sousEnsemble(variante, noms, table) {
  const manquantes = noms.filter((n) => !table.has(n));
  if (manquantes.length) throw new Error(`${variante.cle} : icônes inconnues dans la CSS source — ${manquantes.join(', ')}`);

  const unicodes = noms.map((n) => `U+${table.get(n)}`).join(',');
  const entree = resolve(SRC, variante.dossier, `${variante.fichier}.ttf`);
  const sortieDir = resolve(PUBLIC, 'vendor', 'phosphor', variante.dossier);
  mkdirSync(sortieDir, { recursive: true });
  const sortie = resolve(sortieDir, `${variante.fichier}.woff2`);

  execFileSync(
    'pyftsubset',
    [
      entree,
      `--unicodes=${unicodes}`,
      '--flavor=woff2',
      `--output-file=${sortie}`,
      // Les icônes sont posées via `content:` (un seul codepoint) : les tables de
      // ligatures et de mise en page sont inutiles ici.
      '--layout-features=',
      '--no-hinting',
      '--desubroutinize',
      '--drop-tables+=DSIG',
    ],
    { stdio: ['ignore', 'ignore', 'inherit'] },
  );
  return { sortie, taille: statSync(sortie).size };
}

// ---- 4. CSS réduite aux classes utilisées --------------------------------
function ecrireCss(variante, noms, table) {
  const regles = noms
    .slice()
    .sort()
    .map((n) => `.${variante.classe}.${n}:before {\n  content: "\\${table.get(n)}";\n}`)
    .join('\n');

  const css = `/* Sous-ensemble Phosphor — GÉNÉRÉ par scripts/subset-phosphor.mjs, ne pas éditer à la main.
 * ${noms.length} icône(s) sur les ~1500 de la police complète. Pour en ajouter une :
 * l'utiliser dans public/ (class="${variante.classe} ph-...") puis relancer \`npm run icons\`.
 * font-display: swap (et non block) : une icône en retard n'empêche plus l'affichage. */
@font-face {
  font-family: "${variante.police}";
  src: url("./${variante.fichier}.woff2") format("woff2");
  font-weight: normal;
  font-style: normal;
  font-display: swap;
}

.${variante.classe} {
  /* !important : neutralise les extensions de navigateur qui imposent une police */
  font-family: "${variante.police}" !important;
  font-style: normal;
  font-weight: normal;
  font-variant: normal;
  text-transform: none;
  line-height: 1;
  speak: never;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}

${regles}
`;
  const chemin = resolve(PUBLIC, 'vendor', 'phosphor', variante.dossier, 'style.css');
  writeFileSync(chemin, css, 'utf8');
  return { chemin, taille: Buffer.byteLength(css) };
}

// ---- Exécution ------------------------------------------------------------
if (!existsSync(SRC)) {
  console.error(`Polices complètes absentes : ${SRC}`);
  console.error('Elles sont versionnées dans le dépôt (vendor-src/phosphor/) — vérifie ton git checkout.');
  process.exit(1);
}

const utilisees = iconesUtilisees();
for (const variante of VARIANTES) {
  const table = codepointsDe(variante);
  // La classe de variante elle-même n'est pas une icône.
  const noms = [...utilisees[variante.cle]].filter((n) => n !== 'ph-fill').sort();
  if (!noms.length) {
    console.log(`${variante.cle.padEnd(8)} : aucune icône utilisée, ignoré.`);
    continue;
  }
  const police = sousEnsemble(variante, noms, table);
  const css = ecrireCss(variante, noms, table);
  const avant = statSync(resolve(SRC, variante.dossier, `${variante.fichier}.woff2`)).size;
  console.log(
    `${variante.cle.padEnd(8)} : ${String(noms.length).padStart(2)} icônes — ` +
      `woff2 ${(avant / 1024).toFixed(0)} Ko -> ${(police.taille / 1024).toFixed(1)} Ko, ` +
      `css ${(css.taille / 1024).toFixed(1)} Ko`,
  );
}
