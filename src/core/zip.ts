// The files of a zip archive, read without a dependency: a TwinCAT .library file is one.

import * as zlib from 'zlib';

/** A file of a zip archive, its content read when asked for. */
export interface ZipEntry {
  name: string;
  read(): Buffer;
}

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;

/**
 * The files of a zip archive, from its central directory: stored (method 0) or deflated (8) ones; folders are left
 * out. Throws when the bytes are no zip archive or an entry cannot be read.
 */
export function readZip(bytes: Uint8Array): ZipEntry[] {
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // The end of central directory record: in the last 64 KiB + 22 bytes (its comment comes after it).
  let end = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 22 - 0xffff); i--) {
    if (b.readUInt32LE(i) === EOCD) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new Error('not a zip archive');
  const count = b.readUInt16LE(end + 10);
  let p = b.readUInt32LE(end + 16);
  const entries: ZipEntry[] = [];
  for (let n = 0; n < count; n++) {
    if (p + 46 > b.length || b.readUInt32LE(p) !== CENTRAL) throw new Error('broken zip central directory');
    const method = b.readUInt16LE(p + 10);
    const compressed = b.readUInt32LE(p + 20);
    const nameLength = b.readUInt16LE(p + 28);
    const extraLength = b.readUInt16LE(p + 30);
    const commentLength = b.readUInt16LE(p + 32);
    const local = b.readUInt32LE(p + 42);
    const name = b.toString('utf8', p + 46, p + 46 + nameLength);
    p += 46 + nameLength + extraLength + commentLength;
    if (name.endsWith('/')) continue;
    entries.push({
      name,
      read: () => {
        if (b.readUInt32LE(local) !== LOCAL) throw new Error(`broken zip entry ${name}`);
        const start = local + 30 + b.readUInt16LE(local + 26) + b.readUInt16LE(local + 28);
        const data = b.subarray(start, start + compressed);
        if (method === 0) return Buffer.from(data);
        if (method === 8) return zlib.inflateRawSync(data);
        throw new Error(`zip entry ${name}: compression method ${method}`);
      },
    });
  }
  return entries;
}
