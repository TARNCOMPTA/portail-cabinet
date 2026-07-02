// Tests du hachage de mot de passe (scrypt) — src/auth.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, verifyPassword } from '../src/auth.js';

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
