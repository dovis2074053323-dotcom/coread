export function stripReaderHeading(text) {
  return String(text || '').replace(/^#+\s*/, '');
}

export function readerPageFragments(paragraphs, pageBreaks, pageNumber) {
  if (!Array.isArray(paragraphs) || paragraphs.length === 0 || !Array.isArray(pageBreaks) || pageBreaks.length === 0) return [];
  const page = Math.max(1, Math.min(pageBreaks.length, Number(pageNumber) || 1));
  const start = pageBreaks[page - 1] || { paraIndex: 0, offset: 0 };
  const end = page < pageBreaks.length ? pageBreaks[page] : { paraIndex: paragraphs.length, offset: 0 };
  const fragments = [];

  for (let i = start.paraIndex; i < end.paraIndex || (i === end.paraIndex && end.offset > 0); i++) {
    const para = paragraphs[i];
    if (!para) continue;
    const text = stripReaderHeading(para.content);
    const from = i === start.paraIndex ? start.offset : 0;
    const to = i === end.paraIndex ? end.offset : text.length;
    if (to <= from) continue;
    fragments.push({
      ...para,
      content: text.slice(from, to),
      sourceIdx: i,
      startOffset: from,
      endOffset: to,
      isPartialStart: from > 0,
      isPartialEnd: to < text.length,
    });
  }
  return fragments;
}

export function annotationThreadAnchor(comment) {
  const startPara = Number(comment?.paragraph_idx);
  if (!Number.isFinite(startPara)) return null;

  const rawEndPara = Number(comment?.sel_end_para_idx);
  const endPara = Number.isFinite(rawEndPara) && rawEndPara >= startPara ? rawEndPara : startPara;
  const endOffset = Number(comment?.sel_end_idx);
  if (comment?.sel_end_idx != null && Number.isFinite(endOffset) && endOffset >= 0) {
    return { paragraphIdx: endPara, offset: endOffset, edge: 'end' };
  }

  const startOffset = Number(comment?.sel_start_idx);
  if (comment?.sel_start_idx != null && Number.isFinite(startOffset) && startOffset >= 0) {
    return { paragraphIdx: startPara, offset: startOffset, edge: 'start' };
  }

  return { paragraphIdx: startPara, offset: 0, edge: 'legacy' };
}

// A thread is placed once, after the fragment containing the selection end.
// Older comments without character anchors stay attached to the first fragment
// of their paragraph instead of being repeated on every split page.
export function threadBelongsToFragment(comment, fragment) {
  const anchor = annotationThreadAnchor(comment);
  if (!anchor || Number(fragment?.idx) !== anchor.paragraphIdx) return false;

  const start = Math.max(0, Number(fragment.startOffset) || 0);
  const end = Math.max(start, Number(fragment.endOffset) || 0);
  if (anchor.edge === 'legacy') return start === 0;

  if (anchor.edge === 'start') {
    if (anchor.offset >= start && anchor.offset < end) return true;
    return !fragment.isPartialEnd && anchor.offset === end;
  }

  if (anchor.offset === 0) return start === 0;
  if (anchor.offset > start && anchor.offset <= end) return true;
  // Corrupt or stale offsets should still leave one usable thread on the last
  // fragment rather than making the annotation disappear entirely.
  return !fragment.isPartialEnd && anchor.offset > end;
}

export function virtualPageRange(currentPage, totalPages, overscan = 3) {
  const total = Math.max(1, Math.floor(Number(totalPages) || 1));
  const current = Math.max(1, Math.min(total, Math.floor(Number(currentPage) || 1)));
  const radius = Math.max(1, Math.floor(Number(overscan) || 1));
  let start = Math.max(1, current - radius);
  let end = Math.min(total, current + radius);
  const targetSize = Math.min(total, radius * 2 + 1);

  if (end - start + 1 < targetSize) {
    if (start === 1) end = Math.min(total, start + targetSize - 1);
    else start = Math.max(1, end - targetSize + 1);
  }
  return { start, end };
}
