# Intégration n8n (et autres outils d'automatisation)

Le portail s'intègre à n8n dans les deux sens :

1. **Webhook sortant** — le portail notifie n8n à la fin de chaque récupération (bilan JSON) ;
2. **API entrante** — n8n appelle l'API REST du portail (clients, documents, récupérations…).

---

## 1. Webhook sortant (le portail → n8n)

### Configuration

1. Dans n8n : créer un workflow commençant par un nœud **Webhook** (méthode POST) et copier son URL.
2. Dans le portail : **Paramètres ▸ Collaborateurs ▸ Intégration n8n** → coller l'URL, éventuellement définir un **secret partagé**, Enregistrer puis **« Envoyer un test »**.
3. Dans n8n, vérifier la réception du test, puis passer le webhook en production.

Si un secret est défini, chaque appel porte l'en-tête `X-Webhook-Secret` — à vérifier dans
n8n (nœud IF) pour refuser les appels étrangers.

### Événement `recuperation_terminee`

Envoyé à la fin de **chaque** récupération (lot planifié, « Tout récupérer », ou client
individuel) :

```json
{
  "evenement": "recuperation_terminee",
  "date": "2026-07-08T02:41:12.000Z",
  "cabinet": "Tarn Compta",
  "portail": "https://portail.tarncompta.fr",
  "source": "urssaf",
  "demarre_le": "2026-07-08T02:00:00.000Z",
  "fini_le": "2026-07-08T02:41:12.000Z",
  "clients_traites": 269,
  "succes": 265,
  "echecs": 4,
  "nouveaux_documents": 37,
  "nouveaux_documents_detail": [{ "id": 1748, "client": "MR BARTHE GHISLAIN", "libelle": "16/06/2026 — Régularisation de vos cotisations" }],
  "echecs_detail": [{ "nom": "SARL X", "message": "Aucun client trouve (…)" }]
}
```

`source` : `impots` | `urssaf` | `carpimko` | `carmf` | `carcdsf` | `carpv`.
`echecs_detail` est plafonné à 50 entrées, `nouveaux_documents_detail` à 200 (id
utilisable avec `GET /api/<source>/documents/:id/file` pour télécharger le PDF). L'événement `test` (bouton « Envoyer un
test ») porte la même enveloppe avec `"evenement": "test"`.

Idées de workflows : e-mail/Teams de synthèse après la tournée nocturne, alerte si
`echecs > 0`, création de tâches pour les clients en échec, archivage GED des nouveaux
documents (via l'API ci-dessous).

---

## 2. API entrante (n8n → le portail)

### Authentification

Générer la **clé API** dans Paramètres ▸ Collaborateurs ▸ « Clé API (MCP) » (elle n'est
visible qu'à la génération). Dans n8n, nœud **HTTP Request** avec un en-tête :

```
X-API-Key: <la clé>
```

Base : `https://portail.tarncompta.fr/api` (adapter au domaine du cabinet). La clé donne
un accès complet — la stocker dans un credential n8n, jamais en clair dans le workflow.

### Endpoints principaux

Sources : `impots` (préfixe `/api`), `urssaf` (`/api/urssaf`), caisses
(`/api/carpimko`, `/api/carmf`, `/api/carcdsf`, `/api/carpv`).

| Méthode | URL                                                                       | Rôle                                                             |
| ------- | ------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| GET     | `/api/clients` · `/api/urssaf/clients` · `/api/<caisse>/clients`          | Liste des clients (nom, SIRET/identifiant, nb docs, dernier run) |
| GET     | `/api/documents` · `/api/urssaf/documents` · `/api/<caisse>/documents`    | Tous les documents de la source                                  |
| GET     | `/api/clients/:id/documents` (idem par source)                            | Documents d'un client                                            |
| GET     | `/api/urssaf/documents/:id/file` (idem par source)                        | Télécharger le PDF d'un document                                 |
| POST    | `/api/documents/zip` `{items:[{source,id}]}`                              | ZIP en masse (rangé par client)                                  |
| POST    | `/api/clients/:id/scrape` (impôts : `{cfe,tf,messagerie}`)                | Lancer la récupération d'un client                               |
| POST    | `/api/scrape-all` · `/api/urssaf/scrape-all` · `/api/<caisse>/scrape-all` | Tout récupérer (reprise automatique intégrée)                    |
| GET     | `/api/progress`                                                           | Avancement de la récupération en cours                           |
| GET     | `/api/runs` · `/api/urssaf/runs` · `/api/<caisse>/runs`                   | Historique des récupérations                                     |
| GET     | `/api/messages`                                                           | Messages de la messagerie impôts                                 |
| GET     | `/api/liste-noire` · `/api/urssaf/liste-noire`                            | Clients en liste noire                                           |

Notes : la récupération **impôts** exige la saisie manuelle d'une captcha dans le
portail — un `POST /api/scrape-all` impôts démarre la session mais attend un humain ;
les récupérations URSSAF/caisses sont entièrement automatiques. Les réponses des
`scrape-all` sont immédiates (`{started:true,…}`) : suivre via `/api/progress` ou
attendre le webhook `recuperation_terminee`.
