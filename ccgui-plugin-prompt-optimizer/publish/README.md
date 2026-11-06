# 发布物料（上架社区市场用）

- `push.sh` —— 在能访问 GitHub 的机器上，进入**插件根目录**（本目录的上级）执行：
  - `GH_TOKEN=<PAT> bash publish/push.sh`
  - 国内网络：`GH_TOKEN=<PAT> GH_PROXY=https://ghproxy.net/ bash publish/push.sh`
  自动 init / commit / push `main` / 打 tag（tag == manifest.version）。
- `community-plugins.snippet.json` —— 5 字段条目，按 `id` 字典序插入索引仓
  `zhukunpenglinyutong/ccgui-plugins` 的 `community-plugins.json`。
- `prompt-optimizer.json` —— 完整条目（含 `sha256`），放入索引仓 `plugins/prompt-optimizer.json`
  时使用。**改过 main.js / manifest.json 后必须重算 sha256**：

```bash
sha256sum main.js manifest.json
```

推送后到 Releases 页给 tag 上传附件 `main.js`、`manifest.json`。
