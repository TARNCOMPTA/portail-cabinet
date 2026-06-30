// Outil d'exploration CARCDSF (Flutter Web) — A LANCER SUR LE VPS.
// Ouvre l'espace adherent dans le navigateur du serveur (visible via noVNC), pendant
// que TU te connectes A LA MAIN et ouvres tes documents/attestations. Le script CAPTURE
// le trafic reseau (appels API) et imprime un RESUME des endpoints (URL, methode, statut,
// type, et pour le JSON uniquement les CLES — pas les valeurs, pour ne pas divulguer de
// donnees personnelles). Ce resume sert a ecrire le vrai connecteur (rejeu HTTP).
//
// Usage (dans le conteneur) :
//   sudo docker compose exec app node scripts/explore-carcdsf.mjs <client_id> [secondes]
// Le <client_id> est l'id du client CARCDSF de test (vu dans l'interface / l'API).
// Pendant la fenetre de capture, ouvre la vue « Captcha » (noVNC) du portail et connecte-toi.

import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getClientCredentials } from '../src/carcdsf-db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const id = Number(process.argv[2]);
const secondes = Number(process.argv[3] || 150);
const LOGIN_URLS = {
  cd: 'https://adherents.carcdsf.fr/carcdsf-cd',
  sf: 'https://adherents.carcdsf.fr/carcdsf-sf',
};

if (!id) { console.error('Usage: node scripts/explore-carcdsf.mjs <client_id> [secondes]'); process.exit(1); }
const c = getClientCredentials(id);
if (!c) { console.error(`Client CARCDSF #${id} introuvable.`); process.exit(1); }
const profession = c.profession === 'sf' ? 'sf' : 'cd';
const url = LOGIN_URLS[profession];
console.log(`\n=== Exploration CARCDSF — ${c.nom} (${profession}) ===`);
console.log(`Identifiant : ${c.login}  (mot de passe : ${c.password ? '••• présent' : 'ABSENT'})`);

const calls = [];
const interessant = (u) => !/\.(png|jpg|jpeg|gif|svg|woff2?|ttf|css|js|ico|map)(\?|$)/i.test(u);

const browser = await chromium.launch({ headless: false, args: ['--no-sandbox', '--disable-dev-shm-usage', '--start-maximized'] });
const ctx = await browser.newContext({ locale: 'fr-FR' });
const page = await ctx.newPage();

page.on('request', (req) => {
  const u = req.url();
  if ((req.resourceType() === 'xhr' || req.resourceType() === 'fetch') && interessant(u)) {
    const h = req.headers();
    calls.push({ phase: 'req', method: req.method(), url: u, postData: (req.postData() || '').slice(0, 400), auth: h.authorization ? 'Bearer/…' : (h.cookie ? 'cookie' : ''), ct: h['content-type'] || '' });
  }
});
page.on('response', async (resp) => {
  const u = resp.url();
  if (!interessant(u)) return;
  const ct = resp.headers()['content-type'] || '';
  let cles = '';
  if (/json/i.test(ct)) {
    try { const j = await resp.json(); cles = Array.isArray(j) ? `array[${j.length}] de {${Object.keys(j[0] || {}).join(',')}}` : `{${Object.keys(j || {}).join(',')}}`; } catch { /* ignore */ }
  }
  calls.push({ phase: 'resp', method: resp.request().method(), url: u, status: resp.status(), ct: ct.split(';')[0], cles });
});

console.log(`\nOuverture de ${url}`);
await page.goto(url, { waitUntil: 'domcontentloaded' }).catch(() => {});
// Bandeau cookies (overlay HTML) : on l'accepte automatiquement (plusieurs tentatives,
// il peut apparaitre un peu apres le chargement).
for (let i = 0; i < 8; i++) {
  for (const t of ['Enregistrer et appliquer', 'Tout accepter', 'Accepter', "J'accepte", 'Continuer']) {
    const b = page.locator(`button:has-text("${t}"), input[type="button"][value="${t}"], a:has-text("${t}")`).first();
    if (await b.isVisible().catch(() => false)) { await b.click().catch(() => {}); console.log(`(bandeau cookies : clic « ${t} »)`); break; }
  }
  await page.waitForTimeout(700);
}
console.log('\n>>> CONNECTE-TOI MAINTENANT via la vue « Captcha » (noVNC) du portail, puis ouvre tes');
console.log(`>>> documents / attestations / relevés. Capture pendant ${secondes}s...\n`);
await page.waitForTimeout(secondes * 1000);

// ---- Resume ----
const out = resolve(__dirname, '..', 'data', '_carcdsf_capture.json');
writeFileSync(out, JSON.stringify(calls, null, 2));
const distinct = new Map();
for (const c2 of calls) {
  if (c2.phase !== 'resp') continue;
  const key = `${c2.method} ${c2.url.split('?')[0]}`;
  if (!distinct.has(key)) distinct.set(key, c2);
}
console.log('\n================ ENDPOINTS API CAPTURES ================');
for (const [key, v] of distinct) console.log(`${v.status}  ${key}   [${v.ct}] ${v.cles || ''}`);
console.log('========================================================');
console.log(`\n(${calls.length} appels enregistrés — détail complet dans data/_carcdsf_capture.json)`);
console.log('Copie-moi ce bloc ENDPOINTS (et dis-moi si tu as bien atteint la page des documents).');
await ctx.close().catch(() => {});
await browser.close().catch(() => {});
