// Test manuel du scraper URSSAF sur UN client : node scripts/tester-un-client-urssaf.mjs <clientId>
import { getCabinetFull, getClient, listCabinets } from '../src/urssaf-db.js';
import { scrapeClient } from '../src/scraper-urssaf.js';

const cabinet = getCabinetFull(listCabinets()[0]?.id);
if (!cabinet?.password) {
  console.error('Compte cabinet introuvable ou mot de passe non déchiffrable.');
  process.exit(1);
}
const client = getClient(Number(process.argv[2] || 3));
console.log(`Test sur client #${client.id} « ${client.nom} » (SIRET ${client.siret})\n`);
const r = await scrapeClient(client, { cabinet });
console.log('\n=== RESULTAT ===');
console.log(JSON.stringify({ ok: r.ok, error: r.error ?? null, nouveaux_docs: r.docs?.length ?? 0 }, null, 2));
process.exit(r.ok ? 0 : 2);
