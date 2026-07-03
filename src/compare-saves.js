import { store } from './state.js';
import { escapeHtml, showToast, setLoading } from './utils.js';
import { pyCompareLoad, pyFlattenSlot, initPyodide, isPyodideReady } from './pyodide-runtime.js';
import { isPersistentSave } from './saves.js';

const PAGE = 80;
let diffFilter = 'game';
let diffPage = 0;
let lastChanges = [];

export function flattenSaveNode(node, prefix, out) {
  if (!node) return;
  const t = node.t;
  if (['bool', 'int', 'float', 'str', 'raw'].includes(t)) {
    out[prefix] = node.v;
    return;
  }
  if (t === 'null') {
    out[prefix] = null;
    return;
  }
  if (t === 'list' || t === 'tuple') {
    (node.children || []).forEach((child, i) => flattenSaveNode(child, `${prefix}[${i}]`, out));
    return;
  }
  if (t === 'dict' || t === 'obj') {
    Object.entries(node.children || {}).forEach(([k, v]) => {
      flattenSaveNode(v, prefix ? `${prefix}.${k}` : k, out);
    });
    return;
  }
  if (t === 'set') {
    out[prefix] = (node.items || []).join(', ') || '(empty)';
  }
}

export function flattenSaveStore(saveNodes) {
  const out = {};
  if (!saveNodes) return out;
  Object.entries(saveNodes).forEach(([k, v]) => flattenSaveNode(v, k, out));
  return out;
}

export function diffFlat(flatA, flatB) {
  const keys = new Set([...Object.keys(flatA), ...Object.keys(flatB)]);
  const changes = [];
  keys.forEach(k => {
    if (flatA[k] !== flatB[k]) changes.push({ path: k, before: flatA[k], after: flatB[k] });
  });
  changes.sort((a, b) => a.path.localeCompare(b.path));
  return changes;
}

function isInternalPath(path) {
  const short = path.startsWith('store.') ? path.slice(6) : path;
  if (short.startsWith('_')) return true;
  return /(^|\.|\[)_/.test(short);
}

function isTopLevelPath(path) {
  const short = path.startsWith('store.') ? path.slice(6) : path;
  return !short.includes('.') && !short.includes('[');
}

function groupRenpyDiff(changes) {
  const groups = { gameVars: [], internal: [], nested: [] };
  changes.forEach(c => {
    if (isTopLevelPath(c.path) && !isInternalPath(c.path)) groups.gameVars.push(c);
    else if (isInternalPath(c.path)) groups.internal.push(c);
    else groups.nested.push(c);
  });
  return groups;
}

function fmtVal(v) {
  if (v === undefined) return '(unset)';
  if (v === null) return 'null';
  if (typeof v === 'boolean') return v ? 'ON' : 'OFF';
  const s = String(v);
  return s.length > 120 ? s.slice(0, 117) + '…' : s;
}

function storyHint(path) {
  const short = path.startsWith('store.') ? path.slice(6) : path;
  const root = short.split(/[.[]/)[0];
  if (!store.storyData?.varIndex?.[root]) return '';
  const entry = store.storyData.varIndex[root];
  const refs = entry.setters.length + entry.checkers.length;
  return refs ? ` · ${refs} script ref${refs !== 1 ? 's' : ''}` : '';
}

function filterChanges(changes) {
  if (diffFilter === 'all') return changes;
  if (diffFilter === 'game') return changes.filter(c => !isInternalPath(c.path));
  if (diffFilter === 'top') return changes.filter(c => isTopLevelPath(c.path) && !isInternalPath(c.path));
  if (diffFilter === 'internal') return changes.filter(c => isInternalPath(c.path));
  return changes;
}

function diffSectionHeader(text) {
  const h = document.createElement('div');
  h.className = 'diff-section-h';
  h.textContent = text;
  return h;
}

function diffRow(path, before, after) {
  const row = document.createElement('div');
  row.className = 'ref-card';
  row.style.cursor = 'default';
  const label = path + storyHint(path);
  row.innerHTML =
    '<div class="title">' + escapeHtml(label) + '</div>' +
    '<div class="loc">' + escapeHtml(fmtVal(before)) + '  →  ' + escapeHtml(fmtVal(after)) + '</div>';
  return row;
}

function renderDiffResults(changes, container) {
  const filtered = filterChanges(changes);
  const summary = document.createElement('div');
  summary.className = 'cat-sub';
  summary.textContent = filtered.length + ' difference' + (filtered.length !== 1 ? 's' : '') +
    (diffFilter !== 'all' ? ` (${changes.length} total)` : '') + ' found';
  container.appendChild(summary);

  if (filtered.length === 0) {
    const e = document.createElement('div');
    e.className = 'empty-state';
    e.textContent = changes.length
      ? 'No differences match the current filter.'
      : 'These two saves are identical (at the flattened variable level).';
    container.appendChild(e);
    return;
  }

  const groups = groupRenpyDiff(filtered);
  const pageStart = diffPage * PAGE;
  const pageSlice = filtered.slice(pageStart, pageStart + PAGE);
  const gameSet = new Set(groups.gameVars);
  let lastSection = null;

  pageSlice.forEach(c => {
    if (diffFilter === 'game' || diffFilter === 'top') {
      const section = gameSet.has(c) ? 'game' : 'nested';
      if (section !== lastSection) {
        lastSection = section;
        const label = section === 'game'
          ? `Game variables (${groups.gameVars.length})`
          : `Nested state (${groups.nested.length})`;
        container.appendChild(diffSectionHeader(label));
      }
    } else if (diffFilter === 'internal' && lastSection !== 'internal') {
      lastSection = 'internal';
      container.appendChild(diffSectionHeader(`Internal state (${groups.internal.length})`));
    }
    container.appendChild(diffRow(c.path, c.before, c.after));
  });

  if (filtered.length > PAGE) {
    const bar = document.createElement('div');
    bar.className = 'save-pagebar';
    const totalPages = Math.ceil(filtered.length / PAGE);
    bar.innerHTML = `<span class="save-pginfo">${pageStart + 1}–${Math.min(pageStart + PAGE, filtered.length)} of ${filtered.length}</span>`;
    if (diffPage > 0) {
      const prev = document.createElement('button');
      prev.className = 'sub-btn';
      prev.textContent = '‹ prev';
      prev.onclick = () => { diffPage--; renderCompareContent(); };
      bar.appendChild(prev);
    }
    if (diffPage < totalPages - 1) {
      const next = document.createElement('button');
      next.className = 'sub-btn';
      next.textContent = 'next ›';
      next.onclick = () => { diffPage++; renderCompareContent(); };
      bar.appendChild(next);
    }
    container.appendChild(bar);
  }
}

async function loadCompareFile(label, file, relPath = null) {
  const slot = label === 'A' ? 'a' : 'b';
  const displayName = relPath
    ? relPath.split(/[\\/]/).pop()
    : file.name;
  try {
    if (!isPyodideReady()) {
      showToast('Loading Python runtime (first time may take a few seconds)…');
    }
    setLoading(true, 'Loading save ' + label + '…');
    const raw = new Uint8Array(await file.arrayBuffer());
    await pyCompareLoad(slot, raw);
    setLoading(true, 'Flattening save ' + label + ' for diff…');
    const flat = await pyFlattenSlot(slot);
    if (label === 'A') {
      store.compareSaveA = flat;
      store.compareSaveAName = displayName;
      store.compareSaveAPath = relPath;
    } else {
      store.compareSaveB = flat;
      store.compareSaveBName = displayName;
      store.compareSaveBPath = relPath;
    }
    diffPage = 0;
    renderCompareContent();
    renderCompareSidebar();
    showToast('Save ' + label + ': ' + displayName + ' (' + Object.keys(flat).length + ' values)');
  } catch (err) {
    console.error(err);
    showToast('Could not load Save ' + label + ': ' + err.message, true);
  } finally {
    setLoading(false);
  }
}

async function loadCompareFromEntry(label, entry) {
  if (!entry?.file) {
    showToast('Could not read save at "' + (entry?.relPath || '?') + '"', true);
    return;
  }
  await loadCompareFile(label, entry.file, entry.relPath);
}

function triggerCompareLoad(label) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.save';
  input.onchange = (e) => { if (e.target.files[0]) loadCompareFile(label, e.target.files[0]); };
  input.click();
}

function makeCompareSlot(label, fname) {
  const box = document.createElement('div');
  box.className = 'compare-slot';
  const h = document.createElement('div');
  h.className = 'compare-slot-title';
  h.textContent = 'Save ' + label;
  box.appendChild(h);
  if (fname) {
    const f = document.createElement('div');
    f.className = 'compare-slot-file';
    f.textContent = fname;
    box.appendChild(f);
  }

  const entries = store.saveEntries || [];
  if (entries.length) {
    const pickLabel = document.createElement('label');
    pickLabel.className = 'compare-slot-pick-label';
    pickLabel.textContent = 'From loaded game';
    const select = document.createElement('select');
    select.className = 'compare-slot-select';
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = '— pick a save —';
    select.appendChild(placeholder);
    entries.forEach(entry => {
      const opt = document.createElement('option');
      opt.value = entry.relPath;
      const fnameOnly = entry.relPath.split(/[\\/]/).pop();
      opt.textContent = fnameOnly + (isPersistentSave(entry) ? ' (persistent)' : '');
      const activePath = label === 'A' ? store.compareSaveAPath : store.compareSaveBPath;
      if (activePath === entry.relPath) opt.selected = true;
      select.appendChild(opt);
    });
    select.onchange = () => {
      const entry = entries.find(e => e.relPath === select.value);
      if (entry) void loadCompareFromEntry(label, entry);
      else select.value = activePathForSlot(label) || '';
    };
    pickLabel.appendChild(select);
    box.appendChild(pickLabel);
  }

  const btn = document.createElement('button');
  btn.className = 'secondary';
  btn.textContent = entries.length
    ? (fname ? '📂 Open other .save file…' : '📂 Open .save file…')
    : (fname ? '📂 Replace .save file…' : '📂 Open .save file…');
  btn.title = 'Pick any .save file from disk (not limited to the loaded game)';
  btn.onclick = () => triggerCompareLoad(label);
  box.appendChild(btn);
  return box;
}

function activePathForSlot(label) {
  return label === 'A' ? store.compareSaveAPath : store.compareSaveBPath;
}

function renderCompareSavePicker(sb) {
  const entries = store.saveEntries || [];
  if (!entries.length) return;

  const hdr = document.createElement('div');
  hdr.className = 'sidebar-section-label';
  hdr.textContent = 'Game saves';
  sb.appendChild(hdr);

  const intro = document.createElement('div');
  intro.className = 'compare-sidebar-intro';
  intro.textContent = entries.length + ' save(s) found in the loaded game — assign to A or B.';
  sb.appendChild(intro);

  entries.forEach(entry => {
    const fname = entry.relPath.split(/[\\/]/).pop();
    const isPersist = isPersistentSave(entry);
    const isA = store.compareSaveAPath === entry.relPath;
    const isB = store.compareSaveBPath === entry.relPath;
    const modified = entry.file?.lastModified
      ? new Date(entry.file.lastModified).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' })
      : '';

    const row = document.createElement('div');
    row.className = 'compare-save-row' + (isA || isB ? ' compare-save-active' : '');
    row.innerHTML =
      '<div class="compare-save-info">' +
        '<span class="compare-save-name">' + escapeHtml(fname) +
          (isPersist ? ' <span class="save-persist-tag">persistent</span>' : '') +
        '</span>' +
        (modified ? '<span class="compare-save-date">' + escapeHtml(modified) + '</span>' : '') +
      '</div>';

    const actions = document.createElement('div');
    actions.className = 'compare-save-actions';
    ['A', 'B'].forEach(slot => {
      const active = slot === 'A' ? isA : isB;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'compare-slot-btn' + (active ? ' active' : '');
      btn.textContent = slot;
      btn.title = 'Use as Save ' + slot;
      btn.onclick = () => void loadCompareFromEntry(slot, entry);
      actions.appendChild(btn);
    });
    row.appendChild(actions);
    sb.appendChild(row);
  });

  const sep = document.createElement('div');
  sep.className = 'sidebar-section-sep';
  sb.appendChild(sep);
}

export function renderCompareSidebar() {
  const sb = document.getElementById('sidebar');
  const filters = [
    { id: 'game', label: 'Game vars', desc: 'Exclude Ren\'Py internals (store._*)' },
    { id: 'top', label: 'Top-level', desc: 'Only root store keys' },
    { id: 'all', label: 'Everything', desc: 'Include history, rollback, etc.' },
    { id: 'internal', label: 'Internal only', desc: 'Ren\'Py engine state' },
  ];
  sb.innerHTML = '';
  renderCompareSavePicker(sb);

  const intro = document.createElement('div');
  intro.className = 'compare-sidebar-intro';
  intro.textContent = store.saveEntries?.length
    ? 'Game saves below, or use 📂 Open .save file in each slot. Then pick a diff filter.'
    : 'No saves in loaded game — use 📂 Open .save file above for each slot.';
  sb.appendChild(intro);

  const filterHdr = document.createElement('div');
  filterHdr.className = 'sidebar-section-label';
  filterHdr.textContent = 'Diff filter';
  sb.appendChild(filterHdr);

  filters.forEach(f => {
    const div = document.createElement('div');
    div.className = 'name-list-item' + (diffFilter === f.id ? ' active-filter' : '');
    div.innerHTML = '<span class="nm">' + escapeHtml(f.label) + '</span>';
    div.title = f.desc;
    div.onclick = () => { diffFilter = f.id; diffPage = 0; renderCompareContent(); renderCompareSidebar(); };
    sb.appendChild(div);
  });
  if (lastChanges.length) {
    const stats = document.createElement('div');
    stats.className = 'compare-sidebar-intro';
    const g = groupRenpyDiff(lastChanges);
    stats.textContent = `${g.gameVars.length} game · ${g.nested.length} nested · ${g.internal.length} internal`;
    sb.appendChild(stats);
  }
}

export function renderCompareContent() {
  const content = document.getElementById('content');
  content.innerHTML = '';

  const title = document.createElement('div');
  title.className = 'cat-title';
  title.textContent = 'Compare Two Saves';
  content.appendChild(title);

  const sub = document.createElement('div');
  sub.className = 'cat-sub';
  sub.textContent = 'Pick saves from the loaded game (sidebar/dropdown) or open any .save file. Diffs flattened store variables in Python.';
  content.appendChild(sub);

  const loadRow = document.createElement('div');
  loadRow.className = 'compare-load-row';
  loadRow.appendChild(makeCompareSlot('A', store.compareSaveAName));
  loadRow.appendChild(makeCompareSlot('B', store.compareSaveBName));
  content.appendChild(loadRow);

  if (store.compareSaveA && store.compareSaveB) {
    lastChanges = diffFlat(store.compareSaveA, store.compareSaveB);
    renderDiffResults(lastChanges, content);
  } else {
    lastChanges = [];
    const e = document.createElement('div');
    e.className = 'empty-state';
    e.textContent = 'Load both Save A and Save B above to see the comparison.';
    content.appendChild(e);
  }
}

export function prewarmComparePyodide() {
  initPyodide().catch(err => console.warn('Pyodide prewarm failed:', err));
}