import { getDb } from './db.mjs';

export const READING_NOTE_KINDS = Object.freeze(['summary', 'character', 'thread', 'impression']);
export const READING_NOTE_STATUSES = Object.freeze(['active', 'resolved', 'archived']);
export const READING_STATE_MAX_CHARS = 12_000;

const KIND_SET = new Set(READING_NOTE_KINDS);
const STATUS_SET = new Set(READING_NOTE_STATUSES);
const OWNER_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
const SUBJECT_MAX = 200;
const BODY_MAX = 10_000;
const RESOLUTION_MAX = 10_000;
const CHANGE_REASON_MAX = 200;

export class ReadingNoteError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'ReadingNoteError';
    this.status = status;
  }
}

const cleanText = (value) => String(value ?? '').replace(/\r\n?/g, '\n').trim();

function boundedText(value, field, max, { required = false } = {}) {
  const text = cleanText(value);
  if (required && !text) throw new ReadingNoteError(`${field} is required`);
  if (text.length > max) throw new ReadingNoteError(`${field} exceeds ${max} characters`);
  return text || null;
}

function positivePage(value, field) {
  if (value === undefined || value === null || value === '') return null;
  const page = Number(value);
  if (!Number.isSafeInteger(page) || page < 1) throw new ReadingNoteError(`${field} must be a positive integer`);
  return page;
}

function normalizeKind(value) {
  const kind = cleanText(value).toLowerCase();
  if (!KIND_SET.has(kind)) throw new ReadingNoteError(`kind must be one of: ${READING_NOTE_KINDS.join(', ')}`);
  return kind;
}

export function normalizeReadingNoteOwner(value) {
  const owner = cleanText(value).toLowerCase();
  if (!OWNER_RE.test(owner)) throw new ReadingNoteError('owner must be a valid Resident id');
  return owner;
}

function normalizeStatus(value) {
  const status = cleanText(value).toLowerCase();
  if (!STATUS_SET.has(status)) throw new ReadingNoteError(`status must be one of: ${READING_NOTE_STATUSES.join(', ')}`);
  return status;
}

function noteProjection(row, bodyMax = null) {
  if (!row) return null;
  const truncate = (value, max) => {
    if (value == null || max == null || value.length <= max) return value ?? null;
    return `${value.slice(0, Math.max(1, max - 1))}…`;
  };
  return {
    id: row.id,
    book_id: row.book_id,
    kind: row.kind,
    owner_id: row.owner_id,
    subject: row.subject ?? null,
    body: truncate(row.body, bodyMax),
    scope_start_page: row.scope_start_page ?? null,
    scope_end_page: row.scope_end_page ?? null,
    anchor_page: row.anchor_page ?? null,
    status: row.status,
    resolution: truncate(row.resolution, bodyMax),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function bookExists(db, bookId) {
  const book = db.prepare('SELECT id, title, total_paragraphs FROM books WHERE id = ?').get(bookId);
  if (!book) throw new ReadingNoteError('book not found', 404);
  return book;
}

function noteExists(db, id, bookId = null) {
  const note = db.prepare('SELECT * FROM book_notes WHERE id = ?').get(id);
  if (!note || (bookId != null && note.book_id !== bookId)) throw new ReadingNoteError('reading note not found', 404);
  return note;
}

function revisionProjection(row) {
  if (!row) return null;
  let snapshot;
  try { snapshot = JSON.parse(row.snapshot_json); } catch { snapshot = null; }
  return {
    id: row.id,
    note_id: row.note_id,
    revision_number: row.revision_number,
    snapshot,
    changed_by: row.changed_by,
    change_reason: row.change_reason,
    created_at: row.created_at,
  };
}

function nextRevisionNumber(db, noteId) {
  return Number(db.prepare('SELECT COALESCE(MAX(revision_number), 0) + 1 AS next FROM book_note_revisions WHERE note_id = ?').get(noteId)?.next || 1);
}

function insertRevision(db, note, { changedBy, changeReason, createdAt = null }) {
  const revisionNumber = nextRevisionNumber(db, note.id);
  db.prepare(`
    INSERT INTO book_note_revisions(note_id, revision_number, snapshot_json, changed_by, change_reason, created_at)
    VALUES (?, ?, ?, ?, ?, COALESCE(?, datetime('now')))
  `).run(
    note.id,
    revisionNumber,
    JSON.stringify(noteProjection(note)),
    normalizeReadingNoteOwner(changedBy),
    boundedText(changeReason, 'change_reason', CHANGE_REASON_MAX, { required: true }),
    createdAt,
  );
  return revisionNumber;
}

function updateReason(current, next, changedFields, explicitReason) {
  const explicit = boundedText(explicitReason, 'change_reason', CHANGE_REASON_MAX);
  if (explicit) return explicit;
  if (changedFields.includes('resolution')) return current.status === 'resolved' ? '更新伏笔结论' : '正文揭晓，伏笔已解决';
  if (changedFields.includes('subject') && changedFields.length === 1) return '修改笔记标题';
  if (changedFields.some((field) => ['anchor_page', 'scope_start_page', 'scope_end_page'].includes(field))
    && changedFields.every((field) => ['anchor_page', 'scope_start_page', 'scope_end_page'].includes(field))) return '修正阅读锚点';
  if (changedFields.includes('body')) {
    if (next.kind === 'character') return '更新人物判断';
    if (next.kind === 'impression') return '更新阶段印象';
    if (next.kind === 'summary') return '更新阶段总结';
    return '修改笔记正文';
  }
  return '更新笔记';
}

function noteContentChanged(current, next) {
  const fields = ['kind', 'subject', 'body', 'scope_start_page', 'scope_end_page', 'anchor_page', 'status', 'resolution'];
  return fields.filter((field) => (current[field] ?? null) !== (next[field] ?? null));
}

export function listReadingNotes(bookId, {
  kind,
  ownerId,
  status,
  limit = 50,
} = {}) {
  if (!Number.isSafeInteger(bookId) || bookId < 1) throw new ReadingNoteError('book_id must be a positive integer');
  const cap = Math.min(500, Math.max(1, Number.isSafeInteger(limit) ? limit : 50));
  const where = ['book_id = ?'];
  const params = [bookId];
  if (kind != null) { where.push('kind = ?'); params.push(normalizeKind(kind)); }
  if (ownerId != null) { where.push('owner_id = ?'); params.push(normalizeReadingNoteOwner(ownerId)); }
  if (status != null) { where.push('status = ?'); params.push(normalizeStatus(status)); }
  const db = getDb(true);
  try {
    bookExists(db, bookId);
    return db.prepare(
      `SELECT * FROM book_notes WHERE ${where.join(' AND ')}
       ORDER BY COALESCE(anchor_page, scope_end_page, scope_start_page, 0) DESC, updated_at DESC, id DESC
       LIMIT ?`,
    ).all(...params, cap).map((row) => noteProjection(row));
  } finally {
    db.close();
  }
}

export function listReadingNoteRevisions({ id, bookId = null }) {
  if (!Number.isSafeInteger(id) || id < 1) throw new ReadingNoteError('id must be a positive integer');
  if (bookId != null && (!Number.isSafeInteger(bookId) || bookId < 1)) throw new ReadingNoteError('book_id must be a positive integer');
  const db = getDb(true);
  try {
    noteExists(db, id, bookId);
    return db.prepare('SELECT * FROM book_note_revisions WHERE note_id = ? ORDER BY revision_number DESC').all(id).map(revisionProjection);
  } finally {
    db.close();
  }
}

export function upsertReadingNote({
  id = null,
  bookId,
  ownerId,
  changedBy = ownerId,
  changeReason = null,
  kind,
  subject = null,
  body,
  scopeStartPage = null,
  scopeEndPage = null,
  anchorPage = null,
  resolution = undefined,
}) {
  if (!Number.isSafeInteger(bookId) || bookId < 1) throw new ReadingNoteError('book_id must be a positive integer');
  const owner = normalizeReadingNoteOwner(ownerId);
  const actor = normalizeReadingNoteOwner(changedBy);
  const normalizedKind = normalizeKind(kind);
  const normalizedSubject = boundedText(subject, 'subject', SUBJECT_MAX);
  const normalizedBody = boundedText(body, 'body', BODY_MAX, { required: true });
  const startPage = positivePage(scopeStartPage, 'scope_start_page');
  const endPage = positivePage(scopeEndPage, 'scope_end_page');
  const notePage = positivePage(anchorPage, 'anchor_page');
  if (startPage != null && endPage != null && startPage > endPage) {
    throw new ReadingNoteError('scope_start_page must be before scope_end_page');
  }

  const db = getDb();
  try {
    bookExists(db, bookId);
    if (id != null) {
      if (!Number.isSafeInteger(id) || id < 1) throw new ReadingNoteError('id must be a positive integer');
      const current = noteExists(db, id, bookId);
      if (current.owner_id !== owner) throw new ReadingNoteError('reading note belongs to another owner', 403);
      const nextResolution = resolution === undefined
        ? current.resolution
        : boundedText(resolution, 'resolution', RESOLUTION_MAX);
      if (normalizedKind !== 'thread' && nextResolution != null) throw new ReadingNoteError('only thread notes can have a resolution');
      const next = {
        ...current,
        kind: normalizedKind,
        subject: normalizedSubject,
        body: normalizedBody,
        scope_start_page: startPage,
        scope_end_page: endPage,
        anchor_page: notePage,
        resolution: nextResolution,
      };
      const changedFields = noteContentChanged(current, next);
      if (!changedFields.length) return noteProjection(current);
      const reason = updateReason(current, next, changedFields, changeReason);
      return db.transaction(() => {
        db.prepare(
          `UPDATE book_notes
              SET kind = ?, subject = ?, body = ?, scope_start_page = ?, scope_end_page = ?,
                  anchor_page = ?, resolution = ?, updated_at = datetime('now')
            WHERE id = ?`,
        ).run(normalizedKind, normalizedSubject, normalizedBody, startPage, endPage, notePage, nextResolution, id);
        const updated = db.prepare('SELECT * FROM book_notes WHERE id = ?').get(id);
        insertRevision(db, updated, { changedBy: actor, changeReason: reason });
        return noteProjection(updated);
      })();
    }

    return db.transaction(() => {
      const inserted = db.prepare(
        `INSERT INTO book_notes
          (book_id, kind, owner_id, subject, body, scope_start_page, scope_end_page, anchor_page)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(bookId, normalizedKind, owner, normalizedSubject, normalizedBody, startPage, endPage, notePage);
      const note = db.prepare('SELECT * FROM book_notes WHERE id = ?').get(Number(inserted.lastInsertRowid));
      insertRevision(db, note, { changedBy: actor, changeReason: boundedText(changeReason, 'change_reason', CHANGE_REASON_MAX) || '创建笔记' });
      return noteProjection(note);
    })();
  } finally {
    db.close();
  }
}

export function resolveReadingThread({ id, bookId = null, ownerId, changedBy = ownerId, changeReason = null, resolution, page = null }) {
  if (!Number.isSafeInteger(id) || id < 1) throw new ReadingNoteError('id must be a positive integer');
  if (bookId != null && (!Number.isSafeInteger(bookId) || bookId < 1)) throw new ReadingNoteError('book_id must be a positive integer');
  const owner = normalizeReadingNoteOwner(ownerId);
  const actor = normalizeReadingNoteOwner(changedBy);
  const normalizedResolution = boundedText(resolution, 'resolution', RESOLUTION_MAX, { required: true });
  const anchorPage = positivePage(page, 'page');
  const db = getDb();
  try {
    const current = noteExists(db, id, bookId);
    if (current.kind !== 'thread') throw new ReadingNoteError('only thread notes can be resolved');
    if (current.owner_id !== owner) throw new ReadingNoteError('reading thread belongs to another owner', 403);
    if (current.status === 'archived') throw new ReadingNoteError('archived reading thread cannot be resolved');
    const next = {
      ...current,
      status: 'resolved',
      resolution: normalizedResolution,
      anchor_page: anchorPage ?? current.anchor_page,
    };
    const changedFields = noteContentChanged(current, next);
    if (!changedFields.length) return noteProjection(current);
    const reason = boundedText(changeReason, 'change_reason', CHANGE_REASON_MAX)
      || (current.status === 'active' ? '正文揭晓，伏笔已解决' : '更新伏笔结论');
    return db.transaction(() => {
      db.prepare(
        `UPDATE book_notes
            SET status = 'resolved', resolution = ?,
                anchor_page = ?, updated_at = datetime('now')
          WHERE id = ?`,
      ).run(normalizedResolution, next.anchor_page, id);
      const updated = db.prepare('SELECT * FROM book_notes WHERE id = ?').get(id);
      insertRevision(db, updated, { changedBy: actor, changeReason: reason });
      return noteProjection(updated);
    })();
  } finally {
    db.close();
  }
}

export function restoreReadingNoteRevision({ id, revisionNumber, bookId = null, ownerId, changedBy = ownerId, changeReason = null }) {
  if (!Number.isSafeInteger(id) || id < 1) throw new ReadingNoteError('id must be a positive integer');
  if (!Number.isSafeInteger(revisionNumber) || revisionNumber < 1) throw new ReadingNoteError('revision_number must be a positive integer');
  if (bookId != null && (!Number.isSafeInteger(bookId) || bookId < 1)) throw new ReadingNoteError('book_id must be a positive integer');
  const owner = normalizeReadingNoteOwner(ownerId);
  const actor = normalizeReadingNoteOwner(changedBy);
  const db = getDb();
  try {
    const current = noteExists(db, id, bookId);
    if (current.owner_id !== owner) throw new ReadingNoteError('reading note belongs to another owner', 403);
    const revision = db.prepare('SELECT * FROM book_note_revisions WHERE note_id = ? AND revision_number = ?').get(id, revisionNumber);
    if (!revision) throw new ReadingNoteError('reading note revision not found', 404);
    let snapshot;
    try { snapshot = JSON.parse(revision.snapshot_json); } catch { throw new ReadingNoteError('reading note revision is invalid', 500); }
    if (snapshot?.id !== current.id || snapshot?.book_id !== current.book_id || snapshot?.owner_id !== current.owner_id) {
      throw new ReadingNoteError('reading note revision identity mismatch', 409);
    }
    const reason = boundedText(changeReason, 'change_reason', CHANGE_REASON_MAX) || `恢复至 v${revisionNumber}`;
    return db.transaction(() => {
      db.prepare(`
        UPDATE book_notes
           SET kind = ?, subject = ?, body = ?, scope_start_page = ?, scope_end_page = ?, anchor_page = ?,
               status = ?, resolution = ?, updated_at = datetime('now')
         WHERE id = ?
      `).run(
        snapshot.kind,
        snapshot.subject ?? null,
        snapshot.body,
        snapshot.scope_start_page ?? null,
        snapshot.scope_end_page ?? null,
        snapshot.anchor_page ?? null,
        snapshot.status,
        snapshot.resolution ?? null,
        id,
      );
      const restored = db.prepare('SELECT * FROM book_notes WHERE id = ?').get(id);
      insertRevision(db, restored, { changedBy: actor, changeReason: reason });
      return noteProjection(restored);
    })();
  } finally {
    db.close();
  }
}

export function deleteReadingNote({ id, bookId = null, ownerId }) {
  if (!Number.isSafeInteger(id) || id < 1) throw new ReadingNoteError('id must be a positive integer');
  if (bookId != null && (!Number.isSafeInteger(bookId) || bookId < 1)) throw new ReadingNoteError('book_id must be a positive integer');
  const owner = normalizeReadingNoteOwner(ownerId);
  const db = getDb();
  try {
    const current = noteExists(db, id, bookId);
    if (current.owner_id !== owner) throw new ReadingNoteError('reading note belongs to another owner', 403);
    db.transaction(() => {
      db.prepare('DELETE FROM book_note_revisions WHERE note_id = ?').run(id);
      db.prepare('DELETE FROM book_notes WHERE id = ?').run(id);
    })();
    return true;
  } finally {
    db.close();
  }
}

function recoveryNotes(db, bookId, kind, status, limit, order = '') {
  const statusClause = status ? ' AND status = ?' : '';
  const params = status ? [bookId, kind, status, limit] : [bookId, kind, limit];
  return db.prepare(
    `SELECT * FROM book_notes
      WHERE book_id = ? AND kind = ?${statusClause}
      ORDER BY ${order || 'COALESCE(anchor_page, scope_end_page, scope_start_page, 0) DESC, updated_at DESC, id DESC'}
      LIMIT ?`,
  ).all(...params).map((row) => noteProjection(row, 520));
}

function positionProjection(progress, bookmark) {
  return {
    progress: progress ? {
      page: progress.page,
      paragraph_idx: progress.page,
      char_offset: progress.char_offset || 0,
      updated_at: progress.updated_at || null,
    } : null,
    bookmark: bookmark ? {
      page: bookmark.page,
      paragraph_idx: bookmark.paragraph_idx,
      char_offset: bookmark.char_offset || 0,
      created_at: bookmark.created_at || null,
      updated_at: bookmark.updated_at || null,
    } : null,
  };
}

function trimStateToCap(state) {
  const targets = [
    state.history,
    state.impressions,
    state.threads.recent_resolved,
    state.characters,
    state.recent,
    state.threads.active,
  ];
  let index = 0;
  while (JSON.stringify(state).length > READING_STATE_MAX_CHARS && targets.some((items) => items.length > 1)) {
    const items = targets[index % targets.length];
    if (items.length > 1) items.pop();
    index += 1;
  }
  state.limits.truncated = Object.values(state.limits.omitted).some((count) => count > 0)
    || JSON.stringify(state).length > READING_STATE_MAX_CHARS;
  return state;
}

export function getReadingState(bookId) {
  if (!Number.isSafeInteger(bookId) || bookId < 1) throw new ReadingNoteError('book_id must be a positive integer');
  const db = getDb(true);
  try {
    const book = bookExists(db, bookId);
    const progress = db.prepare('SELECT page, char_offset, updated_at FROM book_progress WHERE book_id = ?').get(bookId);
    const bookmark = db.prepare('SELECT page, paragraph_idx, char_offset, created_at, updated_at FROM book_bookmarks WHERE book_id = ?').get(bookId);
    const summaries = recoveryNotes(db, bookId, 'summary', 'active', 12);
    const characters = recoveryNotes(db, bookId, 'character', 'active', 16);
    const activeThreads = recoveryNotes(db, bookId, 'thread', 'active', 40);
    const resolvedThreads = recoveryNotes(db, bookId, 'thread', 'resolved', 6, 'updated_at DESC, id DESC');
    const impressions = recoveryNotes(db, bookId, 'impression', 'active', 16, "CASE owner_id WHEN 'shared' THEN 0 ELSE 1 END, updated_at DESC, id DESC");

    const state = {
      book: { id: book.id, title: book.title, total_paragraphs: book.total_paragraphs },
      position: positionProjection(progress, bookmark),
      recent: summaries.slice(0, 2),
      history: summaries.slice(2, 10),
      characters,
      threads: { active: activeThreads, recent_resolved: resolvedThreads },
      impressions,
      limits: {
        max_chars: READING_STATE_MAX_CHARS,
        truncated: false,
        omitted: {
          summaries: Math.max(0, summaries.length - 10),
          characters: 0,
          active_threads: 0,
          resolved_threads: 0,
          impressions: 0,
        },
      },
    };
    const before = {
      summaries: state.recent.length + state.history.length,
      characters: state.characters.length,
      active_threads: state.threads.active.length,
      resolved_threads: state.threads.recent_resolved.length,
      impressions: state.impressions.length,
    };
    trimStateToCap(state);
    state.limits.omitted.summaries += before.summaries - state.recent.length - state.history.length;
    state.limits.omitted.characters += before.characters - state.characters.length;
    state.limits.omitted.active_threads += before.active_threads - state.threads.active.length;
    state.limits.omitted.resolved_threads += before.resolved_threads - state.threads.recent_resolved.length;
    state.limits.omitted.impressions += before.impressions - state.impressions.length;
    state.limits.truncated = Object.values(state.limits.omitted).some((count) => count > 0);
    return state;
  } finally {
    db.close();
  }
}
