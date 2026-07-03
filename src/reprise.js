// Reprise des récupérations interrompues (déconnexion, crash en cours de lot).
// Au lancement d'un « tout récupérer », les clients dont la DERNIÈRE récupération
// a réussi il y a moins de REPRISE_HEURES heures sont considérés déjà faits et
// sautés : on repart ainsi du premier dossier non récupéré. Cas particulier :
// si TOUS les clients ont été récupérés récemment (relance volontaire après un
// lot complet), on refait tout normalement.
export const REPRISE_HEURES = 12;

// clients : lignes de listClients() (dernier_run + dernier_statut requis).
// Renvoie { aFaire, ignores } — aFaire trié : jamais récupérés d'abord, puis du
// passage le plus ancien au plus récent.
export function filtrerReprise(clients) {
  const seuil = Date.now() - REPRISE_HEURES * 3600 * 1000;
  const dejaFait = (c) => c.dernier_statut === 'succes' && c.dernier_run && new Date(c.dernier_run.replace(' ', 'T') + 'Z').getTime() >= seuil;
  const restants = clients.filter((c) => !dejaFait(c));
  if (!restants.length) return { aFaire: clients, ignores: 0 };
  const aFaire = [...restants].sort((a, b) => String(a.dernier_run || '').localeCompare(String(b.dernier_run || '')));
  return { aFaire, ignores: clients.length - restants.length };
}

// Disjoncteur de lot : quand N clients échouent D'AFFILÉE, le site source est
// très probablement indisponible (panne, session déconnectée) — inutile (et
// contre-productif) d'enchaîner les centaines de clients restants. Le lot
// s'arrête ; la reprise ci-dessus repartira du premier dossier non récupéré
// au prochain lancement. Un succès remet le compteur à zéro.
export const ECHECS_CONSECUTIFS_MAX = 5;
export function creerDisjoncteur(seuil = ECHECS_CONSECUTIFS_MAX) {
  let echecs = 0;
  return {
    noter(ok) {
      echecs = ok ? 0 : echecs + 1;
    },
    declenche() {
      return echecs >= seuil;
    },
  };
}
