// Minimal pickle unpickler for Ren'Py RPA archive indexes only.
// Handles the dict[str/bytes -> list[tuple(int...)]] shape produced by Ren'Py.

const OP = {
  PROTO: 0x80,
  STOP: 0x2e,
  GLOBAL: 0x63,
  EMPTY_DICT: 0x7d,
  EMPTY_LIST: 0x5d,
  EMPTY_TUPLE: 0x29,
  MARK: 0x28,
  TUPLE: 0x74,
  TUPLE1: 0x85,
  TUPLE2: 0x86,
  TUPLE3: 0x87,
  SETITEM: 0x73,
  SETITEMS: 0x75,
  APPEND: 0x61,
  APPENDS: 0x65,
  BININT: 0x4a,
  BININT1: 0x4b,
  BININT2: 0x4d,
  LONG1: 0x8a,
  LONG: 0x4c,
  BINUNICODE: 0x58,
  SHORT_BINBYTES: 0x43,
  BINBYTES: 0x42,
  SHORT_BINSTRING: 0x55,
  BINSTRING: 0x54,
  UNICODE: 0x56,
  STRING: 0x53,
  BINGET: 0x68,
  BINPUT: 0x71,
  LONG_BINGET: 0x6a,
  LONG_BINPUT: 0x72,
  MEMOIZE: 0x94,
  NEWTRUE: 0x88,
  NEWFALSE: 0x89,
  NONE: 0x4e,
};

function readInt32LE(view, pos) {
  return view.getInt32(pos, true);
}

function readUint16LE(view, pos) {
  return view.getUint16(pos, true);
}

function readUint8(view, pos) {
  return view.getUint8(pos);
}

function readUint32LE(view, pos) {
  return view.getUint32(pos, true);
}

function readSignedLong(bytes, n) {
  let val = 0;
  for (let i = 0; i < n; i++) val += bytes[i] * Math.pow(2, 8 * i);
  if (n > 0 && (bytes[n - 1] & 0x80) && n < 8) val -= Math.pow(2, 8 * n);
  return val;
}

function bytesToStr(bytes) {
  if (typeof bytes === 'string') return bytes;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder('latin1').decode(bytes);
  }
}

function readUint64LE(view, pos) {
  const lo = view.getUint32(pos, true);
  const hi = view.getUint32(pos + 4, true);
  return hi * 0x1_0000_0000 + lo;
}

export function unpickleIndex(buffer) {
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const bytes = buffer;
  let pos = 0;
  let protocol = 2;
  const stack = [];
  const memo = [];
  const markStack = [];

  function readLine() {
    let end = pos;
    while (end < bytes.length && bytes[end] !== 0x0a) end++;
    const line = bytes.slice(pos, end);
    pos = end < bytes.length ? end + 1 : end;
    return line;
  }

  function readBytes(n) {
    const slice = bytes.slice(pos, pos + n);
    pos += n;
    return slice;
  }

  function popMark() {
    const mark = markStack.pop();
    return stack.splice(mark);
  }

  while (pos < bytes.length) {
    const op = readUint8(view, pos++);

    switch (op) {
      case OP.PROTO:
        protocol = readUint8(view, pos);
        pos += 1;
        break;

      case 0x95: { // FRAME (protocol 4+)
        pos += 8;
        break;
      }

      case 0x8c: { // SHORT_BINUNICODE (protocol 4+)
        const len = readUint8(view, pos);
        pos += 1;
        stack.push(bytesToStr(readBytes(len)));
        break;
      }

      case 0x8d: { // BINUNICODE8 (protocol 4+)
        const len = readUint64LE(view, pos);
        pos += 8;
        stack.push(bytesToStr(readBytes(len)));
        break;
      }

      case 0x8e: { // BINBYTES8 (protocol 4+)
        const len = readUint64LE(view, pos);
        pos += 8;
        stack.push(readBytes(len));
        break;
      }

      case 0x90: { // ADDITEMS (set)
        const items = popMark();
        const set = stack.pop();
        if (Array.isArray(set)) set.push(...items);
        stack.push(set);
        break;
      }

      case 0xcb: // EMPTY_SET
        stack.push([]);
        break;

      case OP.STOP: {
        if (stack.length !== 1) {
          throw new Error(`Pickle STOP with ${stack.length} stack items`);
        }
        const result = stack[0];
        if (result && typeof result === 'object' && !Array.isArray(result)) {
          const out = {};
          for (const [k, v] of Object.entries(result)) {
            out[bytesToStr(k)] = v;
          }
          return out;
        }
        return result;
      }

      case OP.GLOBAL:
        readLine(); // module
        readLine(); // name — we don't instantiate, just skip
        stack.push(null);
        break;

      case OP.EMPTY_DICT:
        stack.push({});
        break;

      case OP.EMPTY_LIST:
        stack.push([]);
        break;

      case OP.EMPTY_TUPLE:
        stack.push([]);
        break;

      case OP.MARK:
        markStack.push(stack.length);
        break;

      case OP.TUPLE: {
        const items = popMark();
        stack.push(items);
        break;
      }

      case OP.TUPLE1:
        stack.push([stack.pop()]);
        break;

      case OP.TUPLE2: {
        const b = stack.pop();
        const a = stack.pop();
        stack.push([a, b]);
        break;
      }

      case OP.TUPLE3: {
        const c = stack.pop();
        const b = stack.pop();
        const a = stack.pop();
        stack.push([a, b, c]);
        break;
      }

      case OP.SETITEM: {
        const value = stack.pop();
        const key = stack.pop();
        const dict = stack[stack.length - 1];
        dict[bytesToStr(key)] = value;
        break;
      }

      case OP.SETITEMS: {
        const items = popMark();
        const dict = stack.pop();
        for (let i = 0; i < items.length; i += 2) {
          dict[bytesToStr(items[i])] = items[i + 1];
        }
        stack.push(dict);
        break;
      }

      case OP.APPEND: {
        const value = stack.pop();
        const list = stack[stack.length - 1];
        list.push(value);
        break;
      }

      case OP.APPENDS: {
        const items = popMark();
        const list = stack.pop();
        list.push(...items);
        stack.push(list);
        break;
      }

      case OP.BININT:
        stack.push(readInt32LE(view, pos));
        pos += 4;
        break;

      case OP.BININT1:
        stack.push(readUint8(view, pos));
        pos += 1;
        break;

      case OP.BININT2:
        stack.push(readUint16LE(view, pos));
        pos += 2;
        break;

      case OP.LONG1: {
        if (protocol >= 4) {
          readLine();
          readLine();
          stack.push(null);
          break;
        }
        const n = readUint8(view, pos);
        pos += 1;
        const slice = readBytes(n);
        stack.push(readSignedLong(slice, n));
        break;
      }

      case OP.LONG: {
        const raw = readLine();
        stack.push(parseInt(bytesToStr(raw), 10));
        break;
      }

      case OP.BINUNICODE: {
        const len = readInt32LE(view, pos);
        pos += 4;
        stack.push(bytesToStr(readBytes(len)));
        break;
      }

      case OP.SHORT_BINBYTES: {
        const len = readUint8(view, pos);
        pos += 1;
        stack.push(readBytes(len));
        break;
      }

      case OP.BINBYTES: {
        const len = readInt32LE(view, pos);
        pos += 4;
        stack.push(readBytes(len));
        break;
      }

      case OP.SHORT_BINSTRING: {
        const len = readUint8(view, pos);
        pos += 1;
        stack.push(bytesToStr(readBytes(len)));
        break;
      }

      case OP.BINSTRING: {
        const len = readInt32LE(view, pos);
        pos += 4;
        stack.push(bytesToStr(readBytes(len)));
        break;
      }

      case OP.UNICODE: {
        const raw = readLine();
        stack.push(bytesToStr(raw));
        break;
      }

      case OP.STRING: {
        const raw = readLine();
        // Python string repr — strip quotes
        const s = bytesToStr(raw);
        stack.push(s.length >= 2 ? s.slice(1, -1) : s);
        break;
      }

      case OP.BINGET:
        stack.push(memo[readUint8(view, pos)]);
        pos += 1;
        break;

      case OP.BINPUT:
        memo[readUint8(view, pos)] = stack[stack.length - 1];
        pos += 1;
        break;

      case OP.LONG_BINGET:
        stack.push(memo[readUint32LE(view, pos)]);
        pos += 4;
        break;

      case OP.LONG_BINPUT:
        memo[readUint32LE(view, pos)] = stack[stack.length - 1];
        pos += 4;
        break;

      case OP.MEMOIZE:
        memo.push(stack[stack.length - 1]);
        break;

      case OP.NEWTRUE:
        stack.push(true);
        break;

      case OP.NEWFALSE:
        stack.push(false);
        break;

      case OP.NONE:
        stack.push(null);
        break;

      default:
        throw new Error(`Unsupported pickle opcode: 0x${op.toString(16)} at offset ${pos - 1}`);
    }
  }

  throw new Error('Pickle stream ended without STOP');
}