#!/bin/sh
# ============================================================================
# Portail Cabinet — installation sur un VPS Ubuntu (22.04 / 24.04)
#
#   curl -fsSL https://raw.githubusercontent.com/TARNCOMPTA/portail-cabinet/main/installation/install.sh -o install.sh
#   sudo sh install.sh
#
# Le script : installe Docker si besoin, ouvre le pare-feu (80/443/SSH),
# récupère le code, écrit la configuration (.env), démarre le portail en
# HTTPS automatique (Let's Encrypt) et crée le premier compte administrateur.
# Relançable sans risque (les données de data/ et downloads/ sont conservées).
# ============================================================================
set -e

REPO=https://github.com/TARNCOMPTA/portail-cabinet.git
DIR=${PORTAIL_DIR:-/opt/portail}

[ "$(id -u)" = "0" ] || {
  echo "Ce script doit être lancé en root : sudo sh install.sh"
  exit 1
}

echo ""
echo "=== Portail Cabinet — installation ==="
echo ""
echo "Prérequis : un nom de domaine dont l'enregistrement DNS A pointe déjà"
echo "vers l'IP de ce serveur (sinon le certificat HTTPS échouera)."
echo ""

# Les questions lisent /dev/tty pour fonctionner même via « curl | sh ».
printf "Nom de domaine du portail (ex : portail.moncabinet.fr) : "
read DOMAIN </dev/tty
printf "E-mail pour le certificat HTTPS (ex : contact@moncabinet.fr) : "
read ACME_EMAIL </dev/tty
printf "E-mail du compte administrateur du portail : "
read ADMIN_EMAIL </dev/tty
printf "Nom de l'administrateur (ex : Jean Dupont) : "
read ADMIN_NOM </dev/tty
stty -echo
printf "Mot de passe administrateur (8 caractères minimum) : "
read ADMIN_PWD </dev/tty
stty echo
echo ""

[ -n "$DOMAIN" ] && [ -n "$ACME_EMAIL" ] && [ -n "$ADMIN_EMAIL" ] || {
  echo "Domaine, e-mail HTTPS et e-mail administrateur sont obligatoires."
  exit 1
}
[ "${#ADMIN_PWD}" -ge 8 ] || {
  echo "Mot de passe trop court (8 caractères minimum)."
  exit 1
}

echo ""
echo "--- 1/5 Docker ---"
if command -v docker >/dev/null 2>&1; then
  echo "Docker est déjà installé."
else
  curl -fsSL https://get.docker.com | sh
fi

echo ""
echo "--- 2/5 Pare-feu (SSH + web) ---"
if command -v ufw >/dev/null 2>&1; then
  ufw allow OpenSSH >/dev/null
  ufw allow 80 >/dev/null
  ufw allow 443 >/dev/null
  ufw --force enable >/dev/null
  echo "Ports ouverts : SSH, 80, 443."
else
  echo "ufw absent : vérifie que les ports 80 et 443 sont ouverts."
fi

echo ""
echo "--- 3/5 Code de l'application ---"
if [ -d "$DIR/.git" ]; then
  echo "Dépôt déjà présent dans $DIR : mise à jour."
  git -C "$DIR" pull
else
  apt-get update -qq && apt-get install -y -qq git >/dev/null 2>&1 || true
  git clone --depth 1 "$REPO" "$DIR"
fi
cd "$DIR"

cat > .env <<EOF
DOMAIN=$DOMAIN
PUBLIC_URL=https://$DOMAIN
ACME_EMAIL=$ACME_EMAIL
EOF
echo "Configuration écrite dans $DIR/.env"

echo ""
echo "--- 4/5 Démarrage (construction de l'image : plusieurs minutes) ---"
docker compose up -d --build

echo ""
echo "--- 5/5 Compte administrateur ---"
# On attend que l'application réponde (base initialisée) avant de créer le compte.
i=0
until docker compose exec -T app node -e "fetch('http://localhost:3000/api/branding').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" 2>/dev/null; do
  i=$((i + 1))
  [ "$i" -gt 60 ] && {
    echo "L'application ne répond pas après 3 minutes — consulte : docker compose logs app"
    exit 1
  }
  sleep 3
done
if docker compose exec -T app node creer-admin.js "$ADMIN_EMAIL" "$ADMIN_NOM" "$ADMIN_PWD"; then
  echo "Compte administrateur créé : $ADMIN_EMAIL"
else
  echo "(Le compte existe peut-être déjà — connexion avec le mot de passe existant.)"
fi

echo ""
echo "============================================================"
echo "  Installation terminée !"
echo ""
echo "  Portail   : https://$DOMAIN"
echo "  Connexion : $ADMIN_EMAIL"
echo ""
echo "  Premiers pas (voir la notice NOTICE-INSTALLATION.md) :"
echo "   1. Paramètres ▸ Collaborateurs ▸ Personnalisation : nom du cabinet"
echo "   2. Paramètres : comptes Impôts / URSSAF, clients des caisses"
echo "   3. Les mises à jour s'installent en un clic (badge version, sidebar)"
echo "============================================================"
