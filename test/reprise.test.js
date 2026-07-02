// Tests de la reprise des récupérations interrompues (src/reprise.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filtrerReprise, REPRISE_HEURES } from '../src/reprise.js';

// dernier_run au format SQLite (UTC) : « AAAA-MM-JJ HH:MM:SS ».
const ilYa = (heures) => new Date(Date.now() - heures * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ');

test('filtrerReprise : saute les succès récents, garde le reste', () => {
  const clients = [
    { id: 1, nom: 'Jamais récupéré' },
    { id: 2, nom: 'Succès récent', dernier_statut: 'succes', dernier_run: ilYa(1) },
    { id: 3, nom: 'Succès ancien', dernier_statut: 'succes', dernier_run: ilYa(REPRISE_HEURES + 5) },
    { id: 4, nom: 'Échec récent', dernier_statut: 'echec', dernier_run: ilYa(1) },
  ];
  const { aFaire, ignores } = filtrerReprise(clients);
  assert.deepEqual(aFaire.map((c) => c.id).sort(), [1, 3, 4], 'seul le succès récent est sauté');
  assert.equal(ignores, 1);
});

test('filtrerReprise : jamais récupérés en premier, puis du plus ancien au plus récent', () => {
  const clients = [
    { id: 1, dernier_statut: 'echec', dernier_run: ilYa(2) },
    { id: 2 },
    { id: 3, dernier_statut: 'succes', dernier_run: ilYa(REPRISE_HEURES + 10) },
  ];
  const { aFaire } = filtrerReprise(clients);
  assert.deepEqual(
    aFaire.map((c) => c.id),
    [2, 3, 1],
  );
});

test('filtrerReprise : si tout a été récupéré récemment, on refait tout', () => {
  const clients = [
    { id: 1, dernier_statut: 'succes', dernier_run: ilYa(1) },
    { id: 2, dernier_statut: 'succes', dernier_run: ilYa(2) },
  ];
  const { aFaire, ignores } = filtrerReprise(clients);
  assert.equal(aFaire.length, 2);
  assert.equal(ignores, 0);
});

test('filtrerReprise : liste vide', () => {
  const { aFaire, ignores } = filtrerReprise([]);
  assert.deepEqual(aFaire, []);
  assert.equal(ignores, 0);
});
