# Claude 笑脸图标 + XoCodeX（claude-smiley-icon）

CC GUI（ccgui-next）Tier-1 JS 插件，纯界面换肤：把 Claude Code 的品牌标换成笑脸、文字换成
**XoCodeX**，顺手把侧栏和输入框底栏精简掉。

## 做了什么

| # | 改造 | 实现位置 |
|---|---|---|
| 1 | 把代表 Claude Code 的品牌标（`<img alt="Claude">`）换成珊瑚色笑脸 SVG | `main.js` |
| 2 | 把界面上所有「Claude Code」文字替换为「XoCodeX」 | `main.js` |
| 3 | 隐藏侧栏会话行左侧的引擎头像 | `styles.css` |
| 4 | 输入框底栏精简成「🇨🇳 + 模型 · 思考等级」 | `styles.css` |
| 5 | 输入框常态描边染成亮青蓝，聚焦时更亮并带柔光 | `styles.css` |

第 3 条的副作用值得先说：侧栏看不到笑脸了，笑脸仍出现在**输入框引擎选择器、会话页签**等位置。

## 为什么图标替换走 JS 而不是纯 CSS

宿主把插件 `styles.css` 强制包进最低优先级的层：

```css
@layer ccgui-plugins, theme, base, components, utilities;
```

层叠层优先级压过选择器特异性，Tailwind 的 `size-*` 工具类在最高层 `utilities`，会盖掉 CSS 对
`<img>` 的尺寸/显示设置——表现是「替换了但显示不全，看着像没生效」。所以图标与文字替换由 `main.js`
直接改 DOM，不受层叠影响。

反过来，第 4、5 条这类纯装饰必须用 `!important`：它会反转层优先序（低层的 `!important` 胜过高层的
普通声明），和官方已上架的 `composer-rainbow-border` 用的是同一招。

## 稳定性

- 全部改动走 `MutationObserver`：激活时全量扫一遍，之后宿主/React 每次重渲染把内容写回原样时就地改回。
- 幂等标记：`<img>` 上打 `data-ccgui-smiley`，避免重复处理。
- **跳过 `input` / `textarea` / `contenteditable`**，绝不碰用户正在输入的编辑区。
- 卸载时 `observer.disconnect()`，不留残留。

## 已知边界

- 第 2 条的替换是**文本级全量替换**：任何地方出现「Claude Code」都会变成「XoCodeX」，包括你自己在
  非编辑区里写下的文案。编辑区不受影响。
- 第 3、4 条依赖宿主的 DOM 结构（`aside` + `pl-9` 行锚点、`cli-menu.tsx` 的按钮类名组合）。宿主大版本
  改版后可能失效——表现仅为「样式没变」，不影响功能。
- 想要回国旗以外的底栏样式，改 `styles.css` 顶部的 CSS 变量即可。

## 权限

`permissions: []`——不读写文件、不联网、不起进程，只操作页面 DOM 与样式。

## 安装 / 更新 / 卸载

- **安装**：CC GUI → 设置 → 插件 → 「从本地目录安装」→ 选中本目录（含 `manifest.json` 这一层）。
- **更新**：覆盖 `main.js` / `styles.css` 后重新走一遍「从本地目录安装」即可热重载（同 id 覆盖）。
- **卸载**：插件页该行点卸载。

## 文件

```
main.js        # 笑脸图标 + XoCodeX 文字替换（MutationObserver）
styles.css     # 侧栏头像隐藏 / 输入框底栏精简 / 描边
manifest.json
```

## 许可

MIT
