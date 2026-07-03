import { inflate } from 'pako';
import { unpickleIndex } from './pickle-index.js';
import {
  decodeZix12bPrefix,
  decodeZixOffset,
  findZixMetadata,
  isZixHeaderPrefix,
} from './zix-rpa.js';

const HEADER_VERSIONS = [
  { name: 'RPA-1.0', prefix: null, ext: '.rpi' },
  { name: 'RPA-2.0', prefix: 'RPA-2.0' },
  { name: 'RPA-3.0', prefix: 'RPA-3.0' },
  { name: 'RPA-3.2', prefix: 'RPA-3.2' },
  { name: 'RPA-4.0', prefix: 'RPA-4.0' },
  { name: 'ALT-1.0', prefix: 'ALT-1.0', altKey: 0xDABE8DF0 },
];

export class RpaParseError extends Error {
  constructor(message, { headerLine = '', filename = '', needsManual = false } = {}) {
    super(message);
    this.name = 'RpaParseError';
    this.headerLine = headerLine;
    this.filename = filename;
    this.needsManual = needsManual;
  }
}

function readHeaderLine(bytes) {
  let end = 0;
  while (end < bytes.length && bytes[end] !== 0x0a) end++;
  return new TextDecoder().decode(bytes.slice(0, end));
}

function headerEndOffset(bytes) {
  let end = 0;
  while (end < bytes.length && bytes[end] !== 0x0a) end++;
  return end + 1;
}

function parseKeyFromHexParts(parts, startIdx) {
  let key = 0;
  for (let i = startIdx; i < parts.length; i++) {
    const v = parseInt(parts[i], 16);
    if (!Number.isFinite(v)) return null;
    key ^= v;
  }
  return key;
}

/** Renamed-prefix archives often keep RPA-3.0 layout: PREFIX <offset> [hex keys…] */
export function tryParseGenericHeader(headerLine) {
  const parts = headerLine.trim().split(/\s+/);
  if (parts.length < 2) return null;
  const offset = parseInt(parts[1], 16);
  if (!Number.isFinite(offset)) return null;

  if (parts.length === 2) {
    return { version: `custom:${parts[0]}`, offset, key: null };
  }

  const key = parseKeyFromHexParts(parts, 2);
  if (key === null) return null;
  return { version: `custom:${parts[0]}`, offset, key: key || null };
}

export function parseManualRpaOptions({ offsetHex, keyHex, xorKeysHex, format }) {
  const offset = parseInt(String(offsetHex).trim(), 16);
  if (!Number.isFinite(offset)) throw new Error('Invalid index offset (use hex, e.g. 0x1234abcd)');

  let key = null;
  if (format === 'alt-1.0') {
    const raw = parseInt(String(keyHex).trim(), 16);
    if (!Number.isFinite(raw)) throw new Error('ALT-1.0 needs a hex key');
    key = raw ^ 0xDABE8DF0;
  } else if (format === 'rpa-3.2') {
    const keys = String(xorKeysHex || keyHex || '').trim().split(/\s+/).filter(Boolean);
    if (!keys.length) throw new Error('RPA-3.2 needs at least one hex XOR key');
    key = parseKeyFromHexParts(keys, 0);
    if (key === null) throw new Error('Invalid hex XOR key(s)');
  } else if (format === 'rpa-3.0' || format === 'rpa-4.0') {
    const keys = String(xorKeysHex || keyHex || '').trim().split(/\s+/).filter(Boolean);
    if (keys.length) {
      key = parseKeyFromHexParts(keys, 0);
      if (key === null) throw new Error('Invalid hex XOR key(s)');
    } else {
      key = 0;
    }
  } else {
    key = null; // rpa-2.0
  }

  return { version: `manual:${format}`, offset, key };
}

function parseHeader(headerLine, ext) {
  if (ext === '.rpi') {
    return { version: 'RPA-1.0', offset: 0, key: null, indexFormat: 'pickle' };
  }

  const parts = headerLine.trim().split(/\s+/);

  // Renamed RPA-3.0 headers (rpatool.py / community obfuscation)
  if (headerLine.startsWith('RWA-3.0 ')) {
    return {
      version: 'RWA-3.0',
      offset: parseInt(parts[1], 16),
      key: parseKeyFromHexParts(parts, 2),
      indexFormat: 'pickle',
    };
  }

  if (headerLine.startsWith('SVAC-1.0 ')) {
    const offset = parseInt(parts[1], 16);
    // Exactly 4 header fields → true SVAC-1.0 JSON index; otherwise RPA-3.0 pickle underneath.
    if (parts.length === 4) {
      return { version: 'SVAC-1.0', offset, key: null, indexFormat: 'svac-json' };
    }
    return {
      version: 'SVAC-1.0 (RPA-3.0)',
      offset,
      key: parseKeyFromHexParts(parts, 2),
      indexFormat: 'pickle',
    };
  }

  for (const v of HEADER_VERSIONS) {
    if (!v.prefix) continue;
    if (!headerLine.startsWith(v.prefix)) continue;

    const parts = headerLine.trim().split(/\s+/);
    if (v.prefix === 'RPA-2.0') {
      return { version: v.name, offset: parseInt(parts[1], 16), key: null, indexFormat: 'pickle' };
    }
    if (v.prefix === 'ALT-1.0') {
      const rawKey = parseInt(parts[1], 16);
      const offset = parseInt(parts[2], 16);
      return { version: v.name, offset, key: rawKey ^ v.altKey, indexFormat: 'pickle' };
    }
    if (v.prefix === 'RPA-3.2') {
      const offset = parseInt(parts[1], 16);
      const key = parseKeyFromHexParts(parts, 3);
      return { version: v.name, offset, key, indexFormat: 'pickle' };
    }
    const offset = parseInt(parts[1], 16);
    const key = parseKeyFromHexParts(parts, 2);
    return { version: v.name, offset, key, indexFormat: 'pickle' };
  }

  const generic = tryParseGenericHeader(headerLine);
  if (generic) {
    const prefix = headerLine.trim().split(/\s+/)[0];
    if (isZixHeaderPrefix(prefix)) {
      const parts = headerLine.trim().split(/\s+/);
      const decoded = decodeZixOffset(parts[parts.length - 1]);
      if (decoded != null) {
        return {
          version: prefix,
          offset: decoded,
          key: null,
          zixMeta: {
            variant: /^ZiX-12B$/i.test(prefix) ? 'ZiX-12B' : 'ZiX-12A',
            runAmount: null,
          },
        };
      }
    }
    return generic;
  }

  throw new RpaParseError(`Unrecognized RPA header: ${headerLine.slice(0, 60)}`, {
    headerLine,
    needsManual: true,
  });
}

function normalizeEntry(entry) {
  return entry.map(part => {
    if (part.length === 2) return [part[0], part[1], new Uint8Array(0)];
    return [part[0], part[1], part[2] instanceof Uint8Array ? part[2] : new Uint8Array(part[2] || [])];
  });
}

function deobfuscateIndex(key, index) {
  const out = {};
  for (const [path, entry] of Object.entries(index)) {
    out[path] = normalizeEntry(entry).map(([offset, length, prefix]) => [
      offset ^ key,
      length ^ key,
      prefix,
    ]);
  }
  return out;
}

function normalizeIndex(index) {
  const out = {};
  for (const [path, entry] of Object.entries(index)) {
    out[path] = normalizeEntry(entry);
  }
  return out;
}

function loadIndexAtOffset(bytes, offset, key) {
  const compressed = bytes.slice(offset);
  const decompressed = inflate(compressed);
  const rawIndex = unpickleIndex(decompressed);
  return key != null ? deobfuscateIndex(key, rawIndex) : normalizeIndex(rawIndex);
}

function findBytes(haystack, needle) {
  if (!haystack?.length || !needle?.length) return -1;
  outer: for (let i = 0; i <= haystack.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

function readUint32LE(bytes, pos) {
  return (
    bytes[pos] |
    (bytes[pos + 1] << 8) |
    (bytes[pos + 2] << 16) |
    (bytes[pos + 3] << 24)
  ) >>> 0;
}

/** SVAC-1.0 variant A: JSON embedded in Ogg/Vorbis comments. */
function decodeSvac1Ogg(data) {
  const marker = new Uint8Array([0x03, ...new TextEncoder().encode('vorbis')]);
  const pos = findBytes(data, marker);
  if (pos < 0) throw new Error('SVAC-1.0: Vorbis package (type 3) not found in Ogg stream');

  const vendorLen = readUint32LE(data, pos + 7);
  let p = pos + 11 + vendorLen;
  const commentCount = readUint32LE(data, p);
  p += 4;

  for (let i = 0; i < commentCount; i++) {
    const length = readUint32LE(data, p);
    p += 4;
    const comment = data.slice(p, p + length);
    p += length;
    if (comment.length >= 5 && comment[0] === 0x4a && comment[1] === 0x53 && comment[2] === 0x4f && comment[3] === 0x4e && comment[4] === 0x3d) {
      return new TextDecoder().decode(comment.slice(5));
    }
  }

  throw new Error('SVAC-1.0: JSON not found in Vorbis comments');
}

/** SVAC-1.0 true format: zlib JSON or Ogg-encapsulated JSON index. */
function loadSvac1IndexAtOffset(bytes, offset) {
  const compressed = bytes.slice(offset);
  let jsonData;
  try {
    jsonData = new TextDecoder().decode(inflate(compressed));
  } catch {
    jsonData = decodeSvac1Ogg(compressed);
  }

  const raw = JSON.parse(jsonData);
  const files = raw?.files;
  if (!files || typeof files !== 'object') {
    throw new Error('SVAC-1.0: index JSON missing "files" object');
  }

  const index = {};
  for (const [name, info] of Object.entries(files)) {
    if (!Array.isArray(info) || info.length < 2) continue;
    index[name] = [[info[0], info[1], new Uint8Array(0)]];
  }
  return index;
}

function loadParsedIndex(bytes, attempt) {
  if (attempt.indexFormat === 'svac-json') {
    return loadSvac1IndexAtOffset(bytes, attempt.offset);
  }
  return loadIndexAtOffset(bytes, attempt.offset, attempt.key);
}

function attemptSignature(offset, key) {
  return `${offset}:${key == null ? 'null' : key}`;
}

function collectLoadAttempts(headerLine, primaryHeader, options = {}) {
  const attempts = [];
  const seen = new Set();

  function add(version, offset, key, zixMeta = null, indexFormat = 'pickle') {
    if (!Number.isFinite(offset) || offset < 0 || offset >= Number.MAX_SAFE_INTEGER) return;
    const sig = `${attemptSignature(offset, key)}:${indexFormat}`;
    if (seen.has(sig)) return;
    seen.add(sig);
    attempts.push({ version, offset, key, zixMeta, indexFormat });
  }

  add(
    primaryHeader.version,
    primaryHeader.offset,
    primaryHeader.key,
    primaryHeader.zixMeta,
    primaryHeader.indexFormat || 'pickle',
  );

  const parts = headerLine.trim().split(/\s+/);
  if (parts.length < 2) return attempts;

  const prefix = parts[0];
  const isZix = isZixHeaderPrefix(prefix);
  const offsetTokens = isZix
    ? [parts[parts.length - 1]]
    : [parts[1], parts.length > 2 ? parts[parts.length - 1] : null].filter(Boolean);

  const headerKeys = [];
  if (parts.length >= 3) {
    const folded = parseKeyFromHexParts(parts, 2);
    if (folded !== null) headerKeys.push(folded);
  }
  if (parts.length > 3) {
    const folded32 = parseKeyFromHexParts(parts, 3);
    if (folded32 !== null) headerKeys.push(folded32);
  }

  if (options.zixKey != null) headerKeys.push(options.zixKey);

  for (const token of offsetTokens) {
    const decoded = decodeZixOffset(token);
    if (decoded == null) continue;

    const zixMeta = isZix
      ? {
          variant: prefix.toUpperCase().startsWith('ZIX-12B') ? 'ZiX-12B' : 'ZiX-12A',
          runAmount: options.zixRunAmount ?? null,
        }
      : null;

    for (const key of headerKeys.length ? headerKeys : [null]) {
      add(`zix:${prefix}`, decoded, key, zixMeta ? { ...zixMeta, key } : null, 'pickle');
    }
  }

  return attempts;
}

function tryParseAttempts(bytes, attempts) {
  let lastErr = null;
  for (const attempt of attempts) {
    try {
      const index = loadParsedIndex(bytes, attempt);
      return {
        version: attempt.version,
        index,
        zixMeta: attempt.zixMeta || null,
      };
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error('No parse attempts available');
}

const HEADER_READ_BYTES = 65536;

/** Read only the first chunk of a File — safe for multi-GB archives. */
export async function readHeaderFromFile(file) {
  const end = Math.min(file.size, HEADER_READ_BYTES);
  const buf = await file.slice(0, end).arrayBuffer();
  return readHeaderLine(new Uint8Array(buf));
}

async function loadParsedIndexFromFile(file, attempt) {
  const buf = await file.slice(attempt.offset).arrayBuffer();
  const bytes = new Uint8Array(buf);
  return loadParsedIndex(bytes, { ...attempt, offset: 0 });
}

async function tryParseAttemptsFromFile(file, attempts) {
  let lastErr = null;
  for (const attempt of attempts) {
    try {
      const index = await loadParsedIndexFromFile(file, attempt);
      return {
        version: attempt.version,
        index,
        zixMeta: attempt.zixMeta || null,
      };
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error('No parse attempts available');
}

/**
 * Parse an RPA archive from a File without loading the entire file into RAM.
 * Keeps a File handle for lazy per-entry reads via readRpaFile().
 */
export async function parseRpaArchiveFromFile(file, filename = 'archive.rpa', options = {}) {
  if (!file?.slice) throw new Error('parseRpaArchiveFromFile needs a browser File');

  if (options.manual) {
    const { offset, key, version = 'manual' } = options.manual;
    const index = await loadParsedIndexFromFile(file, { offset, key, indexFormat: 'pickle' });
    return { version, index, zixMeta: options.zixMeta || null, archiveFile: file };
  }

  const ext = filename.toLowerCase().endsWith('.rpi') ? '.rpi' : '.rpa';
  if (ext === '.rpi') {
    const buf = await file.arrayBuffer();
    const parsed = parseRpaArchive(buf, filename, options);
    return { ...parsed, archiveFile: file };
  }

  const headerLine = await readHeaderFromFile(file);
  let primaryHeader;
  try {
    primaryHeader = parseHeader(headerLine, ext);
  } catch (err) {
    if (err instanceof RpaParseError) {
      err.filename = filename;
      throw err;
    }
    throw new RpaParseError(err.message, { headerLine, filename, needsManual: true });
  }

  if (!Number.isFinite(primaryHeader.offset)) {
    throw new RpaParseError(`Invalid index offset in header: ${headerLine.slice(0, 60)}`, {
      headerLine,
      filename,
      needsManual: true,
    });
  }

  const attempts = collectLoadAttempts(headerLine, primaryHeader, {
    zixKey: options.zixKey ?? null,
    zixRunAmount: options.zixRunAmount ?? null,
  });

  try {
    const parsed = await tryParseAttemptsFromFile(file, attempts);
    return { ...parsed, archiveFile: file };
  } catch (err) {
    throw new RpaParseError(
      `Failed to read RPA index (${attempts.length} attempt(s)): ${err.message}`,
      { headerLine, filename, needsManual: true },
    );
  }
}

/** File-based parse with ZiX metadata scan from loaded game scripts. */
export async function parseRpaArchiveAsyncFromFile(file, filename = 'archive.rpa', options = {}) {
  let firstErr;
  try {
    return await parseRpaArchiveFromFile(file, filename, options);
  } catch (err) {
    firstErr = err;
    if (!(err instanceof RpaParseError) || !err.needsManual) throw err;
    if (options.manual) throw err;
  }

  const zixMeta = await findZixMetadata(options.fileIndex);
  if (!zixMeta) throw firstErr;

  try {
    const parsed = await parseRpaArchiveFromFile(file, filename, {
      zixKey: zixMeta.key,
      zixRunAmount: zixMeta.runAmount,
    });
    if (parsed.zixMeta) {
      parsed.zixMeta.key = zixMeta.key;
      parsed.zixMeta.runAmount = zixMeta.runAmount;
    } else if (zixMeta.runAmount != null) {
      parsed.zixMeta = {
        variant: 'ZiX-12B',
        key: zixMeta.key,
        runAmount: zixMeta.runAmount,
      };
    }
    return parsed;
  } catch (retryErr) {
    if (retryErr instanceof RpaParseError) {
      retryErr.filename = filename;
      throw retryErr;
    }
    throw firstErr;
  }
}

/**
 * Parse an RPA archive from raw bytes.
 * @param {ArrayBuffer} arrayBuffer
 * @param {string} filename
 * @param {{ manual?: { offset: number, key: number|null, version?: string } }} options
 */
export function parseRpaArchive(arrayBuffer, filename = 'archive.rpa', options = {}) {
  const bytes = new Uint8Array(arrayBuffer);
  const ext = filename.toLowerCase().endsWith('.rpi') ? '.rpi' : '.rpa';

  if (options.manual) {
    const { offset, key, version = 'manual' } = options.manual;
    const index = loadIndexAtOffset(bytes, offset, key);
    return { version, index, zixMeta: options.zixMeta || null };
  }

  if (ext === '.rpi') {
    const decompressed = inflate(bytes);
    const rawIndex = unpickleIndex(decompressed);
    return { version: 'RPA-1.0', index: normalizeIndex(rawIndex), zixMeta: null };
  }

  const headerLine = readHeaderLine(bytes);
  let primaryHeader;

  try {
    primaryHeader = parseHeader(headerLine, ext);
  } catch (err) {
    if (err instanceof RpaParseError) {
      err.filename = filename;
      throw err;
    }
    throw new RpaParseError(err.message, { headerLine, filename, needsManual: true });
  }

  if (!Number.isFinite(primaryHeader.offset)) {
    throw new RpaParseError(`Invalid index offset in header: ${headerLine.slice(0, 60)}`, {
      headerLine,
      filename,
      needsManual: true,
    });
  }

  const attempts = collectLoadAttempts(headerLine, primaryHeader, {
    zixKey: options.zixKey ?? null,
    zixRunAmount: options.zixRunAmount ?? null,
  });

  try {
    return tryParseAttempts(bytes, attempts);
  } catch (err) {
    throw new RpaParseError(
      `Failed to read RPA index (${attempts.length} attempt(s)): ${err.message}`,
      { headerLine, filename, needsManual: true },
    );
  }
}

/**
 * Parse an RPA archive, scanning loaded game files for ZiX verification metadata when needed.
 * @param {ArrayBuffer} arrayBuffer
 * @param {string} filename
 * @param {{ fileIndex?: Array, manual?: object }} options
 */
export async function parseRpaArchiveAsync(arrayBuffer, filename = 'archive.rpa', options = {}) {
  let firstErr;
  try {
    return parseRpaArchive(arrayBuffer, filename, options);
  } catch (err) {
    firstErr = err;
    if (!(err instanceof RpaParseError) || !err.needsManual) throw err;
    if (options.manual) throw err;
  }

  const zixMeta = await findZixMetadata(options.fileIndex);
  if (!zixMeta) throw firstErr;

  try {
    const parsed = parseRpaArchive(arrayBuffer, filename, {
      zixKey: zixMeta.key,
      zixRunAmount: zixMeta.runAmount,
    });
    if (parsed.zixMeta) {
      parsed.zixMeta.key = zixMeta.key;
      parsed.zixMeta.runAmount = zixMeta.runAmount;
    } else if (zixMeta.runAmount != null) {
      parsed.zixMeta = {
        variant: 'ZiX-12B',
        key: zixMeta.key,
        runAmount: zixMeta.runAmount,
      };
    }
    return parsed;
  } catch (retryErr) {
    if (retryErr instanceof RpaParseError) {
      retryErr.filename = filename;
      throw retryErr;
    }
    throw firstErr;
  }
}

function assembleRpaPart(body, prefixBytes, zixMeta) {
  let out;
  if (prefixBytes.length === 0) {
    out = body;
  } else {
    out = new Uint8Array(prefixBytes.length + body.length);
    out.set(prefixBytes, 0);
    out.set(body, prefixBytes.length);
  }
  if (zixMeta?.variant === 'ZiX-12B' && zixMeta.key != null && zixMeta.runAmount > 0) {
    return decodeZix12bPrefix(out, zixMeta.key, zixMeta.runAmount);
  }
  return out;
}

/** @param {Uint8Array|File|{ archiveFile?: File, archiveBytes?: Uint8Array }} source */
export async function readRpaFile(path, parts, source, zixMeta = null) {
  const part = parts[0];
  const [offset, length, prefix] = part;
  const prefixBytes = prefix instanceof Uint8Array ? prefix : new Uint8Array(prefix || []);
  const dataLen = length - prefixBytes.length;

  let body;
  if (source instanceof Uint8Array) {
    body = source.slice(offset, offset + dataLen);
  } else if (source instanceof File || (source && typeof source.slice === 'function' && typeof source.size === 'number')) {
    const buf = await source.slice(offset, offset + dataLen).arrayBuffer();
    body = new Uint8Array(buf);
  } else if (source?.archiveBytes instanceof Uint8Array) {
    body = source.archiveBytes.slice(offset, offset + dataLen);
  } else if (source?.archiveFile) {
    const buf = await source.archiveFile.slice(offset, offset + dataLen).arrayBuffer();
    body = new Uint8Array(buf);
  } else {
    throw new Error('No archive data source for ' + path);
  }

  return assembleRpaPart(body, prefixBytes, zixMeta);
}

export function listMediaFromIndex(index) {
  return Object.keys(index).filter(p => {
    const lower = p.toLowerCase();
    return /\.(png|jpg|jpeg|webp|gif|ogg|opus|mp3|wav|m4a|webm|mp4|avif)$/.test(lower);
  });
}

const SKIP_ARCHIVE_SCRIPTS = new Set(['gui.rpy', 'options.rpy', 'gui.rpyc', 'options.rpyc']);

/** Story-relevant script paths inside an RPA index (for Story Browser virtual fileIndex). */
export function listStoryScriptPathsFromIndex(index) {
  return Object.keys(index).filter(p => {
    const norm = p.replace(/\\/g, '/').toLowerCase();
    if (norm.includes('/renpy/') || norm.startsWith('renpy/')) return false;
    const base = norm.split('/').pop();
    if (SKIP_ARCHIVE_SCRIPTS.has(base)) return false;
    return /\.(rpy|rpyc|rpymc?)$/i.test(norm);
  });
}

/** All fileIndex virtual paths to expose from an archive (media + scripts). */
export function listVirtualPathsFromIndex(index) {
  return [...new Set([
    ...listMediaFromIndex(index),
    ...listStoryScriptPathsFromIndex(index),
  ])];
}

/** Every indexed path in an archive (full Asset Browser tree). */
export function listAllPathsFromIndex(index) {
  return Object.keys(index);
}

export function isKnownRpaHeader(headerLine) {
  return /^(RPA-[234](?:\.\d)?|ALT-1\.0|RWA-3\.0|SVAC-1\.0)\s/.test(String(headerLine || '').trim());
}

export function isZlibAtStart(bytes) {
  if (!bytes?.length || bytes.length < 2) return false;
  const cmf = bytes[0];
  const flg = bytes[1];
  if (cmf !== 0x78) return false;
  return (flg % 31) === 0;
}

/** RPA-1.0 uses separate .rpa (data) + .rpi (zlib+pickle index) files. */
export function findRpa10Pair(entry, fileIndex) {
  if (!entry?.relPath || !fileIndex?.length) return null;

  const rel = entry.relPath.replace(/\\/g, '/');
  const base = rel.replace(/\.(rpa|rpi)$/i, '');
  const siblingPath = `${base}${/\.rpa$/i.test(rel) ? '.rpi' : '.rpa'}`;
  const sibling = fileIndex.find(e => e.relPath.replace(/\\/g, '/') === siblingPath);
  if (!sibling?.file) return null;

  if (/\.rpa$/i.test(rel)) {
    return { dataEntry: entry, indexEntry: sibling, baseName: base.split('/').pop() };
  }
  return { dataEntry: sibling, indexEntry: entry, baseName: base.split('/').pop() };
}

export function parseRpa10Pair(indexArrayBuffer, dataArrayBuffer) {
  const indexBytes = new Uint8Array(indexArrayBuffer);
  if (!isZlibAtStart(indexBytes)) {
    throw new RpaParseError('RPA-1.0 index (.rpi) is not zlib-compressed', { needsManual: true });
  }

  const decompressed = inflate(indexBytes);
  const rawIndex = unpickleIndex(decompressed);
  return {
    version: 'RPA-1.0',
    index: normalizeIndex(rawIndex),
    dataBytes: new Uint8Array(dataArrayBuffer),
    zixMeta: null,
  };
}

/** RPA-1.0 pair — reads small .rpi fully, keeps large .rpa as File for lazy reads. */
export async function parseRpa10PairFromFiles(indexFile, dataFile) {
  const indexBuf = await indexFile.arrayBuffer();
  const indexBytes = new Uint8Array(indexBuf);
  if (!isZlibAtStart(indexBytes)) {
    throw new RpaParseError('RPA-1.0 index (.rpi) is not zlib-compressed', { needsManual: true });
  }
  const decompressed = inflate(indexBytes);
  const rawIndex = unpickleIndex(decompressed);
  return {
    version: 'RPA-1.0',
    index: normalizeIndex(rawIndex),
    archiveFile: dataFile,
    zixMeta: null,
  };
}

export { headerEndOffset, readHeaderLine };