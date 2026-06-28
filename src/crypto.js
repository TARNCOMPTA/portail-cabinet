// Chiffrement du mot de passe du compte cabinet (AES-256-GCM).
// La cle est generee automatiquement au premier lancement et stockee dans data/secret.key
// (jamais commitee). Pas de configuration manuelle requise.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = resolve(__dirname, '..', 'data');
const KEY_FILE = resolve(DATA_DIR, 'secret.key');

function getKey() {
  mkdirSync(DATA_DIR, { recursive: true });
  if (!existsSync(KEY_FILE)) {
    writeFileSync(KEY_FILE, randomBytes(32).toString('hex'), 'utf8');
  }
  return Buffer.from(readFileSync(KEY_FILE, 'utf8').trim(), 'hex');
}

export function encrypt(plain) {
  const key = getKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString('hex'), tag.toString('hex'), enc.toString('hex')].join(':');
}

export function decrypt(stored) {
  try {
    const [ivH, tagH, dataH] = String(stored).split(':');
    const key = getKey();
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivH, 'hex'));
    decipher.setAuthTag(Buffer.from(tagH, 'hex'));
    return Buffer.concat([decipher.update(Buffer.from(dataH, 'hex')), decipher.final()]).toString('utf8');
  } catch {
    return '';
  }
}
