// `crypto` in the browser: the few calls of the extension (ids, and the sha1 of a text that tells whether it
// changed). The Web Crypto digests are asynchronous, so sha1 is computed here.

import { Buffer } from 'buffer';

const webCrypto = (globalThis as unknown as { crypto: { randomUUID(): string; getRandomValues(a: Uint8Array): Uint8Array } }).crypto;

export function randomUUID(): string {
  return webCrypto.randomUUID();
}

export function randomBytes(size: number): Buffer {
  return Buffer.from(webCrypto.getRandomValues(new Uint8Array(size)));
}

/** SHA-1 of bytes (FIPS 180-4). */
export function sha1(bytes: Uint8Array): Uint8Array {
  const bitLength = bytes.length * 8;
  const padded = new Uint8Array(((bytes.length + 9 + 63) >> 6) << 6);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor(bitLength / 0x100000000));
  view.setUint32(padded.length - 4, bitLength >>> 0);
  let h0 = 0x67452301, h1 = 0xefcdab89, h2 = 0x98badcfe, h3 = 0x10325476, h4 = 0xc3d2e1f0;
  const w = new Uint32Array(80);
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4);
    for (let i = 16; i < 80; i++) {
      const x = w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16];
      w[i] = (x << 1) | (x >>> 31);
    }
    let a = h0, b = h1, c = h2, d = h3, e = h4;
    for (let i = 0; i < 80; i++) {
      let t: number;
      if (i < 20) t = ((b & c) | (~b & d)) + 0x5a827999;
      else if (i < 40) t = (b ^ c ^ d) + 0x6ed9eba1;
      else if (i < 60) t = ((b & c) | (b & d) | (c & d)) + 0x8f1bbcdc;
      else t = (b ^ c ^ d) + 0xca62c1d6;
      t = (((a << 5) | (a >>> 27)) + t + e + w[i]) >>> 0;
      e = d;
      d = c;
      c = (b << 30) | (b >>> 2);
      b = a;
      a = t;
    }
    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
  }
  const out = new Uint8Array(20);
  const outView = new DataView(out.buffer);
  [h0, h1, h2, h3, h4].forEach((h, i) => outView.setUint32(i * 4, h));
  return out;
}

/** The id git gives the bytes of a file (a blob), as in the trees of commits: `git hash-object`. */
export function blobId(bytes: Uint8Array): string {
  const header = Buffer.from(`blob ${bytes.length}\0`, 'utf8');
  return Buffer.from(sha1(Buffer.concat([header, bytes]))).toString('hex');
}

class Hash {
  private readonly parts: Uint8Array[] = [];

  constructor(algorithm: string) {
    if (algorithm.toLowerCase() !== 'sha1') throw new Error(`Hash ${algorithm} is not available in the browser`);
  }

  update(data: string | Uint8Array): this {
    this.parts.push(typeof data === 'string' ? Buffer.from(data, 'utf8') : data);
    return this;
  }

  digest(encoding?: 'hex'): string | Buffer {
    const digest = Buffer.from(sha1(Buffer.concat(this.parts)));
    return encoding ? digest.toString(encoding) : digest;
  }
}

export function createHash(algorithm: string): Hash {
  return new Hash(algorithm);
}
