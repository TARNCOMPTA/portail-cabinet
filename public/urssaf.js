// Logique de la section URSSAF. Charge APRES app.js : reutilise $, api, toast, esc, activerOnglet.
(() => {
  let cabinets = [];
  let clients = [];
  let filtre = '';
  let filtreCab = '';
  let page = 1;
  const PAR_PAGE = 20;

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
    return '<span class="badge">—</span>';
  };

  // ---- Comptes cabinet ----
  async function chargerCabinets() {
    try {
      cabinets = await api('/api/urssaf/cabinets');
    } catch {
      return;
    }
    $('#table-urssaf-cabinets').hidden = cabinets.length === 0;
    $('#u-cab-vide').hidden = cabinets.length !== 0;
    $('#table-urssaf-cabinets tbody').innerHTML = cabinets
      .map(
        (c) => `
      <tr><td>${esc(c.libelle || c.login)}</td><td class="siret">${esc(c.login)}</td><td>${c.nb_clients}</td>
      <td><span class="row-actions">
        <button class="btn small primary" data-ucab="sync" data-id="${c.id}">↻ Synchroniser</button>
        <button class="btn small" data-ucab="edit" data-id="${c.id}">Modifier</button>
        <button class="btn small danger" data-ucab="del" data-id="${c.id}">✕</button>
      </span></td></tr>`,
      )
      .join('');
    const opts = '<option value="">— compte —</option>' + cabinets.map((c) => `<option value="${c.id}">${esc(c.libelle || c.login)}</option>`).join('');
    $('#u-client-cabinet').innerHTML = opts;
    $('#u-filtre-cabinet').innerHTML =
      '<option value="">Tous les comptes</option>' + cabinets.map((c) => `<option value="${c.id}">${esc(c.libelle || c.login)}</option>`).join('');
  }

  const formCab = $('#form-urssaf-cabinet');
  function resetCab() {
    formCab.reset();
    formCab.id.value = '';
    $('#ucab-submit').textContent = 'Ajouter le compte';
    $('#ucab-cancel').hidden = true;
  }
  $('#ucab-cancel').addEventListener('click', resetCab);
  formCab.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('#ucab-submit');
    if (btn.disabled) return;
    const id = formCab.id.value;
    const payload = { libelle: formCab.libelle.value.trim(), login: formCab.login.value.trim(), password: formCab.password.value };
    if (!id && !payload.login) return toast('Identifiant (e-mail) requis.', 'err');
    btn.disabled = true;
    try {
      if (id) {
        await api(`/api/urssaf/cabinets/${id}`, { method: 'PUT', body: JSON.stringify(payload) });
        toast('Compte mis à jour.', 'ok');
      } else {
        await api('/api/urssaf/cabinets', { method: 'POST', body: JSON.stringify(payload) });
        toast('Compte ajouté.', 'ok');
      }
      resetCab();
      chargerCabinets();
    } catch (err) {
      toast(err.message, 'err');
    } finally {
      btn.disabled = false;
    }
  });

  $('#table-urssaf-cabinets').addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-ucab]');
    if (!btn) return;
    const id = Number(btn.dataset.id);
    const cab = cabinets.find((c) => c.id === id);
    if (btn.dataset.ucab === 'sync') {
      btn.disabled = true;
      const t = btn.textContent;
      btn.textContent = '↻ Sync…';
      try {
        const r = await api(`/api/urssaf/cabinets/${id}/sync`, { method: 'POST' });
        let msg = `${r.total} client(s) : ${r.crees} ajouté(s), ${r.maj} mis à jour`;
        if (r.erreurs?.length) msg += `, ${r.erreurs.length} erreur(s)`;
        toast(msg, 'ok');
        chargerCabinets();
        chargerClients();
      } catch (err) {
        toast(err.message, 'err');
      } finally {
        btn.disabled = false;
        btn.textContent = t;
      }
    } else if (btn.dataset.ucab === 'edit') {
      formCab.id.value = cab.id;
      formCab.libelle.value = cab.libelle || '';
      formCab.login.value = cab.login;
      formCab.password.value = '';
      $('#ucab-submit').textContent = 'Mettre à jour';
      $('#ucab-cancel').hidden = false;
      formCab.scrollIntoView({ behavior: 'smooth', block: 'center' });
    } else if (btn.dataset.ucab === 'del') {
      if (!confirm(`Supprimer le compte « ${cab?.libelle || cab?.login} » ?\nSes clients ne seront plus rattachés.`)) return;
      try {
        await api(`/api/urssaf/cabinets/${id}`, { method: 'DELETE' });
        toast('Compte supprimé.', 'ok');
        chargerCabinets();
        chargerClients();
      } catch (err) {
        toast(err.message, 'err');
      }
    }
  });

  // ---- Clients ----
  async function chargerClients() {
    try {
      clients = await api('/api/urssaf/clients');
    } catch {
      return;
    }
    const n = clients.length;
    $('#u-compte').textContent = n ? `${n}` : '';
    const navc = document.getElementById('nav-urssaf-count');
    if (navc) navc.textContent = n || '';
    rendre();
    chargerRuns();
  }
  function rendre() {
    const q = filtre.toLowerCase();
    let liste = clients;
    if (filtreCab) liste = liste.filter((c) => String(c.cabinet_id) === filtreCab);
    if (q) liste = liste.filter((c) => `${c.nom} ${c.siret} ${c.cabinet_libelle || ''}`.toLowerCase().includes(q));
    const totalPages = Math.max(1, Math.ceil(liste.length / PAR_PAGE));
    if (page > totalPages) page = totalPages;
    if (page < 1) page = 1;
    $('#table-urssaf-clients tbody').innerHTML = liste
      .slice((page - 1) * PAR_PAGE, page * PAR_PAGE)
      .map(
        (c) => `
      <tr>
        <td>${esc(c.nom)}</td>
        <td class="siret">${esc(c.siret)}</td>
        <td>${c.cabinet_libelle ? `<span class="badge cab">${esc(c.cabinet_libelle)}</span>` : '<span class="badge err">aucun</span>'}</td>
        <td>${c.nb_docs ? `<a href="#" data-u-docs="${c.id}" style="color:var(--accent);font-weight:600;text-decoration:none;">${c.nb_docs}</a>` : '0'}</td>
        <td>${statutBadge(c.dernier_statut)} <span class="aide" style="margin:0;">${fmtDate(c.dernier_run)}</span></td>
        <td><span class="row-actions">
          <button class="btn small primary" data-u-scrape="${c.id}"${c.cabinet_id ? '' : ' disabled title="Rattache ce client à un compte"'}>Récupérer</button>
          <button class="btn small" data-u-edit="${c.id}">Modifier</button>
          <button class="btn small danger" data-u-del="${c.id}">✕</button>
        </span></td>
      </tr>`,
      )
      .join('');
    $('#u-vide').hidden = liste.length !== 0;
    const pag = document.getElementById('u-pagination');
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
      const runs = await api('/api/urssaf/runs');
      $('#table-urssaf-runs tbody').innerHTML = runs
        .slice(0, 100)
        .map(
          (r) => `
        <tr><td>${fmtDate(r.lance_le)}</td><td>${esc(r.client_nom || '—')}</td><td>${statutBadge(r.statut)}</td><td>${r.nb_docs ?? 0}</td><td class="aide" style="margin:0;">${esc(r.message || '')}</td></tr>`,
        )
        .join('');
    } catch {
      /* ignore */
    }
  }

  const formCli = $('#form-urssaf-client');
  function resetCli() {
    formCli.reset();
    formCli.id.value = '';
    $('#u-submit').textContent = 'Enregistrer le client';
    $('#u-cancel').hidden = true;
  }
  $('#u-cancel').addEventListener('click', resetCli);
  formCli.addEventListener('submit', async (e) => {
    e.preventDefault();
    const id = formCli.id.value;
    const payload = {
      nom: formCli.nom.value.trim(),
      siret: formCli.siret.value.trim(),
      cabinet_id: formCli.cabinet_id.value ? Number(formCli.cabinet_id.value) : null,
    };
    if (!payload.nom || !payload.siret) return toast('Nom et SIRET requis.', 'err');
    try {
      if (id) {
        await api(`/api/urssaf/clients/${id}`, { method: 'PUT', body: JSON.stringify(payload) });
        toast('Client mis à jour.', 'ok');
      } else {
        await api('/api/urssaf/clients', { method: 'POST', body: JSON.stringify(payload) });
        toast('Client ajouté.', 'ok');
      }
      resetCli();
      chargerClients();
    } catch (err) {
      toast(err.message, 'err');
    }
  });

  $('#table-urssaf-clients').addEventListener('click', async (e) => {
    const a = e.target.closest('[data-u-docs]');
    if (a) {
      e.preventDefault();
      return voirDocs(Number(a.dataset.uDocs));
    }
    const btn = e.target.closest('button[data-u-scrape], button[data-u-edit], button[data-u-del]');
    if (!btn) return;
    if (btn.dataset.uScrape) return recuperer(Number(btn.dataset.uScrape));
    if (btn.dataset.uEdit) {
      const c = clients.find((x) => x.id === Number(btn.dataset.uEdit));
      if (!c) return;
      formCli.id.value = c.id;
      formCli.nom.value = c.nom;
      formCli.siret.value = c.siret;
      formCli.cabinet_id.value = c.cabinet_id || '';
      $('#u-submit').textContent = 'Mettre à jour';
      $('#u-cancel').hidden = false;
      formCli.closest('details').open = true;
      formCli.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
    if (btn.dataset.uDel) {
      const c = clients.find((x) => x.id === Number(btn.dataset.uDel));
      if (!confirm(`Supprimer le client « ${c?.nom} » ?`)) return;
      try {
        await api(`/api/urssaf/clients/${btn.dataset.uDel}`, { method: 'DELETE' });
        toast('Client supprimé.', 'ok');
        chargerClients();
      } catch (err) {
        toast(err.message, 'err');
      }
    }
  });

  async function recuperer(id) {
    try {
      await api(`/api/urssaf/clients/${id}/scrape`, { method: 'POST', body: JSON.stringify({}) });
      toast('Récupération lancée — suis la progression en haut.', 'ok');
    } catch (err) {
      toast(err.message, 'err');
    }
  }
  $('#u-scrape-all').addEventListener('click', async () => {
    if (!confirm('Lancer la récupération URSSAF pour TOUS les clients ?\n(Une connexion par compte cabinet, puis enchaînement.)')) return;
    try {
      const r = await api('/api/urssaf/scrape-all', { method: 'POST', body: JSON.stringify({}) });
      toast(`Récupération lancée : ${r.total} client(s).`, 'ok');
      $('#u-stop').hidden = false;
      $('#u-scrape-all').disabled = true;
    } catch (err) {
      toast(err.message, 'err');
    }
  });
  $('#u-stop').addEventListener('click', async () => {
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
      const docs = await api(`/api/urssaf/clients/${id}/documents`);
      $('#docs-titre').textContent = `Documents URSSAF — ${c?.nom || ''}`;
      $('#docs-liste').innerHTML = docs.length
        ? docs
            .map(
              (d) => `<li><span class="lib">${esc(d.libelle || d.fichier.split(/[\\/]/).pop())}</span>
            <a class="btn small" href="/api/urssaf/documents/${d.id}/file" target="_blank" rel="noopener">Ouvrir</a></li>`,
            )
            .join('')
        : '<li class="aide" style="margin:0;">Aucun document récupéré.</li>';
      $('#dialog-docs').showModal();
    } catch (err) {
      toast(err.message, 'err');
    }
  }

  // ---- Import ----
  function parseImport(texte) {
    const lignes = texte
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    if (!lignes.length) return [];
    const sep = lignes[0].match(/\t/) ? '\t' : lignes[0].includes(';') ? ';' : ',';
    const cut = (l) => l.split(sep).map((x) => x.trim());
    let cols = null;
    const head = cut(lignes[0]).map((h) => h.toLowerCase());
    if (head.some((h) => /nom|siret|compte|identifiant/.test(h))) {
      cols = { nom: -1, siret: -1 };
      head.forEach((h, i) => {
        if (/nom/.test(h)) cols.nom = i;
        else if (/siret|compte|identifiant/.test(h)) cols.siret = i;
      });
      lignes.shift();
    }
    return lignes.map((l) => {
      const v = cut(l);
      return cols ? { nom: v[cols.nom] || '', siret: v[cols.siret] || '' } : { nom: v[0] || '', siret: v[1] || '' };
    });
  }
  $('#u-import-btn').addEventListener('click', async () => {
    const rows = parseImport($('#u-import-texte').value);
    if (!rows.length) return toast('Rien à importer.', 'err');
    const cabinet_id = $('#u-client-cabinet').value ? Number($('#u-client-cabinet').value) : null;
    try {
      const b = await api('/api/urssaf/clients/import', { method: 'POST', body: JSON.stringify({ clients: rows, cabinet_id }) });
      let msg = `${b.crees} créé(s), ${b.maj} mis à jour`;
      if (b.erreurs?.length) msg += `, ${b.erreurs.length} erreur(s)`;
      $('#u-import-bilan').textContent = msg;
      toast(msg, b.erreurs?.length ? 'err' : 'ok');
      $('#u-import-texte').value = '';
      chargerClients();
    } catch (err) {
      toast(err.message, 'err');
    }
  });

  $('#u-recherche').addEventListener('input', (e) => {
    filtre = e.target.value.trim();
    page = 1;
    rendre();
  });
  $('#u-filtre-cabinet').addEventListener('change', (e) => {
    filtreCab = e.target.value;
    page = 1;
    rendre();
  });

  // ---- Init + rafraichissement ----
  chargerCabinets();
  chargerClients();
  setInterval(() => {
    api('/api/status')
      .then((s) => {
        const actif = Array.isArray(s.enCours) && s.enCours.some((k) => String(k).startsWith('urssaf'));
        $('#u-scrape-all').disabled = actif;
        $('#u-stop').hidden = !actif;
      })
      .catch(() => {});
    chargerClients();
  }, 6000);
})();
