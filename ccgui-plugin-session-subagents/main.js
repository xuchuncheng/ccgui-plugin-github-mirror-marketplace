// 会话子代理计数（session-subagents）v0.1.0
//
// 作用：左侧会话列表里，如果某个会话正在跑子代理（Claude 的 Task/Agent、pi 家族的
//       task · intent、Codex/Grok 的 spawn_* 等），就在该会话行最右侧挂一枚虚线小
//       胶囊「⑂ 运行中/总数」，运行中带蓝色呼吸点；点一下在该行下方浮出子代理清单
//       （类型徽章 + 描述 + 运行中/已完成）。
//
// 数据口径（按用户确认）：**纯实时**。只认本次 GUI 运行期间从引擎事件流里看到的
//       子代理调用，不做历史统计——重启后清空，也不去读 transcript 文件。
//
// 为什么走 engine://event 而不是 ctx.events：
//   宿主的插件总线只桥接了 usage 事件（见 runtime/events.ts 的 bridgeUsageEvents），
//   工具调用压根不上插件总线。所以这里和 question-alert 一样，用
//   window.__TAURI_INTERNALS__ 直接 listen "engine://event"——必须在宏任务里做，
//   activate 本身跑在 runAsPlugin 深度>0，直接 invoke 会被 hardening 拒。
//
// 为什么 DOM 注入会话行 + body 浮层，而不是 ctx.ui 扩展点：
//   SDK 没有「侧栏会话行」扩展点（只有会话右键菜单 ui:session-menu）。胶囊是行内
//   一个 flex 子元素（跟着宿主布局走，不会和 hover 出来的置顶/改名/删除按钮打架），
//   清单是需要盖住后续行的浮层，挂 body 上、按行 rect 定位，滚动时跟随。
//
// 约束：单文件 ESM，零 import；无 eval / new Function / 远程 import；不联网、不起进程。
//       权限只要 storage + ui:settings-section。样式自己插 <style>（宿主只在安装那
//       一刻读 styles.css，改盘上文件不会重新生效）。

const NS = "session-subagents";
const EVENT_NAME = "engine://event";

const PILL_CLASS = "ccgui-sa-pill";
const ROW_CLASS = "ccgui-sa-row";
const PANEL_CLASS = "ccgui-sa-panel";

/** 子代理工具名判定——与宿主 agent-task-steps.ts 的 isSubagentToolLabel 同源。
 *  引擎差异很大：claude 是 "Task"/"Agent"，pi 家族是 "task · 意图"，Codex/Grok
 *  是 spawn_* 名字，Kimi 是 agent swarm。 */
const SUBAGENT_HEADS = new Set([
  "task",
  "agent",
  "subagent",
  "spawn",
  "spawn_agent",
  "spawn_subagent",
  "workflow",
  "run_workflow",
  "pipeline",
  "dispatch",
  "dispatch_agent",
  "delegate",
]);

function isSubagentTool(text) {
  const raw = String(text == null ? "" : text).trim();
  if (!raw) return false;
  // pi 家族的标签是「工具名 · 意图」，只看 · 之前那段。
  const head = raw.split("·")[0].trim().toLowerCase();
  const first = head.split(/[\s/\\]+/)[0].replace(/-/g, "_");
  if (SUBAGENT_HEADS.has(first)) return true;
  if (/^subagent\s*\d+/.test(head)) return true;
  if (head.indexOf("spawn agent") >= 0 || head.indexOf("spawn subagent") >= 0) return true;
  if (head.indexOf("agent swarm") >= 0 || head.indexOf("agent_swarm") >= 0) return true;
  if (head.indexOf("workflow") >= 0 || head.indexOf("subagent") >= 0) return true;
  return false;
}

function str(v) {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

/** 从一次工具调用的 args 里解出「这次派了几个子代理」。
 *  - tasks[]：一次派发多个 agent（每个 entry 带 name/id/label + agent/subagent_type）；
 *  - 其余：单代理，类型取 subagent_type/type，描述取 description/subject/task。
 *  run_in_background 的调用会立刻返回一条 "Async agent launched successfully"
 *  的回执（不是完成），所以标记 bg，等 task-notification 再收尾。 */
function entriesFromArgs(args, fallbackLabel) {
  const bg = Boolean(args && args.run_in_background === true);
  const tasks = args && Array.isArray(args.tasks) ? args.tasks : null;
  if (tasks && tasks.length > 0) {
    const out = [];
    for (const t of tasks) {
      if (!t || typeof t !== "object") continue;
      const id = str(t.name) || str(t.id) || str(t.label);
      if (!id) continue;
      out.push({
        id,
        label: str(t.description) || id,
        type: str(t.agent) || str(t.subagent_type),
        bg,
      });
    }
    return out;
  }
  const type = str(args && args.subagent_type) || str(args && args.type);
  const label =
    str(args && args.description) ||
    str(args && args.subject) ||
    str(args && args.task) ||
    fallbackLabel;
  return [{ id: "call", label, type, bg }];
}

/** 后台 agent 的完成通知里带着 agentId：`<task-id>…</task-id>`、`<tool-use-id>…`。
 *  事件流把它当普通文本投过来，扫一遍就能把对应的那条收尾。 */
function notificationIds(text) {
  const out = [];
  if (typeof text !== "string" || text.indexOf("task-notification") < 0) return out;
  const re = /<task-id>([^<]+)<\/task-id>|<tool-use-id>([^<]+)<\/tool-use-id>/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const v = (m[1] || m[2] || "").trim();
    if (v) out.push(v);
  }
  return out;
}

/* ------------------------------------------------------------------ 样式 */

const SELF_CSS = [
  // 行内胶囊：跟宿主时间 chip 同一套视觉（虚线边、5px 圆角、11px 字号），
  // 但常驻（不像时间 chip 那样 hover 消失），鼠标移上去才高亮。
  `.${PILL_CLASS}{`,
  "display:inline-flex;align-items:center;gap:4px;flex:0 0 auto;",
  "height:18px;padding:0 6px;margin-left:4px;",
  "border:1px dashed var(--color-border-button-default,rgba(128,128,128,.45));",
  "border-radius:5px;background:transparent;",
  "font-size:11px;line-height:1;font-variant-numeric:tabular-nums;",
  "color:var(--color-text-secondary,inherit);cursor:pointer;user-select:none;",
  "transition:background-color .12s ease,border-color .12s ease;white-space:nowrap;}",
  // 宿主把 hover 出来的置顶/改名/删除按钮塞在同一行；胶囊被挤到它们右边时
  // 保持不换行、不缩，避免把行撑高。
  `.${PILL_CLASS}:hover{background:var(--color-background-tertiary-default,rgba(128,128,128,.14));}`,
  `.${PILL_CLASS}[data-open="1"]{`,
  "border-color:var(--color-foreground-icon-secondary,rgba(160,160,160,.9));",
  "background:var(--color-background-tertiary-default,rgba(128,128,128,.14));}",
  `.${PILL_CLASS} svg{width:10px;height:10px;flex:0 0 auto;opacity:.8;}`,
  // 运行中：蓝色呼吸点；已完成：绿色实心点。
  `.ccgui-sa-dot{width:5px;height:5px;border-radius:9999px;flex:0 0 auto;}`,
  `.ccgui-sa-dot[data-state="active"]{`,
  "background:var(--color-accent-500,#3b82f6);animation:ccgui-sa-breathe 1.6s ease-in-out infinite;}",
  `.ccgui-sa-dot[data-state="done"]{`,
  "background:var(--color-notification-success-foreground,#22c55e);}",
  "@keyframes ccgui-sa-breathe{0%,100%{opacity:1}50%{opacity:.25}}",
  "@media (prefers-reduced-motion:reduce){.ccgui-sa-dot{animation:none !important}}",
  // 浮层清单：钉在被点会话行的正下方（空间不够就翻到行上方）。
  `.${PANEL_CLASS}{`,
  "position:fixed;z-index:2147482000;box-sizing:border-box;",
  "max-height:min(40vh,280px);overflow-y:auto;overscroll-behavior:contain;",
  "padding:4px;border-radius:8px;",
  "border:1px solid var(--color-border-button-default,rgba(128,128,128,.45));",
  "background:var(--color-background-primary-default,#1b1b1b);",
  "box-shadow:0 8px 24px rgba(0,0,0,.28);",
  "font-size:12px;color:var(--color-text-primary,inherit);",
  "font-family:inherit;}",
  `.${PANEL_CLASS} .ccgui-sa-head{`,
  "display:flex;align-items:center;gap:6px;",
  "padding:4px 6px 6px;font-size:11px;",
  "color:var(--color-text-tertiary,rgba(160,160,160,.9));}",
  `.${PANEL_CLASS} ul{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:2px;}`,
  `.${PANEL_CLASS} li{`,
  "display:flex;align-items:center;gap:6px;",
  "padding:4px 6px;border-radius:5px;}",
  `.${PANEL_CLASS} li:hover{background:var(--color-background-tertiary-default,rgba(128,128,128,.14));}`,
  `.${PANEL_CLASS} .ccgui-sa-type{`,
  "flex:0 0 auto;padding:0 5px;border-radius:4px;",
  "background:var(--color-background-tertiary-default,rgba(128,128,128,.18));",
  "font-size:10px;line-height:16px;color:var(--color-text-secondary,inherit);",
  "max-width:96px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}",
  `.${PANEL_CLASS} .ccgui-sa-label{`,
  "flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}",
  `.${PANEL_CLASS} .ccgui-sa-state{`,
  "flex:0 0 auto;font-size:11px;color:var(--color-text-tertiary,rgba(160,160,160,.9));}",
  `.${PANEL_CLASS} .ccgui-sa-state[data-state="active"]{color:var(--color-accent-500,#3b82f6);}`,
  `.${PANEL_CLASS} .ccgui-sa-state[data-state="done"]{`,
  "color:var(--color-notification-success-foreground,#22c55e);}",
].join("");

function injectSelfCss() {
  try {
    if (document.getElementById("ccgui-sa-self-css")) return true;
    const style = document.createElement("style");
    style.id = "ccgui-sa-self-css";
    style.textContent = SELF_CSS;
    (document.head || document.documentElement).appendChild(style);
    return true;
  } catch (_) {
    return false;
  }
}

/* ------------------------------------------------------------------ fiber 工具 */

function getFiber(el) {
  try {
    const keys = Object.keys(el);
    for (let i = 0; i < keys.length; i++) {
      if (keys[i].indexOf("__reactFiber$") === 0) return el[keys[i]];
    }
  } catch (_) {}
  return null;
}

function rootFiber() {
  const el = document.getElementById("root") || document.body;
  try {
    const keys = Object.keys(el);
    for (let i = 0; i < keys.length; i++) {
      if (keys[i].indexOf("__reactContainer$") === 0) {
        const c = el[keys[i]];
        if (c) return c.current || c;
      }
    }
  } catch (_) {}
  try {
    const all = document.getElementsByTagName("*");
    for (let i = 0; i < all.length && i < 4000; i++) {
      const f = getFiber(all[i]);
      if (f) {
        let top = f;
        while (top.return) top = top.return;
        return top;
      }
    }
  } catch (_) {}
  return null;
}

/** 函数组件的 fiber 没有 stateNode；沿子树 BFS 找第一个宿主元素。 */
function fiberToDom(f) {
  const stack = [f];
  let seen = 0;
  while (stack.length && seen < 3000) {
    const x = stack.shift();
    seen++;
    if (x.stateNode && x.stateNode.nodeType === 1) return x.stateNode;
    if (x.child) stack.push(x.child);
    if (x.sibling) stack.push(x.sibling);
  }
  return null;
}

/* ------------------------------------------------------------------ 插件主体 */

export default function activate(ctx) {
  const h = ctx.react.createElement;
  const { useState, useEffect } = ctx.react;

  const cssOk = injectSelfCss();

  let enabled = true;
  let disposed = false;

  /** key = "engine/sessionId" -> { items: Entry[], order: number }
   *  Entry = { uid, label, type, state: "active"|"complete", name, filled } */
  const sessions = new Map();
  /** runId -> key（部分事件 sessionId 为 null，用它兜底，镜像宿主做法） */
  const runRouting = new Map();
  /** 当前展开清单的会话 key（同一时刻只开一个） */
  let openKey = null;

  const diag = {
    sub: "init",
    subErr: "",
    batches: 0,
    events: 0,
    messageEvents: 0,
    agentCalls: 0,
    tracked: 0,
    rowsFound: 0,
    samples: [],
    cssInjected: cssOk,
  };

  /* ---------------- 状态写入 ---------------- */

  function bucket(key) {
    let b = sessions.get(key);
    if (!b) {
      b = { items: [], order: 0 };
      sessions.set(key, b);
    }
    return b;
  }

  function pushEntry(key, entry) {
    const b = bucket(key);
    b.order += 1;
    entry.uid = key + "#" + b.order;
    entry.state = "active";
    entry.at = b.order;
    b.items.push(entry);
    diag.agentCalls += 1;
    return entry;
  }

  /** 参数补全：claude 的 block_start 只给工具名（input 是 {}），真正的
   *  description/subagent_type 要等 block_stop 的 args patch。 */
  function fillPendingArgs(key, name, args) {
    const b = sessions.get(key);
    if (!b) return false;
    for (let i = b.items.length - 1; i >= 0; i--) {
      const it = b.items[i];
      if (it.filled) continue;
      if (it.name !== name) continue;
      const parsed = entriesFromArgs(args, it.label || name);
      // 一次派多个（tasks[]）：占位项展开成多条。
      if (parsed.length > 1 || (args && Array.isArray(args.tasks) && args.tasks.length > 0)) {
        const at = b.items.indexOf(it);
        b.items.splice(at, 1);
        for (const p of parsed) {
          const e = { name, label: p.label, type: p.type, filled: true };
          b.order += 1;
          e.uid = key + "#" + b.order;
          e.state = "active";
          e.at = b.order;
          b.items.splice(at++, 0, e);
        }
        return true;
      }
      const one = parsed[0];
      it.label = one.label || it.label;
      it.type = one.type || it.type;
      it.bg = one.bg;
      it.filled = true;
      return true;
    }
    return false;
  }

  /** 后台 agent 的完成回执：`<task-notification><summary>Agent "X" completed</summary>`
   *  里那段 X 就是派发时的 description，也是面板上显示的那一行，所以拿它当
   *  合并键最稳（引擎事件不带 tool_use id，运行时 agentId 又要等回执才出现）。
   *  带 task-id / tool-use-id 时也一并认，双保险。 */
  function completeFromNotification(text) {
    const ids = notificationIds(text);
    const summary = /<summary>([^<]*)<\/summary>/.exec(text);
    let wanted = null;
    if (summary) {
      // `Agent "Slow background probe" completed` / `Agent「…」已完成`
      const quoted = /Agent\s*[「"“]([^」"”]+)[」"”]/.exec(summary[1]);
      wanted = quoted
        ? quoted[1].trim()
        : summary[1].replace(/^Agent\s+/i, "").replace(/\s*(completed|完成)\s*$/i, "").trim();
      if (!wanted) wanted = null;
    }
    let hit = false;
    for (const b of sessions.values()) {
      for (const it of b.items) {
        if (it.state !== "active") continue;
        const byId = ids.indexOf(it.toolId) >= 0 || ids.indexOf(it.agentId) >= 0;
        const byLabel = Boolean(wanted) && it.label === wanted;
        if (byId || byLabel) {
          it.state = "complete";
          hit = true;
        }
      }
    }
    return hit;
  }

  /** 结果回灌 = 该子代理跑完了。并行同名时只能按「最早的未完成」配对
   *  （引擎事件不带 tool_use id），最终都会收敛到完成。 */
  function completeOne(key, name) {
    const b = sessions.get(key);
    if (!b) return false;
    for (const it of b.items) {
      if (it.state !== "active") continue;
      if (name && it.name !== name) continue;
      it.state = "complete";
      return true;
    }
    return false;
  }

  /** 本轮 done/error 时收尾。后台 agent（run_in_background）不受本轮结束影响：
   *  派发那一刻就返回了回执，宿主本轮 done 时它往往还在跑。 */
  function completeAll(key) {
    const b = sessions.get(key);
    if (!b) return;
    for (const it of b.items) {
      if (it.state === "active" && !it.bg) it.state = "complete";
    }
  }

  /** 后台 agent 的收尾信号：宿主把完成回执塞进队列，下一个轮次开跑才被消费，
   *  而回执本身既不上事件流也不进时间线。可观测的等价信号是「这个会话出现
   *  了另一个 runId 的事件」——说明上一轮（派发后台 agent 的那轮）已经彻底
   *  收尾，后台 agent 也不会再回话了，把它的条目落成已完成。 */
  function markStaleBackground(key, runId) {
    const b = sessions.get(key);
    if (!b) return false;
    let hit = false;
    for (const it of b.items) {
      if (it.state !== "active" || !it.bg) continue;
      if (it.runId && it.runId !== runId) {
        it.state = "complete";
        hit = true;
      }
    }
    return hit;
  }

  function runningCount(b) {
    let n = 0;
    for (const it of b.items) if (it.state === "active") n++;
    return n;
  }

  /* ---------------- 引擎事件 ---------------- */

  function handleEvent(ev) {
    if (!ev || typeof ev !== "object") return;
    diag.events++;
    const engine = typeof ev.engine === "string" ? ev.engine : "";
    const sid = typeof ev.sessionId === "string" && ev.sessionId ? ev.sessionId : null;
    let key = engine && sid ? engine + "/" + sid : null;
    if (key && typeof ev.runId === "string") runRouting.set(ev.runId, key);
    if (!key && typeof ev.runId === "string") key = runRouting.get(ev.runId) || null;
    if (!key) return;

    const kind = String(ev.kind || "");
    const runId = typeof ev.runId === "string" ? ev.runId : null;

    // 后台 agent 的完成回执不会进引擎事件流（宿主把它当 queue-operation /
    // attachment，既不进时间线也不上事件总线）。所以只能等下一个轮次开始：
    // 一旦这个会话出现「不是派发那一轮」的 runId，说明回执已被消费、后台
    // agent 已经收尾。
    if (runId && kind !== "done" && kind !== "error") {
      if (markStaleBackground(key, runId)) schedulePaint();
    }

    if (kind === "done" || kind === "error") {
      if (runId) runRouting.delete(runId);
      completeAll(key);
      schedulePaint();
      return;
    }

    if (kind !== "message") return;
    diag.messageEvents++;

    const data = ev.data;
    if (!data || typeof data !== "object") return;

    // 后台 agent 的完成回执以纯文本投递（<task-notification>…），不是工具行；
    // 扫到就按 agentId / 描述把对应那条收尾。
    if (typeof data.text === "string" && data.text.indexOf("task-notification") >= 0) {
      if (completeFromNotification(data.text)) schedulePaint();
      return;
    }

    if (data.role !== "tool" && data.role !== "tool_result") return;

    const name = str(data.text) || "";
    if (!name) return;
    if (!isSubagentTool(name)) return;

    if (diag.samples.length < 6 && diag.samples.indexOf(name) < 0) diag.samples.push(name);

    // 结果回流（tool_result_patch 带 result）
    if (data.result !== undefined && data.result !== null) {
      const resultText =
        typeof data.result === "string" ? data.result : JSON.stringify(data.result);
      // 后台派发立刻回一条 "Async agent launched successfully"——那是启动回执，
      // 不是完成。记下运行时 agentId（完成通知里带的是它），保持运行中。
      if (resultText.indexOf("Async agent launched") >= 0) {
        const m = /agentId:\s*([A-Za-z0-9_-]+)/.exec(resultText);
        const b = sessions.get(key);
        if (b) {
          for (let i = b.items.length - 1; i >= 0; i--) {
            const it = b.items[i];
            if (it.state !== "active" || it.name !== name) continue;
            it.bg = true;
            if (m) it.agentId = m[1];
            break;
          }
        }
        schedulePaint();
        return;
      }
      if (completeOne(key, name)) schedulePaint();
      return;
    }

    // 参数补全（block_stop 的 args patch）
    if (data.patch === true) {
      if (data.args !== undefined && data.args !== null) {
        fillPendingArgs(key, name, data.args);
        schedulePaint();
        return;
      }
      // 没有 args 也没有 result 的 patch 说明不了什么
      return;
    }

    // 新的一次调用。block_start 时 args 往往还是 {}，先用工具名占位，
    // 等 patch 到了再补 description/type。
    const parsed = entriesFromArgs(
      data.args && typeof data.args === "object" ? data.args : null,
      name,
    );
    for (const p of parsed) {
      pushEntry(key, {
        name,
        label: p.label || name,
        type: p.type,
        bg: p.bg,
        runId,
        filled: parsed.length > 1 || Boolean(p.type || p.label !== name),
      });
    }
    schedulePaint();
  }

  function handleBatch(batch) {
    diag.batches++;
    if (!Array.isArray(batch)) return;
    for (const ev of batch) {
      try {
        handleEvent(ev);
      } catch (_) {
        /* 单条坏事件不影响后续 */
      }
    }
  }

  /* ---------------- 订阅 ---------------- */

  const internals = typeof window !== "undefined" ? window.__TAURI_INTERNALS__ : null;
  let unlisten = null;

  function subscribeAsync() {
    if (disposed) return;
    if (!internals || typeof internals.invoke !== "function" || typeof internals.transformCallback !== "function") {
      diag.sub = "no-internals";
      return;
    }
    let handlerId = null;
    try {
      handlerId = internals.transformCallback((evt) => {
        try {
          handleBatch(evt && evt.payload);
        } catch (_) {}
      }, false);
    } catch (e) {
      diag.sub = "callback-fail";
      diag.subErr = String((e && e.message) || e).slice(0, 160);
      return;
    }
    if (handlerId == null) {
      diag.sub = "callback-fail";
      return;
    }
    diag.sub = "invoking";
    internals
      .invoke("plugin:event|listen", {
        event: EVENT_NAME,
        target: { kind: "Any" },
        handler: handlerId,
      })
      .then((eventId) => {
        if (disposed) {
          try {
            internals.invoke("plugin:event|unlisten", { event: EVENT_NAME, eventId });
          } catch (_) {}
          try {
            internals.unregisterCallback && internals.unregisterCallback(handlerId);
          } catch (_) {}
          return;
        }
        diag.sub = "listening";
        unlisten = () => {
          // disposer 跑在 runAsPlugin 里，invoke 必须推到宏任务。
          setTimeout(() => {
            try {
              internals.invoke("plugin:event|unlisten", { event: EVENT_NAME, eventId });
            } catch (_) {}
          }, 0);
          try {
            internals.unregisterCallback && internals.unregisterCallback(handlerId);
          } catch (_) {}
        };
      })
      .catch((e) => {
        diag.sub = "invoke-fail";
        diag.subErr = String((e && e.message) || e).slice(0, 160);
        try {
          internals.unregisterCallback && internals.unregisterCallback(handlerId);
        } catch (_) {}
      });
  }

  const subscribeTimer = setTimeout(subscribeAsync, 0);

  /* ---------------- 行定位 ---------------- */

  /** key -> 会话行根元素（ThreadItem 的那个 div）。全树扫描很贵（侧栏在流式
   *  期间也在重渲染），所以只在必要时扫，且限速。 */
  let rowCache = new Map();
  let lastScanAt = 0;
  const SCAN_MIN_GAP_MS = 400;

  function scanRows() {
    const found = new Map();
    const root = rootFiber();
    if (root) {
      const stack = [root];
      let seen = 0;
      while (stack.length && seen < 60000) {
        const f = stack.pop();
        seen++;
        try {
          const p = f.memoizedProps;
          if (
            p &&
            typeof p === "object" &&
            typeof p.onSelect === "function" &&
            typeof p.id === "string" &&
            p.id.indexOf("/") > 0
          ) {
            const dom = fiberToDom(f);
            if (dom) found.set(p.id, dom);
          }
        } catch (_) {}
        if (f.child) stack.push(f.child);
        if (f.sibling) stack.push(f.sibling);
      }
    }
    rowCache = found;
    lastScanAt = Date.now();
    diag.rowsFound = found.size;
    return found;
  }

  function liveRow(key) {
    const el = rowCache.get(key);
    if (el && el.isConnected) return el;
    return null;
  }

  /** 一次绘制只扫一次；行可能被 React 换掉（虚拟/重渲染），扫完仍找不到就
   *  说明这个会话此刻不可见（工作区折叠 / 滚出视野），等下一轮。 */
  function ensureRows() {
    if (Date.now() - lastScanAt < SCAN_MIN_GAP_MS) return false;
    scanRows();
    return true;
  }

  /* ---------------- 胶囊 ---------------- */

  const pills = new Map(); // key -> pill element

  function makePill(key) {
    const pill = document.createElement("span");
    pill.className = PILL_CLASS;
    pill.setAttribute("role", "button");
    pill.setAttribute("tabindex", "0");
    pill.dataset.key = key;
    const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    icon.setAttribute("viewBox", "0 0 16 16");
    icon.setAttribute("fill", "none");
    icon.setAttribute("aria-hidden", "true");
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", "M5 3v5.5a2 2 0 0 0 2 2h4M5 3a1.4 1.4 0 1 0 0 .01M11 8.5a1.4 1.4 0 1 0 0 .01");
    path.setAttribute("stroke", "currentColor");
    path.setAttribute("stroke-width", "1.3");
    path.setAttribute("stroke-linecap", "round");
    icon.appendChild(path);
    const dot = document.createElement("i");
    dot.className = "ccgui-sa-dot";
    const count = document.createElement("span");
    count.className = "ccgui-sa-count";
    pill.appendChild(dot);
    pill.appendChild(icon);
    pill.appendChild(count);
    const onToggle = (e) => {
      e.preventDefault();
      e.stopPropagation();
      togglePanel(key);
    };
    pill.addEventListener("click", onToggle);
    pill.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") onToggle(e);
    });
    // 行本身的点击会切换会话——胶囊自己吃掉指针事件，别让冒泡过去。
    pill.addEventListener("mousedown", (e) => e.stopPropagation());
    return pill;
  }

  function syncPill(key, rowEl, bucket) {
    let pill = pills.get(key);
    if (!pill) {
      pill = makePill(key);
      pills.set(key, pill);
    }
    if (pill.parentElement !== rowEl) {
      try {
        rowEl.appendChild(pill);
      } catch (_) {
        return;
      }
    }
    const total = bucket.items.length;
    const running = runningCount(bucket);
    const dot = pill.querySelector(".ccgui-sa-dot");
    const count = pill.querySelector(".ccgui-sa-count");
    if (dot) dot.dataset.state = running > 0 ? "active" : "done";
    if (count) count.textContent = running > 0 ? running + "/" + total : total + "/" + total;
    pill.title =
      running > 0
        ? "子代理 " + running + " 个运行中，共 " + total + " 个（点击展开）"
        : "子代理 " + total + " 个，已全部完成（点击展开）";
    pill.dataset.open = openKey === key ? "1" : "0";
  }

  function dropPill(key) {
    const pill = pills.get(key);
    if (!pill) return;
    try {
      if (pill.parentElement) pill.parentElement.classList.remove(ROW_CLASS);
      pill.remove();
    } catch (_) {}
    pills.delete(key);
  }

  /* ---------------- 浮层清单 ---------------- */

  let panelEl = null;
  let panelKey = null;
  let rafToken = 0;

  function buildPanel() {
    const panel = document.createElement("div");
    panel.className = PANEL_CLASS;
    panel.setAttribute("role", "dialog");
    panel.dataset.plugin = NS;
    // 面板里的点击不要穿到宿主的行/遮罩上。
    panel.addEventListener("mousedown", (e) => e.stopPropagation());
    panel.addEventListener("click", (e) => e.stopPropagation());
    document.body.appendChild(panel);
    return panel;
  }

  function renderPanel(key) {
    if (!panelEl) panelEl = buildPanel();
    const bucket = sessions.get(key);
    if (!bucket) {
      closePanel();
      return;
    }
    panelEl.textContent = "";
    const total = bucket.items.length;
    const running = runningCount(bucket);
    const head = document.createElement("div");
    head.className = "ccgui-sa-head";
    head.textContent =
      running > 0 ? "子代理 · " + running + " 个运行中 / 共 " + total : "子代理 · 共 " + total + " 个";
    panelEl.appendChild(head);
    const ul = document.createElement("ul");
    for (const it of bucket.items) {
      const li = document.createElement("li");
      const dot = document.createElement("i");
      dot.className = "ccgui-sa-dot";
      dot.dataset.state = it.state === "active" ? "active" : "done";
      li.appendChild(dot);
      if (it.type) {
        const type = document.createElement("span");
        type.className = "ccgui-sa-type";
        type.textContent = it.type;
        type.title = it.type;
        li.appendChild(type);
      }
      const label = document.createElement("span");
      label.className = "ccgui-sa-label";
      label.textContent = it.label || it.name || "子代理";
      label.title = label.textContent;
      li.appendChild(label);
      const state = document.createElement("span");
      state.className = "ccgui-sa-state";
      state.dataset.state = it.state === "active" ? "active" : "done";
      state.textContent = it.state === "active" ? "运行中" : "已完成";
      li.appendChild(state);
      ul.appendChild(li);
    }
    panelEl.appendChild(ul);
    panelKey = key;
    positionPanel();
  }

  function positionPanel() {
    if (!panelEl || !panelKey) return;
    const rowEl = liveRow(panelKey);
    if (!rowEl) {
      closePanel();
      return;
    }
    const r = rowEl.getBoundingClientRect();
    // 宽度对齐会话行（侧栏窄，行宽基本就是可视宽度）。
    const width = Math.max(180, Math.min(r.width, 420));
    panelEl.style.width = width + "px";
    panelEl.style.left = Math.round(r.left + Math.min(8, Math.max(0, r.width - width))) + "px";
    const panelH = panelEl.offsetHeight || 120;
    const spaceBelow = window.innerHeight - r.bottom;
    if (spaceBelow < panelH + 12 && r.top > panelH + 12) {
      panelEl.style.top = Math.round(r.top - panelH - 4) + "px";
    } else {
      panelEl.style.top = Math.round(r.bottom + 4) + "px";
    }
  }

  function tick() {
    if (disposed || !panelEl || !panelKey) return;
    positionPanel();
    rafToken = requestAnimationFrame(tick);
  }

  function openPanel(key) {
    openKey = key;
    renderPanel(key);
    cancelAnimationFrame(rafToken);
    rafToken = requestAnimationFrame(tick);
    const pill = pills.get(key);
    if (pill) pill.dataset.open = "1";
  }

  function closePanel() {
    openKey = null;
    panelKey = null;
    cancelAnimationFrame(rafToken);
    rafToken = 0;
    if (panelEl) {
      try {
        panelEl.remove();
      } catch (_) {}
      panelEl = null;
    }
    for (const [k, pill] of pills) {
      if (pill && pill.dataset) pill.dataset.open = "0";
      void k;
    }
  }

  function togglePanel(key) {
    if (openKey === key) closePanel();
    else openPanel(key);
  }

  // 点面板/胶囊以外的地方就收起。
  function onDocumentDown(e) {
    if (!panelKey) return;
    const t = e.target;
    if (panelEl && panelEl.contains(t)) return;
    for (const pill of pills.values()) {
      if (pill === t || (pill.contains && pill.contains(t))) return;
    }
    closePanel();
  }
  document.addEventListener("mousedown", onDocumentDown, true);

  // Esc 收起（跟随宿主浮层的惯例）。
  function onKeyDown(e) {
    if (e.key === "Escape" && panelKey) {
      e.stopPropagation();
      closePanel();
    }
  }
  document.addEventListener("keydown", onKeyDown, true);

  // 侧栏滚动/窗口尺寸变化时，胶囊跟着行走（它在行内，天然跟随），
  // 面板由 rAF 负责；滚动到底行消失时把面板一起收掉。
  function onScroll() {
    if (!panelKey) return;
    if (!liveRow(panelKey)) closePanel();
  }
  window.addEventListener("scroll", onScroll, true);
  window.addEventListener("resize", onScroll);

  /* ---------------- 绘制 ---------------- */

  let paintQueued = false;

  function schedulePaint() {
    if (paintQueued) return;
    paintQueued = true;
    requestAnimationFrame(() => {
      paintQueued = false;
      paint();
    });
  }

  function paint() {
    if (disposed) return;
    if (!enabled) {
      for (const key of Array.from(pills.keys())) dropPill(key);
      if (panelKey) closePanel();
      return;
    }
    diag.tracked = sessions.size;

    // 没有数据的会话：确保没挂着旧胶囊
    for (const key of Array.from(pills.keys())) {
      if (!sessions.has(key) || sessions.get(key).items.length === 0) dropPill(key);
    }

    const wanted = [];
    for (const [key, bucket] of sessions) {
      if (bucket.items.length === 0) continue;
      wanted.push([key, bucket]);
    }
    if (wanted.length === 0) return;

    // 行缓存失效（React 重渲染换掉了行元素）时才重扫，且限速。
    let needScan = false;
    for (const [key] of wanted) {
      if (!liveRow(key)) {
        needScan = true;
        break;
      }
    }
    if (needScan) ensureRows();

    for (const [key, bucket] of wanted) {
      const rowEl = liveRow(key);
      if (!rowEl) continue; // 行此刻不可见（折叠/滚出视野），保留数据等下一轮
      syncPill(key, rowEl, bucket);
    }

    // 展开的清单随数据更新（状态/描述是持续变的）
    if (panelKey) {
      if (!sessions.has(panelKey)) closePanel();
      else renderPanel(panelKey);
    }
  }

  // 行元素会被 React 重渲染换掉、胶囊跟着没了；用低频看门狗补回来。
  // 不用 MutationObserver：侧栏流式期间 DOM 变化极频繁，全树 fiber 重扫扛不住。
  let watchdog = 0;
  function startWatchdog() {
    if (watchdog) return;
    watchdog = setInterval(() => {
      if (disposed) return;
      if (!enabled || sessions.size === 0) return;
      let missing = false;
      for (const pill of pills.values()) {
        if (!pill.isConnected) {
          missing = true;
          break;
        }
      }
      if (missing || (panelKey && !liveRow(panelKey))) schedulePaint();
    }, 1200);
  }
  startWatchdog();

  /* ---------------- 设置页 ---------------- */

  function Settings() {
    const [on, setOn] = useState(enabled);
    const [tick, setTick] = useState(0);
    useEffect(() => {
      ctx.storage.get("enabled").then((v) => {
        const val = typeof v === "boolean" ? v : true;
        setOn(val);
        enabled = val;
        paint();
      });
      const iv = setInterval(() => setTick((t) => t + 1), 800);
      return () => clearInterval(iv);
    }, []);
    void tick;

    const toggle = (val) => {
      setOn(val);
      enabled = val;
      void ctx.storage.set("enabled", val);
      paint();
    };

    const mono = {
      fontFamily: "ui-monospace,Consolas,monospace",
      fontSize: 11.5,
      lineHeight: 1.55,
      background: "rgba(128,128,128,.10)",
      borderRadius: 8,
      padding: "8px 10px",
      marginTop: 10,
      whiteSpace: "pre-wrap",
      wordBreak: "break-all",
      maxHeight: 240,
      overflowY: "auto",
    };

    const tracked = Array.from(sessions.entries())
      .filter(([, b]) => b.items.length > 0)
      .map(([k, b]) => k + " → " + runningCount(b) + "/" + b.items.length);

    return h(
      "div",
      { style: { padding: "4px 2px", maxWidth: 560 } },
      h(
        "label",
        { style: { display: "flex", alignItems: "center", gap: 8, cursor: "pointer", fontSize: 14 } },
        h("input", {
          type: "checkbox",
          checked: on,
          onChange: (e) => toggle(e.target.checked),
        }),
        "会话行右侧显示子代理运行计数（点胶囊展开清单）",
      ),
      h(
        "div",
        { style: { fontSize: 12, marginTop: 6, opacity: 0.7 } },
        "只统计本次打开 GUI 期间从引擎事件里看到的子代理调用；重启后清零，不读历史文件。",
      ),
      h(
        "div",
        { style: mono },
        "订阅: " + diag.sub + (diag.subErr ? "  [" + diag.subErr + "]" : "") + "\n" +
          "样式自注入: " + (diag.cssInjected ? "OK" : "失败") + "\n" +
          "批次/事件: " + diag.batches + " / " + diag.events +
          "   message/工具行: " + diag.messageEvents + "   子代理调用: " + diag.agentCalls + "\n" +
          "识别的工具名: " + (diag.samples.length ? diag.samples.join(" | ") : "(还没遇到)") + "\n" +
          "跟踪中的会话: " + (tracked.length ? tracked.join("  |  ") : "(无)") + "\n" +
          "扫到的会话行: " + diag.rowsFound,
      ),
    );
  }

  const disposeSettings = ctx.ui.registerSettingsSection({
    label: () => "会话子代理计数",
    component: Settings,
  });
  void disposeSettings;

  // 启动即接管已存在的行（哪怕没有事件，也要把之前的胶囊摘干净）。
  schedulePaint();

  /* ---------------- 卸载 ---------------- */

  return () => {
    disposed = true;
    clearTimeout(subscribeTimer);
    try {
      if (typeof unlisten === "function") unlisten();
    } catch (_) {}
    document.removeEventListener("mousedown", onDocumentDown, true);
    document.removeEventListener("keydown", onKeyDown, true);
    window.removeEventListener("scroll", onScroll, true);
    window.removeEventListener("resize", onScroll);
    clearInterval(watchdog);
    cancelAnimationFrame(rafToken);
    closePanel();
    for (const key of Array.from(pills.keys())) dropPill(key);
    try {
      const style = document.getElementById("ccgui-sa-self-css");
      if (style) style.remove();
    } catch (_) {}
  };
}
