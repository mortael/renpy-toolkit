import { store, isSessionLoaded } from './state.js';

export function showToast(msg, isError) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.toggle('error', !!isError);
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2600);
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function setLoading(v, message) {
  const el = document.getElementById('loading-overlay');
  el.classList.toggle('show', v);
  if (message != null) {
    el.textContent = message;
  } else if (!v) {
    el.textContent = 'Loading…';
  }
}

export function setDirty(v) {
  store.dirty = v;
  document.getElementById('dirty-pill').classList.toggle('show', v);
}

export function updateUnloadButton() {
  const btn = document.getElementById('unload-btn');
  if (btn) btn.disabled = !isSessionLoaded();
}