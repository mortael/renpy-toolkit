# Ren'Py Toolkit — Codebase Guide

Architecture reference for developers working on this project. Assumes familiarity with the RPG Maker toolkit pattern (Vite + vanilla JS + shared `store` object).

## 1. Stack

| Piece | Choice |
|-------|--------|
| Build | Vite 8 |
| UI | Vanilla JS modules, no framework |
| State | Single mutable `store` in `state.js` |
| ZIP | `jszip` (save files) |
| Compression | `pako` (RPA index blobs) |
| Save pickle | Pyodide (npm → `public/pyodide/`, CDN fallback) + `public/save_logic.py` |
| RPYC decompile | Pyodide + `public/rpyc_logic.py` (RPYC2 → pseudo-`.rpy` for Story Browser) |

## 2. Entry point & render loop

```
index.html
  └─ main.js
       ├─ initModal()
       ├─ wire header buttons (mode switch, load folder/save/archive, 🕘 Recent, export, search)
       └─ renderAll()
            ├─ renderSubnav()      # per-mode tabs / status
            ├─ renderSidebar()     # delegates to active mode module
            └─ renderContent()     # delegates to active mode module
```

`store.mode` is one of: `assets` | `story` | `save` | `compare`.

Mode modules own their sidebar + content render functions. `main.js` never imports UI details beyond routing.

## 3. Central state (`state.js`)

```js
store = {
  fileIndex,          // unified asset + script file list
  storyData,          // parsed .rpy indexes
  saveData,           // { vars, filename } for live status badges
  mode, activeTab,    // navigation
  selectedId, searchTerm,
  compareSaveA/B,     // flattened key→value maps for diff
  compareSaveA/BName, compareSaveA/BPath,  // display + game-save picker highlight
  assetBrowser*,      // grid/list/sort/selection/expanded folders
  storyExpandedFolders,
  loadedRpaArchives,
  rpaLoadFailures,    // archives that failed to parse
  saveEntries,        // .save files found in loaded folder
  activeSavePath,     // which save is open in Save Editor
  dirty,              // unsaved save edits
}
```

**Why a shared object?** ES module live bindings are read-only from importers. Mutating `store.fileIndex = …` from any module updates all readers.

**Cross-mode helpers** in `state.js`:

- `lookupAssetUsages(folder, baseName)` — script references for Asset Browser
- `lookupVariableRefs(keyPath)` — save key → script setter/checker refs

## 4. Load pipeline (`folder-loader.js`)

`loadFolder(fileList)` is the main orchestrator:

1. `buildFileIndex()` — disk `File` objects → `{ relPath, file, source: 'disk' }`
2. For each `.rpa`/`.rpi`: `indexRpaEntry()` — unpickle index, add virtual `{ relPath, getBytes, source: 'rpa' }` entries for **every path in the archive index** (progress overlay: `Parsing archive N/M`). Story Browser reads scripts from the same virtual entries.
3. **`loadArchives(fileList)`** — same RPA indexing without story/save detection; switches to Asset Browser mode
4. `tryParseStoryFromIndex()` — if `.rpy` and/or `.rpyc`-only scripts: `parseGameDataFromFolder({ decompileRpyc: pyDecompileRpyc })` → `store.storyData` (`.rpyc` skipped when sibling `.rpy` exists)
5. If `saves/*.save` found: `refreshSaveEntries()` → `initPyodide()` → auto-load newest slot save; **save picker** in Save Editor sidebar lists all saves (including `persistent.save`)
6. `recordRecentSession()` — folder label + counts → localStorage (max 12; see `recent-sessions.js`)

`loadArchives()` indexes RPA only, switches to Asset Browser, and records an archive-kind recent session.

Multiple folder picks merge into `fileIndex` by `relPath`.

## 5. Module map

### Assets & archives

| Module | Role |
|--------|------|
| `assets.js` | `fileIndex` helpers, MIME types, blob URLs, `findAssetFile`, `resolveMediaAsset`, `downloadRpaArchiveAsZip`, video thumbnail capture |
| `rpa.js` | Parse RPA header, decompress index, `readRpaFile()` extraction |
| `pickle-index.js` | Minimal pickle unpickler for RPA index dicts only |
| `asset-browser.js` | Folder tree, **Loaded archives** sidebar panel, grid/list, previews, animation sequences, bulk selection (Shift+click range select for frames) |
| `recent-sessions.js` | localStorage recent folder/archive sessions; `main.js` **🕘 Recent** menu re-triggers pickers |
| `animation-player.js` | Frame-sequence player modal |

### Story

| Module | Role |
|--------|------|
| `script-parser.js` | `.rpy` line parser; `default`/`define Character` indexing, `labelRefs` call graph, `assetIndex`; optional `decompileRpyc` |
| `story-browser.js` | Variables / Labels / Files / Media refs / Characters / Dialogue tabs, label flow panel, media preview, `jumpToLabel()` |
| `condition-eval.js` | Lightweight Ren'Py if/elif evaluator (`and`/`or`/`not`, comparisons) |
| `live-status.js` | Save scalar lookup + TRUE/FALSE/? badges on conditions |

**Image tag resolution:** `image tag = "file.jpg"`, `image tag variant = other_tag` (alias chains via `resolveImageTagAliases()`), or `Movie(play="images/foo.webm")` → `imageTagToFile` dict → `resolveMediaAsset()` at preview time. `show`/`scene` use the full tag before `at`/`with` clauses.

**Label list cleanup:** Pre-label content (`init`, `image` defs) merges into the file's first real label; definition-only files (e.g. `screens.rpy`) are hidden from Browse by Label.

### Save

| Module | Role |
|--------|------|
| `pyodide-runtime.js` | CDN/local load, `documentBaseUrl()` + `resolvePublicUrl()`, `py_load` / `py_save` / `py_flatten_store_scalars` / compare + `pyDecompileRpyc` |
| `public/save_logic.py` | `SafeUnpickler`, shallow `py_load`, `py_expand`, compare slots + `_flatten_obj`, `py_save` |
| `public/rpyc_logic.py` | RPYC2 unpickle, AST walk → pseudo-`.rpy` source string |
| `save-editor.js` | Lazy tree UI, dotted/bracketed edit keys, export |
| `compare-saves.js` | Game save picker (sidebar A/B + dropdown), file dialog fallback, `pyCompareLoad` + `pyFlattenSlot`, JS `diffFlat` |

### Shared UI

| Module | Role |
|--------|------|
| `modal.js` | Asset preview, save-key references, save picker |
| `utils.js` | `escapeHtml`, toast, loading overlay, dirty pill |

## 6. Data shapes

### `fileIndex` entry

```js
// disk
{ relPath: 'images/bg.png', file: File, source: 'disk' }
// rpa virtual
{ relPath: 'images/bg.png', getBytes: async () => Uint8Array, source: 'rpa', byteSize, archiveLastModified }
```

### `storyData`

```js
{
  scripts: [{ id, label, file, title, location, lines: [{ type, text, … }] }],
  files: [{ path, labelCount, scriptOffset }],
  varNames, varIndex, assetIndex, labelBrowse,
  imageTagToFile: { ch2scene1: '02-CUARTO_NOCHE.jpg', … },
  _debug: { rpyFiles, labels, vars },
}
```

### Save edit keys

The save tree builds paths like:

- `persistent.achievements[2].unlocked`
- `mom_affection`

`py_save` resolves these through the object graph (not flat `store[key]` lookup).

## 7. RPA parsing (`rpa.js` + `pickle-index.js`)

### Supported formats

| Format | Notes |
|--------|--------|
| `RPA-1.0` | `.rpa` data + `.rpi` zlib/pickle index sidecar |
| `RPA-2.0` / `3.0` / `3.2` / `4.0` | Standard pickle index at header offset |
| `ALT-1.0` | Key then offset in header |
| `RWA-3.0` | Renamed RPA-3.0 (rpatool.py) |
| `SVAC-1.0` | 4 header fields → JSON index (zlib or Ogg/Vorbis); otherwise RPA-3.0 pickle underneath |
| Generic `PREFIX offset [keys…]` | `tryParseGenericHeader()` |
| `ZiX-12A` / `ZiX-12B` | Offset unscramble + key from `loader.rpy` verification string (`zix-rpa.js`) |

Parse flow: known header → multiple offset/key attempts → ZiX metadata scan → `RpaParseError` → `openRpaManualModal()`. Failures accumulate in `store.rpaLoadFailures` with a summary toast (suggests `python rpatool.py -l`).

`ZiX-12B` file body prefix decode works when `runAmount` is found in scripts; `loader.pyo`-only games still need manual offset/key.

## 8. RPA index pickle (`pickle-index.js`)

Ren'Py RPA-3.0 stores a pickled dict mapping filename → list of `(offset, length, …)` tuples. Offsets beyond 2³¹ use Python's `LONG1` opcode (5+ bytes). Protocol 4 opcodes (`FRAME`, `BINUNICODE8`, `SHORT_BINUNICODE`, `BINBYTES8`) are supported for newer games.

**Fixed:** `readSignedLong` uses `bytes[i] * Math.pow(2, 8*i)` instead of `<<` (JS shifts are mod 32, corrupting large offsets).

Run `npm test` for RPA + image-tag alias smoke tests.

## 9. Pyodide runtime (`pyodide-runtime.js`)

- `npm install` runs `scripts/sync-pyodide.mjs` → copies `node_modules/pyodide` to `public/pyodide/` (gitignored, included in `dist/` on build).
- `documentBaseUrl()` resolves `import.meta.env.BASE_URL` against `window.location.href` (fixes `new URL('pyodide/', '/')` on subpaths and `file://`).
- `resolvePublicUrl(path)` — fetches `save_logic.py`, `rpyc_logic.py`, and local Pyodide assets.
- `initPyodide()` probes local `pyodide/pyodide.js` first, then CDN (`v0.26.4`).
- `getPyodideStatusLabel()` — shown in Save Editor subnav.

**Bridges:**

| JS export | Python | Use |
|-----------|--------|-----|
| `pyLoad` / `pyExpand` / `pySave` | `py_load`, `py_expand`, `py_save` | Save Editor |
| `pyCompareLoad` / `pyFlattenSlot` | `py_compare_load`, `py_flatten_slot` | Compare Saves |
| `pyDecompileRpyc` | `py_decompile_rpyc` (via `rpyc_logic.py`) | Story Browser |

## 10. Save logic (`save_logic.py`)

Port of the `FlexObj` / `SafeUnpickler` trick from `reference-renpy-save-editor.py`:

- Every unknown class becomes `FlexObj` / `FlexList` / `FlexDict` at unpickle time
- Tree is serialized to JSON for the JS UI
- Scalar edits round-trip through `_deserialize_scalar`
- **Fixed:** `_resolve_parent()` walks dotted/bracketed paths for nested edits and deletes

**Lazy load (Save Editor):**

- `py_load()` — shallow tree: scalars inline, complex nodes `{ lazy: true, len: N }` only.
- `py_expand(path)` — full `_serialize_value` for one subtree when the user expands a row.

Flow:

```
.save (zip) → py_load (shallow) → expand on demand → edits → py_save → new .save bytes
```

**Compare Saves (always Python flatten, not browser tree):**

- `py_compare_load(slot, raw_bytes)` — unpickles into `_compare_slots['a'|'b']` (separate from editor `_state`).
- `py_flatten_slot(slot)` — walks entire `store` via `_flatten_obj()` → flat `{ "key.path": value }` JSON for JS diff.
- Does **not** use `py_load(full=True)` or lazy expand; the full store is flattened in Python before diffing. Large saves may take longer than Save Editor's shallow open.

## 11. UI patterns (lessons from RPG Maker toolkit)

1. **Folder expand state** — `expandAncestorsOf` only on *select*, never on every render (collapse works).
2. **Animation player** — checks `modal-overlay.show` inside the interval tick; no leaky document click listener.
3. **Single load button** — folder load cascades detection; optional separate save load for extras.

## 12. Script parser scope

`script-parser.js` is intentionally shallow — not a full Ren'Py AST:

| Parsed | Not parsed |
|--------|------------|
| `label`, `jump`/`call`, `menu`, `if`/`elif`, `$` lines | `python:` blocks (body tracked as code lines only) |
| `scene`/`show`/`play music|sound|audio|voice` | `define Character`, screens, ATL transforms |
| `image tag = …` (path + alias chains) | Full Ren'Py AST / ATL |
| `.rpyc` without sibling `.rpy` | Decompiled via `rpyc_logic.py` → same line parser |
| Dialogue (`char "..."`) | Dynamic variable names |

Skipped files: `gui.rpy`, `options.rpy`, anything under `renpy/`.

## 13. Known gaps

| Item | Status |
|------|--------|
| `ZiX-12A`/`ZiX-12B` with only `loader.pyo` | Manual offset/key — no `.pyo` decompilation in browser |
| `persistent.save` | Supported via save picker (sorted below slot saves) |
| `image tag = LiveComposite(...)` etc. | Path-only extraction; no composite preview |
| Variable refs for dynamic names | Best-effort regex only |
| Condition eval | Simple expressions only — dynamic/complex Python shows `?` badge |
| Compare Saves performance | Full Python flatten of both saves before diff (not lazy like Save Editor) |
| `.rpyc` decompile fidelity | Pseudo-`.rpy` from bytecode — good enough for labels/vars, not `unrpyc` quality |
| Recent sessions | Metadata only; user must re-pick folder/archive (browser security) |

## 14. Adding a feature — checklist

1. **Asset-only?** → `assets.js` / `asset-browser.js`, use `fileIndex`
2. **Script reference?** → extend `script-parser.js` `buildIndexes()` and/or `parseLine()`
3. **Save field type?** → `_serialize_value` / `_deserialize_scalar` in `save_logic.py`
4. **New mode/tab?** → button in `index.html`, route in `main.js`, subnav in `renderSubnav()`
5. **Cross-link?** → `state.js` lookup helpers + `modal.js`

## 15. File index (quick)

```
src/
  main.js              # shell, renderAll, mode routing
  state.js             # store + lookups
  folder-loader.js     # load orchestration + rpyc story detect
  recent-sessions.js   # localStorage recent list
  saves.js             # save file discovery (slot + persistent)
  zix-rpa.js           # ZiX-12A/12B offset/key helpers
  assets.js            # bytes, URLs, resolveMediaAsset
  rpa.js               # archive reader
  pickle-index.js      # RPA index unpickler
  asset-browser.js     # asset UI
  animation-player.js  # sequence player
  script-parser.js     # .rpy parser
  story-browser.js     # story UI
  live-status.js       # save value badges
  save-editor.js       # save tree UI
  pyodide-runtime.js   # Python bridge
  compare-saves.js     # diff UI
  condition-eval.js    # if/elif eval for Story Browser
  modal.js             # modals
  utils.js             # shared helpers
  style.css            # all styles
public/
  save_logic.py        # pickle engine (copied to dist/ on build)
  rpyc_logic.py        # RPYC2 decompiler (Pyodide, on demand)
```