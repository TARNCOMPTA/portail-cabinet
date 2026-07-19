// Helpers d'affichage partagés par les sections « sources » (URSSAF via urssaf.js,
// caisses via source-ui.js). Chargé APRÈS app.js et AVANT source-ui.js / urssaf.js :
// expose fmtDate() et statutBadge() en globales (comme app.js pour $, api, toast...).

// Horodatage SQLite (UTC, « AAAA-MM-JJ HH:MM:SS ») -> date+heure locales fr-FR.
// eslint-disable-next-line no-unused-vars -- utilisée par urssaf.js et source-ui.js
function fmtDate(s) {
  if (!s) return '—';
  const d = new Date(String(s).replace(' ', 'T') + 'Z');
  return isNaN(d)
    ? s
    : d.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: '2-digit' }) +
        ' ' +
        d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
}

// Badge HTML de l'état de la dernière récupération. Superset : inclut le cas 'info'
// (utilisé par les caisses) — inoffensif pour URSSAF qui ne le produit pas.
// eslint-disable-next-line no-unused-vars -- utilisée par urssaf.js et source-ui.js
function statutBadge(st) {
  if (st === 'succes') return '<span class="badge ok">OK</span>';
  if (st === 'echec_mdp') return '<span class="badge err">🔒 mdp</span>';
  if (st === 'echec') return '<span class="badge err">échec</span>';
  if (st === 'info') return '<span class="badge">connexion OK</span>';
  return '<span class="badge">—</span>';
}
