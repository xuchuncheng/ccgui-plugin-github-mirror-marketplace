#!/usr/bin/env bash
# 在【能访问 GitHub】的机器上运行。先把本目录 cd 进来。
# 用法： GH_TOKEN=你的PAT  ./push.sh
#   PAT 申请：github.com → Settings → Developer settings → Fine-grained tokens
#            或 classic token，勾选 repo 权限。切勿用明文密码。
set -euo pipefail
REPO="xuchuncheng/ccgui-plugin-github-mirror-marketplace"
VERSION="1.1.0"
: "${GH_TOKEN:?请先 export GH_TOKEN=<你的 GitHub PAT>}"

git init -q
git config user.name "xuchuncheng"
git add -A
git commit -q -m "feat: 社区插件市场镜像加速 v$VERSION"
git branch -M main

# 若仓库已在 GitHub 建好（空仓库），直接推：
git remote add origin "https://xuchuncheng:${GH_TOKEN}@github.com/${REPO}.git" 2>/dev/null || \
git remote set-url origin "https://xuchuncheng:${GH_TOKEN}@github.com/${REPO}.git"
git push -u origin main

# 打 tag（必须 == manifest version，无 v 前缀）
git tag "$VERSION"
git push origin "$VERSION"
echo "已推送 main + tag $VERSION。接着到 Release 页面上传附件 main.js / manifest.json。"
