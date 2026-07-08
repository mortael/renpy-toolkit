import { store, isSessionLoaded } from './state.js';
import { showToast, setLoading, setDirty, updateUnloadButton } from './utils.js';
import { buildFileIndex, clearAssetUrlCache, getAssetKind } from './assets.js';
import {
  parseRpaArchiveFromFile,
  parseRpaArchiveAsyncFromFile,
  parseRpa10PairFromFiles,
  readHeaderFromFile,
  readRpaFile,
  listMediaFromIndex,
  listAllPathsFromIndex,
  RpaParseError,
  findRpa10Pair,
  isKnownRpaHeader,
} from './rpa.js';
import { openRpaManualModal } from './modal.js';
import { parseGameDataFromFolder } from './script-parser.js';
import { loadSaveFromEntry, resetSaveEditorState } from './save-editor.js';
import { isPersistentSave, refreshSaveEntries } from './saves.js';
import { initPyodide, pyDecompileRpyc } from './pyodide-runtime.js';
import { recordRecentSession } from './recent-sessions.js';
import { renderAll } from './main.js';
import { pickDefaultAssetFolder } from './asset-browser.js';
import { openModal, closeModal } from './modal.js';
import { escapeHtml } from './utils.js';

function inferFolderLabel(fileList) {
  const paths = [...fileList].map(f => (f.webkitRelativePath || f.name || '').replace(/\\/g, '/')).filter(Boolean);
  if (!paths.length) return 'Game folder';
  const first = paths[0];
  const top = first.includes('/') ? first.split('/')[0] : first;
  return top || 'Game folder';
}

function countRpycOnlyScripts(fileIndex) {
  const rpyPaths = new Set(
    fileIndex
      .filter(e => /\.rpy$/i.test(e.relPath))
      .map(e => e.relPath.replace(/\\/g, '/').toLowerCase()),
  );
  return fileIndex.filter(e => {
    const norm = e.relPath.replace(/\\/g, '/').toLowerCase();
    if (!/\.rpyc$/i.test(norm) || norm.includes('/renpy/')) return false;
    const rpy = norm.slice(0, -1);
    return !rpyPaths.has(rpy);
  }).length;
}

async function tryParseStoryFromIndex() {
  const hasRpy = store.fileIndex.some(
    e => /\.rpy$/i.test(e.relPath) && !e.relPath.replace(/\\/g, '/').includes('/renpy/'),
  );
  const rpycOnly = countRpycOnlyScripts(store.fileIndex);
  if (!hasRpy && !rpycOnly) return;

  try {
    if (rpycOnly) {
      showToast('Decompiling .rpyc via Pyodide (first time may take a few seconds)…');
      await initPyodide();
    }
    store.storyData = await parseGameDataFromFolder(store.fileIndex, {
      decompileRpyc: pyDecompileRpyc,
    });
    console.info('Story data auto-detected:', store.storyData._debug);
    const d = store.storyData._debug;
    let msg = `Story parsed: ${d.labels} labels, ${d.vars} variables`;
    if (d.rpyFromArchive) msg += ` (${d.rpyFromArchive} .rpy from archive)`;
    if (d.rpycDecompiled) msg += ` (${d.rpycDecompiled} from .rpyc)`;
    showToast(msg);
  } catch (err) {
    console.error('Story auto-detect failed:', err);
    showToast('Found script files but could not parse story: ' + err.message, true);
  }
}

function mergeFileIndex(newEntries) {
  if (!store.fileIndex) store.fileIndex = [];
  const byPath = new Map(store.fileIndex.map(e => [e.relPath, e]));
  newEntries.forEach(e => byPath.set(e.relPath, e));
  store.fileIndex = Array.from(byPath.values());
}

function updateMeta() {
  const el = document.getElementById('file-meta');
  if (!store.fileIndex?.length) {
    el.textContent = store.saveData?.filename
      ? 'Save: ' + store.saveData.filename
      : 'No game loaded';
    updateUnloadButton();
    return;
  }
  const mediaCount = store.fileIndex.filter(e => {
    const fname = e.relPath.split(/[\\/]/).pop().toLowerCase();
    return /\.(png|jpg|jpeg|webp|gif|ogg|opus|mp3|wav|m4a|webm|mp4|avif)$/.test(fname);
  }).length;
  const rpaNote = store.loadedRpaArchives.length
    ? ' · ' + store.loadedRpaArchives.length + ' archive(s)'
    : '';
  el.textContent = store.fileIndex.length + ' files' + (mediaCount ? ' · ' + mediaCount + ' media' : '') + rpaNote;
  updateUnloadButton();
}

/** Clear all loaded folders, archives, story/save data, and release blob URLs. */
export function unloadGame() {
  if (!isSessionLoaded()) return;

  const msg = store.dirty
    ? 'You have unsaved save changes. Close the game and clear everything from memory anyway?'
    : 'Close the loaded game folder and clear all indexed files, archives, and saves from memory?';
  if (!confirm(msg)) return;

  clearAssetUrlCache();
  resetSaveEditorState();

  store.fileIndex = null;
  store.storyData = null;
  store.saveData = null;
  store.mode = 'assets';
  store.activeTab = 'variables';
  store.compareSaveA = null;
  store.compareSaveB = null;
  store.compareSaveAName = '';
  store.compareSaveBName = '';
  store.compareSaveAPath = null;
  store.compareSaveBPath = null;
  store.selectedId = null;
  store.searchTerm = '';
  store.galleryContext = null;
  store.assetBrowserPageSize = 60;
  store.assetSelectMode = false;
  store.assetSelectedPaths.clear();
  store.assetExpandedFolders.clear();
  store.storyExpandedFolders.clear();
  store.loadedRpaArchives = [];
  store.rpaLoadFailures = [];
  store.saveEntries = [];
  store.activeSavePath = null;

  setDirty(false);
  const searchEl = document.getElementById('search');
  if (searchEl) searchEl.value = '';
  const exportBtn = document.getElementById('export-btn');
  if (exportBtn) exportBtn.disabled = true;

  updateMeta();
  updateMediaStatus();
  showToast('Game closed — memory cleared');
  renderAll();
}

export function updateMediaStatus() {
  const el = document.getElementById('media-status');
  if (!el) return;
  el.textContent = store.fileIndex ? ('🖼 ' + store.fileIndex.length + ' files indexed') : '';
}

function resetAssetBrowserUiForLoad() {
  store.mode = 'assets';
  store.searchTerm = '';
  const searchEl = document.getElementById('search');
  if (searchEl) searchEl.value = '';
  store.assetSelectedPaths.clear();
  store.selectedId = null;
}

function selectDefaultAssetFolder() {
  const folder = pickDefaultAssetFolder();
  if (folder == null) return;
  store.selectedId = folder;
  if (folder) {
    const parts = folder.split('/');
    let acc = '';
    parts.forEach(p => {
      acc = acc ? acc + '/' + p : p;
      store.assetExpandedFolders.add(acc);
    });
  }
}

export async function loadFolder(fileList) {
  const files = [...fileList];
  if (!files.length) {
    showToast('No files selected — pick the folder again (browser did not return any files).', true);
    return;
  }

  resetAssetBrowserUiForLoad();
  clearAssetUrlCache();
  const priorCount = store.fileIndex?.length ?? 0;
  const newEntries = buildFileIndex(files);
  mergeFileIndex(newEntries);

  const rpaFiles = newEntries.filter(e => {
    if (e.source !== 'disk' || !/\.(rpa|rpi)$/i.test(e.relPath)) return false;
    const name = e.relPath.split(/[\\/]/).pop();
    return !store.loadedRpaArchives.some(a => a.name === name);
  });

  if (rpaFiles.length) {
    setLoading(true);
    try {
      for (let i = 0; i < rpaFiles.length; i++) {
        const entry = rpaFiles[i];
        const archiveName = entry.relPath.split(/[\\/]/).pop();
        setLoading(true, `Parsing archive ${i + 1}/${rpaFiles.length}: ${archiveName}`);
        try {
          await indexRpaEntry(entry);
        } catch (err) {
          const archiveName = entry.relPath.split(/[\\/]/).pop();
          const headerLine = entry.file ? await readHeaderFromFile(entry.file).catch(() => '') : '';
          recordRpaFailure(entry, headerLine, err.message, archiveName);
          console.error('RPA index failed:', entry.relPath, err);
        }
      }
      if (store.rpaLoadFailures.length) {
        const names = store.rpaLoadFailures.map(f => f.name).join(', ');
        showToast(
          `Could not parse ${store.rpaLoadFailures.length} archive(s): ${names}. ` +
          'Run: python rpatool.py -l <archive.rpa> for offset/key hints.',
          true,
        );
      }
    } finally {
      setLoading(false);
    }
  }

  const folderLabel = inferFolderLabel(fileList);
  recordRecentSession({
    kind: 'folder',
    label: folderLabel,
    fileCount: store.fileIndex.length,
    archiveCount: store.loadedRpaArchives.length,
    rpyCount: store.fileIndex.filter(e => /\.rpy$/i.test(e.relPath) && !e.relPath.replace(/\\/g, '/').includes('/renpy/')).length,
    rpycCount: store.fileIndex.filter(e => /\.rpyc$/i.test(e.relPath) && !e.relPath.replace(/\\/g, '/').includes('/renpy/')).length,
  });

  const added = store.fileIndex.length - priorCount;
  showToast(
    priorCount > 0
      ? `Added ${added} file(s) — ${store.fileIndex.length} indexed in total`
      : `Game folder loaded: ${store.fileIndex.length} files indexed`,
  );
  updateMeta();
  updateMediaStatus();
  selectDefaultAssetFolder();

  await tryParseStoryFromIndex();

  refreshSaveEntries();
  if (store.saveEntries.length) {
    try {
      await initPyodide();
      const slotSaves = store.saveEntries.filter(e => !isPersistentSave(e));
      const initial = slotSaves[0] || store.saveEntries[0];
      await loadSaveFromEntry(initial, { auto: true });
    } catch (err) {
      console.error('Pyodide init failed:', err);
      showToast('Found save file(s) but could not start Python runtime: ' + err.message, true);
    }
  }

  renderAll();
}

/** Load one or more .rpa / .rpi files without a full game folder (asset browsing + extract). */
export async function loadArchives(fileList) {
  const files = [...fileList].filter(f => /\.(rpa|rpi)$/i.test(f.name));
  if (!files.length) {
    showToast('No .rpa or .rpi files selected', true);
    return;
  }

  resetAssetBrowserUiForLoad();
  const newEntries = files.map(f => ({ relPath: f.name, file: f, source: 'disk' }));
  mergeFileIndex(newEntries);
  const failuresBefore = store.rpaLoadFailures.length;
  const rpaToParse = newEntries.filter(e => {
    const name = e.relPath.split(/[\\/]/).pop();
    return !store.loadedRpaArchives.some(a => a.name === name);
  });

  setLoading(true);
  try {
    for (let i = 0; i < rpaToParse.length; i++) {
      const entry = rpaToParse[i];
      const archiveName = entry.relPath.split(/[\\/]/).pop();
      setLoading(true, `Parsing archive ${i + 1}/${rpaToParse.length}: ${archiveName}`);
      try {
        await indexRpaEntry(entry);
      } catch (err) {
        const headerLine = entry.file ? await readHeaderFromFile(entry.file).catch(() => '') : '';
        recordRpaFailure(entry, headerLine, err.message, archiveName);
        console.error('RPA index failed:', entry.relPath, err);
      }
    }
    const newFailures = store.rpaLoadFailures.slice(failuresBefore);
    if (newFailures.length) {
      const names = newFailures.map(f => f.name).join(', ');
      showToast(
        `Could not parse ${newFailures.length} archive(s): ${names}. ` +
        'Run: python rpatool.py -l <archive.rpa> for hints.',
        true,
      );
    }
  } finally {
    setLoading(false);
  }

  const indexed = store.fileIndex?.some(e => e.source === 'rpa');
  const archiveLabel = files.map(f => f.name).join(', ');
  recordRecentSession({
    kind: 'archive',
    label: archiveLabel.length > 80 ? files[0].name + (files.length > 1 ? ` +${files.length - 1}` : '') : archiveLabel,
    fileCount: store.fileIndex.length,
    archiveCount: store.loadedRpaArchives.length,
  });
  showToast(
    indexed
      ? `Loaded ${files.length} archive file(s) — ${store.fileIndex.length} entries indexed`
      : 'No archives could be parsed',
    !indexed,
  );
  updateMeta();
  updateMediaStatus();
  await tryParseStoryFromIndex();
  selectDefaultAssetFolder();
  renderAll();
}

export function showSaveSelectionModal(entries) {
  const wrap = document.createElement('div');
  wrap.style.minWidth = '320px';
  const h = document.createElement('h3');
  h.style.marginTop = '0';
  h.style.color = 'var(--accent)';
  h.textContent = entries.length + ' save files found — choose one to load';
  wrap.appendChild(h);
  const sub = document.createElement('div');
  sub.className = 'cat-sub';
  sub.textContent = 'Sorted by last modified (newest first). Story Browser variable values update after loading.';
  wrap.appendChild(sub);
  entries.forEach(entry => {
    const card = document.createElement('div');
    card.className = 'ref-card';
    const fname = entry.relPath.split(/[\\/]/).pop();
    const modified = entry.file.lastModified
      ? new Date(entry.file.lastModified).toLocaleString()
      : '';
    card.innerHTML =
      '<div class="title">' + escapeHtml(fname) + '</div>' +
      '<div class="loc">' + escapeHtml(entry.relPath) + (modified ? ' · ' + escapeHtml(modified) : '') + '</div>';
    card.onclick = () => { closeModal(); loadSaveFromEntry(entry, { auto: true }); };
    wrap.appendChild(card);
  });
  openModal(wrap);
}

async function indexRpaEntry(entry) {
  const rel = entry.relPath.replace(/\\/g, '/');
  const archiveName = entry.relPath.split(/[\\/]/).pop();
  const file = entry.file;
  if (!file) {
    recordRpaFailure(entry, '', 'Missing file handle', archiveName);
    return;
  }

  // RPA-1.0 index sidecar — handled together with the .rpa data file.
  if (/\.rpi$/i.test(rel)) {
    const rpaPath = rel.replace(/\.rpi$/i, '.rpa');
    if (store.fileIndex.some(e => e.relPath.replace(/\\/g, '/') === rpaPath)) {
      store.fileIndex = store.fileIndex.filter(e => e.relPath !== entry.relPath);
      return;
    }
  }

  const headerLine = await readHeaderFromFile(file);
  const pair = findRpa10Pair(entry, store.fileIndex);

  let parsed;
  let displayName = archiveName;
  let archiveFile = file;

  if (pair && !isKnownRpaHeader(headerLine)) {
    parsed = await parseRpa10PairFromFiles(pair.indexEntry.file, pair.dataEntry.file);
    displayName = pair.baseName + '.rpa';
    archiveFile = pair.dataEntry.file;
  } else {
    try {
      parsed = await parseRpaArchiveAsyncFromFile(file, archiveName, { fileIndex: store.fileIndex });
    } catch (err) {
      if (pair && err instanceof RpaParseError) {
        try {
          parsed = await parseRpa10PairFromFiles(pair.indexEntry.file, pair.dataEntry.file);
          displayName = pair.baseName + '.rpa';
          archiveFile = pair.dataEntry.file;
        } catch {
          /* fall through to manual modal */
        }
      }

      if (!parsed) {
        if (err instanceof RpaParseError && err.needsManual) {
          const sizeHint = file?.size != null
            ? ` (file size ${file.size}, index offset ${parseInt(err.headerLine?.trim().split(/\s+/)[1] || '', 16) || '?'})`
            : '';
          const manual = await openRpaManualModal(entry, err.headerLine, err.message + sizeHint);
          if (!manual) {
            recordRpaFailure(entry, err.headerLine, 'Manual parse cancelled', archiveName);
            showToast('Skipped archive: ' + archiveName, true);
            return;
          }
          parsed = await parseRpaArchiveFromFile(file, archiveName, { manual });
        } else {
          recordRpaFailure(entry, err.headerLine, err.message, archiveName);
          return;
        }
      }
    }
    archiveFile = parsed.archiveFile || file;
  }

  const virtualEntries = buildRpaVirtualEntries(
    displayName,
    pair?.dataEntry?.relPath || entry.relPath,
    archiveFile,
    parsed,
  );
  mergeFileIndex(virtualEntries);

  const consumed = new Set([entry.relPath]);
  if (pair) {
    consumed.add(pair.dataEntry.relPath);
    consumed.add(pair.indexEntry.relPath);
  }
  store.fileIndex = store.fileIndex.filter(e => !consumed.has(e.relPath));
}

function recordRpaFailure(entry, headerLine, message, archiveName) {
  store.rpaLoadFailures.push({
    name: archiveName,
    relPath: entry.relPath,
    headerLine: headerLine || '',
    message: message || 'Unknown error',
  });
}

function buildRpaVirtualEntries(archiveName, archiveRelPath, archiveFile, parsed) {
  const { version, index, zixMeta } = parsed;
  const virtualPaths = listAllPathsFromIndex(index);
  const mediaOnlyPaths = listMediaFromIndex(index);

  const archiveMeta = {
    name: archiveName,
    version,
    fileCount: Object.keys(index).length,
    mediaFileCount: mediaOnlyPaths.length,
    index,
    archiveFile,
    zixMeta: zixMeta || null,
  };
  const existingIdx = store.loadedRpaArchives.findIndex(a => a.name === archiveName);
  if (existingIdx >= 0) store.loadedRpaArchives[existingIdx] = archiveMeta;
  else store.loadedRpaArchives.push(archiveMeta);

  const prefix = archiveRelPath
    ? archiveRelPath.replace(/\\/g, '/').replace(/\/[^/]+$/, '/')
    : '';

  const archiveLastModified = archiveFile?.lastModified || 0;

  return virtualPaths.map(path => {
    const relPath = (prefix + path).replace(/\\/g, '/');
    const parts = index[path];
    const byteSize = (parts || []).reduce((sum, p) => sum + (Array.isArray(p) ? (p[1] || 0) : 0), 0);
    return {
      relPath,
      source: 'rpa',
      archiveName,
      byteSize,
      archiveLastModified,
      getBytes: () => readRpaFile(path, parts, archiveFile, zixMeta),
    };
  });
}