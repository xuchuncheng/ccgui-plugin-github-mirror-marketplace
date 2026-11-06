// 过程卡片的纯函数测试（node --test test.mjs）
//
// 只测分类器与结果格式化：这两块是卡片「说人话」的全部逻辑，也是最容易在
// 不同引擎/工具名之间出错的地方。React 组件不在这里测（宿主没有可用的
// 组件测试环境），视觉部分靠装进 GUI 人工核对。

import test from "node:test";
import assert from "node:assert/strict";
import { classifyTool, classifyItems, formatResult, toolKindOf } from "./main.js";

const zh = { locale: "zh-CN" };

test("工具名归一：大小写、分隔符、MCP 前缀", () => {
  assert.equal(toolKindOf("Bash"), "shell");
  assert.equal(toolKindOf("read_file"), "read");
  assert.equal(toolKindOf("Read File"), "read");
  assert.equal(toolKindOf("apply_patch"), "edit");
  assert.equal(toolKindOf("TodoWrite"), "todo");
  assert.equal(toolKindOf("mcp__filesystem__read_file"), "read");
  assert.equal(toolKindOf("SomeUnknownTool"), "tool");
});

test("Bash：优先用 description，命令作次要文本", () => {
  const r = classifyTool(
    {
      type: "tool",
      text: "Bash",
      args: { command: "node -v\nnpm -v", description: "检查 Node 版本" },
      path: null,
    },
    zh,
  );
  assert.equal(r.verb, "执行命令");
  assert.equal(r.primary, "检查 Node 版本");
  assert.equal(r.secondary, "node -v");
});

test("Bash：没有 description 时命令首行就是主文本", () => {
  const r = classifyTool(
    { type: "tool", text: "Bash", args: { command: "  git status --short  \n" } },
    zh,
  );
  assert.equal(r.verb, "执行命令");
  assert.equal(r.primary, "git status --short");
  assert.equal(r.secondary, "");
});

test("codex 风格：整行就是命令（工具名里有空格）", () => {
  const r = classifyTool(
    { type: "tool", text: "npm run build --silent", args: null },
    zh,
  );
  assert.equal(r.kind, "shell");
  assert.equal(r.primary, "npm run build --silent");
});

test("Read：文件名为主，绝对路径为次要；带行号选择器要剥掉", () => {
  const r = classifyTool(
    {
      type: "tool",
      text: "Read",
      path: "D:/work_space/CCgui/src/main.ts:120-160",
      args: { file_path: "D:/work_space/CCgui/src/main.ts", offset: 120, limit: 40 },
    },
    zh,
  );
  assert.equal(r.verb, "读取文件");
  assert.equal(r.primary, "main.ts");
  assert.equal(r.secondary, "D:/work_space/CCgui/src");
});

test("Edit：算出 +N/-M 行", () => {
  const r = classifyTool(
    {
      type: "tool",
      text: "Edit",
      path: "src/a.ts",
      args: {
        file_path: "src/a.ts",
        old_string: "a\nb\nc",
        new_string: "a\nB\nc\nd",
      },
    },
    zh,
  );
  assert.equal(r.verb, "编辑文件");
  assert.equal(r.primary, "a.ts");
  assert.equal(r.added, 2);
  assert.equal(r.removed, 1);
});

test("Grep：模式为主文本，路径为次要", () => {
  const r = classifyTool(
    { type: "tool", text: "Grep", args: { pattern: "TODO", path: "src" } },
    zh,
  );
  assert.equal(r.verb, "搜索");
  assert.match(r.primary, /TODO/);
  assert.equal(r.secondary, "src");
});

test("WebFetch：域名为主文本", () => {
  const r = classifyTool(
    { type: "tool", text: "WebFetch", args: { url: "https://example.com/a/b?x=1" } },
    zh,
  );
  assert.equal(r.kind, "web");
  assert.equal(r.primary, "example.com/a/b");
});

test("TodoWrite：任务条数与进行中项", () => {
  const r = classifyTool(
    {
      type: "tool",
      text: "TodoWrite",
      args: {
        todos: [
          { content: "读配置", status: "completed" },
          { content: "改启动类", status: "in_progress" },
        ],
      },
    },
    zh,
  );
  assert.equal(r.kind, "todo");
  assert.equal(r.primary, "2 项任务");
  assert.equal(r.secondary, "进行中：改启动类");
});

test("未知工具：动词回退为工具名，参数里的 path 仍能当次要文本", () => {
  const r = classifyTool(
    { type: "tool", text: "SomeUnknownTool", path: "src/x.ts", args: { a: 1 } },
    zh,
  );
  assert.equal(r.verb, "SomeUnknownTool");
  assert.equal(r.primary, "src/x.ts");
});

test("英文环境下动词切换", () => {
  const r = classifyTool(
    { type: "tool", text: "Bash", args: { command: "ls -la" } },
    { locale: "en-US" },
  );
  assert.equal(r.verb, "Run command");
});

test("formatResult：stdout/stderr 包装、is_error、字符串", () => {
  assert.deepEqual(formatResult({ stdout: "ok", stderr: "" }), { text: "ok", isError: false });
  assert.deepEqual(formatResult({ stderr: "boom" }), { text: "boom", isError: true });
  assert.deepEqual(formatResult({ is_error: true, stdout: "denied" }), {
    text: "denied",
    isError: true,
  });
  assert.deepEqual(formatResult("  hello  "), { text: "hello", isError: false });
  assert.equal(formatResult(null), null);
  assert.equal(formatResult("   "), null);
});

test("classifyItems：计数、状态、错误标记、思考块保序", () => {
  const items = [
    { type: "thinking", text: "先看配置" },
    { type: "tool", text: "Read", path: "a.yml", result: { stdout: "x" } },
    { type: "tool", text: "Bash", args: { command: "ls" }, result: { stderr: "fail" } },
    { type: "tool", text: "Bash", args: { command: "pwd" } },
  ];
  const out = classifyItems(items, zh, { live: true });
  assert.equal(out.total, 3);
  assert.equal(out.done, 2);
  assert.equal(out.errors, 1);
  assert.equal(out.rows.length, 4);
  assert.equal(out.rows[0].kind, "thinking");
  assert.equal(out.rows[1].status, "done");
  assert.equal(out.rows[2].status, "error");
  assert.equal(out.rows[3].status, "running");
});

test("classifyItems：卡片已结束但工具没有 result 时视为完成", () => {
  const out = classifyItems(
    [{ type: "tool", text: "Read", path: "a.yml" }],
    zh,
    { live: false },
  );
  assert.equal(out.rows[0].status, "done");
  assert.equal(out.done, 1);
});

test("classifyItems：并行工具整批标进行中（不止最后一个）", () => {
  const items = [
    { type: "thinking", text: "同时读三个文件" },
    { type: "tool", text: "Read", path: "a.yml", result: { stdout: "a" } },
    { type: "tool", text: "Read", path: "b.yml" },
    { type: "tool", text: "Read", path: "c.yml" },
  ];
  const out = classifyItems(items, zh, { live: true });
  assert.equal(out.rows[1].status, "done");
  assert.equal(out.rows[2].status, "running");
  assert.equal(out.rows[3].status, "running");
  assert.equal(out.done, 1);
  assert.equal(out.total, 3);
});

test("classifyItems：本轮已结束，未拿到 result 的工具回落为完成", () => {
  const out = classifyItems(
    [
      { type: "tool", text: "Read", path: "a.yml", result: { stdout: "a" } },
      { type: "tool", text: "Read", path: "b.yml" },
    ],
    zh,
    { live: false },
  );
  assert.equal(out.rows[1].status, "done");
  assert.equal(out.done, 2);
});

test("空白工具名不会崩", () => {
  const r = classifyTool({ type: "tool", text: "" }, zh);
  assert.equal(r.verb, "工具调用");
  assert.equal(r.primary, "");
});
