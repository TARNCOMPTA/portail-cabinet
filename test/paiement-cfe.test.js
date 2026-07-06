// Tests de la détection du mode de paiement sur les avis CFE (src/validation-pdf.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detecterPaiementCfe } from '../src/validation-pdf.js';

test('prélèvement à l’échéance (majuscules accentuées, apostrophe typographique)', () => {
  assert.equal(detecterPaiementCfe('Mode de paiement : PRÉLÈVEMENT À L’ÉCHÉANCE'), 'echeance');
  assert.equal(detecterPaiementCfe("vous êtes prélevé à l'échéance de décembre"), 'echeance');
  assert.equal(detecterPaiementCfe('PRELEVEMENTS A L ECHEANCE'), 'echeance');
});

test('mensualisation / mensualisé', () => {
  assert.equal(detecterPaiementCfe('Vous avez opté pour la MENSUALISATION.'), 'mensualise');
  assert.equal(detecterPaiementCfe('vous êtes mensualisé'), 'mensualise');
});

test('pas de prélèvement automatique (prioritaire sur les invitations à adhérer)', () => {
  assert.equal(detecterPaiementCfe("Vous n'avez pas adhéré à un prélèvement automatique."), 'aucun');
  // Un avis « sans prélèvement » invite souvent à adhérer à la mensualisation OU au
  // prélèvement à l'échéance : la mention « pas adhéré » doit gagner.
  assert.equal(
    detecterPaiementCfe(
      'Vous n’avez pas adhéré à un prélèvement automatique. Pensez à adhérer à la mensualisation ou au prélèvement à l’échéance avant le 30/11.',
    ),
    'aucun',
  );
});

test('rien de détectable', () => {
  assert.equal(detecterPaiementCfe('Avis de taxe foncière — propriétés bâties.'), null);
  assert.equal(detecterPaiementCfe(''), null);
  assert.equal(detecterPaiementCfe(null), null);
});
