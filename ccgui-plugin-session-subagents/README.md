# 会话子代理计数（session-subagents）

CC GUI（ccgui-next 1.1.6）Tier-1 JS 插件。左侧会话列表里，**正在跑子代理**的会话行
右侧会多出一枚虚线小胶囊 `⑂ 运行中/总数`，运行中带蓝色呼吸点；点一下在**该行下方**
浮出子代理清单（类型徽章 + 描述 + 运行中/已完成）。

```
CCgui                                22
├─ ● 会话中是涉及…   3分钟   [ ● ⑂ 2/2 ]
│                            ┌───────────────────────────────┐
│                            │ 子代理 · 2 个运行中 / 共 3     │
│                            │ ● general-purpose  核对接口  运行中│
│                            │ ● Explore          梳理流程  已完成│
│                            └───────────────────────────────┘
└─ ● EasyFish         42分钟
```

## 数据口径：只实时

只统计**本次打开 GUI 期间**从引擎事件流里看到的子代理调用：

- 重启 GUI 后清零；
- 不读 `~/.claude/projects/**/subagents/*.jsonl`；
- 不写历史存档。

这样不会出现「会话早就跑完了，侧栏还挂着 3 个运行中」的陈旧数据。

## 装什么、要什么权限

`manifest.json` 只申请两项：

| 权限 | 用途 |
|---|---|
| `storage` | 记住开关（设置页） |
| `ui:settings-section` | 设置页里的开关 + 诊断面板 |

不联网、不起进程、不读文件。样式由插件自己在 `activate` 里注入 `<style>`
（宿主只在安装那一刻读 `styles.css`，改盘上文件不会重新生效）。

## 识别哪些工具

沿用宿主 `agent-task-steps.ts` 的判定表，覆盖各引擎的写法：

- Claude：`Task` / `Agent`
- pi 家族：`task · 意图`（只看 `·` 前的工具名）
- Codex / Grok：`spawn_agent` / `spawn_subagent`
- Kimi：`agent swarm`
- 另含 `workflow` / `run_workflow` / `pipeline` / `dispatch_agent` / `delegate`

一次 `tasks[]` 派发多个 agent 时，按数组里每个 entry 各算一条。

## 状态是怎么判的

| 事件 | 判定 |
|---|---|
| 工具行出现（`content_block_start`） | 新增一条「运行中」，先用工具名占位 |
| args patch（`content_block_stop`） | 补上 `description` / `subagent_type`，`tasks[]` 会展开成多条 |
| 工具结果回灌 | 该条转「已完成」 |
| 结果内容是 `Async agent launched successfully` | **不算完成**——那是后台 agent 的启动回执，只记下 `agentId`，保持运行中 |
| 本轮 `done` / `error` | 非后台的条目兜底收尾；后台条目不动 |
| 该会话出现**另一个 runId** 的事件 | 上一轮已彻底收尾，后台条目落成「已完成」 |

最后一条是后台 agent 的唯一可行信号：宿主把 `<task-notification>` 当
`queue-operation` / `attachment` 处理，**既不进时间线也不上事件总线**，插件拿不到；
能观测到的等价事实是「这个会话又开了一轮」，那时通知已被消费。

## 为什么用 DOM 注入

SDK 没有「侧栏会话行」扩展点（只有会话右键 `ui:session-menu`），所以：

- **胶囊**：`document.createElement("span")` 追加进会话行元素，跟着宿主布局走；
  行元素通过 React fiber 找（`props.id === "engine/sessionId"` 且带 `onSelect`），
  缓存后只在失效时重扫，避免每次绘制全树遍历。
- **清单**：挂在 `body` 上的 `position:fixed` 浮层，按会话行 `getBoundingClientRect()`
  定位，滚动时用 `requestAnimationFrame` 跟随。
  **刻意不做「插进列表流撑开」**——宿主的树形连接线（`TreeConnector`）是按
  「行数 × 30px 固定节距」画的 SVG，插行会让下面所有肘形线错位。

## 安装 / 更新 / 卸载

- **安装**：设置 → 插件 → 「从本地目录安装」→ 选中本目录（含 `manifest.json` 那一层）。
- **更新**：覆盖 `~/.ccgui-next/plugins/session-subagents/main.js` 后，在插件页把开关
  关一次再开（`setEnabled` 会即时重新加载，无需重启）。
- **卸载**：插件页该行点卸载。

## 设置页

设置 → 插件 → **会话子代理计数**：

- 开关：关掉会立刻摘掉所有胶囊与浮层；
- 诊断：订阅状态、批次/事件数、识别到的工具名样本、跟踪中的会话、扫到的会话行数。

`订阅: no-internals` = 不在桌面宿主里（Web 版没有 `__TAURI_INTERNALS__`），
`订阅: invoke-fail` 会带错误信息。

## 已知限制

- 并行派发多个**同名**工具时，结果回灌只能按「最早的未完成」配对——引擎事件不带
  `tool_use_id`。最终都会收敛到完成，只是极端情况下完成顺序可能对调。
- 后台 agent 的「已完成」是推断出来的（见上表最后一行），不是精确回执。
- 会话行被 React 整段重建时，胶囊可能短暂消失；低频看门狗（1.2s）会补回。

## 许可

MIT
