// Change le mot de passe d'un utilisateur existant (depannage / reset).
//   node changer-mdp.js <email> <nouveau_mot_de_passe>
// Astuce shell : entoure le mot de passe de guillemets SIMPLES 'monMdp' pour eviter
// que le terminal n'interprete $ & ! etc.
import { getUserByEmail, updateUserPassword, deleteUserSessions } from './src/db.js';
import { hashPassword } from './src/auth.js';

const [, , email, pwd] = process.argv;
if (!email || !pwd) {
  console.error("Usage : node changer-mdp.js <email> <nouveau_mot_de_passe>");
  process.exit(1);
}
if (String(pwd).length < 8) { console.error('Mot de passe trop court (8 caracteres minimum).'); process.exit(1); }
const u = getUserByEmail(email);
if (!u) { console.error(`Aucun utilisateur avec l'e-mail ${email}.`); process.exit(1); }
updateUserPassword(u.id, hashPassword(pwd));
deleteUserSessions(u.id);
console.log(`Mot de passe change pour ${u.email}. (sessions existantes deconnectees)`);
process.exit(0);
