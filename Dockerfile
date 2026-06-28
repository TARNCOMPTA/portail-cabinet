# Image de l'application (Node 24 pour node:sqlite + Chromium via Playwright).
FROM node:24-bookworm

# Ecran virtuel (Xvfb) + serveur VNC (x11vnc) + pont noVNC (novnc/websockify) :
# permet de VOIR et piloter a distance le navigateur du robot (saisie de la captcha).
# xdpyinfo (paquet x11-utils) sert a attendre que l'ecran soit pret au demarrage.
RUN apt-get update && apt-get install -y --no-install-recommends \
    xvfb x11vnc x11-utils novnc websockify \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Dépendances Node (couche cachée tant que package*.json ne change pas).
COPY package*.json ./
RUN npm ci --omit=dev || npm install --omit=dev

# Navigateur Chromium + librairies système nécessaires.
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
