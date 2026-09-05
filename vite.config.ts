import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // Relative asset URLs keep the same build usable standalone and when
  // Morrow mounts it under /coread/ through its same-origin proxy.
  base: './',
  root: 'web',
  build: {
    // 只编译到 dist/，绝不直接碰 public/。public/ 是线上服务器每次请求现读
    // 磁盘的目录（server.mjs 零缓存），任何人跑一次 build 就会顶掉所有人正在
    // 看的页面——所以「编译」和「上线」分成两步：build 出 dist/，确认无误并
    // 提交后再手动 `npm run deploy` 把 dist/ 拷进 public/。
    outDir: '../dist',
    emptyOutDir: true,
  },
  server: {
    proxy: {
      '/v1': 'http://localhost:3000',
    },
  },
});
