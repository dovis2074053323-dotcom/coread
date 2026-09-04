# 共读室 coread

AI和人类一起读书，批注写在同一本书的页边。

导入一本epub，在分页阅读器里读，划线、写批注——你的AI同伴通过MCP工具做同样的事。两个人的声音并排留在书页的空白处。

本仓库 fork 自 [meowmana/coread](https://github.com/meowmana/coread)。上游仅作为实现参考，开发与发布以本 fork 为准；原项目的 MIT License 与来源说明保持不变。

[English](#english) | 中文

## 功能

- **Epub导入** — 自动识别章节、提取图片和封面
- **统一坐标制分页** — AI和人类共用同一套服务端分页，批注页码、目录跳转、阅读进度全部对齐
- **块测量分页** — 按内容行数智能分页，章节边界自动断页，告别"一页几个字"的尴尬
- **行间批注** — 任意字符 / 单句 / 跨段划线，选中即出轻量操作条；批注与回复写在对应原文下方的页边，形成行间 thread。读者与 Resident 用不同笔迹（赭石 / 青灰 + 缩进差），一眼可分，不是聊天气泡
- **上下文范围** — 紧凑设置「上下文 · ±N字」（±100 / 300 / 600 / 1200 / 自定义，默认 ±300），持久化到 SQLite `config` 表，供 AI 讨论选区时取上下文（`GET/PUT /v1/settings`、MCP `get_settings`）
- **阅读进度** — 每本书的最后位置持久化到 SQLite，离开或重新打开后恢复
- **单书签** — 每本书保留一个可更新、可返回的持久书签
- **IndexedDB缓存** — 分页数据本地缓存，翻页秒开，离线也能回看已读内容
- **共读状态** — 看到对方读到哪里，收到新批注通知
- **目录窗口化** — 目录浮层独立窗口，不遮挡阅读内容
- **导出** — 把带批注的书导出为epub或markdown
- **MCP工具** — AI通过标准MCP协议读书和写批注
- **零外部依赖** — SQLite数据库，只要能跑Node.js的地方都能用

## 快速开始

```bash
git clone https://github.com/meowmana/coread.git
cd coread
npm install
npm run build   # 构建前端
npm start       # 启动服务器
```

浏览器打开 `http://localhost:3000`。

## MCP配置

### Claude Code（stdio）

在MCP配置里加：

```json
{
  "mcpServers": {
    "coread": {
      "command": "node",
      "args": ["/你的路径/coread/mcp-stdio.mjs"]
    }
  }
}
```

### claude.ai / 远程MCP（SSE + Streamable HTTP）

```bash
npm run mcp:sse   # 启动SSE/HTTP MCP服务器（默认端口3001）
```

SSE端点：`http://你的服务器:3001/sse`
Streamable HTTP端点：`http://你的服务器:3001/mcp`

环境变量 `COREAD_MCP_PORT` 可以改端口。

在claude.ai设置里添加为远程MCP服务器即可。支持SSE和Streamable HTTP两种传输模式。

### 其他MCP客户端

任何支持MCP的客户端都能用——不限于Claude。GPT、DeepSeek、Gemini，支持MCP的都行。三种传输模式可选：stdio、SSE、Streamable HTTP。

## MCP工具列表

| 工具 | 说明 |
|------|------|
| `list_books` | 列出书架上所有的书 |
| `read_book` | 读某一页（统一坐标制，页码与前端一致） |
| `add_comment` | 在某段写批注 |
| `list_comments` | 列出一本书的所有批注 |
| `get_toc` | 获取目录 |
| `import_book` | 导入文本或epub |
| `delete_comment` | 删除批注 |
| `update_progress` | 更新阅读进度 |

## 配置项

环境变量：

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `COREAD_PORT` | `3000` | Web服务器端口 |
| `COREAD_MCP_PORT` | `3001` | MCP SSE/HTTP服务器端口 |
| `COREAD_DB` | `./data/coread.db` | 数据库路径 |
| `COREAD_NOTIFY_CMD` | 空（关闭） | 有人评论时执行的shell命令，见下方「评论通知」 |
| `COREAD_NOTIFY_FROM` | `human` | 触发通知的评论者名字，`*` 表示所有人 |

## 评论通知（把批注实时推给你的AI）

人类在共读室划句子写批注时，AI那边默认是不知道的（MCP是拉模式，AI要主动翻书才看得到）。设置 `COREAD_NOTIFY_CMD` 后，每条新评论都会触发你配置的命令，评论内容通过环境变量传入：

| 环境变量 | 内容 |
|----------|------|
| `COREAD_BOOK_ID` | 书的ID |
| `COREAD_BOOK_TITLE` | 书名 |
| `COREAD_FROM` | 评论者 |
| `COREAD_COMMENT` | 评论内容 |

命令是任意的，所以通知去哪都行——两个现成示例在 `examples/`：

**tmux注入**（AI跑在tmux里的Claude Code等agent，评论直接变成一条发给AI的消息）：

```bash
COREAD_NOTIFY_CMD="./examples/notify-tmux.sh" \
COREAD_TMUX_SESSION="main" \
node server.mjs
```

**webhook**（POST JSON到任意HTTP端点，接bot桥、ntfy、Slack/Discord适配器都行）：

```bash
COREAD_NOTIFY_CMD="./examples/notify-webhook.sh" \
COREAD_WEBHOOK_URL="https://example.com/hook" \
node server.mjs
```

默认只有 `human` 的评论触发（AI自己批注不会给自己发通知）；自定义过名字的把 `COREAD_NOTIFY_FROM` 设成对应名字即可。

## 开发

```bash
npm run dev     # Vite开发服务器（API代理到localhost:3000）
npm start       # 生产模式（提供构建好的前端）
```

## 项目结构

```
server.mjs        — HTTP服务器：API + 静态文件
mcp-stdio.mjs     — MCP服务器（stdio传输）
mcp-sse.mjs       — MCP服务器（SSE + Streamable HTTP传输）
lib/
  db.mjs           — SQLite数据库初始化
  epub.mjs         — Epub解析器（章节、图片、封面）
  routes.mjs       — 书籍API路由 + 统一坐标制分页算法
  mcp-tools.mjs    — MCP工具定义与处理
web/
  StudyApp.tsx     — React前端（块测量分页阅读器 + 批注 + IndexedDB缓存）
  api.ts           — API客户端
  app.tsx          — 入口
public/            — 构建产物（vite build生成，已提交方便直接部署）
data/              — SQLite数据库 + 书籍图片（gitignore，不入库）
test/              — SQLite/HTTP 持久化回归测试
```

### Morrow 承载

Coread 仍是独立的 Node 服务和数据库。默认监听 `3000`；Morrow 的
`/coread/` 页面会通过同源代理承载它。需要自定义地址时，在 Morrow
服务环境中设置 `MORROW_COREAD_URL`，并确保该地址运行的是本仓库的
Coread 服务。构建使用相对资源路径，因此直接打开 Coread 和嵌入 Morrow
都使用同一份产物。

---

<a name="english"></a>

## English

A co-reading room where AI and humans read books together, leaving annotations side by side.

Import an epub, read it in a paginated web reader, highlight passages, write comments — and your AI companion does the same through MCP tools. Both voices live in the margins of the same book.

Features: unified server-side pagination (AI and human see the same page numbers), block-measured page breaks with chapter boundaries, IndexedDB caching for instant page turns, floating TOC window, shared annotations with page-jump links, epub/markdown export, pluggable comment notifications, and MCP tools over stdio/SSE/Streamable HTTP.

### Quick Start

```bash
git clone https://github.com/meowmana/coread.git
cd coread
npm install
npm run build
npm start
```

Open `http://localhost:3000` in your browser.

### MCP Setup

**Claude Code (stdio):**

```json
{
  "mcpServers": {
    "coread": {
      "command": "node",
      "args": ["/path/to/coread/mcp-stdio.mjs"]
    }
  }
}
```

**claude.ai / Remote MCP (SSE + Streamable HTTP):**

```bash
npm run mcp:sse   # Starts SSE/HTTP MCP server on port 3001
```

- SSE endpoint: `http://your-server:3001/sse`
- Streamable HTTP endpoint: `http://your-server:3001/mcp`

Works with any MCP-compatible client — not limited to Claude. Three transport modes: stdio, SSE, Streamable HTTP.

### Comment Notifications (push human comments to your AI)

By default the AI only sees comments when it opens the book (MCP is pull-based). Set `COREAD_NOTIFY_CMD` to run any shell command whenever someone comments — details arrive via env vars (`COREAD_BOOK_ID`, `COREAD_BOOK_TITLE`, `COREAD_FROM`, `COREAD_COMMENT`). Two ready-made examples in `examples/`:

```bash
# Inject into a tmux session running your AI agent (e.g. Claude Code):
COREAD_NOTIFY_CMD="./examples/notify-tmux.sh" COREAD_TMUX_SESSION="main" node server.mjs

# Or POST to any webhook:
COREAD_NOTIFY_CMD="./examples/notify-webhook.sh" COREAD_WEBHOOK_URL="https://example.com/hook" node server.mjs
```

`COREAD_NOTIFY_FROM` filters who triggers it (default `human`, `*` for everyone).

## License

MIT
