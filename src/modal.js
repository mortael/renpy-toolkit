import { store, lookupAssetUsages, lookupVariableRefs } from './state.js';
import { escapeHtml } from './utils.js';
import { getAssetKind, kindIcon, resolveAssetUrlCached, assetFolderHint, getAssetBytes } from './assets.js';
import { tryParseGenericHeader, parseManualRpaOptions } from './rpa.js';
import { jumpToLabel } from './story-browser.js';
import { renderAll } from './main.js';

export function openModal(contentEl) {
  const inner = document.getElementById('modal-inner');
  inner.innerHTML = '';
  inner.appendChild(contentEl);
  document.getElementById('modal-overlay').classList.add('show');
}

export function closeModal() {
  document.getElementById('modal-overlay').classList.remove('show');
  document.getElementById('modal-inner').innerHTML = '';
  store.galleryContext = null;
}

export function navigateGallery(direction) {
  if (!store.galleryContext) return;
  const { entries, index } = store.galleryContext;
  if (entries.length <= 1) return;
  let newIndex = index + direction;
  if (newIndex < 0) newIndex = entries.length - 1;
  if (newIndex >= entries.length) newIndex = 0;
  const newEntry = entries[newIndex];
  const folderHint = assetFolderHint(newEntry);
  openAssetPreviewModal(newEntry, folderHint, entries, newIndex);
}

function renderUsageList(usages, container) {
  const header = document.createElement('div');
  header.style.fontSize = '13px';
  header.style.color = 'var(--text-dim)';
  header.style.margin = '14px 0 8px';
  header.style.borderTop = '1px solid var(--border)';
  header.style.paddingTop = '12px';
  if (!store.storyData) {
    header.textContent = 'Load .rpy script files (Story Browser phase) to see where this asset is referenced.';
    header.style.fontStyle = 'italic';
    container.appendChild(header);
    return;
  }
  if (usages.length === 0) {
    header.textContent = 'Not referenced in any parsed script (may be used dynamically, or unused).';
    header.style.fontStyle = 'italic';
    container.appendChild(header);
    return;
  }
  header.textContent = 'Used in (' + usages.length + ')';
  container.appendChild(header);
  usages.forEach(u => {
    const card = document.createElement('div');
    card.className = 'ref-card';
    const title = u.label || u.eventName || u.path || 'reference';
    const loc = u.file ? (u.file + (u.line ? ' — line ' + u.line : '')) : (u.location || '');
    card.innerHTML = '<div class="title">' + escapeHtml(title) + '</div><div class="loc">' + escapeHtml(loc) + '</div>';
    card.onclick = () => {
      closeModal();
      if (u.scriptId !== undefined) {
        store.mode = 'story';
        store.activeTab = 'labels';
        store.selectedId = u.scriptId;
        renderAll();
      } else if (u.label) {
        jumpToLabel(u.label);
      }
    };
    container.appendChild(card);
  });
}

function makeVarRefCard(ref, kind) {
  const card = document.createElement('div');
  card.className = 'ref-card';
  const tag = document.createElement('span');
  tag.className = 'tag ' + (kind === 'set' ? 'tag-set' : 'tag-check');
  tag.textContent = kind === 'set' ? 'SET ' + (ref.detail || '') : 'CHECK ' + (ref.detail || '');
  const titleSpan = document.createElement('span');
  titleSpan.className = 'title';
  titleSpan.textContent = ref.eventName || ref.label || 'script';
  card.appendChild(tag);
  card.appendChild(titleSpan);
  const loc = document.createElement('div');
  loc.className = 'loc';
  loc.textContent = (ref.file || '') + (ref.line ? ' — line ' + ref.line : '');
  card.appendChild(loc);
  card.onclick = () => {
    closeModal();
    store.mode = 'story';
    store.activeTab = 'labels';
    store.selectedId = ref.scriptId;
    renderAll();
  };
  return card;
}

export function openSaveKeyReferencesModal(keyPath) {
  const wrap = document.createElement('div');
  wrap.style.minWidth = '340px';
  wrap.style.maxWidth = '520px';

  const title = document.createElement('div');
  title.className = 'cat-title';
  title.textContent = keyPath;
  wrap.appendChild(title);

  if (!store.storyData) {
    const hint = document.createElement('div');
    hint.className = 'cat-sub';
    hint.textContent = 'Load a game folder with .rpy scripts to see where this variable is referenced.';
    wrap.appendChild(hint);
    openModal(wrap);
    return;
  }

  const { setters, checkers, matchedName } = lookupVariableRefs(keyPath);
  const sub = document.createElement('div');
  sub.className = 'cat-sub';
  if (matchedName && matchedName !== keyPath) {
    sub.textContent = 'Script cross-reference for “' + matchedName + '” (regex scan — may miss dynamic names).';
  } else {
    sub.textContent = 'Script cross-reference (regex scan — may miss dynamic names).';
  }
  wrap.appendChild(sub);

  const total = setters.length + checkers.length;
  if (total === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.style.padding = '16px 0';
    empty.textContent = 'No script references found for this key. It may be engine-internal, set only in Python, or use a dynamic name.';
    wrap.appendChild(empty);
    openModal(wrap);
    return;
  }

  if (setters.length) {
    const setH = document.createElement('div');
    setH.style.fontSize = '13px';
    setH.style.color = 'var(--text-dim)';
    setH.style.margin = '14px 0 8px';
    setH.textContent = 'SET by (' + setters.length + ')';
    wrap.appendChild(setH);
    setters.forEach(ref => wrap.appendChild(makeVarRefCard(ref, 'set')));
  }

  if (checkers.length) {
    const chkH = document.createElement('div');
    chkH.style.fontSize = '13px';
    chkH.style.color = 'var(--text-dim)';
    chkH.style.margin = '18px 0 8px';
    chkH.textContent = 'CHECKED by (' + checkers.length + ')';
    wrap.appendChild(chkH);
    checkers.forEach(ref => wrap.appendChild(makeVarRefCard(ref, 'check')));
  }

  openModal(wrap);
}

export async function openAssetPreviewModal(entry, folderHint, galleryEntries, galleryIndex) {
  const fname = entry.relPath.split(/[\\/]/).pop();
  const dot = fname.lastIndexOf('.');
  const baseName = dot >= 0 ? fname.slice(0, dot) : fname;
  const kind = getAssetKind(fname.toLowerCase());
  const hasGallery = kind === 'image' && galleryEntries && galleryEntries.length > 1 && galleryIndex !== undefined && galleryIndex >= 0;
  store.galleryContext = hasGallery ? { entries: galleryEntries, index: galleryIndex } : null;

  const wrap = document.createElement('div');
  wrap.style.minWidth = '280px';
  wrap.style.maxWidth = '82vw';
  const pathLabel = document.createElement('div');
  pathLabel.style.fontSize = '12px';
  pathLabel.style.color = 'var(--text-dim)';
  pathLabel.style.marginBottom = '12px';
  pathLabel.textContent = kindIcon(kind) + ' ' + entry.relPath + (hasGallery ? '  (' + (galleryIndex + 1) + ' / ' + galleryEntries.length + ')' : '');
  wrap.appendChild(pathLabel);

  const actionBar = document.createElement('div');
  actionBar.style.display = 'flex';
  actionBar.style.gap = '8px';
  actionBar.style.marginBottom = '12px';
  const openTabBtn = document.createElement('button');
  openTabBtn.className = 'secondary';
  openTabBtn.textContent = 'Open file in new tab ↗';
  openTabBtn.disabled = true;
  actionBar.appendChild(openTabBtn);
  wrap.appendChild(actionBar);

  const previewRow = document.createElement('div');
  previewRow.style.display = 'flex';
  previewRow.style.alignItems = 'center';
  previewRow.style.justifyContent = 'center';
  previewRow.style.gap = '12px';
  if (hasGallery) {
    const prevBtn = document.createElement('button');
    prevBtn.className = 'secondary';
    prevBtn.textContent = '◀';
    prevBtn.style.fontSize = '18px';
    prevBtn.style.padding = '14px 16px';
    prevBtn.onclick = (e) => { e.stopPropagation(); navigateGallery(-1); };
    previewRow.appendChild(prevBtn);
  }
  const previewBox = document.createElement('div');
  previewBox.style.textAlign = 'center';
  previewBox.style.minWidth = '120px';
  previewBox.textContent = 'Loading…';
  previewRow.appendChild(previewBox);
  if (hasGallery) {
    const nextBtn = document.createElement('button');
    nextBtn.className = 'secondary';
    nextBtn.textContent = '▶';
    nextBtn.style.fontSize = '18px';
    nextBtn.style.padding = '14px 16px';
    nextBtn.onclick = (e) => { e.stopPropagation(); navigateGallery(1); };
    previewRow.appendChild(nextBtn);
  }
  wrap.appendChild(previewRow);
  openModal(wrap);

  try {
    const url = await resolveAssetUrlCached(entry);
    openTabBtn.disabled = false;
    openTabBtn.onclick = () => window.open(url, '_blank');
    previewBox.innerHTML = '';
    if (kind === 'image') {
      const img = document.createElement('img');
      img.src = url;
      img.style.maxWidth = 'none';
      img.style.maxHeight = '70vh';
      img.style.borderRadius = '6px';
      previewBox.appendChild(img);
    } else if (kind === 'audio') {
      const audio = document.createElement('audio');
      audio.controls = true;
      audio.src = url;
      audio.style.width = '340px';
      previewBox.appendChild(audio);
    } else if (kind === 'video') {
      const video = document.createElement('video');
      video.controls = true;
      video.src = url;
      video.style.maxWidth = '70vw';
      video.style.maxHeight = '60vh';
      previewBox.appendChild(video);
    } else if (kind === 'script' || kind === 'text') {
      const bytes = await getAssetBytes(entry);
      const text = new TextDecoder('utf-8').decode(bytes);
      const pre = document.createElement('pre');
      pre.style.cssText = 'max-height:60vh;overflow:auto;text-align:left;font-size:11px;white-space:pre-wrap;word-break:break-word;margin:0;padding:10px;background:var(--panel2);border-radius:6px';
      pre.textContent = text.length > 120000 ? text.slice(0, 120000) + '\n…(truncated)' : text;
      previewBox.appendChild(pre);
    } else {
      previewBox.textContent = '(no inline preview — use Open file in new tab)';
    }
  } catch (err) {
    previewBox.innerHTML = '';
    previewBox.textContent = '(could not load: ' + err.message + ')';
  }

  const guessFolder = folderHint || assetFolderHint(entry);
  renderUsageList(lookupAssetUsages(guessFolder, baseName), wrap);
}

export function openRpaManualModal(entry, headerLine = '', failureReason = '') {
  return new Promise(resolve => {
    const archiveName = entry.relPath.split(/[\\/]/).pop();
    const generic = headerLine ? tryParseGenericHeader(headerLine) : null;

    const wrap = document.createElement('div');
    wrap.style.minWidth = '360px';
    wrap.style.maxWidth = '520px';

    const h = document.createElement('h3');
    h.style.marginTop = '0';
    h.style.color = 'var(--accent)';
    h.textContent = 'Manual RPA parse: ' + archiveName;
    wrap.appendChild(h);

    const intro = document.createElement('div');
    intro.className = 'cat-sub';
    intro.textContent = 'This archive could not be auto-parsed. Tip: run python rpatool.py -l on the file to inspect the header. For ZiX games, load the full game folder (including renpy/loader.rpy). Offset/key fields below are pre-filled when possible.';
    wrap.appendChild(intro);

    if (failureReason) {
      const reason = document.createElement('div');
      reason.style.fontSize = '12px';
      reason.style.color = 'var(--danger)';
      reason.style.margin = '10px 0';
      reason.style.wordBreak = 'break-word';
      reason.textContent = failureReason;
      wrap.appendChild(reason);
    }

    if (headerLine) {
      const hdr = document.createElement('div');
      hdr.style.fontSize = '12px';
      hdr.style.color = 'var(--text-dim)';
      hdr.style.margin = '10px 0';
      hdr.style.wordBreak = 'break-all';
      hdr.textContent = 'Header: ' + headerLine;
      wrap.appendChild(hdr);
    }

    const form = document.createElement('div');
    form.style.display = 'grid';
    form.style.gap = '10px';
    form.style.marginTop = '12px';

    const formatRow = document.createElement('label');
    formatRow.style.display = 'grid';
    formatRow.style.gap = '4px';
    formatRow.innerHTML = '<span style="font-size:12px;color:var(--text-dim)">Format</span>';
    const formatSel = document.createElement('select');
    formatSel.className = 'save-inp';
    [
      ['rpa-3.0', 'RPA-3.0 / RPA-4.0 (offset + XOR keys)'],
      ['rpa-2.0', 'RPA-2.0 (offset only, no XOR)'],
      ['rpa-3.2', 'RPA-3.2 (offset + multiple XOR keys from part 3+)'],
      ['alt-1.0', 'ALT-1.0 (key then offset)'],
    ].forEach(([v, label]) => {
      const opt = document.createElement('option');
      opt.value = v;
      opt.textContent = label;
      formatSel.appendChild(opt);
    });
    formatRow.appendChild(formatSel);
    form.appendChild(formatRow);

    function field(label, id, placeholder, value = '') {
      const row = document.createElement('label');
      row.style.display = 'grid';
      row.style.gap = '4px';
      row.innerHTML = '<span style="font-size:12px;color:var(--text-dim)">' + escapeHtml(label) + '</span>';
      const inp = document.createElement('input');
      inp.className = 'save-inp';
      inp.id = id;
      inp.placeholder = placeholder;
      inp.value = value;
      row.appendChild(inp);
      form.appendChild(row);
      return inp;
    }

    const offsetInp = field('Index offset (hex)', 'rpa-offset', 'e.g. 1234abcd or 0x1234abcd',
      generic ? '0x' + generic.offset.toString(16) : '');
    const keyInp = field('XOR key(s) (hex, space-separated)', 'rpa-keys', 'e.g. deadbeef or key1 key2 key3',
      generic?.key != null ? '0x' + (generic.key >>> 0).toString(16) : '');

    wrap.appendChild(form);

    const errEl = document.createElement('div');
    errEl.style.color = 'var(--danger)';
    errEl.style.fontSize = '12px';
    errEl.style.minHeight = '18px';
    wrap.appendChild(errEl);

    const actions = document.createElement('div');
    actions.style.display = 'flex';
    actions.style.gap = '8px';
    actions.style.marginTop = '14px';

    const tryBtn = document.createElement('button');
    tryBtn.textContent = 'Parse archive';
    const skipBtn = document.createElement('button');
    skipBtn.className = 'secondary';
    skipBtn.textContent = 'Skip';

    tryBtn.onclick = () => {
      errEl.textContent = '';
      try {
        const manual = parseManualRpaOptions({
          offsetHex: offsetInp.value,
          keyHex: keyInp.value,
          xorKeysHex: keyInp.value,
          format: formatSel.value,
        });
        closeModal();
        resolve(manual);
      } catch (err) {
        errEl.textContent = err.message;
      }
    };
    skipBtn.onclick = () => { closeModal(); resolve(null); };

    actions.appendChild(tryBtn);
    actions.appendChild(skipBtn);
    wrap.appendChild(actions);
    openModal(wrap);
  });
}

export function initModal() {
  document.getElementById('modal-close').onclick = closeModal;
  document.getElementById('modal-overlay').onclick = (e) => { if (e.target.id === 'modal-overlay') closeModal(); };
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { closeModal(); return; }
    if (!document.getElementById('modal-overlay').classList.contains('show')) return;
    if (e.key === 'ArrowLeft') navigateGallery(-1);
    else if (e.key === 'ArrowRight') navigateGallery(1);
  });
}