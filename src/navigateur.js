// Options de lancement Chromium partagées par tous les scrapers Playwright.
// Objectif : limiter la consommation mémoire sur le VPS.
// - --disable-dev-shm-usage : /dev/shm est minuscule dans Docker (64 Mo) ;
// - --disable-gpu : pas de GPU sur un VPS, evite les processus/compositing inutiles ;
// - --disable-extensions / --mute-audio / --no-first-run : moins de services annexes ;
// - --js-flags=--max-old-space-size=256 : plafonne le tas JS de CHAQUE renderer
//   (les pages des sites administratifs n'en demandent jamais autant).
export function launchArgs() {
  if (process.platform !== 'linux') return [];
  return [
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--disable-extensions',
    '--mute-audio',
    '--no-first-run',
    '--js-flags=--max-old-space-size=256',
  ];
}
