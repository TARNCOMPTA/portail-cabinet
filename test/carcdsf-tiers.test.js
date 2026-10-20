// Tests du compte tiers delegataire CARCDSF (src/carcdsf-tiers.js) contre un site FACTICE
// local reproduisant le circuit de l'application adherents.carcdsf.fr : double
// authentification par e-mail, appareil memorise (da), portefeuille, selection d'adherent.
// Ne teste PAS le vrai site (compte reel du cabinet).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

const CODE = '481991';
let codeEnvoye = false; // le faux Graph ne livre le mail qu'apres la demande de code
const ID2FA = 'ID-2FA-42';
const appels = [];
let srv;
let tiers;
let relais;
let boite;

function demarrerSiteFactice() {
  return createServer(async (req, res) => {
    let corps = '';
    for await (const c of req) corps += c;
    const p = new URL(req.url, 'http://localhost').pathname;
    appels.push(`${req.method} ${p}`);
    const json = (o, h = {}) => {
      res.writeHead(200, { 'content-type': 'application/json', ...h });
      res.end(JSON.stringify(o));
    };
    if (p === '/InternetWebServicesNonConnectes/0/internaute/connexion/V1') {
      const b = JSON.parse(corps || '{}');
      if (b.pwd !== 'secret') return json({ codeRetour: 1, codeInterne: 103, libelle: '' });
      if (b.da !== ID2FA) return json({ codeRetour: 0, codeInterne: 0, infos2FA: { email: 'c***@tarncompta.fr', telephone: '', identifiant: ID2FA } });
      return json(
        { codeRetour: 0, codeInterne: 0, signaletiqueAccueil: { matricule: 9, nature: 0, modeDelegataire: true, refDelegataire: 4242 } },
        { authorization: 'Bearer T1' },
      );
    }
    if (p === `/InternetWebServicesNonConnectes/0/internaute/code2FA/V1/${ID2FA}/mail`) {
      codeEnvoye = true;
      return json({ codeRetour: 0, codeInterne: 0 });
    }
    // Faux Microsoft Graph : jeton applicatif + boite des codes.
    if (p === '/00000000-1111-2222-3333-444444444444/oauth2/v2.0/token') return json({ access_token: 'G1', expires_in: 3600 });
    if (p === '/graph/users/caisses%40tarncompta.fr/messages') {
      if (req.headers.authorization !== 'Bearer G1') return json({ error: { message: 'jeton' } });
      return json({
        value: codeEnvoye
          ? [
              {
                subject: 'Votre code de sécurité CARCDSF',
                from: { emailAddress: { address: 'noreply@carcdsf.fr' } },
                body: {
                  content: `Bonjour,\r\n\r\nVeuillez trouver ci-après le code d'authentification à usage unique pour vous connecter sur le portail de la CARCDSF.\r\n\r\n${CODE}\r\n\r\nAttention, ce code est valable seulement 30 minutes.`,
                },
              },
            ]
          : [],
      });
    }
    if (p.startsWith(`/InternetWebServicesNonConnectes/0/internaute/verifiercode2FA/V1/${ID2FA}/`)) return json({ vrai: p.endsWith(`/${CODE}/email`) });
    if (req.headers.authorization !== 'Bearer T1') {
      res.writeHead(401);
      return res.end();
    }
    if (p === '/InternetWebServices/0/internaute/matriculeGere/V1/4242')
      return json({
        listeMatriculesGeres: [
          { entitePicris: 0, matriculeNature: 1234500, nom: 'MALPHETTES', prenom: 'Valérie', titre: 'Mme' },
          { entitePicris: 0, matriculeNature: 5555501, nom: 'NOUVEAU', prenom: 'Paul', titre: 'Dr' },
        ],
      });
    if (p.startsWith('/InternetWebServices/0/internaute/adhGere/V1/')) return json({ codeRetour: 0, codeInterne: 0 });
    res.writeHead(404);
    res.end();
  });
}

before(async () => {
  srv = demarrerSiteFactice();
  await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
  process.env.CARCDSF_BASE_URL = `http://127.0.0.1:${srv.address().port}`;
  process.env.CARCDSF_ATTENTE_CODE_MS = '5000';
  process.env.GRAPH_LOGIN_URL = process.env.CARCDSF_BASE_URL;
  process.env.GRAPH_API_URL = `${process.env.CARCDSF_BASE_URL}/graph`;
  tiers = await import('../src/carcdsf-tiers.js');
  relais = await import('../src/captcha-relais.js');
  boite = await import('../src/boite-codes.js');
  tiers.enregistrerTiers({ effacer: true });
  boite.enregistrerBoite({ effacer: true });
});
after(() => {
  tiers?.enregistrerTiers({ effacer: true });
  boite?.enregistrerBoite({ effacer: true });
  srv?.close();
});

// Saisit des codes dans le bandeau des qu'il s'ouvre (comme le ferait l'utilisateur).
async function saisirQuandDemande(codes) {
  const reponses = [];
  for (let i = 0; i < 100 && !relais.etat().actif; i++) await new Promise((ok) => setTimeout(ok, 20));
  for (const c of codes) reponses.push(await relais.soumettre(c));
  return reponses;
}

test('non configuré : refus explicite', async () => {
  assert.equal(tiers.tiersConfigure(), false);
  await assert.rejects(tiers.ouvrirSessionTiers(), /non configuré/);
});

test('mauvais mot de passe : refus marqué « mdp »', async () => {
  tiers.enregistrerTiers({ login: 'cabinet', password: 'faux', base: 0 });
  await assert.rejects(tiers.ouvrirSessionTiers(), (e) => e.kind === 'mdp' && /incorrect/.test(e.message));
});

test('1re connexion : code demandé dans le bandeau, code faux refusé, bon code accepté, appareil mémorisé', async () => {
  tiers.enregistrerTiers({ password: 'secret' });
  const sessionP = tiers.ouvrirSessionTiers();
  const [faux, bon] = await saisirQuandDemande(['ZZZZZZ', CODE]);
  assert.equal(faux.refuse, true);
  assert.equal(bon.connecte, true);
  const s = await sessionP;
  assert.equal(s.ref, 4242);
  assert.equal(s.H.authorization, 'Bearer T1');
  assert.equal(relais.etat().actif, false, 'bandeau fermé après validation');
  assert.equal(tiers.etatTiers().appareil_memorise, true);
  assert.ok(appels.includes(`POST /InternetWebServicesNonConnectes/0/internaute/code2FA/V1/${ID2FA}/mail`));
});

test('connexion suivante : appareil mémorisé, aucun code demandé', async () => {
  const avant = appels.length;
  const s = await tiers.ouvrirSessionTiers();
  assert.equal(s.ref, 4242);
  assert.ok(!appels.slice(avant).some((a) => a.includes('code2FA')), 'pas de nouvel envoi de code');
});

test('portefeuille + rapprochement : homonyme individuel basculé, nouvel adhérent créé', async () => {
  const s = await tiers.ouvrirSessionTiers();
  const pf = await tiers.listerPortefeuille(s);
  assert.deepEqual(
    pf.map((a) => [a.matriculeNature, a.matricule, a.nom]),
    [
      [1234500, 12345, 'MALPHETTES'],
      [5555501, 55555, 'NOUVEAU'],
    ],
  );
  // Base factice en memoire (meme interface que creer-source-db.js).
  const clients = [{ id: 7, nom: 'MALPHETTES  Valerie', login: 'valou', password: 'x' }];
  const db = {
    getClientByLogin: (l) => clients.find((c) => c.login === l),
    listClients: () => clients,
    remplacerIdentifiants: (id, login, password) =>
      Object.assign(
        clients.find((c) => c.id === id),
        { login, password },
      ),
    createClient: (c) => {
      const n = { id: clients.length + 100, ...c };
      clients.push(n);
      return n;
    },
  };
  assert.equal(tiers.clientPourAdherent(db, pf[0], 0), 7, 'client existant réutilisé (historique conservé)');
  assert.equal(clients[0].login, 'tiers:1234500');
  assert.equal(clients[0].password, '', 'identifiants individuels supprimés');
  const id2 = tiers.clientPourAdherent(db, pf[1], 0);
  assert.equal(clients.find((c) => c.id === id2).login, 'tiers:5555501');
  assert.equal(tiers.clientPourAdherent(db, pf[0], 0), 7, 'idempotent : retrouvé par son login tiers');
  await tiers.selectionnerAdherent(s, 1234500);
  assert.ok(appels.includes('GET /InternetWebServices/0/internaute/adhGere/V1/1234500'));
});

test('client tiers isolé : sélection de l’adhérent puis scraper appelé avec la session et le matricule', async () => {
  let recu = null;
  const scraper = async (creds, opts) => {
    recu = { creds, opts };
    return { ok: true, docs: [], dejaPresents: 2 };
  };
  const r = await tiers.scrapeUnClientTiers(scraper, { id: 7, nom: 'MALPHETTES Valerie', login: 'tiers:1234500', password: '' });
  assert.equal(r.ok, true);
  assert.equal(recu.creds.login, '12345', 'matricule pour le contrôle d’appartenance des PDF');
  assert.deepEqual({ base: recu.opts.session.base, dossier: recu.opts.session.dossier }, { base: 0, dossier: 1234500 });
  assert.equal(recu.opts.session.H.authorization, 'Bearer T1');
  assert.ok(appels.includes('GET /InternetWebServices/0/internaute/adhGere/V1/0'), 'retour au compte délégataire en fin de session');
});

test('boîte des codes configurée : code lu automatiquement, sans saisie dans le bandeau', async () => {
  tiers.enregistrerTiers({ oublier_appareil: true });
  boite.enregistrerBoite({ tenant: '00000000-1111-2222-3333-444444444444', client_id: '00000000-1111-2222-3333-555555555555', client_secret: 'sec' });
  codeEnvoye = false;
  const journal = [];
  const s = await tiers.ouvrirSessionTiers({ log: (m) => journal.push(m) });
  assert.equal(s.ref, 4242);
  assert.ok(
    journal.some((m) => /lu automatiquement/.test(m)),
    journal.join(' | '),
  );
  assert.equal(relais.etat().actif, false, 'bandeau refermé');
  assert.equal(tiers.etatTiers().appareil_memorise, true);
  assert.deepEqual((await boite.testerBoite()).ok, true);
});

test('extraction du code : format réel du mail CARCDSF, expéditeur et objet contrôlés', () => {
  const mail = (de, objet, corps) => ({ from: { emailAddress: { address: de } }, subject: objet, body: { content: corps } });
  const corps =
    "Bonjour,\r\n\r\nVeuillez trouver ci-après le code d'authentification.\r\n\r\n009991\r\n\r\nAttention, ce code est valable seulement 30 minutes.";
  assert.equal(boite.extraireCodeCarcdsf(mail('noreply@carcdsf.fr', 'Votre code de sécurité CARCDSF', corps)), '009991');
  assert.equal(boite.extraireCodeCarcdsf(mail('pirate@exemple.fr', 'Votre code de sécurité CARCDSF', corps)), null, 'autre expéditeur ignoré');
  assert.equal(boite.extraireCodeCarcdsf(mail('noreply@carcdsf.fr', 'Notification de connexion au portail Adhérent CARCDSF', corps)), null);
});

test('rapprochement des noms : une lettre d’écart tolérée (VEYSSIERE / VEYSSIERES), pas davantage', () => {
  const clients = [
    { id: 1, nom: 'VEYSSIERES CHRISTOPHE', login: 'drv' },
    { id: 2, nom: 'MARTEL PAUL', login: 'mp' },
  ];
  const db = {
    getClientByLogin: () => null,
    listClients: () => clients,
    remplacerIdentifiants: (id, login) =>
      Object.assign(
        clients.find((c) => c.id === id),
        { login },
      ),
    createClient: (c) => ({ id: 99, ...c }),
  };
  assert.equal(tiers.clientPourAdherent(db, { matriculeNature: 8367200, matricule: 83672, nom: 'VEYSSIERE', prenom: 'Christophe' }, 0), 1);
  assert.equal(tiers.clientPourAdherent(db, { matriculeNature: 100, matricule: 1, nom: 'MARTIN', prenom: 'Paul' }, 0), 99, 'MARTIN ≠ MARTEL');
});
