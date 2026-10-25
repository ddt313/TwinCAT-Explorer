import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as nodeCrypto from 'crypto';
import { execFileSync } from 'child_process';
import { blobId, createHash, sha1 } from '../../src/web/crypto';

test('web crypto: sha1 is that of Node, for every length around the 64-byte blocks', () => {
  for (let n = 0; n < 200; n++) {
    const bytes = Uint8Array.from({ length: n }, (_, i) => (i * 31 + n) & 0xff);
    assert.equal(Buffer.from(sha1(bytes)).toString('hex'), nodeCrypto.createHash('sha1').update(bytes).digest('hex'), `length ${n}`);
  }
});

test('web crypto: createHash joins its updates and reads text as UTF-8', () => {
  const text = 'FUNCTION_BLOCK FB_Ä\r\nVAR\r\nEND_VAR\r\n';
  assert.equal(createHash('sha1').update(text.slice(0, 9)).update(text.slice(9)).digest('hex'),
    nodeCrypto.createHash('sha1').update(text).digest('hex'));
});

test('web crypto: blobId is the id git gives a file', () => {
  for (const text of ['', 'FUNCTION_BLOCK FB_Motor\r\nEND_VAR\r\n', '\ufeff<?xml version="1.0" encoding="utf-8"?>\n'.repeat(40)]) {
    const bytes = Buffer.from(text, 'utf8');
    assert.equal(blobId(bytes), execFileSync('git', ['hash-object', '--stdin'], { input: bytes }).toString('utf8').trim());
  }
});
