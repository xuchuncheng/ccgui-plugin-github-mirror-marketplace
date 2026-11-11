// main.js —— Apipost 接口面板（CC GUI 插件）
// 单文件 ESM，无 import / 无 JSX；组件一律用 ctx.react.createElement。
export default function activate(ctx) {
  const { createElement: h, useState, useEffect, useCallback } = ctx.react;

  // ——— 常量 ———
  const BASE = "https://open.apipost.net";
  const HEADERS = {
    "Apipost-Terminal": "idea",
    "Apipost-Language": "zh-CN",
    "Apipost-Version": "1.1.0",
  };
  // ——— 路径解析 ———
  // 不写死用户名：启动时用 python 探测技能脚本真实位置（python 自己知道 ~ 是哪个目录），
  // 探到的结果存进 storage；换电脑后首次打开自动重新探测，也可手动覆盖。
  const CANDIDATE_DIRS = [
    "~/.claude/skills/python",
    "~/.walicode/skills/python",
  ];
  const SKILLS_KEY = "skillsDir";

  function toWin(d) {
    return String(d || "").replace(/\//g, "\\").replace(/\\+$/, "");
  }

  function pathsOf(dir) {
    const d = toWin(dir);
    return {
      root: d,
      upload: d + "\\apipost_upload.py",
      config: d + "\\apipost_config.json",
      docx: d + "\\apipost_docx.py",
      view: d + "\\apipost_view.py",
      mkdir: d + "\\apipost_mkdir.py",
      createProject: d + "\\apipost_create_project.py",
      selection: d + "\\apipost_selection.json",
    };
  }

  // 用 python 探测：返回第一个含 apipost_upload.py 的目录（绝对路径），找不到返回 ""
  async function probeSkillsDir() {
    const py = [
      "import os, sys",
      "try:",
      "    sys.stdout.reconfigure(encoding='utf-8', errors='replace')",
      "except Exception:",
      "    pass",
      "cands = " + JSON.stringify(CANDIDATE_DIRS),
      "for c in cands:",
      "    p = os.path.expanduser(c)",
      "    if os.path.isfile(os.path.join(p, 'apipost_upload.py')):",
      "        print(os.path.abspath(p))",
      "        break",
    ].join("\n");
    try {
      const r = await ctx.bridge.invoke("plugin_exec_run", {
        bin: "python", args: ["-c", py], timeoutMs: 15000,
      });
      const out = String(r.stdout || "").trim();
      return out ? toWin(out.split("\n").pop()) : "";
    } catch (_) {
      return "";
    }
  }

  // 兜底：探测失败时按当前用户的常见布局拼一个（最后手段）
  function fallbackSkillsDir() {
    // CC GUI 在 Windows 上运行；用宿主工作区路径推导用户目录不可靠，
    // 因此这里只给出相对提示，由用户手动指定。
    return "";
  }

  // 统一错误文案：bridge 可能抛出 Error / 普通对象 / 字符串，
  // 直接取 e.message 会得到 undefined，让人误以为接口坏了。
  function errText(e) {
    if (e == null) return "未知错误";
    if (typeof e === "string") return e;
    if (typeof e === "object") {
      const parts = [e.message, e.msg, e.reason, e.error].filter(
        (x) => typeof x === "string" && x.trim());
      if (parts.length) return parts[0];
      try {
        const s = JSON.stringify(e);
        if (s && s !== "{}") return s;
      } catch (_) { /* 循环引用等 */ }
      return String(e);
    }
    return String(e);
  }

  // ——— HTTP / EXEC 封装 ———
  // 对齐宿主 plugin_http_request 契约：{ method, url, headers, body } → { status, body }。
  // 宿主底层不带 User-Agent，部分网关会直接断开（表现为 reqwest 的
  // "error sending request"），因此必须显式补 UA。
  const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    + "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 ccgui-apipost-panel/0.10.0";
  const HTTP_TIMEOUT_MS = 15000;

  // 把 bridge 返回的各种形态归一成 { status, body(string) }
  function normalizeResp(r) {
    if (r == null) throw new Error("空响应");
    if (typeof r === "string") return { status: 200, body: r };
    const inner = r.result && typeof r.result === "object" ? r.result : r;
    if (inner.error) throw new Error(String(inner.error));
    const status = Number(inner.status ?? inner.statusCode ?? (inner.ok ? 200 : 0)) || 0;
    const body = inner.body ?? inner.text ?? inner.data ?? "";
    return { status, body: typeof body === "string" ? body : JSON.stringify(body) };
  }

  // 单次请求；宿主侧没有超时参数（多传会被拒），所以用 Promise.race 自己兜
  async function httpOnce(method, path, headers, bodyObj) {
    let timer;
    try {
      const p = ctx.bridge.invoke("plugin_http_request", {
        method,
        url: BASE + path,
        headers: { "User-Agent": USER_AGENT, Accept: "application/json,*/*", ...headers },
        body: bodyObj == null ? null : JSON.stringify(bodyObj),
      });
      const r = await Promise.race([
        p,
        new Promise((_, rej) => {
          timer = setTimeout(() => rej(new Error("请求超时（" + HTTP_TIMEOUT_MS + "ms）")), HTTP_TIMEOUT_MS);
        }),
      ]);
      return normalizeResp(r);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async function requestJson(method, path, headers, bodyObj) {
    const attempt = async () => {
      const { status, body } = await httpOnce(method, path, headers, bodyObj);
      if (!body || !String(body).trim()) {
        throw new Error("服务端返回空响应（HTTP " + (status || "?") + "）");
      }
      try {
        return JSON.parse(body);
      } catch (_) {
        throw new Error("响应不是合法 JSON（HTTP " + (status || "?") + "）：" + String(body).slice(0, 160));
      }
    };
    try {
      return await attempt();
    } catch (e) {
      // 单次失败可能只是链路抖动（同 URL 隔一秒再打就通），重试一次再判定
      await new Promise((r) => setTimeout(r, 400));
      try {
        return await attempt();
      } catch (e2) {
        // 宿主网络层（reqwest）故障时，改走 Python 独立链路兜底
        try {
          return await requestViaPython(method, path, headers, bodyObj);
        } catch (e3) {
          const a = errText(e), b = errText(e2), c = errText(e3);
          throw new Error(a === b ? b + "；Python 兜底也失败：" + c : a + "；重试后：" + b);
        }
      }
    }
  }

  // 兜底链路：用 python 直连（与 CLI 同一套 urllib，已验证可用）
  // 关键：宿主 exec 的 stdout 有传输上限，73 KB 的目录树会被截断 → JSON 解析失败。
  // 因此 Python 侧先 gzip 再 base64，体积从 73 KB 降到 17 KB，稳定可传。
  async function requestViaPython(method, path, headers, bodyObj) {
    const py = [
      "import json, sys, gzip, base64, urllib.request, urllib.error",
      // Windows 下被管道调用时 sys.stdout 默认按 GBK 编码，宿主按 UTF-8 解码会乱码；
      // 必须在任何输出之前强制 UTF-8。
      "try:",
      "    sys.stdout.reconfigure(encoding='utf-8', errors='replace')",
      "except Exception:",
      "    pass",
      "a = json.loads(sys.argv[1])",
      "data = json.dumps(a['body'], ensure_ascii=False).encode('utf-8') if a.get('body') is not None else None",
      "req = urllib.request.Request(a['url'], data=data, method=a['method'])",
      "for k, v in a['headers'].items():",
      "    req.add_header(k, v)",
      "try:",
      "    r = urllib.request.urlopen(req, timeout=45)",
      "    raw = r.read()",
      "except urllib.error.HTTPError as e:",
      "    raw = e.read()",
      // 目录树只保留前端渲染所需字段，进一步压体积（url 占 17 KB 且列表页用不到完整值）
      "slim_list = None",
      "try:",
      "    obj = json.loads(raw.decode('utf-8'))",
      "    if isinstance(obj, dict) and isinstance(obj.get('data'), dict) and isinstance(obj['data'].get('list'), list):",
      "        keep = ('target_id','parent_id','name','target_type','version','sort','method','url')",
      "        obj['data']['list'] = [{k: n.get(k) for k in keep if k in n} for n in obj['data']['list']]",
      "        raw = json.dumps(obj, ensure_ascii=False, separators=(',',':')).encode('utf-8')",
      "except Exception:",
      "    pass",
      "sys.stdout.write('GZ:' + base64.b64encode(gzip.compress(raw, 6)).decode('ascii'))",
    ].join("\n");
    const arg = JSON.stringify({
      method, url: BASE + path, headers, body: bodyObj == null ? null : bodyObj,
    });
    const r = await exec("python", ["-c", py, arg], 60000);
    const out = (r.stdout || "").trim();
    if (!out) {
      throw new Error("Python 返回空内容" + (r.stderr ? "：" + String(r.stderr).slice(0, 200) : ""));
    }
    const text = out.startsWith("GZ:") ? await gunzipBase64(out.slice(3)) : out;
    try {
      return JSON.parse(text);
    } catch (_) {
      throw new Error("Python 返回非 JSON（" + text.length + " 字符）：" + text.slice(0, 160));
    }
  }

  // 把 "base64(gzip(bytes))" 解回字符串：优先用浏览器原生 DecompressionStream
  async function gunzipBase64(b64) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    if (typeof DecompressionStream === "function") {
      const ds = new DecompressionStream("gzip");
      const stream = new Blob([bytes]).stream().pipeThrough(ds);
      return await new Response(stream).text();
    }
    throw new Error("当前环境不支持 DecompressionStream，无法解压兜底响应");
  }

  async function apiGet(path, token) {
    const headers = token ? { ...HEADERS, "Apipost-Token": token } : { ...HEADERS };
    return requestJson("GET", path, headers, null);
  }

  async function apiPost(path, bodyObj, token) {
    const headers = { ...HEADERS, "Content-Type": "application/json", "Apipost-Token": token };
    return requestJson("POST", path, headers, bodyObj);
  }
  async function exec(bin, args, timeoutMs) {
    return ctx.bridge.invoke("plugin_exec_run", { bin, args, timeoutMs: timeoutMs || 30000 });
  }

  // 当前生效的技能目录与拉取目录（面板挂载时探测并写入，换电脑自动重探）
  let skillsDir = "";
  let pullDir = "";

  function pathsNow() {
    return pathsOf(skillsDir);
  }

  function pullDirNow() {
    return pullDir || (toWin(skillsDir).replace(/\\skills\\python$/i, "\\APIPost工作区\\apipost_pull"));
  }

  // 把 token 写进 apipost_config.json，让 CLI 与面板共用登录态
  async function writeCliConfig(token) {
    const cfgPath = pathsNow().config;
    if (!cfgPath) return;
    const py =
      "import json,time,sys;" +
      "sys.stdout.reconfigure(encoding='utf-8',errors='replace');" +
      "json.dump({'remoteUrl':" + JSON.stringify(BASE) + ",'token':" + JSON.stringify(token) +
      ",'saved_at':time.strftime('%Y-%m-%d %H:%M:%S')}," +
      "open(r" + JSON.stringify(cfgPath) + ",'w',encoding='utf-8'),ensure_ascii=False,indent=2);" +
      "print('ok')";
    await exec("python", ["-c", py]);
  }

  // 把「当前选中」写进交接文件，供 Skill/CLI 用 --from-selection 读取
  async function writeSelection(sel) {
    const selPath = pathsNow().selection;
    if (!selPath) return;
    const py =
      "import sys;" +
      "sys.stdout.reconfigure(encoding='utf-8',errors='replace');" +
      "open(r" + JSON.stringify(selPath) + ",'w',encoding='utf-8').write(sys.argv[1])";
    try {
      await exec("python", ["-c", py, JSON.stringify(sel, null, 2)]);
    } catch (e) { /* 写入失败不阻塞交互 */ }
  }

  // ——— 样式层 ———
  // CC GUI 宿主主题 token 前缀是 --color-*；旧代码用的 --border-default/--background-secondary
  // 根本不存在，导致 fallback 的深色值在浅色主题下全部生效。这里统一映射到真实 token，
  // 并抽出一层 --ap-* 语义变量，黑白主题随宿主自动切换。
  const CSS = `
.apipost-panel {
  --ap-canvas:  var(--color-background-primary-default, #ffffff);
  --ap-surface: var(--color-background-primary-default, #ffffff);
  --ap-sunken:  var(--color-background-tertiary-default, #f9fafb);
  --ap-line:    var(--color-separator-border, rgba(0,0,0,.05));
  --ap-line-strong: var(--color-border-button-default, rgba(0,0,0,.10));
  --ap-ink:     var(--color-text-primary, #111827);
  --ap-body:    var(--color-text-secondary, #374151);
  --ap-muted:   var(--color-text-tertiary, #9ca3af);
  --ap-placeholder: var(--color-text-placeholder, #9ca3af);
  --ap-accent:  var(--color-accent-500, #2563eb);
  --ap-accent-strong: var(--color-accent-600, #1d4ed8);
  --ap-success: var(--color-notification-success-foreground, #16a34a);
  --ap-danger:  var(--color-text-error-primary, #ef4444);
  --ap-warning: var(--color-text-warning-primary, #f59e0b);
  --ap-focus:   var(--color-border-focus-ring, #2563eb);
  /* 文件夹与 HTTP 方法标识色 */
  --ap-folder:  var(--color-accent-500, #2563eb);
  --ap-method-get:    #0891b2;
  --ap-method-post:   #16a34a;
  --ap-method-put:    #d97706;
  --ap-method-delete: #dc2626;
  --ap-radius:  var(--radius-2lg, 12px);
  --ap-radius-sm: 8px;
  --ap-font:    var(--font-sans, ui-sans-serif, system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif);
  --ap-mono:    var(--font-mono, ui-monospace, "SF Mono", Menlo, monospace);
  --ap-shadow:  var(--shadow-card, 0 1px 2px rgba(16,24,40,.04), 0 4px 16px -4px rgba(16,24,40,.06));

  display: flex;
  flex-direction: column;
  gap: 10px;
  height: 100%;
  padding: 12px;
  overflow-y: auto;
  background: transparent;
  color: var(--ap-ink);
  font-family: var(--ap-font);
  font-size: 13px;
  line-height: 1.5;
  -webkit-font-smoothing: antialiased;
}

/* —— 卡片 —— */
.ap-card {
  background: var(--ap-surface);
  border: 1px solid var(--ap-line);
  border-radius: var(--ap-radius);
  box-shadow: var(--ap-shadow);
  padding: 12px;
}
/* 面板底色与宿主一致（透传），卡片才需要浮起；避免整块发灰 */
.apipost-panel > .ap-card { background: var(--ap-surface); }

/* —— 页头 —— */
.ap-head {
  display: flex; align-items: center; gap: 8px;
  padding: 2px 2px 0;
}
.ap-title { font-size: 14px; font-weight: 600; color: var(--ap-ink); letter-spacing: -.01em;
  display: inline-flex; align-items: center; gap: 6px; }
.ap-title-icon { display: inline-flex; align-items: center; color: var(--ap-accent); }
.ap-dot { font-size: 11px; font-weight: 500; color: var(--ap-muted); display: inline-flex; align-items: center; gap: 4px; }
.ap-dot::before {
  content: ""; width: 6px; height: 6px; border-radius: 999px;
  background: var(--ap-muted); flex: 0 0 auto;
}
.ap-dot.is-on { color: var(--ap-success); }
.ap-dot.is-on::before { background: var(--ap-success); }
.ap-head-actions { margin-left: auto; display: flex; gap: 6px; }

/* —— 按钮 —— */
.ap-btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 5px;
  height: 28px; padding: 0 10px;
  font-family: var(--ap-font); font-size: 12px; font-weight: 500; line-height: 1;
  color: var(--ap-body);
  background: var(--ap-surface);
  border: 1px solid var(--ap-line-strong);
  border-radius: var(--ap-radius-sm);
  cursor: pointer; white-space: nowrap; user-select: none;
  transition: background-color 140ms ease, border-color 140ms ease, color 140ms ease, opacity 140ms ease;
}
.ap-btn:hover:not(:disabled) { background: var(--ap-sunken); border-color: var(--ap-line-strong); color: var(--ap-ink); }
.ap-btn:active:not(:disabled) { transform: translateY(.5px); }
.ap-btn:disabled { opacity: .45; cursor: not-allowed; }
.ap-btn:focus-visible {
  outline: none;
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--ap-focus) 28%, transparent);
}
.ap-btn.is-accent { color: var(--ap-accent); border-color: color-mix(in srgb, var(--ap-accent) 45%, var(--ap-line-strong)); }
.ap-btn.is-accent:hover:not(:disabled) { background: color-mix(in srgb, var(--ap-accent) 8%, transparent); }
.ap-btn.is-primary {
  color: var(--color-text-white, #fff);
  background: var(--ap-accent);
  border-color: var(--ap-accent);
}
.ap-btn.is-primary:hover:not(:disabled) { background: var(--ap-accent-strong); border-color: var(--ap-accent-strong); color: var(--color-text-white,#fff); }
.ap-btn.is-block { width: 100%; }

/* —— 提示（底部日志区，限高可滚动）—— */
.ap-msg {
  font-size: 12px; line-height: 1.55; white-space: pre-wrap;
  padding: 8px 10px; border-radius: var(--ap-radius-sm);
  border: 1px solid var(--ap-line);
  background: var(--ap-sunken);
  color: var(--ap-body);
  word-break: break-word;
  max-height: 132px; overflow-y: auto;
  font-family: var(--ap-font);
}
.ap-msg.is-log { font-family: var(--ap-mono); font-size: 11px; }
.ap-msg.is-ok   { color: var(--ap-success); border-color: color-mix(in srgb, var(--ap-success) 35%, transparent); background: color-mix(in srgb, var(--ap-success) 8%, transparent); }
.ap-msg.is-err  { color: var(--ap-danger);  border-color: color-mix(in srgb, var(--ap-danger) 35%, transparent);  background: color-mix(in srgb, var(--ap-danger) 8%, transparent); }
.ap-msg.is-warn { color: var(--ap-warning); border-color: color-mix(in srgb, var(--ap-warning) 35%, transparent); background: color-mix(in srgb, var(--ap-warning) 8%, transparent); }

/* —— 表单 —— */
.ap-label { font-size: 11px; font-weight: 500; color: var(--ap-muted); margin-bottom: 4px; display: block; }
.ap-select, .ap-input {
  width: 100%; box-sizing: border-box;
  font-family: var(--ap-font); font-size: 12px; font-weight: 500;
  color: var(--ap-ink); background: var(--ap-surface);
  border: 1px solid var(--ap-line-strong); border-radius: var(--ap-radius-sm);
  padding: 5px 8px; outline: none;
  transition: border-color 140ms ease, box-shadow 140ms ease;
}
.ap-input::placeholder { color: var(--ap-placeholder); font-weight: 400; }
.ap-select:hover, .ap-input:hover { border-color: var(--color-border-button-hover, var(--ap-muted)); }
.ap-select:focus-visible, .ap-input:focus-visible {
  border-color: var(--ap-focus);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--ap-focus) 22%, transparent);
}
.ap-input.is-mono { font-family: var(--ap-mono); font-size: 11px; }

/* —— 目录树 —— */
.ap-section-head {
  display: flex; align-items: center; gap: 6px;
  font-size: 11px; font-weight: 500; color: var(--ap-muted);
  margin-bottom: 6px;
}
.ap-section-head b { color: var(--ap-body); font-weight: 600; }
.ap-tree-actions {
  margin-left: auto; display: flex; align-items: center; gap: 8px; min-width: 0;
}
.ap-tree-target { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 150px; }
.ap-tree.is-busy { opacity: .55; pointer-events: none; }
.ap-link.is-busy { opacity: .6; pointer-events: none; }
.ap-tree {
  max-height: 264px; overflow: auto;
  border: 1px solid var(--ap-line);
  border-radius: var(--ap-radius-sm);
  background: var(--ap-surface);
  padding: 4px;
}
.ap-row {
  display: flex; align-items: center; gap: 5px;
  min-height: 24px; padding: 2px 6px;
  border-radius: 6px; cursor: pointer;
  font-size: 12px; color: var(--ap-body);
  transition: background-color 120ms ease, color 120ms ease;
}
.ap-row:hover { background: var(--ap-sunken); color: var(--ap-ink); }
.ap-row.is-folder-target {
  background: color-mix(in srgb, var(--ap-accent) 10%, transparent);
  color: var(--ap-ink); font-weight: 500;
}
.ap-row.is-api-selected {
  background: color-mix(in srgb, var(--ap-accent) 14%, transparent);
  color: var(--ap-ink); font-weight: 600;
  box-shadow: inset 2px 0 0 var(--ap-accent);
}
.ap-row:focus-visible { outline: none; box-shadow: 0 0 0 2px color-mix(in srgb, var(--ap-focus) 40%, transparent); }
.ap-caret { width: 12px; flex: 0 0 auto; display: inline-flex; align-items: center; justify-content: center; }
.ap-icon  { flex: 0 0 auto; display: inline-flex; align-items: center; }
.ap-name  { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ap-method {
  flex: 0 0 auto; margin-right: 2px;
  font-family: var(--ap-mono); font-size: 9px; font-weight: 600; letter-spacing: .02em;
  padding: 1px 4px; border-radius: 3px; line-height: 1.5;
}
.ap-method.m-get    { color: var(--ap-method-get);    background: color-mix(in srgb, var(--ap-method-get) 12%, transparent); }
.ap-method.m-post   { color: var(--ap-method-post);   background: color-mix(in srgb, var(--ap-method-post) 12%, transparent); }
.ap-method.m-put    { color: var(--ap-method-put);    background: color-mix(in srgb, var(--ap-method-put) 12%, transparent); }
.ap-method.m-delete { color: var(--ap-method-delete); background: color-mix(in srgb, var(--ap-method-delete) 12%, transparent); }
.ap-method.m-patch  { color: var(--ap-method-put);    background: color-mix(in srgb, var(--ap-method-put) 12%, transparent); }
.ap-row-tail { margin-left: auto; display: flex; align-items: center; gap: 6px; flex: 0 0 auto; }
/* —— 文字按钮（参考 CC GUI 的「全部撤销 / 全部暂存」样式：无下划线，悬停才浮起底色）—— */
.ap-link {
  display: inline-flex; align-items: center; gap: 3px;
  font-size: 11px; font-weight: 500; line-height: 1;
  color: var(--ap-muted);
  background: transparent;
  border: 1px solid transparent;
  border-radius: 6px;
  padding: 3px 6px;
  cursor: pointer; white-space: nowrap;
  text-decoration: none;
  transition: background-color 140ms ease, color 140ms ease, border-color 140ms ease;
}
.ap-link:hover {
  color: var(--ap-ink);
  background: var(--ap-sunken);
  border-color: var(--ap-line);
  text-decoration: none;
}
.ap-link:active { transform: translateY(.5px); }
.ap-link.is-accent { color: var(--ap-accent); }
.ap-link.is-accent:hover {
  color: var(--ap-accent);
  background: color-mix(in srgb, var(--ap-accent) 10%, transparent);
  border-color: color-mix(in srgb, var(--ap-accent) 30%, transparent);
}
.ap-link:focus-visible { outline: none; box-shadow: 0 0 0 2px color-mix(in srgb, var(--ap-focus) 40%, transparent); }
.ap-badge {
  font-size: 10px; font-weight: 600; padding: 1px 6px; border-radius: 999px;
  white-space: nowrap;
}
.ap-badge.is-target { color: var(--ap-accent); background: color-mix(in srgb, var(--ap-accent) 12%, transparent); }
.ap-badge.is-selected { color: var(--ap-accent); background: color-mix(in srgb, var(--ap-accent) 16%, transparent); }

/* —— 选中摘要 —— */
.ap-selected {
  display: flex; align-items: baseline; gap: 6px; flex-wrap: wrap;
  font-size: 11px; color: var(--ap-muted); margin: 8px 0 6px;
}
.ap-selected b { color: var(--ap-ink); font-weight: 600; font-size: 12px; }
.ap-selected code {
  font-family: var(--ap-mono); font-size: 10px; color: var(--ap-body);
  background: var(--ap-sunken); padding: 1px 4px; border-radius: 4px;
}

/* —— 元信息表单 —— */
.ap-meta { display: flex; flex-direction: column; gap: 6px; }
.ap-meta-row { display: flex; align-items: center; gap: 8px; }
.ap-meta-row > span:first-child {
  width: 62px; flex: 0 0 auto;
  font-size: 11px; font-weight: 500; color: var(--ap-muted);
}
.ap-meta-foot { margin-top: 2px; }

/* —— 操作区 —— */
.ap-row-btns { display: flex; gap: 6px; flex-wrap: wrap; }
.ap-hint { font-size: 11px; color: var(--ap-muted); line-height: 1.6; }
.ap-hint code { font-family: var(--ap-mono); font-size: 10.5px; }
`;

  const styleDisposer = ctx.theme.injectCss(CSS);

  // ——— 图标（16px，纯 SVG，跟随主题色）———
  const Ic = {
    folder: (open) => h("svg", {
      width: 15, height: 15, viewBox: "0 0 16 16", fill: "none", "aria-hidden": "true",
      style: { flex: "0 0 auto", color: "var(--ap-folder)" },
    },
      h("path", {
        d: open
          ? "M1.5 3.5A1.5 1.5 0 0 1 3 2h3.1c.4 0 .78.16 1.06.44L8.4 3.7H13a1.5 1.5 0 0 1 1.5 1.5v6.3A1.5 1.5 0 0 1 13 13H3a1.5 1.5 0 0 1-1.5-1.5v-8Z"
          : "M1.5 4A1.5 1.5 0 0 1 3 2.5h2.6c.4 0 .78.16 1.06.44l.94.94H13A1.5 1.5 0 0 1 14.5 5.4v5.1A1.5 1.5 0 0 1 13 12H3a1.5 1.5 0 0 1-1.5-1.5V4Z",
        fill: "currentColor", "fill-opacity": open ? ".9" : ".75",
      }),
      h("path", {
        d: "M1.5 6.2h13",
        stroke: "var(--ap-surface)", "stroke-width": "1.2", "stroke-opacity": ".55",
      }),
    ),
    file: () => h("svg", {
      width: 14, height: 14, viewBox: "0 0 16 16", fill: "none", "aria-hidden": "true",
      style: { flex: "0 0 auto", color: "var(--ap-muted)" },
    },
      h("path", {
        d: "M4 1.75h5.1L12.5 5.1v9.15A1.25 1.25 0 0 1 11.25 15.5h-7.5A1.25 1.25 0 0 1 2.5 14.25v-11A1.5 1.5 0 0 1 4 1.75Z",
        stroke: "currentColor", "stroke-width": "1.15", "stroke-linejoin": "round",
      }),
      h("path", { d: "M8.9 2v3.2h3.4", stroke: "currentColor", "stroke-width": "1.15", "stroke-linejoin": "round" }),
    ),
    caret: (open) => h("svg", {
      width: 10, height: 10, viewBox: "0 0 10 10", fill: "none", "aria-hidden": "true",
      style: {
        flex: "0 0 auto", color: "var(--ap-muted)",
        transition: "transform 140ms ease",
        transform: open ? "rotate(90deg)" : "rotate(0deg)",
      },
    },
      h("path", { d: "M3.5 2 7 5l-3.5 3", stroke: "currentColor", "stroke-width": "1.4",
        "stroke-linecap": "round", "stroke-linejoin": "round" }),
    ),
    dot: () => h("span", {
      style: {
        width: 5, height: 5, borderRadius: 999, flex: "0 0 auto",
        background: "var(--ap-muted)", opacity: 0.45, margin: "0 2.5px",
      },
    }),
  };

  // ——— 小组件 ———
  function Btn(props) {
    const cls = ["ap-btn",
      props.variant === "accent" ? "is-accent" : "",
      props.variant === "primary" ? "is-primary" : "",
      props.block ? "is-block" : "",
      props.className || ""].filter(Boolean).join(" ");
    return h("button", {
      type: "button",
      className: cls,
      onClick: props.onClick,
      disabled: props.disabled,
      title: props.title || "",
    }, props.children);
  }
  function Msg({ text, kind }) {
    if (!text) return null;
    const isLog = /\[info\]|\[pull\]|\[提示\]|\[match\]|python |--project/.test(text);
    const cls = "ap-msg" + (isLog ? " is-log" : "") + (kind === "err" ? " is-err" : kind === "ok" ? " is-ok"
      : kind === "warn" ? " is-warn" : "");
    return h("div", { className: cls, role: kind === "err" ? "alert" : "status" }, text);
  }
  function Badge({ text, kind }) {
    return h("span", { className: "ap-badge " + (kind === "target" ? "is-target" : "is-selected") }, text);
  }

  // 纯函数：在扁平节点列表里算某 folder 的完整路径（根目录返回 "根目录"）
  function folderPathOf(list, node) {
    const byId = {};
    (list || []).forEach((x) => { byId[x.target_id] = x; });
    const segs = [];
    let cur = node;
    while (cur && cur.target_type === "folder") {
      segs.unshift(cur.name);
      cur = byId[String(cur.parent_id || "0")];
    }
    return segs.join("/") || "根目录";
  }

  // ——— 目录树 ———
  function Tree(props) {
    const { nodes, expanded, onToggle, parent, selectedId, selectedApiId, onSelect, onSelectApi, onMkdir, depth } = props;
    const kids = nodes
      .filter((n) => String(n.parent_id || "0") === String(parent))
      .sort((a, b) => (a.target_type !== "folder") - (b.target_type !== "folder") || (a.sort || 0) - (b.sort || 0));
    if (!kids.length && depth === 0) {
      return h("div", { style: { fontSize: 12, color: "var(--ap-muted)", padding: 8 } }, "（空项目）");
    }
    return h("div", null, kids.map((n) => {
      const isFolder = n.target_type === "folder";
      const isOpen = expanded.has(n.target_id);
      const sel = n.target_id === selectedId;
      const selApi = n.target_id === selectedApiId;
      const rowCls = "ap-row" + (selApi ? " is-api-selected" : sel ? " is-folder-target" : "");
      return h("div", { key: n.target_id },
        h("div", {
          className: rowCls,
          style: { paddingLeft: depth * 14 + 6 },
          tabIndex: 0,
          onClick: () => { if (isFolder) onToggle(n.target_id); else onSelectApi(n); },
          onKeyDown: (e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              if (isFolder) onToggle(n.target_id); else onSelectApi(n);
            }
          },
          onDoubleClick: () => { if (isFolder) onSelect(n); },
          title: isFolder
            ? "单击展开/收起，双击设为上传目标"
            : "单击选中该接口（用于补全入参出参 / 生成文档）：" + (n.method || "") + " " + (n.url || ""),
        },
          h("span", { className: "ap-caret" }, isFolder ? Ic.caret(isOpen) : null),
          h("span", { className: "ap-icon" }, isFolder ? Ic.folder(isOpen) : Ic.file()),
          isFolder ? null : h("span", { className: "ap-method " + ("m-" + (n.method || "get").toLowerCase()) },
            n.method || "GET"),
          h("span", { className: "ap-name" }, n.name),
          h("span", { className: "ap-row-tail" },
            sel ? h(Badge, { text: "✓ 目标", kind: "target" }) : null,
            selApi ? h(Badge, { text: "✓ 已选", kind: "selected" }) : null,
            isFolder
              ? h("span", {
                  className: "ap-link",
                  title: "在此目录下新建子目录",
                  onClick: (e) => { e.stopPropagation(); onMkdir && onMkdir(n); },
                  onKeyDown: (e) => {
                    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); onMkdir && onMkdir(n); }
                  },
                  role: "button",
                  tabIndex: 0,
                }, "＋")
              : null,
            isFolder && !sel
              ? h("span", {
                  className: "ap-link",
                  onClick: (e) => { e.stopPropagation(); onSelect(n); },
                  onKeyDown: (e) => {
                    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); onSelect(n); }
                  },
                  role: "button",
                  tabIndex: 0,
                }, "设为目标")
              : null,
            !isFolder && !selApi
              ? h("span", {
                  className: "ap-link",
                  onClick: (e) => { e.stopPropagation(); onSelectApi(n); },
                  onKeyDown: (e) => {
                    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); onSelectApi(n); }
                  },
                  role: "button",
                  tabIndex: 0,
                }, "选中")
              : null,
          ),
        ),
        isFolder && isOpen
          ? h(Tree, { ...props, parent: n.target_id, depth: depth + 1 })
          : null,
      );
    }));
  }

  // 文档元信息默认值：全部可留空，留空即使用这里的默认（用户不必填写任何信息）
  const DEFAULT_BASE_URL = "http://ip:port";
  function buildDefaults(api, project) {
    return {
      title: api ? api.name + "-接口文档" : "",
      provider: (project && project.name) || "",
      consumer: "对外服务",
      baseUrl: DEFAULT_BASE_URL,
    };
  }

  // ——— 页签图标（火箭，线性风格，跟随宿主 currentColor）———
  // 参照 Apipost 官方的火箭意象，但改用与「文件 / 变更 / 知识」一致的
  // 线性描边语言：16px 网格、2.0 描边、圆角端点。
  //
  // 尺寸关键：图形必须**撑满 24×24 画布**（占 58%×62%），否则在 16px 渲染下
  // 只剩 9px 高，比旁边 14px 宽的文件夹图标显小一圈。
  // 目标：宽约 14px / 高约 15px，与文件夹的视觉重量持平。
  function RocketGlyph(props) {
    const p = props || {};
    return h("svg", {
      xmlns: "http://www.w3.org/2000/svg",
      viewBox: "0 0 24 24",
      width: 16, height: 16,
      fill: "none",
      stroke: "currentColor",
      strokeWidth: 2,
      strokeLinecap: "round",
      strokeLinejoin: "round",
      "aria-hidden": "true",
      className: p.className,
      style: p.style,
    },
      // 弹体：从 y=2.6 到 y=18.2，横向 6.6~17.4
      h("path", {
        key: "body",
        d: "M12 2.6c3.5 2.3 5.4 5.5 5.4 9.4v6.2H6.6v-6.2c0-3.9 1.9-7.1 5.4-9.4Z",
      }),
      // 舷窗（略大，保证 16px 下仍可见）
      h("circle", { key: "win", cx: 12, cy: 9.9, r: 2.05 }),
      // 左尾翼：贴到画布左缘
      h("path", { key: "finL", d: "M6.6 12.7 3.4 15.4v4.6l3.2-1.9" }),
      // 右尾翼：贴到画布右缘
      h("path", { key: "finR", d: "M17.4 12.7l3.2 2.7v4.6l-3.2-1.9" })
    );
  }

  // —— 页签显示模式：图标+名称 / 仅图标 ——
  const TAB_ICON_ONLY_KEY = "tabIconOnly";
  const tabListeners = new Set();
  let tabIconOnly = false;

  function tabSubscribe(fn) { tabListeners.add(fn); return () => tabListeners.delete(fn); }
  function tabSnapshot() { return tabIconOnly; }
  function setTabIconOnly(next) {
    tabIconOnly = !!next;
    void ctx.storage.set(TAB_ICON_ONLY_KEY, tabIconOnly);
    tabListeners.forEach((fn) => fn());
  }
  // 首次读取设置（异步），读到后通知页签重绘
  ctx.storage.get(TAB_ICON_ONLY_KEY).then((v) => {
    if (typeof v === "boolean") { tabIconOnly = v; tabListeners.forEach((fn) => fn()); }
  }).catch(() => {});

  // 页签图标组件：宿主在「仅图标」模式下只渲染图标，带标签时我们自己拼图标+文字
  function PanelTabIcon(props) {
    const p = props || {};
    if (ctx.react.useSyncExternalStore) ctx.react.useSyncExternalStore(tabSubscribe, tabSnapshot);
    const iconOnly = tabIconOnly;

    const glyph = h(RocketGlyph, {
      className: iconOnly ? p.className : undefined,
      style: iconOnly ? undefined : { display: "block", flex: "none" },
    });
    if (iconOnly) return glyph;

    // 图标 + 文字：与宿主其它页签同一行盒（13px / 1.4）
    return h("span", {
      className: p.className,
      "aria-hidden": p["aria-hidden"] != null ? p["aria-hidden"] : "true",
      style: {
        display: "inline-flex", alignItems: "center", gap: "5px",
        width: "auto", height: "auto", lineHeight: 1,
      },
    },
      glyph,
      h("span", {
        key: "label",
        style: { fontSize: "13px", fontWeight: 500, lineHeight: "18px", whiteSpace: "nowrap" },
      }, "API")
    );
  }

  // ——— 主面板 ———
  function Panel({ workspacePath }) {
    // 订阅页签显示模式：切换后本面板里的切换按钮也要跟着重绘
    if (ctx.react.useSyncExternalStore) ctx.react.useSyncExternalStore(tabSubscribe, tabSnapshot);
    const [token, setToken] = useState(null);
    const [loginState, setLoginState] = useState("idle"); // idle|waiting|busy
    const [loginUrl, setLoginUrl] = useState("");
    const [msg, setMsg] = useState({ text: "", kind: "" });
    const [teams, setTeams] = useState(null);
    const [proj, setProj] = useState(null);            // {project_id,name,team_name}
    const [nodes, setNodes] = useState(null);
    const [expanded, setExpanded] = useState(new Set());
    const [parent, setParent] = useState({ id: "0", path: "根目录" });
    const [filePath, setFilePath] = useState("");
    const [busy, setBusy] = useState(false);
    const [treeBusy, setTreeBusy] = useState(false);   // 目录树刷新中
    const [selApi, setSelApi] = useState(null);   // 选中的接口节点 {target_id,name,url,method}
    const [docxMeta, setDocxMeta] = useState({ title: "", provider: "", consumer: "", baseUrl: "" });
    const [metaOpen, setMetaOpen] = useState(false);   // 元信息栏仅点 ④ 时展开
    const [skillsReady, setSkillsReady] = useState(false);
    // —— 新建项目（官方 MCP create_project）内联表单 ——
    const [createOpen, setCreateOpen] = useState(false);
    const [createForm, setCreateForm] = useState({ teamId: "", name: "", intro: "" });
    const [creating, setCreating] = useState(false);
    // —— 新建目录（api_upload folder）内联表单：null=收起，否则 {parentId, parentPath} ——
    const [mkdirCtx, setMkdirCtx] = useState(null);
    const [mkdirName, setMkdirName] = useState("");
    const [mkdirBusy, setMkdirBusy] = useState(false);

    // 启动时探测技能目录（换电脑后自动重新定位，不依赖写死的用户名）
    useEffect(() => {
      let alive = true;
      (async () => {
        let dir = "";
        try { dir = await ctx.storage.get(SKILLS_KEY); } catch (_) { /* ignore */ }
        if (!dir) dir = await probeSkillsDir();
        if (!alive) return;
        skillsDir = dir || "";
        if (dir) {
          try { await ctx.storage.set(SKILLS_KEY, dir); } catch (_) { /* ignore */ }
        }
        setSkillsReady(true);
        if (!dir) {
          setMsg({ text: "未找到 Apipost 脚本目录。请确认 ~/.claude/skills/python 下存在 apipost_upload.py，"
            + "或让 AI 帮你改一次路径。", kind: "warn" });
        }
      })();
      return () => { alive = false; };
    }, []);

    useEffect(() => {
      let alive = true;
      ctx.storage.get("docxMeta").then((v) => {
        if (alive && v && typeof v === "object") setDocxMeta(v);
      });
      return () => { alive = false; };
    }, []);

    useEffect(() => {
      let alive = true;
      ctx.storage.get("token").then(async (t) => {
        if (!alive || !t) return;
        setToken(t);
        // 恢复登录态时立即拉项目列表，避免空白
        try {
          const d = await apiGet("/plugin/project/v1/tp_tree_list", t);
          if (alive && d.code === 0) setTeams(d.data || []);
        } catch (e) { /* 失败可由用户点「刷新项目」重试 */ }
      });
      return () => { alive = false; };
    }, []);

    const flash = (text, kind) => setMsg({ text, kind });

    // 文档元信息变化即持久化，下次打开面板还在
    function updateMeta(key, value) {
      setDocxMeta((prev) => {
        const next = { ...prev, [key]: value };
        void ctx.storage.set("docxMeta", next);
        return next;
      });
    }

    // —— 登录：pre_login → 开浏览器 → 轮询 login_check → 换 apiToken ——
    async function login() {
      try {
        setLoginState("busy");
        const pre = await apiGet("/plugin/login/v1/pre_login");
        if (pre.code !== 0) throw new Error("pre_login 失败: " + pre.msg);
        const { login_url, login_check_url } = pre.data;
        setLoginState("waiting");
        setLoginUrl(login_url);
        flash("正在打开浏览器…若没弹出，复制下方链接手动打开（120 秒内完成登录）", "");
        // 用 explorer 打开 URL：不经 cmd，规避 & 被当命令分隔符、start 把引号内 URL 误当标题导致不弹窗
        try {
          await ctx.bridge.invoke("plugin_exec_spawn", {
            bin: "explorer", args: [login_url], lifecycle: "detached",
          });
        } catch (e) {
          flash("自动打开浏览器失败：" + errText(e) + "\n请复制下方链接手动打开", "err");
        }
        const deadline = Date.now() + 120000;
        while (Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 2000));
          let chk;
          try { chk = await apiGet(login_check_url); } catch (e) { continue; }
          const webTok = chk && chk.code === 0 && chk.data && chk.data.token;
          if (webTok) {
            const sw = await apiGet("/plugin/user/v1/to_api_token", webTok);
            const apiTok = sw.code === 0 && sw.data && sw.data.api_token;
            if (!apiTok) throw new Error("换取 apiToken 失败: " + (sw.msg || sw.code));
            setToken(apiTok);
            await ctx.storage.set("token", apiTok);
            try { await writeCliConfig(apiTok); } catch (e) { /* CLI 配置写失败不影响面板 */ }
            setLoginState("idle");
            setLoginUrl("");
            flash("登录成功，token 已保存（面板与 CLI 共用）", "ok");
            void loadProjects(apiTok);
            return;
          }
        }
        throw new Error("等待登录超时");
      } catch (e) {
        setLoginState("idle");
        setLoginUrl("");
        flash("登录失败: " + errText(e), "err");
      }
    }

    async function logout() {
      setToken(null); setTeams(null); setProj(null); setNodes(null);
      await ctx.storage.delete("token");
      flash("已退出（本地清除 token；如需吊销请去官网）", "");
    }

    const [loadingProjects, setLoadingProjects] = useState(false);

    // —— 项目列表 ——
    // opts.silent：新建项目后自动刷新时不覆盖「创建成功」提示；返回 teams 供调用方复用
    async function loadProjects(tk, opts) {
      const t = tk || token;
      if (!t) return [];
      setLoadingProjects(true);
      try {
        const d = await apiGet("/plugin/project/v1/tp_tree_list", t);
        if (d.code !== 0) throw new Error(d.msg || "code " + d.code);
        setTeams(d.data || []);
        if (!opts || !opts.silent) {
          flash("已加载 " + (d.data || []).reduce((n, t2) => n + (t2.project || []).length, 0) + " 个项目", "ok");
        }
        return d.data || [];
      } catch (e) { flash("读取项目列表失败: " + errText(e), "err"); return []; }
      finally { setLoadingProjects(false); }
    }

    // —— 新建项目：官方 MCP create_project（经 apipost_create_project.py）——
    async function createProject() {
      if (!skillsDir) { flash("未找到 apipost_*.py 脚本目录，无法新建项目", "err"); return; }
      const teamId = createForm.teamId.trim();
      const name = createForm.name.trim();
      const intro = createForm.intro.trim();
      if (!teamId) { flash("请选择所属团队", "err"); return; }
      if (!name) { flash("项目名称不能为空", "err"); return; }
      setCreating(true);
      try {
        const argv = [pathsNow().createProject, "--team", teamId, "--name", name];
        if (intro) argv.push("--intro", intro);
        const r = await exec("python", argv, 45000);
        let payload = null;
        const out = (r.stdout || "").trim();
        try { payload = JSON.parse(out.split(/\r?\n/).pop()); } catch (_) { /* 非 JSON */ }
        if (r.code === 0 && payload && payload.code === 0) {
          const newId = payload.data && payload.data.project_id;
          // 云端索引可能有延迟：稍等再重拉；拉不到也不报错，用户可手动选
          await new Promise((res) => setTimeout(res, 1000));
          const list = await loadProjects(token, { silent: true });
          let picked = false;
          if (newId) {
            const owner = list.find((t2) => t2.team_id === teamId);
            const np = owner && (owner.project || []).find((p) => p.project_id === newId);
            if (np) { void pickProject({ ...np, team_name: owner.name }); picked = true; }
          }
          setCreateOpen(false);
          setCreateForm({ teamId: "", name: "", intro: "" });
          flash("项目《" + name + "》创建成功 ✓" + (newId ? "（id: " + newId + "）" : "")
            + (picked ? "\n已自动选中并加载目录树" : "\n项目列表已刷新，可在下拉框中选择"), "ok");
        } else {
          // 脚本契约：失败时 stdout 最后一行是统一 JSON，msg 为中文原因（含服务端业务码原文）
          const msg = payload && payload.msg
            ? payload.msg + (typeof payload.code === "number" ? "（code " + payload.code + "）" : "")
            : "脚本返回异常(code=" + r.code + "):\n" + ((r.stderr || "") + out).slice(-400);
          flash("新建项目失败：" + msg, "err");
        }
      } catch (e) {
        flash("新建项目执行失败: " + errText(e), "err");
      } finally { setCreating(false); }
    }

    // —— 打开建目录表单：node=null 时挂在当前「上传目标」下，否则挂在该文件夹下 ——
    function openMkdir(node) {
      if (!skillsDir) { flash("未找到 apipost_*.py 脚本目录，无法新建目录", "err"); return; }
      const parentId = node ? node.target_id : parent.id;
      const parentPath = node ? folderPathOf(nodes, node) : parent.path;
      setMkdirCtx({ parentId, parentPath });
      setMkdirName("");
    }

    // —— 新建目录：api_upload folder（经 apipost_mkdir.py，脚本侧同级查重）——
    async function submitMkdir() {
      if (!proj || !mkdirCtx) return;
      const name = mkdirName.trim();
      if (!name) { flash("目录名称不能为空", "err"); return; }
      if (/[\\/]/.test(name)) { flash("目录名不能包含 / 或 \\，多级目录请逐层创建", "err"); return; }
      setMkdirBusy(true);
      try {
        const r = await exec("python", [
          pathsNow().mkdir,
          "--project", proj.project_id,
          "--parent", mkdirCtx.parentId,
          "--name", name,
        ], 45000);
        let payload = null;
        const out = (r.stdout || "").trim();
        try { payload = JSON.parse(out.split(/\r?\n/).pop()); } catch (_) { /* 非 JSON */ }
        if (r.code === 0 && payload && payload.code === 0) {
          const fid = payload.data && payload.data.target_id;
          const existed = !!(payload.data && payload.data.existed);
          // 刷新树（拿最新列表，路径计算基于它而不是可能过期的 nodes 闭包）
          const list = await refreshTree();
          if (mkdirCtx.parentId !== "0") {
            setExpanded((prev) => { const n = new Set(prev); n.add(mkdirCtx.parentId); return n; });
          }
          // 新目录自动设为上传目标，形成「建目录 → ① 生成接口直接挂入」闭环
          const node = fid ? list.find((x) => x.target_id === fid) : null;
          if (node) {
            const path = folderPathOf(list, node);
            setParent({ id: node.target_id, path });
            void writeSelection({
              saved_at: new Date().toISOString(),
              project: { project_id: proj.project_id, name: proj.name },
              folder: { id: node.target_id, path },
              api: null,
            });
          }
          const ctxPath = mkdirCtx.parentPath;
          setMkdirCtx(null);
          setMkdirName("");
          flash((existed ? "同级目录已存在，已直接选中：" : "目录创建成功 ✓：") + name
            + "\n位置：" + ctxPath + "　上传目标已切换，① 生成的接口会直接挂进来", "ok");
        } else {
          const msg = payload && payload.msg
            ? payload.msg + (typeof payload.code === "number" ? "（code " + payload.code + "）" : "")
            : "脚本返回异常(code=" + r.code + "):\n" + ((r.stderr || "") + out).slice(-400);
          flash("新建目录失败：" + msg, "err");
        }
      } catch (e) {
        flash("新建目录执行失败: " + errText(e), "err");
      } finally { setMkdirBusy(false); }
    }

    // —— 选项目 → 拉目录树 ——
    async function pickProject(p) {
      setProj(p); setNodes(null); setExpanded(new Set());
      setParent({ id: "0", path: "根目录" });
      await refreshTree(p, { resetSelection: true });
    }

    // 刷新当前项目的目录树（保留骨架、不清空，避免闪烁）；返回最新节点列表
    async function refreshTree(p, opts) {
      const target = p || proj;
      if (!target) { flash("请先选择项目", "err"); return []; }
      setTreeBusy(true);
      try {
        const d = await apiGet("/plugin/api/v1/list?project_id=" + encodeURIComponent(target.project_id), token);
        if (d.code !== 0) throw new Error(d.msg || "code " + d.code);
        const list = (d.data && d.data.list) || [];
        setNodes(list);
        if (opts && opts.resetSelection) { setSelApi(null); setMetaOpen(false); }
        else {
          // 选中项可能已被改动，按 target_id 重新对齐
          setSelApi((prev) => {
            if (!prev) return prev;
            const hit = list.find((x) => x.target_id === prev.target_id);
            return hit || null;
          });
        }
        flash("目录树已刷新：" + list.length + " 个节点", "ok");
        return list;
      } catch (e) { flash("读取目录树失败: " + errText(e), "err"); return []; }
      finally { setTreeBusy(false); }
    }

    function toggle(id) {
      setExpanded((prev) => {
        const n = new Set(prev);
        n.has(id) ? n.delete(id) : n.add(id);
        return n;
      });
    }
    function selectFolder(n) {
      // 计算路径名
      const byId = {};
      (nodes || []).forEach((x) => { byId[x.target_id] = x; });
      const segs = [];
      let cur = n;
      while (cur && cur.target_type === "folder") {
        segs.unshift(cur.name);
        cur = byId[String(cur.parent_id || "0")];
      }
      setParent({ id: n.target_id, path: segs.join("/") });
      flash("上传目标已设为: " + (proj ? proj.name : "") + " / " + segs.join("/"), "ok");
      void writeSelection({
        saved_at: new Date().toISOString(),
        project: proj ? { project_id: proj.project_id, name: proj.name } : null,
        folder: { id: n.target_id, path: segs.join("/") },
        api: null,
      });
    }

    // 选中具体接口 → 写入交接文件（Skill 用 --from-selection 读取）
    function selectApi(n) {
      setSelApi(n);
      setMetaOpen(false);            // 元信息栏只在点 ④ 时出现
      setDocxMeta(buildDefaults(n, proj));
      const byId = {};
      (nodes || []).forEach((x) => { byId[x.target_id] = x; });
      const segs = [];
      let cur = byId[String(n.parent_id || "0")];
      while (cur && cur.target_type === "folder") {
        segs.unshift(cur.name);
        cur = byId[String(cur.parent_id || "0")];
      }
      void writeSelection({
        saved_at: new Date().toISOString(),
        project: proj ? { project_id: proj.project_id, name: proj.name } : null,
        folder: { id: String(n.parent_id || "0"), path: segs.join("/") || "根目录" },
        api: { target_id: n.target_id, name: n.name, method: n.method || "", url: n.url || "" },
      });
      flash("已选中接口：" + (n.method || "") + " " + (n.url || "") + "　《" + n.name + "》"
        + "\n（已同步给 Skill：可直接说「用选中的接口生成对外接口文档」）", "ok");
    }

    // —— 生成接口文档：把上下文写进聊天输入框，交给 APIPOST_GENPOST skill ——
    function genDoc() {
      if (!proj) { flash("请先选择项目", "err"); return; }
      const skillsBase = toWin(skillsDir).replace(/\\python$/i, "");
      const draft =
        "使用 APIPOST_GENPOST 生成 POST 接口文档。\n" +
        "- 目标接口：<在这里写 Controller 方法名或 URL，如 /workshop/xxx/report>\n" +
        "- 模板 JSON：" + (skillsBase ? skillsBase + "\\APIPOST_GENPOST\\assets\\POST接口模板.json"
                                       : "<skills>/APIPOST_GENPOST/assets/POST接口模板.json") + "\n" +
        "- 输出目录：" + pullDirNow() + "\n" +
        "生成完成后，用配套脚本上报到 Apipost 云端并挂到我选好的目录：\n" +
        "  python " + (pathsNow().upload || "<skills>/apipost_upload.py") + " \"<生成的文件>\" --project " + proj.project_id + " --parent " + parent.id + "\n" +
        "（当前选中：项目《" + proj.name + "》 / 目录「" + parent.path + "」，" +
        "工作区 " + (workspacePath || "未知") + "）";
      ctx.composer.setDraft(draft);
      flash("已把生成指令填入输入框，补充接口名后发送即可", "ok");
    }

    // —— ④ 生成对外接口文档：把完整话术自动拼好，填入聊天输入框 ——
    function genDocxPrompt() {
      if (!proj || !selApi) { flash("请先在目录树里单击选中一个接口", "err"); return; }
      // 先展示元信息栏并预填默认值（用户不填任何内容也能直接生成）
      if (!metaOpen) {
        setDocxMeta((prev) => {
          const d = buildDefaults(selApi, proj);
          const next = {};
          for (const k of Object.keys(d)) next[k] = (prev[k] || "").trim() || d[k];
          void ctx.storage.set("docxMeta", next);
          return next;
        });
        setMetaOpen(true);
        flash("已按默认值填好文档元信息 —— 可直接再点一次 ④ 生成，或先修改", "");
        return;
      }

      const d = buildDefaults(selApi, proj);
      const pick = (k) => ((docxMeta[k] || "").trim() || d[k]);
      const title = pick("title");
      const provider = pick("provider");
      const consumer = pick("consumer");
      const baseUrl = pick("baseUrl");
      const safeName = title.replace(/[\\/:*?"<>|]/g, "_");
      const outPath = pullDirNow() + "\\" + safeName + ".docx";

      const draft =
        "使用 APIPOST_GENDOC 技能，把我在 Apipost 面板里选中的接口生成对外接口文档（Word）。\n" +
        "\n" +
        "【选中接口】\n" +
        "- 项目：" + proj.name + "（" + proj.project_id + "）\n" +
        "- 接口：" + selApi.name + "\n" +
        "- 请求：" + (selApi.method || "") + " " + (selApi.url || "") + "\n" +
        "- target_id：" + selApi.target_id + "\n" +
        "\n" +
        "【文档元信息】\n" +
        "- 标题：" + title + "\n" +
        "- 服务提供者：" + provider + "\n" +
        "- 调用方：" + consumer + "\n" +
        "- 方法入口前缀：" + baseUrl + "\n" +
        "- 输出路径：" + outPath + "\n" +
        "\n" +
        "【执行】直接读取面板选中状态（无需我再报 target_id）：\n" +
        "python " + (pathsNow().docx || "<skills>/apipost_docx.py") + " --from-selection \\\n" +
        "  --title \"" + title + "\" --provider \"" + provider + "\"" +
        " --consumer \"" + consumer + "\" --base-url \"" + baseUrl + "\" \\\n" +
        "  --out \"" + outPath + "\"\n" +
        "\n" +
        "【要求】\n" +
        "1. 先检查该接口的入参/出参是否完整；若为空或含义列为空，先用 ② 补全流程把字段写回 Apipost 再生成；\n" +
        "2. 文档结构严格套 assets/接口文档模板.docx（接口清单 + 接口说明 + 逐接口详情表）；\n" +
        "3. 生成后报告入参/出参条目数，并指出仍缺描述的字段；\n" +
        "4. **最后必须输出生成结果的完整绝对路径**（形如 " + outPath + "），我要据此直接打开文件。\n" +
        "\n" +
        "（工作区 " + (workspacePath || "未知") + "）";

      ctx.composer.setDraft(draft);
      flash("已把「生成对外接口文档」话术填入输入框，回车即可执行", "ok");
    }

    // —— ④ 备用：跳过 AI，直接跑脚本生成 ——
    async function genDocx() {
      if (!proj || !selApi) { flash("请先在目录树里单击选中一个接口", "err"); return; }
      setBusy(true);
      try {
        const d = buildDefaults(selApi, proj);
        const pick = (k) => ((docxMeta[k] || "").trim() || d[k]);
        const title = pick("title");
        const safeName = title.replace(/[\\/:*?"<>|]/g, "_");
        const outPath = pullDirNow() + "\\" + safeName + ".docx";
        const argv = [
          pathsNow().docx,
          "--from-selection",
          "--title", title,
          "--provider", pick("provider"),
          "--consumer", pick("consumer"),
          "--base-url", pick("baseUrl"),
          "--out", outPath,
        ];
        const r = await exec("python", argv, 90000);
        const out = (r.stdout || "") + (r.stderr || "");
        if (r.code === 0) {
          flash("接口文档已生成 ✓\n完整路径：" + outPath + "\n" + out.slice(-300), "ok");
          try { await ctx.shell.revealPath(outPath); } catch (e) {}
        } else {
          flash("生成失败(code=" + r.code + "):\n" + out.slice(-600), "err");
        }
      } catch (e) {
        flash("生成执行失败: " + errText(e), "err");
      } finally { setBusy(false); }
    }

    // —— 在浏览器打开选中接口的文档（本地 HTML 渲染，并用系统浏览器打开）——
    async function openApiDoc() {
      if (!proj || !selApi) { flash("请先在目录树里单击选中一个接口", "err"); return; }
      setBusy(true);
      try {
        const d = buildDefaults(selApi, proj);
        const pick = (k) => ((docxMeta[k] || "").trim() || d[k]);
        const safeName = pick("title").replace(/[\\/:*?"<>|]/g, "_");
        const outPath = pullDirNow() + "\\" + safeName + ".html";
        const r = await exec("python", [
          pathsNow().view, "--from-selection",
          "--title", pick("title"),
          "--provider", pick("provider"),
          "--consumer", pick("consumer"),
          "--base-url", pick("baseUrl"),
          "--out", outPath,
        ], 60000);
        const out = (r.stdout || "") + (r.stderr || "");
        if (r.code === 0) {
          flash("接口文档已生成 ✓\n完整路径：" + outPath, "ok");
          // 用系统默认浏览器打开（explorer 不会把 & 当分隔符）
          try {
            await ctx.bridge.invoke("plugin_exec_spawn", {
              bin: "explorer", args: [outPath], lifecycle: "detached",
            });
          } catch (e) { flash("生成成功但打开失败：" + errText(e) + "\n路径：" + outPath, "err"); }
        } else {
          flash("生成失败(code=" + r.code + "):\n" + out.slice(-600), "err");
        }
      } catch (e) {
        flash("执行失败: " + errText(e), "err");
      } finally { setBusy(false); }
    }

    // —— 选中接口 → 下载完整定义到本地，交由 AI 补全入参/出参 ——
    async function pullSelected() {
      if (!proj || !selApi) { flash("请先在目录树里点选一个接口", "err"); return; }
      setBusy(true);
      try {
        const r = await exec("python", [
          pathsNow().upload, "--pull", selApi.target_id,
          "--project", proj.project_id,
          "--out", pullDirNow(),
        ], 60000);
        const out = (r.stdout || "") + (r.stderr || "");
        if (r.code === 0) {
          const file = out.split("\n").filter((l) => l.includes("-拉取.json"))
            .map((l) => (l.includes("→") ? l.split("→").pop().trim() : "")).filter(Boolean)[0] || "";
          flash("已下载接口定义 ✓\n" + out.slice(-500), "ok");
          // 把补全指令填入输入框，AI 可直接读文件、改出参入参、回传更新
          const draft =
            "请补全 Apipost 接口的入参/出参描述并回传更新。\n" +
            "- 待补全文件：" + (file || (pullDirNow() + "\\" + selApi.name + "-拉取.json")) + "\n" +
            "- 项目 ID：" + proj.project_id + "（" + proj.name + "）\n" +
            "- 接口：" + (selApi.method || "") + " " + (selApi.url || "") + "　《" + selApi.name + "》\n" +
            "要求：\n" +
            "1. 读该后端接口的 Controller/DTO/Service，确认真实入参字段与类型，写入 request.body.raw（JSON 字符串）与 request.body.raw_schema；GET 接口写 request.query.parameter；\n" +
            "2. 按真实返回结构补全 response.example（成功/失败两条）的 raw、raw_parameter、expect.schema；\n" +
            "3. 保持 target_id、project_id、parent_id 不变，其余骨架字段原样保留；\n" +
            "4. 改完后执行回传：\n" +
            "   python " + pathsNow().upload + " \"" + (file || (pullDirNow() + "\\" + selApi.name + "-拉取.json")) + "\" --project " + proj.project_id + "\n" +
            "（工作区 " + (workspacePath || "未知") + "）";
          ctx.composer.setDraft(draft);
        } else {
          flash("下载失败(code=" + r.code + "):\n" + out.slice(-600), "err");
        }
      } catch (e) {
        flash("下载执行失败: " + errText(e), "err");
      } finally { setBusy(false); }
    }

    // —— 直接上传指定文件 ——
    async function upload() {
      if (!proj) { flash("请先选择项目", "err"); return; }
      if (!filePath.trim()) { flash("请填写要上传的接口 JSON 文件路径", "err"); return; }
      setBusy(true);
      try {
        const r = await exec("python", [
          pathsNow().upload, filePath.trim(),
          "--project", proj.project_id,
          "--parent", parent.id,
        ], 60000);
        const out = (r.stdout || "") + (r.stderr || "");
        if (r.code === 0 && out.includes('"code": 0')) {
          flash("上传成功 ✓\n" + out.slice(-400), "ok");
          await refreshTree();          // 上传后立即刷新目录树
        } else {
          flash("上传返回异常(code=" + r.code + "):\n" + out.slice(-600), "err");
        }
      } catch (e) {
        flash("上传执行失败: " + errText(e), "err");
      } finally { setBusy(false); }
    }

    // —— 渲染 ——
    return h("div", { className: "apipost-panel" },
      // 页头
      h("div", { className: "ap-head" },
        h("span", { className: "ap-title" },
          h("span", { className: "ap-title-icon" }, h(RocketGlyph, null)),
          "API"),
        h("span", { className: "ap-dot" + (token ? " is-on" : "") }, token ? "已登录" : "未登录"),
        h("div", { className: "ap-head-actions" },
          token
            ? h(Btn, { onClick: logout }, "退出")
            : h(Btn, { variant: "primary", onClick: login, disabled: loginState !== "idle" },
                loginState === "waiting" ? "等待登录…" : "登录"),
          h(Btn, { onClick: () => loadProjects(), disabled: !token || loadingProjects },
            loadingProjects ? "加载中…" : "刷新项目"),
          h(Btn, {
            onClick: () => setTabIconOnly(!tabIconOnly),
            title: tabIconOnly ? "切换为「图标 + 名称」" : "切换为「仅图标」",
          }, tabIconOnly ? "☰" : "▣"),
        ),
      ),

      // 登录链接兜底
      loginState === "waiting" && loginUrl
        ? h("div", { className: "ap-card" },
            h("div", { className: "ap-label" }, "登录链接（点击复制）"),
            h("div", {
              className: "ap-input is-mono",
              role: "button",
              tabIndex: 0,
              style: { cursor: "pointer", wordBreak: "break-all", color: "var(--ap-accent)" },
              onClick: () => {
                try { navigator.clipboard.writeText(loginUrl); flash("链接已复制到剪贴板", "ok"); }
                catch (e) { flash("复制失败，请手动选中链接复制", "err"); }
              },
              title: "点击复制",
            }, loginUrl))
        : null,

      // 项目选择
      token && teams
        ? h("div", { className: "ap-card" },
            h("label", { className: "ap-label" }, "项目"),
            h("select", {
              className: "ap-select",
              value: proj ? proj.team_id + "|" + proj.project_id : "",
              onChange: (e) => {
                const v = e.target.value;
                if (!v) { setProj(null); setNodes(null); return; }
                const [tid, pid] = v.split("|");
                const team = teams.find((t) => t.team_id === tid);
                const p = (team.project || []).find((x) => x.project_id === pid);
                void pickProject({ ...p, team_name: team.name });
              },
            },
              h("option", { value: "" }, "— 选择项目 —"),
              teams.map((t) => h("optgroup", { key: t.team_id, label: t.name },
                (t.project || []).map((p) => h("option", {
                  key: t.team_id + "|" + p.project_id, value: t.team_id + "|" + p.project_id,
                }, p.name)))),
            ),
            // 新建项目入口（官方 MCP create_project，经 Python 脚本调用）
            h("div", { style: { display: "flex", justifyContent: "flex-end", marginTop: 6 } },
              h("span", {
                className: "ap-link" + (!skillsDir ? " is-busy" : ""),
                role: "button", tabIndex: 0,
                title: skillsDir
                  ? "通过 Apipost 官方 MCP 在指定团队下新建项目"
                  : "未找到 apipost_*.py 脚本目录，无法新建项目",
                onClick: () => {
                  if (!skillsDir) return;
                  if (!createOpen) {
                    // 默认带出当前项目所属团队，省一次选择
                    setCreateForm((prev) => ({
                      teamId: prev.teamId || (proj && proj.team_id) || "",
                      name: "", intro: "",
                    }));
                  }
                  setCreateOpen(!createOpen);
                },
                onKeyDown: (e) => {
                  if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setCreateOpen(!createOpen); }
                },
              }, createOpen ? "收起新建表单" : "＋ 新建项目")),
            // 新建项目内联表单
            createOpen
              ? h("div", {
                  className: "ap-card",
                  style: {
                    marginTop: 8, padding: 10, background: "var(--ap-sunken)",
                    boxShadow: "none", display: "flex", flexDirection: "column", gap: 8,
                  },
                },
                h("div", null,
                  h("label", { className: "ap-label" }, "所属团队（必填）"),
                  h("select", {
                    className: "ap-select",
                    value: createForm.teamId,
                    onChange: (e) => setCreateForm((prev) => ({ ...prev, teamId: e.target.value })),
                  },
                    h("option", { value: "" }, "— 选择团队 —"),
                    teams.map((t) => h("option", { key: t.team_id, value: t.team_id },
                      t.name + "（" + (t.project || []).length + " 个项目）")))),
                h("div", null,
                  h("label", { className: "ap-label" }, "项目名称（必填）"),
                  h("input", {
                    className: "ap-input",
                    placeholder: "如：三级修接口管理",
                    value: createForm.name,
                    maxLength: 50,
                    onChange: (e) => setCreateForm((prev) => ({ ...prev, name: e.target.value })),
                    onKeyDown: (e) => {
                      if (e.key === "Enter" && createForm.teamId.trim() && createForm.name.trim() && !creating) {
                        void createProject();
                      }
                    },
                  })),
                h("div", null,
                  h("label", { className: "ap-label" }, "项目简介（选填）"),
                  h("input", {
                    className: "ap-input",
                    placeholder: "一句话说明项目用途，可留空",
                    value: createForm.intro,
                    maxLength: 120,
                    onChange: (e) => setCreateForm((prev) => ({ ...prev, intro: e.target.value })),
                  })),
                h("div", { style: { display: "flex", gap: 6, justifyContent: "flex-end" } },
                  h(Btn, {
                    onClick: () => { setCreateOpen(false); },
                    disabled: creating,
                  }, "取消"),
                  h(Btn, {
                    variant: "primary",
                    onClick: createProject,
                    disabled: creating || !createForm.teamId.trim() || !createForm.name.trim(),
                    title: "调用官方 MCP create_project，成功后自动刷新项目列表",
                  }, creating ? "创建中…" : "确认创建")))
              : null,
          )
        : null,

      // 目录树
      proj && nodes
        ? h("div", { className: "ap-card" },
            h("div", { className: "ap-section-head" },
              h("span", null, "目录树"),
              h("span", { className: "ap-tree-actions" },
                h("span", { className: "ap-tree-target" }, "目标：", h("b", null, parent.path)),
                h("span", {
                  className: "ap-link" + (!skillsDir ? " is-busy" : ""),
                  role: "button", tabIndex: 0,
                  title: skillsDir ? "在当前上传目标下新建目录" : "未找到 apipost_*.py 脚本目录",
                  onClick: () => { if (skillsDir) openMkdir(null); },
                  onKeyDown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); if (skillsDir) openMkdir(null); } },
                }, "＋ 目录"),
                h("span", {
                  className: "ap-link" + (treeBusy ? " is-busy" : ""),
                  role: "button", tabIndex: 0,
                  title: "从云端重新拉取目录树",
                  onClick: () => { if (!treeBusy) void refreshTree(); },
                  onKeyDown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); if (!treeBusy) void refreshTree(); } },
                }, treeBusy ? "刷新中…" : "↻ 刷新"))),
            h("div", { className: "ap-tree" + (treeBusy ? " is-busy" : "") },
              h(Tree, {
                nodes, expanded, onToggle: toggle, parent: "0",
                selectedId: parent.id, onSelect: selectFolder,
                selectedApiId: selApi ? selApi.target_id : null,
                onSelectApi: (n) => { selectApi(n); },
                onMkdir: openMkdir,
                depth: 0,
              })),
            // 新建目录内联表单（头部「＋ 目录」或文件夹行尾「＋」触发）
            mkdirCtx
              ? h("div", {
                  className: "ap-card",
                  style: {
                    marginTop: 8, padding: 10, background: "var(--ap-sunken)",
                    boxShadow: "none", display: "flex", flexDirection: "column", gap: 8,
                  },
                },
                h("div", { className: "ap-label" },
                  "新建目录 —— 父级：", h("b", null, mkdirCtx.parentPath)),
                h("input", {
                  className: "ap-input",
                  autoFocus: true,
                  placeholder: "目录名称（单级，不含 / 或 \\）",
                  value: mkdirName,
                  maxLength: 50,
                  onChange: (e) => setMkdirName(e.target.value),
                  onKeyDown: (e) => {
                    if (e.key === "Enter" && mkdirName.trim() && !mkdirBusy) void submitMkdir();
                    if (e.key === "Escape") { setMkdirCtx(null); setMkdirName(""); }
                  },
                }),
                h("div", { style: { display: "flex", gap: 6, justifyContent: "flex-end" } },
                  h(Btn, {
                    onClick: () => { setMkdirCtx(null); setMkdirName(""); },
                    disabled: mkdirBusy,
                  }, "取消"),
                  h(Btn, {
                    variant: "primary", onClick: submitMkdir,
                    disabled: mkdirBusy || !mkdirName.trim(),
                    title: "同级同名目录会自动复用，不会建副本",
                  }, mkdirBusy ? "创建中…" : "确认创建")))
              : null,
          )
        : null,

      // 操作区
      proj
        ? h("div", { className: "ap-card" },
            skillsReady && !skillsDir
              ? h("div", { className: "ap-msg is-warn", style: { marginBottom: 8 } },
                  "未找到 apipost_*.py 脚本目录（默认 ~/.claude/skills/python）。"
                  + "上传/生成文档类按钮将不可用。")
              : null,
            h("div", { className: "ap-row-btns", style: { marginBottom: 8 } },
              h(Btn, { onClick: genDoc }, "① 生成接口文档"),
              h(Btn, {
                variant: "accent",
                onClick: () => {
                  if (!selApi) { flash("请先在目录树里单击选中一个接口（文件夹是双击设为目标）", "err"); return; }
                  void pullSelected();
                },
                disabled: busy,
              }, busy ? "处理中…" : (selApi ? "② 补全「" + selApi.name.slice(0, 10) + "」" : "② 补全选中接口")),
              h(Btn, { onClick: upload, disabled: busy }, busy ? "上传中…" : "③ 直接上传文件"),
              h(Btn, {
                variant: "accent", onClick: genDocxPrompt, disabled: busy,
              }, busy ? "处理中…" : (metaOpen ? "④ 生成对外接口文档" : "④ 生成对外接口文档（先确认元信息）")),
              h(Btn, { onClick: openApiDoc, disabled: busy || !selApi }, "⑤ 打开接口文档"),
            ),

            selApi
              ? h("div", { className: "ap-selected" },
                  h("span", null, "已选"),
                  h("b", null, selApi.name),
                  h("code", null, (selApi.method || "") + " " + (selApi.url || "")),
                  h("span", {
                    className: "ap-link",
                    role: "button", tabIndex: 0,
                    onClick: () => { setSelApi(null); setMetaOpen(false); },
                  }, "取消选择"))
              : h("div", { className: "ap-hint", style: { marginBottom: 8 } },
                  "在目录树里单击接口名即可选中 —— 用于补全入参/出参、生成对外文档"),

            // ④ 文档元信息 —— 仅点击 ④ 后展开；默认值已预填，可全部不填直接生成
            selApi && metaOpen
              ? h("div", { className: "ap-card", style: { padding: 10, background: "var(--ap-sunken)", boxShadow: "none" } },
                  h("div", { className: "ap-label" },
                    "④ 文档元信息（已预填默认值，可留空直接生成）"),
                  h("div", { className: "ap-meta" },
                    (() => {
                      const d = buildDefaults(selApi, proj);
                      return [
                        ["title", "标题", d.title, false],
                        ["provider", "服务提供者", d.provider, false],
                        ["consumer", "调用方", d.consumer, false],
                        ["baseUrl", "入口前缀", d.baseUrl, true],
                      ];
                    })().map(([key, label, dflt, mono]) =>
                      h("div", { key: key, className: "ap-meta-row" },
                        h("span", null, label),
                        h("input", {
                          className: "ap-input" + (mono ? " is-mono" : ""),
                          placeholder: "默认：" + dflt,
                          value: docxMeta[key] || "",
                          onChange: (e) => updateMeta(key, e.target.value),
                        }),
                      )),
                    h("div", { className: "ap-meta-foot" },
                      h("span", {
                        className: "ap-link",
                        role: "button", tabIndex: 0,
                        onClick: () => { if (!busy) void genDocx(); },
                        title: "不经过 AI，直接调用 apipost_docx.py 生成本地 docx",
                      }, "跳过 AI，直接生成到本地 →")),
                  ))
              : null,

            // ③ 文件路径
            h("div", { style: { display: "flex", gap: 6, marginTop: 8 } },
              h("input", {
                className: "ap-input is-mono",
                placeholder: "③ 接口 JSON 路径，如 …\\xxx-POST接口.json",
                value: filePath,
                onChange: (e) => setFilePath(e.target.value),
              }),
              filePath
                ? h(Btn, { onClick: () => ctx.shell.revealPath(filePath.trim()).catch(() => {}) }, "定位")
                : null,
            ),
          )
        : null,

      !token
        ? h("div", { className: "ap-hint" },
            "流程：登录（跳转浏览器授权）→ 选项目 → 选目录 → 生成接口文档 / 补全已有接口 / 直推上传 → 生成对外 Word 文档。",
            h("br"),
            "与 ", h("code", null, pathsNow().upload || "<skills>/apipost_upload.py"), " 共用 token 与协议，互不干扰。")
        : null,

      // 操作反馈固定在底部，不挤占上方浏览区
      h(Msg, { text: msg.text, kind: msg.kind }),
    );
  }

  const disposer = ctx.ui.registerPanelTab({
    key: "apipost-panel",
    label: () => "API",
    icon: PanelTabIcon,
    component: Panel,
  });
  return () => {
    if (typeof disposer === "function") disposer();
    if (typeof styleDisposer === "function") styleDisposer();
  };
}
