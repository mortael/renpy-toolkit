import { parseRpyContent, buildIndexes } from '../src/script-parser.js';

let passed = 0;
let failed = 0;

function assert(cond, label) {
  if (cond) { passed++; console.log('  ✓', label); }
  else { failed++; console.error('  ✗', label); }
}

const sample = `
default mom_affection = 0
default persistent.gallery_unlocked = False
define j = Character("Joseph", color="#fff")
define fade2 = Fade(1.0, 0.0, 1.0)

label start:
    $ persistent.cg1 = True
    if mom_affection >= 5 and persistent.cg1:
        jump next_part
    call sub_label

label next_part:
    "Hello"

label sub_label:
    return
`;

const scripts = parseRpyContent(sample, 'test.rpy');
const idx = buildIndexes(scripts);

assert(idx.varIndex.mom_affection?.setters?.length >= 1, 'default mom_affection indexed as setter');
assert(idx.varIndex['persistent.gallery_unlocked']?.setters?.length >= 1, 'default persistent.gallery_unlocked indexed');
assert(idx.varIndex['persistent.cg1']?.setters?.length >= 1, '$ persistent.cg1 indexed as setter');
assert(idx.varIndex.mom_affection?.checkers?.length >= 1, 'if mom_affection checker');
assert(idx.varIndex['persistent.cg1']?.checkers?.length >= 1, 'if persistent.cg1 checker');

assert(idx.characters.j?.displayName === 'Joseph', 'define Character j → Joseph');
assert(!idx.characters.fade2, 'Fade define not treated as character');

assert(idx.labelRefs.next_part?.length >= 1, 'next_part has incoming jump');
assert(idx.labelRefs.next_part[0].fromLabel === 'start', 'jump to next_part from start');
assert(idx.labelRefs.sub_label?.length >= 1, 'sub_label has incoming call');

const startScript = scripts.find(s => s.label === 'start');
const outgoing = (startScript?.lines || []).filter(l => l.type === 'transfer').map(l => l.target);
assert(outgoing.includes('next_part') && outgoing.includes('sub_label'), 'start has outgoing jump/call targets');

console.log('');
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);