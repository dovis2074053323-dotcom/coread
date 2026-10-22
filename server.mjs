import http from 'http';
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { execFile } from 'child_process';
import { fileURLToPath } from 'url';
import { initDb, getDb } from './lib/db.mjs';
import { handleRequest } from './lib/routes.mjs';
import { postAnnotationEvent, bridgeConfigured } from './lib/bridge.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.COREAD_PORT || '3000');
// 只对本机开放：外面一律走 Morrow 的 /coread 代理（带登录和同源校验），
// 直接暴露 3000 等于绕过登录就能删书、重启。
const HOST = process.env.COREAD_HOST || '127.0.0.1';
const DB_PATH = process.env.COREAD_DB || path.join(process.cwd(), 'data', 'coread.db');

// Optional comment notifier: run an arbitrary command whenever someone comments.
// COREAD_NOTIFY_CMD  — shell command to execute (comment details passed via env vars)
// COREAD_NOTIFY_FROM — only fire for this author (default 'human'; '*' = everyone)
// Env vars available to the command:
//   COREAD_BOOK_ID, COREAD_BOOK_TITLE, COREAD_FROM, COREAD_COMMENT
const NOTIFY_CMD = process.env.COREAD_NOTIFY_CMD || '';
const NOTIFY_FROM = process.env.COREAD_NOTIFY_FROM || 'human';

function notifyComment({ book_id, from_who, content }) {
  if (!NOTIFY_CMD) return;
  if (NOTIFY_FROM !== '*' && from_who !== NOTIFY_FROM) return;
  let title = `book#${book_id}`;
  try {
    const db = getDb(true);
    title = db.prepare('SELECT title FROM books WHERE id = ?').get(book_id)?.title || title;
    db.close();
  } catch {}
  execFile('/bin/sh', ['-c', NOTIFY_CMD], {
    timeout: 15000,
    env: {
      ...process.env,
      COREAD_BOOK_ID: String(book_id),
      COREAD_BOOK_TITLE: title,
      COREAD_FROM: from_who,
      COREAD_COMMENT: content || '',
    },
  }, (err) => { if (err) console.error('notify cmd error:', err.message); });
}

initDb(DB_PATH);

const MIME = {
  '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
};
const COMPRESSIBLE = /json|text|javascript|svg/;

// 手机上打开 Palimpsest 每次都要整包重传：既没有 Cache-Control（Vite 构建的
// index-*.js 文件名本身带 hash，本可以长期缓存），也没有压缩（JSON 大段落
// 响应和纯文本 JS bundle 都是压缩敏感内容）。这里在 res.end 上包一层透明
// gzip——不改 routes.mjs 里几十处 json() 调用点，静态文件和 API 响应一起受益
// （vv 2026-09-05 反馈"进去加载很慢"）。
function withGzip(req, res) {
  if (!/\bgzip\b/.test(req.headers['accept-encoding'] || '')) return res;
  const rawWriteHead = res.writeHead.bind(res);
  const rawWrite = res.write.bind(res);
  const rawEnd = res.end.bind(res);
  let pending = null;
  let streaming = false;
  res.writeHead = (status, headers) => { pending = [status, headers]; return res; };
  // epub 导出用 archiver 直接 .pipe(res)，走的是 write() 多次拼流，不是一把
  // 传完的 body——那种情况原样放行，不重复压缩（archiver 自己已经 zlib 了）。
  res.write = (chunk, ...rest) => {
    streaming = true;
    if (pending) { rawWriteHead(pending[0], pending[1]); pending = null; }
    return rawWrite(chunk, ...rest);
  };
  res.end = (body) => {
    if (streaming) return rawEnd(body);
    const [status, headers = {}] = pending || [res.statusCode, {}];
    const ct = headers['Content-Type'] || headers['content-type'] || '';
    if (body && body.length > 512 && COMPRESSIBLE.test(ct)) {
      const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
      const gz = zlib.gzipSync(buf);
      rawWriteHead(status, { ...headers, 'Content-Encoding': 'gzip', 'Content-Length': gz.length });
      rawEnd(gz);
    } else {
      rawWriteHead(status, headers);
      rawEnd(body);
    }
  };
  return res;
}

// 手动重启：server.mjs 和 lib/ 只在进程启动时加载一次（public/ 是现读的），
// 改了后端不重启，新路由就会掉进下面的 index.html 兜底、回一个 200 的网页。
// 只有被 systemd 托管（Restart=always 会设 INVOCATION_ID）时退出才等于重启；
// 裸跑时退出就是关机，所以那种情况不提供重启。
const STARTED_AT = new Date();
const SUPERVISED = Boolean(process.env.INVOCATION_ID);

function codeUpdatedAt() {
  const files = [path.join(__dirname, 'server.mjs')];
  const libDir = path.join(__dirname, 'lib');
  for (const name of fs.readdirSync(libDir)) if (name.endsWith('.mjs')) files.push(path.join(libDir, name));
  return new Date(Math.max(...files.map(f => fs.statSync(f).mtimeMs)));
}

const serverControl = {
  startedAt: STARTED_AT,
  supervised: SUPERVISED,
  codeUpdatedAt,
  restart() {
    console.log('  ↻ manual restart requested');
    // 先让这次请求的响应发出去，再收尾；空闲长连接直接断，卡住的请求最多等 3 秒。
    setTimeout(() => {
      server.close(() => process.exit(0));
      server.closeIdleConnections();
      setTimeout(() => process.exit(0), 3000).unref();
    }, 200);
  },
};

const server = http.createServer(async (req, res) => {
  res = withGzip(req, res);
  const handled = await handleRequest(req, res, {
    port: PORT,
    onComment: notifyComment,
    onAnnotationEvent: bridgeConfigured() ? postAnnotationEvent : null,
    server: serverControl,
  });
  if (handled) return;

  // Serve static files from public/
  let filePath = path.join(__dirname, 'public', req.url === '/' ? 'index.html' : req.url.split('?')[0]);
  if (!fs.existsSync(filePath) && !path.extname(filePath)) {
    filePath = path.join(__dirname, 'public', 'index.html');
  }
  try {
    const data = fs.readFileSync(filePath);
    const ext = path.extname(filePath).toLowerCase();
    // Vite 输出的 /assets/*-<hash>.js 文件名一变内容就变，可以放心长缓存；
    // index.html 本身要随时能拿到最新的资源引用，不缓存。
    const cacheControl = filePath.includes(`${path.sep}assets${path.sep}`)
      ? 'public, max-age=31536000, immutable'
      : 'no-cache';
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': cacheControl });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end('Not found');
  }
});

server.listen(PORT, HOST, () => {
  console.log(`\n  📚 coread server running at http://localhost:${PORT}`);
  console.log(`  📂 Database: ${DB_PATH}`);
  console.log(`  🌐 Open http://localhost:${PORT} in your browser\n`);
});
