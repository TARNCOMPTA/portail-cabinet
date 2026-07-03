// Tests de la liste noire des clients supprimés (src/liste-noire.js).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { creerListeNoire } from '../src/liste-noire.js';

const FICH = resolve('data', '_test_liste_noire.db');
const nettoyer = () => {
  for (const suf of ['', '-wal', '-shm'])
    try {
      rmSync(FICH + suf, { force: true });
    } catch {
      /* ignore */
    }
};
nettoyer();
const ln = creerListeNoire(new DatabaseSync(FICH));
after(nettoyer);

test('ajouter + estListeNoire (SIRET normalisé)', () => {
  ln.ajouterListeNoire({ siret: '123 456 789 00012', nom: 'SARL TEST', cabinet_id: 3 });
  assert.equal(ln.estListeNoire('12345678900012'), true);
  assert.equal(ln.estListeNoire('123 456 789 00012'), true, 'normalisation à la lecture aussi');
  assert.equal(ln.estListeNoire('99999999900000'), false);
});

test('doublon ignoré + liste', () => {
  ln.ajouterListeNoire({ siret: '12345678900012', nom: 'DOUBLON' });
  const liste = ln.listListeNoire();
  assert.equal(liste.length, 1);
  assert.equal(liste[0].nom, 'SARL TEST', 'la première entrée est conservée');
  assert.equal(liste[0].cabinet_id, 3);
});

test('retirerListeNoire renvoie l’entrée (pour recréer le client)', () => {
  const id = ln.listListeNoire()[0].id;
  const entree = ln.retirerListeNoire(id);
  assert.equal(entree.siret, '12345678900012');
  assert.equal(ln.estListeNoire('12345678900012'), false);
  assert.equal(ln.retirerListeNoire(id), null, 'déjà retirée');
});

test('retirerListeNoireParSiret (ajout manuel volontaire)', () => {
  ln.ajouterListeNoire({ siret: '55555555500055', nom: 'X' });
  ln.retirerListeNoireParSiret('555 555 555 00055');
  assert.equal(ln.estListeNoire('55555555500055'), false);
});

test('siret vide ignoré', () => {
  ln.ajouterListeNoire({ siret: '', nom: 'SANS SIRET' });
  assert.equal(ln.listListeNoire().length, 0);
});
