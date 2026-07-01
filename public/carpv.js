// Logique de la section CARPV (retraite des vétérinaires).
// Charge APRES app.js : reutilise $, api, toast, esc, renderPagination.
(() => {
  let clients = [];
  let filtre = '';
  let page = 1;
  const PAR_PAGE = 20;

  const fmtDate = (s) => {
    if (!s) return '—';
    const d = new Date(String(s).replace(' ', 'T'));
    return isNaN(d) ? s : d.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: '2-digit' }) + ' ' + d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  };
  const statutBadge = (st) => {
    if (st === 'succes') return '<span class="badge ok">OK</span>';
    if (st === 'echec_mdp') return '<span class="badge err">🔒 mdp</span>';
    if (st === 'echec') return '<span class="badge err">échec</span>';
    return '<span class="badge">—</span>';
  };

  async function charger() {
    try { clients = await api('/api/carpv/clients'); } catch { return; }
    const n = clients.length;
    $('#cv-compte').textContent = n ? `${n}` : '';
    const navc = document.getElementById('nav-carpv-count'); if (navc) navc.textContent = n || '';
    rendre();
    chargerRuns();
  }
  function rendre() {
    const q = filtre.toLowerCase();
    const liste = q ? clients.filter((c) => `${c.nom} ${c.login} ${c.notes || ''}`.toLowerCase().includes(q)) : clients;
    const totalPages = Math.max(1, Math.ceil(liste.length / PAR_PAGE));
    if (page > totalPages) page = totalPages;
    if (page < 1) page = 1;
    const tb = $('#table-carpv-clients tbody');
    tb.innerHTML = liste.slice((page - 1) * PAR_PAGE, page * PAR_PAGE).map((c) => `
      <tr${c.verrouille ? ' style="background:var(--err-bg);"' : ''}>
        <td>${c.verrouille ? '🔒 ' : ''}${esc(c.nom)}</td>
        <td class="siret">${esc(c.login)}</td>
        <td>${esc(c.notes || '')}</td>
        <td>${c.nb_docs ? `<a href="#" data-cv-docs="${c.id}" style="color:var(--accent);font-weight:600;text-decoration:none;">${c.nb_docs}</a>` : '0'}</td>
        <td>${statutBadge(c.dernier_statut)} <span class="aide" style="margin:0;">${fmtDate(c.dernier_run)}</span></td>
        <td><span class="row-actions">
          <button class="btn small primary" data-cv-scrape="${c.id}">Récupérer</button>
          <button class="btn small" data-cv-edit="${c.id}">Modifier</button>
          <button class="btn small danger" data-cv-del="${c.id}">✕</button>
        </span></td>
      </tr>`).join('');
    $('#cv-vide').hidden = liste.length !== 0;
    const pag = document.getElementById('cv-pagination');
    if (pag && typeof renderPagination === 'function') renderPagination(pag, page, totalPages, (p) => { page = p; rendre(); }, liste.length);
  }
  async function chargerRuns() {
    try {
      const runs = await api('/api/carpv/runs');
      $('#table-carpv-runs tbody').innerHTML = runs.slice(0, 100).map((r) => `
        <tr><td>${fmtDate(r.lance_le)}</td><td>${esc(r.client_nom || '—')}</td>
        <td>${statutBadge(r.statut)}</td><td>${r.nb_docs ?? 0}</td><td class="aide" style="margin:0;">${esc(r.message || '')}</td></tr>`).join('');
    } catch { /* ignore */ }
  }

  const form = $('#form-carpv');
  function resetForm() {
    form.reset(); form.id.value = '';
    $('#cv-form-titre').textContent = 'Ajouter un client CARPV';
    $('#cv-submit').textContent = 'Enregistrer';
    $('#cv-cancel').hidden = true;
    form.password.required = true;
  }
  $('#cv-cancel').addEventListener('click', resetForm);
  form.password.required = true;
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('#cv-submit');
    if (btn.disabled) return;
    const id = form.id.value;
    const payload = { nom: form.nom.value.trim(), login: form.login.value.trim(), password: form.password.value, notes: form.notes.value.trim(), dossier: form.dossier.value.trim() };
    if (!payload.nom || !payload.login) return toast('Nom et identifiant requis.', 'err');
    if (!id && !payload.password) return toast('Mot de passe requis pour un nouveau client.', 'err');
    btn.disabled = true;
    try {
      if (id) {
        if (!payload.password) delete payload.password;
        await api(`/api/carpv/clients/${id}`, { method: 'PUT', body: JSON.stringify(payload) });
        toast('Client mis à jour.', 'ok');
      } else {
        await api('/api/carpv/clients', { method: 'POST', body: JSON.stringify(payload) });
        toast('Client ajouté.', 'ok');
      }
      resetForm(); charger();
    } catch (err) { toast(err.message, 'err'); }
    finally { btn.disabled = false; }
  });

  $('#table-carpv-clients').addEventListener('click', async (e) => {
    const a = e.target.closest('[data-cv-docs]');
    if (a) { e.preventDefault(); return voirDocs(Number(a.dataset.cvDocs)); }
    const btn = e.target.closest('button[data-cv-scrape], button[data-cv-edit], button[data-cv-del]');
    if (!btn) return;
    if (btn.dataset.cvScrape) return recuperer(Number(btn.dataset.cvScrape));
    if (btn.dataset.cvEdit) return editer(Number(btn.dataset.cvEdit));
    if (btn.dataset.cvDel) return supprimer(Number(btn.dataset.cvDel));
  });

  function editer(id) {
    const c = clients.find((x) => x.id === id);
    if (!c) return;
    form.id.value = c.id; form.nom.value = c.nom; form.login.value = c.login;
    form.notes.value = c.notes || ''; form.dossier.value = c.dossier || ''; form.password.value = '';
    form.password.required = false;
    $('#cv-form-titre').textContent = `Modifier — ${c.nom}`;
    $('#cv-submit').textContent = 'Mettre à jour';
    $('#cv-cancel').hidden = false;
    form.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
  async function supprimer(id) {
    const c = clients.find((x) => x.id === id);
    if (!confirm(`Supprimer le client CARPV « ${c?.nom || id} » ?\n(Les PDF déjà téléchargés ne sont pas supprimés.)`)) return;
    try { await api(`/api/carpv/clients/${id}`, { method: 'DELETE' }); toast('Client supprimé.', 'ok'); charger(); }
    catch (err) { toast(err.message, 'err'); }
  }
  async function recuperer(id, force = false) {
    try {
      await api(`/api/carpv/clients/${id}/scrape`, { method: 'POST', body: JSON.stringify({ force }) });
      toast('Récupération lancée — suis la progression en haut.', 'ok');
    } catch (err) {
      if (err.message === 'verrou_mdp') {
        if (confirm('Compte verrouillé (dernier échec = mot de passe).\nForcer quand même la tentative ?')) return recuperer(id, true);
        return;
      }
      toast(err.message, 'err');
    }
  }
  $('#cv-scrape-all').addEventListener('click', async () => {
    if (!clients.length) return toast('Aucun client CARPV.', 'err');
    if (!confirm('Lancer la récupération CARPV pour TOUS les clients (en série) ?\nLes comptes verrouillés sont ignorés.')) return;
    try {
      const r = await api('/api/carpv/scrape-all', { method: 'POST', body: JSON.stringify({}) });
      let msg = `Récupération lancée : ${r.total} client(s).`;
      if (r.ignores?.length) msg += ` ${r.ignores.length} verrouillé(s) ignoré(s).`;
      toast(msg, 'ok');
      $('#cv-stop').hidden = false; $('#cv-scrape-all').disabled = true;
    } catch (err) { toast(err.message, 'err'); }
  });
  $('#cv-stop').addEventListener('click', async () => {
    try { await api('/api/scrape-all/stop', { method: 'POST' }); toast('Arrêt demandé — fin après le client en cours.', 'ok'); }
    catch (err) { toast(err.message, 'err'); }
  });

  async function voirDocs(id) {
    const c = clients.find((x) => x.id === id);
    try {
      const docs = await api(`/api/carpv/clients/${id}/documents`);
      $('#docs-titre').textContent = `Documents CARPV — ${c?.nom || ''}`;
      $('#docs-liste').innerHTML = docs.length
        ? docs.map((d) => `<li><span class="lib">${esc(d.libelle || d.fichier.split(/[\\/]/).pop())}</span>
            <a class="btn small" href="/api/carpv/documents/${d.id}/file" target="_blank" rel="noopener">Ouvrir</a></li>`).join('')
        : '<li class="aide" style="margin:0;">Aucun document récupéré.</li>';
      $('#dialog-docs').showModal();
    } catch (err) { toast(err.message, 'err'); }
  }

  function parseImport(texte) {
    const lignes = texte.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (!lignes.length) return [];
    const sep = (lignes[0].match(/\t/) ? '\t' : lignes[0].includes(';') ? ';' : ',');
    const cut = (l) => l.split(sep).map((x) => x.trim());
    let cols = null;
    const head = cut(lignes[0]).map((h) => h.toLowerCase());
    if (head.some((h) => /nom|identif|login|mot|pass|note/.test(h))) {
      cols = { nom: -1, login: -1, password: -1, notes: -1 };
      head.forEach((h, i) => {
        if (/nom/.test(h)) cols.nom = i;
        else if (/identif|login/.test(h)) cols.login = i;
        else if (/mot|pass/.test(h)) cols.password = i;
        else if (/note/.test(h)) cols.notes = i;
      });
      lignes.shift();
    }
    return lignes.map((l) => {
      const v = cut(l);
      return cols
        ? { nom: v[cols.nom] || '', login: v[cols.login] || '', password: v[cols.password] || '', notes: cols.notes >= 0 ? v[cols.notes] || '' : '' }
        : { nom: v[0] || '', login: v[1] || '', password: v[2] || '', notes: v[3] || '' };
    });
  }
  $('#cv-import-btn').addEventListener('click', async () => {
    const rows = parseImport($('#cv-import-texte').value);
    if (!rows.length) return toast('Rien à importer.', 'err');
    try {
      const b = await api('/api/carpv/clients/import', { method: 'POST', body: JSON.stringify({ clients: rows }) });
      let msg = `${b.crees} créé(s), ${b.maj} mis à jour`;
      if (b.erreurs?.length) msg += `, ${b.erreurs.length} erreur(s)`;
      $('#cv-import-bilan').textContent = msg;
      toast(msg, b.erreurs?.length ? 'err' : 'ok');
      $('#cv-import-texte').value = ''; charger();
    } catch (err) { toast(err.message, 'err'); }
  });

  $('#cv-recherche').addEventListener('input', (e) => { filtre = e.target.value.trim(); page = 1; rendre(); });

  charger();
  setInterval(() => {
    api('/api/status').then((s) => {
      const actif = Array.isArray(s.enCours) && s.enCours.some((k) => String(k).startsWith('carpv'));
      $('#cv-scrape-all').disabled = actif;
      $('#cv-stop').hidden = !actif;
    }).catch(() => {});
    charger();
  }, 6000);
})();
