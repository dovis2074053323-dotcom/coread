import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initDb, getDb } from '../lib/db.mjs';
import { handleRequest } from '../lib/routes.mjs';

test('cc chapters append to their own book without changing existing pages or annotations', async () => {
  const root = mkdtempSync(join(tmpdir(), 'coread-chapter-'));
  const previousSecret = process.env.MORROW_COREAD_BRIDGE_SECRET;
  process.env.MORROW_COREAD_BRIDGE_SECRET = 'coread-chapter-test-token';
  initDb(join(root, 'coread.db'));
  const server = createServer(async (req, res) => {
    if (!await handleRequest(req, res)) {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const url = `http://127.0.0.1:${server.address().port}`;
    const residentHeaders = {
      'content-type': 'application/json',
      'x-coread-owner': 'claude-code',
      'x-morrow-coread-token': 'coread-chapter-test-token',
    };
    const request = async (path, payload, headers = residentHeaders) => {
      const response = await fetch(url + path, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
      });
      return { status: response.status, body: await response.json() };
    };
    const made = await request('/v1/books', { title: 'cc 的长书', content: '最初的一页' });
    assert.equal(made.status, 201);
    const id = made.body.book_id;
    const db = getDb();
    db.prepare('INSERT INTO book_comments (book_id, paragraph_idx, content) VALUES (?, 0, ?)').run(id, '原来的批注');
    db.prepare('INSERT INTO book_progress (book_id, page) VALUES (?, 0)').run(id);
    db.close();

    const appended = await request(`/v1/books/${id}/chapters`, {
      title: '醒来的第二章',
      content: '写下第一段。\n\n写下第二段。',
    });
    assert.equal(appended.status, 201);
    assert.equal(appended.body.ok, true);
    assert.equal(appended.body.book_id, id);
    assert.ok(appended.body.appended_paragraphs >= 3);
    const saved = getDb(true);
    assert.equal(saved.prepare('SELECT owner_id FROM books WHERE id = ?').get(id).owner_id, 'claude-code');
    assert.equal(saved.prepare('SELECT content FROM book_paragraphs WHERE book_id = ? AND idx = 0').get(id).content, '最初的一页');
    assert.equal(saved.prepare('SELECT content FROM book_paragraphs WHERE book_id = ? AND idx = 1').get(id).content, '# 醒来的第二章');
    assert.equal(saved.prepare('SELECT paragraph_idx FROM book_comments WHERE book_id = ?').get(id).paragraph_idx, 0);
    assert.equal(saved.prepare('SELECT page FROM book_progress WHERE book_id = ?').get(id).page, 0);
    assert.equal(saved.prepare('SELECT total_paragraphs FROM books WHERE id = ?').get(id).total_paragraphs,
      appended.body.total_paragraphs);
    saved.close();

    assert.equal((await request(`/v1/books/${id}/chapters`, { title: '无权追加', content: 'x' }, {
      'content-type': 'application/json',
    })).status, 403);

    const human = await request('/v1/books', { title: 'vv 的书', content: '他人的文字' }, {
      'content-type': 'application/json',
    });
    assert.equal(human.status, 201);
    assert.equal((await request(`/v1/books/${human.body.book_id}/chapters`, {
      title: '不允许', content: '不能追加到他人作品',
    })).status, 403);
  } finally {
    await new Promise(resolve => server.close(resolve));
    if (previousSecret === undefined) delete process.env.MORROW_COREAD_BRIDGE_SECRET;
    else process.env.MORROW_COREAD_BRIDGE_SECRET = previousSecret;
    rmSync(root, { recursive: true, force: true });
  }
});
