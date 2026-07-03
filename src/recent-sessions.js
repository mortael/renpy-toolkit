const STORAGE_KEY = 'renpy-toolkit-recent-sessions';
const MAX_SESSIONS = 12;

function loadAll() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveAll(list) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list.slice(0, MAX_SESSIONS)));
  } catch {
    // private browsing / quota
  }
}

export function getRecentSessions() {
  return loadAll();
}

/** @param {{ kind: 'folder'|'archive', label: string, fileCount?: number, archiveCount?: number, rpyCount?: number, rpycCount?: number }} meta */
export function recordRecentSession(meta) {
  if (!meta?.label) return;
  const entry = {
    id: `${meta.kind}:${meta.label}`,
    kind: meta.kind,
    label: meta.label,
    fileCount: meta.fileCount || 0,
    archiveCount: meta.archiveCount || 0,
    rpyCount: meta.rpyCount || 0,
    rpycCount: meta.rpycCount || 0,
    loadedAt: Date.now(),
  };
  const list = loadAll().filter(s => s.id !== entry.id);
  list.unshift(entry);
  saveAll(list);
}

export function removeRecentSession(id) {
  saveAll(loadAll().filter(s => s.id !== id));
}

export function formatRecentLabel(session) {
  const parts = [];
  if (session.fileCount) parts.push(`${session.fileCount} files`);
  if (session.archiveCount) parts.push(`${session.archiveCount} archive(s)`);
  if (session.rpyCount) parts.push(`${session.rpyCount} .rpy`);
  if (session.rpycCount && !session.rpyCount) parts.push(`${session.rpycCount} .rpyc`);
  const detail = parts.length ? ` · ${parts.join(' · ')}` : '';
  const when = new Date(session.loadedAt).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' });
  return `${session.label}${detail} · ${when}`;
}