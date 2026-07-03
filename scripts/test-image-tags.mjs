import { resolveImageTagAliases } from '../src/script-parser.js';

let passed = 0;
let failed = 0;

function assert(cond, label) {
  if (cond) { passed++; console.log('  ✓', label); }
  else { failed++; console.error('  ✗', label); }
}

const resolved = resolveImageTagAliases({
  mom: { type: 'path', value: 'images/mom.png' },
  'mom happy': { type: 'alias', value: 'mom' },
  eileen: { type: 'alias', value: 'eileen_base' },
  eileen_base: { type: 'path', value: 'eileen.png' },
  loop_a: { type: 'alias', value: 'loop_b' },
  loop_b: { type: 'alias', value: 'loop_a' },
});

assert(resolved.mom === 'images/mom.png', 'direct path');
assert(resolved['mom happy'] === 'images/mom.png', 'single-hop alias');
assert(resolved.eileen === 'eileen.png', 'two-hop alias chain');
assert(!resolved.loop_a && !resolved.loop_b, 'cycle not exported to dict');

console.log('');
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);