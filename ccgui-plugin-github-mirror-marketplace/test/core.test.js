import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildEndpoints,
  isAccepted,
  normalizePlugins,
  parseRepo,
  blobToRaw,
  buildFileEndpoints,
  fetchWithFallback,
  fetchFirstText,
  installPaths,
  buildRegistrationPatch,
  compareVersions,
  parseLatestJson,
  buildUpdaterEndpoints,
  buildInstallerEndpoints,
  installerFileName,
  PRIMARY_URL,
  FALLBACK_URL,
  DEFAULT_MIRROR_PREFIXES,
  UPDATER_LATEST_URL,
} from "../core.js";

// 造一个假 http：按 url 返回预设结果，或抛错模拟网络失败/超时。
function fakeHttp(map) {
  return async (url) => {
    const v = map[url];
    if (v instanceof Error) throw v;
    if (v === undefined) throw new Error("error sending request for url " + url);
    return v; // {status, body}
  };
}

const GOOD_JSON = JSON.stringify([{ id: "a", name: "Alpha" }, { id: "b", name: "Beta" }]);

// ── buildEndpoints ────────────────────────────────────────────────────
test("端点顺序：主 → 备 → 镜像(包裹主地址)，且去重", () => {
  const eps = buildEndpoints();
  assert.equal(eps[0], PRIMARY_URL);
  assert.equal(eps[1], FALLBACK_URL);
  // 镜像在前缀后紧跟主地址
  assert.ok(eps.length >= 2 + DEFAULT_MIRROR_PREFIXES.length);
  assert.ok(eps.some((u) => u.includes("ghproxy.net/") && u.endsWith(PRIMARY_URL)));
  // 无重复
  assert.equal(new Set(eps).size, eps.length);
});

test("镜像为空时只有主+备两个端点", () => {
  const eps = buildEndpoints({ mirrorPrefixes: [] });
  assert.deepEqual(eps, [PRIMARY_URL, FALLBACK_URL]);
});

// ── isAccepted ────────────────────────────────────────────────────────
test("isAccepted：2xx 通过，非 2xx 与 undefined 拒绝", () => {
  assert.equal(isAccepted(200), true);
  assert.equal(isAccepted(203), true);
  assert.equal(isAccepted(299), true);
  assert.equal(isAccepted(301), false);
  assert.equal(isAccepted(404), false);
  assert.equal(isAccepted(500), false);
  assert.equal(isAccepted(undefined), false);
});

// ── normalizePlugins ──────────────────────────────────────────────────
test("normalize：裸数组与 {plugins:[...]} 都能识别并归一", () => {
  const arr = normalizePlugins([{ id: "x", name: "X" }]);
  assert.equal(arr.length, 1);
  assert.equal(arr[0].id, "x");

  const wrapped = normalizePlugins({ plugins: [{ name: "Y", repo: "o/Y" }] });
  assert.equal(wrapped.length, 1);
  assert.equal(wrapped[0].id, "Y"); // 无 id 时回退到 repo 名
});

test("normalize：非清单结构返回 null（触发回退）", () => {
  assert.equal(normalizePlugins({ foo: "bar" }), null);
  assert.equal(normalizePlugins("a string"), null);
  assert.equal(normalizePlugins(42), null);
});

// ── parseRepo / blobToRaw ─────────────────────────────────────────────
test("parseRepo：owner/name、完整 URL、带 tree/ref 都能解析", () => {
  assert.deepEqual(parseRepo("dijia/foo"), { owner: "dijia", name: "foo", ref: "" });
  const u = parseRepo("https://github.com/dijia/foo");
  assert.equal(u.owner, "dijia");
  assert.equal(u.name, "foo");
  const t = parseRepo("https://github.com/dijia/foo/tree/dev/src");
  assert.equal(t.ref, "dev");
  assert.equal(parseRepo(""), null);
});

test("blobToRaw：GitHub blob → raw；非 GitHub 原样", () => {
  assert.equal(
    blobToRaw("https://github.com/o/r/blob/main/manifest.json"),
    "https://raw.githubusercontent.com/o/r/main/manifest.json",
  );
  assert.equal(blobToRaw("https://example.com/x.json"), "https://example.com/x.json");
});

// ── buildFileEndpoints ────────────────────────────────────────────────
test("manifest.json 端点：仓库根 raw + 镜像包裹 + jsdelivr", () => {
  const eps = buildFileEndpoints({ repo: "dijia/foo", _raw: {} }, "manifest.json", { mirrorPrefixes: ["https://ghproxy.net/"] });
  assert.ok(eps.some((u) => u === "https://raw.githubusercontent.com/dijia/foo/main/manifest.json"));
  assert.ok(eps.some((u) => u === "https://cdn.jsdelivr.net/gh/dijia/foo@main/manifest.json"));
  assert.ok(eps.some((u) => u.includes("ghproxy.net/") && u.endsWith("/manifest.json")));
});

test("main.js/styles.css 走 Release 附件（仓库根没有构建产物），镜像在前", () => {
  const eps = buildFileEndpoints({ repo: "dijia/foo", _raw: {} }, "main.js", { mirrorPrefixes: ["https://ghproxy.net/"], version: "1.2.0" });
  // 不该出现仓库根 raw 的 main.js（那里只有 src/）
  assert.ok(!eps.some((u) => u.startsWith("https://raw.githubusercontent.com/")));
  // 精确 tag 路径 + latest 兜底，且镜像包裹优先
  assert.ok(eps.some((u) => u === "https://ghproxy.net/https://github.com/dijia/foo/releases/download/1.2.0/main.js"));
  assert.ok(eps.some((u) => u === "https://github.com/dijia/foo/releases/download/1.2.0/main.js"));
  assert.ok(eps.some((u) => u === "https://github.com/dijia/foo/releases/latest/download/main.js"));
  assert.ok(eps[0].includes("ghproxy.net/")); // 镜像排最前
});

test("无 version 时 Release 链只剩 latest", () => {
  const eps = buildFileEndpoints({ repo: "dijia/foo", _raw: {} }, "main.js", { mirrorPrefixes: [] });
  assert.deepEqual(eps, ["https://github.com/dijia/foo/releases/latest/download/main.js"]);
});

test("文件端点：清单直接给了 url 时优先，且 blob 会被转 raw", () => {
  const eps = buildFileEndpoints({ url: "https://github.com/o/r/blob/main/manifest.json", repo: "" }, "manifest.json", { mirrorPrefixes: [] });
  assert.equal(eps[0], "https://raw.githubusercontent.com/o/r/main/manifest.json");
});

// ── fetchWithFallback：核心回退行为 ──────────────────────────────────
test("回退：主地址网络失败 → 备用成功", async () => {
  const http = fakeHttp({
    [PRIMARY_URL]: new Error("error sending request for url"),
    [FALLBACK_URL]: { status: 200, body: GOOD_JSON },
  });
  const r = await fetchWithFallback(http, [PRIMARY_URL, FALLBACK_URL]);
  assert.equal(r.ok, true);
  assert.equal(r.endpoint, FALLBACK_URL);
  assert.equal(r.data.length, 2);
  assert.equal(r.errors[0].reason, "network");
});

test("回退：主地址非 200 → 备用成功", async () => {
  const http = fakeHttp({
    [PRIMARY_URL]: { status: 403, body: "blocked" },
    [FALLBACK_URL]: { status: 200, body: GOOD_JSON },
  });
  const r = await fetchWithFallback(http, [PRIMARY_URL, FALLBACK_URL]);
  assert.equal(r.ok, true);
  assert.equal(r.endpoint, FALLBACK_URL);
  assert.equal(r.errors[0].reason, "status");
});

test("回退：主地址 200 但 JSON 坏 → 跳到镜像", async () => {
  const mirror = "https://ghproxy.net/" + PRIMARY_URL;
  const http = fakeHttp({
    [PRIMARY_URL]: { status: 200, body: "{not json" },
    [mirror]: { status: 200, body: GOOD_JSON },
  });
  const r = await fetchWithFallback(http, [PRIMARY_URL, mirror]);
  assert.equal(r.ok, true);
  assert.equal(r.endpoint, mirror);
  assert.equal(r.errors[0].reason, "json");
});

test("回退：200 且可解析但结构不像清单 → 继续下一个", async () => {
  const http = fakeHttp({
    [PRIMARY_URL]: { status: 200, body: JSON.stringify({ msg: "rate limited" }) },
    [FALLBACK_URL]: { status: 200, body: GOOD_JSON },
  });
  const r = await fetchWithFallback(http, [PRIMARY_URL, FALLBACK_URL]);
  assert.equal(r.ok, true);
  assert.equal(r.endpoint, FALLBACK_URL);
  assert.equal(r.errors[0].reason, "shape");
});

test("全败：ok=false，errors 汇总每个端点失败原因", async () => {
  const http = fakeHttp({});
  const r = await fetchWithFallback(http, [PRIMARY_URL, FALLBACK_URL]);
  assert.equal(r.ok, false);
  assert.equal(r.data, null);
  assert.equal(r.errors.length, 2);
});

// ── fetchFirstText ────────────────────────────────────────────────────
test("fetchFirstText：跳过空体与非 2xx，取首个有效文本", async () => {
  const http = fakeHttp({
    "u1": { status: 404, body: "" },
    "u2": { status: 200, body: "" },
    "u3": { status: 200, body: "console.log(1)" },
  });
  const r = await fetchFirstText(http, ["u1", "u2", "u3"]);
  assert.equal(r.ok, true);
  assert.equal(r.endpoint, "u3");
  assert.equal(r.text, "console.log(1)");
});

// ── installPaths ──────────────────────────────────────────────────────
test("installPaths：拼出插件目录、各文件路径、plugins.json，并清洗非法字符", () => {
  const p = installPaths("/home/me/.ccgui-next", "bad id/../x", ["manifest.json", "main.js"]);
  assert.equal(p.id, "bad_id_.._x");
  assert.ok(p.dir.endsWith("/plugins/bad_id_.._x"));
  assert.ok(p.files["manifest.json"].endsWith("/plugins/bad_id_.._x/manifest.json"));
  assert.equal(p.pluginsJson, "/home/me/.ccgui-next/plugins.json");
});

// ── buildRegistrationPatch ────────────────────────────────────────────
test("注册补丁：写入 enabled/local 项，保留原有条目，不改入参", () => {
  const orig = { plugins: { existing: { version: "1.0.0", enabled: true } } };
  const patched = buildRegistrationPatch(orig, "newid", { version: "2.3.4", _raw: { permissions: ["storage"] } }, { installedAt: 111 });
  assert.equal(patched.plugins.newid.enabled, true);
  assert.equal(patched.plugins.newid.source, "local");
  assert.equal(patched.plugins.newid.version, "2.3.4");
  assert.deepEqual(patched.plugins.newid.permissions, ["storage"]);
  assert.equal(patched.plugins.newid.installedAt, 111);
  assert.equal(patched.plugins.existing.enabled, true); // 原有保留
  assert.equal(orig.plugins.newid, undefined); // 入参未被改
});

test("注册补丁：入参为空对象也能生成结构", () => {
  const patched = buildRegistrationPatch({}, "solo", {}, { installedAt: 1 });
  assert.equal(patched.plugins.solo.enabled, true);
});

// ── 客户端更新：版本比较 / latest.json / 端点 ──────────────────────────
test("compareVersions：数值语义比较", () => {
  assert.equal(compareVersions("1.0.6", "1.1.0"), -1);
  assert.equal(compareVersions("1.1.0", "1.1.0"), 0);
  assert.equal(compareVersions("1.2", "1.1.9"), 1);
  assert.equal(compareVersions("1.0.6", "1.0.6-beta"), 0); // 非数字段按 0
});

test("parseLatestJson：取 windows-x86_64 的 url/signature", () => {
  const j = {
    version: "1.1.0",
    notes: "## 更新",
    platforms: {
      "darwin-aarch64": { url: "x.app.tar.gz" },
      "windows-x86_64": { url: "https://github.com/o/r/releases/download/v1.1.0/setup.exe", signature: "SIG" },
    },
  };
  const r = parseLatestJson(j);
  assert.equal(r.ok, true);
  assert.equal(r.version, "1.1.0");
  assert.equal(r.winSig, "SIG");
  assert.ok(r.winUrl.endsWith("setup.exe"));
});

test("parseLatestJson：缺 windows 平台 → ok=false", () => {
  const r = parseLatestJson({ version: "1.1.0", platforms: { "linux-x86_64": { url: "a" } } });
  assert.equal(r.ok, false);
});

test("buildUpdaterEndpoints：镜像在前，直连 latest.json 兜底", () => {
  const eps = buildUpdaterEndpoints({ mirrorPrefixes: ["https://ghproxy.net/"] });
  assert.equal(eps[0], "https://ghproxy.net/" + UPDATER_LATEST_URL);
  assert.equal(eps[eps.length - 1], UPDATER_LATEST_URL);
});

test("buildInstallerEndpoints + installerFileName", () => {
  const winUrl = "https://github.com/o/r/releases/download/v1.1.0/CC.GUI_1.1.0_x64-setup.exe";
  const eps = buildInstallerEndpoints(winUrl, { mirrorPrefixes: ["https://ghproxy.net/"] });
  assert.ok(eps[0].startsWith("https://ghproxy.net/"));
  assert.ok(eps.includes(winUrl));
  assert.equal(installerFileName(winUrl), "CC.GUI_1.1.0_x64-setup.exe");
});
