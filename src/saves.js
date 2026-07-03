import { store } from './state.js';

export function isPersistentSave(entry) {
  return /persistent\.save$/i.test((entry?.relPath || '').split(/[\\/]/).pop());
}

export function findSaveEntries() {
  if (!store.fileIndex) return [];
  return store.fileIndex
    .filter(e => e.source === 'disk' && e.file && /\.save$/i.test(e.relPath))
    .sort((a, b) => {
      const aPersist = isPersistentSave(a);
      const bPersist = isPersistentSave(b);
      if (aPersist !== bPersist) return aPersist ? 1 : -1;
      return (b.file.lastModified || 0) - (a.file.lastModified || 0);
    });
}

export function refreshSaveEntries() {
  store.saveEntries = findSaveEntries();
}