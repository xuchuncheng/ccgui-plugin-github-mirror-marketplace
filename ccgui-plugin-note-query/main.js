// 便签会话查询插件（CC GUI / ccgui-next，Tier-1 JS 插件，单文件 ESM）
//
// 存储模型（v0.2 起，中央统一存储）：
//   · 全部便签集中存于 ~/.ccgui-next/plugin-data/note-query/notes.json（单文件，按工作区打标签）。
//   · 每条便签的「归属工作区」由宿主 app.db 的 sessions 表按 session_id 权威解析（不再靠 DOM 猜），
//     彻底消除「存错工作区」。
//   · 右侧便签栏默认只显示当前工作区的便签，可切「全部工作区」；卡片支持「移动到其他工作区」
//     （改一个 workspacePath 字段即完成迁移，无需跨文件搬运）。
//   · 首次加载自动把历史散落在各工作区 .ccgui/notes.json 的便签合并进中央文件并纠正错位，
//     原文件改名 *.migrated.bak 保留。
//
// 定位：selectSession(engine,sessionId,workspacePath) + session://activated 回执确认，
//       再以「复合会话ID」经 React fiber 精确锚定侧栏行挂跑马灯。
//
// 约束：单文件 ESM，零模块依赖；组件用 ctx.react.createElement 手工构造；不使用动态求值、
//       不碰宿主内部对象与浏览器本地存储；注入 CSS 自包含（无外链引用）。

// ---------- 常量 ----------
var NS = "note-query";
var ACCENT = "#e8703a"; // 与宿主强调色一致，自包含

// ---- 主题：只跟随本软件「通用设置 → 主题外观」的实际生效状态（宿主把它落到 DOM 上：
//      class/data-theme/color-scheme/主题变量/背景色），不直接看 Windows 系统深浅色。
//      宿主若设了"跟随系统"，它自己会响应系统切换并改 DOM——我们只观察 DOM 即可。
//      探测链：主题标记 → color-scheme 计算值 → 宿主语义 token 变量亮度 → 页面背景亮度采样。
function parseColorToRgb(s) {
  s = String(s || "").trim();
  var m = /rgba?\(([^)]+)\)/.exec(s);
  if (m) {
    var p = m[1].split(/[,\s/]+/).filter(Boolean);
    return [+p[0], +p[1], +p[2]];
  }
  m = /^#([0-9a-f]{3,8})$/i.exec(s);
  if (m) {
    var hx = m[1];
    if (hx.length === 3) hx = hx[0] + hx[0] + hx[1] + hx[1] + hx[2] + hx[2];
    if (hx.length >= 6) return [parseInt(hx.slice(0, 2), 16), parseInt(hx.slice(2, 4), 16), parseInt(hx.slice(4, 6), 16)];
  }
  return null;
}
function luminanceIsLight(rgb) {
  return (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) / 255 > 0.5;
}
function isLightNow() {
  var de = document.documentElement, b = document.body;
  try {
    // 1) 宿主主题标记
    var dark = (de.classList && de.classList.contains("dark")) ||
               (b && b.classList && b.classList.contains("dark")) ||
               de.getAttribute("data-theme") === "dark";
    var light = (de.classList && de.classList.contains("light")) ||
                de.getAttribute("data-theme") === "light";
    if (light && !dark) return true;
    if (dark && !light) return false;
    // 2) color-scheme 计算值（宿主主题设置通常会写这个，跟随系统时也生效）
    var cs = getComputedStyle(de).colorScheme || "";
    if (cs.indexOf("light") >= 0 && cs.indexOf("dark") < 0) return true;
    if (cs.indexOf("dark") >= 0 && cs.indexOf("light") < 0) return false;
  } catch (e) {}
  try {
    // 3) 宿主语义 token：主题外观改变时这些变量必然改变
    var tok = getComputedStyle(de).getPropertyValue("--background-primary-default") ||
              getComputedStyle(de).getPropertyValue("--background-base") ||
              getComputedStyle(de).getPropertyValue("--background");
    var rgb = parseColorToRgb(tok);
    if (rgb) return luminanceIsLight(rgb);
  } catch (e) {}
  try {
    // 4) 页面实际背景亮度采样（背景由宿主按其主题设置绘制，天然反映应用内主题）
    var el = b || de, bg = "";
    while (el) {
      bg = getComputedStyle(el).backgroundColor || "";
      if (bg && bg !== "rgba(0, 0, 0, 0)" && bg !== "transparent") break;
      el = el.parentElement;
    }
    var rgb2 = parseColorToRgb(bg);
    if (rgb2) return luminanceIsLight(rgb2);
  } catch (e) {}
  return false; // 完全探测不到时保持深色（原行为）
}
var PAL_LIGHT = {
  scheme: "light",
  text: "#111827", text2: "#374151", muted: "#9ca3af",
  card: "#ffffff", cardBorder: "rgba(0,0,0,.06)",
  cardShadow: "0 1px 2px rgba(16,24,40,.05), 0 10px 24px -14px rgba(16,24,40,.14)",
  badgeBg: "#f3f4f6", badgeText: "#374151",
  input: "#ffffff", inputBorder: "rgba(0,0,0,.14)",
  modalBg: "#ffffff", backdrop: "rgba(15,23,42,.32)",
  locatedBg: "rgba(232,112,58,.08)",
  errBg: "rgba(239,68,68,.08)", errText: "#dc2626",
};
var PAL_DARK = {
  scheme: "dark",
  text: "#e5e7eb", text2: "#c9ced6", muted: "#8b929c",
  card: "rgba(128,128,128,.06)", cardBorder: "rgba(128,128,128,.35)",
  cardShadow: "none",
  badgeBg: "rgba(128,128,128,.18)", badgeText: "#c9ced6",
  input: "transparent", inputBorder: "rgba(128,128,128,.45)",
  modalBg: "#1e1e1e", backdrop: "rgba(0,0,0,.45)",
  locatedBg: "rgba(232,112,58,.12)",
  errBg: "rgba(179,38,30,.15)", errText: "#e0524d",
};
function palNow() { return isLightNow() ? PAL_LIGHT : PAL_DARK; }

// ---- 内嵌 python 脚本（经 exec:python3 运行；内容/路径走 base64 env，规避 Windows 引号与编码）----

// BOOT：若中央文件未迁移则执行一次性迁移（合并各工作区旧文件 + 用 app.db 纠正归属 + 备份旧文件），
// 然后输出当前模型 base64。已迁移则直接输出。
var BOOT_PY = [
  "import os,base64,json,sqlite3,sys",
  "home=os.path.expanduser('~')",
  "pdata=os.path.join(home,'.ccgui-next','plugin-data','note-query')",
  "central=os.path.join(pdata,'notes.json')",
  "dbpath=os.path.join(home,'.ccgui-next','app.db').replace(os.sep,'/')",
  "def rd(p):",
  "    try:",
  "        f=open(p,'rb'); d=f.read(); f.close(); return d",
  "    except Exception: return b''",
  "def loadc():",
  "    d=rd(central)",
  "    if not d.strip(): return None",
  "    try: return json.loads(d.decode('utf-8'))",
  "    except Exception: return None",
  "def db(sql,args=()):",
  "    try:",
  "        con=sqlite3.connect('file:%s?mode=ro'%dbpath,uri=True)",
  "        r=con.execute(sql,args).fetchall(); con.close(); return r",
  "    except Exception: return []",
  "m=loadc()",
  "if m and m.get('version')==2 and m.get('migrated'):",
  "    print(base64.b64encode(json.dumps(m,ensure_ascii=False).encode('utf-8')).decode('ascii')); sys.exit(0)",
  "merged={}; order=[]",
  "def absorb(notes):",
  "    for n in notes or []:",
  "        if not isinstance(n,dict): continue",
  "        nid=n.get('id') or ('n_imp_%d'%len(order))",
  "        if nid not in merged: merged[nid]=n; order.append(nid)",
  "if m and isinstance(m.get('notes'),list): absorb(m['notes'])",
  "rows=db('SELECT path FROM workspaces')",
  "for (wp,) in rows:",
  "    if not wp: continue",
  "    legacy=os.path.join(wp,'.ccgui','notes.json')",
  "    d=rd(legacy)",
  "    if not d.strip(): continue",
  "    try: lm=json.loads(d.decode('utf-8'))",
  "    except Exception: continue",
  "    absorb(lm.get('notes') if isinstance(lm,dict) else (lm if isinstance(lm,list) else []))",
  "    try: os.replace(legacy, legacy+'.migrated.bak')",
  "    except Exception: pass",
  "for nid in order:",
  "    n=merged[nid]",
  "    sid=(n.get('session') or {}).get('sessionId') if isinstance(n.get('session'),dict) else None",
  "    if sid:",
  "        r=db('SELECT workspace_path FROM sessions WHERE session_id=?',(sid,))",
  "        if r and r[0][0]: n['workspacePath']=r[0][0]",
  "out={'version':2,'migrated':True,'notes':[merged[k] for k in order]}",
  "os.makedirs(pdata,exist_ok=True)",
  "tmp=central+'.tmp'",
  "f=open(tmp,'wb'); f.write(json.dumps(out,ensure_ascii=False).encode('utf-8')); f.flush(); os.fsync(f.fileno()); f.close()",
  "os.replace(tmp,central)",
  "print(base64.b64encode(json.dumps(out,ensure_ascii=False).encode('utf-8')).decode('ascii'))",
].join("\n");

// READ：读中央文件输出模型 base64；缺文件回退空模型。
var READ_PY = [
  "import os,base64",
  "home=os.path.expanduser('~')",
  "p=os.path.join(home,'.ccgui-next','plugin-data','note-query','notes.json')",
  "d=b''",
  "try:",
  "    f=open(p,'rb'); d=f.read(); f.close()",
  "except Exception: d=b''",
  "if not d.strip(): d=b'{\"version\":2,\"migrated\":true,\"notes\":[]}'",
  "print(base64.b64encode(d).decode('ascii'))",
].join("\n");

// WRITE：base64 解码 env → 原子替换写中央文件。
var WRITE_PY = [
  "import os,base64",
  "home=os.path.expanduser('~')",
  "raw=base64.b64decode(os.environ.get('NQ_B64',''))",
  "d=os.path.join(home,'.ccgui-next','plugin-data','note-query')",
  "os.makedirs(d,exist_ok=True)",
  "tmp=os.path.join(d,'notes.json.tmp')",
  "dst=os.path.join(d,'notes.json')",
  "f=open(tmp,'wb'); f.write(raw); f.flush(); os.fsync(f.fileno()); f.close()",
  "os.replace(tmp,dst)",
  "print('OK')",
].join("\n");

// RESOLVE：按 session_id(+engine) 从 app.db 权威解析 {workspace_path, custom_title/title}。
var RESOLVE_PY = [
  "import os,base64,json,sqlite3",
  "home=os.path.expanduser('~')",
  "dbpath=os.path.join(home,'.ccgui-next','app.db').replace(os.sep,'/')",
  "sid=os.environ.get('NQ_SID',''); eng=os.environ.get('NQ_ENGINE','')",
  "ws=''; title=''",
  "try:",
  "    con=sqlite3.connect('file:%s?mode=ro'%dbpath,uri=True)",
  "    r=None",
  "    if eng: r=con.execute('SELECT workspace_path,custom_title,title FROM sessions WHERE session_id=? AND engine=?',(sid,eng)).fetchone()",
  "    if not r: r=con.execute('SELECT workspace_path,custom_title,title FROM sessions WHERE session_id=?',(sid,)).fetchone()",
  "    con.close()",
  "    if r: ws=r[0] or ''; title=r[1] or r[2] or ''",
  "except Exception: pass",
  "print(base64.b64encode(json.dumps({'ws':ws,'title':title},ensure_ascii=False).encode('utf-8')).decode('ascii'))",
].join("\n");

// WSLIST：app.db 全部登记工作区 [{path,name}]（供「移动到其他工作区」下拉）。
var WSLIST_PY = [
  "import os,base64,json,sqlite3",
  "home=os.path.expanduser('~')",
  "dbpath=os.path.join(home,'.ccgui-next','app.db').replace(os.sep,'/')",
  "out=[]",
  "try:",
  "    con=sqlite3.connect('file:%s?mode=ro'%dbpath,uri=True)",
  "    rows=con.execute('SELECT path,name FROM workspaces ORDER BY last_opened_at DESC').fetchall()",
  "    con.close()",
  "    for path,name in rows:",
  "        if not path: continue",
  "        nm=name or path.replace(chr(92),'/').rstrip('/').split('/')[-1]",
  "        out.append({'path':path,'name':nm})",
  "except Exception: out=[]",
  "print(base64.b64encode(json.dumps(out,ensure_ascii=False).encode('utf-8')).decode('ascii'))",
].join("\n");

// LOGDIAG：把 base64 文本追加到中央目录 note-query-diag.log（宿主无 DevTools 时回传诊断）。
var LOGDIAG_PY = [
  "import os,base64",
  "home=os.path.expanduser('~')",
  "raw=base64.b64decode(os.environ.get('NQ_LOG','')).decode('utf-8')",
  "d=os.path.join(home,'.ccgui-next','plugin-data','note-query')",
  "os.makedirs(d,exist_ok=True)",
  "f=open(os.path.join(d,'note-query-diag.log'),'a',encoding='utf-8')",
  "f.write(raw); f.close()",
  "print('OK')",
].join("\n");

// ---------- 纯工具 ----------
function zh(locale) { return String(locale || "").toLowerCase().indexOf("zh") === 0; }

function todayStr() {
  var d = new Date(), p = function (n) { return (n < 10 ? "0" : "") + n; };
  return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
}

function newId() {
  return "n_" + Date.now().toString(36) + "_" + Math.floor(Math.random() * 1e6).toString(36);
}

function msgOf(e) { return (e && e.message) ? e.message : String(e); }

function firstLine(t) {
  t = String(t || "").replace(/\s+/g, " ").trim();
  return t.length > 120 ? t.slice(0, 120) : t;
}

// Windows 路径归一（分隔符、尾斜杠、大小写）用于比较归属工作区
function normWs(p) { return String(p || "").replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase(); }
function sameWs(a, b) { a = normWs(a); b = normWs(b); return !!a && a === b; }
function wsBasename(p) {
  p = String(p || "").replace(/[\\/]+$/, "");
  var i = Math.max(p.lastIndexOf("\\"), p.lastIndexOf("/"));
  return i >= 0 ? p.slice(i + 1) : p;
}

// utf8 <-> base64（TextEncoder/TextDecoder，Chromium 可用）
function b64enc(str) {
  var bytes = new TextEncoder().encode(String(str));
  var bin = "", i;
  for (i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}
function b64dec(b) {
  var bin = atob(String(b).trim()), n = bin.length, bytes = new Uint8Array(n), i;
  for (i = 0; i < n; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

function norm(s) { return String(s || "").trim().toLowerCase(); }
function fuzzy(q, text) {
  q = norm(q); text = norm(text);
  if (!q) return true;
  if (text.indexOf(q) >= 0) return true;
  var i = 0, j;
  for (j = 0; j < text.length && i < q.length; j++) { if (text[j] === q[i]) i++; }
  return i >= q.length;
}

function uniq(list) {
  var seen = {}, out = [];
  for (var i = 0; i < list.length; i++) { var v = list[i]; if (v && !seen[v]) { seen[v] = 1; out.push(v); } }
  return out;
}

function toast(msg, ok) {
  var el = document.createElement("div");
  el.setAttribute("role", "status");
  el.setAttribute("data-nq-ui", "1");
  el.textContent = msg;
  el.style.cssText =
    "position:fixed;left:50%;transform:translateX(-50%);bottom:24px;z-index:2147483000;" +
    "padding:9px 14px;border-radius:8px;font:13px/1.5 system-ui,sans-serif;color:#fff;" +
    "background:" + (ok === false ? "#b3261e" : "#1a7f37") + ";" +
    "box-shadow:0 4px 16px rgba(0,0,0,.35);max-width:70vw;word-break:break-all";
  document.body.appendChild(el);
  setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 3200);
}

// ---------- 激活 ----------
export default function activate(ctx) {
  var h = ctx.react.createElement;
  var useState = ctx.react.useState;
  var useEffect = ctx.react.useEffect;
  var useMemo = ctx.react.useMemo;
  var useSyncExternalStore = ctx.react.useSyncExternalStore;

  // ---- 极简响应式 store ----
  var state = {
    notes: [], workspaces: [], loading: false, error: "", loaded: false,
    editor: null, locatedId: "", showAll: false,
  };
  var listeners = {};
  var lid = 0;
  function subscribe(fn) { var k = ++lid; listeners[k] = fn; return function () { delete listeners[k]; }; }
  function getSnapshot() { return state; }
  function set(patch) { state = Object.assign({}, state, patch); for (var k in listeners) { if (listeners[k]) listeners[k](); } }

  var activeWs = "";
  var lastSession = null;        // {engine,sessionId}
  var lastSessionTitle = "";
  var recentActivated = {};      // sessionId/复合id -> ts：selectSession 是否真生效的确认信号
  var flashTimers = [];
  var bootDone = false;          // 迁移/首读只跑一次

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  // ---- 文件诊断日志（宿主无 DevTools 时回传）----
  var logQueue = [], flushing = false;
  function fileLog(tag, obj) {
    try {
      logQueue.push(new Date().toISOString() + " " + tag + " " + JSON.stringify(obj) + "\n");
      if (logQueue.length > 60) logQueue.splice(0, logQueue.length - 60);
      flushLogs();
    } catch (e) {}
  }
  function flushLogs() {
    if (!logQueue.length || flushing) return;
    flushing = true;
    var batch = logQueue.splice(0, logQueue.length);
    runPy(LOGDIAG_PY, { NQ_LOG: b64enc(batch.join("")) }).catch(function () {
      logQueue = batch.concat(logQueue).slice(-60);
    }).then(function () { flushing = false; });
  }

  // ---- 活动工作空间 ----
  function applyMeta(m) {
    if (!m) return;
    var v = m.path || m.rootPath || m.workspacePath || m.root || "";
    if (v) activeWs = v;
  }
  async function resolveWs() {
    var fresh = "";
    try {
      var m = await ctx.workspace.getMetadata();
      fresh = (m && (m.path || m.rootPath || m.workspacePath || m.root)) || "";
    } catch (e) {}
    if (fresh) { activeWs = fresh; return fresh; }
    return activeWs || "";
  }
  try {
    var p0 = ctx.workspace.getMetadata();
    if (p0 && typeof p0.then === "function") p0.then(applyMeta).catch(function () {});
  } catch (e) {}

  var offEvents = null;
  try {
    offEvents = ctx.events.on("session://activated", function (payload) {
      var p = payload || {};
      if (p.workspacePath) activeWs = p.workspacePath;
      else if (p.path) activeWs = p.path;
      if (typeof p.engine === "string" && typeof p.sessionId === "string") {
        lastSession = { engine: p.engine, sessionId: p.sessionId };
        recentActivated[p.sessionId] = Date.now();
      }
      try {
        var now = Date.now();
        if (p.id && typeof p.id === "string") recentActivated[p.id] = now;
        if (p.session && typeof p.session === "object") {
          if (p.session.sessionId) recentActivated[p.session.sessionId] = now;
          if (p.session.id) recentActivated[p.session.id] = now;
        }
      } catch (e) {}
      var t = p.title || p.name || p.sessionTitle || p.label;
      if (typeof t === "string" && t) lastSessionTitle = t;
    });
  } catch (e) {}

  // ---- python 执行封装 ----
  async function runPy(py, env) {
    var res = await ctx.bridge.invoke("plugin_exec_run", {
      bin: "python3", args: ["-c", py], env: env || {}, timeoutMs: 15000,
    });
    if (!res || res.code !== 0) {
      throw new Error((res && res.stderr && String(res.stderr).trim()) || ("python3 退出码 " + (res ? res.code : "?")));
    }
    return String(res.stdout || "").trim();
  }

  // ---- 中央数据读写 ----
  async function loadAll(force) {
    set({ loading: true, error: "" });
    try {
      var out = (!bootDone || force) ? await runPy(BOOT_PY, {}) : await runPy(READ_PY, {});
      bootDone = true;
      var m = JSON.parse(b64dec(out));
      if (!m || !Array.isArray(m.notes)) m = { version: 2, migrated: true, notes: [] };
      set({ notes: m.notes, loaded: true, loading: false, error: "" });
      ensureWorkspaces();
    } catch (e) {
      set({ loaded: true, loading: false, error: msgOf(e) });
      fileLog("load-error", { err: msgOf(e) });
    }
  }

  async function mutateAll(fn) {
    var base;
    try { base = (JSON.parse(b64dec(await runPy(READ_PY, {}))).notes) || []; }
    catch (e) { base = state.notes.slice(); }
    var next = fn(base.slice());
    var b64 = b64enc(JSON.stringify({ version: 2, migrated: true, notes: next }));
    var out = await runPy(WRITE_PY, { NQ_B64: b64 });
    if (out !== "OK") throw new Error("写入未确认");
    set({ notes: next });
    return next;
  }

  // ---- app.db 权威解析 ----
  async function resolveSession(engine, sid) {
    if (!sid) return { ws: "", title: "" };
    try {
      var out = await runPy(RESOLVE_PY, { NQ_SID: sid, NQ_ENGINE: engine || "" });
      return JSON.parse(b64dec(out)) || { ws: "", title: "" };
    } catch (e) { return { ws: "", title: "" }; }
  }

  function ensureWorkspaces() {
    if (state.workspaces.length) return Promise.resolve(state.workspaces);
    return runPy(WSLIST_PY, {}).then(function (out) {
      var rows = JSON.parse(b64dec(out)) || [];
      set({ workspaces: rows });
      return rows;
    }).catch(function () { return []; });
  }

  // ---- 编辑器控制 ----
  function openEditor(mode, fields) {
    set({ editor: { nonce: newId(), mode: mode, draft: Object.assign({ workspacePath: "" }, fields) } });
  }
  function closeEditor() { set({ editor: null }); }

  async function commitEditor(draft, mode) {
    var title = String(draft.title || "").trim();
    if (!title) { toast(zh(ctx.host.locale) ? "请填写便签标题" : "Title is required", false); return; }
    var now = Date.now();
    var note = {
      id: mode === "edit" ? draft.id : newId(),
      title: title,
      date: draft.date || todayStr(),
      business: String(draft.business || "").trim(),
      module: String(draft.module || "").trim(),
      detail: String(draft.detail || ""),
      sessionTitle: String(draft.sessionTitle || "").trim(),
      session: draft.session || null,
      workspacePath: draft.workspacePath || "",   // 归属工作区（可在编辑器里改＝移动）
      createdAt: mode === "edit" ? (draft.createdAt || now) : now,
      updatedAt: now,
    };
    try {
      await mutateAll(function (arr) {
        var idx = -1, i;
        for (i = 0; i < arr.length; i++) { if (arr[i] && arr[i].id === note.id) { idx = i; break; } }
        if (idx >= 0) arr[idx] = note; else arr.push(note);
        return arr;
      });
      closeEditor();
      toast(mode === "edit" ? (zh(ctx.host.locale) ? "已更新便签" : "Updated") : (zh(ctx.host.locale) ? "已添加便签" : "Added"), true);
    } catch (e) {
      toast((zh(ctx.host.locale) ? "保存失败：" : "Save failed: ") + msgOf(e), false);
      fileLog("save-error", { err: msgOf(e) });
    }
  }

  async function removeNote(id) {
    try {
      await mutateAll(function (arr) { return arr.filter(function (n) { return n.id !== id; }); });
      closeEditor();
      toast(zh(ctx.host.locale) ? "已删除便签" : "Deleted", true);
    } catch (e) {
      toast((zh(ctx.host.locale) ? "删除失败：" : "Delete failed: ") + msgOf(e), false);
    }
  }

  // 添加便签：engine+sessionId → app.db 权威解析归属工作区与标题 → 开弹窗
  async function openAddForSession(engine, sid, fallbackTitle) {
    await ensureWorkspaces();
    var ws = "", title = fallbackTitle || "";
    if (sid) {
      var info = await resolveSession(engine, sid);
      ws = info.ws || ""; title = info.title || title;
    }
    if (!ws) ws = await resolveWs();
    if (!ws) { toast(zh(ctx.host.locale) ? "无法确定工作空间" : "Unknown workspace", false); return; }
    openEditor("create", {
      title: "", date: todayStr(), business: "", module: "", detail: "",
      sessionTitle: title, session: (engine && sid) ? { engine: engine, sessionId: sid } : null,
      workspacePath: ws,
    });
  }

  // ---- 定位 + 跑马灯 ----
  function rowAncestor(el) {
    var n = el, i;
    for (i = 0; i < 6 && n; i++) {
      try {
        if (n.matches && n.matches('button,a[role="link"],li,[role="treeitem"],[role="option"],[role="menuitem"],[data-session-id],[class*="cursor-pointer"]')) return n;
      } catch (e) {}
      n = n.parentElement;
    }
    return el;
  }

  function getFiber(el) {
    try {
      var ks = Object.keys(el), i;
      for (i = 0; i < ks.length; i++) { if (ks[i].indexOf("__reactFiber$") === 0) return el[ks[i]]; }
    } catch (e) {}
    return null;
  }
  function rootFiber() {
    var el = document.getElementById("root") || document.body, ks, i;
    try {
      ks = Object.keys(el);
      for (i = 0; i < ks.length; i++) {
        if (ks[i].indexOf("__reactContainer$") === 0) {
          var c = el[ks[i]];
          if (c) return c.current || c;
        }
      }
    } catch (e) {}
    try {
      var all = document.getElementsByTagName("*");
      for (i = 0; i < all.length && i < 4000; i++) {
        var f = getFiber(all[i]);
        if (f) { while (f.return) f = f.return; return f; }
      }
    } catch (e) {}
    return null;
  }
  function propsHaveSessionId(p, key) {
    if (!p || typeof p !== "object") return false;
    try {
      if (typeof p.id === "string" && p.id === key && typeof p.onSelect === "function") return true;
      if (p.session && typeof p.session.id === "string" && p.session.id === key) return true;
    } catch (e) {}
    return false;
  }
  function findFiberBySessionId(key) {
    if (!key) return null;
    var root = rootFiber();
    if (!root) return null;
    var stack = [root], seen = 0;
    while (stack.length && seen < 15000) {
      var f = stack.pop(); seen++;
      try { if (propsHaveSessionId(f.memoizedProps, key)) return f; } catch (e) {}
      if (f.child) stack.push(f.child);
      if (f.sibling) stack.push(f.sibling);
    }
    return null;
  }
  function fiberToDom(f) {
    var stack = [f], seen = 0;
    while (stack.length && seen < 3000) {
      var x = stack.shift(); seen++;
      var sn = x.stateNode;
      if (sn && sn.nodeType === 1) return sn;
      if (x.child) stack.push(x.child);
      if (x.sibling) stack.push(x.sibling);
    }
    return null;
  }
  function findSessionRow(hint, key) {
    if (key) {
      var f = findFiberBySessionId(key);
      if (f) { var dom = fiberToDom(f); if (dom) return rowAncestor(dom); }
    }
    if (hint) {
      var probes = [], hh = String(hint).trim();
      if (hh) { probes.push(hh); if (hh.length > 12) probes.push(hh.slice(0, 12)); }
      for (var pi = 0; pi < probes.length; pi++) {
        try {
          var xp = document.evaluate('//*[contains(normalize-space(.), $t)]', document,
            { t: { value: probes[pi] } }, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
          var best = null, bestLen = 1e9, i;
          for (i = 0; i < xp.snapshotLength; i++) {
            var e = xp.snapshotItem(i);
            if (!e || (e.closest && e.closest("[data-nq-ui]"))) continue;
            var len = (e.textContent || "").trim().length;
            if (len > 0 && len < bestLen) { bestLen = len; best = e; }
          }
          if (best) return rowAncestor(best);
        } catch (e) {}
      }
    }
    try {
      var act = document.querySelectorAll('[aria-current="true"],[aria-selected="true"],[data-state="active"]');
      for (var j = 0; j < act.length; j++) {
        var a = act[j];
        if (a.closest && a.closest("[data-nq-ui]")) continue;
        var t = (a.textContent || "").trim();
        if (t && t.length <= 120) return rowAncestor(a);
      }
    } catch (e) {}
    return null;
  }
  function flashRow(hint, maxTries, key) {
    var tries = 0, limit = maxTries || 16;
    var iv = setInterval(function () {
      tries++;
      var row = findSessionRow(hint, key);
      if (row) {
        clearInterval(iv);
        try { row.scrollIntoView({ behavior: "smooth", block: "center" }); } catch (e) {}
        row.classList.add("nq-flash");
        var rm = setTimeout(function () { try { row.classList.remove("nq-flash"); } catch (e) {} }, 2600);
        flashTimers.push(rm);
      } else if (tries > limit) { clearInterval(iv); }
    }, 160);
    flashTimers.push(iv);
  }

  async function locate(note) {
    var s = note.session;
    if (!s || !s.engine || !s.sessionId) {
      toast(zh(ctx.host.locale) ? "该便签未绑定会话，无法定位" : "Note not bound to a session", false);
      return;
    }
    var ws = note.workspacePath || activeWs || (await resolveWs());
    if (!ws) { toast(zh(ctx.host.locale) ? "无法确定会话所属工作空间" : "Unknown workspace for session", false); return; }
    var forms = [ws];
    var alt = /[\\/]/.test(ws) ? (ws.indexOf("\\") >= 0 ? ws.replace(/\\/g, "/") : ws.replace(/\//g, "\\")) : "";
    if (alt && alt !== ws) forms.push(alt);

    set({ locatedId: note.id });
    var t = setTimeout(function () { set({ locatedId: "" }); }, 2600);
    flashTimers.push(t);

    var ok = false, key = s.engine + "/" + s.sessionId;
    function stamp() { return Math.max(recentActivated[s.sessionId] || 0, recentActivated[key] || 0); }
    function since(b) { return (recentActivated[s.sessionId] || 0) > b || (recentActivated[key] || 0) > b; }
    for (var fi = 0; fi < forms.length && !ok; fi++) {
      try {
        var before = stamp();
        await ctx.sessions.selectSession(s.engine, s.sessionId, forms[fi]);
        for (var w = 0; w < 20 && !ok; w++) { await sleep(150); ok = since(before); }
        fileLog("locate-attempt", { form: fi, ws: forms[fi], activated: ok, sid: s.sessionId });
      } catch (e) { fileLog("locate-error", { form: fi, ws: forms[fi], err: msgOf(e) }); }
    }
    if (!ok) {
      try {
        var b2 = stamp();
        await ctx.sessions.refresh();
        await sleep(500);
        await ctx.sessions.selectSession(s.engine, s.sessionId, forms[0]);
        for (var w2 = 0; w2 < 20 && !ok; w2++) { await sleep(150); ok = since(b2); }
        fileLog("locate-retry-after-refresh", { activated: ok });
      } catch (e) { fileLog("locate-refresh-error", { err: msgOf(e) }); }
    }
    if (!ok) {
      try { navigator.clipboard.writeText(s.sessionId); } catch (e) {}
      toast(zh(ctx.host.locale)
        ? "宿主未能切换到该会话（可能已被删除/归档），会话ID已复制到剪贴板"
        : "Host could not switch to session; sessionId copied to clipboard", false);
      return;
    }
    flashRow(note.sessionTitle || note.title, 32, key);
  }

  // ================= 组件 =================

  // 主题联动：只跟随本软件主题设置的生效结果——观察宿主写到 DOM 上的主题痕迹
  // （html/body 的 class/data-theme/style 变化）。宿主若设"跟随系统"，系统翻转时
  // 宿主自己会改这些属性，我们照样被动跟随，绝不直接读系统偏好。
  function useThemePal() {
    var s = useState(isLightNow());
    var light = s[0], setLight = s[1];
    useEffect(function () {
      function sync() { setLight(isLightNow()); }
      sync();
      var mo = new MutationObserver(sync);
      try {
        mo.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "data-theme", "style"] });
        if (document.body) mo.observe(document.body, { attributes: true, attributeFilter: ["class", "data-theme", "style"] });
      } catch (e) {}
      // 宿主主题切换有时只改 CSS 变量而不碰属性：低频轮询背景色兜底（开销可忽略）。
      var iv = setInterval(sync, 2000);
      return function () {
        try { mo.disconnect(); } catch (e) {}
        try { clearInterval(iv); } catch (e) {}
      };
    }, []);
    return light ? PAL_LIGHT : PAL_DARK;
  }

  // 控件样式随当前明暗取色板；每次渲染现算。
  function stylesFor(pal) {
    return {
      inp: { width: "100%", boxSizing: "border-box", padding: "6px 8px", borderRadius: 6,
        border: "1px solid " + pal.inputBorder, background: pal.input, color: pal.text, fontSize: 13,
        colorScheme: pal.scheme },
      btn: { fontSize: 13, padding: "6px 14px", borderRadius: 7, cursor: "pointer",
        border: "1px solid " + pal.inputBorder, background: pal.input, color: pal.text },
      btnPrimary: { fontSize: 13, padding: "6px 16px", borderRadius: 7, cursor: "pointer",
        border: "none", background: ACCENT, color: "#fff", fontWeight: 600 },
    };
  }

  function Field(label, node, hint) {
    var pal = palNow();
    return h("div", { style: { marginBottom: 12 } },
      h("label", { style: { fontSize: 12, fontWeight: 600, color: pal.text2, marginBottom: 3, display: "block" } }, label),
      node,
      hint ? h("div", { style: { fontSize: 11, color: pal.muted, marginTop: 3 } }, hint) : null);
  }

  // ---- 编辑弹窗（overlay 内）----
  function EditorModal(props) {
    var pal = useThemePal();
    var S = stylesFor(pal);
    var ed = props.editor;
    var st = useState(ed.draft);
    var draft = st[0], setDraft = st[1];
    var delArm = useState(false);
    var delArmed = delArm[0], setDelArmed = delArm[1];
    var delTimer = null;
    function askDeleteNote() {
      if (!delArmed) { setDelArmed(true); delTimer = setTimeout(function () { setDelArmed(false); }, 3000); return; }
      clearTimeout(delTimer); setDelArmed(false); removeNote(draft.id);
    }
    var notes = props.notes;
    var workspaces = props.workspaces;
    var bizOpts = useMemo(function () { return uniq(notes.map(function (n) { return n.business; })); }, [notes]);
    var modOpts = useMemo(function () { return uniq(notes.map(function (n) { return n.module; })); }, [notes]);
    var patch = function (kv) { setDraft(function (p) { return Object.assign({}, p, kv); }); };

    // 归属工作区下拉：登记工作区 ∪ 当前值
    var wsOptions = useMemo(function () {
      var seen = {}, out = [];
      for (var i = 0; i < workspaces.length; i++) {
        var w = workspaces[i];
        if (w && w.path && !seen[normWs(w.path)]) { seen[normWs(w.path)] = 1; out.push(w); }
      }
      if (draft.workspacePath && !seen[normWs(draft.workspacePath)]) {
        out.unshift({ path: draft.workspacePath, name: wsBasename(draft.workspacePath) });
      }
      return out;
    }, [workspaces, draft.workspacePath]);

    var sessionTxt = draft.session
      ? (draft.session.engine + " · " + String(draft.session.sessionId).slice(0, 8))
      : (zh(ctx.host.locale) ? "未绑定会话" : "No session");

    return h("div", {
      "data-nq-ui": "1",
      onClick: function (e) { if (e.target === e.currentTarget) closeEditor(); },
      style: { position: "fixed", inset: 0, zIndex: 2147482000, background: pal.backdrop,
        display: "flex", alignItems: "center", justifyContent: "center", pointerEvents: "auto" },
    },
      h("div", {
        onClick: function (e) { e.stopPropagation(); },
        style: { width: "min(540px, 92vw)", maxHeight: "86vh", overflowY: "auto",
          background: pal.modalBg, color: pal.text,
          border: "1px solid " + pal.cardBorder, borderRadius: 12, padding: 18,
          boxShadow: pal.scheme === "light" ? "0 12px 40px rgba(16,24,40,.18)" : "0 12px 40px rgba(0,0,0,.5)" },
      },
        h("div", { style: { fontSize: 16, fontWeight: 700, marginBottom: 14, color: pal.text } },
          ed.mode === "edit" ? (zh(ctx.host.locale) ? "编辑便签" : "Edit note") : (zh(ctx.host.locale) ? "添加便签" : "Add note")),

        Field(zh(ctx.host.locale) ? "标题 *" : "Title *",
          h("input", { style: S.inp, autoFocus: true, value: draft.title || "",
            onChange: function (e) { patch({ title: e.target.value }); },
            placeholder: zh(ctx.host.locale) ? "必填，用于检索" : "required" })),

        h("div", { style: { display: "flex", gap: 12 } },
          h("div", { style: { flex: 1 } },
            Field(zh(ctx.host.locale) ? "时间" : "Date",
              h("input", { style: S.inp, type: "date", value: draft.date || todayStr(),
                onChange: function (e) { patch({ date: e.target.value }); } }))),
          h("div", { style: { flex: 1 } },
            Field(zh(ctx.host.locale) ? "会话标题" : "Session title",
              h("input", { style: S.inp, value: draft.sessionTitle || "",
                onChange: function (e) { patch({ sessionTitle: e.target.value }); },
                placeholder: zh(ctx.host.locale) ? "可手填，供按会话标题查询" : "optional" })))),

        h("div", { style: { display: "flex", gap: 12 } },
          h("div", { style: { flex: 1 } },
            Field(zh(ctx.host.locale) ? "业务" : "Business",
              h("input", { style: S.inp, list: "nq-biz", value: draft.business || "",
                onChange: function (e) { patch({ business: e.target.value }); },
                placeholder: zh(ctx.host.locale) ? "可新增/下拉" : "new or pick" }),
              h("datalist", { id: "nq-biz" }, bizOpts.map(function (o) { return h("option", { key: o, value: o }); })))),
          h("div", { style: { flex: 1 } },
            Field(zh(ctx.host.locale) ? "归属模块" : "Module",
              h("input", { style: S.inp, list: "nq-mod", value: draft.module || "",
                onChange: function (e) { patch({ module: e.target.value }); },
                placeholder: zh(ctx.host.locale) ? "可新增/下拉" : "new or pick" }),
              h("datalist", { id: "nq-mod" }, modOpts.map(function (o) { return h("option", { key: o, value: o }); }))))),

        Field(zh(ctx.host.locale) ? "归属工作区（改此处即把便签迁移到该工作区）" : "Workspace (change to move)",
          h("select", { style: S.inp, value: draft.workspacePath || "",
            onChange: function (e) { patch({ workspacePath: e.target.value }); } },
            wsOptions.map(function (w) { return h("option", { key: w.path, value: w.path }, w.name); }))),

        Field(zh(ctx.host.locale) ? "详情" : "Detail",
          h("textarea", { style: Object.assign({}, S.inp, { minHeight: 90, resize: "vertical", lineHeight: 1.5 }),
            value: draft.detail || "", onChange: function (e) { patch({ detail: e.target.value }); }})),

        h("div", { style: { fontSize: 11, color: pal.muted, marginBottom: 12 } },
          (zh(ctx.host.locale) ? "绑定会话：" : "Bound session: ") + sessionTxt),

        h("div", { style: { display: "flex", gap: 10, justifyContent: "flex-end" } },
          ed.mode === "edit"
            ? h("button", { type: "button", style: Object.assign({}, S.btn, { color: "#e0524d", borderColor: "#e0524d",
                background: delArmed ? "rgba(224,82,77,.18)" : pal.input }),
                onClick: function () { askDeleteNote(); } },
                delArmed ? (zh(ctx.host.locale) ? "再点一次确认删除" : "Click again to confirm") : (zh(ctx.host.locale) ? "删除" : "Delete"))
            : null,
          h("div", { style: { flex: 1 } }),
          h("button", { type: "button", style: S.btn, onClick: closeEditor }, zh(ctx.host.locale) ? "取消" : "Cancel"),
          h("button", { type: "button", style: S.btnPrimary,
            onClick: function () { commitEditor(draft, ed.mode); } }, zh(ctx.host.locale) ? "保存" : "Save")),
      ));
  }

  function OverlayComp() {
    var st = useSyncExternalStore(subscribe, getSnapshot);
    if (!st.editor) return null;
    return h(EditorModal, { key: st.editor.nonce, editor: st.editor, notes: st.notes, workspaces: st.workspaces });
  }

  // ---- 便签卡片 ----
  function NoteCard(props) {
    var pal = useThemePal();
    var n = props.note, located = props.located, showWsBadge = props.showWsBadge;
    var arm = useState(false);
    var armed = arm[0], setArmed = arm[1];
    var armTimer = null;
    function askDelete() {
      if (!armed) { setArmed(true); armTimer = setTimeout(function () { setArmed(false); }, 3000); return; }
      clearTimeout(armTimer); setArmed(false); removeNote(n.id);
    }
    var badges = [];
    if (n.date) badges.push(n.date);
    if (n.business) badges.push(n.business);
    if (n.module) badges.push(n.module);
    if (showWsBadge) badges.push("📁 " + wsBasename(n.workspacePath));
    return h("div", {
      onClick: function () { locate(n); },
      style: { position: "relative", padding: "10px 11px", marginBottom: 8, borderRadius: 12, cursor: "pointer",
        border: "1px solid " + (located ? ACCENT : pal.cardBorder),
        background: located ? pal.locatedBg : pal.card,
        boxShadow: located ? ("0 0 0 2px " + ACCENT) : pal.cardShadow, transition: "all .2s" },
    },
      h("div", { style: { display: "flex", alignItems: "flex-start", gap: 6 } },
        h("div", { style: { flex: 1, minWidth: 0 } },
          h("div", { style: { fontSize: 13.5, fontWeight: 600, color: pal.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } },
            located ? "✓ " : "", n.title || (zh(ctx.host.locale) ? "（无标题）" : "(untitled)")),
          badges.length ? h("div", { style: { display: "flex", flexWrap: "wrap", gap: 4, marginTop: 5 } },
            badges.map(function (b, i) {
              return h("span", { key: i, style: { fontSize: 10.5, padding: "1px 6px", borderRadius: 10,
                background: pal.badgeBg, color: pal.badgeText } }, b);
            })) : null,
          n.detail ? h("div", { style: { fontSize: 11.5, color: pal.text2, marginTop: 5, lineHeight: 1.45,
            display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" } }, n.detail) : null,
          n.sessionTitle ? h("div", { style: { fontSize: 10.5, color: pal.muted, marginTop: 5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } },
            "💬 " + n.sessionTitle) : null),
        h("div", { style: { display: "flex", flexDirection: "column", gap: 4 } },
          h("button", { type: "button", title: zh(ctx.host.locale) ? "编辑 / 移动" : "Edit / move",
            style: { fontSize: 11, padding: "2px 6px", borderRadius: 5, cursor: "pointer", border: "1px solid " + pal.inputBorder, background: pal.input, color: pal.text },
            onClick: function (e) { e.stopPropagation(); ensureWorkspaces(); openEditor("edit", n); } }, "✎"),
          h("button", { type: "button", title: zh(ctx.host.locale) ? "删除" : "Delete",
            style: { fontSize: 11, padding: "2px 6px", borderRadius: 5, cursor: "pointer",
              border: "1px solid " + (armed ? "#e0524d" : pal.inputBorder), background: armed ? "rgba(224,82,77,.18)" : pal.input,
              color: armed ? "#e0524d" : pal.text },
            onClick: function (e) { e.stopPropagation(); askDelete(); } },
            armed ? (zh(ctx.host.locale) ? "再点一次确认" : "Again?") : "🗑"))));
  }

  // ---- 便签栏面板 ----
  function NotePanel(props) {
    var pal = useThemePal();
    var S = stylesFor(pal);
    var ws = props.workspacePath || "";
    var st = useSyncExternalStore(subscribe, getSnapshot);
    var fs = useState({ q: "", date: "", biz: "", mod: "" });
    var filt = fs[0], setFilt = fs[1];
    var patch = function (kv) { setFilt(function (p) { return Object.assign({}, p, kv); }); };

    useEffect(function () { loadAll(); }, []);
    useEffect(function () { if (ws) activeWs = ws; }, [ws]);

    // 作用域：当前工作区 or 全部
    var scoped = useMemo(function () {
      if (st.showAll || !ws) return st.notes;
      return st.notes.filter(function (n) { return sameWs(n.workspacePath, ws); });
    }, [st.notes, st.showAll, ws]);

    var bizOpts = useMemo(function () { return uniq(scoped.map(function (n) { return n.business; })); }, [scoped]);
    var modOpts = useMemo(function () { return uniq(scoped.map(function (n) { return n.module; })); }, [scoped]);

    var list = useMemo(function () {
      var arr = scoped.filter(function (n) {
        if (filt.q && !(fuzzy(filt.q, n.title) || fuzzy(filt.q, n.sessionTitle))) return false;
        if (filt.date && n.date !== filt.date) return false;
        if (filt.biz && n.business !== filt.biz) return false;
        if (filt.mod && n.module !== filt.mod) return false;
        return true;
      });
      arr.sort(function (a, b) {
        if ((a.date || "") !== (b.date || "")) return (b.date || "").localeCompare(a.date || "");
        return (b.updatedAt || 0) - (a.updatedAt || 0);
      });
      return arr;
    }, [scoped, filt]);

    return h("div", { "data-nq-ui": "1", style: { height: "100%", display: "flex", flexDirection: "column", padding: 10, boxSizing: "border-box", fontSize: 13, color: pal.text } },
      h("div", { style: { marginBottom: 8 } },
        h("input", { style: S.inp, placeholder: zh(ctx.host.locale) ? "🔍 搜索便签名称 / 会话标题…" : "Search notes…",
          value: filt.q, onChange: function (e) { patch({ q: e.target.value }); } }),
        h("div", { style: { display: "flex", gap: 6, marginTop: 6, flexWrap: "wrap", alignItems: "center" } },
          h("input", { type: "date", title: zh(ctx.host.locale) ? "按日期筛选" : "By date",
            style: Object.assign({}, S.inp, { maxWidth: 140 }), value: filt.date,
            onChange: function (e) { patch({ date: e.target.value }); } }),
          h("select", { style: Object.assign({}, S.inp, { maxWidth: 120 }), value: filt.biz,
            onChange: function (e) { patch({ biz: e.target.value }); } },
            h("option", { value: "" }, zh(ctx.host.locale) ? "业务·全部" : "Biz·All"),
            bizOpts.map(function (o) { return h("option", { key: o, value: o }, o); })),
          h("select", { style: Object.assign({}, S.inp, { maxWidth: 120 }), value: filt.mod,
            onChange: function (e) { patch({ mod: e.target.value }); } },
            h("option", { value: "" }, zh(ctx.host.locale) ? "模块·全部" : "Mod·All"),
            modOpts.map(function (o) { return h("option", { key: o, value: o }, o); })),
          (filt.q || filt.date || filt.biz || filt.mod)
            ? h("button", { type: "button", style: Object.assign({}, S.btn, { padding: "4px 8px", fontSize: 12 }),
                onClick: function () { setFilt({ q: "", date: "", biz: "", mod: "" }); } },
                zh(ctx.host.locale) ? "清除" : "Clear")
            : null)),

      h("div", { style: { display: "flex", alignItems: "center", gap: 8, marginBottom: 8, fontSize: 12, color: pal.text2 } },
        h("label", { style: { display: "flex", alignItems: "center", gap: 4, cursor: "pointer", color: pal.text2 } },
          h("input", { type: "checkbox", checked: st.showAll,
            onChange: function (e) { set({ showAll: e.target.checked }); } }),
          zh(ctx.host.locale) ? "全部工作区" : "All workspaces"),
        h("span", { style: { flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: pal.muted } },
          (zh(ctx.host.locale) ? "共 " : "") + scoped.length + (zh(ctx.host.locale) ? " · 命中 " : " · ") + list.length),
        h("button", { type: "button", style: Object.assign({}, S.btn, { padding: "3px 9px", fontSize: 12 }),
          onClick: function () { loadAll(true); } }, zh(ctx.host.locale) ? "刷新" : "Refresh"),
        h("button", { type: "button", style: Object.assign({}, S.btnPrimary, { padding: "3px 10px", fontSize: 12 }),
          onClick: function () {
            if (lastSession) openAddForSession(lastSession.engine, lastSession.sessionId, lastSessionTitle);
            else openEditor("create", { title: "", date: todayStr(), business: "", module: "", detail: "", sessionTitle: "", session: null, workspacePath: ws || activeWs });
          } }, zh(ctx.host.locale) ? "＋新建" : "＋New")),

      h("div", { style: { flex: 1, overflowY: "auto", minHeight: 0 } },
        st.loading ? h("div", { style: { padding: 12, color: pal.muted } }, zh(ctx.host.locale) ? "加载中…" : "Loading…")
          : st.error ? h("div", { style: { padding: 10, borderRadius: 8, background: pal.errBg, color: pal.errText, fontSize: 12, lineHeight: 1.5 } },
              (zh(ctx.host.locale) ? "读取便签失败：" : "Load failed: ") + st.error,
              h("div", { style: { marginTop: 6, opacity: .85 } },
                zh(ctx.host.locale) ? "提示：需本机 python3 在 PATH 中；若报 binary not found，请把 Python 目录加入系统 PATH 后重启 CC GUI。" : "Ensure python3 is on PATH."))
            : (!st.loaded ? h("div", { style: { padding: 12, color: pal.muted } }, "…")
              : list.length === 0 ? h("div", { style: { padding: 16, textAlign: "center", color: pal.muted, fontSize: 12.5 } },
                  scoped.length === 0
                    ? (zh(ctx.host.locale) ? "本工作区暂无便签。右键任意会话「添加便签」即可。" : "No notes here. Right-click a session to add.")
                    : (zh(ctx.host.locale) ? "无匹配便签。" : "No matching notes."))
                : list.map(function (n) { return h(NoteCard, { key: n.id, note: n, located: st.locatedId === n.id, showWsBadge: st.showAll }); })))
    );
  }

  // ================= 注册扩展点 =================

  try {
    ctx.theme.injectCss(
      "@property --nq-a{syntax:'<angle>';inherits:false;initial-value:0deg}" +
      ".nq-flash{position:relative!important;border-radius:8px}" +
      ".nq-flash::after{content:'';position:absolute;inset:-2px;border-radius:10px;padding:2px;" +
      "background:conic-gradient(from var(--nq-a)," + ACCENT + ",rgba(232,112,58,.15) 25%," + ACCENT + " 50%,rgba(232,112,58,.15) 75%," + ACCENT + ");" +
      "-webkit-mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0);-webkit-mask-composite:xor;mask-composite:exclude;" +
      "pointer-events:none;animation:nqspin 1.1s linear infinite}" +
      "@keyframes nqspin{to{--nq-a:360deg}}" +
      "@supports not (background:conic-gradient(from 0deg,red,blue)){" +
      ".nq-flash{outline:2px solid " + ACCENT + ";animation:nqpulse 1.2s ease-in-out infinite}" +
      "@keyframes nqpulse{0%,100%{outline-offset:1px;outline-color:" + ACCENT + "}50%{outline-offset:5px;outline-color:rgba(232,112,58,.2)}}}"
    );
  } catch (e) {}

  // 会话右键「添加便签」：engine+sessionId → app.db 权威解析归属工作区
  try {
    ctx.ui.registerSessionMenuItem({
      key: NS + ":add",
      label: function () { return zh(ctx.host.locale) ? "添加便签" : "Add note"; },
      run: function (target) {
        openAddForSession(target && target.engine, target && target.sessionId, "");
      },
    });
  } catch (e) {}

  try {
    ctx.ui.registerPanelTab({
      key: NS,
      label: function () { return zh(ctx.host.locale) ? "便签" : "Notes"; },
      component: NotePanel,
    });
  } catch (e) {}

  try {
    ctx.ui.registerOverlay({ key: NS + ":editor", component: OverlayComp });
  } catch (e) {}

  // 卸载清理
  return function () {
    if (offEvents && typeof offEvents === "function") { try { offEvents(); } catch (e) {} }
    for (var i = 0; i < flashTimers.length; i++) { try { clearInterval(flashTimers[i]); clearTimeout(flashTimers[i]); } catch (e) {} }
    flashTimers = [];
  };
}
