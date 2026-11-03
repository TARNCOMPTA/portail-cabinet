// Tests de la factory de base "source par login/mot de passe" (src/creer-source-db.js).
// Utilise une base jetable data/_test_source.db (nettoyée avant/après).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { creerSourceDb } from '../src/creer-source-db.js';

const FICH = '_test_source.db';
const nettoyer = () => {
  for (const suf of ['', '-wal', '-shm']) {
    try {
      rmSync(resolve('data', FICH) + suf, { force: true });
    } catch {
      /* ignore */
    }
  }
};
nettoyer(); // repartir d'une base vierge

const db = creerSourceDb(FICH, { profession: true });
after(nettoyer);

test('createClient + getClientCredentials : mot de passe chiffré puis déchiffré', () => {
  const c = db.createClient({ nom: 'Dr TEST', profession: 'sf', login: 'LOG1', password: 'motdepasse' });
  assert.ok(c.id, 'id attribué');
  assert.equal(c.password_enc, undefined, 'la vue publique ne contient pas le mot de passe chiffré');
  const creds = db.getClientCredentials(c.id);
  assert.equal(creds.password, 'motdepasse', 'mot de passe correctement déchiffré');
  assert.equal(creds.profession, 'sf');
});

test('listClients : profession_libelle + compteur', () => {
  const c = db.listClients().find((x) => x.login === 'LOG1');
  assert.equal(c.profession, 'sf');
  assert.equal(c.profession_libelle, 'Sage-femme');
  assert.equal(c.nb_docs, 0);
});

test('getClientByLogin + updateClient', () => {
  const c = db.getClientByLogin('LOG1');
  assert.ok(c);
  db.updateClient(c.id, { nom: 'Dr TEST MODIFIÉ' });
  assert.equal(db.getClient(c.id).nom, 'Dr TEST MODIFIÉ');
  assert.equal(db.getClientCredentials(c.id).password, 'motdepasse', 'mdp inchangé si non fourni');
});

test('importClients : création + mise à jour', () => {
  const bilan = db.importClients([
    { nom: 'Import A', profession: 'cd', login: 'IMPA', password: 'a' },
    { nom: 'LOG1 maj', profession: 'sf', login: 'LOG1', password: '' },
  ]);
  assert.equal(bilan.crees, 1);
  assert.equal(bilan.maj, 1);
  assert.equal(db.getClientByLogin('IMPA').profession, 'cd');
});

test('deleteClient', () => {
  const c = db.getClientByLogin('IMPA');
  db.deleteClient(c.id);
  assert.equal(db.getClientByLogin('IMPA'), undefined);
});

test('getDocument : accès direct par id (indépendant des listes plafonnées)', () => {
  const c = db.getClientByLogin('LOG1');
  db.addDocument(c.id, { libelle: 'Attestation 2026', fichier: '/tmp/doc_test.pdf', date_doc: '2026' });
  const d = db.listDocuments(c.id)[0];
  const direct = db.getDocument(d.id);
  assert.equal(direct.fichier, '/tmp/doc_test.pdf');
  assert.equal(direct.client_nom, c.nom, 'joint le nom du client');
  assert.equal(db.getDocument(999999), undefined, 'id inconnu -> undefined');
});

test('listRuns(limite, depuis) : toute la période demandée, rien avant', () => {
  const c = db.createClient({ nom: 'Dr RUNS', login: 'RUNS1', password: 'x' });
  const ins = db.db.prepare('INSERT INTO runs (client_id, statut, message, nb_docs, lance_le) VALUES (?, ?, ?, 0, ?)');
  ins.run(c.id, 'succes', 'ancien', '2026-10-30 23:59:59');
  ins.run(c.id, 'echec', 'du jour 1', '2026-10-31 00:00:00');
  ins.run(c.id, 'echec_mdp', 'du jour 2', '2026-10-31 08:15:00');
  const periode = db.listRuns(5000, '2026-10-31').filter((r) => r.client_id === c.id);
  assert.deepEqual(
    periode.map((r) => r.message),
    ['du jour 2', 'du jour 1'],
  );
  assert.equal(db.listRuns(300).filter((r) => r.client_id === c.id).length, 3, 'sans depuis : comportement inchangé');
});
