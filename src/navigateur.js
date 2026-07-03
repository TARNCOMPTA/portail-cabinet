// Options de lancement Chromium partagées par tous les scrapers Playwright.
// Objectif : limiter la consommation mémoire sur le VPS.
// - --disable-dev-shm-usage : /dev/shm est minuscule dans Docker (64 Mo) ;
// - --disable-extensions / --mute-audio / --no-first-run : moins de services annexes ;
// - --js-flags=--max-old-space-size=256 : plafonne le tas JS de CHAQUE renderer
//   (les pages des sites administratifs n'en demandent jamais autant).
// - --disable-gpu : UNIQUEMENT pour les navigateurs invisibles (headless). Sur le
//   navigateur VISIBLE (captcha impôts, affiché dans Xvfb/noVNC), ce drapeau peut
//   produire une fenêtre entièrement NOIRE — on l'omet donc en mode visible.
export function launchArgs({ visible = false } = {}) {
  if (process.platform !== 'linux') return [];
  const args = ['--no-sandbox', '--disable-dev-shm-usage', '--disable-extensions', '--mute-audio', '--no-first-run', '--js-flags=--max-old-space-size=256'];
  if (!visible) args.push('--disable-gpu');
  return args;
}
