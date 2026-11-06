#!/usr/bin/env bash
# 把提示词优化器插件发布到 GitHub 仓库 xuchuncheng/ccgui-plugin-prompt-optimizer。
# 在能访问 GitHub 的机器上，于插件仓库根目录（含 manifest.json 的那层）运行：
#
#   GH_TOKEN=<你的PAT> bash publish/push.sh
#
# 国内网络可加代理前缀：GH_PROXY=https://ghproxy.net/ bash publish/push.sh
set -euo pipefail
REPO="xuchuncheng/ccgui-plugin-prompt-optimizer"
VERSION="$(node -p "require('./manifest.json').version")"
: "${GH_TOKEN:?请先 export GH_TOKEN=<你的 GitHub PAT>}"

# 切到仓库根（本脚本在 publish/ 里）
cd "$(dirname "$0")/.."

BASE="${GH_PROXY:-}https://github.com/${REPO}.git"

rm -rf .git
git init -q
git config user.name "xuchuncheng"
git config user.email "xuchuncheng@users.noreply.github.com"

# 只发布运行期文件
git add manifest.json main.js README.md LICENSE
git commit -q -m "feat: 提示词优化器 v${VERSION}"
git branch -M main

git remote add origin "https://xuchuncheng:${GH_TOKEN}@${BASE#https://}"
git push -u origin main --force

# tag 必须 == manifest version（无 v 前缀），市场按它找 Release
git tag -f "$VERSION"
git push -f origin "$VERSION"

# 抹掉带 token 的 remote，防泄露在 .git/config
git remote set-url origin "https://github.com/${REPO}.git"

echo "✅ 已推送 main + tag $VERSION。"
echo "下一步：到 Releases 页给 tag $VERSION 上传附件 main.js / manifest.json："
echo "  https://github.com/${REPO}/releases/new?tag=${VERSION}"
