// Tests du relais captcha (src/captcha-relais.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as relais from '../src/captcha-relais.js';

test('inactif par défaut + soumission refusée', async () => {
  assert.deepEqual(relais.etat(), { actif: false });
  const r = await relais.soumettre('ABC');
  assert.equal(r.ok, false);
});

test('ouvrir -> etat expose l’image en data-url', () => {
  relais.ouvrir({ image: Buffer.from('fauxpng'), soumettre: async () => ({ ok: true }) });
  const e = relais.etat();
  assert.equal(e.actif, true);
  assert.match(e.image, /^data:image\/png;base64,/);
});

test('soumettre transmet le code au handler (trim)', async () => {
  let recu = null;
  relais.ouvrir({
    image: Buffer.from('x'),
    soumettre: async (code) => {
      recu = code;
      return { ok: true, connecte: true };
    },
  });
  const r = await relais.soumettre('  AB12  ');
  assert.equal(recu, 'AB12');
  assert.equal(r.connecte, true);
});

test('majImage + rafraichir + fermer', async () => {
  let rafraichi = false;
  relais.ouvrir({
    image: Buffer.from('a'),
    soumettre: async () => ({ ok: false }),
    rafraichir: async () => {
      rafraichi = true;
      relais.majImage(Buffer.from('b'));
    },
  });
  const avant = relais.etat().image;
  const r = await relais.rafraichir();
  assert.equal(rafraichi, true);
  assert.notEqual(r.image, avant, 'image mise à jour');
  relais.fermer();
  assert.deepEqual(relais.etat(), { actif: false });
});

test('handler qui lève -> erreur propre', async () => {
  relais.ouvrir({
    image: Buffer.from('x'),
    soumettre: async () => {
      throw new Error('page fermée');
    },
  });
  const r = await relais.soumettre('AB');
  assert.equal(r.ok, false);
  assert.equal(r.error, 'page fermée');
  relais.fermer();
});
