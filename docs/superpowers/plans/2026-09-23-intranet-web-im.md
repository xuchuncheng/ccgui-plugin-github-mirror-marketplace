# 内网网页版 IM 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 搭建一个内网自建、浏览器直接访问的轻量即时通讯应用,支持昵称直进、实时私聊/群聊、图片发送。

**Architecture:** 单进程 Node.js 应用:Express 托管前端静态页与上传接口,Socket.IO 负责实时消息,better-sqlite3 嵌入式存储消息与用户。前端为零构建的原生 HTML/CSS/JS 单页。所有数据落在项目目录内(`im.db` + `uploads/`)。

**Tech Stack:** Node.js 18+(内置 `node:test` 测试运行器)、Express 4、Socket.IO 4、better-sqlite3、multer。

**Spec:** `docs/superpowers/specs/2026-09-23-intranet-web-im-design.md`

## Global Constraints

- 运行时 Node.js 18+(需支持 ESM `import` 与内置 `node --test`)。
- 数据库固定用 better-sqlite3(嵌入式,禁止引入独立数据库服务)。
- 前端零构建:不引入 Vite/Webpack/npm build 步骤,`public/` 下文件由 Express 直接静态托管。
- 身份为昵称直进,无密码、无鉴权中间件。
- 单张图片上传上限 5MB。
- 端口默认 3000,可用环境变量 `PORT` 覆盖。
- 每个后端单元都可测:模块导出纯工厂函数,测试用内存库(`:memory:`)与临时目录,互不污染。

---

## 文件结构

```
CCgui/im/
├── package.json          # 依赖 + "test": "node --test test/"
├── .gitignore            # node_modules / im.db / uploads
├── src/
│   ├── db.js             # SQLite 初始化 + 数据访问(createUser/findOrCreateUser/listUsers/createChat/addMember/getChat/listChatsForUser/insertMessage/listMessages)
│   ├── http.js           # Express app 工厂(createApp):静态托管 + /api/login + /api/upload
│   ├── socket.js         # Socket.IO 逻辑(registerSocket):注册/在线/发消息/建私聊
│   └── server.js         # 组装 createServer + createApp + registerSocket,启动入口
├── public/
│   ├── index.html        # 单页骨架(登录浮层 + 侧栏 + 聊天区)
│   ├── style.css         # 样式
│   └── app.js            # 前端逻辑(连接、渲染、收发、传图)
├── test/
│   ├── helpers.js        # makeServer():临时目录 + 内存/文件库 + 随机端口,供 http/socket 测试复用
│   ├── db.test.js        # 数据层单测
│   ├── http.test.js      # 登录 + 上传接口测试
│   └── socket.test.js    # 实时收发端到端测试
└── README.md             # 三步部署说明
```

---

## Task 1: 项目脚手架 + 数据访问层(db.js)

**Files:**
- Create: `im/package.json`
- Create: `im/.gitignore`
- Create: `im/src/db.js`
- Create: `im/test/db.test.js`

**Interfaces:**
- Consumes: 无(首个任务)
- Produces:
  - `createDb(file=':memory:') -> Database` —— 打开库并建表、建默认群
  - `createUser(db, nickname) -> {id, nickname, last_seen}`
  - `getUserByName(db, nickname) -> user | undefined`
  - `getUserById(db, id) -> user | undefined`
  - `findOrCreateUser(db, nickname) -> user`
  - `touchUser(db, id, ts) -> void`
  - `listUsers(db) -> user[]`
  - `createChat(db, {type, name=''}) -> chat{id,type,name}`
  - `getChat(db, id) -> chat | undefined`
  - `addMember(db, chatId, userId) -> void`
  - `isMember(db, chatId, userId) -> boolean`
  - `listMembers(db, chatId) -> user[]`
  - `listChatsForUser(db, userId) -> chat[]`
  - `insertMessage(db, {chat_id, sender_id, content, msg_type='text', ts=Date.now()}) -> message`
  - `listMessages(db, chatId, after=0) -> message[]`(按 ts 升序)
  - 常量 `DEFAULT_GROUP_NAME = '吹水群'`

- [ ] **Step 1: 初始化 git 仓库并创建 package.json**

在 `D:\work_space\B-工作空间\CCgui` 下执行(当前目录尚无 git):

```bash
cd "D:/work_space/B-工作空间/CCgui" && git init && mkdir -p im/src im/public im/test
```

创建 `im/package.json`:

```json
{
  "name": "intranet-im",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "start": "node src/server.js",
    "test": "node --test test/"
  },
  "dependencies": {
    "better-sqlite3": "^11.3.0",
    "express": "^4.19.2",
    "multer": "^1.4.5-lts.1",
    "socket.io": "^4.7.5"
  },
  "devDependencies": {
    "socket.io-client": "^4.7.5",
    "supertest": "^7.0.0"
  }
}
```

创建 `im/.gitignore`:

```
node_modules/
im.db
im.db-shm
im.db-wal
uploads/
*.log
```

- [ ] **Step 2: 安装依赖**

Run: `cd "D:/work_space/B-工作空间/CCgui/im" && npm install`
Expected: 生成 `node_modules/`,`better-sqlite3` 预编译包安装成功(无报错)。若报原生编译错误,记录并停止 —— 需换纯 JS 方案(见风险)。

- [ ] **Step 3: 写失败的测试(test/db.test.js)**

创建 `im/test/db.test.js`:

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createDb, createUser, getUserByName, findOrCreateUser,
  createChat, addMember, isMember, listChatsForUser,
  insertMessage, listMessages, DEFAULT_GROUP_NAME,
} from '../src/db.js';

test('createDb 建表并自动创建默认群', () => {
  const db = createDb(':memory:');
  const row = db.prepare("SELECT name FROM chats WHERE type='group'").get();
  assert.equal(row.name, DEFAULT_GROUP_NAME);
});

test('createUser 写入昵称并可查回', () => {
  const db = createDb(':memory:');
  const u = createUser(db, '阿强');
  assert.ok(u.id > 0);
  assert.equal(getUserByName(db, '阿强').nickname, '阿强');
});

test('昵称唯一,重复创建抛错', () => {
  const db = createDb(':memory:');
  createUser(db, '小明');
  assert.throws(() => createUser(db, '小明'));
});

test('findOrCreateUser 幂等', () => {
  const db = createDb(':memory:');
  const a = findOrCreateUser(db, '老王');
  const b = findOrCreateUser(db, '老王');
  assert.equal(a.id, b.id);
});

test('群成员关系与按用户列群', () => {
  const db = createDb(':memory:');
  const u = createUser(db, '张三');
  const c = createChat(db, { type: 'group', name: '测试群' });
  addMember(db, c.id, u.id);
  assert.equal(isMember(db, c.id, u.id), true);
  assert.equal(isMember(db, c.id, 999), false);
  assert.ok(listChatsForUser(db, u.id).some((x) => x.id === c.id));
});

test('insertMessage + listMessages 按时间升序、支持 after', () => {
  const db = createDb(':memory:');
  const u = createUser(db, '李四');
  const c = createChat(db, { type: 'dm' });
  insertMessage(db, { chat_id: c.id, sender_id: u.id, content: '第一条', ts: 100 });
  insertMessage(db, { chat_id: c.id, sender_id: u.id, content: '第二条', ts: 200 });
  const all = listMessages(db, c.id);
  assert.deepEqual(all.map((m) => m.content), ['第一条', '第二条']);
  const after = listMessages(db, c.id, 150);
  assert.deepEqual(after.map((m) => m.content), ['第二条']);
});
```

- [ ] **Step 4: 运行测试确认失败**

Run: `cd "D:/work_space/B-工作空间/CCgui/im" && node --test test/db.test.js`
Expected: FAIL —— `Cannot find module '../src/db.js'` 或导出项 undefined。

- [ ] **Step 5: 写最小实现(src/db.js)**

创建 `im/src/db.js`:

```javascript
import Database from 'better-sqlite3';

export const DEFAULT_GROUP_NAME = '吹水群';

export function createDb(file = ':memory:') {
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nickname TEXT UNIQUE NOT NULL,
      last_seen INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS chats (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL CHECK (type IN ('dm','group')),
      name TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS chat_members (
      chat_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      PRIMARY KEY (chat_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id INTEGER NOT NULL,
      sender_id INTEGER NOT NULL,
      content TEXT NOT NULL,
      msg_type TEXT NOT NULL DEFAULT 'text',
      ts INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_msg_chat_ts ON messages(chat_id, ts);
  `);
  const g = db.prepare("SELECT id FROM chats WHERE type='group' LIMIT 1").get();
  if (!g) db.prepare("INSERT INTO chats(type,name) VALUES('group',?)").run(DEFAULT_GROUP_NAME);
  return db;
}

export function createUser(db, nickname) {
  const info = db.prepare('INSERT INTO users(nickname,last_seen) VALUES(?,?)')
    .run(nickname, Date.now());
  return getUserById(db, info.lastInsertRowid);
}

export function getUserByName(db, nickname) {
  return db.prepare('SELECT * FROM users WHERE nickname=?').get(nickname);
}

export function getUserById(db, id) {
  return db.prepare('SELECT * FROM users WHERE id=?').get(id);
}

export function findOrCreateUser(db, nickname) {
  return getUserByName(db, nickname) || createUser(db, nickname);
}

export function touchUser(db, id, ts = Date.now()) {
  db.prepare('UPDATE users SET last_seen=? WHERE id=?').run(ts, id);
}

export function listUsers(db) {
  return db.prepare('SELECT * FROM users ORDER BY id').all();
}

export function createChat(db, { type, name = '' }) {
  const info = db.prepare('INSERT INTO chats(type,name) VALUES(?,?)').run(type, name);
  return getChat(db, info.lastInsertRowid);
}

export function getChat(db, id) {
  return db.prepare('SELECT * FROM chats WHERE id=?').get(id);
}

export function addMember(db, chatId, userId) {
  db.prepare('INSERT OR IGNORE INTO chat_members(chat_id,user_id) VALUES(?,?)')
    .run(chatId, userId);
}

export function isMember(db, chatId, userId) {
  return !!db.prepare('SELECT 1 FROM chat_members WHERE chat_id=? AND user_id=?')
    .get(chatId, userId);
}

export function listMembers(db, chatId) {
  return db.prepare(`SELECT u.* FROM users u JOIN chat_members m ON u.id=m.user_id
    WHERE m.chat_id=? ORDER BY u.id`).all(chatId);
}

export function listChatsForUser(db, userId) {
  return db.prepare(`SELECT c.* FROM chats c JOIN chat_members m ON c.id=m.chat_id
    WHERE m.user_id=? ORDER BY c.id`).all(userId);
}

export function insertMessage(db, { chat_id, sender_id, content, msg_type = 'text', ts = Date.now() }) {
  const info = db.prepare(
    'INSERT INTO messages(chat_id,sender_id,content,msg_type,ts) VALUES(?,?,?,?,?)')
    .run(chat_id, sender_id, content, msg_type, ts);
  return db.prepare('SELECT * FROM messages WHERE id=?').get(info.lastInsertRowid);
}

export function listMessages(db, chatId, after = 0) {
  return db.prepare('SELECT * FROM messages WHERE chat_id=? AND ts>? ORDER BY ts ASC')
    .all(chatId, after);
}
```

- [ ] **Step 6: 运行测试确认通过**

Run: `cd "D:/work_space/B-工作空间/CCgui/im" && node --test test/db.test.js`
Expected: PASS(6 个测试全绿)。

- [ ] **Step 7: Commit**

```bash
cd "D:/work_space/B-工作空间/CCgui" && git add im && git commit -m "feat(im): 数据访问层 db.js + 脚手架"
```

---

## Task 2: HTTP 层(http.js)—— 静态托管 + 登录 + 图片上传

**Files:**
- Create: `im/src/http.js`
- Create: `im/test/helpers.js`
- Create: `im/test/http.test.js`
- Create: `im/public/index.html`(占位,Task 5 完善)

**Interfaces:**
- Consumes: `db.js` 的 `findOrCreateUser`
- Produces:
  - `createApp({ db, uploadDir }) -> express app`
    - `GET /api/login?name=<昵称>` → 200 `{id, nickname}`;缺 name → 400 `{error}`
    - `POST /api/upload`(multipart 字段 `file`,≤5MB)→ 200 `{url, name}`;超限 → 413 `{error}`
    - 静态托管 `uploadDir` 于 `/uploads`,`public/` 于 `/`

- [ ] **Step 1: 创建测试辅助(test/helpers.js)**

```javascript
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { createDb } from '../src/db.js';

export function tmpDir(prefix = 'im-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// 启动一个真实监听端口的 server,返回 {srv, io, db, dir, url, close}
export async function makeServer() {
  const { createServer } = await import('node:http');
  const { Server } = await import('socket.io');
  const { createApp } = await import('../src/http.js');
  const { registerSocket } = await import('../src/socket.js');
  const dir = tmpDir();
  const db = createDb(':memory:');
  const app = createApp({ db, uploadDir: dir });
  const srv = createServer(app);
  const io = new Server(srv);
  registerSocket(io, db);
  await new Promise((r) => srv.listen(0, r));
  const url = `http://localhost:${srv.address().port}`;
  return { srv, io, db, dir, url, close: () => new Promise((r) => srv.close(r)) };
}
```

> 注:`makeServer` 引用了 Task 3 才实现的 `registerSocket`;本任务的 `http.test.js` 只用 `createApp`(经 supertest),不调用 `makeServer`,故不受影响。

- [ ] **Step 2: 写失败的测试(test/http.test.js)**

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { createDb } from '../src/db.js';
import { createApp } from '../src/http.js';
import { tmpDir } from './helpers.js';

function app() {
  return createApp({ db: createDb(':memory:'), uploadDir: tmpDir() });
}

test('GET /api/login 建档并返回用户', async () => {
  const res = await request(app()).get('/api/login?name=阿强').expect(200);
  assert.equal(res.body.nickname, '阿强');
  assert.ok(res.body.id > 0);
});

test('GET /api/login 缺 name 返回 400', async () => {
  await request(app()).get('/api/login').expect(400);
});

test('POST /api/upload 保存图片并返回可访问 URL', async () => {
  const a = app();
  const res = await request(a)
    .post('/api/upload')
    .attach('file', Buffer.from('fake-image-bytes'), 'pic.png')
    .expect(200);
  assert.match(res.body.url, /^\/uploads\/.+\.png$/);
  await request(a).get(res.body.url).expect(200);
});
```

- [ ] **Step 3: 运行测试确认失败**

Run: `cd "D:/work_space/B-工作空间/CCgui/im" && node --test test/http.test.js`
Expected: FAIL —— `Cannot find module '../src/http.js'`。

- [ ] **Step 4: 写最小实现(src/http.js)**

```javascript
import express from 'express';
import multer from 'multer';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findOrCreateUser } from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MAX_SIZE = 5 * 1024 * 1024;

export function createApp({ db, uploadDir }) {
  const app = express();

  app.get('/api/login', (req, res) => {
    const name = (req.query.name || '').trim();
    if (!name) return res.status(400).json({ error: '请输入昵称' });
    const user = findOrCreateUser(db, name);
    res.json({ id: user.id, nickname: user.nickname });
  });

  const storage = multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, uploadDir),
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase().replace(/[^.a-z0-9]/g, '');
      cb(null, `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${ext}`);
    },
  });
  const upload = multer({ storage, limits: { fileSize: MAX_SIZE } });

  app.post('/api/upload', (req, res) => {
    upload.single('file')(req, res, (err) => {
      if (err) {
        const code = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
        return res.status(code).json({ error: err.message });
      }
      if (!req.file) return res.status(400).json({ error: '未收到文件' });
      res.json({ url: '/uploads/' + req.file.filename, name: req.file.originalname });
    });
  });

  app.use('/uploads', express.static(uploadDir));
  app.use(express.static(path.join(__dirname, '..', 'public')));
  return app;
}
```

- [ ] **Step 5: 创建前端占位(public/index.html)**

```html
<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>内网吹水</title></head>
<body><div id="placeholder">前端将在 Task 5 实现</div></body></html>
```

- [ ] **Step 6: 运行测试确认通过**

Run: `cd "D:/work_space/B-工作空间/CCgui/im" && node --test test/http.test.js`
Expected: PASS(3 个测试全绿)。

- [ ] **Step 7: Commit**

```bash
cd "D:/work_space/B-工作空间/CCgui" && git add im && git commit -m "feat(im): HTTP 层 登录 + 图片上传 + 静态托管"
```

---

## Task 3: Socket.IO 实时层(socket.js + server.js)

**Files:**
- Create: `im/src/socket.js`
- Create: `im/src/server.js`
- Create: `im/test/socket.test.js`

**Interfaces:**
- Consumes: `db.js` 全部函数;`http.js` 的 `createApp`;`helpers.js` 的 `makeServer`
- Produces:
  - `roomOf(chatId) -> 'chat:'+chatId`
  - `registerSocket(io, db) -> void`
  - Socket 事件契约:
    - 入站 `register {name}` → ack `{ok,id,nickname}` / `{ok:false,error}`;成功后 `presence{online:[{id,nickname}]}` 广播全体,`joined{chat,user}` 通知成员
    - 入站 `dm {peerId}` → ack `{ok,chat}`(懒建私聊)
    - 入站 `message {chatId,content,msgType}` → 落库后向房间广播 `message{...}`
    - 入站 `history {chatId,after}` → ack `{ok,messages}`
    - 断线 → 广播 `presence`

- [ ] **Step 1: 写失败的测试(test/socket.test.js)**

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { io as ioc } from 'socket.io-client';
import { makeServer } from './helpers.js';

function connect(url) {
  return ioc(url, { transports: ['websocket'], forceNew: true });
}
function once(sock, ev) {
  return new Promise((r) => sock.once(ev, r));
}

test('注册后可收发消息,并拉取历史', async () => {
  const { url, close } = await makeServer();
  const a = connect(url), b = connect(url);
  const ackA = await new Promise((r) => a.emit('register', { name: '甲' }, r));
  const ackB = await new Promise((r) => b.emit('register', { name: '乙' }, r));
  assert.equal(ackA.ok, true);
  assert.equal(ackB.ok, true);

  const dmA = await new Promise((r) => a.emit('dm', { peerId: ackB.id }, r));
  await new Promise((r) => b.emit('dm', { peerId: ackA.id }, r));
  assert.equal(dmA.ok, true);
  const chatId = dmA.chat.id;

  const got = once(b, 'message');
  a.emit('message', { chatId, content: '你好', msgType: 'text' });
  const msg = await got;
  assert.equal(msg.content, '你好');
  assert.equal(msg.sender_id, ackA.id);

  const hist = await new Promise((r) => b.emit('history', { chatId }, r));
  assert.equal(hist.ok, true);
  assert.equal(hist.messages[0].content, '你好');

  a.close(); b.close(); await close();
});

test('重名注册第二次被拒', async () => {
  const { url, close } = await makeServer();
  const a = connect(url);
  const first = await new Promise((r) => a.emit('register', { name: '独占' }, r));
  const b = connect(url);
  const dup = await new Promise((r) => b.emit('register', { name: '独占' }, r));
  assert.equal(first.ok, true);
  assert.equal(dup.ok, false);
  a.close(); b.close(); await close();
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd "D:/work_space/B-工作空间/CCgui/im" && node --test test/socket.test.js`
Expected: FAIL —— `Cannot find module '../src/socket.js'`。

- [ ] **Step 3: 写实现(src/socket.js)**

```javascript
import {
  findOrCreateUser, getUserByName, getUserById, touchUser,
  createChat, addMember, isMember, listMembers, listChatsForUser,
  insertMessage, listMessages, DEFAULT_GROUP_NAME,
} from './db.js';

export function roomOf(chatId) {
  return 'chat:' + chatId;
}

export function registerSocket(io, db) {
  io.on('connection', (socket) => {
    let uid = null;

    function broadcastPresence() {
      const ids = [...io.sockets.sockets.values()]
        .map((s) => s.data.uid).filter(Boolean);
      const online = ids.map((id) => getUserById(db, id)).filter(Boolean)
        .map((u) => ({ id: u.id, nickname: u.nickname }));
      io.emit('presence', { online });
    }

    function joinChat(chatId) {
      socket.join(roomOf(chatId));
    }

    socket.on('register', (data, ack) => {
      const name = (data?.name || '').trim();
      if (!name) return ack?.({ ok: false, error: '请输入昵称' });
      const existing = getUserByName(db, name);
      if (existing && ![...io.sockets.sockets.values()].some((s) => s.data.uid === existing.id)) {
        uid = existing.id;
      } else if (existing) {
        return ack?.({ ok: false, error: '昵称已被占用' });
      } else {
        uid = findOrCreateUser(db, name).id;
      }
      socket.data.uid = uid;
      touchUser(db, uid);

      const grp = db.prepare("SELECT * FROM chats WHERE type='group' AND name=?").get(DEFAULT_GROUP_NAME);
      if (grp) { addMember(db, grp.id, uid); joinChat(grp.id); }
      for (const c of listChatsForUser(db, uid)) joinChat(c.id);

      ack?.({ ok: true, id: uid, nickname: name });
      io.to(roomOf(grp.id)).emit('joined', { chat: grp.id, user: getUserById(db, uid) });
      broadcastPresence();
    });

    socket.on('dm', (data, ack) => {
      if (!uid) return ack?.({ ok: false, error: '未登录' });
      const peerId = Number(data?.peerId);
      if (!peerId) return ack?.({ ok: false, error: '缺少对象' });
      let chat = null;
      for (const c of listChatsForUser(db, uid)) {
        if (c.type === 'dm' && isMember(db, c.id, peerId)) { chat = c; break; }
      }
      if (!chat) {
        chat = createChat(db, { type: 'dm' });
        addMember(db, chat.id, uid);
        addMember(db, chat.id, peerId);
      }
      joinChat(chat.id);
      socket.to(roomOf(chat.id)).emit('chat-added', { chat, user: getUserById(db, uid) });
      ack?.({ ok: true, chat });
    });

    socket.on('message', (data) => {
      if (!uid) return;
      const chatId = Number(data?.chatId);
      if (!chatId || !isMember(db, chatId, uid)) return;
      const content = String(data?.content ?? '');
      const msgType = data?.msgType === 'image' ? 'image' : 'text';
      if (!content.trim() && msgType !== 'image') return;
      const msg = insertMessage(db, { chat_id: chatId, sender_id: uid, content, msg_type: msgType });
      io.to(roomOf(chatId)).emit('message', msg);
    });

    socket.on('history', (data, ack) => {
      if (!uid) return ack?.({ ok: false, error: '未登录' });
      const chatId = Number(data?.chatId);
      if (!chatId || !isMember(db, chatId, uid)) return ack?.({ ok: false, error: '无权' });
      const after = Number(data?.after) || 0;
      ack?.({ ok: true, messages: listMessages(db, chatId, after) });
    });

    socket.on('disconnect', () => { broadcastPresence(); });
  });
}
```

- [ ] **Step 4: 写启动入口(src/server.js)**

```javascript
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Server } from 'socket.io';
import { createDb } from './db.js';
import { createApp } from './http.js';
import { registerSocket } from './socket.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, '..', 'uploads');

fs.mkdirSync(UPLOAD_DIR, { recursive: true });
const db = createDb(process.env.DB_FILE || path.join(__dirname, '..', 'im.db'));
const app = createApp({ db, uploadDir: UPLOAD_DIR });
const server = http.createServer(app);
const io = new Server(server);
registerSocket(io, db);

server.listen(PORT, () => {
  console.log(`内网 IM 已启动: http://localhost:${PORT}`);
});
```

- [ ] **Step 5: 运行测试确认通过**

Run: `cd "D:/work_space/B-工作空间/CCgui/im" && node --test test/socket.test.js`
Expected: PASS(2 个测试全绿)。

- [ ] **Step 6: 冒烟启动确认服务可拉起**

Run: `cd "D:/work_space/B-工作空间/CCgui/im" && node src/server.js` (后台或另开终端),看到 `内网 IM 已启动: http://localhost:3000` 后 Ctrl+C 停止。
Expected: 正常打印启动日志,无异常堆栈。

- [ ] **Step 7: Commit**

```bash
cd "D:/work_space/B-工作空间/CCgui" && git add im && git commit -m "feat(im): Socket.IO 实时收发 + 启动入口"
```

---

## Task 4: 前端单页(index.html + style.css + app.js)

**Files:**
- Modify: `im/public/index.html`(替换占位)
- Create: `im/public/style.css`
- Create: `im/public/app.js`

**Interfaces:**
- Consumes: HTTP `/api/login`、`/api/upload`;Socket 事件契约(Task 3)
- Produces: 可在浏览器直接使用的完整界面(登录浮层、在线列表、会话切换、消息区、输入框、发图)

> 本任务为前端,无自动化测试;以浏览器手动验收为准(Step 6)。

- [ ] **Step 1: 写页面骨架(public/index.html)**

```html
<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>内网吹水</title>
  <link rel="stylesheet" href="/style.css" />
</head>
<body>
  <div id="login" class="overlay">
    <div class="card">
      <h1>内网吹水</h1>
      <input id="nick" placeholder="输入昵称" maxlength="20" />
      <button id="enter">进入</button>
      <p id="loginErr" class="err"></p>
    </div>
  </div>
  <div id="app" class="hidden">
    <aside id="sidebar">
      <div id="me"></div>
      <h3>在线同事</h3>
      <ul id="people"></ul>
      <h3>会话</h3>
      <ul id="chats"></ul>
    </aside>
    <main id="main">
      <header id="chatTitle">选择一个会话</header>
      <div id="msgs"></div>
      <div id="composer">
        <input id="file" type="file" accept="image/*" class="hidden" />
        <button id="imgBtn" title="发图片">🖼️</button>
        <input id="input" placeholder="说点什么…" autocomplete="off" />
        <button id="send">发送</button>
      </div>
    </main>
  </div>
  <script src="/socket.io/socket.io.js"></script>
  <script type="module" src="/app.js"></script>
</body>
</html>
```

- [ ] **Step 2: 写样式(public/style.css)**

```css
* { box-sizing: border-box; }
body { margin: 0; font: 14px/1.5 system-ui, "Microsoft YaHei", sans-serif; color: #222; }
.hidden { display: none !important; }
.overlay { position: fixed; inset: 0; background: #4a6fa5; display: flex; align-items: center; justify-content: center; }
.card { background: #fff; padding: 32px 40px; border-radius: 12px; width: 320px; text-align: center; box-shadow: 0 8px 30px rgba(0,0,0,.2); }
.card h1 { margin: 0 0 20px; font-size: 22px; }
.card input { width: 100%; padding: 10px; border: 1px solid #ccc; border-radius: 6px; }
.card button { width: 100%; margin-top: 12px; padding: 10px; border: 0; border-radius: 6px; background: #4a6fa5; color: #fff; cursor: pointer; }
.err { color: #c0392b; min-height: 18px; margin: 8px 0 0; }
#app { display: flex; height: 100vh; }
#sidebar { width: 240px; border-right: 1px solid #ddd; padding: 12px; overflow-y: auto; background: #f7f8fa; }
#me { font-weight: 600; margin-bottom: 8px; }
#sidebar h3 { font-size: 12px; color: #888; margin: 14px 0 6px; }
#sidebar ul { list-style: none; margin: 0; padding: 0; }
#sidebar li { padding: 6px 8px; border-radius: 6px; cursor: pointer; }
#sidebar li:hover { background: #e8ecf3; }
#sidebar li.active { background: #4a6fa5; color: #fff; }
#main { flex: 1; display: flex; flex-direction: column; }
#chatTitle { padding: 12px 16px; border-bottom: 1px solid #ddd; font-weight: 600; }
#msgs { flex: 1; overflow-y: auto; padding: 16px; }
.msg { margin-bottom: 10px; }
.msg .who { font-size: 12px; color: #888; }
.msg .bubble { display: inline-block; max-width: 70%; padding: 8px 12px; border-radius: 10px; background: #eef1f6; word-break: break-word; }
.msg.mine { text-align: right; }
.msg.mine .bubble { background: #4a6fa5; color: #fff; }
.msg img { max-width: 260px; border-radius: 8px; display: block; }
#composer { display: flex; gap: 8px; padding: 10px; border-top: 1px solid #ddd; }
#composer input#input { flex: 1; padding: 10px; border: 1px solid #ccc; border-radius: 6px; }
#composer button { padding: 0 14px; border: 0; border-radius: 6px; background: #4a6fa5; color: #fff; cursor: pointer; }
```

- [ ] **Step 3: 写逻辑(public/app.js)**

```javascript
const $ = (id) => document.getElementById(id);
let socket = null;
let me = null;
const chats = new Map();
let current = null;

$('enter').onclick = login;
$('nick').addEventListener('keydown', (e) => { if (e.key === 'Enter') login(); });

async function login() {
  const name = $('nick').value.trim();
  if (!name) return;
  const r = await fetch('/api/login?name=' + encodeURIComponent(name));
  if (!r.ok) { $('loginErr').textContent = (await r.json()).error || '登录失败'; return; }
  me = await r.json();
  $('login').classList.add('hidden');
  $('app').classList.remove('hidden');
  $('me').textContent = '我:' + me.nickname;
  connect();
}

function connect() {
  socket = io();
  socket.on('connect', () => socket.emit('register', { name: me.nickname }, (res) => {
    if (!res.ok) { alert('昵称被占用:' + res.error); location.reload(); return; }
  }));
  socket.on('presence', renderPeople);
  socket.on('message', onMessage);
  // 服务端 register 后会向默认群房间广播 joined,自己也在房间内 → 首屏即出现默认群
  socket.on('joined', (d) => { addChat(d.chat); if (!current) openChat(d.chat.id); });
  socket.on('chat-added', (d) => { addChat(d.chat); });
  socket.on('disconnect', () => $('chatTitle').textContent = '连接断开,重连中…');
}

function addChat(chat) {
  if (chat && !chats.has(chat.id)) { chats.set(chat.id, { ...chat, unread: 0 }); renderChats(); }
}

function renderPeople(p) {
  const ul = $('people'); ul.innerHTML = '';
  for (const u of p.online) {
    if (me && u.id === me.id) continue;
    const li = document.createElement('li');
    li.textContent = u.nickname;
    li.onclick = () => socket.emit('dm', { peerId: u.id }, (res) => {
      if (res.ok) { addChat(res.chat); openChat(res.chat.id); }
    });
    ul.appendChild(li);
  }
}

function renderChats() {
  const ul = $('chats'); ul.innerHTML = '';
  for (const c of chats.values()) {
    const li = document.createElement('li');
    li.textContent = (c.name || '私聊') + (c.unread ? ` (${c.unread})` : '');
    li.className = current === c.id ? 'active' : '';
    li.onclick = () => openChat(c.id);
    ul.appendChild(li);
  }
}

function openChat(id) {
  current = id;
  const c = chats.get(id);
  if (c) c.unread = 0;
  $('chatTitle').textContent = c ? (c.name || '私聊') : '';
  $('msgs').innerHTML = '';
  socket.emit('history', { chatId: id }, (res) => {
    if (res.ok) { res.messages.forEach(addBubble); renderChats(); }
  });
}

function onMessage(m) {
  addChat({ id: m.chat_id, type: 'dm', name: '' });
  if (m.chat_id === current) { addBubble(m); }
  else { const c = chats.get(m.chat_id); if (c) { c.unread++; renderChats(); } }
}

function addBubble(m) {
  const box = $('msgs');
  const div = document.createElement('div');
  div.className = 'msg' + (me && m.sender_id === me.id ? ' mine' : '');
  const who = document.createElement('div'); who.className = 'who';
  who.textContent = (m.sender_id === me?.id) ? '我' : ('#' + m.sender_id);
  const bubble = document.createElement('div'); bubble.className = 'bubble';
  if (m.msg_type === 'image') { const img = document.createElement('img'); img.src = m.content; bubble.appendChild(img); }
  else bubble.textContent = m.content;
  div.append(who, bubble);
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
}

$('send').onclick = sendText;
$('input').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendText(); });
function sendText() {
  const v = $('input').value.trim();
  if (!v || !current) return;
  socket.emit('message', { chatId: current, content: v, msgType: 'text' });
  $('input').value = '';
}

$('imgBtn').onclick = () => $('file').click();
$('file').onchange = async (e) => {
  const f = e.target.files[0]; if (!f || !current) return;
  const fd = new FormData(); fd.append('file', f);
  const r = await fetch('/api/upload', { method: 'POST', body: fd });
  if (!r.ok) { alert('图片过大或上传失败'); return; }
  const { url } = await r.json();
  socket.emit('message', { chatId: current, content: url, msgType: 'image' });
  e.target.value = '';
};
```

> 说明:默认群在服务端 `register` 后向房间广播 `joined`,客户端在同一连接上收到即把默认群加入侧栏并默认打开,首屏开箱可用。

- [ ] **Step 4: 语法自检(前端)**

Run: `cd "D:/work_space/B-工作空间/CCgui/im" && node --check public/app.js`
Expected: 无输出(语法正确)。

- [ ] **Step 5: 运行全部后端测试确认未回归**

Run: `cd "D:/work_space/B-工作空间/CCgui/im" && npm test`
Expected: PASS(db + http + socket 全部测试绿)。

- [ ] **Step 6: 浏览器手动验收**

1. 启动 `node src/server.js`,浏览器开 `http://localhost:3000`,另开一个隐身窗口开同一地址。
2. 两窗口分别输入不同昵称进入。
3. 验收清单:
   - [ ] 双方能看到默认"吹水群"并可发言,另一窗口实时收到
   - [ ] 点击在线同事头像区某人名 → 建立私聊,互发消息实时可见
   - [ ] 发一张图片 → 两窗口都能显示
   - [ ] 关掉一个窗口(模拟离线)→ 另一窗口发消息 → 重新打开离线窗口 → 拉取到离线期间的历史消息
   - [ ] 拔网线/停服再恢复 → 客户端自动重连
Expected: 以上全部通过。若默认群首屏不出现,按 Step 3 说明补 `joined` 处理后再验。

- [ ] **Step 7: Commit**

```bash
cd "D:/work_space/B-工作空间/CCgui" && git add im && git commit -m "feat(im): 前端单页 登录/在线列表/私聊群聊/发图"
```

---

## Task 5: 部署文档与最终验证

**Files:**
- Create: `im/README.md`

**Interfaces:**
- Consumes: 全部已完成代码
- Produces: 面向同事的三步部署与使用说明

- [ ] **Step 1: 写 README.md**

```markdown
# 内网吹水 IM

浏览器直接访问的内网即时通讯,零客户端、零独立数据库。

## 部署(3 步)

1. 装 Node.js 18+(内网机器任选一台,你自己的电脑也行)。
2. 在本目录执行 `npm install`。
3. 启动:`npm start`(默认端口 3000,可用 `PORT=8080 npm start` 改端口)。

看到 `内网 IM 已启动: http://localhost:3000` 即成功。

## 使用

- 本机:`http://localhost:3000`
- 同事:`http://<这台机器的内网IP>:3000`(IP 用 `ipconfig` 查)
- 打开网页输入昵称即可聊天、发图片。

## 数据

全部数据在本目录的 `im.db`(消息/用户)和 `uploads/`(图片)。
备份 = 停服后拷贝这两个;迁移 = 换机器后同样拷贝。

## 运维(可选)

保持后台常驻:`npm i -g pm2 && pm2 start src/server.js --name im`
开机自启、崩溃自动重启由 pm2 负责。

## 开发

- 跑测试:`npm test`
- 防火墙需放行所用端口(Windows 入站规则)。
```

- [ ] **Step 2: 全量测试最终确认**

Run: `cd "D:/work_space/B-工作空间/CCgui/im" && npm test`
Expected: PASS(全部测试绿)。

- [ ] **Step 3: 冒烟启动最终确认**

Run: `cd "D:/work_space/B-工作空间/CCgui/im" && node src/server.js`
Expected: 打印启动日志;浏览器打开首页显示登录浮层。Ctrl+C 停止。

- [ ] **Step 4: Commit**

```bash
cd "D:/work_space/B-工作空间/CCgui" && git add im && git commit -m "docs(im): 三步部署与使用说明"
```

---

## 风险与回退

- **better-sqlite3 原生模块装不上**(Win 无编译链且预编译包缺失):回退方案是改用纯 JS 存储(如 `lowdb` 或直接 JSON 文件),数据层接口(`db.js` 导出的函数签名)保持不变,上层无感。触发条件:Task 1 Step 2 `npm install` 报错。
- **默认群首屏不显示**:属前端事件时序问题,已在 Task 4 Step 3 预留处理路径,不阻塞核心收发功能。
- **内网 IP 不通/防火墙拦截**:属部署环境问题,README 已提示放行端口;非代码缺陷。
