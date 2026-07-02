// Mise a jour automatique de l'application (cote serveur).
//
// Un manifeste publie sur GitHub (UPDATE_MANIFEST_URL) indique la derniere version :
//   { "version": "1.1.0", "notes": "...", "url": "https://.../app.zip" }
// L'app compare sa version locale (version.json) ; si une version plus recente existe,
// l'utilisateur l'installe en 1 clic : telechargement -> extraction dans "app_update"
// -> drapeau "restart.flag" -> arret. Le lanceur (Demarrer.bat) applique la maj
// (copie app_update -> projet) puis relance. Les donnees (data/, .env, downloads/) ne
// sont jamais touchees (elles ne sont pas dans l'archive).

import JSZip from 'jszip';
import crypto from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const STAGING = resolve(APP_DIR, 'app_update');
const RESTART_FLAG = resolve(APP_DIR, 'restart.flag');

// URL par defaut du manifeste (depot public). Surchargeable via .env (UPDATE_MANIFEST_URL).
const MANIFEST_URL = process.env.UPDATE_MANIFEST_URL || 'https://raw.githubusercontent.com/TARNCOMPTA/portail-cabinet/main/update/version.json';

export function versionLocale() {
  try {
    const raw = readFileSync(resolve(APP_DIR, 'version.json'), 'utf8').replace(/^﻿/, '');
    return JSON.parse(raw).version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export function comparerVersions(a, b) {
  const pa = String(a)
    .split('.')
    .map((n) => parseInt(n, 10) || 0);
  const pb = String(b)
    .split('.')
    .map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d;
  }
  return 0;
}

export async function verifierMaj() {
  const current = versionLocale();
  // Sur serveur (Docker), la maj se fait par "git pull" + rebuild : on desactive le mecanisme embarque.
  if (process.env.UPDATE_DISABLED) return { configure: false, current, updateAvailable: false };
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 10000);
    const res = await fetch(MANIFEST_URL, { signal: ctrl.signal, cache: 'no-store' });
    clearTimeout(t);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const manifest = JSON.parse((await res.text()).replace(/^﻿/, ''));
    const latest = manifest.version || '0.0.0';
    return {
      configure: true,
      current,
      latest,
      notes: manifest.notes || '',
      url: manifest.url || '',
      sha256: manifest.sha256 || '',
      updateAvailable: comparerVersions(latest, current) > 0,
    };
  } catch (e) {
    return { configure: true, current, updateAvailable: false, erreur: e.message };
  }
}

export async function appliquerMaj(onLog = () => {}) {
  const etat = await verifierMaj();
  if (!etat.updateAvailable || !etat.url) throw new Error('Aucune mise a jour disponible.');
  onLog(`Telechargement de la version ${etat.latest}...`);
  const res = await fetch(etat.url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`Telechargement echoue (HTTP ${res.status}).`);
  const buf = Buffer.from(await res.arrayBuffer());

  // Integrite : l'empreinte publiee dans le manifeste doit correspondre a l'archive.
  if (etat.sha256) {
    const h = crypto.createHash('sha256').update(buf).digest('hex');
    if (h !== String(etat.sha256).toLowerCase()) throw new Error('Empreinte SHA-256 invalide - maj annulee.');
  }

  const zip = await JSZip.loadAsync(buf);
  if (!zip.file('server.js')) throw new Error('Archive invalide (server.js absent) - maj annulee.');

  rmSync(STAGING, { recursive: true, force: true });
  mkdirSync(STAGING, { recursive: true });
  for (const entry of Object.values(zip.files)) {
    const dest = resolve(STAGING, entry.name);
    if (entry.dir) mkdirSync(dest, { recursive: true });
    else {
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, await entry.async('nodebuffer'));
    }
  }
  onLog("Mise a jour preparee. Redemarrage de l'application...");
  writeFileSync(RESTART_FLAG, etat.latest, 'utf8');
  setTimeout(() => process.exit(0), 800);
  return { ok: true, version: etat.latest };
}
