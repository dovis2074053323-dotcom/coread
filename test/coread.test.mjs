import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { getDb, initDb } from '../lib/db.mjs';
import { handleRequest } from '../lib/routes.mjs';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const AdmZip = require('adm-zip');

const tempRoot = mkdtempSync(join(tmpdir(), 'coread-v1-'));
const dbPath = join(tempRoot, 'coread.db');
initDb(dbPath);

async function request(method, url, body) {
  const req = Readable.from(body === undefined ? [] : [JSON.stringify(body)]);
  req.method = method;
  req.url = url;
  req.headers = { 'x-owner-key': 'test-owner' };

  let statusCode = 200;
  const headers = {};
  let responseBody = '';
  let resolveResponse;
  const done = new Promise(resolve => { resolveResponse = resolve; });
  const res = {
    setHeader(name, value) { headers[name.toLowerCase()] = value; },
    writeHead(status, values = {}) {
      statusCode = status;
      for (const [name, value] of Object.entries(values)) headers[name.toLowerCase()] = value;
    },
    end(value = '') {
      responseBody += Buffer.isBuffer(value) ? value.toString('utf8') : String(value);
      resolveResponse();
    },
  };
  const handled = await handleRequest(req, res, { port: 3000 });
  await done;
  let json = null;
  try { json = responseBody ? JSON.parse(responseBody) : null; } catch {}
  return { handled, statusCode, headers, body: json, raw: responseBody };
}

test.after(() => rmSync(tempRoot, { recursive: true, force: true }));

test('persists progress, one bookmark, and selection/reply threads', async () => {
  const legacyRoot = mkdtempSync(join(tmpdir(), 'coread-legacy-'));
  const legacyPath = join(legacyRoot, 'coread.db');
  const legacyDb = new Database(legacyPath);
  legacyDb.exec(`
    CREATE TABLE book_progress (
      book_id INTEGER PRIMARY KEY,
      page INTEGER DEFAULT 1,
      updated_at DATETIME DEFAULT (datetime('now'))
    )
  `);
  legacyDb.close();
  initDb(legacyPath);
  const migrated = getDb(true);
  assert.ok(migrated.pragma('table_info(book_progress)').some(column => column.name === 'char_offset'));
  assert.ok(migrated.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'book_bookmarks'").get());
  migrated.close();
  rmSync(legacyRoot, { recursive: true, force: true });
  initDb(dbPath);

  const created = await request('POST', '/v1/books', {
    title: 'Persistence fixture',
    content: '第一段 alpha words\n\n第二段 beta words\n\n第三段 gamma words',
  });
  assert.equal(created.statusCode, 201);
  const bookId = created.body.book_id;

  const progress = await request('PATCH', `/v1/books/${bookId}/progress`, { page: 1, char_offset: 3 });
  assert.equal(progress.statusCode, 200);
  assert.equal(progress.body.progress.paragraph_idx, 1);
  assert.equal(progress.body.progress.char_offset, 3);

  // Re-opening the database exercises the same startup migration path used
  // after a service restart, rather than relying on an in-memory row.
  initDb(dbPath);
  const detail = await request('GET', `/v1/books/${bookId}?page=1`);
  assert.equal(detail.body.progress_position.paragraph_idx, 1);
  assert.equal(detail.body.progress_position.char_offset, 3);

  const bookmark = await request('PUT', `/v1/books/${bookId}/bookmark`, {
    page: 1,
    paragraph_idx: 1,
    char_offset: 2,
  });
  assert.equal(bookmark.statusCode, 200);
  assert.equal(bookmark.body.bookmark.paragraph_idx, 1);
  assert.equal(bookmark.body.bookmark.char_offset, 2);

  const updatedBookmark = await request('PATCH', `/v1/books/${bookId}/bookmark`, {
    page: 2,
    paragraph_idx: 2,
    char_offset: 4,
  });
  assert.equal(updatedBookmark.statusCode, 200);
  const bookmarkRead = await request('GET', `/v1/books/${bookId}/bookmark`);
  assert.deepEqual(
    {
      page: bookmarkRead.body.bookmark.page,
      paragraph_idx: bookmarkRead.body.bookmark.paragraph_idx,
      char_offset: bookmarkRead.body.bookmark.char_offset,
    },
    { page: 2, paragraph_idx: 2, char_offset: 4 },
  );

  const parent = await request('POST', `/v1/books/${bookId}/comment`, {
    paragraph_idx: 0,
    sel_start_idx: 1,
    sel_end_idx: 4,
    sel_end_para_idx: 1,
    selected_text: '段 alpha words 第二段',
    content: '跨段批注',
    from_who: 'human',
  });
  assert.equal(parent.statusCode, 200);
  const reply = await request('POST', `/v1/books/${bookId}/comment`, {
    paragraph_idx: 1,
    content: '回复批注',
    from_who: 'ai',
    reply_to: parent.body.id,
  });
  assert.equal(reply.statusCode, 200);

  const withThread = await request('GET', `/v1/books/${bookId}?page=1`);
  assert.equal(withThread.body.comments.length, 2);
  assert.equal(withThread.body.comments.find(comment => comment.id === parent.body.id).sel_end_para_idx, 1);
  assert.equal(withThread.body.comments.find(comment => comment.id === reply.body.id).reply_to, parent.body.id);

  const epub = new AdmZip();
  epub.addFile('mimetype', Buffer.from('application/epub+zip'));
  epub.addFile('META-INF/container.xml', Buffer.from(
    '<container><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
  ));
  epub.addFile('OEBPS/content.opf', Buffer.from(
    '<package><manifest><item id="chapter" href="chapter.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="chapter"/></spine></package>',
  ));
  epub.addFile('OEBPS/chapter.xhtml', Buffer.from(
    '<html><head><title>Fixture</title></head><body><h1>Chapter One</h1><p>EPUB body text</p></body></html>',
  ));
  const epubCreated = await request('POST', '/v1/books', {
    title: 'EPUB fixture',
    format: 'epub',
    data: epub.toBuffer().toString('base64'),
  });
  assert.equal(epubCreated.statusCode, 201);
  const epubDetail = await request('GET', `/v1/books/${epubCreated.body.book_id}?page=1`);
  assert.equal(epubDetail.statusCode, 200);
  assert.match(epubDetail.body.paragraphs.map(paragraph => paragraph.content).join('\n'), /EPUB body text/);

  const listed = await request('GET', '/v1/books');
  const listedBook = listed.body.books.find(book => book.id === bookId);
  assert.equal(listedBook.bookmark_paragraph_idx, 2);
  assert.equal(listedBook.current_offset, 3);

  const db = getDb(true);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM book_bookmarks WHERE book_id = ?').get(bookId).count, 1);
  assert.ok(db.pragma('table_info(book_progress)').some(column => column.name === 'char_offset'));
  db.close();
});

test('context_chars setting: default, persistence, and validation', async () => {
  initDb(dbPath);

  const initial = await request('GET', '/v1/settings');
  assert.equal(initial.statusCode, 200);
  assert.equal(initial.body.context_chars, 300);

  const rejected = await request('PUT', '/v1/settings', { context_chars: 10 });
  assert.equal(rejected.statusCode, 400);
  const rejectedHigh = await request('PUT', '/v1/settings', { context_chars: 99999 });
  assert.equal(rejectedHigh.statusCode, 400);
  const rejectedNaN = await request('PUT', '/v1/settings', { context_chars: 'lots' });
  assert.equal(rejectedNaN.statusCode, 400);

  const saved = await request('PUT', '/v1/settings', { context_chars: 600 });
  assert.equal(saved.statusCode, 200);
  assert.equal(saved.body.context_chars, 600);

  // Re-open the database to prove it survives a service restart.
  initDb(dbPath);
  const reloaded = await request('GET', '/v1/settings');
  assert.equal(reloaded.body.context_chars, 600);
  assert.equal(reloaded.body.settings.context_chars, '600');

  const custom = await request('PUT', '/v1/settings', { context_chars: 450 });
  assert.equal(custom.body.context_chars, 450);
});
