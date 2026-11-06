# 提示词优化器（prompt-optimizer）

CC GUI（ccgui-next）Tier-1 JS 插件。把 [prompt-optimizer](https://github.com/linshenkx/prompt-optimizer)
v2.13.0 的**元提示词模板**搬进 CC GUI：输入框旁点 ✨ 弹出优化对话框，写回输入框即关闭。

## 模板库

完整移植官方 **41 个提示词模板**，分四大类、15 个子模式：

| 大类 | 子模式 |
|---|---|
| **基础** | 系统提示词优化 · 用户提示词优化 · 迭代优化 · 提示词评估 |
| **上下文** | 用户提示词优化 · 多消息优化 · 迭代优化 · 提示词评估 |
| **图像** | 文生图 · 图生图 · 多图生图 · 迭代优化 · 提示词评估 |
| **变量** | 变量抽取 · 变量值生成 |

另含 OpenClaw SOUL 结构化模板（`soul-openclaw-compose` / `soul-hermes-compose` / `soul-iterate`）。
每个模板都带中英两版正文，跟随宿主语言切换。

## 交互

- **输入框 ✨ 按钮**（`ui:composer-status` 的 `cliMenu` 槽位）→ 打开遮罩弹窗。
- **命令面板**：搜「提示词」「optimize」也能打开。
- 弹窗两个页签：**运行**（选模式 → 选脚本 → 填输入 → 出结果）与**脚本库**（只读卡片视图）。
- 结果可 **复制** / **写回输入框**（发不发送永远由你决定）/ **以此为基准迭代** / **应用变量到原文**。
- 有「历史」区记住最近的运行记录。

## 后端三种模式

设置 → 插件 → 提示词优化器 → **后端**：

| 模式 | 说明 |
|---|---|
| `auto`（默认，推荐） | 跟随 CLI：读 `~/.claude/settings.json`，经 cc-switch 本地代理出网 |
| `api` | 手填 OpenAI 兼容端点（Base URL + Key + 模型名） |
| `engine` | 走宿主引擎（会残留会话） |

`auto`/`api` 都可以点「测试连通」当场验证。直连模式下 Base URL 的域名必须在 manifest 的
`network:` 白名单里，否则会被拦并提示需要补哪个域名。

> 部分网关（如 `token.longshine.com`）缺 `User-Agent` 会直接 403「不支持当前工具」，而宿主
> `plugin_http_request` 底层不带 UA，插件已显式补上。

## 脚本库

- 默认由内置 41 个模板生成，落在 `<软件数据目录>/plugin-data/prompt-optimizer/scripts.json`。
- 设置页 → **脚本库维护** 里可新建 / 编辑 / 删除 / 导入导出 JSON / 恢复默认。
- 升级后新增的模板会自动补进脚本库，**已改过的条目一律保留你的版本**。
- 写库带 CAS 版本令牌；检测到外部改过会重载磁盘版并提示，不会静默覆盖。

## 已知边界

- 优化质量取决于所选模板与模型；插件只负责把模板与上下文拼好送出去。
- `engine` 模式会在宿主里留下可见会话记录，介意就用 `auto`。
- 模板正文版权归 [prompt-optimizer](https://github.com/linshenkx/prompt-optimizer) 原作者，见下方许可。

## 权限

`ui:composer-status` `ui:overlay` `ui:command` `ui:settings-section` `composer:draft` `events`
`storage` `plugin.storage` `theme` `agent` `workspace.metadata.read`
`network:`（7 个直连端点 + `127.0.0.1`）`exec:cmd` `exec:python3`

## 安装 / 更新 / 卸载

- **安装**：CC GUI → 设置 → 插件 → 「从本地目录安装」→ 选中本目录（含 `manifest.json` 这一层）。
- **更新**：覆盖 `main.js` / `manifest.json` 后重新走一遍「从本地目录安装」即可热重载。
- **卸载**：插件页该行点卸载。脚本库文件留在 `plugin-data` 里，重装不丢。

## 文件

```
main.js        # 单文件自包含（无 import / 无 JSX / 无 eval），模板库 + UI 全在内
manifest.json
```

## 许可

模板正文（`main.js` 中的 `TEMPLATES`）取自
[prompt-optimizer](https://github.com/linshenkx/prompt-optimizer)，遵循 **AGPL-3.0**
（Copyright prompt-optimizer contributors）。本插件整体按 AGPL-3.0 分发，见 `LICENSE`。
