import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { NavStack } from '../../src/core/navStack';

const stack = () => new NavStack<string>(s => s.toLowerCase());

test('NavStack: back and forward through the visited entries', () => {
  const nav = stack();
  assert.equal(nav.canGoBack, false);
  nav.visit('OnEntry');
  nav.visit('OnExit');
  nav.visit('StateToString');
  assert.equal(nav.goBack(), 'OnExit');
  assert.equal(nav.goBack(), 'OnEntry');
  assert.equal(nav.canGoBack, false);
  assert.equal(nav.goBack(), undefined);
  assert.equal(nav.current, 'OnEntry');
  assert.equal(nav.goForward(), 'OnExit');
  assert.equal(nav.goForward(), 'StateToString');
  assert.equal(nav.canGoForward, false);
});

test('NavStack: the tab activated by going back is no new visit', () => {
  const nav = stack();
  nav.visit('A');
  nav.visit('B');
  assert.equal(nav.goBack(), 'A');
  nav.visit('a');
  assert.equal(nav.canGoForward, true);
  assert.equal(nav.goForward(), 'B');
});

test('NavStack: a new visit clears the forward entries', () => {
  const nav = stack();
  nav.visit('A');
  nav.visit('B');
  nav.goBack();
  nav.visit('C');
  assert.equal(nav.canGoForward, false);
  assert.equal(nav.goBack(), 'A');
});

test('NavStack: entries that are no longer valid are skipped and dropped', () => {
  const nav = stack();
  nav.visit('A');
  nav.visit('Gone');
  nav.visit('C');
  assert.equal(nav.goBack(e => e !== 'Gone'), 'A');
  assert.equal(nav.goForward(), 'C');
  assert.equal(nav.goBack(), 'A');
});
