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
