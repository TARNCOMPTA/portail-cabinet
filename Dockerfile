# Image de l'application (Node 24 pour node:sqlite + Chromium via Playwright).
FROM node:24-bookworm

# Ecran virtuel (Xvfb) + serveur VNC (x11vnc) + pont noVNC (novnc/websockify) :
# permet de VOIR et piloter a distance le navigateur du robot (saisie de la captcha).
# xdpyinfo (paquet x11-utils) sert a attendre que l'ecran soit pret au demarrage.
# numlockx : active le verrouillage numerique de l'ecran virtuel (sinon le pave
# numerique arrive comme fleches/Debut/Fin dans noVNC lors de la saisie captcha).
RUN apt-get update && apt-get install -y --no-install-recommends \
    xvfb x11vnc x11-utils novnc websockify numlockx \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Dépendances Node (couche cachée tant que package*.json ne change pas).
# PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD : le postinstall de package.json lance
# « playwright install chromium ». Sans ce drapeau, les ~170 Mo de Chromium
# atterrissaient DANS cette couche, qui est donc invalidée au moindre changement de
# package.json — la promesse de cache de la ligne ci-dessus n'était pas tenue.
# Le téléchargement a lieu à l'étape suivante, qui lui est dédiée.
COPY package*.json ./
RUN PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm ci --omit=dev || PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install --omit=dev

# Navigateur Chromium + librairies système nécessaires (couche dédiée et stable).
RUN npx playwright install --with-deps chromium

# Code de l'application.
COPY . .
RUN chmod +x start.sh

ENV NODE_ENV=production
ENV PORT=3000
ENV DISPLAY=:99
EXPOSE 3000 6080

# Ecran virtuel + VNC + noVNC + serveur (voir start.sh).
CMD ["./start.sh"]
