import { store } from './state.js';
import { escapeHtml, showToast, setDirty, setLoading, updateUnloadButton } from './utils.js';
import { pyLoadSave, pyExpandNode, pyExportSave, pyFlattenStoreScalars, initPyodide, isPyodideReady } from './pyodide-runtime.js';
import { renderAll } from './main.js';
import { openSaveKeyReferencesModal } from './modal.js';
import { isPersistentSave } from './saves.js';

const PAGE = 50;
let DATA = null;
let edits = {};
let deleted = new Set();
let pillFilter = 'all';
let selectedNs = null;

export function resetSaveEditorState() {
  DATA = null;
  edits = {};
  deleted = new Set();
  selectedNs = null;
  pillFilter = 'all';
}

export function extractVarsFromSaveStore(storeNodes) {
  const vars = {};
  if (!storeNodes) return vars;
  for (const [key, node] of Object.entries(storeNodes)) {
    if (!node || !['bool', 'int', 'float', 'str'].includes(node.t)) continue;
    vars[key] = node.v;
    if (key.startsWith('store.')) vars[key.slice(6)] = node.v;
  }
  return vars;
}

function uid(s) {
  return String(s).replace(/[^a-z0-9]/gi, '_');
}

function escA(s) {
  return escapeHtml(s).replace(/'/g, '&#39;');
}

function getGroups() {
  const groups = {};
  for (const key of Object.keys(DATA.store)) {
    const short = key.startsWith('store.') ? key.slice(6) : key;
    const parts = short.split('.');
    const g = parts.length > 1 ? parts[0] : '__root__';
    (groups[g] = groups[g] || []).push(key);
  }
  return groups;
}

function rememberSaveEntry(entry) {
  if (!entry?.file) return;
  const rel = entry.relPath || entry.file.name;
  if (!store.saveEntries) store.saveEntries = [];
  const idx = store.saveEntries.findIndex(e => e.relPath === rel);
  if (idx >= 0) {
    store.saveEntries[idx] = { ...store.saveEntries[idx], ...entry, relPath: rel };
  } else {
    store.saveEntries.unshift({ relPath: rel, file: entry.file, source: entry.source || 'disk' });
  }
  store.activeSavePath = rel;
}

export async function loadSaveFile(file, { switchMode = true, auto = false, relPath = null } = {}) {
  try {
    if (!isPyodideReady()) {
      showToast('Loading Python runtime (first time may take a few seconds)…');
    }
    const raw = new Uint8Array(await file.arrayBuffer());
    const parsed = await pyLoadSave(raw);
    let flatVars = extractVarsFromSaveStore(parsed.store);
    try {
      flatVars = { ...flatVars, ...(await pyFlattenStoreScalars()) };
    } catch (err) {
      console.warn('Scalar flatten for Story Browser failed:', err);
    }
    const path = relPath || file.name;
    DATA = { filename: file.name, relPath: path, store: parsed.store };
    edits = {};
    deleted = new Set();
    selectedNs = null;
    store.saveData = { vars: flatVars, filename: file.name };
    rememberSaveEntry({ relPath: path, file, source: 'disk' });
    setDirty(false);
    document.getElementById('file-meta').textContent = file.name;
    document.getElementById('export-btn').disabled = false;
    updateUnloadButton();
    showToast((auto ? 'Save auto-loaded: ' : 'Save loaded: ') + file.name);
    if (switchMode) store.mode = 'save';
    renderAll();
  } catch (err) {
    console.error(err);
    showToast('Could not load save: ' + err.message, true);
  }
}

export async function loadSaveFromEntry(entry, options = {}) {
  if (!entry?.file) {
    showToast('Could not read save file at "' + (entry?.relPath || '?') + '"', true);
    return;
  }
  await loadSaveFile(entry.file, { ...options, relPath: entry.relPath });
}

export async function switchSaveEntry(entry) {
  if (!entry?.file) return;
  if (store.dirty) {
    const ok = confirm('You have unsaved edits. Switch to another save anyway?');
    if (!ok) return;
  }
  await loadSaveFromEntry(entry, { switchMode: false, auto: false });
}

export async function exportSaveFile() {
  if (!DATA) return;
  try {
    setLoading(true);
    const out = await pyExportSave(edits, [...deleted]);
    const blob = new Blob([out], { type: 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = DATA.filename || 'edited.save';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    setDirty(false);
    showToast('Downloaded ' + a.download);
  } catch (err) {
    console.error(err);
    showToast('Export failed: ' + err.message, true);
  } finally {
    setLoading(false);
  }
}

function markDirtyState() {
  const mods = Object.keys(edits).length + deleted.size;
  setDirty(mods > 0);
}

function renderInlineVal(el, key, node) {
  const t = node?.t;
  if (t === 'bool') {
    const on = node.v ? 'on' : '';
    el.innerHTML = `<div class="save-bool"><button type="button" class="save-tog ${on}" data-key="${escA(key)}"></button><span class="save-tog-lbl">${node.v}</span></div>`;
    el.querySelector('.save-tog').onclick = (e) => {
      const btn = e.currentTarget;
      const isOn = btn.classList.toggle('on');
      btn.nextElementSibling.textContent = isOn;
      edits[key] = { t: 'bool', v: isOn };
      markMod(key);
      markDirtyState();
    };
  } else if (t === 'str') {
    el.innerHTML = `<input class="save-inp save-inp-str" value="${escA(node.v)}" data-key="${escA(key)}" data-orig="${escA(node.v)}">`;
    const inp = el.querySelector('input');
    inp.onchange = () => { edits[key] = { t: 'str', v: inp.value }; markMod(key); markDirtyState(); };
    inp.oninput = () => markMod(key);
  } else if (t === 'int' || t === 'float') {
    el.innerHTML = `<input class="save-inp save-inp-num" type="number" step="${t === 'int' ? '1' : 'any'}" value="${node.v}" data-key="${escA(key)}">`;
    const inp = el.querySelector('input');
    inp.onchange = () => {
      const v = t === 'int' ? parseInt(inp.value, 10) : parseFloat(inp.value);
      edits[key] = { t, v };
      markMod(key);
      markDirtyState();
    };
    inp.oninput = () => markMod(key);
  } else if (t === 'null') {
    el.innerHTML = '<span class="save-null">null</span>';
  } else if (['list', 'tuple', 'dict', 'set', 'obj'].includes(t)) {
    const dim = t === 'obj'
      ? ((node.cls || '').split('.').pop() + ' · ' + Object.keys(node.children || {}).length + ' attrs')
      : (node.len + ' item' + (node.len !== 1 ? 's' : ''));
    el.innerHTML = `<span class="save-cplx">${escapeHtml(dim)} — expand ▶</span>`;
  } else if (t === 'raw') {
    el.innerHTML = `<span class="save-null">${escapeHtml(String(node.v || '').slice(0, 100))}</span>`;
  } else if (node?.lazy && (t === 'list' || t === 'tuple')) {
    el.innerHTML = `<span class="save-null">${node.len} item${node.len !== 1 ? 's' : ''} — expand to load</span>`;
  } else if (node?.lazy && t === 'dict') {
    el.innerHTML = `<span class="save-null">${node.len} entr${node.len !== 1 ? 'ies' : 'y'} — expand to load</span>`;
  } else if (node?.lazy && t === 'set') {
    el.innerHTML = `<span class="save-null">${node.len} items — expand to load</span>`;
  } else if (node?.lazy && t === 'obj') {
    const cls = (node.cls || '').split('.').pop();
    el.innerHTML = `<span class="save-null">${escapeHtml(cls)} · ${node.len} attr${node.len !== 1 ? 's' : ''} — expand to load</span>`;
  } else {
    el.innerHTML = '<span class="save-null">—</span>';
  }
}

function markMod(key) {
  const row = document.querySelector(`.save-row[data-key="${CSS.escape(key)}"]`);
  if (row) row.classList.add('mod');
  updateSaveStats();
}

async function expandAndLoadChildren(container, keyPath, node, depth) {
  if (node?.lazy) {
    container.innerHTML = '<div class="save-null" style="padding:8px 12px">Loading…</div>';
    try {
      const full = await pyExpandNode(keyPath);
      Object.assign(node, full);
      delete node.lazy;
      const valEl = document.getElementById('vv-' + uid(keyPath));
      if (valEl) renderInlineVal(valEl, keyPath, node);
    } catch (err) {
      container.innerHTML = '<div class="media-missing" style="padding:8px 12px">(could not load: ' + escapeHtml(err.message) + ')</div>';
      return;
    }
  }
  loadChildren(container, keyPath, node, depth);
}

function loadChildren(container, keyPath, node, depth, pageStart = 0) {
  container.innerHTML = '';
  const t = node.t;
  if (t === 'list' || t === 'tuple') {
    const all = node.children || [];
    const page = all.slice(pageStart, pageStart + PAGE);
    page.forEach((child, i) => {
      const idx = pageStart + i;
      container.appendChild(makeNode(`${keyPath}[${idx}]`, child, String(idx), depth));
    });
    if (all.length > PAGE) appendPager(container, keyPath, node, depth, all.length, pageStart);
  } else if (t === 'dict') {
    const entries = Object.entries(node.children || {});
    const page = entries.slice(pageStart, pageStart + PAGE);
    page.forEach(([k, v]) => container.appendChild(makeNode(`${keyPath}.${k}`, v, k, depth)));
    if (entries.length > PAGE) appendPager(container, keyPath, node, depth, entries.length, pageStart);
  } else if (t === 'obj') {
    Object.entries(node.children || {}).filter(([k]) => !k.startsWith('_module'))
      .forEach(([k, v]) => container.appendChild(makeNode(`${keyPath}.${k}`, v, k, depth)));
  } else if (t === 'set') {
    const setEl = document.createElement('div');
    setEl.className = 'save-set-items';
    setEl.textContent = (node.items || []).join(', ') || '(empty)';
    container.appendChild(setEl);
  }
}

function appendPager(container, keyPath, node, depth, total, pageStart) {
  const bar = document.createElement('div');
  bar.className = 'save-pagebar';
  const totalPages = Math.ceil(total / PAGE);
  const curPage = Math.floor(pageStart / PAGE);
  bar.innerHTML = `<span class="save-pginfo">${pageStart + 1}–${Math.min(pageStart + PAGE, total)} of ${total}</span>`;
  if (curPage > 0) {
    const prev = document.createElement('button');
    prev.className = 'sub-btn';
    prev.textContent = '‹ prev';
    prev.onclick = () => { container.innerHTML = ''; loadChildren(container, keyPath, node, depth, (curPage - 1) * PAGE); };
    bar.appendChild(prev);
  }
  if (curPage < totalPages - 1) {
    const next = document.createElement('button');
    next.className = 'sub-btn';
    next.textContent = 'next ›';
    next.onclick = () => { container.innerHTML = ''; loadChildren(container, keyPath, node, depth, (curPage + 1) * PAGE); };
    bar.appendChild(next);
  }
  container.appendChild(bar);
}

function makeNode(keyPath, node, displayKey, depth) {
  const wrap = document.createElement('div');
  wrap.className = 'save-node';
  const isComplex = ['list', 'dict', 'obj', 'set', 'tuple'].includes(node?.t);
  const row = document.createElement('div');
  row.className = 'save-row d' + Math.min(depth, 5);
  row.dataset.key = keyPath;
  row.dataset.vt = node?.t || 'null';

  const xbtn = document.createElement('span');
  xbtn.className = isComplex ? 'save-xbtn' : 'save-xbtn leaf';
  xbtn.textContent = isComplex ? '▶' : '';

  const keyEl = document.createElement('span');
  keyEl.className = 'save-key';
  let disp = displayKey;
  if (depth === 0 && String(displayKey).startsWith('store.')) {
    const short = String(displayKey).slice(6);
    const parts = short.split('.');
    disp = parts.length > 1 ? parts.slice(0, -1).join('.') + '.' + parts[parts.length - 1] : short;
  }
  keyEl.textContent = disp;
  keyEl.classList.add('save-key-link');
  keyEl.title = 'Show script references';
  keyEl.onclick = (e) => {
    e.stopPropagation();
    openSaveKeyReferencesModal(keyPath);
  };

  const tb = document.createElement('span');
  tb.className = 'save-tbadge tb-' + (node?.t || 'null');
  tb.textContent = node?.t || 'null';

  const valEl = document.createElement('span');
  valEl.className = 'save-val';
  valEl.id = 'vv-' + uid(keyPath);
  renderInlineVal(valEl, keyPath, node);

  const acts = document.createElement('span');
  acts.className = 'save-acts';
  if (depth === 0) {
    const resetBtn = document.createElement('button');
    resetBtn.className = 'sub-btn';
    resetBtn.textContent = '↺';
    resetBtn.onclick = (e) => { e.stopPropagation(); resetKey(keyPath); };
    const delBtn = document.createElement('button');
    delBtn.className = 'sub-btn';
    delBtn.textContent = '✕';
    delBtn.style.color = 'var(--danger)';
    delBtn.onclick = (e) => { e.stopPropagation(); deleteKey(keyPath); };
    acts.appendChild(resetBtn);
    acts.appendChild(delBtn);
  }

  row.appendChild(xbtn);
  row.appendChild(keyEl);
  row.appendChild(tb);
  row.appendChild(valEl);
  row.appendChild(acts);

  let children = null;
  if (isComplex) {
    children = document.createElement('div');
    children.className = 'save-children';
    let loaded = false;
    const toggle = (e) => {
      e.stopPropagation();
      const open = !children.classList.contains('open');
      children.classList.toggle('open', open);
      xbtn.classList.toggle('open', open);
      xbtn.textContent = open ? '▼' : '▶';
      if (open && !loaded) {
        loaded = true;
        void expandAndLoadChildren(children, keyPath, node, depth + 1);
      }
    };
    xbtn.onclick = toggle;
    row.style.cursor = 'pointer';
    row.onclick = (e) => { if (!e.target.closest('button') && !e.target.closest('input')) toggle(e); };
  }

  wrap.appendChild(row);
  if (children) wrap.appendChild(children);
  return wrap;
}

function resetKey(key) {
  delete edits[key];
  deleted.delete(key);
  const orig = DATA.store[key];
  const el = document.getElementById('vv-' + uid(key));
  if (el) renderInlineVal(el, key, orig);
  const row = document.querySelector(`.save-row[data-key="${CSS.escape(key)}"]`);
  if (row) row.classList.remove('mod', 'del');
  markDirtyState();
  updateSaveStats();
}

function deleteKey(key) {
  deleted.add(key);
  delete edits[key];
  const row = document.querySelector(`.save-row[data-key="${CSS.escape(key)}"]`);
  if (row) row.classList.add('del');
  markDirtyState();
  updateSaveStats();
}

function resetAllEdits() {
  edits = {};
  deleted = new Set();
  setDirty(false);
  renderSaveContent();
  showToast('All changes reset');
}

function applySaveFilter() {
  const q = store.searchTerm;
  document.querySelectorAll('.save-row[data-key]').forEach(row => {
    if (row.closest('.save-children')) return;
    const key = row.dataset.key || '';
    const vt = row.dataset.vt || '';
    const isMod = row.classList.contains('mod') || deleted.has(key);
    let pass = true;
    if (selectedNs) {
      const short = key.startsWith('store.') ? key.slice(6) : key;
      const g = short.split('.').length > 1 ? short.split('.')[0] : '__root__';
      if (g !== selectedNs) pass = false;
    }
    if (q && !key.toLowerCase().includes(q)) pass = false;
    if (pillFilter === 'bool' && vt !== 'bool') pass = false;
    if (pillFilter === 'str' && vt !== 'str') pass = false;
    if (pillFilter === 'int' && vt !== 'int' && vt !== 'float') pass = false;
    if (pillFilter === 'complex' && !['list', 'dict', 'set', 'obj', 'tuple'].includes(vt)) pass = false;
    if (pillFilter === 'modified' && !isMod) pass = false;
    row.closest('.save-node')?.classList.toggle('fout', !pass);
  });
  updateSaveStats();
}

function updateSaveStats() {
  const el = document.getElementById('save-stats');
  if (!el || !DATA) return;
  const mods = Object.keys(edits).length + deleted.size;
  const total = Object.keys(DATA.store).length;
  el.textContent = total + ' keys · ' + mods + ' edits · ' + deleted.size + ' deleted';
}

function renderSaveTree(container) {
  container.innerHTML = '';
  const groups = getGroups();
  let keys = Object.keys(DATA.store).sort();
  if (selectedNs) {
    keys = (groups[selectedNs] || []).sort();
  }
  keys.forEach(key => container.appendChild(makeNode(key, DATA.store[key], key, 0)));
  applySaveFilter();
}

function renderSavePicker(sb) {
  const entries = store.saveEntries || [];
  if (!entries.length) return;

  const hdr = document.createElement('div');
  hdr.className = 'sidebar-section-label';
  hdr.textContent = 'Saves';
  sb.appendChild(hdr);

  entries.forEach(entry => {
    const fname = entry.relPath.split(/[\\/]/).pop();
    const isActive = store.activeSavePath === entry.relPath;
    const isPersist = isPersistentSave(entry);
    const modified = entry.file?.lastModified
      ? new Date(entry.file.lastModified).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' })
      : '';

    const div = document.createElement('div');
    div.className = 'name-list-item save-picker-item' + (isActive ? ' active-save' : '');
    div.title = entry.relPath + (modified ? '\n' + modified : '');
    div.innerHTML =
      '<span class="nm">' + escapeHtml(fname) + (isPersist ? ' <span class="save-persist-tag">persistent</span>' : '') + '</span>' +
      (modified ? '<span class="ct">' + escapeHtml(modified) + '</span>' : '<span class="ct"></span>');
    div.onclick = () => {
      if (store.activeSavePath === entry.relPath) return;
      void switchSaveEntry(entry);
    };
    sb.appendChild(div);
  });

  const sep = document.createElement('div');
  sep.className = 'sidebar-section-sep';
  sb.appendChild(sep);

  const filterHdr = document.createElement('div');
  filterHdr.className = 'sidebar-section-label';
  filterHdr.textContent = 'Filter by namespace';
  sb.appendChild(filterHdr);
}

export function renderSaveSidebar() {
  const sb = document.getElementById('sidebar');
  sb.innerHTML = '';

  renderSavePicker(sb);

  if (!DATA) {
    const hint = document.createElement('div');
    hint.style.padding = '14px 18px';
    hint.style.fontSize = '12px';
    hint.style.color = 'var(--text-dim)';
    hint.textContent = store.saveEntries?.length
      ? 'Select a save above, or use Load Save in the header.'
      : 'Load a game folder or a .save file to browse variables.';
    sb.appendChild(hint);
    return;
  }

  const all = document.createElement('div');
  all.className = 'name-list-item';
  all.style.background = selectedNs === null ? 'var(--panel2)' : '';
  all.innerHTML = '<span class="nm">(all keys)</span><span class="ct">' + Object.keys(DATA.store).length + '</span>';
  all.onclick = () => { selectedNs = null; renderAll(); };
  sb.appendChild(all);

  const groups = getGroups();
  Object.keys(groups).sort((a, b) => {
    const ai = a.startsWith('_') || a === '__root__';
    const bi = b.startsWith('_') || b === '__root__';
    if (ai !== bi) return ai ? 1 : -1;
    return a.localeCompare(b);
  }).forEach(g => {
    const label = g === '__root__' ? '(root)' : g;
    const div = document.createElement('div');
    div.className = 'name-list-item';
    div.style.background = selectedNs === g ? 'var(--panel2)' : '';
    div.innerHTML = '<span class="nm">' + escapeHtml(label) + '</span><span class="ct">' + groups[g].length + '</span>';
    div.onclick = () => { selectedNs = g; renderAll(); };
    sb.appendChild(div);
  });
}

export function renderSaveContent() {
  const content = document.getElementById('content');
  content.innerHTML = '';

  if (!DATA) {
    content.innerHTML = '<div class="empty-state">💾 Load a Ren\'Py <code>.save</code> file using the button above.<br><br>First load downloads the Python runtime (~15MB) via Pyodide — runs entirely in your browser.<br><br>Only scalar values (bool/int/float/str) are editable; complex objects can be browsed and deleted.</div>';
    return;
  }

  const toolbar = document.createElement('div');
  toolbar.className = 'save-toolbar';
  ['all', 'bool', 'str', 'int', 'complex', 'modified'].forEach(f => {
    const b = document.createElement('button');
    b.className = 'sub-btn' + (pillFilter === f ? ' active' : '');
    b.textContent = f;
    b.onclick = () => { pillFilter = f; applySaveFilter(); toolbar.querySelectorAll('.sub-btn').forEach(x => x.classList.remove('active')); b.classList.add('active'); };
    toolbar.appendChild(b);
  });
  const resetBtn = document.createElement('button');
  resetBtn.className = 'secondary';
  resetBtn.textContent = '↺ Reset all edits';
  resetBtn.onclick = resetAllEdits;
  toolbar.appendChild(resetBtn);
  content.appendChild(toolbar);

  const stats = document.createElement('div');
  stats.className = 'save-stats';
  stats.id = 'save-stats';
  content.appendChild(stats);

  const tree = document.createElement('div');
  tree.className = 'save-tree';
  tree.id = 'save-tree';
  content.appendChild(tree);

  renderSaveTree(tree);
  updateSaveStats();
}

export function onSaveSearch() {
  if (DATA) applySaveFilter();
}

// Pre-warm Pyodide when user opens save mode
export function prewarmPyodide() {
  initPyodide().catch(err => console.warn('Pyodide prewarm failed:', err));
}