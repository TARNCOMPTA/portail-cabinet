// Configuration ESLint (flat config v9). Objectif : attraper les vraies erreurs
// (variables non définies, code mort, coquilles) sans imposer de reformatage — le style
// est géré par Prettier. Trois contextes : back-end Node, scrapers (Node + code navigateur
// exécuté via page.evaluate), et front-end (scripts classiques à scope global partagé).
import js from '@eslint/js';
import globals from 'globals';

export default [
  { ignores: ['node_modules/**', 'public/vendor/**', 'data/**', 'downloads/**', 'app_update/**', '**/*.min.js'] },

  js.configs.recommended,

  {
    rules: {
      'no-empty': ['warn', { allowEmptyCatch: true }],
      'no-unused-vars': ['warn', { args: 'none', varsIgnorePattern: '^_', caughtErrors: 'none', ignoreRestSiblings: true }],
      'no-constant-condition': ['error', { checkLoops: false }],
      // Le strip de BOM (update.js) utilise volontairement le caractère U+FEFF dans une regex.
      'no-irregular-whitespace': 'off',
    },
  },

  // Back-end Node : modules ES + scripts racine.
  {
    files: ['src/**/*.js', 'test/**/*.js', '*.js', 'mcp-portail/**/*.mjs', 'scripts/**/*.mjs'],
    languageOptions: { ecmaVersion: 2023, sourceType: 'module', globals: { ...globals.node } },
  },

  // Scrapers Playwright : contiennent du code navigateur (page.evaluate) -> globals navigateur.
  // backToHome = fonction exposée par le site URSSAF, appelée dans un evaluate.
  {
    files: ['src/scraper-*.js'],
    languageOptions: { globals: { ...globals.browser, backToHome: 'readonly' } },
  },

  // Front-end : scripts classiques chargés via <script>, partageant un scope global
  // multi-fichiers (helpers de app.js, initSourceUI de source-ui.js). no-undef/no-redeclare
  // ne conviennent pas à ce modèle ; on garde les autres règles de qualité.
  {
    files: ['public/**/*.js'],
    languageOptions: { ecmaVersion: 2023, sourceType: 'script', globals: { ...globals.browser } },
    rules: { 'no-undef': 'off', 'no-redeclare': 'off' },
  },
];
