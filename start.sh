#!/bin/sh
# Demarrage du conteneur : ecran virtuel + serveur VNC + pont noVNC + application.
set -e

# 1) Ecran virtuel (le navigateur visible du robot s'y affiche)
Xvfb :99 -screen 0 1600x1000x24 -nolisten tcp >/tmp/xvfb.log 2>&1 &
# Attendre que l'ecran soit pret
for i in $(seq 1 20); do
  if xdpyinfo -display :99 >/dev/null 2>&1; then break; fi
  sleep 0.3
done

# 2) Serveur VNC sur l'ecran :99 (accessible uniquement en local, expose via noVNC/Caddy)
x11vnc -display :99 -nopw -forever -shared -rfbport 5900 -localhost -bg -o /tmp/x11vnc.log

# 3) Pont noVNC (websocket) + fichiers web noVNC sur le port 6080
websockify --web=/usr/share/novnc 6080 localhost:5900 >/tmp/websockify.log 2>&1 &

# 4) Application (au premier plan : c'est le processus principal du conteneur)
exec node --disable-warning=ExperimentalWarning server.js
