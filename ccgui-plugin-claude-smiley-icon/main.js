/*
 * Claude 笑脸图标 + XoCodeX 文字 —— CC GUI 插件逻辑（Tier-1 JS）
 *
 * 为什么图标也放这里而不是纯 CSS：
 *   宿主把插件 styles.css 强制包进最低优先级层 @layer ccgui-plugins，Tailwind
 *   的 size-* 工具类在最高层 utilities，会盖掉 CSS 对 <img> 的尺寸/显示设置，
 *   导致 content 替换在部分位置（如 18px 的下拉图标）显示不全、看着像没生效。
 *   main.js 直接改 DOM，不受 CSS 层叠影响，最稳。
 *
 * 三件事（前两件在 main.js，第三件在 styles.css）：
 *   1) 把代表 Claude Code 的品牌标（<img alt="Claude">）换成笑脸 SVG。
 *   2) 把界面上所有「Claude Code」文字替换为「XoCodeX」。
 *   3) styles.css 里另做两处纯视觉改造：隐藏侧栏会话行左侧的引擎头像
 *      （v1.2.0），输入框底栏精简成「中国国旗 + 模型 · 思考等级」（v1.4.0）。
 *      前者让侧栏看不到笑脸，笑脸仍出现在输入框引擎选择、会话页签等位置。
 *
 * 都用 MutationObserver：激活时全量扫一遍，之后宿主/React 每次重渲染把内容
 * 写回原样时就地改回；卸载时 disconnect，不留残留（规范要求所有副作用有 disposer）。
 * 跳过 input/textarea/contenteditable，绝不碰用户正在输入的编辑区。
 */

const FROM_TEXT = "Claude Code";
const TO_TEXT = "XoCodeX";

/* 笑脸：珊瑚底 + 白色双眼和笑嘴，跟 Claude 品牌色一脉相承，深浅色都清晰。
   作为 data URI 直接塞进 <img src>，元素本身不动——宿主据其原类名控制尺寸，
   且避开「用别的元素替换 <img>」会让 React 复用时 removeChild 报错的风险。 */
const SMILEY_DATA_URI =
  "data:image/svg+xml," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">' +
      '<circle cx="12" cy="12" r="11" fill="#d97757"/>' +
      '<circle cx="8.5" cy="9.5" r="1.7" fill="#fff"/>' +
      '<circle cx="15.5" cy="9.5" r="1.7" fill="#fff"/>' +
      '<path d="M6.4 14.2c1.4 2.7 3.5 4 5.6 4s4.2-1.3 5.6-4" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round"/>' +
      "</svg>",
  );

/* 把一枚 Claude 品牌标的图像源换成笑脸：只改 src + object-fit，保留元素、
   类名、尺寸。data-ccgui-smiley 作幂等标记，避免重复处理。 */
function replaceImg(img) {
  if (img.dataset.ccguiSmiley) return;
  img.dataset.ccguiSmiley = "1";
  img.src = SMILEY_DATA_URI;
  img.style.objectFit = "contain";
}

/* 处理一个文本节点：把 FROM_TEXT 换成 TO_TEXT。 */
function replaceText(node) {
  if (node.nodeType !== 3) return;
  const v = node.nodeValue;
  if (!v || v.indexOf(FROM_TEXT) === -1) return;
  const el = node.parentElement;
  if (el && (el.tagName === "TEXTAREA" || el.tagName === "INPUT" || el.isContentEditable === true)) return;
  node.nodeValue = v.split(FROM_TEXT).join(TO_TEXT);
}

/* 深度遍历一个子树：既换文字，也换 Claude 品牌标。 */
function walk(root) {
  if (root.nodeType === 3) {
    replaceText(root);
    return;
  }
  if (root.nodeType !== 1) return;
  if (root.tagName === "IMG") {
    const alt = root.getAttribute("alt");
    const src = root.getAttribute("src") || "";
    if (alt === "Claude" || /claude/i.test(src)) replaceImg(root);
    return;
  }
  const kids = root.childNodes;
  for (let i = 0; i < kids.length; i++) walk(kids[i]);
}

export default function activate() {
  if (typeof document === "undefined") return;

  if (document.body) walk(document.body);

  const observer = new MutationObserver((mutations) => {
    for (const m of mutations) {
      if (m.type === "characterData") {
        replaceText(m.target);
      } else {
        for (const n of m.addedNodes) walk(n);
      }
    }
  });
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true,
  });

  return () => observer.disconnect();
}
