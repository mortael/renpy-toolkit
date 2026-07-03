/** @typedef {{ ok: true, value: boolean } | { ok: false, reason: string }} EvalResult */

function normalizeVarKey(key) {
  return key.startsWith('store.') ? key.slice(6) : key;
}

function resolveVar(name, vars) {
  const trimmed = name.trim();
  if (!trimmed || !vars) return undefined;
  if (Object.prototype.hasOwnProperty.call(vars, trimmed)) return vars[trimmed];
  const short = normalizeVarKey(trimmed);
  if (Object.prototype.hasOwnProperty.call(vars, short)) return vars[short];
  return undefined;
}

function parseLiteral(token, vars) {
  const t = token.trim();
  if (t === 'True') return true;
  if (t === 'False') return false;
  if (t === 'None') return null;
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  const quoted = t.match(/^["'](.*)["']$/);
  if (quoted) return quoted[1];
  if (/^[a-zA-Z_][a-zA-Z0-9_.]*$/.test(t)) return resolveVar(t, vars);
  throw new Error('bad literal');
}

function truthy(v) {
  if (v === null || v === undefined) return false;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'string') return v.length > 0;
  return Boolean(v);
}

function splitTopLevel(expr, sep) {
  const parts = [];
  let depth = 0;
  let start = 0;
  let i = 0;
  while (i < expr.length) {
    const ch = expr[i];
    if (ch === '(') depth++;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    else if (depth === 0 && expr.slice(i, i + sep.length) === sep) {
      parts.push(expr.slice(start, i));
      i += sep.length;
      start = i;
      continue;
    }
    i++;
  }
  parts.push(expr.slice(start));
  return parts.map(p => p.trim()).filter(Boolean);
}

function compareValues(left, op, right) {
  if (op === 'is') return left === right;
  if (op === 'is not') return left !== right;
  if (op === '==') return left == right;
  if (op === '!=') return left != right;
  if (op === '>=') return left >= right;
  if (op === '<=') return left <= right;
  if (op === '>') return left > right;
  if (op === '<') return left < right;
  throw new Error('bad op');
}

function evalAtom(expr, vars) {
  let atom = expr.trim();
  if (!atom) throw new Error('empty atom');

  if (atom.startsWith('(') && atom.endsWith(')')) {
    return evalExpr(atom.slice(1, -1), vars);
  }

  let negate = false;
  while (atom.startsWith('not ')) {
    negate = !negate;
    atom = atom.slice(4).trim();
  }

  const cmp = atom.match(/^(.+?)\s*(==|!=|>=|<=|>|<)\s*(.+)$/);
  if (cmp) {
    const result = compareValues(
      parseLiteral(cmp[1], vars),
      cmp[2],
      parseLiteral(cmp[3], vars),
    );
    return negate ? !result : result;
  }

  const isMatch = atom.match(/^(.+?)\s+(is not|is)\s+(.+)$/i);
  if (isMatch) {
    const result = compareValues(
      parseLiteral(isMatch[1], vars),
      isMatch[2].toLowerCase(),
      parseLiteral(isMatch[3], vars),
    );
    return negate ? !result : result;
  }

  const val = parseLiteral(atom, vars);
  const result = truthy(val);
  return negate ? !result : result;
}

function evalExpr(expr, vars) {
  const orParts = splitTopLevel(expr, ' or ');
  if (orParts.length > 1) {
    return orParts.some(part => evalExpr(part, vars));
  }
  const andParts = splitTopLevel(expr, ' and ');
  if (andParts.length > 1) {
    return andParts.every(part => evalAtom(part, vars));
  }
  return evalAtom(expr, vars);
}

/** Evaluate simple Ren'Py if/elif conditions against flattened save vars. */
export function evaluateRenpyCondition(expr, vars) {
  if (!expr?.trim()) return { ok: false, reason: 'empty' };
  try {
    const value = Boolean(evalExpr(expr.trim(), vars));
    return { ok: true, value };
  } catch {
    return { ok: false, reason: 'complex' };
  }
}