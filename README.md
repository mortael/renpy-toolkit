# Ren'Py Toolkit

A browser-based toolkit for exploring and editing **your own** Ren'Py game files. Nothing is uploaded — everything runs locally in the browser.

Sibling project to the RPG Maker MV/MZ Toolkit. Same spirit: Asset Browser, Story Browser, Save Editor, and Compare Saves — adapted for Ren'Py's formats (`.rpa` archives, `.rpy` scripts, pickled `.save` files).

## Features

| Mode | What it does |
|------|----------------|
| **Asset Browser** | Browse **all files** from a game folder or `.rpa` archives (images, audio, video, scripts, fonts, etc.). **Load Archive** works without a full folder. Folder tree, grid/list views, text preview for `.rpy`/`.txt`, frame-sequence animation player (Shift+click range select), video thumbnails. Sidebar **Loaded archives** panel (version, file counts, **Extract**). |
| **Story Browser** | Parse `.rpy` / decompiled `.rpyc`: **Variables** (`default`, `$`, `python:`), **Labels** (incoming/outgoing jump graph), **Script files**, **Media refs**, **Characters** (`define Character`), **Dialogue search** (`speaker:id` filter). With a loaded save: variable values + TRUE/FALSE on if/elif lines. Scene/show/play lines preview media. |
| **Save Editor** | Load a Ren'Py `.save` (ZIP + Python pickle), edit variables in a tree UI, export a modified save. Uses Pyodide for real Python unpickling. Lazy tree: complex nodes expand on demand. |
| **Compare Saves** | Pick Save A/B from the loaded game's save list (sidebar or dropdown) or **Open .save file…** for external saves. Python flattens both store trees, then JS diffs variable values with filters. |
| **Recent** | **🕘 Recent** dropdown remembers the last 12 loaded folders/archives (localStorage). Browsers cannot reopen folder paths — choosing a recent entry re-opens the folder or archive picker with a reminder. |

## Quick start

```bash
npm install          # also copies Pyodide → public/pyodide/
npm run dev
```

To refresh the local Pyodide copy manually: `npm run sync-pyodide`

Open the local URL (usually `http://localhost:5173`), then click **Load Game Folder** and select your game's `game/` directory (the folder that contains `script.rpy`, `images/`, `audio/`, etc.). For asset-only work, use **Load Archive** to open one or more `.rpa` / `.rpi` files without the full folder. Previously loaded sessions appear under **🕘 Recent** (re-pick the same folder/archive — paths are not stored).

The loader auto-detects:

- **`.rpy` files** → Story Browser parsing
- **`.rpyc` only** (no sibling `.rpy`) → Pyodide decompile → same Story Browser pipeline (first load may take a few seconds)
- **`.rpa` / `.rpi` archives** → virtual file index for assets
- **`.save` files** in `saves/` (including `persistent.save`) → Save Editor with a **save picker** in the left sidebar; Compare Saves can use the same list for A/B

Use **Load Save** separately if you have a save file outside the loaded folder.

Build for production:

```bash
npm run build      # output in dist/
npm run preview    # serve dist/ locally
npm test           # RPA parser + image-tag alias tests
```

A test game is included at `testgame/game/` (Wet Nightmares) for local development.

## Requirements & limitations

- **Modern browser** with folder-picker support (`webkitdirectory`).
- **Pyodide (Save Editor)** — bundled locally after `npm install` (`public/pyodide/`, copied from the `pyodide` npm package). Works offline once synced. Falls back to jsDelivr CDN if the local copy is missing.
- **Story Browser parsing is shallow** — not a full Ren'Py AST. `.rpyc`-only games are supported via in-browser decompilation (RPYC2 → pseudo-`.rpy`); quality matches the hand-written line parser, not `unrpyc`. When both `.rpy` and `.rpyc` exist, `.rpy` wins. `image tag = other_tag` alias chains are resolved for media previews; `show`/`scene` lines use the full tag name (e.g. `mom happy`).
- **Variable cross-references are heuristic** — regex-based; dynamic names (`getattr(store, name)`) may be missed.
- **RPA support** — `RPA-1.0` (`.rpa` + `.rpi` pairs), `RPA-2.0`–`RPA-4.0`, `ALT-1.0`, renamed headers (`RWA-3.0`, `SVAC-1.0`), and generic `PREFIX offset [keys…]` layouts. `ZiX-12A`/`12B` auto-retry when `loader.rpy` is in the loaded folder. Unrecognized archives open a **manual parse** dialog (tip: `python rpatool.py -l archive.rpa`).
- **Large archives (>2 GiB)** — multi-byte pickle offsets decode correctly.

## How loading works

One primary **Load Game Folder** action (by design — avoids the overlapping load buttons problem from the RPG Maker toolkit). You can click it multiple times to merge additional folder selections.

```
Load Game Folder
  ├─ index disk files (images/, audio/, .rpy, .rpyc, …)
  ├─ parse .rpa → virtual entries in fileIndex
  ├─ parse .rpy (or decompile .rpyc-only) → storyData
  ├─ find saves/ → init Pyodide → load save (or picker)
  └─ record session in 🕘 Recent (localStorage)
```

## Project layout

```
renpy-toolkit/
├── index.html          # App shell
├── public/
│   ├── save_logic.py   # Python pickle + compare flatten (Pyodide)
│   └── rpyc_logic.py   # RPYC2 decompiler → pseudo-.rpy (Pyodide)
├── src/                # JS modules — see codebase.md
├── testgame/game/      # Sample game for dev/testing
├── renpy-toolkit-plan.md   # Original design doc
└── REVIEW_FINDINGS.md      # External code review (bugs fixed)
```

## Documentation

- **[codebase.md](./codebase.md)** — architecture, module map, data flow, extension notes.
- **[renpy-toolkit-plan.md](./renpy-toolkit-plan.md)** — original planning document and format notes.

## Privacy

All processing is client-side. Game files, saves, and edits never leave your machine.