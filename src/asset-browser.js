import { store, lookupAssetUsages } from './state.js';
import { escapeHtml } from './utils.js';
import { getAssetKind, kindIcon, resolveAssetUrlCached, resolveVideoThumbnailCached, downloadFolderAsZip, downloadRpaArchiveAsZip, getEntryFileMeta, assetFolderHint } from './assets.js';
import { openAssetPreviewModal, openModal, closeModal } from './modal.js';
import { detectSequences, openAnimationPlayer } from './animation-player.js';

/** relPath of last plain click while selecting frames (Shift+click range anchor). */
let assetSelectionAnchor = null;

function imageEntriesFrom(entries) {
  return entries.filter(e => getAssetKind(e.relPath.split(/[\\/]/).pop().toLowerCase()) === 'image');
}

function handleFrameSelectClick(entry, event, selectableEntries) {
  const idx = selectableEntries.findIndex(e => e.relPath === entry.relPath);
  if (idx < 0) return;

  if (event.shiftKey && assetSelectionAnchor) {
    const anchorIdx = selectableEntries.findIndex(e => e.relPath === assetSelectionAnchor);
    if (anchorIdx >= 0) {
      const lo = Math.min(anchorIdx, idx);
      const hi = Math.max(anchorIdx, idx);
      store.assetSelectedPaths.clear();
      for (let i = lo; i <= hi; i++) {
        store.assetSelectedPaths.add(selectableEntries[i].relPath);
      }
    } else {
      store.assetSelectedPaths.clear();
      store.assetSelectedPaths.add(entry.relPath);
    }
  } else if (store.assetSelectedPaths.has(entry.relPath)) {
    store.assetSelectedPaths.delete(entry.relPath);
  } else {
    store.assetSelectedPaths.add(entry.relPath);
  }

  if (!event.shiftKey) {
    assetSelectionAnchor = entry.relPath;
  }
  renderAssetBrowserContent();
}

function sortEntries(entries) {
  const dir = store.assetSortDir === 'desc' ? -1 : 1;
  const sorted = entries.slice();
  sorted.sort((a, b) => {
    const am = getEntryFileMeta(a);
    const bm = getEntryFileMeta(b);
    if (store.assetSortBy === 'size') return ((am.size || 0) - (bm.size || 0)) * dir;
    if (store.assetSortBy === 'date') return ((am.lastModified || 0) - (bm.lastModified || 0)) * dir;
    const an = a.relPath.split(/[\\/]/).pop().toLowerCase();
    const bn = b.relPath.split(/[\\/]/).pop().toLowerCase();
    return an.localeCompare(bn) * dir;
  });
  return sorted;
}

function formatFileSize(bytes) {
  if (bytes === undefined || bytes === null) return '?';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

function formatFileDate(timestamp) {
  if (!timestamp) return '?';
  const d = new Date(timestamp);
  return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function buildFolderTree() {
  const root = { name: '(root)', path: '', children: {}, directFiles: [] };
  if (!store.fileIndex) return root;
  store.fileIndex.forEach(entry => {
    const parts = entry.relPath.split(/[\\/]/);
    const fname = parts[parts.length - 1];
    const folderParts = parts.slice(0, -1);
    let node = root;
    let pathSoFar = '';
    folderParts.forEach(part => {
      pathSoFar = pathSoFar ? pathSoFar + '/' + part : part;
      if (!node.children[part]) {
        node.children[part] = { name: part, path: pathSoFar, children: {}, directFiles: [] };
      }
      node = node.children[part];
    });
    node.directFiles.push(entry);
  });
  return root;
}

function collectAllFiles(node) {
  let files = node.directFiles.slice();
  Object.keys(node.children).forEach(k => { files = files.concat(collectAllFiles(node.children[k])); });
  return files;
}

function findNodeByPath(root, path) {
  if (!path) return root;
  let node = root;
  for (const part of path.split('/')) {
    if (!node.children[part]) return null;
    node = node.children[part];
  }
  return node;
}

function subtreeMatchesSearch(node, term) {
  if (node.path.toLowerCase().includes(term)) return true;
  if (node.directFiles?.some(f => f.relPath.toLowerCase().includes(term))) return true;
  return Object.keys(node.children).some(k => subtreeMatchesSearch(node.children[k], term));
}

function expandAncestorsOf(path) {
  const parts = String(path).split('/');
  let acc = '';
  parts.forEach(p => { acc = acc ? acc + '/' + p : p; store.assetExpandedFolders.add(acc); });
}

function renderArchiveListPanel(sb) {
  const archives = store.loadedRpaArchives || [];
  const failures = store.rpaLoadFailures || [];
  if (!archives.length && !failures.length) return;

  const sep = document.createElement('div');
  sep.className = 'sidebar-section-sep';
  sb.appendChild(sep);

  const label = document.createElement('div');
  label.className = 'sidebar-section-label';
  label.textContent = 'Loaded archives';
  sb.appendChild(label);

  archives.forEach(arch => {
    const row = document.createElement('div');
    row.className = 'archive-list-item';
    const title = document.createElement('div');
    title.className = 'archive-list-name';
    title.textContent = arch.name;
    const meta = document.createElement('div');
    meta.className = 'archive-list-meta';
    meta.textContent = `${arch.version || '?'} · ${arch.fileCount} files · ${arch.mediaFileCount ?? '?'} media`;
    row.appendChild(title);
    row.appendChild(meta);
    const btn = document.createElement('button');
    btn.className = 'archive-list-extract sub-btn';
    btn.textContent = '⬇ Extract';
    btn.title = `Extract all ${arch.fileCount} indexed files to ZIP`;
    btn.onclick = (e) => { e.stopPropagation(); downloadRpaArchiveAsZip(arch); };
    row.appendChild(btn);
    sb.appendChild(row);
  });

  failures.forEach(f => {
    const row = document.createElement('div');
    row.className = 'archive-list-item archive-list-failed';
    row.title = f.message || '';
    row.innerHTML =
      '<div class="archive-list-name">' + escapeHtml(f.name) + '</div>' +
      '<div class="archive-list-meta">' + escapeHtml(f.headerLine || 'parse failed') + '</div>' +
      '<div class="archive-list-err">' + escapeHtml((f.message || '').slice(0, 120)) + '</div>';
    sb.appendChild(row);
  });
}

export function renderAssetBrowserSidebar() {
  const sb = document.getElementById('sidebar');
  sb.innerHTML = '';
  if (!store.fileIndex) {
    sb.innerHTML = '<div style="padding:14px 18px;font-size:12px;color:var(--text-dim)">Load a game folder or use <b>Load Archive</b> for .rpa files only.</div>';
    return;
  }

  renderArchiveListPanel(sb);

  const tree = buildFolderTree();
  if (Object.keys(tree.children).length === 0) {
    const empty = document.createElement('div');
    empty.style.cssText = 'padding:14px 18px;font-size:12px;color:var(--text-dim)';
    empty.textContent = archivesOrFailuresNote()
      ? 'Archives loaded above — pick a folder to browse all indexed archive files.'
      : 'No files found in the loaded folder.';
    sb.appendChild(empty);
    return;
  }

  if (store.loadedRpaArchives?.length || store.rpaLoadFailures?.length) {
    const foldersLabel = document.createElement('div');
    foldersLabel.className = 'sidebar-section-label';
    foldersLabel.textContent = 'Media folders';
    sb.appendChild(foldersLabel);
  }

  const term = store.searchTerm ? store.searchTerm.toLowerCase() : '';
  renderTreeLevel(tree, sb, 0, term);
}

function archivesOrFailuresNote() {
  return (store.loadedRpaArchives?.length || 0) + (store.rpaLoadFailures?.length || 0) > 0;
}

function renderTreeLevel(node, container, depth, term) {
  Object.keys(node.children).sort().forEach(key => {
    const child = node.children[key];
    if (term && !subtreeMatchesSearch(child, term)) return;
    const totalCount = collectAllFiles(child).length;
    if (totalCount === 0) return;

    const hasChildren = Object.keys(child.children).length > 0;
    const expanded = store.assetExpandedFolders.has(child.path);

    const row = document.createElement('div');
    row.className = 'tree-row' + (hasChildren ? '' : ' tree-row-leaf');
    row.style.paddingLeft = (10 + depth * 16) + 'px';
    row.classList.toggle('active', store.selectedId === child.path);

    const arrow = document.createElement('span');
    arrow.className = hasChildren ? 'tree-arrow' : 'tree-arrow-spacer';
    if (hasChildren) {
      arrow.textContent = expanded ? '▼' : '▶';
      arrow.onclick = (e) => {
        e.stopPropagation();
        if (expanded) store.assetExpandedFolders.delete(child.path);
        else store.assetExpandedFolders.add(child.path);
        renderAssetBrowserSidebar();
      };
    }

    const counts = {};
    collectAllFiles(child).forEach(e => {
      const k = getAssetKind(e.relPath.split(/[\\/]/).pop().toLowerCase());
      counts[k] = (counts[k] || 0) + 1;
    });
    const kindSummary = Object.keys(counts).map(k => kindIcon(k)).join('');

    const label = document.createElement('span');
    label.className = 'tree-label';
    label.innerHTML = kindSummary + ' ' + escapeHtml(child.name);
    const count = document.createElement('span');
    count.className = 'ct';
    count.textContent = totalCount;

    row.appendChild(arrow);
    row.appendChild(label);
    row.appendChild(count);
    row.onclick = () => {
      store.selectedId = child.path;
      store.assetBrowserPageSize = 60;
      store.assetSelectedPaths.clear();
      assetSelectionAnchor = null;
      if (hasChildren) store.assetExpandedFolders.add(child.path);
      expandAncestorsOf(child.path);
      renderAssetBrowserSidebar();
      renderAssetBrowserContent();
    };
    container.appendChild(row);

    if (hasChildren && expanded) renderTreeLevel(child, container, depth + 1, term);
  });
}

export function renderAssetBrowserContent() {
  const content = document.getElementById('content');
  content.innerHTML = '';
  if (!store.fileIndex) {
    content.innerHTML = '<div class="empty-state">📂 <b>Load Game Folder</b> for a full game, or <b>Load Archive</b> for <code>.rpa</code> files only.<br><br>Auto-detects unpacked assets, archives, scripts, and saves — everything stays local in your browser.</div>';
    return;
  }
  if (store.selectedId === null) {
    content.innerHTML = '<div class="empty-state">Select a folder on the left. Click a parent folder (e.g. <code>images</code>) to see every file in it and all its subfolders combined.</div>';
    return;
  }
  const tree = buildFolderTree();
  const node = findNodeByPath(tree, store.selectedId);
  const entries = node ? collectAllFiles(node) : [];
  const title = document.createElement('div');
  title.className = 'cat-title';
  title.textContent = store.selectedId + ' (' + entries.length + ' files)';
  content.appendChild(title);

  let filtered = entries;
  if (store.searchTerm) {
    const term = store.searchTerm.toLowerCase();
    filtered = entries.filter(e => e.relPath.toLowerCase().includes(term));
  }
  filtered = sortEntries(filtered);

  const toolbar = document.createElement('div');
  toolbar.style.display = 'flex';
  toolbar.style.alignItems = 'center';
  toolbar.style.gap = '14px';
  toolbar.style.marginBottom = '14px';
  const gridBtn = document.createElement('button');
  gridBtn.className = 'sub-btn' + (store.assetViewMode === 'grid' ? ' active' : '');
  gridBtn.textContent = '⊞ Grid';
  gridBtn.onclick = () => { store.assetViewMode = 'grid'; renderAssetBrowserContent(); };
  const listBtn = document.createElement('button');
  listBtn.className = 'sub-btn' + (store.assetViewMode === 'list' ? ' active' : '');
  listBtn.textContent = '☰ List';
  listBtn.onclick = () => { store.assetViewMode = 'list'; renderAssetBrowserContent(); };
  toolbar.appendChild(gridBtn);
  toolbar.appendChild(listBtn);

  const sortLabel = document.createElement('span');
  sortLabel.style.fontSize = '12px';
  sortLabel.style.color = 'var(--text-dim)';
  sortLabel.textContent = 'Sort';
  const sortSelect = document.createElement('select');
  sortSelect.innerHTML = '<option value="name">Name</option><option value="size">Size</option><option value="date">Date</option>';
  sortSelect.value = store.assetSortBy;
  sortSelect.onchange = () => { store.assetSortBy = sortSelect.value; renderAssetBrowserContent(); };
  const sortDirBtn = document.createElement('button');
  sortDirBtn.className = 'secondary';
  sortDirBtn.textContent = store.assetSortDir === 'asc' ? '↑' : '↓';
  sortDirBtn.title = store.assetSortDir === 'asc' ? 'Ascending — click for descending' : 'Descending — click for ascending';
  sortDirBtn.onclick = () => { store.assetSortDir = store.assetSortDir === 'asc' ? 'desc' : 'asc'; renderAssetBrowserContent(); };
  toolbar.appendChild(sortLabel);
  toolbar.appendChild(sortSelect);
  toolbar.appendChild(sortDirBtn);

  let grid;
  if (store.assetViewMode === 'grid') {
    const sliderLabel = document.createElement('span');
    sliderLabel.style.fontSize = '12px';
    sliderLabel.style.color = 'var(--text-dim)';
    sliderLabel.textContent = 'Size';
    const slider = document.createElement('input');
    slider.type = 'range';
    slider.min = '80';
    slider.max = '280';
    slider.step = '10';
    slider.value = String(store.assetTileSize);
    slider.style.width = '140px';
    slider.oninput = () => {
      store.assetTileSize = parseInt(slider.value, 10);
      if (grid) grid.style.setProperty('--tile-size', store.assetTileSize + 'px');
    };
    toolbar.appendChild(sliderLabel);
    toolbar.appendChild(slider);
  }
  const spacer = document.createElement('div');
  spacer.style.flex = '1';
  toolbar.appendChild(spacer);

  const detectBtn = document.createElement('button');
  detectBtn.className = 'secondary';
  detectBtn.textContent = '🎬 Detect Sequences';
  detectBtn.title = 'Find groups of numbered frames (e.g. Explosion_01..Explosion_12) in this view';
  detectBtn.onclick = () => showSequencePicker(filtered.filter(e => getAssetKind(e.relPath.split(/[\\/]/).pop().toLowerCase()) === 'image'));
  toolbar.appendChild(detectBtn);

  const selectBtn = document.createElement('button');
  selectBtn.className = 'secondary';
  selectBtn.style.background = store.assetSelectMode ? 'var(--accent-dim)' : '';
  selectBtn.style.borderColor = store.assetSelectMode ? 'var(--accent)' : '';
  selectBtn.textContent = store.assetSelectMode ? '☑ Selecting frames…' : '☐ Select Frames';
  selectBtn.title = store.assetSelectMode
    ? 'Click frames to toggle · Shift+click another to select the range in between'
    : 'Select multiple image frames to play as animation';
  selectBtn.onclick = () => {
    store.assetSelectMode = !store.assetSelectMode;
    if (!store.assetSelectMode) {
      store.assetSelectedPaths.clear();
      assetSelectionAnchor = null;
    }
    renderAssetBrowserContent();
  };
  toolbar.appendChild(selectBtn);

  if (store.assetSelectMode) {
    const hint = document.createElement('span');
    hint.style.fontSize = '11px';
    hint.style.color = 'var(--text-dim)';
    hint.textContent = 'Shift+click to select a range';
    toolbar.appendChild(hint);
  }

  if (store.assetSelectMode && store.assetSelectedPaths.size >= 2) {
    const playBtn = document.createElement('button');
    playBtn.textContent = '▶ Play Selected (' + store.assetSelectedPaths.size + ')';
    playBtn.onclick = () => {
      const selected = filtered.filter(e => store.assetSelectedPaths.has(e.relPath));
      openAnimationPlayer(selected);
    };
    toolbar.appendChild(playBtn);
  }

  const downloadBtn = document.createElement('button');
  downloadBtn.className = 'secondary';
  downloadBtn.textContent = '⬇ Download all as ZIP (' + filtered.length + ')';
  downloadBtn.title = 'Bundle every file in this view into a downloadable .zip';
  downloadBtn.onclick = () => downloadFolderAsZip(store.selectedId.replace(/[\\/]/g, '_'), filtered);
  toolbar.appendChild(downloadBtn);
  content.appendChild(toolbar);

  const visible = filtered.slice(0, store.assetBrowserPageSize);
  const imageEntries = imageEntriesFrom(filtered);

  if (store.assetViewMode === 'grid') {
    grid = document.createElement('div');
    grid.className = 'asset-grid';
    grid.style.setProperty('--tile-size', store.assetTileSize + 'px');
    visible.forEach(entry => grid.appendChild(makeAssetTile(entry, imageEntries, imageEntries)));
    content.appendChild(grid);
  } else {
    visible.forEach(entry => content.appendChild(makeAssetListRow(entry, imageEntries, imageEntries)));
  }

  if (filtered.length > visible.length) {
    const btn = document.createElement('button');
    btn.className = 'load-more-btn';
    btn.textContent = 'Load ' + Math.min(60, filtered.length - visible.length) + ' more (' + (filtered.length - visible.length) + ' remaining)';
    btn.onclick = () => { store.assetBrowserPageSize += 60; renderAssetBrowserContent(); };
    content.appendChild(btn);
  }
}

function showSequencePicker(imageEntries) {
  const groups = detectSequences(imageEntries);
  const wrap = document.createElement('div');
  wrap.style.minWidth = '340px';
  wrap.style.maxWidth = '500px';
  const h = document.createElement('h3');
  h.style.marginTop = '0';
  h.style.color = 'var(--accent)';
  h.textContent = groups.length + ' sequence' + (groups.length === 1 ? '' : 's') + ' detected';
  wrap.appendChild(h);
  if (groups.length === 0) {
    const e = document.createElement('div');
    e.className = 'empty-state';
    e.style.padding = '10px';
    e.textContent = 'No numbered frame sequences found in this view (looking for names ending in a number, with 2+ files sharing the same prefix).';
    wrap.appendChild(e);
  }
  groups.forEach(g => {
    const card = document.createElement('div');
    card.className = 'ref-card';
    card.innerHTML = '<div class="title">' + escapeHtml(g.prefix || '(unnamed)') + '</div><div class="loc">' + g.entries.length + ' frames</div>';
    card.onclick = () => { closeModal(); openAnimationPlayer(g.entries); };
    wrap.appendChild(card);
  });
  openModal(wrap);
}

export function makeAssetTile(entry, imageGalleryEntries, selectableEntries = []) {
  const fname = entry.relPath.split(/[\\/]/).pop();
  const dot = fname.lastIndexOf('.');
  const baseName = dot >= 0 ? fname.slice(0, dot) : fname;
  const folder = assetFolderHint(entry);
  const kind = getAssetKind(fname.toLowerCase());
  const tile = document.createElement('div');
  tile.className = 'asset-tile';
  const thumbBox = document.createElement('div');
  thumbBox.className = 'thumb-box';
  const badge = document.createElement('span');
  badge.className = 'kind-badge';
  badge.textContent = kindIcon(kind);
  thumbBox.appendChild(badge);
  if (kind === 'image') {
    const img = document.createElement('img');
    img.alt = baseName;
    thumbBox.appendChild(img);
    resolveAssetUrlCached(entry).then(url => { img.src = url; }).catch(() => {
      thumbBox.innerHTML = '<span class="placeholder-icon">⚠</span>';
      thumbBox.appendChild(badge);
    });
  } else if (kind === 'video') {
    thumbBox.classList.add('video-thumb');
    const img = document.createElement('img');
    img.alt = baseName;
    thumbBox.appendChild(img);
    const icon = document.createElement('span');
    icon.className = 'video-play-badge';
    icon.textContent = '▶';
    thumbBox.appendChild(icon);
    resolveVideoThumbnailCached(entry).then(url => { img.src = url; }).catch(() => {
      img.remove();
      const fallback = document.createElement('span');
      fallback.className = 'placeholder-icon';
      fallback.textContent = kindIcon(kind);
      thumbBox.insertBefore(fallback, icon);
    });
  } else {
    const icon = document.createElement('span');
    icon.className = 'placeholder-icon';
    icon.textContent = kindIcon(kind);
    thumbBox.appendChild(icon);
  }
  if (store.assetSelectMode && kind === 'image') {
    const isSelected = store.assetSelectedPaths.has(entry.relPath);
    tile.classList.toggle('selected', isSelected);
    const checkbox = document.createElement('span');
    checkbox.className = 'select-checkbox' + (isSelected ? ' checked' : '');
    checkbox.textContent = isSelected ? '✓' : '';
    thumbBox.appendChild(checkbox);
  }
  tile.appendChild(thumbBox);
  const label = document.createElement('div');
  label.className = 'fname';
  label.textContent = baseName;
  tile.appendChild(label);
  const usages = lookupAssetUsages(folder, baseName);
  const usect = document.createElement('div');
  usect.className = 'usect' + (usages.length === 0 ? ' unused' : '');
  usect.textContent = usages.length > 0 ? ('used ' + usages.length + 'x') : (store.storyData ? 'not referenced' : 'usage lookup needs Story Browser');
  tile.appendChild(usect);
  if (store.assetSelectMode && kind === 'image') {
    tile.onclick = (e) => handleFrameSelectClick(entry, e, selectableEntries);
  } else if (kind === 'image' && imageGalleryEntries) {
    tile.onclick = () => openAssetPreviewModal(entry, folder, imageGalleryEntries, imageGalleryEntries.indexOf(entry));
  } else {
    tile.onclick = () => openAssetPreviewModal(entry, folder);
  }
  return tile;
}

export function makeAssetListRow(entry, imageGalleryEntries, selectableEntries = []) {
  const fname = entry.relPath.split(/[\\/]/).pop();
  const dot = fname.lastIndexOf('.');
  const baseName = dot >= 0 ? fname.slice(0, dot) : fname;
  const folder = assetFolderHint(entry);
  const kind = getAssetKind(fname.toLowerCase());
  const meta = getEntryFileMeta(entry);
  const row = document.createElement('div');
  row.className = 'asset-audio-row';
  if (store.assetSelectMode && kind === 'image') {
    const isSelected = store.assetSelectedPaths.has(entry.relPath);
    row.classList.toggle('selected', isSelected);
    const checkbox = document.createElement('span');
    checkbox.className = 'select-checkbox' + (isSelected ? ' checked' : '');
    checkbox.textContent = isSelected ? '✓' : '';
    row.appendChild(checkbox);
  }
  if (kind === 'video') {
    const mini = document.createElement('img');
    mini.className = 'list-video-thumb';
    mini.alt = '';
    row.appendChild(mini);
    resolveVideoThumbnailCached(entry).then(url => { mini.src = url; }).catch(() => { mini.remove(); });
  }
  const label = document.createElement('span');
  label.className = 'fname';
  label.textContent = kindIcon(kind) + ' ' + baseName;
  const metaEl = document.createElement('span');
  metaEl.className = 'fmeta';
  metaEl.textContent = formatFileSize(meta.size) + '  ·  ' + formatFileDate(meta.lastModified);
  const usages = lookupAssetUsages(folder, baseName);
  const usect = document.createElement('span');
  usect.className = 'usect' + (usages.length === 0 ? ' unused' : '');
  usect.textContent = usages.length > 0 ? ('used ' + usages.length + 'x') : (store.storyData ? 'not referenced' : '—');
  row.appendChild(label);
  row.appendChild(metaEl);
  row.appendChild(usect);
  if (store.assetSelectMode && kind === 'image') {
    row.onclick = (e) => handleFrameSelectClick(entry, e, selectableEntries);
  } else if (kind === 'image' && imageGalleryEntries) {
    row.onclick = () => openAssetPreviewModal(entry, folder, imageGalleryEntries, imageGalleryEntries.indexOf(entry));
  } else {
    row.onclick = () => openAssetPreviewModal(entry, folder);
  }
  return row;
}