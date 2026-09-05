import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const readerSource = readFileSync(new URL('../web/StudyApp.tsx', import.meta.url), 'utf8');
const indexSource = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');

test('annotation focus is detached from the reader scroller and prevents browser auto-scroll', () => {
  assert.doesNotMatch(readerSource, /autoFocus/);
  assert.doesNotMatch(readerSource, /scrollIntoView\s*\(/);
  assert.match(readerSource, /focus\(\{ preventScroll: true \}\)/);
  assert.match(readerSource, /bottom: 20 \+ keyboardInset/);
  assert.match(readerSource, /overflowAnchor: 'none'/);
});

test('reader viewport and pagination ignore same-width keyboard resize', () => {
  assert.doesNotMatch(indexSource, /100dvh/);
  assert.match(indexSource, /100lvh/);
  assert.match(readerSource, /Math\.abs\(width - lockedWidthRef\.current\) > 2/);
  assert.doesNotMatch(readerSource, /lockedHeightRef\.current \* 0\.95/);
});

test('layout-affecting settings share measurement, rendering, and cache identity', () => {
  assert.match(readerSource, /paginationLayoutSignature = `fs\$\{readerFontSize\}-lh\$\{readerLineSpacing\}-mg\$\{readerMargin\}`/);
  assert.match(readerSource, /inner\.style\.lineHeight = String\(chapterTitle \? readerChapterLineHeight : readerLineHeight\)/);
  assert.match(readerSource, /lineHeight: chapterTitle \? readerChapterLineHeight : readerLineHeight/);
  assert.match(readerSource, /readerContentWidth = Math\.max\(1, readerSize\.width - readerHorizontalPadding\)/);
});

test('returning to a populated shelf refreshes without entering blocking loading state', () => {
  assert.match(readerSource, /loadBooks = async \(blocking = !booksLoadedRef\.current\)/);
  assert.match(readerSource, /finally\(\(\) => \{ void loadBooks\(false\); \}\)/);
});

test('reading toolbar has no duplicate close control', () => {
  assert.doesNotMatch(readerSource, /<button onClick=\{backToShelf\}/);
});
