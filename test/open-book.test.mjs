import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { findBookById } from '../web/open-book.js';

test('invite book lookup returns the current shelf row and missing books stay missing', () => {
  const latest = { id: 7, title: 'Current', current_page: 12, current_offset: 4 };
  assert.equal(findBookById([latest], 7), latest);
  assert.equal(findBookById([latest], 8), null);
});

test('iframe invitation protocol carries only bookId and keeps a pending load path', () => {
  const source = readFileSync(new URL('../web/StudyApp.tsx', import.meta.url), 'utf8');
  assert.match(source, /type !== 'morrow-coread-open-book'/);
  assert.match(source, /pendingBookIdRef\.current = bookId/);
  assert.match(source, /openRequestBookIdRef\.current === bookId/);
  assert.match(source, /findBookById\(latestBooks, pendingBookId\)/);
  assert.match(source, /toast\('这本书已不在书架'\)/);
  assert.doesNotMatch(source, /e\.data\.(?:page|progress|char_offset)/);
});
