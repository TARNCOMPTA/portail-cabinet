#!/usr/bin/env node
// Publie une mise à jour EN LIGNE du portail. À lancer depuis le poste de dev :
//
//   node scripts/publier-maj.mjs                    -> incrémente le patch (1.0.7 -> 1.0.8)
//   node scripts/publier-maj.mjs 1.1.0 "Nouveautés" -> version + notes explicites
//
// Étapes : bump de version.json -> commit -> archive du code (git archive HEAD)
// dans update/app.zip -> manifeste update/version.json (version, notes, url, sha256)
// -> commit + push. Toutes les instances (bouton « Mettre à jour », auto-maj au
// démarrage) verront alors la nouvelle version via GitHub raw.
//
// Prérequis : arbre git PROPRE (tout committé) — le script committe et pousse lui-même.
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const APP = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const run = (cmd) =>
  execSync(cmd, { cwd: APP, stdio: ['ignore', 'pipe', 'inherit'] })
    .toString()
    .trim();
const RAW_BASE = 'https://raw.githubusercontent.com/TARNCOMPTA/portail-cabinet/main/update';

// 1) Arbre propre ? (on committe nous-mêmes, pas question d'embarquer des changements non voulus)
if (run('git status --porcelain')) {
  console.error('Arbre git non propre : committe (ou remise) tes changements avant de publier.');
  process.exit(1);
}

// 2) Nouvelle version
const actuelle = JSON.parse(readFileSync(resolve(APP, 'version.json'), 'utf8').replace(/^﻿/, '')).version || '0.0.0';
let nouvelle = process.argv[2];
if (!nouvelle) {
  const p = actuelle.split('.').map((n) => parseInt(n, 10) || 0);
  nouvelle = `${p[0]}.${p[1]}.${(p[2] || 0) + 1}`;
}
if (!/^\d+\.\d+\.\d+$/.test(nouvelle)) {
  console.error(`Version invalide : ${nouvelle} (attendu X.Y.Z)`);
  process.exit(1);
}
const notes = process.argv[3] || `Mise à jour ${nouvelle}`;
console.log(`Publication ${actuelle} -> ${nouvelle}`);

// 3) Bump + commit de la version (la version DOIT être dans l'archive)
writeFileSync(resolve(APP, 'version.json'), JSON.stringify({ version: nouvelle }, null, 2) + '\n');
run('git add version.json');
run(`git commit -m "Version ${nouvelle}"`);

// 4) Archive du code (fichiers trackés uniquement ; update/ exclu via .gitattributes)
mkdirSync(resolve(APP, 'update'), { recursive: true });
run('git archive --format=zip -o update/app.zip HEAD');
const zip = readFileSync(resolve(APP, 'update', 'app.zip'));
const sha256 = crypto.createHash('sha256').update(zip).digest('hex');
console.log(`Archive : ${(zip.length / 1024 / 1024).toFixed(1)} Mo — sha256 ${sha256.slice(0, 16)}…`);

// 5) Manifeste
writeFileSync(resolve(APP, 'update', 'version.json'), JSON.stringify({ version: nouvelle, notes, url: `${RAW_BASE}/app.zip`, sha256 }, null, 2) + '\n');

// 6) Commit + push
run('git add update');
run(`git commit -m "Publie la mise à jour ${nouvelle}"`);
run('git push origin main');
console.log(`\nMise à jour ${nouvelle} publiée. Les portails la verront via « Vérifier » (ou l'installeront au prochain démarrage).`);
