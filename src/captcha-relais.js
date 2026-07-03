// Relais captcha : pendant la connexion impôts, le scraper publie ici l'IMAGE du
// captcha (capture de l'élément) et un handler de saisie. L'interface du portail
// l'affiche (GET /api/captcha) et renvoie le code tapé par l'utilisateur
// (POST /api/captcha) — le robot le recopie dans la vraie page et se connecte.
// Le code est saisi par un HUMAIN : on ne fait que déporter l'affichage,
// exactement comme noVNC (qui reste disponible en secours).
// Une seule session à la fois (les connexions impôts sont déjà sérialisées).

let session = null; // { image: Buffer, soumettre(code), rafraichir(), depuis }

export function ouvrir({ image, soumettre, rafraichir }) {
  session = { image, soumettre, rafraichir, depuis: new Date().toISOString() };
}
export function majImage(image) {
  if (session && image) session.image = image;
}
export function fermer() {
  session = null;
}
export function etat() {
  if (!session) return { actif: false };
  return { actif: true, image: 'data:image/png;base64,' + session.image.toString('base64'), depuis: session.depuis };
}
export async function soumettre(code) {
  if (!session) return { ok: false, error: 'Aucune captcha en attente.' };
  try {
    return await session.soumettre(String(code || '').trim());
  } catch (e) {
    return { ok: false, error: e.message };
  }
}
export async function rafraichir() {
  if (!session) return { ok: false, error: 'Aucune captcha en attente.' };
  await session.rafraichir?.();
  return { ok: true, ...etat() };
}
