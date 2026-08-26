// Tests des garde-fous OAuth (src/oauth.js). Trois failles, trouvees par audit, sont
// couvertes ici — ce sont exactement les points ou une regression redonne un acces :
//   1. injection HTML dans la page de consentement (nom de parametre non echappe) ;
//   2. enregistrement d'un client dont l'URL de retour part chez un tiers ;
//   3. jeton d'un collaborateur desactive toujours accepte.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { pageAutorisation, uriDeConfiance, esc, requireBearer, CALLBACK_HOSTE } from '../src/oauth.js';
import * as oauthDb from '../src/oauth-db.js';
import { createUser, setUserActif, deleteUser } from '../src/db.js';

// ---- 1. Injection HTML dans la page de consentement ------------------------

test('esc neutralise tous les caracteres dangereux', () => {
  assert.equal(esc(`<img src=x onerror=alert(1)>`), '&lt;img src=x onerror=alert(1)&gt;');
  assert.equal(esc(`a"b'c&d`), 'a&quot;b&#39;c&amp;d');
  assert.equal(esc(null), '');
});

test('un NOM de parametre hostile ne peut plus produire de balisage', () => {
  // Le vecteur reel : `name="${k}"` interpolait la cle brute. Une cle contenant une
  // fermeture d'attribut refermait l'input et ouvrait une balise active.
  const html = pageAutorisation(null, {
    client_id: 'dcr-abc',
    '"><img src=x id=audit-marker onerror=alert(1)>': '1',
  });
  assert.ok(!html.includes('audit-marker'), 'le parametre inconnu ne doit pas ressortir du tout');
  assert.ok(!html.includes('<img'), 'aucune balise injectee');
  assert.ok(html.includes('name="client_id" value="dcr-abc"'), 'les champs OAuth legitimes restent presents');
});

test('une VALEUR hostile est echappee, pas seulement ses guillemets', () => {
  const html = pageAutorisation(null, { state: `"><script>alert(1)</script>` });
  assert.ok(!html.includes('<script>alert(1)</script>'), 'pas de script actif');
  assert.ok(html.includes('&quot;&gt;&lt;script&gt;'), 'la valeur ressort echappee');
});

test('seuls les parametres OAuth attendus sont recopies', () => {
  const html = pageAutorisation(null, {
    client_id: 'c',
    response_type: 'code',
    redirect_uri: CALLBACK_HOSTE,
    code_challenge: 'ch',
    code_challenge_method: 'S256',
    state: 'st',
    scope: 'mcp',
    resource: 'r',
    parametre_inconnu: 'x',
    email: 'a@b.fr',
    password: 'secret',
  });
  for (const k of ['client_id', 'response_type', 'redirect_uri', 'code_challenge', 'code_challenge_method', 'state', 'scope', 'resource']) {
    assert.ok(html.includes(`name="${k}"`), `${k} doit etre conserve (le POST le relit)`);
  }
  assert.ok(!html.includes('parametre_inconnu'), 'les parametres inconnus sont ignores');
  assert.ok(!html.includes('secret'), 'le mot de passe n’est JAMAIS recopie en champ cache');
  assert.ok(!html.includes('name="email"' + ' value='), 'l’e-mail non plus');
});

// ---- 2. URL de retour d'un client enregistre dynamiquement ------------------

test('uriDeConfiance accepte Claude et la boucle locale, rien d’autre', () => {
  assert.ok(uriDeConfiance(CALLBACK_HOSTE));
  assert.ok(uriDeConfiance('http://localhost:54321/callback'));
  assert.ok(uriDeConfiance('http://127.0.0.1:9999/callback'));

  assert.ok(!uriDeConfiance('https://attaquant.example/cb'), 'domaine tiers refuse');
  assert.ok(!uriDeConfiance('https://claude.ai.attaquant.example/cb'), 'domaine ressemblant refuse');
  assert.ok(!uriDeConfiance('http://localhost:3000/autre'), 'chemin non /callback refuse');
  assert.ok(!uriDeConfiance('http://127.0.0.1.attaquant.example/callback'), 'hote suffixe refuse');
  assert.ok(!uriDeConfiance('pas une url'), 'chaine invalide refusee');
  assert.ok(!uriDeConfiance(''), 'vide refuse');
  assert.ok(!uriDeConfiance(undefined), 'absent refuse');
});

// ---- 3. Revocation : jeton d'un collaborateur desactive ---------------------

let userId;
const CLIENT_ID = 'dcr-zztest-oauth';
const ACCESS = 'zztest-access-' + oauthDb.rnd(8);

before(() => {
  const u = createUser({ email: `zztest-oauth-${oauthDb.rnd(6)}@local.test`, nom: 'ZZTest OAuth', password_hash: 'x', role: 'membre' });
  userId = u.id;
  oauthDb.createClient({ client_id: CLIENT_ID, client_secret: null, redirect_uris: [CALLBACK_HOSTE], name: 'ZZTest', statique: 0 });
  oauthDb.saveToken({
    access_token: ACCESS,
    refresh_token: 'zztest-refresh',
    client_id: CLIENT_ID,
    user_id: userId,
    scope: 'mcp',
    expires_at: Date.now() + 60_000,
  });
});
after(() => {
  oauthDb.supprimerClient(CLIENT_ID);
  if (userId) deleteUser(userId);
});

// Faux couple req/res : requireBearer n'a besoin que de l'en-tete et du code de statut.
function appeler(token) {
  const req = { headers: { authorization: `Bearer ${token}`, host: 'test.local' } };
  let statut = 0;
  const res = {
    status(c) {
      statut = c;
      return res;
    },
    set: () => res,
    json: () => res,
  };
  let passe = false;
  requireBearer(req, res, () => {
    passe = true;
  });
  return { passe, statut };
}

test('un jeton valide d’un collaborateur actif passe', () => {
  const r = appeler(ACCESS);
  assert.equal(r.passe, true);
});

test('le meme jeton est refuse des que le collaborateur est desactive', () => {
  setUserActif(userId, 0);
  const r = appeler(ACCESS);
  assert.equal(r.passe, false, 'le connecteur d’un compte desactive doit etre coupe');
  assert.equal(r.statut, 401);
  setUserActif(userId, 1);
  assert.equal(appeler(ACCESS).passe, true, 'et rouvert si le compte est reactive');
});

test('le jeton est refuse si son client a ete supprime', () => {
  oauthDb.supprimerClient(CLIENT_ID);
  const r = appeler(ACCESS);
  assert.equal(r.passe, false);
  assert.equal(r.statut, 401);
  // remis en place pour ne pas dependre de l'ordre des tests
  oauthDb.createClient({ client_id: CLIENT_ID, client_secret: null, redirect_uris: [CALLBACK_HOSTE], name: 'ZZTest', statique: 0 });
  oauthDb.saveToken({
    access_token: ACCESS,
    refresh_token: 'zztest-refresh',
    client_id: CLIENT_ID,
    user_id: userId,
    scope: 'mcp',
    expires_at: Date.now() + 60_000,
  });
});

test('supprimerClient emporte les jetons du client', () => {
  assert.ok(oauthDb.getByAccess(ACCESS), 'le jeton existe avant');
  oauthDb.supprimerClient(CLIENT_ID);
  assert.ok(!oauthDb.getByAccess(ACCESS), 'et disparait avec son client');
});
