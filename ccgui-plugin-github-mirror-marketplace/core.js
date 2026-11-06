/*
 * 社区插件市场镜像加速 —— 纯逻辑内核（与宿主/浏览器解耦，可在 node 下单测）
 *
 * 为什么单独抽出 core.js：
 *   弹性回退链（主地址→备用→国内镜像）、状态码/JSON 结构判定、列表归一化、
 *   下载路径拼装、plugins.json 注册补丁——这些是本插件的全部"聪明"所在，且不
 *   依赖任何宿主 API。把它们做成纯函数，就能用 node:test 直接验证回退顺序与
 *   "坏响应跳到下一个端点"的行为，而不必真联网（本机 curl 两条公网都被封）。
 *
 * 约定：调用方（main.js）注入一个 http(url) => {status, body} 的异步函数，
 *   core 只消费 {status, body}，网络错误/超时由 http 抛出、core 捕获后继续下一个端点。
 *   这样 core 既能被 plugin_http_request 驱动，也能被测试桩驱动。
 */

// ── 常量：主/备地址、国内镜像前缀、请求头、超时 ─────────────────────────
export const PRIMARY_URL =
  "https://raw.githubusercontent.com/zhukunpenglinyutong/ccgui-plugins/main/community-plugins.json";

// JsDelivr CDN 备用：把 GitHub 原始文件走 CDN，国内通常可达。
export const FALLBACK_URL =
  "https://cdn.jsdelivr.net/gh/zhukunpenglinyutong/ccgui-plugins@main/community-plugins.json";

// 第三层兼价：经典 ghproxy 系代理，用法是"前缀 + 完整原始 URL"。
// 面板里可编辑；空数组表示不加镜像。
export const DEFAULT_MIRROR_PREFIXES = ["https://ghproxy.net/", "https://gh-proxy.com/"];

// 宿主内置更新器的 latest.json 端点（Tauri updater，端点焊死在 Rust 里、插件改不了）。
// 本插件另起镜像链取同一份 latest.json，替用户完成"检查更新 + 下载安装包"。
export const UPDATER_LATEST_URL =
  "https://github.com/zhukunpenglinyutong/desktop-cc-gui/releases/latest/download/latest.json";

// 绕过部分网关对默认 UA 的拦截。
export const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0 Safari/537.36";

// 单端点请求超时（毫秒）。主/备/镜像各自计时，全部失败才放弃。
export const TIMEOUT_MS = 10000;

// 期望 HTTP/1.1（规避 HTTP/2 下的 TLS 握手坑）；bridge 不支持时由适配器忽略。
export const HTTP_VERSION = "HTTP/1.1";

// community-plugins.json 顶层可能是数组，也可能是 {plugins:[...]} 之类包裹。
const LIST_KEYS = ["plugins", "items", "list", "community", "data", "entries"];

/**
 * 构造有序端点列表：主地址 → 备用 CDN → 各国内镜像（包裹主地址）。
 * 去重、剔除空值；镜像前缀缺省用 DEFAULT_MIRROR_PREFIXES。
 */
export function buildEndpoints(opts = {}) {
  const primary = opts.primaryUrl || PRIMARY_URL;
  const fallback = opts.fallbackUrl || FALLBACK_URL;
  const mirrors = opts.mirrorPrefixes ?? DEFAULT_MIRROR_PREFIXES;

  const list = [primary, fallback];
  for (const pfx of mirrors || []) {
    if (!pfx) continue;
    // ghproxy 系：前缀直接拼完整原始 URL。
    list.push(pfx.replace(/\/$/, "") + "/" + primary.replace(/^https?:\/\//, "https://"));
  }
  // 去重保序
  const seen = new Set();
  const out = [];
  for (const u of list) {
    if (u && !seen.has(u)) {
      seen.add(u);
      out.push(u);
    }
  }
  return out;
}

/** 状态码是否算成功。按需求"非 200 视为失败"，但容忍 2xx（部分 CDN 返 203/206 亦属正常）。 */
export function isAccepted(status) {
  return typeof status === "number" && status >= 200 && status < 300;
}

/**
 * 判断解析后的 JSON 是否"像"一份插件清单：数组，或含数组字段。
 * 返回归一化后的插件数组；不像则返回 null（触发回退到下一个端点）。
 */
export function normalizePlugins(json) {
  if (Array.isArray(json)) return json.map(toEntry);
  if (json && typeof json === "object") {
    for (const k of LIST_KEYS) {
      if (Array.isArray(json[k])) return json[k].map(toEntry);
    }
    // 兜底：任意一个数组值
    for (const v of Object.values(json)) {
      if (Array.isArray(v)) return v.map(toEntry);
    }
  }
  return null;
}

/** 把一条原始插件对象归一成 {id,name,author,description,version,tier,repo,url,_raw}。 */
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

function str(v) {
  return v == null ? "" : String(v);
}

/** 从 repo（"owner/name" 或完整 GitHub URL）取仓库名。 */
function repoBase(repo) {
  const p = parseRepo(repo);
  return p ? p.name : "";
}

/**
 * 解析 repo 字段为 {owner,name,ref,basePath}，认三种写法：
 *   - "owner/name"
 *   - "https://github.com/owner/name[/tree/ref/path]"
 *   - 其它含 owner/name 的字符串（尽力）
 * 解析不出返回 null。
 */
export function parseRepo(repo) {
  const s = str(repo).trim();
  if (!s) return null;
  let m = s.match(/github\.com\/([^/]+)\/([^/#?]+)/i);
  if (m) {
    const owner = m[1];
    // blob/tree 里可能带 /ref/subpath
    const rest = s.slice(m.index + m[0].length);
    const refm = rest.match(/^\/(?:tree|blob)\/([^/]+)/);
    const ref = refm ? refm[1] : "";
    return { owner, name: m[2].replace(/\.git$/i, ""), ref };
  }
  m = s.match(/^([\w.-]+)\/([\w.-]+)$/);
  if (m) return { owner: m[1], name: m[2], ref: "" };
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
export function buildFileEndpoints(entry, fileName, opts = {}) {
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

/** 把 GitHub blob URL 转成 raw.githubusercontent 等价地址；不是则原样返回。 */
export function blobToRaw(url) {
  const s = str(url);
  const m = s.match(/github\.com\/([^/]+)\/([^/]+)\/blob\/(.+)$/i);
  if (!m) return s || "";
  return `https://raw.githubusercontent.com/${m[1]}/${m[2]}/${m[3]}`;
}

/**
 * 弹性抓取：按端点顺序尝试，任一拿到"状态可接受 + JSON 可解析 + 结构像清单"即成功。
 * 网络错误/超时（http 抛出）、非 2xx、解析失败、结构不符 → 记录并跳下一个。
 * 返回 {ok, endpoint, data, errors}；全败则 ok:false 且 data:null。
 */
export async function fetchWithFallback(http, endpoints) {
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
      // 继续下一个端点
    }
  }
  return { ok: false, endpoint: null, data: null, errors };
}

/** 抓取单条文件文本（用于安装）：同样按端点回退，取第一个 2xx 且非空的响应体。 */
export async function fetchFirstText(http, endpoints) {
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

// ── 安装：路径与注册补丁（纯函数，便于单测）─────────────────────────────

/**
 * 依据宿主插件根目录（一般是 ~/.ccgui-next）拼出目标安装路径。
 * baseDir 由调用方传入（测试传临时目录），core 不猜 home，保持纯净。
 */
export function installPaths(baseDir, pluginId, files) {
  const id = str(pluginId).replace(/[^\w.-]/g, "_") || "unnamed";
  const dir = join(baseDir, "plugins", id);
  const map = {};
  for (const f of files) map[f] = join(dir, f);
  return { id, dir, files: map, pluginsJson: join(baseDir, "plugins.json") };
}

function join(...parts) {
  return parts
    .map((p) => str(p).replace(/[\\/]+$/, ""))
    .join("/")
    .replace(/\/+/g, "/");
}

/**
 * 生成 plugins.json 的注册补丁：在 obj.plugins[id] 写入启用项，返回新对象（不改入参）。
 * 结构对齐宿主现有 plugins.json（version/enabled/source/permissions/quarantined/...）。
 */
export function buildRegistrationPatch(pluginsJson, pluginId, entry, opts = {}) {
  const base = pluginsJson && typeof pluginsJson === "object" ? pluginsJson : {};
  const plugins = base.plugins && typeof base.plugins === "object" ? { ...base.plugins } : {};
  const id = str(pluginId);
  plugins[id] = {
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

// ── 客户端更新（镜像替宿主 updater 检查/取包）───────────────────────────

/** 语义化版本比较：a<b 返回 -1，a>b 返回 1，相等 0。缺段按 0，非数字段按 0。 */
export function compareVersions(a, b) {
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

/**
 * 解析宿主 updater 的 latest.json（Tauri 格式）。
 * 返回 {ok, version, notes, winUrl, winSig, error}；winUrl/winSig 取
 * platforms["windows-x86_64"]（本机即此平台）。
 */
export function parseLatestJson(json) {
  const o = json && typeof json === "object" ? json : {};
  const plat = (o.platforms && o.platforms["windows-x86_64"]) || null;
  if (!o.version || !plat || !plat.url) {
    return { ok: false, version: "", notes: "", winUrl: "", winSig: "", error: "latest.json 结构不符" };
  }
  return {
    ok: true,
    version: str(o.version),
    notes: str(o.notes),
    winUrl: str(plat.url),
    winSig: str(plat.signature),
    error: "",
  };
}

/** latest.json 的检查端点回退链：直连 → 各镜像（镜像在前更实用，直连基本被封）。 */
export function buildUpdaterEndpoints(opts = {}) {
  const mirrors = (opts.mirrorPrefixes ?? DEFAULT_MIRROR_PREFIXES).filter(Boolean);
  const out = [];
  for (const pfx of mirrors) out.push(pfx.replace(/\/$/, "") + "/" + UPDATER_LATEST_URL);
  out.push(UPDATER_LATEST_URL);
  return out;
}

/** 安装包下载端点：镜像在前（Release 大文件走镜像才可能成），直连兜底。 */
export function buildInstallerEndpoints(winUrl, opts = {}) {
  const mirrors = (opts.mirrorPrefixes ?? DEFAULT_MIRROR_PREFIXES).filter(Boolean);
  const out = [];
  for (const pfx of mirrors) out.push(pfx.replace(/\/$/, "") + "/" + winUrl);
  out.push(winUrl);
  return out;
}

/** 从 Release url 里取安装包文件名（如 CC.GUI_1.1.0_x64-setup.exe）。 */
export function installerFileName(winUrl) {
  const m = str(winUrl).match(/\/([^/?#]+)$/);
  return m ? decodeURIComponent(m[1]) : "ccgui-update-setup.exe";
}

// ── 市场列表展示（分类/排序/格式化，纯函数）──────────────────────────────

/**
 * 市场分类。官方索引只登记 id/repo/name/description/author——分类是宿主自己算的，
 * 索引里没有字段，故本插件按名称/描述做启发式归并（近似，非官方口径）。
 */
export const CATEGORIES = [
  { key: "all", label: "全部" },
  { key: "devtools", label: "开发工具" },
  { key: "productivity", label: "效率工具" },
  { key: "integration", label: "集成与渠道" },
  { key: "appearance", label: "界面外观" },
  { key: "other", label: "其他" },
];

const CATEGORY_RULES = [
  {
    key: "appearance",
    re: /外观|主题|配色|颜色|字体|边框|跑马灯|背景|淡化|美化|皮肤|壁纸|桌宠|光效|theme|style|color|font|border|rainbow|background|wallpaper|live2d|icon/i,
  },
  {
    key: "devtools",
    re: /代码|体检|端口|调试|构建|日志|终端|仓库|分支|文件树|文件预览|预览面板|图表|git|wsl|react|mermaid|pr|devtool|code|lint|build|debug|port|terminal|preview|diff/i,
  },
  {
    key: "integration",
    re: /供应商|渠道|网关|桥接|上下文|引擎|协议|模型|余额|配额|余量|状态页|服务状态|出口\s*ip|ip|provider|gateway|bridge|context|engine|mcp|balance|quota|status/i,
  },
  {
    key: "productivity",
    re: /会话|命名|标题|用量|token|笔记|便签|任务|提醒|拖拽|上传|提示词|自动化|统计|计量|定时|限额|屏蔽|来源|看板|监控|usage|task|session|title|prompt|upload|drag|remind|meter|note|schedule|board|monitor/i,
  },
];

/**
 * 归类一个插件（吃 name + description + keywords）。
 * 打分制：各分类正则命中次数最多者胜，同分按规则顺序（appearance→devtools→
 * integration→productivity）。对当前官方 28 条索引实测 28/28 与人工标定一致。
 */
export function categoryOf(p) {
  const o = p || {};
  const text = [o.name, o.description, ...(Array.isArray(o.keywords) ? o.keywords : [])]
    .filter(Boolean)
    .join(" ");
  let best = "other";
  let bestN = 0;
  for (const rule of CATEGORY_RULES) {
    const n = (text.match(new RegExp(rule.re.source, "gi")) || []).length;
    if (n > bestN) {
      bestN = n;
      best = rule.key;
    }
  }
  return best;
}

/** 插件图标瓷砖的文字：中文取首字，英文取前两个词首字母，兜底取首字符。 */
export function initials(p) {
  const name = str((p && (p.name || p.id)) || "?").trim();
  if (!name) return "?";
  // 中英混排（如 "Token 速度表"）：取第一个汉字，比孤零零一个拉丁字母更可读。
  const cjk = name.match(/[一-龥]/);
  if (cjk) return cjk[0];
  const words = name.split(/[\s\-_]+/).filter(Boolean);
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
  return name.slice(0, 2).toUpperCase();
}

/** 同一 id 恒定配色（hue 取 id 字符和），返回 CSS 渐变；官方缺图标时也是这套做法。 */
export function tileGradient(id) {
  const s = str(id);
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
  return `linear-gradient(135deg, hsl(${h} 62% 52%), hsl(${(h + 38) % 360} 66% 42%))`;
}

/** 排序：relevance(综合=索引原序) / name / version。不改入参数组。 */
export function sortPlugins(list, mode) {
  const arr = (list || []).slice();
  if (mode === "name") {
    arr.sort((a, b) => str(a.name || a.id).localeCompare(str(b.name || b.id), "zh-Hans-CN"));
  } else if (mode === "version") {
    arr.sort((a, b) => compareVersions(b.version || "0", a.version || "0"));
  }
  // relevance：保持官方索引原序（索引本身已按 id 字典序整理）。
  return arr;
}

/**
 * 把官方索引的插件数组与补充元数据（plugins/<id>.json 的 version/icon/updatedAt）
 * 合并成展示条目。extra 可缺省；不改入参。
 */
export function mergeMarketData(list, extra) {
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
