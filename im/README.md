# 内网吹水 IM

浏览器直接访问的内网即时通讯,零客户端、零独立数据库。

## 部署(3 步)

1. 装 Node.js 18+(内网机器任选一台,你自己的电脑也行)。
2. 在本目录执行 `npm install`。
3. 启动:`npm start`(默认端口 3000,可用 `PORT=8080 npm start` 改端口)。

看到 `内网 IM 已启动: http://localhost:3000` 即成功。

> 提示:在 Windows PowerShell 里改端口写法不同,用 `$env:PORT=8080; npm start`。
> 上面的 `PORT=8080 npm start` 适用于 bash / macOS / Linux。

## 使用

- 本机:`http://localhost:3000`
- 同事:`http://<这台机器的内网IP>:3000`(IP 用 `ipconfig` 查)
- 打开网页输入昵称即可聊天、发图片。

## 数据

全部数据在本目录的 `im.db`(消息/用户)和 `uploads/`(图片)。
备份 = 停服后拷贝这两个;迁移 = 换机器后同样拷贝。

## 运维(可选)

保持后台常驻:`npm i -g pm2 && pm2 start src/server.js --name im`
开机自启、崩溃自动重启由 pm2 负责。

## 开发

- 跑测试:`npm test`
- 防火墙需放行所用端口(Windows 入站规则)。

## 常见问题 / 离线部署

### `npm install` 卡在 better-sqlite3 报错

本项目的 `im.db` 存储依赖 `better-sqlite3`,它需要下载一个**原生二进制**(不是纯 JS)。
仓库自带的 `.npmrc` 已把这个二进制的下载地址指向公共镜像 `registry.npmmirror.com`:

```
better_sqlite3_binary_host=https://registry.npmmirror.com/-/binary/better-sqlite3
```

**这个镜像是公网地址,只有在能访问 `registry.npmmirror.com` 的机器上才有效。**
如果部署目标是一台完全断外网的内网服务器,`npm install` 仍会失败(拉不到二进制)。
两种解决办法,任选其一:

- **办法一(推荐,最省事):联网机器装好再整体拷过来。**
  在一台能上网、且系统/Node 版本与目标服务器一致的机器上,用本项目自带的 `.npmrc`
  正常执行 `npm install`,确认能 `npm start` 跑起来后,把**整个 `im/` 目录(含 `node_modules/`)**
  一起拷贝到内网服务器,直接 `npm start` 即可,无需在内网机上再 `npm install`。
  (注意:`node_modules` 里的原生二进制与操作系统/CPU 架构绑定,源机和目标机要同为 Windows x64 或同为 Linux x64。)

- **办法二:把 `.npmrc` 指向内网自己的镜像。**
  如果内网有私有 npm 源(如 Nexus / Verdaccio / 内网 npmmirror),编辑本目录 `.npmrc`,
  将 `better_sqlite3_binary_host` 及 registry 改为内网可达的地址后再 `npm install`。

> 数据文件 `im.db`、`im.db-shm`、`im.db-wal` 和 `uploads/` 已被 `.gitignore` 忽略,
> 不会被纳入版本库;首次启动会自动建库并创建一个默认群,无需手动初始化。

### 同事打不开页面 / 连不上

几乎都是**防火墙**问题:Windows 默认拦截外部对 3000 端口的入站连接。
需要在这台服务器上放行所用端口:
「Windows 安全中心 → 防火墙和网络保护 → 高级设置 → 入站规则 → 新建规则 → 端口 → TCP → 特定本地端口(如 3000)→ 允许连接」。
换了 `PORT` 就放行对应的端口。放行后同事用 `http://<内网IP>:<端口>` 即可访问。
