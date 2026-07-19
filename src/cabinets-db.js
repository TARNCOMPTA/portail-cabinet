// Factory du modèle « comptes cabinet » (libellé + login + mot de passe chiffré),
// partagée par db.js (impôts) et urssaf-db.js. L'appelant doit avoir DÉJÀ créé la table
// `cabinets` (et la colonne clients.cabinet_id) ; la factory pose l'index unique par login
// (avec dédoublonnage préalable) puis rend le CRUD. Le chiffrement réutilise crypto.js.
import { encrypt, decrypt } from './crypto.js';

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ indexName: string, exigeMotDePasse?: boolean }} options
 *   indexName : nom de l'index unique (distinct par base) ;
 *   exigeMotDePasse : true => un compte n'est « configuré » que s'il a un mot de passe
 *   (URSSAF, connexion automatique) ; false => dès qu'il existe (impôts, captcha manuel).
 */
export function creerCabinets(db, { indexName, exigeMotDePasse = false } = {}) {
  // Dédoublonnage par login (garde le plus petit id, rattache ses clients) + index unique :
  // empêche tout cabinet en double (même e-mail), y compris en insertion concurrente.
  {
    const dups = db.prepare('SELECT MIN(id) AS keep FROM cabinets GROUP BY lower(login) HAVING COUNT(*) > 1').all();
    for (const { keep } of dups) {
      const login = db.prepare('SELECT login FROM cabinets WHERE id = ?').get(keep).login;
      db.prepare('UPDATE clients SET cabinet_id = ? WHERE cabinet_id IN (SELECT id FROM cabinets WHERE lower(login) = lower(?) AND id != ?)').run(
        keep,
        login,
        keep,
      );
      db.prepare('DELETE FROM cabinets WHERE lower(login) = lower(?) AND id != ?').run(login, keep);
    }
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS ${indexName} ON cabinets(lower(login))`);
  }

  function listCabinets() {
    return db
      .prepare(
        `
      SELECT c.id, c.libelle, c.login,
             (SELECT COUNT(*) FROM clients cl WHERE cl.cabinet_id = c.id) AS nb_clients,
             (c.password_enc IS NOT NULL) AS pwd_ok
      FROM cabinets c ORDER BY c.libelle COLLATE NOCASE, c.id
    `,
      )
      .all()
      .map((c) => ({ ...c, pwd_ok: !!c.pwd_ok }));
  }
  // Renvoie le cabinet avec mot de passe déchiffré (usage interne scraper).
  function getCabinetFull(id) {
    const c = db.prepare('SELECT * FROM cabinets WHERE id = ?').get(id);
    if (!c) return null;
    return { id: c.id, libelle: c.libelle, login: c.login, password: c.password_enc ? decrypt(c.password_enc) : '' };
  }
  function getCabinetByLogin(login) {
    return db.prepare('SELECT id, libelle, login FROM cabinets WHERE lower(login) = lower(?)').get(String(login || '').trim());
  }
  function createCabinet({ libelle, login, password }) {
    const info = db
      .prepare('INSERT INTO cabinets (libelle, login, password_enc) VALUES (?, ?, ?)')
      .run((libelle || login || '').trim(), String(login || '').trim(), password ? encrypt(String(password)) : null);
    return db.prepare('SELECT id, libelle, login FROM cabinets WHERE id = ?').get(info.lastInsertRowid);
  }
  function updateCabinet(id, { libelle, login, password }) {
    const c = db.prepare('SELECT * FROM cabinets WHERE id = ?').get(id);
    if (!c) return null;
    const enc = password ? encrypt(String(password)) : c.password_enc;
    db.prepare('UPDATE cabinets SET libelle = ?, login = ?, password_enc = ? WHERE id = ?').run(libelle ?? c.libelle, login ?? c.login, enc, id);
    return db.prepare('SELECT id, libelle, login FROM cabinets WHERE id = ?').get(id);
  }
  function deleteCabinet(id) {
    db.prepare('UPDATE clients SET cabinet_id = NULL WHERE cabinet_id = ?').run(id);
    db.prepare('DELETE FROM cabinets WHERE id = ?').run(id);
  }
  function cabinetsConfigure() {
    const sql = exigeMotDePasse ? 'SELECT COUNT(*) AS n FROM cabinets WHERE password_enc IS NOT NULL' : 'SELECT COUNT(*) AS n FROM cabinets';
    return db.prepare(sql).get().n > 0;
  }

  return { listCabinets, getCabinetFull, getCabinetByLogin, createCabinet, updateCabinet, deleteCabinet, cabinetsConfigure };
}
