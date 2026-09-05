#!/usr/bin/env node
// 上线：把已编译的 dist/ 覆盖到 public/。
//
// 为什么单独一步：server.mjs 对 public/ 是每次请求 fs.readFileSync 现读磁盘、
// 零缓存零网关，public/ 改了立刻就是线上。所以 `npm run build` 只出 dist/，
// 不碰 public/；确认改动没问题、提交之后，再手动跑这个脚本上线。
import { existsSync, rmSync, cpSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const publicDir = path.join(root, 'public');

if (!existsSync(path.join(dist, 'index.html'))) {
  console.error('✗ dist/index.html 不存在——先跑 `npm run build`。');
  process.exit(1);
}

rmSync(publicDir, { recursive: true, force: true });
cpSync(dist, publicDir, { recursive: true });

const fileCount = readdirSync(publicDir, { recursive: true, withFileTypes: true }).filter(d => d.isFile()).length;
console.log(`✓ 已上线 dist/ → public/（${fileCount} 个文件）。`);
console.log('  记得提交 public/ 以记录当前线上版本。');
