import { loadPyodide } from 'pyodide';
import { setLoading, showToast } from './utils.js';

const PYODIDE_VERSION = '0.26.4';
const CDN_PYODIDE = `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`;

let pyodide = null;
let pyodideReady = false;
let initPromise = null;
let rpycReady = false;
let pyodideSource = 'unknown';

/** Resolve Vite BASE_URL against the current page ("/" alone is not a valid URL base). */
function documentBaseUrl() {
  const basePath = import.meta.env.BASE_URL || '/';
  return new URL(basePath, window.location.href).href;
}

function resolvePublicUrl(path) {
  return new URL(path.replace(/^\//, ''), documentBaseUrl()).href;
}

function localPyodideBase() {
  return resolvePublicUrl('pyodide/');
}

async function resolvePyodideIndexURL() {
  const local = localPyodideBase();
  try {
    const probe = await fetch(new URL('pyodide.js', local), { method: 'HEAD' });
    if (probe.ok) {
      pyodideSource = 'local';
      return local;
    }
  } catch {
    // fall through to CDN
  }
  pyodideSource = 'cdn';
  return CDN_PYODIDE;
}

export function getPyodideSource() {
  return pyodideSource;
}

export function getPyodideStatusLabel() {
  if (!pyodideReady) return 'Pyodide · not loaded';
  return pyodideSource === 'local'
    ? 'Pyodide · local (offline-capable)'
    : 'Pyodide · CDN (needs internet)';
}

export function isPyodideReady() {
  return pyodideReady;
}

export async function initPyodide() {
  if (pyodideReady && pyodide) return pyodide;
  if (initPromise) return initPromise;

  initPromise = (async () => {
    setLoading(true);
    try {
      const indexURL = await resolvePyodideIndexURL();
      const py = await loadPyodide({ indexURL });
      const code = await fetch(resolvePublicUrl('save_logic.py')).then(r => {
        if (!r.ok) throw new Error('save_logic.py not found');
        return r.text();
      });
      await py.runPythonAsync(code);
      pyodide = py;
      pyodideReady = true;
      if (pyodideSource === 'cdn') {
        console.info('Pyodide loaded from CDN — run npm install && npm run dev for local/offline copy');
      }
      return pyodide;
    } finally {
      setLoading(false);
    }
  })();

  try {
    return await initPromise;
  } catch (err) {
    initPromise = null;
    pyodide = null;
    pyodideReady = false;
    pyodideSource = 'unknown';
    throw err;
  }
}

export async function pyLoadSave(rawBytes, { full = false } = {}) {
  const py = await initPyodide();
  py.globals.set('_js_raw', rawBytes);
  try {
    const expr = full ? 'py_load(bytes(_js_raw), full=True)' : 'py_load(bytes(_js_raw))';
    const jsonStr = await py.runPythonAsync(expr);
    return JSON.parse(jsonStr);
  } finally {
    py.globals.delete('_js_raw');
  }
}

export async function pyFlattenStoreScalars() {
  const py = await initPyodide();
  const jsonStr = await py.runPythonAsync('py_flatten_store_scalars()');
  return JSON.parse(jsonStr);
}

export async function pyExpandNode(path) {
  const py = await initPyodide();
  py.globals.set('_js_path', path);
  try {
    const jsonStr = await py.runPythonAsync('py_expand(_js_path)');
    return JSON.parse(jsonStr);
  } finally {
    py.globals.delete('_js_path');
  }
}

export async function pyExportSave(edits, deleted) {
  const py = await initPyodide();
  const editsJson = JSON.stringify(edits);
  const deletedJson = JSON.stringify(deleted);
  py.globals.set('_js_edits', editsJson);
  py.globals.set('_js_deleted', deletedJson);
  try {
    const result = await py.runPythonAsync('py_save(_js_edits, _js_deleted)');
    return new Uint8Array(result);
  } finally {
    py.globals.delete('_js_edits');
    py.globals.delete('_js_deleted');
  }
}

export async function pyCompareLoad(slot, rawBytes) {
  const py = await initPyodide();
  py.globals.set('_js_slot', slot);
  py.globals.set('_js_raw', rawBytes);
  try {
    const jsonStr = await py.runPythonAsync('py_compare_load(_js_slot, bytes(_js_raw))');
    return JSON.parse(jsonStr);
  } finally {
    py.globals.delete('_js_slot');
    py.globals.delete('_js_raw');
  }
}

export async function pyFlattenSlot(slot) {
  const py = await initPyodide();
  py.globals.set('_js_slot', slot);
  try {
    const jsonStr = await py.runPythonAsync('py_flatten_slot(_js_slot)');
    return JSON.parse(jsonStr);
  } finally {
    py.globals.delete('_js_slot');
  }
}

async function ensureRpycLogic(py) {
  if (rpycReady) return;
  const code = await fetch(resolvePublicUrl('rpyc_logic.py')).then(r => {
    if (!r.ok) throw new Error('rpyc_logic.py not found');
    return r.text();
  });
  await py.runPythonAsync(code);
  rpycReady = true;
}

export async function pyDecompileRpyc(rawBytes) {
  const py = await initPyodide();
  await ensureRpycLogic(py);
  py.globals.set('_js_raw', rawBytes);
  try {
    const jsonStr = await py.runPythonAsync('py_decompile_rpyc(bytes(_js_raw))');
    return JSON.parse(jsonStr);
  } finally {
    py.globals.delete('_js_raw');
  }
}