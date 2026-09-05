import assert from 'node:assert/strict';
import test from 'node:test';
import {
  annotationThreadAnchor,
  readerPageFragments,
  threadBelongsToFragment,
  virtualPageRange,
} from '../web/reader-layout.js';

test('readerPageFragments keeps source offsets for paragraphs split across pages', () => {
  const paragraphs = [
    { idx: 7, content: '# Heading' },
    { idx: 8, content: 'abcdefghij' },
  ];
  const breaks = [
    { paraIndex: 0, offset: 0 },
    { paraIndex: 1, offset: 4 },
    { paraIndex: 1, offset: 8 },
  ];

  assert.deepEqual(readerPageFragments(paragraphs, breaks, 2), [{
    idx: 8,
    content: 'efgh',
    sourceIdx: 1,
    startOffset: 4,
    endOffset: 8,
    isPartialStart: true,
    isPartialEnd: true,
  }]);
});

test('anchored annotation threads belong to exactly one page fragment', () => {
  const fragments = [
    { idx: 4, startOffset: 0, endOffset: 100, isPartialEnd: true },
    { idx: 4, startOffset: 100, endOffset: 200, isPartialEnd: true },
    { idx: 4, startOffset: 200, endOffset: 300, isPartialEnd: false },
  ];
  const middle = { paragraph_idx: 4, sel_start_idx: 120, sel_end_idx: 145, sel_end_para_idx: null };
  assert.deepEqual(fragments.map(f => threadBelongsToFragment(middle, f)), [false, true, false]);

  const boundary = { paragraph_idx: 4, sel_start_idx: 90, sel_end_idx: 100, sel_end_para_idx: null };
  assert.deepEqual(fragments.map(f => threadBelongsToFragment(boundary, f)), [true, false, false]);

  const startOnly = { paragraph_idx: 4, sel_start_idx: 100, sel_end_idx: null, sel_end_para_idx: null };
  assert.deepEqual(fragments.map(f => threadBelongsToFragment(startOnly, f)), [false, true, false]);
});

test('cross-paragraph and legacy annotations render once at a compatible anchor', () => {
  const cross = { paragraph_idx: 4, sel_start_idx: 80, sel_end_para_idx: 5, sel_end_idx: 20 };
  assert.deepEqual(annotationThreadAnchor(cross), { paragraphIdx: 5, offset: 20, edge: 'end' });
  assert.equal(threadBelongsToFragment(cross, { idx: 4, startOffset: 0, endOffset: 100, isPartialEnd: false }), false);
  assert.equal(threadBelongsToFragment(cross, { idx: 5, startOffset: 0, endOffset: 50, isPartialEnd: true }), true);

  const legacy = { paragraph_idx: 9, sel_start_idx: null, sel_end_idx: null, sel_end_para_idx: null };
  assert.equal(threadBelongsToFragment(legacy, { idx: 9, startOffset: 0, endOffset: 100, isPartialEnd: true }), true);
  assert.equal(threadBelongsToFragment(legacy, { idx: 9, startOffset: 100, endOffset: 200, isPartialEnd: false }), false);
});

test('scrolling mode keeps a bounded page window for large books', () => {
  assert.deepEqual(virtualPageRange(1, 100000), { start: 1, end: 7 });
  assert.deepEqual(virtualPageRange(50000, 100000), { start: 49997, end: 50003 });
  assert.deepEqual(virtualPageRange(100000, 100000), { start: 99994, end: 100000 });
});
