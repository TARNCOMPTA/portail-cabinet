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
        "PORTAIL_EMAIL": "ton.email@cabinet.fr",
        "PORTAIL_PASSWORD": "ton-mot-de-passe-portail"
      }
    }
  }
}
```
- `PORTAIL_EMAIL` / `PORTAIL_PASSWORD` = un compte collaborateur du portail (le MCP se connecte avec).
- Redémarrer le client Claude après modification de la config.

## Exemples d'usage (dans le chat)
- « Ajoute le client Dr DUPONT à CARMF, identifiant 226701Y, mot de passe xxxx. »
- « Récupère les documents du client CARPIMKO n°12. »
- « Liste les clients URSSAF qui contiennent “albi”. »
- « Où en est la récupération en cours ? »

> Sécurité : le serveur tourne sur ta machine et n'envoie les identifiants qu'au portail
> (HTTPS). Ne partage pas ta config (elle contient le mot de passe du portail).
