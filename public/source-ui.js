// Factory UI commune aux sources "par login/mot de passe" (CARPIMKO, CARMF, CARPV, CARCDSF).
// Chaque public/<source>.js appelle initSourceUI({...}). Charge APRES app.js (reutilise
// $, api, toast, esc, renderPagination). Options : profession (colonne cd/sf) et
// tousDocuments (case "tous les documents" -> CARPIMKO).
function initSourceUI({ prefix: P, source, label, profession = false, tousDocuments = false }) {
  let clients = [];
  let filtre = '';
  let filtreEtat = '';
  let page = 1;
  const PAR_PAGE = 20;
  const PRO = { cd: 'Chirurgien-dentiste', sf: 'Sage-femme' };
  const ep = (s) => `/api/${source}${s}`;
  const el = (s) => $(`#${P}-${s}`);

  const fmtDate = (s) => {
    if (!s) return '—';
    const d = new Date(String(s).replace(' ', 'T'));
    return isNaN(d)
      ? s
      : d.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: '2-digit' }) +
          ' ' +
          d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  };
  const statutBadge = (st) => {
    if (st === 'succes') return '<span class="badge ok">OK</span>';
    if (st === 'echec_mdp') return '<span class="badge err">🔒 mdp</span>';
    if (st === 'echec') return '<span class="badge err">échec</span>';
    if (st === 'info') return '<span class="badge">connexion OK</span>';
    return '<span class="badge">—</span>';
  };
  const proBadge = (p) => `<span class="badge">${p === 'sf' ? 'Sage-femme' : 'Chir.-dentiste'}</span>`;
  const tousDocsCoche = () => (tousDocuments ? !!el('tous-docs')?.checked : false);

  async function charger() {
    try {
      clients = await api(ep('/clients'));
    } catch {
      return;
    }
    const n = clients.length;
    if (el('compte')) el('compte').textContent = n ? `${n}` : '';
    const navc = document.getElementById(`nav-${source}-count`);
    if (navc) navc.textContent = n || '';
    rendre();
    chargerRuns();
  }
  function rendre() {
    const q = filtre.toLowerCase();
    let liste = q
      ? clients.filter((c) => `${c.nom} ${c.login} ${profession ? PRO[c.profession] || '' : ''} ${c.notes || ''}`.toLowerCase().includes(q))
      : clients;
    if (filtreEtat) liste = liste.filter((c) => filtreEtatClient(c, filtreEtat));
    const totalPages = Math.max(1, Math.ceil(liste.length / PAR_PAGE));
    if (page > totalPages) page = totalPages;
    if (page < 1) page = 1;
    const tb = $(`#table-${source}-clients tbody`);
    tb.innerHTML = liste
      .slice((page - 1) * PAR_PAGE, page * PAR_PAGE)
      .map(
        (c) => `
      <tr${c.verrouille ? ' style="background:var(--err-bg);"' : ''}>
        <td>${c.verrouille ? '🔒 ' : ''}${esc(c.nom)}</td>
        ${profession ? `<td>${proBadge(c.profession)}</td>` : ''}
        <td class="siret">${esc(c.login)}</td>
        <td>${esc(c.notes || '')}</td>
        <td>${c.nb_docs ? `<a href="#" data-${P}-docs="${c.id}" style="color:var(--accent);font-weight:600;text-decoration:none;">${c.nb_docs}</a>` : '0'}</td>
        <td>${statutBadge(c.dernier_statut)} <span class="aide" style="margin:0;">${fmtDate(c.dernier_run)}</span></td>
        <td><span class="row-actions">
          <button class="btn small primary" data-${P}-scrape="${c.id}">Récupérer</button>
          <button class="btn small" data-${P}-edit="${c.id}">Modifier</button>
          <button class="btn small danger" data-${P}-del="${c.id}">✕</button>
        </span></td>
      </tr>`,
      )
      .join('');
    if (el('vide')) el('vide').hidden = liste.length !== 0;
    const pag = document.getElementById(`${P}-pagination`);
    if (pag && typeof renderPagination === 'function')
      renderPagination(
        pag,
        page,
        totalPages,
        (p) => {
          page = p;
          rendre();
        },
        liste.length,
      );
  }
  async function chargerRuns() {
    try {
      const runs = await api(ep('/runs'));
      // Rendu partagé « façon récupération en cours » (helper global de app.js).
      renderHistorique(document.getElementById(`hist-${source}`), runs);
    } catch {
      /* ignore */
    }
  }

  const form = $(`#form-${source}`);
  function resetForm() {
    form.reset();
    form.id.value = '';
    if (el('form-titre')) el('form-titre').textContent = `Ajouter un client ${label}`;
    if (el('submit')) el('submit').textContent = 'Enregistrer';
    if (el('cancel')) el('cancel').hidden = true;
    form.password.required = true;
  }
  el('cancel')?.addEventListener('click', resetForm);
  form.password.required = true;
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!e.isTrusted) return; // soumission de script/extension (gestionnaire de mdp), pas d'un clic
    const btn = el('submit');
    if (btn.disabled) return;
    const id = form.id.value;
    const payload = {
      nom: form.nom.value.trim(),
      login: form.login.value.trim(),
      password: form.password.value,
      notes: form.notes.value.trim(),
    };
    if (profession) payload.profession = form.profession.value;
    if (!payload.nom || !payload.login) return toast('Nom et identifiant requis.', 'err');
    if (!id && !payload.password) return toast('Mot de passe requis pour un nouveau client.', 'err');
    btn.disabled = true;
    try {
      if (id) {
        if (!payload.password) delete payload.password;
        await api(ep(`/clients/${id}`), { method: 'PUT', body: JSON.stringify(payload) });
        toast('Client mis à jour.', 'ok');
      } else {
        await api(ep('/clients'), { method: 'POST', body: JSON.stringify(payload) });
        toast('Client ajouté.', 'ok');
      }
      resetForm();
      charger();
    } catch (err) {
      toast(err.message, 'err');
    } finally {
      btn.disabled = false;
    }
  });

  $(`#table-${source}-clients`).addEventListener('click', async (e) => {
    const a = e.target.closest(`[data-${P}-docs]`);
    if (a) {
      e.preventDefault();
      return voirDocs(Number(a.dataset[`${P}Docs`]));
    }
    const btn = e.target.closest(`button[data-${P}-scrape], button[data-${P}-edit], button[data-${P}-del]`);
    if (!btn) return;
    if (btn.dataset[`${P}Scrape`]) return recuperer(Number(btn.dataset[`${P}Scrape`]));
    if (btn.dataset[`${P}Edit`]) return editer(Number(btn.dataset[`${P}Edit`]));
    if (btn.dataset[`${P}Del`]) return supprimer(Number(btn.dataset[`${P}Del`]));
  });

  function editer(id) {
    const c = clients.find((x) => x.id === id);
    if (!c) return;
    form.id.value = c.id;
    form.nom.value = c.nom;
    form.login.value = c.login;
    if (profession) form.profession.value = c.profession || 'cd';
    form.notes.value = c.notes || '';
    form.password.value = '';
    form.password.required = false;
    if (el('form-titre')) el('form-titre').textContent = `Modifier — ${c.nom}`;
    if (el('submit')) el('submit').textContent = 'Mettre à jour';
    if (el('cancel')) el('cancel').hidden = false;
    form.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
  async function supprimer(id) {
    const c = clients.find((x) => x.id === id);
    if (!confirm(`Supprimer le client ${label} « ${c?.nom || id} » ?\n(Les PDF déjà téléchargés ne sont pas supprimés.)`)) return;
    try {
      await api(ep(`/clients/${id}`), { method: 'DELETE' });
      toast('Client supprimé.', 'ok');
      charger();
    } catch (err) {
      toast(err.message, 'err');
    }
  }
  async function recuperer(id, force = false) {
    try {
      const body = { force };
      if (tousDocuments) body.tousDocuments = tousDocsCoche();
      await api(ep(`/clients/${id}/scrape`), { method: 'POST', body: JSON.stringify(body) });
      toast('Récupération lancée — suis la progression en haut.', 'ok');
    } catch (err) {
      if (err.message === 'verrou_mdp') {
        if (confirm('Compte verrouillé (dernier échec = mot de passe).\nForcer quand même la tentative ?')) return recuperer(id, true);
        return;
      }
      toast(err.message, 'err');
    }
  }
  el('scrape-all')?.addEventListener('click', async () => {
    if (!clients.length) return toast(`Aucun client ${label}.`, 'err');
    if (!confirm(`Lancer la récupération ${label} pour TOUS les clients (en série) ?\nLes comptes verrouillés sont ignorés.`)) return;
    try {
      const r = await api(ep('/scrape-all'), { method: 'POST', body: JSON.stringify(tousDocuments ? { tousDocuments: tousDocsCoche() } : {}) });
      let msg = `Récupération lancée : ${r.total} client(s).`;
      if (r.ignores?.length) msg += ` ${r.ignores.length} verrouillé(s) ignoré(s).`;
      if (r.deja) msg += ` Reprise : ${r.deja} déjà récupéré(s), ignoré(s).`;
      toast(msg, 'ok');
      if (el('stop')) el('stop').hidden = false;
      el('scrape-all').disabled = true;
    } catch (err) {
      toast(err.message, 'err');
    }
  });
  el('stop')?.addEventListener('click', async () => {
    try {
      await api('/api/scrape-all/stop', { method: 'POST' });
      toast('Arrêt demandé — fin après le client en cours.', 'ok');
    } catch (err) {
      toast(err.message, 'err');
    }
  });

  async function voirDocs(id) {
    const c = clients.find((x) => x.id === id);
    try {
      const docs = await api(ep(`/clients/${id}/documents`));
      $('#docs-titre').textContent = `Documents ${label} — ${c?.nom || ''}`;
      $('#docs-liste').innerHTML = docs.length
        ? docs
            .map(
              (d) => `<li><span class="lib">${esc(d.libelle || d.fichier.split(/[\\/]/).pop())}</span>
            <a class="btn small" href="${ep(`/documents/${d.id}/file`)}" target="_blank" rel="noopener">Ouvrir</a></li>`,
            )
            .join('')
        : '<li class="aide" style="margin:0;">Aucun document récupéré.</li>';
      $('#dialog-docs').showModal();
    } catch (err) {
      toast(err.message, 'err');
    }
  }

  function parseImport(texte) {
    const lignes = texte
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    if (!lignes.length) return [];
    const sep = lignes[0].match(/\t/) ? '\t' : lignes[0].includes(';') ? ';' : ',';
    const cut = (l) => l.split(sep).map((x) => x.trim());
    const normPro = (v) => (/sf|sage|femme/i.test(v || '') ? 'sf' : 'cd');
    let cols = null;
    const head = cut(lignes[0]).map((h) => h.toLowerCase());
    const re = profession ? /nom|identif|login|dossier|mot|pass|note|profess|metier|métier/ : /nom|identif|login|dossier|mot|pass|note/;
    if (head.some((h) => re.test(h))) {
      cols = profession ? { nom: -1, profession: -1, login: -1, password: -1, notes: -1 } : { nom: -1, login: -1, password: -1, notes: -1 };
      head.forEach((h, i) => {
        if (/nom/.test(h)) cols.nom = i;
        else if (profession && /profess|metier|métier/.test(h)) cols.profession = i;
        else if (/identif|login|dossier/.test(h)) cols.login = i;
        else if (/mot|pass/.test(h)) cols.password = i;
        else if (/note/.test(h)) cols.notes = i;
      });
      lignes.shift();
    }
    return lignes.map((l) => {
      const v = cut(l);
      if (cols) {
        const o = { nom: v[cols.nom] || '', login: v[cols.login] || '', password: v[cols.password] || '', notes: cols.notes >= 0 ? v[cols.notes] || '' : '' };
        if (profession) o.profession = normPro(cols.profession >= 0 ? v[cols.profession] : '');
        return o;
      }
      if (profession) return { nom: v[0] || '', profession: normPro(v[1]), login: v[2] || '', password: v[3] || '', notes: v[4] || '' };
      return { nom: v[0] || '', login: v[1] || '', password: v[2] || '', notes: v[3] || '' };
    });
  }
  el('import-btn')?.addEventListener('click', async () => {
    const rows = parseImport(el('import-texte').value);
    if (!rows.length) return toast('Rien à importer.', 'err');
    try {
      const b = await api(ep('/clients/import'), { method: 'POST', body: JSON.stringify({ clients: rows }) });
      let msg = `${b.crees} créé(s), ${b.maj} mis à jour`;
      if (b.erreurs?.length) msg += `, ${b.erreurs.length} erreur(s)`;
      if (el('import-bilan')) el('import-bilan').textContent = msg;
      toast(msg, b.erreurs?.length ? 'err' : 'ok');
      el('import-texte').value = '';
      charger();
    } catch (err) {
      toast(err.message, 'err');
    }
  });

  el('recherche')?.addEventListener('input', (e) => {
    filtre = e.target.value.trim();
    page = 1;
    rendre();
  });
  el('filtre-etat')?.addEventListener('change', (e) => {
    filtreEtat = e.target.value;
    page = 1;
    rendre();
  });

  charger();
  setInterval(() => {
    api('/api/status')
      .then((s) => {
        const actif = Array.isArray(s.enCours) && s.enCours.some((k) => String(k).startsWith(source));
        if (el('scrape-all')) el('scrape-all').disabled = actif;
        if (el('stop')) el('stop').hidden = !actif;
      })
      .catch(() => {});
    charger();
  }, 6000);
}
