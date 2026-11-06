# 便签会话查询插件 · 架构与实现方案

> ⚠️ **v0.2 重大变更（已实现）**：存储从「各工作区 `.ccgui/notes.json`」改为
> **中央统一存储** `~/.ccgui-next/plugin-data/note-query/notes.json`，按工作区打标签加载；
> 归属工作区改由宿主 **app.db 的 sessions 表按 sessionId 权威解析**（不再靠 DOM 猜，彻底修好
> 「存错位置」）；新增「移动便签到其他工作区」；首次启动自动迁移历史散落文件并纠正错位。
> 下文 §1/§2/§3 的「工作空间文件存储」描述已被此变更取代，其余（生命周期、扩展点、定位、
> 跑马灯、检索）仍适用。详见 `ccgui-plugin-note-query/README.md`。

> 目标宿主：CC GUI / ccgui-next（本机 v1.0.6，SDK 0.3.x）
> 插件层级：Tier-1（单文件 ESM `main.js`，无构建、无 `import`）
> 插件 id：`note-query`　显示名：**便签会话查询**
> 目录：`ccgui-plugin-note-query/`
> 本文档只做设计，不含实现代码（按用户要求「先只出架构与实现方案」）。

---

## 0. 一句话概述

在侧栏会话右键菜单加「添加便签」，弹出一个结构化便签编辑器（标题 / 时间 / 业务 / 归属模块 / 详情），
把便签写进**当前工作空间** `.ccgui/notes.json`；右侧新增「便签栏」面板页签，展示本工作空间全部便签，
支持**按名称模糊检索**、**按日期（日）筛选**、**按业务 / 归属模块下拉筛选**；点击任一条便签即
`selectSession` 定位到左侧对应会话，并对该会话行施加**跑马灯线框高亮**。

---

## 1. 关键决策与依据

| 议题 | 决策 | 依据 / 权衡 |
|---|---|---|
| 便签数据落盘 | **仅工作空间 `<ws>/.ccgui/notes.json`**（用户选定） | 可进 git、跨设备共享、换机不丢；代价是必须经 `exec:python3` 读写（Tier-1 无 FS API）。 |
| 读写手段 | `ctx.bridge.invoke("plugin_exec_run",{bin:"python3",args:["-c",PY],env})`，内容走 **base64 env** | 绕开 Windows 命令行引号 + 中文路径；本机已确认 python3 可用（`…\Python313\python3.exe`）。 |
| 插件偏好（非便签数据） | 存 `ctx.storage`（开关、默认排序、跑马灯时长等） | 第一方 KV 最稳，与工作空间数据分离；`storage` 权限。 |
| 编辑弹窗载体 | `ctx.ui.registerOverlay`（常驻视口挂载，按状态渲染模态） | SDK 无「命令式 modal」原语；`openPanelTab` 在权威 sdk-api.md 中**不存在**，不能强开面板，故用 overlay。 |
| 定位会话 | `ctx.sessions.selectSession(engine,sessionId,ws)` | 第一方、可靠。 |
| 高亮效果 | 三层：活动标记/标题匹配轮询重试 → 侧栏行跑马灯 → 主聊天区脉冲 | 侧栏行选择器未知+可能未渲染（分组折叠/加载更多）；轮询消化重渲染延迟，主区兜底保证有反馈且不用横幅。 |
| 「按会话标题查询」 | 便签额外存 `sessionTitle`（创建时尽力抓取 + 可手填），检索覆盖它 | SDK 无 `getSessionTitle` API；靠 DOM 抓取 + 可编辑字段双保险。 |
| id 唯一性 | 用 `note-query`，**避开已装的 `session-notes`** | 二者功能不同，防止覆盖安装。 |

---

## 2. 数据模型

### 2.1 文件 `<workspace>/.ccgui/notes.json`

```jsonc
{
  "version": 1,
  "notes": [
    {
      "id": "n_1728372000000_a1b2",   // 稳定 id：n_<createdAt>_<rand4>
      "title": "收入尺寸上报联调",       // 必填，检索主字段
      "date": "2026-10-08",            // YYYY-MM-DD，默认当天
      "business": "HMS-收入",           // 可空；下拉历史来源=全体便签去重
      "module": "尺寸上报接口",          // 可空；同上
      "detail": "与 X 老师对齐字段口径…", // 可空，多行
      "sessionTitle": "收入尺寸上报｜整理设计", // 尽力抓取，可手填；供「按会话标题查询」
      "session": { "engine": "claude", "sessionId": "…" }, // 绑定，供定位
      "createdAt": 1728372000000,
      "updatedAt": 1728372000000
    }
  ]
}
```

设计要点：
- **业务 / 归属模块的「历史下拉」不单独存**：由 `notes[]` 里所有非空 `business`/`module` **去重**得到（按最近使用排序）。新增=直接输入新值即成为候选。自维护、无冗余。
- `session` 是定位锚点；`engine`+`sessionId` 唯一定位一个会话（与已装 `session-notes` 的键法一致：`note:<engine>:<sessionId>` 思路，但我们允许多条便签指向同一会话，故用数组而非 map）。
- 文件缺失/损坏时读取回退为 `{version:1,notes:[]}`，写回时补建 `.ccgui` 目录。

### 2.2 内存响应式模型（activate 闭包内的极简 store）

```
store = { ws, notes:[], loading:false, error:null|msg, loaded:false }
subscribe(fn) / notify()   // 面板与 overlay 共用
```
所有变更走 **reload-merge-write**：改前先重读文件 → 应用这一处变更 → 原子写回 → 更新 store → notify。
（单用户桌面、低频，够用；并发写为已知限制，见 §9。）

---

## 3. 文件 I/O 契约（python3 via exec_run）

> 严格遵守本机实测的 exec 坑：`bin` 必须是短名 `python3`（绝对路径会被判 invalid manifest → 整体隔离）；
> 路径/内容经 **env + base64** 传入，绝不拼进命令行参数；输出走 stdout。

### 3.1 读

```
invoke("plugin_exec_run", {
  bin: "python3",
  args: ["-c", READ_PY],
  env: { NQ_WS: <workspacePath> }
}) -> { code, stdout, stderr }
```
`READ_PY`（内嵌）：读 `os.environ["NQ_WS"]/.ccgui/notes.json`，存在则原样打印，否则打印 `{"version":1,"notes":[]}`。
JS 侧 `JSON.parse(stdout)`；解析失败 → 置 `store.error`（很可能是 §9 的 64KB 截断）。

### 3.2 写

```
invoke("plugin_exec_run", {
  bin: "python3",
  args: ["-c", WRITE_PY],
  env: { NQ_WS: <workspacePath>, NQ_B64: base64(utf8(JSON.stringify(model))) }
}) -> { code, stdout:"OK", stderr }
```
`WRITE_PY`：`base64.b64decode(os.environ["NQ_B64"]).decode("utf-8")` → `os.makedirs(<ws>/.ccgui, exist_ok=True)`
→ 写临时文件 + `os.replace` **原子替换** → 打印 `OK`。非零 code / 无 OK 视为失败并 toast。

### 3.3 base64 传输细节
- env 值只能是字符串：`btoa(unescape(encodeURIComponent(json)))` 得到 ASCII-safe base64，规避中文与引号。
- 大 JSON 受限于单条 env 变量长度（Windows 环境块上限很高，一般无虞）；真正的硬限是**读**方向的 64KB stdout（见 §9）。

---

## 4. 扩展点与权限清单

| 功能 | 扩展点（sdk-api.md 权威签名） | 权限 |
|---|---|---|
| 会话右键「添加便签」 | `ctx.ui.registerSessionMenuItem({key,label,run(target:{engine,sessionId})})` | `ui:session-menu` |
| 右侧「便签栏」面板页签 | `ctx.ui.registerPanelTab({key,label,icon,component:({workspacePath})})` | `ui:panel-tab` |
| 便签编辑弹窗（模态） | `ctx.ui.registerOverlay({key,component})` | `ui:overlay` |
| 点击便签定位会话 | `ctx.sessions.selectSession(engine,sessionId,ws)` | `host:session` |
| 读写工作空间文件 | `ctx.bridge.invoke("plugin_exec_run",…)` | `exec:python3` |
| 插件偏好存储 | `ctx.storage.get/set` | `storage` |
| 注入面板样式 + 跑马灯动画 | `ctx.theme.injectCss(css)` | `theme` |
| 跟踪当前活动工作空间 | `ctx.events.on("session://activated",cb)` + `ctx.workspace.getMetadata()` | `events`（+ `workspace.metadata.read` 若用 getMetadata） |
| 命令面板入口（可选） | `ctx.ui.registerCommand({key,title,run})` | `ui:command` |
| 设置页（可选） | `ctx.ui.registerSettingsSection({key,label,component})` | `ui:settings-section` |

**manifest.permissions（最终集，不多不少）**：
```
["ui:session-menu","ui:panel-tab","ui:overlay","host:session",
 "exec:python3","storage","theme","events",
 "ui:command","ui:settings-section","workspace.metadata.read"]
```
> 说明：`events` 用于订阅会话切换以维护 `activeWs`；`workspace.metadata.read` 用于面板未挂载时兜底解析工作空间路径
> （`registerSessionMenuItem.run` 的 target **不带 workspacePath**，必须自行解析——沿用已装 `api-summary` 的成熟做法）。
> 若最终不用命令面板/设置页，则相应去掉 `ui:command`/`ui:settings-section`（权限最小化）。

---

## 5. 插件生命周期管理

```
安装(复制) → 校验 manifest → ESM 加载 main.js → activate(ctx) → [运行期] → 卸载(dispose)
```

### 5.1 加载 / 安装
- 用户：侧栏「插件」→「从本地目录安装」→ 选 `ccgui-plugin-note-query/`（含 `manifest.json` 那层）。
- 宿主把整目录复制到 `~/.ccgui-next/plugins/note-query/`，校验 `id`/`version`/`tier`/`permissions`（未知权限=加载期拒绝），
  以 ESM 解析 `main.js`，调用 `export default function activate(ctx)`。
- 首次安装会弹权限清单，`exec:python3` 需用户放行（声明≠授权；手写 plugins.json 不算数）。

### 5.2 初始化（activate 内，按序）
1. 从 `ctx.storage` 读偏好（enabled、默认排序、跑马灯开关/时长），得运行期 `cfg`。
2. 建 §2.2 的 `store` + 极简 pub/sub。
3. `injectCss`：面板样式 + `@keyframes` 跑马灯/呼吸线框（自包含，禁 `@import`/远程 `url()`）。
4. 注册扩展点：session-menu「添加便签」、panel-tab「便签栏」、overlay（编辑弹窗，默认隐藏）、命令面板项、设置页。
5. 订阅 `session://activated` 维护 `activeWs`；调用 `getMetadata()` 兜底取初值。
6. **懒加载数据**：不在 activate 里读文件（可能无活动工作空间）；面板首次挂载 / 首次「添加便签」时才按当前 `ws` 读。

### 5.3 运行期（数据流）
```
右键会话 → run(target) → 解析 activeWs → 抓取 sessionTitle(best-effort)
        → 打开 overlay 编辑器(create 模式，date 预填今天)
        → 保存 → reload-merge-write(python) → store.notes 更新 → notify
        → 便签栏面板即时重渲染

面板点便签 → selectSession(engine,sessionId,ws)（宿主原生把该会话标记为「选中/活动」＝保证的定位+选中反馈）
        → 轮询重试给活动行挂跑马灯线框；找不到行则柔和脉冲侧栏容器（**不弹横幅**）

面板检索/筛选 → 纯内存 over store.notes（不再触盘）
```

### 5.4 卸载 / 回滚
- `activate` 返回清理函数；宿主另按注册逆序自动回收所有 `register*` 的 Disposer（插件**不要**自存 Disposer 列表）。
- 清理函数负责：断开 `events` 订阅、断开任何 MutationObserver、关闭 overlay、冲刷未完成写。
- **便签数据不受卸载影响**（在工作空间，不在 plugin-data）；重装同 id 走热重载覆盖代码，数据原样复用。
- 卸载后宿主保留插件数据 30 天（指 ctx.storage 偏好，非工作空间文件）。

---

## 6. 组件详细设计

### 6.1 会话右键项「添加便签」
- `label()`：中文环境「添加便签」/「Add note」。
- `run(target)`：
  1. `ws = activeWs || target.workspacePath`；无 ws → toast 提示「无法确定工作空间」并中止。
  2. `sessionTitle = captureSessionTitle(target)`（§6.5，可空）。
  3. 置 overlay 状态 `{mode:'create', draft:{date:today(), session:target, sessionTitle}}` → notify → overlay 弹出编辑器。

### 6.2 编辑弹窗（overlay 模态）
- overlay 组件读 `store`/闭包的 `editorState`；`editorState==null` 时返回 `null`（不占交互），非空时渲染居中模态。
- 根容器 `pointer-events:none`，模态本体 `pointer-events:auto`（overlay 约定）。
- 字段（自上而下）：
  - **标题** `input`（必填，autofocus；空则保存按钮禁用并提示）。
  - **时间** `input[type=date]`，默认 `今天`（YYYY-MM-DD）。
  - **业务** `input` + `<datalist>`（候选=全体便签 business 去重）→「可新增可下拉历史」原生实现。
  - **归属模块** `input` + `<datalist>`（同上，module 去重）。
  - **会话标题** `input`（预填抓取值，可改；供按会话标题查询）。
  - **详情** `textarea`（多行，可空）。
  - 底部：`保存` / `取消`；编辑模式额外 `删除`（二次确认）。
  - 只读小字显示绑定会话：`engine · sessionId 前 8 位`。
- 保存：create→push；edit→按 id 替换并更新 `updatedAt`；均走 §3.2 写盘 → notify → 关窗 → toast。

### 6.3 右侧「便签栏」面板页签
- `registerPanelTab({ label:()=> "便签", component: NotePanel })`，`NotePanel({workspacePath})`。
- 挂载时 `ws=workspacePath`，触发 §3.1 读盘填充 store。
- **顶部工具条**：
  - 搜索框：`placeholder="搜索便签名称…"`（模糊，见 §7）。
  - 日期筛选：`input[type=date]` + 「清除」；命中 `note.date===选中日`（按日）。
  - 业务下拉：`<select>`，选项=`["全部", ...business去重]`。
  - 模块下拉：`<select>`，选项=`["全部", ...module去重]`。
  - 右侧：`新建便签`（对当前活动会话开 create 弹窗）、`刷新`（重读盘）、计数 `共 N / 命中 M`。
- **列表**：卡片按 `date` 倒序（同日按 `updatedAt` 倒序）。每张卡：
  - 标题（粗体）、徽章行（日期 / 业务 / 模块，空则不显）、详情摘要（2 行截断）、会话小图标 + `sessionTitle`。
  - **点卡片主体 → 定位会话**（§6.4）。卡右上角 `编辑` / `删除` 小按钮。
- **状态**：loading 骨架；error 红条（含 python3/exec 排障指引，见 §9）；empty「暂无便签，右键会话即可添加」。
- 筛选四者 **AND 组合**；纯内存计算，`useMemo` over `store.notes + filters`。

### 6.4 定位 + 跑马灯高亮（修订：去掉浮动横幅兜底）
```
async locate(note){
  await ctx.sessions.selectSession(note.session.engine, note.session.sessionId, ws)
  // ① 宿主原生选中态 = 保证的基础反馈（selectSession 会让侧栏行进入活动态）
  // ② 便签卡片自身短暂打勾/描边（locatedId 状态，2.4s）——反馈发生在用户点击处，零定位成本
  // ③ flashSessionRow：轮询重试给侧栏行挂跑马灯线框
}
```
`flashSessionRow`（轮询重试，消化宿主重渲染延迟；**不再用横幅**）：
- 每 160ms 尝试 `findSessionRow(hint)`，最长 2.6s，命中即 `scrollIntoView` + 挂 `.nq-flash`（跑马灯 2.6s 后摘除）。
- `findSessionRow` 两级启发式：
  1. **文本匹配**（首选）：XPath `contains(normalize-space(.), sessionTitle)` 找最小文本节点，向上爬到行祖先（button/a/li/[role=treeitem…]），排除插件自身 UI（`closest('[data-nq-ui]')`）。
  2. **活动态启发式**：`[aria-current="true"] / [aria-selected="true"] / [data-state="active"]` 且文本短、不在插件 UI 内。
- 超时仍未命中：不打扰用户——宿主选中态 + 卡片打勾已经传达「已定位」，跑马灯是锦上添花。
- ⚠️ 侧栏行选择器仍需真机校准（与已装 `filetree-open-with` 同类脆弱点），但失败面只剩「少个动画」，无错误反馈。

### 6.5 抓取 sessionTitle（best-effort）
`run(target)` 打开菜单时，尝试从侧栏对应行读文本：
1. 若行元素带 `data-*`/`aria-*` 含 `sessionId` → 取其可见文本。
2. 否则留空——编辑器「会话标题」字段允许用户手填。
两条路都汇入同一个可编辑字段，保证「按会话标题查询」始终可用（最差=用户手输一次）。

---

## 7. 检索与筛选算法

- **名称模糊检索**：对 `q` 与每条便签做归一化（trim + 小写 + 全角转半角可选）。
  - 先 `includes` 子串命中；未命中再做**子序列**（subsequence）匹配（`收入上报` 命中 `收入尺寸上报`）。
  - 匹配范围默认 `title`；勾选「含全文」时扩展到 `sessionTitle + business + module + detail`（满足「按便签或会话标题查询」）。
- **日期筛选（按日）**：`note.date === 选中日` 精确到日；「清除」还原。
- **业务 / 模块下拉筛选**：`note.business === 选中` / `note.module === 选中`；「全部」不过滤。
- 组合：`match = 名称模糊 ∧ 日期 ∧ 业务 ∧ 模块`。列表按 `date desc, updatedAt desc` 稳定排序。

---

## 8. 注入样式（theme.injectCss，自包含）

- 面板/卡片/徽章/工具条：全部走宿主语义 token（`var(--background-primary-default)` 等 `--*` 变量），随明暗主题；不发明新前缀色值。
- **跑马灯线框**（WebView2=Chromium，支持 `@property`）：
  ```css
  @property --nq-a{syntax:'<angle>';initial-value:0deg;inherits:false}
  .nq-flash{position:relative}
  .nq-flash::after{content:"";position:absolute;inset:-2px;border-radius:8px;padding:2px;
    background:conic-gradient(from var(--nq-a),var(--accent,#e8703a),transparent 25%,var(--accent,#e8703a) 50%,transparent 75%,var(--accent,#e8703a));
    -webkit-mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0);
    -webkit-mask-composite:xor;mask-composite:exclude;
    animation:nq-spin 1.1s linear infinite;pointer-events:none}
  @keyframes nq-spin{to{--nq-a:360deg}}
  ```
  （若 `@property` 不可用，退化为 `outline` 呼吸：`@keyframes nq-pulse{50%{outline-offset:5px;outline-color:transparent}}`。）
- 禁止 `@import`、远程 `url(http…)`（宿主门禁会拒）。

---

## 9. 边界、风险与缓解

| # | 风险 | 现象 | 缓解 |
|---|---|---|---|
| R1 | python3 不在 GUI 的精简 PATH | exec_run 报 `binary not found on PATH` | 错误 toast 附排障：把 Python 目录加入**系统**PATH 后重启 GUI（本机既有经验）；面板 error 条同提示。 |
| R2 | exec_run **stdout 上限 64KB** | 便签很多时**读**被截断 → JSON.parse 失败 | v1：解析失败即报「便签文件过大」并停止覆盖写（防丢数据）；detail 建议精简；后续可分页读。 |
| R3 | 侧栏活动行选择器未知 / 行未渲染（分组折叠、加载更多） | 跑马灯找不到行 | 轮询重试 2.6s；失败也只是少个动画——`selectSession` 的宿主原生选中态 + 便签卡片打勾已构成「已定位」反馈，不弹横幅。 |
| R4 | sessionTitle 抓不到 | 「按会话标题查询」缺数据 | 编辑器字段可手填，双保险。 |
| R5 | 多个 GUI 实例同时写同一文件 | 后写覆盖先写 | reload-merge-write 缩小窗口；桌面单实例为主，列为已知限制。 |
| R6 | `.ccgui/notes.json` 进 git 产生噪声 | 提交历史变碎 | 文档提示：不想共享可加进 `.gitignore`；想团队共享则纳入版本控制（正是选此存储的动机）。 |
| R7 | 权限未放行（尤其 exec:python3） | 加载期隔离或调用抛错 | 必须走「从本地目录安装」弹窗放行；离线补 plugins.json 亦有效（本机经验）。 |
| R8 | 与已装 `session-notes` 混淆 | 用户以为重复 | 独立 id `note-query`、独立文件、独立面板页签名，互不干扰。 |

---

## 10. 实现步骤（进入编码阶段时按序执行）

1. 建目录 `ccgui-plugin-note-query/`，写 `manifest.json`（§4 权限集、id/version/tier 合规）。
2. `main.js` 骨架：`activate(ctx)` + §2.2 store + pub/sub + 偏好读取。
3. python 读写助手（§3，含 base64 传输、原子写、错误码判定）。
4. `injectCss`（§8 面板样式 + 跑马灯）。
5. session-menu「添加便签」+ `activeWs` 跟踪 + `captureSessionTitle`。
6. overlay 编辑弹窗（create/edit/delete，datalist 历史下拉）。
7. panel-tab「便签栏」（列表 + 工具条 + 检索/筛选 §7 + 状态）。
8. 定位 `locate` + `flashLocated`（§6.4，含兜底横幅）。
9. 命令面板项 + 设置页（可选，精简权限则跳过）。
10. 卸载清理函数（断订阅/observer、关窗）。
11. **真机验收**（§11）并校准跑马灯选择器。

---

## 11. 验收清单（verification-before-completion）

- [ ] 安装成功、无权限报错；面板出现「便签」页签、右键出现「添加便签」。
- [ ] 添加便签后，`<工作空间>/.ccgui/notes.json` 生成且为合法 JSON，字段齐全。
- [ ] 时间默认=今天；除标题外字段可空；业务/模块下拉能看到历史值且可输入新值。
- [ ] 关闭重开面板、卸载重装后，便签仍在（数据在工作空间）。
- [ ] 名称模糊检索命中；日期(按日)/业务/模块筛选生效且可组合。
- [ ] 点便签 → 左侧切到对应会话 + 跑马灯/横幅反馈可见。
- [ ] 删除便签 → 文件同步更新；编辑 → updatedAt 变化。
- [ ] 故意把 python3 移出 PATH → 面板出现可读错误指引而非白屏。
- [ ] `main.js` 零 `import`、无 JSX/eval；每个订阅/observer 有清理。

---

## 12. manifest.json 草案

```json
{
  "id": "note-query",
  "name": "便签会话查询",
  "version": "0.1.0",
  "tier": "js",
  "sdkVersion": "^0.3",
  "minAppVersion": "1.0.6",
  "author": "IM Builder",
  "description": "给会话贴结构化便签（标题/时间/业务/归属模块/详情），存于工作空间 .ccgui/notes.json；右侧便签栏可按名称模糊检索、按日期/业务/模块筛选，点击便签直接定位并高亮左侧会话。",
  "permissions": [
    "ui:session-menu", "ui:panel-tab", "ui:overlay", "host:session",
    "exec:python3", "storage", "theme", "events", "workspace.metadata.read",
    "ui:command", "ui:settings-section"
  ]
}
```

---

## 13. 交付与迭代路径（届时告知用户）

1. **安装**：侧栏「插件」→「从本地目录安装」→ 选 `ccgui-plugin-note-query/`；弹窗放行权限（含 exec:python3）。
2. **验收**：对照 §11；看不到效果就看插件页该行错误提示，别猜。
3. **迭代**：改文件后**重新走一次「从本地目录安装」**（同 id 覆盖即热重载），不必重启、别新建目录。
4. **卸载/回滚**：插件页卸载；便签数据留在工作空间 `.ccgui/notes.json`，不受影响。
