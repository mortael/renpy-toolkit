import { evaluateRenpyCondition } from '../src/condition-eval.js';

let passed = 0;
let failed = 0;

function assert(cond, label) {
  if (cond) { passed++; console.log('  ✓', label); }
  else { failed++; console.error('  ✗', label); }
}

const vars = {
  mom_affection: 7,
  flag: false,
  'persistent.cg1': true,
  persistent: { cg1: true },
  empty: 0,
};

function ev(expr) {
  return evaluateRenpyCondition(expr, vars);
}

assert(ev('mom_affection >= 5').ok && ev('mom_affection >= 5').value === true, '>= comparison true');
assert(ev('mom_affection < 5').ok && ev('mom_affection < 5').value === false, '>= comparison false');
assert(ev('persistent.cg1').ok && ev('persistent.cg1').value === true, 'dotted var truthy');
assert(ev('not flag').ok && ev('not flag').value === true, 'not flag');
assert(ev('mom_affection >= 5 and persistent.cg1').ok && ev('mom_affection >= 5 and persistent.cg1').value === true, 'and chain');
assert(ev('flag or persistent.cg1').ok && ev('flag or persistent.cg1').value === true, 'or chain');
assert(ev('empty').ok && ev('empty').value === false, 'zero is falsy');
assert(ev('mom_affection == 7').ok && ev('mom_affection == 7').value === true, 'equality');
assert(!ev('getattr(store, "x")').ok, 'unknown complex expr returns not ok');

console.log('');
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);