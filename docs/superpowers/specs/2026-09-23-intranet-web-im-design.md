# 内网网页版即时通讯(IM)设计文档

- 日期:2026-09-23
- 状态:待评审
- 目标读者:项目发起人(内网吹水自用)

## 1. 背景与目标

公司 PC 禁装即时通讯客户端,需要一个**内网自建、浏览器直接访问**的轻量 IM,供同事上班沟通吹水。

核心诉求:
- 部署越轻越好 —— 最好一台内网机器、一条命令跑起来,零独立数据库服务。
- 功能够用即可 —— 实时聊天 + 发图片,不做企业级 IM 的那一套。
- 维护成本极低 —— 非专职运维,改完刷新就能用。

**非目标(YAGNI,本期不做)**:音视频、消息撤回、已读回执、消息搜索、多端同步、端到端加密、权限体系、群管理界面。这些等基础跑稳了再按需升级。

## 2. 整体架构

单进程模型:一台内网机器跑一个 Node.js 进程,同时承担三件事 ——
1. **静态文件服务器**:托管前端 `index.html` 及资源。
2. **Socket.IO 服务**:WebSocket 实时收发聊天消息。
3. **嵌入式数据层**:SQLite 存消息/用户,`uploads/` 目录存图片文件。

同事在浏览器打开 `http://<内网机器IP>:<端口>` 即可使用,无需安装任何东西。

```
┌─────────────┐   HTTP(打开页面/传图)   ┌──────────────────────────┐
│  浏览器 A    │ ───────────────────────> │                          │
│  浏览器 B    │                          │   Node.js 单进程          │
│  浏览器 C    │   WebSocket(实时消息)    │   Express + Socket.IO     │
│            │ <══════════════════════> │   + better-sqlite3       │
└─────────────┘                          │                          │
                                         │   im.db    uploads/      │
                                         └──────────────────────────┘
                                          (全部数据 = 这一个目录)
```

## 3. 技术选型

| 层 | 选择 | 理由 |
|---|---|---|
| 运行时 | Node.js + Express | 生态成熟,Socket.IO 官方搭配 |
| 实时通信 | Socket.IO | 自带断线重连、房间(room)机制,天然适配群聊/私聊 |
| 数据库 | better-sqlite3 | 嵌入式,零独立部署;同步 API 简单,单进程无并发写问题 |
| 前端 | 原生 HTML/CSS/JS 单页 | **零构建**,改完刷新即生效,符合"轻量自用"定位 |
| 前端 Socket 库 | socket.io-client(CDN 引入) | 免打包 |

**关于 SQLite 的部署**:SQLite 是一个文件(`im.db`),不是数据库服务进程。随 `npm install better-sqlite3` 自动装好,首次运行自动建库建表。整套部署量 = 装 Node.js → `npm install` → `node server.js`。备份 = 拷贝整个项目目录。

**关于前端选型的取舍**:曾考虑 Vue 3 + Vite,因引入构建环节、增加维护复杂度而放弃。若后续 UI 变复杂,可平滑迁移到 Vue,不影响后端与协议。

## 4. 身份与登录

采用**昵称直进**:打开页面输入昵称即进入,无密码、无账号表外键约束。

- 昵称即身份标识,连接时校验唯一性,重名则提示换一个。
- 内网环境、熟人场景,不做鉴权(威胁模型:同事之间互信)。
- 会话状态由 Socket 连接维持,断线重连用同一昵称恢复。

## 5. 数据模型

四张表,极简。

**users**
| 字段 | 类型 | 说明 |
|---|---|---|
| id | INTEGER PK | 自增 |
| nickname | TEXT UNIQUE | 昵称,兼作登录标识 |
| last_seen | INTEGER | 最近在线时间戳 |

**chats**
| 字段 | 类型 | 说明 |
|---|---|---|
| id | INTEGER PK | 自增 |
| type | TEXT | `dm`(私聊)/ `group`(群聊) |
| name | TEXT | 群名;私聊为空 |

**chat_members** —— chats 与 users 的多对多
| 字段 | 类型 | 说明 |
|---|---|---|
| chat_id | INTEGER | FK → chats.id |
| user_id | INTEGER | FK → users.id |

**messages**
| 字段 | 类型 | 说明 |
|---|---|---|
| id | INTEGER PK | 自增 |
| chat_id | INTEGER | FK → chats.id |
| sender_id | INTEGER | FK → users.id |
| content | TEXT | 文本内容;图片消息存图片 URL |
| msg_type | TEXT | `text` / `image` |
| ts | INTEGER | 发送时间戳 |

**默认群**:首次启动自动创建一个全员群("吹水群"),所有在线用户自动加入,保证开箱即用。私聊在两人之间懒创建(首次发消息时建 dm chat)。

## 6. 核心流程

**上线**
1. 输入昵称 → 校验唯一 → 写入/更新 users → 建立 Socket,`join` 默认群 room。
2. 服务端向在线用户广播"某某上线",更新在线列表。

**收发消息**
1. 发送方 `emit('message', {chatId, content, msgType})`。
2. 服务端写入 messages,`io.to(room).emit` 推给该 chat 全体成员。
3. 接收方在线则即时渲染;离线则下次上线拉历史补齐。

**离线补拉**
1. 客户端上线后,对每个已知 chat 调 HTTP `GET /api/chats/:id/messages?after=<lastSeenTs>` 拉增量。

**发图片**
1. 前端选图 → `POST /api/upload`(multipart,限单张 ≤ 5MB)→ 存入 `uploads/`,返回 URL。
2. 以 `msgType=image, content=<URL>` 走上面的消息流程。
3. 接收方 `<img src=URL>` 显示。

## 7. 错误处理与边界

| 场景 | 处理 |
|---|---|
| WebSocket 断线 | Socket.IO 自动重连;重连成功后触发离线补拉 |
| 昵称冲突 | 连接时校验,占用则拒绝并要求改名 |
| 并发写库 | 单进程 + better-sqlite3 同步 API,天然串行,无锁竞争 |
| 图片超限 | 前端拦截 + 服务端二次校验,>5MB 拒绝 |
| 磁盘写满 | 上传失败返回错误码,前端提示;不做配额(内网自用) |
| 消息乱序 | 以服务端 ts 为准排序 |

## 8. 测试策略

- **后端接口测试**(supertest + socket.io-client):
  - 注册昵称 / 重名拒绝
  - 发消息 → 落库 → 拉历史 一致性
  - 图片上传 → 返回可访问 URL → 大小限制生效
  - 私聊懒建群、群成员可见性
- **前端手动验收**:开两个浏览器标签模拟两人对话、传图、拔网线重连后补消息。

## 9. 部署与运维

1. 内网机器装 Node.js(LTS)。
2. 拷贝项目目录 → `npm install`。
3. `node server.js` 启动;可选 `pm2` 守护保活。
4. 防火墙放行监听端口。
5. 访问地址 `http://<机器IP>:<端口>` 发给同事。
6. 备份:停服 → 拷贝 `im.db` + `uploads/`。

## 10. 交付物

- `server.js` —— Express + Socket.IO + 路由
- `db.js` —— SQLite 初始化与查询封装
- `public/index.html` + `app.js` + `style.css` —— 前端单页
- `package.json` —— 依赖与启动脚本
- `README.md` —— 三步部署说明
