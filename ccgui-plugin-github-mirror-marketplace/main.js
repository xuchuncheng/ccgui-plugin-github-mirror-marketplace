/*
 * 社区插件市场镜像加速 —— CC GUI 插件（Tier-1 JS，零构建，vanilla DOM）
 *
 * 要解决的问题：
 *   宿主内置插件市场用 GET 抓
 *   https://raw.githubusercontent.com/.../community-plugins.json，
 *   国内企业内网/防火墙常封 raw.githubusercontent.com，报
 *   "error sending request for url" → 市场整块打不开。
 *
 * ⚠️ 能力边界（诚实声明，面板顶部也会显示）：
 *   宿主那一次抓取发生在 Rust 后端(reqwest)，JS 插件【拦不到、也改不了】它——
 *   所以本插件不去"劫持"内置市场，而是【另起一条弹性抓取链】把同一份配置抓到手，
 *   在右侧面板里给你浏览并一键安装，绕开内置那次失败。
 *   你要求的自定义 UA / 10s 超时都照做；"强制 HTTP/1.1"在本 bridge 里尽力传
 *   （带 version 试一次，若 bridge 因不认字段报错就退回不带再试一次），
 *   因为宿主 reqwest 的 TLS 参数插件层面无法直接设置。
 *
 * 抓取链（任一拿到"2xx + 可解析 + 结构像清单"即停，其余静默跳过并记录原因）：
 *   主 raw → 备 JsDelivr CDN → 国内镜像(ghproxy 系，前缀包裹主地址，可在面板编辑)。
 *
 * 实现要点（沿用同仓 temp-external-view 的约束）：
 *   - 运行时禁止 import 外部模块，故本文件自包含；纯算法与 test/core.test.js 里的
 *     core.js 是同一段逻辑的两份拷贝（core.js 为可单测的权威副本，改动请同步）。
 *   - 下载/写盘走 ctx.bridge.invoke("plugin_exec_run",{bin:"powershell"})，
 *     文件内容与路径一律经 env 以 base64 传入脚本再解码，绝不拼进命令行 → 无注入。
 *   - 列表缓存进 ctx.storage，宿主市场彻底挂掉时仍可离线看上次结果。
 */

// ══ 纯逻辑（与 core.js 同步）══════════════════════════════════════════
const PRIMARY_URL =
  "https://raw.githubusercontent.com/zhukunpenglinyutong/ccgui-plugins/main/community-plugins.json";
const FALLBACK_URL =
  "https://cdn.jsdelivr.net/gh/zhukunpenglinyutong/ccgui-plugins@main/community-plugins.json";
const DEFAULT_MIRROR_PREFIXES = ["https://ghproxy.net/", "https://gh-proxy.com/"];
const UPDATER_LATEST_URL =
  "https://github.com/zhukunpenglinyutong/desktop-cc-gui/releases/latest/download/latest.json";
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0 Safari/537.36";
const TIMEOUT_MS = 10000;
const LIST_KEYS = ["plugins", "items", "list", "community", "data", "entries"];

function str(v) {
  return v == null ? "" : String(v);
}

function buildEndpoints(opts = {}) {
  const primary = opts.primaryUrl || PRIMARY_URL;
  const fallback = opts.fallbackUrl || FALLBACK_URL;
  const mirrors = opts.mirrorPrefixes ?? DEFAULT_MIRROR_PREFIXES;
  const list = [primary, fallback];
  for (const pfx of mirrors || []) {
    if (!pfx) continue;
    list.push(pfx.replace(/\/$/, "") + "/" + primary);
  }
  const seen = new Set();
  const out = [];
  for (const u of list) if (u && !seen.has(u)) (seen.add(u), out.push(u));
  return out;
}

function isAccepted(status) {
  return typeof status === "number" && status >= 200 && status < 300;
}

function toEntry(raw) {
  const o = raw && typeof raw === "object" ? raw : {};
  const repo = str(o.repo || o.repository || o.github || o.homepage);
  const name = str(o.name || o.title || o.displayName);
  const id = str(o.id || o.identifier || o.slug || repoBase(repo) || name) || "unnamed";
  return {
    id,
    name: name || id,
    author: str(o.author || o.owner || o.maintainer),
    description: str(o.description || o.summary || o.desc),
    version: str(o.version),
    tier: str(o.tier),
    repo,
    url: str(o.url || o.download || o.manifest || o.main || o.entry),
    _raw: o,
  };
}

function repoBase(repo) {
  const p = parseRepo(repo);
  return p ? p.name : "";
}

function parseRepo(repo) {
  const s = str(repo).trim();
  if (!s) return null;
  let m = s.match(/github\.com\/([^/]+)\/([^/#?]+)/i);
  if (m) {
    const owner = m[1];
    const rest = s.slice(m.index + m[0].length);
    const refm = rest.match(/^\/(?:tree|blob)\/([^/]+)/);
    return { owner, name: m[2].replace(/\.git$/i, ""), ref: refm ? refm[1] : "" };
  }
  m = s.match(/^([\w.-]+)\/([\w.-]+)$/);
  if (m) return { owner: m[1], name: m[2], ref: "" };
  return null;
}

function blobToRaw(url) {
  const s = str(url);
  const m = s.match(/github\.com\/([^/]+)\/([^/]+)\/blob\/(.+)$/i);
  if (!m) return s || "";
  return `https://raw.githubusercontent.com/${m[1]}/${m[2]}/${m[3]}`;
}

function normalizePlugins(json) {
  if (Array.isArray(json)) return json.map(toEntry);
  if (json && typeof json === "object") {
    for (const k of LIST_KEYS) if (Array.isArray(json[k])) return json[k].map(toEntry);
    for (const v of Object.values(json)) if (Array.isArray(v)) return v.map(toEntry);
  }
  return null;
}

/**
 * 为某个插件的一条文件构造下载端点回退链。
 *
 * 官方分发规范（Obsidian 模式）决定了两类文件住在不同地方：
 *   - manifest.json：默认分支【仓库根】（§4.2 硬性要求）→ 走 raw/jsdelivr/镜像；
 *   - main.js / styles.css：构建产物，只存在于【GitHub Release 附件】，
 *     仓库根没有（那里只有 src/ 源码）。tag 恒等于 manifest.version，
 *     故按 releases/download/{version}/{file} 取，latest 兜底。
 * opts.version：从已下载的 manifest 里解析出的版本号（取非 manifest 文件时必传才有精确路径）。
 * 镜像前缀缺省用 DEFAULT_MIRROR_PREFIXES；Release 下载正是 ghproxy 系的主业，优先套镜像。
 */
function buildFileEndpoints(entry, fileName, opts = {}) {
  const mirrors = (opts.mirrorPrefixes ?? DEFAULT_MIRROR_PREFIXES).filter(Boolean);
  const ref = (entry && entry._raw && (entry._raw.ref || entry._raw.branch)) || opts.ref || "main";
  const rp = parseRepo(entry && entry.repo);
  const out = [];
  const seen = new Set();
  const push = (u) => {
    if (u && !seen.has(u)) {
      seen.add(u);
      out.push(u);
    }
  };
  const wrap = (u) => mirrors.map((p) => p.replace(/\/$/, "") + "/" + u);

  if (fileName === "manifest.json") {
    // 1) 清单里直接给了 url → 优先，且它若是 github blob 也转 raw
    const direct = str(entry && entry.url);
    if (direct) push(blobToRaw(direct) || direct);
    // 2) 仓库根 raw（+镜像包裹），jsdelivr 兜底
    if (rp) {
      const r = rp.ref || ref;
      const raw = `https://raw.githubusercontent.com/${rp.owner}/${rp.name}/${r}/${fileName}`;
      push(raw);
      wrap(raw).forEach(push);
      push(`https://cdn.jsdelivr.net/gh/${rp.owner}/${rp.name}@${r}/${fileName}`);
    }
  } else if (rp) {
    // Release 附件：镜像在前（国内直连 github.com 多半不通），直连兜底。
    const v = str(opts.version);
    const rels = [];
    if (v) rels.push(`https://github.com/${rp.owner}/${rp.name}/releases/download/${v}/${fileName}`);
    rels.push(`https://github.com/${rp.owner}/${rp.name}/releases/latest/download/${fileName}`);
    for (const u of rels) {
      wrap(u).forEach(push);
      push(u);
    }
  }
  return out;
}

async function fetchWithFallback(http, endpoints) {
  const errors = [];
  for (const url of endpoints) {
    try {
      const res = await http(url);
      if (!res || !isAccepted(res.status)) {
        errors.push({ url, reason: "status", detail: res ? res.status : "no-response" });
        continue;
      }
      let parsed;
      try {
        parsed = JSON.parse(res.body);
      } catch (e) {
        errors.push({ url, reason: "json", detail: String((e && e.message) || e) });
        continue;
      }
      const list = normalizePlugins(parsed);
      if (!list) {
        errors.push({ url, reason: "shape", detail: "不是插件数组" });
        continue;
      }
      return { ok: true, endpoint: url, data: list, errors };
    } catch (e) {
      errors.push({ url, reason: "network", detail: String((e && e.message) || e) });
    }
  }
  return { ok: false, endpoint: null, data: null, errors };
}

async function fetchFirstText(http, endpoints) {
  const errors = [];
  for (const url of endpoints) {
    try {
      const res = await http(url);
      if (res && isAccepted(res.status) && res.body != null && String(res.body).length > 0) {
        return { ok: true, endpoint: url, text: String(res.body), errors };
      }
      errors.push({ url, reason: res ? "status" : "no-response", detail: res ? res.status : "" });
    } catch (e) {
      errors.push({ url, reason: "network", detail: String((e && e.message) || e) });
    }
  }
  return { ok: false, endpoint: null, text: "", errors };
}

function buildRegistrationPatch(pluginsJson, pluginId, entry, opts = {}) {
  const base = pluginsJson && typeof pluginsJson === "object" ? pluginsJson : {};
  const plugins = base.plugins && typeof base.plugins === "object" ? { ...base.plugins } : {};
  plugins[str(pluginId)] = {
    version: (entry && entry.version) || opts.version || "0.0.0",
    enabled: true,
    source: "local",
    permissions: (entry && entry._raw && entry._raw.permissions) || [],
    quarantined: false,
    lastError: null,
    installedAt: opts.installedAt || Math.floor(Date.now() / 1000),
  };
  return { ...base, plugins };
}

// 客户端更新（与 core.js 同步）：宿主 updater 端点焊死在 Rust 里改不了，
// 这里用同一批镜像替它检查 latest.json 并定位 windows 安装包。
function compareVersions(a, b) {
  const pa = str(a).split(".").map((x) => parseInt(x, 10) || 0);
  const pb = str(b).split(".").map((x) => parseInt(x, 10) || 0);
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i++) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

function parseLatestJson(json) {
  const o = json && typeof json === "object" ? json : {};
  const plat = (o.platforms && o.platforms["windows-x86_64"]) || null;
  if (!o.version || !plat || !plat.url) {
    return { ok: false, version: "", notes: "", winUrl: "", winSig: "", error: "latest.json 结构不符" };
  }
  return { ok: true, version: str(o.version), notes: str(o.notes), winUrl: str(plat.url), winSig: str(plat.signature), error: "" };
}

function buildUpdaterEndpoints(opts = {}) {
  const mirrors = (opts.mirrorPrefixes ?? DEFAULT_MIRROR_PREFIXES).filter(Boolean);
  const out = [];
  for (const pfx of mirrors) out.push(pfx.replace(/\/$/, "") + "/" + UPDATER_LATEST_URL);
  out.push(UPDATER_LATEST_URL);
  return out;
}

function buildInstallerEndpoints(winUrl, opts = {}) {
  const mirrors = (opts.mirrorPrefixes ?? DEFAULT_MIRROR_PREFIXES).filter(Boolean);
  const out = [];
  for (const pfx of mirrors) out.push(pfx.replace(/\/$/, "") + "/" + winUrl);
  out.push(winUrl);
  return out;
}

function installerFileName(winUrl) {
  const m = str(winUrl).match(/\/([^/?#]+)$/);
  return m ? decodeURIComponent(m[1]) : "ccgui-update-setup.exe";
}

// ── 市场展示（与 core.js 同步）：分类/安装量/图标/排序/合并 ──────────────
const CATEGORIES = [
  { key: "all", label: "全部" },
  { key: "devtools", label: "开发工具" },
  { key: "productivity", label: "效率工具" },
  { key: "integration", label: "集成与渠道" },
  { key: "appearance", label: "界面外观" },
  { key: "other", label: "其他" },
];
const CATEGORY_RULES = [
  { key: "appearance", re: /外观|主题|配色|颜色|字体|边框|跑马灯|背景|淡化|美化|皮肤|壁纸|桌宠|光效|theme|style|color|font|border|rainbow|background|wallpaper|live2d|icon/i },
  { key: "devtools", re: /代码|体检|端口|调试|构建|日志|终端|仓库|分支|文件树|文件预览|预览面板|图表|git|wsl|react|mermaid|pr\b|devtool|code|lint|build|debug|port|terminal|preview|diff/i },
  { key: "integration", re: /供应商|渠道|网关|桥接|上下文|引擎|协议|模型|余额|配额|余量|状态页|服务状态|出口\s*ip|\bip\b|provider|gateway|bridge|context|engine|mcp|balance|quota|status/i },
  { key: "productivity", re: /会话|命名|标题|用量|token|笔记|便签|任务|提醒|拖拽|上传|提示词|自动化|统计|计量|定时|限额|屏蔽|来源|看板|监控|usage|task|session|title|prompt|upload|drag|remind|meter|note|schedule|board|monitor/i },
];

function categoryOf(p) {
  const o = p || {};
  const text = [o.name, o.description, ...(Array.isArray(o.keywords) ? o.keywords : [])].filter(Boolean).join(" ");
  let best = "other", bestN = 0;
  for (const rule of CATEGORY_RULES) {
    const n = (text.match(new RegExp(rule.re.source, "gi")) || []).length;
    if (n > bestN) { bestN = n; best = rule.key; }
  }
  return best;
}

function initials(p) {
  const name = str((p && (p.name || p.id)) || "?").trim();
  if (!name) return "?";
  // 中英混排（如 "Token 速度表"）：取第一个汉字，比孤零零一个拉丁字母更可读。
  const cjk = name.match(/[一-龥]/);
  if (cjk) return cjk[0];
  const words = name.split(/[\s\-_]+/).filter(Boolean);
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
  return name.slice(0, 2).toUpperCase();
}
function tileGradient(id) {
  const s = str(id);
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
  return `linear-gradient(135deg, hsl(${h} 62% 52%), hsl(${(h + 38) % 360} 66% 42%))`;
}
function sortPlugins(list, mode) {
  const arr = (list || []).slice();
  if (mode === "name") arr.sort((a, b) => str(a.name || a.id).localeCompare(str(b.name || b.id), "zh-Hans-CN"));
  else if (mode === "version") arr.sort((a, b) => compareVersions(b.version || "0", a.version || "0"));
  return arr;
}
function mergeMarketData(list, extra) {
  const x = extra && typeof extra === "object" ? extra : {};
  return (list || []).map((p) => {
    const meta = x[p.id] || {};
    return {
      ...p,
      version: str(meta.version || p.version),
      icon: str(meta.icon || p.icon),
      updatedAt: str(meta.updatedAt || ""),
      category: categoryOf(p),
    };
  });
}

// ══ 宿主适配层 ══════════════════════════════════════════════════════════
function sanitizeId(id) {
  return str(id).replace(/[^\w.-]/g, "_") || "unnamed";
}

// UTF-8 安全的 base64（供 powershell 侧 [Convert]::FromBase64String 还原）。
function b64(text) {
  const bytes = new TextEncoder().encode(String(text));
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

export default function activate(ctx) {
  const h = ctx.react;

  // ── HTTP 适配器（对齐真实宿主 v1.0.6 的 plugin_http_request 契约）──────
  // 真实签名：{ method, url, headers, body } → 返回 { status, body }。
  // 没有 timeoutMs/version 字段（多传会被 deny_unknown_fields 拒），超时只能在 JS 侧
  // 用 Promise.race 自己做（与官方 claude-ip-check 同款）。UA 仍按要求带上。
  // 单次请求，带 1 次重试：ghproxy 这类公共镜像偶发 000/超时（实测同 URL
  // 隔一秒再打就 200），单次失败不该让整个元数据缺失。
  async function httpOnce(url) {
    let timer;
    try {
      const p = ctx.bridge.invoke("plugin_http_request", {
        method: "GET",
        url,
        headers: { "User-Agent": USER_AGENT, Accept: "application/json,*/*" },
        body: null,
      });
      const r = await Promise.race([
        p,
        new Promise((_, rej) => (timer = setTimeout(() => rej(new Error("timeout " + TIMEOUT_MS + "ms")), TIMEOUT_MS))),
      ]);
      return normalizeResp(r);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  async function http(url) {
    try {
      return await httpOnce(url);
    } catch (e) {
      await new Promise((r) => setTimeout(r, 350));
      return await httpOnce(url);
    }
  }
  // bridge 返回 {status, body}；容错几种变体，归一成 {status, body}。
  function normalizeResp(r) {
    if (r == null) throw new Error("空响应");
    if (typeof r === "string") return { status: 200, body: r };
    const inner = r.result && typeof r.result === "object" ? r.result : r;
    if (inner.error) throw new Error(String(inner.error));
    const status = Number(inner.status ?? inner.statusCode ?? (inner.ok ? 200 : 0)) || 0;
    const body = inner.body ?? inner.text ?? inner.data ?? "";
    return { status, body: typeof body === "string" ? body : JSON.stringify(body) };
  }

  // ── exec 适配层（实测宿主两坑，勿改回简单写法）────────────────────────
  // 坑1：宿主进程 PATH 被精简，powershell/powershell.exe 都 "not found on PATH"。
  // 坑2：exec 权限按 bin 字段【字面】匹配 grant——绝对路径必须先在 manifest 里
  //     声明成 exec:<同一路径> 才能过门控。
  // 对策：探测宿主 PATH 实际可用的执行器（cmd 最可能在——官方 service-status 就
  //   声明 exec:cmd），缓存赢家；PowerShell 用【正斜杠绝对路径】经 cmd/node 间接
  //   拉起（grant 只看 bin=cmd/node；正斜杠免掉 JS↔argv↔PS 的多层反斜杠转义坑）。
  //   脚本经 -EncodedCommand 传 UTF-16LE base64，绕开 cmd 一切引号/百分号问题；
  //   文件内容仍经 env 传 base64，绝不拼命令行。
  const PS_FWD = "/System32/WindowsPowerShell/v1.0/powershell.exe"; // 前置 %SystemRoot% 或 SystemRoot env
  const PS_ABS_WIN = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"; // 直连候选（grant 需同串）
  const EXEC_PROBES = [
    { bin: "cmd", kind: "cmd", args: ["/c", "echo ok"] },
    { bin: "cmd.exe", kind: "cmd", args: ["/c", "echo ok"] },
    { bin: "node", kind: "node", args: ["-e", "process.stdout.write('ok')"] },
    { bin: "node.exe", kind: "node", args: ["-e", "process.stdout.write('ok')"] },
    { bin: "pwsh", kind: "ps", args: ["-NoProfile", "-Command", "'ok'"] },
    { bin: PS_ABS_WIN, kind: "ps", args: ["-NoProfile", "-NonInteractive", "-Command", "'ok'"] },
    { bin: "powershell.exe", kind: "ps", args: ["-NoProfile", "-NonInteractive", "-Command", "'ok'"] },
    { bin: "powershell", kind: "ps", args: ["-NoProfile", "-NonInteractive", "-Command", "'ok'"] },
  ];
  let execWinner = null; // {bin, kind}

  async function rawRun(bin, args, env) {
    const r = await ctx.bridge.invoke("plugin_exec_run", {
      bin,
      args,
      env: env || {},
      timeoutMs: 30000,
    });
    if (r && r.code !== 0) {
      throw new Error(((r.stderr || "") + "").trim() || "退出码 " + (r && r.code));
    }
    return (r && r.stdout) || "";
  }

  async function pickExec() {
    if (execWinner) return execWinner;
    const errs = [];
    for (const p of EXEC_PROBES) {
      try {
        const out = await rawRun(p.bin, p.args, {});
        if (String(out).trim() === "ok") {
          execWinner = { bin: p.bin, kind: p.kind };
          return execWinner;
        }
        errs.push(p.bin + "：应答异常");
      } catch (e) {
        errs.push(p.bin + "：" + String((e && e.message) || e));
      }
    }
    throw new Error("宿主里找不到任何可用执行器。尝试过：" + errs.join("；"));
  }

  // UTF-16LE base64（PowerShell -EncodedCommand 的编码要求）。
  function b64u16(s) {
    const bytes = new Uint8Array(s.length * 2);
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      bytes[i * 2] = c & 255;
      bytes[i * 2 + 1] = c >> 8;
    }
    let bin = "";
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }

  // node 版转发器：SystemRoot + 正斜杠路径拉起 PowerShell，脚本/env 原样转发。
  const NODE_LAUNCHER =
    "const{execFileSync}=require('child_process');" +
    "const ps=process.env.SystemRoot+'/System32/WindowsPowerShell/v1.0/powershell.exe';" +
    "const o=execFileSync(ps,['-NoProfile','-NonInteractive','-EncodedCommand',process.env.CCGUI_PSB64],{env:process.env,maxBuffer:16*1024*1024});" +
    "process.stdout.write(o);";

  // 执行一段 PowerShell 脚本（env 传给最终 powershell 子进程）。
  async function ps(script, env) {
    const w = await pickExec();
    if (w.kind === "ps") {
      return rawRun(w.bin, ["-NoProfile", "-NonInteractive", "-EncodedCommand", b64u16(script)], env);
    }
    const b64 = b64u16(script);
    if (w.kind === "cmd") {
      // cmd 会展开 %SystemRoot%；正斜杠路径 CreateProcess 直接接受。
      return rawRun(w.bin, ["/c", "%SystemRoot%" + PS_FWD + " -NoProfile -NonInteractive -EncodedCommand " + b64], env);
    }
    // node 转发
    return rawRun(w.bin, ["-e", NODE_LAUNCHER], { ...(env || {}), CCGUI_PSB64: b64 });
  }

  const PS_UTF8 = "try{[Console]::OutputEncoding=[Text.Encoding]::UTF8}catch{}; ";

  // 读宿主现有 plugins.json（不存在则空对象），供 JS 侧合并注册。
  async function readPluginsJson() {
    const out = await ps(
      PS_UTF8 +
        "$pj=Join-Path $env:USERPROFILE '.ccgui-next\\plugins.json'; " +
        "if(Test-Path -LiteralPath $pj){[IO.File]::ReadAllText($pj)}else{'{}'}",
    );
    try {
      return JSON.parse(out || "{}");
    } catch (e) {
      return {};
    }
  }

  // 安装：建目录 + 写文件(base64) + 备份并改写 plugins.json；任一步失败则还原备份。
  async function installPlugin(entry, files, mergedJson) {
    const id = sanitizeId(entry.id);
    const env = {
      CCGUI_ID: id,
      CCGUI_B_MANIFEST: b64(files["manifest.json"] || ""),
      CCGUI_B_MAIN: b64(files["main.js"] || ""),
      CCGUI_B_STYLES: files["styles.css"] != null ? b64(files["styles.css"]) : "",
      CCGUI_B_PLUGINS: b64(JSON.stringify(mergedJson, null, 2)),
    };
    const script =
      PS_UTF8 +
      "$ErrorActionPreference='Stop'; " +
      "$base=Join-Path $env:USERPROFILE '.ccgui-next'; " +
      "$dir=Join-Path $base ('plugins\\'+$env:CCGUI_ID); " +
      "$pj=Join-Path $base 'plugins.json'; " +
      "New-Item -ItemType Directory -Force -Path $dir | Out-Null; " +
      "if(Test-Path -LiteralPath $pj){Copy-Item -LiteralPath $pj -Destination ($pj+'.bak') -Force}; " +
      "try{ " +
      // 注意：PS 不支持 $env:$v 这种动态变量名，按名字取环境变量须用 GetEnvironmentVariable。
      "function W($n,$name){ $v=[Environment]::GetEnvironmentVariable($name); if($v){[IO.File]::WriteAllBytes((Join-Path $dir $n),[Convert]::FromBase64String($v))} }; " +
      "W 'manifest.json' 'CCGUI_B_MANIFEST'; " +
      "W 'main.js' 'CCGUI_B_MAIN'; " +
      "W 'styles.css' 'CCGUI_B_STYLES'; " +
      "[IO.File]::WriteAllBytes($pj,[Convert]::FromBase64String($env:CCGUI_B_PLUGINS)); " +
      "'OK|'+$dir " +
      "}catch{ " +
      "if(Test-Path -LiteralPath ($pj+'.bak')){Copy-Item -LiteralPath ($pj+'.bak') -Destination $pj -Force}; " +
      "throw $_ " +
      "}";
    return (await ps(script, env)).trim();
  }

  // ── 状态 ────────────────────────────────────────────────────────────
  const S = {
    plugins: [],
    extraMeta: {}, // id -> {version, icon}
    installed: {}, // id -> 已装版本（读 ~/.ccgui-next/plugins.json）
    endpointHit: "",
    errors: [],
    loading: false,
    error: "",
    notice: "",
    mirrors: DEFAULT_MIRROR_PREFIXES.slice(),
    expandedId: "",
    installing: {}, // id -> {busy,msg}
    metaLoading: false, // 版本/图标后台补充中
    cat: "all", // 当前分类
    showSettings: false, // 是否展开设置区
    sort: "relevance", // 排序
    query: "", // 搜索
    upd: { checking: false, downloading: false, msg: "", latest: "", current: "", notes: "", winUrl: "", downloaded: "" },
  };

  async function loadPrefs() {
    try {
      const m = await ctx.storage.get("mirrors");
      if (Array.isArray(m)) S.mirrors = m;
    } catch (e) {
      /* 首次 */
    }
  }
  async function savePrefs() {
    try {
      await ctx.storage.set("mirrors", S.mirrors);
    } catch (e) {
      /* 存不下就算了 */
    }
  }
  async function loadCache() {
    try {
      const c = await ctx.storage.get("cache");
      if (c && Array.isArray(c.plugins)) {
        S.plugins = c.plugins;
        if (c.extraMeta && typeof c.extraMeta === "object") S.extraMeta = c.extraMeta;
        S.endpointHit = c.endpointHit || "(离线缓存)";
        S.notice = "显示的是上次成功抓取的离线缓存（" + c.plugins.length + " 个插件）。点「刷新」获取最新。";
      }
    } catch (e) {
      /* 无缓存 */
    }
  }
  async function saveCache() {
    try {
      await ctx.storage.set("cache", { plugins: S.plugins, extraMeta: S.extraMeta, endpointHit: S.endpointHit });
    } catch (e) {
      /* 忽略 */
    }
  }

  // 官方索引根的补充元数据 plugins/<id>.json（version/icon/updatedAt，一插件一文件）。
  // 都走同一镜像链；失败只让该字段留空，绝不阻塞列表渲染。
  // （安装量 download-counts.json 不再使用，见 v1.2.1。）
  const INDEX_ROOT = "https://raw.githubusercontent.com/zhukunpenglinyutong/ccgui-plugins/main";
  const META_CONCURRENCY = 6;
  function metaEndpoints(rel) {
    return buildInstallerEndpoints(INDEX_ROOT + "/" + rel, { mirrorPrefixes: S.mirrors });
  }
  async function loadMarketMeta() {
    // 每插件登记：并发上限 6，失败的留空（列表照常展示）。
    const todo = S.plugins.filter((p) => !S.extraMeta[p.id]);
    let cursor = 0;
    async function worker() {
      while (cursor < todo.length) {
        const p = todo[cursor++];
        try {
          const r = await fetchFirstText(http, metaEndpoints("plugins/" + encodeURIComponent(p.id) + ".json"));
          if (r.ok) {
            const j = JSON.parse(r.text);
            S.extraMeta[p.id] = { version: str(j.version), icon: str(j.icon), updatedAt: str(j.updatedAt) };
          }
        } catch (e) {
          /* 单个失败忽略 */
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(META_CONCURRENCY, todo.length) }, worker));
  }

  // 读本机已装插件（~/.ccgui-next/plugins.json），用于列表区分「已安装 / 可更新」。
  // 失败一律静默：读不到就当作全未安装，不打断浏览。
  async function loadInstalled() {
    try {
      const j = await readPluginsJson();
      const out = {};
      const ps = (j && j.plugins) || {};
      for (const [id, v] of Object.entries(ps)) {
        if (v && v.enabled !== false && v.quarantined !== true) out[id] = str(v.version);
      }
      S.installed = out;
    } catch (e) {
      S.installed = {};
    }
  }

  async function refresh() {
    S.loading = true;
    S.error = "";
    S.notice = "";
    render();
    try {
      const eps = buildEndpoints({ mirrorPrefixes: S.mirrors });
      const r = await fetchWithFallback(http, eps);
      if (!r.ok) {
        S.errors = r.errors;
        const detail = r.errors.map((e) => prettyEndpoint(e.url) + "：" + reasonLabel(e.reason) + (e.detail ? "(" + e.detail + ")" : "")).join("；");
        S.error =
          "所有端点均失败。请检查网络，或在上方增改国内镜像前缀后重试。\n\n明细：" +
          detail;
      } else {
        S.plugins = r.data;
        S.endpointHit = r.endpoint;
        S.errors = r.errors;
        S.notice = "已从 " + prettyEndpoint(r.endpoint) + " 抓取 " + r.data.length + " 个插件。";
        // 列表到手就结束 loading（版本/图标是锦上添花，不该让整页卡在"抓取中"）。
        S.loading = false;
        render();
        S.metaLoading = true;
        Promise.all([loadMarketMeta(), loadInstalled()])
          .then(() => {
            S.metaLoading = false;
            render();
            saveCache();
          })
          .catch(() => {
            S.metaLoading = false;
            render();
          });
      }
    } catch (e) {
      S.error = String((e && e.message) || e);
    } finally {
      S.loading = false;
      render();
      // 抓取状态变了 → 让内置市场页的桥接卡按最新状态重建（若在场）。
      if (typeof document !== "undefined") {
        for (const nd of document.querySelectorAll("[data-gmm-bridge]")) nd.remove();
        scheduleInject();
      }
    }
  }

  async function doInstall(entry) {
    S.installing[entry.id] = { busy: true, msg: "下载 manifest 中…" };
    render();
    try {
      const files = {};
      const hit = [];
      // ① manifest.json 在仓库根（官方规范 §4.2）——先拿到它才知道版本号。
      const mEps = buildFileEndpoints(entry, "manifest.json", { mirrorPrefixes: S.mirrors });
      if (!mEps.length) throw new Error("无法定位 manifest.json 的下载地址（清单缺 repo/url）");
      const m = await fetchFirstText(http, mEps);
      if (!m.ok) throw new Error("manifest.json 下载失败：" + m.errors.map((e) => reasonLabel(e.reason)).join("、"));
      files["manifest.json"] = m.text;
      hit.push("manifest←" + prettyEndpoint(m.endpoint));
      let version = "";
      try {
        version = String(JSON.parse(m.text).version || "");
      } catch (e) {
        /* 解析不出版本就走 latest 兜底 */
      }
      // ② main.js / styles.css 是构建产物，只存在于 Release 附件（仓库根没有）。
      for (const fn of ["main.js", "styles.css"]) {
        S.installing[entry.id].msg = "下载 " + fn + "（Release）中…";
        render();
        const eps = buildFileEndpoints(entry, fn, { mirrorPrefixes: S.mirrors, version });
        if (!eps.length) {
          if (fn === "main.js") throw new Error("无法定位 main.js 的 Release 下载地址（清单缺 repo）");
          continue;
        }
        const r = await fetchFirstText(http, eps);
        if (!r.ok) {
          if (fn === "styles.css") continue; // 样式可选
          throw new Error(fn + " 下载失败：" + r.errors.map((e) => reasonLabel(e.reason) + "(" + (e.detail || "") + ")").join("、"));
        }
        files[fn] = r.text;
        hit.push(fn + "←" + prettyEndpoint(r.endpoint));
      }
      S.installing[entry.id].msg = "写入本地并注册中…";
      const cur = await readPluginsJson();
      const merged = buildRegistrationPatch(cur, sanitizeId(entry.id), { ...entry, version: version || entry.version });
      const out = await installPlugin(entry, files, merged);
      S.installing[entry.id] = {
        busy: false,
        msg: "✅ 已安装到 " + out.replace(/^OK\|/, "") + "。" + (hit.join("，") || "") +
          " 若未即时生效，请重启/重载 CC GUI 以加载新插件。",
      };
      await loadInstalled();
      render();
    } catch (e) {
      S.installing[entry.id] = { busy: false, msg: "❌ " + String((e && e.message) || e) };
    }
    render();
  }

  // ── 客户端更新（替宿主那个被封的 updater 检查 + 经镜像下载安装包）──────
  // 说明：宿主的 Tauri updater 端点焊死在 Rust 里（直连 github.com，本机必超时），
  // 插件改不了它；这里做的是"镜像代查代下"——把 setup.exe 下到
  // ~/.ccgui-next/downloads/ 后由用户手动双击安装。minisign 签名校验无法在插件内
  // 复现（本机无 minisign），但安装包本身带开发者 Authenticode 签名，双击时
  // Windows 会校验；下载全程走 https 镜像。
  async function checkUpdate(auto) {
    S.upd.checking = true;
    if (!auto) S.upd.msg = "检查中…";
    render();
    try {
      const eps = buildUpdaterEndpoints({ mirrorPrefixes: S.mirrors });
      const r = await fetchFirstText(http, eps);
      if (!r.ok) throw new Error("latest.json 所有端点失败：" + r.errors.map((e) => reasonLabel(e.reason)).join("、"));
      let json;
      try {
        json = JSON.parse(r.text);
      } catch (e) {
        throw new Error("latest.json 解析失败");
      }
      const p = parseLatestJson(json);
      if (!p.ok) throw new Error(p.error);
      S.upd.latest = p.version;
      S.upd.notes = p.notes;
      S.upd.winUrl = p.winUrl;
      const cur = (ctx.host && ctx.host.appVersion) || "";
      S.upd.current = cur;
      const cmp = cur ? compareVersions(cur, p.version) : -1; // 拿不到当前版本时保守视为可更新
      S.upd.msg =
        cmp < 0
          ? "发现新版本 v" + p.version + (cur ? "（当前 v" + cur + "）" : "")
          : "已是最新版本 v" + p.version + "（当前 v" + cur + "）";
      S.upd.hasUpdate = cmp < 0;
    } catch (e) {
      S.upd.msg = "❌ " + String((e && e.message) || e);
      S.upd.hasUpdate = false;
    } finally {
      S.upd.checking = false;
      render();
    }
  }

  // 单个端点一次 exec 调用（各自 120s 超时），curl -C - 断点续传，
  // 一个镜像没喂完就换下一个接着续，直到 curl 退出码 0（完整）。
  async function downloadInstaller() {
    if (!S.upd.winUrl) return;
    const fname = installerFileName(S.upd.winUrl);
    const eps = buildInstallerEndpoints(S.upd.winUrl, { mirrorPrefixes: S.mirrors });
    S.upd.downloading = true;
    S.upd.msg = "下载 " + fname + " 中（断点续传，逐镜像尝试）…";
    render();
    const script =
      PS_UTF8 +
      "$ErrorActionPreference='Stop'; " +
      "$dir=Join-Path $env:USERPROFILE '.ccgui-next\\downloads'; " +
      "New-Item -ItemType Directory -Force -Path $dir | Out-Null; " +
      "$out=Join-Path $dir $env:CCGUI_FNAME; " +
      "$curl=Join-Path $env:SystemRoot 'System32\\curl.exe'; " +
      "& $curl -sS -L --retry 3 --retry-delay 2 --connect-timeout 10 -C - -o $out $env:CCGUI_URL; " +
      "if($LASTEXITCODE -ne 0){ throw ('curl exit '+$LASTEXITCODE) }; " +
      "'DONE|'+(Get-Item $out).Length";
    let lastErr = "";
    for (let i = 0; i < eps.length; i++) {
      S.upd.msg = "下载中…（第 " + (i + 1) + "/" + eps.length + " 个端点，已下部分会续传）";
      render();
      try {
        const out = await rawRunWin(script, { CCGUI_URL: eps[i], CCGUI_FNAME: fname });
        const size = Number(String(out).split("|")[1]) || 0;
        S.upd.downloading = false;
        S.upd.downloaded = "~/.ccgui-next/downloads/" + fname + "（" + (size / 1048576).toFixed(1) + " MB）";
        S.upd.msg = "✅ 安装包已下载。请双击运行完成升级；升级后本插件需在新版本里重新安装一次。";
        render();
        return;
      } catch (e) {
        lastErr = String((e && e.message) || e);
      }
    }
    S.upd.downloading = false;
    S.upd.msg = "❌ 所有端点都没下完（最后错误：" + lastErr + "）。已下载部分保留，可再点重试续传。";
    render();
  }

  // 下载专用 exec：120s 超时（与官方插件同档），走已探明的执行器转发。
  async function rawRunWin(script, env) {
    const w = await pickExec();
    if (w.kind === "ps") {
      return rawRunTimeout(w.bin, ["-NoProfile", "-NonInteractive", "-EncodedCommand", b64u16(script)], env, 120000);
    }
    const b64 = b64u16(script);
    if (w.kind === "cmd") {
      return rawRunTimeout(w.bin, ["/c", "%SystemRoot%" + PS_FWD + " -NoProfile -NonInteractive -EncodedCommand " + b64], env, 120000);
    }
    return rawRunTimeout(w.bin, ["-e", NODE_LAUNCHER], { ...(env || {}), CCGUI_PSB64: b64 }, 120000);
  }
  async function rawRunTimeout(bin, args, env, timeoutMs) {
    const r = await ctx.bridge.invoke("plugin_exec_run", { bin, args, env: env || {}, timeoutMs });
    if (r && r.code !== 0) throw new Error(((r.stderr || "") + "").trim() || "退出码 " + (r && r.code));
    return (r && r.stdout) || "";
  }

  // ── DOM 小工具 ──────────────────────────────────────────────────────
  function el(tag, cls, txt) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (txt != null) n.textContent = txt;
    return n;
  }
  function reasonLabel(r) {
    return { network: "网络/超时", status: "状态码", json: "JSON 解析", shape: "结构不符", "no-response": "无响应" }[r] || r;
  }
  function prettyEndpoint(u) {
    if (!u) return "—";
    if (u === PRIMARY_URL) return "主地址 raw";
    if (u === FALLBACK_URL) return "备用 JsDelivr";
    if (/ghproxy|gh-proxy/.test(u)) return "镜像 " + u.split("/")[2];
    return u.replace(/^https:\/\//, "").slice(0, 40);
  }
  // 与宿主同风格：中性 token + 深浅色自动翻转，禁用写死 hex。
  const T = {
    btn: "select-none whitespace-nowrap cursor-pointer rounded-md px-2.5 py-1 text-xs border border-neutral-500/30 hover:bg-neutral-500/15 disabled:opacity-50 disabled:cursor-not-allowed",
    btnPrimary: "select-none whitespace-nowrap cursor-pointer rounded-md px-3 py-1 text-xs font-medium bg-blue-600 text-white hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed",
    chip: "select-none cursor-pointer rounded-full px-3 py-1 text-xs whitespace-nowrap",
    chipOn: "bg-neutral-500/25 text-neutral-900 dark:text-neutral-50 font-medium",
    chipOff: "text-neutral-500 dark:text-neutral-400 hover:bg-neutral-500/10",
    muted: "text-neutral-500 dark:text-neutral-400",
  };
  const BTN = T.btn;

  // ── 渲染 ────────────────────────────────────────────────────────────
  let host = null;
  function render() {
    if (!host) return;
    host.textContent = "";
    host.appendChild(renderBody());
  }

  function renderBody() {
    const wrap = el("div", "gm-root flex flex-col h-full w-full text-neutral-800 dark:text-neutral-100");
    wrap.style.height = "100%";
    wrap.style.minHeight = "0";

    wrap.appendChild(renderHeader());
    wrap.appendChild(renderTabs());
    wrap.appendChild(renderToolbar());

    if (S.error) {
      const err = el("div", "mx-4 mt-2 px-3 py-2 rounded-md text-xs bg-red-500/15 text-red-600 dark:text-red-400 whitespace-pre-wrap break-words", S.error);
      wrap.appendChild(err);
    }
    if (S.notice)
      wrap.appendChild(el("div", "mx-4 mt-2 px-3 py-2 rounded-md text-[11px] leading-snug bg-amber-500/10 text-amber-700 dark:text-amber-400", S.notice));

    wrap.appendChild(renderList());
    return wrap;
  }

  // 头部：标题 + 命中端点 + 右侧操作区（设置开关 / 刷新）。
  function renderHeader() {
    const head = el("div", "px-4 pt-3 pb-2 flex items-center gap-3");
    const title = el("span", "text-base font-semibold", "社区插件市场");
    head.appendChild(title);
    const ep = el("span", "flex-1 truncate text-[11px] " + T.muted, S.endpointHit ? "命中：" + prettyEndpoint(S.endpointHit) : "尚未抓取");
    ep.title = S.endpointHit || "";
    head.appendChild(ep);
    const gear = el("button", T.btn + " flex items-center gap-1", (S.showSettings ? "收起设置" : "设置"));
    gear.type = "button";
    gear.onclick = () => {
      S.showSettings = !S.showSettings;
      render();
    };
    head.appendChild(gear);
    const rf = el("button", T.btn, S.loading ? "抓取中…" : S.metaLoading ? "补全中…" : "刷新");
    rf.type = "button";
    rf.disabled = S.loading;
    rf.onclick = refresh;
    head.appendChild(rf);
    return head;
  }

  // 分类页签条：全部 28 · 开发工具 6 · …（计数按当前数据实时算）
  function renderTabs() {
    const bar = el("div", "px-4 pb-2 flex items-center gap-4 overflow-x-auto border-b border-neutral-500/15");
    const mergedAll = mergeMarketData(S.plugins, S.extraMeta);
    for (const c of CATEGORIES) {
      const n = c.key === "all" ? mergedAll.length : mergedAll.filter((p) => p.category === c.key).length;
      const on = S.cat === c.key;
      const chip = el("button", T.chip + " " + (on ? T.chipOn : T.chipOff), c.label + (n ? " " + n : ""));
      chip.type = "button";
      chip.onclick = () => {
        S.cat = c.key;
        S.expandedId = "";
        render();
      };
      bar.appendChild(chip);
    }
    return bar;
  }

  // 工具条：排序下拉 + 搜索框（与官方市场同位置）。
  function renderToolbar() {
    const bar = el("div", "px-4 py-2 flex items-center gap-2");
    const sort = el("select", "cursor-pointer rounded-md px-2 py-1 text-xs border border-neutral-500/30 bg-transparent outline-none");
    for (const [v, label] of [["relevance", "综合排序"], ["name", "名称"], ["version", "版本"]]) {
      const o = el("option", "", label);
      o.value = v;
      if (S.sort === v) o.selected = true;
      sort.appendChild(o);
    }
    sort.onchange = () => {
      S.sort = sort.value;
      render();
    };
    bar.appendChild(sort);

    const search = el("input", "flex-1 max-w-xs ml-auto px-2.5 py-1 text-xs rounded-md border border-neutral-500/30 bg-transparent outline-none placeholder:text-neutral-500");
    search.type = "text";
    search.spellcheck = false;
    search.placeholder = "搜索插件...";
    search.value = S.query;
    search.oninput = () => {
      S.query = search.value;
      render();
    };
    bar.appendChild(search);

    if (S.showSettings) {
      const settings = el("div", "px-4 pb-2 space-y-2");
      settings.appendChild(renderMirrors());
      settings.appendChild(renderUpdate());
      bar.appendChild(settings);
      bar.className += " flex-wrap";
    }
    return bar;
  }

  // 当前分类 + 搜索命中的条目（已排序）。展示前统一合并安装量/图标/分类。
  function filtered(extra) {
    if (extra === null) return [];
    const q = str(extra).trim().toLowerCase();
    const merged = mergeMarketData(S.plugins, S.extraMeta);
    return merged.filter((p) => {
      if (S.cat !== "all" && (p.category || categoryOf(p)) !== S.cat) return false;
      if (!q) return true;
      return [p.name, p.description, p.author, p.id].filter(Boolean).join(" ").toLowerCase().indexOf(q) !== -1;
    });
  }

  function renderList() {
    const box = el("div", "flex-1 overflow-auto px-4 pb-4");
    if (S.loading && !S.plugins.length) {
      box.appendChild(el("div", "p-6 text-sm " + T.muted, "抓取中（主 → 备用 → 镜像 依次尝试）…"));
      return box;
    }
    const rows = sortPlugins(filtered(S.query), S.sort);
    if (!S.plugins.length) {
      box.appendChild(el("div", "p-6 text-sm " + T.muted, "暂无插件。点右上「刷新」。"));
      return box;
    }

    // 圆角列表容器（与官方市场同款：外框大圆角 + 行间细分隔线，无卡片阴影）
    const table = el("div", "w-full rounded-xl border border-neutral-500/20 overflow-hidden");
    const COLS = "minmax(0,1fr) 140px 96px 168px";
    const head = el("div", "grid items-center gap-3 px-4 py-2.5 text-[11px] font-medium " + T.muted);
    head.style.gridTemplateColumns = COLS;
    ["名称", "开发者", "版本", "操作"].forEach((t) => {
      const cell = el("div", t === "操作" ? "text-right" : "", t);
      head.appendChild(cell);
    });
    table.appendChild(head);
    table.appendChild(el("div", "h-px bg-neutral-500/20"));

    if (!rows.length) {
      box.appendChild(el("div", "p-6 text-sm " + T.muted, "没有匹配的插件。"));
      return box;
    }
    rows.forEach((p, i) => {
      const row = renderRow(p);
      // 行间细分隔线（首行不画，避免与外框重叠成双线）
      if (i > 0) row.classList.add("border-t", "border-neutral-500/10");
      table.appendChild(row);
    });
    box.appendChild(table);
    return box;
  }

  // 一个插件行：图标瓷砖 + 名称/描述 | 开发者 | 版本 | 操作
  function renderRow(p) {
    const frag = el("div", "");
    const row = el("div", "grid items-center gap-3 px-4 py-3 hover:bg-neutral-500/[0.07] transition-colors");
    row.style.gridTemplateColumns = "minmax(0,1fr) 140px 96px 168px";

    // ── 名称列：图标瓷砖 + 标题/描述
    const nameCell = el("div", "flex items-center gap-3 min-w-0");
    nameCell.appendChild(renderTile(p));
    const txt = el("div", "min-w-0 flex-1");
    txt.appendChild(el("div", "text-[13px] leading-tight font-medium truncate", p.name || p.id));
    if (p.description) txt.appendChild(el("div", "mt-0.5 text-[11px] leading-snug truncate " + T.muted, p.description));
    nameCell.appendChild(txt);
    row.appendChild(nameCell);

    // ── 开发者（官方插件给紫色徽章）
    const authorCell = el("div", "min-w-0");
    const official = /^(zhukunpenglinyutong|ccgui)$/i.test(str(p.author));
    const badge = el(
      "span",
      "inline-block max-w-full truncate rounded px-1.5 py-0.5 text-[11px] " +
        (official ? "bg-purple-500/15 text-purple-600 dark:text-purple-300" : T.muted),
      official ? "CCGUI官方插件" : str(p.author) || "—",
    );
    badge.title = str(p.author) || "";
    authorCell.appendChild(badge);
    row.appendChild(authorCell);

    // ── 版本
    row.appendChild(el("div", "text-xs tabular-nums " + (p.version ? "text-neutral-600 dark:text-neutral-300" : T.muted), p.version ? "v" + p.version : "—"));

    // ── 操作：已安装 → 灰底 ✓ 已安装（药丸态，与官方一致）；可更新 → 更新按钮
    const inst = S.installing[p.id];
    const ops = el("div", "flex items-center justify-end gap-1.5 shrink-0");
    const localVer = S.installed[p.id];
    const isInstalled = localVer !== undefined;
    const canUpdate = isInstalled && p.version && compareVersions(localVer || "0", p.version) < 0;

    if (inst && inst.busy) {
      const b = el("button", T.btnPrimary, "安装中…");
      b.type = "button";
      b.disabled = true;
      ops.appendChild(b);
    } else if (isInstalled && !canUpdate) {
      const pill = el(
        "span",
        "select-none shrink-0 whitespace-nowrap inline-flex items-center gap-1 rounded-md px-2.5 py-1 text-xs bg-neutral-500/15 text-neutral-600 dark:text-neutral-300",
        "✓ 已安装",
      );
      pill.title = localVer ? "已安装 v" + localVer : "已安装";
      ops.appendChild(pill);
    } else {
      const btn = el("button", T.btnPrimary, canUpdate ? "更新" : "安装");
      btn.type = "button";
      if (canUpdate) btn.title = "已装 v" + localVer + " → v" + p.version;
      btn.onclick = () => doInstall(p);
      ops.appendChild(btn);
    }

    const exp = el("button", T.btn, S.expandedId === p.id ? "收起" : "详情");
    exp.type = "button";
    exp.onclick = () => {
      S.expandedId = S.expandedId === p.id ? "" : p.id;
      render();
    };
    ops.appendChild(exp);
    row.appendChild(ops);
    frag.appendChild(row);

    if (inst && inst.msg) {
      const cls = inst.msg.startsWith("✅")
        ? "text-green-600 dark:text-green-400"
        : inst.msg.startsWith("❌")
          ? "text-red-600 dark:text-red-400"
          : T.muted;
      frag.appendChild(el("div", "px-4 pb-2 text-[11px] leading-snug " + cls, inst.msg));
    }
    if (S.expandedId === p.id) frag.appendChild(renderDetail(p));
    return frag;
  }

  // 图标瓷砖：优先用真实 icon（仓库默认分支上的相对路径），否则用 id 恒定配色 + 首字。
  function renderTile(p) {
    const tile = el("div", "shrink-0 flex items-center justify-center rounded-lg text-white text-[13px] font-semibold overflow-hidden");
    tile.style.width = "32px";
    tile.style.height = "32px";
    tile.style.background = tileGradient(p.id);
    const src = iconUrl(p);
    if (src) {
      const img = el("img", "w-full h-full object-cover");
      img.src = src;
      img.alt = "";
      img.onerror = () => {
        img.remove();
      };
      tile.appendChild(img);
    }
    tile.appendChild(el("span", "", initials(p)));
    // 图片加载成功后隐藏首字母
    const imgEl = tile.querySelector("img");
    if (imgEl) imgEl.onload = () => {
      const s = tile.querySelector("span");
      if (s) s.style.display = "none";
    };
    return tile;
  }

  // 由 repo + 登记里的 icon 相对路径拼出可访问的图标地址（默认分支，官方约定）。
  function iconUrl(p) {
    const icon = str(p.icon);
    if (!icon) return "";
    if (/^https?:\/\//i.test(icon)) return icon;
    const rp = parseRepo(p.repo);
    if (!rp) return "";
    const base = "https://raw.githubusercontent.com/" + rp.owner + "/" + rp.name + "/" + (rp.ref || "main") + "/" + icon.replace(/^\.?\//, "");
    const mirror = S.mirrors[0];
    return mirror ? mirror.replace(/\/$/, "") + "/" + base : base;
  }

  function renderMirrors() {
    const bar = el("div", "flex items-center gap-2");
    bar.appendChild(el("span", "shrink-0 text-[11px] " + T.muted, "镜像前缀"));
    const input = el("input", "flex-1 px-2 py-1 text-xs rounded-md border border-neutral-500/30 bg-transparent outline-none");
    input.type = "text";
    input.spellcheck = false;
    input.placeholder = "逗号分隔，如 https://ghproxy.net/,https://gh-proxy.com/";
    input.value = S.mirrors.join(",");
    input.onchange = () => {
      S.mirrors = input.value.split(",").map((s) => s.trim()).filter(Boolean);
      savePrefs();
      refresh();
    };
    bar.appendChild(input);
    const clr = el("button", BTN, "恢复默认");
    clr.type = "button";
    clr.onclick = () => {
      S.mirrors = DEFAULT_MIRROR_PREFIXES.slice();
      savePrefs();
      render();
    };
    bar.appendChild(clr);
    return bar;
  }

  function renderUpdate() {
    const box = el("div", "flex items-center gap-2 flex-wrap");
    box.appendChild(el("span", "text-[11px] " + T.muted, "客户端更新"));
    const cur = (ctx.host && ctx.host.appVersion) || "";
    if (cur) box.appendChild(el("span", "text-[11px] " + T.muted, "当前 v" + cur));
    const chk = el("button", BTN, S.upd.checking ? "检查中…" : "检查更新");
    chk.type = "button";
    chk.disabled = S.upd.checking || S.upd.downloading;
    chk.onclick = () => checkUpdate(false);
    box.appendChild(chk);
    if (S.upd.hasUpdate) {
      const dl = el("button", T.btnPrimary, S.upd.downloading ? "下载中…" : "下载 v" + S.upd.latest);
      dl.type = "button";
      dl.disabled = S.upd.downloading;
      dl.onclick = downloadInstaller;
      box.appendChild(dl);
    }
    if (S.upd.msg) {
      const cls = S.upd.msg.startsWith("✅")
        ? "text-green-600 dark:text-green-400"
        : S.upd.msg.startsWith("❌")
          ? "text-red-600 dark:text-red-400"
          : T.muted;
      box.appendChild(el("span", "text-[11px] " + cls, S.upd.msg));
    }
    if (S.upd.downloaded) box.appendChild(el("span", "text-[11px] break-all " + T.muted, "位置：" + S.upd.downloaded));
    if (S.upd.hasUpdate && S.upd.notes) {
      const n = el("details", "basis-full text-[11px] " + T.muted);
      n.appendChild(el("summary", "cursor-pointer select-none", "查看 v" + S.upd.latest + " 更新日志"));
      n.appendChild(el("pre", "mt-1 whitespace-pre-wrap break-words font-sans max-h-40 overflow-auto", S.upd.notes));
      box.appendChild(n);
    }
    return box;
  }

  function renderDetail(p) {
    const box = el("div", "mx-3 mb-3 px-3 py-2 rounded-md border border-neutral-500/20 space-y-1 bg-neutral-500/[0.04]");
    box.appendChild(kv("ID", p.id));
    box.appendChild(kv("仓库", p.repo ? "github.com/" + p.repo : "—"));
    if (p.updatedAt) box.appendChild(kv("更新时间", p.updatedAt));
    const eps = buildFileEndpoints(p, "manifest.json", { mirrorPrefixes: S.mirrors });
    box.appendChild(el("div", "text-[11px] " + T.muted, "manifest 下载回退链："));
    const ol = el("ol", "pl-5 text-[11px] " + T.muted + " list-decimal");
    for (const u of eps) ol.appendChild(el("li", "break-all", u));
    if (!eps.length) ol.appendChild(el("li", "", "（无法定位：清单缺 repo/url）"));
    box.appendChild(ol);
    if (p.repo) {
      const rp = parseRepo(p.repo);
      const repoUrl = rp ? "https://github.com/" + rp.owner + "/" + rp.name : p.repo;
      const cp = el("button", BTN, "复制仓库地址");
      cp.type = "button";
      cp.onclick = async () => {
        try {
          await navigator.clipboard.writeText(repoUrl);
          cp.textContent = "已复制 ✓";
        } catch (e) {
          cp.textContent = "复制失败，手动看下方";
        }
        setTimeout(() => (cp.textContent = "复制仓库地址"), 1500);
      };
      box.appendChild(cp);
      box.appendChild(el("div", "text-[11px] break-all " + T.muted, repoUrl));
    }
    return box;
  }

  function kv(k, v) {
    const row = el("div", "flex gap-2 text-[11px]");
    row.appendChild(el("span", "shrink-0 " + T.muted, k + "："));
    row.appendChild(el("span", "break-all text-neutral-700 dark:text-neutral-200", v));
    return row;
  }

  // ── 挂载 ────────────────────────────────────────────────────────────
  function Panel() {
    const ref = h.useRef(null);
    h.useEffect(() => {
      host = ref.current;
      // 先立即画一帧（不依赖任何异步），避免 storage 慢/被拒时整块空白。
      render();
      (async () => {
        await loadPrefs();
        await loadCache();
        render();
        // 已装列表：有缓存也照样读一次（缓存里没带 installed，且它很便宜）。
        loadInstalled().then(render).catch(() => {});
        if (!S.plugins.length) {
          refresh();
        } else if (S.plugins.some((p) => !S.extraMeta[p.id])) {
          // 有缓存先画一帧，后台补版本/图标（不阻塞浏览）
          S.metaLoading = true;
          loadMarketMeta()
            .then(() => {
              S.metaLoading = false;
              render();
              saveCache();
            })
            .catch(() => {
              S.metaLoading = false;
              render();
            });
        }
        if (!S.upd.latest) checkUpdate(true); // 静默检查一次客户端更新
      })();
      return () => {
        host = null;
      };
    }, []);
    return h.createElement("div", { ref, className: "h-full w-full", style: { height: "100%", minHeight: 0 } });
  }

  // 页签/导航图标：书签样式 SVG，与宿主内置图标同风格（currentColor 描边）。
  function Icon({ className }) {
    return h.createElement(
      "svg",
      {
        viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2",
        strokeLinecap: "round", strokeLinejoin: "round", width: "16", height: "16",
        className, "aria-hidden": true,
      },
      h.createElement("path", { d: "M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" }),
    );
  }

  const disposers = [];
  function reg(fn, def) {
    if (typeof fn !== "function") return;
    try {
      const d = fn.call(ctx.ui, def);
      if (typeof d === "function") disposers.push(d);
    } catch (e) {
      /* 该扩展点在本宿主版本不可用：跳过，不影响其余注册 */
    }
  }

  // 主展示面：中心页签（与官方 service-status 同款，入口最显眼）。
  reg(ctx.ui.registerCenterTab, {
    key: "github-mirror-marketplace",
    title: () => "社区市场",
    icon: Icon,
    component: Panel,
  });
  // 侧边栏导航行：点开中心页签。
  reg(ctx.ui.registerSidebarNav, {
    key: "github-mirror-marketplace",
    label: () => "社区市场",
    icon: Icon,
    order: 90,
    onOpen: () => {
      if (typeof ctx.ui.openCenterTab === "function") ctx.ui.openCenterTab("github-mirror-marketplace");
    },
  });
  // 注：不注册右侧面板页签（registerPanelTab）——它与中心页签内容重复，
  // 只是多占一份界面位置。市场入口统一走「中心页签 + 侧边栏 + ⌘K 命令」。
  // 命令面板（⌘K）一条"刷新社区市场"，便于不切页签也能拉一次。
  reg(ctx.ui.registerCommand, {
    key: "github-mirror-marketplace.refresh",
    title: () => "社区市场：刷新插件索引",
    keywords: () => ["marketplace", "市场", "插件", "github", "镜像"],
    run: () => {
      if (typeof ctx.ui.openCenterTab === "function") ctx.ui.openCenterTab("github-mirror-marketplace");
      refresh();
    },
  });

  // ── A：内置市场页桥接卡（融合引导，受配置开关控制，默认关）──────────────
  // 官方规范 §5 明写"抓宿主 DOM 是拒审理由"，故默认关闭：关闭时本插件完全不
  // 触碰宿主界面，只有用户在设置页显式开启（config.bridgeCardEnabled=true）才
  // 启用。开关值走 ctx.storage 的 "config.<key>"（与官方 auto-title 同款约定）。
  // 开启后：内置市场页加载失败时（红字"市场加载失败…"/空置"市场暂时没有插件"），
  // 在失败横幅下方注入引导卡：显示镜像链抓取状态 + 一键跳到「社区市场」。
  // MutationObserver + 稳定中文文案锚点（不用 class），data-gmm-bridge 幂等标记，
  // dispose 时断开观察器并移除全部注入节点，不留残留。
  const MARKET_MARKERS = ["市场加载失败", "市场暂时没有插件"];
  let bridgeOn = false; // 由 loadBridgePref() 决定
  let injectTimer = 0;
  function scheduleInject() {
    if (!bridgeOn || injectTimer) return;
    injectTimer = setTimeout(() => {
      injectTimer = 0;
      tryInject();
    }, 300);
  }
  // 从标记文本节点爬到"横幅行"：最多 4 层，且要求祖先【矮】（≤160px）且正文短
  // （≤400 字）。高度钳制是关键——空态页的居中大容器正文也短，只按文字长度爬
  // 会一路爬到整页 wrapper，卡片就悬浮在半空（v1.0.8 实测翻车点）。
  function rowFor(node) {
    let cur = node;
    for (let i = 0; i < 4; i++) {
      const par = cur.parentElement;
      if (!par || par === document.body || par.closest("[data-gmm-bridge]")) break;
      if ((par.textContent || "").trim().length > 400) break;
      let h = 0;
      try {
        h = par.getBoundingClientRect().height;
      } catch (e) {
        h = 0;
      }
      if (h > 160) break;
      cur = par;
    }
    return cur;
  }
  function buildBridgeCard() {
    const card = el(
      "div",
      "mt-2 mx-1 px-3 py-2.5 rounded-lg border border-orange-500/40 bg-orange-500/10 flex items-center gap-3 flex-wrap",
    );
    card.dataset.gmmBridge = "1";
    const txt = el("div", "flex-1 min-w-0 text-xs leading-snug text-neutral-700 dark:text-neutral-200");
    if (S.plugins.length) {
      txt.textContent =
        "GitHub 直连被网络拦截了。本插件的镜像加速链已抓到 " + S.plugins.length +
        " 个社区插件（命中：" + prettyEndpoint(S.endpointHit) + "）。";
    } else if (S.loading) {
      txt.textContent = "GitHub 直连被拦截。镜像加速链正在后台抓取社区插件索引…";
    } else {
      txt.textContent = "GitHub 直连被拦截。「社区市场」可用镜像链（ghproxy→JsDelivr→raw）抓取并一键安装社区插件。";
    }
    card.appendChild(txt);
    const go = el("button", BTN + " border-orange-500/60 text-orange-600 dark:text-orange-400", "前往社区市场 →");
    go.type = "button";
    go.onclick = () => {
      if (typeof ctx.ui.openCenterTab === "function") ctx.ui.openCenterTab("github-mirror-marketplace");
      if (!S.plugins.length && !S.loading) refresh();
    };
    card.appendChild(go);
    return card;
  }
  function tryInject() {
    if (typeof document === "undefined" || !document.body) return;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const rows = new Set();
    let n;
    while ((n = walker.nextNode())) {
      const v = n.nodeValue || "";
      if (!MARKET_MARKERS.some((m) => v.indexOf(m) !== -1)) continue;
      const p = n.parentElement;
      if (!p || p.closest("[data-gmm-bridge]")) continue; // 别在自家卡里找
      rows.add(rowFor(p));
    }
    for (const row of rows) {
      if (row.nextElementSibling && row.nextElementSibling.dataset && row.nextElementSibling.dataset.gmmBridge) continue;
      if (row.querySelector("[data-gmm-bridge]")) continue;
      row.after(buildBridgeCard());
    }
  }
  let bridgeObserver = null;
  function armBridge() {
    if (bridgeObserver || typeof document === "undefined" || !document.body) return;
    bridgeObserver = new MutationObserver(scheduleInject);
    bridgeObserver.observe(document.body, { childList: true, subtree: true, characterData: true });
    scheduleInject();
  }
  function disarmBridge() {
    if (bridgeObserver) {
      bridgeObserver.disconnect();
      bridgeObserver = null;
    }
    if (injectTimer) {
      clearTimeout(injectTimer);
      injectTimer = 0;
    }
    if (typeof document !== "undefined") {
      for (const nd of document.querySelectorAll("[data-gmm-bridge]")) nd.remove();
    }
  }
  // 读 config.bridgeCardEnabled（默认关），据此决定是否武装 DOM 监听。fire-and-forget。
  (async () => {
    try {
      const v = await ctx.storage.get("config.bridgeCardEnabled");
      bridgeOn = v === true; // 严格 true 才开；缺省/null/其它一律关
    } catch (e) {
      bridgeOn = false;
    }
    if (bridgeOn) armBridge();
  })();

  return () => {
    disarmBridge();
    for (const d of disposers) {
      try {
        d();
      } catch (e) {
        /* 单个 dispose 失败不影响其余 */
      }
    }
    host = null;
  };
}
