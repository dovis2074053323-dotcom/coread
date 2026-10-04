import { createRequire } from 'module';
import path from 'path';
import fs from 'fs';
const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

let dbPath = null;

const noteSnapshot = (row) => ({
  id: row.id,
  book_id: row.book_id,
  kind: row.kind,
  owner_id: row.owner_id,
  subject: row.subject ?? null,
  body: row.body,
  scope_start_page: row.scope_start_page ?? null,
  scope_end_page: row.scope_end_page ?? null,
  anchor_page: row.anchor_page ?? null,
  status: row.status,
  resolution: row.resolution ?? null,
  created_at: row.created_at,
  updated_at: row.updated_at,
});

function migrateReadingNoteOwnerConstraint(db) {
  const table = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'book_notes'").get();
  if (!table?.sql || !/CHECK\s*\(owner_id\s+IN\s*\(/i.test(table.sql)) return;

  db.exec(`
    PRAGMA foreign_keys = OFF;
    BEGIN IMMEDIATE;
    CREATE TABLE book_notes_owner_v2 (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      book_id INTEGER NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('summary', 'character', 'thread', 'impression')),
      owner_id TEXT NOT NULL DEFAULT 'shared',
      subject TEXT,
      body TEXT NOT NULL,
      scope_start_page INTEGER,
      scope_end_page INTEGER,
      anchor_page INTEGER,
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'resolved', 'archived')),
      resolution TEXT,
      created_at DATETIME NOT NULL DEFAULT (datetime('now')),
      updated_at DATETIME NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (book_id) REFERENCES books(id) ON DELETE CASCADE
    );
    INSERT INTO book_notes_owner_v2
      (id, book_id, kind, owner_id, subject, body, scope_start_page, scope_end_page, anchor_page, status, resolution, created_at, updated_at)
      SELECT id, book_id, kind, owner_id, subject, body, scope_start_page, scope_end_page, anchor_page, status, resolution, created_at, updated_at
      FROM book_notes;
    DROP TABLE book_notes;
    ALTER TABLE book_notes_owner_v2 RENAME TO book_notes;
    CREATE INDEX idx_book_notes_book_kind_status
      ON book_notes (book_id, kind, status, updated_at DESC);
    CREATE INDEX idx_book_notes_owner
      ON book_notes (owner_id, updated_at DESC);
    COMMIT;
    PRAGMA foreign_keys = ON;
  `);
}

function ensureReadingNoteRevisionSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS book_note_revisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      note_id INTEGER NOT NULL,
      revision_number INTEGER NOT NULL,
      snapshot_json TEXT NOT NULL,
      changed_by TEXT NOT NULL,
      change_reason TEXT NOT NULL,
      created_at DATETIME NOT NULL DEFAULT (datetime('now')),
      UNIQUE (note_id, revision_number)
    );
    CREATE INDEX IF NOT EXISTS idx_book_note_revisions_note
      ON book_note_revisions (note_id, revision_number DESC);
  `);

  const missing = db.prepare(`
    SELECT n.*
      FROM book_notes n
     WHERE NOT EXISTS (
       SELECT 1 FROM book_note_revisions r WHERE r.note_id = n.id
     )
     ORDER BY n.id
  `).all();
  if (!missing.length) return;
  const insert = db.prepare(`
    INSERT INTO book_note_revisions(note_id, revision_number, snapshot_json, changed_by, change_reason, created_at)
    VALUES (?, 1, ?, 'migration', '启用修订历史时的现状', ?)
  `);
  db.transaction(() => {
    for (const row of missing) insert.run(row.id, JSON.stringify(noteSnapshot(row)), row.updated_at || row.created_at || new Date().toISOString());
  })();
}

export function initDb(customPath) {
  dbPath = customPath || path.join(process.cwd(), 'data', 'coread.db');
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS books (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      total_paragraphs INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT (datetime('now')),
      cover_image TEXT
    );
    CREATE TABLE IF NOT EXISTS book_paragraphs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      book_id INTEGER NOT NULL,
      idx INTEGER NOT NULL,
      content TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS book_comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      book_id INTEGER NOT NULL,
      paragraph_idx INTEGER NOT NULL,
      sel_start_idx INTEGER,
      sel_end_idx INTEGER,
      sel_end_para_idx INTEGER,
      selected_text TEXT,
      from_who TEXT DEFAULT 'human',
      content TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      reply_to INTEGER
    );
    CREATE TABLE IF NOT EXISTS book_progress (
      book_id INTEGER PRIMARY KEY,
      page INTEGER DEFAULT 1,
      char_offset INTEGER DEFAULT 0,
      updated_at DATETIME DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS book_bookmarks (
      book_id INTEGER PRIMARY KEY,
      page INTEGER NOT NULL DEFAULT 1,
      paragraph_idx INTEGER NOT NULL DEFAULT 0,
      char_offset INTEGER NOT NULL DEFAULT 0,
      created_at DATETIME DEFAULT (datetime('now')),
      updated_at DATETIME DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS book_notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      book_id INTEGER NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('summary', 'character', 'thread', 'impression')),
      owner_id TEXT NOT NULL DEFAULT 'shared',
      subject TEXT,
      body TEXT NOT NULL,
      scope_start_page INTEGER,
      scope_end_page INTEGER,
      anchor_page INTEGER,
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'resolved', 'archived')),
      resolution TEXT,
      created_at DATETIME NOT NULL DEFAULT (datetime('now')),
      updated_at DATETIME NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (book_id) REFERENCES books(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_book_notes_book_kind_status
      ON book_notes (book_id, kind, status, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_book_notes_owner
      ON book_notes (owner_id, updated_at DESC);
    CREATE TABLE IF NOT EXISTS config (
      key TEXT PRIMARY KEY,
      value TEXT
    );
  `);

  // Existing installations used a fixed owner CHECK. Keep the table and data,
  // but remove only that CHECK so new Residents can own notes without another migration.
  migrateReadingNoteOwnerConstraint(db);
  ensureReadingNoteRevisionSchema(db);

  // Older Coread databases already have book_progress, but predate the
  // character offset. Keep the existing page/paragraph anchor intact and
  // add only the field needed to restore a page that starts mid-paragraph.
  const progressColumns = db.pragma('table_info(book_progress)');
  if (!progressColumns.some(column => column.name === 'char_offset')) {
    db.exec('ALTER TABLE book_progress ADD COLUMN char_offset INTEGER DEFAULT 0');
  }
  db.close();
}

export function getDb(readonly = false) {
  return new Database(dbPath, { readonly });
}

export function getDbPath() { return dbPath; }

export function getImageDir(bookId) {
  const dir = path.join(path.dirname(dbPath), 'book-images', String(bookId));
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}
