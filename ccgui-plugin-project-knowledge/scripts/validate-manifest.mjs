#!/usr/bin/env node
/**
 * manifest.json 结构校验（发版 Action 与本地共用，零依赖，Node ≥ 20）。
 * 规则对齐市场索引仓 scripts/validate.mjs 的 entry/manifest 检查。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(path.join(ROOT, "manifest.json"), "utf8"));

const ID_RE = /^[a-z0-9][a-z0-9-]*(?:\.[a-z0-9][a-z0-9-]*)*$/;
const SEMVER_RE = /^\d+\.\d+\.\d+$/;
const SDK_RANGE_RE = /^(?:(\^|~|>=)?\d+\.\d+(?:\.\d+)?|\*)$/;

const errors = [];
const check = (ok, msg) => { if (!ok) errors.push(msg); };
const chars = (s) => [...String(s)].length;

check(typeof manifest.id === "string" && ID_RE.test(manifest.id), "id 不合法：需小写点分段 [a-z0-9-]");
check(typeof manifest.name === "string" && chars(manifest.name) > 0 && chars(manifest.name) <= 30, "name 缺失或超过 30 字符");
check(SEMVER_RE.test(manifest.version || ""), "version 必须是三段 semver");
check(manifest.tier === "js", 'tier 必须是 "js"');
check(typeof manifest.repo === "string" && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(manifest.repo), "repo 需 owner/repo 形式");
check(SEMVER_RE.test(manifest.minAppVersion || ""), "minAppVersion 必须是三段 semver");
check(SDK_RANGE_RE.test(manifest.sdkVersion || ""), "sdkVersion range 不合法（*、三段、^x.y(.z)、~x.y.z、>=x.y.z）");
check(chars(manifest.description) > 0 && chars(manifest.description) <= 120, "description 缺失或超过 120 字符");
check(Array.isArray(manifest.permissions), "permissions 必须是数组");
check(Array.isArray(manifest.keywords) && manifest.keywords.length <= 8, "keywords 必须是数组且不超过 8 个");
check(manifest.license === "MIT", "license 必须是 MIT");

// 展示素材：相对仓库路径、不逃逸、图片扩展名
if (manifest.icon !== undefined) {
  check(
    typeof manifest.icon === "string" &&
      /\.(png|jpe?g|webp|gif|svg|avif)$/i.test(manifest.icon) &&
      !manifest.icon.includes("\\") &&
      !manifest.icon.split("/").includes(".."),
    "icon 必须是仓库内相对路径或 https URL，图片扩展名",
  );
}

if (errors.length) {
  console.error(`manifest.json 校验失败：\n- ${errors.join("\n- ")}`);
  process.exit(1);
}
console.log(`manifest ok：${manifest.id}@${manifest.version}（${manifest.permissions.length} 项权限）`);
