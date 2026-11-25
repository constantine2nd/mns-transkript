// Minimal zip reader and writer for transcript bundles (docs/bundle-format.md).
// Reader: central-directory based, so entries written by Java's ZipOutputStream (data descriptors,
// local header sizes 0) read correctly. Methods 0 (STORE) and 8 (DEFLATE). Writer: STORE only.

const SIG_EOCD = 0x06054b50;
const SIG_CEN = 0x02014b50;
const SIG_LOC = 0x04034b50;

let CRC_TABLE = null;
function crcTable() {
  if (CRC_TABLE) return CRC_TABLE;
  CRC_TABLE = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    CRC_TABLE[n] = c >>> 0;
  }
  return CRC_TABLE;
}

export function crc32(bytes) {
  const t = crcTable();
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = t[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export class ZipError extends Error {}

/** Inflates raw DEFLATE data with the browser's DecompressionStream. */
export async function inflateRawWeb(data) {
  const ds = new DecompressionStream('deflate-raw');
  const stream = new Blob([data]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function toBytes(buf) {
  if (buf instanceof Uint8Array) return buf;
  if (buf instanceof ArrayBuffer) return new Uint8Array(buf);
  if (ArrayBuffer.isView(buf)) return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  throw new ZipError('not a byte buffer');
}

/**
 * Lists the entries of a zip. Each entry: {name, method, compressedSize, size, crc, read()}, where
 * read() resolves to the uncompressed bytes (CRC checked).
 * @param {Uint8Array|ArrayBuffer} buf
 * @param {{inflateRaw?: (data: Uint8Array) => Promise<Uint8Array>}} [opts]
 */
export function readZip(buf, opts = {}) {
  const bytes = toBytes(buf);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const inflateRaw = opts.inflateRaw || inflateRawWeb;
  // End of central directory: 22 bytes plus a comment of up to 65535 bytes.
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 65535); i--) {
    if (dv.getUint32(i, true) === SIG_EOCD) { eocd = i; break; }
  }
  if (eocd < 0) throw new ZipError('not a zip file');
  const count = dv.getUint16(eocd + 10, true);
  const cdOffset = dv.getUint32(eocd + 16, true);
  if (count === 0xffff || cdOffset === 0xffffffff) throw new ZipError('zip64 is not supported');
  const decoder = new TextDecoder('utf-8');
  const entries = [];
  let p = cdOffset;
  for (let k = 0; k < count; k++) {
    if (p + 46 > bytes.length || dv.getUint32(p, true) !== SIG_CEN) throw new ZipError('broken central directory');
    const method = dv.getUint16(p + 10, true);
    const crc = dv.getUint32(p + 16, true);
    const compressedSize = dv.getUint32(p + 20, true);
    const size = dv.getUint32(p + 24, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const localOffset = dv.getUint32(p + 42, true);
    const name = decoder.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;
    const entry = {
      name, method, compressedSize, size, crc,
      async read() {
        if (localOffset + 30 > bytes.length || dv.getUint32(localOffset, true) !== SIG_LOC) throw new ZipError(`broken entry ${name}`);
        const lNameLen = dv.getUint16(localOffset + 26, true);
        const lExtraLen = dv.getUint16(localOffset + 28, true);
        const start = localOffset + 30 + lNameLen + lExtraLen;
        if (start + compressedSize > bytes.length) throw new ZipError(`truncated entry ${name}`);
        const raw = bytes.subarray(start, start + compressedSize);
        let out;
        if (method === 0) out = raw;
        else if (method === 8) out = await inflateRaw(raw);
        else throw new ZipError(`unsupported compression ${method} in ${name}`);
        if (out.length !== size) throw new ZipError(`size mismatch in ${name}`);
        if (crc32(out) !== crc) throw new ZipError(`CRC mismatch in ${name}`);
        return out;
      },
    };
    entries.push(entry);
  }
  return entries;
}

/**
 * Writes a STORE-only zip. Names are UTF-8 (flag bit 11).
 * @param {{name: string, data: Uint8Array|string}[]} files
 * @param {Date} [date]
 * @returns {Uint8Array}
 */
export function writeZip(files, date = new Date()) {
  const enc = new TextEncoder();
  const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const dosDate = (Math.max(0, date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  const parts = [];
  const central = [];
  let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.name);
    const data = typeof f.data === 'string' ? enc.encode(f.data) : toBytes(f.data);
    const crc = crc32(data);
    const loc = new Uint8Array(30 + name.length);
    const lv = new DataView(loc.buffer);
    lv.setUint32(0, SIG_LOC, true);
    lv.setUint16(4, 20, true);          // version needed
    lv.setUint16(6, 0x0800, true);      // UTF-8 names
    lv.setUint16(8, 0, true);           // STORE
    lv.setUint16(10, dosTime, true);
    lv.setUint16(12, dosDate, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, data.length, true);
    lv.setUint16(26, name.length, true);
    lv.setUint16(28, 0, true);
    loc.set(name, 30);
    parts.push(loc, data);
    const cen = new Uint8Array(46 + name.length);
    const cv = new DataView(cen.buffer);
    cv.setUint32(0, SIG_CEN, true);
    cv.setUint16(4, 20, true);          // version made by
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, dosTime, true);
    cv.setUint16(14, dosDate, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    cen.set(name, 46);
    central.push(cen);
    offset += loc.length + data.length;
  }
  const cdSize = central.reduce((n, c) => n + c.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, SIG_EOCD, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);
  const all = [...parts, ...central, eocd];
  const out = new Uint8Array(all.reduce((n, a) => n + a.length, 0));
  let o = 0;
  for (const a of all) { out.set(a, o); o += a.length; }
  return out;
}
