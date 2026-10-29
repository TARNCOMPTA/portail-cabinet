// Test de la detection d'une « deconnexion » URSSAF (src/scraper-urssaf.js) : au lieu du
// tableau de bord, la SSO renvoie vers login.urssaf.fr/api/oauth/v1/providerLogin
// (reboucle qu'un rechargement ne resout pas ; un retour sur tdbec/accueil, si).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { surDemandeAuthentification } from '../src/scraper-urssaf.js';

test('surDemandeAuthentification : detecte le rebouclage vers une nouvelle demande OAuth', () => {
  assert.equal(
    surDemandeAuthentification(
      'https://login.urssaf.fr/api/oauth/v1/providerLogin?requestOrigin=response_type%3Dcode%26client_id%3DTDBEC-FE&redirect_uri=https%3A%2F%2Ftdbec.urssaf.fr%2Fcallback',
    ),
    true,
  );
});

test('surDemandeAuthentification : ne declenche pas sur le tableau de bord ou la connexion initiale', () => {
  assert.equal(surDemandeAuthentification('https://tdbec.urssaf.fr/accueil'), false);
  assert.equal(surDemandeAuthentification('https://www.urssaf.fr/accueil/se-connecter.html'), false);
  assert.equal(surDemandeAuthentification(''), false);
  assert.equal(surDemandeAuthentification(undefined), false);
});
