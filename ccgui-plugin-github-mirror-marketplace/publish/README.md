# 发布物料（上架官方市场用）

- `push.sh` —— 在能访问 GitHub 的机器上，进入**仓库根目录**（本目录的上级）执行：
  `GH_TOKEN=<你的PAT> bash publish/push.sh`（自动 init/commit/push main/打 tag 1.1.0）
- `github-mirror-marketplace.json` —— 提 PR 时原样放入索引仓 `plugins/github-mirror-marketplace.json`
- `community-plugins.snippet.json` —— 内容按 id 字典序插入索引仓 `community-plugins.json`（在 file-drag-upload 与 font-tuner 之间）

⚠️ 两个 sha256 与当前 main.js / manifest.json 绑定：改过这两个文件后须重新计算并更新
`github-mirror-marketplace.json`（`sha256sum main.js manifest.json`）。

推送后记得在仓库 Releases 页给 tag `1.1.0` 上传附件 `main.js`、`manifest.json`。
