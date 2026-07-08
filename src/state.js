// Central mutable state, shared across all modules.
export const store = {
  fileIndex: null,        // [{ relPath, file?, getBytes?, source }]
  storyData: null,        // { varIndex, assetIndex, imageTagToFile, scripts, ... } — Story Browser phase
  saveData: null,         // Save Editor phase
  dirty: false,
  mode: 'assets',         // 'assets' | 'story' | 'save' | 'compare'
  activeTab: 'variables', // story browser sub-tab
  compareSaveA: null,
  compareSaveB: null,
  compareSaveAName: '',
  compareSaveBName: '',
  compareSaveAPath: null,  // relPath when picked from loaded game
  compareSaveBPath: null,
  selectedId: null,       // asset folder name, script label, etc.
  searchTerm: '',
  galleryContext: null,   // { entries, index }
  assetBrowserPageSize: 60,
  assetViewMode: 'grid',  // 'grid' | 'list'
  assetTileSize: 140,
  assetSortBy: 'name',    // 'name' | 'size' | 'date'
  assetSortDir: 'asc',    // 'asc' | 'desc'
  assetKindFilter: 'all', // 'all' | 'script' | 'image' | 'audio' | 'video' | 'other'
  assetFolderScope: 'recursive', // 'recursive' | 'direct' — direct = files in this folder only
  assetSelectMode: false,
  assetSelectedPaths: new Set(),
  assetExpandedFolders: new Set(),
  storyExpandedFolders: new Set(),
  loadedRpaArchives: [],  // [{ name, version, fileCount }]
  rpaLoadFailures: [],    // [{ name, relPath, headerLine, message }]
  saveEntries: [],        // [{ relPath, file, source }] — slot + persistent saves
  activeSavePath: null,   // relPath of save currently open in Save Editor
};

export function isSessionLoaded() {
  return Boolean(
    store.fileIndex?.length ||
    store.loadedRpaArchives?.length ||
    store.storyData ||
    store.saveData ||
    store.saveEntries?.length,
  );
}

export function lookupAssetUsages(folderHint, baseName) {
  if (!store.storyData?.assetIndex || !baseName) return [];
  const key = baseName.toLowerCase().replace(/\.[^.]+$/, '');
  const idx = store.storyData.assetIndex;

  if (folderHint && idx[folderHint]?.[key]) return idx[folderHint][key].usages;

  const all = [];
  Object.values(idx).forEach(folderEntry => {
    if (folderEntry[key]) all.push(...folderEntry[key].usages);
  });
  return all;
}

export function variableNamesFromSaveKey(keyPath) {
  const short = keyPath.startsWith('store.') ? keyPath.slice(6) : keyPath;
  const root = short.split('[')[0];
  const names = [root];
  const parts = root.split('.');
  if (parts.length > 1) {
    names.push(parts[0], parts[parts.length - 1]);
  }
  return [...new Set(names.filter(Boolean))];
}

export function lookupVariableRefs(keyPath) {
  const candidates = variableNamesFromSaveKey(keyPath);
  const empty = { setters: [], checkers: [], matchedName: candidates[0] || keyPath };
  if (!store.storyData?.varIndex) return empty;
  for (const name of candidates) {
    const entry = store.storyData.varIndex[name];
    if (entry && (entry.setters.length || entry.checkers.length)) {
      return { setters: entry.setters, checkers: entry.checkers, matchedName: name };
    }
  }
  const direct = store.storyData.varIndex[candidates[0]];
  if (direct) return { setters: direct.setters, checkers: direct.checkers, matchedName: candidates[0] };
  return empty;
}