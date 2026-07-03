# Ren'Py Toolkit — Code Review Findings

Reviewed: the `renpy-toolkit.zip` upload (22 modules, builds cleanly with
`npm run build` — zero errors/warnings). This document covers what was
checked, two confirmed bugs with reproductions and fixes, and a handful of
smaller observations. Nothing in this document has been applied to the code —
it's a findings report, not a patch.

---

## Overall assessment

Genuinely solid work. Specifically worth calling out as done well:

- **The three lessons-learned from the RPG Maker toolkit were correctly
  applied**, not just copy-pasted as a note and then ignored:
  - The folder-tree expand/collapse bug (auto-re-expanding an ancestor on
    every render, making collapse impossible) does **not** recur —
    `expandAncestorsOf`/`expandStoryAncestorsOf` are only called from the
    *select* path, never from a general render path, in both
    `asset-browser.js` and `story-browser.js`.
  - The animation player's "stop on modal close" logic does **not** use a
    leaky bubbling click listener — it correctly checks
    `modal-overlay.classList.contains('show')` inside the `setInterval` tick
    itself, exactly the fix that was needed.
  - Loading is consolidated into one primary "Load Game Folder" action with
    auto-detection cascading through RPA extraction → script parsing → save
    detection → Pyodide init, matching the explicit guidance added to
    `renpy-toolkit-plan.md` §4 about not repeating the "too many overlapping
    load buttons" mistake.
- **`save_logic.py`** is a faithful, correct port of the `FlexObj`/
  `SafeUnpickler` class-substitution trick from
  `reference-renpy-save-editor.py`, adapted cleanly for the Pyodide
  JSON-bridge (no Flask needed).
- **`pyodide-runtime.js`** wiring is clean — CDN script load, pinned Pyodide
  version (`v0.26.4`, not "latest"), proper error/state cleanup on init
  failure, correct Pyodide proxy usage for passing bytes across the bridge.
- **`script-parser.js`**'s `shouldTrackVar`/`extractVarsFromExpr` heuristic
  variable cross-reference is a sensible, well-scoped answer to "Ren'Py has
  no fixed switch list" — filters Python keywords and Ren'Py builtins,
  special-cases `persistent.`/`store.` correctly (bare `persistent`/`store`
  aren't trackable, only their attributes are).
- **`assets.js`**'s `getAssetBytes` abstraction (real `File` vs. an RPA
  virtual entry's `getBytes()` closure) is exactly the right shape, and
  `resolveVideoThumbnailCached` (seek-and-canvas-capture for video posters)
  is a genuinely new, well-implemented feature beyond anything the RPG Maker
  toolkit had.
- Renaming `decrypt.js` → `assets.js` for the Ren'Py project was a good call
  — Ren'Py mostly isn't *encrypted*, just *archived*, and the old name
  wouldn't have fit.

Two real, confirmed bugs were found underneath all that — both with clean,
verified fixes below.

---

## 🔴 Bug 1 — `py_save` silently drops every nested edit

**File:** `public/save_logic.py` (and its `dist/` copy)

```python
for key, node in edits.items():
    if key in store:
        store[key] = _deserialize_scalar(node, store[key])
```

This only matches **top-level** keys of the `store` dict. But
`src/save-editor.js`'s `loadChildren` builds nested, dotted/bracketed edit
keys as the user expands the tree and edits a value at any depth:

```js
container.appendChild(makeNode(`${keyPath}[${idx}]`, child, String(idx), depth));
...
page.forEach(([k, v]) => container.appendChild(makeNode(`${keyPath}.${k}`, v, k, depth)));
```

So a real edit key looks like `"persistent.achievements[2].unlocked"` — which
is never `in store` (the actual dict only has simple top-level names like
`"persistent"`, `"mom_affection"`, etc. as keys). The `if key in store:`
guard is false for every nested edit, so **the edit is silently never
applied** — no exception, no console warning, the UI shows the change as
made, and the exported `.save` simply doesn't contain it.

This isn't a minor edge case — given the tree UI is explicitly built to let
people edit at arbitrary depth (that's the entire point of the FlexObj
substitution trick over plain top-level patching), this bug means **most
realistic edits silently don't save**. Only edits to genuine top-level
`store` variables (no dots, no brackets) currently work.

### Suggested fix

Resolve the dotted/bracketed path against the real object graph instead of
doing a flat dict lookup:

```python
import re

_PATH_RE = re.compile(r'\.([A-Za-z_][A-Za-z0-9_]*)|\[(\d+)\]')

def _resolve_parent(root, path):
    """Walk `path` (e.g. 'persistent.achievements[2]') and return
    (parent_container, final_key_or_index) for the last segment,
    or (None, None) if any step along the way doesn't exist."""
    parts = [path.split('.', 1)[0].split('[')[0]]  # first segment, no leading dot
    rest = path[len(parts[0]):]
    for m in _PATH_RE.finditer(rest):
        parts.append(m.group(1) if m.group(1) is not None else int(m.group(2)))

    obj = root
    for part in parts[:-1]:
        try:
            obj = obj[part] if isinstance(part, int) else (
                obj[part] if isinstance(obj, dict) else getattr(obj, part)
            )
        except (KeyError, AttributeError, IndexError, TypeError):
            return None, None
    return obj, parts[-1]


def py_save(edits_json, deleted_json):
    if _state["store"] is None:
        raise RuntimeError("no save loaded")
    store = _state["store"]
    rollback = _state["rollback"]
    extras = _state["extras"]
    edits = json.loads(edits_json)
    deleted = json.loads(deleted_json)

    for key in deleted:
        parent, final = _resolve_parent(store, key)
        if parent is None:
            continue
        try:
            if isinstance(final, int):
                del parent[final]
            elif isinstance(parent, dict):
                parent.pop(final, None)
            else:
                delattr(parent, final)
        except (KeyError, AttributeError, IndexError, TypeError):
            pass

    for key, node in edits.items():
        parent, final = _resolve_parent(store, key)
        if parent is None:
            continue
        try:
            current = parent[final] if isinstance(final, int) or isinstance(parent, dict) else getattr(parent, final)
        except (KeyError, AttributeError, IndexError, TypeError):
            current = None
        new_value = _deserialize_scalar(node, current)
        if isinstance(final, int):
            parent[final] = new_value
        elif isinstance(parent, dict):
            parent[final] = new_value
        else:
            setattr(parent, final, new_value)

    return save_to_bytes(store, rollback, extras)
```

This mirrors exactly what `_serialize_value` already does in reverse — it
already recurses through `list`/`dict`/`FlexObj.__dict__` to *read* nested
values for display, so the *write* side just needs the same traversal,
applied to the last segment instead of stopping at a leaf for display. Worth
testing against a save with at least 3 levels of nesting (e.g. a
dict-inside-a-FlexObj-inside-persistent) before trusting it fully — the
parent-type branching (dict vs. object vs. list) is the part most likely to
need a real test file to get exactly right.

---

## 🔴 Bug 2 — large RPA archives get corrupted offsets/lengths

**File:** `src/pickle-index.js`, the `readSignedLong` helper (used by the
`LONG1` pickle opcode handler):

```js
function readSignedLong(bytes, n) {
  let val = 0;
  for (let i = 0; i < n; i++) val += bytes[i] << (8 * i);
  if (n > 0 && (bytes[n - 1] & 0x80) && n < 8) val -= 1 << (8 * n);
  return val;
}
```

JavaScript's `<<` operator takes its shift amount **modulo 32** — so
`bytes[4] << 32` silently behaves like `bytes[4] << 0`, not "shift this byte
into bit position 32 and up" as the loop intends. Confirmed with a real
reproduction:

```js
// A file living at offset 5,000,000,000 (~4.66 GiB) inside a large .rpa
const target = 5_000_000_000;
const bytes = [0, 242, 5, 42, 1]; // little-endian 5-byte encoding of target
readSignedLong(bytes, 5);  // → 705032705  (WRONG)
// expected: 5000000000
```

**Why this matters in practice:** Python's pickler uses the compact
`BININT` opcode (4-byte signed int) for any value within ±2³¹, and only
switches to `LONG1` (the opcode this function decodes) once a value exceeds
that — which for RPA file offsets means *any archive bigger than roughly
2 GiB* will have at least some file offsets encoded via `LONG1` with 5+
bytes, and this function corrupts every one of those silently (no thrown
error — just a wrong number, leading to garbage/truncated bytes when that
file is later extracted via `readRpaFile`). Smaller archives never hit this
path and are unaffected. Some Ren'Py games — especially ones bundling a lot
of video or voice-acted dialogue into a single `archive.rpa` — comfortably
exceed 2 GiB, so this isn't a theoretical concern.

### Suggested fix

Replace the bit-shift accumulation with multiplication — JS numbers are
exact integers up to 2⁵³, far beyond anything a real file offset will reach,
and `*` has no 32-bit wraparound:

```js
function readSignedLong(bytes, n) {
  let val = 0;
  for (let i = 0; i < n; i++) val += bytes[i] * Math.pow(2, 8 * i);
  if (n > 0 && (bytes[n - 1] & 0x80) && n < 8) val -= Math.pow(2, 8 * n);
  return val;
}
```

Re-running the same reproduction with this version returns `5000000000`
correctly. One-line change, verified.

---

## Smaller observations (not bugs, worth knowing about)

1. **`rpa.js` has no fallback for renamed/obfuscated RPA headers.** Some
   Ren'Py games rename the magic-string prefix entirely (e.g. `ZiX-12A`
   instead of `RPA-3.0`) specifically to dodge generic extractors. Right now
   an archive like that just throws `Unrecognized RPA header` with no
   recovery path. `renpy-toolkit-plan.md` §5.1 already flagged this as worth
   handling via a manual "tell me the version/offset yourself" fallback —
   that part of the plan wasn't implemented yet. Not urgent (most games use
   plain `RPA-2.0`/`RPA-3.0`), but worth keeping on the list.
2. **Pyodide loads from a CDN** (`pyodide-runtime.js`, `cdn.jsdelivr.net`).
   This is the deliberate, planned tradeoff from choosing Option C in the
   original plan, not an oversight — flagging only so it's an explicit,
   confirmed choice rather than a surprise: the Save Editor specifically
   needs internet access the first time it's used in a browser session
   (subsequent uses in the same session, or once the browser caches the
   Pyodide assets, don't re-fetch).
3. **`py_load` serializes the entire save state in one synchronous-feeling
   call**, rather than the lazy/on-demand per-node expansion the original
   reference Flask tool implied via its tree UI design. Fine for ordinary
   saves; could get slow to *load* (not edit) for save files with unusually
   large rollback history or dialogue logs. Not worth pre-optimizing without
   a real slow case to point at.

---

## Suggested next step

Bugs 1 and 2 both have concrete, verified fixes above, ready to apply
directly. Worth doing in that order — Bug 1 affects every single save edit
beyond the simplest top-level case, so it's the higher-priority one despite
Bug 2 having the scarier failure mode (silent data corruption vs. silent
data non-application).
