import { store } from './state.js';
import { evaluateRenpyCondition } from './condition-eval.js';

function normalizeVarKey(key) {
  return key.startsWith('store.') ? key.slice(6) : key;
}

// Save-linked live values — populated when a .save is loaded in Save Editor.
export function getCurrentVariableValue(varName) {
  if (!store.saveData?.vars || !varName) return undefined;
  const vars = store.saveData.vars;
  if (Object.prototype.hasOwnProperty.call(vars, varName)) return vars[varName];
  const short = normalizeVarKey(varName);
  if (Object.prototype.hasOwnProperty.call(vars, short)) return vars[short];
  return undefined;
}

export function evaluateConditionForSave(condition) {
  if (!store.saveData?.vars) return { ok: false, reason: 'no save' };
  return evaluateRenpyCondition(condition, store.saveData.vars);
}

export function statusBadge(met) {
  const span = document.createElement('span');
  span.style.marginLeft = '8px';
  span.style.fontSize = '10px';
  span.style.fontWeight = '700';
  span.style.padding = '1px 7px';
  span.style.borderRadius = '8px';
  if (met === null) {
    span.textContent = 'no save loaded';
    span.style.background = 'var(--panel2)';
    span.style.color = 'var(--text-dim)';
    span.style.fontWeight = '400';
  } else if (met === undefined) {
    span.textContent = '?';
    span.title = 'Could not evaluate this condition';
    span.style.background = 'var(--panel2)';
    span.style.color = 'var(--text-dim)';
    span.style.fontWeight = '400';
  } else if (met) {
    span.textContent = 'TRUE';
    span.style.background = '#2d4a2a';
    span.style.color = 'var(--good)';
  } else {
    span.textContent = 'FALSE';
    span.style.background = '#4a2a2a';
    span.style.color = 'var(--danger)';
  }
  return span;
}

export function conditionStatusBadge(condition) {
  if (!store.saveData?.vars) return statusBadge(null);
  const result = evaluateConditionForSave(condition);
  if (!result.ok) return statusBadge(undefined);
  return statusBadge(result.value);
}