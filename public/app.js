const $ = (s) => document.querySelector(s);

async function api(url, opts = {}) {
  const res = await fetch(url, { headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', ...opts });
  if (res.status === 401) {
    location.replace('/login.html');
    throw new Error('Session expirée.');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Erreur ${res.status}`);
  return data;
}
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[m]);
}
function toast(msg, type = '') {
  const el = document.createElement('div');
  el.className = 'toast-item ' + type;
  el.textContent = msg;
  $('#toast').appendChild(el);
  setTimeout(() => el.remove(), 5500);
}

// ---- Thème ----
$('#btn-theme').addEventListener('click', () => {
  const t = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', t);
  localStorage.setItem('theme', t);
});

// ---- Comptes cabinet ------------------------------------------------------
let cabinetsCache = [];
let remoteBrowser = false; // serveur en mode navigateur distant (captcha via noVNC)

async function chargerCabinets() {
  cabinetsCache = await api('/api/cabinets');
  const tbody = $('#table-cabinets tbody');
  tbody.innerHTML = '';
  $('#table-cabinets').hidden = cabinetsCache.length === 0;
  $('.vide-cab').hidden = cabinetsCache.length !== 0;
  for (const c of cabinetsCache) {
    const tr = document.createElement('tr');
    const pwd = '';
    tr.innerHTML = `
      <td>${esc(c.libelle || '—')}${pwd}</td>
      <td><span class="siret">${esc(c.login)}</span></td>
      <td>${c.nb_clients}</td>
      <td><div class="row-actions">
        <button class="btn small primary" data-cab="sync" data-id="${c.id}">↻ Synchroniser</button>
        <button class="btn small" data-cab="habilitations" data-id="${c.id}" data-nom="${esc(c.libelle || c.login)}">Habilitations</button>
        <button class="btn small" data-cab="edit" data-id="${c.id}">Modifier</button>
        <button class="btn small danger" data-cab="del" data-id="${c.id}">Suppr.</button>
      </div></td>`;
    tbody.appendChild(tr);
  }
  remplirSelectCabinets();
}

function remplirSelectCabinets() {
  const sel = $('#client-cabinet');
  const courant = sel.value;
  sel.innerHTML = cabinetsCache.length
    ? cabinetsCache.map((c) => `<option value="${c.id}">${esc(c.libelle || c.login)}</option>`).join('')
    : '<option value="">(aucun — ajoute un compte)</option>';
  if (courant) sel.value = courant;
}

const formCab = $('#form-cabinet');
formCab.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!e.isTrusted) return; // soumission de script/extension (gestionnaire de mdp), pas d'un clic
  const btn = $('#cab-submit');
  if (btn.disabled) return; // anti double-soumission (double-clic / Entrée repete)
  const payload = { libelle: formCab.libelle.value.trim(), login: formCab.login.value.trim(), password: formCab.password.value };
  const id = formCab.id.value;
  if (!id && !payload.login) return toast('Identifiant (e-mail) du compte requis.', 'err');
  btn.disabled = true;
  try {
    if (id) {
      await api(`/api/cabinets/${id}`, { method: 'PUT', body: JSON.stringify(payload) });
      toast('Cabinet mis à jour.', 'ok');
    } else {
      await api('/api/cabinets', { method: 'POST', body: JSON.stringify(payload) });
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
function resetCab() {
  formCab.reset();
  formCab.id.value = '';
  $('#cab-submit').textContent = 'Ajouter le cabinet';
  $('#cab-cancel').hidden = true;
}
$('#cab-cancel').addEventListener('click', resetCab);

$('#table-cabinets').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-cab]');
  if (!btn) return;
  const id = Number(btn.dataset.id);
  const act = btn.dataset.cab;
  const cab = cabinetsCache.find((c) => c.id === id);
  if (act === 'sync') {
    btn.disabled = true;
    btn.textContent = '↻ Sync…';
    if (remoteBrowser) toast('Fenêtre impôts ouverte côté serveur : clique sur « 🖥️ Captcha » (en haut) pour saisir la captcha.', 'ok');
    try {
      const r = await api(`/api/cabinets/${id}/sync`, { method: 'POST' });
      let msg = `${r.total} client(s) : ${r.crees} ajouté(s), ${r.maj} mis à jour`;
      if (r.liste_noire) msg += `, ${r.liste_noire} en liste noire (ignorés)`;
      if (r.erreurs?.length) msg += `, ${r.erreurs.length} erreur(s)`;
      toast(msg, 'ok');
      rafraichir();
    } catch (err) {
      toast(err.message, 'err');
    } finally {
      btn.disabled = false;
      btn.textContent = '↻ Synchroniser';
    }
  } else if (act === 'habilitations') {
    ouvrirHabilitations(id, btn.dataset.nom);
  } else if (act === 'edit') {
    formCab.id.value = cab.id;
    formCab.libelle.value = cab.libelle || '';
    formCab.login.value = cab.login;
    formCab.password.value = '';
    $('#cab-submit').textContent = 'Mettre à jour';
    $('#cab-cancel').hidden = false;
    formCab.scrollIntoView({ behavior: 'smooth' });
  } else if (act === 'del') {
    if (confirm(`Supprimer le cabinet « ${cab.libelle || cab.login} » ?\nSes clients ne seront plus rattachés (à réaffecter ou supprimer).`)) {
      await api(`/api/cabinets/${id}`, { method: 'DELETE' });
      toast('Cabinet supprimé.');
      rafraichir();
    }
  }
});

// ---- Pagination (utilitaire reutilisable) ---------------------------------
function renderPagination(el, page, totalPages, onGo, total) {
  el.innerHTML = '';
  if (totalPages <= 1) {
    el.style.display = 'none';
    return;
  }
  el.style.display = 'flex';
  const mk = (label, p, opts = {}) => {
    const b = document.createElement('button');
    b.textContent = label;
    if (opts.actif) b.className = 'actif';
    b.disabled = !!opts.disabled;
    if (!opts.disabled && p) b.onclick = () => onGo(p);
    return b;
  };
  el.appendChild(mk('«', 1, { disabled: page === 1 }));
  el.appendChild(mk('‹', page - 1, { disabled: page === 1 }));
  const info = document.createElement('span');
  info.className = 'info';
  info.textContent = `Page ${page} / ${totalPages} · ${total} élément(s)`;
  el.appendChild(info);
  el.appendChild(mk('›', page + 1, { disabled: page === totalPages }));
  el.appendChild(mk('»', totalPages, { disabled: page === totalPages }));
}

// ---- Clients --------------------------------------------------------------
let clientsAll = [];
let clientsPage = 1;
let clientsTri = { col: 'nom', dir: 1 };
const selection = new Set();

// Badge du mode de paiement CFE (détecté dans le texte de l'avis) — helper GLOBAL.
function badgePaiementCfe(p) {
  if (p === 'echeance') return '<span class="badge ok" title="L\'avis CFE indique un prélèvement à l\'échéance">Prélevé échéance</span>';
  if (p === 'mensualise') return '<span class="badge ok" title="L\'avis CFE indique une mensualisation">Mensualisé</span>';
  if (p === 'aucun') return '<span class="badge err" title="L\'avis CFE indique : pas d\'adhésion à un prélèvement automatique">⚠ Pas de prélèvement</span>';
  return '';
}

// État de la dernière récupération d'un client — helper GLOBAL, utilisé par les
// filtres « état » des listes clients de toutes les sources (source-ui.js, urssaf.js).
function filtreEtatClient(c, etat) {
  if (!etat) return true;
  if (etat === 'succes') return c.dernier_statut === 'succes';
  if (etat === 'echec') return c.dernier_statut === 'echec';
  if (etat === 'bloque') return c.dernier_statut === 'echec_mdp' || !!c.verrouille;
  if (etat === 'jamais') return !c.dernier_statut;
  return true;
}

// Renvoie la liste filtree + triee (sans pagination).
function clientsFiltres() {
  const q = ($('#clients-recherche').value || '').toLowerCase().trim();
  const cabFiltre = $('#clients-filtre-cabinet').value;
  const etat = $('#clients-filtre-etat')?.value || '';
  let liste = clientsAll.slice();
  if (cabFiltre) liste = liste.filter((c) => String(c.cabinet_id) === cabFiltre);
  // Filtres « paiement CFE » (mode détecté sur le dernier avis CFE du client).
  if (etat.startsWith('cfe-')) liste = liste.filter((c) => c.paiement_cfe === etat.slice(4));
  else if (etat) liste = liste.filter((c) => filtreEtatClient(c, etat));
  if (q) liste = liste.filter((c) => `${c.nom} ${c.siret} ${c.cabinet_libelle || ''}`.toLowerCase().includes(q));
  const { col, dir } = clientsTri;
  const val = (c) =>
    ({
      nom: (c.nom || '').toLowerCase(),
      siret: (c.siret || '').toLowerCase(),
      cabinet: (c.cabinet_libelle || '').toLowerCase(),
      docs: c.nb_docs || 0,
      run: c.dernier_run || '',
    })[col];
  liste.sort((a, b) => {
    const x = val(a),
      y = val(b);
    return x < y ? -dir : x > y ? dir : 0;
  });
  return liste;
}

function renderClients() {
  const liste = clientsFiltres();
  const taille = Number($('#clients-taille').value) || 50;
  const totalPages = Math.max(1, Math.ceil(liste.length / taille));
  if (clientsPage > totalPages) clientsPage = totalPages;
  if (clientsPage < 1) clientsPage = 1;
  const debut = (clientsPage - 1) * taille;
  const slice = liste.slice(debut, debut + taille);

  $('#clients-compte').textContent = liste.length === clientsAll.length ? `${clientsAll.length}` : `${liste.length} / ${clientsAll.length}`;
  const navi = document.getElementById('nav-impots-count');
  if (navi) navi.textContent = clientsAll.length || '';
  $('#table-clients').hidden = clientsAll.length === 0;
  $('.vide').hidden = clientsAll.length !== 0;

  const tbody = $('#table-clients tbody');
  tbody.innerHTML = '';
  for (const c of slice) {
    const tr = document.createElement('tr');
    if (selection.has(c.id)) tr.className = 'selectionne';
    const cab = c.cabinet_libelle ? `<span class="badge cab">${esc(c.cabinet_libelle)}</span>` : '<span class="badge err">aucun</span>';
    tr.innerHTML = `
      <td class="col-check"><input type="checkbox" class="row-check" data-id="${c.id}" ${selection.has(c.id) ? 'checked' : ''} /></td>
      <td>${esc(c.nom)} ${badgePaiementCfe(c.paiement_cfe)}</td>
      <td><span class="siret">${esc(c.siret)}</span></td>
      <td>${cab}</td>
      <td>${c.nb_docs}</td>
      <td>${c.dernier_run ? new Date(c.dernier_run + 'Z').toLocaleString('fr-FR') : '—'}</td>
      <td><div class="row-actions">
        <button class="btn small primary" data-act="scrape" data-id="${c.id}">Récupérer</button>
        <button class="btn small" data-act="docs" data-id="${c.id}" data-nom="${esc(c.nom)}">Documents</button>
        <button class="btn small" data-act="edit" data-id="${c.id}">Modifier</button>
        <button class="btn small danger" data-act="del" data-id="${c.id}">Suppr.</button>
      </div></td>`;
    tbody.appendChild(tr);
  }
  // En-tetes : indicateur de tri
  document.querySelectorAll('#table-clients th.triable').forEach((th) => {
    th.classList.toggle('tri-asc', th.dataset.sort === clientsTri.col && clientsTri.dir === 1);
    th.classList.toggle('tri-desc', th.dataset.sort === clientsTri.col && clientsTri.dir === -1);
  });
  // Case "tout selectionner" : cochee si tous les filtres sont selectionnes
  const idsFiltres = liste.map((c) => c.id);
  $('#check-all').checked = idsFiltres.length > 0 && idsFiltres.every((id) => selection.has(id));
  majBoutonSelection();
  renderPagination(
    $('#clients-pagination'),
    clientsPage,
    totalPages,
    (p) => {
      clientsPage = p;
      renderClients();
    },
    liste.length,
  );
}

function majBoutonSelection() {
  const n = selection.size;
  const b = $('#btn-scrape-selection');
  b.textContent = `Récupérer la sélection (${n})`;
  b.disabled = n === 0;
}

async function chargerClients() {
  clientsAll = await api('/api/clients');
  // Purge la selection des clients disparus
  const ids = new Set(clientsAll.map((c) => c.id));
  for (const id of [...selection]) if (!ids.has(id)) selection.delete(id);
  // Filtre par cabinet (alimente depuis le cache des cabinets)
  const sel = $('#clients-filtre-cabinet');
  const courant = sel.value;
  sel.innerHTML =
    '<option value="">Tous les cabinets</option>' + cabinetsCache.map((c) => `<option value="${c.id}">${esc(c.libelle || c.login)}</option>`).join('');
  sel.value = courant;
  renderClients();
}

$('#clients-recherche').addEventListener('input', () => {
  clientsPage = 1;
  renderClients();
});
$('#clients-filtre-cabinet').addEventListener('change', () => {
  clientsPage = 1;
  renderClients();
});
$('#clients-filtre-etat')?.addEventListener('change', () => {
  clientsPage = 1;
  renderClients();
});
$('#clients-taille').addEventListener('change', () => {
  clientsPage = 1;
  renderClients();
});

// Tri par clic sur l'en-tete
document.querySelectorAll('#table-clients th.triable').forEach((th) => {
  th.addEventListener('click', () => {
    const col = th.dataset.sort;
    if (clientsTri.col === col) clientsTri.dir = -clientsTri.dir;
    else clientsTri = { col, dir: 1 };
    renderClients();
  });
});

// Selection : cases a cocher
$('#table-clients').addEventListener('change', (e) => {
  const cb = e.target.closest('.row-check');
  if (!cb) return;
  const id = Number(cb.dataset.id);
  if (cb.checked) selection.add(id);
  else selection.delete(id);
  cb.closest('tr').classList.toggle('selectionne', cb.checked);
  $('#check-all').checked = clientsFiltres().every((c) => selection.has(c.id));
  majBoutonSelection();
});
$('#check-all').addEventListener('change', (e) => {
  const ids = clientsFiltres().map((c) => c.id);
  if (e.target.checked) ids.forEach((id) => selection.add(id));
  else ids.forEach((id) => selection.delete(id));
  renderClients();
});

// Export CSV de la liste filtree
$('#btn-export-csv').addEventListener('click', () => {
  const liste = clientsFiltres();
  if (!liste.length) return toast('Aucun client à exporter.', 'err');
  const esc2 = (v) => '"' + String(v ?? '').replace(/"/g, '""') + '"';
  const lignes = [['Nom', 'SIRET / n° compte', 'Cabinet', 'Documents', 'Dernier run'].map(esc2).join(';')];
  for (const c of liste) {
    lignes.push(
      [c.nom, c.siret, c.cabinet_libelle || '', c.nb_docs, c.dernier_run ? new Date(c.dernier_run + 'Z').toLocaleString('fr-FR') : ''].map(esc2).join(';'),
    );
  }
  const blob = new Blob(['﻿' + lignes.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `clients_urssaf_${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
  toast(`${liste.length} client(s) exporté(s).`, 'ok');
});

// Recuperer la selection
$('#btn-scrape-selection').addEventListener('click', async () => {
  const ids = [...selection];
  if (!ids.length) return;
  if (!confirm(`Récupérer les appels de cotisations pour ${ids.length} client(s) sélectionné(s) ?`)) return;
  try {
    const phases = phasesImpotsCochees();
    if (!phases) return;
    const r = await api('/api/scrape-selection', { method: 'POST', body: JSON.stringify({ ids, ...phases }) });
    toast(`Récupération lancée pour ${r.total} client(s).`, 'ok');
    majEtatGlobal(true);
  } catch (err) {
    toast(err.message, 'err');
  }
});

$('#table-clients').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const id = Number(btn.dataset.id);
  const act = btn.dataset.act;
  if (act === 'scrape') {
    btn.disabled = true;
    btn.textContent = '…';
    try {
      const phases = phasesImpotsCochees();
      if (!phases) throw new Error('Coche au moins une phase (CFE, taxe foncière ou messagerie).');
      await api(`/api/clients/${id}/scrape`, { method: 'POST', body: JSON.stringify(phases) });
      toast("Récupération lancée. Suis l'avancement dans l'historique.", 'ok');
    } catch (err) {
      toast(err.message, 'err');
    } finally {
      setTimeout(() => {
        btn.disabled = false;
        btn.textContent = 'Récupérer';
        rafraichir();
      }, 1500);
    }
  } else if (act === 'docs') {
    ouvrirDocs(id, btn.dataset.nom);
  } else if (act === 'edit') {
    remplir(id);
  } else if (act === 'del') {
    if (confirm('Supprimer ce client ?\nIl passe en liste noire : la synchronisation ne le recréera pas (réintégrable en bas de page).')) {
      await api(`/api/clients/${id}`, { method: 'DELETE' });
      toast('Client supprimé et ajouté à la liste noire.');
      chargerClients();
      chargerListeNoire('/api', 'imp');
    }
  }
});

// ---- Formulaire client ----
const form = $('#form-client');
async function remplir(id) {
  const c = (await api('/api/clients')).find((x) => x.id === id);
  if (!c) return;
  form.id.value = c.id;
  form.nom.value = c.nom;
  form.siret.value = c.siret;
  remplirSelectCabinets();
  if (c.cabinet_id) form.cabinet_id.value = c.cabinet_id;
  $('#btn-submit').textContent = 'Mettre à jour';
  $('#btn-cancel').hidden = false;
  form.scrollIntoView({ behavior: 'smooth' });
}
function reset() {
  form.reset();
  form.id.value = '';
  $('#btn-submit').textContent = 'Enregistrer';
  $('#btn-cancel').hidden = true;
}
$('#btn-cancel').addEventListener('click', reset);

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const payload = {
    nom: form.nom.value.trim(),
    siret: form.siret.value.replace(/\s+/g, ''),
    cabinet_id: form.cabinet_id.value ? Number(form.cabinet_id.value) : null,
  };
  if (!/^\d{9,14}$/.test(payload.siret)) return toast('SIREN invalide (9 chiffres — ou un SIRET, on garde le SIREN).', 'err');
  if (!payload.cabinet_id) return toast('Choisis un compte de rattachement (ajoute-en un si nécessaire).', 'err');
  const id = form.id.value;
  try {
    if (id) {
      await api(`/api/clients/${id}`, { method: 'PUT', body: JSON.stringify(payload) });
      toast('Client mis à jour.', 'ok');
    } else {
      await api('/api/clients', { method: 'POST', body: JSON.stringify(payload) });
      toast('Client ajouté.', 'ok');
    }
    reset();
    chargerClients();
  } catch (err) {
    toast(err.message, 'err');
  }
});

// ---- Tout récupérer (une session par cabinet) ----
// Phases impots cochées (CFE / TF / messagerie) — null si aucune (avec toast).
function phasesImpotsCochees() {
  const p = { cfe: !!$('#chk-cfe')?.checked, tf: !!$('#chk-tf')?.checked, messagerie: !!$('#chk-messagerie')?.checked, tva: !!$('#chk-tva')?.checked };
  if (!p.cfe && !p.tf && !p.messagerie && !p.tva) {
    toast('Coche au moins une phase (CFE, taxe foncière, messagerie ou TVA).', 'err');
    return null;
  }
  return p;
}
$('#btn-scrape-all').addEventListener('click', async () => {
  const phases = phasesImpotsCochees();
  if (!phases) return;
  if (!confirm('Lancer la récupération pour TOUS les clients ?\n(Une connexion par cabinet, puis enchaînement de ses clients.)')) return;
  try {
    const r = await api('/api/scrape-all', { method: 'POST', body: JSON.stringify(phases) });
    let msg = `Récupération lancée : ${r.total} client(s) sur ${r.cabinets} cabinet(s).`;
    if (r.ignores) msg += ` Reprise : ${r.ignores} déjà récupéré(s), ignoré(s).`;
    toast(msg, 'ok');
    majEtatGlobal(true);
  } catch (err) {
    toast(err.message, 'err');
  }
});
$('#btn-stop-all').addEventListener('click', async () => {
  try {
    await api('/api/scrape-all/stop', { method: 'POST' });
    toast('Arrêt demandé — fin après le client en cours.', 'ok');
  } catch (err) {
    toast(err.message, 'err');
  }
});
function majEtatGlobal(enCours) {
  $('#btn-scrape-all').disabled = enCours;
  $('#btn-scrape-all').textContent = enCours ? 'Récupération en cours…' : 'Tout récupérer';
  $('#btn-stop-all').hidden = !enCours;
}
async function suivreEtat() {
  try {
    const s = await api('/api/status');
    majEtatGlobal(Array.isArray(s.enCours) && s.enCours.includes('all'));
  } catch {
    /* ignore */
  }
}
setInterval(suivreEtat, 4000);

// ---- Documents ----
const dialogDocs = $('#dialog-docs');
async function ouvrirDocs(id, nom) {
  const docs = await api(`/api/clients/${id}/documents`);
  $('#docs-titre').textContent = `Documents — ${nom}`;
  const ul = $('#docs-liste');
  ul.innerHTML = docs.length ? '' : '<li class="vide">Aucun document récupéré.</li>';
  for (const d of docs) {
    const li = document.createElement('li');
    li.innerHTML = `<span><span class="lib">${esc(d.libelle || d.fichier.split(/[\\/]/).pop())}</span><br/>
      <span class="date">${new Date(d.recupere_le + 'Z').toLocaleString('fr-FR')}</span></span>
      <a class="btn small" href="/api/documents/file?path=${encodeURIComponent(d.fichier)}" target="_blank">Ouvrir</a>`;
    ul.appendChild(li);
  }
  dialogDocs.showModal();
}
$('#docs-fermer').addEventListener('click', () => dialogDocs.close());

// ---- Habilitations (tableau par compte espace pro) ----
// Reutilise la modale #dialog-docs : liste des tableaux deja telecharges + bouton pour
// en recuperer un nouveau (ouvre une session captcha cote serveur).
async function ouvrirHabilitations(id, nom) {
  $('#docs-titre').textContent = `Habilitations — ${nom || ''}`;
  const ul = $('#docs-liste');
  ul.innerHTML = '<li class="vide">Chargement…</li>';
  dialogDocs.showModal();
  try {
    const files = await api(`/api/cabinets/${id}/habilitations`);
    ul.innerHTML = `<li><button type="button" class="btn small primary" data-hab-run="${id}"><i class="ph ph-download-simple"></i> Récupérer le tableau maintenant</button></li>`;
    if (!files.length) {
      ul.innerHTML += '<li class="vide">Aucun tableau téléchargé pour l’instant.</li>';
    } else {
      for (const f of files) {
        const li = document.createElement('li');
        li.innerHTML = `<span><span class="lib">${esc(f.nom)}</span><br/>
          <span class="date">${new Date(f.modifie).toLocaleString('fr-FR')}</span></span>
          <a class="btn small" href="/api/cabinets/${id}/habilitations/file?name=${encodeURIComponent(f.nom)}" target="_blank" rel="noopener">Ouvrir</a>`;
        ul.appendChild(li);
      }
    }
  } catch (err) {
    ul.innerHTML = `<li class="vide">${esc(err.message)}</li>`;
  }
}
$('#docs-liste').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-hab-run]');
  if (!btn) return;
  const id = Number(btn.dataset.habRun);
  btn.disabled = true;
  btn.textContent = '…';
  if (remoteBrowser) toast('Fenêtre impôts ouverte côté serveur : clique sur « 🖥️ Captcha » (en haut) pour saisir la captcha.', 'ok');
  try {
    await api(`/api/cabinets/${id}/habilitations`, { method: 'POST' });
    toast('Récupération lancée — saisis la captcha, le tableau se téléchargera ensuite.', 'ok');
    majEtatGlobal(true);
    dialogDocs.close();
  } catch (err) {
    toast(err.message, 'err');
    btn.disabled = false;
    btn.textContent = 'Récupérer le tableau maintenant';
  }
});

// ---- Liste noire (clients supprimés, protégés de la synchro) ----------------
// Helper GLOBAL (impôts prefix 'imp' + URSSAF prefix 'u' via urssaf.js).
async function chargerListeNoire(apiBase, prefix) {
  try {
    const lignes = await api(`${apiBase}/liste-noire`);
    const table = $(`#${prefix}-ln-table`);
    if (!table) return;
    table.querySelector('tbody').innerHTML = lignes
      .map(
        (l) => `
      <tr>
        <td>${esc(l.nom || '—')}</td>
        <td class="siret">${esc(l.siret)}</td>
        <td>${l.ajoute_le ? new Date(l.ajoute_le + 'Z').toLocaleDateString('fr-FR') : '—'}</td>
        <td><button type="button" class="btn small" data-ln-reintegrer="${l.id}" data-ln-base="${apiBase}" data-ln-prefix="${prefix}">↩ Réintégrer</button></td>
      </tr>`,
      )
      .join('');
    table.hidden = !lignes.length;
    const vide = $(`#${prefix}-ln-vide`);
    if (vide) vide.hidden = !!lignes.length;
    const compte = $(`#${prefix}-ln-compte`);
    if (compte) compte.textContent = lignes.length || '';
  } catch {
    /* ignore */
  }
}
document.addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-ln-reintegrer]');
  if (!btn) return;
  btn.disabled = true;
  try {
    const r = await api(`${btn.dataset.lnBase}/liste-noire/${btn.dataset.lnReintegrer}/reintegrer`, { method: 'POST' });
    toast(`${r.nom || 'Client'} réintégré${r.sans_cabinet ? ' — pense à le rattacher à un compte' : ''}.`, 'ok');
    chargerListeNoire(btn.dataset.lnBase, btn.dataset.lnPrefix);
    if (btn.dataset.lnPrefix === 'imp') chargerClients();
    else window.dispatchEvent(new Event('urssaf-rafraichir'));
  } catch (err) {
    toast(err.message, 'err');
    btn.disabled = false;
  }
});

// ---- Historique des récupérations -------------------------------------------
// Présentation façon « récupération en cours » : les lignes (1 par client) sont
// regroupées en SESSIONS (écart > 30 min = nouvelle récupération), chacune rendue
// comme le panneau d'avancement : barre, compteur, badges succès/échecs, détail.
// Helper GLOBAL : utilisé aussi par source-ui.js et urssaf.js.
const HIST_PAUSE_MIN = 30;
const HIST_PAR_PAGE = 8;
function renderHistorique(el, runs) {
  if (!el) return;
  const limite = Number(el.dataset.limite) || HIST_PAR_PAGE;
  const tries = [...runs].sort((a, b) => String(b.lance_le || '').localeCompare(String(a.lance_le || '')));
  const sessions = [];
  let s = null;
  for (const r of tries) {
    const t = new Date(String(r.lance_le || '').replace(' ', 'T') + 'Z').getTime() || 0;
    if (!s || s.minMs - t > HIST_PAUSE_MIN * 60 * 1000) {
      s = { runs: [], minMs: t, maxMs: t };
      sessions.push(s);
    }
    s.runs.push(r);
    s.minMs = Math.min(s.minMs, t);
    s.maxMs = Math.max(s.maxMs, t);
  }
  if (!sessions.length) {
    el.innerHTML = '<p class="vide" style="padding: 0 22px 16px">Aucune récupération pour l\'instant.</p>';
    return;
  }
  const libStatut = (r) => ({ echec: 'échec', echec_mdp: '🔒 mot de passe' })[r.statut] || r.statut;
  const html = sessions
    .slice(0, limite)
    .map((se) => {
      const ok = se.runs.filter((r) => r.statut === 'succes');
      const ko = se.runs.filter((r) => r.statut !== 'succes');
      const docs = se.runs.reduce((n, r) => n + (r.nb_docs || 0), 0);
      const pct = Math.round((ok.length / se.runs.length) * 100);
      const dureeMin = Math.round((se.maxMs - se.minMs) / 60000);
      const duree = dureeMin >= 60 ? ` · ${Math.floor(dureeMin / 60)} h ${String(dureeMin % 60).padStart(2, '0')}` : dureeMin > 0 ? ` · ${dureeMin} min` : '';
      return `
    <div class="hist-session">
      <div class="hist-tete">
        <strong>${new Date(se.minMs).toLocaleString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</strong>
        <span>${se.runs.length} client(s) · ${docs} nouveau(x) document(s)${duree}</span>
      </div>
      <div class="hist-resume">
        <div class="progress-barre"><div class="progress-fill" style="width:${pct}%"></div></div>
        <span class="progress-compteur">${ok.length} / ${se.runs.length}</span>
      </div>
      <div class="hist-bilan">
        <span class="badge ok">✔ ${ok.length} succès</span>
        ${ko.length ? `<span class="badge err">✘ ${ko.length} échec(s)</span>` : ''}
      </div>
      ${
        ko.length
          ? `<details class="hist-echecs"><summary>Détail des échecs</summary><ul>${ko
              .map((r) => `<li><strong>${esc(r.client_nom || '—')}</strong> <span class="badge err">${libStatut(r)}</span> — ${esc(r.message || '')}</li>`)
              .join('')}</ul></details>`
          : ''
      }
    </div>`;
    })
    .join('');
  const reste = sessions.length - limite;
  el.innerHTML =
    html +
    (reste > 0
      ? `<div class="hist-plus"><button type="button" class="btn small" data-hist-plus>Afficher ${Math.min(reste, HIST_PAR_PAGE)} récupération(s) de plus</button></div>`
      : '');
  el.querySelector('[data-hist-plus]')?.addEventListener('click', () => {
    el.dataset.limite = limite + HIST_PAR_PAGE;
    renderHistorique(el, runs);
  });
}

let runsAll = [];
async function chargerRuns() {
  runsAll = await api('/api/runs');
  renderHistorique($('#hist-impots'), runsAll);
}

// ---- Suivi d'avancement (journal en direct) -------------------------------
let progressMasque = false;
let dernierDemarrage = null;
let recupEnCours = false;
async function suivreProgression() {
  let p;
  try {
    p = await api('/api/progress');
  } catch {
    return;
  }
  if (p.demarre_le && p.demarre_le !== dernierDemarrage) {
    dernierDemarrage = p.demarre_le;
    progressMasque = false;
  }
  if (p.actif) recupEnCours = true;
  else if (recupEnCours) {
    recupEnCours = false;
    rafraichir();
  } // fin de recup -> rafraichit les tableaux
  // Le panneau d'avancement ne s'affiche que sur le tableau de bord.
  const aMontrer = (p.actif || (p.fini_le && p.resultats.length > 0)) && !progressMasque && ongletActif === 'dashboard';
  $('#panel-progress').hidden = !aMontrer;
  if (!aMontrer) return;
  const pct = p.total > 0 ? Math.round((p.fait / p.total) * 100) : 0;
  $('#progress-fill').style.width = pct + '%';
  $('#progress-compteur').textContent = `${p.fait} / ${p.total}`;
  if (p.actif) {
    $('#progress-titre').textContent = 'Récupération en cours…';
    $('#progress-courant').textContent = p.courant ? `⏳ Client en cours : ${p.courant}` : '';
    $('#progress-masquer').hidden = true;
  } else {
    $('#progress-titre').textContent = 'Récupération terminée';
    $('#progress-courant').textContent = '';
    $('#progress-masquer').hidden = false;
  }
  const ok = p.resultats.filter((r) => r.ok);
  const ko = p.resultats.filter((r) => !r.ok);
  let bilan = `<span class="badge ok">✔ ${ok.length} succès</span> `;
  if (ko.length) {
    bilan += `<span class="badge err">✘ ${ko.length} échec(s)</span>`;
    bilan += '<ul class="progress-echecs">' + ko.map((r) => `<li><strong>${esc(r.nom)}</strong> — ${esc(r.message)}</li>`).join('') + '</ul>';
  }
  $('#progress-bilan').innerHTML = bilan;
  const logEl = $('#progress-log');
  const enBas = logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 40;
  logEl.textContent = p.logs.join('\n');
  if (enBas) logEl.scrollTop = logEl.scrollHeight;
}
$('#progress-masquer').addEventListener('click', () => {
  progressMasque = true;
  $('#panel-progress').hidden = true;
});

// ---- Captcha impôts relayée dans le portail ---------------------------------
// L'image est capturée par le robot ; le code tapé ici est recopié dans la vraie
// page de connexion. Le bandeau s'affiche sur TOUS les onglets (action requise).
let captchaVisible = false;
async function suivreCaptcha() {
  try {
    const c = await api('/api/captcha');
    const p = $('#panel-captcha');
    if (!p) return;
    if (c.actif) {
      const img = $('#captcha-img');
      if (img.src !== c.image) img.src = c.image;
      if (!captchaVisible) {
        captchaVisible = true;
        p.hidden = false;
        $('#captcha-code').value = '';
        $('#captcha-msg').textContent = '';
        $('#captcha-code').focus();
      }
    } else if (captchaVisible) {
      captchaVisible = false;
      p.hidden = true;
    }
  } catch {
    /* ignore */
  }
}
async function validerCaptcha() {
  const code = $('#captcha-code').value.trim();
  if (!code) return;
  $('#captcha-valider').disabled = true;
  $('#captcha-msg').textContent = 'Envoi du code…';
  try {
    const r = await api('/api/captcha', { method: 'POST', body: JSON.stringify({ code }) });
    if (r.connecte) {
      $('#captcha-msg').textContent = '✔ Connecté — la récupération continue.';
      toast('Captcha validée — connexion réussie.', 'ok');
    } else if (r.refuse) {
      $('#captcha-msg').textContent = 'Code refusé — nouvelle image chargée.';
      if (r.image) $('#captcha-img').src = r.image;
      $('#captcha-code').value = '';
      $('#captcha-code').focus();
    } else if (r.error) {
      $('#captcha-msg').textContent = r.error;
    }
  } catch (err) {
    $('#captcha-msg').textContent = err.message;
  } finally {
    $('#captcha-valider').disabled = false;
  }
}
$('#captcha-valider')?.addEventListener('click', validerCaptcha);
$('#captcha-code')?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') validerCaptcha();
});
$('#captcha-rafraichir')?.addEventListener('click', async () => {
  try {
    const r = await api('/api/captcha/rafraichir', { method: 'POST' });
    if (r.image) $('#captcha-img').src = r.image;
  } catch {
    /* ignore */
  }
});
setInterval(suivreCaptcha, 3000);

// ---- Documents (onglet global) --------------------------------------------
let tousDocs = [];
let pageDocs = 1;
let filtreDocs = '';
let filtreAnnee = '';
const DOCS_PAR_PAGE = 20;

// Année d'un document : date du document (carpimko), sinon année (20xx) dans le
// libellé / nom de fichier, sinon année de récupération.
function anneeDoc(d) {
  if (d.date_doc && /^\d{4}/.test(d.date_doc)) return d.date_doc.slice(0, 4);
  const m = `${d.libelle || ''} ${d.fichier || ''}`.match(/\b(20\d{2})\b/);
  if (m) return m[1];
  if (d.recupere_le && /^\d{4}/.test(d.recupere_le)) return d.recupere_le.slice(0, 4);
  return '—';
}
// Beaucoup de libellés commencent par la date du document (« JJ/MM/AAAA — objet » URSSAF/
// CARPIMKO, « Message JJ/MM/AAAA objet » / « PJ JJ/MM/AAAA nom » impôts) : on l'extrait pour
// la colonne Date (plus parlante que la date de récupération) et on nettoie le libellé.
// Renvoie { _date (affichage), _cle (tri AAAA-MM-JJ), _libelle }.
function infoDoc(d) {
  const brut = d.libelle || (d.fichier ? d.fichier.split(/[\\/]/).pop() : '—');
  const m = brut.match(/^(Message|PJ)?\s*(\d{2})\/(\d{2})\/(\d{4})\s*(?:—\s*)?(.*)$/);
  if (m) {
    const reste = [m[1], m[5]].filter(Boolean).join(' ');
    return { _date: `${m[2]}/${m[3]}/${m[4]}`, _cle: `${m[4]}-${m[3]}-${m[2]}`, _libelle: reste || brut };
  }
  return { _date: d.recupere_le ? new Date(d.recupere_le + 'Z').toLocaleDateString('fr-FR') : '—', _cle: String(d.recupere_le || ''), _libelle: brut };
}
function remplirAnnees() {
  const sel = $('#docs-filtre-annee');
  if (!sel) return;
  const annees = [...new Set(tousDocs.map((d) => d._annee).filter((a) => a && a !== '—'))].sort((a, b) => b.localeCompare(a));
  const cur = sel.value;
  sel.innerHTML = '<option value="">Toutes les années</option>' + annees.map((a) => `<option value="${a}">${a}</option>`).join('');
  sel.value = annees.includes(cur) ? cur : '';
}

function norm(s) {
  return String(s ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
}

// Liste centrale des sources agrégées (Documents, Clients, Tableau de bord).
// Ajouter une caisse ici suffit pour qu'elle apparaisse dans toutes les vues transverses.
const SOURCES = [
  {
    key: 'impots',
    label: 'Impôts',
    clients: '/api/clients',
    docs: '/api/documents',
    runs: '/api/runs',
    cleId: 'siret',
    hrefDoc: (d) => `/api/documents/file?path=${encodeURIComponent(d.fichier)}`,
  },
  {
    key: 'urssaf',
    label: 'URSSAF',
    clients: '/api/urssaf/clients',
    docs: '/api/urssaf/documents',
    runs: '/api/urssaf/runs',
    cleId: 'siret',
    hrefDoc: (d) => `/api/urssaf/documents/${d.id}/file`,
  },
  {
    key: 'carpimko',
    label: 'CARPIMKO',
    clients: '/api/carpimko/clients',
    docs: '/api/carpimko/documents',
    runs: '/api/carpimko/runs',
    cleId: 'login',
    hrefDoc: (d) => `/api/carpimko/documents/${d.id}/file`,
  },
  {
    key: 'carmf',
    label: 'CARMF',
    clients: '/api/carmf/clients',
    docs: '/api/carmf/documents',
    runs: '/api/carmf/runs',
    cleId: 'login',
    hrefDoc: (d) => `/api/carmf/documents/${d.id}/file`,
  },
  {
    key: 'carcdsf',
    label: 'CARCDSF',
    clients: '/api/carcdsf/clients',
    docs: '/api/carcdsf/documents',
    runs: '/api/carcdsf/runs',
    cleId: 'login',
    hrefDoc: (d) => `/api/carcdsf/documents/${d.id}/file`,
  },
  {
    key: 'carpv',
    label: 'CARPV',
    clients: '/api/carpv/clients',
    docs: '/api/carpv/documents',
    runs: '/api/carpv/runs',
    cleId: 'login',
    hrefDoc: (d) => `/api/carpv/documents/${d.id}/file`,
  },
];

async function chargerDocuments() {
  try {
    const listesDocs = await Promise.all(SOURCES.map((s) => api(s.docs).catch(() => [])));
    tousDocs = SOURCES.flatMap((s, i) => listesDocs[i].map((d) => ({ ...d, source: s.label, _src: s.key, _href: s.hrefDoc(d) }))).map((d) => ({
      ...d,
      _annee: anneeDoc(d),
      ...infoDoc(d),
    }));
    // Classement par année (du plus récent au plus ancien), puis par date du document.
    tousDocs.sort((a, b) => b._annee.localeCompare(a._annee) || b._cle.localeCompare(a._cle));
    remplirAnnees();
  } catch {
    tousDocs = [];
  }
  afficherPageDocs();
}
function docsAffiches() {
  let liste = tousDocs;
  if (filtreAnnee) liste = liste.filter((d) => d._annee === filtreAnnee);
  const fPaiement = $('#docs-filtre-paiement')?.value || '';
  if (fPaiement) liste = liste.filter((d) => d.paiement === fPaiement);
  if (filtreDocs) {
    const q = norm(filtreDocs);
    liste = liste.filter((d) =>
      norm(
        `${d.client_nom || ''} ${d.libelle || ''} ${d._libelle || ''} ${d._date || ''} ${d.fichier || ''} ${d.recupere_le || ''} ${d.source || ''} ${d._annee || ''}`,
      ).includes(q),
    );
  }
  return liste;
}
function afficherPageDocs() {
  const liste = docsAffiches();
  const tbody = $('#table-docs tbody');
  if (!tbody) return;
  tbody.innerHTML = '';
  $('#table-docs').hidden = liste.length === 0;
  const vide = $('#vide-docs-all');
  if (vide) {
    vide.hidden = liste.length !== 0;
    vide.textContent = filtreDocs ? 'Aucun document ne correspond à la recherche.' : "Aucun document récupéré pour l'instant.";
  }
  const nbPages = Math.max(1, Math.ceil(liste.length / DOCS_PAR_PAGE));
  if (pageDocs > nbPages) pageDocs = nbPages;
  if (pageDocs < 1) pageDocs = 1;
  const debut = (pageDocs - 1) * DOCS_PAR_PAGE;
  for (const d of liste.slice(debut, debut + DOCS_PAR_PAGE)) {
    const cle = `${d._src}:${d.id}`;
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><input type="checkbox" data-doc-coche="${cle}" ${docsSelection.has(cle) ? 'checked' : ''} /></td>
      <td><strong>${esc(d._annee || '—')}</strong></td>
      <td>${esc(d._date || '—')}</td>
      <td>${esc(d.client_nom || '—')}</td>
      <td><span class="badge cab">${esc(d.source || '—')}</span></td>
      <td>${esc(d._libelle || '—')} ${badgePaiementCfe(d.paiement)}</td>
      <td><a class="btn small primary" href="${d._href}" target="_blank">Ouvrir</a></td>`;
    tbody.appendChild(tr);
  }
  majBoutonZip();
  const pag = $('#pagination-docs');
  if (pag) {
    pag.hidden = liste.length <= DOCS_PAR_PAGE;
    $('#pag-docs-info').textContent = `Page ${pageDocs} / ${nbPages} — ${liste.length} document(s)`;
    $('#pag-docs-prev').disabled = pageDocs <= 1;
    $('#pag-docs-next').disabled = pageDocs >= nbPages;
  }
}
function allerPageDocs(delta) {
  pageDocs += delta;
  afficherPageDocs();
}
$('#pag-docs-prev').addEventListener('click', () => allerPageDocs(-1));
$('#pag-docs-next').addEventListener('click', () => allerPageDocs(1));
$('#search-docs').addEventListener('input', (e) => {
  filtreDocs = e.target.value.trim();
  pageDocs = 1;
  afficherPageDocs();
});
$('#docs-filtre-annee')?.addEventListener('change', (e) => {
  filtreAnnee = e.target.value;
  pageDocs = 1;
  afficherPageDocs();
});
$('#docs-filtre-paiement')?.addEventListener('change', () => {
  pageDocs = 1;
  afficherPageDocs();
});

// ---- Téléchargement en masse (ZIP) -----------------------------------------
// Cases à cocher (persistantes entre pages/filtres) ; le bouton prend la
// sélection si non vide, sinon TOUT le résultat filtré courant.
const docsSelection = new Set(); // clés `${source}:${id}`
function majBoutonZip() {
  const lib = $('#docs-zip-lib');
  if (!lib) return;
  const n = docsSelection.size;
  lib.textContent = n ? `Télécharger la sélection (${n})` : `Télécharger tout (${docsAffiches().length})`;
  $('#docs-zip').disabled = !n && !docsAffiches().length;
  const tout = $('#docs-cocher-tout');
  if (tout) {
    const affiches = docsAffiches();
    tout.checked = affiches.length > 0 && affiches.every((d) => docsSelection.has(`${d._src}:${d.id}`));
  }
}
$('#table-docs')?.addEventListener('change', (e) => {
  const cb = e.target.closest('input[data-doc-coche]');
  if (!cb) return;
  if (cb.checked) docsSelection.add(cb.dataset.docCoche);
  else docsSelection.delete(cb.dataset.docCoche);
  majBoutonZip();
});
$('#docs-cocher-tout')?.addEventListener('change', (e) => {
  for (const d of docsAffiches()) {
    if (e.target.checked) docsSelection.add(`${d._src}:${d.id}`);
    else docsSelection.delete(`${d._src}:${d.id}`);
  }
  afficherPageDocs();
});
$('#docs-zip')?.addEventListener('click', async () => {
  const items = docsSelection.size
    ? [...docsSelection].map((c) => ({ source: c.split(':')[0], id: Number(c.split(':')[1]) }))
    : docsAffiches().map((d) => ({ source: d._src, id: d.id }));
  if (!items.length) return toast('Aucun document à télécharger.', 'err');
  const btn = $('#docs-zip');
  btn.disabled = true;
  toast(`Préparation du ZIP (${items.length} document(s))…`, 'ok');
  try {
    const r = await fetch('/api/documents/zip', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ items }),
    });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `Erreur ${r.status}`);
    const blob = await r.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = (r.headers.get('Content-Disposition') || '').match(/filename="([^"]+)"/)?.[1] || 'documents.zip';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 30000);
    toast('ZIP téléchargé.', 'ok');
  } catch (err) {
    toast(err.message, 'err');
  } finally {
    btn.disabled = false;
    majBoutonZip();
  }
});

// ---- Messages (messagerie impôts sécurisée) -------------------------------
let tousMessages = [];
async function chargerMessages() {
  try {
    tousMessages = await api('/api/messages');
  } catch {
    tousMessages = [];
  }
  const nav = document.getElementById('nav-messages-count');
  if (nav) nav.textContent = tousMessages.length || '';
  afficherMessages();
}
// Libellé stocké = « Message JJ/MM/AAAA objet » : on en extrait la date du message
// (celle des impôts, pas celle de la récupération) et l'objet nettoyé.
function infoMessage(m) {
  const brut = (m.libelle || '').replace(/^Message\s*/, '');
  const md = brut.match(/^(\d{2})\/(\d{2})\/(\d{4})\s*(.*)$/);
  if (md) return { date: `${md[1]}/${md[2]}/${md[3]}`, cle: `${md[3]}-${md[2]}-${md[1]}`, objet: md[4] || brut };
  return { date: m.recupere_le ? new Date(m.recupere_le + 'Z').toLocaleDateString('fr-FR') : '—', cle: String(m.recupere_le || ''), objet: brut };
}
let msgPage = 1;
const MSG_PAR_PAGE = 10;
function afficherMessages() {
  const q = norm($('#msg-search')?.value || '');
  const liste = (q ? tousMessages.filter((m) => norm(`${m.client_nom || ''} ${m.libelle || ''}`).includes(q)) : tousMessages)
    .map((m) => ({ ...m, ...infoMessage(m) }))
    .sort((a, b) => b.cle.localeCompare(a.cle));
  const tb = $('#table-messages tbody');
  if (!tb) return;
  const totalPages = Math.max(1, Math.ceil(liste.length / MSG_PAR_PAGE));
  if (msgPage > totalPages) msgPage = totalPages;
  if (msgPage < 1) msgPage = 1;
  const debut = (msgPage - 1) * MSG_PAR_PAGE;
  tb.innerHTML = liste
    .slice(debut, debut + MSG_PAR_PAGE)
    .map(
      (m) => `
    <tr data-msg="${m.id}" style="cursor:pointer;">
      <td>${m.date}</td>
      <td>${esc(m.client_nom || '—')}</td>
      <td>${esc(m.objet)}</td>
      <td>${m.pieces?.length ? `<span class="badge cab">${m.pieces.length} PJ</span>` : ''}</td>
    </tr>`,
    )
    .join('');
  $('#table-messages').hidden = liste.length === 0;
  const vide = $('#msg-vide');
  if (vide) vide.hidden = liste.length !== 0;
  const pag = $('#msg-pagination');
  if (pag)
    renderPagination(
      pag,
      msgPage,
      totalPages,
      (p) => {
        msgPage = p;
        afficherMessages();
      },
      liste.length,
    );
}
$('#msg-search')?.addEventListener('input', () => {
  msgPage = 1;
  afficherMessages();
});
$('#table-messages')?.addEventListener('click', async (e) => {
  const tr = e.target.closest('tr[data-msg]');
  if (!tr) return;
  const id = Number(tr.dataset.msg);
  const m = tousMessages.find((x) => x.id === id);
  try {
    const r = await api(`/api/messages/${id}/texte`);
    const inf = m ? infoMessage(m) : { date: '', objet: '' };
    $('#msg-lecture-titre').textContent = `${m?.client_nom || ''} — ${inf.objet}${inf.date ? ` (${inf.date})` : ''}`;
    $('#msg-lecture-corps').textContent = r.texte || '(vide)';
    $('#msg-lecture-pj').innerHTML = (m?.pieces || [])
      .map(
        (p) =>
          `<a class="btn small" href="/api/documents/file?path=${encodeURIComponent(p.fichier)}" target="_blank" rel="noopener"><i class="ph ph-paperclip"></i> ${esc(p.nom)}</a>`,
      )
      .join('');
    $('#msg-lecture').hidden = false;
    $('#msg-lecture').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (err) {
    toast(err.message, 'err');
  }
});

// ---- Vue « Clients » transverse : tous les documents d'un client, toutes sources -----
let pcClients = [];
let pcFiltre = '';
let pcPage = 1;
const pcSelection = new Set();
const PC_PAR_PAGE = 20;
const PC_ENDPOINTS = Object.fromEntries(SOURCES.map((s) => [s.label, s.clients]));
function hrefDoc(source, d) {
  const s = SOURCES.find((x) => x.label === source);
  return s ? s.hrefDoc(d) : '#';
}
async function chargerParClient() {
  let listes = SOURCES.map(() => []);
  let fus = [];
  try {
    const rep = await Promise.all([...SOURCES.map((s) => api(s.clients).catch(() => [])), api('/api/fusions').catch(() => [])]);
    listes = rep.slice(0, SOURCES.length);
    fus = rep[SOURCES.length] || [];
  } catch {
    /* ignore */
  }
  const units = [];
  SOURCES.forEach((s, i) => {
    for (const c of listes[i]) units.push({ source: s.label, id: c.id, nom: c.nom, ident: c[s.cleId] || '', nb: c.nb_docs || 0 });
  });
  // Une fusion manuelle prime sur le regroupement par nom.
  const fusionDe = new Map();
  for (const f of fus) for (const m of f.membres) fusionDe.set(`${m.source}:${m.client_id}`, f);
  const groups = new Map();
  for (const u of units) {
    const f = fusionDe.get(`${u.source}:${u.id}`);
    const key = f ? `fusion:${f.id}` : `nom:${norm(u.nom)}`;
    if (!groups.has(key)) groups.set(key, { nom: f ? f.nom : u.nom, key, fusionId: f ? f.id : null, refs: [], nbDocs: 0, sources: new Set() });
    const g = groups.get(key);
    g.refs.push({ source: u.source, id: u.id, ident: u.ident, nom: u.nom });
    g.nbDocs += u.nb;
    g.sources.add(u.source);
  }
  pcClients = [...groups.values()].sort((a, b) => a.nom.localeCompare(b.nom));
  const navc = document.getElementById('nav-parclient-count');
  if (navc) navc.textContent = pcClients.length || '';
  for (const k of [...pcSelection]) if (!groups.has(k)) pcSelection.delete(k);
  rendreParClient();
}
function pcAffiches() {
  if (!pcFiltre) return pcClients;
  const q = norm(pcFiltre);
  return pcClients.filter((c) => norm(c.nom).includes(q) || c.refs.some((r) => String(r.ident || '').includes(pcFiltre)));
}
function majBoutonFusion() {
  const b = $('#pc-fusionner');
  if (b) {
    b.disabled = pcSelection.size < 2;
    b.textContent = `Fusionner la sélection (${pcSelection.size})`;
  }
}
function rendreParClient() {
  const liste = pcAffiches();
  const tb = $('#table-par-client tbody');
  if (!tb) return;
  const totalPages = Math.max(1, Math.ceil(liste.length / PC_PAR_PAGE));
  if (pcPage > totalPages) pcPage = totalPages;
  if (pcPage < 1) pcPage = 1;
  tb.innerHTML = liste
    .slice((pcPage - 1) * PC_PAR_PAGE, pcPage * PC_PAR_PAGE)
    .map(
      (c) => `
    <tr>
      <td class="col-check"><input type="checkbox" class="pc-check" data-key="${esc(c.key)}" ${pcSelection.has(c.key) ? 'checked' : ''}></td>
      <td><strong>${esc(c.nom)}</strong>${c.fusionId ? ' <span class="badge ok">fusionné</span>' : ''}${c.refs.length > 1 ? `<div class="aide" style="margin:2px 0 0;">${c.refs.map((r) => esc(r.nom)).join(' · ')}</div>` : ''}</td>
      <td>${[...c.sources].map((s) => `<span class="badge cab">${esc(s)}</span>`).join(' ')}</td>
      <td>${c.nbDocs}</td>
      <td><span class="row-actions">
        <button class="btn small primary" data-pc="${esc(c.key)}">Documents</button>
        ${c.fusionId ? `<button class="btn small" data-pc-sep="${c.fusionId}">Séparer</button>` : ''}
      </span></td>
    </tr>`,
    )
    .join('');
  $('#pc-vide').hidden = liste.length !== 0;
  majBoutonFusion();
  const pag = document.getElementById('pc-pagination');
  if (pag)
    renderPagination(
      pag,
      pcPage,
      totalPages,
      (p) => {
        pcPage = p;
        rendreParClient();
      },
      liste.length,
    );
}
async function voirDocsClient(key) {
  const c = pcClients.find((x) => x.key === key);
  if (!c) return;
  $('#pc-docs-titre').textContent = `Documents — ${c.nom}`;
  $('#pc-docs-panel').hidden = false;
  const tb = $('#table-pc-docs tbody');
  tb.innerHTML = '<tr><td colspan="5" class="aide" style="margin:0;padding:12px 22px;">Chargement…</td></tr>';
  const docs = [];
  for (const r of c.refs) {
    const ds = await api(`${PC_ENDPOINTS[r.source]}/${r.id}/documents`).catch(() => []);
    docs.push(...ds.map((d) => ({ ...d, source: r.source, _annee: anneeDoc(d), _href: hrefDoc(r.source, d), ...infoDoc(d) })));
  }
  docs.sort((a, b) => String(b._annee).localeCompare(String(a._annee)) || String(b._cle).localeCompare(String(a._cle)));
  tb.innerHTML = docs
    .map(
      (d) => `
    <tr>
      <td><strong>${esc(d._annee || '—')}</strong></td>
      <td><span class="badge cab">${esc(d.source)}</span></td>
      <td>${esc(d._libelle || '—')}</td>
      <td>${esc(d._date || '—')}</td>
      <td><a class="btn small primary" href="${d._href}" target="_blank">Ouvrir</a></td>
    </tr>`,
    )
    .join('');
  $('#pc-docs-vide').hidden = docs.length !== 0;
  $('#pc-docs-panel').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}
$('#table-par-client')?.addEventListener('click', (e) => {
  const doc = e.target.closest('button[data-pc]');
  if (doc) return voirDocsClient(doc.dataset.pc);
  const sep = e.target.closest('button[data-pc-sep]');
  if (sep) {
    if (!confirm('Séparer ce client fusionné en fiches distinctes ?')) return;
    api(`/api/fusions/${sep.dataset.pcSep}`, { method: 'DELETE' })
      .then(() => {
        toast('Fusion annulée.', 'ok');
        chargerParClient();
      })
      .catch((err) => toast(err.message, 'err'));
  }
});
$('#table-par-client')?.addEventListener('change', (e) => {
  const cb = e.target.closest('.pc-check');
  if (!cb) return;
  if (cb.checked) pcSelection.add(cb.dataset.key);
  else pcSelection.delete(cb.dataset.key);
  majBoutonFusion();
});
$('#pc-fusionner')?.addEventListener('click', async () => {
  const groupes = pcClients.filter((c) => pcSelection.has(c.key));
  if (groupes.length < 2) return;
  const membres = groupes.flatMap((g) => g.refs.map((r) => ({ source: r.source, id: r.id })));
  const nomDefaut = groupes.map((g) => g.nom).sort((a, b) => b.length - a.length)[0];
  const nom = prompt('Nom du client fusionné :', nomDefaut);
  if (nom === null) return;
  try {
    await api('/api/fusions', { method: 'POST', body: JSON.stringify({ nom: nom.trim() || nomDefaut, membres }) });
    pcSelection.clear();
    toast('Clients fusionnés.', 'ok');
    chargerParClient();
  } catch (err) {
    toast(err.message, 'err');
  }
});
$('#pc-recherche')?.addEventListener('input', (e) => {
  pcFiltre = e.target.value.trim();
  pcPage = 1;
  rendreParClient();
});

// ---- Onglets --------------------------------------------------------------
let ongletActif = 'dashboard';
function activerOnglet(nom) {
  ongletActif = nom;
  document.querySelectorAll('.tab-btn').forEach((b) => b.classList.toggle('active', b.dataset.tab === nom));
  document.querySelectorAll('.tab-pane').forEach((p) => {
    p.hidden = p.id !== `tab-${nom}`;
  });
  // Le panneau « Récupération en cours » n'est visible que sur le tableau de bord.
  if (nom === 'dashboard') suivreProgression();
  else $('#panel-progress').hidden = true;
  if (nom === 'par-client') chargerParClient();
  if (nom === 'messages') chargerMessages();
  if (nom === 'documents') chargerDocuments();
}
document.querySelectorAll('.tab-btn').forEach((b) => b.addEventListener('click', () => activerOnglet(b.dataset.tab)));
activerOnglet('dashboard');

// Cartes "source" du tableau de bord -> navigation vers l'onglet correspondant.
document.addEventListener('click', (e) => {
  const card = e.target.closest('[data-goto]');
  if (card) activerOnglet(card.dataset.goto);
});

// ---- Menu mobile (tiroir) ----
const fermerNav = () => document.body.classList.remove('nav-open');
$('#btn-menu')?.addEventListener('click', () => document.body.classList.toggle('nav-open'));
$('#nav-overlay')?.addEventListener('click', fermerNav);
document.querySelectorAll('.sidebar .nav-item').forEach((b) => b.addEventListener('click', fermerNav));
addEventListener('keydown', (e) => {
  if (e.key === 'Escape') fermerNav();
});

// Sous-onglets (page Paramètres)
function activerSousOnglet(nom) {
  document.querySelectorAll('.subtab-btn').forEach((b) => b.classList.toggle('active', b.dataset.subtab === nom));
  document.querySelectorAll('.subtab-pane').forEach((p) => {
    p.hidden = p.id !== `sp-${nom}`;
  });
  if (nom === 'planif') chargerPlanifs();
}
document.querySelectorAll('.subtab-btn').forEach((b) => b.addEventListener('click', () => activerSousOnglet(b.dataset.subtab)));

// ---- Planification des récupérations (Paramètres ▸ Planification) ----
const PLANIF_LBL = { urssaf: 'URSSAF', carpimko: 'CARPIMKO', carmf: 'CARMF', carcdsf: 'CARCDSF', carpv: 'CARPV' };
const PLANIF_JOURS = ['', 'Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi', 'Dimanche'];
const PLANIF_ORDRE = ['urssaf', 'carpimko', 'carmf', 'carcdsf', 'carpv'];
// Plusieurs horaires possibles par organisme : chaque ligne du tableau est un horaire
// indépendant (➕ Ajouter un horaire, 🗑 pour retirer) ; « Enregistrer » envoie tout.
function lignePlanif(p = { source: 'urssaf', actif: true, jour: 1, heure: 2 }) {
  const tr = document.createElement('tr');
  tr.innerHTML = `
    <td><select class="planif-source">${PLANIF_ORDRE.map((s) => `<option value="${s}" ${p.source === s ? 'selected' : ''}>${PLANIF_LBL[s]}</option>`).join('')}</select></td>
    <td><input type="checkbox" class="planif-actif" ${p.actif ? 'checked' : ''} style="width:16px;height:16px;accent-color:var(--accent);"></td>
    <td><select class="planif-jour">${PLANIF_JOURS.slice(1)
      .map((j, i) => `<option value="${i + 1}" ${p.jour === i + 1 ? 'selected' : ''}>${j}</option>`)
      .join('')}</select></td>
    <td><select class="planif-heure">${Array.from({ length: 24 }, (_, h) => `<option value="${h}" ${p.heure === h ? 'selected' : ''}>${String(h).padStart(2, '0')}h00</option>`).join('')}</select></td>
    <td><button type="button" class="btn small danger planif-suppr" title="Retirer cet horaire"><i class="ph ph-trash"></i></button></td>`;
  return tr;
}
async function chargerPlanifs() {
  let pls = [];
  try {
    pls = await api('/api/planifications');
  } catch {
    return;
  }
  const tb = $('#table-planif tbody');
  if (!tb) return;
  pls.sort((a, b) => PLANIF_ORDRE.indexOf(a.source) - PLANIF_ORDRE.indexOf(b.source) || a.jour - b.jour || a.heure - b.heure);
  tb.innerHTML = '';
  for (const p of pls) tb.appendChild(lignePlanif(p));
}
$('#planif-ajouter')?.addEventListener('click', () => {
  $('#table-planif tbody')?.appendChild(lignePlanif());
  $('#planif-info').textContent = 'Ligne ajoutée — pense à enregistrer.';
});
$('#table-planif')?.addEventListener('click', (e) => {
  const btn = e.target.closest('.planif-suppr');
  if (!btn) return;
  btn.closest('tr').remove();
  $('#planif-info').textContent = 'Ligne retirée — pense à enregistrer.';
});
$('#planif-save')?.addEventListener('click', async () => {
  const btn = $('#planif-save');
  btn.disabled = true;
  try {
    const lignes = [...document.querySelectorAll('#table-planif tbody tr')].map((tr) => ({
      source: tr.querySelector('.planif-source').value,
      actif: tr.querySelector('.planif-actif').checked,
      jour: Number(tr.querySelector('.planif-jour').value),
      heure: Number(tr.querySelector('.planif-heure').value),
    }));
    await api('/api/planifications', { method: 'PUT', body: JSON.stringify({ lignes }) });
    await chargerPlanifs();
    toast('Planification enregistrée.', 'ok');
    $('#planif-info').textContent = 'Enregistré — le serveur applique ces horaires (Europe/Paris).';
  } catch (err) {
    toast(err.message, 'err');
  } finally {
    btn.disabled = false;
  }
});

// ---- Tableau de bord (indicateurs) ----------------------------------------
async function chargerDashboard() {
  try {
    const [clientsParSrc, docsParSrc, runsParSrc, cabinets, uCab] = await Promise.all([
      Promise.all(SOURCES.map((s) => api(s.clients).catch(() => []))),
      Promise.all(SOURCES.map((s) => api(s.docs).catch(() => []))),
      Promise.all(SOURCES.map((s) => api(s.runs).catch(() => []))),
      api('/api/cabinets').catch(() => []),
      api('/api/urssaf/cabinets').catch(() => []),
    ]);
    const somme = (arr) => arr.reduce((n, l) => n + l.length, 0);
    const set = (id, v) => {
      const el = document.getElementById(id);
      if (el) el.textContent = v;
    };
    // Indicateurs agreges sur toutes les sources (liste SOURCES).
    set('kpi-clients', somme(clientsParSrc));
    set('kpi-documents', somme(docsParSrc));
    set('kpi-runs', somme(runsParSrc));
    set('kpi-comptes', cabinets.length + uCab.length);
    const totalDocs = somme(docsParSrc);
    const nav = document.getElementById('nav-docs-count');
    if (nav) nav.textContent = totalDocs || '';
    const d = document.getElementById('dash-date');
    if (d) d.textContent = new Date().toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  } catch {
    /* ignore */
  }
}

// ---- Marque blanche : nom du cabinet ----------------------------------------
async function chargerBranding() {
  try {
    const b = await fetch('/api/branding').then((r) => r.json());
    appliquerBranding(b);
    const champ = $('#branding-nom');
    if (champ && !champ.value) champ.placeholder = b.nom;
  } catch {
    /* ignore */
  }
}
function appliquerBranding(b) {
  if (!b?.nom) return;
  document.title = `${b.nom} — Portail de récupération`;
  $('#brand-nom').textContent = b.nom;
  $('#brand-initiales').textContent = b.initiales || 'PC';
}
$('#branding-enregistrer')?.addEventListener('click', async () => {
  try {
    const b = await api('/api/branding', { method: 'POST', body: JSON.stringify({ nom: $('#branding-nom').value.trim() }) });
    appliquerBranding(b);
    toast('Nom du cabinet enregistré.', 'ok');
  } catch (err) {
    toast(err.message, 'err');
  }
});

// ---- Version (pied de page + sidebar) ---------------------------------------
// La mise a jour est desormais installee AUTOMATIQUEMENT au demarrage du serveur
// (cote server.js) : plus de bandeau ni de bouton « Installer » dans l'interface.
async function afficherVersion() {
  try {
    const v = await api('/api/version');
    $('#pied-version').textContent = 'v' + v.version;
    const bv = $('#brand-version');
    if (bv && !bv.classList.contains('maj-dispo')) bv.textContent = ` · v${v.version}`;
  } catch {
    /* ignore */
  }
}

// ---- Compte connecté & administration des collaborateurs ------------------
let moi = null;
async function chargerMoi() {
  try {
    const r = await api('/api/me');
    moi = r.user;
  } catch {
    return;
  }
  $('#user-email').textContent = moi.email;
  const av = $('#user-avatar');
  if (av) av.textContent = (moi.email || '?').replace(/@.*/, '').slice(0, 2).toUpperCase();
  $('#user-chip').hidden = false;
  if (moi.role === 'admin') {
    $('#panel-users').hidden = false;
    const sb = $('#subtab-btn-users');
    if (sb) sb.hidden = false;
    chargerUsers();
    $('#panel-apikey').hidden = false;
    chargerApiKey();
    $('#panel-mcp-oauth').hidden = false;
    chargerMcpOAuth();
    $('#panel-maj').hidden = false;
    chargerMaj();
    $('#panel-branding').hidden = false;
  }
}

// ---- Mise à jour en ligne (admin) ------------------------------------------
// Deux points d'entrée : le panneau Paramètres et le badge version de la sidebar
// (cliquable ; mis en évidence quand une mise à jour est disponible).
let etatMaj = null;
function setEtatMaj(t) {
  const e = $('#maj-etat');
  if (e) e.textContent = t;
}
function majBadgeVersion() {
  const bv = $('#brand-version');
  if (!bv) return;
  if (etatMaj?.updateAvailable) {
    bv.textContent = ` · v${etatMaj.current} → v${etatMaj.latest}`;
    bv.classList.add('maj-dispo');
    bv.title = `Mise à jour v${etatMaj.latest} disponible — cliquer pour l'installer`;
  } else if (etatMaj?.current) {
    bv.textContent = ` · v${etatMaj.current}`;
    bv.classList.remove('maj-dispo');
    bv.title = 'Le portail est à jour (cliquer pour revérifier)';
  }
}
async function chargerMaj() {
  setEtatMaj('Vérification…');
  try {
    const r = await api('/api/update/check');
    etatMaj = r;
    if ($('#maj-actuelle')) {
      $('#maj-actuelle').value = 'v' + (r.current || '?');
      $('#maj-derniere').value = r.latest ? 'v' + r.latest : '—';
      $('#maj-notes').value = r.notes || '';
      $('#maj-notes-bloc').hidden = !r.notes;
      $('#maj-installer').hidden = !r.updateAvailable;
    }
    setEtatMaj(r.erreur ? 'Vérification impossible : ' + r.erreur : r.updateAvailable ? 'Une mise à jour est disponible.' : 'Le portail est à jour.');
    majBadgeVersion();
  } catch (err) {
    setEtatMaj(err.message);
  }
}
async function installerMaj() {
  if (!etatMaj?.updateAvailable) return;
  if (!confirm(`Installer la mise à jour v${etatMaj.latest} maintenant ?\nL'application redémarre toute seule (quelques secondes d'interruption).`)) return;
  const btn = $('#maj-installer');
  if (btn) btn.disabled = true;
  setEtatMaj('Téléchargement et installation…');
  toast(`Installation de la v${etatMaj.latest}…`, 'ok');
  try {
    const r = await api('/api/update/apply', { method: 'POST' });
    setEtatMaj(`Version ${r.version} installée — redémarrage en cours…`);
    const bv = $('#brand-version');
    if (bv) bv.textContent = ` · redémarrage…`;
    // Le serveur s'arrête pour appliquer la maj : on attend qu'il revienne avec la nouvelle version.
    const debut = Date.now();
    const attendre = setInterval(async () => {
      try {
        const v = await fetch('/api/version').then((x) => x.json());
        if (v.version === r.version) {
          clearInterval(attendre);
          toast(`Mise à jour v${r.version} appliquée.`, 'ok');
          setTimeout(() => location.reload(), 1200);
        }
      } catch {
        /* serveur en cours de redémarrage */
      }
      if (Date.now() - debut > 3 * 60 * 1000) {
        clearInterval(attendre);
        setEtatMaj('Le redémarrage prend plus de temps que prévu — recharge la page dans un instant.');
        if (btn) btn.disabled = false;
      }
    }, 3000);
  } catch (err) {
    toast(err.message, 'err');
    setEtatMaj(err.message);
    if (btn) btn.disabled = false;
  }
}
$('#maj-verifier')?.addEventListener('click', chargerMaj);
$('#maj-installer')?.addEventListener('click', installerMaj);
// Badge version de la sidebar : installe si une maj est connue, sinon revérifie.
$('#brand-version')?.addEventListener('click', async () => {
  if (!moi || moi.role !== 'admin') return;
  if (etatMaj?.updateAvailable) return installerMaj();
  await chargerMaj();
  if (etatMaj?.updateAvailable) installerMaj();
  else toast(`Le portail est à jour (v${etatMaj?.current || '?'}).`, 'ok');
});

// ---- Connecteur MCP « organisation » (OAuth) ------------------------------
// Sécurité : le Client Secret n'est visible qu'à la génération (stocké haché).
function remplirMcpOAuth(r) {
  $('#mcpoauth-url').value = r.url || '';
  $('#mcpoauth-id').value = r.client_id || '';
  $('#mcpoauth-secret').value = r.client_secret || '';
  if (!r.client_secret) $('#mcpoauth-secret').placeholder = r.secret_defini ? 'Défini — visible uniquement à la génération' : '';
}
async function chargerMcpOAuth() {
  try {
    remplirMcpOAuth(await api('/api/mcp-oauth/client'));
  } catch {}
}
$('#mcpoauth-regenerer')?.addEventListener('click', async () => {
  if (!confirm('Régénérer le Client ID/Secret ? Le connecteur déjà configuré dans Claude devra être reconfiguré.')) return;
  try {
    remplirMcpOAuth(await api('/api/mcp-oauth/regenerer', { method: 'POST' }));
    toast('Nouvelles clés générées. Copie le Client Secret MAINTENANT : il ne sera plus affiché.', 'ok');
  } catch (err) {
    toast(err.message, 'err');
  }
});
$('#mcpoauth-copier')?.addEventListener('click', async () => {
  const t = `URL : ${$('#mcpoauth-url').value}\nClient ID : ${$('#mcpoauth-id').value}\nClient Secret : ${$('#mcpoauth-secret').value}`;
  try {
    await navigator.clipboard.writeText(t);
    toast('Valeurs copiées.', 'ok');
  } catch {
    toast('Copie impossible — sélectionne manuellement.', 'err');
  }
});

// ---- Clé API (MCP) --------------------------------------------------------
// Sécurité : la clé n'est visible qu'à la génération (stockée hachée côté serveur).
async function chargerApiKey() {
  try {
    const r = await api('/api/apikey');
    $('#apikey-valeur').value = '';
    $('#apikey-valeur').placeholder = r.definie ? 'Définie — visible uniquement à la génération' : 'Aucune clé définie — clique sur « Régénérer la clé »';
  } catch {}
}
$('#apikey-regenerer')?.addEventListener('click', async () => {
  if (!confirm("Régénérer la clé API ? Les configurations utilisant l'ancienne clé (MCP) cesseront de fonctionner.")) return;
  try {
    const r = await api('/api/apikey/regenerer', { method: 'POST' });
    $('#apikey-valeur').value = r.key;
    toast('Nouvelle clé générée. Copie-la MAINTENANT : elle ne sera plus affichée.', 'ok');
  } catch (err) {
    toast(err.message, 'err');
  }
});
$('#apikey-revoquer')?.addEventListener('click', async () => {
  if (!confirm('Révoquer la clé API ? Tout accès par clé (MCP) sera coupé.')) return;
  try {
    await api('/api/apikey', { method: 'DELETE' });
    $('#apikey-valeur').value = '';
    $('#apikey-valeur').placeholder = 'Aucune clé définie';
    toast('Clé révoquée.', 'ok');
  } catch (err) {
    toast(err.message, 'err');
  }
});
$('#apikey-copier')?.addEventListener('click', async () => {
  const v = $('#apikey-valeur').value;
  if (!v) {
    toast('Aucune clé à copier.', 'err');
    return;
  }
  try {
    await navigator.clipboard.writeText(v);
    toast('Clé copiée.', 'ok');
  } catch {
    $('#apikey-valeur').select();
    document.execCommand('copy');
    toast('Clé copiée.', 'ok');
  }
});
$('#btn-logout').addEventListener('click', async () => {
  try {
    await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' });
  } catch {}
  location.replace('/login.html');
});
$('#form-moncompte').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await api('/api/me/password', { method: 'POST', body: JSON.stringify({ nouveau: e.target.nouveau.value }) });
    toast('Mot de passe changé. Reconnecte-toi.', 'ok');
    setTimeout(() => location.replace('/login.html'), 1200);
  } catch (err) {
    toast(err.message, 'err');
  }
});
async function chargerUsers() {
  const users = await api('/api/users');
  const tbody = $('#table-users tbody');
  tbody.innerHTML = '';
  for (const u of users) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${esc(u.email)}</td><td>${esc(u.nom || '—')}</td>
      <td>${u.role === 'admin' ? 'Admin' : 'Membre'}</td>
      <td>${u.actif ? 'Actif' : 'Désactivé'}</td>
      <td>${u.last_login ? new Date(u.last_login + 'Z').toLocaleString('fr-FR') : '—'}</td>
      <td><div class="row-actions">
        <button class="btn small" data-uact="pwd" data-id="${u.id}">Mot de passe</button>
        <button class="btn small" data-uact="role" data-id="${u.id}" data-role="${u.role}">${u.role === 'admin' ? '→ Membre' : '→ Admin'}</button>
        <button class="btn small" data-uact="actif" data-id="${u.id}" data-actif="${u.actif}">${u.actif ? 'Désactiver' : 'Activer'}</button>
        <button class="btn small danger" data-uact="del" data-id="${u.id}">Suppr.</button>
      </div></td>`;
    tbody.appendChild(tr);
  }
}
const tableUsers = $('#table-users');
if (tableUsers)
  tableUsers.addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-uact]');
    if (!btn) return;
    const id = Number(btn.dataset.id);
    const act = btn.dataset.uact;
    try {
      if (act === 'pwd') {
        const np = prompt('Nouveau mot de passe (8 caractères min.) :');
        if (!np) return;
        await api(`/api/users/${id}`, { method: 'PUT', body: JSON.stringify({ password: np }) });
        toast('Mot de passe réinitialisé.', 'ok');
      } else if (act === 'role') {
        await api(`/api/users/${id}`, { method: 'PUT', body: JSON.stringify({ role: btn.dataset.role === 'admin' ? 'membre' : 'admin' }) });
        chargerUsers();
      } else if (act === 'actif') {
        await api(`/api/users/${id}`, { method: 'PUT', body: JSON.stringify({ actif: btn.dataset.actif !== 'true' }) });
        chargerUsers();
      } else if (act === 'del') {
        if (!confirm('Supprimer ce collaborateur ?')) return;
        await api(`/api/users/${id}`, { method: 'DELETE' });
        chargerUsers();
      }
    } catch (err) {
      toast(err.message, 'err');
    }
  });
const formUser = $('#form-user');
if (formUser)
  formUser.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    try {
      await api('/api/users', {
        method: 'POST',
        body: JSON.stringify({
          email: f.email.value.trim(),
          nom: f.nom.value.trim(),
          password: f.password.value,
          role: f.role.value,
        }),
      });
      toast('Collaborateur ajouté.', 'ok');
      f.reset();
      chargerUsers();
    } catch (err) {
      toast(err.message, 'err');
    }
  });

// Vue navigateur a distance (noVNC) : revele le bouton si le serveur l'expose.
async function chargerConfig() {
  try {
    const c = await api('/api/config');
    remoteBrowser = !!c.remoteBrowser;
    if (remoteBrowser) {
      for (const sel of ['#btn-voir-navigateur', '#aide-captcha', '#btn-captcha-global']) {
        const el = $(sel);
        if (el) el.hidden = false;
      }
    }
  } catch {
    /* ignore */
  }
}

async function rafraichir() {
  await chargerCabinets();
  await Promise.all([chargerClients(), chargerRuns(), chargerDocuments(), chargerListeNoire('/api', 'imp')]);
}
chargerMoi();
chargerConfig();
rafraichir();
chargerDashboard();
chargerParClient(); // au demarrage aussi : alimente le compteur « Clients » de la sidebar
chargerMessages(); // idem pour le compteur « Messages »
chargerBranding();
suivreEtat();
afficherVersion();
suivreProgression();
setInterval(chargerRuns, 5000);
// Les listes de documents peuvent etre volumineuses (plafond urssaf releve a 50000) :
// rafraichissement espace, complete par un rechargement a l'ouverture de l'onglet.
setInterval(chargerDocuments, 30000);
setInterval(chargerDashboard, 10000);
setInterval(suivreProgression, 2000);

// ---- Anti gestionnaires de mots de passe -----------------------------------
// Les formulaires de comptes (identifiant + mot de passe des sources) sont pris
// pour des formulaires de connexion par les extensions (Dashlane, Bitwarden...) :
// fenetres intempestives, remplissage et SOUMISSION automatiques a l'ouverture
// des Parametres (toasts « Identifiant requis » en serie). On marque ces champs
// comme hors-jeu avec les attributs d'exclusion propres a chaque extension.
for (const f of document.querySelectorAll('form')) {
  if (!f.querySelector('input[type="password"]')) continue;
  f.setAttribute('autocomplete', 'off');
  for (const inp of f.querySelectorAll('input[name="login"], input[type="password"]')) {
    inp.setAttribute('autocomplete', inp.type === 'password' ? 'new-password' : 'off');
    inp.setAttribute('data-lpignore', 'true'); // LastPass
    inp.setAttribute('data-1p-ignore', ''); // 1Password
    inp.setAttribute('data-bwignore', ''); // Bitwarden
    inp.setAttribute('data-protonpass-ignore', 'true'); // Proton Pass
  }
}
