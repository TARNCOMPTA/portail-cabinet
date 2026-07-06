# Portail Cabinet

**Le portail qui récupère automatiquement les documents administratifs des clients d'un cabinet comptable.**

Chaque cabinet installe **son propre portail** sur **son propre serveur**, avec son nom, son
domaine et ses données. Rien n'est partagé entre cabinets, rien ne remonte vers l'éditeur.

| Organisme                              | Documents récupérés                                | Automatisable ?                                                                |
| -------------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------ |
| **Impôts** (espace pro impots.gouv.fr) | Avis CFE/IFER, taxe foncière, messagerie sécurisée | Semi-auto (captcha à saisir une fois par session, directement dans le portail) |
| **URSSAF** (tiers déclarant)           | Documents du portefeuille clients                  | ✅ Oui, planifiable                                                            |
| **CARPIMKO**                           | Documents des clients (1 identifiant par client)   | ✅ Oui, planifiable                                                            |
| **CARMF**                              | Documents des clients                              | ✅ Oui, planifiable                                                            |
| **CARCDSF**                            | Documents des clients                              | ✅ Oui, planifiable                                                            |
| **CARPV**                              | Documents des clients                              | ✅ Oui, planifiable                                                            |

**Dans la boîte :** multi-utilisateurs (admin / collaborateurs), planification par organisme,
reprise après interruption, anti-doublon, mots de passe chiffrés (AES-256, clé locale au serveur),
mises à jour **en un clic** depuis le portail, HTTPS automatique (Let's Encrypt), et un
**connecteur Claude (MCP)** optionnel pour piloter le portail depuis une conversation Claude.

---

## Installation pas à pas (pour les nuls)

> Aucune connaissance en informatique serveur n'est nécessaire : on loue un petit serveur,
> on crée une adresse web, on colle **une commande**, on répond à **5 questions**. C'est tout.

### Étape 0 — Les 3 ingrédients

1. **Un VPS** : un petit serveur loué chez un hébergeur (≈ 5–10 €/mois). C'est un ordinateur
   allumé 24 h/24 quelque part en France/Europe, sur lequel le portail va tourner.
2. **Un nom de domaine** : l'adresse web du cabinet (ex. `moncabinet.fr`). Vous en avez
   sûrement déjà un (celui de votre site ou de vos e-mails).
3. **Un sous-domaine** : l'adresse du portail, ex. `portail.moncabinet.fr`. C'est gratuit,
   ça se crée en 2 minutes dans la zone DNS du domaine (étape 2).

### Étape 1 — Louer le VPS

Chez **OVH**, **Scaleway** ou **Hetzner** par exemple, commander un VPS avec :

- **Ubuntu 24.04** (ou 22.04) comme système ;
- **2 vCPU, 4 Go de RAM, 40 Go de disque** conseillés.

À la fin de la commande, l'hébergeur envoie par e-mail : **l'adresse IP** du serveur
(4 nombres, ex. `51.83.12.34`) et le **mot de passe root**. Gardez cet e-mail.

### Étape 2 — Créer le sous-domaine (DNS)

Dans l'interface de votre hébergeur de domaine (ex. OVH ▸ Domaines ▸ `moncabinet.fr` ▸
**Zone DNS** ▸ Ajouter une entrée) :

- Type : **A**
- Sous-domaine : `portail`
- Cible : **l'adresse IP du VPS** (celle de l'étape 1)

⚠️ **À faire AVANT l'installation** : le certificat HTTPS (le cadenas 🔒) en dépend.
La propagation peut prendre de quelques minutes à 1 h. Pour vérifier depuis votre PC,
ouvrir un terminal (Windows : touche Windows ▸ taper `powershell` ▸ Entrée) et taper :

```
nslookup portail.moncabinet.fr
```

→ la réponse doit afficher l'IP du VPS. Tant que ce n'est pas le cas, attendre.

### Étape 3 — Se connecter au serveur

Toujours dans PowerShell (ou un terminal Mac/Linux) :

```bash
ssh root@51.83.12.34
```

(remplacer par **votre** IP). À la première connexion, répondre `yes` à la question de
sécurité, puis saisir le **mot de passe root** reçu par e-mail — _l'écran n'affiche rien
pendant la frappe, c'est normal_. Certains hébergeurs demandent de changer le mot de passe
à la première connexion : suivre les instructions.

Vous êtes maintenant « dans » le serveur : les commandes suivantes s'y tapent directement.

### Étape 4 — Installer le portail (une seule commande)

Copier-coller ces deux lignes puis Entrée :

```bash
curl -fsSL https://raw.githubusercontent.com/TARNCOMPTA/portail-cabinet/main/installation/install.sh -o install.sh
sudo sh install.sh
```

Le script pose **5 questions** :

| #   | Question                                                          | Exemple de réponse          |
| --- | ----------------------------------------------------------------- | --------------------------- |
| 1   | Nom de domaine du portail                                         | `portail.moncabinet.fr`     |
| 2   | E-mail pour le certificat HTTPS                                   | `contact@moncabinet.fr`     |
| 3   | E-mail du compte administrateur                                   | `jean.dupont@moncabinet.fr` |
| 4   | Nom de l'administrateur                                           | `Jean Dupont`               |
| 5   | Mot de passe administrateur (8 caractères min., saisie invisible) | —                           |

Puis il fait **tout** tout seul : installation de Docker, ouverture du pare-feu,
téléchargement du code, configuration, démarrage (la première construction prend
**plusieurs minutes**, c'est normal), certificat HTTPS et création du compte admin.

À la fin s'affiche :

```
  Installation terminée !
  Portail   : https://portail.moncabinet.fr
```

### Étape 5 — Premiers pas dans le portail

Ouvrir **https://portail.moncabinet.fr** dans le navigateur et se connecter avec le
compte administrateur, puis dans l'ordre :

1. **Nom du cabinet** — Paramètres ▸ Collaborateurs ▸ **Personnalisation** : il s'affiche
   partout (barre latérale, page de connexion, icône d'onglet).
2. **Collaborateurs** — Paramètres ▸ Collaborateurs : un compte par membre de l'équipe
   (rôle admin ou collaborateur).
3. **Sources** :
   - **Impôts** — Paramètres ▸ Comptes Impôts : ajouter le(s) compte(s) espace pro.
     La connexion demande une **captcha** : cliquer sur « 🖥️ Captcha » en haut du portail
     et la saisir dans la fenêtre, le robot enchaîne ensuite tout seul.
   - **URSSAF** — Paramètres ▸ Comptes URSSAF : compte tiers déclarant, puis
     « ↻ Synchroniser » pour importer tout le portefeuille.
   - **CARPIMKO / CARMF / CARCDSF / CARPV** — onglet de chaque caisse : identifiant +
     mot de passe **par client** (manuel ou import CSV). Mots de passe chiffrés.
4. **Planification** — Paramètres ▸ Planification : jour et heure de récupération
   automatique par organisme (sauf Impôts : captcha oblige).
5. **Récupérer** — bouton « Tout récupérer ». En cas d'interruption, relancer :
   le portail **reprend au premier dossier non récupéré**.

📄 Notice détaillée : [installation/NOTICE-INSTALLATION.md](installation/NOTICE-INSTALLATION.md)

---

## Paramètres

La configuration du serveur tient dans un fichier **`.env`** à côté de
`docker-compose.yml` (le script d'installation le crée automatiquement — on n'y touche
que pour changer quelque chose). Modèle : [.env.exemple](.env.exemple).

| Variable     | Rôle                                                   | Défaut                          |
| ------------ | ------------------------------------------------------ | ------------------------------- |
| `DOMAIN`     | Nom de domaine du portail (certificat HTTPS)           | `portail.tarncompta.fr`         |
| `PUBLIC_URL` | URL publique complète (connecteur Claude/MCP)          | `https://portail.tarncompta.fr` |
| `ACME_EMAIL` | E-mail Let's Encrypt (avis d'expiration du certificat) | `aymeric@tarncompta.fr`         |

Après modification : `cd /opt/portail && sudo docker compose up -d` pour appliquer.

Variables avancées (déjà réglées dans `docker-compose.yml`, à modifier seulement si besoin) :

| Variable                                                                                           | Rôle                                                                            | Défaut        |
| -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | ------------- |
| `PORT`                                                                                             | Port interne de l'application                                                   | `3000`        |
| `NAV_TIMEOUT`                                                                                      | Délai max (ms) d'attente des pages des organismes                               | `60000`       |
| `REMOTE_BROWSER`                                                                                   | `1` = vue du navigateur serveur dans le portail (saisie captcha)                | `1`           |
| `SCHEDULE`                                                                                         | `1` = planificateur activé (Paramètres ▸ Planification)                         | `1`           |
| `SCHEDULE_URSSAF` / `SCHEDULE_CARPIMKO` / `SCHEDULE_CARMF` / `SCHEDULE_CARCDSF` / `SCHEDULE_CARPV` | Activer/désactiver la planification d'un organisme                              | `1`           |
| `UPDATE_DISABLED`                                                                                  | `1` = désactive la mise à jour en un clic (retour au mode `git pull` + rebuild) | _(désactivé)_ |
| `HEADLESS`                                                                                         | `false` = navigateur du robot visible (débogage local)                          | `true`        |

## Mises à jour

Le portail se met à jour **en un clic, sans toucher au serveur** : le numéro de version
sous le logo passe en couleur quand une mise à jour est publiée → cliquer dessus.
(Également : Paramètres ▸ Collaborateurs ▸ Mise à jour de l'application, et installation
automatique de la dernière version au redémarrage du serveur.)

Les mises à jour sont téléchargées depuis GitHub et **vérifiées par empreinte SHA-256**.
Les données (clients, documents, clés) ne sont jamais touchées.

## Sauvegardes

Tout l'état du portail tient dans **deux dossiers** du VPS (`/opt/portail`) :

- `data/` — bases SQLite **et la clé de chiffrement `secret.key`** (sans elle, les mots
  de passe clients stockés sont irrécupérables) ;
- `downloads/` — les documents récupérés.

```bash
tar czf portail-sauvegarde-$(date +%F).tar.gz -C /opt/portail data downloads
```

## Dépannage

| Symptôme                                   | Que faire                                                                      |
| ------------------------------------------ | ------------------------------------------------------------------------------ |
| Le site ne répond pas après l'installation | `cd /opt/portail && sudo docker compose logs app --tail 50`                    |
| Erreur de certificat HTTPS                 | Vérifier le DNS (`nslookup domaine`), puis `sudo docker compose restart caddy` |
| Récupération impôts bloquée                | Cliquer sur « 🖥️ Captcha » en haut du portail et saisir la captcha             |
| Compte caisse marqué 🔒                    | Mot de passe refusé par la caisse : le corriger dans la fiche client           |
| Redémarrer le portail                      | `cd /opt/portail && sudo docker compose restart`                               |
| Tout reconstruire (sans perte de données)  | `cd /opt/portail && sudo docker compose up -d --build`                         |

## Connecteur Claude (optionnel)

Le portail peut être ajouté comme **connecteur personnalisé** dans Claude (claude.ai,
niveau organisation) : Paramètres ▸ Collaborateurs ▸ « Connecteur MCP — organisation »
fournit l'URL et les deux clés à coller dans Claude. On peut alors lister les clients,
lancer des récupérations et télécharger des documents depuis une conversation.
⚠️ Le Client Secret n'est **visible qu'à sa génération** : le copier immédiatement.

## Utilisation locale (test / développement, Windows)

Sans serveur, le portail tourne aussi sur un PC : installer [Node.js](https://nodejs.org),
puis `npm install` dans le dossier du projet, et double-clic sur **`Démarrer.bat`**
→ http://localhost:3003. Les données restent dans `data/` et `downloads/` à côté du code.

## Confidentialité

Chaque installation est **totalement autonome** : identifiants, documents et bases restent
sur le serveur du cabinet. Les mots de passe des clients sont chiffrés (AES-256) avec une
clé générée localement. Aucune donnée ne remonte vers l'éditeur.

## Licence

Distribué sous licence **MIT** — voir le fichier [LICENSE](LICENSE).
