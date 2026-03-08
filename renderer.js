'use strict';
/* global pkgApi */

// ── State ─────────────────────────────────────────────────────────────────────
let allItems      = [];
let filteredItems = [];
let sortCol       = 'title';
let sortDir       = 'asc';
let activeCat     = 'all';
let searchQuery   = '';
let scanHistory   = [];
let destHistory   = [];
let renameTargets = [];

const HISTORY_KEY_SRC  = 'ps3vault_src_history';
const HISTORY_KEY_DEST = 'ps3vault_dest_history';
const THEME_KEY        = 'ps3vault_theme';

// ── Category helpers ───────────────────────────────────────────────────────────
function categoryDisplay(cat) {
  if (!cat) return 'Other';
  const c = cat.toUpperCase();
  if (['HG', 'HG_FILE_SYSTEM_CATEGORY_GAME', 'GD', 'GDE'].includes(c)) return 'Game';
  if (['2P', 'PATCH', 'GP'].includes(c)) return 'Patch';
  if (['DLC', 'AC', '2G'].includes(c)) return 'DLC';
  if (['DEMO', '2D', 'GN'].includes(c)) return 'Demo';
  if (['TH', 'THEME'].includes(c)) return 'Theme';
  if (['PSP_GAME', '2R', '2X'].includes(c)) return 'PSP';
  // Map baseType strings
  if (c === 'GAME')  return 'Game';
  if (c === 'OTHER') return 'Other';
  return cat.toUpperCase() || 'Other';
}

function effectiveCat(item) {
  const cd = categoryDisplay(item.category || item.baseType || '');
  return cd.toLowerCase();
}

function regionDisplay(r) {
  const map = { UP:'USA', EP:'EUR', JP:'JPN', BL:'JPN', BC:'JPN', HP:'ASIA', KP:'KOR' };
  if (!r) return 'Other';
  const prefix = r.slice(0, 2).toUpperCase();
  return map[prefix] || (map[r.toUpperCase()] || r || 'Other');
}

function formatBytes(n) {
  if (!n || n === 0) return '0 B';
  const units = ['B','KB','MB','GB','TB'];
  const i = Math.floor(Math.log(n) / Math.log(1024));
  return (n / Math.pow(1024, i)).toFixed(i > 1 ? 2 : 0) + ' ' + units[i];
}

function catClass(cat) {
  switch (cat.toLowerCase()) {
    case 'game':  return 'cat-game';
    case 'patch': return 'cat-patch';
    case 'dlc':   return 'cat-dlc';
    case 'demo':  return 'cat-demo';
    case 'theme': return 'cat-theme';
    case 'psp':   return 'cat-psp';
    default:      return 'cat-other';
  }
}

function regionClass(r) {
  switch ((r||'').toUpperCase()) {
    case 'USA': return 'reg-usa';
    case 'EUR': return 'reg-eur';
    case 'JPN': return 'reg-jpn';
    case 'ASIA': return 'reg-asia';
    case 'KOR': return 'reg-kor';
    default: return 'reg-other';
  }
}

// ── Table rendering ───────────────────────────────────────────────────────────
function renderTable() {
  const tbody = document.getElementById('pkg-tbody');
  if (filteredItems.length === 0) {
    tbody.innerHTML = `<tr><td colspan="8"><div id="empty-state">
      <svg width="64" height="64" viewBox="0 0 64 64" fill="none">
        <rect x="8" y="12" width="48" height="40" rx="6" stroke="currentColor" stroke-width="2"/>
        <path d="M8 22h48" stroke="currentColor" stroke-width="2"/>
        <circle cx="32" cy="38" r="8" stroke="currentColor" stroke-width="2"/>
        <path d="M28 38h8M32 34v8" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
      </svg>
      <p>No PKG files found matching your criteria.</p>
    </div></td></tr>`;
    return;
  }

  const rows = filteredItems.map((item, idx) => {
    const cat      = effectiveCat(item);
    const catLabel = categoryDisplay(item.category || item.baseType || '');
    const reg      = item.region || 'Other';
    const regLabel = regionDisplay(reg);
    const checked  = item._selected ? 'checked' : '';

    let coverCell;
    if (item.iconDataUrl) {
      coverCell = `<img class="cover-thumb" src="${item.iconDataUrl}"
        data-src="${item.iconDataUrl}"
        onmouseover="showImgPreview(event,this.dataset.src)"
        onmouseout="hideImgPreview()"
        onclick="showImgPreview(event,this.dataset.src,true)"
        alt="cover"/>`;
    } else {
      coverCell = `<div class="cover-placeholder" title="No cover">🎮</div>`;
    }

    const dupBadge = item.isDuplicate ? `<span class="badge badge-dup">⚠ DUP</span> ` : '';
    const ftpBadge = item.isFtp      ? `<span class="badge badge-ftp">FTP</span> `    : '';

    return `<tr data-idx="${idx}" class="${item._selected ? 'selected' : ''}">
      <td><input type="checkbox" class="row-chk" data-idx="${idx}" ${checked}/></td>
      <td class="cover-cell">${coverCell}</td>
      <td>
        <div class="title-main">${esc(item.title || '—')}</div>
        <div class="title-id">${esc(item.titleId || item.contentId || '')}</div>
        <div class="title-file" onclick="copyPath(${idx})" title="${esc(item.filePath)}">${esc(item.fileName)}</div>
        <div style="margin-top:3px">${dupBadge}${ftpBadge}</div>
      </td>
      <td><span class="badge ${catClass(cat)}">${esc(catLabel)}</span></td>
      <td>${esc(item.version || '—')}</td>
      <td><span class="badge ${regionClass(regLabel)}">${esc(regLabel)}</span></td>
      <td>${formatBytes(item.fileSize)}</td>
      <td>
        <div class="row-actions">
          <button class="act-btn" onclick="showInFolder(${idx})" title="Show in folder">📁</button>
          <button class="act-btn" onclick="copyId(${idx})" title="Copy Content ID">📋</button>
          <button class="act-btn danger" onclick="deleteSingle(${idx})" title="Delete">🗑</button>
        </div>
      </td>
    </tr>`;
  });

  tbody.innerHTML = rows.join('');

  // Bind checkbox events
  tbody.querySelectorAll('.row-chk').forEach(chk => {
    chk.addEventListener('change', () => {
      const i = parseInt(chk.dataset.idx, 10);
      filteredItems[i]._selected = chk.checked;
      // sync to allItems
      const orig = allItems.find(x => x.filePath === filteredItems[i].filePath);
      if (orig) orig._selected = chk.checked;
      chk.closest('tr').classList.toggle('selected', chk.checked);
      updateSelectionUI();
    });
  });
}

function esc(s) {
  if (!s) return '';
  return String(s)
    .replace(/&/g,'&amp;')
    .replace(/</g,'&lt;')
    .replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;');
}

// ── Filtering & Sorting ───────────────────────────────────────────────────────
function applyFilters() {
  let items = allItems.slice();

  // Category filter
  if (activeCat !== 'all') {
    items = items.filter(it => effectiveCat(it) === activeCat);
  }

  // Search filter
  if (searchQuery) {
    const q = searchQuery.toLowerCase();
    items = items.filter(it =>
      (it.title      || '').toLowerCase().includes(q) ||
      (it.titleId    || '').toLowerCase().includes(q) ||
      (it.fileName   || '').toLowerCase().includes(q) ||
      (it.contentId  || '').toLowerCase().includes(q)
    );
  }

  // Sort
  items.sort((a, b) => {
    let av = a[sortCol] ?? '';
    let bv = b[sortCol] ?? '';
    if (sortCol === 'fileSize') {
      av = Number(av); bv = Number(bv);
      return sortDir === 'asc' ? av - bv : bv - av;
    }
    av = String(av).toLowerCase();
    bv = String(bv).toLowerCase();
    if (av < bv) return sortDir === 'asc' ? -1 : 1;
    if (av > bv) return sortDir === 'asc' ? 1 : -1;
    return 0;
  });

  filteredItems = items;
  renderTable();
  updateCatCounts();
  document.getElementById('results-count').textContent =
    `${filteredItems.length} item${filteredItems.length !== 1 ? 's' : ''}${allItems.length !== filteredItems.length ? ` (of ${allItems.length})` : ''}`;
}

function updateCatCounts() {
  const counts = { all:0, game:0, patch:0, dlc:0, demo:0, theme:0, psp:0, other:0 };
  for (const it of allItems) {
    const c = effectiveCat(it);
    counts.all++;
    if (counts[c] !== undefined) counts[c]++;
    else counts.other++;
  }
  for (const [k,v] of Object.entries(counts)) {
    const el = document.getElementById('cnt-' + k);
    if (el) el.textContent = v;
  }
}

function updateSelectionUI() {
  const sel = allItems.filter(x => x._selected);
  const cnt = sel.length;
  document.getElementById('btn-batch-rename').disabled  = cnt === 0;
  document.getElementById('btn-batch-install').disabled = cnt === 0;
  document.getElementById('btn-batch-delete').disabled  = cnt === 0;
}

// ── Action helpers ────────────────────────────────────────────────────────────
function copyPath(idx) {
  const item = filteredItems[idx];
  if (!item) return;
  pkgApi.copyToClipboard(item.filePath);
  showToast('File path copied');
}

function copyId(idx) {
  const item = filteredItems[idx];
  if (!item) return;
  pkgApi.copyToClipboard(item.contentId || item.titleId || '');
  showToast('Content ID copied');
}

function showInFolder(idx) {
  const item = filteredItems[idx];
  if (!item) return;
  pkgApi.showInFolder(item.filePath);
}

async function deleteSingle(idx) {
  const item = filteredItems[idx];
  if (!item) return;
  if (!confirm(`Delete "${item.fileName}"?`)) return;
  const res = await pkgApi.deletePkgs([item]);
  if (res.ok) {
    allItems = allItems.filter(x => x !== item);
    applyFilters();
    showToast('Deleted successfully');
  } else {
    showToast('Delete failed: ' + (res.errors[0]?.error || 'unknown'), true);
  }
}

// ── Image preview ─────────────────────────────────────────────────────────────
let previewLocked = false;

function showImgPreview(event, src, lock = false) {
  if (previewLocked && !lock) return;
  if (lock) previewLocked = !previewLocked;
  const el = document.getElementById('img-preview');
  const img = document.getElementById('img-preview-img');
  img.src = src;
  el.style.display = 'block';
  el.style.left = Math.min(event.clientX + 12, window.innerWidth  - 260) + 'px';
  el.style.top  = Math.min(event.clientY + 12, window.innerHeight - 260) + 'px';
}

function hideImgPreview() {
  if (previewLocked) return;
  document.getElementById('img-preview').style.display = 'none';
}

document.getElementById('img-preview').addEventListener('click', () => {
  previewLocked = false;
  document.getElementById('img-preview').style.display = 'none';
});

// ── Toast ─────────────────────────────────────────────────────────────────────
function showToast(msg, isError = false) {
  const c = document.getElementById('toast-container');
  const t = document.createElement('div');
  t.className = 'toast' + (isError ? ' error' : '');
  t.textContent = msg;
  c.appendChild(t);
  setTimeout(() => t.remove(), 3200);
}

// ── Scan ──────────────────────────────────────────────────────────────────────
async function scan(sourceDir) {
  if (!sourceDir) { showToast('Select a source folder first', true); return; }
  addHistory('src', sourceDir);

  document.getElementById('scan-progress-row').style.display = 'block';
  document.getElementById('btn-cancel').style.display = '';
  setScanBar(0, true);
  document.getElementById('scan-label').textContent = 'Discovering files…';

  pkgApi.onScanProgress(onScanProgress);

  try {
    await pkgApi.scanPkgs(sourceDir);
  } finally {
    pkgApi.offScanProgress();
    document.getElementById('btn-cancel').style.display = 'none';
    setScanBar(100, false);
  }
}

function onScanProgress(d) {
  switch (d.type) {
    case 'scan-start':
      document.getElementById('scan-label').textContent = 'Starting scan…';
      break;
    case 'scan-discovering':
      document.getElementById('scan-label').textContent = 'Discovering .pkg files…';
      setScanBar(0, true);
      break;
    case 'scan-found':
      document.getElementById('scan-label').textContent = `Found ${d.total} files, parsing…`;
      setScanBar(0, false);
      break;
    case 'scan-parsing':
      if (d.total > 0) {
        const pct = Math.round((d.done / d.total) * 100);
        setScanBar(pct, false);
        document.getElementById('scan-label').textContent = `Parsing ${d.done}/${d.total}…`;
      }
      break;
    case 'scan-result':
      if (d.item) {
        // Stream item in
        const existing = allItems.findIndex(x => x.filePath === d.item.filePath);
        if (existing >= 0) allItems[existing] = d.item;
        else allItems.push(d.item);
        applyFilters();
      }
      break;
    case 'scan-done':
      document.getElementById('scan-label').textContent =
        d.cancelled ? 'Scan cancelled.' : `Done — ${d.total} PKG${d.total !== 1 ? 's' : ''} found.`;
      setScanBar(100, false);
      setTimeout(() => { document.getElementById('scan-progress-row').style.display = 'none'; }, 3000);
      showToast(d.cancelled ? 'Scan cancelled' : `Scan complete: ${d.total} PKGs`);
      break;
    case 'scan-error':
      document.getElementById('scan-label').textContent = 'Error: ' + d.error;
      showToast('Scan error: ' + d.error, true);
      break;
  }
}

function setScanBar(pct, wiggle) {
  const bar = document.getElementById('scan-bar');
  bar.style.width = pct + '%';
  bar.classList.toggle('wiggle', wiggle);
}

async function scanAllDrives() {
  const drives = await pkgApi.getAllDrives();
  if (!drives || drives.length === 0) { showToast('No drives found', true); return; }
  showToast(`Scanning ${drives.length} drive(s)…`);
  for (const drive of drives) {
    await scan(drive);
  }
}

// ── FTP Scan ──────────────────────────────────────────────────────────────────
function showFtpModal() {
  openModal('ftp-modal');
}

async function testFtpConn() {
  const cfg = getFtpCfg();
  showToast('Testing connection…');
  const res = await pkgApi.ftpTestConn(cfg);
  if (res.ok) showToast(`Connected! ${res.entries} entries in root.`);
  else showToast('Connection failed: ' + res.error, true);
}

function getFtpCfg() {
  return {
    host:  document.getElementById('ftp-host').value.trim(),
    port:  parseInt(document.getElementById('ftp-port').value, 10) || 21,
    user:  document.getElementById('ftp-user').value.trim(),
    pass:  document.getElementById('ftp-pass').value,
    paths: document.getElementById('ftp-paths').value.split('\n').map(x=>x.trim()).filter(Boolean),
  };
}

async function doFtpScan() {
  const cfg = getFtpCfg();
  closeModal('ftp-modal');

  document.getElementById('scan-progress-row').style.display = 'block';
  document.getElementById('btn-cancel').style.display = '';
  setScanBar(0, true);
  document.getElementById('scan-label').textContent = `FTP scanning ${cfg.host}…`;

  pkgApi.onScanProgress(onScanProgress);
  try {
    await pkgApi.ftpScanPkgs(cfg);
  } finally {
    pkgApi.offScanProgress();
    document.getElementById('btn-cancel').style.display = 'none';
    setScanBar(100, false);
  }
}

// ── GO ────────────────────────────────────────────────────────────────────────
async function goSelected() {
  const selected = allItems.filter(x => x._selected);
  if (selected.length === 0) { showToast('No items selected', true); return; }

  const destDir = document.getElementById('dest-input').value.trim();
  if (!destDir) { showToast('Select a destination folder', true); return; }

  const action = document.getElementById('action-select').value;
  const layout = document.getElementById('layout-select').value;
  const fmt    = document.getElementById('rename-format').value;

  // Check conflicts
  const conflicts = await pkgApi.checkPkgConflicts(selected, destDir, layout, fmt);
  if (conflicts.length > 0) {
    if (!confirm(`${conflicts.length} file(s) already exist at destination. Overwrite?`)) return;
  }

  addHistory('dest', destDir);

  // Build GO modal
  const listEl = document.getElementById('go-items-list');
  listEl.innerHTML = selected.map((it, i) => `
    <div class="go-item" id="go-item-${i}">
      <div class="go-item-name">${esc(it.fileName)}</div>
      <div class="go-progress-wrap"><div class="go-progress-fill" id="go-bar-${i}" style="width:0%"></div></div>
    </div>`).join('');

  document.getElementById('go-overall-label').textContent = `0 / ${selected.length}`;
  document.getElementById('go-overall-bar').style.width = '0%';
  document.getElementById('btn-go-cancel').classList.remove('hidden');
  document.getElementById('btn-go-close').classList.add('hidden');
  openModal('go-modal');

  pkgApi.onGoProgress(onGoProgress.bind(null, selected.length));
  await pkgApi.goPkgs(selected, destDir, action, layout, fmt, null);
  pkgApi.offGoProgress();
}

let goItemMap = {};

function onGoProgress(total, d) {
  switch (d.type) {
    case 'file-start':
      break;
    case 'file-progress': {
      const idx = allItems.filter(x=>x._selected).findIndex(x=>x.fileName===d.file);
      const bar = document.getElementById(`go-bar-${idx}`);
      if (bar && d.fileTotal > 0) bar.style.width = Math.round((d.transferred/d.fileTotal)*100)+'%';
      break;
    }
    case 'file-done': {
      const idx = allItems.filter(x=>x._selected).findIndex(x=>x.fileName===d.file);
      const bar = document.getElementById(`go-bar-${idx}`);
      if (bar) bar.style.width = '100%';
      document.getElementById('go-overall-label').textContent = `${d.done} / ${d.total}`;
      document.getElementById('go-overall-bar').style.width = Math.round((d.done/d.total)*100)+'%';
      break;
    }
    case 'all-done':
      document.getElementById('go-overall-bar').style.width = '100%';
      document.getElementById('btn-go-cancel').classList.add('hidden');
      document.getElementById('btn-go-close').classList.remove('hidden');
      showToast(d.cancelled ? 'Transfer cancelled' : `Done! ${d.done} file(s) transferred.`);
      break;
  }
}

function cancelGo() {
  pkgApi.cancelOperation();
}

// ── Delete selected ───────────────────────────────────────────────────────────
async function deleteSelected() {
  const selected = allItems.filter(x => x._selected);
  if (selected.length === 0) return;
  if (!confirm(`Delete ${selected.length} selected PKG file(s)?`)) return;
  const res = await pkgApi.deletePkgs(selected);
  if (res.ok) {
    allItems = allItems.filter(x => !x._selected);
    applyFilters();
    updateSelectionUI();
    showToast('Deleted successfully');
  } else {
    showToast(`${res.errors.length} error(s) during delete`, true);
  }
}

// ── Rename selected ───────────────────────────────────────────────────────────
function renameSelected() {
  renameTargets = allItems.filter(x => x._selected);
  if (renameTargets.length === 0) return;
  updateRenamePreview();
  openModal('rename-modal');
}

function updateRenamePreview() {
  const fmt  = document.getElementById('rename-modal-fmt').value;
  const item = renameTargets[0];
  if (!item) return;
  const name = applyClientFormat(fmt, item) + '.pkg';
  document.getElementById('rename-preview').textContent = name;
}

function applyRenamePreset() {
  const preset = document.getElementById('rename-preset').value;
  if (preset) document.getElementById('rename-modal-fmt').value = preset;
  updateRenamePreview();
}

function applyClientFormat(fmt, item) {
  return fmt
    .replace(/\{TITLE_ID\}/g,   item.titleId   || '')
    .replace(/\{TITLE\}/g,      item.title     || '')
    .replace(/\{VERSION\}/g,    item.version   || '')
    .replace(/\{CATEGORY\}/g,   item.category  || '')
    .replace(/\{REGION\}/g,     item.region    || '')
    .replace(/\{CONTENT_ID\}/g, item.contentId || '')
    .replace(/\{REQ_FW\}/g,     item.reqFw     || '');
}

async function applyRename() {
  const fmt = document.getElementById('rename-modal-fmt').value;
  closeModal('rename-modal');
  let ok = 0, fail = 0;
  for (const item of renameTargets) {
    const newName = applyClientFormat(fmt, item) + '.pkg';
    const res = await pkgApi.renamePkg(item, newName);
    if (res.ok) {
      item.filePath = res.newPath;
      item.fileName = newName;
      ok++;
    } else {
      fail++;
    }
  }
  applyFilters();
  showToast(`Renamed ${ok} file(s)` + (fail ? `, ${fail} failed` : ''));
}

// ── Remote Install ────────────────────────────────────────────────────────────
async function installSelected() {
  const selected = allItems.filter(x => x._selected);
  if (selected.length === 0) return;

  const hasFtp = selected.some(x => x.isFtp);
  document.getElementById('install-ftp-warning').style.display = hasFtp ? '' : 'none';

  // Populate items
  const listEl = document.getElementById('install-items-list');
  listEl.innerHTML = selected.map((it, i) => `
    <div class="install-item" id="inst-item-${i}">
      <div class="install-status" id="inst-icon-${i}">⏳</div>
      <div class="install-info">
        <div class="install-name">${esc(it.fileName)}</div>
        <div class="install-prog-wrap"><div class="install-prog-fill" id="inst-bar-${i}" style="width:0%"></div></div>
      </div>
    </div>`).join('');

  // Get local IP
  const ip = await pkgApi.getLocalIp();
  document.getElementById('local-ip-display').textContent = ip;

  document.getElementById('btn-send-ps3').classList.remove('hidden');
  document.getElementById('btn-install-close').classList.add('hidden');
  openModal('install-modal');
}

async function doInstall() {
  const selected = allItems.filter(x => x._selected);
  const ps3Ip   = document.getElementById('ps3-ip').value.trim();
  const ps3Port = document.getElementById('ps3-port').value;
  const srvPort = document.getElementById('srv-port').value;

  if (!ps3Ip) { showToast('Enter PS3 IP address', true); return; }

  document.getElementById('btn-send-ps3').classList.add('hidden');

  pkgApi.onInstallProgress(onInstallProgress.bind(null, selected));
  await pkgApi.remoteInstall(selected, ps3Ip, ps3Port, srvPort);
  pkgApi.offInstallProgress();
  document.getElementById('btn-install-close').classList.remove('hidden');
}

function onInstallProgress(selected, d) {
  if (d.status === 'all-done') {
    showToast('All installs complete');
    pkgApi.stopPkgServer();
    return;
  }
  if (d.idx === undefined) return;
  const icon = document.getElementById(`inst-icon-${d.idx}`);
  const bar  = document.getElementById(`inst-bar-${d.idx}`);
  if (icon) icon.textContent = d.status === 'done' ? '✅' : d.status === 'error' ? '❌' : '⏳';
  if (bar)  bar.style.width  = (d.percent || 0) + '%';
}

function closeInstallModal() {
  pkgApi.stopPkgServer();
  pkgApi.offInstallProgress();
  closeModal('install-modal');
}

// ── Find duplicates ───────────────────────────────────────────────────────────
function findDuplicates() {
  allItems.forEach(it => { it._selected = it.isDuplicate; });
  applyFilters();
  updateSelectionUI();
  const cnt = allItems.filter(x => x.isDuplicate).length;
  showToast(`${cnt} duplicate(s) selected`);
}

// ── Export CSV ────────────────────────────────────────────────────────────────
function exportCsv() {
  const cols = ['Title','Title ID','Content ID','Category','Version','Region','Size (bytes)','File Path'];
  const rows = filteredItems.map(it => [
    it.title     || '',
    it.titleId   || '',
    it.contentId || '',
    categoryDisplay(it.category || it.baseType || ''),
    it.version   || '',
    regionDisplay(it.region || ''),
    it.fileSize  || 0,
    it.filePath  || '',
  ].map(v => `"${String(v).replace(/"/g,'""')}"`).join(','));
  const csv = [cols.join(','), ...rows].join('\n');
  const blob = new Blob([csv], { type:'text/csv' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url; a.download = 'ps3vault-export.csv'; a.click();
  URL.revokeObjectURL(url);
  showToast('CSV exported');
}

// ── History ───────────────────────────────────────────────────────────────────
function loadHistory() {
  try { scanHistory = JSON.parse(localStorage.getItem(HISTORY_KEY_SRC)  || '[]'); } catch { scanHistory = []; }
  try { destHistory = JSON.parse(localStorage.getItem(HISTORY_KEY_DEST) || '[]'); } catch { destHistory = []; }
  updateHistoryUI();
}

function addHistory(type, value) {
  if (type === 'src') {
    scanHistory = [value, ...scanHistory.filter(x=>x!==value)].slice(0, 10);
    localStorage.setItem(HISTORY_KEY_SRC, JSON.stringify(scanHistory));
  } else {
    destHistory = [value, ...destHistory.filter(x=>x!==value)].slice(0, 10);
    localStorage.setItem(HISTORY_KEY_DEST, JSON.stringify(destHistory));
  }
  updateHistoryUI();
}

function updateHistoryUI() {
  const srcDl = document.getElementById('src-history');
  srcDl.innerHTML = scanHistory.map(h => `<option value="${esc(h)}"/>`).join('');
  const destDl = document.getElementById('dest-history');
  destDl.innerHTML = destHistory.map(h => `<option value="${esc(h)}"/>`).join('');
}

// ── Theme ─────────────────────────────────────────────────────────────────────
function loadTheme() {
  const t = localStorage.getItem(THEME_KEY) || 'dark';
  document.body.dataset.theme = t;
}

function toggleTheme() {
  const cur = document.body.dataset.theme;
  const next = cur === 'dark' ? 'light' : 'dark';
  document.body.dataset.theme = next;
  localStorage.setItem(THEME_KEY, next);
  document.getElementById('theme-toggle').textContent =
    'Made by Nookie ' + (next === 'dark' ? '🌙' : '☀️');
}

// ── Sort ──────────────────────────────────────────────────────────────────────
function setupSort() {
  document.querySelectorAll('th[data-sort]').forEach(th => {
    th.addEventListener('click', () => {
      const col = th.dataset.sort;
      if (sortCol === col) sortDir = sortDir === 'asc' ? 'desc' : 'asc';
      else { sortCol = col; sortDir = 'asc'; }
      document.querySelectorAll('th[data-sort]').forEach(t => {
        t.classList.remove('sorted','desc');
      });
      th.classList.add('sorted');
      if (sortDir === 'desc') th.classList.add('desc');
      applyFilters();
    });
  });
}

// ── Init ──────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  loadTheme();
  loadHistory();
  setupSort();
  applyFilters();

  // Category tabs
  document.getElementById('cat-tabs').addEventListener('click', e => {
    const tab = e.target.closest('.cat-tab');
    if (!tab) return;
    document.querySelectorAll('.cat-tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    activeCat = tab.dataset.cat;
    applyFilters();
  });

  // Search
  document.getElementById('search-input').addEventListener('input', e => {
    searchQuery = e.target.value.trim();
    applyFilters();
  });

  // Select all
  document.getElementById('chk-all').addEventListener('change', e => {
    filteredItems.forEach(it => {
      it._selected = e.target.checked;
      const orig = allItems.find(x => x.filePath === it.filePath);
      if (orig) orig._selected = e.target.checked;
    });
    renderTable();
    updateSelectionUI();
  });

  // Source browse
  document.getElementById('src-browse').addEventListener('click', async () => {
    const dir = await pkgApi.openDirectory();
    if (dir) document.getElementById('src-input').value = dir;
  });

  // Dest browse
  document.getElementById('dest-browse').addEventListener('click', async () => {
    const dir = await pkgApi.openDirectory();
    if (dir) document.getElementById('dest-input').value = dir;
  });

  // Scan button
  document.getElementById('btn-scan').addEventListener('click', () => {
    const dir = document.getElementById('src-input').value.trim();
    allItems = [];
    applyFilters();
    scan(dir);
  });

  // All drives
  document.getElementById('btn-all-drives').addEventListener('click', () => {
    allItems = [];
    applyFilters();
    scanAllDrives();
  });

  // FTP scan
  document.getElementById('btn-ftp-scan').addEventListener('click', showFtpModal);

  // Cancel
  document.getElementById('btn-cancel').addEventListener('click', () => pkgApi.cancelOperation());

  // GO
  document.getElementById('btn-go').addEventListener('click', goSelected);

  // Layout change → show/hide format row
  document.getElementById('layout-select').addEventListener('change', e => {
    const v = e.target.value;
    const fr = document.getElementById('format-row');
    if (v === 'rename' || v === 'rename-organize') fr.classList.add('visible');
    else fr.classList.remove('visible');
  });

  // Format input preview
  document.getElementById('rename-format').addEventListener('input', () => {});

  // Batch buttons
  document.getElementById('btn-batch-rename').addEventListener('click',  renameSelected);
  document.getElementById('btn-batch-install').addEventListener('click', installSelected);
  document.getElementById('btn-batch-delete').addEventListener('click',  deleteSelected);

  // Find dupes
  document.getElementById('btn-find-dupes').addEventListener('click', findDuplicates);

  // Rename modal
  document.getElementById('rename-modal-fmt').addEventListener('input', updateRenamePreview);

  // Menu select
  document.getElementById('menu-select').addEventListener('change', e => {
    const v = e.target.value;
    e.target.value = '';
    if (v === 'export-csv')   exportCsv();
    if (v === 'find-dupes')   findDuplicates();
    if (v === 'select-all')   { filteredItems.forEach(it => { it._selected = true; const o = allItems.find(x=>x.filePath===it.filePath); if(o) o._selected=true; }); renderTable(); updateSelectionUI(); }
    if (v === 'deselect-all') { allItems.forEach(it => { it._selected = false; }); filteredItems.forEach(it => { it._selected = false; }); renderTable(); updateSelectionUI(); }
  });

  // Theme toggle
  document.getElementById('theme-toggle').addEventListener('click', toggleTheme);

  // Discord link
  document.getElementById('discord-btn').addEventListener('click', () => {
    pkgApi.openExternal('https://discord.gg/ps3vault');
  });
});
