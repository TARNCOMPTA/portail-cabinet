#!/bin/sh
# Demarrage du conteneur : ecran virtuel + serveur VNC + pont noVNC + application.
set -e

# 0) Mise a jour en ligne : si une maj a ete telechargee (app_update/, voir src/update.js),
#    on l'applique maintenant (node est arrete -> aucun fichier verrouille). Le conteneur
#    redemarre tout seul apres process.exit(0) grace a "restart: unless-stopped".
#    NB : survit aux redemarrages du conteneur, PAS a une recreation (docker compose up
#    --build) — dans ce cas l'auto-maj au boot retelechargera la derniere version.
if [ -f app_update/server.js ]; then
  echo "[maj] Application de la mise a jour telechargee..."
  NEED_NPM=0
  cmp -s package.json app_update/package.json 2>/dev/null || NEED_NPM=1
  cp -rf app_update/. .
  rm -rf app_update
  if [ "$NEED_NPM" = "1" ]; then
    echo "[maj] package.json modifie -> npm install..."
    npm install --omit=dev --no-audit --no-fund || echo "[maj] npm install a echoue (on continue avec les dependances existantes)"
  fi
  echo "[maj] Mise a jour appliquee."
fi
rm -f restart.flag

# 1) Ecran virtuel (le navigateur visible du robot s'y affiche)
Xvfb :99 -screen 0 1600x1000x24 -nolisten tcp >/tmp/xvfb.log 2>&1 &
# Attendre que l'ecran soit pret
for i in $(seq 1 20); do
  if xdpyinfo -display :99 >/dev/null 2>&1; then break; fi
  sleep 0.3
done

# 2) Serveur VNC sur l'ecran :99 (accessible uniquement en local, expose via noVNC/Caddy)
# -noxdamage : sous Xvfb l'extension XDAMAGE ne remonte pas les changements -> x11vnc
#   resterait bloque sur l'image grise initiale (fenetre Chromium jamais affichee dans noVNC).
#   On force donc le balayage periodique du framebuffer.
x11vnc -display :99 -nopw -forever -shared -noxdamage -rfbport 5900 -localhost -bg -o /tmp/x11vnc.log

# 3) Pont noVNC (websocket) + fichiers web noVNC sur le port 6080
websockify --web=/usr/share/novnc 6080 localhost:5900 >/tmp/websockify.log 2>&1 &

# 4) Application (au premier plan : c'est le processus principal du conteneur)
exec node --disable-warning=ExperimentalWarning server.js
