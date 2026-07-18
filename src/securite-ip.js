// Bannissement d'IP applicatif (« fail2ban embarqué ») — complète le throttle
// mémoire de src/auth.js par des bans ESCALADÉS et PERSISTANTS (survivent au reboot).
// Factory sur le modèle de creerListeNoire : instanciée sur la base SQLite du portail.
export function creerBannissementIp(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS bannissements_ip (
    ip        TEXT PRIMARY KEY,
    jusqua    TEXT NOT NULL,              -- fin du bannissement (ISO)
    recidives INTEGER NOT NULL DEFAULT 1, -- nb de bans successifs (escalade)
    motif     TEXT,
    cree_le   TEXT NOT NULL DEFAULT (datetime('now'))
  );`);

  const FENETRE_MS = Number(process.env.SEC_WINDOW_MS || 15 * 60 * 1000);
  const SEUIL = Number(process.env.SEC_THRESHOLD || 10);
  const PALIERS_MIN = (process.env.SEC_BAN_STEPS || '15,60,240,1440')
    .split(',')
    .map((n) => Number(n.trim()))
    .filter((n) => n > 0);
  const LISTE_BLANCHE = new Set(
    (process.env.IP_ALLOWLIST || '').split(',').map((s) => s.trim()).filter(Boolean)
  );

  const echecs = new Map(); // ip -> { score, resetAt }
  const banJusqua = new Map(); // ip -> epoch ms
  const recidives = new Map(); // ip -> n

  // Reprise des bans encore actifs au démarrage
  for (const row of db.prepare('SELECT * FROM bannissements_ip').all()) {
    const t = new Date(row.jusqua).getTime();
    recidives.set(row.ip, row.recidives);
    if (t > Date.now()) banJusqua.set(row.ip, t);
    else db.prepare('DELETE FROM bannissements_ip WHERE ip = ?').run(row.ip);
  }

  const clientIp = (req) => {
    let ip = req.ip || req.socket?.remoteAddress || '';
    if (ip.startsWith('::ffff:')) ip = ip.slice(7);
    return ip;
  };

  function bannir(ip, motif) {
    const now = Date.now();
    const n = (recidives.get(ip) || 0) + 1;
    recidives.set(ip, n);
    const mins = PALIERS_MIN[Math.min(n - 1, PALIERS_MIN.length - 1)];
    const jusqua = now + mins * 60 * 1000;
    banJusqua.set(ip, jusqua);
    echecs.delete(ip);
    db.prepare(
      'INSERT INTO bannissements_ip (ip, jusqua, recidives, motif) VALUES (?, ?, ?, ?) ' +
        'ON CONFLICT(ip) DO UPDATE SET jusqua = excluded.jusqua, recidives = excluded.recidives, motif = excluded.motif'
    ).run(ip, new Date(jusqua).toISOString(), n, motif || null);
    console.warn(`[securite] ${new Date().toISOString()} IP ${ip} bannie ${mins} min (recidive #${n}, motif: ${motif})`);
  }

  return {
    // Middleware : bloque tôt toute IP actuellement bannie.
    porte(req, res, next) {
      const ip = clientIp(req);
      if (LISTE_BLANCHE.has(ip)) return next();
      const jusqua = banJusqua.get(ip);
      if (jusqua) {
        if (jusqua > Date.now()) {
          const retry = Math.ceil((jusqua - Date.now()) / 1000);
          res.set('Retry-After', String(retry));
          return res.status(403).json({ error: 'Accès temporairement bloqué (trop de tentatives).' });
        }
        banJusqua.delete(ip);
        db.prepare('DELETE FROM bannissements_ip WHERE ip = ?').run(ip);
      }
      next();
    },

    // Enregistre un échec pondéré ; bannit si le score dépasse le seuil dans la fenêtre.
    echec(req, poids = 1, motif = '') {
      const ip = clientIp(req);
      if (!ip || LISTE_BLANCHE.has(ip)) return;
      const now = Date.now();
      let e = echecs.get(ip);
      if (!e || now > e.resetAt) e = { score: 0, resetAt: now + FENETRE_MS };
      e.score += poids;
      echecs.set(ip, e);
      if (e.score >= SEUIL) bannir(ip, motif);
    },

    // Réinitialise les échecs après un succès (ne lève pas un ban actif).
    reussite(req) {
      echecs.delete(clientIp(req));
    },

    // Gestion (admin)
    liste() {
      const now = Date.now();
      return [...banJusqua.entries()]
        .filter(([, j]) => j > now)
        .map(([ip, j]) => ({
          ip,
          jusqua: new Date(j).toISOString(),
          minutesRestantes: Math.ceil((j - now) / 60000),
          recidives: recidives.get(ip) || 1,
        }))
        .sort((a, b) => b.jusqua.localeCompare(a.jusqua));
    },
    debloquer(ip) {
      banJusqua.delete(ip);
      echecs.delete(ip);
      recidives.delete(ip);
      return db.prepare('DELETE FROM bannissements_ip WHERE ip = ?').run(ip).changes > 0;
    },
  };
}
