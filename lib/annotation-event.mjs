// Phase 3 — context-rich annotation event.
//
// When a human writes an annotation or reply, Coread builds the whole event
// from the canonical book text *here and now* — the Morrow Resident's first
// turn must not need a single follow-up read. Context is taken from the real
// body around the actual selection: N characters before the selection start
// and N after the selection end (N = the reading-room `context_chars`
// setting), walking across paragraph boundaries and stopping cleanly at the
// start or end of the book.

const PARA_JOIN = '\n\n';

/**
 * Pull `chars` characters of real body text immediately before and after a
 * selection anchor. Paragraphs are stitched with a blank line so the excerpt
 * reads the way the book reads; the walk stops at the first/last paragraph
 * instead of padding.
 *
 * @param {Array<{idx:number, content:string}>} paragraphs  full book, ordered by idx
 * @param {{startParaIdx:number,endParaIdx:number,startIdx:number,endIdx:number}} anchor
 * @param {number} chars
 */
export function extractContext(paragraphs, anchor, chars) {
  const byIdx = new Map(paragraphs.map(p => [p.idx, p.content ?? '']));
  const order = paragraphs.map(p => p.idx);
  const n = Math.max(0, Math.floor(chars));

  const { startParaIdx, endParaIdx, startIdx, endIdx } = anchor;
  const startContent = byIdx.get(startParaIdx) ?? '';
  const endContent = byIdx.get(endParaIdx) ?? '';
  const clampedStart = Math.max(0, Math.min(startIdx ?? 0, startContent.length));
  const clampedEnd = Math.max(0, Math.min(endIdx ?? endContent.length, endContent.length));

  // —— before ——
  let before = startContent.slice(0, clampedStart);
  let cursor = order.indexOf(startParaIdx) - 1;
  while (before.length < n && cursor >= 0) {
    before = (byIdx.get(order[cursor]) ?? '') + PARA_JOIN + before;
    cursor -= 1;
  }
  const contextBefore = before.length > n ? before.slice(before.length - n) : before;

  // —— after ——
  let after = endContent.slice(clampedEnd);
  cursor = order.indexOf(endParaIdx) + 1;
  while (after.length < n && cursor < order.length) {
    after = after + PARA_JOIN + (byIdx.get(order[cursor]) ?? '');
    cursor += 1;
  }
  const contextAfter = after.length > n ? after.slice(0, n) : after;

  // —— selected text, rebuilt from the anchor so it is always the real body ——
  let selectedText;
  if (startParaIdx === endParaIdx) {
    selectedText = startContent.slice(clampedStart, clampedEnd);
  } else {
    const middle = [];
    let walk = order.indexOf(startParaIdx) + 1;
    const endPos = order.indexOf(endParaIdx);
    while (walk < endPos) { middle.push(byIdx.get(order[walk]) ?? ''); walk += 1; }
    selectedText = [startContent.slice(clampedStart), ...middle, endContent.slice(0, clampedEnd)].join(PARA_JOIN);
  }

  return { context_before: contextBefore, context_after: contextAfter, selected_text: selectedText };
}

/**
 * Build the full `coread.annotation.created` event from a freshly written
 * comment row plus the book's paragraphs and current reading progress.
 */
export function buildAnnotationEvent({ book, comment, paragraphs, contextChars, progress, replyTo }) {
  const startParaIdx = comment.paragraph_idx;
  const endParaIdx = comment.sel_end_para_idx ?? comment.paragraph_idx;
  const anchor = {
    start_para: startParaIdx,
    end_para: endParaIdx,
    start_idx: comment.sel_start_idx,
    end_idx: comment.sel_end_idx,
  };
  const { context_before, context_after, selected_text } = extractContext(
    paragraphs,
    { startParaIdx, endParaIdx, startIdx: comment.sel_start_idx, endIdx: comment.sel_end_idx },
    contextChars,
  );

  return {
    type: 'coread.annotation.created',
    book_id: book.id,
    book_title: book.title,
    comment_id: comment.id,
    from: comment.from_who,
    reply_to: comment.reply_to ?? null,
    anchor,
    selected_text: comment.selected_text || selected_text || null,
    context_before,
    context_after,
    context_chars: contextChars,
    comment: comment.content,
    reply_to_comment: replyTo
      ? { comment_id: replyTo.id, from: replyTo.from_who, comment: replyTo.content, selected_text: replyTo.selected_text ?? null }
      : null,
    reading_progress: progress
      ? { page: progress.page ?? null, paragraph_idx: progress.page ?? null, char_offset: progress.char_offset ?? 0 }
      : null,
  };
}
