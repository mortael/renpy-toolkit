# RPYC → pseudo-.rpy decompilation for Story Browser (Pyodide)
import io
import json
import struct
import zlib
import sys
import types
from pickle import _Unpickler

RPYC2_HEADER = b"RENPY RPC2"


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


def read_rpyc_slot(raw_bytes, slot=1):
    data = bytes(raw_bytes)
    if data[: len(RPYC2_HEADER)] != RPYC2_HEADER:
        if slot != 1:
            return None
        return zlib.decompress(data)

    pos = len(RPYC2_HEADER)
    while pos + 12 <= len(data):
        header_slot, start, length = struct.unpack("III", data[pos : pos + 12])
        if header_slot == slot:
            return zlib.decompress(data[start : start + length])
        if header_slot == 0:
            return None
        pos += 12
    return None


def _ast_fields(obj):
    if not hasattr(obj, "__dict__"):
        return {}
    st = obj.__dict__.get("_state")
    if isinstance(st, tuple) and len(st) == 2 and isinstance(st[1], dict):
        return st[1]
    return {k: v for k, v in obj.__dict__.items() if not k.startswith("_")}


def _qname(obj):
    return getattr(type(obj), "_qname", type(obj).__name__)


def _pycode_source(obj):
    if obj is None:
        return None
    if isinstance(obj, str):
        return obj
    if hasattr(obj, "__dict__"):
        st = obj.__dict__.get("_state")
        if isinstance(st, tuple) and len(st) >= 2 and isinstance(st[1], str):
            return st[1]
    return None


def _expr_str(obj):
    if obj is None:
        return None
    if isinstance(obj, str):
        return obj
    src = _pycode_source(obj)
    if src:
        return src
    return None


def _imspec_name(imspec):
    if not imspec:
        return ""
    parts = imspec[0] if imspec else ()
    if isinstance(parts, (list, tuple)):
        return " ".join(str(p) for p in parts)
    return str(parts)


def _indent(level):
    return "    " * level


def _emit_stmt(stmt, lines, level=0):
    if stmt is None:
        return
    if not hasattr(stmt, "__dict__"):
        return

    q = _qname(stmt)
    short = q.split(".")[-1]
    f = _ast_fields(stmt)

    if short == "Init":
        return

    if short == "UserStatement":
        line = f.get("line")
        if line:
            lines.append(_indent(level) + str(line))
        return

    if short == "Label":
        name = f.get("name") or "label"
        lines.append(_indent(level) + f"label {name}:")
        for child in f.get("block") or []:
            _emit_stmt(child, lines, level + 1)
        return

    if short == "Say":
        who = _expr_str(f.get("who"))
        what = f.get("what") or ""
        if isinstance(what, str):
            what = what.replace('"', '\\"')
        if who:
            lines.append(_indent(level) + f'{who} "{what}"')
        else:
            lines.append(_indent(level) + f'"{what}"')
        return

    if short == "Python":
        code = _pycode_source(f.get("code"))
        if code:
            if "\n" in code.strip():
                lines.append(_indent(level) + "python:")
                for ln in code.splitlines():
                    lines.append(_indent(level + 1) + ln)
            else:
                lines.append(_indent(level) + "$ " + code)
        return

    if short in ("Scene", "Show", "Hide"):
        name = _imspec_name(f.get("imspec"))
        layer = f.get("layer")
        extra = f" on {layer}" if layer and layer != "master" else ""
        lines.append(_indent(level) + f"{short.lower()} {name}{extra}".strip())
        return

    if short == "Image":
        imgname = f.get("imgname") or ()
        tag = " ".join(str(p) for p in imgname) if isinstance(imgname, (list, tuple)) else str(imgname)
        rhs = _pycode_source(f.get("code")) or "..."
        lines.append(_indent(level) + f"image {tag} = {rhs}")
        return

    if short == "Define":
        code = _pycode_source(f.get("code"))
        if code:
            lines.append(_indent(level) + f"define {code}")
        return

    if short == "Default":
        code = _pycode_source(f.get("code"))
        if code:
            lines.append(_indent(level) + f"default {code}")
        return

    if short in ("Jump", "Call"):
        target = f.get("target") or "?"
        lines.append(_indent(level) + f"{short.lower()} {target}")
        return

    if short == "Return":
        lines.append(_indent(level) + "return")
        return

    if short == "Menu":
        lines.append(_indent(level) + "menu:")
        for item in f.get("items") or []:
            if not item:
                continue
            caption = item[0] if len(item) > 0 else "?"
            block = item[1] if len(item) > 1 else []
            cap = str(caption).replace('"', '\\"')
            lines.append(_indent(level + 1) + f'"{cap}":')
            for child in block or []:
                _emit_stmt(child, lines, level + 2)
        return

    if short in ("If", "Elif", "Else"):
        if short == "If":
            cond = _expr_str(f.get("condition")) or "True"
            lines.append(_indent(level) + f"if {cond}:")
        elif short == "Elif":
            cond = _expr_str(f.get("condition")) or "True"
            lines.append(_indent(level) + f"elif {cond}:")
        else:
            lines.append(_indent(level) + "else:")
        for child in f.get("block") or []:
            _emit_stmt(child, lines, level + 1)
        return

    if short == "With":
        expr = _expr_str(f.get("expr")) or "dissolve"
        lines.append(_indent(level) + f"with {expr}")
        return

    if short == "Screen":
        return

    block = f.get("block")
    if block:
        for child in block:
            _emit_stmt(child, lines, level)


def decompile_rpyc(raw_bytes):
    blob = read_rpyc_slot(raw_bytes, slot=1)
    if blob is None:
        blob = read_rpyc_slot(raw_bytes, slot=2)
    if blob is None:
        raise ValueError("Could not read RPYC data slots")

    root = SafeUnpickler(io.BytesIO(blob)).load()
    if isinstance(root, tuple) and len(root) >= 2:
        stmts = root[1]
    elif isinstance(root, list):
        stmts = root
    else:
        stmts = [root]

    lines = ["# Decompiled from .rpyc (approximate — review before editing)"]
    for stmt in stmts:
        _emit_stmt(stmt, lines, 0)

    source = "\n".join(lines)
    if not source.strip():
        raise ValueError("Decompiled source is empty")
    return source


def py_decompile_rpyc(raw_bytes):
    return json.dumps({"source": decompile_rpyc(raw_bytes)})