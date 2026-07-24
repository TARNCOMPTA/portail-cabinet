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
// Temoin chiffre avec la cle : permet de detecter qu'elle a change (voir verifierCle).
const CHECK_FILE = resolve(DATA_DIR, 'secret.check');
const TEMOIN = 'portail-cabinet/cle-ok';

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

/**
 * Verifie que la cle en place est bien celle qui a chiffre les donnees existantes.
 *
 * Sans ce controle, la perte de data/secret.key est SILENCIEUSE : getKey() fabrique une
 * cle neuve, tous les mots de passe clients se dechiffrent alors en chaine vide, et le
 * portail les traite comme « mot de passe vide » -> chaque client passe en echec_mdp donc
 * verrouille, et les tournees se vident sans explication.
 *
 * Au premier appel (ou apres une restauration complete), un temoin chiffre est ecrit ;
 * ensuite il doit se dechiffrer. Renvoie { ok, initialise }.
 */
export function verifierCle() {
  getKey();
  if (!existsSync(CHECK_FILE)) {
    writeFileSync(CHECK_FILE, encrypt(TEMOIN), 'utf8');
    return { ok: true, initialise: true };
  }
  let lu = '';
  try {
    lu = decrypt(readFileSync(CHECK_FILE, 'utf8').trim());
  } catch {
    lu = '';
  }
  return { ok: lu === TEMOIN, initialise: false };
}
