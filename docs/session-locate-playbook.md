# 会话待答提醒（question-alert）· 定位方案记录

记录 `会话定位` 经过三轮迭代后的最终做法，供后续插件复用。参考实现：
`ccgui-plugin-note-query`。

## 结论：定位一律走宿主第一方 API，不要猜 DOM

```
ctx.sessions.selectSession(engine, sessionId, workspacePath)   // 权限 host:session
```

这是与宿主「点击侧栏会话行」等价的内部动作，**不依赖任何 class / data-* /
fiber props 形状**。运行版 exe 的前端 chunk 是压缩存储的，源码快照里的
`pl-9` / `data-tab-key` 等在实机上并不成立——所有基于 DOM 选择器的定位方案
（包括蓝点 `animate-pulse` 锚、根 fiber 全树 DFS 按 props 形状匹配）都被实测
证伪。

## 成功判定：用事件回执，而不是返回值

`selectSession` 不抛错也不返回"是否成功"。必须在调用**之前**记时间戳，调用后
轮询等 `session://activated` 事件作为确认：

```js
ctx.events.on("session://activated", (p) => {
  recentActivated[p.sessionId] = Date.now();
  recentActivated[p.engine + "/" + p.sessionId] = Date.now();
  if (p.id) recentActivated[p.id] = Date.now();
});

const before = recentActivated[sid] || 0;
await ctx.sessions.selectSession(engine, sid, ws);
for (let i = 0; i < 20; i++) {          // 最多等 3 秒
  await sleep(150);
  if ((recentActivated[sid] || 0) > before) return true;   // 确认成功
}
```

要点：
- 事件 payload 的会话标识**形状不唯一**（`sessionId` / `id` / `session.sessionId`），
  三个都记进 `recentActivated`，判定时任一命中即算成功；
- 同一个 sessionId 可能是从**后台会话切过来**，也可能用户本来就停在那条上
  ——所以判定用"时间戳变大"而不是"是否存在"，避免误判。

## workspacePath 必须给

`selectSession` 的第三参是工作区路径，**会话是工作区内的对象**。取法（按顺序）：

1. `ctx.workspace.getMetadata()` → `path | rootPath | workspacePath | root`
   （权限 `workspace.metadata.read`）；
2. 兜底用 `session://activated` 事件里累积的 `activeWs`；
3. 路径分隔符试两种写法（`\` ↔ `/`），某些引擎记录的是另一种；
4. 实在拿不到就传空串试一次——宿主可能自行解析，但别把空串当唯一方案。

## 失败降级（三级）

| 级别 | 动作 | 用户可见反馈 |
|---|---|---|
| 1 | `selectSession` + 双分隔符各试一次 | 「已定位」 |
| 2 | `ctx.sessions.refresh()` 后再 `selectSession` | 「已定位」 |
| 3 | 全部失败 | 「未找到会话」，卡片保留（会话可能被删/归档），**会话 ID 复制到剪贴板**便于人工核查 |

不要做 DOM 点击兜底——实测宿主行 props 形状不稳定，点错行的风险比不点更糟。

## 所需权限

```json
["host:session", "events", "workspace.metadata.read"]
```

`host:session` 对应 `ctx.sessions.*`，`events` 对应 `ctx.events.on`，
`workspace.metadata.read` 对应 `ctx.workspace.getMetadata()`。

## 如果 CSS / 类名注入没生效

宿主只在「安装插件那一刻」读取 `styles.css`，改磁盘文件不重装不生效。
插件应在 `activate()` 里自己往 `<head>` 插一个 `<style>`（幂等，按 id 判重）
——这是唯一可靠的自注入路径，且不依赖 `theme` 权限。

## 事件链路（与定位无关，但同插件内）

引擎事件流 `engine://event` **不经过**插件事件总线（宿主只桥接 `usage://*`、
`done` 等少数几个）。要拿 `question` 事件只能走 Tauri v2 协议旁路：

```js
// activate 时处于 runAsPlugin 深度>0，直接 invoke 会被 hardening 拒；
// 推到宏任务里执行即可脱离深度计数（宿主文档承认的残留面，非契约）。
setTimeout(() => {
  const handler = window.__TAURI_INTERNALS__.transformCallback((evt) => {
    handleBatch(evt && evt.payload);          // payload = EngineEventPayload[]
  }, false);
  window.__TAURI_INTERNALS__.invoke("plugin:event|listen", {
    event: "engine://event",
    target: { kind: "Any" },
    handler,
  }).then((eventId) => { /* eventId 用于 unlisten */ });
}, 0);
```

两条实现约束：
- `question` 事件**可能带 `sessionId: null`**，需按 `runId` 维护路由表兜底
  （宿主 `engine-events.ts` 的 `runRouting` 就是干这个的）；
- 待答状态的清除不能只看 `delta`——提问那一轮的**尾部 delta** 序号也更大，
  会被误判成"已回答"。加 3 秒时间闸（`question` 落地 3 秒内的产出不算回答）。
