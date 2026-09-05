import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { getDb, getImageDir } from './db.mjs';
import { parseEpub, extractImages, extractCover, smartSplit } from './epub.mjs';
import { buildAnnotationEvent } from './annotation-event.mjs';
const require = createRequire(import.meta.url);

const CHAPTER_RE = /^第[\d一二三四五六七八九十百千万]+[章节回]|^#|^Chapter\s+\d/i;

// ─── 共读室关门锁（task-1786030476040-meb33p）───
// 与 bridge server / sullyos-bridge 工具共享同一把文件锁；开门要彤宝的 owner key。
const ROOM_LOCK_PATH = '/home/admin/.sullyos/reading-room-lock.json';
const ROOM_OWNER_KEY = process.env.ROOM_OWNER_KEY || 'xk-room-owner-f47ac10b58d2e619a3c4';
function readRoomLock() {
  try {
    const s = JSON.parse(fs.readFileSync(ROOM_LOCK_PATH, 'utf8'));
    return { locked: !!s.locked, at: s.at || null, note: typeof s.note === 'string' ? s.note : '' };
  } catch { return { locked: false, at: null, note: '' }; }
}
function roomGate(req, res) {
  if (!readRoomLock().locked) return false;
  if ((req.headers['x-owner-key'] || '') === ROOM_OWNER_KEY) return false;
  json(res, 423, { error: 'door_locked', message: '共读室已关门（彤宝落了锁），开门要彤宝来。' });
  return true;
}

// 统一坐标制（移植自 Sully AS#72）：全系统只保留这一套服务端分页，
// per_page 参数不再解析——前端/AI/批注页码共用同一坐标，不再各切各的页
export const BOOK_PER_PAGE = 28;

// 共读上下文范围（字符数，正文向选区两侧各取多少字）。Phase 2 只落地存储，
// Phase 3 的「批注触发 AI」「从选中句主动讨论」两条链路都直接读这一个值。
export const DEFAULT_CONTEXT_CHARS = 300;
export const CONTEXT_CHARS_MIN = 50;
export const CONTEXT_CHARS_MAX = 5000;

export function clampContextChars(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_CONTEXT_CHARS;
  return Math.min(CONTEXT_CHARS_MAX, Math.max(CONTEXT_CHARS_MIN, Math.round(n)));
}

// Phase 3 入口：给定一个已打开的 db，取当前共读上下文字符数（缺省 300）。
export function getContextChars(db) {
  try {
    const row = db.prepare("SELECT value FROM config WHERE key = 'context_chars'").get();
    return row ? clampContextChars(row.value) : DEFAULT_CONTEXT_CHARS;
  } catch {
    return DEFAULT_CONTEXT_CHARS;
  }
}

export function computePageBreaks(db, bookId, perPage, charsPerLine = 22) {
  const paras = db.prepare('SELECT idx, content FROM book_paragraphs WHERE book_id = ? ORDER BY idx').all(bookId);
  const pages = [];
  let cur = [];
  let curWeight = 0;
  const maxWeight = perPage;
  for (const p of paras) {
    if (CHAPTER_RE.test(p.content.trim().substring(0, 60)) && cur.length > 0) {
      pages.push(cur);
      cur = [];
      curWeight = 0;
    }
    const lines = Math.max(1, Math.ceil(p.content.length / charsPerLine));
    if (curWeight + lines > maxWeight && cur.length > 0) {
      pages.push(cur);
      cur = [];
      curWeight = 0;
    }
    cur.push(p.idx);
    curWeight += lines;
  }
  if (cur.length > 0) pages.push(cur);
  return pages;
}

function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(data));
}

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-owner-key, x-morrow-request');
}

async function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => data += c);
    req.on('end', () => { try { resolve(JSON.parse(data)); } catch { reject(new Error('Invalid JSON')); } });
    req.on('error', reject);
  });
}

function integer(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  return Number.isSafeInteger(n) ? n : null;
}

function positionPayload(row) {
  if (!row) return null;
  return {
    page: row.page,
    paragraph_idx: row.page,
    char_offset: row.char_offset || 0,
    updated_at: row.updated_at || null,
  };
}

function bookmarkPayload(row) {
  if (!row) return null;
  return {
    page: row.page,
    paragraph_idx: row.paragraph_idx,
    char_offset: row.char_offset || 0,
    created_at: row.created_at || null,
    updated_at: row.updated_at || null,
  };
}

export async function handleRequest(req, res, opts = {}) {
  if (req.method === 'OPTIONS') {
    cors(res);
    res.writeHead(204);
    res.end();
    return true;
  }

  cors(res);
  const port = opts.port || 3000;

  // GET /v1/settings — reading-room settings. Phase 2 only carries context_chars.
  if (req.method === 'GET' && req.url === '/v1/settings') {
    try {
      const db = getDb(true);
      const rows = db.prepare('SELECT key, value FROM config').all();
      db.close();
      const settings = {};
      for (const row of rows) settings[row.key] = row.value;
      json(res, 200, {
        context_chars: settings.context_chars != null ? clampContextChars(settings.context_chars) : DEFAULT_CONTEXT_CHARS,
        settings,
      });
    } catch (e) { json(res, 500, { error: e.message }); }
    return true;
  }

  // PUT /v1/settings — persist context_chars (50..5000). Same value feeds both
  // Phase 3 AI paths; the web reader keeps a localStorage copy for instant UI.
  if (req.method === 'PUT' && req.url === '/v1/settings') {
    if (roomGate(req, res)) return true;
    try {
      const body = await readBody(req);
      const raw = body.context_chars ?? body.contextChars;
      const n = integer(raw);
      if (n === null || n < CONTEXT_CHARS_MIN || n > CONTEXT_CHARS_MAX) {
        json(res, 400, { error: `context_chars must be an integer in [${CONTEXT_CHARS_MIN}, ${CONTEXT_CHARS_MAX}]` });
        return true;
      }
      const db = getDb();
      db.prepare("INSERT INTO config (key, value) VALUES ('context_chars', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(n));
      db.close();
      json(res, 200, { ok: true, context_chars: n });
    } catch (e) { json(res, 500, { error: e.message }); }
    return true;
  }

  // GET /v1/books
  if (req.method === 'GET' && req.url === '/v1/books') {
    try {
      const db = getDb(true);
      const books = db.prepare(`
        SELECT b.id, b.title, b.total_paragraphs, b.created_at, b.cover_image,
               p.page as current_page, p.char_offset as current_offset,
               p.updated_at as last_read_at,
               bm.page as bookmark_page, bm.paragraph_idx as bookmark_paragraph_idx,
               bm.char_offset as bookmark_offset, bm.updated_at as bookmark_updated_at
        FROM books b
        LEFT JOIN book_progress p ON b.id = p.book_id
        LEFT JOIN book_bookmarks bm ON b.id = bm.book_id
        ORDER BY b.created_at DESC
      `).all();
      const commentCounts = db.prepare('SELECT book_id, COUNT(*) as count FROM book_comments GROUP BY book_id').all();
      db.close();
      const countMap = {};
      for (const c of commentCounts) countMap[c.book_id] = c.count;
      json(res, 200, { books: books.map(b => ({ ...b, comment_count: countMap[b.id] || 0 })) });
    } catch (e) { json(res, 500, { error: e.message }); }
    return true;
  }

  // GET /v1/books/:id/slice
  if (req.method === 'GET' && req.url.match(/^\/v1\/books\/\d+\/slice/)) {
    if (roomGate(req, res)) return true;
    try {
      const urlObj = new URL(req.url, `http://localhost:${port}`);
      const id = parseInt(req.url.split('/')[3]);
      const start = parseInt(urlObj.searchParams.get('start') || '0');
      const count = parseInt(urlObj.searchParams.get('count') || '30');
      const db = getDb(true);
      const book = db.prepare('SELECT * FROM books WHERE id = ?').get(id);
      if (!book) { db.close(); json(res, 404, { error: 'not found' }); return true; }
      const paragraphs = db.prepare('SELECT idx, content FROM book_paragraphs WHERE book_id = ? AND idx >= ? ORDER BY idx LIMIT ?').all(id, start, count);
      const minIdx = paragraphs.length ? paragraphs[0].idx : start;
      const maxIdx = paragraphs.length ? paragraphs[paragraphs.length - 1].idx : start;
      const comments = paragraphs.length ? db.prepare('SELECT * FROM book_comments WHERE book_id = ? AND paragraph_idx BETWEEN ? AND ? ORDER BY paragraph_idx, created_at').all(id, minIdx, maxIdx) : [];
      db.close();
      json(res, 200, { book, paragraphs, comments, total: book.total_paragraphs });
    } catch (e) { json(res, 500, { error: e.message }); }
    return true;
  }

  // GET /v1/books/:id/bookmark
  if (req.method === 'GET' && req.url.match(/^\/v1\/books\/\d+\/bookmark(?:\?|$)/)) {
    if (roomGate(req, res)) return true;
    try {
      const id = parseInt(req.url.split('/')[3]);
      const db = getDb(true);
      const book = db.prepare('SELECT id FROM books WHERE id = ?').get(id);
      if (!book) { db.close(); json(res, 404, { error: 'book not found' }); return true; }
      const bookmark = db.prepare('SELECT page, paragraph_idx, char_offset, created_at, updated_at FROM book_bookmarks WHERE book_id = ?').get(id);
      db.close();
      json(res, 200, { bookmark: bookmarkPayload(bookmark) });
    } catch (e) { json(res, 500, { error: e.message }); }
    return true;
  }

  // PUT/PATCH /v1/books/:id/bookmark — one durable bookmark per book.
  if ((req.method === 'PUT' || req.method === 'PATCH') && req.url.match(/^\/v1\/books\/\d+\/bookmark$/)) {
    if (roomGate(req, res)) return true;
    try {
      const id = parseInt(req.url.split('/')[3]);
      const body = await readBody(req);
      const page = integer(body.page);
      const paragraphIdx = integer(body.paragraph_idx ?? body.para_idx ?? body.page);
      const charOffset = integer(body.char_offset ?? body.offset ?? 0);
      if (page === null || page < 1 || paragraphIdx === null || paragraphIdx < 0 || charOffset === null || charOffset < 0) {
        json(res, 400, { error: 'page, paragraph_idx and non-negative char_offset required' }); return true;
      }
      const db = getDb();
      const book = db.prepare('SELECT id FROM books WHERE id = ?').get(id);
      if (!book) { db.close(); json(res, 404, { error: 'book not found' }); return true; }
      const para = db.prepare('SELECT content FROM book_paragraphs WHERE book_id = ? AND idx = ?').get(id, paragraphIdx);
      if (!para) { db.close(); json(res, 400, { error: 'paragraph_idx not found' }); return true; }
      if (charOffset > para.content.length) { db.close(); json(res, 400, { error: 'char_offset out of range' }); return true; }
      db.prepare(`
        INSERT INTO book_bookmarks (book_id, page, paragraph_idx, char_offset, updated_at)
        VALUES (?, ?, ?, ?, datetime('now'))
        ON CONFLICT(book_id) DO UPDATE SET
          page = excluded.page,
          paragraph_idx = excluded.paragraph_idx,
          char_offset = excluded.char_offset,
          updated_at = datetime('now')
      `).run(id, page, paragraphIdx, charOffset);
      const bookmark = db.prepare('SELECT page, paragraph_idx, char_offset, created_at, updated_at FROM book_bookmarks WHERE book_id = ?').get(id);
      db.close();
      json(res, 200, { ok: true, bookmark: bookmarkPayload(bookmark) });
    } catch (e) { json(res, 500, { error: e.message }); }
    return true;
  }

  // GET /v1/books/:id
  if (req.method === 'GET' && req.url.match(/^\/v1\/books\/\d+(\?|$)/)) {
    if (roomGate(req, res)) return true;
    try {
      const url = new URL(req.url, `http://localhost:${port}`);
      const id = parseInt(url.pathname.split('/')[3]);
      const page = parseInt(url.searchParams.get('page') || '1');
      const perPage = BOOK_PER_PAGE; // 统一坐标制：per_page 参数不再解析（移植自 Sully AS#72）
      const db = getDb(true);
      const book = db.prepare('SELECT * FROM books WHERE id = ?').get(id);
      if (!book) { db.close(); json(res, 404, { error: 'book not found' }); return true; }
      const pages = computePageBreaks(db, id, perPage);
      const totalPages = pages.length || 1;
      const clampedPage = Math.max(1, Math.min(page, totalPages));
      const pageIndices = pages[clampedPage - 1] || [];
      let paragraphs = [];
      if (pageIndices.length > 0) {
        const placeholders = pageIndices.map(() => '?').join(',');
        paragraphs = db.prepare(`SELECT idx, content FROM book_paragraphs WHERE book_id = ? AND idx IN (${placeholders}) ORDER BY idx`).all(id, ...pageIndices);
      }
      const comments = db.prepare('SELECT * FROM book_comments WHERE book_id = ? ORDER BY paragraph_idx, created_at').all(id);
      const progress = db.prepare('SELECT page, char_offset, updated_at FROM book_progress WHERE book_id = ?').get(id);
      const bookmark = db.prepare('SELECT page, paragraph_idx, char_offset, created_at, updated_at FROM book_bookmarks WHERE book_id = ?').get(id);
      db.close();
      json(res, 200, {
        book,
        paragraphs,
        comments,
        pagination: { page: clampedPage, perPage, totalPages, total: book.total_paragraphs },
        // Keep the legacy numeric progress field for MCP/older clients. The
        // position object carries the new character offset explicitly.
        progress: progress?.page || 1,
        progress_position: positionPayload(progress),
        bookmark: bookmarkPayload(bookmark),
      });
    } catch (e) { json(res, 500, { error: e.message }); }
    return true;
  }

  // POST /v1/books/:id/comment
  if (req.method === 'POST' && req.url.match(/^\/v1\/books\/\d+\/comment$/)) {
    if (roomGate(req, res)) return true;
    try {
      const id = parseInt(req.url.split('/')[3]);
      const body = await readBody(req);
      const { paragraph_idx, selected_text, content, from_who, origin, sel_start_idx, sel_end_idx, sel_end_para_idx, reply_to } = body;
      const startParaIdx = integer(paragraph_idx);
      const endParaIdx = integer(sel_end_para_idx ?? paragraph_idx);
      const startIdxValue = integer(sel_start_idx);
      const endIdxValue = integer(sel_end_idx);
      if (startParaIdx === null || startParaIdx < 0 || !String(content || '').trim()) { json(res, 400, { error: 'paragraph_idx and content required' }); return true; }
      if (endParaIdx === null || endParaIdx < startParaIdx || (startIdxValue !== null && startIdxValue < 0) || (endIdxValue !== null && endIdxValue < 0)) {
        json(res, 400, { error: 'invalid selection anchor' }); return true;
      }
      const db = getDb();
      db.pragma('foreign_keys = OFF');
      const author = from_who || 'human';
      const book = db.prepare('SELECT id FROM books WHERE id = ?').get(id);
      if (!book) { db.close(); json(res, 404, { error: 'book not found' }); return true; }
      const startPara = db.prepare('SELECT content FROM book_paragraphs WHERE book_id = ? AND idx = ?').get(id, startParaIdx);
      const endPara = db.prepare('SELECT content FROM book_paragraphs WHERE book_id = ? AND idx = ?').get(id, endParaIdx);
      if (!startPara || !endPara) { db.close(); json(res, 400, { error: 'selection paragraph not found' }); return true; }
      let startIdx = startIdxValue, endIdx = endIdxValue;
      if (selected_text && startIdx == null) {
        if (startPara.content) {
          const i = startPara.content.indexOf(selected_text);
          if (i >= 0) { startIdx = i; endIdx = i + selected_text.length; }
        }
      }
      if (startIdx !== null && startIdx > startPara.content.length) { db.close(); json(res, 400, { error: 'selection start out of range' }); return true; }
      if (endIdx !== null && endIdx > endPara.content.length) { db.close(); json(res, 400, { error: 'selection end out of range' }); return true; }
      const result = db.prepare('INSERT INTO book_comments (book_id, paragraph_idx, sel_start_idx, sel_end_idx, sel_end_para_idx, selected_text, from_who, content, reply_to) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(id, startParaIdx, startIdx, endIdx, endParaIdx !== startParaIdx ? endParaIdx : null, selected_text || null, author, String(content).trim(), reply_to ?? null);
      const commentId = Number(result.lastInsertRowid);

      // Phase 3: only a human-origin annotation/reply produces a Resident
      // event. A Resident write-back must never re-enter here, or replies
      // would loop. Origin used to be inferred from `from_who === 'human'`,
      // but the UI sends vv's own editable display name there — the moment
      // she renames herself away from the literal string "human", every
      // annotation silently stopped triggering the bridge. `origin` is an
      // explicit, non-user-editable flag; fall back to the old inference
      // only when a caller doesn't send it (older tests, direct API use).
      const isHumanOrigin = origin ? origin === 'human' : author === 'human';
      let annotationEvent = null;
      if (isHumanOrigin && opts.onAnnotationEvent) {
        try {
          const bookRow = db.prepare('SELECT id, title FROM books WHERE id = ?').get(id);
          const paragraphs = db.prepare('SELECT idx, content FROM book_paragraphs WHERE book_id = ? ORDER BY idx').all(id);
          const progress = db.prepare('SELECT page, char_offset FROM book_progress WHERE book_id = ?').get(id) || null;
          const parent = (reply_to != null)
            ? db.prepare('SELECT id, from_who, content, selected_text FROM book_comments WHERE id = ?').get(reply_to)
            : null;
          const commentRow = db.prepare('SELECT id, paragraph_idx, sel_start_idx, sel_end_idx, sel_end_para_idx, selected_text, from_who, content, reply_to FROM book_comments WHERE id = ?').get(commentId);
          annotationEvent = buildAnnotationEvent({
            book: bookRow,
            comment: commentRow,
            paragraphs,
            contextChars: getContextChars(db),
            progress,
            replyTo: parent,
          });
        } catch (e) {
          console.error('annotation event build failed:', e.message);
        }
      }

      db.close();
      json(res, 200, { ok: true, id: commentId });
      if (opts.onComment) opts.onComment({ book_id: id, from_who: author, content });
      if (annotationEvent && opts.onAnnotationEvent) opts.onAnnotationEvent(annotationEvent);
    } catch (e) { json(res, 500, { error: e.message }); }
    return true;
  }

  // DELETE /v1/books/comment/:id
  if (req.method === 'DELETE' && req.url.match(/^\/v1\/books\/comment\/\d+$/)) {
    try {
      const commentId = parseInt(req.url.split('/').pop());
      const db = getDb();
      db.prepare('DELETE FROM book_comments WHERE id = ?').run(commentId);
      db.close();
      json(res, 200, { ok: true });
    } catch (e) { json(res, 500, { error: e.message }); }
    return true;
  }

  // GET /v1/books/:id/new-replies
  if (req.method === 'GET' && req.url.match(/^\/v1\/books\/\d+\/new-replies/)) {
    try {
      const urlObj = new URL(req.url, 'http://localhost');
      const id = parseInt(req.url.split('/')[3]);
      const lastSeen = parseInt(urlObj.searchParams.get('since') || '0');
      const db = getDb(true);
      const replies = db.prepare(
        `SELECT c.id, c.paragraph_idx, c.content, c.created_at, c.reply_to,
                c.from_who, c.sel_start_idx, c.sel_end_idx, c.selected_text,
                p.content as parent_content, p.from_who as parent_from, p.id as parent_id,
                p.paragraph_idx as parent_paragraph_idx,
                p.sel_start_idx as parent_sel_start_idx,
                p.sel_end_idx as parent_sel_end_idx,
                p.selected_text as parent_selected_text
         FROM book_comments c
         LEFT JOIN book_comments p ON c.reply_to = p.id
         WHERE c.book_id = ? AND c.id > ?
         ORDER BY c.id DESC LIMIT 20`
      ).all(id, lastSeen);
      db.close();
      json(res, 200, { replies });
    } catch (e) { json(res, 500, { error: e.message }); }
    return true;
  }

  // GET /v1/books/:id/reader-state
  if (req.method === 'GET' && req.url.match(/^\/v1\/books\/\d+\/reader-state/)) {
    if (roomGate(req, res)) return true;
    try {
      const urlObj = new URL(req.url, 'http://localhost');
      const id = parseInt(req.url.split('/')[3]);
      const lastCommentId = parseInt(urlObj.searchParams.get('since') || '0');
      const db = getDb(true);
      const progress = db.prepare('SELECT page, char_offset, updated_at FROM book_progress WHERE book_id = ?').get(id);
      const position = progress?.page ?? 0;
      const around = 3;
      const paras = db.prepare('SELECT idx, content FROM book_paragraphs WHERE book_id = ? AND idx >= ? AND idx < ? ORDER BY idx').all(id, Math.max(0, position - around), position + 10 + around);
      const newComments = db.prepare('SELECT id, paragraph_idx, from_who, content, reply_to, created_at FROM book_comments WHERE book_id = ? AND id > ? ORDER BY id').all(id, lastCommentId);
      const visibleComments = db.prepare('SELECT id, paragraph_idx, sel_start_idx, sel_end_idx, selected_text, from_who, content, reply_to, created_at FROM book_comments WHERE book_id = ? AND paragraph_idx >= ? AND paragraph_idx < ? ORDER BY paragraph_idx, created_at').all(id, Math.max(0, position), position + 10);
      db.close();
      json(res, 200, { position, char_offset: progress?.char_offset || 0, progress: positionPayload(progress), paragraphs: paras, newComments, visibleComments });
    } catch (e) { json(res, 500, { error: e.message }); }
    return true;
  }

  // PATCH /v1/books/:id/progress
  if (req.method === 'PATCH' && req.url.match(/^\/v1\/books\/\d+\/progress$/)) {
    if (roomGate(req, res)) return true;
    try {
      const id = parseInt(req.url.split('/')[3]);
      const body = await readBody(req);
      const page = integer(body.page ?? body.paragraph_idx ?? body.para_idx);
      const charOffset = integer(body.char_offset ?? body.offset ?? 0);
      if (page === null || page < 0 || charOffset === null || charOffset < 0) { json(res, 400, { error: 'page and non-negative char_offset required' }); return true; }
      const db = getDb();
      const book = db.prepare('SELECT id FROM books WHERE id = ?').get(id);
      if (!book) { db.close(); json(res, 404, { error: 'book not found' }); return true; }
      const para = db.prepare('SELECT content FROM book_paragraphs WHERE book_id = ? AND idx = ?').get(id, page);
      // `page` was the historical public field and some MCP clients use it
      // as a page number. The web reader stores its paragraph anchor there;
      // keep both forms accepted while validating offsets when an anchor is
      // available.
      if (para && charOffset > para.content.length) { db.close(); json(res, 400, { error: 'char_offset out of range' }); return true; }
      db.prepare("INSERT INTO book_progress (book_id, page, char_offset, updated_at) VALUES (?, ?, ?, datetime('now')) ON CONFLICT(book_id) DO UPDATE SET page = ?, char_offset = ?, updated_at = datetime('now')").run(id, page, charOffset, page, charOffset);
      const progress = db.prepare('SELECT page, char_offset, updated_at FROM book_progress WHERE book_id = ?').get(id);
      db.close();
      json(res, 200, { ok: true, progress: positionPayload(progress) });
    } catch (e) { json(res, 500, { error: e.message }); }
    return true;
  }

  // POST /v1/books — create book
  if (req.method === 'POST' && req.url === '/v1/books') {
    if (roomGate(req, res)) return true;
    try {
      const body = await readBody(req);
      const { title, content, format, data } = body;
      if (!title) { json(res, 400, { error: 'title required' }); return true; }

      let paragraphs = [];
      let epubResult = null;

      if (format === 'epub' && data) {
        epubResult = parseEpub(data);
        paragraphs = epubResult.paragraphs;
      } else if (content) {
        paragraphs = smartSplit(content);
      } else {
        json(res, 400, { error: 'content or epub data required' }); return true;
      }

      if (paragraphs.length === 0) { json(res, 400, { error: 'no paragraphs extracted' }); return true; }

      const db = getDb();
      const bookResult = db.prepare('INSERT INTO books (title, total_paragraphs) VALUES (?, ?)').run(title, paragraphs.length);
      const bookId = Number(bookResult.lastInsertRowid);
      const ins = db.prepare('INSERT INTO book_paragraphs (book_id, idx, content) VALUES (?, ?, ?)');
      db.transaction(() => { for (let i = 0; i < paragraphs.length; i++) ins.run(bookId, i, paragraphs[i]); })();
      db.close();

      if (epubResult) {
        const imgDir = getImageDir(bookId);
        const images = extractImages(epubResult.zip, epubResult.epubImageMap, paragraphs);
        for (const [fname, data] of images) {
          fs.writeFileSync(path.join(imgDir, fname), data);
        }
        const cover = extractCover(epubResult.zip, epubResult.epubCoverFile);
        if (cover) {
          fs.writeFileSync(path.join(imgDir, cover.name), cover.data);
          const db2 = getDb();
          db2.prepare('UPDATE books SET cover_image = ? WHERE id = ?').run(cover.name, bookId);
          db2.close();
        }
      }

      json(res, 201, { ok: true, book_id: bookId, title, paragraphs: paragraphs.length });
    } catch (e) {
      console.error('Book create error:', e);
      json(res, 500, { error: e.message });
    }
    return true;
  }

  // GET /v1/books/:id/toc
  if (req.method === 'GET' && req.url.match(/^\/v1\/books\/\d+\/toc/)) {
    try {
      const id = parseInt(req.url.split('/')[3]);
      const urlObj = new URL(req.url, 'http://localhost');
      const perPage = BOOK_PER_PAGE; // 统一坐标制：目录页码与正文同一坐标
      const db = getDb(true);
      const pages = computePageBreaks(db, id, perPage);
      const idxToPage = {};
      for (let i = 0; i < pages.length; i++) {
        for (const idx of pages[i]) idxToPage[idx] = i + 1;
      }
      const paras = db.prepare('SELECT idx, substr(content, 1, 100) as content FROM book_paragraphs WHERE book_id = ? ORDER BY idx').all(id);
      db.close();
      const chapters = [];
      for (const p of paras) {
        if (CHAPTER_RE.test(p.content.trim())) {
          const title = p.content.trim().split('\n')[0].replace(/^#+\s*/, '').slice(0, 60);
          chapters.push({ idx: p.idx, page: idxToPage[p.idx] || 1, title });
        }
      }
      json(res, 200, { chapters, totalPages: pages.length });
    } catch (e) { json(res, 500, { error: e.message }); }
    return true;
  }

  // GET /v1/books/:id/export
  if (req.method === 'GET' && req.url.match(/^\/v1\/books\/\d+\/export/)) {
    if (roomGate(req, res)) return true;
    try {
      const urlObj = new URL(req.url, `http://localhost:${port}`);
      const id = parseInt(urlObj.pathname.split('/')[3]);
      const format = urlObj.searchParams.get('format') || 'epub';
      const db = getDb(true);
      const book = db.prepare('SELECT * FROM books WHERE id = ?').get(id);
      if (!book) { db.close(); json(res, 404, { error: 'book not found' }); return true; }
      const paras = db.prepare('SELECT idx, content FROM book_paragraphs WHERE book_id = ? ORDER BY idx').all(id);
      const comments = db.prepare('SELECT * FROM book_comments WHERE book_id = ? ORDER BY paragraph_idx, sel_start_idx, created_at').all(id);
      db.close();

      const commentsByPara = {};
      for (const c of comments) {
        if (!commentsByPara[c.paragraph_idx]) commentsByPara[c.paragraph_idx] = [];
        commentsByPara[c.paragraph_idx].push(c);
      }

      if (format === 'md') {
        let md = `# ${book.title}\n\n`;
        for (const para of paras) {
          md += para.content + '\n\n';
          const pComments = commentsByPara[para.idx];
          if (pComments?.length) {
            for (const c of pComments) {
              if (c.selected_text) md += `> **${c.from_who}** highlighted "${c.selected_text}": ${c.content}\n>\n`;
              else md += `> **${c.from_who}**: ${c.content}\n>\n`;
            }
            md += '\n';
          }
        }
        cors(res);
        res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8', 'Content-Disposition': `attachment; filename="${encodeURIComponent(book.title)}.md"` });
        res.end(md);
        return true;
      }

      // 批注摘录导出：只导出有 selected_text 的顶层批注（一条摘录 root）
      // 及其整条回复链，跳过整本正文和无 selected_text 的独立批注。
      if (format === 'annotations-md') {
        const childrenOf = new Map();
        for (const c of comments) {
          if (c.reply_to == null) continue;
          if (!childrenOf.has(c.reply_to)) childrenOf.set(c.reply_to, []);
          childrenOf.get(c.reply_to).push(c);
        }
        for (const list of childrenOf.values()) {
          list.sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : a.id - b.id));
        }
        const roots = comments
          .filter(c => c.reply_to == null && c.selected_text && c.selected_text.trim())
          .sort((a, b) => {
            if (a.paragraph_idx !== b.paragraph_idx) return a.paragraph_idx - b.paragraph_idx;
            const aStart = a.sel_start_idx ?? -1, bStart = b.sel_start_idx ?? -1;
            if (aStart !== bStart) return aStart - bStart;
            return a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : a.id - b.id;
          });

        let md = `# 《${book.title}》· 批注摘录\n\n`;
        if (!roots.length) {
          md += '暂无批注摘录。\n';
        } else {
          const blocks = roots.map((root, i) => {
            const num = String(i + 1).padStart(2, '0');
            let block = `## ${num}\n`;
            block += root.selected_text.split('\n').map(l => `> ${l}`).join('\n') + '\n\n';
            const parts = [];
            const walk = (node) => {
              parts.push(`**${node.from_who}**\n${node.content}`);
              for (const kid of childrenOf.get(node.id) || []) walk(kid);
            };
            walk(root);
            block += parts.join('\n\n');
            return block;
          });
          md += blocks.join('\n\n---\n\n') + '\n';
        }
        cors(res);
        const fname = `《${book.title}》-批注摘录`;
        res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8', 'Content-Disposition': `attachment; filename="${encodeURIComponent(fname)}.md"` });
        res.end(md);
        return true;
      }

      // EPUB export
      const archiver = require('archiver');
      const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
      const epubId = `book-${id}-${Date.now()}`;
      const chapterRe = /^第[\d一二三四五六七八九十百千万]+[章节回]|^#|^Chapter\s+\d/i;
      const chapters = [];
      let curChapter = { title: book.title, paras: [] };
      for (const p of paras) {
        const t = p.content.trim();
        if (chapterRe.test(t) && curChapter.paras.length > 0) {
          chapters.push(curChapter);
          curChapter = { title: t.split('\n')[0].replace(/^#+\s*/, '').slice(0, 80), paras: [] };
        }
        curChapter.paras.push(p);
      }
      if (curChapter.paras.length > 0) chapters.push(curChapter);

      const style = `body{font-family:"PingFang SC","Hiragino Sans GB","Microsoft YaHei",serif;line-height:1.85;color:#333;margin:1em}h1{text-align:center;font-size:1.4em;margin:2em 0 1em;color:#222}p{text-indent:1.5em;margin:.6em 0}.ann{background:#f8f0f0;border-left:3px solid #d4a0a0;border-radius:8px;padding:8px 12px;margin:8px 0;font-size:.9em}.ann-author{font-weight:bold;color:#8b6b6b}.ann-quote{font-style:italic;color:#888;margin-bottom:4px}`;

      const imgDir = getImageDir(id);
      const exportImages = new Map();
      try {
        for (const f of fs.readdirSync(imgDir)) exportImages.set(f, fs.readFileSync(path.join(imgDir, f)));
      } catch {}

      const buildChapterXhtml = (ch, idx) => {
        let body = '';
        if (idx > 0 || chapterRe.test(ch.paras[0]?.content?.trim() || '')) body += `<h1>${esc(ch.title)}</h1>\n`;
        for (const p of ch.paras) {
          const t = p.content.trim();
          const imgMatch = t.match(/^\[IMG:([^\]]+)\]$/);
          if (imgMatch) { body += `<div style="text-align:center;margin:1em 0"><img src="images/${esc(imgMatch[1])}" style="max-width:100%"/></div>\n`; continue; }
          if (chapterRe.test(t) && body.includes('</h1>')) {} else {
            const isH = t.startsWith('#');
            const display = t.replace(/^#+\s*/, '');
            if (isH) body += `<h1>${esc(display)}</h1>\n`;
            else body += `<p>${display.replace(/\[IMG:([^\]]+)\]/g, (_, f) => `</p><div style="text-align:center;margin:1em 0"><img src="images/${esc(f)}" style="max-width:100%"/></div><p>`)}</p>\n`;
          }
          const pComments = commentsByPara[p.idx];
          if (pComments?.length) {
            for (const c of pComments) {
              body += `<div class="ann">`;
              if (c.selected_text) body += `<div class="ann-quote">"${esc(c.selected_text.slice(0, 200))}"</div>`;
              body += `<span class="ann-author">${esc(c.from_who)}</span>: ${esc(c.content)}</div>\n`;
            }
          }
        }
        return `<?xml version="1.0" encoding="utf-8"?><!DOCTYPE html><html xmlns="http://www.w3.org/1999/xhtml" xml:lang="zh"><head><meta charset="utf-8"/><title>${esc(ch.title)}</title><link rel="stylesheet" type="text/css" href="style.css"/></head><body>${body}</body></html>`;
      };

      let manifest = '', spine = '', navPoints = '';
      for (let i = 0; i < chapters.length; i++) {
        manifest += `<item id="ch${i}" href="ch${i}.xhtml" media-type="application/xhtml+xml"/>\n`;
        spine += `<itemref idref="ch${i}"/>\n`;
        navPoints += `<navPoint id="nav${i}" playOrder="${i+1}"><navLabel><text>${esc(chapters[i].title)}</text></navLabel><content src="ch${i}.xhtml"/></navPoint>\n`;
      }

      const mimeTypes = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', svg: 'image/svg+xml', webp: 'image/webp' };
      let imgManifest = '', coverMeta = '';
      let imgIdx = 0;
      for (const [fname] of exportImages) {
        const ext = fname.split('.').pop().toLowerCase();
        const mime = mimeTypes[ext] || 'image/jpeg';
        const imgId = `img${imgIdx++}`;
        imgManifest += `<item id="${imgId}" href="images/${esc(fname)}" media-type="${mime}"${fname.startsWith('cover.') ? ' properties="cover-image"' : ''}/>\n`;
        if (fname.startsWith('cover.')) coverMeta = `<meta name="cover" content="${imgId}"/>`;
      }

      // archive 创建 + error handler 必须在 writeHead 之前挂好：一旦响应头
      // 发出后 archive 再报错，catch 里二次 writeHead/json 会直接崩进程。
      const archive = archiver('zip', { zlib: { level: 9 } });
      archive.on('error', (err) => {
        console.error('epub export archive error:', err.message);
        if (!res.headersSent) {
          json(res, 500, { error: err.message });
        } else if (!res.writableEnded) {
          res.destroy(err);
        }
      });

      cors(res);
      res.writeHead(200, { 'Content-Type': 'application/epub+zip', 'Content-Disposition': `attachment; filename="${encodeURIComponent(book.title)}.epub"` });
      archive.pipe(res);
      archive.append('application/epub+zip', { name: 'mimetype', store: true });
      archive.append(`<?xml version="1.0" encoding="UTF-8"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`, { name: 'META-INF/container.xml' });
      archive.append(`<?xml version="1.0" encoding="utf-8"?><package xmlns="http://www.idpf.org/2007/opf" unique-identifier="bookid" version="2.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${esc(book.title)}</dc:title><dc:language>zh</dc:language><dc:identifier id="bookid">${epubId}</dc:identifier><dc:creator>coread</dc:creator>${coverMeta}</metadata><manifest><item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/><item id="css" href="style.css" media-type="text/css"/>${manifest}${imgManifest}</manifest><spine toc="ncx">${spine}</spine></package>`, { name: 'OEBPS/content.opf' });
      archive.append(`<?xml version="1.0" encoding="utf-8"?><ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1"><head><meta name="dtb:uid" content="${epubId}"/></head><docTitle><text>${esc(book.title)}</text></docTitle><navMap>${navPoints}</navMap></ncx>`, { name: 'OEBPS/toc.ncx' });
      archive.append(style, { name: 'OEBPS/style.css' });
      for (let i = 0; i < chapters.length; i++) archive.append(buildChapterXhtml(chapters[i], i), { name: `OEBPS/ch${i}.xhtml` });
      for (const [fname, data] of exportImages) archive.append(data, { name: `OEBPS/images/${fname}` });
      archive.finalize();
    } catch (e) {
      if (!res.headersSent) {
        json(res, 500, { error: e.message });
      } else if (!res.writableEnded) {
        res.destroy(e);
      }
    }
    return true;
  }

  // DELETE /v1/books/:id
  if (req.method === 'DELETE' && req.url.match(/^\/v1\/books\/\d+$/)) {
    try {
      const id = parseInt(req.url.split('/')[3]);
      const db = getDb();
      const book = db.prepare('SELECT id FROM books WHERE id = ?').get(id);
      if (!book) { db.close(); json(res, 404, { error: 'book not found' }); return true; }
      db.prepare('DELETE FROM book_comments WHERE book_id = ?').run(id);
      db.prepare('DELETE FROM book_paragraphs WHERE book_id = ?').run(id);
      db.prepare('DELETE FROM book_progress WHERE book_id = ?').run(id);
      db.prepare('DELETE FROM book_bookmarks WHERE book_id = ?').run(id);
      db.prepare('DELETE FROM books WHERE id = ?').run(id);
      db.close();
      json(res, 200, { ok: true, deleted: id });
    } catch (e) { json(res, 500, { error: e.message }); }
    return true;
  }

  // GET /v1/book-images/:bookId/:filename
  const imgMatch = req.url?.match(/^\/v1\/book-images\/(\d+)\/(.+)$/);
  if (req.method === 'GET' && imgMatch) {
    const imgPath = path.join(getImageDir(parseInt(imgMatch[1])), decodeURIComponent(imgMatch[2]));
    try {
      const data = fs.readFileSync(imgPath);
      const ext = path.extname(imgPath).toLowerCase();
      const mimeMap = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml' };
      cors(res);
      res.writeHead(200, { 'Content-Type': mimeMap[ext] || 'application/octet-stream', 'Cache-Control': 'public, max-age=86400' });
      res.end(data);
    } catch { res.writeHead(404); res.end('not found'); }
    return true;
  }

  return false;
}
