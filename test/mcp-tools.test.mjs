import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { getDb, initDb } from '../lib/db.mjs';
import { handleTool, tools } from '../lib/mcp-tools.mjs';

const root = mkdtempSync(join(tmpdir(), 'coread-mcp-'));
initDb(join(root, 'coread.db'));

test.after(() => rmSync(root, { recursive: true, force: true }));

function seedBook(title, paragraphs) {
  const db = getDb();
  const inserted = db.prepare('INSERT INTO books (title, total_paragraphs) VALUES (?, ?)').run(title, paragraphs.length);
  const bookId = Number(inserted.lastInsertRowid);
  const insertParagraph = db.prepare('INSERT INTO book_paragraphs (book_id, idx, content) VALUES (?, ?, ?)');
  paragraphs.forEach((content, idx) => insertParagraph.run(bookId, idx, content));
  db.close();
  return bookId;
}

test('tools/list exposes the compact MCP schemas', () => {
  const byName = Object.fromEntries(tools.map(item => [item.name, item]));
  assert.deepEqual(tools.map(item => item.name), [
    'search_books', 'list_books', 'read_book', 'add_comment', 'list_comments',
    'get_toc', 'import_book', 'delete_comment', 'get_settings', 'update_progress',
  ]);
  assert.equal(byName.search_books.description, 'Find books by title.');
  assert.deepEqual(byName.search_books.inputSchema.properties, {
    query: { type: 'string' },
    limit: { type: 'integer', minimum: 1, maximum: 20 },
  });
  assert.equal(byName.list_books.description, 'List books and reading position.');
  assert.equal(byName.read_book.description, 'Read one book page.');
  assert.deepEqual(Object.keys(byName.read_book.inputSchema.properties), ['book_id', 'page']);
  assert.equal(byName.add_comment.description, 'Add an annotation or reply.');
  assert.deepEqual(Object.keys(byName.add_comment.inputSchema.properties), ['book_id', 'paragraph_idx', 'content', 'selected_text', 'reply_to']);
  assert.equal(byName.list_comments.description, "List a book's annotations.");
  assert.equal(byName.get_toc.description, "Get a book's contents.");
  assert.equal(byName.import_book.description, 'Import text or EPUB.');
  assert.equal(byName.delete_comment.description, 'Delete an annotation.');
  assert.equal(byName.get_settings.description, 'Get reading settings.');
  assert.equal(byName.update_progress.description, 'Save reading page.');
  assert.deepEqual(Object.keys(byName.update_progress.inputSchema.properties), ['book_id', 'page']);
});

test('search_books uses NFKC lowercase title substring and limit', () => {
  seedBook('Ａlpha Reading', ['body']);
  seedBook('alpha notes', ['body']);
  seedBook('unrelated', ['body']);
  const limited = handleTool('search_books', { query: 'aLPHa', limit: 1 });
  assert.equal(limited.length, 1);
  assert.match(limited[0].title.normalize('NFKC').toLowerCase(), /alpha/);
  assert.deepEqual(
    new Set(handleTool('search_books', { query: 'ＡＬＰＨＡ' }).map(book => book.title)),
    new Set(['alpha notes', 'Ａlpha Reading']),
  );
  assert.deepEqual(handleTool('search_books', { query: 'missing' }), []);
});

test('read/list/comment/toc projections do not leak database fields', () => {
  const paragraphs = ['# Opening', ...Array.from({ length: 30 }, (_, i) => `paragraph ${i} ${'x'.repeat(22)}`), '# Later', 'tail'];
  const bookId = seedBook('Projection fixture', paragraphs);
  const progress = handleTool('update_progress', { book_id: bookId, page: 2, char_offset: 99 });
  assert.deepEqual(progress, { ok: true });

  const db = getDb(true);
  assert.deepEqual(db.prepare('SELECT page, char_offset FROM book_progress WHERE book_id = ?').get(bookId), { page: 2, char_offset: 0 });
  db.close();

  const listed = handleTool('list_books', {}).find(book => book.id === bookId);
  assert.deepEqual(Object.keys(listed), ['id', 'title', 'current_page']);
  assert.equal(listed.current_page, 2);

  const page = handleTool('read_book', { book_id: bookId, page: 2, per_page: 1 });
  assert.deepEqual(Object.keys(page), ['page', 'total_pages', 'text']);
  assert.ok(page.total_pages >= 2);

  const comment = handleTool('add_comment', {
    book_id: bookId,
    paragraph_idx: 1,
    content: 'note',
    selected_text: 'paragraph',
    from_who: 'human',
  });
  assert.deepEqual(Object.keys(comment), ['id']);
  const reply = handleTool('add_comment', { book_id: bookId, paragraph_idx: 1, content: 'reply', reply_to: comment.id });
  const comments = handleTool('list_comments', { book_id: bookId });
  assert.deepEqual(comments[0], {
    id: comment.id,
    paragraph_idx: 1,
    from_who: 'ai',
    content: 'note',
    selected_text: 'paragraph',
  });
  assert.deepEqual(comments[1], {
    id: reply.id,
    paragraph_idx: 1,
    from_who: 'ai',
    content: 'reply',
    reply_to: comment.id,
  });

  const toc = handleTool('get_toc', { book_id: bookId });
  assert.deepEqual(Object.keys(toc[0]), ['page', 'title']);
  assert.equal(handleTool('read_book', { book_id: bookId, page: toc[1].page }).page, toc[1].page);
  assert.deepEqual(handleTool('delete_comment', { comment_id: reply.id }), { ok: true });
});

test('import and settings receipts stay minimal', () => {
  const imported = handleTool('import_book', { title: 'Imported', content: 'one\n\ntwo' });
  assert.deepEqual(Object.keys(imported), ['book_id']);
  assert.deepEqual(Object.keys(handleTool('get_settings', {})), ['context_chars']);
});
