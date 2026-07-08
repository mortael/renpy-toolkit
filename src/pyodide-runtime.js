import { loadPyodide } from 'pyodide';
import { setLoading, showToast } from './utils.js';

const PYODIDE_VERSION = '0.29.4';
const CDN_PYODIDE = `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`;

let pyodide = null;
let pyodideReady = false;
let initPromise = null;
let rpycReady = false;
let pyodideSource = 'unknown';

/** Cached Python callables — avoids runPythonAsync recompile (and should_quiet bugs). */
const pyFns = {
  py_load: null,
  py_flatten_store_scalars: null,
  py_expand: null,
  py_save: null,
  py_compare_load: null,
  py_flatten_slot: null,
  py_decompile_rpyc: null,
};

/**
 * Workaround for Pyodide should_quiet() using reversed() on token lists
 * (TypeError: 'list' object is not reversible in some builds).
 */
const SHOULD_QUIET_PATCH = `
import _pyodide._base as _b
import tokenize
from io import StringIO

def _should_quiet_fixed(source):
    source_io = StringIO(source)
    tokens = list(tokenize.generate_tokens(source_io.readline))
    for i in range(len(tokens) - 1, -1, -1):
        token = tokens[i]
        if token.type in (tokenize.ENDMARKER, tokenize.NL, tokenize.NEWLINE, tokenize.COMMENT):
            continue
        return (token.type == tokenize.OP) and (token.string == ";")
    return False

_b.should_quiet = _should_quiet_fixed
`;

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

function resetPyodideState() {
  initPromise = null;
  pyodide = null;
  pyodideReady = false;
  rpycReady = false;
  pyodideSource = 'unknown';
  Object.keys(pyFns).forEach(k => { pyFns[k] = null; });
}

function bindPyFn(py, name) {
  const fn = py.globals.get(name);
  if (!fn) throw new Error(`Python function ${name} not found`);
  pyFns[name] = fn;
}

async function loadPythonSource(py, relPath) {
  const code = await fetch(resolvePublicUrl(relPath)).then(r => {
    if (!r.ok) throw new Error(`${relPath} not found`);
    return r.text();
  });
  await py.runPythonAsync(code, { filename: relPath });
}

function applyShouldQuietPatch(py) {
  try {
    py.runPython(SHOULD_QUIET_PATCH, { filename: '_should_quiet_patch.py' });
  } catch (err) {
    console.warn('Pyodide should_quiet patch failed:', err);
  }
}

function bytesToUint8Array(result) {
  if (result instanceof Uint8Array) return result;
  if (result?.buffer instanceof ArrayBuffer) {
    return new Uint8Array(result.buffer, result.byteOffset, result.byteLength);
  }
  if (typeof result?.toJs === 'function') {
    const js = result.toJs();
    if (js instanceof Uint8Array) return js;
  }
  return new Uint8Array(result);
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
      applyShouldQuietPatch(py);

      await loadPythonSource(py, 'save_logic.py');
      bindPyFn(py, 'py_load');
      bindPyFn(py, 'py_flatten_store_scalars');
      bindPyFn(py, 'py_expand');
      bindPyFn(py, 'py_save');
      bindPyFn(py, 'py_compare_load');
      bindPyFn(py, 'py_flatten_slot');

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
    resetPyodideState();
    throw err;
  }
}

async function ensureRpycLogic() {
  const py = await initPyodide();
  if (rpycReady) return py;
  await loadPythonSource(py, 'rpyc_logic.py');
  bindPyFn(py, 'py_decompile_rpyc');
  rpycReady = true;
  return py;
}

export async function pyLoadSave(rawBytes, { full = false } = {}) {
  await initPyodide();
  const jsonStr = pyFns.py_load(rawBytes, full);
  return JSON.parse(jsonStr);
}

export async function pyFlattenStoreScalars() {
  await initPyodide();
  const jsonStr = pyFns.py_flatten_store_scalars();
  return JSON.parse(jsonStr);
}

export async function pyExpandNode(path) {
  await initPyodide();
  const jsonStr = pyFns.py_expand(path);
  return JSON.parse(jsonStr);
}

export async function pyExportSave(edits, deleted) {
  await initPyodide();
  const editsJson = JSON.stringify(edits);
  const deletedJson = JSON.stringify(deleted);
  const result = pyFns.py_save(editsJson, deletedJson);
  return bytesToUint8Array(result);
}

export async function pyCompareLoad(slot, rawBytes) {
  await initPyodide();
  const jsonStr = pyFns.py_compare_load(slot, rawBytes);
  return JSON.parse(jsonStr);
}

export async function pyFlattenSlot(slot) {
  await initPyodide();
  const jsonStr = pyFns.py_flatten_slot(slot);
  return JSON.parse(jsonStr);
}

export async function pyDecompileRpyc(rawBytes) {
  await ensureRpycLogic();
  const jsonStr = pyFns.py_decompile_rpyc(rawBytes);
  return JSON.parse(jsonStr);
}

/** Drop cached Pyodide state (e.g. on Close game) so the next load starts fresh. */
export function resetPyodideSession() {
  resetPyodideState();
}