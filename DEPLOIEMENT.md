# Déploiement du Portail Cabinet sur le VPS (Ubuntu 24.04, UE)

Mise en ligne avec **HTTPS automatique** (Caddy + Let's Encrypt) sur `portail.tarncompta.fr`.

## Prérequis
- VPS **Ubuntu 24.04**, tu as l'**IP** et l'accès **root** (ou un utilisateur sudo).
- DNS : enregistrement **A** `portail` → IP du VPS, créé chez OVH (zone DNS de `tarncompta.fr`).
  Vérifie depuis ton PC : `nslookup portail.tarncompta.fr` doit renvoyer l'IP du VPS.
- Le code est poussé sur GitHub (`TARNCOMPTA/portail-cabinet`) **dans sa version avec authentification + Docker**.

---

## 1. Se connecter au VPS
Depuis ton PC (PowerShell ou terminal) :
```bash
ssh root@IP_DU_VPS
```
(mot de passe reçu par mail OVH ; il peut demander de le changer à la 1re connexion.)

## 2. Pare-feu : ouvrir le web et SSH
```bash
ufw allow OpenSSH
ufw allow 80
ufw allow 443
ufw --force enable
```

## 3. Installer Docker
```bash
curl -fsSL https://get.docker.com | sh
```
Vérifie : `docker --version` et `docker compose version`.

## 4. Récupérer le code
```bash
cd /opt
git clone https://github.com/TARNCOMPTA/portail-cabinet.git portail
cd portail
```

## 5. Lancer le portail (build + démarrage)
```bash
docker compose up -d --build
```
Le 1er build prend quelques minutes (téléchargement de Chromium). Suivre les logs :
```bash
docker compose logs -f app
```
Caddy obtient automatiquement le certificat HTTPS dès que le DNS pointe bien sur le VPS.

## 6. Créer le 1er compte administrateur
```bash
docker compose exec app node creer-admin.js "aymeric@tarncompta.fr" "Aymeric HANGARD" "UnMotDePasseSolide"
```

## 7. Ouvrir le portail
Dans le navigateur : **https://portail.tarncompta.fr**
Connexion avec le compte admin → panneau **Collaborateurs** pour ajouter les 7 autres.

---

## Mises à jour (quand je publie du nouveau code)
```bash
cd /opt/portail
git pull
docker compose up -d --build
```
Les données (`data/`, `downloads/`) sont conservées (volumes).

## Sauvegarde
Tout l'état (comptes, clients, documents, clé de chiffrement) est dans `/opt/portail/data` et
`/opt/portail/downloads`. Sauvegarde régulière conseillée :
```bash
tar czf /root/portail-backup-$(date +%F).tgz -C /opt/portail data downloads
```

## Commandes utiles
```bash
docker compose ps               # état des conteneurs
docker compose logs -f app      # logs de l'application
docker compose logs -f caddy    # logs HTTPS / certificat
docker compose restart app      # redémarrer l'app
docker compose down             # tout arrêter
```

---

## ⚠️ Important — étape actuelle
Cette mise en ligne couvre **le portail + l'authentification équipe + la gestion clients/comptes**.

La **récupération des documents impôts nécessite la captcha** : sur un serveur, il faut pouvoir
**voir et piloter le navigateur à distance** pour la saisir. C'est la **Phase 3** (affichage du
navigateur du serveur dans ton onglet via noVNC). Tant qu'elle n'est pas en place, ne lance pas
« Récupérer » depuis le serveur — on l'active juste après avoir validé la mise en ligne.

Les sites **sans captcha** (URSSAF, CARPIMKO, CARMF), une fois intégrés au portail, pourront tourner
en automatique côté serveur.
