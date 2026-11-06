// 项目知识（CC GUI / ccgui-next，Tier-1 JS 插件，单文件 ESM）
//
// 三个 Tab：笔记 / 待办 / 计划。条目可「加入上下文 / 移出上下文」，
// 挂载状态按会话隔离（engine + sessionId），发送前经 ctx.hooks.registerTurnHooks
// 的 beforeTurn 以 promptContribution 注入给模型；移出后下一轮即不再携带。
//
// 存储：ctx.storage（宿主 app.db 的 plugin_kv），单个键 knowledge:v1：
//   { version, knowledge: { <workspacePath>: { notes[], todos[], plan } },
//     mounts: { <scope>: { items: [{kind, ws, id}] } } }
// scope：有 sessionId 时为 "s:<engine>/<sessionId>"，否则 "p:<engine>@<workspacePath>"。
// 会话建立后（activated 拿到 sessionId / beforeTurn 带 sessionId）把 pending 桶
// 迁移到该会话，保证首轮挂载不丢且各会话互不串味。
//
// 约束：单文件 ESM，零 import；组件用 ctx.react.createElement 手工构造；
// 不使用动态求值、不读写浏览器本地存储、不碰宿主内部对象。

export default function activate(ctx) {
  var h = ctx.react.createElement;
  var React = ctx.react;

  var NS = "project-knowledge";
  var STORE_KEY = "knowledge:v1";
  // 宿主单轮 prompt 贡献总预算 12KB（DEFAULT_PROMPT_CONTRIBUTION_MAX_BYTES，
  // 且是所有插件共享的），我们自留余量；超出的条目省略并在上下文里注明。
  var MAX_CONTEXT_BYTES = 8000;

  // ================= 基础工具 =================

  function uid(prefix) {
    return prefix + "_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }

  function now() {
    return Date.now();
  }

  function byteLength(text) {
    var s = String(text == null ? "" : text);
    if (typeof TextEncoder === "function") return new TextEncoder().encode(s).length;
    return unescape(encodeURIComponent(s)).length;
  }

  function fmtTime(ts) {
    if (!ts) return "";
    try {
      var d = new Date(ts);
      var p = function (n) { return n < 10 ? "0" + n : String(n); };
      return p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes());
    } catch (e) { return ""; }
  }

  function wsName(path) {
    var p = String(path || "").replace(/[\\/]+$/, "");
    var parts = p.split(/[\\/]/);
    return parts[parts.length - 1] || p || "（未选择工作区）";
  }

  function snippet(text, n) {
    var s = String(text || "").replace(/\s+/g, " ").trim();
    return s.length > n ? s.slice(0, n) + "…" : s;
  }

  function itemKey(kind, ws, id) {
    return kind + "|" + ws + "|" + (kind === "plan" ? "plan" : id);
  }

  // ================= 数据模型 =================

  function blankData() {
    return { version: 1, knowledge: {}, mounts: {} };
  }

  function normalizeData(raw) {
    var data = blankData();
    if (!raw || typeof raw !== "object") return data;
    var kn = raw.knowledge;
    if (kn && typeof kn === "object") {
      Object.keys(kn).forEach(function (ws) {
        var doc = kn[ws];
        if (!doc || typeof doc !== "object") return;
        data.knowledge[ws] = {
          notes: Array.isArray(doc.notes) ? doc.notes.filter(isEntry).map(normEntry) : [],
          todos: Array.isArray(doc.todos) ? doc.todos.filter(isEntry).map(normEntry) : [],
          plan: typeof doc.plan === "string" ? doc.plan : "",
          planUpdatedAt: typeof doc.planUpdatedAt === "number" ? doc.planUpdatedAt : 0,
        };
      });
    }
    var mt = raw.mounts;
    if (mt && typeof mt === "object") {
      Object.keys(mt).forEach(function (scope) {
        var bucket = mt[scope];
        if (!bucket || !Array.isArray(bucket.items)) return;
        var seen = Object.create(null);
        var items = [];
        bucket.items.forEach(function (it) {
          if (!it || typeof it !== "object") return;
          if (it.kind !== "note" && it.kind !== "todo" && it.kind !== "plan") return;
          if (typeof it.ws !== "string" || !it.ws) return;
          var key = itemKey(it.kind, it.ws, it.id);
          if (seen[key]) return;
          seen[key] = 1;
          items.push({ kind: it.kind, ws: it.ws, id: it.kind === "plan" ? "plan" : String(it.id || "") });
        });
        if (items.length) data.mounts[scope] = { items: items, updatedAt: typeof bucket.updatedAt === "number" ? bucket.updatedAt : 0 };
      });
    }
    return data;
  }

  function isEntry(entry) {
    return !!entry && typeof entry === "object" && typeof entry.text === "string";
  }

  function normEntry(entry) {
    return {
      id: typeof entry.id === "string" && entry.id ? entry.id : uid("n"),
      text: entry.text,
      done: entry.done === true,
      createdAt: typeof entry.createdAt === "number" ? entry.createdAt : now(),
      updatedAt: typeof entry.updatedAt === "number" ? entry.updatedAt : now(),
    };
  }

  function cloneData(data) {
    try {
      return JSON.parse(JSON.stringify(data));
    } catch (e) {
      return blankData();
    }
  }

  // ================= 极简 store =================

  var state = {
    loaded: false,
    error: null,
    data: blankData(),
    active: { engine: null, sessionId: null },
    activeWs: "",
    toast: null,
  };

  var listeners = new Set();

  function subscribe(fn) {
    listeners.add(fn);
    return function () { listeners.delete(fn); };
  }

  function getSnapshot() {
    return state;
  }

  function setState(patch) {
    state = Object.assign({}, state, patch);
    listeners.forEach(function (fn) {
      try { fn(); } catch (e) { /* 一个订阅者出错不该拖垮其他 UI */ }
    });
  }

  var toastTimer = null;
  function toast(text, tone, action) {
    if (toastTimer) { clearTimeout(toastTimer); toastTimer = null; }
    setState({ toast: { text: text, tone: tone || "info", action: action || null, at: now() } });
    toastTimer = setTimeout(function () {
      toastTimer = null;
      setState({ toast: null });
    }, action ? 7000 : 4200);
  }

  function dismissToast() {
    if (toastTimer) { clearTimeout(toastTimer); toastTimer = null; }
    setState({ toast: null });
  }

  // ---- 加载 / 保存 ----

  var loadPromise = null;

  function ensureLoaded() {
    if (state.loaded) return Promise.resolve(state.data);
    if (loadPromise) return loadPromise;
    loadPromise = ctx.storage.get(STORE_KEY).then(function (raw) {
      setState({ data: normalizeData(raw), loaded: true, error: null });
      return state.data;
    }).catch(function (err) {
      loadPromise = null;
      setState({ loaded: true, error: (err && (err.message || String(err))) || "读取失败" });
      return state.data;
    });
    return loadPromise;
  }

  var saveChain = Promise.resolve();

  function persist() {
    var payload = cloneData(state.data);
    saveChain = saveChain.then(function () {
      return ctx.storage.set(STORE_KEY, payload);
    }).catch(function (err) {
      var msg = (err && (err.message || String(err))) || "保存失败";
      console.error("[" + NS + "] persist failed", err);
      setState({ error: msg });
    });
    return saveChain;
  }

  function mutate(fn) {
    // 首次写入前必须先把磁盘上的旧数据读进来，否则会用空模型覆盖用户内容。
    if (!state.loaded) {
      void ensureLoaded().then(function () { mutate(fn); });
      return false;
    }
    var next = cloneData(state.data);
    var changed = fn(next);
    if (changed === false) return false;
    setState({ data: next, error: null });
    persist();
    return true;
  }

  // ---- scope 解析 ----

  // 会话桶优先；会话 id 尚未出现（新建中）时落到「引擎 + 工作区」的 pending 桶。
  // 工作区在这里需要归一化：面板拿到的是 props.workspacePath，beforeTurn 拿到的是
  // event.workspace.path，两者写法可能差一个尾斜杠或盘符大小写。
  function normWs(ws) {
    var s = String(ws || "").trim().replace(/\\/g, "/").replace(/\/+$/, "");
    if (/^[a-z]:/.test(s)) s = s.charAt(0).toUpperCase() + s.slice(1);
    return s;
  }

  function scopeKey(engine, sessionId, ws) {
    if (sessionId) return "s:" + engine + "/" + sessionId;
    return "p:" + (engine || "?") + "@" + normWs(ws);
  }

  function currentScope() {
    var a = state.active;
    if (!a.engine) return null;
    return scopeKey(a.engine, a.sessionId, state.activeWs);
  }

  // pending 桶 → 会话桶（会话 id 出现后合并，保证首轮挂载不丢）。
  // 只认「本工作区」和「无工作区」两个键，不做跨工作区猜测：
  // 同一引擎可能先后存在多个待建会话（不同工作区），猜错会把 A 的挂载并进 B。
  // 工作区未知（面板没开过）时直接跳过——beforeTurn 一定带 workspace.path，那时再并。
  function migratePending(engine, sessionId, ws) {
    if (!engine || !sessionId || !normWs(ws)) return false;
    var dest = scopeKey(engine, sessionId, ws);
    return mutate(function (data) {
      var destBucket = data.mounts[dest];
      var merged = [];
      var seen = Object.create(null);
      function pushAll(items) {
        (items || []).forEach(function (it) {
          var key = itemKey(it.kind, it.ws, it.id);
          if (seen[key]) return;
          seen[key] = 1;
          merged.push({ kind: it.kind, ws: it.ws, id: it.id });
        });
      }
      var touched = false;
      if (destBucket) pushAll(destBucket.items);

      var sources = [];
      [scopeKey(engine, null, ws), scopeKey(engine, null, "")].forEach(function (src) {
        if (sources.indexOf(src) < 0 && data.mounts[src]) sources.push(src);
      });
      sources.forEach(function (src) {
        pushAll(data.mounts[src].items);
        delete data.mounts[src];
        touched = true;
      });
      if (!touched) return false;
      if (merged.length) data.mounts[dest] = { items: merged, updatedAt: now() };
      else delete data.mounts[dest];
      return true;
    });
  }

  function setActiveWs(ws) {
    var next = String(ws || "");
    if (state.activeWs === next) return;
    setState({ activeWs: next });
  }

  // ---- 挂载状态 ----

  function bucketItems(scope) {
    if (!scope) return [];
    var bucket = state.data.mounts[scope];
    return bucket && Array.isArray(bucket.items) ? bucket.items : [];
  }

  function isMounted(scope, kind, ws, id) {
    var key = itemKey(kind, ws, id);
    return bucketItems(scope).some(function (it) {
      return itemKey(it.kind, it.ws, it.id) === key;
    });
  }

  // 解析成可渲染/可注入的实体；已删除的条目自动跳过。
  // 纯函数：不在渲染期改 store（清理悬空挂载由 pruneIfNeeded 在 effect 里做）。
  function resolveMounted(scope) {
    if (!scope) return [];
    var items = bucketItems(scope);
    var out = [];
    items.forEach(function (it) {
      var doc = state.data.knowledge[it.ws];
      if (!doc) return;
      if (it.kind === "plan") {
        var plan = typeof doc.plan === "string" ? doc.plan : "";
        if (!plan.trim()) return;
        out.push({ kind: "plan", ws: it.ws, id: "plan", text: plan });
        return;
      }
      var list = it.kind === "note" ? doc.notes : doc.todos;
      var entry = (list || []).find(function (x) { return x.id === it.id; });
      if (!entry) return;
      out.push({ kind: it.kind, ws: it.ws, id: it.id, entry: entry, text: entry.text });
    });
    return out;
  }

  /** 清掉指向已删除条目的挂载记录（只从 effect / 事件里调用，不在渲染期）。 */
  function pruneIfNeeded(scope) {
    if (!scope) return;
    var items = bucketItems(scope);
    if (!items.length) return;
    var dangling = items.some(function (it) {
      var doc = state.data.knowledge[it.ws];
      if (!doc) return true;
      if (it.kind === "plan") return !String(doc.plan || "").trim();
      var list = it.kind === "note" ? doc.notes : doc.todos;
      return !(list || []).some(function (x) { return x.id === it.id; });
    });
    if (!dangling) return;
    mutate(function (data) {
      var bucket = data.mounts[scope];
      if (!bucket) return false;
      var kept = bucket.items.filter(function (it) {
        var doc = data.knowledge[it.ws];
        if (!doc) return false;
        if (it.kind === "plan") return String(doc.plan || "").trim() !== "";
        var list = it.kind === "note" ? doc.notes : doc.todos;
        return (list || []).some(function (x) { return x.id === it.id; });
      });
      if (kept.length === bucket.items.length) return false;
      if (kept.length) data.mounts[scope] = { items: kept, updatedAt: now() };
      else delete data.mounts[scope];
      return true;
    });
  }

  function toggleMount(kind, ws, id) {
    var scope = currentScope();
    if (!scope) {
      toast("当前没有活动会话，无法挂载；请先打开或新建一个会话", "warn");
      return;
    }
    var key = itemKey(kind, ws, id);
    mutate(function (data) {
      var bucket = data.mounts[scope] || { items: [], updatedAt: 0 };
      var exists = bucket.items.some(function (it) { return itemKey(it.kind, it.ws, it.id) === key; });
      var items = exists
        ? bucket.items.filter(function (it) { return itemKey(it.kind, it.ws, it.id) !== key; })
        : bucket.items.concat([{ kind: kind, ws: ws, id: kind === "plan" ? "plan" : id }]);
      if (items.length) data.mounts[scope] = { items: items, updatedAt: now() };
      else delete data.mounts[scope];
      return true;
    });
  }

  function unmountItem(scope, kind, ws, id) {
    var key = itemKey(kind, ws, id);
    mutate(function (data) {
      var bucket = data.mounts[scope];
      if (!bucket) return false;
      var items = bucket.items.filter(function (it) { return itemKey(it.kind, it.ws, it.id) !== key; });
      if (items.length === bucket.items.length) return false;
      if (items.length) data.mounts[scope] = { items: items, updatedAt: now() };
      else delete data.mounts[scope];
      return true;
    });
  }

  function clearScope(scope) {
    if (!scope) return;
    mutate(function (data) {
      if (!data.mounts[scope]) return false;
      delete data.mounts[scope];
      return true;
    });
    toast("已清空当前会话挂载的知识", "info");
  }

  // ---- 知识条目 CRUD ----

  function ensureDoc(data, ws) {
    if (!data.knowledge[ws]) data.knowledge[ws] = { notes: [], todos: [], plan: "", planUpdatedAt: 0 };
    return data.knowledge[ws];
  }

  function addEntry(kind, ws, text) {
    var body = String(text || "").trim();
    if (!body) return;
    mutate(function (data) {
      var doc = ensureDoc(data, ws);
      var list = kind === "note" ? doc.notes : doc.todos;
      list.unshift({ id: uid(kind === "note" ? "n" : "t"), text: body, done: false, createdAt: now(), updatedAt: now() });
      return true;
    });
  }

  function updateEntry(kind, ws, id, patch) {
    mutate(function (data) {
      var doc = data.knowledge[ws];
      if (!doc) return false;
      var list = kind === "note" ? doc.notes : doc.todos;
      var entry = list.find(function (x) { return x.id === id; });
      if (!entry) return false;
      Object.keys(patch).forEach(function (k) { entry[k] = patch[k]; });
      entry.updatedAt = now();
      return true;
    });
  }

  function removeEntry(kind, ws, id) {
    var key = itemKey(kind, ws, id);
    mutate(function (data) {
      var doc = data.knowledge[ws];
      if (!doc) return false;
      var changed = false;
      if (kind === "note") {
        var before = doc.notes.length;
        doc.notes = doc.notes.filter(function (x) { return x.id !== id; });
        changed = before !== doc.notes.length;
      } else {
        var beforeTodo = doc.todos.length;
        doc.todos = doc.todos.filter(function (x) { return x.id !== id; });
        changed = beforeTodo !== doc.todos.length;
      }
      // 条目删除即不再是可挂载内容：所有会话里的挂载记录一并清掉。
      Object.keys(data.mounts).forEach(function (scope) {
        var bucket = data.mounts[scope];
        if (!bucket) return;
        var kept = bucket.items.filter(function (it) { return itemKey(it.kind, it.ws, it.id) !== key; });
        if (kept.length === bucket.items.length) return;
        changed = true;
        if (kept.length) data.mounts[scope] = { items: kept, updatedAt: now() };
        else delete data.mounts[scope];
      });
      return changed;
    });
  }

  function setPlanText(ws, text) {
    var body = String(text == null ? "" : text);
    mutate(function (data) {
      var doc = ensureDoc(data, ws);
      if (doc.plan === body) return false;
      doc.plan = body;
      doc.planUpdatedAt = now();
      // 计划被清空 = 没有可挂载内容，顺手摘掉所有挂载记录。
      if (!body.trim()) {
        Object.keys(data.mounts).forEach(function (scope) {
          var bucket = data.mounts[scope];
          if (!bucket) return;
          var kept = bucket.items.filter(function (it) { return !(it.kind === "plan" && it.ws === ws); });
          if (kept.length === bucket.items.length) return;
          if (kept.length) data.mounts[scope] = { items: kept, updatedAt: now() };
          else delete data.mounts[scope];
        });
      }
      return true;
    });
  }

  // ================= 上下文注入 =================

  function buildContextText(scope) {
    var items = resolveMounted(scope);
    if (!items.length) return null;
    var notes = items.filter(function (i) { return i.kind === "note"; });
    var todos = items.filter(function (i) { return i.kind === "todo"; });
    var plans = items.filter(function (i) { return i.kind === "plan"; });

    var used = 0;
    var budget = MAX_CONTEXT_BYTES;
    var truncated = false;
    var parts = [];

    function push(text) {
      if (truncated) return;
      var size = byteLength(text) + 2;
      if (used + size > budget) {
        truncated = true;
        return;
      }
      used += size;
      parts.push(text);
    }

    push("以下是用户手动挂载到当前会话的项目知识（仅作参考；用户移出后即不再携带）。");

    if (notes.length) {
      push("## 笔记");
      notes.forEach(function (n) { push("- " + String(n.text).replace(/\n/g, "\n  ")); });
    }
    if (todos.length) {
      push("## 待办");
      todos.forEach(function (t) {
        push("- [" + (t.entry && t.entry.done ? "x" : " ") + "] " + String(t.text).replace(/\n/g, "\n  "));
      });
    }
    if (plans.length) {
      push("## 计划");
      plans.forEach(function (p) { push(String(p.text)); });
    }
    if (truncated) {
      parts.push("（其余挂载内容因单轮上下文长度限制已省略；如需完整内容请移出部分条目或精简笔记。）");
    }
    return parts.join("\n\n");
  }

  // ================= Markdown 预览（自包含，产出 React 节点，不拼 HTML） =================

  function mdInline(text, kp) {
    var out = [];
    var re = /(`[^`\n]+`|\*\*[^*\n]+\*\*|__[^_\n]+__|~~[^~\n]+~~|\*[^*\n]+\*|_[^_\n]+_|\[[^\]\n]*\]\([^)\s]+\))/g;
    var last = 0;
    var m;
    var k = 0;
    while ((m = re.exec(text))) {
      if (m.index > last) out.push(text.slice(last, m.index));
      var tok = m[0];
      var key = kp + "-" + (k++);
      if (tok.charAt(0) === "`") {
        out.push(h("code", { key: key, className: "pk-md-code" }, tok.slice(1, -1)));
      } else if (tok.slice(0, 2) === "**" || tok.slice(0, 2) === "__") {
        out.push(h("strong", { key: key }, tok.slice(2, -2)));
      } else if (tok.slice(0, 2) === "~~") {
        out.push(h("del", { key: key }, tok.slice(2, -2)));
      } else if (tok.charAt(0) === "*" || tok.charAt(0) === "_") {
        out.push(h("em", { key: key }, tok.slice(1, -1)));
      } else {
        // 链接只显示文本 + 地址，不生成可点击 a：宿主 webview 里点击会导航走整个应用。
        var lm = /^\[([^\]]*)\]\(([^)]+)\)$/.exec(tok);
        out.push(h("span", { key: key, className: "pk-md-link" }, (lm && lm[1]) || (lm && lm[2]) || tok));
      }
      last = m.index + tok.length;
    }
    if (last < text.length) out.push(text.slice(last));
    return out;
  }

  function renderMarkdown(src) {
    var lines = String(src || "").replace(/\r\n?/g, "\n").split("\n");
    var blocks = [];
    var i = 0;
    var k = 0;

    function blockStart(s) {
      return /^\s*(```|#{1,6}\s|>\s?|([-*+]|\d+\.)\s+|(---|\*\*\*|___)\s*$)/.test(s);
    }

    while (i < lines.length) {
      var line = lines[i];
      if (/^\s*$/.test(line)) { i++; continue; }
      var bk = "b" + (k++);

      if (/^\s*```/.test(line)) {
        var buf = [];
        i++;
        while (i < lines.length && !/^\s*```/.test(lines[i])) { buf.push(lines[i]); i++; }
        i++;
        blocks.push(h("pre", { key: bk, className: "pk-md-pre" }, h("code", null, buf.join("\n"))));
        continue;
      }

      var hm = /^(#{1,6})\s+(.*)$/.exec(line);
      if (hm) {
        blocks.push(h("div", { key: bk, className: "pk-md-h pk-md-h" + hm[1].length }, mdInline(hm[2], bk)));
        i++;
        continue;
      }

      if (/^\s*(---|\*\*\*|___)\s*$/.test(line)) {
        blocks.push(h("hr", { key: bk, className: "pk-md-hr" }));
        i++;
        continue;
      }

      if (/^\s*>/.test(line)) {
        var quote = [];
        while (i < lines.length && /^\s*>/.test(lines[i])) {
          quote.push(lines[i].replace(/^\s*>\s?/, ""));
          i++;
        }
        blocks.push(h("blockquote", { key: bk, className: "pk-md-quote" }, mdInline(quote.join(" "), bk)));
        continue;
      }

      var lm = /^\s*([-*+]|\d+\.)\s+/.exec(line);
      if (lm) {
        var ordered = /^\d+\./.test(lm[1]);
        var items = [];
        while (i < lines.length) {
          var cur = lines[i];
          var m2 = /^\s*([-*+]|\d+\.)\s+(.*)$/.exec(cur);
          if (!m2) {
            if (/^\s+\S/.test(cur) && items.length) {
              items[items.length - 1].text += " " + cur.trim();
              i++;
              continue;
            }
            break;
          }
          var t = m2[2];
          var chk = /^\[( |x|X)\]\s+(.*)$/.exec(t);
          items.push({ text: chk ? chk[2] : t, checked: chk ? chk[1].toLowerCase() === "x" : null });
          i++;
        }
        blocks.push(h(ordered ? "ol" : "ul", { key: bk, className: "pk-md-list" }, items.map(function (it, idx) {
          return h("li", { key: "l" + idx },
            it.checked === null ? null : h("span", { className: "pk-md-check" }, it.checked ? "☑ " : "☐ "),
            mdInline(it.text, bk + "-" + idx));
        })));
        continue;
      }

      var para = [line];
      i++;
      while (i < lines.length && !/^\s*$/.test(lines[i]) && !blockStart(lines[i])) {
        para.push(lines[i]);
        i++;
      }
      blocks.push(h("p", { key: bk, className: "pk-md-p" }, mdInline(para.join(" "), bk)));
    }

    if (!blocks.length) return h("div", { className: "pk-md-empty" }, "暂无内容");
    return h("div", { className: "pk-md" }, blocks);
  }

  // ================= 通用小组件 =================

  function Btn(props) {
    var cls = "pk-btn" + (props.primary ? " pk-btn-primary" : "") + (props.danger ? " pk-btn-danger" : "") +
      (props.ghost ? " pk-btn-ghost" : "") + (props.active ? " pk-btn-active" : "");
    return h("button", {
      type: "button",
      className: cls,
      title: props.title || undefined,
      disabled: props.disabled || undefined,
      onClick: props.onClick,
    }, props.children);
  }

  // 【加入上下文】/【移出上下文】成对出现：当前状态那一个高亮，另一个置灰，
  // 用户不用猜「现在这条到底在不在上下文里」。
  function MountBtn(props) {
    return h("span", { className: "pk-mount-group" },
      h("button", {
        type: "button",
        className: "pk-mount-btn" + (!props.mounted ? " is-on" : ""),
        title: "加入当前会话上下文：模型下次发送时即可读到这条内容",
        disabled: props.disabled || props.mounted || undefined,
        onClick: function (e) { e.stopPropagation(); props.onToggle(); },
      }, "加入上下文"),
      h("button", {
        type: "button",
        className: "pk-mount-btn" + (props.mounted ? " is-on" : ""),
        title: "从当前会话上下文中移出：后续发送不再携带这条内容",
        disabled: props.disabled || !props.mounted || undefined,
        onClick: function (e) { e.stopPropagation(); props.onToggle(); },
      }, "移出上下文"));
  }

  function CountBadge(props) {
    return h("span", { className: "pk-count-badge" }, String(props.n));
  }

  // ================= 笔记 Tab =================

  function NoteRow(props) {
    var entry = props.entry;
    var [editing, setEditing] = React.useState(false);
    var [draft, setDraft] = React.useState(entry.text);
    var [armed, setArmed] = React.useState(false);
    var armedTimer = React.useRef(null);

    React.useEffect(function () {
      setDraft(entry.text);
    }, [entry.text]);

    React.useEffect(function () {
      return function () { if (armedTimer.current) clearTimeout(armedTimer.current); };
    }, []);

    function askDelete() {
      if (!armed) {
        setArmed(true);
        armedTimer.current = setTimeout(function () { setArmed(false); }, 3000);
        return;
      }
      if (armedTimer.current) clearTimeout(armedTimer.current);
      setArmed(false);
      props.onRemove();
    }

    if (editing) {
      return h("div", { className: "pk-item pk-item-editing" },
        h("textarea", {
          className: "pk-textarea",
          rows: 3,
          autoFocus: true,
          value: draft,
          onChange: function (e) { setDraft(e.target.value); },
        }),
        h("div", { className: "pk-row-actions" },
          h(Btn, {
            primary: true,
            disabled: !draft.trim(),
            onClick: function () { props.onSave(draft); setEditing(false); },
          }, "保存"),
          h(Btn, { onClick: function () { setDraft(entry.text); setEditing(false); } }, "取消")));
    }

    return h("div", { className: "pk-item" },
      h("div", { className: "pk-item-text" }, entry.text),
      h("div", { className: "pk-item-foot" },
        h("span", { className: "pk-item-meta" }, fmtTime(entry.updatedAt)),
        h("div", { className: "pk-row-actions" },
          h(MountBtn, { mounted: props.mounted, disabled: props.mountDisabled, onToggle: props.onToggle }),
          h(Btn, { ghost: true, onClick: function () { setDraft(entry.text); setEditing(true); } }, "编辑"),
          h(Btn, {
            ghost: true,
            danger: armed,
            onClick: askDelete,
          }, armed ? "确认删除" : "删除"))));
  }

  function AddRow(props) {
    var [text, setText] = React.useState("");
    function submit() {
      if (!text.trim()) return;
      props.onAdd(text);
      setText("");
    }
    return h("div", { className: "pk-add" },
      props.multiline
        ? h("textarea", {
            className: "pk-textarea",
            rows: 2,
            placeholder: props.placeholder,
            value: text,
            onChange: function (e) { setText(e.target.value); },
            onKeyDown: function (e) {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submit(); }
            },
          })
        : h("input", {
            className: "pk-input",
            placeholder: props.placeholder,
            value: text,
            onChange: function (e) { setText(e.target.value); },
            onKeyDown: function (e) { if (e.key === "Enter") { e.preventDefault(); submit(); } },
          }),
      h(Btn, { primary: true, onClick: submit, disabled: !text.trim() }, "添加"));
  }

  function NotesTab(props) {
    var doc = props.doc;
    var items = React.useMemo(function () {
      return (doc.notes || []).slice().sort(function (a, b) { return (b.updatedAt || 0) - (a.updatedAt || 0); });
    }, [doc.notes]);

    return h("div", { className: "pk-tab-body" },
      h(AddRow, {
        multiline: true,
        placeholder: "记录上下文、提醒或链接（Ctrl/⌘+Enter 添加）",
        onAdd: function (t) { addEntry("note", props.ws, t); },
      }),
      items.length === 0
        ? h("div", { className: "pk-empty" }, "暂无笔记。把与项目相关的事实、约定、链接记在这里，需要时加入上下文。")
        : h("div", { className: "pk-list" }, items.map(function (entry) {
            return h(NoteRow, {
              key: entry.id,
              entry: entry,
              mounted: props.isMounted("note", props.ws, entry.id),
              mountDisabled: props.mountDisabled,
              onToggle: function () { toggleMount("note", props.ws, entry.id); },
              onSave: function (text) { updateEntry("note", props.ws, entry.id, { text: text.trim() }); },
              onRemove: function () { removeEntry("note", props.ws, entry.id); },
            });
          })));
  }

  // ================= 待办 Tab =================

  function TodoRow(props) {
    var entry = props.entry;
    var [editing, setEditing] = React.useState(false);
    var [draft, setDraft] = React.useState(entry.text);
    var [armed, setArmed] = React.useState(false);
    var armedTimer = React.useRef(null);

    React.useEffect(function () { setDraft(entry.text); }, [entry.text]);
    React.useEffect(function () {
      return function () { if (armedTimer.current) clearTimeout(armedTimer.current); };
    }, []);

    function askDelete() {
      if (!armed) {
        setArmed(true);
        armedTimer.current = setTimeout(function () { setArmed(false); }, 3000);
        return;
      }
      if (armedTimer.current) clearTimeout(armedTimer.current);
      setArmed(false);
      props.onRemove();
    }

    var check = h("input", {
      type: "checkbox",
      className: "pk-check",
      checked: entry.done === true,
      title: entry.done ? "标记为未完成" : "标记为已完成",
      onChange: function () { props.onToggleDone(!entry.done); },
    });

    if (editing) {
      return h("div", { className: "pk-item pk-item-editing" },
        h("div", { className: "pk-item-main" }, check,
          h("textarea", {
            className: "pk-textarea",
            rows: 2,
            autoFocus: true,
            value: draft,
            onChange: function (e) { setDraft(e.target.value); },
          })),
        h("div", { className: "pk-row-actions" },
          h(Btn, {
            primary: true,
            disabled: !draft.trim(),
            onClick: function () { props.onSave(draft); setEditing(false); },
          }, "保存"),
          h(Btn, { onClick: function () { setDraft(entry.text); setEditing(false); } }, "取消")));
    }

    return h("div", { className: "pk-item pk-todo" + (entry.done ? " is-done" : "") },
      h("div", { className: "pk-item-main" }, check,
        h("div", { className: "pk-item-text" }, entry.text)),
      h("div", { className: "pk-item-foot" },
        h("span", { className: "pk-item-meta" }, entry.done ? "已完成 · " + fmtTime(entry.updatedAt) : fmtTime(entry.updatedAt)),
        h("div", { className: "pk-row-actions" },
          h(MountBtn, { mounted: props.mounted, disabled: props.mountDisabled, onToggle: props.onToggle }),
          h(Btn, { ghost: true, onClick: function () { setDraft(entry.text); setEditing(true); } }, "编辑"),
          h(Btn, { ghost: true, danger: armed, onClick: askDelete }, armed ? "确认删除" : "删除"))));
  }

  function TodosTab(props) {
    var doc = props.doc;
    var items = React.useMemo(function () {
      var list = (doc.todos || []).slice();
      list.sort(function (a, b) {
        if ((a.done === true) !== (b.done === true)) return a.done ? 1 : -1;
        return (b.createdAt || 0) - (a.createdAt || 0);
      });
      return list;
    }, [doc.todos]);
    var openCount = items.filter(function (x) { return !x.done; }).length;

    return h("div", { className: "pk-tab-body" },
      h(AddRow, {
        placeholder: "记录一个开发任务或事项，回车添加",
        onAdd: function (t) { addEntry("todo", props.ws, t); },
      }),
      items.length === 0
        ? h("div", { className: "pk-empty" }, "暂无待办。记录要做的开发事项，勾选复选框切换完成状态。")
        : h("div", { className: "pk-list" },
            h("div", { className: "pk-list-summary" }, "未完成 " + openCount + " / 共 " + items.length),
            items.map(function (entry) {
              return h(TodoRow, {
                key: entry.id,
                entry: entry,
                mounted: props.isMounted("todo", props.ws, entry.id),
                mountDisabled: props.mountDisabled,
                onToggle: function () { toggleMount("todo", props.ws, entry.id); },
                onToggleDone: function (done) { updateEntry("todo", props.ws, entry.id, { done: done }); },
                onSave: function (text) { updateEntry("todo", props.ws, entry.id, { text: text.trim() }); },
                onRemove: function () { removeEntry("todo", props.ws, entry.id); },
              });
            })));
  }

  // ================= 计划 Tab =================

  function PlanTab(props) {
    var ws = props.ws;
    var doc = props.doc;
    var saved = typeof doc.plan === "string" ? doc.plan : "";
    var [text, setText] = React.useState(saved);
    var [mode, setMode] = React.useState("edit");
    var [sending, setSending] = React.useState(false);
    var lastSaved = React.useRef(saved);
    var timer = React.useRef(null);
    var textRef = React.useRef(text);
    textRef.current = text;

    React.useEffect(function () {
      if (saved !== lastSaved.current) {
        lastSaved.current = saved;
        setText(saved);
      }
    }, [saved]);

    // 卸载（切 Tab / 关面板 / 换工作区）前把未落盘的编辑刷出去。
    React.useEffect(function () {
      return function () {
        if (timer.current) {
          clearTimeout(timer.current);
          timer.current = null;
          setPlanText(ws, textRef.current);
        }
      };
    }, []);

    function scheduleSave(next) {
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(function () {
        timer.current = null;
        lastSaved.current = next;
        setPlanText(ws, next);
      }, 600);
    }

    function onChange(value) {
      setText(value);
      scheduleSave(value);
    }

    function flush() {
      if (timer.current) {
        clearTimeout(timer.current);
        timer.current = null;
      }
      lastSaved.current = text;
      setPlanText(ws, text);
    }

    async function sendPlan() {
      var body = String(text || "").trim();
      if (!body) {
        toast("计划内容为空，先写点东西再发送", "warn");
        return;
      }
      flush();
      setSending(true);
      var engine = state.active.engine;
      var sessionId = state.active.sessionId;
      var targetWs = state.activeWs || ws;
      try {
        if (!engine) throw new Error("当前没有活动会话");
        if (!ctx.sessions || typeof ctx.sessions.startRun !== "function") throw new Error("当前宿主不支持直接发送");
        // 宿主没有「往当前会话追加一条消息」的插件 API；startRun 是唯一的
        // 「像用户自己发了一条」通道。宿主支持 resume 时带上当前 sessionId，
        // 计划就落进当前对话；否则只能开一个新会话（toast 里如实说明）。
        var canResume = ctx.sessions.supportsResume === true && !!sessionId;
        var def = { engine: engine, prompt: body, workspacePath: targetWs };
        if (canResume) def.sessionId = sessionId;
        var res = await ctx.sessions.startRun(def);
        var sid = (res && res.sessionId) || sessionId || null;
        toast(canResume ? "已发送到当前会话" : "已作为消息发送到新会话", "ok", {
          label: "打开会话",
          run: function () {
            if (sid) ctx.sessions.selectSession(engine, sid, targetWs).catch(function () { /* 打开失败时保持原状 */ });
            else toast("会话仍在启动，稍后在侧栏打开即可", "info");
          },
        });
      } catch (err) {
        // 无法自动发送（无活动会话 / 旧宿主）：退化为写入输入框，绝不静默失败。
        try {
          ctx.composer.setDraft(body);
          toast("未能自动发送（" + ((err && err.message) || "宿主限制") + "），已写入输入框，请手动发送", "warn");
        } catch (e2) {
          toast("发送失败：" + ((err && err.message) || "未知错误"), "err");
        }
      } finally {
        setSending(false);
      }
    }

    var mounted = props.isMounted("plan", ws, "plan");
    var words = text.trim() ? text.trim().split(/\s+/).length : 0;

    return h("div", { className: "pk-tab-body pk-plan" },
      h("div", { className: "pk-plan-toolbar" },
        h("div", { className: "pk-seg" },
          h("button", {
            type: "button",
            className: "pk-seg-btn" + (mode === "edit" ? " is-active" : ""),
            onClick: function () { flush(); setMode("edit"); },
          }, "编辑"),
          h("button", {
            type: "button",
            className: "pk-seg-btn" + (mode === "preview" ? " is-active" : ""),
            onClick: function () { flush(); setMode("preview"); },
          }, "预览")),
        h("span", { className: "pk-item-meta" }, words + " 词" + (doc.planUpdatedAt ? " · " + fmtTime(doc.planUpdatedAt) : ""))),

      mode === "edit"
        ? h("textarea", {
            className: "pk-textarea pk-plan-textarea",
            placeholder: "用 Markdown 写计划：目标、步骤、验收标准…（内容自动保存）",
            value: text,
            onChange: function (e) { onChange(e.target.value); },
            onBlur: flush,
          })
        : h("div", { className: "pk-plan-preview" }, renderMarkdown(text)),

      h("div", { className: "pk-plan-actions" },
        h(Btn, {
          primary: true,
          disabled: sending || !text.trim(),
          title: "把当前 Markdown 直接作为一条消息发送到对话（宿主能力所限会开启一个新会话）",
          onClick: function () { void sendPlan(); },
        }, sending ? "发送中…" : "发送到会话"),
        h("span", { className: "pk-mount-group" },
          h(Btn, {
            disabled: props.mountDisabled || mounted,
            active: !mounted,
            title: "加入当前会话上下文：模型下次发送时即可读到这份计划",
            onClick: function () { flush(); toggleMount("plan", ws, "plan"); },
          }, "加入上下文"),
          h(Btn, {
            disabled: props.mountDisabled || !mounted,
            active: mounted,
            title: "从当前会话上下文中移出：后续发送不再携带这份计划",
            onClick: function () { flush(); toggleMount("plan", ws, "plan"); },
          }, "移出上下文"))));
  }

  // ================= 挂载清单弹层 =================

  var KIND_LABEL = { note: "笔记", todo: "待办", plan: "计划" };

  function ListModal(props) {
    var scope = props.scope;
    var mounted = props.mounted;
    var [armed, setArmed] = React.useState(false);
    var armedTimer = React.useRef(null);

    React.useEffect(function () {
      function onKey(e) { if (e.key === "Escape") props.onClose(); }
      document.addEventListener("keydown", onKey, true);
      return function () {
        document.removeEventListener("keydown", onKey, true);
        if (armedTimer.current) clearTimeout(armedTimer.current);
      };
    }, []);

    function askClear() {
      if (!armed) {
        setArmed(true);
        armedTimer.current = setTimeout(function () { setArmed(false); }, 3000);
        return;
      }
      if (armedTimer.current) clearTimeout(armedTimer.current);
      setArmed(false);
      clearScope(scope);
      props.onClose();
    }

    var groups = ["note", "todo", "plan"].map(function (kind) {
      return { kind: kind, items: mounted.filter(function (m) { return m.kind === kind; }) };
    }).filter(function (g) { return g.items.length > 0; });

    return h("div", {
      className: "pk-modal-backdrop",
      onClick: function (e) { if (e.target === e.currentTarget) props.onClose(); },
    },
      h("div", { className: "pk-modal", role: "dialog", "aria-label": "已挂载清单" },
        h("div", { className: "pk-modal-head" },
          h("div", { className: "pk-modal-title" }, "当前会话已挂载 " + mounted.length + " 条知识"),
          h("button", { type: "button", className: "pk-icon-btn", "aria-label": "关闭", onClick: props.onClose }, "✕")),
        h("div", { className: "pk-modal-body" },
          mounted.length === 0
            ? h("div", { className: "pk-empty" }, "当前会话还没有挂载任何知识。在笔记 / 待办 / 计划里点「加入上下文」即可。")
            : groups.map(function (g) {
                return h("div", { key: g.kind, className: "pk-modal-group" },
                  h("div", { className: "pk-modal-group-title" }, KIND_LABEL[g.kind] + " · " + g.items.length),
                  g.items.map(function (m) {
                    return h("div", { key: itemKey(m.kind, m.ws, m.id), className: "pk-modal-row" },
                      h("div", { className: "pk-modal-row-main" },
                        h("div", { className: "pk-modal-row-text" }, snippet(m.text, 90)),
                        h("div", { className: "pk-item-meta" }, wsName(m.ws) + (m.kind === "todo" && m.entry && m.entry.done ? " · 已完成" : ""))),
                      h(Btn, {
                        ghost: true,
                        onClick: function () { unmountItem(scope, m.kind, m.ws, m.id); },
                      }, "移出"));
                  }));
              })),
        h("div", { className: "pk-modal-foot" },
          h(Btn, {
            danger: armed,
            disabled: mounted.length === 0,
            onClick: askClear,
          }, armed ? "确认清空？" : "一键清空"),
          h(Btn, { onClick: props.onClose }, "关闭"))));
  }

  // ================= 右侧面板 =================

  function Panel(props) {
    var snap = React.useSyncExternalStore(subscribe, getSnapshot);
    var ws = props.workspacePath || snap.activeWs || "";
    var [tab, setTab] = React.useState("notes");
    var [showList, setShowList] = React.useState(false);
    var [armedClear, setArmedClear] = React.useState(false);
    var armedTimer = React.useRef(null);

    React.useEffect(function () {
      void ensureLoaded();
    }, []);

    React.useEffect(function () {
      setActiveWs(props.workspacePath || "");
    }, [props.workspacePath]);

    React.useEffect(function () {
      return function () { if (armedTimer.current) clearTimeout(armedTimer.current); };
    }, []);

    var doc = snap.data.knowledge[ws] || { notes: [], todos: [], plan: "", planUpdatedAt: 0 };
    var scope = currentScope();
    var mounted = scope ? resolveMounted(scope) : [];
    var mountDisabled = !scope;

    // 面板打开期间顺手清掉指向已删除条目的挂载记录（只可能在外部手改数据后出现）。
    React.useEffect(function () {
      if (scope) pruneIfNeeded(scope);
    }, [snap.data, scope]);

    var isMountedFn = React.useCallback(function (kind, w, id) {
      return scope ? isMounted(scope, kind, w, id) : false;
    }, [snap.data, scope]);

    function askClear() {
      if (!scope) return;
      if (!armedClear) {
        setArmedClear(true);
        armedTimer.current = setTimeout(function () { setArmedClear(false); }, 3000);
        return;
      }
      if (armedTimer.current) clearTimeout(armedTimer.current);
      setArmedClear(false);
      clearScope(scope);
    }

    var tabDefs = [
      { key: "notes", label: "笔记", count: (doc.notes || []).length },
      { key: "todos", label: "待办", count: (doc.todos || []).length },
      { key: "plan", label: "计划", count: String(doc.plan || "").trim() ? 1 : 0 },
    ];

    return h("div", { className: "pk-root", "data-pk-ui": "1" },
      h("div", { className: "pk-header" },
        h("div", { className: "pk-header-line" },
          h("span", { className: "pk-header-title" }, "当前上下文已挂载 "),
          h("strong", { className: "pk-header-count" }, String(mounted.length)),
          h("span", { className: "pk-header-title" }, " 条知识")),
        h("div", { className: "pk-header-actions" },
          h("button", {
            type: "button",
            className: "pk-link-btn",
            onClick: function () { setShowList(true); },
          }, "查看清单"),
          h("button", {
            type: "button",
            className: "pk-link-btn" + (armedClear ? " is-danger" : ""),
            disabled: mounted.length === 0,
            onClick: askClear,
          }, armedClear ? "确认清空" : "一键清空"))),

      h("div", { className: "pk-tabs", role: "tablist" },
        tabDefs.map(function (t) {
          return h("button", {
            key: t.key,
            type: "button",
            role: "tab",
            "aria-selected": tab === t.key,
            className: "pk-tab" + (tab === t.key ? " is-active" : ""),
            onClick: function () { setTab(t.key); },
          }, h("span", null, t.label), h(CountBadge, { n: t.count }));
        })),

      !scope
        ? h("div", { className: "pk-hint" }, "未检测到活动会话：内容仍可编辑，但「加入上下文」需先打开或新建一个会话。")
        : null,

      h("div", { className: "pk-content" },
        tab === "notes" ? h(NotesTab, { key: "n:" + ws, ws: ws, doc: doc, isMounted: isMountedFn, mountDisabled: mountDisabled })
          : tab === "todos" ? h(TodosTab, { key: "t:" + ws, ws: ws, doc: doc, isMounted: isMountedFn, mountDisabled: mountDisabled })
            : h(PlanTab, { key: "p:" + ws, ws: ws, doc: doc, isMounted: isMountedFn, mountDisabled: mountDisabled })),

      snap.error ? h("div", { className: "pk-error" }, "存储异常：" + snap.error) : null,
      snap.toast ? h(Toast, { toast: snap.toast }) : null,
      showList ? h(ListModal, {
        scope: scope,
        mounted: mounted,
        onClose: function () { setShowList(false); },
      }) : null);
  }

  function Toast(props) {
    var t = props.toast;
    var toneCls = t.tone === "err" ? " is-err" : t.tone === "warn" ? " is-warn" : t.tone === "ok" ? " is-ok" : "";
    return h("div", { className: "pk-toast" + toneCls, role: "status" },
      h("span", { className: "pk-toast-text" }, t.text),
      t.action ? h("button", {
        type: "button",
        className: "pk-toast-action",
        onClick: function () { dismissToast(); try { t.action.run(); } catch (e) { /* 动作失败已由各自 toast 呈现 */ } },
      }, t.action.label) : null,
      h("button", { type: "button", className: "pk-icon-btn", "aria-label": "关闭提示", onClick: dismissToast }, "✕"));
  }

  // ================= 输入框状态条 chip =================

  function StatusChip() {
    var snap = React.useSyncExternalStore(subscribe, getSnapshot);
    var [open, setOpen] = React.useState(false);
    var boxRef = React.useRef(null);

    React.useEffect(function () {
      void ensureLoaded();
    }, []);

    React.useEffect(function () {
      if (!open) return;
      function onDown(e) {
        if (boxRef.current && !boxRef.current.contains(e.target)) setOpen(false);
      }
      function onKey(e) { if (e.key === "Escape") setOpen(false); }
      document.addEventListener("mousedown", onDown, true);
      document.addEventListener("keydown", onKey, true);
      return function () {
        document.removeEventListener("mousedown", onDown, true);
        document.removeEventListener("keydown", onKey, true);
      };
    }, [open]);

    var scope = currentScope();
    var mounted = scope ? resolveMounted(scope) : [];

    return h("div", { className: "pk-chip-wrap", ref: boxRef },
      h("button", {
        type: "button",
        className: "pk-chip" + (mounted.length ? " has-items" : ""),
        title: "项目知识：当前会话已挂载 " + mounted.length + " 条",
        onClick: function () { setOpen(function (v) { return !v; }); },
      },
        h("span", { className: "pk-chip-dot" }),
        h("span", null, "项目知识"),
        h("span", { className: "pk-chip-n" }, String(mounted.length))),

      open ? h("div", { className: "pk-chip-pop" },
        h("div", { className: "pk-chip-pop-head" },
          h("span", null, "已挂载 " + mounted.length + " 条知识"),
          h("button", { type: "button", className: "pk-icon-btn", "aria-label": "关闭", onClick: function () { setOpen(false); } }, "✕")),
        mounted.length === 0
          ? h("div", { className: "pk-empty pk-chip-empty" }, "尚未挂载。打开右侧「项目知识」面板，点条目上的「加入上下文」。")
          : h("div", { className: "pk-chip-list" }, mounted.map(function (m) {
              return h("div", { key: itemKey(m.kind, m.ws, m.id), className: "pk-chip-row" },
                h("span", { className: "pk-chip-kind" }, KIND_LABEL[m.kind]),
                h("span", { className: "pk-chip-text" }, snippet(m.text, 60)),
                h("button", {
                  type: "button",
                  className: "pk-icon-btn",
                  title: "移出上下文",
                  onClick: function () { unmountItem(scope, m.kind, m.ws, m.id); },
                }, "−"));
            })),
        mounted.length > 0
          ? h("div", { className: "pk-chip-pop-foot" },
              h("button", {
                type: "button",
                className: "pk-link-btn is-danger",
                onClick: function () { clearScope(scope); },
              }, "一键清空"))
          : null)
        : null);
  }

  // ================= 注册扩展点 =================

  // 会话切换：记录活动会话，并把 pending 桶并入会话桶。
  var offActivated = ctx.events.on("session://activated", function (payload) {
    var p = payload && typeof payload === "object" ? payload : {};
    var engine = typeof p.engine === "string" ? p.engine : null;
    var sessionId = typeof p.sessionId === "string" ? p.sessionId : null;
    setState({ active: { engine: engine, sessionId: sessionId } });
    if (engine && sessionId) {
      void ensureLoaded().then(function () { migratePending(engine, sessionId, state.activeWs); });
    }
  });

  // 发送前注入：挂载了什么就带什么，未挂载/已移出的不带；按会话隔离。
  ctx.hooks.registerTurnHooks({
    beforeTurn: function (event) {
      return ensureLoaded().then(function () {
        var engine = event && event.engine ? event.engine : (state.active.engine || "");
        var sessionId = event && event.sessionId ? event.sessionId : null;
        var ws = (event && event.workspace && event.workspace.path) || state.activeWs || "";
        if (engine && sessionId) migratePending(engine, sessionId, ws);
        var scope = scopeKey(engine, sessionId, ws);
        var text = buildContextText(scope);
        if (!text) return undefined;
        return {
          promptContributions: [{
            id: NS + ":mounted-context",
            content: text,
            placement: "request-tail",
            visibility: "internal",
            persistence: "turn",
          }],
        };
      }).catch(function (err) {
        console.error("[" + NS + "] beforeTurn failed", err);
        return undefined;
      });
    },
  });

  ctx.ui.registerPanelTab({
    key: NS,
    label: function () { return "项目知识"; },
    component: function (props) { return h(Panel, { workspacePath: props && props.workspacePath }); },
    order: 25,
  });

  ctx.ui.registerComposerStatusItem({
    key: NS + ":chip",
    component: StatusChip,
    order: 40,
  });

  void ensureLoaded();

  return function dispose() {
    try { offActivated(); } catch (e) { /* 宿主也会逆序回收 Disposer */ }
    if (toastTimer) { clearTimeout(toastTimer); toastTimer = null; }
  };
}
