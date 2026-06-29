const $ = (s) => document.querySelector(s);

async function api(url, opts = {}) {
  const res = await fetch(url, { headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', ...opts });
  if (res.status === 401) { location.replace('/login.html'); throw new Error('Session expirée.'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Erreur ${res.status}`);
  return data;
}
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
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
  } catch (err) { toast(err.message, 'err'); }
  finally { btn.disabled = false; }
});
function resetCab() {
  formCab.reset(); formCab.id.value = '';
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
    btn.disabled = true; btn.textContent = '↻ Sync…';
    if (remoteBrowser) toast('Fenêtre impôts ouverte côté serveur : clique sur « 🖥️ Captcha » (en haut) pour saisir la captcha.', 'ok');
    try {
      const r = await api(`/api/cabinets/${id}/sync`, { method: 'POST' });
      let msg = `${r.total} client(s) : ${r.crees} ajouté(s), ${r.maj} mis à jour`;
      if (r.erreurs?.length) msg += `, ${r.erreurs.length} erreur(s)`;
      toast(msg, 'ok');
      rafraichir();
    } catch (err) { toast(err.message, 'err'); }
    finally { btn.disabled = false; btn.textContent = '↻ Synchroniser'; }
  } else if (act === 'edit') {
    formCab.id.value = cab.id; formCab.libelle.value = cab.libelle || ''; formCab.login.value = cab.login; formCab.password.value = '';
    $('#cab-submit').textContent = 'Mettre à jour'; $('#cab-cancel').hidden = false;
    formCab.scrollIntoView({ behavior: 'smooth' });
  } else if (act === 'del') {
    if (confirm(`Supprimer le cabinet « ${cab.libelle || cab.login} » ?\nSes clients ne seront plus rattachés (à réaffecter ou supprimer).`)) {
      await api(`/api/cabinets/${id}`, { method: 'DELETE' });
      toast('Cabinet supprimé.'); rafraichir();
    }
  }
});

// ---- Pagination (utilitaire reutilisable) ---------------------------------
function renderPagination(el, page, totalPages, onGo, total) {
  el.innerHTML = '';
  if (totalPages <= 1) { el.style.display = 'none'; return; }
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

// Renvoie la liste filtree + triee (sans pagination).
function clientsFiltres() {
  const q = ($('#clients-recherche').value || '').toLowerCase().trim();
  const cabFiltre = $('#clients-filtre-cabinet').value;
  let liste = clientsAll.slice();
  if (cabFiltre) liste = liste.filter((c) => String(c.cabinet_id) === cabFiltre);
  if (q) liste = liste.filter((c) => `${c.nom} ${c.siret} ${c.cabinet_libelle || ''}`.toLowerCase().includes(q));
  const { col, dir } = clientsTri;
  const val = (c) => ({
    nom: (c.nom || '').toLowerCase(),
    siret: (c.siret || '').toLowerCase(),
    cabinet: (c.cabinet_libelle || '').toLowerCase(),
    docs: c.nb_docs || 0,
    run: c.dernier_run || '',
  }[col]);
  liste.sort((a, b) => { const x = val(a), y = val(b); return x < y ? -dir : x > y ? dir : 0; });
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
      <td>${esc(c.nom)}</td>
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
  renderPagination($('#clients-pagination'), clientsPage, totalPages, (p) => { clientsPage = p; renderClients(); }, liste.length);
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
  sel.innerHTML = '<option value="">Tous les cabinets</option>' +
    cabinetsCache.map((c) => `<option value="${c.id}">${esc(c.libelle || c.login)}</option>`).join('');
  sel.value = courant;
  renderClients();
}

$('#clients-recherche').addEventListener('input', () => { clientsPage = 1; renderClients(); });
$('#clients-filtre-cabinet').addEventListener('change', () => { clientsPage = 1; renderClients(); });
$('#clients-taille').addEventListener('change', () => { clientsPage = 1; renderClients(); });

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
  if (cb.checked) selection.add(id); else selection.delete(id);
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
  const lignes = [['Nom', 'SIRET / n° compte', 'Cabinet', 'Documents', 'Dernier run']
    .map(esc2).join(';')];
  for (const c of liste) {
    lignes.push([c.nom, c.siret, c.cabinet_libelle || '', c.nb_docs,
      c.dernier_run ? new Date(c.dernier_run + 'Z').toLocaleString('fr-FR') : ''].map(esc2).join(';'));
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
    const r = await api('/api/scrape-selection', { method: 'POST', body: JSON.stringify({ ids }) });
    toast(`Récupération lancée pour ${r.total} client(s).`, 'ok');
    majEtatGlobal(true);
  } catch (err) { toast(err.message, 'err'); }
});

$('#table-clients').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const id = Number(btn.dataset.id);
  const act = btn.dataset.act;
  if (act === 'scrape') {
    btn.disabled = true; btn.textContent = '…';
    try { await api(`/api/clients/${id}/scrape`, { method: 'POST' }); toast('Récupération lancée. Suis l\'avancement dans l\'historique.', 'ok'); }
    catch (err) { toast(err.message, 'err'); }
    finally { setTimeout(() => { btn.disabled = false; btn.textContent = 'Récupérer'; rafraichir(); }, 1500); }
  } else if (act === 'docs') { ouvrirDocs(id, btn.dataset.nom); }
  else if (act === 'edit') { remplir(id); }
  else if (act === 'del') {
    if (confirm('Supprimer ce client et ses documents enregistrés ?')) {
      await api(`/api/clients/${id}`, { method: 'DELETE' }); toast('Client supprimé.'); chargerClients();
    }
  }
});

// ---- Formulaire client ----
const form = $('#form-client');
async function remplir(id) {
  const c = (await api('/api/clients')).find((x) => x.id === id);
  if (!c) return;
  form.id.value = c.id; form.nom.value = c.nom; form.siret.value = c.siret; form.dossier.value = c.dossier || '';
  remplirSelectCabinets(); if (c.cabinet_id) form.cabinet_id.value = c.cabinet_id;
  $('#btn-submit').textContent = 'Mettre à jour'; $('#btn-cancel').hidden = false;
  form.scrollIntoView({ behavior: 'smooth' });
}
function reset() { form.reset(); form.id.value = ''; $('#btn-submit').textContent = 'Enregistrer'; $('#btn-cancel').hidden = true; }
$('#btn-cancel').addEventListener('click', reset);

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const payload = {
    nom: form.nom.value.trim(), siret: form.siret.value.replace(/\s+/g, ''),
    dossier: form.dossier.value.trim(), cabinet_id: form.cabinet_id.value ? Number(form.cabinet_id.value) : null,
  };
  if (!/^\d{9,14}$/.test(payload.siret)) return toast('SIREN invalide (9 chiffres — ou un SIRET, on garde le SIREN).', 'err');
  if (!payload.cabinet_id) return toast('Choisis un compte de rattachement (ajoute-en un si nécessaire).', 'err');
  const id = form.id.value;
  try {
    if (id) { await api(`/api/clients/${id}`, { method: 'PUT', body: JSON.stringify(payload) }); toast('Client mis à jour.', 'ok'); }
    else { await api('/api/clients', { method: 'POST', body: JSON.stringify(payload) }); toast('Client ajouté.', 'ok'); }
    reset(); chargerClients();
  } catch (err) { toast(err.message, 'err'); }
});

// ---- Dossier de destination + sélecteur natif ----
async function choisirDossier() { const r = await api('/api/pick-folder', { method: 'POST' }); return r.folder || null; }
$('#pick-global').addEventListener('click', async () => { try { const f = await choisirDossier(); if (f) $('#dest-global').value = f; } catch (err) { toast(err.message, 'err'); } });
$('#save-global').addEventListener('click', async () => {
  try { await api('/api/settings', { method: 'POST', body: JSON.stringify({ destinationFolder: $('#dest-global').value.trim() }) }); toast('Dossier de destination enregistré.', 'ok'); }
  catch (err) { toast(err.message, 'err'); }
});
document.addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-pick]');
  if (!btn) return;
  try { const f = await choisirDossier(); if (f) { const champ = form[btn.dataset.pick]; if (champ) champ.value = f; } }
  catch (err) { toast(err.message, 'err'); }
});
async function chargerReglages() {
  try { const s = await api('/api/settings'); $('#dest-global').value = s.destinationFolder || ''; } catch { /* ignore */ }
}

// ---- Tout récupérer (une session par cabinet) ----
$('#btn-scrape-all').addEventListener('click', async () => {
  if (!confirm('Lancer la récupération pour TOUS les clients ?\n(Une connexion par cabinet, puis enchaînement de ses clients.)')) return;
  try {
    const r = await api('/api/scrape-all', { method: 'POST' });
    toast(`Récupération lancée : ${r.total} client(s) sur ${r.cabinets} cabinet(s).`, 'ok');
    majEtatGlobal(true);
  } catch (err) { toast(err.message, 'err'); }
});
$('#btn-stop-all').addEventListener('click', async () => {
  try { await api('/api/scrape-all/stop', { method: 'POST' }); toast('Arrêt demandé — fin après le client en cours.', 'ok'); }
  catch (err) { toast(err.message, 'err'); }
});
function majEtatGlobal(enCours) {
  $('#btn-scrape-all').disabled = enCours;
  $('#btn-scrape-all').textContent = enCours ? 'Récupération en cours…' : 'Tout récupérer';
  $('#btn-stop-all').hidden = !enCours;
}
async function suivreEtat() {
  try { const s = await api('/api/status'); majEtatGlobal(Array.isArray(s.enCours) && s.enCours.includes('all')); } catch { /* ignore */ }
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

// ---- Historique ----
let runsAll = [];
let runsPage = 1;
const RUNS_TAILLE = 25;

function renderRuns() {
  const totalPages = Math.max(1, Math.ceil(runsAll.length / RUNS_TAILLE));
  if (runsPage > totalPages) runsPage = totalPages;
  const debut = (runsPage - 1) * RUNS_TAILLE;
  const slice = runsAll.slice(debut, debut + RUNS_TAILLE);
  const tbody = $('#table-runs tbody');
  tbody.innerHTML = '';
  for (const r of slice) {
    const cls = r.statut === 'succes' ? 'ok' : 'err';
    const lib = { succes: 'succès', echec: 'échec', echec_mdp: '🔒 mot de passe' }[r.statut] || r.statut;
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${new Date(r.lance_le + 'Z').toLocaleString('fr-FR')}</td>
      <td>${esc(r.client_nom || '—')}</td><td><span class="badge ${cls}">${lib}</span></td>
      <td>${r.nb_docs}</td><td>${esc(r.message || '')}</td>`;
    tbody.appendChild(tr);
  }
  renderPagination($('#runs-pagination'), runsPage, totalPages, (p) => { runsPage = p; renderRuns(); }, runsAll.length);
}

async function chargerRuns() {
  runsAll = await api('/api/runs');
  renderRuns();
}

// ---- Suivi d'avancement (journal en direct) -------------------------------
let progressMasque = false;
let dernierDemarrage = null;
let recupEnCours = false;
async function suivreProgression() {
  let p;
  try { p = await api('/api/progress'); } catch { return; }
  if (p.demarre_le && p.demarre_le !== dernierDemarrage) { dernierDemarrage = p.demarre_le; progressMasque = false; }
  if (p.actif) recupEnCours = true;
  else if (recupEnCours) { recupEnCours = false; rafraichir(); } // fin de recup -> rafraichit les tableaux
  const aMontrer = (p.actif || (p.fini_le && p.resultats.length > 0)) && !progressMasque;
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
$('#progress-masquer').addEventListener('click', () => { progressMasque = true; $('#panel-progress').hidden = true; });

// ---- Documents (onglet global) --------------------------------------------
let tousDocs = [];
let pageDocs = 1;
let filtreDocs = '';
const DOCS_PAR_PAGE = 50;

function norm(s) { return String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, ''); }

async function chargerDocuments() {
  try {
    const [imp, cp] = await Promise.all([
      api('/api/documents').catch(() => []),
      api('/api/carpimko/documents').catch(() => []),
    ]);
    tousDocs = [
      ...imp.map((d) => ({ ...d, source: 'Impôts', _href: `/api/documents/file?path=${encodeURIComponent(d.fichier)}` })),
      ...cp.map((d) => ({ ...d, source: 'CARPIMKO', _href: `/api/carpimko/documents/${d.id}/file` })),
    ].sort((a, b) => String(b.recupere_le || '').localeCompare(String(a.recupere_le || '')));
  } catch { tousDocs = []; }
  afficherPageDocs();
}
function docsAffiches() {
  if (!filtreDocs) return tousDocs;
  const q = norm(filtreDocs);
  return tousDocs.filter((d) => norm(`${d.client_nom || ''} ${d.libelle || ''} ${d.fichier || ''} ${d.recupere_le || ''} ${d.source || ''}`).includes(q));
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
    vide.textContent = filtreDocs ? 'Aucun document ne correspond à la recherche.' : 'Aucun document récupéré pour l\'instant.';
  }
  const nbPages = Math.max(1, Math.ceil(liste.length / DOCS_PAR_PAGE));
  if (pageDocs > nbPages) pageDocs = nbPages;
  if (pageDocs < 1) pageDocs = 1;
  const debut = (pageDocs - 1) * DOCS_PAR_PAGE;
  for (const d of liste.slice(debut, debut + DOCS_PAR_PAGE)) {
    const lib = d.libelle || (d.fichier ? d.fichier.split(/[\\/]/).pop() : '—');
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${d.recupere_le ? new Date(d.recupere_le + 'Z').toLocaleString('fr-FR') : '—'}</td>
      <td>${esc(d.client_nom || '—')}</td>
      <td><span class="badge cab">${esc(d.source || '—')}</span></td>
      <td>${esc(lib)}</td>
      <td><a class="btn small primary" href="${d._href}" target="_blank">Ouvrir</a></td>`;
    tbody.appendChild(tr);
  }
  const pag = $('#pagination-docs');
  if (pag) {
    pag.hidden = liste.length <= DOCS_PAR_PAGE;
    $('#pag-docs-info').textContent = `Page ${pageDocs} / ${nbPages} — ${liste.length} document(s)`;
    $('#pag-docs-prev').disabled = pageDocs <= 1;
    $('#pag-docs-next').disabled = pageDocs >= nbPages;
  }
}
function allerPageDocs(delta) { pageDocs += delta; afficherPageDocs(); }
$('#pag-docs-prev').addEventListener('click', () => allerPageDocs(-1));
$('#pag-docs-next').addEventListener('click', () => allerPageDocs(1));
$('#search-docs').addEventListener('input', (e) => { filtreDocs = e.target.value.trim(); pageDocs = 1; afficherPageDocs(); });

// ---- Onglets --------------------------------------------------------------
function activerOnglet(nom) {
  document.querySelectorAll('.tab-btn').forEach((b) => b.classList.toggle('active', b.dataset.tab === nom));
  document.querySelectorAll('.tab-pane').forEach((p) => { p.hidden = p.id !== `tab-${nom}`; });
}
document.querySelectorAll('.tab-btn').forEach((b) => b.addEventListener('click', () => activerOnglet(b.dataset.tab)));
activerOnglet('dashboard');

// ---- Tableau de bord (indicateurs) ----------------------------------------
async function chargerDashboard() {
  try {
    const [clients, documents, runs, cabinets, cpClients, cpDocs, cpRuns] = await Promise.all([
      api('/api/clients').catch(() => []),
      api('/api/documents').catch(() => []),
      api('/api/runs').catch(() => []),
      api('/api/cabinets').catch(() => []),
      api('/api/carpimko/clients').catch(() => []),
      api('/api/carpimko/documents').catch(() => []),
      api('/api/carpimko/runs').catch(() => []),
    ]);
    const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
    // Indicateurs agreges sur toutes les sources (Impots + CARPIMKO).
    set('kpi-clients', clients.length + cpClients.length);
    set('kpi-documents', documents.length + cpDocs.length);
    set('kpi-runs', runs.length + cpRuns.length);
    set('kpi-comptes', cabinets.length);
    const totalDocs = documents.length + cpDocs.length;
    const nav = document.getElementById('nav-docs-count'); if (nav) nav.textContent = totalDocs || '';
    const d = document.getElementById('dash-date');
    if (d) d.textContent = new Date().toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  } catch { /* ignore */ }
}

// ---- Version (pied de page) -----------------------------------------------
// La mise a jour est desormais installee AUTOMATIQUEMENT au demarrage du serveur
// (cote server.js) : plus de bandeau ni de bouton « Installer » dans l'interface.
async function afficherVersion() {
  try { const v = await api('/api/version'); $('#pied-version').textContent = 'v' + v.version; } catch { /* ignore */ }
}

// ---- Compte connecté & administration des collaborateurs ------------------
let moi = null;
async function chargerMoi() {
  try { const r = await api('/api/me'); moi = r.user; } catch { return; }
  $('#user-email').textContent = moi.email;
  const av = $('#user-avatar');
  if (av) av.textContent = (moi.email || '?').replace(/@.*/, '').slice(0, 2).toUpperCase();
  $('#user-chip').hidden = false;
  if (moi.role === 'admin') { $('#panel-users').hidden = false; chargerUsers(); }
}
$('#btn-logout').addEventListener('click', async () => {
  try { await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' }); } catch {}
  location.replace('/login.html');
});
$('#form-moncompte').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await api('/api/me/password', { method: 'POST', body: JSON.stringify({ nouveau: e.target.nouveau.value }) });
    toast('Mot de passe changé. Reconnecte-toi.', 'ok');
    setTimeout(() => location.replace('/login.html'), 1200);
  } catch (err) { toast(err.message, 'err'); }
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
if (tableUsers) tableUsers.addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-uact]'); if (!btn) return;
  const id = Number(btn.dataset.id); const act = btn.dataset.uact;
  try {
    if (act === 'pwd') {
      const np = prompt('Nouveau mot de passe (8 caractères min.) :'); if (!np) return;
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
  } catch (err) { toast(err.message, 'err'); }
});
const formUser = $('#form-user');
if (formUser) formUser.addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  try {
    await api('/api/users', { method: 'POST', body: JSON.stringify({
      email: f.email.value.trim(), nom: f.nom.value.trim(), password: f.password.value, role: f.role.value,
    }) });
    toast('Collaborateur ajouté.', 'ok'); f.reset(); chargerUsers();
  } catch (err) { toast(err.message, 'err'); }
});

// Vue navigateur a distance (noVNC) : revele le bouton si le serveur l'expose.
async function chargerConfig() {
  try {
    const c = await api('/api/config');
    remoteBrowser = !!c.remoteBrowser;
    if (remoteBrowser) {
      for (const sel of ['#btn-voir-navigateur', '#aide-captcha', '#btn-captcha-global']) {
        const el = $(sel); if (el) el.hidden = false;
      }
    }
  } catch { /* ignore */ }
}

async function rafraichir() { await chargerCabinets(); await Promise.all([chargerClients(), chargerRuns(), chargerDocuments()]); }
chargerMoi();
chargerConfig();
rafraichir();
chargerDashboard();
chargerReglages();
suivreEtat();
afficherVersion();
suivreProgression();
setInterval(chargerRuns, 5000);
setInterval(chargerDocuments, 8000);
setInterval(chargerDashboard, 10000);
setInterval(suivreProgression, 2000);
