import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const AdmZip = require('adm-zip');

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');
const PORT = 34617;

const tempRoot = mkdtempSync(join(tmpdir(), 'coread-export-'));
const dbPath = join(tempRoot, 'coread.db');

let child;
let bookId;
let annoBookId;
let emptyBookId;
let rootAId, replyA1Id;

function httpRequest(opts, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: 'localhost', port: PORT, headers: { 'x-owner-key': 'test-owner' }, ...opts }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

test.before(async () => {
  child = spawn(process.execPath, ['server.mjs'], {
    cwd: repoRoot,
    env: { ...process.env, COREAD_PORT: String(PORT), COREAD_DB: dbPath },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((resolve, reject) => {
    let out = '';
    const onData = (d) => {
      out += d;
      if (out.includes('coread server running')) { child.stdout.off('data', onData); resolve(); }
    };
    child.stdout.on('data', onData);
    child.on('exit', (code) => reject(new Error(`coread server exited early (code ${code})`)));
    setTimeout(() => reject(new Error('coread server did not start in time')), 8000);
  });

  const created = await httpRequest(
    { path: '/v1/books', method: 'POST', headers: { 'Content-Type': 'application/json' } },
    JSON.stringify({ title: '导出验收夹具', content: '第一段正文，用来验证导出功能。\n\n第二段正文，带一条批注。' }),
  );
  assert.equal(created.statusCode, 201);
  bookId = JSON.parse(created.body.toString('utf8')).book_id;

  const commented = await httpRequest(
    { path: `/v1/books/${bookId}/comment`, method: 'POST', headers: { 'Content-Type': 'application/json' } },
    JSON.stringify({ paragraph_idx: 1, content: '这是一条批注', from_who: 'human' }),
  );
  assert.equal(commented.statusCode, 200);

  // 批注摘录夹具：一个更靠前段落的 root（后创建）、一个更靠后段落的 root
  // （先创建，带两层回复）、一条无 selected_text 的独立批注、一段无批注正文。
  const annoCreated = await httpRequest(
    { path: '/v1/books', method: 'POST', headers: { 'Content-Type': 'application/json' } },
    JSON.stringify({
      title: '批注摘录夹具',
      content: '第一段正文，包含一个较早位置的关键词句用于验证排序。\n\n第二段正文，包含一句会被划线的关键内容。\n\n第三段正文，不会出现在摘录里。',
    }),
  );
  assert.equal(annoCreated.statusCode, 201);
  annoBookId = JSON.parse(annoCreated.body.toString('utf8')).book_id;

  const rootA = await httpRequest(
    { path: `/v1/books/${annoBookId}/comment`, method: 'POST', headers: { 'Content-Type': 'application/json' } },
    JSON.stringify({ paragraph_idx: 1, selected_text: '包含一句会被划线的关键内容', content: '根批注A', from_who: 'human' }),
  );
  assert.equal(rootA.statusCode, 200);
  rootAId = JSON.parse(rootA.body.toString('utf8')).id;

  const replyA1 = await httpRequest(
    { path: `/v1/books/${annoBookId}/comment`, method: 'POST', headers: { 'Content-Type': 'application/json' } },
    JSON.stringify({ paragraph_idx: 1, content: '回应A-1', from_who: 'ai', reply_to: rootAId }),
  );
  assert.equal(replyA1.statusCode, 200);
  replyA1Id = JSON.parse(replyA1.body.toString('utf8')).id;

  const replyA2 = await httpRequest(
    { path: `/v1/books/${annoBookId}/comment`, method: 'POST', headers: { 'Content-Type': 'application/json' } },
    JSON.stringify({ paragraph_idx: 1, content: '回应A-2', from_who: 'human', reply_to: replyA1Id }),
  );
  assert.equal(replyA2.statusCode, 200);

  const rootB = await httpRequest(
    { path: `/v1/books/${annoBookId}/comment`, method: 'POST', headers: { 'Content-Type': 'application/json' } },
    JSON.stringify({ paragraph_idx: 0, selected_text: '包含一个较早位置的关键词句', content: '根批注B', from_who: 'human' }),
  );
  assert.equal(rootB.statusCode, 200);

  const independent = await httpRequest(
    { path: `/v1/books/${annoBookId}/comment`, method: 'POST', headers: { 'Content-Type': 'application/json' } },
    JSON.stringify({ paragraph_idx: 2, content: '没有划线的独立批注', from_who: 'human' }),
  );
  assert.equal(independent.statusCode, 200);

  const emptyCreated = await httpRequest(
    { path: '/v1/books', method: 'POST', headers: { 'Content-Type': 'application/json' } },
    JSON.stringify({ title: '无批注书籍', content: '这本书没有任何批注。' }),
  );
  assert.equal(emptyCreated.statusCode, 201);
  emptyBookId = JSON.parse(emptyCreated.body.toString('utf8')).book_id;
});

test.after(async () => {
  if (child && child.exitCode === null) child.kill();
  rmSync(tempRoot, { recursive: true, force: true });
});

test('EPUB export (no gzip): valid zip with the required entries', async () => {
  const res = await httpRequest({ path: `/v1/books/${bookId}/export?format=epub`, method: 'GET' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['content-type'], 'application/epub+zip');
  assert.equal(res.headers['content-encoding'], undefined);
  const names = new AdmZip(res.body).getEntries().map((e) => e.entryName);
  assert.ok(names.includes('mimetype'));
  assert.ok(names.includes('META-INF/container.xml'));
  assert.ok(names.includes('OEBPS/content.opf'));
});

test('EPUB export (Accept-Encoding: gzip): streaming bypass keeps it a plain valid zip', async () => {
  const res = await httpRequest({ path: `/v1/books/${bookId}/export?format=epub`, method: 'GET', headers: { 'Accept-Encoding': 'gzip' } });
  assert.equal(res.statusCode, 200);
  // archiver 自己已经 zlib 了；server.mjs 的 gzip 层对 streaming response 原样放行，不重复压缩。
  assert.equal(res.headers['content-encoding'], undefined);
  const names = new AdmZip(res.body).getEntries().map((e) => e.entryName);
  assert.ok(names.includes('mimetype'));
  assert.ok(names.includes('META-INF/container.xml'));
  assert.ok(names.includes('OEBPS/content.opf'));
});

test('Markdown export: contains body text and the annotation', async () => {
  const res = await httpRequest({ path: `/v1/books/${bookId}/export?format=md`, method: 'GET' });
  assert.equal(res.statusCode, 200);
  const text = res.body.toString('utf8');
  assert.match(text, /第一段正文，用来验证导出功能/);
  assert.match(text, /这是一条批注/);
});

test('annotations-md export: includes selected_text roots and full reply chains, in original-text order', async () => {
  const res = await httpRequest({ path: `/v1/books/${annoBookId}/export?format=annotations-md`, method: 'GET' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['content-type'], 'text/markdown; charset=utf-8');
  assert.match(decodeURIComponent(res.headers['content-disposition']), /批注摘录/);
  const text = res.body.toString('utf8');

  assert.match(text, /包含一个较早位置的关键词句/);
  assert.match(text, /根批注B/);
  assert.match(text, /包含一句会被划线的关键内容/);
  assert.match(text, /根批注A/);
  assert.match(text, /回应A-1/);
  assert.match(text, /回应A-2/);

  // root B sits in paragraph 0 (created after root A) but must still be
  // excerpted first: sort order is original text position, not creation time.
  assert.ok(text.indexOf('根批注B') < text.indexOf('根批注A'), 'earlier-paragraph root must come first');
  // a reply chain must stay nested under its own root: A's replies come
  // after root A's own comment, not spliced before it.
  assert.ok(text.indexOf('根批注A') < text.indexOf('回应A-1'));
  assert.ok(text.indexOf('回应A-1') < text.indexOf('回应A-2'));

  assert.doesNotMatch(text, /没有划线的独立批注/);
  assert.doesNotMatch(text, /不会出现在摘录里/);
});

test('annotations-md export: a book with no excerptable annotations still returns valid markdown', async () => {
  const res = await httpRequest({ path: `/v1/books/${emptyBookId}/export?format=annotations-md`, method: 'GET' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['content-type'], 'text/markdown; charset=utf-8');
  const text = res.body.toString('utf8');
  assert.match(text, /批注摘录/);
  assert.match(text, /暂无批注摘录。/);
  assert.doesNotMatch(text, /这本书没有任何批注/);
});

test('an aborted export stream does not crash the server; plain requests still work after', async () => {
  await new Promise((resolve) => {
    const req = http.request({ hostname: 'localhost', port: PORT, path: `/v1/books/${bookId}/export?format=epub`, method: 'GET' }, (res) => {
      res.once('data', () => { req.destroy(); resolve(); });
      res.on('error', () => resolve());
    });
    req.on('error', () => resolve());
    req.end();
  });

  await new Promise((r) => setTimeout(r, 300));
  assert.equal(child.exitCode, null, 'coread server process must survive an aborted export stream');

  const health = await httpRequest({ path: '/v1/books', method: 'GET' });
  assert.equal(health.statusCode, 200);
  assert.ok(Array.isArray(JSON.parse(health.body.toString('utf8')).books));
});
