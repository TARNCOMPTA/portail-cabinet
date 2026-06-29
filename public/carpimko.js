// Logique de la section CARPIMKO. Charge APRES app.js : reutilise les helpers
// globaux $, api, toast, esc et la fonction activerOnglet.
(() => {
  let clients = [];
  let filtre = '';

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

  // ---- Chargement + rendu liste clients ----
  async function charger() {
    try { clients = await api('/api/carpimko/clients'); } catch { return; }
    const n = clients.length;
    $('#cp-compte').textContent = n ? `${n}` : '';
    const navc = document.getElementById('nav-carpimko-count'); if (navc) navc.textContent = n || '';
    rendre();
    chargerRuns();
  }

  function rendre() {
    const q = filtre.toLowerCase();
    const liste = q ? clients.filter((c) => `${c.nom} ${c.login} ${c.notes || ''}`.toLowerCase().includes(q)) : clients;
    const tb = $('#table-carpimko-clients tbody');
    tb.innerHTML = liste.map((c) => `
      <tr${c.verrouille ? ' style="background:var(--err-bg);"' : ''}>
        <td>${c.verrouille ? '🔒 ' : ''}${esc(c.nom)}</td>
        <td class="siret">${esc(c.login)}</td>
        <td>${esc(c.notes || '')}</td>
        <td>${c.nb_docs ? `<a href="#" data-cp-docs="${c.id}" style="color:var(--accent);font-weight:600;text-decoration:none;">${c.nb_docs}</a>` : '0'}</td>
        <td>${statutBadge(c.dernier_statut)} <span class="aide" style="margin:0;">${fmtDate(c.dernier_run)}</span></td>
        <td><span class="row-actions">
          <button class="btn small primary" data-cp-scrape="${c.id}">Récupérer</button>
          <button class="btn small" data-cp-edit="${c.id}">Modifier</button>
          <button class="btn small danger" data-cp-del="${c.id}">✕</button>
        </span></td>
      </tr>`).join('');
    $('#cp-vide').hidden = liste.length !== 0;
  }

  async function chargerRuns() {
    try {
      const runs = await api('/api/carpimko/runs');
      $('#table-carpimko-runs tbody').innerHTML = runs.slice(0, 100).map((r) => `
        <tr><td>${fmtDate(r.lance_le)}</td><td>${esc(r.client_nom || '—')}</td>
        <td>${statutBadge(r.statut)}</td><td>${r.nb_docs ?? 0}</td><td class="aide" style="margin:0;">${esc(r.message || '')}</td></tr>`).join('');
    } catch { /* ignore */ }
  }

  // ---- Formulaire ajout / modif ----
  const form = $('#form-carpimko');
  function resetForm() {
    form.reset(); form.id.value = '';
    $('#cp-form-titre').textContent = 'Ajouter un client CARPIMKO';
    $('#cp-submit').textContent = 'Enregistrer';
    $('#cp-cancel').hidden = true;
    form.password.required = true;
  }
  $('#cp-cancel').addEventListener('click', resetForm);
  form.password.required = true;

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('#cp-submit');
    if (btn.disabled) return;
    const id = form.id.value;
    const payload = {
      nom: form.nom.value.trim(), login: form.login.value.trim(),
      password: form.password.value, notes: form.notes.value.trim(), dossier: form.dossier.value.trim(),
    };
    if (!payload.nom || !payload.login) return toast('Nom et numéro de dossier requis.', 'err');
    if (!id && !payload.password) return toast('Mot de passe requis pour un nouveau client.', 'err');
    btn.disabled = true;
    try {
      if (id) {
        if (!payload.password) delete payload.password; // ne pas écraser le mdp si laissé vide
        await api(`/api/carpimko/clients/${id}`, { method: 'PUT', body: JSON.stringify(payload) });
        toast('Client mis à jour.', 'ok');
      } else {
        await api('/api/carpimko/clients', { method: 'POST', body: JSON.stringify(payload) });
        toast('Client ajouté.', 'ok');
      }
      resetForm();
      charger();
    } catch (err) { toast(err.message, 'err'); }
    finally { btn.disabled = false; }
  });

  // ---- Actions table (délégation) ----
  $('#table-carpimko-clients').addEventListener('click', async (e) => {
    const a = e.target.closest('[data-cp-docs]');
    if (a) { e.preventDefault(); return voirDocs(Number(a.dataset.cpDocs)); }
    const btn = e.target.closest('button[data-cp-scrape], button[data-cp-edit], button[data-cp-del]');
    if (!btn) return;
    if (btn.dataset.cpScrape) return recuperer(Number(btn.dataset.cpScrape));
    if (btn.dataset.cpEdit) return editer(Number(btn.dataset.cpEdit));
    if (btn.dataset.cpDel) return supprimer(Number(btn.dataset.cpDel));
  });

  function editer(id) {
    const c = clients.find((x) => x.id === id);
    if (!c) return;
    form.id.value = c.id; form.nom.value = c.nom; form.login.value = c.login;
    form.notes.value = c.notes || ''; form.dossier.value = c.dossier || ''; form.password.value = '';
    form.password.required = false;
    $('#cp-form-titre').textContent = `Modifier — ${c.nom}`;
    $('#cp-submit').textContent = 'Mettre à jour';
    $('#cp-cancel').hidden = false;
    form.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  async function supprimer(id) {
    const c = clients.find((x) => x.id === id);
    if (!confirm(`Supprimer le client CARPIMKO « ${c?.nom || id} » ?\n(Les PDF déjà téléchargés sur le disque ne sont pas supprimés.)`)) return;
    try { await api(`/api/carpimko/clients/${id}`, { method: 'DELETE' }); toast('Client supprimé.', 'ok'); charger(); }
    catch (err) { toast(err.message, 'err'); }
  }

  async function recuperer(id, force = false) {
    const tousDocuments = $('#cp-tous-docs').checked;
    try {
      await api(`/api/carpimko/clients/${id}/scrape`, { method: 'POST', body: JSON.stringify({ tousDocuments, force }) });
      toast('Récupération lancée — suis la progression en haut.', 'ok');
    } catch (err) {
      if (err.message === 'verrou_mdp') {
        if (confirm('Compte verrouillé (la dernière connexion a échoué pour mot de passe).\nForcer quand même la tentative ? (risque de blocage du compte)')) return recuperer(id, true);
        return;
      }
      toast(err.message, 'err');
    }
  }

  // ---- Tout récupérer + arrêt ----
  $('#cp-scrape-all').addEventListener('click', async () => {
    if (!clients.length) return toast('Aucun client CARPIMKO.', 'err');
    if (!confirm('Lancer la récupération CARPIMKO pour TOUS les clients (en série) ?\nLes comptes verrouillés sont ignorés.')) return;
    const tousDocuments = $('#cp-tous-docs').checked;
    try {
      const r = await api('/api/carpimko/scrape-all', { method: 'POST', body: JSON.stringify({ tousDocuments }) });
      let msg = `Récupération lancée : ${r.total} client(s).`;
      if (r.ignores?.length) msg += ` ${r.ignores.length} verrouillé(s) ignoré(s).`;
      toast(msg, 'ok');
      $('#cp-stop').hidden = false; $('#cp-scrape-all').disabled = true;
    } catch (err) { toast(err.message, 'err'); }
  });
  $('#cp-stop').addEventListener('click', async () => {
    try { await api('/api/scrape-all/stop', { method: 'POST' }); toast('Arrêt demandé — fin après le client en cours.', 'ok'); }
    catch (err) { toast(err.message, 'err'); }
  });

  // ---- Documents d'un client (réutilise le dialog partagé) ----
  async function voirDocs(id) {
    const c = clients.find((x) => x.id === id);
    try {
      const docs = await api(`/api/carpimko/clients/${id}/documents`);
      $('#docs-titre').textContent = `Documents — ${c?.nom || ''}`;
      $('#docs-liste').innerHTML = docs.length
        ? docs.map((d) => `<li><span class="lib">${esc(d.libelle || d.fichier.split(/[\\/]/).pop())}</span>
            <a class="btn small" href="/api/carpimko/documents/${d.id}/file" target="_blank" rel="noopener">Ouvrir</a></li>`).join('')
        : '<li class="aide" style="margin:0;">Aucun document récupéré.</li>';
      $('#dialog-docs').showModal();
    } catch (err) { toast(err.message, 'err'); }
  }

  // ---- Import en masse ----
  function parseImport(texte) {
    const lignes = texte.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (!lignes.length) return [];
    const sep = (lignes[0].match(/\t/) ? '\t' : lignes[0].includes(';') ? ';' : ',');
    const cut = (l) => l.split(sep).map((x) => x.trim());
    let cols = null;
    const head = cut(lignes[0]).map((h) => h.toLowerCase());
    const isHeader = head.some((h) => /nom|dossier|login|identifiant|mot|pass|note/.test(h));
    if (isHeader) {
      cols = { nom: -1, login: -1, password: -1, notes: -1 };
      head.forEach((h, i) => {
        if (/nom/.test(h)) cols.nom = i;
        else if (/dossier|login|identifiant/.test(h)) cols.login = i;
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
  $('#cp-import-btn').addEventListener('click', async () => {
    const rows = parseImport($('#cp-import-texte').value);
    if (!rows.length) return toast('Rien à importer.', 'err');
    try {
      const b = await api('/api/carpimko/clients/import', { method: 'POST', body: JSON.stringify({ clients: rows }) });
      let msg = `${b.crees} créé(s), ${b.maj} mis à jour`;
      if (b.erreurs?.length) msg += `, ${b.erreurs.length} erreur(s)`;
      $('#cp-import-bilan').textContent = msg;
      toast(msg, b.erreurs?.length ? 'err' : 'ok');
      $('#cp-import-texte').value = '';
      charger();
    } catch (err) { toast(err.message, 'err'); }
  });

  // ---- Recherche ----
  $('#cp-recherche').addEventListener('input', (e) => { filtre = e.target.value.trim(); rendre(); });

  // ---- Cartes "source" du tableau de bord -> navigation ----
  document.addEventListener('click', (e) => {
    const card = e.target.closest('[data-goto]');
    if (card && typeof activerOnglet === 'function') activerOnglet(card.dataset.goto);
  });

  // ---- Rafraîchissement périodique (récup en arrière-plan) ----
  charger();
  setInterval(() => {
    // Réactive le bouton "Tout récupérer" quand plus aucune récup n'est active.
    api('/api/status').then((s) => {
      const actif = Array.isArray(s.enCours) && s.enCours.some((k) => String(k).startsWith('carpimko'));
      $('#cp-scrape-all').disabled = actif;
      $('#cp-stop').hidden = !actif;
    }).catch(() => {});
    charger();
  }, 6000);
})();
