# Ren'Py Toolkit — Project Plan

This is a planning document, written before any code exists. It's meant to be
handed to a future session (yours or another AI's) to start this project
without re-deriving everything from scratch. It assumes the reader has no
context beyond this file — if you're an AI picking this up, read the whole
thing before writing code.

**Status: not started, but de-risked.** This describes a sibling project to
the already-built **RPG Maker MV/MZ Toolkit** (Save Editor + Story Browser +
Asset Browser + Compare Saves, built with Vite + vanilla JS modules — see
that project's `codebase.md` for the full architecture, which this project
should largely *reuse*, not reinvent). Unlike when this plan was first
written, the hardest unsolved piece (safe, generic save-file editing) now
has a **working reference implementation** sitting alongside this file:
`reference-renpy-save-editor.py`, a local Flask tool, already built and
used. Read §5.3 for what it does and the three ways to build on it.

---

## 1. Goal

Build the same category of tool — save editing, story/script browsing with a
flag cross-reference, asset browsing/extraction — but for **Ren'Py** games
instead of RPG Maker MV/MZ games. Same spirit, same target audience (a player
wanting to understand/explore/edit their own save and the game's content),
same "runs entirely in the browser, nothing uploaded anywhere" constraint.

## 2. Why this is a separate project, not a port

RPG Maker MV/MZ and Ren'Py are different enough at a data-format level that
almost none of the *parsing* code transfers, even though the *UI patterns* and
*overall architecture* absolutely should be reused. The differences, by
component:

| | RPG Maker MV/MZ (done) | Ren'Py (this project) |
|---|---|---|
| Save format | `LZString.compressToBase64(JSON.stringify(obj))` — trivial to decode in JS | ZIP file containing a **pickled Python object** — pickle is a much richer, dynamic, code-adjacent format. No JS-native equivalent. |
| Switches/variables | Fixed-size arrays, numeric IDs, named via `System.json` | No fixed list at all — flags are arbitrary Python variable names assigned anywhere, including inside free-form Python blocks |
| Script/event format | Structured JSON, numeric command codes (`code: 101`, `code: 401`, etc.) | A custom Python-like scripting language (`.rpy`), or compiled bytecode (`.rpyc`) if source isn't shipped |
| Asset encryption | Fixed, documented 16-byte-header XOR scheme, same for every MV/MZ game | Often **no encryption at all** (plain `.png`/`.ogg`); if archived, a different simple format (`.rpa`), not XOR |

The asset side is easy and very transferable. The script side is medium
difficulty and structurally different. The save side looked like the hard
part, but a working reference implementation (see §5.3) found a
meaningfully better strategy than this document originally assumed —
"safely substitute every class with an inert generic stand-in during
unpickling" rather than "patch known primitive byte ranges in place." Read
§5.3 before starting; the scoping below reflects that update.

## 3. Recommended build order (mirrors how the RPG Maker toolkit grew)

Build in this order. Each phase is independently useful — don't block on
later phases.

1. **Asset Browser** (highest confidence, do this first — and most of its UI
   layer doesn't need to be designed at all, just ported: see §5.1a)
2. **Story Browser** (medium difficulty, *only if* `.rpy` source is available
   for the target game — see §6 open question)
3. **Save Editor** (a working reference implementation already exists for
   the hard part — see §5.3 — pick an implementation path (A/B/C) and either
   port or directly reuse it)
4. **Compare Saves** — once the Save Editor can parse a save into a flat
   variable dict, the diff algorithm from the RPG Maker toolkit
   (`flattenForDiff`/`diffFlat`/`groupDiffChanges` in `compare-saves.js`) is
   almost directly reusable as-is, since by that point both projects are just
   diffing "flat dict of variable name → value."

---

## 4. Suggested architecture — reuse the RPG Maker toolkit's setup

Don't redesign this part. Copy the pattern:

- **Vite**, vanilla JS modules, no framework. Same `npm run dev` / `npm run
  build` → `dist/` workflow.
- **The `store` pattern**: one shared mutable object in `state.js`, every
  other module imports `{ store }` and mutates its properties directly.
  Read the RPG Maker toolkit's `codebase.md` §3 for the *why* (ES module
  live-bindings are read-only from importing modules; a shared object
  sidesteps that).
- **Per-concern file split**: something like `decrypt.js` (RPA unpacking, see
  §5.1), `script-parser.js` (`.rpy` parsing, see §5.2), `save-parser.js`
  (pickle class-substitution + serialize/patch-scalars/re-pickle, see §5.3 —
  port the pattern from `reference-renpy-save-editor.py`, not "bytecode
  patching" as an earlier draft of this section suggested), `asset-browser.js`,
  `story-browser.js`, `save-editor.js`, `modal.js`, `main.js`. Naming doesn't
  need to match exactly, but keep the same "one job per file, a few hundred
  lines max" discipline.
- **Same library choices where they transfer**: `jszip` is still useful here
  (regular `.zip`-based saves, and possibly for reading `.rpa` if you end up
  representing it as a virtual archive — though `.rpa` is its own format, see
  §5.1, so you'll likely write a small dedicated parser rather than using
  JSZip for it).
- **Same testing approach**: no permanent test suite checked in; verify with
  a temporary Node script + a minimal DOM shim that exercises the pure-logic
  functions against a real sample file, then delete it before final delivery.
  See the RPG Maker toolkit's `codebase.md` §8 for the exact shim code.
- **Load UI lesson learned, apply from the start**: the RPG Maker toolkit
  initially shipped four separate load buttons (save, data.zip, System.json,
  game folder) and this turned out to be genuinely confusing — "Load Game
  Folder" alone could already auto-detect everything else, making the
  separate data.zip button pure redundancy. It was removed entirely once
  that became clear. For this project: lead with **one** primary "Load Game
  Folder" action that auto-detects whatever it can (`.rpy`/`.rpyc` source,
  `.rpa` archives, save files), with "Load Save" as the only other
  first-class button (for a save that didn't come bundled with the folder).
  Don't add a separate lightweight loader for some narrower subset "just in
  case" unless a real, distinct use case shows up in practice — it's easy to
  end up with overlapping buttons that all do almost the same thing.

---

## 5. Technical reference (research already done — don't re-derive this)

### 5.1 Asset archives (`.rpa` format)

Ren'Py games either ship assets unpacked (plain files in `images/`, `audio/`,
etc. inside the `game/` folder — directly browsable, no work needed beyond
what the existing Asset Browser code already does) or packed into one or more
`.rpa` archive files (commonly `archive.rpa`, or split like `archive-1.rpa`).

`.rpa` is **not encrypted at the file-content level** — only the *index's*
offset/length values are XOR-obfuscated, the actual asset bytes inside are
stored verbatim. Verified format (multiple independent reference
implementations agree on this):

- **Header**: a single text line, e.g. `RPA-3.0 <16-hex-char offset>
  <8-hex-char key>\n` for RPA-3.0 (RPA-3.2 has additional hex sub-keys after
  it, XOR-folded together into one key; RPA-2.0 has the offset but no key —
  nothing is obfuscated, key is effectively `0`; RPA-1.0/4.0 and oddball
  variants like `ALT-1.0`/`ZiX-12A`/`ZiX-12B` exist too — some games
  deliberately rename the magic-string prefix to dodge generic extractors,
  per a Ren'Py-community forum thread on "how to obfuscate your RPA files" —
  worth handling as "if the recognized prefixes don't match, let the user
  manually specify the version/offset" rather than silently failing).
- **Index**: seek to the header's offset, read to EOF, zlib-decompress, then
  pickle-deserialize. This decodes to a plain dict:
  `{ "path/to/file.png": [(offset, length)], ... }` (or a 3-tuple
  `(offset, length, prefix)` in some versions, where `prefix` is a short
  byte-string literally prepended to the file's data on read). **This is a
  pickle, but a small, fixed, well-known structure** (just a dict of
  string → list of int-tuples) — far simpler than the save file's pickle
  problem in §5.3. You only need to handle the opcodes that appear in this
  specific shape (dict/list/tuple/int/string construction), not a general
  unpickler.
- **De-obfuscation**: if a key is present (non-zero), XOR both `offset` and
  `length` from every index entry against it before use. The file's actual
  bytes are then just `rawArchiveBytes.slice(offset, offset + length)`
  (with `prefix` bytes prepended first, if present) — no further decoding.

**Action item before writing code:** don't reimplement this from a verbal
description — read the source of `Lattyware/unrpa` (Python, actively
maintained, handles `RPA-1.0` through `RPA-4.0` plus the renamed-prefix
variants) directly when implementing, to get every version's exact byte
layout right. Treat it as the reference implementation, not a thing to
re-derive from scratch.

### 5.1a The Asset Browser UI layer is asset-format-agnostic — port it directly

Since this plan was first written, the RPG Maker toolkit's Asset Browser
grew several features that have **nothing to do with RPG Maker specifically**
— they operate purely on `{ relPath, file }` entries plus a `getAssetKind()`
classification, both of which a Ren'Py asset source can produce just as well
as the RPG Maker one. Don't redesign these — port the UI/interaction code
near-verbatim once a Ren'Py `decrypt.js`-equivalent (RPA-reading, see §5.1)
produces the same entry shape:

- **Folder tree view, not a flat list** (`buildFolderTree`/`collectAllFiles`/
  `findNodeByPath` in `asset-browser.js`): a real expand/collapse hierarchy
  where selecting a parent folder shows every file in it *and every
  subfolder recursively combined*, rather than only files sitting directly
  in that exact folder. Worth noting a real bug that was hit and fixed here:
  don't re-run "auto-expand ancestors of the current selection" on *every*
  render — only at the moment a folder is actually clicked — or collapsing
  any ancestor of the current selection becomes impossible (the very next
  render silently re-expands it).
- **Sort by name/size/date, both directions** (`sortEntries` +
  `formatFileSize`/`formatFileDate`): trivial once you have a `File`-like
  object per entry (`.size`/`.lastModified` — note a real Ren'Py archive
  member won't naturally have these, since it's just a byte range inside one
  big `.rpa` file, not a separate filesystem `File` — you'll need to
  synthesize a comparable size/date proxy, e.g. the byte length from the RPA
  index and the archive file's own `lastModified`/a constant, if you want
  sort-by-size/date to work for archived assets too. Unpacked loose files do
  have real `File` objects and work as-is.)
- **Selection mode + numbered-frame-sequence detection + an FPS-adjustable
  animation player** (`animation-player.js`: `naturalCompare` for
  "Frame2 before Frame10" ordering, `detectSequences` for auto-grouping
  `Explosion_01..Explosion_12`-style files, `openAnimationPlayer` for the
  actual play/pause/scrub/loop/FPS modal). This came from RPG Maker games
  routinely storing animations as loose numbered frame images rather than a
  video — worth checking whether the target Ren'Py game does the same
  (common for older/simpler Ren'Py projects; newer ones more often use real
  video files or Ren'Py's built-in `ATL`-based transitions instead, in which
  case this feature has nothing to detect and is simply inert/unused, which
  is fine — no harm in including it regardless).
- A real bug worth knowing about in advance: a naive "stop playback when the
  modal closes" implementation that attaches a `click` listener to the modal
  backdrop will also catch clicks that bubble up from buttons *inside* the
  modal (e.g. the play button itself), immediately undoing whatever the
  click just did. The fix that shipped: don't add extra listeners for this at
  all — have the playback interval's own tick check whether the modal is
  still marked visible, and stop itself if not.

None of the above needs to wait for the harder RPA/script-parsing work to be
finished — it can be built and verified against a folder of *plain, unpacked*
Ren'Py image files first, exactly like the asset side of this project was
recommended to be tackled first in §3.

### 5.2 Script format (`.rpy` source / `.rpyc` bytecode)

**If `.rpy` source is shipped** (check the target game's `game/` folder for
`.rpy` files alongside `.rpyc` — many devs ship both, some ship only `.rpyc`):
it's plain text, a custom indentation-based language. Rough shape:
```
label start:
    scene bg_bedroom
    show mom happy
    mom "Good morning!"
    menu:
        "Ask about breakfast":
            jump breakfast_scene
        "Leave":
            jump hallway
    if mom_affection >= 50:
        jump mom_special_scene
    $ mom_affection += 1
    python:
        some_arbitrary_python_code()
```
A hand-written parser (not a full Python-grammar parser — just enough to
recognize `label`, `jump`, `call`, `menu`/choice blocks, `if`/`elif`/`else`,
dialogue lines (`character_name "text"` or just `"text"`), and `$`/`python:`
blocks as opaque-but-displayed code) is a reasonable scope. **There is no
fixed enumerable switch/variable list** — the practical cross-reference
strategy is regex-based: scan all `.rpy` files for `$ varname = ...` /
`varname = ...` (assignment) and `varname` appearing inside `if`/`elif`
conditions (reference), bucket by variable name. This will miss dynamically
constructed variable names and anything set deep inside non-trivial Python
logic — acceptable, document the limitation in the UI rather than promising
RPG-Maker-level precision.

**If only `.rpyc` bytecode is shipped:** do not write a Ren'Py bytecode
decompiler from scratch — that's a substantial standalone project (Ren'Py's
bytecode is versioned, has changed across engine releases, and target-game
custom AST node types/transforms add to the complexity). The established
community tool for this is **`unrpyc`** (Python). Practical recommendation:
treat decompilation as an out-of-band manual step the user runs once (e.g.
"run `unrpyc` on the game folder, then point our tool at the resulting `.rpy`
files") rather than a feature of this toolkit. Revisit only if this
limitation turns out to block real usage.

### 5.3 Save format — UPDATE: a working reference implementation exists

**This section was rewritten after a concrete, working Python tool became
available** (`reference-renpy-save-editor.py` in this same folder — a local
Flask app, already built and in use). It demonstrates a meaningfully better
approach than the "bytecode patching" strategy this section originally
recommended. Read that file before implementing anything — it's the ground
truth, this is just an explanation of the pattern it uses.

A Ren'Py `.save` file is a ZIP archive containing a member called `log`
(the actual game state, pickled — `pickle.Pickler(buf, protocol=2).dump((store,
rollback))`, confirmed from the reference script's `save_to_bytes`), plus a
few small text/metadata members (`json`, `extra_info`, `renpy_version`,
`screenshot.png`) that can be read/written completely untouched.

**The better pattern — "safe generic substitution" instead of byte patching:**
Python's `pickle.Unpickler` exposes a `find_class(module, name)` hook that
controls *what class gets instantiated* for every object reference in the
stream. The reference script overrides this hook so that:
- `RevertableDict`/`RevertableList`/`RevertableSet`/`SlottedNoRollback` (Ren'Py's
  own rollback-aware container types, mentioned in Ren'Py's own save docs) map
  to thin `dict`/`list`/`set` subclasses that just accept whatever pickle
  tries to restore into them via `__setstate__`, ignoring it harmlessly where
  it doesn't apply.
- **Every other class name** (regardless of what it actually is — a game's
  own `Character`/`Person` class, an achievement tracker, anything) maps to a
  *dynamically created stand-in class* (`FlexObj`) whose `__init__` does
  nothing and whose `__setstate__` just dumps whatever dict pickle was going
  to apply into `self.__dict__`.

The result: the **entire** object graph — arbitrarily deep, including custom
class instances — comes back as inert, fully-introspectable Python objects,
with zero risk of any real game/engine code executing, and *without ever
needing to know what any of those classes actually do*. This is strictly
better than the byte-patching approach: byte-patching only safely reaches
primitives sitting at a known, fixed-width location; this reaches everything,
generically, recursively, lazily-rendered to the UI on expand (see the
script's `_serialize_value`/`renderTree`/`loadChildren` for the recursive,
paginated tree-browser pattern — worth reusing the *design*, e.g. lazy
per-node expansion and pagination for huge lists, even if the implementation
language changes).

**Editing & round-trip**: edits are restricted to scalars (bool/int/float/str)
via `_deserialize_scalar` — nested complex objects are browsable and
deletable (`deleteKey`/`deleteGroup` in the script) but not restructured.
Saving re-pickles the *same* `FlexObj`/`FlexList`/etc. graph with the standard
`pickle.Pickler` — this works because `_make_flex`/`_ensure_module` gave every
stand-in class the **same** `__module__`/`__qualname__` as the original real
class, so the re-emitted pickle bytes reference the same class path Ren'Py
expects. When the actual game loads the file later, **its** real unpickler
(with the real classes available) reconstructs everything normally — our
stand-ins never need to round-trip through the real game's Python process,
only through pickle's byte format.

#### Three implementation paths — pick one before starting

**A. Port this pattern to a from-scratch JS pickle reader/writer.**
Fits the "no backend, just a static bundle" philosophy the RPG Maker toolkit
established. Real effort: you're writing a small pickle-opcode interpreter
(`GLOBAL`/`STACK_GLOBAL`, `REDUCE`, `BUILD`, `EMPTY_DICT`, `EMPTY_LIST`,
`MARK`, `TUPLE*`, `SETITEM(S)`, `APPEND(S)`, `NEWOBJ`, the various int/float/
string/binary opcodes — get the exact byte-level spec from Python's own
`pickletools` source/docs at implementation time, not from memory) *and* a
writer that re-emits equivalent opcodes from your in-memory tagged-object
representation. The "tag everything generically instead of instantiating"
trick ports directly: instead of Python's dynamic-class-per-name dance, a JS
node would just be `{ __pickleClass: "module.Name", __state: {...} }` —
arguably simpler in JS than the Python original, since you don't need to
fake a module/class system, just a plain tagged object. Real but bounded
effort; the existing script removes essentially all of the *design risk*,
what's left is implementation work.

**B. Keep the existing Python/Flask tool as its own thing.**
Zero new work for the Save Editor. Means the eventual "Ren'Py toolkit" is
two separate apps (a static JS bundle for Story/Asset browsing, a small
local Flask app — `python renpy_save_editor.py` — for saves) rather than one
unified tool. Pragmatic if shipping one combined app isn't actually
important to the end goal.

**C. Run the existing Python code unmodified, in-browser, via Pyodide.**
**Worth strongly considering — possibly the best option.** Pyodide is CPython
compiled to WebAssembly, runs in any modern browser, no install, no server,
and includes the full standard library — `pickle`, `zipfile`, `io`, `types`,
`sys` are all stdlib, no C-extension dependencies, so `reference-renpy-save-
editor.py`'s actual unpickling/pickling logic should run **basically
unchanged** once Flask's HTTP-request plumbing is swapped for direct
JS-to-Python calls (Pyodide lets JS call Python functions and exchange data
directly — no need to literally run a Flask dev server inside the
WebAssembly sandbox, just lift the `load_save`/`save_to_bytes`/
`_serialize_value`/`_deserialize_scalar` functions out and call them from JS
glue code instead of Flask routes). This gets you: zero pickle-format risk
(it's the *real* `pickle` module, not a reimplementation that might be subtly
wrong on some opcode), almost all of the already-written/working logic
reused as-is, and still satisfies "no backend, runs from a static bundle"
(Pyodide loads from a CDN or bundled `.whl`/wasm assets, no server process).
Tradeoff: Pyodide's runtime is a real download (order of 10-20MB,
first-load init time of a few seconds) — almost certainly an acceptable cost
for a tool the user runs locally for their own save editing, but worth
sizing/testing before committing.

**Recommendation if forced to choose without further input: C.** It captures
nearly all of B's "zero new risk, already works" benefit while still
matching A's "single static client-side bundle" architectural goal. Only
fall back to A if Pyodide's bundle size/init time turns out to be a real
problem in practice, or to B if a unified single-app deliverable isn't
actually a requirement.

---

## 6. Open questions to resolve before/while starting

Ask the user (or check yourself if files are already provided) before
committing to a scope:

1. **What does the target game's folder actually contain?**
   - `game/*.rpy` (source available) or only `game/*.rpyc` (compiled only)?
   - Assets unpacked in `game/images/`, `game/audio/`, etc., or packed into
     `game/archive.rpa` (or similarly named)?
2. **Roughly how large is the game's script?** (file count / total `.rpy`
   line count, if source is available) — affects how much the regex-based
   variable cross-reference needs tuning/scoping vs. how good "good enough"
   actually is in practice.
3. **Is there a specific save file available to test against?** Get one
   early — this part needs real test data, same as the RPG Maker toolkit's
   decrypt logic needed a real `.rpgmvp` file before it could be trusted (see
   that project's conversation history / `codebase.md` §8 for how that
   verification was done). `reference-renpy-save-editor.py` already works
   against at least one real save (whatever the person has used it on
   before) — start there rather than sourcing a new one blind.
4. **Which implementation path for the Save Editor — A, B, or C (§5.3)?**
   This is a real fork, not a detail: it decides whether the eventual
   project is one unified static bundle (A or C) or two separate tools (B).
   Don't default silently — confirm with the person before sinking time into
   a from-scratch JS pickle implementation (A) if they'd be just as happy
   with C (much less new code, same "no server" outcome) or even fine with B
   (already working, zero new code, just a separate app to launch).
   §8 for how that verification was done).

---

## 7. Honest scope/risk summary

- **Asset Browser**: low risk, high confidence, build first.
- **Story Browser**: medium risk if `.rpy` source exists (manageable, scoped
  text parser); **out of scope** (defer to existing external tools) if only
  `.rpyc` is shipped.
- **Save Editor**: lower risk than originally assessed — a working Python
  reference implementation (`reference-renpy-save-editor.py`) already
  demonstrates a clean, generically-safe strategy (class substitution during
  unpickling, see §5.3) rather than the byte-patching this document
  originally proposed. Remaining work is a path choice (A: port to JS, B:
  keep as a separate Python tool, C: run the existing Python in-browser via
  Pyodide — recommended) plus implementation/testing, not open algorithm
  design.
- **Compare Saves**: low risk, mostly free once the Save Editor's parser
  exists, since the diffing algorithm is generic.

This is a multi-session project, same as the RPG Maker toolkit was. Don't try
to build all of it in one sitting — ship the Asset Browser, confirm it works
against real game files, then move to the next phase.