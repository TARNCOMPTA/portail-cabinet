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
