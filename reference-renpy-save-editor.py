#!/usr/bin/env python3
"""
Ren'Py Save Editor
Run: python renpy_save_editor.py [savefile.save]
Then open http://localhost:5171
"""
import io, json, os, pickle, sys, types, zipfile
from pickle import _Unpickler
from flask import Flask, jsonify, request, send_file, Response

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 50 * 1024 * 1024

# ── Pickle machinery ───────────────────────────────────────────────────────────
class FlexObj:
    def __init__(self, *a, **kw): pass
    def __setstate__(self, d):
        if isinstance(d, dict): self.__dict__.update(d)
        else: self._state = d

class FlexList(list):
    def __setstate__(self, d): pass

class FlexDict(dict):
    def __setstate__(self, d):
        if isinstance(d, dict): self.update(d)

class FlexSet(set):
    def __setstate__(self, d): pass

_class_registry = {}

def _ensure_module(module):
    parts = module.split(".")
    cur = ""
    for part in parts:
        parent, cur = cur, (cur + "." if cur else "") + part
        if cur not in sys.modules:
            m = types.ModuleType(cur)
            sys.modules[cur] = m
            if parent: setattr(sys.modules[parent], part, m)

def _make_flex(module, name):
    key = (module, name)
    if key in _class_registry: return _class_registry[key]
    _ensure_module(module)
    cls = type(name, (FlexObj,), {"_qname": f"{module}.{name}", "_module_name": module})
    cls.__module__, cls.__qualname__ = module, name
    setattr(sys.modules[module], name, cls)
    _class_registry[key] = cls
    return cls

def _register_flex(base_cls, module, name):
    key = (module, name)
    if key in _class_registry: return _class_registry[key]
    _ensure_module(module)
    cls = type(name, (base_cls,), {})
    cls.__module__, cls.__qualname__ = module, name
    setattr(sys.modules[module], name, cls)
    _class_registry[key] = cls
    return cls

class SafeUnpickler(_Unpickler):
    def find_class(self, module, name):
        if name in ("RevertableList", "SlottedNoRollback"):
            return _register_flex(FlexList, module, name)
        if name == "RevertableDict":  return _register_flex(FlexDict, module, name)
        if name == "RevertableSet":   return _register_flex(FlexSet, module, name)
        return _make_flex(module, name)

def load_save(raw):
    zf = zipfile.ZipFile(io.BytesIO(raw))
    log_data = zf.read("log")
    extras = {n: zf.read(n) for n in zf.namelist() if n != "log"}
    store, rollback = SafeUnpickler(io.BytesIO(log_data)).load()
    return store, rollback, extras

def save_to_bytes(store, rollback, extras):
    buf = io.BytesIO()
    pickle.Pickler(buf, protocol=2).dump((store, rollback))
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("log", buf.getvalue())
        for n, d in extras.items(): zf.writestr(n, d)
    return out.getvalue()

# ── Serialization (unbounded depth, lazy on demand) ───────────────────────────
def _serialize_value(v):
    if v is None:   return {"t": "null"}
    if isinstance(v, bool): return {"t": "bool", "v": v}
    if isinstance(v, int):  return {"t": "int",  "v": v}
    if isinstance(v, float):return {"t": "float","v": v}
    if isinstance(v, str):  return {"t": "str",  "v": v}
    if isinstance(v, (list, FlexList)):
        return {"t": "list", "len": len(v),
                "children": [_serialize_value(i) for i in v]}
    if isinstance(v, (dict, FlexDict)):
        return {"t": "dict", "len": len(v),
                "children": {str(k): _serialize_value(vv) for k, vv in v.items()}}
    if isinstance(v, FlexSet):
        return {"t": "set", "len": len(v), "items": [repr(i) for i in v]}
    if isinstance(v, FlexObj):
        d = {k: vv for k, vv in v.__dict__.items() if not k.startswith("_module")}
        qname = getattr(type(v), "_qname", type(v).__name__)
        return {"t": "obj", "cls": qname,
                "children": {k: _serialize_value(vv) for k, vv in d.items()}}
    if isinstance(v, tuple):
        return {"t": "tuple", "len": len(v),
                "children": [_serialize_value(i) for i in v]}
    return {"t": "raw", "v": repr(v)[:300]}

def _deserialize_scalar(node, original):
    t = node.get("t")
    if t == "null":  return None
    if t == "bool":  return bool(node["v"])
    if t == "int":   return int(node["v"])
    if t == "float": return float(node["v"])
    if t == "str":   return str(node["v"])
    return original  # complex types unchanged

# ── App state ─────────────────────────────────────────────────────────────────
_state = {"store": None, "rollback": None, "extras": None, "filename": None}

# ── HTML ──────────────────────────────────────────────────────────────────────
HTML = r"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Ren'Py Save Editor</title>
<style>
@import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:ital,wght@0,300;0,400;0,500;0,600;1,400&family=Syne:wght@400;600;700&display=swap');
:root {
  --bg:#0c0e13; --s1:#131720; --s2:#181d28; --s3:#1d2335;
  --b1:#222840; --b2:#2c3454; --b3:#3a4270;
  --acc:#7c6af7; --acc2:#a78bfa; --acc3:#c4b5fd;
  --grn:#34d399; --red:#f87171; --amb:#fbbf24; --cyn:#38bdf8; --pnk:#f472b6; --org:#fb923c;
  --t1:#e2e8f0; --t2:#94a3b8; --t3:#64748b; --t4:#3e4a63;
  --mono:'JetBrains Mono',monospace; --sans:'Syne',sans-serif;
}
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
html,body{height:100%}
body{background:var(--bg);color:var(--t1);font-family:var(--sans);font-size:14px;display:flex;flex-direction:column;height:100vh;overflow:hidden}

/* header */
header{background:var(--s1);border-bottom:1px solid var(--b1);padding:0 20px;height:52px;display:flex;align-items:center;gap:12px;flex-shrink:0;z-index:50}
.logo{font-family:var(--mono);font-size:12px;font-weight:600;color:var(--acc2);letter-spacing:.08em;white-space:nowrap}
.logo em{color:var(--t3);font-style:normal;font-weight:300}
.spacer{flex:1}
.badge{font-family:var(--mono);font-size:11px;color:var(--t2);background:var(--s2);border:1px solid var(--b1);padding:3px 10px;border-radius:4px;max-width:240px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.btn{font-family:var(--sans);font-size:12px;font-weight:600;padding:5px 14px;border-radius:6px;border:none;cursor:pointer;transition:all .15s;white-space:nowrap;letter-spacing:.02em}
.btn-p{background:var(--acc);color:#fff} .btn-p:hover{background:var(--acc2)}
.btn-g{background:transparent;color:var(--t2);border:1px solid var(--b2)} .btn-g:hover{border-color:var(--acc);color:var(--acc2)}
.btn-s{background:var(--grn);color:#071a10} .btn-s:hover{filter:brightness(1.1)}
.btn-r{background:transparent;color:var(--red);border:1px solid #3d2020} .btn-r:hover{background:#3d2020}

/* drop zone */
#dropzone{flex:1;display:flex;align-items:center;justify-content:center}
#dropzone.hidden{display:none}
.dropbox{width:380px;border:2px dashed var(--b2);border-radius:14px;padding:44px 28px;text-align:center;cursor:pointer;transition:all .2s;background:var(--s1)}
.dropbox:hover,.dropbox.drag{border-color:var(--acc);background:var(--s2)}
.drop-ico{font-size:44px;margin-bottom:14px;display:block}
.drop-t{font-size:17px;font-weight:700;margin-bottom:6px}
.drop-s{color:var(--t2);font-size:12px}

/* main layout */
#main{flex:1;display:flex;flex-direction:column;overflow:hidden}
#main.hidden{display:none}

/* toolbar */
.toolbar{background:var(--s1);border-bottom:1px solid var(--b1);padding:8px 20px;display:flex;align-items:center;gap:10px;flex-wrap:wrap;flex-shrink:0}
.sw{position:relative;flex:1;min-width:160px;max-width:280px}
.sw svg{position:absolute;left:9px;top:50%;transform:translateY(-50%);color:var(--t3);pointer-events:none}
#search{width:100%;background:var(--s2);border:1px solid var(--b1);color:var(--t1);font-family:var(--mono);font-size:11px;padding:5px 9px 5px 30px;border-radius:6px;outline:none;transition:border-color .15s}
#search:focus{border-color:var(--acc)}
.pills{display:flex;gap:5px;flex-wrap:wrap}
.pill{font-size:11px;font-weight:600;padding:3px 10px;border-radius:20px;border:1px solid var(--b2);cursor:pointer;background:transparent;color:var(--t2);transition:all .15s;font-family:var(--sans);letter-spacing:.02em}
.pill.on{background:var(--acc);color:#fff;border-color:var(--acc)}

/* stats */
.statsbar{font-family:var(--mono);font-size:10px;color:var(--t3);padding:4px 20px;border-bottom:1px solid var(--b1);display:flex;gap:12px;flex-shrink:0;background:var(--s2)}
.statsbar b{color:var(--t2)}

/* scrollable tree area */
.tree-scroll{flex:1;overflow-y:auto;overflow-x:hidden}
::-webkit-scrollbar{width:5px} ::-webkit-scrollbar-track{background:var(--bg)} ::-webkit-scrollbar-thumb{background:var(--b2);border-radius:3px}

/* ── Namespace group ── */
.nsgroup{border-bottom:1px solid var(--b1)}
.nshdr{display:flex;align-items:center;gap:8px;padding:7px 20px;cursor:pointer;background:var(--s2);position:sticky;top:0;z-index:20;transition:background .1s;user-select:none}
.nshdr:hover{background:var(--s3)}
.nsarrow{color:var(--t3);font-size:9px;transition:transform .18s;width:12px;text-align:center}
.nshdr.col .nsarrow{transform:rotate(-90deg)}
.nslabel{font-family:var(--mono);font-size:11px;font-weight:600;color:var(--cyn);flex:1}
.nscount{font-family:var(--mono);font-size:10px;color:var(--t3);background:var(--s1);border:1px solid var(--b1);padding:1px 7px;border-radius:10px}
.nsdelbtn{font-size:10px;padding:2px 8px;border-radius:4px;background:transparent;border:1px solid #3d2020;color:var(--red);cursor:pointer;font-family:var(--sans);transition:all .15s;opacity:0;font-weight:600}
.nshdr:hover .nsdelbtn{opacity:1} .nsdelbtn:hover{background:#3d2020}

/* ── Node rows ── */
.node{display:flex;flex-direction:column}
.node-row{display:flex;align-items:center;min-height:32px;padding:0 20px;border-bottom:1px solid transparent;transition:background .08s;cursor:default}
.node-row:hover{background:var(--s2);border-color:var(--b1)}
.node-row.mod{border-left:2px solid var(--amb)}
.node-row.del{opacity:.35;text-decoration:line-through}
.node-row.fout{display:none}

/* indent levels */
.d0{padding-left:20px}
.d1{padding-left:36px}
.d2{padding-left:52px}
.d3{padding-left:68px}
.d4{padding-left:84px}
.d5{padding-left:100px}

/* expand toggle */
.xbtn{width:18px;height:18px;display:flex;align-items:center;justify-content:center;cursor:pointer;color:var(--t3);font-size:9px;border-radius:3px;transition:all .1s;flex-shrink:0;margin-right:4px}
.xbtn:hover{background:var(--b1);color:var(--t1)}
.xbtn.open{color:var(--acc2)}
.xbtn.leaf{cursor:default;color:transparent}

/* key label */
.nkey{font-family:var(--mono);font-size:11px;color:var(--t2);flex-shrink:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding-right:10px}
.nkey .nspart{color:var(--t4)}
.nkey .idx{color:var(--t3)}

/* type badge */
.tbadge{font-family:var(--mono);font-size:9px;padding:2px 5px;border-radius:3px;flex-shrink:0;margin-right:8px;min-width:38px;text-align:center}
.tb-bool{background:#1a2e22;color:var(--grn)}
.tb-str{background:#162030;color:var(--cyn)}
.tb-int,.tb-float{background:#2a2410;color:var(--amb)}
.tb-null{background:#251530;color:var(--pnk)}
.tb-list,.tb-tuple{background:#161a2e;color:#818cf8}
.tb-dict{background:#161a2e;color:#818cf8}
.tb-set{background:#161a2e;color:#818cf8}
.tb-obj{background:#1e1610;color:var(--org)}
.tb-raw{background:#2a2020;color:var(--red)}

/* value area */
.nval{flex:1;min-width:0}

/* editors */
.ve-bool{display:flex;align-items:center;gap:8px}
.tog{width:36px;height:20px;background:var(--b2);border-radius:10px;position:relative;cursor:pointer;transition:background .18s;border:none;flex-shrink:0}
.tog.on{background:var(--grn)}
.tog::after{content:'';position:absolute;width:14px;height:14px;border-radius:50%;background:#fff;top:3px;left:3px;transition:left .18s}
.tog.on::after{left:19px}
.tog-lbl{font-family:var(--mono);font-size:11px;color:var(--t2)} .tog.on+.tog-lbl{color:var(--grn)}

.ve-edit{font-family:var(--mono);font-size:11px;background:transparent;border:none;color:var(--t1);padding:2px 5px;border-radius:4px;outline:none;width:100%;transition:all .12s}
.ve-edit:hover{background:var(--s2)} .ve-edit:focus{background:var(--s1);border:1px solid var(--acc)}
.ve-edit.s{color:var(--cyn)} .ve-edit.n{color:var(--amb)}

.ve-null{font-family:var(--mono);font-size:11px;color:var(--pnk)}
.ve-cplx{font-family:var(--mono);font-size:10px;color:var(--t3);display:flex;align-items:center;gap:6px}
.ve-cplx .cls{background:var(--s3);color:var(--org);padding:1px 6px;border-radius:3px;font-size:9px}
.ve-cplx .dim{color:var(--t4)}

/* row actions */
.acts{display:flex;gap:4px;opacity:0;transition:opacity .12s;margin-left:8px;flex-shrink:0}
.node-row:hover .acts{opacity:1}
.ab{background:transparent;border:none;cursor:pointer;color:var(--t3);padding:2px 5px;border-radius:3px;font-size:11px;font-family:var(--sans);transition:all .12s}
.ab.d{color:var(--red)} .ab.d:hover{background:#3d2020}
.ab.r:hover{background:var(--s3);color:var(--t2)}

/* children container */
.children{display:none}
.children.open{display:block}

/* pagination */
.pagebar{display:flex;align-items:center;gap:8px;padding:6px 20px 6px 48px;border-bottom:1px solid var(--b1);background:var(--s1)}
.pgbtn{font-family:var(--mono);font-size:11px;padding:3px 10px;border-radius:5px;border:1px solid var(--b2);background:transparent;color:var(--t2);cursor:pointer;transition:all .12s}
.pgbtn:hover{border-color:var(--acc);color:var(--acc2)} .pgbtn.cur{background:var(--acc);color:#fff;border-color:var(--acc)}
.pginfo{font-family:var(--mono);font-size:10px;color:var(--t3)}

/* toast */
#toast{position:fixed;bottom:20px;right:20px;background:var(--s2);border:1px solid var(--b2);border-radius:8px;padding:10px 16px;font-size:12px;z-index:999;transition:opacity .25s;opacity:0;pointer-events:none;font-family:var(--mono)}
#toast.show{opacity:1} #toast.ok{border-color:var(--grn);color:var(--grn)} #toast.err{border-color:var(--red);color:var(--red)}
</style>
</head>
<body>

<header>
  <div class="logo">ren<em>'</em>py <em>//</em> save editor</div>
  <div class="spacer"></div>
  <div class="badge" id="badge">no file loaded</div>
  <label class="btn btn-g" style="cursor:pointer">Open .save
    <input type="file" accept=".save" id="fileinput" style="display:none">
  </label>
  <button class="btn btn-s" id="savebtn" disabled onclick="doSave()">⬇ Download</button>
</header>

<div id="dropzone">
  <div class="dropbox" id="dropbox" onclick="document.getElementById('fileinput').click()">
    <span class="drop-ico">💾</span>
    <div class="drop-t">Drop your .save file here</div>
    <div class="drop-s">or click to browse · Ren'Py 8.x</div>
  </div>
</div>

<div id="main" class="hidden">
  <div class="toolbar">
    <div class="sw">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
        <circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>
      </svg>
      <input type="text" id="search" placeholder="filter keys…" oninput="applyFilter()">
    </div>
    <div class="pills">
      <button class="pill on" onclick="setFilter('all',this)">all</button>
      <button class="pill" onclick="setFilter('bool',this)">bool</button>
      <button class="pill" onclick="setFilter('str',this)">str</button>
      <button class="pill" onclick="setFilter('int',this)">int</button>
      <button class="pill" onclick="setFilter('complex',this)">complex</button>
      <button class="pill" onclick="setFilter('modified',this)">modified</button>
    </div>
    <button class="btn btn-g" onclick="resetAll()">↺ reset all</button>
  </div>
  <div class="statsbar" id="stats"></div>
  <div class="tree-scroll" id="tree"></div>
</div>

<div id="toast"></div>

<script>
// ── globals ───────────────────────────────────────────────────────────────────
let DATA = null;       // {filename, store:{key→node}}
let edits = {};        // key → new scalar node
let deleted = new Set();
let pillFilter = 'all';
const PAGE = 50;       // items per page for large lists

// ── file loading ──────────────────────────────────────────────────────────────
document.getElementById('fileinput').onchange = e => loadFile(e.target.files[0]);
const dropbox = document.getElementById('dropbox');
dropbox.ondragover = e => { e.preventDefault(); dropbox.classList.add('drag'); };
dropbox.ondragleave = () => dropbox.classList.remove('drag');
dropbox.ondrop = e => { e.preventDefault(); dropbox.classList.remove('drag'); if(e.dataTransfer.files[0]) loadFile(e.dataTransfer.files[0]); };
document.ondragover = e => e.preventDefault();
document.ondrop = e => { e.preventDefault(); const f = e.dataTransfer.files[0]; if(f?.name.endsWith('.save')) loadFile(f); };

async function loadFile(file) {
  const fd = new FormData(); fd.append('file', file);
  const r = await fetch('/api/load', {method:'POST', body:fd});
  if (!r.ok) { toast('Load failed', 'err'); return; }
  DATA = await r.json();
  edits = {}; deleted = new Set();
  document.getElementById('badge').textContent = file.name;
  document.getElementById('savebtn').disabled = false;
  document.getElementById('dropzone').classList.add('hidden');
  document.getElementById('main').classList.remove('hidden');
  renderTree();
}

async function tryPreload() {
  const r = await fetch('/api/data');
  if (!r.ok || r.status === 204) return;
  DATA = await r.json();
  if (!DATA?.store) return;
  edits = {}; deleted = new Set();
  document.getElementById('badge').textContent = DATA.filename || 'loaded';
  document.getElementById('savebtn').disabled = false;
  document.getElementById('dropzone').classList.add('hidden');
  document.getElementById('main').classList.remove('hidden');
  renderTree();
}
tryPreload();

// ── tree rendering ─────────────────────────────────────────────────────────────
function renderTree() {
  const tree = document.getElementById('tree');
  tree.innerHTML = '';

  // Group store keys by namespace
  const groups = {};
  for (const key of Object.keys(DATA.store)) {
    const short = key.startsWith('store.') ? key.slice(6) : key;
    const parts = short.split('.');
    const g = parts.length > 1 ? parts[0] : '__root__';
    (groups[g] = groups[g] || []).push(key);
  }

  const sortedGroups = Object.keys(groups).sort((a,b) => {
    const ai = a.startsWith('_')||a==='__root__', bi = b.startsWith('_')||b==='__root__';
    if (ai!==bi) return ai ? 1 : -1;
    return a.localeCompare(b);
  });

  for (const g of sortedGroups) {
    tree.appendChild(makeNsGroup(g, groups[g].sort()));
  }
  updateStats();
}

function makeNsGroup(group, keys) {
  const wrap = document.createElement('div');
  wrap.className = 'nsgroup'; wrap.dataset.group = group;

  const label = group === '__root__' ? '(root)' : group;
  const isSys = group.startsWith('_') || group === '__root__';

  const hdr = document.createElement('div');
  hdr.className = 'nshdr';
  hdr.innerHTML = `<span class="nsarrow">▼</span>
    <span class="nslabel">${esc(label)}</span>
    <span class="nscount">${keys.length}</span>
    ${!isSys ? `<button class="nsdelbtn" onclick="deleteGroup(event,'${esc(group)}')">✕ group</button>` : ''}`;
  hdr.onclick = e => {
    if (e.target.classList.contains('nsdelbtn')) return;
    hdr.classList.toggle('col');
    body.classList.toggle('hidden');
  };

  const body = document.createElement('div');
  body.dataset.groupbody = group;
  for (const key of keys) body.appendChild(makeNode(key, DATA.store[key], key, 0));

  wrap.appendChild(hdr); wrap.appendChild(body);
  return wrap;
}

// Make a full node (row + optional children)
function makeNode(keyPath, node, displayKey, depth) {
  const wrap = document.createElement('div');
  wrap.className = 'node';

  const isComplex = ['list','dict','obj','set','tuple'].includes(node?.t);
  const isLeaf = !isComplex;

  // ── row ──
  const row = document.createElement('div');
  row.className = `node-row d${Math.min(depth,5)}`;
  row.dataset.key = keyPath;
  row.dataset.vt = node?.t || 'null';

  // expand button
  const xbtn = document.createElement('span');
  xbtn.className = isComplex ? 'xbtn' : 'xbtn leaf';
  xbtn.textContent = isComplex ? '▶' : '';

  // key label
  const keyEl = document.createElement('span');
  keyEl.className = 'nkey';
  keyEl.style.width = depth === 0 ? '240px' : '180px';
  // For top-level keys strip store.  prefix and namespace
  let dispKey = displayKey;
  if (depth === 0 && dispKey.startsWith('store.')) {
    const short = dispKey.slice(6);
    const parts = short.split('.');
    if (parts.length > 1)
      dispKey = `<span class="nspart">${esc(parts.slice(0,-1).join('.'))}.</span>${esc(parts[parts.length-1])}`;
    else dispKey = esc(short);
  } else {
    dispKey = esc(String(displayKey));
  }
  keyEl.innerHTML = dispKey;

  // type badge
  const tb = document.createElement('span');
  tb.className = `tbadge tb-${node?.t||'null'}`;
  tb.textContent = node?.t || 'null';

  // value area
  const valEl = document.createElement('span');
  valEl.className = 'nval';
  valEl.id = `vv-${uid(keyPath)}`;
  renderInlineVal(valEl, keyPath, node);

  // actions (only on top-level keys, or deletable child paths)
  const acts = document.createElement('span');
  acts.className = 'acts';
  if (depth === 0) {
    acts.innerHTML = `<button class="ab r" title="reset" onclick="resetKey('${esc(keyPath)}')">↺</button>
      <button class="ab d" onclick="deleteKey(event,'${esc(keyPath)}')">✕</button>`;
  }

  row.appendChild(xbtn); row.appendChild(keyEl); row.appendChild(tb);
  row.appendChild(valEl); row.appendChild(acts);

  // ── children ──
  let children = null;
  if (isComplex) {
    children = document.createElement('div');
    children.className = 'children';
    children.id = `ch-${uid(keyPath)}`;

    let loaded = false;
    xbtn.onclick = (e) => {
      e.stopPropagation();
      const open = !children.classList.contains('open');
      children.classList.toggle('open', open);
      xbtn.classList.toggle('open', open);
      xbtn.textContent = open ? '▼' : '▶';
      if (open && !loaded) {
        loaded = true;
        loadChildren(children, keyPath, node, depth + 1);
      }
    };
    // also click row to expand
    row.style.cursor = 'pointer';
    row.onclick = (e) => { if (!e.target.classList.contains('ab')) xbtn.onclick(e); };
  }

  wrap.appendChild(row);
  if (children) wrap.appendChild(children);
  return wrap;
}

// Populate children container
function loadChildren(container, keyPath, node, depth, pageStart=0) {
  container.innerHTML = '';
  const t = node.t;
  let items = [];

  if (t === 'list' || t === 'tuple') {
    const all = node.children || [];
    const total = all.length;
    const page = all.slice(pageStart, pageStart + PAGE);
    for (let i = 0; i < page.length; i++) {
      const idx = pageStart + i;
      const child = makeNode(`${keyPath}[${idx}]`, page[i], idx, depth);
      container.appendChild(child);
    }
    if (total > PAGE) appendPager(container, keyPath, node, depth, total, pageStart);
  } else if (t === 'dict') {
    const entries = Object.entries(node.children || {});
    const total = entries.length;
    const page = entries.slice(pageStart, pageStart + PAGE);
    for (const [k, v] of page) {
      container.appendChild(makeNode(`${keyPath}.${k}`, v, k, depth));
    }
    if (total > PAGE) appendPager(container, keyPath, node, depth, total, pageStart);
  } else if (t === 'obj') {
    const entries = Object.entries(node.children || {}).filter(([k]) => !k.startsWith('_module'));
    for (const [k, v] of entries) {
      container.appendChild(makeNode(`${keyPath}.${k}`, v, k, depth));
    }
  } else if (t === 'set') {
    const setEl = document.createElement('div');
    setEl.style.cssText='padding:6px 20px 6px 52px;font-family:var(--mono);font-size:10px;color:var(--t2)';
    setEl.textContent = (node.items||[]).join(', ') || '(empty)';
    container.appendChild(setEl);
  }
}

function appendPager(container, keyPath, node, depth, total, pageStart) {
  const bar = document.createElement('div');
  bar.className = 'pagebar';

  const totalPages = Math.ceil(total / PAGE);
  const curPage = Math.floor(pageStart / PAGE);

  bar.innerHTML = `<span class="pginfo">${pageStart+1}–${Math.min(pageStart+PAGE,total)} of ${total}</span>`;

  // prev
  if (curPage > 0) {
    const prev = document.createElement('button');
    prev.className = 'pgbtn'; prev.textContent = '‹ prev';
    prev.onclick = () => {
      container.innerHTML = '';
      loadChildren(container, keyPath, node, depth, (curPage-1)*PAGE);
    };
    bar.appendChild(prev);
  }
  // page buttons (up to 7)
  const start = Math.max(0, curPage-3), end = Math.min(totalPages, start+7);
  for (let p = start; p < end; p++) {
    const btn = document.createElement('button');
    btn.className = p===curPage ? 'pgbtn cur' : 'pgbtn';
    btn.textContent = p+1;
    const ps = p; // capture
    btn.onclick = () => { container.innerHTML=''; loadChildren(container,keyPath,node,depth,ps*PAGE); };
    bar.appendChild(btn);
  }
  // next
  if (curPage < totalPages-1) {
    const next = document.createElement('button');
    next.className = 'pgbtn'; next.textContent = 'next ›';
    next.onclick = () => {
      container.innerHTML = '';
      loadChildren(container, keyPath, node, depth, (curPage+1)*PAGE);
    };
    bar.appendChild(next);
  }

  container.appendChild(bar);
}

// Render an inline editable value widget
function renderInlineVal(el, key, node) {
  const t = node?.t;
  if (t === 'bool') {
    const on = node.v ? 'on' : '';
    el.innerHTML = `<div class="ve-bool">
      <button class="tog ${on}" onclick="toggleBool('${esc(key)}',this)"></button>
      <span class="tog-lbl">${node.v}</span></div>`;
  } else if (t === 'str') {
    el.innerHTML = `<input class="ve-edit s" value="${escA(node.v)}"
      onchange="editScalar('${esc(key)}','str',this.value)"
      oninput="markMod('${esc(key)}')" data-orig="${escA(node.v)}">`;
  } else if (t === 'int') {
    el.innerHTML = `<input class="ve-edit n" type="number" step="1" value="${node.v}"
      onchange="editScalar('${esc(key)}','int',this.value)"
      oninput="markMod('${esc(key)}')" data-orig="${node.v}">`;
  } else if (t === 'float') {
    el.innerHTML = `<input class="ve-edit n" type="number" value="${node.v}"
      onchange="editScalar('${esc(key)}','float',this.value)"
      oninput="markMod('${esc(key)}')" data-orig="${node.v}">`;
  } else if (t === 'null') {
    el.innerHTML = `<span class="ve-null">null</span>`;
  } else if (t === 'list' || t === 'tuple') {
    el.innerHTML = `<span class="ve-cplx"><span class="dim">${node.len} item${node.len!==1?'s':''} — click to expand</span></span>`;
  } else if (t === 'dict') {
    el.innerHTML = `<span class="ve-cplx"><span class="dim">${node.len} entr${node.len!==1?'ies':'y'} — click to expand</span></span>`;
  } else if (t === 'set') {
    el.innerHTML = `<span class="ve-cplx"><span class="dim">${node.len} items</span></span>`;
  } else if (t === 'obj') {
    const cls = (node.cls||'').split('.').pop();
    const cnt = Object.keys(node.children||{}).filter(k=>!k.startsWith('_module')).length;
    el.innerHTML = `<span class="ve-cplx"><span class="cls">${esc(cls)}</span><span class="dim">${cnt} attr${cnt!==1?'s':''} — click to expand</span></span>`;
  } else if (t === 'raw') {
    el.innerHTML = `<span class="ve-null">${esc((node.v||'').slice(0,100))}</span>`;
  } else {
    el.innerHTML = `<span class="ve-null">—</span>`;
  }
}

// ── edit operations ───────────────────────────────────────────────────────────
function toggleBool(key, btn) {
  const on = btn.classList.toggle('on');
  btn.nextElementSibling.textContent = on;
  edits[key] = {t:'bool', v:on};
  markMod(key); updateStats();
}
function editScalar(key, type, rawVal) {
  const v = type==='int' ? parseInt(rawVal,10) : type==='float' ? parseFloat(rawVal) : rawVal;
  edits[key] = {t:type, v};
  markMod(key); updateStats();
}
function markMod(key) {
  const row = document.querySelector(`.node-row[data-key="${CSS.escape(key)}"]`);
  if (row) row.classList.add('mod');
}

function resetKey(key) {
  delete edits[key]; deleted.delete(key);
  const orig = DATA.store[key];
  const el = document.getElementById(`vv-${uid(key)}`);
  if (el) renderInlineVal(el, key, orig);
  const row = document.querySelector(`.node-row[data-key="${CSS.escape(key)}"]`);
  if (row) { row.classList.remove('mod','del'); row.style.opacity=''; row.style.textDecoration=''; }
  updateStats();
}
function resetAll() {
  edits={}; deleted=new Set();
  renderTree(); applyFilter();
  toast('All changes reset','ok');
}

function deleteKey(e, key) {
  e.stopPropagation();
  deleted.add(key); delete edits[key];
  const row = document.querySelector(`.node-row[data-key="${CSS.escape(key)}"]`);
  if (row) row.classList.add('del');
  updateStats(); toast(`Deleted: ${key}`,'ok');
}

function deleteGroup(e, group) {
  e.stopPropagation();
  const prefix = `store.${group}.`;
  let n = 0;
  for (const key of Object.keys(DATA.store)) {
    if (key.startsWith(prefix) || key===`store.${group}`) {
      deleted.add(key); delete edits[key];
      const row = document.querySelector(`.node-row[data-key="${CSS.escape(key)}"]`);
      if (row) row.classList.add('del');
      n++;
    }
  }
  updateStats(); toast(`Deleted group "${group}" (${n} keys)`,'ok');
}

// ── filter ────────────────────────────────────────────────────────────────────
function setFilter(f, el) {
  pillFilter = f;
  document.querySelectorAll('.pill').forEach(p=>p.classList.remove('on'));
  el.classList.add('on');
  applyFilter();
}
function applyFilter() {
  const q = document.getElementById('search').value.toLowerCase();
  let shown=0, total=0;
  document.querySelectorAll('.node-row[data-key]').forEach(row => {
    if (row.closest('.children')) return; // skip child rows from filter count
    total++;
    const key = row.dataset.key||'';
    const vt  = row.dataset.vt||'';
    const isMod = row.classList.contains('mod')||deleted.has(key);
    let pass = true;
    if (q && !key.toLowerCase().includes(q)) pass=false;
    if (pillFilter==='bool'    && vt!=='bool') pass=false;
    if (pillFilter==='str'     && vt!=='str')  pass=false;
    if (pillFilter==='int'     && vt!=='int'&&vt!=='float') pass=false;
    if (pillFilter==='complex' && !['list','dict','set','obj','tuple'].includes(vt)) pass=false;
    if (pillFilter==='modified'&& !isMod) pass=false;
    const node = row.closest('.node');
    if (node) node.classList.toggle('fout', !pass);
    if (pass) shown++;
  });
  updateStats(shown, total);
}

// ── stats ─────────────────────────────────────────────────────────────────────
function updateStats(shown, total) {
  const allRows = document.querySelectorAll('.node-row[data-key]');
  let t=0; allRows.forEach(r=>{ if(!r.closest('.children'))t++; });
  if (total===undefined) { shown=t; total=t; }
  const mods = Object.keys(edits).length + deleted.size;
  document.getElementById('stats').innerHTML =
    `<b>${total}</b> keys &nbsp; <b>${shown}</b> shown &nbsp; `+
    `<span style="color:${mods?'var(--amb)':'var(--t3)'}"><b>${mods}</b> edits</span> &nbsp; `+
    `<span style="color:${deleted.size?'var(--red)':'var(--t3)'}"><b>${deleted.size}</b> deleted</span>`;
}

// ── save ──────────────────────────────────────────────────────────────────────
async function doSave() {
  const r = await fetch('/api/save', {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({edits, deleted:[...deleted]})
  });
  if (!r.ok) { const e=await r.json(); toast('Save failed: '+(e.error||'?'),'err'); return; }
  const blob = await r.blob();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = DATA.filename || 'edited.save';
  a.click();
  toast('Downloaded!','ok');
}

// ── helpers ───────────────────────────────────────────────────────────────────
function esc(s){ return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function escA(s){ return esc(s).replace(/'/g,'&#39;'); }
function uid(s){ return s.replace(/[^a-z0-9]/gi,'_'); }
let _tt;
function toast(msg,type='ok'){
  const el=document.getElementById('toast');
  el.textContent=msg; el.className=`show ${type}`;
  clearTimeout(_tt); _tt=setTimeout(()=>el.className='',3000);
}
</script>
</body>
</html>
"""

@app.get("/")
def index(): return Response(HTML, content_type="text/html")

@app.post("/api/load")
def api_load():
    if "file" not in request.files: return jsonify({"error":"no file"}),400
    f = request.files["file"]
    raw = f.read()
    try: store, rollback, extras = load_save(raw)
    except Exception as e: return jsonify({"error":str(e)}),400
    _state.update(store=store, rollback=rollback, extras=extras, filename=f.filename)
    return jsonify({"filename":f.filename,
                    "store":{k:_serialize_value(v) for k,v in store.items()}})

@app.get("/api/data")
def api_data():
    if _state["store"] is None: return Response(status=204)
    return jsonify({"filename":_state["filename"],
                    "store":{k:_serialize_value(v) for k,v in _state["store"].items()}})

@app.post("/api/save")
def api_save():
    if _state["store"] is None: return jsonify({"error":"no file loaded"}),400
    payload = request.get_json()
    store, rollback, extras = _state["store"], _state["rollback"], _state["extras"]
    for key in payload.get("deleted",[]): store.pop(key,None)
    for key, node in payload.get("edits",{}).items():
        if key in store: store[key] = _deserialize_scalar(node, store[key])
    try: out = save_to_bytes(store, rollback, extras)
    except Exception as e:
        import traceback; traceback.print_exc()
        return jsonify({"error":str(e)}),500
    return send_file(io.BytesIO(out), mimetype="application/octet-stream",
                     as_attachment=True, download_name=_state.get("filename") or "edited.save")

if __name__ == "__main__":
    port = 5171
    for arg in sys.argv[1:]:
        if os.path.isfile(arg) and arg.endswith(".save"):
            store, rollback, extras = load_save(open(arg,"rb").read())
            _state.update(store=store, rollback=rollback, extras=extras, filename=os.path.basename(arg))
            print(f"[*] Loaded: {arg}")
    print(f"[*] http://localhost:{port}")
    app.run(host="0.0.0.0", port=port, debug=False)