#!/usr/bin/env bash
# 把插件发布到 GitHub 仓库 xuchuncheng/ccgui-plugin-github-mirror-marketplace。
# 在【能访问 GitHub】的机器上，于插件仓库根目录（含 manifest.json 的那层）运行：
#
#   GH_TOKEN=<你的PAT> bash publish/push.sh
#
# PAT 申请：github.com → Settings → Developer settings → Fine-grained tokens
#           Repository access 选本仓库，Permissions 勾 Contents: Read and write。
#           切勿使用明文密码（GitHub 已停用密码推送）。
set -euo pipefail
REPO="xuchuncheng/ccgui-plugin-github-mirror-marketplace"
VERSION="1.1.0"
: "${GH_TOKEN:?请先 export GH_TOKEN=<你的 GitHub PAT>}"

# 切到仓库根（本脚本在 publish/ 里）
cd "$(dirname "$0")/.."

# 只发布运行期文件 + 仓库必备文件；core.js/test 属开发文件，不入库
rm -rf .git
git init -q
git config user.name "xuchuncheng"
git config user.email "xuchuncheng@users.noreply.github.com"

git add manifest.json main.js README.md LICENSE docs/icon.svg
git commit -q -m "feat: 社区插件市场镜像加速 v$VERSION"
git branch -M main

git remote add origin "https://xuchuncheng:${GH_TOKEN}@github.com/${REPO}.git"
git push -u origin main

# tag 必须 == manifest version（无 v 前缀），市场按它找 Release
git tag "$VERSION"
git push origin "$VERSION"

# 抹掉带 token 的 remote，防泄露在 .git/config
git remote set-url origin "https://github.com/${REPO}.git"

echo "✅ 已推送 main + tag $VERSION。"
echo "下一步：到 Releases 页给 tag $VERSION 上传附件 main.js / manifest.json："
echo "  https://github.com/${REPO}/releases/new?tag=${VERSION}"
