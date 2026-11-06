#!/usr/bin/env node
/**
 * bundle 门禁自检（发版 Action 与本地共用，零依赖，Node ≥ 20）。
 * 对齐市场索引仓 scripts/validate.mjs：黑名单、体积、CSS 静态解析、
 * 以及「声明了权限 / 代码里真的调用了」的双向比对。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (f) => readFileSync(path.join(ROOT, f), "utf8");

const JS_BLACKLIST = [
  [/\beval\s*\(/, "eval("],
  [/new\s+Function\s*\(/, "new Function("],
  [/__TAURI__/, "__TAURI__"],
  [/\blocalStorage\b/, "localStorage"],
  [/import\s*\(\s*["'`]https?:\/\//, "远程 import("],
];

const CSS_BLACKLIST = [
  [/@import\b/i, "@import"],
  [/url\(\s*["']?https?:\/\//i, "url(http…)"],
];

/** 权限 → 代码里必须出现的调用点（与索引仓 CTX_PERMISSION_MAP 同口径）。 */
const PERMISSION_CALLS = [
  ["ui:panel-tab", /\.ui\.registerPanelTab\s*\(/],
  ["ui:composer-status", /\.ui\.registerComposerStatusItem\s*\(/],
  ["storage", /\.storage\.(get|set|delete)\s*\(/],
  ["events", /\.events\.(on|emit)\s*\(/],
  ["prompt.contribute.internal", /\.hooks\.registerTurnHooks\s*\(/],
  ["host:session", /\.sessions\.(selectSession|startRun|interruptRun|refresh|setEffort|registerSource|list)\s*\(/],
  ["composer:draft", /\.composer\.setDraft\s*\(/],
];

/** 未声明却出现的调用点（漏声明 = 硬错误）。 */
const UNDECLARED_CHECKS = [
  ["ui:settings-section", /\.ui\.registerSettingsSection\s*\(/],
  ["ui:add-menu", /\.ui\.registerAddMenuRow\s*\(/],
  ["ui:status-bar", /\.ui\.registerStatusBarItem\s*\(/],
  ["ui:command", /\.ui\.registerCommand\s*\(/],
  ["ui:markdown", /\.ui\.registerMarkdownRenderer\s*\(/],
  ["ui:page", /\.ui\.registerPage\s*\(/],
  ["ui:timeline-row", /\.ui\.registerTimelineRowRenderer\s*\(/],
  ["ui:sidebar-entry", /\.ui\.registerSidebarNav\s*\(/],
  ["ui:center-tab", /\.ui\.(registerCenterTab|openCenterTab)\s*\(/],
  ["ui:worktree-badge", /\.ui\.registerWorktreeBadges\s*\(/],
  ["ui:workspace-menu", /\.ui\.registerWorkspaceMenuItem\s*\(/],
  ["ui:session-menu", /\.ui\.registerSessionMenuItem\s*\(/],
  ["ui:file-link-menu", /\.ui\.registerFileLinkMenuItem\s*\(/],
  ["ui:overlay", /\.ui\.registerOverlay\s*\(/],
  ["ui:conversation-mode", /\.ui\.registerConversationMode\s*\(/],
  ["agent", /\.agent\.(catalog|start|interrupt)\s*\(/],
  ["theme", /\.theme\.(injectCss|setTokens)\s*\(/],
  ["i18n", /\.i18n\.addBundle\s*\(/],
  ["plugin.storage", /\.documentStorage\.[A-Za-z]+\s*\(/],
  ["workspace.metadata.read", /\.workspace\.getMetadata\s*\(/],
  ["host:workspace", /\.workspaces\.(add|list)\s*\(/],
  ["usage.read", /\.usage\.(query|sources|refresh|rescan|prices|updatePrices)\s*\(/],
  ["limits.read", /\.limits\.get\s*\(/],
  ["host:worktree", /\.worktrees\.(create|remove)\s*\(/],
  ["host:window", /\.window\.(getState|setNormalBounds|sampleWechat)\s*\(/],
  ["host:models", /\.models\.(listEngines|listEngineModels|catalog)\s*\(/],
  ["session.lifecycle.read", /\.hooks\.registerSessionHooks\s*\(/],
  ["runtime.switch.observe", /\.hooks\.registerRuntimeSwitchHooks\s*\(/],
];

const MAX_WARN_BYTES = 512 * 1024;
const MAX_HARD_BYTES = 2 * 1024 * 1024;

const manifest = JSON.parse(read("manifest.json"));
const main = read("main.js");
const css = read("styles.css");
const errors = [];
const warnings = [];

for (const [re, label] of JS_BLACKLIST) {
  if (re.test(main)) errors.push(`main.js 命中黑名单 "${label}"`);
}
for (const [re, label] of CSS_BLACKLIST) {
  if (re.test(css)) errors.push(`styles.css 命中禁止项 "${label}"`);
}

const bytes = Buffer.byteLength(main, "utf8");
if (bytes > MAX_HARD_BYTES) errors.push(`main.js ${(bytes / 1024).toFixed(1)}KB 超过 2MB 硬上限`);
else if (bytes > MAX_WARN_BYTES) warnings.push(`main.js ${(bytes / 1024).toFixed(1)}KB 超过 512KB 警告阈值`);

if (/^\s*import\s/m.test(main)) errors.push("main.js 含顶层 import：Tier-1 bundle 必须是自包含单文件");

const declared = new Set(manifest.permissions || []);
for (const [perm, re] of UNDECLARED_CHECKS) {
  if (re.test(main) && !declared.has(perm)) errors.push(`代码使用 ${re} 但未声明权限 "${perm}"`);
}
for (const [perm, re] of PERMISSION_CALLS) {
  if (declared.has(perm) && !re.test(main)) warnings.push(`声明了权限 "${perm}" 但未检出对应调用`);
}
for (const perm of declared) {
  if (!PERMISSION_CALLS.some(([p]) => p === perm) && !perm.startsWith("network:") && !perm.startsWith("exec:")) {
    warnings.push(`权限 "${perm}" 不在本脚本的比对表内，请人工确认`);
  }
}

console.log(`main.js ${(bytes / 1024).toFixed(1)}KB · styles.css ${(Buffer.byteLength(css) / 1024).toFixed(1)}KB`);
for (const w of warnings) console.log(`⚠️  ${w}`);
if (errors.length) {
  console.error(`\n门禁未通过：\n- ${errors.join("\n- ")}`);
  process.exit(1);
}
console.log("bundle 门禁通过");
