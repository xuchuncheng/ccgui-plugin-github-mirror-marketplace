// 过程卡片插件（CC GUI / ccgui-next，Tier-1 JS 插件，单文件 ESM）
//
// 作用：接管会话时间线里的 kind="process" 行（思考 + 工具调用的合集），
//       把它从「思考 N 次 工具调用 M 次 >」的折叠列表，改成一张
//       「任务摘要卡 + 语义化执行日志」：
//         · 头部：任务摘要 · 进行中/已完成 · 步数
//         · 日志：每步一行 = 状态图标 + 动词 + 主文本 + 次要路径/命令
//         · 「参数」展开：原始 args / result（JSON 或 stdout/stderr）
//         · 思考：大脑图标 + 左侧轨道灰文，默认只露首行
//
// 为什么走 registerTimelineRowRenderer 而不是 DOM 注入：
//   宿主的 MessageTimeline 在渲染每一行前先查 timelineRowRegistry，
//   插件注册的 renderer 优先于内置分支（src/features/chat/components/
//   MessageTimeline.tsx，v1.0.6 起就有）。这是一等扩展点，不依赖 DOM 结构。
//
// 接管后宿主原本做的三件事由本插件补位（设置页可调）：
//   1) 最新一组自动展开、思考结束自动折叠 → 由「是否有 live 思考」+ 步数变化驱动；
//   2) 设置→通用→「思考自动折叠」→ 插件设置页同名开关；
//   3) Ctrl+F 搜索跳转到折叠区内的命中不会自动展开 → 已知限制，v0.2 再处理。
//
// 约束：单文件 ESM，零模块依赖；组件用 ctx.react.createElement 手工构造；不使用 JSX。

const NS = "timeline-cards";
const CONFIG_KEY = NS + ":config";

const DEFAULTS = {
  autoCollapse: true, // 思考结束后自动折叠
  expandLatest: true, // 最后一张卡默认展开
  showThinking: true, // 展示思考段落
  pageSize: 40, // 每页步数（含思考）
  semanticVerbs: true, // 用「读取文件/执行命令」等语义动词
};

// ===========================================================================
// 纯函数：工具分类（test.mjs 覆盖）
// ===========================================================================

const LABELS = {
  zh: {
    summary: "任务摘要",
    running: "进行中",
    finished: "已完成",
    log: "执行日志",
    args: "参数",
    thinking: "思考",
    empty: "暂无步骤",
    pagePrev: "上一页",
    pageNext: "下一页",
    pageLatest: "回到最新",
    pageRange: (s, e, t) => `${s}-${e} / 共 ${t} 条`,
    tasks: (n) => `${n} 项任务`,
    inProgress: (t) => `进行中：${t}`,
    verb: {
      shell: "执行命令",
      read: "读取文件",
      write: "写入文件",
      edit: "编辑文件",
      search: "搜索",
      web: "抓取网页",
      websearch: "搜索网络",
      task: "子任务",
      todo: "更新任务清单",
      tool: "工具调用",
    },
  },
  en: {
    summary: "Task summary",
    running: "Running",
    finished: "Completed",
    log: "Execution log",
    args: "Details",
    thinking: "Thinking",
    empty: "No steps",
    pagePrev: "Previous",
    pageNext: "Next",
    pageLatest: "Latest",
    pageRange: (s, e, t) => `${s}-${e} of ${t}`,
    tasks: (n) => `${n} task${n === 1 ? "" : "s"}`,
    inProgress: (t) => `In progress: ${t}`,
    verb: {
      shell: "Run command",
      read: "Read file",
      write: "Write file",
      edit: "Edit file",
      search: "Search",
      web: "Fetch page",
      websearch: "Web search",
      task: "Subtask",
      todo: "Update tasks",
      tool: "Tool call",
    },
  },
};

function isZh(cfg) {
  const loc = String((cfg && cfg.locale) || "");
  return loc.toLowerCase().startsWith("zh");
}

function labels(cfg) {
  return isZh(cfg) ? LABELS.zh : LABELS.en;
}

/** 工具名归一。返回 kind：shell/read/write/edit/search/web/websearch/task/todo/tool。
 *  引擎之间的差异很大：claude 给 "Bash"/"Read"/"TodoWrite"，codex 直接把整行
 *  命令当工具名（"npm run build"），MCP 工具是 "mcp__fs__read_file" 这种。 */
export function toolKindOf(name) {
  const raw = String(name == null ? "" : name).trim();
  if (!raw) return "tool";
  // camelCase 先拆开（TodoWrite → todo write），再按非字母数字切词。
  // 下划线也要切：MCP 工具名是 `mcp__filesystem__read_file` 这种。
  const normalized = raw.replace(/([a-z0-9])([A-Z])/g, "$1 $2");
  const tokens = normalized.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const set = new Set(tokens);
  const has = (...names) => names.some((n) => set.has(n));

  // "web_search" 拆开后是 web + search，要在单独的 web/search 之前判定。
  if (has("websearch") || (set.has("web") && set.has("search"))) return "websearch";
  if (has("web", "fetch", "browse")) return "web";
  // TodoWrite 必须排在 edit 前面，否则 "write" 会把它认成编辑文件。
  if (has("todo", "todowrite", "todolist")) return "todo";
  if (has("bash", "sh", "shell", "zsh", "terminal", "run_command", "exec")) return "shell";
  if (has("read", "cat", "view", "open_file", "read_file", "notebook_read")) return "read";
  if (has("write", "write_file")) return "write";
  if (has("edit", "apply_patch", "patch", "sed", "multiedit", "file_edit")) return "edit";
  if (has("grep", "glob", "rg", "find", "ls", "search", "search_files")) return "search";
  if (has("task", "agent", "spawn", "subagent")) return "task";
  // 多词标签是 codex 这类引擎直接抛上来的 shell 命令。只认原始串里的空格：
  // camelCase 拆出来的空格是归类手段，不能反过来当成"命令"证据。
  if (/\s/.test(raw)) return "shell";
  return "tool";
}

/** 路径的参数名不止 file_path：claude 用 file_path，别的引擎用 path/filePath。 */
function pathFromArgs(args) {
  if (!args || typeof args !== "object") return "";
  for (const key of ["file_path", "filePath", "path", "notebook_path", "filename"]) {
    const v = args[key];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return "";
}

/** 剥掉读取选择器（`file.ts:301-591:raw`、`img.svg:img`），和宿主
 *  ProcessDisclosure.fileChipFor 的规则一致；Windows 盘符 `C:` 不受影响。 */
function stripSelector(path) {
  const parts = String(path || "").split(":");
  while (parts.length > 1) {
    const last = parts[parts.length - 1];
    if (/^\d/.test(last) || last === "raw" || last === "img" || last === "conflicts") parts.pop();
    else break;
  }
  return parts.join(":");
}

function baseName(path) {
  const clean = stripSelector(path).replace(/[\\/]+$/, "");
  const idx = Math.max(clean.lastIndexOf("/"), clean.lastIndexOf("\\"));
  return idx >= 0 ? clean.slice(idx + 1) : clean;
}

function dirName(path) {
  const clean = stripSelector(path).replace(/[\\/]+$/, "");
  const idx = Math.max(clean.lastIndexOf("/"), clean.lastIndexOf("\\"));
  return idx > 0 ? clean.slice(0, idx) : "";
}

function firstLine(text) {
  const line = String(text == null ? "" : text).split(/\r?\n/).find((l) => l.trim());
  return (line || "").trim();
}

/** 精简的 LCS 行差：字符串足够短时算出 +N/-M，大了就退化成「行数对比」，
 *  避免长文件把渲染线程拖住。 */
function diffStats(before, after) {
  const a = String(before == null ? "" : before).split("\n");
  const b = String(after == null ? "" : after).split("\n");
  if (a.length * b.length > 250000) {
    const delta = b.length - a.length;
    return delta >= 0 ? { added: delta, removed: 0 } : { added: 0, removed: -delta };
  }
  let prev = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    const cur = new Array(b.length + 1).fill(0);
    for (let j = 1; j <= b.length; j++) {
      cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    }
    prev = cur;
  }
  const same = prev[b.length];
  return { added: b.length - same, removed: a.length - same };
}

/** apply_patch 的 patch 文本直接数 +/- 行。 */
function patchStats(patch) {
  let added = 0;
  let removed = 0;
  for (const line of String(patch || "").split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) added++;
    else if (line.startsWith("-") && !line.startsWith("---")) removed++;
  }
  return { added, removed };
}

/** 单个工具调用 → 一行「人话」。 */
export function classifyTool(item, cfg) {
  const L = labels(cfg);
  const semantic = !(cfg && cfg.semanticVerbs === false);
  const text = String((item && item.text) || "").trim();
  const args = item && item.args;
  const kind = toolKindOf(text);
  const argPath = pathFromArgs(args);
  const path = String((item && item.path) || "") || argPath;

  const out = {
    kind,
    verb: semantic ? L.verb[kind] || L.verb.tool : text || L.verb.tool,
    primary: "",
    secondary: "",
    added: 0,
    removed: 0,
  };

  if (kind === "shell") {
    const command =
      (args && (typeof args.command === "string" ? args.command : args.cmd || args.script)) ||
      // codex：整行就是命令，没有 args
      (!args && /\s/.test(text) ? text : "");
    const description = args && typeof args.description === "string" ? args.description.trim() : "";
    out.primary = description || firstLine(command) || text;
    out.secondary = description ? firstLine(command) : "";
    return out;
  }

  if (kind === "read" || kind === "write" || kind === "edit") {
    const name = baseName(path);
    out.primary = name || text;
    out.secondary = dirName(path);
    if (kind === "edit") {
      if (args && typeof args.old_string === "string" && typeof args.new_string === "string") {
        const stats = diffStats(args.old_string, args.new_string);
        out.added = stats.added;
        out.removed = stats.removed;
      } else if (args && typeof args.content === "string") {
        out.added = args.content.split("\n").length;
      } else if (args && typeof args.patch === "string") {
        const stats = patchStats(args.patch);
        out.added = stats.added;
        out.removed = stats.removed;
      }
    } else if (kind === "write" && args && typeof args.content === "string") {
      out.added = args.content.split("\n").length;
    }
    return out;
  }

  if (kind === "search") {
    const pattern =
      (args && (args.pattern || args.query || args.glob || args.regex)) || "";
    out.primary = typeof pattern === "string" ? pattern : "";
    out.secondary = String((args && (args.path || args.dir)) || "") || (out.primary ? "" : path);
    if (!out.primary) out.primary = path || text;
    return out;
  }

  if (kind === "web" || kind === "websearch") {
    const url = args && typeof args.url === "string" ? args.url : "";
    if (url) {
      out.primary = url
        .replace(/^https?:\/\//i, "")
        .replace(/^www\./i, "")
        .split("#")[0]
        .split("?")[0];
    } else {
      const query = args && (args.query || args.prompt || args.search_query);
      out.primary = typeof query === "string" ? query : text;
    }
    return out;
  }

  if (kind === "todo") {
    const todos = (args && Array.isArray(args.todos) && args.todos) || [];
    out.primary = todos.length ? L.tasks(todos.length) : text;
    const active = todos.find((t) => t && (t.status === "in_progress" || t.status === "in-progress"));
    if (active && typeof active.content === "string") out.secondary = L.inProgress(active.content);
    return out;
  }

  if (kind === "task") {
    const label =
      (args && (args.description || args.subagent_type || args.agent || args.name)) || "";
    out.primary = typeof label === "string" && label.trim() ? label.trim() : path || text;
    return out;
  }

  // 未知工具：动词就是工具名本身；参数里若带路径，仍然把它当主文本。
  out.verb = semantic ? text || L.verb.tool : text || L.verb.tool;
  out.primary = path || "";
  out.secondary = "";
  return out;
}

/** 工具结果 → 可读文本 + 是否出错。stdout/stderr 包装是 claude 与多数
 *  shell 类工具的常见形状，其余直接 JSON 序列化。 */
export function formatResult(result) {
  if (result == null) return null;
  if (typeof result === "string") {
    const trimmed = result.trim();
    return trimmed ? { text: trimmed, isError: false } : null;
  }
  if (typeof result === "object") {
    const obj = result;
    const stdout = typeof obj.stdout === "string" ? obj.stdout.trim() : "";
    const stderr = typeof obj.stderr === "string" ? obj.stderr.trim() : "";
    const isError = Boolean(obj.is_error || obj.isError || (stderr && !stdout));
    if (stdout && stderr) return { text: `${stdout}\n--- stderr ---\n${stderr}`, isError };
    if (stderr) return { text: stderr, isError: true };
    // 只有 stdout 时仍可能是错误（is_error: true + 一段说明文本）。
    if (stdout) return { text: stdout, isError };
    try {
      const text = JSON.stringify(result, null, 2);
      return text && text !== "{}" ? { text, isError } : null;
    } catch (_) {
      return { text: String(result), isError: false };
    }
  }
  return { text: String(result), isError: false };
}

/** 一组 process items → 卡片数据。
 *  `opts.live` = 这一轮仍在执行。它由调用方给出（见卡片里的 probeTurnLive）：
 *  宿主只把 turnLive 传给内置渲染器，插件拿不到，只能从时间线尾巴的状态条推断。
 *
 *  工具行的「进行中」判定：本轮仍在执行，且该工具位于**最后一个已有结果的工具
 *  之后**。这样并行工具（claude 一次发多个 tool_use）能整批标成进行中，而不是
 *  只标最后一个。 */
export function classifyItems(items, cfg, opts) {
  const list = Array.isArray(items) ? items : [];
  const live = Boolean(opts && opts.live);
  let lastSettled = -1;
  if (live) {
    list.forEach((item, index) => {
      if (!item || item.type === "thinking") return;
      if (item.result !== undefined && formatResult(item.result)) lastSettled = index;
    });
  }
  const rows = list.map((item, index) => {
    if (item && item.type === "thinking") {
      return { kind: "thinking", index, text: String(item.text || ""), live: Boolean(item.live) };
    }
    const info = classifyTool(item, cfg);
    const res = formatResult(item && item.result);
    let status = "done";
    if (res && res.isError) status = "error";
    else if (!res && live && index > lastSettled) status = "running";
    // info.kind 是工具类型（read/edit/…），不能覆盖行类型 kind: "tool"。
    const { kind: toolKind, ...rest } = info;
    return { kind: "tool", toolKind, index, status, payload: res ? res.text : "", args: item && item.args, result: item && item.result, ...rest };
  });
  const tools = rows.filter((r) => r.kind === "tool");
  return {
    rows,
    total: tools.length,
    done: tools.filter((r) => r.status !== "running").length,
    errors: tools.filter((r) => r.status === "error").length,
  };
}

/** 卡片预览里显示的一行：优先进行中，其次最后一个工具。 */
function previewRow(data) {
  for (let i = data.rows.length - 1; i >= 0; i--) {
    const row = data.rows[i];
    if (row.kind === "tool" && row.status === "running") return row;
  }
  for (let i = data.rows.length - 1; i >= 0; i--) {
    if (data.rows[i].kind === "tool") return data.rows[i];
  }
  return null;
}

// ===========================================================================
// 配置存储（模块级小 store，卡片与设置页共用）
// ===========================================================================

const configStore = { value: { ...DEFAULTS }, listeners: new Set() };

function setConfig(patch) {
  configStore.value = { ...configStore.value, ...patch };
  configStore.listeners.forEach((fn) => {
    try {
      fn();
    } catch (_) {}
  });
}

function sanitizeConfig(raw) {
  const next = { ...DEFAULTS };
  if (!raw || typeof raw !== "object") return next;
  if (typeof raw.autoCollapse === "boolean") next.autoCollapse = raw.autoCollapse;
  if (typeof raw.expandLatest === "boolean") next.expandLatest = raw.expandLatest;
  if (typeof raw.showThinking === "boolean") next.showThinking = raw.showThinking;
  if (typeof raw.semanticVerbs === "boolean") next.semanticVerbs = raw.semanticVerbs;
  const size = Number(raw.pageSize);
  if (Number.isFinite(size)) next.pageSize = Math.min(200, Math.max(5, Math.round(size)));
  return next;
}

// ===========================================================================
// 图标（内联 SVG，不引第三方图标库）
// ===========================================================================

function svg(ctx, size, children, extra) {
  const { createElement: h } = ctx.react;
  return h(
    "svg",
    {
      viewBox: "0 0 24 24",
      width: size,
      height: size,
      fill: "none",
      stroke: "currentColor",
      strokeWidth: 2,
      strokeLinecap: "round",
      strokeLinejoin: "round",
      "aria-hidden": "true",
      ...(extra || {}),
    },
    ...children,
  );
}

function makeIcons(ctx) {
  const { createElement: h } = ctx.react;
  return {
    spark: (size) =>
      svg(ctx, size || 14, [
        h("path", { key: "a", d: "M12 3v4M12 17v4M3 12h4M17 12h4" }),
        h("path", { key: "b", d: "M12 8.5 13.6 11l2.4 1-2.4 1L12 15.5 10.4 13 8 12l2.4-1z" }),
      ]),
    check: (size) =>
      svg(ctx, size || 14, [h("path", { key: "a", d: "M20 6 9 17l-5-5" })]),
    alert: (size) =>
      svg(ctx, size || 14, [
        h("circle", { key: "a", cx: 12, cy: 12, r: 9 }),
        h("path", { key: "b", d: "M12 8v5M12 16.5v.01" }),
      ]),
    dot: (size) => svg(ctx, size || 14, [h("circle", { key: "a", cx: 12, cy: 12, r: 3, fill: "currentColor", stroke: "none" })]),
    brain: (size) =>
      svg(ctx, size || 13, [
        h("path", { key: "a", d: "M9 4a3 3 0 0 0-3 3 3 3 0 0 0-1 5.7V16a3 3 0 0 0 4 2.8" }),
        h("path", { key: "b", d: "M15 4a3 3 0 0 1 3 3 3 3 0 0 1 1 5.7V16a3 3 0 0 1-4 2.8" }),
        h("path", { key: "c", d: "M12 5v14" }),
      ]),
    chevron: (size) =>
      svg(ctx, size || 13, [h("path", { key: "a", d: "m9 6 6 6-6 6" })]),
  };
}

// ===========================================================================
// 卡片组件
// ===========================================================================

/** 时间线里这一行的位置信息。宿主把每一行渲染成 [data-virtual-inner] 下直接
 *  子级的 `[data-index]` 容器；流式输出时它还会在末尾多挂一条「思考中…」
 *  状态条（AgentThinking，`role="status"`），`streaming` 一结束就摘掉；
 *  自动 compaction 期间占位的是 CompactionCurtain（data-testid）。
 *
 *  返回：
 *    tailLive      —— 末尾挂着流式状态条 = 本轮仍在执行
 *                     （插件唯一能拿到的 live 信号，宿主的 turnLive 只给内置渲染器）；
 *    isLastContent —— 这一行是末条内容行（状态条/占位不算），即「正在被追加的那条」；
 *    isLastProcess —— 这一行是最后一条过程行（宿主 autoExpand 的判据，
 *                     它后面可能还跟着一条正在生成的助手消息）。
 *  读不到结构时全 false：宁可少报进行中，也不要把历史卡片挂成运行中。 */
function probePosition(el) {
  const none = { tailLive: false, isLastContent: false, isLastProcess: false, found: false };
  try {
    const holder = el && el.closest ? el.closest("[data-index]") : null;
    const parent = holder && holder.parentElement;
    if (!parent) return none;
    const own = Number(holder.getAttribute("data-index"));
    if (!Number.isFinite(own)) return none;
    let max = -Infinity;
    let maxNode = null;
    let maxProcess = -Infinity;
    for (const node of parent.children) {
      if (!node.hasAttribute || !node.hasAttribute("data-index")) continue;
      const v = Number(node.getAttribute("data-index"));
      if (!Number.isFinite(v)) continue;
      if (v > max) {
        max = v;
        maxNode = node;
      }
      // 过程行 = 挂着本插件卡片的那一行。
      if (v > maxProcess && node.querySelector(".tc-card")) maxProcess = v;
    }
    if (!maxNode) return none;
    const tailLive = Boolean(maxNode.querySelector && maxNode.querySelector('[role="status"]'));
    const tailCurtain = Boolean(
      maxNode.querySelector && maxNode.querySelector('[data-testid="compaction-curtain"]'),
    );
    const contentMax = max - (tailLive || tailCurtain ? 1 : 0);
    // 虚拟列表只挂载可见行：滚上去之后末尾行被摘掉，此时「已挂载的最大
    // index」并不是真正的末尾。用「滚动容器是否到底」兜住这种情况。
    let atBottom = true;
    let scroller = parent.parentElement;
    while (scroller && scroller !== document.body) {
      const style = window.getComputedStyle(scroller);
      if (/(auto|scroll)/.test(style.overflowY)) break;
      scroller = scroller.parentElement;
    }
    if (scroller && scroller !== document.body) {
      atBottom = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 120;
    }
    return {
      tailLive,
      isLastContent: own === contentMax && atBottom,
      isLastProcess: own === maxProcess,
      found: true,
    };
  } catch (_) {
    return none;
  }
}

/** 当前行是不是时间线末尾那条过程行（决定「默认展开」，与宿主一致）。 */
function isLastRow(el) {
  return probePosition(el).isLastProcess;
}

function makeCard(ctx, icons) {
  const { createElement: h, useState, useEffect, useRef, useMemo, useCallback } = ctx.react;

  function useConfig() {
    const [version, setVersion] = useState(0);
    useEffect(() => {
      const listener = () => setVersion((v) => v + 1);
      configStore.listeners.add(listener);
      return () => {
        configStore.listeners.delete(listener);
      };
    }, []);
    void version;
    return configStore.value;
  }

  /** 时间线位置：本行是不是末条过程行、末尾有没有流式状态条。 */
  function useTimelinePosition(ref) {
    const [pos, setPos] = useState({
      tailLive: false,
      isLastContent: false,
      isLastProcess: false,
    });
    useEffect(() => {
      const holder = ref.current && ref.current.closest ? ref.current.closest("[data-index]") : null;
      const parent = holder && holder.parentElement;
      if (!parent) return;
      const read = () => {
        const next = probePosition(ref.current);
        setPos((prev) =>
          prev.tailLive === next.tailLive &&
          prev.isLastContent === next.isLastContent &&
          prev.isLastProcess === next.isLastProcess
            ? prev
            : next,
        );
      };
      read();
      if (!window.MutationObserver) return;
      const observer = new window.MutationObserver(read);
      // 行的增删都在 childList；流式状态条也是作为末尾的兄弟节点增删的。
      observer.observe(parent, { childList: true, subtree: false });
      return () => observer.disconnect();
    }, []);
    return pos;
  }

  function StatusIcon(props) {
    if (props.status === "error") return h("span", { className: "tc-ico tc-ico-error" }, icons.alert(13));
    if (props.status === "running") return h("span", { className: "tc-ico tc-ico-run" }, icons.dot(12));
    return h("span", { className: "tc-ico tc-ico-done" }, icons.check(13));
  }

  return function ProcessCard(props) {
    const row = props && props.row ? props.row : null;
    const items = (row && Array.isArray(row.items) && row.items) || [];
    const cfg = useConfig();
    const L = labels(cfg);

    const rootRef = useRef(null);
    const position = useTimelinePosition(rootRef);
    // 「本轮还在跑」= 时间线末尾挂着流式状态条。插件拿不到宿主的 turnLive，
    // 而 item.live 在工具一落地就被宿主清掉，只有这个信号可靠。
    // 只有「末条过程行」才标进行中：它后面可能还跟着一条正在生成的助手消息，
    // 但那一轮的工具调用确实已经结束了，不该继续显示成运行中。
    const live = position.tailLive && (position.isLastProcess || position.isLastContent);

    const data = useMemo(
      () => classifyItems(items, cfg, { live }),
      [items, cfg, live],
    );
    const visibleRows = useMemo(
      () => (cfg.showThinking ? data.rows : data.rows.filter((r) => r.kind !== "thinking")),
      [data.rows, cfg.showThinking],
    );

    // 初始一律折叠：历史卡片就不该展开。挂载后确认它是末尾且设置允许，
    // 再展开（宿主对「最新一组」也是这么处理的）。
    const [expanded, setExpanded] = useState(false);
    const [overridden, setOverridden] = useState(false);
    const [page, setPage] = useState(null); // null = 跟随最新
    const [openArgs, setOpenArgs] = useState({});
    const [openThinking, setOpenThinking] = useState({});
    const mounted = useRef({ live, count: items.length });

    // 挂载：末尾那张卡按设置默认展开（宿主对「最新一组」也是这么做的）。
    useEffect(() => {
      if (cfg.expandLatest && isLastRow(rootRef.current)) setExpanded(true);
      mounted.current = { live, count: items.length };
    }, []);

    // 状态机：本轮开始跑 → 展开；跑完 → 按设置折叠；用户手点过就听用户的。
    // 首帧拿不到 DOM（position 还没测），所以「变 live」也在这里兜住展开。
    useEffect(() => {
      const before = mounted.current;
      mounted.current = { live, count: items.length };
      if (overridden) return;
      if (live && !before.live) setExpanded(true);
      else if (!live && before.live && cfg.autoCollapse) setExpanded(false);
      else if (items.length > before.count && cfg.expandLatest) setExpanded(true);
    }, [live, items.length, cfg.autoCollapse, cfg.expandLatest, overridden]);

    const toggle = useCallback(() => {
      setOverridden(true);
      setExpanded((v) => !v);
    }, []);

    const toggleArgs = useCallback((index) => {
      setOpenArgs((prevMap) => ({ ...prevMap, [index]: !prevMap[index] }));
    }, []);

    const toggleThinking = useCallback((index) => {
      setOpenThinking((prevMap) => ({ ...prevMap, [index]: !prevMap[index] }));
    }, []);

    if (!row || items.length === 0) return null;

    const pageSize = Math.max(5, Number(cfg.pageSize) || 40);
    const lastPage = Math.max(0, Math.ceil(visibleRows.length / pageSize) - 1);
    const currentPage = Math.min(page == null ? lastPage : page, lastPage);
    const start = currentPage * pageSize;
    const end = Math.min(start + pageSize, visibleRows.length);
    const slice = visibleRows.slice(start, end);
    const preview = previewRow(data);
    const statusText = live ? L.running : L.finished;

    const header = h(
      "button",
      {
        type: "button",
        className: "tc-head",
        "aria-expanded": expanded,
        onClick: toggle,
      },
      h("span", { className: "tc-head-main" },
        h("span", { className: "tc-head-icon" }, icons.spark(14)),
        h("span", { className: "tc-title" }, L.summary),
        h("span", { className: "tc-chip " + (live ? "tc-chip-live" : "tc-chip-done") }, statusText),
        data.errors > 0 ? h("span", { className: "tc-chip tc-chip-error" }, "⚠ " + data.errors) : null,
      ),
      // 预览行单独占一块、可以收缩：标题栏宽度基本恒定，长路径只截自己。
      !expanded && preview
        ? h("span", { className: "tc-preview" },
            h("span", { className: "tc-preview-verb" }, preview.verb),
            preview.primary ? h("span", { className: "tc-preview-text" }, preview.primary) : null)
        : null,
      h("span", { className: "tc-head-right" },
        h("span", { className: "tc-count" }, data.done + "/" + data.total),
        h("span", { className: "tc-chevron " + (expanded ? "is-open" : "") }, icons.chevron(13))),
    );

    const logBar = h("div", { className: "tc-logbar" },
      h("span", { className: "tc-loglabel" }, L.log),
      lastPage > 0
        ? h("span", { className: "tc-pager" },
            h("button", {
              type: "button",
              className: "tc-page-btn",
              disabled: currentPage === 0,
              onClick: () => setPage(Math.max(0, currentPage - 1)),
            }, L.pagePrev),
            h("span", { className: "tc-page-range" }, L.pageRange(start + 1, end, visibleRows.length)),
            h("button", {
              type: "button",
              className: "tc-page-btn",
              disabled: currentPage === lastPage,
              onClick: () => setPage(currentPage + 1 >= lastPage ? null : currentPage + 1),
            }, L.pageNext),
            h("button", {
              type: "button",
              className: "tc-page-btn",
              disabled: page == null,
              onClick: () => setPage(null),
            }, L.pageLatest),
          )
        : null,
    );

    const body = h(
      "div",
      { className: "tc-clip " + (expanded ? "is-open" : "") },
      h("div", { className: "tc-clip-inner" },
        h("div", { className: "tc-body" },
          visibleRows.length === 0 ? h("div", { className: "tc-empty" }, L.empty) : logBar,
          visibleRows.length === 0
            ? null
            : h("ul", { className: "tc-list" },
                slice.map((entry) => {
                  if (entry.kind === "thinking") {
                    const open = Boolean(openThinking[entry.index]);
                    const text = entry.text || "";
                    const firstLineText = firstLine(text);
                    const shown = open ? text : firstLineText;
                    const truncated = !open && text.trim().length > firstLineText.length;
                    return h("li", { key: "t" + entry.index, className: "tc-think" },
                      h("button", {
                        type: "button",
                        className: "tc-think-head",
                        "aria-expanded": open,
                        onClick: () => toggleThinking(entry.index),
                      },
                      h("span", { className: "tc-think-ico" }, icons.brain(13)),
                      h("span", { className: "tc-think-title" }, L.thinking),
                      truncated ? h("span", { className: "tc-think-more" }, "…") : null),
                      h("div", { className: "tc-think-body" }, shown || "…"),
                    );
                  }
                  const hasPayload = entry.args !== undefined || entry.result !== undefined;
                  const open = Boolean(openArgs[entry.index]);
                  return h("li", { key: "s" + entry.index, className: "tc-row tc-row-" + entry.status },
                    h(StatusIcon, { status: entry.status }),
                    h("div", { className: "tc-row-main" },
                      h("div", { className: "tc-row-line" },
                        h("span", { className: "tc-verb" }, entry.verb),
                        entry.primary ? h("span", { className: "tc-primary", title: entry.primary }, entry.primary) : null,
                        entry.added ? h("span", { className: "tc-stat tc-stat-add" }, "+" + entry.added) : null,
                        entry.removed ? h("span", { className: "tc-stat tc-stat-del" }, "-" + entry.removed) : null,
                        hasPayload
                          ? h("button", {
                              type: "button",
                              className: "tc-args-btn",
                              "aria-expanded": open,
                              onClick: () => toggleArgs(entry.index),
                            }, L.args)
                          : null),
                      entry.secondary
                        ? h("div", { className: "tc-secondary", title: entry.secondary }, entry.secondary)
                        : null,
                      open && hasPayload
                        ? h("pre", { className: "tc-payload" }, payloadText(entry, 4000))
                        : null),
                  );
                })),
        ),
      ),
    );

    return h("div", { className: "tc-card", ref: rootRef, "data-tc-seq": row.firstSeq }, header, body);
  };
}

/** 参数/结果的可读文本：优先展示原始 JSON，其次 stdout/stderr 文本。 */
function payloadText(entry, limit) {
  const parts = [];
  if (entry.args !== undefined) {
    try {
      parts.push("[args]\n" + JSON.stringify(entry.args, null, 2));
    } catch (_) {
      parts.push("[args]\n" + String(entry.args));
    }
  }
  if (entry.payload) parts.push("[result]\n" + entry.payload);
  else if (entry.result !== undefined) {
    try {
      parts.push("[result]\n" + JSON.stringify(entry.result, null, 2));
    } catch (_) {}
  }
  const text = parts.join("\n\n");
  return text.length > limit ? text.slice(0, limit) + "\n…" : text;
}

// ===========================================================================
// 设置页
// ===========================================================================

function makeSettings(ctx) {
  const { createElement: h, useState, useEffect } = ctx.react;

  function SettingRow(props) {
    return h("label", { className: "tc-set-row" },
      h("input", {
        type: "checkbox",
        checked: Boolean(props.checked),
        onChange: (e) => props.onChange(e.target.checked),
      }),
      h("span", { className: "tc-set-text" },
        h("span", { className: "tc-set-label" }, props.label),
        props.desc ? h("span", { className: "tc-set-desc" }, props.desc) : null),
    );
  }

  return function Settings() {
    const cfg = configStore.value;
    const [, force] = useState(0);
    const [saved, setSaved] = useState(false);
    useEffect(() => {
      const listener = () => force((v) => v + 1);
      configStore.listeners.add(listener);
      return () => {
        configStore.listeners.delete(listener);
      };
    }, []);

    const persist = (patch) => {
      // locale 不是设置项，但卡片文案靠它；sanitize 会把它丢掉，这里补回来。
      const next = sanitizeConfig({ ...configStore.value, ...patch });
      next.locale = ctx.host && ctx.host.locale;
      setConfig(next);
      void ctx.storage
        .set(CONFIG_KEY, next)
        .then(() => {
          setSaved(true);
          setTimeout(() => setSaved(false), 1200);
        })
        .catch(() => {});
    };

    const zh = isZh(cfg);
    const t = zh
      ? {
          title: "过程卡片",
          desc: "接管会话里「思考 + 工具调用」那张折叠行，改成任务摘要卡。",
          autoCollapse: "思考结束后自动折叠",
          autoCollapseDesc: "关掉后，这一轮结束前卡片保持展开（对应宿主「思考自动折叠」开关）。",
          expandLatest: "最新一组默认展开",
          expandLatestDesc: "时间线最后一张卡默认展开，和历史记录一致。",
          showThinking: "显示思考内容",
          showThinkingDesc: "关闭后只保留工具调用步骤。",
          semantic: "使用语义化动词",
          semanticDesc: "把 Bash/Read/Edit 换成人话；关闭后显示原始工具名。",
          pageSize: "每页步数",
          pageSizeDesc: "超过该数量的步骤分页显示（5–200）。",
          reset: "恢复默认",
          saved: "已保存",
        }
      : {
          title: "Process cards",
          desc: "Takes over the folded thinking + tool-call row and renders it as a task summary card.",
          autoCollapse: "Auto-collapse after thinking settles",
          autoCollapseDesc: "Off keeps the card open until the turn ends (mirrors the host option).",
          expandLatest: "Expand the latest card",
          expandLatestDesc: "The last card in the timeline starts expanded, like the host default.",
          showThinking: "Show thinking text",
          showThinkingDesc: "Off keeps only the tool-call steps.",
          semantic: "Use semantic verbs",
          semanticDesc: "Turn Bash/Read/Edit into plain language; off shows raw tool names.",
          pageSize: "Steps per page",
          pageSizeDesc: "Paginate above this count (5–200).",
          reset: "Reset",
          saved: "Saved",
        };

    return h("div", { className: "tc-settings" },
      h("h3", { className: "tc-set-title" }, t.title),
      h("p", { className: "tc-set-sub" }, t.desc),
      h(SettingRow, {
        checked: cfg.autoCollapse,
        label: t.autoCollapse,
        desc: t.autoCollapseDesc,
        onChange: (v) => persist({ autoCollapse: v }),
      }),
      h(SettingRow, {
        checked: cfg.expandLatest,
        label: t.expandLatest,
        desc: t.expandLatestDesc,
        onChange: (v) => persist({ expandLatest: v }),
      }),
      h(SettingRow, {
        checked: cfg.showThinking,
        label: t.showThinking,
        desc: t.showThinkingDesc,
        onChange: (v) => persist({ showThinking: v }),
      }),
      h(SettingRow, {
        checked: cfg.semanticVerbs,
        label: t.semantic,
        desc: t.semanticDesc,
        onChange: (v) => persist({ semanticVerbs: v }),
      }),
      h("div", { className: "tc-set-row tc-set-row-num" },
        h("span", { className: "tc-set-text" },
          h("span", { className: "tc-set-label" }, t.pageSize),
          h("span", { className: "tc-set-desc" }, t.pageSizeDesc)),
        h("input", {
          type: "number",
          min: 5,
          max: 200,
          value: cfg.pageSize,
          onChange: (e) => persist({ pageSize: Number(e.target.value) }),
        })),
      h("div", { className: "tc-set-actions" },
        h("button", {
          type: "button",
          className: "tc-reset",
          onClick: () => persist({ ...DEFAULTS }),
        }, t.reset),
        saved ? h("span", { className: "tc-saved" }, t.saved) : null),
    );
  };
}

// ===========================================================================
// 入口
// ===========================================================================

export default function activate(ctx) {
  if (!ctx || !ctx.react || !ctx.ui) return;

  const initial = { ...DEFAULTS };
  initial.locale = ctx.host && ctx.host.locale;
  setConfig(initial);

  // 配置异步载入；读到之前卡片先用默认值渲染，读完自动刷新。
  void Promise.resolve()
    .then(() => ctx.storage.get(CONFIG_KEY))
    .then((raw) => {
      const next = sanitizeConfig(raw);
      next.locale = ctx.host && ctx.host.locale;
      setConfig(next);
    })
    .catch(() => {});

  const icons = makeIcons(ctx);
  const Card = makeCard(ctx, icons);
  const Settings = makeSettings(ctx);

  const disposers = [];

  try {
    disposers.push(
      ctx.ui.registerTimelineRowRenderer({
        key: "process",
        kind: "process",
        component: Card,
      }),
    );
  } catch (error) {
    // 宿主太旧（没有 ui:timeline-row）时插件应静默退场，而不是崩掉整个插件。
    console.warn("[" + NS + "] timeline row renderer unavailable:", error && error.message);
    return () => {};
  }

  try {
    disposers.push(
      ctx.ui.registerSettingsSection({
        key: "main",
        label: () => (isZh({ locale: ctx.host && ctx.host.locale }) ? "过程卡片" : "Process cards"),
        component: Settings,
      }),
    );
  } catch (_) {}

  return () => {
    for (const dispose of disposers) {
      try {
        if (typeof dispose === "function") dispose();
      } catch (_) {}
    }
  };
}
