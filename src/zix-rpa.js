/** ZiX-12A / ZiX-12B helpers (ported from Lattyware/unrpa zix.py). */

const MAGIC_KEYS = [
  3621826839565189698n,
  8167163782024462963n,
  5643161164948769306n,
  4940859562182903807n,
  2672489546482320731n,
  8917212212349173728n,
  7093854916990953299n,
];

const ZIX_VERIFICATION_RE =
  /verificationcode\s*=\s*_string\.sha1\s*\(\s*['"]([^'"]+)['"]\s*\)/i;
const ZIX_RUN_AMOUNT_RE =
  /_string\.run\s*\(\s*rv\.read\s*\(\s*(\d+)\s*\)\s*,\s*verificationcode\s*\)/i;

/** Reverse-engineered offset unscramble used by ZiX archives. */
export function decodeZixOffset(hexValue) {
  const value = String(hexValue || '').trim();
  if (!/^[0-9a-fA-F]+$/.test(value) || value.length < 8) return null;

  const a = value.slice(6, 8).split('').reverse().join('');
  const b = value.slice(0, 3);
  const c = value.slice(3, 6).split('').reverse().join('');
  const decoded = parseInt(a + b + c, 16);
  return Number.isFinite(decoded) ? decoded : null;
}

/** Derive XOR key from the verification string embedded in loader scripts. */
export function deriveZixKey(verificationCode) {
  const digits = String(verificationCode || '').replace(/\D/g, '');
  if (!digits) return null;

  const a = BigInt(digits) + 102464652121606009n;
  const aNum = Number(a);
  if (!Number.isFinite(aNum)) return null;

  const b = Math.round(Math.cbrt(aNum)) / 23 * 109;
  return Math.trunc(b);
}

export function decodeZixRun(data, key) {
  if (!data?.length || key == null) return data;

  const count = Math.floor(data.length / 8);
  if (count === 0) return data;

  const out = new Uint8Array(data);
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  const keyBig = BigInt(key);

  for (let i = 0; i < count; i++) {
    const magic = MAGIC_KEYS[i % MAGIC_KEYS.length];
    const part = view.getBigUint64(i * 8, true);
    view.setBigUint64(i * 8, magic ^ keyBig ^ part, true);
  }

  return out;
}

export function decodeZix12bPrefix(bytes, key, amount) {
  if (!bytes?.length || !amount || amount <= 0) return bytes;
  const prefixLen = Math.min(amount, bytes.length);
  const out = new Uint8Array(bytes);
  const decoded = decodeZixRun(out.slice(0, prefixLen), key);
  out.set(decoded, 0);
  return out;
}

/** Scan loaded game files for ZiX verification metadata (usually in renpy/loader.rpy). */
export async function findZixMetadata(fileIndex) {
  if (!fileIndex?.length) return null;

  let verificationCode = null;
  let runAmount = null;

  const candidates = fileIndex
    .filter(entry => entry.file && /\.(rpy|py)$/i.test(entry.relPath))
    .sort((a, b) => {
      const aLoader = /loader\.rpy$/i.test(a.relPath) ? 0 : 1;
      const bLoader = /loader\.rpy$/i.test(b.relPath) ? 0 : 1;
      return aLoader - bLoader;
    });

  for (const entry of candidates) {

    let text;
    try {
      text = await entry.file.text();
    } catch {
      continue;
    }

    const codeMatch = text.match(ZIX_VERIFICATION_RE);
    if (codeMatch) verificationCode = codeMatch[1];

    const runMatch = text.match(ZIX_RUN_AMOUNT_RE);
    if (runMatch) runAmount = parseInt(runMatch[1], 10);
  }

  if (!verificationCode) return null;

  const key = deriveZixKey(verificationCode);
  if (key == null) return null;

  return {
    verificationCode,
    key,
    runAmount: Number.isFinite(runAmount) ? runAmount : null,
  };
}

export function isZixHeaderPrefix(prefix) {
  return /^ZiX-12[AB]$/i.test(String(prefix || '').trim());
}