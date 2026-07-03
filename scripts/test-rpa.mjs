import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { unpickleIndex } from '../src/pickle-index.js';
import {
  parseRpaArchive,
  parseManualRpaOptions,
  tryParseGenericHeader,
  isKnownRpaHeader,
  readFileSlice,
  listStoryScriptPathsFromIndex,
  listVirtualPathsFromIndex,
  listAllPathsFromIndex,
} from '../src/rpa.js';
import { decodeZixOffset } from '../src/zix-rpa.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
let passed = 0;
let failed = 0;

function ok(label) {
  passed++;
  console.log('  ✓', label);
}

function fail(label, err) {
  failed++;
  console.error('  ✗', label, err?.message || err);
}

function assert(cond, label) {
  if (cond) ok(label);
  else fail(label, new Error('assertion failed'));
}

// gallery.rpa — standard RPA-3.0
try {
  const buf = readFileSync(join(root, 'testgame/game/gallery.rpa'));
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const parsed = parseRpaArchive(ab, 'gallery.rpa');
  assert(parsed.version === 'RPA-3.0', 'gallery.rpa parses as RPA-3.0');
  assert(Object.keys(parsed.index).length === 43, 'gallery.rpa has 43 index entries');
} catch (err) {
  fail('gallery.rpa', err);
}

// Header detection
assert(isKnownRpaHeader('RPA-3.0 00000000002e5bfa 42424242'), 'recognizes RPA-3.0');
assert(isKnownRpaHeader('RWA-3.0 00000000002e5bfa 42424242'), 'recognizes RWA-3.0');
assert(isKnownRpaHeader('SVAC-1.0 00000000002e5bfa aa bb'), 'recognizes SVAC-1.0');
assert(!isKnownRpaHeader('Made with RenPy'), 'rejects non-header');

// Generic / renamed prefix
const generic = tryParseGenericHeader('MYGAME-1.0 00000000002e5bfa deadbeef');
assert(generic?.offset === 0x2e5bfa, 'generic header offset');
assert((generic?.key >>> 0) === 0xdeadbeef, 'generic header XOR key');

// ZiX offset decode (parity with Python unrpa)
assert(decodeZixOffset('a1b2c3d4e5f60718') === 0x4da1b3c2, 'ZiX offset unscramble');

// Large-archive header (multi-GB images.rpa style)
const largeManual = parseManualRpaOptions({
  offsetHex: '0000000123b09074',
  keyHex: '42424242',
  format: 'rpa-3.0',
});
assert(largeManual.offset === 0x123b09074, 'large RPA-3.0 offset');
assert((largeManual.key >>> 0) === 0x42424242, 'large RPA-3.0 XOR key');

// Protocol 5 index uses LONG1 for offsets > 2 GiB (regression: images.rpa)
try {
  const hex = '80059524000000000000007d948c09746573742e77656270945d948a0521ca43c2004a020a4f42430094879461732e';
  const bytes = new Uint8Array(hex.match(/.{2}/g).map(h => parseInt(h, 16)));
  const idx = unpickleIndex(bytes);
  assert(idx['test.webp']?.[0]?.[0] === 3259222561, 'LONG1 large offset unpickles');
} catch (err) {
  fail('LONG1 protocol-5 index', err);
}

// readFileSlice past 2 GiB uses tail-relative Blob.slice (index/asset reads)
try {
  const fileSize = 0x123b09074 + 4096;
  const offset = 0x123b09074;
  const payload = new Uint8Array([0x78, 0x9c, 0x03, 0x00, 0x00, 0x00, 0x00, 0x01]);
  const backing = new Uint8Array(fileSize);
  backing.set(payload, offset);
  const mockBlob = {
    size: fileSize,
    slice(start, end) {
      let s = start;
      let e = end;
      if (s < 0) s = fileSize + s;
      if (e < 0) e = fileSize + e;
      if (e === undefined) e = fileSize;
      return {
        async arrayBuffer() {
          return backing.slice(s, e).buffer;
        },
      };
    },
  };
  const read = await readFileSlice(mockBlob, offset, payload.length);
  assert(read.length === payload.length, 'readFileSlice length past 2 GiB');
  assert(read[0] === 0x78 && read[1] === 0x9c, 'readFileSlice zlib magic past 2 GiB');
} catch (err) {
  fail('readFileSlice large offset', err);
}

// RPA-3.2 key folding: keys from field 4+ only (3 fields = offset + pad + no keys from part 3)
// Header layout tested via tryParseGenericHeader for custom prefixes only

const mockIndex = {
  'script.rpy': [[0, 100]],
  'chapter1.rpyc': [[100, 200]],
  'images/bg.png': [[300, 50]],
  'renpy/common.rpy': [[400, 10]],
  'gui.rpy': [[500, 10]],
};
const scripts = listStoryScriptPathsFromIndex(mockIndex);
assert(scripts.includes('script.rpy'), 'archive index includes script.rpy');
assert(scripts.includes('chapter1.rpyc'), 'archive index includes chapter1.rpyc');
assert(!scripts.includes('images/bg.png'), 'archive script list excludes images');
assert(!scripts.some(p => p.includes('renpy/')), 'archive script list excludes renpy/');
assert(!scripts.includes('gui.rpy'), 'archive script list excludes gui.rpy');
const virtual = listVirtualPathsFromIndex(mockIndex);
assert(virtual.includes('images/bg.png') && virtual.includes('script.rpy'), 'virtual paths merge media + scripts');
const all = listAllPathsFromIndex(mockIndex);
assert(all.length === Object.keys(mockIndex).length, 'all paths returns full archive index');

console.log('');
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);