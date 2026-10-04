import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { getDb, initDb } from '../lib/db.mjs';
import { handleRequest } from '../lib/routes.mjs';
import { extractContext } from '../lib/annotation-event.mjs';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const AdmZip = require('adm-zip');

const tempRoot = mkdtempSync(join(tmpdir(), 'coread-v1-'));
const dbPath = join(tempRoot, 'coread.db');
initDb(dbPath);

async function request(method, url, body, extraOpts = {}) {
  const req = Readable.from(body === undefined ? [] : [JSON.stringify(body)]);
  req.method = method;
  req.url = url;
  req.headers = { 'x-owner-key': 'test-owner', ...(extraOpts.headers || {}) };

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
  const handled = await handleRequest(req, res, { port: 3000, ...extraOpts });
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
  assert.ok(migrated.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'book_notes'").get());
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

  const rejected = await request('PUT', '/v1/settings', { context_chars: -1 });
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

  const zero = await request('PUT', '/v1/settings', { context_chars: 0 });
  assert.equal(zero.statusCode, 200);
  initDb(dbPath);
  const zeroReloaded = await request('GET', '/v1/settings');
  assert.equal(zeroReloaded.body.context_chars, 0);
  const arbitrary = await request('PUT', '/v1/settings', { context_chars: 137 });
  assert.equal(arbitrary.body.context_chars, 137);
});

test('extractContext walks paragraphs and stops at book edges', () => {
  const paras = [
    { idx: 0, content: 'AAAAAAAAAA' },
    { idx: 1, content: 'BBBBBBBBBB' },
    { idx: 2, content: 'CCCCCCCCCC' },
    { idx: 3, content: 'DDDDDDDDDD' },
    { idx: 4, content: 'EEEEEEEEEE' },
  ];

  const mid = extractContext(paras, { startParaIdx: 2, endParaIdx: 2, startIdx: 3, endIdx: 7 }, 8);
  assert.equal(mid.selected_text, 'CCCC');
  assert.equal(mid.context_before, 'BBB\n\nCCC');
  assert.equal(mid.context_after, 'CCC\n\nDDD');

  const atStart = extractContext(paras, { startParaIdx: 0, endParaIdx: 0, startIdx: 2, endIdx: 5 }, 100);
  assert.equal(atStart.context_before, 'AA');

  const atEnd = extractContext(paras, { startParaIdx: 4, endParaIdx: 4, startIdx: 0, endIdx: 10 }, 100);
  assert.equal(atEnd.context_after, '');
  assert.equal(atEnd.context_before, 'AAAAAAAAAA\n\nBBBBBBBBBB\n\nCCCCCCCCCC\n\nDDDDDDDDDD\n\n');

  const cross = extractContext(paras, { startParaIdx: 1, endParaIdx: 3, startIdx: 5, endIdx: 4 }, 3);
  assert.equal(cross.context_before, 'BBB');
  assert.equal(cross.context_after, 'DDD');
  assert.equal(cross.selected_text, 'BBBBB\n\nCCCCCCCCCC\n\nDDDD');

  const empty = extractContext(paras, { startParaIdx: 2, endParaIdx: 2, startIdx: 3, endIdx: 7 }, 0);
  assert.equal(empty.context_before, '');
  assert.equal(empty.context_after, '');
});

test('human annotation emits a context-rich event; AI write-back does not', async () => {
  initDb(dbPath);
  await request('PUT', '/v1/settings', { context_chars: 300 });
  const created = await request('POST', '/v1/books', {
    title: '事件夹具',
    content: '第一段内容在这里。\n\n第二段这里有一句想划的话，就是这句。\n\n第三段收尾。',
  });
  const bookId = created.body.book_id;
  await request('PATCH', `/v1/books/${bookId}/progress`, { page: 1, char_offset: 4 });

  const events = [];
  const onAnnotationEvent = (e) => events.push(e);

  const human = await request('POST', `/v1/books/${bookId}/comment`, {
    paragraph_idx: 1,
    sel_start_idx: 4,
    sel_end_idx: 9,
    selected_text: '这里有一句',
    content: '这句话让我想到……',
    from_who: 'human',
  }, { onAnnotationEvent });
  assert.equal(human.statusCode, 200);
  assert.equal(events.length, 1);
  const event = events[0];
  assert.equal(event.type, 'coread.annotation.created');
  assert.equal(event.book_id, bookId);
  assert.equal(event.book_title, '事件夹具');
  assert.equal(event.comment_id, human.body.id);
  assert.equal(event.from, 'human');
  assert.equal(event.comment, '这句话让我想到……');
  assert.equal(event.anchor.start_para, 1);
  assert.equal(event.selected_text, '这里有一句');
  assert.equal(event.context_chars, 300);
  assert.match(event.context_before, /第一段内容在这里/);
  assert.match(event.context_after, /第三段收尾/);
  assert.equal(event.reading_progress.paragraph_idx, 1);
  assert.equal(event.reading_progress.char_offset, 4);

  const ai = await request('POST', `/v1/books/${bookId}/comment`, {
    paragraph_idx: 1,
    content: '页边回应',
    from_who: 'cc',
    reply_to: human.body.id,
  }, { onAnnotationEvent });
  assert.equal(ai.statusCode, 200);
  assert.equal(events.length, 1, 'AI write-back must not emit another event');

  const humanReply = await request('POST', `/v1/books/${bookId}/comment`, {
    paragraph_idx: 1,
    content: '我又想到一点',
    from_who: 'human',
    reply_to: human.body.id,
  }, { onAnnotationEvent });
  assert.equal(events.length, 2);
  assert.equal(events[1].reply_to, human.body.id);
  assert.equal(events[1].reply_to_comment.comment, '这句话让我想到……');

  await request('PUT', '/v1/settings', { context_chars: 0 });
  const zeroContext = await request('POST', `/v1/books/${bookId}/comment`, {
    paragraph_idx: 1,
    sel_start_idx: 4,
    sel_end_idx: 9,
    selected_text: '这里有一句',
    content: '零上下文首次批注',
    from_who: 'human',
  }, { onAnnotationEvent });
  assert.equal(zeroContext.statusCode, 200);
  assert.equal(events[2].context_chars, 0);
  assert.equal(events[2].context_before, '');
  assert.equal(events[2].context_after, '');
});

test('edit book: rename keeps annotations; content replace re-anchors by text', async () => {
  initDb(dbPath);
  const created = await request('POST', '/v1/books', {
    title: '原书名',
    content: '第一段 alpha\n\n第二段 beta\n\n第三段 gamma',
  });
  assert.equal(created.statusCode, 201);
  const bookId = created.body.book_id;

  // A text-anchored annotation, a reply riding along with it, and progress.
  const anchored = await request('POST', `/v1/books/${bookId}/comment`, {
    paragraph_idx: 1, sel_start_idx: 3, sel_end_idx: 7,
    selected_text: 'beta', content: '一条批注', from_who: 'human',
  });
  await request('POST', `/v1/books/${bookId}/comment`, {
    paragraph_idx: 1, content: '一条回应', from_who: 'ai', reply_to: anchored.body.id,
  });
  await request('PATCH', `/v1/books/${bookId}/progress`, { page: 2, char_offset: 1 });

  // raw round-trips the stored paragraphs.
  const raw = await request('GET', `/v1/books/${bookId}/raw`);
  assert.equal(raw.statusCode, 200);
  assert.equal(raw.body.content, '第一段 alpha\n\n第二段 beta\n\n第三段 gamma');

  // Pure rename: title changes, annotations untouched.
  const renamed = await request('PATCH', `/v1/books/${bookId}`, { title: '新书名' });
  assert.equal(renamed.statusCode, 200);
  assert.equal(renamed.body.book.title, '新书名');
  assert.equal(renamed.body.content_replaced, false);
  const afterRename = await request('GET', `/v1/books/${bookId}?page=1`);
  assert.equal(afterRename.body.book.title, '新书名');
  assert.equal(afterRename.body.comments.length, 2);

  // Empty title is rejected.
  const emptyTitle = await request('PATCH', `/v1/books/${bookId}`, { title: '   ' });
  assert.equal(emptyTitle.statusCode, 400);

  // Content replace: insert a new opening paragraph (shifting indices) and edit
  // the third. 'beta' still exists but has moved from idx 1 to idx 2; its reply
  // follows it. The 'gamma' paragraph was rewritten, but this book had no
  // annotation there, so nothing is lost.
  const edited = await request('PATCH', `/v1/books/${bookId}`, {
    content: '新开头\n\n第一段 alpha\n\n第二段 beta\n\n第三段 delta',
  });
  assert.equal(edited.statusCode, 200);
  assert.equal(edited.body.content_replaced, true);
  assert.equal(edited.body.book.total_paragraphs, 4);
  assert.equal(edited.body.retained_annotations, 2);
  assert.equal(edited.body.dropped_annotations, 0);
  const afterEdit = await request('GET', `/v1/books/${bookId}?page=1`);
  assert.equal(afterEdit.body.comments.length, 2);
  const moved = afterEdit.body.comments.find(c => c.content === '一条批注');
  assert.equal(moved.paragraph_idx, 2);
  assert.equal(moved.selected_text, 'beta');
  assert.equal(afterEdit.body.paragraphs.find(p => p.idx === 2).content.slice(moved.sel_start_idx, moved.sel_end_idx), 'beta');
  const reply = afterEdit.body.comments.find(c => c.content === '一条回应');
  assert.equal(reply.paragraph_idx, 2);
  assert.equal(reply.reply_to, moved.id);

  // Now delete the text an annotation is anchored to: it can't be located.
  const dropEdit = await request('PATCH', `/v1/books/${bookId}`, {
    content: '新开头\n\n第一段 alpha\n\n第三段 delta',
  });
  assert.equal(dropEdit.body.retained_annotations, 0);
  assert.equal(dropEdit.body.dropped_annotations, 2);
  const afterDrop = await request('GET', `/v1/books/${bookId}?page=1`);
  assert.equal(afterDrop.body.comments.length, 0);

  // Empty content and missing fields are rejected; 404 for unknown book.
  const emptyContent = await request('PATCH', `/v1/books/${bookId}`, { content: '   ' });
  assert.equal(emptyContent.statusCode, 400);
  const noFields = await request('PATCH', `/v1/books/${bookId}`, {});
  assert.equal(noFields.statusCode, 400);
  const missing = await request('PATCH', '/v1/books/999999', { title: 'x' });
  assert.equal(missing.statusCode, 404);
});


test('typed reading notes preserve ownership and one-call recovery state', async () => {
  initDb(dbPath);
  process.env.MORROW_COREAD_BRIDGE_SECRET = 'test-coread-bridge';

  const created = await request('POST', '/v1/books', {
    title: 'Long reading state fixture',
    content: '第一章\n\n人物登场\n\n第二章\n\n伏笔出现\n\n第三章\n\n线索回收',
  });
  assert.equal(created.statusCode, 201);
  const bookId = created.body.book_id;
  await request('PATCH', `/v1/books/${bookId}/progress`, { page: 3, char_offset: 2 });
  await request('PUT', `/v1/books/${bookId}/bookmark`, { page: 2, paragraph_idx: 3, char_offset: 1 });

  const forgedOwner = await request('POST', `/v1/books/${bookId}/notes`, {
    kind: 'summary',
    owner_id: 'gpt',
    subject: '第一章',
    body: '第一章详细总结',
    scope_start_page: 1,
    scope_end_page: 1,
  });
  assert.equal(forgedOwner.statusCode, 201);
  assert.equal(forgedOwner.body.note.owner_id, 'user');

  const ccHeaders = { 'x-coread-owner': 'claude-code', 'x-morrow-coread-token': 'test-coread-bridge' };
  const gptHeaders = { 'x-coread-owner': 'gpt', 'x-morrow-coread-token': 'test-coread-bridge' };
  await request('POST', `/v1/books/${bookId}/notes`, {
    kind: 'summary', subject: '第二章', body: '第二章详细总结', scope_start_page: 2, scope_end_page: 2,
  }, { headers: ccHeaders });
  await request('POST', `/v1/books/${bookId}/notes`, {
    kind: 'summary', subject: '第三章', body: '第三章详细总结', scope_start_page: 3, scope_end_page: 3,
  }, { headers: ccHeaders });
  await request('POST', `/v1/books/${bookId}/notes`, {
    kind: 'character', subject: '阿宁', body: '表面冷静，但我觉得她在隐瞒害怕。', anchor_page: 3,
  }, { headers: ccHeaders });
  await request('POST', `/v1/books/${bookId}/notes`, {
    kind: 'impression', subject: '当前感受', body: '我不信任那个证人。', anchor_page: 3,
  }, { headers: gptHeaders });

  const activeThread = await request('POST', `/v1/books/${bookId}/notes`, {
    kind: 'thread', subject: '钥匙', body: '原猜测：钥匙属于失踪者。', anchor_page: 2,
  }, { headers: ccHeaders });
  const wrongOwner = await request('POST', `/v1/books/${bookId}/notes/${activeThread.body.note.id}/resolve`, {
    resolution: '伪造的结论',
  }, { headers: gptHeaders });
  assert.equal(wrongOwner.statusCode, 403);

  const resolved = await request('POST', `/v1/books/${bookId}/notes/${activeThread.body.note.id}/resolve`, {
    resolution: '真相：钥匙属于管家。',
    page: 3,
  }, { headers: ccHeaders });
  assert.equal(resolved.statusCode, 200);
  assert.equal(resolved.body.note.body, '原猜测：钥匙属于失踪者。');
  assert.equal(resolved.body.note.resolution, '真相：钥匙属于管家。');
  assert.equal(resolved.body.note.status, 'resolved');

  await request('POST', `/v1/books/${bookId}/notes`, {
    kind: 'thread', subject: '窗边脚印', body: '猜测脚印来自第二个人。', anchor_page: 3,
  });

  const restored = await request('GET', `/v1/books/${bookId}/reading-state`);
  assert.equal(restored.statusCode, 200);
  const state = restored.body.state;
  assert.deepEqual(
    {
      progress: state.position.progress,
      bookmark: state.position.bookmark,
    },
    {
      progress: { page: 3, paragraph_idx: 3, char_offset: 2, updated_at: state.position.progress.updated_at },
      bookmark: { page: 2, paragraph_idx: 3, char_offset: 1, created_at: state.position.bookmark.created_at, updated_at: state.position.bookmark.updated_at },
    },
  );
  assert.deepEqual(state.recent.map((note) => note.subject), ['第三章', '第二章']);
  assert.deepEqual(state.history.map((note) => note.subject), ['第一章']);
  assert.equal(state.characters[0].body, '表面冷静，但我觉得她在隐瞒害怕。');
  assert.equal(state.impressions[0].owner_id, 'gpt');
  assert.equal(state.threads.active[0].body, '猜测脚印来自第二个人。');
  assert.equal(state.threads.recent_resolved[0].body, '原猜测：钥匙属于失踪者。');
  assert.equal(state.threads.recent_resolved[0].resolution, '真相：钥匙属于管家。');
  assert.ok(JSON.stringify(state).length <= state.limits.max_chars);
  assert.equal(Object.hasOwn(state, 'comments'), false);
  assert.equal(Object.hasOwn(state, 'diary'), false);

  const listed = await request('GET', `/v1/books/${bookId}/notes?kind=thread&status=resolved`);
  assert.equal(listed.body.notes.length, 1);
  assert.equal(listed.body.notes[0].id, activeThread.body.note.id);

  const deleted = await request('DELETE', `/v1/books/${bookId}`);
  assert.equal(deleted.statusCode, 200);
  const db = getDb(true);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM book_notes WHERE book_id = ?').get(bookId).count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM book_note_revisions WHERE note_id = ?').get(activeThread.body.note.id).count, 0);
  db.close();
});


test('reading-note revisions are append-only, owner-bound, and allow future Resident ids', async () => {
  initDb(dbPath);
  process.env.MORROW_COREAD_BRIDGE_SECRET = 'test-coread-bridge';
  const created = await request('POST', '/v1/books', {
    title: 'Revision fixture',
    content: '第一章\n\n一条线索\n\n第二章\n\n答案揭晓',
  });
  const bookId = created.body.book_id;
  const edenHeaders = { 'x-coread-owner': 'opencode', 'x-morrow-coread-token': 'test-coread-bridge' };
  const gptHeaders = { 'x-coread-owner': 'gpt', 'x-morrow-coread-token': 'test-coread-bridge' };

  const noteCreated = await request('POST', `/v1/books/${bookId}/notes`, {
    kind: 'thread', subject: '门锁', body: '原猜测：钥匙在屋内。', anchor_page: 1,
  }, { headers: edenHeaders });
  assert.equal(noteCreated.statusCode, 201);
  assert.equal(noteCreated.body.note.owner_id, 'opencode');
  const noteId = noteCreated.body.note.id;

  let history = await request('GET', `/v1/books/${bookId}/notes/${noteId}/revisions`);
  assert.deepEqual(history.body.revisions.map(r => r.revision_number), [1]);
  assert.equal(history.body.revisions[0].snapshot.body, '原猜测：钥匙在屋内。');
  assert.equal(history.body.revisions[0].changed_by, 'opencode');

  const beforeNoop = noteCreated.body.note.updated_at;
  const noop = await request('PUT', `/v1/books/${bookId}/notes/${noteId}`, {
    kind: 'thread', subject: '门锁', body: '原猜测：钥匙在屋内。', anchor_page: 1,
  }, { headers: edenHeaders });
  assert.equal(noop.statusCode, 200);
  assert.equal(noop.body.note.updated_at, beforeNoop);
  history = await request('GET', `/v1/books/${bookId}/notes/${noteId}/revisions`);
  assert.equal(history.body.revisions.length, 1);

  const edited = await request('PUT', `/v1/books/${bookId}/notes/${noteId}`, {
    kind: 'thread', subject: '门锁与钥匙', body: '修正猜测：钥匙由第二个人带入。', anchor_page: 2,
    change_reason: '修正先前误判',
  }, { headers: edenHeaders });
  assert.equal(edited.statusCode, 200);
  history = await request('GET', `/v1/books/${bookId}/notes/${noteId}/revisions`);
  assert.deepEqual(history.body.revisions.map(r => r.revision_number), [2, 1]);
  assert.equal(history.body.revisions[0].change_reason, '修正先前误判');

  const resolved = await request('POST', `/v1/books/${bookId}/notes/${noteId}/resolve`, {
    resolution: '正文揭晓：钥匙从窗外递入。', page: 4,
  }, { headers: edenHeaders });
  assert.equal(resolved.statusCode, 200);
  assert.equal(resolved.body.note.status, 'resolved');
  assert.equal(resolved.body.note.body, '修正猜测：钥匙由第二个人带入。');

  const resolutionEdit = await request('POST', `/v1/books/${bookId}/notes/${noteId}/resolve`, {
    resolution: '正文最终确认：备用钥匙从窗外递入。', page: 4,
  }, { headers: edenHeaders });
  assert.equal(resolutionEdit.statusCode, 200);
  history = await request('GET', `/v1/books/${bookId}/notes/${noteId}/revisions`);
  assert.deepEqual(history.body.revisions.map(r => r.revision_number), [4, 3, 2, 1]);
  assert.equal(history.body.revisions[0].change_reason, '更新伏笔结论');

  const wrongOwnerRestore = await request('POST', `/v1/books/${bookId}/notes/${noteId}/revisions/1/restore`, {}, { headers: gptHeaders });
  assert.equal(wrongOwnerRestore.statusCode, 403);

  const restored = await request('POST', `/v1/books/${bookId}/notes/${noteId}/revisions/1/restore`, {}, { headers: edenHeaders });
  assert.equal(restored.statusCode, 200);
  assert.equal(restored.body.note.body, '原猜测：钥匙在屋内。');
  assert.equal(restored.body.note.status, 'active');
  assert.equal(restored.body.note.resolution, null);
  history = await request('GET', `/v1/books/${bookId}/notes/${noteId}/revisions`);
  assert.deepEqual(history.body.revisions.map(r => r.revision_number), [5, 4, 3, 2, 1]);
  assert.equal(history.body.revisions[0].change_reason, '恢复至 v1');

  await request('DELETE', `/v1/books/${bookId}`);
});

test('legacy fixed-owner book_notes migration preserves notes and seeds one baseline revision', () => {
  const root = mkdtempSync(join(tmpdir(), 'coread-note-owner-migration-'));
  const legacyPath = join(root, 'coread.db');
  const legacyDb = new Database(legacyPath);
  legacyDb.exec(`
    CREATE TABLE books (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, total_paragraphs INTEGER DEFAULT 0, created_at DATETIME DEFAULT (datetime('now')), cover_image TEXT);
    INSERT INTO books(id, title, total_paragraphs) VALUES (1, 'Legacy notes', 1);
    CREATE TABLE book_notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      book_id INTEGER NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('summary', 'character', 'thread', 'impression')),
      owner_id TEXT NOT NULL DEFAULT 'shared' CHECK (owner_id IN ('shared', 'user', 'claude-code', 'gpt')),
      subject TEXT,
      body TEXT NOT NULL,
      scope_start_page INTEGER,
      scope_end_page INTEGER,
      anchor_page INTEGER,
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'resolved', 'archived')),
      resolution TEXT,
      created_at DATETIME NOT NULL DEFAULT (datetime('now')),
      updated_at DATETIME NOT NULL DEFAULT (datetime('now'))
    );
    INSERT INTO book_notes(id, book_id, kind, owner_id, subject, body) VALUES (7, 1, 'impression', 'gpt', '旧笔记', '内容必须原样保留');
  `);
  legacyDb.close();

  initDb(legacyPath);
  const migrated = getDb(true);
  const schema = migrated.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='book_notes'").get().sql;
  assert.equal(/CHECK\s*\(owner_id\s+IN/i.test(schema), false);
  const note = migrated.prepare('SELECT * FROM book_notes WHERE id = 7').get();
  assert.equal(note.owner_id, 'gpt');
  assert.equal(note.body, '内容必须原样保留');
  const revisions = migrated.prepare('SELECT * FROM book_note_revisions WHERE note_id = 7 ORDER BY revision_number').all();
  assert.equal(revisions.length, 1);
  assert.equal(revisions[0].revision_number, 1);
  assert.equal(JSON.parse(revisions[0].snapshot_json).body, '内容必须原样保留');
  migrated.close();
  rmSync(root, { recursive: true, force: true });
  initDb(dbPath);
});
