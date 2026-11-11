# 邮箱助手插件（email-assistant）设计文档

- 日期：2026-11-11
- 状态：待评审
- 范围：CCgui Tier-1 JS 插件 + 配套独立 MCP 服务
- 一期目标：QQ 邮箱参数配置（插件设置页）+ 邮件发送 / 接收核心能力（MCP 工具）

## 1. 背景与目标

CCgui 目前没有邮件能力。本项目交付两个协同组件：

1. **CCgui 插件 `ccgui-plugin-email-assistant`**：提供 QQ 邮箱的参数配置界面（地址、授权码、显示名）、连通性测试、MCP 服务一键注册向导。
2. **配套 MCP 服务 `email_mcp`**：Python 零依赖（仅标准库）stdio MCP server，向对话引擎暴露 3 个工具：发信、列最近邮件、取单封邮件。

两个组件通过磁盘上同一份配置文件解耦：插件负责写，MCP 负责读，互不直接调用。MCP 服务可独立分发，不依赖 CCgui 也能被其他 MCP 宿主使用。

### 一期成功标准

- 在插件设置页填好 QQ 邮箱地址与授权码并保存，点「连通性测试」能明确返回成功或认证失败原因。
- 点「一键注册」后，引擎重连即可看到 `email-assistant` MCP 及其 3 个工具。
- 在对话中让 AI：发一封带附件的邮件给自己 → 列出收件箱 → 取回该邮件正文，全链路成功。
- JS 与 Python 两侧自动化测试全绿，真实联网验证留作发布前人工步骤。

## 2. 关键决策（已与用户确认）

| 决策点 | 选择 | 理由 |
|---|---|---|
| MCP 运行时 | Python 3 零依赖标准库，stdio 传输 | 本机已有 Python 3.13；smtplib/imaplib/email 是标准库；与 note-query 插件的 exec:python3 模式一致；离线可用 |
| 功能深度 | 基础收发：send_mail / list_recent_mails / get_mail | 覆盖日常主要场景，搜索、标记、文件夹管理留二期 |
| 凭据存储 | `~/.ccgui-next/plugin-data/email-assistant/profiles.json` 明文 JSON | 插件与 MCP 单一数据源；与 note-query 的 plugin-data 目录约定一致；风险在 README 明示 |
| 认证方式 | QQ 邮箱 IMAP/SMTP 授权码（非账号密码） | QQ 邮箱官方要求 |

## 3. 目录结构

```
ccgui-plugin-email-assistant/
├── manifest.json              # Tier-1 JS 插件声明
├── main.js                    # 零依赖 ESM：设置页 + 配置读写 + 注册向导 + 连通测试
├── styles.css                 # 少量表单样式（宿主主题 token，明暗自适应）
├── README.md                  # 安装、授权码获取指引、安全提示、注册说明
├── LICENSE
├── test/
│   └── core.test.mjs          # node --test，零依赖，不启动宿主
└── mcp/                       # 配套 MCP 服务，可独立分发
    ├── README.md              # 独立 MCP 注册说明（面向非 CCgui 宿主）
    └── email_mcp/
        ├── __init__.py
        ├── __main__.py        # 入口：stdio 主循环 + 工具分发
        ├── protocol.py        # JSON-RPC 2.0 帧读写、MCP 握手、能力声明
        ├── config.py          # profiles.json 读取、QQ 预设、配置校验
        ├── sender.py          # smtplib 发信、MIME 组装
        ├── receiver.py        # imaplib 收信、信封列表、整封解析
        ├── selftest.py        # 连通性测试（SMTP noop / IMAP login）
        └── tests/
            ├── __init__.py
            ├── test_protocol.py
            ├── test_sender.py
            └── test_receiver.py
```

## 4. 插件侧设计

### 4.1 manifest

```json
{
  "id": "email-assistant",
  "name": "邮箱助手",
  "version": "0.1.0",
  "tier": "js",
  "sdkVersion": "^0.3",
  "minAppVersion": "1.1.1",
  "author": "IM Builder",
  "license": "MIT",
  "permissions": [
    "ui:settings-section",
    "storage",
    "exec:python3",
    "theme"
  ]
}
```

### 4.2 设置页（registerSettingsSection）

单页表单，分三个卡片区块：

**A. QQ 邮箱账号**

- 邮箱地址（输入框，校验 `^[A-Za-z0-9._%+-]+@(qq|foxmail)\.com$`，foxmail 同属 QQ 邮箱体系，允许通过）
- 授权码（password 输入框；保存后回显固定掩码 `••••••••`，留空保存表示不修改原授权码）
- 发件显示名（可选，默认取邮箱前缀）
- 只读展示服务器参数：SMTP `smtp.qq.com:465 (SSL)`、IMAP `imap.qq.com:993 (SSL)`
- 附「如何获取 QQ 邮箱授权码」折叠说明（设置 → 账号 → POP3/IMAP 服务开启 → 生成授权码）

**B. 连通性测试**

- 按钮经 `ctx.bridge.invoke("plugin_exec_run", {bin:"python3", args:["<插件dir>/mcp/email_mcp/selftest.py"], env:{EMAIL_MCP_HOME:"<可选，测试用覆盖根目录>"}})` 调用
- `selftest.py` 顶部先把上级 `mcp/` 目录注入 `sys.path` 再 import 包内模块（支持以脚本路径直接启动，不依赖 cwd）；分别做 SMTP `login + noop + quit` 与 IMAP `login + logout`，stdout 输出 base64 JSON `{smtp:"ok", imap:"ok"}` 或结构化错误
- 结果行内展示（绿/红状态行 + 中文错误文案），15s 超时
- `EMAIL_MCP_HOME` 是配置根目录覆盖开关：设置时配置文件取 `<该目录>/plugin-data/email-assistant/profiles.json`，缺省为 `~/.ccgui-next`；仅测试与 selftest 使用，正式注册的 MCP 条目不带此变量

**C. MCP 注册向导**

- 读取并检测两个注册目标：
  - `~/.claude.json` 的 `mcpServers`（Claude Code / CCgui 引擎实际读取处，已验证本机现有 5 个条目均在此）
  - `~/.ccgui-next/config.json` 的 `claude.providers.*.settingsConfig.mcpServers`（CCgui 界面层配置；遍历所有 provider 写入同名条目，保持两处一致）
- 注册条目内容：

```json
"email-assistant": {
  "type": "stdio",
  "command": "python3",
  "args": ["<插件绝对路径>/mcp/email_mcp"],
  "env": {}
}
```

- 写入前先对目标文件做时间戳备份（`<file>.bak-email-assistant.<ts>`，沿用本机 plugins.json 备份惯例），JSON 序列化保留缩进与 `ensure_ascii=False`
- 已存在同名条目时显示「已注册」状态，并提供「卸载注册」（删除键 + 备份）
- 向导只改文件，不热加载；UI 提示「需重启对话引擎 / 重连 MCP 后生效」
- 插件目录绝对路径通过激活期自身模块 URL 解析（`import.meta.url` → 文件目录），不依赖工作区

### 4.3 配置落盘

插件本身不直接写文件系统（Tier-1 无 FS API），与 note-query 相同路径：把 base64 后的 JSON 经 env 传给内嵌 python 片段，由 python 落盘。

文件：`~/.ccgui-next/plugin-data/email-assistant/profiles.json`

```json
{
  "version": 1,
  "activeId": "qq-default",
  "profiles": [
    {
      "id": "qq-default",
      "provider": "qq",
      "email": "user@qq.com",
      "authCode": "16位授权码明文",
      "displayName": "张三",
      "smtp": { "host": "smtp.qq.com", "port": 465, "ssl": true },
      "imap": { "host": "imap.qq.com", "port": 993, "ssl": true },
      "updatedAt": 1762838400000
    }
  ]
}
```

- 结构预留多账号（`profiles` 数组 + `activeId`），一期 UI 只维护一个 `qq-default` 条目
- 写入采用「读全量 → 改 → 临时文件 + os.replace 原子替换」，避免半写损坏
- `ctx.storage` 另存一份非敏感 UI 偏好（如上次测试结果时间），**授权码只进 profiles.json，不进 ctx.storage**

### 4.4 安全提示（README + 设置页脚注）

- 授权码等同于密码，明文存于本机用户目录，请勿同步网盘、勿提交仓库
- 建议在 QQ 邮箱设置里定期轮换授权码
- `.gitignore` 需排除任何本地测试用 profiles 文件

## 5. MCP 服务侧设计

### 5.1 协议实现（protocol.py）

- JSON-RPC 2.0 over stdio，按行（`\n`）分帧，UTF-8
- 支持方法：`initialize`、`notifications/initialized`（通知，无响应）、`tools/list`、`tools/call`、`ping`
- `initialize` 返回 `protocolVersion: "2024-11-05"`、`capabilities: {tools: {}}`、server info
- 未知方法返回 JSON-RPC `-32601`；解析错误 `-32700`；参数校验失败 `-32602`
- 工具业务异常**不**走 JSON-RPC error，而是返回 MCP 工具结果 `{isError: true, content:[{type:"text", text:"中文错误"}]}`，保证 server 进程不退出
- 每行日志写 stderr（stdio 通道纯净），含时间戳与方法名，不记录授权码

### 5.2 工具定义

#### send_mail

入参：

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| to | string[] | 是 | 收件人地址数组，1 个起 |
| subject | string | 是 | 主题 |
| body | string | 是 | 正文纯文本 |
| cc | string[] | 否 | 抄送 |
| html | string | 否 | 提供时生成 multipart/alternative，纯文本与 HTML 同时携带 |
| attachments | string[] | 否 | 本机绝对路径数组 |

行为与约束：

- 读 active profile；无配置则 isError 提示先去插件设置页配置
- 地址做基本格式校验（正则 + 必须含 @），附件逐个校验存在、是文件、单文件 ≤ 25MB（QQ 邮箱普通附件上限）
- MIME 组装：`From` 含 displayName 时做 RFC 2047 编码；主题、附件名同样编码；附件 base64
- SMTP_SSL 连接 465，30s socket 超时，`with`/try-finally 保证 quit
- 成功返回 `{messageId, accepted:[...], rejected:[...]}` 文本摘要

#### list_recent_mails

入参：`limit`（默认 10，钳制 1–50）、`folder`（默认 `INBOX`）

- IMAP4_SSL 993 登录，`SELECT(folder, readonly=True)`
- `UID SEARCH ALL` 取全部 UID，截最后 N 个，反向（最新在前）
- 批量 `UID FETCH ... (BODY.PEEK[HEADER.FIELDS (FROM SUBJECT DATE)] RFC822.SIZE FLAGS)`，PEEK 避免误标已读
- 每封返回：`uid、from（解析后的姓名+地址）、subject、date、size、unread（FLAGS 不含 \\Seen）`
- 纯信封数据，不下正文，控制流量

#### get_mail

入参：`uid`（必填）、`folder`（默认 INBOX）、`mark_read`（默认 true）

- `mark_read=false` 时用 `BODY.PEEK[]`；默认 `RFC822` 抓取后由 QQ 服务端置已读（行为在 README 说明）
- 用 `email.message_from_bytes` 解析，递归遍历 multipart：
  - text/plain、text/html 分别解码（charset 缺失时回退 utf-8、gb18030 尝试解码，QQ 中文邮件常见）
  - 附件清单：filename、mimeType、size，**不自动落盘**，正文里不内联附件内容
- 返回结构化文本：头部 + 纯文本正文（截断保护：单部分 > 512KB 截断并提示）+ HTML 摘要 + 附件清单

### 5.3 模块边界

- `protocol.py`：只懂 JSON-RPC 帧与 MCP 握手，不知道邮件存在
- `config.py`：唯一 import 读取 profiles.json 的模块；提供 `load_active_profile()`、QQ 预设常量、配置校验
- `sender.py` / `receiver.py`：纯邮件逻辑，函数入参为 profile 对象，可在测试中直接注入
- `__main__.py`：只做组装——读配置、注册工具表、驱动 protocol 循环
- `selftest.py`：复用 config/sender/receiver 的连接函数，不重复实现

### 5.4 错误处理统一约定

- 所有工具内部捕获 `smtplib.SMTPException`、`imaplib.IMAP4.error`、`OSError`、`ValueError`
- 认证失败（535 / LOGIN failed）→ 「邮箱认证失败：授权码错误或 IMAP/SMTP 服务未开启」
- 网络超时/连接拒绝 → 「无法连接 <host>:<port>，请检查网络」
- 其余异常 → 异常类型 + message，前缀「邮件操作失败：」
- 错误文本均为中文，便于模型直接转述用户

## 6. 数据流

```
用户在设置页填写
   │  (plugin_exec_run + base64 env)
   ▼
profiles.json（plugin-data/email-assistant/）
   │                              ▲
   │ MCP 启动时读取               │ 插件 selftest 读取
   ▼                              │
email_mcp 进程 ◄──stdio JSON-RPC── 对话引擎（经 .claude.json / config.json 注册）
   │
   ├── SMTP_SSL → smtp.qq.com:465（发信）
   └── IMAP4_SSL → imap.qq.com:993（收信）
```

## 7. 测试策略

### 7.1 JS 侧（node --test，仿 ccgui-plugin-session-wait）

- `normalizeProfile`：脏数据（缺字段、类型错误、非法邮箱）兜底与默认值
- profiles.json 载荷构造：结构、activeId、掩码留空不改授权码逻辑
- MCP 注册配置生成：绝对路径拼接、JSON 条目形状；用临时 HOME 跑写入/备份/卸载全流程，不碰真实 `~/.claude.json`
- 注册目标检测：已存在 / 不存在 / JSON 损坏三种状态

### 7.2 Python 侧（unittest，零第三方库）

- `test_protocol.py`：向假 stdin 喂 initialize / tools/list / tools/call 行序列，断言 stdout 帧内容、错误码、notification 无响应
- `test_sender.py`：注入假 SMTP 类，断言 MIME 结构（中文头编码、multipart、附件头）、收件人参数、25MB 拦截
- `test_receiver.py`：用 `email.message.EmailMessage` 在内存构造样例（中文主题、multipart/alternative、带附件、gb18030 正文），喂给解析函数断言输出；假 IMAP 类断言 PEEK 与 readonly 用法
- `test_config.py`：临时目录 profiles.json 的正常读取、文件缺失、JSON 损坏、无 activeId 各路径

### 7.3 人工真实验证（发布前）

用真实 QQ 授权码：selftest 通过 → AI 发信自发自收（含一个中文文件名附件）→ list_recent_mails 看到它 → get_mail 正文与附件名正确。授权码不写入仓库与测试夹具。

## 8. 一期范围外（二期候选）

- 多账号切换 UI（数据结构已预留）
- 邮件搜索、标记已读/未读、文件夹管理、附件下载落盘
- 163 / Gmail 等服务商预设、OAuth2 认证
- 新邮件提醒（需常驻轮询，与短连接模型冲突，单独立项）
- MCP 注册的热加载（受宿主能力限制）

## 9. 风险与缓解

| 风险 | 缓解 |
|---|---|
| 授权码明文存储 | README 与设置页明示；仅用户目录；建议轮换；不进 ctx.storage 与仓库 |
| 改 ~/.claude.json 写坏导致引擎启动失败 | 写前时间戳备份 + 原子替换 + 写入后 JSON 回读校验，失败自动还原备份 |
| Windows 下 python3 命令名差异（note-query 已在本机验证 python3 可用） | 注册与 exec 统一用 python3；README 注明需与 note-query 相同的 Python 环境 |
| QQ 邮箱频率/反垃圾限制导致发信被拒 | 错误原文透传；单封发送、不做批量群发功能 |
| 中文邮件编码千差万别 | 解析侧 utf-8/gb18030 回退；测试夹具覆盖典型 QQ 邮件结构 |
