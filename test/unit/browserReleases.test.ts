// The browser extension's releases on GitHub (browser/src/releases.ts): which of the repository's releases is the
// newest of the browser extension, and when a version is newer than the one installed, on made-up lists.

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { isNewer, latestBrowserRelease } from '../../browser/src/releases';

test('isNewer compares the parts of two versions as numbers', () => {
  assert.equal(isNewer('0.2.1', '0.2.0'), true);
  assert.equal(isNewer('0.10.0', '0.9.3'), true);
  assert.equal(isNewer('1.0.0', '0.99.99'), true);
  assert.equal(isNewer('0.2.1', '0.2.1'), false);
  assert.equal(isNewer('0.2.0', '0.2.1'), false);
  assert.equal(isNewer('0.2', '0.2.0'), false);
  assert.equal(isNewer('0.2.0.1', '0.2'), true);
  assert.equal(isNewer('0.3.0-beta.1', '0.2.0'), false);
  assert.equal(isNewer('0.3.0', 'x'), false);
});

const release = (tag: string, more: object = {}) => ({ tag_name: tag, html_url: `https://github.com/o/r/releases/tag/${tag}`, draft: false, prerelease: false, ...more });

test('latestBrowserRelease takes the newest browser-v release, whatever the order', () => {
  const list = [release('v0.16.1'), release('browser-v0.2.1'), release('browser-v0.10.0'), release('v0.16.0'), release('browser-v0.2.0')];
  assert.deepEqual(latestBrowserRelease(list), { version: '0.10.0', url: 'https://github.com/o/r/releases/tag/browser-v0.10.0' });
});

test('latestBrowserRelease leaves out drafts, pre-releases and the VS Code extension', () => {
  const list = [
    release('browser-v0.4.0', { draft: true }),
    release('browser-v0.3.0', { prerelease: true }),
    release('browser-v0.3.0-beta.1'),
    release('v0.17.0'),
    release('browser-v0.2.1'),
  ];
  assert.equal(latestBrowserRelease(list)?.version, '0.2.1');
  assert.equal(latestBrowserRelease([release('v0.16.1')]), undefined);
  assert.equal(latestBrowserRelease([]), undefined);
  assert.equal(latestBrowserRelease({ message: 'API rate limit exceeded' }), undefined);
  assert.equal(latestBrowserRelease([null, { tag_name: 'browser-v1.0.0' }]), undefined);
});
