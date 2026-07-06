# Portail Cabinet — Notice d'installation

Le Portail Cabinet récupère automatiquement les documents administratifs des clients
d'un cabinet comptable : **Impôts** (avis CFE/IFER, taxe foncière, messagerie sécurisée),
**URSSAF** (tiers déclarant), **CARPIMKO**, **CARMF**, **CARCDSF** et **CARPV**.
Chaque cabinet installe **son propre portail** sur **son propre serveur**, avec son nom,
son domaine et ses données — rien n'est partagé entre cabinets.

---

## 1. Ce qu'il faut préparer

| Élément                  | Détail                                                                                                                                                                                                  |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Un VPS**               | Ubuntu 22.04 ou 24.04, 2 vCPU / 4 Go de RAM / 40 Go de disque conseillés (OVH, Scaleway, Hetzner…).                                                                                                     |
| **Un nom de domaine**    | Un sous-domaine dédié, ex. `portail.moncabinet.fr`.                                                                                                                                                     |
| **L'enregistrement DNS** | Dans la zone DNS du domaine, créer un enregistrement **A** `portail` → **IP du VPS**. À faire **avant** l'installation (le certificat HTTPS en dépend). Vérifier avec `nslookup portail.moncabinet.fr`. |
| **L'accès SSH au VPS**   | Utilisateur `root` (ou sudo).                                                                                                                                                                           |

Aucun autre logiciel n'est à préparer : le script installe Docker et tout le nécessaire.

## 2. Installation (une commande)

Se connecter au VPS puis lancer :

```bash
ssh root@IP_DU_VPS

curl -fsSL https://raw.githubusercontent.com/TARNCOMPTA/portail-cabinet/main/installation/install.sh -o install.sh
sudo sh install.sh
```

Le script pose 5 questions :

1. **Nom de domaine** du portail (ex. `portail.moncabinet.fr`) ;
2. **E-mail pour le certificat HTTPS** (avis d'expiration Let's Encrypt) ;
3. **E-mail du compte administrateur** (identifiant de connexion au portail) ;
4. **Nom de l'administrateur** ;
5. **Mot de passe administrateur** (8 caractères minimum, saisie masquée).

Puis il enchaîne tout seul : Docker, pare-feu (SSH/80/443), téléchargement du code,
configuration, démarrage (la construction de l'image prend plusieurs minutes la
première fois), certificat HTTPS automatique et création du compte administrateur.

À la fin : **https://portail.moncabinet.fr** est en ligne. ✅

## 3. Premiers pas dans le portail

Se connecter avec le compte administrateur, puis :

1. **Nom du cabinet** — Paramètres ▸ Collaborateurs ▸ **Personnalisation** : saisir le
   nom du cabinet. Il s'affiche partout (barre latérale, page de connexion, icône
   d'onglet, page d'autorisation Claude).
2. **Collaborateurs** — Paramètres ▸ Collaborateurs : créer un compte par membre de
   l'équipe (rôle admin ou collaborateur).
3. **Sources de récupération** :
   - **Impôts** — Paramètres ▸ Comptes Impôts : ajouter le(s) compte(s) « espace
     professionnel » impots.gouv.fr. ⚠️ La connexion impôts demande une **captcha** à
     chaque session : une fenêtre s'ouvre côté serveur, visible via le bouton
     « 🖥️ Captcha » en haut du portail (il ne reste qu'à la saisir).
   - **URSSAF** — Paramètres ▸ Comptes URSSAF : compte tiers déclarant, puis
     « ↻ Synchroniser » pour importer tout le portefeuille.
   - **CARPIMKO / CARMF / CARCDSF / CARPV** — onglet de chaque caisse : un
     identifiant + mot de passe **par client** (ajout manuel ou import CSV).
     Les mots de passe sont chiffrés (AES-256) avec une clé locale au serveur.
4. **Planification** — Paramètres ▸ Planification : jour et heure de récupération
   automatique par organisme (les Impôts ne sont pas automatisables : captcha).
5. **Récupérer** — bouton « Tout récupérer » de chaque source. En cas d'interruption,
   relancer : le portail **reprend au premier dossier non récupéré**.

## 4. Mises à jour

Le portail se met à jour **en un clic, sans toucher au serveur** :

- le numéro de version sous le logo (barre latérale) passe en **couleur** quand une
  mise à jour est publiée : cliquer dessus l'installe (quelques secondes d'interruption) ;
- ou Paramètres ▸ Collaborateurs ▸ **Mise à jour de l'application** ;
- au redémarrage du serveur, la dernière version s'installe automatiquement.

Les données (clients, documents, clés) ne sont jamais touchées par une mise à jour.

## 5. Sauvegardes

Tout l'état du portail tient dans **deux dossiers** du VPS (`/opt/portail`) :

- `data/` — bases SQLite **et la clé de chiffrement `secret.key`** (sans elle, les
  mots de passe clients stockés sont irrécupérables) ;
- `downloads/` — les documents récupérés.

Sauvegarder ces deux dossiers régulièrement, par exemple :

```bash
tar czf portail-sauvegarde-$(date +%F).tar.gz -C /opt/portail data downloads
```

## 6. Connecteur Claude (optionnel)

Le portail peut être ajouté comme **connecteur personnalisé** dans Claude
(claude.ai, niveau organisation) : Paramètres ▸ Collaborateurs ▸ « Connecteur MCP —
organisation » fournit l'URL et les deux clés à coller dans Claude. On peut alors
lister les clients, lancer des récupérations et télécharger des documents depuis
une conversation Claude. ⚠️ Le Client Secret n'est **visible qu'à sa génération** :
le copier immédiatement.

## 7. Dépannage

| Symptôme                                   | Que faire                                                                                                       |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| Le site ne répond pas après l'installation | `cd /opt/portail && sudo docker compose logs app --tail 50`                                                     |
| Erreur de certificat HTTPS                 | Vérifier que le DNS pointe bien vers le VPS (`nslookup domaine`), puis `sudo docker compose restart caddy`.     |
| Récupération impôts bloquée                | Cliquer sur « 🖥️ Captcha » en haut du portail et saisir la captcha dans la fenêtre.                             |
| Compte caisse marqué 🔒                    | Le site de la caisse a refusé le mot de passe : le corriger dans la fiche client (verrou levé automatiquement). |
| Redémarrer le portail                      | `cd /opt/portail && sudo docker compose restart`                                                                |
| Tout reconstruire (sans perte de données)  | `cd /opt/portail && sudo docker compose up -d --build`                                                          |

## 8. Ce que le portail ne partage jamais

Chaque installation est **totalement autonome** : les identifiants, documents et bases
restent sur le VPS du cabinet. Les mises à jour sont téléchargées depuis GitHub
(vérifiées par empreinte SHA-256) — aucune donnée ne remonte vers l'éditeur.

Le portail est distribué sous **licence MIT** (logiciel libre, fourni sans garantie) —
voir le fichier `LICENSE` du dépôt.
