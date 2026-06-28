# Image de l'application (Node 24 pour node:sqlite + Chromium via Playwright).
FROM node:24-bookworm

# Xvfb : écran virtuel pour que le navigateur (mode visible, captcha) puisse tourner côté serveur.
RUN apt-get update && apt-get install -y --no-install-recommends xvfb \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Dépendances Node (couche cachée tant que package*.json ne change pas).
COPY package*.json ./
RUN npm ci --omit=dev || npm install --omit=dev

# Navigateur Chromium + librairies système nécessaires.
RUN npx playwright install --with-deps chromium

# Code de l'application.
COPY . .

ENV NODE_ENV=production
ENV PORT=3000
ENV DISPLAY=:99
EXPOSE 3000

# Démarre l'écran virtuel puis le serveur. Le navigateur lancé par le robot s'affichera dans cet écran.
CMD ["sh", "-c", "Xvfb :99 -screen 0 1600x1000x24 -nolisten tcp >/dev/null 2>&1 & exec node --disable-warning=ExperimentalWarning server.js"]
