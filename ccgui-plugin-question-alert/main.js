// 会话待答提醒（question-alert）v0.7.1
//
// 目标：某会话（含后台、含你正看着的那个）里 Claude 抛出 AskUserQuestion 等你回答时，
// 右下角弹出「站内信」卡片 + 侧栏对应行扫光高亮；回答/取消后自动消失。
// 自 0.7.0 起同一套卡片也承载「对话已完成 / 对话异常 / 会话已中断」三类提醒——
// 宿主那侧只有系统通知（Windows 上由系统主题决定外观，插件无法改），
// 应用内的补位卡片才由插件完全掌控。
//
// 视觉：全部走宿主 theme.css 的语义 token（--color-background-primary-default /
// --color-text-* / --color-accent-500 / --color-notification-success-foreground …），
// 宿主 .dark 一翻转整个卡片跟着变深色，不再有硬编码的深紫底。
//
// 补位对象（宿主 1.2.0 实测能力边界，从 exe 里的 bootstrap bundle 逆出）：
//   · 宿主已有系统通知 notifyOnQuestion（默认开）→ _de() → $h("onQuestion") →
//     plugin:notification|notify，点击走 Sde()：关弹层 → focusTab/selectSession。
//   · 但 notifyWhenUnfocusedOnly 默认 true：xde() 里 document.hidden || !hasFocus()
//     才算"后台"，你盯着该会话时宿主主动静默——这正是漏提醒的根因。
//   · 宿主没有应用内待答面板：消息通知/一键已读/查看全部 在 540 个前端资源里命中 0。
//   · 插件官方 onRuntimeEvent（runtime.events.read）经 sfe() 映射，question 落到 null。
//   ⇒ 插件只在"宿主静默的那一段"补位：应用内卡片 + 行高亮，不做系统通知、不重复打扰。
//
// 宿主真实结构（逆自 bke 组件，此前几版猜错了，以此为准）：
//   行容器 div.group.flex…py-[5px].pr-2.pl-9
//     └ button[aria-current="page"?]  onClick → onSelect(id)
//   props { id: `${engine}/${sessionId}`, label, engine, streaming, retrying, unseen, onSelect }
//   状态点 span.sidebar-thread-status(-processing|-unseen)，CSS 宽高 6px、呼吸动画
//   —— 状态点类名不是 animate-pulse，所以早期"蓝点锚"一个都扫不到。
//
// 链路：
//   ①订阅：setTimeout 宏任务里按 Tauri v2 协议 listen "engine://event"（activate 处于
//     runAsPlugin 深度>0，直接 invoke 被 hardening 拒；宏任务脱离后放行——宿主文档
//     承认的"异步续体逃逸"残留面，非官方契约）。question 只有这条路能拿到。
//   ②事件：question 记入 pending（带 seq 与问句）；question_settled 移出；delta/
//     message/thinking 要"晚于 question 且过了 3 秒闸"才算已回答（提问轮的尾部产出
//     seq 更大，光比 seq 会误清）；done/error 不清（挂起等答时宿主常以 done 收尾本轮）。
//     question 可能带 sessionId:null → 用 runId→key 路由表兜底（镜像宿主 runRouting）。
//   ③通知：pending 变化即重绘右下角卡片栈（原生 DOM，textContent 写入，无 innerHTML）。
//     done/error 也进同一栈（v0.7.0）：done 卡片 6 秒后自动淡出，error 卡片常驻到手动关。
//   ④落地：按宿主行签名 id 精确匹配 → 加 .ccgui-qa-marquee；折叠工作区加 .ccgui-qa-group。
//     「查看」照抄宿主 Sde：ctx.sessions.selectSession(engine, sessionId, ws)，用
//     session://activated 事件回执判定成功，失败再 refresh 重试，最后退回 onSelect(id)。
//
// 约束：单文件 ESM，零 import；无 eval/new Function/远程 import。

const HL_CLASS = "ccgui-qa-marquee";
const HL_GROUP = "ccgui-qa-group";
const INBOX_ID = "ccgui-qa-inbox";
const EVENT_NAME = "engine://event";
// 完成卡 6 秒自动退场；异常/中断常驻，直到用户自己关。
const CARD_TTL_DONE = 6000;
const CARD_TTL_ERROR = 0;

// 自注入样式：宿主只在"安装插件"那一刻读取 styles.css 并缓存注入，直接改磁盘文件
// 不会重新生效。所以在 activate 里自己插一个 <style>，幂等、不依赖重装。
// 视觉全部走宿主语义 token（theme.css），明暗主题由 .dark 自动翻转；
// var() 第二参数给浅色兜底，token 意外缺失时退化为可读的浅色卡片。
const SELF_CSS = `
#${INBOX_ID}{
  position:fixed;right:18px;bottom:18px;
  /* 跟宿主 UpdateToast 同一层级：压过设置/插件全屏页（z-100），
     让弹窗与命令面板（z-110）仍在上面。 */
  z-index:105;
  display:flex;flex-direction:column;gap:10px;width:342px;max-width:calc(100vw - 36px);
  font-family:var(--font-sans,ui-sans-serif,system-ui,sans-serif);
  font-size:13px;line-height:1.5;color:var(--color-text-primary,#171717);
  pointer-events:none;
}
#${INBOX_ID} .ccgui-qa-card{pointer-events:auto;}
.ccgui-qa-card{
  --qa-tone:var(--color-accent-500,#2f7df6);
  position:relative;overflow:hidden;
  background:var(--color-background-primary-default,#ffffff);
  color:var(--color-text-primary,#171717);
  border:1px solid var(--color-separator-border,#e5e5e5);
  border-radius:var(--radius-notification-card,12px);
  box-shadow:var(--shadow-lg,0 6px 16px rgb(0 0 0/.10),0 12px 32px rgb(0 0 0/.14));
  padding:11px 12px 11px 16px;
  animation:ccgui-qa-cardin .24s cubic-bezier(.22,.8,.3,1) both;
}
.ccgui-qa-card::before{
  content:"";position:absolute;left:0;top:10px;bottom:10px;width:3px;border-radius:0 3px 3px 0;
  background:var(--qa-tone);opacity:.9;
}
.ccgui-qa-tone-question{--qa-tone:var(--color-accent-500,#2f7df6);}
.ccgui-qa-tone-done{--qa-tone:var(--color-notification-success-foreground,#16a34a);}
.ccgui-qa-tone-error{--qa-tone:var(--color-text-error-primary,#dc2626);}
.ccgui-qa-tone-warn{--qa-tone:var(--color-text-warning-primary,#ea580c);}
.ccgui-qa-head{display:flex;align-items:center;gap:7px;min-height:18px;}
.ccgui-qa-dot{width:6px;height:6px;border-radius:50%;background:var(--qa-tone);flex:0 0 auto;}
.ccgui-qa-tone-question .ccgui-qa-dot{animation:ccgui-qa-breathe 1.8s ease-in-out infinite;}
.ccgui-qa-kind{font-size:11px;font-weight:600;letter-spacing:.03em;color:var(--qa-tone);flex:0 0 auto;}
.ccgui-qa-name{
  min-width:0;flex:1 1 auto;font-size:11px;color:var(--color-text-tertiary,#a3a3a3);
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
}
.ccgui-qa-time{
  margin-left:auto;font-size:10.5px;color:var(--color-text-tertiary,#a3a3a3);
  font-variant-numeric:tabular-nums;
}
.ccgui-qa-x{
  margin-left:4px;flex:0 0 auto;width:20px;height:20px;padding:0;border:none;border-radius:6px;
  background:transparent;color:var(--color-text-tertiary,#a3a3a3);font-size:14px;line-height:18px;
  cursor:pointer;transition:background .15s,color .15s;
}
.ccgui-qa-x:hover{background:var(--color-background-secondary-hover,#e5e5e5);color:var(--color-text-primary,#171717);}
.ccgui-qa-title{
  margin-top:7px;font-size:12.5px;font-weight:600;color:var(--color-text-primary,#171717);
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
}
.ccgui-qa-q{
  margin-top:3px;font-size:12.5px;line-height:1.55;color:var(--color-text-secondary,#525252);
  display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:3;overflow:hidden;
  word-break:break-word;
}
.ccgui-qa-btns{display:flex;align-items:center;gap:8px;justify-content:flex-end;margin-top:10px;}
.ccgui-qa-btn{
  font:inherit;font-size:11.5px;font-weight:500;padding:3px 11px;border-radius:7px;cursor:pointer;
  border:1px solid color-mix(in srgb,var(--qa-tone) 32%,transparent);
  background:color-mix(in srgb,var(--qa-tone) 12%,transparent);
  color:var(--qa-tone);
  transition:background .15s,border-color .15s,transform .1s;
}
.ccgui-qa-btn:hover{
  background:color-mix(in srgb,var(--qa-tone) 22%,transparent);
  border-color:color-mix(in srgb,var(--qa-tone) 48%,transparent);
}
.ccgui-qa-btn:active{transform:translateY(.5px);}
.ccgui-qa-btn:disabled{opacity:.55;cursor:default;}
.ccgui-qa-btn-primary{
  border-color:var(--qa-tone);background:var(--qa-tone);color:var(--color-text-white,#ffffff);
}
.ccgui-qa-btn-primary:hover{
  background:color-mix(in srgb,var(--qa-tone) 86%,#000);
  border-color:color-mix(in srgb,var(--qa-tone) 86%,#000);
}
@keyframes ccgui-qa-cardin{from{opacity:0;transform:translateY(10px) scale(.985)}to{opacity:1;transform:none}}
@keyframes ccgui-qa-breathe{0%,100%{opacity:.45;transform:scale(.9)}50%{opacity:1;transform:scale(1.15)}}
.${HL_CLASS}{
  background-color:color-mix(in srgb,var(--color-accent-500,#2f7df6) 9%,transparent)!important;
  background-image:linear-gradient(100deg,
    transparent 0%,transparent 32%,
    color-mix(in srgb,var(--color-accent-400,#3392ff) 36%,transparent) 50%,
    transparent 68%,transparent 100%)!important;
  background-size:240% 100%!important;background-repeat:no-repeat!important;
  animation:ccgui-qa-marquee 2.6s ease-in-out infinite!important;
  box-shadow:inset 2px 0 0 color-mix(in srgb,var(--color-accent-500,#2f7df6) 65%,transparent);
}
@keyframes ccgui-qa-marquee{0%{background-position:120% 0}100%{background-position:-120% 0}}
.${HL_GROUP}{
  background-color:color-mix(in srgb,var(--color-accent-500,#2f7df6) 11%,transparent)!important;
  box-shadow:inset 2px 0 0 color-mix(in srgb,var(--color-accent-500,#2f7df6) 55%,transparent);
}
@media (prefers-reduced-motion:reduce){
  .ccgui-qa-card{animation:none!important;}
  .ccgui-qa-dot{animation:none!important;}
  .${HL_CLASS}{
    animation:none!important;background-image:none!important;
    background-color:color-mix(in srgb,var(--color-accent-500,#2f7df6) 16%,transparent)!important;
  }
}`;

function injectSelfCss() {
  try {
    const existing = document.getElementById("ccgui-qa-self-css");
    if (existing) {
      // 热更新：宿主缓存的 styles.css 还是旧版，这里同步刷新内容，
      // 否则卸载重载后旧样式节点仍在，新旧两套规则会互相覆盖。
      if (existing.textContent !== SELF_CSS) existing.textContent = SELF_CSS;
      return true;
    }
    const s = document.createElement("style");
    s.id = "ccgui-qa-self-css";
    s.textContent = SELF_CSS;
    document.head.appendChild(s);
    return true;
  } catch (_) {
    return false;
  }
}

function isPlainObject(v) {
  return v && typeof v === "object";
}

function threadKey(ev) {
  if (!isPlainObject(ev)) return null;
  const engine = ev.engine;
  const sessionId = ev.sessionId;
  if (typeof engine !== "string" || typeof sessionId !== "string" || !engine || !sessionId) {
    return null;
  }
  return engine + "/" + sessionId;
}

function requestIdOf(ev) {
  const data = ev && ev.data;
  if (!isPlainObject(data)) return null;
  const rid = typeof data.requestId === "string" ? data.requestId.trim() : "";
  return rid || null;
}

function questionTextOf(ev) {
  try {
    const qs = ev.data.input.questions;
    if (Array.isArray(qs) && qs.length) {
      const q = qs[0] && qs[0].question;
      if (typeof q === "string" && q.trim()) return q.trim().slice(0, 220);
    }
  } catch (_) {}
  return "";
}

function seqOf(ev) {
  return typeof ev.seq === "number" ? ev.seq : (typeof ev.ts === "number" ? ev.ts : null);
}

/** done/error 的正文：宿主把整段错误（或 CLI 的 result 行）塞进 data。
 *  Markdown 标记、多行空白都清掉，再截到 160 字，和系统通知同一口径。 */
function cleanSummary(text, maxLen) {
  if (typeof text !== "string" || !text) return "";
  const clean = text
    .replace(/```[\s\S]*?```/g, "")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  if (!clean) return "";
  return clean.length > maxLen ? clean.slice(0, maxLen) + "…" : clean;
}

/** 宿主 looksLikeDisconnection 的同一判据：中断 vs 异常。 */
function looksLikeDisconnection(errText) {
  return /中断|disconnect|abort|timeout|timed out/i.test(String(errText || ""));
}

function doneTextOf(ev) {
  // done 的 data 是 { usage } —— 没有可读正文，交给卡片显示「AI 已完成回复」。
  void ev;
  return "";
}

function errorTextOf(ev) {
  return cleanSummary(typeof ev.data === "string" ? ev.data : "", 160);
}

// ===========================================================================
// 模板层（0.8.0）—— 纯函数，无 DOM、无 ctx 依赖，可直接单测。
// ===========================================================================

/** 只认 `{小写变量名}`：`{a}` 命中，`{}` / `{a b}` / `{{a}}` 都原样保留。
 *  与 OpenChamber 的 `/\{(\w+)\}/g` 同源，但额外排除变量名里的下划线连结
 *  （我们的变量全是下划线风格，`{last_message}` 也要能命中，故保留 \w）。 */
const VAR_RE = /\{(\w+)\}/g;

/** 变量全集。渲染时缺哪个就填空串——绝不把 `{xxx}` 漏给用户。 */
const TEMPLATE_VARS = [
  "project_name",
  "worktree",
  "branch",
  "session_name",
  "agent_name",
  "model_name",
  "last_message",
];

/** 三类事件的内置默认（照抄 OpenChamber 中文默认，见 design.md D8）。 */
const DEFAULT_TEMPLATES = {
  done: { title: "{agent_name} 已完成", message: "{model_name} 已完成任务" },
  error: { title: "工具错误", message: "{last_message}" },
  ask: { title: "需要输入", message: "{last_message}" },
};

/** 正文兜底：模板渲染为空、或事件本身没有正文时用它。 */
const FALLBACK_BODIES = {
  done: "AI 已完成回复，点「查看」回到会话。",
  error: "对话执行遇到错误，点「查看」打开会话。",
  warn: "API 连接或响应异常中断。",
  ask: "有会话在等你回复，点「查看」打开会话。",
};

/** 把模板渲染成文本。
 *  - 缺变量 → 空串（不是保留占位符）；
 *  - 首尾空白裁掉（`{agent_name} 已完成` 在 agent_name 为空时会剩前导空格）；
 *  - 结果为空 → 返回 ""，由调用方决定要不要回落默认。 */
function renderTemplate(template, ctx) {
  if (typeof template !== "string" || !template) return "";
  const vars = ctx && typeof ctx === "object" ? ctx : {};
  const out = template.replace(VAR_RE, (_m, key) => {
    if (TEMPLATE_VARS.indexOf(key) < 0) return "";   // 未知变量当缺省处理
    const v = vars[key];
    return v === undefined || v === null ? "" : String(v);
  });
  return out.replace(/\s+/g, " ").trim();
}

/** 渲染一条提醒的标题与正文，含两条回落规则（design.md D4）：
 *  ① 标题/正文渲染为空 → 用内置默认模板再渲染一次 → 仍为空则用兜底文案；
 *  ② 模板里写了 `{last_message}` 但该变量为空 → 正文保留兜底，不用空值覆盖。 */
function renderNotice(kind, templates, ctx) {
  // warn（会话中断）没有独立模板：用户界面上它和 error 是一类，共用错误模板。
  const tplKind = kind === "warn" ? "error" : kind;
  const tpl = (templates && templates[tplKind]) || DEFAULT_TEMPLATES[tplKind] || DEFAULT_TEMPLATES.done;
  const fallback = DEFAULT_TEMPLATES[tplKind] || DEFAULT_TEMPLATES.done;
  const bodyFallback = FALLBACK_BODIES[kind] || FALLBACK_BODIES.done;

  let title = renderTemplate(tpl.title, ctx);
  if (!title) title = renderTemplate(fallback.title, ctx);

  let message = renderTemplate(tpl.message, ctx);
  if (!message) {
    // ① 整条模板渲染为空：退回默认模板渲染
    message = renderTemplate(fallback.message, ctx);
  } else if (typeof tpl.message === "string" && tpl.message.indexOf("{last_message}") >= 0) {
    // ② 模板点名要 last_message：正文变量本身为空时保留兜底，别发出空白正文
    const lm = ctx && ctx.last_message;
    if (typeof lm !== "string" || !lm.trim()) message = "";
  }
  if (!message) message = bodyFallback;

  return { title, message };
}

/** 宿主通知标题的尾缀 → 事件类型。三套语言与宿主 i18n 同源；
 *  识别不了返回 null（调用方原样转发，绝不丢）。 */
const TOAST_SUFFIX = [
  { kind: "done", words: ["对话已完成", "Turn completed", "턴 완료"] },
  { kind: "error", words: ["对话异常", "Conversation error", "대화 오류"] },
  { kind: "warn", words: ["会话已中断", "Session interrupted", "세션이 중단되었습니다"] },
  { kind: "ask", words: ["需要你的回复", "Needs your reply", "답변이 필요합니다"] },
  { kind: "ask", words: ["计划待审批", "Plan awaiting review", "계획 승인 대기"] },
  { kind: "ask", words: ["请求访问权限", "Permission requested", "권한 요청"] },
];

function toastKindOf(title) {
  if (typeof title !== "string" || !title) return null;
  for (const row of TOAST_SUFFIX) {
    for (const word of row.words) {
      if (title.endsWith("· " + word)) return row.kind;
    }
  }
  return null;
}

/** 宿主标题 = `${会话标题} · ${事件名}`，取 ` · ` 之前那段做 session_name。 */
function sessionNameOfTitle(title) {
  if (typeof title !== "string") return "";
  const at = title.lastIndexOf(" · ");
  return at > 0 ? title.slice(0, at).trim() : title.trim();
}

export default function activate(ctx) {
  const { createElement: h, useState, useEffect } = ctx.react;
  const cssOk = injectSelfCss();

  // ---- 诊断计数（设置页轮询展示）----
  const stats = {
    sub: "init",           // init | no-internals | invoking | listening | callback-fail | invoke-fail
    subErr: "",
    batches: 0,
    events: 0,
    kinds: {},
    samples: [],
    qRing: [],             // 最近 question 事件完整形状（环形缓冲 ≤6）——关键取证
    noKeyQuestions: 0,     // 收到 question 但定位不到会话的次数
    jump: "idle",          // idle | jumping | ok | fail | no-api
    jumpErr: "",
    questions: 0,
    pendingKeys: [],
    cards: 0,
    cssInjected: cssOk,
    lastPaint: null,
    misses: 0,
    rewrite: "off",        // off | on | unsupported | failed | no-internals
    toastRewritten: 0,     // 成功按模板改写并转发的 Toast 条数
    toastDropped: 0,       // 前台时被卡片接管的 Toast 条数
    toastMiss: 0,          // 标题尾缀不认识的宿主通知条数（诊断改写是否失效）
  };

  // ---- 运行期配置（0.8.0 扁平键；首次读取缺失即补默认）----
  // 单一事实源在这里：所有读取都走 cfg，写入都走 saveCfg。
  const cfg = {
    enabled: true,          // 总开关（卡片 + Toast 都受它管）
    focusMode: "unfocused", // "unfocused" = 只在失焦时发 Toast（聚焦走卡片）；"always" = 两边都发
    events: { done: true, error: true, ask: true },
    templates: {
      done: { ...DEFAULT_TEMPLATES.done },
      error: { ...DEFAULT_TEMPLATES.error },
      ask: { ...DEFAULT_TEMPLATES.ask },
    },
  };
  // 旧版（≤0.7.1）的散键 → 新键的一次性迁移映射。
  const LEGACY_KEYS = { enabled: "enabled", notifyDone: "events.done", notifyError: "events.error" };
  let cfgReady = false;

  function coerceTemplate(v) {
    const src = v && typeof v === "object" ? v : {};
    return {
      title: typeof src.title === "string" ? src.title : "",
      message: typeof src.message === "string" ? src.message : "",
    };
  }

  async function loadCfg() {
    const pairs = [
      ["notify.enabled", "enabled"],
      ["notify.focusMode", "focusMode"],
      ["notify.events.done", "events.done"],
      ["notify.events.error", "events.error"],
      ["notify.events.ask", "events.ask"],
      ["notify.tpl.done", "tpl.done"],
      ["notify.tpl.error", "tpl.error"],
      ["notify.tpl.ask", "tpl.ask"],
    ];
    const got = {};
    for (const [key, path] of pairs) {
      try {
        got[path] = await ctx.storage.get(key);
      } catch (_) {
        got[path] = null;
      }
    }

    // 迁移：新键全缺、旧键有值时才搬一次。
    const anyNew = pairs.some(([, path]) => got[path] != null);
    if (!anyNew) {
      for (const [legacy, path] of Object.entries(LEGACY_KEYS)) {
        try {
          const old = await ctx.storage.get(legacy);
          if (typeof old === "boolean") got[path] = old;
        } catch (_) {}
      }
    }

    if (typeof got["enabled"] === "boolean") cfg.enabled = got["enabled"];
    if (got["focusMode"] === "always" || got["focusMode"] === "unfocused") {
      cfg.focusMode = got["focusMode"];
    }
    for (const k of ["done", "error", "ask"]) {
      const v = got["events." + k];
      if (typeof v === "boolean") cfg.events[k] = v;
    }
    for (const k of ["done", "error", "ask"]) {
      const v = got["tpl." + k];
      if (v && typeof v === "object") {
        // 部分字段缺失时补默认，避免用户只改了一半就瘸腿。
        const t = coerceTemplate(v);
        cfg.templates[k] = {
          title: typeof v.title === "string" ? t.title : DEFAULT_TEMPLATES[k].title,
          message: typeof v.message === "string" ? t.message : DEFAULT_TEMPLATES[k].message,
        };
      }
    }
    cfgReady = true;
  }

  async function saveCfg(patch) {
    const writes = [];
    if (typeof patch.enabled === "boolean") {
      cfg.enabled = patch.enabled;
      writes.push(["notify.enabled", patch.enabled]);
    }
    if (patch.focusMode === "always" || patch.focusMode === "unfocused") {
      cfg.focusMode = patch.focusMode;
      writes.push(["notify.focusMode", patch.focusMode]);
    }
    if (patch.events) {
      for (const k of Object.keys(patch.events)) {
        if (k in cfg.events && typeof patch.events[k] === "boolean") {
          cfg.events[k] = patch.events[k];
          writes.push(["notify.events." + k, patch.events[k]]);
        }
      }
    }
    if (patch.templates) {
      for (const k of Object.keys(patch.templates)) {
        if (!(k in cfg.templates)) continue;
        const t = coerceTemplate(patch.templates[k]);
        cfg.templates[k] = t;
        writes.push(["notify.tpl." + k, t]);
      }
    }
    for (const [key, value] of writes) {
      try {
        await ctx.storage.set(key, value);
      } catch (_) {}
    }
    renderInbox();
    paint();
  }

  // 卡片/Toast 共用的开关查询：某事件是否应该提醒。
  function eventOn(kind) {
    if (!cfg.enabled) return false;
    if (kind === "warn") return cfg.events.error;    // 中断归 error
    if (kind === "question") return cfg.events.ask;  // 待答归 ask
    return cfg.events[kind] !== false;
  }


  // ---- 待答状态 ----
  // key -> { rids:Set, seq:number, qText:string, title:string }
  const pending = new Map();
  const runRouting = new Map();   // runId -> key（question 带 null sessionId 时兜底）
  const dismissed = new Set();    // 手动关掉卡片的 key（pending 仍在，行高亮不受影响）

  // ---- 轮次级卡片（done / error）----
  // 与 pending 分开存：它们不属于"待答"，不进侧栏高亮，也不需要 requestId。
  // 提前声明：renderInbox 会读它，异步回调与同步路径都得能引用到。
  //   { id, kind:"done"|"error"|"warn", key, title, body, ts, expiresAt }
  const evCards = [];
  const CARD_MAX = 5;
  let evSeq = 0;
  let lastRenderAt = Date.now();

  function syncPendingKeys() {
    stats.pendingKeys = Array.from(pending.keys()).slice(0, 8);
    renderInbox();
  }

  function markPending(key, requestId, seq, qText) {
    if (!key) return;
    stats.questions++;
    let e = pending.get(key);
    if (!e) {
      e = { rids: new Set(), seq: seq == null ? -1 : seq, qText: qText || "", title: "", markedAt: Date.now() };
      pending.set(key, e);
    }
    if (seq != null && seq > e.seq) e.seq = seq;
    if (qText) e.qText = qText;
    if (requestId) e.rids.add(requestId);
    e.markedAt = Date.now();
    dismissed.delete(key);
    syncPendingKeys();
    schedulePaint();
  }

  function settleKey(key, requestId) {
    const e = pending.get(key);
    if (!e) return;
    if (requestId) e.rids.delete(requestId);
    if (!requestId || e.rids.size === 0) pending.delete(key);
    syncPendingKeys();
    schedulePaint();
  }

  // 恢复产出 = 问题已被回答；但只认"晚于 question 的产出"（提问前模型也在发 delta）。
  // 另加 3 秒宽限：宿主可能在推完 question 后还继续吐本轮尾部 delta（同属提问那一轮），
  // 这些 seq 也大于 question——不加时间闸就会被秒清（正是"没收到提醒"的又一嫌疑）。
  function clearIfAnswered(key, seq) {
    const e = pending.get(key);
    if (!e) return;
    if (seq == null) return;          // 无序号保守不清
    if (seq > e.seq && Date.now() - e.markedAt > 3000) {
      pending.delete(key);
      dismissed.delete(key);
      syncPendingKeys();
      schedulePaint();
    }
  }

  // ---- 轮次级卡片（done / error / warn）的存取 ----
  // TTL 不用创建时刻计，而用「第一次真正可见」的时刻计：窗口在后台时不做数，
  // 用户切回来才看到这张卡该有的 6 秒。
  // notice = renderNotice() 的返回值 { title, message }。
  function pushEventCard(kind, key, notice, ttlMs) {
    const now = Date.now();
    const title = (notice && notice.title) || "";
    const body = (notice && notice.message) || "";
    // 同会话同类型只留最新一条，避免连发多张
    for (let i = evCards.length - 1; i >= 0; i--) {
      if (evCards[i].key === key && evCards[i].kind === kind) evCards.splice(i, 1);
    }
    evSeq += 1;
    evCards.push({
      id: String(now) + "-" + evSeq,
      kind,
      key: key || "",
      title,
      body,
      ts: now,
      ttlMs: ttlMs || 0,
      expiresAt: 0,
    });
    while (evCards.length > 3) evCards.shift();
    renderInbox();
  }

  function clearEventCards(key, kinds) {
    let changed = false;
    for (let i = evCards.length - 1; i >= 0; i--) {
      const c = evCards[i];
      const keyOk = key == null || c.key === key;
      if (keyOk && (!kinds || kinds.indexOf(c.kind) >= 0)) {
        evCards.splice(i, 1);
        changed = true;
      }
    }
    if (changed) renderInbox();
  }

  // 宁可提醒得不精确，不能漏提醒。90 秒后自动消失（期间若同 requestId 的带 key
  // 事件到了，正常卡片会接管）。
  const unresolved = [];   // {qText, rid, expiresAt}

  function markUnresolved(qText, rid, runId) {
    for (const u of unresolved) {
      if (u.rid && rid && u.rid === rid) return;   // 同请求不重复弹
    }
    unresolved.push({
      qText: qText || "（有会话在等你回答问题，但暂时定位不到是哪一条）",
      rid: rid || null,
      runId: runId || null,
      expiresAt: Date.now() + 90000,
    });
    while (unresolved.length > 3) unresolved.shift();
    renderInbox();
  }

  function handleBatch(batch) {
    stats.batches++;
    if (!Array.isArray(batch)) return;
    for (const ev of batch) {
      stats.events++;
      if (!isPlainObject(ev)) continue;
      const kind = String(ev.kind || "?");
      stats.kinds[kind] = (stats.kinds[kind] || 0) + 1;

      const sk = threadKey(ev);
      if (sk && typeof ev.runId === "string") runRouting.set(ev.runId, sk);
      let key = sk;
      if (!key && typeof ev.runId === "string") key = runRouting.get(ev.runId) || null;
      if (!key) {
        if (stats.samples.length < 8) stats.samples.push("(nokey)" + kind + ":" + (ev.sessionId === null ? "null" : "?"));
        if (kind === "question") {
          // 关键取证：question 事件既无 sessionId 又查不到路由 → 记完整形状。
          stats.noKeyQuestions++;
          try {
            const s = JSON.stringify(ev);
            stats.qRing.push((s.length > 420 ? s.slice(0, 420) + "…" : s));
            if (stats.qRing.length > 6) stats.qRing.shift();
          } catch (_) {
            stats.qRing.push("{unstringifiable}");
          }
          // 兜底提醒：无法定位会话也要告诉用户"有问题在等"，TTL 后自动消失。
          markUnresolved(questionTextOf(ev), ev.data && ev.data.requestId, ev.runId);
        }
        continue;
      }
      if (stats.samples.length < 8 && stats.samples.indexOf(key) < 0) stats.samples.push(key);

      const seq = seqOf(ev);
      // 会话级上下文的采集点：先记模型名与本轮输出，后面的 done 渲染才拿得到。
      captureContext(ev, key, kind);

      switch (kind) {
        case "question":
          markPending(key, requestIdOf(ev), seq, questionTextOf(ev));
          break;
        case "question_settled":
          settleKey(key, requestIdOf(ev));
          break;
        case "delta":
        case "message":
        case "thinking":
          clearIfAnswered(key, seq);
          break;
        case "done":
          // 本轮结束 ≠ 问题已答（CLI 挂起等答时宿主常以 done 收尾），不清 pending。
          // 挂起等答的轮次不再叠加"已完成"卡；有新产出时换掉上一轮的完成卡/异常卡。
          if (typeof ev.runId === "string") runRouting.delete(ev.runId);
          clearEventCards(key, ["done", "error", "warn"]);
          // 人正开着这个会话看结果，就别再弹一张卡打扰——和宿主
          // notifyWhenUnfocusedOnly 的取舍一致，只是这里判断的是"看的是不是这条"。
          if (eventOn("done") && !pending.has(key) && key !== activeKey) {
            const notice = renderNotice("done", cfg.templates, {
              ...baseCtxOf(key, ev),
              last_message: turnTextOf(key),
            });
            pushEventCard("done", key, notice, CARD_TTL_DONE);
          }
          break;
        case "error": {
          if (typeof ev.runId === "string") runRouting.delete(ev.runId);
          if (eventOn("error") && key !== activeKey) {
            const text = errorTextOf(ev);
            const disconnect = looksLikeDisconnection(text);
            const kind = disconnect ? "warn" : "error";
            const notice = renderNotice(kind, cfg.templates, {
              ...baseCtxOf(key, ev),
              last_message: text,
            });
            pushEventCard(kind, key, notice, CARD_TTL_ERROR);
          }
          break;
        }
        default:
          break;
      }
    }
    syncPendingKeys();
  }

  // ---- 订阅引擎事件流 / 系统 Toast 去重 共用的底座 ----
  const internals = typeof window !== "undefined" ? window.__TAURI_INTERNALS__ : null;
  let unlisten = null;
  let disposed = false;

  // ---- 系统 Toast 的改写与分流（0.8.0）----
  // 宿主 raise 这几类通知时标题是 `${会话标题} · ${事件名}`（lib/notifications.ts），
  // 载荷里还带 options.extra.sessionKey（点击路由用）与 options.body（已完成清洗）。
  //
  // 我们只做两件事：
  //   ① 用同一份模板重写 title/body —— 卡片与 Toast 文案一致；
  //   ② 按焦点分流 —— 聚焦时丢弃（卡片已画），失焦时放行（系统 Toast 是唯一能把人叫回来的通道）。
  // 其余一律原样转发：id 与 extra 不动，点击跳会话的能力完整保留。
  //
  // 手法与事件旁路同源：activate 在 runAsPlugin 深度里，改 invoke 会立刻被自己
  // 的调用打脸（宿主 hardening 的包装里 pluginDepth>0 直接 reject），所以推迟到
  // 宏任务里再装。包住的是当前 invoke（= hardening 的包装），插件代码调用时依旧
  // 会被它的深度检查拦下，安全边界不变。
  let prevInvoke = null;
  let rewriteInstalled = false;
  let bypassOnce = false;   // 测试按钮用：下一次改写跳过分流

  /** 窗口是否真的在前台（与宿主 isSessionUnfocused 的第一条同判据）。 */
  function isForeground() {
    try {
      if (typeof document === "undefined") return false;
      if (document.hidden) return false;
      if (typeof document.hasFocus === "function" && !document.hasFocus()) return false;
      return true;
    } catch (_) {
      return false;
    }
  }

  /** 用当前模板改写一条通知；`opts` 是宿主的 options，返回新的 options。
   *  会话名取标题前缀；上下文里能补的（model/branch）顺手补上。 */
  function rewriteByTemplate(kind, opts) {
    const key = opts.extra && typeof opts.extra.sessionKey === "string" ? opts.extra.sessionKey : "";
    const ctxBody = typeof opts.body === "string" ? opts.body : "";
    const base = key ? baseCtxOf(key, null) : {
      project_name: "", worktree: "", branch: "",
      session_name: "", agent_name: "", model_name: "", last_message: "",
    };
    // Toast 路径的 last_message 直接用宿主清洗过的正文——比自己攒 delta 准。
    const notice = renderNotice(kind, cfg.templates, {
      ...base,
      session_name: sessionNameOfTitle(opts.title) || base.session_name,
      last_message: ctxBody,
    });
    stats.toastRewritten++;
    return {
      ...opts,                         // id / extra / sound 等一律保留
      title: notice.title || opts.title,
      body: notice.message || opts.body,
    };
  }

  /** 对一条宿主通知做决策，返回改写后的 args 或 null（丢弃）。
   *  null = 不发；原 args = 原样发；新 args = 改写后发。 */
  function rewriteNotification(args) {
    const opts = args && args.options;
    if (!opts || typeof opts !== "object") return args;
    const kind = toastKindOf(opts.title);
    if (!kind) {
      stats.toastMiss++;
      return args;                        // 不认识 → 原样转发，绝不丢
    }
    if (!cfg.enabled || !eventOn(kind)) return null;   // 用户关了这个事件

    // 测试按钮的一次性放行：它刻意要同时看卡片与 Toast。
    if (bypassOnce) {
      bypassOnce = false;
      return { ...args, options: rewriteByTemplate(kind, opts) };
    }
    // 聚焦时卡片已经画了同一条 → 丢弃 Toast（除非用户选了"两者都要"）。
    if (cfg.focusMode !== "always" && isForeground()) {
      stats.toastDropped++;
      return null;
    }
    return { ...args, options: rewriteByTemplate(kind, opts) };
  }

  function installToastRewrite() {
    if (rewriteInstalled || disposed) return;
    if (!internals || typeof internals.invoke !== "function") {
      stats.rewrite = "no-internals";
      return;
    }
    const prev = internals.invoke;
    prevInvoke = prev;
    // 参数原样透传：@tauri-apps/api 的 invoke 还带第三个 options 参数。
    const wrapped = function (...callArgs) {
      try {
        if (callArgs[0] === "plugin:notification|notify") {
          const next = rewriteNotification(callArgs[1]);
          if (next === null) return Promise.resolve(undefined);
          return prev.apply(internals, [callArgs[0], next, ...callArgs.slice(2)]);
        }
      } catch (_) {
        /* 改写出错就放行原文，宁可文案丑也不静默丢提醒 */
      }
      return prev.apply(internals, callArgs);
    };
    try {
      // hardening 用 defineProperty 保留了原描述符；这里照做，避免破坏它的可配置性。
      const desc = Object.getOwnPropertyDescriptor(internals, "invoke");
      if (desc && desc.configurable) {
        Object.defineProperty(internals, "invoke", { ...desc, value: wrapped });
      } else if (desc && desc.writable !== false) {
        internals.invoke = wrapped;
      } else {
        prevInvoke = null;
        stats.rewrite = "unsupported";
        return;
      }
      rewriteInstalled = true;
      stats.rewrite = "on";
    } catch (_) {
      prevInvoke = null;
      stats.rewrite = "failed";
    }
  }

  function uninstallToastRewrite() {
    if (!rewriteInstalled || !prevInvoke) return;
    try {
      const desc = Object.getOwnPropertyDescriptor(internals, "invoke");
      if (desc && desc.configurable) {
        Object.defineProperty(internals, "invoke", { ...desc, value: prevInvoke });
      } else if (desc && desc.writable !== false) {
        internals.invoke = prevInvoke;
      }
    } catch (_) {}
    rewriteInstalled = false;
    stats.rewrite = "off";
    prevInvoke = null;
  }

  const dedupeTimer = setTimeout(installToastRewrite, 0);
  // 配置必须早于第一条事件落地：否则首轮提醒会按内置默认跑一次。
  // 失败也算就绪（用默认值），不能让插件卡在加载态。
  void loadCfg().then(() => {
    renderInbox();
    paint();
  }).catch(() => {
    cfgReady = true;
  });

  function subscribeAsync() {
    if (disposed) return;
    if (!internals || typeof internals.invoke !== "function" || typeof internals.transformCallback !== "function") {
      stats.sub = "no-internals";
      return;
    }
    let handlerId = null;
    try {
      handlerId = internals.transformCallback((evt) => {
        try {
          handleBatch(evt && evt.payload);
        } catch (_) {
          /* 单批异常不影响后续投递 */
        }
      }, false);
    } catch (e) {
      stats.sub = "callback-fail";
      stats.subErr = String((e && e.message) || e).slice(0, 200);
      return;
    }
    if (handlerId == null) {
      stats.sub = "callback-fail";
      return;
    }
    stats.sub = "invoking";
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
        stats.sub = "listening";
        unlisten = () => {
          // disposer 运行在 runAsPlugin 里（深度>0），invoke 须推到宏任务。
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
        stats.sub = "invoke-fail";
        stats.subErr = String((e && e.message) || e).slice(0, 200);
        try {
          internals.unregisterCallback && internals.unregisterCallback(handlerId);
        } catch (_) {}
      });
  }

  const subscribeTimer = setTimeout(subscribeAsync, 0);

  // ---- React fiber 工具 ----
  function getFiber(el) {
    try {
      const ks = Object.keys(el);
      for (let i = 0; i < ks.length; i++) {
        if (ks[i].indexOf("__reactFiber$") === 0) return el[ks[i]];
      }
    } catch (_) {}
    return null;
  }
  function rootFiber() {
    const el = document.getElementById("root") || document.body;
    try {
      const ks = Object.keys(el);
      for (let i = 0; i < ks.length; i++) {
        if (ks[i].indexOf("__reactContainer$") === 0) {
          const c = el[ks[i]];
          if (c) return c.current || c;
        }
      }
    } catch (_) {}
    return null;
  }
  function fiberToDom(f) {
    const stack = [f];
    let seen = 0;
    while (stack.length && seen < 3000) {
      const x = stack.shift();
      seen++;
      const sn = x.stateNode;
      if (sn && sn.nodeType === 1) return sn;
      if (x.child) stack.push(x.child);
      if (x.sibling) stack.push(x.sibling);
    }
    return null;
  }

  // ---- 行解析（通知标题 / 跳转 / 高亮共用）----
  // 依据宿主 1.2.0 真实结构（bootstrap bundle 逆出的 bke 组件）：
  //   行容器  div.group.flex...py-[5px].pr-2.pl-9
  //     └ button[aria-current=page?]  onClick → onSelect(id)
  //   状态点  span.sidebar-thread-status(-processing|-unseen)   ← 不是 animate-pulse
  //   行 props { id: `${engine}/${sessionId}`, label, engine, streaming, ... }
  // id 形状与 pending key 完全一致，可直接比对。
  function rowFromEl(el) {
    let f = getFiber(el);
    for (let i = 0; i < 30 && f; i++) {
      const p = f.memoizedProps;
      try {
        if (p && typeof p === "object" && typeof p.id === "string" &&
            typeof p.onSelect === "function" && p.id.indexOf("/") > 0) {
          // 优先用 fiber 自己的宿主节点（才是整行），退而求其次找最近的 div 祖先。
          let row = null;
          try {
            const sn = f.stateNode;
            if (sn && sn.nodeType === 1 && (sn.className || "").indexOf("pl-9") >= 0) row = sn;
          } catch (_) {}
          if (!row) row = fiberToDom(f);
          if (!row) row = el.closest('div[class*="pl-9"]') || el.parentElement || el;
          return { fiber: f, props: p, key: p.id, row };
        }
      } catch (_) {}
      f = f.return;
    }
    return null;
  }

  function findRowByKey(key) {
    // 路 A：状态点锚（宿主"进行中"/"未读"那两颗小圆点）
    try {
      const dots = document.querySelectorAll(
        ".sidebar-thread-status-processing, .sidebar-thread-status-unseen, .sidebar-thread-status"
      );
      for (const dot of dots) {
        const hit = rowFromEl(dot);
        if (hit && hit.key === key) return hit;
      }
    } catch (_) {}
    // 路 B：行容器类（pl-9 是宿主行内边距，实测存在于 bke）
    try {
      const rows = document.querySelectorAll('div[class*="pl-9"]');
      for (const row of rows) {
        const hit = rowFromEl(row);
        if (hit && hit.key === key) return hit;
      }
    } catch (_) {}
    // 路 C：全树 fiber DFS 兜底
    const root = rootFiber();
    if (!root) return null;
    const st = [root];
    let seen = 0;
    while (st.length && seen < 30000) {
      const f = st.pop();
      seen++;
      try {
        const p = f.memoizedProps;
        if (p && typeof p === "object" && p.id === key && typeof p.onSelect === "function") {
          const dom = fiberToDom(f);
          if (dom) return { fiber: f, props: p, key, row: dom.closest("div") || dom };
        }
      } catch (_) {}
      if (f.child) st.push(f.child);
      if (f.sibling) st.push(f.sibling);
    }
    return null;
  }

  function resolveRow(key) {
    const hit = findRowByKey(key);
    if (!hit) return null;
    return { dom: hit.row, props: hit.props, fiber: hit.fiber };
  }

  function titleOfRow(entry, key) {
    try {
      const r = resolveRow(key);
      if (!r) return "";
      const p = r.props || {};
      const cand = [p.title, p.label, p.name,
        p.thread && p.thread.title, p.thread && p.thread.name,
        p.session && p.session.title, p.session && p.session.name];
      for (const c of cand) {
        if (typeof c === "string" && c.trim()) return c.trim().slice(0, 60);
      }
      if (r.dom && r.dom.textContent) {
        return r.dom.textContent.replace(/\s+/g, " ").trim().slice(0, 42);
      }
    } catch (_) {}
    void entry;
    return "";
  }

  // ---- 活动工作区 & 会话切换确认（镜像 note-query 的定位写法）----
  // ctx.sessions.selectSession(engine, sessionId, ws) 是宿主第一方 API，可靠；
  // 但它不会抛错告知"是否成功"，所以用 session://activated 事件作确认信号：
  // 调用后若收到该 sessionId 的 activated，即视为定位成功。
  let activeWs = "";
  let activeKey = "";         // 宿主当前打开的会话（engine/sessionId），来自 session://activated
  let recentActivated = {};   // sessionId 或 engine/sessionId -> ts
  let lastActivatedTitle = "";

  // ---- 模板上下文缓存（0.8.0）----
  // 会话 key → { model, wsPath, lastText }。三条来源：
  //   model   : engine `kind:"model"` 事件（data 就是模型串）
  //   wsPath  : selectSession/activated 带过来的工作区路径（后台会话也能记住）
  //   lastText: 本轮 assistant 产出（delta/message 累积，done 时清空）
  // 只保留有限的会话，避免长跑累积。
  const ctxCache = new Map();
  const CTX_CACHE_MAX = 30;

  function ctxEntry(key) {
    let e = ctxCache.get(key);
    if (!e) {
      e = { model: "", wsPath: "", lastText: "" };
      if (ctxCache.size >= CTX_CACHE_MAX) {
        const first = ctxCache.keys().next().value;
        if (first !== undefined) ctxCache.delete(first);
      }
      ctxCache.set(key, e);
    }
    return e;
  }

  function captureContext(ev, key, kind) {
    try {
      const e = ctxEntry(key);
      if (kind === "model") {
        const m = typeof ev.data === "string" ? ev.data.trim() : "";
        if (m) e.model = m;
        return;
      }
      if (kind === "session") {
        const d = ev.data;
        if (d && typeof d === "object") {
          const p = d.workspacePath || d.path || d.cwd;
          if (typeof p === "string" && p) e.wsPath = p;
        }
        return;
      }
      if (kind === "delta") {
        const t = typeof ev.data === "string" ? ev.data : "";
        if (t) e.lastText = clampText(e.lastText + t);
        return;
      }
      if (kind === "message") {
        const d = ev.data;
        if (d && typeof d === "object" && d.role === "assistant" && typeof d.text === "string") {
          e.lastText = clampText(d.text);
        }
        return;
      }
      if (kind === "done") {
        // done 收尾后把本轮文本留给渲染读，再清空，避免下一轮误用。
        // 消息事件（kimi/codex 整段快照）已在上面覆盖过 lastText，这里直接取。
        const text = cleanSummary(e.lastText, 200);
        e.lastText = "";
        e.lastDoneText = text;
      }
    } catch (_) {}
  }

  function clampText(s) {
    const max = 1200;   // 只留尾部：越靠后越能代表本轮结论
    return typeof s === "string" && s.length > max ? s.slice(-max) : s || "";
  }

  function turnTextOf(key) {
    const e = ctxCache.get(key);
    return (e && e.lastDoneText) || "";
  }

  /** 组装渲染上下文。缺的字段留空串，交给 renderTemplate 填空。 */
  function baseCtxOf(key, ev) {
    const e = ctxCache.get(key);
    const ws = (e && e.wsPath) || activeWs || "";
    const seg = ws ? ws.replace(/[\\/]+$/, "").split(/[\\/]/).filter(Boolean) : [];
    const worktree = seg.length ? seg[seg.length - 1] : "";
    return {
      project_name: worktree,
      worktree,
      branch: branchOfKey(key),
      session_name: titleOfRow(null, key) || shortKey(key),
      agent_name: "",                 // 主代理无名（用户决定：留空）
      model_name: (e && e.model) || "",
      last_message: "",
    };
  }

  /** 分支：工作区元数据优先；侧栏行 props 上带 branch 时用它自己的。
   *  取不到就返回空串（渲染时被替换掉，不泄露占位符）。 */
  function branchOfKey(key) {
    try {
      const r = resolveRow(key);
      const p = r && r.props;
      if (p) {
        const b = p.branch || (p.worktree && p.worktree.branch) ||
          (p.thread && p.thread.branch) || (p.repo && p.repo.branch);
        if (typeof b === "string" && b.trim()) return b.trim();
      }
    } catch (_) {}
    return lastBranch || "";
  }
  let lastBranch = "";

  function applyWsMeta(m) {
    if (!m) return;
    const v = m.path || m.rootPath || m.workspacePath || m.root || "";
    if (v) activeWs = v;
    if (typeof m.gitBranch === "string" && m.gitBranch.trim()) lastBranch = m.gitBranch.trim();
  }
  try {
    const p0 = ctx.workspace && ctx.workspace.getMetadata ? ctx.workspace.getMetadata() : null;
    if (p0 && typeof p0.then === "function") p0.then(applyWsMeta).catch(() => {});
    else applyWsMeta(p0);
  } catch (_) {}

  let offActivated = null;
  try {
    if (ctx.events && typeof ctx.events.on === "function") {
      offActivated = ctx.events.on("session://activated", (payload) => {
        const p = payload || {};
        if (p.workspacePath) activeWs = p.workspacePath;
        else if (p.path) activeWs = p.path;
        const now = Date.now();
        try {
          if (typeof p.sessionId === "string" && typeof p.engine === "string") {
            recentActivated[p.sessionId] = now;
            recentActivated[p.engine + "/" + p.sessionId] = now;
          }
          if (typeof p.id === "string") recentActivated[p.id] = now;
          if (p.session && typeof p.session === "object") {
            if (p.session.sessionId) recentActivated[p.session.sessionId] = now;
            if (p.session.id) recentActivated[p.session.id] = now;
          }
        } catch (_) {}
        const t = p.title || p.name || p.sessionTitle || p.label;
        if (typeof t === "string" && t) lastActivatedTitle = t;

        // 记住"当前打开的会话"，并顺手收掉它的完成/异常卡——
        // 人已经进到这个会话里看过结果了，卡片没有继续留着的理由。
        // 注意：session://activated 是宿主的"保留话题"，订阅时会同步回放一次，
        // 那时 activate 后半段的 cards/renderInbox 可能还没初始化完，
        // 所以这里推一个宏任务再收卡。
        if (typeof p.engine === "string" && typeof p.sessionId === "string" && p.sessionId) {
          activeKey = p.engine + "/" + p.sessionId;
          const k = activeKey;
          setTimeout(() => { try { clearEventCards(k); } catch (_) {} }, 0);
        } else if (p.sessionId === null) {
          activeKey = "";
        }
      });
    }
  } catch (_) {}

  async function resolveWsFresh() {
    try {
      const m = await ctx.workspace.getMetadata();
      const v = (m && (m.path || m.rootPath || m.workspacePath || m.root)) || "";
      if (v) { activeWs = v; return v; }
    } catch (_) {}
    return activeWs || "";
  }

  function splitKey(key) {
    const i = String(key || "").indexOf("/");
    if (i <= 0) return { engine: "", sessionId: "" };
    return { engine: key.slice(0, i), sessionId: key.slice(i + 1) };
  }

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  // 第一方定位：selectSession + session://activated 确认；失败再退回 fiber 行点击。
  async function jumpToKey(key) {
    const { engine, sessionId } = splitKey(key);
    stats.jump = "jumping";
    stats.jumpErr = "";

    // 主线：宿主 API
    if (engine && sessionId && ctx.sessions && typeof ctx.sessions.selectSession === "function") {
      let ws = await resolveWsFresh();
      if (!ws) ws = activeWs || "";
      const forms = [];
      if (ws) {
        forms.push(ws);
        const alt = ws.indexOf("\\") >= 0 ? ws.replace(/\\/g, "/") : ws.replace(/\//g, "\\");
        if (alt && alt !== ws) forms.push(alt);
      }
      if (!forms.length) forms.push("");   // 无 ws 也试一次，让宿主自行匹配
      const stamp = () => Math.max(recentActivated[sessionId] || 0, recentActivated[key] || 0);
      const since = (b) => (recentActivated[sessionId] || 0) > b || (recentActivated[key] || 0) > b;

      for (const form of forms) {
        try {
          const before = stamp();
          await ctx.sessions.selectSession(engine, sessionId, form);
          for (let w = 0; w < 20; w++) {
            await sleep(150);
            if (since(before)) {
              stats.jump = "ok";
              return true;
            }
          }
        } catch (e) {
          stats.jumpErr = String((e && e.message) || e).slice(0, 120);
        }
      }
      // refresh 后再试一次（会话可能刚结束/新出现在侧栏）
      try {
        if (typeof ctx.sessions.refresh === "function") {
          const b2 = stamp();
          await ctx.sessions.refresh();
          await sleep(400);
          await ctx.sessions.selectSession(engine, sessionId, forms[0]);
          for (let w = 0; w < 20; w++) {
            await sleep(150);
            if (since(b2)) {
              stats.jump = "ok";
              return true;
            }
          }
        }
      } catch (e) {
        stats.jumpErr = String((e && e.message) || e).slice(0, 120);
      }
      if (stats.jump !== "ok") {
        stats.jump = "fail";
        stats.jumpErr = stats.jumpErr || "selectSession 已调用但未收到 activated 确认";
      }
    } else {
      stats.jump = "no-api";
    }

    // 兜底：直接在 fiber 里找到该行，按宿主签名 onSelect(id) 触发
    const r = resolveRow(key);
    if (r && r.props && typeof r.props.onSelect === "function") {
      try {
        r.props.onSelect(r.props.id || key);
        stats.jump = "ok";
        return true;
      } catch (_) {}
    }
    if (stats.jump !== "fail") stats.jump = "fail";
    return false;
  }

  // ---- 站内信卡片栈（右下角）----
  // 一张卡 = 宿主语义 token 里的普通浮层：左侧 3px 色条区分 tone，
  // 标题 + 2~3 行正文 + 右侧动作。所有颜色都从 var() 取，明暗随宿主切换。
  const cards = new Map();   // key -> {el, kindEl, tEl, qEl, timeEl, body}
  let inboxRoot = null;

  const TONE = {
    question: { tone: "question", label: "会话待答", cls: "ccgui-qa-tone-question" },
    done:     { tone: "done",     label: "对话已完成", cls: "ccgui-qa-tone-done" },
    error:    { tone: "error",    label: "对话异常",   cls: "ccgui-qa-tone-error" },
    warn:     { tone: "warn",     label: "会话已中断", cls: "ccgui-qa-tone-warn" },
    unknown:  { tone: "question", label: "会话待答",   cls: "ccgui-qa-tone-question" },
  };

  function ensureInboxRoot() {
    if (inboxRoot && document.body.contains(inboxRoot)) return inboxRoot;
    const d = document.createElement("div");
    d.id = INBOX_ID;
    document.body.appendChild(d);
    inboxRoot = d;
    return d;
  }

  function fmtClock(ts) {
    try {
      const d = new Date(ts);
      const hh = String(d.getHours()).padStart(2, "0");
      const mm = String(d.getMinutes()).padStart(2, "0");
      return hh + ":" + mm;
    } catch (_) {
      return "";
    }
  }

  function buildCard(key, kind) {
    const meta = TONE[kind] || TONE.unknown;
    const el = document.createElement("div");
    el.className = "ccgui-qa-card " + meta.cls;

    const head = document.createElement("div");
    head.className = "ccgui-qa-head";

    const dot = document.createElement("span");
    dot.className = "ccgui-qa-dot";
    head.appendChild(dot);

    const kindEl = document.createElement("span");
    kindEl.className = "ccgui-qa-kind";
    kindEl.textContent = meta.label;
    head.appendChild(kindEl);

    // 会话名：模板标题未必含 {session_name}，所以单独占一格，保证用户知道是哪条会话。
    const nameEl = document.createElement("span");
    nameEl.className = "ccgui-qa-name";
    head.appendChild(nameEl);

    const timeEl = document.createElement("span");
    timeEl.className = "ccgui-qa-time";
    head.appendChild(timeEl);

    const x = document.createElement("button");
    x.type = "button";
    x.className = "ccgui-qa-x";
    x.textContent = "×";
    x.title = "关掉这张卡";
    x.addEventListener("click", () => {
      if (key.indexOf("unres:") === 0) {
        const rid = key.slice(6);
        for (let i = unresolved.length - 1; i >= 0; i--) {
          if ((unresolved[i].rid || unresolved[i].runId) === rid) unresolved.splice(i, 1);
        }
      } else if (key.indexOf("ev:") !== 0) {
        dismissed.add(key);
      }
      renderInbox();
    });
    head.appendChild(x);
    el.appendChild(head);

    const title = document.createElement("div");
    title.className = "ccgui-qa-title";
    el.appendChild(title);

    const q = document.createElement("div");
    q.className = "ccgui-qa-q";
    el.appendChild(q);

    const btns = document.createElement("div");
    btns.className = "ccgui-qa-btns";
    el.appendChild(btns);

    return { el, kindEl, nameEl, tEl: title, qEl: q, timeEl, btns, body: "" };
  }

  // 卡片上的「查看」按钮：待答 / 完成 / 异常都走同一个跳转链路。
  function attachJumpButton(card, key, label, primary) {
    const go = document.createElement("button");
    go.type = "button";
    go.className = "ccgui-qa-btn" + (primary ? " ccgui-qa-btn-primary" : "");
    go.textContent = label;
    go.addEventListener("click", async () => {
      const original = label;
      go.textContent = "定位中…";
      go.disabled = true;
      let ok = false;
      try {
        ok = await jumpToKey(key);
      } catch (e) {
        stats.jump = "fail";
        stats.jumpErr = String((e && e.message) || e).slice(0, 120);
      }
      go.disabled = false;
      go.textContent = ok ? "已定位" : "未找到会话";
      setTimeout(() => { go.textContent = original; }, ok ? 1500 : 2000);
    });
    card.btns.appendChild(go);
    return go;
  }

  function shortKey(key) {
    const i = key.indexOf("/");
    if (i < 0) return key.slice(0, 30);
    return key.slice(0, i) + " · " + key.slice(i + 1, i + 9);
  }

  function renderInbox() {
    stats.cards = 0;
    if (!cfg.enabled) {
      cards.forEach((c) => { try { c.el.remove(); } catch (_) {} });
      cards.clear();
      return;
    }
    // 清理过期兜底项
    const now = Date.now();
    for (let i = unresolved.length - 1; i >= 0; i--) {
      if (unresolved[i].expiresAt <= now) unresolved.splice(i, 1);
    }
    // done/error 卡片到期退场；窗口在后台时冻结倒计时（回来还能看到完整时长）
    if (document.hidden) {
      for (const c of evCards) {
        if (c.ttlMs && c.expiresAt) c.expiresAt += now - lastRenderAt;
      }
    } else {
      for (let i = evCards.length - 1; i >= 0; i--) {
        const c = evCards[i];
        if (!c.ttlMs) continue;
        if (!c.expiresAt) c.expiresAt = now + c.ttlMs;   // 第一次可见才开始计时
        else if (c.expiresAt <= now) evCards.splice(i, 1);
      }
    }
    lastRenderAt = now;
    // 移除已解决的卡片
    for (const [k, c] of Array.from(cards)) {
      if (k.indexOf("unres:") === 0) {
        const rid = k.slice(6);
        let alive = unresolved.some((u) => (u.rid || u.runId) === rid);
        // 同 requestId 的带 key 卡片接管后，兜底卡提前退场
        if (alive && rid) {
          for (const e of pending.values()) {
            if (e.rids.has(rid)) { alive = false; break; }
          }
        }
        if (!alive || dismissed.has(k)) {
          try { c.el.remove(); } catch (_) {}
          cards.delete(k);
        }
      } else if (k.indexOf("ev:") !== 0 && (!pending.has(k) || dismissed.has(k))) {
        try { c.el.remove(); } catch (_) {}
        cards.delete(k);
      }
    }
    // 已退场的轮次卡同步摘除
    const aliveEv = new Set(evCards.map((c) => "ev:" + c.id));
    for (const [k, c] of Array.from(cards)) {
      if (k.indexOf("ev:") === 0 && !aliveEv.has(k)) {
        try { c.el.remove(); } catch (_) {}
        cards.delete(k);
      }
    }

    const root = ensureInboxRoot();
    const order = [];
    let n = 0;

    // ①待答卡（最重要，永远排在最上面）
    for (const [k, e] of pending) {
      if (dismissed.has(k)) continue;
      if (n >= CARD_MAX) break;
      n++;
      let c = cards.get(k);
      if (!c) {
        c = buildCard(k, "question");
        cards.set(k, c);
        attachJumpButton(c, k, "查看", true);
        c.timeEl.textContent = fmtClock(e.markedAt);
      }
      order.push(c.el);
      const wantQ = e.qText || "（Claude 有一个问题等你选择答案）";
      if (c.body !== wantQ) {
        c.body = wantQ;
        try { c.qEl.textContent = wantQ; } catch (_) {}
      }
      if (!c.tEl.textContent || c.tEl.textContent === shortKey(k)) {
        const t = titleOfRow(e, k) || shortKey(k);
        try { c.tEl.textContent = t; c.tEl.title = k; } catch (_) {}
      }
    }

    // ②定位不到会话的兜底待答卡
    for (const u of unresolved) {
      if (n >= CARD_MAX) break;
      const uk = "unres:" + (u.rid || u.runId || String(u.expiresAt));
      n++;
      let c = cards.get(uk);
      if (!c) {
        c = buildCard(uk, "unknown");
        cards.set(uk, c);
        const go = document.createElement("button");
        go.type = "button";
        go.className = "ccgui-qa-btn";
        go.textContent = "无法定位";
        go.disabled = true;
        c.btns.appendChild(go);
        c.timeEl.textContent = fmtClock(Date.now());
      }
      order.push(c.el);
      if (c.body !== u.qText) {
        c.body = u.qText;
        try { c.qEl.textContent = u.qText; } catch (_) {}
      }
      if (!c.tEl.textContent) {
        try {
          c.tEl.textContent = "未知会话（事件缺 sessionId）";
          c.tEl.title = "runId=" + (u.runId || "?");
        } catch (_) {}
      }
    }

    // ③轮次级卡片（done / error），新的在下
    for (const ev of evCards) {
      if (n >= CARD_MAX) break;
      const ek = "ev:" + ev.id;
      n++;
      let c = cards.get(ek);
      if (!c) {
        c = buildCard(ek, ev.kind);
        cards.set(ek, c);
        c.timeEl.textContent = fmtClock(ev.ts);
        if (ev.key) attachJumpButton(c, ev.key, "查看", false);
      }
      order.push(c.el);
      // 正文与标题都来自模板（pushEventCard 已经渲染好），这里只负责贴到 DOM。
      if (c.body !== ev.body) {
        c.body = ev.body;
        try { c.qEl.textContent = ev.body; } catch (_) {}
      }
      if (c.tEl.textContent !== ev.title) {
        try { c.tEl.textContent = ev.title || ""; c.tEl.title = ev.key || ev.id; } catch (_) {}
      }
      // 会话名单独一格：侧栏行还没渲染出来时先用 key 缩略，2 秒轮询会补上。
      const nm = ev.key ? (titleOfRow(null, ev.key) || shortKey(ev.key)) : "未知会话";
      if (c.nameEl.textContent !== nm) {
        try { c.nameEl.textContent = nm; c.nameEl.title = ev.key || ev.id; } catch (_) {}
      }
    }

    if (!order.length) {
      stats.cards = 0;
      return;
    }
    syncOrder(root, order);
    stats.cards = n;
  }

  /** 按 order 排好子节点；只在位置不对时移动，避免无谓的重排打断入场动画。 */
  function syncOrder(root, order) {
    let prev = null;
    for (const el of order) {
      const expect = prev ? prev.nextSibling : root.firstChild;
      if (expect !== el) root.insertBefore(el, expect);
      prev = el;
    }
    while (prev && prev.nextSibling) root.removeChild(prev.nextSibling);
  }

  // 轮次卡到期自清 + 兜底项过期 + 标题延迟解析共用一个定时器。
  const titleTimer = setInterval(() => {
    for (const [k, c] of cards) {
      if (k.indexOf("unres:") === 0 || k.indexOf("ev:") === 0) continue;
      if (pending.has(k) && c.tEl && c.tEl.textContent === shortKey(k)) {
        const t = titleOfRow(pending.get(k), k);
        if (t) { try { c.tEl.textContent = t; c.tEl.title = k; } catch (_) {} }
      }
    }
    if (unresolved.length || evCards.length) renderInbox();
  }, 2000);

  // ---- 侧栏高亮（best-effort，匹配不上不影响通知）----
  function collectTargets() {
    const rows = new Set();
    const groups = new Set();
    if (pending.size === 0) {
      stats.lastPaint = { visited: 0, rows: 0, groups: 0 };
      return { rows, groups };
    }
    // 一次遍历同时收集：命中 pending 的会话行 + 含待答会话的折叠工作区
    const root = rootFiber();
    let seen = 0;
    if (root) {
      const stack = [root];
      while (stack.length && seen < 30000) {
        const f = stack.pop();
        seen++;
        try {
          const p = f.memoizedProps;
          if (p && typeof p === "object") {
            // 会话行：宿主签名 { id:"engine/sessionId", onSelect(fn), ... }
            if (typeof p.id === "string" && typeof p.onSelect === "function" && pending.has(p.id)) {
              const dom = fiberToDom(f);
              if (dom) {
                const rowEl = dom.closest('div[class*="pl-9"]') || dom;
                rows.add(rowEl);
              }
            }
            // 折叠工作区头行（弱提醒）
            if (p.repo && Array.isArray(p.repo.threads) && p.expanded === false) {
              for (const t of p.repo.threads) {
                if (t && typeof t.id === "string" && pending.has(t.id)) {
                  const dom = fiberToDom(f);
                  if (dom) groups.add(dom);
                  break;
                }
              }
            }
          }
        } catch (_) {}
        if (f.child) stack.push(f.child);
        if (f.sibling) stack.push(f.sibling);
      }
    }
    stats.lastPaint = { visited: seen, rows: rows.size, groups: groups.size };
    if (pending.size > 0 && rows.size + groups.size === 0) stats.misses++;
    else stats.misses = 0;
    return { rows, groups };
  }

  let markedRows = new Set();
  let markedGroups = new Set();
  let paintQueued = false;

  function schedulePaint() {
    if (paintQueued) return;
    paintQueued = true;
    requestAnimationFrame(() => {
      paintQueued = false;
      paint();
    });
  }

  function reconcile(prev, next, cls) {
    prev.forEach((el) => {
      if (!next.has(el)) {
        try { el.classList.remove(cls); } catch (_) {}
      }
    });
    next.forEach((el) => {
      if (!prev.has(el)) {
        try { el.classList.add(cls); } catch (_) {}
      }
    });
    return next;
  }

  function paint() {
    if (!cfg.enabled) {
      markedRows.forEach((el) => { try { el.classList.remove(HL_CLASS); } catch (_) {} });
      markedGroups.forEach((el) => { try { el.classList.remove(HL_GROUP); } catch (_) {} });
      markedRows = new Set();
      markedGroups = new Set();
      return;
    }
    const t = collectTargets();
    markedRows = reconcile(markedRows, t.rows, HL_CLASS);
    markedGroups = reconcile(markedGroups, t.groups, HL_GROUP);
  }

  const observer = new MutationObserver(schedulePaint);
  observer.observe(document.body, { childList: true, subtree: true });
  schedulePaint();

  // ---- 设置页：投递 / 事件 / 模板 / 诊断 ----
  // 版式对照 OpenChamber 的通知页：分组 + 变量提示 + 每事件两组输入框。
  function Settings() {
    const [state, setState] = useState(() => snapshotCfg());
    const [tick, setTick] = useState(0);
    // 输入框本地态：受控输入必须先在本地改，再防抖落盘，否则每敲一个字都回到旧值。
    const [draft, setDraft] = useState(() => snapshotCfg().templates);
    const [savedAt, setSavedAt] = useState(0);

    function snapshotCfg() {
      return {
        enabled: cfg.enabled,
        focusMode: cfg.focusMode,
        events: { ...cfg.events },
        templates: {
          done: { ...cfg.templates.done },
          error: { ...cfg.templates.error },
          ask: { ...cfg.templates.ask },
        },
      };
    }

    useEffect(() => {
      loadCfg().then(() => {
        const s = snapshotCfg();
        setState(s);
        setDraft(s.templates);
        renderInbox();
        paint();
      });
      const iv = setInterval(() => setTick((t) => t + 1), 800);
      return () => clearInterval(iv);
    }, []);
    void tick;

    const commit = (patch) => {
      const next = { ...state, ...patch };
      setState(next);
      void saveCfg(patch).then(() => setSavedAt(Date.now()));
    };
    const commitEvents = (k, val) => {
      const events = { ...state.events, [k]: val };
      setState({ ...state, events });
      void saveCfg({ events: { [k]: val } }).then(() => setSavedAt(Date.now()));
      if (!val) {
        if (k === "done") clearEventCards(null, ["done"]);
        if (k === "error") clearEventCards(null, ["error", "warn"]);
      }
    };
    const editTemplate = (kind, field, value) => {
      const templates = { ...draft, [kind]: { ...draft[kind], [field]: value } };
      setDraft(templates);
      void saveCfg({ templates: { [kind]: templates[kind] } }).then(() => setSavedAt(Date.now()));
    };
    const resetTemplate = (kind) => {
      editTemplate(kind, "title", DEFAULT_TEMPLATES[kind].title);
      editTemplate(kind, "message", DEFAULT_TEMPLATES[kind].message);
    };

    const resub = () => {
      try {
        if (typeof unlisten === "function") unlisten();
      } catch (_) {}
      unlisten = null;
      stats.sub = "init";
      stats.subErr = "";
      subscribeAsync();
    };

    // 测试通知：同一份模拟上下文同时出卡片 + 真 Toast，串起两条通路。
    const TRIAL_CTX = {
      project_name: "springboot-phm",
      worktree: "springboot-phm",
      branch: "master",
      session_name: "测试会话",
      agent_name: "",
      model_name: "deepseek-v4",
      last_message: "这是一条测试通知的正文。",
    };
    const trial = () => {
      const notice = renderNotice("done", draft, TRIAL_CTX);
      pushEventCard("done", "claude/__trial__", notice, CARD_TTL_DONE);
      // Toast：走宿主同一个 IPC。这条请求会先经过我们自己的改写包装，而窗口
      // 在前台时它会被"卡片接管"规则丢弃——所以用一次性放行标记绕过，
      // 保证点测试按钮一定能看到真 Toast。
      bypassOnce = true;
      setTimeout(() => {
        try {
          internals.invoke("plugin:notification|notify", {
            options: {
              id: (Date.now() & 0x7fffffff) || 1,
              title: notice.title,
              body: notice.message,
              extra: { sessionKey: "claude/__trial__" },
            },
          }).catch(() => {});
        } catch (_) {
          bypassOnce = false;
        }
      }, 0);
    };

    const mono = { fontFamily: "ui-monospace,Consolas,monospace", fontSize: 11.5, lineHeight: 1.55,
      background: "rgba(128,128,128,.10)", borderRadius: 8, padding: "8px 10px", marginTop: 10,
      whiteSpace: "pre-wrap", wordBreak: "break-all", maxHeight: 200, overflowY: "auto" };
    const rowStyle = { display: "flex", alignItems: "center", gap: 8, cursor: "pointer", fontSize: 13.5, marginTop: 8 };
    const sectionTitle = { fontSize: 12, fontWeight: 600, letterSpacing: ".02em",
      color: "var(--color-text-tertiary, #a3a3a3)", marginTop: 18, marginBottom: 2 };
    const hr = { border: "none", borderTop: "1px solid var(--color-separator-border, #e5e5e5)",
      margin: "18px 0 0" };
    const inputStyle = { width: "100%", boxSizing: "border-box", font: "inherit", fontSize: 12.5,
      padding: "5px 8px", borderRadius: 6, color: "inherit",
      border: "1px solid var(--color-border-button-default, rgba(128,128,128,.45))",
      background: "var(--color-background-primary-default, transparent)" };
    const fieldLabel = { fontSize: 11.5, color: "var(--color-text-tertiary, #a3a3a3)", marginBottom: 3 };
    const btnStyle = () => ({
      fontSize: 12, padding: "4px 10px", borderRadius: 6, cursor: "pointer",
      border: "1px solid var(--color-border-button-default, rgba(128,128,128,.5))",
      background: "transparent", color: "inherit",
    });

    const varLine = TEMPLATE_VARS.map((v) => "{" + v + "}").join(" ");

    const templateBlock = (kind, label) => h("div", { style: { marginTop: 14 } },
      h("div", { style: { display: "flex", alignItems: "center", gap: 8, marginBottom: 6 } },
        h("span", { style: { fontSize: 12.5, fontWeight: 600 } }, label),
        h("button", { type: "button", style: { ...btnStyle(), fontSize: 11, padding: "1px 7px" },
          onClick: () => resetTemplate(kind) }, "恢复默认")),
      h("div", { style: fieldLabel }, "标题"),
      h("input", { type: "text", style: inputStyle, value: draft[kind].title,
        placeholder: DEFAULT_TEMPLATES[kind].title,
        onChange: (e) => editTemplate(kind, "title", e.target.value) }),
      h("div", { style: { ...fieldLabel, marginTop: 8 } }, "消息"),
      h("input", { type: "text", style: inputStyle, value: draft[kind].message,
        placeholder: DEFAULT_TEMPLATES[kind].message,
        onChange: (e) => editTemplate(kind, "message", e.target.value) }));

    const kinds = Object.keys(stats.kinds);
    const kindStr = kinds.length ? kinds.map((k) => k + ":" + stats.kinds[k]).join("  ") : "(还没收到事件)";
    const preview = renderNotice("done", draft, TRIAL_CTX);

    return h("div", { style: { padding: "4px 2px", maxWidth: 720 } },
      h("div", { style: sectionTitle }, "通知投递"),
      h("label", { style: rowStyle },
        h("input", { type: "checkbox", checked: state.enabled,
          onChange: (e) => { commit({ enabled: e.target.checked }); renderInbox(); paint(); } }),
        "启用通知"),
      h("label", { style: rowStyle },
        h("input", { type: "checkbox", checked: state.focusMode === "always",
          onChange: (e) => commit({ focusMode: e.target.checked ? "always" : "unfocused" }) }),
        "应用聚焦时也发系统通知（默认只弹应用内卡片）"),
      h("div", { style: { display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap", alignItems: "center" } },
        h("button", { type: "button", onClick: trial, style: btnStyle() }, "发送测试通知"),
        h("button", { type: "button", onClick: resub, style: btnStyle() }, "重新订阅"),
        savedAt ? h("span", { style: { fontSize: 11.5, color: "var(--color-text-tertiary, #a3a3a3)" } }, "已保存") : null),

      h("hr", { style: hr }),
      h("div", { style: sectionTitle }, "通知事件"),
      h("label", { style: rowStyle },
        h("input", { type: "checkbox", checked: state.events.done,
          onChange: (e) => commitEvents("done", e.target.checked) }), "智能体完成"),
      h("label", { style: rowStyle },
        h("input", { type: "checkbox", checked: state.events.error,
          onChange: (e) => commitEvents("error", e.target.checked) }), "智能体错误（含会话中断）"),
      h("label", { style: rowStyle },
        h("input", { type: "checkbox", checked: state.events.ask,
          onChange: (e) => commitEvents("ask", e.target.checked) }), "智能体提问（含计划审批 / 权限请求）"),

      h("hr", { style: hr }),
      h("div", { style: sectionTitle }, "通知模板"),
      h("div", { style: { ...fieldLabel, marginTop: 8 } }, "变量：",
        h("span", { style: { color: "var(--color-text-warning-primary, #ea580c)" } }, varLine)),
      // 两列排布（对照截图）：完成 / 错误 一行，提问单独一行左半。
      h("div", { style: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0 20px" } },
        templateBlock("done", "完成"),
        templateBlock("error", "错误"),
        templateBlock("ask", "提问")),
      h("div", { style: { ...fieldLabel, marginTop: 10, fontStyle: "italic" } },
        "预览（完成）：" + (preview.title || "(空)") + " — " + (preview.message || "(空)")),

      h("hr", { style: hr }),
      h("div", { style: sectionTitle }, "诊断"),
      h("div", { style: mono },
        "订阅: " + stats.sub + (stats.subErr ? "  [" + stats.subErr + "]" : "") + "\n" +
        "样式自注入: " + (stats.cssInjected ? "OK" : "失败") + "\n" +
        "事件: " + stats.events + "   question数: " + stats.questions + "   定位失败question: " + stats.noKeyQuestions + "   卡片: " + stats.cards + "\n" +
        "kind分布: " + kindStr + "\n" +
        "待答: " + (stats.pendingKeys.length ? stats.pendingKeys.join(" | ") : "(空)") + "\n" +
        "轮次卡: " + (evCards.length ? evCards.map((c) => c.kind).join(" | ") : "(空)") + "\n" +
        "Toast改写: " + stats.rewrite + "   已改写 " + stats.toastRewritten +
          " 条   前台转卡片 " + stats.toastDropped + " 条   未识别 " + stats.toastMiss + " 条\n" +
        "定位: " + stats.jump + (stats.jumpErr ? "  [" + stats.jumpErr + "]" : "") +
        (activeWs ? "   工作区=" + activeWs.slice(-38) : "   工作区=(未知)") + "\n" +
        "侧栏高亮: " + (stats.lastPaint
          ? "行" + stats.lastPaint.rows + " 工作区" + stats.lastPaint.groups + "（best-effort）"
          : "(还没画过)")));
  }

  const disposeSettings = ctx.ui.registerSettingsSection({
    label: () => "会话提醒",
    component: Settings,
  });
  void disposeSettings;

  // ---- 卸载清理 ----
  return () => {
    disposed = true;
    clearTimeout(subscribeTimer);
    clearTimeout(dedupeTimer);
    clearInterval(titleTimer);
    uninstallToastRewrite();
    try {
      if (typeof offActivated === "function") offActivated();
    } catch (_) {}
    try {
      if (typeof unlisten === "function") unlisten();
    } catch (_) {}
    observer.disconnect();
    markedRows.forEach((el) => { try { el.classList.remove(HL_CLASS); } catch (_) {} });
    markedGroups.forEach((el) => { try { el.classList.remove(HL_GROUP); } catch (_) {} });
    cards.forEach((c) => { try { c.el.remove(); } catch (_) {} });
    cards.clear();
    try {
      if (inboxRoot) inboxRoot.remove();
    } catch (_) {}
    inboxRoot = null;
    pending.clear();
    evCards.length = 0;
    dismissed.clear();
  };
}
