// Fenetre de recuperation : annee en cours + 2 precedentes (src/scraper-commun.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { anneeMinimale, anneeDe, dansPeriode } from '../src/scraper-commun.js';

const REF = new Date('2026-10-20');

test('anneeMinimale : annee en cours - 2', () => {
  assert.equal(anneeMinimale(REF), 2024);
});

test('anneeDe : dates FR, ISO et libelles', () => {
  assert.equal(anneeDe('15/03/2025'), 2025);
  assert.equal(anneeDe('2024-05-02 Appel'), 2024);
  assert.equal(anneeDe('Avis CFE 2023 123456789012'), 2023);
  assert.equal(anneeDe(''), null);
  assert.equal(anneeDe(null), null);
});

test('dansPeriode : garde 2024-2026, ecarte avant, garde si annee inconnue', () => {
  assert.equal(dansPeriode('01/01/2026', REF), true);
  assert.equal(dansPeriode('31/12/2024', REF), true);
  assert.equal(dansPeriode('31/12/2023', REF), false);
  assert.equal(dansPeriode('sans date', REF), true);
  assert.equal(dansPeriode(null, REF), true);
});
