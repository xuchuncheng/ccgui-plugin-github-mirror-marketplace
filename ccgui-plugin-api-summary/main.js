// 会话 API 汇总插件（CC GUI / ccgui-next，Tier-1 JS 插件，单文件 ESM）
//
// 作用：在侧栏「会话」右键菜单里加一项「汇总API」。点击后，把一段可配置的提示词
//       送到 AI 面前，让它梳理本次会话涉及的接口，并：
//         1) 维护到当前工作空间的 docs/apis.xlsx（固定 8 列）；
//         2) 按接口在 docs/apis/<归属任务>/<接口编码>_<简要描述>.md 生成含
//            业务流程图 / 表数据流转图 / 业务时序图 / 其他标注 的文档，并自检 Mermaid。
//
// 为什么用「草稿/发起轮次」而不是插件自己写文件：
//   Tier-1 插件没有文件系统 API（只能经 exec: 授权跑外部命令），而 xlsx 落库 +
//   Mermaid 校验本质是「读懂这段对话再产出文档」的活——交给带完整上下文的 AI 来做
//   最可靠。两种送达方式：
//     · draft（默认）：先切到该会话，再把提示词写进输入框草稿。用户回车即发送，
//       AI 带着这轮会话的完整历史来汇总，最准确。
//     · run：直接起一个宿主可见的聊天轮次（可随时停止/接管）。
//
// 约束：单文件 ESM，零模块依赖；组件用 ctx.react.createElement 手工构造；不使用 JSX。

const NS = "api-summary";

// ---------- 默认提示词（可在设置页改；改坏了可「恢复默认」） ----------

// 占位符：{workspace} {xlsx} {dir} {prefix} {engine} {sessionId}
const DEFAULT_SUMMARY_PROMPT = [
  "# 任务：汇总本次会话涉及的接口 API",
  "",
  "请通读我们这段对话里出现过的所有后端接口（Controller / REST / HTTP 端点），",
  "把它们编码、去重并维护到一张 Excel 台账里。",
  "",
  "## 台账文件",
  "- 路径：`{workspace}/{xlsx}`（相对当前工作空间；目录不存在则先创建）。",
  "- 若文件已存在，读取后**增量维护**（按 URL+请求方式 去重，已存在的行更新、新接口追加），不要整表覆盖丢失历史。",
  "- 用 Python(openpyxl) 或等价方式读写 xlsx；写完后确认文件已落盘。",
  "",
  "## 列顺序（第 1 行为表头，严格按此 8 列）",
  "1. 接口编码　　— 规则：`{prefix}` + 年月(yyMM) + 两位流水号，例 `{prefix}261001`。",
  "   先扫描台账里已有的同月前缀最大流水号，接着往下编；不同月各自从 01 起。",
  "2. URL　　　　　— 接口完整路径（如 /api/user/login）。",
  "3. Url所在Controller — 定义该接口的控制器类名/文件。",
  "4. 请求方式　　 — GET / POST / PUT / DELETE / PATCH 等。",
  "5. 接口含义　　 — 一句话完整说明这个接口做什么。",
  "6. 接口含义简要描述 — **10 字以内**，用于文件名与页签（不含空格与非法文件名字符）。",
  "7. 归属任务　　 — 该接口所属的需求/任务名（用于建子目录）。",
  "8. 其他备注　　 — 鉴权、幂等、版本、遗留问题等补充信息，可为空。",
  "",
  "## 输出前自检",
  "- 每个接口都齐全 8 列；简要描述 ≤10 字且可直接作文件名（去掉 \\/:*?\"<>| 与空白）。",
  "- 接口编码在本月内唯一、连续，无重复无跳号。",
  "- 台账已实际保存到 `{workspace}/{xlsx}`。",
  "",
  "完成后，接着按【文档生成规则】为**每一个新登记/更新的接口**生成对应的 Markdown 文档。",
].join("\n");

const DEFAULT_DOC_PROMPT = [
  "# 文档生成规则（接口编码_接口含义简要描述.md）",
  "",
  "对上一步台账里的每个接口，在工作空间创建 Markdown 文档：",
  "- 路径：`{workspace}/{dir}/<归属任务>/<接口编码>_<接口含义简要描述>.md`",
  "  （归属任务作为一级子目录，目录不存在则创建；文件名用「接口编码_简要描述」）。",
  "",
  "## 文档必须包含以下四部分（顺序不限，但都要有）",
  "1. **业务流程图**　　— Mermaid `flowchart TD`（或 LR），画出接口从入参校验到返回的完整业务分支。",
  "2. **表数据流转图**　— Mermaid，展示涉及的数据表/字段之间的读写与关联（SQL 关联图 / 数据链路图）。",
  "3. **业务时序图**　　— Mermaid `sequenceDiagram`，画出 客户端→Controller→Service→DB/外部 的调用时序。",
  "4. **其他标注情况**　— 文字说明：异常/边界、事务、缓存、幂等、权限、性能注意点等。",
  "",
  "此外文档开头给出接口基本信息（接口编码 / URL / Controller / 请求方式 / 含义 / 归属任务）。",
  "",
  "## ⚠️ Mermaid 图表必须能正常渲染 —— 逐个代码块自检",
  "- 代码块标记：每段图都用 ```mermaid 正确开启并**完整闭合**（前后各三个反引号，成对出现）。",
  "- 语法规范：节点定义、连线语法（-->、-.->、==>、<-->）、关键字拼写",
  "  （flowchart/graph/sequenceDiagram/stateDiagram/classDiagram/subgraph/end/alt/loop/opt 等）符合 Mermaid 规范；",
  "  节点 id 用 ASCII，中文放进方括号标签里；含空格/括号/特殊字符的标签用双引号包裹，如 A[\"查询 用户(分页)\"]。",
  "  避免在节点文字里出现未转义的 `()`、`{}`、`[]`、`|`、`#`、`<>`；分号/换行按 Mermaid 规则处理。",
  "- 逻辑完整性：不存在**孤立节点**（每个节点至少有一条进出连线）；",
  "  flowchart 有明确的起点与终点；subgraph / alt / loop / opt 等成对结构都有对应的 `end` 收尾，不缺结束标记。",
  "- sequenceDiagram：每个参与者先声明（participant 或由消息隐式建立），消息箭头方向正确，无悬空片段。",
  "",
  "## 保存前逐图复核",
  "把每张图当作要交给 mermaid-cli 渲染来检查：若某图渲染会报错，就地修正语法/闭合/孤立节点后再保存。",
  "确认所有 `.md` 文件已写入 `{workspace}/{dir}/<归属任务>/` 下。",
].join("\n");

// ---------- 小工具 ----------

function zh(locale) {
  return String(locale || "").toLowerCase().indexOf("zh") === 0;
}

function substitute(tpl, vars) {
  return String(tpl).replace(/\{(\w+)\}/g, function (m, k) {
    return Object.prototype.hasOwnProperty.call(vars, k) ? String(vars[k]) : m;
  });
}

function joinPath(ws, rel) {
  if (!ws) return rel;
  var sep = ws.indexOf("\\") >= 0 && ws.indexOf("/") < 0 ? "\\" : "/";
  var base = ws.replace(/[\\/]+$/, "");
  var r = String(rel || "").replace(/^[\\/]+/, "");
  return base + sep + r;
}

// 去掉 Windows/Linux 不允许出现在单个路径段里的字符，保留中文。
function sanitizeSeg(s) {
  return String(s || "")
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/\s+/g, " ")
    .trim();
}

function toast(msg, ok) {
  var el = document.createElement("div");
  el.setAttribute("role", "status");
  el.textContent = msg;
  el.style.cssText =
    "position:fixed;left:50%;transform:translateX(-50%);bottom:24px;z-index:2147483000;" +
    "padding:9px 14px;border-radius:8px;font:13px/1.5 system-ui,sans-serif;color:#fff;" +
    "background:" + (ok === false ? "#b3261e" : "#1a7f37") + ";" +
    "box-shadow:0 4px 16px rgba(0,0,0,.35);max-width:70vw;word-break:break-all";
  document.body.appendChild(el);
  setTimeout(function () { el.remove(); }, 3600);
}

// ---------- 配置读写（ctx.storage） ----------

var CFG_KEY = "config";
var DEFAULT_CFG = {
  mode: "draft",                 // draft | run
  xlsx: "docs/apis.xlsx",        // 相对工作空间
  dir: "docs/apis",              // 相对工作空间
  prefix: "CS",                  // 接口编码前缀
  summaryPrompt: DEFAULT_SUMMARY_PROMPT,
  docPrompt: DEFAULT_DOC_PROMPT,
};

function normalizeCfg(raw) {
  var c = {};
  for (var k in DEFAULT_CFG) {
    if (Object.prototype.hasOwnProperty.call(DEFAULT_CFG, k)) c[k] = DEFAULT_CFG[k];
  }
  if (raw && typeof raw === "object") {
    if (raw.mode === "draft" || raw.mode === "run") c.mode = raw.mode;
    if (typeof raw.xlsx === "string" && raw.xlsx.trim()) c.xlsx = raw.xlsx.trim();
    if (typeof raw.dir === "string" && raw.dir.trim()) c.dir = raw.dir.trim();
    if (typeof raw.prefix === "string" && raw.prefix.trim()) c.prefix = raw.prefix.trim();
    if (typeof raw.summaryPrompt === "string" && raw.summaryPrompt.trim()) c.summaryPrompt = raw.summaryPrompt;
    if (typeof raw.docPrompt === "string" && raw.docPrompt.trim()) c.docPrompt = raw.docPrompt;
  }
  return c;
}

function buildFullPrompt(cfg, ctxVars) {
  var parts = [];
  parts.push(substitute(cfg.summaryPrompt, ctxVars));
  parts.push("");
  parts.push(substitute(cfg.docPrompt, ctxVars));
  return parts.join("\n");
}

// ---------- 激活 ----------

export default function activate(ctx) {
  var h = ctx.react.createElement;
  var useState = ctx.react.useState;
  var useEffect = ctx.react.useEffect;

  var cfg = normalizeCfg(null);
  var cfgLoaded = false;
  ctx.storage.get(CFG_KEY).then(function (v) {
    cfg = normalizeCfg(v);
    cfgLoaded = true;
  }).catch(function () { cfgLoaded = true; });

  // 追踪当前活动工作空间路径（SessionMenuTarget 不带 workspacePath，需自行解析）。
  var activeWs = "";
  function refreshWs() {
    try {
      var p = ctx.workspace.getMetadata();
      if (p && typeof p.then === "function") {
        p.then(function (m) {
          if (m) activeWs = m.path || m.rootPath || m.workspacePath || m.root || "";
        }).catch(function () {});
      }
    } catch (e) {}
  }
  refreshWs();

  var offActivated = null;
  try {
    offActivated = ctx.events.on("session://activated", function (payload) {
      var p = payload || {};
      if (p.workspacePath) activeWs = p.workspacePath;
      else if (p.path) activeWs = p.path;
    });
  } catch (e) {}

  // 组装当前上下文变量
  function ctxVars(target) {
    var ws = activeWs || (target && target.workspacePath) || "";
    return {
      workspace: ws || "（当前工作空间根目录）",
      xlsx: cfg.xlsx,
      dir: cfg.dir,
      prefix: cfg.prefix,
      engine: (target && target.engine) || "",
      sessionId: (target && target.sessionId) || "",
    };
  }

  // 右键菜单：汇总API
  try {
    ctx.ui.registerSessionMenuItem({
      key: NS + ":summarize",
      label: function () { return zh(ctx.host.locale) ? "汇总API" : "Summarize APIs"; },
      run: function (target) {
        var vars = ctxVars(target);
        var full = buildFullPrompt(cfg, vars);

        if (cfg.mode === "run") {
          var ws = activeWs || (target && target.workspacePath) || "";
          if (!ws) {
            toast(zh(ctx.host.locale) ? "无法确定工作空间路径，请改用「草稿」模式" : "Workspace path unknown; use draft mode", false);
            return;
          }
          ctx.sessions.startRun({ engine: target.engine, prompt: full, workspacePath: ws })
            .then(function () {
              toast(zh(ctx.host.locale) ? "已发起「汇总API」轮次，请在聊天中查看进度" : "API summary run started", true);
            })
            .catch(function (e) {
              toast("发起失败：" + ((e && e.message) || String(e)), false);
            });
          return;
        }

        // draft 模式：先切到该会话，再把提示词写进输入框（AI 带完整历史汇总，最准）。
        var done = function () {
          try {
            ctx.composer.setDraft(full);
            toast(zh(ctx.host.locale)
              ? "已把「汇总API」提示词填入输入框，按回车发送即可"
              : "Summary prompt placed in composer — press Enter to send", true);
          } catch (e) {
            toast("写入草稿失败：" + ((e && e.message) || String(e)), false);
          }
        };
        if (target && target.engine && target.sessionId) {
          ctx.sessions.selectSession(target.engine, target.sessionId, activeWs || "")
            .then(done).catch(done); // 切换失败也尽量落到当前会话草稿
        } else {
          done();
        }
      },
    });
  } catch (e) {
    // 没有 ui:session-menu 权限或宿主不支持时不致命，设置页仍可用。
  }

  // ---------- 设置页 ----------
  function Field(label, node, hint) {
    return h("div", { style: { marginBottom: 14 } },
      h("div", { style: { fontSize: 13, fontWeight: 600, marginBottom: 4 } }, label),
      node,
      hint ? h("div", { style: { fontSize: 12, opacity: 0.65, marginTop: 3, lineHeight: 1.5 } }, hint) : null,
    );
  }

  function PromptBox(props) {
    // props: {label, value, onChange, onReset, placeholder}
    var ta = h("textarea", {
      value: props.value,
      onChange: function (e) { props.onChange(e.target.value); },
      spellCheck: false,
      placeholder: props.placeholder || "",
      style: {
        width: "100%", minHeight: 220, boxSizing: "border-box", resize: "vertical",
        fontFamily: "ui-monospace, Consolas, monospace", fontSize: 12, lineHeight: 1.5,
        padding: 8, borderRadius: 6, border: "1px solid rgba(128,128,128,.4)",
        background: "transparent", color: "inherit",
      },
    });
    return h("div", { style: { marginBottom: 16 } },
      h("div", { style: { display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 } },
        h("div", { style: { fontSize: 13, fontWeight: 600 } }, props.label),
        h("button", {
          type: "button",
          onClick: props.onReset,
          style: { fontSize: 12, padding: "2px 8px", borderRadius: 5, cursor: "pointer",
            border: "1px solid rgba(128,128,128,.5)", background: "transparent", color: "inherit" },
        }, "恢复默认"),
      ),
      ta,
      h("div", { style: { fontSize: 11, opacity: 0.6, marginTop: 3 } },
        "可用占位符：{workspace} {xlsx} {dir} {prefix} {engine} {sessionId}"),
    );
  }

  function Settings() {
    var st = useState(normalizeCfg(null));
    var local = st[0], setLocal = st[1];
    var loaded = useState(false);
    var isLoaded = loaded[0], setIsLoaded = loaded[1];

    useEffect(function () {
      ctx.storage.get(CFG_KEY).then(function (v) {
        var c = normalizeCfg(v);
        setLocal(c);
        cfg = c;               // 同步运行期副本
        setIsLoaded(true);
      }).catch(function () { setIsLoaded(true); });
    }, []);

    var patch = function (kv) { setLocal(function (prev) { return Object.assign({}, prev, kv); }); };

    var save = function () {
      var c = normalizeCfg(local);
      cfg = c;
      ctx.storage.set(CFG_KEY, c).then(function () {
        toast(zh(ctx.host.locale) ? "已保存" : "Saved", true);
      }).catch(function (e) {
        toast("保存失败：" + ((e && e.message) || String(e)), false);
      });
    };

    var inputStyle = {
      width: "100%", boxSizing: "border-box", padding: "6px 8px", borderRadius: 6,
      border: "1px solid rgba(128,128,128,.4)", background: "transparent", color: "inherit", fontSize: 13,
    };

    if (!isLoaded) return h("div", { style: { padding: 8, opacity: 0.6 } }, "加载中…");

    return h("div", { style: { padding: "4px 2px", maxWidth: 720 } },
      h("p", { style: { fontSize: 13, lineHeight: 1.6, marginTop: 0, opacity: 0.85 } },
        "在侧栏「会话」右键菜单里新增「汇总API」。点击后把下面的提示词交给 AI，让它梳理会话涉及的接口，" +
        "维护到 " + joinPath("<工作空间>", local.xlsx) + " 台账，并在 " + joinPath("<工作空间>", local.dir) +
        "/<归属任务>/ 下按接口生成含 Mermaid 图的文档。两段提示词均可自定义。"),

      Field("送达方式",
        h("div", { style: { display: "flex", gap: 16, fontSize: 13 } },
          h("label", { style: { display: "flex", alignItems: "center", gap: 6, cursor: "pointer" } },
            h("input", { type: "radio", name: "mode", checked: local.mode === "draft",
              onChange: function () { patch({ mode: "draft" }); } }), "草稿（推荐）"),
          h("label", { style: { display: "flex", alignItems: "center", gap: 6, cursor: "pointer" } },
            h("input", { type: "radio", name: "mode", checked: local.mode === "run",
              onChange: function () { patch({ mode: "run" }); } }), "自动发起轮次"),
        ),
        "草稿：右键后把提示词填入该会话输入框，你回车发送——AI 带着完整对话历史汇总，最准确。" +
        "自动发起：直接起一个宿主可见的聊天轮次（新会话可能看不到原始历史，准确性略低）。"),

      Field("接口编码前缀",
        h("input", { style: Object.assign({}, inputStyle, { maxWidth: 160 }), value: local.prefix,
          onChange: function (e) { patch({ prefix: e.target.value }); } }),
        "接口编码 = 前缀 + 年月(yyMM) + 两位流水号，如 " + sanitizeSeg(local.prefix || "CS") + "261001。"),

      Field("台账 Excel 路径（相对工作空间）",
        h("input", { style: inputStyle, value: local.xlsx,
          onChange: function (e) { patch({ xlsx: e.target.value }); } })),

      Field("接口文档目录（相对工作空间）",
        h("input", { style: inputStyle, value: local.dir,
          onChange: function (e) { patch({ dir: e.target.value }); } }),
        "文档写到 <此目录>/<归属任务>/<接口编码>_<简要描述>.md。"),

      PromptBox({
        label: "汇总API 提示词",
        value: local.summaryPrompt,
        onChange: function (v) { patch({ summaryPrompt: v }); },
        onReset: function () { patch({ summaryPrompt: DEFAULT_SUMMARY_PROMPT }); },
      }),

      PromptBox({
        label: "接口文档（.md）输出逻辑 提示词",
        value: local.docPrompt,
        onChange: function (v) { patch({ docPrompt: v }); },
        onReset: function () { patch({ docPrompt: DEFAULT_DOC_PROMPT }); },
      }),

      h("button", {
        type: "button", onClick: save,
        style: { fontSize: 14, padding: "8px 18px", borderRadius: 8, cursor: "pointer",
          border: "none", background: "#1a7f37", color: "#fff", fontWeight: 600 },
      }, "保存设置"),
    );
  }

  try {
    ctx.ui.registerSettingsSection({
      key: NS,
      label: function () { return zh(ctx.host.locale) ? "会话 API 汇总" : "API Summary"; },
      component: Settings,
    });
  } catch (e) {}

  // 卸载清理：事件订阅由宿主按 Disposer 回收，这里兜底断开。
  return function () {
    if (offActivated && typeof offActivated === "function") { try { offActivated(); } catch (e) {} }
  };
}
