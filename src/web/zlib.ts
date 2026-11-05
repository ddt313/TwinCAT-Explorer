// `zlib` in the browser: the library files it inflates (src/core/zip.ts) are read on the desktop only, where the
// library repositories are.

export function inflateRawSync(): never {
  throw new Error('Library files cannot be read in the browser');
}
