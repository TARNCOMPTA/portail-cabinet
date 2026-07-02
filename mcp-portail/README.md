# MCP « Portail Cabinet »

Serveur MCP pour piloter le Portail Cabinet (clients + récupérations) **depuis un chat Claude**
(Claude Desktop, Claude Code…). Il dialogue avec l'API HTTP du portail.

## Outils exposés

- **lister_clients** — liste/recherche les clients d'un organisme (impots, urssaf, carpimko, carmf).
- **ajouter_client** — enregistre un nouveau client.
  - carpimko / carmf : `identifiant` = identifiant de connexion + `mot_de_passe` (obligatoire).
  - impots / urssaf : `identifiant` = SIRET/SIREN (+ `cabinet_id` pour le rattacher à un compte).
- **recuperer_documents** — lance la récupération des documents d'un client (par `client_id`).
- **etat_recuperation** — avancement de la récupération en cours.

## Installation

```bash
cd mcp-portail
npm install
```

## Authentification : clé API (recommandé)

Dans le portail, va dans **Paramètres ▸ Collaborateurs ▸ Clé API (MCP)** (admin) puis
**Régénérer la clé** et copie-la. Cette clé est révocable et distincte des mots de passe
des comptes — c'est la méthode recommandée.

## Configuration du client Claude

Ajouter ce serveur dans la config MCP (ex. Claude Desktop : `claude_desktop_config.json`) :

```json
{
  "mcpServers": {
    "portail-cabinet": {
      "command": "node",
      "args": ["X:/portail-cabinet/mcp-portail/index.mjs"],
      "env": {
        "PORTAIL_URL": "https://portail.tarncompta.fr",
        "PORTAIL_API_KEY": "la-cle-generee-dans-le-portail"
      }
    }
  }
}
```

- `PORTAIL_API_KEY` = clé générée dans le portail (en-tete `X-API-Key`).
- Repli possible sans clé : `PORTAIL_EMAIL` + `PORTAIL_PASSWORD` (compte collaborateur).
- Redémarrer le client Claude après modification de la config.
- Pour **Claude Code** : `claude mcp add portail-cabinet -s user -e PORTAIL_URL=https://portail.tarncompta.fr -e PORTAIL_API_KEY=la-cle -- node X:/portail-cabinet/mcp-portail/index.mjs`

## Exemples d'usage (dans le chat)

- « Ajoute le client Dr DUPONT à CARMF, identifiant 226701Y, mot de passe xxxx. »
- « Récupère les documents du client CARPIMKO n°12. »
- « Liste les clients URSSAF qui contiennent “albi”. »
- « Où en est la récupération en cours ? »

> Sécurité : le serveur tourne sur ta machine et n'envoie les identifiants qu'au portail
> (HTTPS). Ne partage pas ta config (elle contient le mot de passe du portail).
