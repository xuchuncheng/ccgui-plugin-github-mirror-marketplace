# 社区插件市场镜像加速（github-mirror-marketplace）

CC GUI 插件（Tier-1 JS）：解决**国内网络下访问 GitHub 静态资源被拦截、内置插件市场打不开**的问题。

## 要解决的问题

宿主内置插件市场通过 GET 抓取：

```
https://raw.githubusercontent.com/zhukunpenglinyutong/ccgui-plugins/main/community-plugins.json
```

`raw.githubusercontent.com` 常被国内企业内网 / 防火墙拦截，导致请求失败：

```
error sending request for url ...
```

于是整个插件市场不可用。

## 本插件做什么

在右侧新增「社区市场」面板，**另起一条弹性抓取链**把同一份 `community-plugins.json` 抓到手并展示，绕开内置那次失败：

1. **备用地址自动回退**（任一拿到「2xx + JSON 可解析 + 结构像清单」即停，其余静默跳过并记录原因）：
   - 主：`https://raw.githubusercontent.com/.../community-plugins.json`
   - 备：`https://cdn.jsdelivr.net/gh/.../community-plugins.json`（JsDelivr CDN）
   - 镜像：`ghproxy` 系前缀包裹主地址（面板内可增删，默认 `https://ghproxy.net/`、`https://gh-proxy.com/`）
2. **HTTP 请求配置**：自定义 `User-Agent`（Chrome/120）、单端点 **10s 超时**；**尽力强制 HTTP/1.1**（先带 `version:"HTTP/1.1"` 试，bridge 不认该字段则自动退回不带再试）。
3. **离线缓存**：抓取结果存插件私有 KV，宿主市场彻底挂掉时仍能看上次列表。
4. **一键下载安装**：对某插件，沿同一回退链下载 `manifest.json`/`main.js`（`styles.css` 可选），经 PowerShell 写入 `~/.ccgui-next/plugins/<id>/`，并**备份后**把启用项并入 `~/.ccgui-next/plugins.json`；任一步失败自动还原 `plugins.json`。

## ⚠️ 能力边界（务必知悉）

- **宿主内置市场那一次抓取发生在 Rust 后端（reqwest），JS 插件拦不到、也改不了它**——所以本插件不去"劫持/修复"内置市场，而是**独立抓一份给你用**。你要求的 reqwest 级 TLS/HTTP1.1 调参，插件层面无法施加到宿主那次请求。
- **一键安装的"启用"依赖宿主是否热重载第三方插件**：文件写入与 `plugins.json` 注册是确定的，但**新插件是否即时生效未知**。若面板显示已安装却没立刻出现，请**重启 / 重载 CC GUI**。
- 下载/写盘依赖系统 `powershell`（Windows 自带）。非 Windows 需改用对应命令。
- 所有文件内容与路径均以 **base64 经环境变量**传入 PowerShell 脚本再解码，绝不拼进命令行 → 无命令注入。

## 其他功能

- **客户端更新镜像检查**：宿主内置"检查更新"直连 github.com（国内必超时）。本插件在同一面板用镜像链读取 updater 的 latest.json，发现新版可一键经镜像**断点续传**下载官方安装包到 `~/.ccgui-next/downloads/`，由你双击安装（不静默安装）。
- **内置市场页引导卡（默认关闭）**：设置项「内置市场页引导卡」开启后，才会在内置市场加载失败处注入一张跳转引导卡（该功能读取宿主界面文本定位，故默认关、需显式开启）。

## 权限

- `ui:panel-tab`：注册右侧「社区市场」标签页。
- `storage`：缓存插件列表与镜像偏好到插件私有 KV。
- `exec:powershell`：写入本地插件目录、备份并改写 `plugins.json`（仅安装动作触发）。

## 安装（本地）

CC GUI → 设置 → 插件 → 从本地目录安装，指向本目录（含 `manifest.json`）。
或把本目录复制到 `~/.ccgui-next/plugins/github-mirror-marketplace/` 并在 `plugins.json` 登记后重启。

## 开发与测试

纯逻辑（回退链、状态/结构判定、列表归一化、下载端点构造、注册补丁）抽在 `core.js`，用 `node:test` 单测：

```bash
node --test "test/*.test.js"   # 18 项，全绿
```

> `main.js` 内联了与 `core.js` 相同的纯函数（运行时禁止 import 外部模块）。改动纯逻辑请两处同步，并以 `core.test.js` 为准。
