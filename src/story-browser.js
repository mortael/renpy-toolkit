import { store } from './state.js';
import { escapeHtml } from './utils.js';
import { resolveAssetUrlCached, resolveMediaAsset, getAssetKind } from './assets.js';
import { getCurrentVariableValue, conditionStatusBadge } from './live-status.js';
import { openAssetPreviewModal } from './modal.js';
import { renderAll } from './main.js';

export const storyTabs = [
  { id: 'variables', label: 'Variables Index' },
  { id: 'labels', label: 'Browse by Label' },
  { id: 'files', label: 'Script Files' },
  { id: 'media', label: 'Media refs' },
  { id: 'characters', label: 'Characters' },
  { id: 'dialogue', label: 'Search Dialogue' },
];

const DIALOGUE_PAGE = 80;
let dialoguePage = 0;

export function jumpToLabel(labelName) {
  const entry = store.storyData?.labelBrowse?.[labelName];
  if (!entry) return;
  store.mode = 'story';
  store.activeTab = 'labels';
  store.selectedId = entry.scriptId;
  store.searchTerm = '';
  document.getElementById('search').value = '';
  renderAll();
}

export function renderMediaPreview(lineEntry, container) {
  const wrap = document.createElement('div');
  wrap.className = 'media-line';
  const line = document.createElement('div');
  line.className = 'script-line';
  line.textContent = lineEntry.text;
  wrap.appendChild(line);
  const previewBox = document.createElement('div');
  previewBox.className = 'media-preview';
  wrap.appendChild(previewBox);
  if (!store.fileIndex) {
    const hint = document.createElement('div');
    hint.className = 'media-missing';
    hint.textContent = '(load the game folder above to preview this)';
    previewBox.appendChild(hint);
  } else {
    const entry = resolveMediaAsset(lineEntry.mediaName, lineEntry.mediaFolder, lineEntry.mediaPath);
    if (!entry) {
      const hint = document.createElement('div');
      hint.className = 'media-missing';
      hint.textContent = '(file "' + (lineEntry.mediaName || '?') + '" not found in loaded folder)';
      previewBox.appendChild(hint);
    } else {
      const hint = document.createElement('div');
      hint.className = 'media-missing';
      hint.textContent = 'Loading preview…';
      previewBox.appendChild(hint);
      resolveAssetUrlCached(entry).then(url => {
        previewBox.innerHTML = '';
        const kind = lineEntry.mediaType === 'audio'
          ? 'audio'
          : getAssetKind(entry.relPath.split(/[\\/]/).pop().toLowerCase());
        if (kind === 'image') {
          const img = document.createElement('img');
          img.src = url;
          img.alt = lineEntry.mediaName;
          img.title = 'Click for full size';
          img.onclick = () => openAssetPreviewModal(entry, lineEntry.mediaFolder);
          previewBox.appendChild(img);
        } else if (kind === 'video') {
          const video = document.createElement('video');
          video.controls = true;
          video.playsInline = true;
          video.src = url;
          previewBox.appendChild(video);
        } else {
          const audio = document.createElement('audio');
          audio.controls = true;
          audio.src = url;
          previewBox.appendChild(audio);
        }
      }).catch(err => {
        previewBox.innerHTML = '';
        const h = document.createElement('div');
        h.className = 'media-missing';
        h.textContent = '(could not load: ' + err.message + ')';
        previewBox.appendChild(h);
      });
    }
  }
  container.appendChild(wrap);
}

export function renderScript(scriptId, container) {
  const s = store.storyData.scripts[scriptId];
  if (!s) return;
  const block = document.createElement('div');
  block.className = 'script-block';
  const h = document.createElement('h3');
  h.textContent = s.title;
  const loc = document.createElement('div');
  loc.className = 'loc';
  loc.textContent = s.location;
  block.appendChild(h);
  block.appendChild(loc);
  if (s.lines.length === 0) {
    const e = document.createElement('div');
    e.className = 'empty-state';
    e.style.padding = '10px';
    e.textContent = '(no readable content in this label)';
    block.appendChild(e);
  } else {
    s.lines.forEach(entry => {
      if (entry.type === 'media') {
        renderMediaPreview(entry, block);
      } else if (entry.type === 'transfer') {
        const d = document.createElement('div');
        d.className = 'script-line transfer-line';
        d.textContent = entry.text;
        d.title = 'Click to jump to label';
        d.onclick = () => jumpToLabel(entry.target);
        block.appendChild(d);
      } else if (entry.type === 'condition') {
        const d = document.createElement('div');
        d.className = 'script-line';
        d.style.display = 'flex';
        d.style.alignItems = 'center';
        const txt = document.createElement('span');
        txt.textContent = entry.text;
        d.appendChild(txt);
        d.appendChild(conditionStatusBadge(entry.condition));
        block.appendChild(d);
      } else if (entry.type === 'dialogue') {
        const d = document.createElement('div');
        d.className = 'script-line';
        d.style.color = 'var(--text)';
        d.textContent = entry.text;
        block.appendChild(d);
      } else {
        const d = document.createElement('div');
        d.className = 'script-line';
        d.textContent = entry.text;
        block.appendChild(d);
      }
    });
  }
  container.appendChild(block);
}

export function showScriptReplacingContent(scriptId) {
  const content = document.getElementById('content');
  content.innerHTML = '';
  const back = document.createElement('button');
  back.className = 'back-btn';
  back.textContent = '← Back to overview';
  back.onclick = () => renderStoryContent();
  content.appendChild(back);
  renderScript(scriptId, content);
}

function makeRefCard(ref, kind) {
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
  card.onclick = () => showScriptReplacingContent(ref.scriptId);
  return card;
}

export function renderVarSidebar() {
  const sb = document.getElementById('sidebar');
  sb.innerHTML = '';
  const names = store.storyData.varNames || [];
  if (names.length === 0) {
    sb.innerHTML = '<div style="padding:14px 18px;font-size:12px;color:var(--text-dim)">No variables found via script scan.</div>';
    return;
  }
  names.forEach(name => {
    if (store.searchTerm && !name.toLowerCase().includes(store.searchTerm)) return;
    const entry = store.storyData.varIndex[name] || { setters: [], checkers: [] };
    const div = document.createElement('div');
    div.className = 'name-list-item';
    div.style.background = store.selectedId === name ? 'var(--panel2)' : '';
    let dot = '';
    if (store.saveData) {
      const v = getCurrentVariableValue(name);
      dot = '<span style="margin-right:6px;color:var(--accent);font-size:10px;">' + (v !== undefined ? escapeHtml(String(v)) : '?') + '</span>';
    }
    div.innerHTML = '<span class="nm">' + dot + escapeHtml(name) + '</span><span class="ct">' + entry.setters.length + ' set · ' + entry.checkers.length + ' check</span>';
    div.onclick = () => {
      store.selectedId = name;
      renderStoryContent();
      document.querySelectorAll('.name-list-item').forEach(x => { x.style.background = ''; });
      div.style.background = 'var(--panel2)';
    };
    sb.appendChild(div);
  });
}

export function renderVarDetail() {
  const content = document.getElementById('content');
  content.innerHTML = '';
  if (store.selectedId === null) {
    content.innerHTML = '<div class="empty-state">Select a variable on the left.</div>';
    return;
  }
  const name = store.selectedId;
  const title = document.createElement('div');
  title.className = 'cat-title';
  title.style.display = 'flex';
  title.style.alignItems = 'center';
  const titleTxt = document.createElement('span');
  titleTxt.textContent = name;
  title.appendChild(titleTxt);
  const curBadge = document.createElement('span');
  curBadge.style.marginLeft = '12px';
  curBadge.style.fontSize = '12px';
  curBadge.style.padding = '2px 9px';
  curBadge.style.borderRadius = '8px';
  if (!store.saveData) {
    curBadge.textContent = 'load a .save to see current value';
    curBadge.style.background = 'var(--panel2)';
    curBadge.style.color = 'var(--text-dim)';
  } else {
    const val = getCurrentVariableValue(name);
    curBadge.textContent = 'Current: ' + (val !== undefined ? val : '?');
    curBadge.style.background = 'var(--panel2)';
    curBadge.style.color = 'var(--accent)';
  }
  title.appendChild(curBadge);
  content.appendChild(title);

  const note = document.createElement('div');
  note.className = 'cat-sub';
  note.textContent = 'Cross-reference includes default, $, and python: assignments. Complex Python may still be missed.';
  content.appendChild(note);

  const entry = store.storyData.varIndex[name] || { setters: [], checkers: [] };
  const setH = document.createElement('div');
  setH.style.fontSize = '13px';
  setH.style.color = 'var(--text-dim)';
  setH.style.margin = '14px 0 8px';
  setH.textContent = 'SET by (' + entry.setters.length + ')';
  content.appendChild(setH);
  if (entry.setters.length === 0) {
    const e = document.createElement('div');
    e.className = 'empty-state';
    e.style.padding = '10px';
    e.textContent = '(no direct assignments found)';
    content.appendChild(e);
  } else {
    entry.setters.forEach(ref => content.appendChild(makeRefCard(ref, 'set')));
  }

  const chkH = document.createElement('div');
  chkH.style.fontSize = '13px';
  chkH.style.color = 'var(--text-dim)';
  chkH.style.margin = '18px 0 8px';
  chkH.textContent = 'CHECKED by (' + entry.checkers.length + ')';
  content.appendChild(chkH);
  if (entry.checkers.length === 0) {
    const e = document.createElement('div');
    e.className = 'empty-state';
    e.style.padding = '10px';
    e.textContent = '(no if/elif references found)';
    content.appendChild(e);
  } else {
    entry.checkers.forEach(ref => content.appendChild(makeRefCard(ref, 'check')));
  }
}

export function renderLabelSidebar() {
  const sb = document.getElementById('sidebar');
  sb.innerHTML = '';
  const scripts = (store.storyData.scripts || []).filter(s => !s.isDefinitionsOnly);
  scripts.forEach(s => {
    const display = s.title;
    if (store.searchTerm && !display.toLowerCase().includes(store.searchTerm) && !s.file.toLowerCase().includes(store.searchTerm)) return;
    const div = document.createElement('div');
    div.className = 'name-list-item';
    div.style.background = store.selectedId === s.id ? 'var(--panel2)' : '';
    div.innerHTML = '<span class="nm">' + escapeHtml(display) + '</span><span class="ct">' + s.lines.length + '</span>';
    div.onclick = () => {
      store.selectedId = s.id;
      renderStoryContent();
      document.querySelectorAll('.name-list-item').forEach(x => { x.style.background = ''; });
      div.style.background = 'var(--panel2)';
    };
    sb.appendChild(div);
  });
}

function makeLabelRefCard(ref) {
  const card = document.createElement('div');
  card.className = 'ref-card';
  const tag = document.createElement('span');
  tag.className = 'tag tag-check';
  tag.textContent = (ref.kind || 'jump').toUpperCase();
  const titleSpan = document.createElement('span');
  titleSpan.className = 'title';
  titleSpan.textContent = ref.fromLabel || ref.eventName || 'script';
  card.appendChild(tag);
  card.appendChild(titleSpan);
  const loc = document.createElement('div');
  loc.className = 'loc';
  loc.textContent = (ref.file || '') + (ref.line ? ' — line ' + ref.line : '');
  card.appendChild(loc);
  card.onclick = () => {
    if (ref.scriptId != null) showScriptReplacingContent(ref.scriptId);
  };
  return card;
}

export function renderLabelDetail() {
  const content = document.getElementById('content');
  content.innerHTML = '';
  if (store.selectedId === null) {
    content.innerHTML = '<div class="empty-state">Select a label on the left.</div>';
    return;
  }
  const script = store.storyData.scripts[store.selectedId];
  if (script) {
    const incoming = store.storyData.labelRefs?.[script.label] || [];
    const outgoing = (script.lines || []).filter(l => l.type === 'transfer');

    if (incoming.length || outgoing.length) {
      const flow = document.createElement('div');
      flow.className = 'label-flow-panel';
      if (incoming.length) {
        const h = document.createElement('div');
        h.className = 'cat-sub';
        h.textContent = 'Called from (' + incoming.length + ')';
        flow.appendChild(h);
        incoming.forEach(ref => flow.appendChild(makeLabelRefCard(ref)));
      }
      if (outgoing.length) {
        const h = document.createElement('div');
        h.className = 'cat-sub';
        h.style.marginTop = incoming.length ? '14px' : '0';
        h.textContent = 'Jumps / calls (' + outgoing.length + ')';
        flow.appendChild(h);
        outgoing.forEach(line => {
          const card = document.createElement('div');
          card.className = 'ref-card';
          card.innerHTML =
            '<span class="tag tag-set">' + escapeHtml((line.text || '').includes('CALL') ? 'CALL' : 'JUMP') + '</span> ' +
            '<span class="title">' + escapeHtml(line.target || '?') + '</span>';
          card.onclick = () => jumpToLabel(line.target);
          flow.appendChild(card);
        });
      }
      content.appendChild(flow);
    }
  }
  renderScript(store.selectedId, content);
}

function collectDialogueForSpeaker(charId) {
  const matches = [];
  (store.storyData.scripts || []).forEach(s => {
    s.lines.forEach((line, idx) => {
      if (line.type === 'dialogue' && line.speaker === charId) {
        matches.push({ script: s, line, lineIdx: idx });
      }
    });
  });
  return matches;
}

export function renderCharactersSidebar() {
  const sb = document.getElementById('sidebar');
  sb.innerHTML = '';
  const chars = Object.values(store.storyData.characters || {});
  if (!chars.length) {
    sb.innerHTML = '<div style="padding:14px 18px;font-size:12px;color:var(--text-dim)">No <code>define X = Character(...)</code> found in scripts.</div>';
    return;
  }
  chars
    .sort((a, b) => (a.displayName || a.id).localeCompare(b.displayName || b.id))
    .forEach(ch => {
      if (store.searchTerm && !(ch.displayName || '').toLowerCase().includes(store.searchTerm) &&
          !ch.id.toLowerCase().includes(store.searchTerm)) return;
      const count = collectDialogueForSpeaker(ch.id).length;
      const div = document.createElement('div');
      div.className = 'name-list-item';
      div.style.background = store.selectedId === ch.id ? 'var(--panel2)' : '';
      div.innerHTML =
        '<span class="nm">' + escapeHtml(ch.displayName || ch.id) + '</span>' +
        '<span class="ct">' + ch.id + ' · ' + count + ' lines</span>';
      div.onclick = () => {
        store.selectedId = ch.id;
        renderStoryContent();
        document.querySelectorAll('.name-list-item').forEach(x => { x.style.background = ''; });
        div.style.background = 'var(--panel2)';
      };
      sb.appendChild(div);
    });
}

export function renderCharactersDetail() {
  const content = document.getElementById('content');
  content.innerHTML = '';
  if (store.selectedId === null) {
    content.innerHTML = '<div class="empty-state">Select a character on the left.</div>';
    return;
  }
  const ch = store.storyData.characters?.[store.selectedId];
  if (!ch) {
    content.innerHTML = '<div class="empty-state">Character not found.</div>';
    return;
  }
  const title = document.createElement('div');
  title.className = 'cat-title';
  title.textContent = (ch.displayName || ch.id) + ' (' + ch.id + ')';
  content.appendChild(title);
  const sub = document.createElement('div');
  sub.className = 'cat-sub';
  sub.textContent = (ch.file || '') + (ch.line ? ' — define line ' + ch.line : '');
  content.appendChild(sub);

  const lines = collectDialogueForSpeaker(ch.id);
  if (!lines.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = 'No dialogue lines found for this speaker id.';
    content.appendChild(empty);
    return;
  }
  lines.forEach(({ script, line }) => {
    const card = document.createElement('div');
    card.className = 'ref-card';
    card.innerHTML =
      '<div class="title">' + escapeHtml(script.title) + '</div>' +
      '<div class="loc">' + escapeHtml(script.location) + '</div>' +
      '<div style="font-size:12px;margin-top:6px;color:var(--text)">' + escapeHtml(line.text) + '</div>';
    card.onclick = () => showScriptReplacingContent(script.id);
    content.appendChild(card);
  });
}

function listMediaKeys() {
  const idx = store.storyData.assetIndex || {};
  const rows = [];
  Object.entries(idx).forEach(([folder, entries]) => {
    Object.entries(entries).forEach(([key, meta]) => {
      rows.push({ folder, key, name: meta.name, count: meta.usages?.length || 0 });
    });
  });
  rows.sort((a, b) => a.folder.localeCompare(b.folder) || a.key.localeCompare(b.key));
  return rows;
}

export function renderMediaSidebar() {
  const sb = document.getElementById('sidebar');
  sb.innerHTML = '';
  const rows = listMediaKeys();
  if (!rows.length) {
    sb.innerHTML = '<div style="padding:14px 18px;font-size:12px;color:var(--text-dim)">No show/scene/play references found.</div>';
    return;
  }
  rows.forEach(row => {
    const id = row.folder + '/' + row.key;
    if (store.searchTerm && !id.toLowerCase().includes(store.searchTerm) &&
        !row.name.toLowerCase().includes(store.searchTerm)) return;
    const div = document.createElement('div');
    div.className = 'name-list-item';
    div.style.background = store.selectedId === id ? 'var(--panel2)' : '';
    div.innerHTML =
      '<span class="nm">' + escapeHtml(row.name) + '</span>' +
      '<span class="ct">' + row.folder + ' · ' + row.count + ' ref' + (row.count !== 1 ? 's' : '') + '</span>';
    div.onclick = () => {
      store.selectedId = id;
      renderStoryContent();
      document.querySelectorAll('.name-list-item').forEach(x => { x.style.background = ''; });
      div.style.background = 'var(--panel2)';
    };
    sb.appendChild(div);
  });
}

export function renderMediaDetail() {
  const content = document.getElementById('content');
  content.innerHTML = '';
  if (store.selectedId === null) {
    content.innerHTML = '<div class="empty-state">Select a media asset on the left.</div>';
    return;
  }
  const parts = String(store.selectedId).split('/');
  const folder = parts[0];
  const key = parts.slice(1).join('/');
  const entry = store.storyData.assetIndex?.[folder]?.[key];
  if (!entry) {
    content.innerHTML = '<div class="empty-state">Asset entry not found.</div>';
    return;
  }
  const title = document.createElement('div');
  title.className = 'cat-title';
  title.textContent = entry.name + ' (' + folder + ')';
  content.appendChild(title);
  const sub = document.createElement('div');
  sub.className = 'cat-sub';
  sub.textContent = (entry.usages?.length || 0) + ' script reference(s)';
  content.appendChild(sub);

  (entry.usages || []).forEach(usage => {
    const card = document.createElement('div');
    card.className = 'ref-card';
    card.innerHTML =
      '<div class="title">' + escapeHtml(usage.label || '?') + '</div>' +
      '<div class="loc">' + escapeHtml(usage.file || '') + ' — line ' + (usage.line || '?') +
      (usage.path ? ' · ' + escapeHtml(usage.path) : '') + '</div>';
    card.onclick = () => {
      if (usage.scriptId != null) showScriptReplacingContent(usage.scriptId);
    };
    content.appendChild(card);
  });
}

function buildScriptFolderTree() {
  const root = { name: '(root)', path: '', children: {}, directFiles: [] };
  (store.storyData.files || []).forEach((f, fileIndex) => {
    const parts = f.path.split('/');
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
    node.directFiles.push({ ...f, fileIndex });
  });
  return root;
}

function collectAllScriptFiles(node) {
  let files = node.directFiles.slice();
  Object.keys(node.children).forEach(k => {
    files = files.concat(collectAllScriptFiles(node.children[k]));
  });
  return files;
}

function scriptFolderKey(folderNode) {
  return folderNode.path || '__root__';
}

function scriptSubtreeMatchesSearch(node, term) {
  if (node.path.toLowerCase().includes(term)) return true;
  if (node.directFiles.some(f => f.path.toLowerCase().includes(term))) return true;
  return Object.keys(node.children).some(k => scriptSubtreeMatchesSearch(node.children[k], term));
}

function expandStoryAncestorsOf(folderKey) {
  if (folderKey === '__root__') return;
  const parts = String(folderKey).split('/');
  let acc = '';
  parts.forEach(p => { acc = acc ? acc + '/' + p : p; store.storyExpandedFolders.add(acc); });
}

function toggleScriptFolder(folderKey) {
  if (store.storyExpandedFolders.has(folderKey)) store.storyExpandedFolders.delete(folderKey);
  else {
    store.storyExpandedFolders.add(folderKey);
    expandStoryAncestorsOf(folderKey);
  }
  renderFilesSidebar();
}

function renderScriptFileRow(file, container, depth, term) {
  if (term && !file.path.toLowerCase().includes(term)) return;
  const fname = file.path.split('/').pop();
  const row = document.createElement('div');
  row.className = 'tree-row tree-row-file tree-row-leaf';
  row.style.paddingLeft = (10 + depth * 16) + 'px';
  row.classList.toggle('active', store.selectedId === file.path);

  const spacer = document.createElement('span');
  spacer.className = 'tree-arrow-spacer';
  const label = document.createElement('span');
  label.className = 'tree-label';
  label.textContent = fname;
  const count = document.createElement('span');
  count.className = 'ct';
  count.textContent = String(file.labelCount);

  row.appendChild(spacer);
  row.appendChild(label);
  row.appendChild(count);
  row.onclick = () => {
    store.selectedId = file.path;
    renderFilesSidebar();
    renderFilesDetail();
  };
  container.appendChild(row);
}

function renderScriptFolderRow(folderNode, displayName, container, depth, term) {
  const hasSubfolders = Object.keys(folderNode.children).length > 0;
  const hasFiles = folderNode.directFiles.length > 0;
  if (!hasSubfolders && !hasFiles) return;
  if (term && !scriptSubtreeMatchesSearch(folderNode, term)) return;

  const folderKey = scriptFolderKey(folderNode);
  const canExpand = hasSubfolders || hasFiles;
  const expanded = store.storyExpandedFolders.has(folderKey);
  const fileCount = collectAllScriptFiles(folderNode).length;
  const labelCount = collectAllScriptFiles(folderNode).reduce((sum, f) => sum + f.labelCount, 0);

  const row = document.createElement('div');
  row.className = 'tree-row tree-row-folder';
  row.style.paddingLeft = (10 + depth * 16) + 'px';

  const arrow = document.createElement('span');
  arrow.className = canExpand ? 'tree-arrow' : 'tree-arrow-spacer';
  if (canExpand) {
    arrow.textContent = expanded ? '▼' : '▶';
    const toggle = (e) => {
      e.stopPropagation();
      toggleScriptFolder(folderKey);
    };
    arrow.onclick = toggle;
    row.onclick = toggle;
  }

  const label = document.createElement('span');
  label.className = 'tree-label';
  label.textContent = displayName;
  const count = document.createElement('span');
  count.className = 'ct';
  count.textContent = fileCount + ' · ' + labelCount;

  row.appendChild(arrow);
  row.appendChild(label);
  row.appendChild(count);
  container.appendChild(row);

  if (canExpand && expanded) {
    Object.keys(folderNode.children).sort().forEach(key => {
      renderScriptFolderRow(folderNode.children[key], folderNode.children[key].name, container, depth + 1, term);
    });
    folderNode.directFiles
      .slice()
      .sort((a, b) => a.path.localeCompare(b.path))
      .forEach(f => renderScriptFileRow(f, container, depth + 1, term));
  }
}

function renderScriptTreeLevel(node, container, depth, term) {
  if (depth === 0 && node.directFiles.length > 0) {
    renderScriptFolderRow(node, '(root)', container, depth, term);
  }
  Object.keys(node.children).sort().forEach(key => {
    renderScriptFolderRow(node.children[key], node.children[key].name, container, depth, term);
  });
}

export function renderFilesSidebar() {
  const sb = document.getElementById('sidebar');
  sb.innerHTML = '';
  const tree = buildScriptFolderTree();
  if (Object.keys(tree.children).length === 0 && tree.directFiles.length === 0) {
    sb.innerHTML = '<div style="padding:14px 18px;font-size:12px;color:var(--text-dim)">No .rpy script files found.</div>';
    return;
  }
  const term = store.searchTerm ? store.searchTerm.toLowerCase() : '';
  renderScriptTreeLevel(tree, sb, 0, term);
}

export function renderFilesDetail() {
  const content = document.getElementById('content');
  content.innerHTML = '';
  if (store.selectedId === null) {
    content.innerHTML = '<div class="empty-state">Expand a folder on the left, then select a <code>.rpy</code> file to view its labels and script lines.</div>';
    return;
  }
  const file = (store.storyData.files || []).find(f => f.path === store.selectedId);
  if (!file) {
    content.innerHTML = '<div class="empty-state">Select a <code>.rpy</code> file on the left — clicking a folder only expands it.</div>';
    return;
  }

  const title = document.createElement('div');
  title.className = 'cat-title';
  title.textContent = file.path + ' (' + file.labelCount + ' label' + (file.labelCount !== 1 ? 's' : '') + ')';
  content.appendChild(title);

  const scripts = store.storyData.scripts.filter(s => s.file === file.path);
  scripts.forEach(s => renderScript(s.id, content));
}

export function renderSearchResults() {
  const content = document.getElementById('content');
  content.innerHTML = '';
  const term = store.searchTerm.toLowerCase();
  const speakerFilter = term.startsWith('speaker:') ? term.slice(8).trim() : null;
  const textTerm = speakerFilter ? '' : term;

  const title = document.createElement('div');
  title.className = 'cat-title';
  title.textContent = speakerFilter
    ? 'Dialogue by speaker "' + escapeHtml(speakerFilter) + '"'
    : 'Search results for "' + escapeHtml(store.searchTerm) + '"';
  content.appendChild(title);

  const matches = [];
  store.storyData.scripts.forEach(s => {
    const matchingLines = s.lines.filter(l => {
      if (!l.text) return false;
      if (speakerFilter) {
        return l.type === 'dialogue' && l.speaker === speakerFilter;
      }
      if (textTerm && !l.text.toLowerCase().includes(textTerm)) return false;
      return true;
    });
    if (matchingLines.length > 0) matches.push({ s, matchingLines });
  });

  const totalLabels = matches.length;
  const pageCount = Math.max(1, Math.ceil(totalLabels / DIALOGUE_PAGE));
  if (dialoguePage >= pageCount) dialoguePage = pageCount - 1;
  const pageSlice = matches.slice(dialoguePage * DIALOGUE_PAGE, (dialoguePage + 1) * DIALOGUE_PAGE);

  const sub = document.createElement('div');
  sub.className = 'cat-sub';
  sub.textContent = totalLabels + ' label' + (totalLabels !== 1 ? 's' : '') + ' with matches' +
    (pageCount > 1 ? ' · page ' + (dialoguePage + 1) + '/' + pageCount : '') +
    (speakerFilter ? '' : ' · tip: speaker:j filters by character id');
  content.appendChild(sub);

  if (pageCount > 1) {
    const bar = document.createElement('div');
    bar.className = 'save-pagebar';
    if (dialoguePage > 0) {
      const prev = document.createElement('button');
      prev.className = 'sub-btn';
      prev.textContent = '‹ prev';
      prev.onclick = () => { dialoguePage--; renderSearchResults(); };
      bar.appendChild(prev);
    }
    if (dialoguePage < pageCount - 1) {
      const next = document.createElement('button');
      next.className = 'sub-btn';
      next.textContent = 'next ›';
      next.onclick = () => { dialoguePage++; renderSearchResults(); };
      bar.appendChild(next);
    }
    content.appendChild(bar);
  }

  pageSlice.forEach(({ s, matchingLines }) => {
    const card = document.createElement('div');
    card.className = 'ref-card';
    const t = document.createElement('div');
    t.className = 'title';
    t.textContent = s.title;
    const loc = document.createElement('div');
    loc.className = 'loc';
    loc.textContent = s.location;
    card.appendChild(t);
    card.appendChild(loc);
    matchingLines.slice(0, 5).forEach(l => {
      const ml = document.createElement('div');
      ml.style.fontSize = '12px';
      ml.style.color = l.type === 'dialogue' ? 'var(--text)' : 'var(--text-dim)';
      ml.style.marginTop = '4px';
      if (l.speaker) {
        const sp = document.createElement('span');
        sp.style.color = 'var(--accent)';
        sp.textContent = l.speaker + ': ';
        ml.appendChild(sp);
      }
      ml.appendChild(document.createTextNode(l.text));
      card.appendChild(ml);
    });
    card.onclick = () => showScriptReplacingContent(s.id);
    content.appendChild(card);
  });
}

export function renderStorySidebar() {
  const sb = document.getElementById('sidebar');
  if (!store.storyData) {
    sb.innerHTML = '<div style="padding:14px 18px;font-size:12px;color:var(--text-dim)">Load a game folder with .rpy files to browse the story.</div>';
    return;
  }
  if (store.activeTab === 'variables') renderVarSidebar();
  else if (store.activeTab === 'labels') renderLabelSidebar();
  else if (store.activeTab === 'files') renderFilesSidebar();
  else if (store.activeTab === 'media') renderMediaSidebar();
  else if (store.activeTab === 'characters') renderCharactersSidebar();
  else if (store.activeTab === 'dialogue') {
    sb.innerHTML = '<div style="padding:14px 18px;font-size:12px;color:var(--text-dim)">Type at least 3 characters to search dialogue and script lines.<br><br>Use <code>speaker:j</code> to filter by character id (e.g. <code>speaker:j</code> for Joseph).</div>';
  }
}

export function renderStoryContent() {
  const content = document.getElementById('content');
  if (!store.storyData) {
    content.innerHTML = '<div class="empty-state">📂 Load a Ren\'Py <b>game</b> folder containing <code>.rpy</code> script files.<br><br>Variable cross-references are regex-based and may miss dynamically constructed names — see the Variables Index tab for details.</div>';
    return;
  }
  if (store.activeTab === 'variables') renderVarDetail();
  else if (store.activeTab === 'labels') renderLabelDetail();
  else if (store.activeTab === 'files') renderFilesDetail();
  else if (store.activeTab === 'media') renderMediaDetail();
  else if (store.activeTab === 'characters') renderCharactersDetail();
  else if (store.activeTab === 'dialogue') {
    const speakerQ = store.searchTerm.toLowerCase().startsWith('speaker:');
    if (store.searchTerm.length >= 3 || speakerQ) {
      if (speakerQ) dialoguePage = 0;
      renderSearchResults();
    } else {
      content.innerHTML = '<div class="empty-state">Type at least 3 characters to search all dialogue and script lines.<br><br>Or use <code>speaker:character_id</code> (e.g. <code>speaker:j</code>).</div>';
    }
  }
}