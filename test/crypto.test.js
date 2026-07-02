// Tests du chiffrement AES-256-GCM (src/crypto.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encrypt, decrypt } from '../src/crypto.js';

test('encrypt/decrypt : round-trip', () => {
  const secret = 'M0nMotDeP@sse!éàü';
  const enc = encrypt(secret);
  assert.notEqual(enc, secret, 'le chiffré ne doit pas être en clair');
  assert.match(enc, /^[0-9a-f]+:[0-9a-f]+:[0-9a-f]+$/, 'format iv:tag:data attendu');
  assert.equal(decrypt(enc), secret, 'le déchiffré doit égaler l’original');
});

test('encrypt : deux chiffrés du même texte diffèrent (IV aléatoire)', () => {
  assert.notEqual(encrypt('abc'), encrypt('abc'));
});

test('decrypt : valeur corrompue ou vide renvoie une chaîne vide', () => {
  assert.equal(decrypt('nimportequoi'), '');
  assert.equal(decrypt(''), '');
  assert.equal(decrypt('aa:bb:cc'), '');
});
