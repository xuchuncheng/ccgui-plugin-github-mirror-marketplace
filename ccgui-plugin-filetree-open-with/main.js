// 文件树 · 在关联应用中打开
// 宿主未开放“文件树右键菜单”扩展点（SDK 仅有 sessionMenu/addMenu/panelTab/… 等注册表，
// 没有任何 file/explorer/context-menu 槽位）。因此本插件用 DOM 注入的方式，在文件树
// 右键菜单弹出时，往其中追加一行“在关联应用中打开”，点击后经 plugin_exec_spawn 调
// `cmd /c start "" "<path>"` 交给 Windows 默认关联程序打开。
// 与你已安装的 github-mirror-marketplace 插件同源套路（MutationObserver + document.body）。
//
// 约束：单文件 ESM，不得 import 任何模块；组件用 ctx.react.createElement；无 JSX/eval。

const ZH = "zh";

// 文件树菜单独有的一行组合（其它 role=menu 菜单都没有这对，用于唯一定位）。
const MARK_NEW_FILE = ["新建文件", "New File"];
const MARK_NEW_FOLDER = ["新建文件夹", "New Folder"];

// 与宿主 context-menu.tsx 普通行完全一致的类名，保证视觉/悬停统一。
const ROW_CLASS =
  "flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-body-medium outline-none " +
  "text-text-primary hover:bg-background-primary-hover";

// lucide “external-link” 字形，内联 SVG（不能引包）。
const ICON_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
  'stroke-linecap="round" stroke-linejoin="round" class="size-4" aria-hidden="true">' +
  '<path d="M15 3h6v6"/><path d="M10 14 21 3"/>' +
  '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/></svg>';

function labelFor(locale) {
  return String(locale || "").toLowerCase().startsWith(ZH)
    ? "在关联应用中打开"
    : "Open with Associated App";
}

function toast(msg) {
  const el = document.createElement("div");
  el.setAttribute("role", "status");
  el.textContent = msg;
  el.style.cssText =
    "position:fixed;right:16px;bottom:16px;z-index:2147483000;padding:8px 12px;" +
    "border-radius:8px;font:13px/1.4 system-ui,sans-serif;color:#fff;background:#b3261e;" +
    "box-shadow:0 4px 16px rgba(0,0,0,.35);max-width:60vw;word-break:break-all";
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3200);
}

export default function activate(ctx) {
  const { createElement: h, useState, useEffect } = ctx.react;

  // 运行期开关：默认开启；从 storage 恢复。设置页改动即时生效。
  let enabled = true;
  ctx.storage.get("enabled").then((v) => {
    if (typeof v === "boolean") {
      enabled = v;
      schedule();
    }
  });

  // ---- DOM 注入：识别文件树右键菜单并追加一行 ----
  let busy = false;
  let queued = false;
  function schedule() {
    if (queued) return;
    queued = true;
    // MutationObserver 回调里改 DOM 会再次触发自身 → 用微任务错峰 + busy 防重入。
    queueMicrotask(() => {
      queued = false;
      inject();
    });
  }

  function textOf(btn) {
    return (btn.textContent || "").trim();
  }

  function looksLikeFileTreeMenu(menu) {
    const btns = menu.querySelectorAll('button[role="menuitem"]');
    let hasFile = false;
    let hasFolder = false;
    for (const b of btns) {
      const t = textOf(b);
      if (MARK_NEW_FILE.indexOf(t) >= 0) hasFile = true;
      else if (MARK_NEW_FOLDER.indexOf(t) >= 0) hasFolder = true;
    }
    return hasFile && hasFolder;
  }

  function makeRow(path) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.setAttribute("role", "menuitem");
    btn.className = ROW_CLASS;
    btn.dataset.owBtn = "1";
    btn.innerHTML =
      '<span class="shrink-0 text-foreground-icon-tertiary" aria-hidden="true">' +
      ICON_SVG +
      "</span>";
    const label = document.createElement("span");
    label.className = "truncate";
    label.textContent = labelFor(ctx.host.locale);
    btn.appendChild(label);
    btn.addEventListener("click", () => {
      // 先收起菜单（宿主 window keydown capture 监听 Escape → close），再异步打开。
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      // 必须用 spawn(detached) 而不是 exec_run：exec_run 把 cmd 及其孙进程
      // （start 拉起的目标程序）放进 kill-on-close Job，cmd 一退出宿主就把刚
      // 打开的应用杀掉。spawn 的 detached 路径不建 Job、丢句柄，进程存活。
      ctx.bridge
        .invoke("plugin_exec_spawn", {
          bin: "cmd",
          args: ["/c", "start", "", path],
        })
        .catch((e) => toast("打开失败：" + (e && e.message ? e.message : String(e))));
    });
    return btn;
  }

  function inject() {
    if (busy) return;
    busy = true;
    try {
      const menus = document.querySelectorAll('[role="menu"]');
      for (const menu of menus) {
        if (!enabled) {
          // 关闭时清掉已注入的行。
          menu.querySelectorAll("[data-ow-btn]").forEach((n) => n.remove());
          continue;
        }
        if (menu.querySelector("[data-ow-btn]")) continue; // 幂等
        if (!looksLikeFileTreeMenu(menu)) continue;
        const path = (menu.getAttribute("aria-label") || "").trim();
        if (!path) continue;
        const row = makeRow(path);
        // 落在“在资源管理器中显示”之后、“移到废纸篓”之前：插到首个分隔线(hr)前面。
        const sep = menu.querySelector("hr");
        if (sep) menu.insertBefore(row, sep);
        else menu.appendChild(row);
      }
    } finally {
      busy = false;
    }
  }

  const observer = new MutationObserver(schedule);
  observer.observe(document.body, { childList: true, subtree: true });

  // ---- 设置页：总开关（不卸载也能关掉注入）----
  function Settings() {
    const [on, setOn] = useState(enabled);
    useEffect(() => {
      ctx.storage.get("enabled").then((v) => {
        const val = typeof v === "boolean" ? v : true;
        setOn(val);
        enabled = val;
      });
    }, []);
    const toggle = (val) => {
      setOn(val);
      enabled = val;
      void ctx.storage.set("enabled", val);
      schedule();
    };
    return h(
      "div",
      { style: { padding: "4px 2px", maxWidth: 460 } },
      h(
        "label",
        {
          style: {
            display: "flex",
            alignItems: "center",
            gap: 8,
            cursor: "pointer",
            fontSize: 14,
          },
        },
        h("input", {
          type: "checkbox",
          checked: on,
          onChange: (e) => toggle(e.target.checked),
        }),
        "在文件树右键菜单显示「在关联应用中打开」",
      ),
      h(
        "p",
        { style: { marginTop: 8, fontSize: 12, opacity: 0.7, lineHeight: 1.5 } },
        "点击该行会用系统默认关联程序打开选中的文件/文件夹。宿主未开放文件树菜单扩展点，此项以 DOM 注入实现，宿主改版时可能失效。",
      ),
    );
  }
  const disposeSettings = ctx.ui.registerSettingsSection({
    label: () => "文件树 · 关联打开",
    component: Settings,
  });
  void disposeSettings; // 宿主在卸载时自动回收 register* 的 Disposer，无需手动调用。

  // 卸载：断开观察器 + 移除已注入的行（这两样是本插件自己管的，宿主不负责）。
  return () => {
    observer.disconnect();
    document.querySelectorAll("[data-ow-btn]").forEach((n) => n.remove());
  };
}
