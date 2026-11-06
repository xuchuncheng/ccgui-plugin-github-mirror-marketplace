# 便签会话查询（note-query）v0.2

CC GUI（ccgui-next）Tier-1 JS 插件：给会话贴**结构化便签**，集中存储、按工作区加载、
一键定位回会话、支持跨工作区移动。

## v0.2 变化（重要）

- **存储改为中央统一**：全部便签存
  `~/.ccgui-next/plugin-data/note-query/notes.json`（不再散落在各工作区 `.ccgui/`）。
- **归属工作区经宿主 `app.db` 权威解析**：添加便签时按 sessionId 查 sessions 表得到真实
  工作区，彻底消除「存错位置」。
- **首次启动自动迁移**：合并历史散落的各工作区 `.ccgui/notes.json` → 中央文件，
  并纠正错位便签；原文件改名 `notes.json.migrated.bak` 保留。
- **按工作区加载**：便签栏默认只显示当前工作区的便签，勾选「全部工作区」可看全量
  （卡片带 📁 工作区徽章）。
- **移动便签**：编辑弹窗新增「归属工作区」下拉（宿主登记的全部工作区），改选即迁移。

## 功能

- 右键会话 →「添加便签」：标题（必填）/时间（默认今天）/业务/归属模块/会话标题/详情；
  业务与模块可手输新值也可下拉历史。
- 便签栏：名称模糊检索（含会话标题）、按日期(日)、按业务/模块下拉筛选，AND 组合。
- 点击便签 → `selectSession` 定位 + `session://activated` 回执确认 + React fiber
  按复合会话 ID 精确锚定侧栏行挂跑马灯线框；确认失败则提示并把 sessionId 复制到剪贴板。

## 安装 / 迭代 / 卸载

1. 侧栏「插件」→「从本地目录安装」→ 选本目录；权限弹窗放行（含 `exec:python3`）。
2. 改代码后重新安装即热重载；或在插件页关→开该插件。
3. 便签数据在 `~/.ccgui-next/plugin-data/note-query/`，卸载重装不丢。

## 前置条件与已知限制

- 本机 `python3` 须在 GUI 进程 PATH 中（报 binary not found 时把 Python 目录加系统 PATH 后重启 GUI）。
- 依赖宿主 `app.db`（sessions/workspaces 表）只读查询做权威解析；宿主大改版若改表结构，
  解析会回落为「当前活动工作空间」，不会崩。
- 诊断日志：`~/.ccgui-next/plugin-data/note-query/note-query-diag.log`（DevTools 打不开时看这个）。

## 权限清单

`ui:session-menu` `ui:panel-tab` `ui:overlay` `host:session` `exec:python3`
`theme` `events` `workspace.metadata.read`

## 文件

- `manifest.json` / `main.js`（单文件 ESM，零 import）
- 架构与实现方案（350 行设计文档）属开发资料，未随本仓库分发

## 许可

MIT
