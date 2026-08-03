// Options de lancement Chromium partagées par tous les scrapers Playwright.
// Objectif : limiter la consommation mémoire sur le VPS.
// - --disable-dev-shm-usage : /dev/shm est minuscule dans Docker (64 Mo) ;
// - --disable-extensions / --mute-audio / --no-first-run : moins de services annexes ;
// - --js-flags=--max-old-space-size=256 : plafonne le tas JS de CHAQUE renderer
//   (les pages des sites administratifs n'en demandent jamais autant).
// - --disable-gpu : UNIQUEMENT pour les navigateurs invisibles (headless). Sur le
//   navigateur VISIBLE (captcha impôts, affiché dans Xvfb/noVNC), ce drapeau peut
//   produire une fenêtre entièrement NOIRE — on l'omet donc en mode visible.
import { chromium } from 'playwright';

export function launchArgs({ visible = false } = {}) {
  if (process.platform !== 'linux') return [];
  const args = ['--no-sandbox', '--disable-dev-shm-usage', '--disable-extensions', '--mute-audio', '--no-first-run', '--js-flags=--max-old-space-size=256'];
  if (!visible) args.push('--disable-gpu');
  return args;
}

// ---- Navigateur pret pour UN client (caisses a login individuel) -------------
// Les scrapers CARMF/CARPIMKO/CARCDSF/CARPV lancaient un Chromium COMPLET par client :
// un lot de 100 clients = 100 demarrages de processus, soit 2 a 3 minutes de pure
// attente. Or l'isolation dont ils ont besoin (cookies, session, stockage) est celle
// du CONTEXTE, pas du processus : `browser.newContext()` la fournit deja.
//
// `ouvrirPour(opts)` renvoie donc un contexte + une page, et un `fermer()` qui ne
// detruit le navigateur QUE s'il l'a lui-meme lance :
//   - client isole (bouton « Recuperer ») : aucun `opts.browser` -> comportement
//     d'origine, un navigateur dedie ouvert puis referme ;
//   - lot (`lancerTous`) : le navigateur est passe dans `opts.browser` et reste ouvert
//     d'un client au suivant, seul le contexte est recycle.
export async function ouvrirPour(opts = {}) {
  const headless = String(process.env.HEADLESS ?? 'false').toLowerCase() === 'true';
  const navTimeout = Number(process.env.NAV_TIMEOUT ?? 45000);
  const prete = !!opts.browser; // navigateur preté par l'appelant (mode lot)
  const browser = opts.browser || (await chromium.launch({ headless, args: launchArgs() }));
  const context = await browser.newContext({ acceptDownloads: true, locale: 'fr-FR', ...(opts.contextOptions || {}) });
  const page = await context.newPage();
  page.setDefaultTimeout(navTimeout);
  const fermer = async () => {
    await context.close().catch(() => {});
    if (!prete) await browser.close().catch(() => {});
  };
  // `headless` est renvoye car certains scrapers l'utilisent ensuite (CARPIMKO laisse
  // la main quelques secondes en mode visible, pour une verification email/SMS).
  return { browser, context, page, navTimeout, headless, fermer };
}

// Navigateur partage par un lot. A appeler dans un try/finally cote appelant.
export async function ouvrirNavigateurLot() {
  const headless = String(process.env.HEADLESS ?? 'false').toLowerCase() === 'true';
  return chromium.launch({ headless, args: launchArgs() });
}
