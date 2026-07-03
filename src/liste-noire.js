// Liste noire des clients supprimés (sources SYNCHRONISÉES : impôts, URSSAF).
// Un client supprimé y est inscrit : la synchronisation du portefeuille ne le
// recréera pas. « Réintégrer » le retire de la liste (et le recrée aussitôt).
// Factory : chaque source l'instancie sur SA base SQLite.
export function creerListeNoire(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS liste_noire (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    siret      TEXT UNIQUE NOT NULL,
    nom        TEXT,
    cabinet_id INTEGER,
    ajoute_le  TEXT DEFAULT (datetime('now'))
  );`);
  const norm = (s) => String(s || '').replace(/\D/g, '');
  return {
    listListeNoire: () => db.prepare('SELECT id, siret, nom, cabinet_id, ajoute_le FROM liste_noire ORDER BY ajoute_le DESC, id DESC').all(),
    estListeNoire: (siret) => !!db.prepare('SELECT 1 FROM liste_noire WHERE siret = ?').get(norm(siret)),
    ajouterListeNoire: ({ siret, nom, cabinet_id }) => {
      if (!norm(siret)) return;
      db.prepare('INSERT OR IGNORE INTO liste_noire (siret, nom, cabinet_id) VALUES (?, ?, ?)').run(norm(siret), nom ?? null, cabinet_id ?? null);
    },
    // Retire une entrée par id et la renvoie (pour recréer le client).
    retirerListeNoire: (id) => {
      const r = db.prepare('SELECT id, siret, nom, cabinet_id FROM liste_noire WHERE id = ?').get(Number(id));
      if (r) db.prepare('DELETE FROM liste_noire WHERE id = ?').run(Number(id));
      return r || null;
    },
    // Un ajout MANUEL d'un client lève sa mise en liste noire (geste volontaire).
    retirerListeNoireParSiret: (siret) => db.prepare('DELETE FROM liste_noire WHERE siret = ?').run(norm(siret)),
  };
}
