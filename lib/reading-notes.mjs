import { getDb } from './db.mjs';

export const READING_NOTE_KINDS = Object.freeze(['summary', 'character', 'thread', 'impression']);
export const READING_NOTE_OWNERS = Object.freeze(['shared', 'user', 'claude-code', 'gpt']);
export const READING_NOTE_STATUSES = Object.freeze(['active', 'resolved', 'archived']);
export const READING_STATE_MAX_CHARS = 12_000;

const KIND_SET = new Set(READING_NOTE_KINDS);
const OWNER_SET = new Set(READING_NOTE_OWNERS);
const STATUS_SET = new Set(READING_NOTE_STATUSES);
const SUBJECT_MAX = 200;
const BODY_MAX = 10_000;
const RESOLUTION_MAX = 10_000;

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
  if (!OWNER_SET.has(owner)) throw new ReadingNoteError(`owner must be one of: ${READING_NOTE_OWNERS.join(', ')}`);
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

export function listReadingNotes(bookId, {
  kind,
  ownerId,
  status,
  limit = 50,
} = {}) {
  if (!Number.isSafeInteger(bookId) || bookId < 1) throw new ReadingNoteError('book_id must be a positive integer');
  const cap = Math.min(100, Math.max(1, Number.isSafeInteger(limit) ? limit : 50));
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

export function upsertReadingNote({
  id = null,
  bookId,
  ownerId,
  kind,
  subject = null,
  body,
  scopeStartPage = null,
  scopeEndPage = null,
  anchorPage = null,
}) {
  if (!Number.isSafeInteger(bookId) || bookId < 1) throw new ReadingNoteError('book_id must be a positive integer');
  const owner = normalizeReadingNoteOwner(ownerId);
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
      const current = db.prepare('SELECT * FROM book_notes WHERE id = ?').get(id);
      if (!current || current.book_id !== bookId) throw new ReadingNoteError('reading note not found', 404);
      if (current.owner_id !== owner) throw new ReadingNoteError('reading note belongs to another owner', 403);
      db.prepare(
        `UPDATE book_notes
            SET kind = ?, subject = ?, body = ?, scope_start_page = ?, scope_end_page = ?,
                anchor_page = ?, updated_at = datetime('now')
          WHERE id = ?`,
      ).run(normalizedKind, normalizedSubject, normalizedBody, startPage, endPage, notePage, id);
      return noteProjection(db.prepare('SELECT * FROM book_notes WHERE id = ?').get(id));
    }

    const inserted = db.prepare(
      `INSERT INTO book_notes
        (book_id, kind, owner_id, subject, body, scope_start_page, scope_end_page, anchor_page)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(bookId, normalizedKind, owner, normalizedSubject, normalizedBody, startPage, endPage, notePage);
    return noteProjection(db.prepare('SELECT * FROM book_notes WHERE id = ?').get(Number(inserted.lastInsertRowid)));
  } finally {
    db.close();
  }
}

export function resolveReadingThread({ id, bookId = null, ownerId, resolution, page = null }) {
  if (!Number.isSafeInteger(id) || id < 1) throw new ReadingNoteError('id must be a positive integer');
  if (bookId != null && (!Number.isSafeInteger(bookId) || bookId < 1)) throw new ReadingNoteError('book_id must be a positive integer');
  const owner = normalizeReadingNoteOwner(ownerId);
  const normalizedResolution = boundedText(resolution, 'resolution', RESOLUTION_MAX, { required: true });
  const anchorPage = positivePage(page, 'page');
  const db = getDb();
  try {
    const current = db.prepare('SELECT * FROM book_notes WHERE id = ?').get(id);
    if (!current || (bookId != null && current.book_id !== bookId)) throw new ReadingNoteError('reading thread not found', 404);
    if (current.kind !== 'thread') throw new ReadingNoteError('only thread notes can be resolved');
    if (current.owner_id !== owner) throw new ReadingNoteError('reading thread belongs to another owner', 403);
    db.prepare(
      `UPDATE book_notes
          SET status = 'resolved', resolution = ?,
              anchor_page = COALESCE(?, anchor_page), updated_at = datetime('now')
        WHERE id = ?`,
    ).run(normalizedResolution, anchorPage, id);
    return noteProjection(db.prepare('SELECT * FROM book_notes WHERE id = ?').get(id));
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
    const current = db.prepare('SELECT id, owner_id FROM book_notes WHERE id = ?').get(id);
    if (!current || (bookId != null && current.book_id !== bookId)) throw new ReadingNoteError('reading note not found', 404);
    if (current.owner_id !== owner) throw new ReadingNoteError('reading note belongs to another owner', 403);
    db.prepare('DELETE FROM book_notes WHERE id = ?').run(id);
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
