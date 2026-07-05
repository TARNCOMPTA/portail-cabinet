// Tests du hachage de mot de passe (scrypt) et du throttle anti-brute-force — src/auth.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, verifyPassword, creerThrottle } from '../src/auth.js';

test('hashPassword/verifyPassword : mot de passe correct accepté', () => {
  const h = hashPassword('Bon-Mot-De-Passe-2026');
  assert.match(h, /^scrypt\$/, 'format scrypt$salt$hash attendu');
  assert.equal(verifyPassword('Bon-Mot-De-Passe-2026', h), true);
});

test('verifyPassword : mauvais mot de passe rejeté', () => {
  const h = hashPassword('secret');
  assert.equal(verifyPassword('autre', h), false);
});

test('verifyPassword : hash invalide rejeté sans lever d’exception', () => {
  assert.equal(verifyPassword('x', 'pas-un-hash'), false);
  assert.equal(verifyPassword('x', ''), false);
});

test('hashPassword : deux hachages du même mot de passe diffèrent (sel aléatoire)', () => {
  assert.notEqual(hashPassword('meme'), hashPassword('meme'));
});

test('creerThrottle : bloque après max échecs, indépendant par clé', () => {
  const t = creerThrottle({ max: 3, fenetreMs: 60000 });
  assert.equal(t.bloque('a@b.fr'), false);
  t.echec('a@b.fr');
  t.echec('a@b.fr');
  assert.equal(t.bloque('a@b.fr'), false, '2 échecs sur 3 : pas encore bloqué');
  t.echec('a@b.fr');
  assert.equal(t.bloque('a@b.fr'), true, '3 échecs : bloqué');
  assert.equal(t.bloque('autre@b.fr'), false, 'les autres clés ne sont pas affectées');
});

test('creerThrottle : la réussite remet le compteur à zéro', () => {
  const t = creerThrottle({ max: 2, fenetreMs: 60000 });
  t.echec('k');
  t.reussite('k');
  t.echec('k');
  assert.equal(t.bloque('k'), false, 'le compteur repart de zéro après une réussite');
});

test('creerThrottle : le blocage expire après la fenêtre', () => {
  const t = creerThrottle({ max: 1, fenetreMs: -1 }); // fenêtre déjà expirée
  t.echec('k');
  assert.equal(t.bloque('k'), false, 'fenêtre passée : plus bloqué');
});
