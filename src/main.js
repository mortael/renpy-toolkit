import { store } from './state.js';
import { renderAssetBrowserSidebar, renderAssetBrowserContent } from './asset-browser.js';
import { storyTabs, renderStorySidebar, renderStoryContent } from './story-browser.js';
import { renderSaveSidebar, renderSaveContent, loadSaveFile, exportSaveFile, onSaveSearch, prewarmPyodide } from './save-editor.js';
import { getPyodideStatusLabel } from './pyodide-runtime.js';
import { renderCompareSidebar, renderCompareContent, prewarmComparePyodide } from './compare-saves.js';
import { loadFolder, loadArchives, updateMediaStatus, unloadGame } from './folder-loader.js';
import { downloadRpaArchiveAsZip } from './assets.js';
import { initModal } from './modal.js';
import { getRecentSessions, formatRecentLabel, removeRecentSession } from './recent-sessions.js';
import { showToast } from './utils.js';

function renderSubnav() {
  const nav = document.getElementById('subnav');
  nav.innerHTML = '';
  if (store.mode === 'assets') {
    const status = document.createElement('span');
    status.className = 'media-status';
    status.id = 'media-status';
    nav.appendChild(status);
    updateMediaStatus();
    store.loadedRpaArchives.forEach(arch => {
      const btn = document.createElement('button');
      btn.className = 'sub-btn';
      btn.title = 'Extract all ' + arch.fileCount + ' files from this archive (including scripts, not only media)';
      btn.textContent = '⬇ Extract ' + arch.name + ' (' + arch.fileCount + ')';
      btn.onclick = () => downloadRpaArchiveAsZip(arch);
      nav.appendChild(btn);
    });
    if (store.rpaLoadFailures?.length) {
      const warn = document.createElement('span');
      warn.className = 'media-status';
      warn.style.color = 'var(--danger)';
      warn.textContent = store.rpaLoadFailures.length + ' archive(s) failed to parse';
      nav.appendChild(warn);
    }
  } else if (store.mode === 'story') {
    storyTabs.forEach(t => {
      const b = document.createElement('button');
      b.className = 'sub-btn' + (t.id === store.activeTab ? ' active' : '');
      b.textContent = t.label;
      b.onclick = () => {
        store.activeTab = t.id;
        store.selectedId = null;
        if (!['dialogue', 'characters', 'media'].includes(t.id)) {
          store.searchTerm = '';
          document.getElementById('search').value = '';
        }
        renderAll();
      };
      nav.appendChild(b);
    });
    if (store.storyData) {
      const status = document.createElement('span');
      status.className = 'media-status';
      const d = store.storyData._debug;
      let txt = d.labels + ' labels · ' + d.vars + ' variables';
      if (d.rpycDecompiled) txt += ' · ' + d.rpycDecompiled + ' .rpyc decompiled';
      status.textContent = txt;
      nav.appendChild(status);
    }
  } else if (store.mode === 'save') {
    const hint = document.createElement('span');
    hint.className = 'media-status';
    hint.textContent = getPyodideStatusLabel();
    nav.appendChild(hint);
  } else if (store.mode === 'compare') {
    const hint = document.createElement('span');
    hint.className = 'media-status';
    hint.textContent = 'Flattened store diff';
    nav.appendChild(hint);
  }
}

export function renderAll() {
  document.querySelectorAll('.mode-btn').forEach(b => b.classList.toggle('active', b.dataset.mode === store.mode));
  renderRecentMenu();
  renderSubnav();
  if (store.mode === 'assets') {
    renderAssetBrowserSidebar();
    renderAssetBrowserContent();
  } else if (store.mode === 'story') {
    renderStorySidebar();
    renderStoryContent();
  } else if (store.mode === 'save') {
    renderSaveSidebar();
    renderSaveContent();
  } else if (store.mode === 'compare') {
    renderCompareSidebar();
    renderCompareContent();
  }
}

function renderRecentMenu() {
  const menu = document.getElementById('recent-menu');
  if (!menu) return;
  const sessions = getRecentSessions();
  menu.innerHTML = '';
  if (!sessions.length) {
    const empty = document.createElement('div');
    empty.className = 'recent-menu-empty';
    empty.textContent = 'No recent sessions yet. Load a game folder or archive to see it here.';
    menu.appendChild(empty);
    return;
  }
  sessions.forEach(session => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'recent-menu-item';
    btn.innerHTML =
      '<span class="recent-kind">' + (session.kind === 'archive' ? '📦 Archive' : '📂 Folder') + '</span> ' +
      '<span class="recent-menu-remove" data-remove="' + session.id + '" title="Remove">✕</span><br>' +
      formatRecentLabel(session);
    btn.onclick = (e) => {
      if (e.target?.dataset?.remove) return;
      document.getElementById('recent-dropdown')?.removeAttribute('open');
      if (session.kind === 'archive') {
        showToast('Pick the same archive file(s) again via 📦 Load Archive');
        document.getElementById('load-archive-btn')?.click();
      } else {
        showToast('Pick the same game folder again via 📂 Load Game Folder');
        document.getElementById('load-folder-btn')?.click();
      }
    };
    btn.querySelector('.recent-menu-remove')?.addEventListener('click', (e) => {
      e.stopPropagation();
      removeRecentSession(session.id);
      renderRecentMenu();
    });
    menu.appendChild(btn);
  });
}

function init() {
  initModal();
  renderRecentMenu();

  document.getElementById('mode-assets').onclick = () => { store.mode = 'assets'; renderAll(); };
  document.getElementById('mode-story').onclick = () => { store.mode = 'story'; renderAll(); };
  document.getElementById('mode-save').onclick = () => { store.mode = 'save'; prewarmPyodide(); renderAll(); };
  document.getElementById('mode-compare').onclick = () => { store.mode = 'compare'; prewarmComparePyodide(); renderAll(); };

  document.getElementById('load-folder-btn').onclick = () => document.getElementById('folder-input').click();
  document.getElementById('unload-btn').onclick = () => unloadGame();
  document.getElementById('folder-input').onchange = (e) => {
    if (e.target.files?.length) loadFolder(e.target.files);
    e.target.value = '';
  };
  document.getElementById('load-archive-btn').onclick = () => document.getElementById('archive-input').click();
  document.getElementById('archive-input').onchange = (e) => {
    if (e.target.files?.length) loadArchives(e.target.files);
    e.target.value = '';
  };
  document.getElementById('load-save-btn').onclick = () => document.getElementById('save-input').click();
  document.getElementById('save-input').onchange = (e) => {
    if (e.target.files?.[0]) loadSaveFile(e.target.files[0]);
  };
  document.getElementById('export-btn').onclick = exportSaveFile;

  document.getElementById('search').oninput = (e) => {
    store.searchTerm = e.target.value.toLowerCase();
    if (store.mode === 'assets') {
      renderAssetBrowserSidebar();
      renderAssetBrowserContent();
    }
    else if (store.mode === 'story') {
      renderStorySidebar();
      renderStoryContent();
    }
    else if (store.mode === 'save') onSaveSearch();
  };

  window.addEventListener('beforeunload', (e) => {
    if (store.dirty) { e.preventDefault(); e.returnValue = ''; }
  });

  renderAll();
}

init();