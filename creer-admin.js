// Cree le premier compte administrateur (a lancer une seule fois).
//   node creer-admin.js <email> <nom> <motdepasse>
// Exemple : node creer-admin.js aymeric@tarncompta.fr "Aymeric HANGARD" MonMotDePasse123
import { getUserByEmail, createUser, countUsers } from './src/db.js';
import { hashPassword } from './src/auth.js';

const [, , email, nom, pwd] = process.argv;
if (!email || !pwd) {
  console.error('Usage : node creer-admin.js <email> <nom> <motdepasse>');
  console.error('  (le nom peut contenir des espaces : mets-le entre guillemets)');
  process.exit(1);
}
if (String(pwd).length < 8) {
  console.error('Mot de passe trop court (8 caracteres minimum).');
  process.exit(1);
}
if (getUserByEmail(email)) {
  console.error(`Un utilisateur avec l'e-mail ${email} existe deja.`);
  process.exit(1);
}

const u = createUser({ email, nom: nom || email, password_hash: hashPassword(pwd), role: 'admin' });
console.log(`Administrateur cree : ${u.email} (${countUsers()} utilisateur(s) au total).`);
console.log('Tu peux maintenant te connecter sur le portail et ajouter les autres collaborateurs.');
process.exit(0);
