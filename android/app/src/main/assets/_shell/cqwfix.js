/* ============================================================================
 * cqwfix.js —— 老内核（Chrome 83）**`cqw` 单位兜底换算**
 * ============================================================================
 *
 * ## 为什么需要它（2026-10-09 F140 实测根因）
 *
 * 佘先生报「新增的文字框调不了字号」。逐环排查后发现**每一环都正常**：
 *   · 面板滑块能拖（实测 2.1 → 12.9 → 0.8）          ✅
 *   · `coverTextJson` 把 `size` 正确序列化进 JSON      ✅
 *   · 引擎 `setCover` → `showPage` 正确传`coverText`  ✅
 *   · 引擎 `coverTextStyle` 正确生成 `--ct-x1-size:13.118cqw`  ✅
 *   · CSS 变量作用域正确（`.cover-extra` **拿到了**那个变量） ✅
 *   ★ 但**实际 `font-size` 计算值恒为 16px**                ❌
 *
 * ## 铁证（不是猜的）
 *
 *     CSS.supports('font-size', '1cqw')  ===  false
 *     （直接设`font-size:20cqw` 的探针算出来是 16px，而同一条 `px` 正常 20px）
 *
 * ⇒ 这台机的 WebView **完全不认识 `cqw`** ⇒ 所有 `cqw` 长的声明被**整条丢弃**，
 *   `font-size` 退回继承的 16px。
 * ⚠⚠ **影响面远不止文字框**：封面**书名 / 副标题 / 页脚**的字号滑块
 *   其实**从来没生效过**（看着"像变了"是别的 CSS 在起作用）。
 *
 * ## 为什么不能改引擎
 *
 * 冻结的 `_engine/template.js` 里 `coverExtraHtml` 写死了
 * `font-size: var(--ct-x1-size, 2.1cqw)` —— **一个字不许改**。
 * ⇒ 只能在**壳层**（本文件）把 `cqw` 换算成 `px` 兜底。
 *
 * ## 为什么能换算
 *
 * `cqw` = **容器宽度**的 1%。封面上这些文字的容器是 `.art-page`（封面页本身），
 * 而 `compat.js` 已经量过它的宽度（`--ct-*` 那套就是按它算的）⇒
 * **`1cqw` 的物理值 = `.art-page` 的宽度 / 100**，量得到就能换算。
 *
 * ## 做法（**只加内联样式，不改 DOM 结构、不改书**）
 *
 * 1. 量封面页 `.art-page` 的**布局宽度**（`offsetWidth`；⚠ **不能用 `getBoundingClientRect`**
 *    —— 祖先挂了 `transform: scale()` 时 rect 会跟着放大，`F148` 踩过，详见 `fixOne`）；
 * 2. 读它上面每个 `--ct-<key>-size` 变量的**裸数值**（如 `13.118`）；
 * 3. 算 `px = 裸数值 / 100 × 容器宽`，**写内联 `font-size`**（优先级高于
 *    `var(...)` 那条失效声明）⇒ 老内核立刻生效；
 * 4. **新内核（认识 `cqw`）跳过** ⇒ 一点行为都不变，避免"新机器被老补丁拖累"。
 *
 * ⚠ 为什么不能只写 CSS：`@supports (font-size: 1cqw)` 在 Chrome 83 上为假，
 *   所以**可以用它当「新内核」开关** —— 这是最干净的版本闸门。
 *
 * ⚠ 为什么不能靠 `resize` 事件：书页尺寸由 `compat.js` 算完才定，
 *   事件时序不可靠 ⇒ 改成**短轮询 + MutationObserver 双保险**（转屏、翻页都覆盖）。
 *
 * ⚠ 污染最小：所有属性都带 `__cqwfix` 标记，重复调用先清旧值。
 * ==========================================================================*/
(function () {
  'use strict';

  var TAG = '[cqwfix]';
  function log(m) { try { console.log(TAG + ' ' + m); } catch (e) { /* 忽略 */ } }

  // ★★ 版本闸门：新内核（认识 cqw）⇒ 整个文件不做事。
  //   ⚠ 这是 `&&` 不是 `||`：老内核两条都为 false ⇒ 进来兜底。
  var NEEDS_FIX = false;
  try {
    NEEDS_FIX = !(window.CSS && CSS.supports && CSS.supports('font-size', '1cqw'));
  } catch (e) {
    NEEDS_FIX = true;//连CSS.supports 都没有 ⇒ 更老 ⇒ 必须兜底
  }
  if (!NEEDS_FIX) {
    log('新内核支持 cqw ⇒ 不做任何事');
    return;
  }
  if (window.__cqwfixInstalled) { log('已装过，不再重复安装'); return; }
  window.__cqwfixInstalled = true;
  log('★ 老内核不认 cqw ⇒ 启动 px 兜底换算');

  /** 一个封面页里所有需要兜底的文字元素。 */
  function targets(page) {
    var out = [];
    var sel = ['.cover-title', '.cover-subtitle', '.cover-foot', '.cover-extra'];
    for (var i = 0; i < sel.length; i++) {
      var list = page.querySelectorAll(sel[i]);
      for (var j = 0; j < list.length; j++) out.push(list[j]);
    }
    return out;
  }

  /**
   * 引擎自己写在 `var(...)` 里的**默认 cqw 值**。
   * ⚠⚠ 为什么必须有这张表（★ 真机第一轮验收发现的缺陷）：
   *   用户**没动过**某项样式时，引擎**根本不生成**那个 CSS 变量
   *   （实测书页里 `--ct-title-size` 整个是空的）。
   *   而 `font-size: var(--ct-title-size, 7.2cqw)` 里那个兜底值 **7.2cqw 一样失效**
   *   ⇒ 该元素算出来恒是 16px。
   *   ⇒ 所以变量缺失时**必须自己补引擎的默认值**，否则「没改过」的那几处永远修不好。
   * ★ 数值取自引擎封面默认（title 7.2 / subtitle 2.1 / foot 1.6 cqw）。
   */
  var DEFAULT_CQW = { title: 7.2, subtitle: 2.1, foot: 1.6 };
  /** 文字框（extras）没设字号时的引擎默认 `2.1cqw`。 */
  var DEFAULT_EXTRA_CQW = 2.1;

  /** 写内联 font-size（带标记 ⇒ 幂等，不会叠加）。 */
  function applyPx(el, key, px) {
    if (!isFinite(px) || px <= 0) return false;
    el.setAttribute('data-cqwfix', key);
    el.style.fontSize = (Math.round(px * 100) / 100) + 'px';
    return true;
  }

  /**
   * 给一个封面页的一处文字做换算。
   * @param {Element} page 封面那页 `.art-page`
   * @param {Element} el   要设内联字号的文字元素
   */
  function fixOne(page, el) {
    // ★ key 从 data-ct / class 判断：文字框有 data-ct（x1..x8），
    //   内置三处没有 ⇒ 按 class 推。
    var key = el.getAttribute && el.getAttribute('data-ct');
    var isExtra = !!key;
    if (!key) {
      var cl = String(el.className || '');
      if (cl.indexOf('cover-title') >= 0) key = 'title';
      else if (cl.indexOf('cover-subtitle') >= 0) key = 'subtitle';
      else if (cl.indexOf('cover-foot') >= 0) key = 'foot';
      else if (cl.indexOf('cover-extra') >= 0) isExtra = true;
    }
    if (!key) return false;

    // ★ cqw = 容器宽度/100，容器就是封面页本身（它就是带 container-type 的那个）。
    //
    // ⚠⚠⚠ **必须用 `offsetWidth`，不能用 `getBoundingClientRect().width`**（`F148` 真机实测）：
    //   `cqw` 的口径是**容器（`.art-page`）自己的布局宽度**，而 rect 是**渲染后**的尺寸 ——
    //   祖先只要挂了 `transform: scale()`，rect 就跟着被放大。
    //   实测事故：工作台预览双指放大到 **3.5×** 时，这里的 rect 变成 350px
    //   ⇒ 字号被按 3.5 倍算死（书名 14.6cqw ⇒ 51px）**而且缩放回 1× 之后不会自己回来**
    //   ⇒ "一放大，封面的字就巨大了且再也回不去"。
    //   同类风险在**书页净屏**（`html.fs-net .book-rig{transform:scale(--fs-scale)}`）也在，
    //   只是净屏时不一定重跑本函数，所以一直没暴露。
    //   ⇒ `offsetWidth` 是**布局宽度**、不受 transform 影响，且 `cqw` 本来算的就是它。
    var pageW = page.offsetWidth;
    if (!pageW) { pageW = page.getBoundingClientRect().width; }
    if (!pageW) return false;

    var raw = getComputedStyle(page).getPropertyValue('--ct-' + key + '-size');
    // ★★★ 这里原来只认「裸数字」或 `px`，**漏了 `cqw` 后缀** ⇒ 拖字号时
    //   变量其实变成了 `13.062cqw`（已实测），却被判成"没值"⇒ 退回默认 2.1cqw
    //   ⇒ 所有文字框都被算成同一个 4.15px，看起来就是「拖了没反应」。
    //   ⇒ 现在**三种形态全认**：裸数字 / `px` / `cqw`。
    var m = raw ? String(raw).match(/^\s*(-?\d+(?:\.\d+)?)\s*([a-z%]*)\s*$/i) : null;
    if (m) {
      var v = parseFloat(m[1]);
      var u = (m[2] || '').toLowerCase();
      if (isFinite(v) && v > 0) {
        if (u === 'px') return applyPx(el, key, v);
        // ★ cqw / 无单位（引擎存的 cqw 数值）⇒ 按容器宽换算
        if (u === '' || u === 'cqw') return applyPx(el, key, v / 100 * pageW);
      }
    }
    // ★ 变量缺失 ⇒ 用引擎自己的默认值兜底（本轮修的就是这一条）
    var num = isExtra ? DEFAULT_EXTRA_CQW
                      : (DEFAULT_CQW[key] !== undefined ? DEFAULT_CQW[key] : null);
    if (num === null) return false;
    return applyPx(el, key, num / 100 * pageW);
  }

  /** 扫全页：所有 `.art-page` 里的封面文字都换算一遍。 */
  function fixAll() {
    var pages = document.querySelectorAll('.art-page');
    var n = 0;
    for (var i = 0; i < pages.length; i++) {
      var page = pages[i];
      //★ 只处理**封面页**：非封面上不该有 cover-* 元素，但过滤一下更稳。
      var list = targets(page);
      for (var j = 0; j < list.length; j++) {
        if (fixOne(page, list[j])) n++;
      }
    }
    return n;
  }

  /**
   * ★★ 第十八轮（他报「增大封面文字大小时画面会闪烁」）：
   *   新增一个**对外钩子**——“重算一遍”。
   *
   *   为什么必须加：本文件把 `cqw` 换算成**内联 `font-size: px`**
   *   （那台机的 WebView **不认识 `cqw`**，不换算就是 16px）。
   *   而面板改字号只是**改 CSS 变量** → 上面那条 px 不会自己变。
   *   而原来的触发器只监听 `childList`（结构变），**不听 `style` 属性**。
   *   ⇒ 不加这个钩子、又要回到「数字变了但画面不动」那个坑。
   *
   *   ⚠ 新内核（认识 cqw）下整个文件早就 return 了 ⇒ 这里不存在，调用方必须先判存在。
   */
  window.__cqwfixRun = function (tag) { run(tag || '外部调用'); };

  // ---- 触发时机：多保险 ------------------------------------------------
  // ① 立刻 + DOM 就绪
  function run(tag) {
    var n = 0;
    try { n = fixAll(); } catch (e) { log('换算出错（忽略）：' + (e && e.message)); return; }
    if (n) log('换算了 ' + n + ' 处封面文字（' + tag + '）');
  }

  if (document.readyState === 'interactive' || document.readyState === 'complete') {
    setTimeout(function () { run('就绪'); }, 0);
  } else {
    document.addEventListener('DOMContentLoaded', function () { run('DOMContentLoaded'); });
  }
  //② 书是异步渲染 + compat.js 要 400/1200ms 才量完尺寸 ⇒ 补测几次
  setTimeout(function () { run('400ms'); }, 400);
  setTimeout(function () { run('1200ms'); }, 1200);
  setTimeout(function () { run('2600ms'); }, 2600);

  //③ 转屏（尺寸变了 ⇒ cqw 的物理值也变了，必须重算）
  window.addEventListener('orientationchange', function () {
    setTimeout(function () { run('转屏+400ms'); }, 400);
    setTimeout(function () { run('转屏+1200ms'); }, 1200);
  });
  window.addEventListener('resize', function () {
    setTimeout(function () { run('resize+500ms'); }, 500);
  });

  // ④ 翻页会换掉整个 `bookEl.innerHTML` ⇒ 新节点要再兜一次
  if (window.MutationObserver) {
    try {
      var book = document.querySelector('.book') || document.body;
      var mo = new MutationObserver(function () {
        clearTimeout(window.__cqwfixTimer);
        window.__cqwfixTimer = setTimeout(function () { run('DOM变化'); }, 60);
      });
      mo.observe(book, { childList: true, subtree: true });
    } catch (e) { /* 忽略 */ }
  }
})();