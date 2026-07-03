# Ren'Py save pickle logic — runs in Pyodide (lifted from reference-renpy-save-editor.py)
import io
import json
import pickle
import re
import sys
import types
import zipfile
from pickle import _Unpickler

_PATH_RE = re.compile(r"\.([A-Za-z_][A-Za-z0-9_]*)|\[(\d+)\]")

class FlexObj:
    def __init__(self, *a, **kw):
        pass

    def __setstate__(self, d):
        if isinstance(d, dict):
            self.__dict__.update(d)
        else:
            self._state = d


class FlexList(list):
    def __setstate__(self, d):
        pass


class FlexDict(dict):
    def __setstate__(self, d):
        if isinstance(d, dict):
            self.update(d)


class FlexSet(set):
    def __setstate__(self, d):
        pass


_class_registry = {}


def _ensure_module(module):
    parts = module.split(".")
    cur = ""
    for part in parts:
        parent, cur = cur, (cur + "." if cur else "") + part
        if cur not in sys.modules:
            m = types.ModuleType(cur)
            sys.modules[cur] = m
            if parent:
                setattr(sys.modules[parent], part, m)


def _make_flex(module, name):
    key = (module, name)
    if key in _class_registry:
        return _class_registry[key]
    _ensure_module(module)
    cls = type(name, (FlexObj,), {"_qname": f"{module}.{name}", "_module_name": module})
    cls.__module__, cls.__qualname__ = module, name
    setattr(sys.modules[module], name, cls)
    _class_registry[key] = cls
    return cls


def _register_flex(base_cls, module, name):
    key = (module, name)
    if key in _class_registry:
        return _class_registry[key]
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
        if name == "RevertableDict":
            return _register_flex(FlexDict, module, name)
        if name == "RevertableSet":
            return _register_flex(FlexSet, module, name)
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
        for n, d in extras.items():
            zf.writestr(n, d)
    return out.getvalue()


def _serialize_shallow(v):
    if v is None:
        return {"t": "null"}
    if isinstance(v, bool):
        return {"t": "bool", "v": v}
    if isinstance(v, int):
        return {"t": "int", "v": v}
    if isinstance(v, float):
        return {"t": "float", "v": v}
    if isinstance(v, str):
        return {"t": "str", "v": v}
    if isinstance(v, (list, FlexList)):
        return {"t": "list", "len": len(v), "lazy": True}
    if isinstance(v, (dict, FlexDict)):
        return {"t": "dict", "len": len(v), "lazy": True}
    if isinstance(v, FlexSet):
        return {"t": "set", "len": len(v), "lazy": True}
    if isinstance(v, FlexObj):
        d = {k: vv for k, vv in v.__dict__.items() if not k.startswith("_module")}
        qname = getattr(type(v), "_qname", type(v).__name__)
        return {"t": "obj", "cls": qname, "len": len(d), "lazy": True}
    if isinstance(v, tuple):
        return {"t": "tuple", "len": len(v), "lazy": True}
    return {"t": "raw", "v": repr(v)[:300]}


def _serialize_value(v):
    if v is None:
        return {"t": "null"}
    if isinstance(v, bool):
        return {"t": "bool", "v": v}
    if isinstance(v, int):
        return {"t": "int", "v": v}
    if isinstance(v, float):
        return {"t": "float", "v": v}
    if isinstance(v, str):
        return {"t": "str", "v": v}
    if isinstance(v, (list, FlexList)):
        return {"t": "list", "len": len(v), "children": [_serialize_value(i) for i in v]}
    if isinstance(v, (dict, FlexDict)):
        return {"t": "dict", "len": len(v), "children": {str(k): _serialize_value(vv) for k, vv in v.items()}}
    if isinstance(v, FlexSet):
        return {"t": "set", "len": len(v), "items": [repr(i) for i in v]}
    if isinstance(v, FlexObj):
        d = {k: vv for k, vv in v.__dict__.items() if not k.startswith("_module")}
        qname = getattr(type(v), "_qname", type(v).__name__)
        return {"t": "obj", "cls": qname, "children": {k: _serialize_value(vv) for k, vv in d.items()}}
    if isinstance(v, tuple):
        return {"t": "tuple", "len": len(v), "children": [_serialize_value(i) for i in v]}
    return {"t": "raw", "v": repr(v)[:300]}


def _deserialize_scalar(node, original):
    t = node.get("t")
    if t == "null":
        return None
    if t == "bool":
        return bool(node["v"])
    if t == "int":
        return int(node["v"])
    if t == "float":
        return float(node["v"])
    if t == "str":
        return str(node["v"])
    return original


def _path_parts(path):
    head = path.split(".", 1)[0].split("[", 1)[0]
    parts = [head]
    rest = path[len(head):]
    for m in _PATH_RE.finditer(rest):
        parts.append(m.group(1) if m.group(1) is not None else int(m.group(2)))
    return parts


def _get_child(obj, part):
    if isinstance(part, int):
        return obj[part]
    if isinstance(obj, (dict, FlexDict)):
        return obj[part]
    return getattr(obj, part)


def _set_child(parent, final, value):
    if isinstance(final, int):
        parent[final] = value
    elif isinstance(parent, (dict, FlexDict)):
        parent[final] = value
    else:
        setattr(parent, final, value)


def _del_child(parent, final):
    if isinstance(final, int):
        del parent[final]
    elif isinstance(parent, (dict, FlexDict)):
        parent.pop(final, None)
    else:
        delattr(parent, final)


def _resolve_parent(root, path):
    parts = _path_parts(path)
    obj = root
    for part in parts[:-1]:
        try:
            obj = _get_child(obj, part)
        except (KeyError, AttributeError, IndexError, TypeError):
            return None, None
    return obj, parts[-1]


_state = {"store": None, "rollback": None, "extras": None}
_compare_slots = {}


def _flatten_obj(obj, prefix, out):
    if obj is None:
        out[prefix] = None
        return
    if isinstance(obj, bool):
        out[prefix] = obj
        return
    if isinstance(obj, int):
        out[prefix] = obj
        return
    if isinstance(obj, float):
        out[prefix] = obj
        return
    if isinstance(obj, str):
        out[prefix] = obj
        return
    if isinstance(obj, (list, FlexList, tuple)):
        for i, item in enumerate(obj):
            child = f"{prefix}[{i}]" if prefix else f"[{i}]"
            _flatten_obj(item, child, out)
        return
    if isinstance(obj, (dict, FlexDict)):
        for k, v in obj.items():
            key = str(k)
            child = f"{prefix}.{key}" if prefix else key
            _flatten_obj(v, child, out)
        return
    if isinstance(obj, FlexSet):
        out[prefix] = ", ".join(repr(i) for i in obj) or "(empty)"
        return
    if isinstance(obj, FlexObj):
        d = {k: vv for k, vv in obj.__dict__.items() if not k.startswith("_module")}
        if not d:
            out[prefix] = repr(obj)[:300]
            return
        for k, v in d.items():
            child = f"{prefix}.{k}" if prefix else k
            _flatten_obj(v, child, out)
        return
    out[prefix] = repr(obj)[:300]


def py_compare_load(slot, raw_bytes):
    store, rollback, extras = load_save(raw_bytes)
    _compare_slots[slot] = {"store": store, "rollback": rollback, "extras": extras}
    return json.dumps({"keys": len(store)})


def py_flatten_store_scalars():
    if _state["store"] is None:
        return json.dumps({})
    out = {}
    for k, v in _state["store"].items():
        key = str(k)
        short = key[6:] if key.startswith("store.") else key
        _flatten_obj(v, short, out)
    scalar = {}
    for path, val in out.items():
        if isinstance(val, (bool, int, float, str)) or val is None:
            scalar[path] = val
    return json.dumps(scalar)


def py_flatten_slot(slot):
    entry = _compare_slots.get(slot)
    if entry is None:
        raise RuntimeError(f"compare slot {slot!r} not loaded")
    out = {}
    for k, v in entry["store"].items():
        _flatten_obj(v, k, out)
    return json.dumps(out)


def py_load(raw_bytes, full=False):
    store, rollback, extras = load_save(raw_bytes)
    _state.update(store=store, rollback=rollback, extras=extras)
    ser = _serialize_value if full else _serialize_shallow
    return json.dumps({"store": {k: ser(v) for k, v in store.items()}})


def py_expand(path):
    if _state["store"] is None:
        raise RuntimeError("no save loaded")
    store = _state["store"]
    parent, final = _resolve_parent(store, path)
    if parent is None:
        raise KeyError(path)
    obj = _get_child(parent, final)
    return json.dumps(_serialize_value(obj))


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
            _del_child(parent, final)
        except (KeyError, AttributeError, IndexError, TypeError):
            pass

    for key, node in edits.items():
        parent, final = _resolve_parent(store, key)
        if parent is None:
            continue
        try:
            current = _get_child(parent, final)
        except (KeyError, AttributeError, IndexError, TypeError):
            current = None
        _set_child(parent, final, _deserialize_scalar(node, current))

    return save_to_bytes(store, rollback, extras)