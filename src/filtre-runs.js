// Filtre commun des listes de passages (table runs, alias r) des bases de chaque source.
// Module sans effet de bord : l'importer n'ouvre aucune base.

/** Clause WHERE des listes de passages (`depuis`, `clientId`), en parametres lies. */
export function filtreRuns(depuis = null, clientId = null) {
  const conds = [];
  const params = [];
  if (depuis) {
    conds.push('r.lance_le >= ?');
    params.push(depuis);
  }
  if (clientId != null) {
    conds.push('r.client_id = ?');
    params.push(clientId);
  }
  return { where: conds.length ? `WHERE ${conds.join(' AND ')}` : '', params };
}
