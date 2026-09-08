import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { unreadReplies } from '../web/reply-poll.mjs';

const readerSource = readFileSync(new URL('../web/StudyApp.tsx', import.meta.url), 'utf8');
const indexSource = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');

test('annotation focus is detached from the reader scroller and prevents browser auto-scroll', () => {
  assert.doesNotMatch(readerSource, /autoFocus/);
  assert.doesNotMatch(readerSource, /scrollIntoView\s*\(/);
  assert.match(readerSource, /focus\(\{ preventScroll: true \}\)/);
  assert.match(readerSource, /bottom: 'calc\(20px \+ var\(--keyboard-inset, 0px\)\)'/);
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
  assert.doesNotMatch(readerSource, /barTimer/);
  assert.match(readerSource, /setShowBookmarkMenu\(false\); setShowFontPanel\(false\); setShowMoreMenu\(false\)/);
});

test('scroll reader uses a touch-transparent mask edge fade, paged reader does not', () => {
  assert.match(readerSource, /fade-scroll-top/);
  assert.match(readerSource, /mask-image: linear-gradient/);
  assert.match(readerSource, /scroller\.scrollTop > 8/);
  assert.match(readerSource, /readerMode === 'scroll' \? ' fade-scroll' : ''/);
});

test('stale reply polling filters against the response-time lastSeen ref and book lifetime', () => {
  assert.match(readerSource, /const currentLastSeen = lastSeenRef\.current/);
  assert.match(readerSource, /unreadReplies\(d\.replies, currentLastSeen, humanName\)/);
  assert.match(readerSource, /lastSeenRef\.current = Math\.max\(lastSeenRef\.current, maxId\)/);
  assert.match(readerSource, /currentBook = false/);
});

test('a stale reply response cannot revive notices already marked read', () => {
  const delayedResponse = [{ id: 11, from_who: 'claude-code', content: '旧的迟到响应' }];
  assert.deepEqual(unreadReplies(delayedResponse, 11, 'human'), []);
  assert.deepEqual(unreadReplies([...delayedResponse, { id: 12, from_who: 'claude-code', content: '真正的新回复' }], 11, 'human').map(reply => reply.id), [12]);
});

test('keyboard animation moves only the detached editor while preserving reader geometry', () => {
  assert.doesNotMatch(readerSource, /setKeyboardInset/);
  assert.match(readerSource, /--keyboard-inset/);
  assert.match(readerSource, /isCommentingRef\.current/);
  assert.match(readerSource, /Math\.abs\(width - locked\.width\) <= 80/);
});
