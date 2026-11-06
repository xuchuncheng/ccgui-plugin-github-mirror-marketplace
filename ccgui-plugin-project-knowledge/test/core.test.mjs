// 项目知识插件核心逻辑测试（node --test，不依赖宿主）
//
// 这里用「最小化宿主桩」把 main.js 的 activate() 跑起来，验证三条业务规则：
//   1) 只有「加入上下文」的条目不注入，移出后立即不带；
//   2) 挂载按会话（engine + sessionId）隔离；
//   3) 新建会话（sessionId=null）期间的挂载在会话建立后自动并入该会话。
//
// 运行：cd ccgui-plugin-project-knowledge && node --test test/

import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const mainPath = path.join(here, "..", "main.js");

// React 的最小替身：只补齐 activate() 里用到的 hooks 与 createElement。
// 组件本身不在本测试范围内（由预览页做视觉验收），这里只驱动数据层。
function fakeReact() {
  const noop = () => {};
  return {
    createElement: function () { return null; },
    useState: (init) => [typeof init === "function" ? init() : init, noop],
    useEffect: noop,
    useRef: (v) => ({ current: v }),
    useMemo: (fn) => fn(),
    useCallback: (fn) => fn,
    useSyncExternalStore: (sub, get) => get(),
  };
}

function makeCtx(initial) {
  const listeners = new Map();
  const state = { data: initial ? JSON.parse(JSON.stringify(initial)) : null, hooks: null, writes: 0, drafts: [] };
  const ctx = {
    pluginId: "project-knowledge",
    version: "0.1.0",
    react: fakeReact(),
    host: { appVersion: "1.1.9", sdkVersion: "0.3.25", locale: "zh-CN", isWeb: false },
    storage: {
      get: async () => (state.data ? JSON.parse(JSON.stringify(state.data)) : null),
      set: async (_k, v) => { state.data = JSON.parse(JSON.stringify(v)); state.writes++; },
      delete: async () => { state.data = null; },
    },
    events: {
      on: (topic, cb) => {
        if (!listeners.has(topic)) listeners.set(topic, []);
        listeners.get(topic).push(cb);
        return () => {
          const arr = listeners.get(topic) || [];
          const i = arr.indexOf(cb);
          if (i >= 0) arr.splice(i, 1);
        };
      },
      emit: () => {},
    },
    hooks: { registerTurnHooks: (hooks) => { state.hooks = hooks; return () => { state.hooks = null; }; } },
    ui: { registerPanelTab: () => () => {}, registerComposerStatusItem: () => () => {} },
    composer: { setDraft: (t) => state.drafts.push(t) },
    sessions: {
      startRun: async (def) => ({ runId: "r1", sessionId: "s-" + def.engine }),
      selectSession: async () => {},
    },
  };
  function fire(topic, payload) {
    (listeners.get(topic) || []).forEach((fn) => fn(payload));
  }
  return { ctx, state, fire };
}

async function loadPlugin() {
  const mod = await import(pathToFileURL(mainPath).href + "?t=" + Math.random());
  return mod.default;
}

async function contextText(harness, engine, sessionId, ws) {
  const res = await harness.state.hooks.beforeTurn({
    runId: "run",
    turnId: "turn",
    engine,
    sessionId,
    workspace: { path: ws },
    occurredAt: new Date().toISOString(),
  });
  if (!res || !res.promptContributions || !res.promptContributions.length) return "";
  return res.promptContributions.map((c) => c.content).join("\n");
}

const WS = "D:/work_space/demo";

function seed() {
  return {
    version: 1,
    knowledge: {
      [WS]: {
        notes: [
          { id: "n1", text: "笔记一", createdAt: 1, updatedAt: 2 },
          { id: "n2", text: "笔记二", createdAt: 1, updatedAt: 3 },
        ],
        todos: [{ id: "t1", text: "待办一", done: false, createdAt: 1, updatedAt: 1 }],
        plan: "# 计划正文",
        planUpdatedAt: 5,
      },
    },
    mounts: {},
  };
}

test("未挂载时 beforeTurn 不产生任何供献", async () => {
  const activate = await loadPlugin();
  const harness = makeCtx(seed());
  activate(harness.ctx);
  harness.fire("session://activated", { engine: "claude", sessionId: "S1" });
  assert.equal(await contextText(harness, "claude", "S1", WS), "");
});

test("挂载的笔记/待办/计划会注入，未挂载的不注入", async () => {
  const data = seed();
  data.mounts["s:claude/S1"] = { items: [{ kind: "note", ws: WS, id: "n2" }, { kind: "plan", ws: WS, id: "plan" }] };
  const activate = await loadPlugin();
  const harness = makeCtx(data);
  activate(harness.ctx);
  harness.fire("session://activated", { engine: "claude", sessionId: "S1" });

  const text = await contextText(harness, "claude", "S1", WS);
  assert.match(text, /笔记二/);
  assert.match(text, /# 计划正文/);
  assert.doesNotMatch(text, /笔记一/);
  assert.doesNotMatch(text, /待办一/);
});

test("不同会话的挂载互相隔离", async () => {
  const data = seed();
  data.mounts["s:claude/S1"] = { items: [{ kind: "note", ws: WS, id: "n1" }] };
  const activate = await loadPlugin();
  const harness = makeCtx(data);
  activate(harness.ctx);

  assert.match(await contextText(harness, "claude", "S1", WS), /笔记一/);
  assert.equal(await contextText(harness, "claude", "S2", WS), "");
  assert.equal(await contextText(harness, "codex", "S1", WS), "");
});

test("新建会话期间的挂载在会话建立后并入该会话", async () => {
  const data = seed();
  // 面板在 sessionId=null 时写入的 pending 桶（引擎 + 工作区）
  data.mounts["p:claude@" + WS] = { items: [{ kind: "todo", ws: WS, id: "t1" }] };
  const activate = await loadPlugin();
  const harness = makeCtx(data);
  activate(harness.ctx);

  harness.fire("session://activated", { engine: "claude", sessionId: "S3" });
  await new Promise((r) => setTimeout(r, 20));

  const text = await contextText(harness, "claude", "S3", WS);
  assert.match(text, /待办一/);
  assert.ok(harness.state.data.mounts["s:claude/S3"], "挂载应迁移到会话桶");
  assert.equal(harness.state.data.mounts["p:claude@" + WS], undefined, "pending 桶应被清空");
});

test("工作区路径写法不同（反斜杠/尾斜杠/盘符小写）也能对上同一个会话", async () => {
  const data = seed();
  data.mounts["p:claude@D:/work_space/demo"] = { items: [{ kind: "note", ws: WS, id: "n1" }] };
  const activate = await loadPlugin();
  const harness = makeCtx(data);
  activate(harness.ctx);

  // beforeTurn 带的是另一种写法：尾斜杠 + 反斜杠 + 小写盘符
  const text = await contextText(harness, "claude", "S5", "d:\\work_space\\demo\\");
  assert.match(text, /笔记一/);
});

test("不同工作区的 pending 挂载不会互相串味", async () => {
  const data = seed();
  data.knowledge["D:/work_space/other"] = { notes: [{ id: "o1", text: "别的项目笔记", createdAt: 1, updatedAt: 1 }], todos: [], plan: "", planUpdatedAt: 0 };
  data.mounts["p:claude@D:/work_space/other"] = { items: [{ kind: "note", ws: "D:/work_space/other", id: "o1" }] };
  const activate = await loadPlugin();
  const harness = makeCtx(data);
  activate(harness.ctx);

  const text = await contextText(harness, "claude", "S6", WS);
  assert.doesNotMatch(text, /别的项目笔记/);
  assert.ok(harness.state.data.mounts["p:claude@D:/work_space/other"], "别的项目的 pending 必须原样保留");
});

test("条目被删除后即使有挂载记录也不再注入", async () => {
  const data = seed();
  data.mounts["s:claude/S1"] = { items: [{ kind: "note", ws: WS, id: "n-gone" }] };
  const activate = await loadPlugin();
  const harness = makeCtx(data);
  activate(harness.ctx);
  harness.fire("session://activated", { engine: "claude", sessionId: "S1" });
  assert.equal(await contextText(harness, "claude", "S1", WS), "");
});

test("超长内容按预算截断并给出说明，不超宿主 12KB 上限", async () => {
  const data = seed();
  data.knowledge[WS].notes = [{ id: "big", text: "长".repeat(12000), createdAt: 1, updatedAt: 1 }];
  data.mounts["s:claude/S1"] = { items: [{ kind: "note", ws: WS, id: "big" }] };
  const activate = await loadPlugin();
  const harness = makeCtx(data);
  activate(harness.ctx);
  harness.fire("session://activated", { engine: "claude", sessionId: "S1" });

  const text = await contextText(harness, "claude", "S1", WS);
  const bytes = new TextEncoder().encode(text).length;
  assert.ok(bytes > 0 && bytes <= 12 * 1024, `贡献体应落在 12KB 预算内，实际 ${bytes}`);
});
