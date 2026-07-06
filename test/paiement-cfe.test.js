// Tests de la détection du mode de paiement sur les avis CFE (src/validation-pdf.js).
// Les extraits reprennent les formulations RÉELLES des avis 2021-2025 : tous les avis
// embarquent une FAQ générique citant mensualisation et prélèvement à l'échéance —
// seules les mentions personnalisées doivent être prises en compte.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detecterPaiementCfe } from '../src/validation-pdf.js';

// FAQ présente sur TOUS les avis (mensualisés, à l'échéance ou sans prélèvement) :
// elle ne doit JAMAIS suffire à classer un avis.
const FAQ_GENERIQUE =
  '… résilier votre contrat de mensualisation ? comment signaler un changement de coordonnées bancaires ? ' +
  '… modifier le montant de vos prélèvements mensuels ? … suspendre vos prélèvements mensuels ? vous êtes mensualisé et vous souhaitez ... ' +
  'le prélèvement à l’échéance avantages : – vos impôts sont prélevés automatiquement sur le compte bancaire de votre choix. ' +
  'quand ? si vous adhérez d’ici le 30 novembre, votre impôt sera payé par prélèvement automatique.';

test('prélèvement à l’échéance : mention personnalisée « vous avez choisi »', () => {
  assert.equal(
    detecterPaiementCfe(
      `votre paiement ou remboursement vous avez choisi le prélèvement à l'échéance. le montant à payer sera prélevé le 27/12/2023. ${FAQ_GENERIQUE}`,
    ),
    'echeance',
  );
  assert.equal(detecterPaiementCfe(`Vous avez opté pour le PRÉLÈVEMENT À L’ÉCHÉANCE. ${FAQ_GENERIQUE}`), 'echeance');
});

test('mensualisé : contrat de mensualisation ou contrat de prélèvement mensuel', () => {
  assert.equal(detecterPaiementCfe(`contrat de mensualisation au nom de PARRE FLORIANE 15 décembre 2025. ${FAQ_GENERIQUE}`), 'mensualise');
  assert.equal(detecterPaiementCfe(`numéro de contrat de prélèvement mensuel : m0 81 0000056 91. ${FAQ_GENERIQUE}`), 'mensualise');
  assert.equal(detecterPaiementCfe(`vous avez opté pour le prélèvement mensuel. ${FAQ_GENERIQUE}`), 'mensualise');
});

test('l’avis à l’échéance a un « numéro de contrat de prélèvement » SANS « mensuel » — pas mensualisé', () => {
  assert.equal(
    detecterPaiementCfe(`numéro de contrat de prélèvement : p0 81 0021051 95. vous avez choisi le prélèvement à l'échéance. ${FAQ_GENERIQUE}`),
    'echeance',
  );
});

test('pas de prélèvement automatique (les invitations à adhérer ne comptent pas)', () => {
  assert.equal(
    detecterPaiementCfe(
      `à ce jour, vous n'avez pas adhéré à un prélèvement automatique. vous pouvez payer en optant pour le prélèvement à l'échéance d'ici au 30 novembre minuit. ${FAQ_GENERIQUE}`,
    ),
    'aucun',
  );
});

test('FAQ générique seule (aucune mention personnalisée) : rien de détectable', () => {
  assert.equal(detecterPaiementCfe(FAQ_GENERIQUE), null);
  assert.equal(detecterPaiementCfe('Avis de taxe foncière — propriétés bâties.'), null);
  assert.equal(detecterPaiementCfe(''), null);
  assert.equal(detecterPaiementCfe(null), null);
});
