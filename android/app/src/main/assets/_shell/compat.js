/* ============================================================================
 * 老内核版式补丁（compat.js）—— 由 App 外壳在页面加载完成后注入
 * ============================================================================
 *
 * 为什么需要它
 * ------------
 * 画册的版式（`styles.css`）用**容器查询单位**给书页算尺寸：
 *
 *     .stage    { container-type: size; }
 *     .book-rig { width:  min(100%, calc(100cqh * var(--page-ratio) * 2), …);
 *                 height: min(100cqh, 640px); }
 *     .room     { height: 100dvh; }
 *
 * `cqh` 要 Chrome **105+**、`dvh` 要 **108+**。老内核（实测 vivo Z5 = Chrome 83，
 * 2020-06）**不认识这两个单位** ⇒ `calc(100cqh * …)` 解析失败 ⇒ 整个 `min()`
 * 无效 ⇒ `width`/`height` 两条声明被浏览器**丢弃** ⇒ `.book-rig` 塌成内容尺寸
 * （实测 287×359，竖版小书）。由此连带四个现象：
 *
 *   ① 书变小（只占舞台宽 38%）
 *   ② **退成单页**：容器宽 287 < 高 359 ⇒ 翻页库（usePortrait:true）判 PORTRAIT
 *   ③ 净屏顶满失效（`--fs-scale` 的值同样来自 cqh）
 *   ④ 底部控制条跑到屏幕外（`.room{height:100dvh}` 失效 ⇒ 页面比视口高）
 *
 * 本补丁的立场
 * ------------
 *   · **书（成品）一个字不改，电脑工具一个字不改** —— 全是壳这一层的事
 *   · **只在老内核生效**：新内核认识 `cqh`，本补丁直接 return，一个像素都不动
 *   · **不许把 App 带走**：整段包在 try-catch 里，出错只打日志
 *   · 想在任何内核上强制验证，加 URL 参数 `?compat=force`
 * ==========================================================================*/
(function () {
  'use strict';

  var TAG = '[compat]';
  function log(m) { try { console.log(TAG + ' ' + m); } catch (e) { /* 忽略 */ } }

  // ---- 只在老内核生效 ----------------------------------------------------
  var modern = false;
  try {
    modern = !!(window.CSS && CSS.supports && CSS.supports('height: 1cqh'));
  } catch (e) { modern = false; }

  var force = false;
  try { force = /[?&]compat=force(&|$)/.test(location.search); } catch (e) { /* 忽略 */ }

  /* ★ 第十五轮：「只画封面」模式（竖屏封面编辑页用 `?cover=1` 打开，标记打在 `<html>`）。
     ⚠ 这个模式下**新内核也要跑本补丁** —— 因为单页的宽高比跨页复杂（见 apply 里的分支），
       交给 CSS 算会在窄屏上把封面**拉伸变形**（宽被 100% 卡住、高还是 min(100cqh,640px)）。
     ⚠ 标记在 `<head>` 里就打了（本文件由 `<script src>` 引，跑得比它晚）⇒ 这里读得到。 */
  var coverOnly = false;
  try { coverOnly = document.documentElement.classList.contains('pv-cover-only'); }
  catch (e) { coverOnly = false; }

  if (modern && !force && !coverOnly) {
    log('内核认识容器查询单位，跳过补丁');
    return;
  }
  log('开始打补丁' + (force && modern ? '（强制模式）' : '（老内核）'));

  // ---- 工具 --------------------------------------------------------------
  function px(v) { return Math.max(0, Math.round(v)) + 'px'; }

  function toPx(v) {
    var n = parseFloat(v);
    return isFinite(n) ? n : 0;
  }

  /** 把舞台的真实可用空间写回 .book-rig，替掉浏览器不认的 100cqh。 */
  function apply() {
    var room  = document.querySelector('.room');
    var stage = document.querySelector('.stage');
    var rig   = document.querySelector('.book-rig');
    if (!stage || !rig) { return 'no-elements'; }

    // ① .room 的高度退路：100dvh 不认识，用老内核一定认识的 100vh 顶
    //    （App 里 WebView 是真全屏、没有地址栏 ⇒ 100vh 不会跳）
    if (room) { room.style.setProperty('height', '100vh', 'important'); }

    // ② 实量 .stage 的内容盒，换算成书该有多大
    var cs    = getComputedStyle(stage);
    var padY  = toPx(cs.paddingTop) + toPx(cs.paddingBottom);
    var availH = Math.max(0, stage.clientHeight - padY);
    var availW = Math.max(0, stage.clientWidth);

    var ratio = toPx(getComputedStyle(document.documentElement).getPropertyValue('--page-ratio'));
    if (!(ratio > 0.05 && ratio < 20)) { ratio = 0.8; }   // 兜底：512/640

    // ★★ 第十五轮：「只画封面」模式 —— **单页**，而且必须**保比例**。
    //   为什么不能照搬下面那条跨页公式：跨页的 `width`/`height` 是两条**各自**的 min()，
    //   窄屏（竖屏手机）上宽会被 `100%` 卡住、高却仍是 min(100cqh,640px) ⇒
    //   rig 变成 360×640（比例 0.56），而封面是 0.8 ⇒ **封面被纵向拉长**。
    //   单页这里改成"先按高度定、放不下就按宽度反推"，两轴**永远同一条比例**。
    //   ⚠ 上限 640px 保留（与跨页同口径：大屏上别把书撑成巨无霸）。
    if (coverOnly) {
      // ⚠ 留 12px 呼吸边（CSS px）—— 封面编辑页里封面**贴着左右屏幕边**会显得很挤
      //   （书页里封面本来就有木桌留白，这里靠这一步还原那种"摆在一张桌上"的感觉）。
      var caw = Math.max(60, availW - 24);
      var cah = Math.max(60, availH - 24);
      var ch = Math.min(cah, 640);
      var cw = ch * ratio;
      if (cw > caw) { cw = caw; ch = cw / ratio; }
      rig.style.setProperty('width',  px(cw), 'important');
      rig.style.setProperty('height', px(ch), 'important');
      return '单页 ' + px(cw) + '×' + px(ch) + '（可用 ' + px(caw) + '×' + px(cah)
           + '，比例 ' + ratio.toFixed(3) + '）';
    }

    // 复刻原公式（min(100%, 100cqh*ratio*2, 640px*ratio*2) / min(100cqh, 640px)），
    // 只把 100cqh 换成实量的 availH
    var h = Math.min(availH, 640);
    var w = Math.min(availW, h * ratio * 2, 640 * ratio * 2);
    if (w > availW) { w = availW; h = w / (ratio * 2); }   // 宽度受限时反推高度
    if (h > availH) { h = availH; w = h * ratio * 2; }

    rig.style.setProperty('width',  px(w), 'important');
    rig.style.setProperty('height', px(h), 'important');
    return px(w) + '×' + px(h) + '（可用 ' + px(availW) + '×' + px(availH) + '，比例 ' + ratio.toFixed(3) + '）';
  }

  // ---- 让翻页库按新尺寸重算 ----------------------------------------------
  // 库的「单页 / 跨页」是**按容器宽高比**决定的，尺寸一改必须让它重算一次。
  var kicking = false;
  function kick() {
    if (kicking) { return; }
    kicking = true;
    var r;
    try { r = apply(); } catch (e) { log('回写尺寸失败：' + e); kicking = false; return; }
    log('尺寸回写 ' + r);

    setTimeout(function () {
      var how = '无';
      // 首选：直接调库的 update()（页面里的 pageFlip 是顶层 const，
      // 全局词法环境可见；TDZ 或不存在时 typeof 会抛，所以包起来）
      try {
        /* eslint-disable no-undef */
        if (typeof pageFlip !== 'undefined' && pageFlip && typeof pageFlip.update === 'function') {
          pageFlip.update();
          how = 'pageFlip.update()';
        }
      } catch (e) { /* 落到下面的 resize */ }
      // 退路：库自己也监听 window.resize
      if (how === '无') {
        try {
          selfResize = true;
          window.dispatchEvent(new Event('resize'));
          how = 'resize 事件';
        } catch (e) { log('resize 派发失败：' + e); }
      }
      log('重算方式：' + how);
      kicking = false;
    }, 80);
  }

  // 自己派发的 resize 不要再触发一轮 kick（否则死循环）
  var selfResize = false;
  window.addEventListener('resize', function () {
    if (selfResize) { selfResize = false; return; }
    setTimeout(kick, 120);
  });

  // ---- 补回老内核不认的 CSS 独立属性 `translate` -------------------------
  // 书里有一条「封面 / 封底单独占一跨时，把整本书平移四分之一宽、正好居中」的
  // 设计（styles.css）：
  //     .book[data-layout="landscape"][data-edge="front"] { translate: -25% 0; }
  //     .book[data-layout="landscape"][data-edge="back"]  { translate:  25% 0; }
  // 配套的过渡挂在 .book 上：`transition: translate 760ms ease`。
  // （data-edge 由书的 flipbook.js 自己维护：0 = "front"、末页 = "back"、其余 "inside"。）
  //
  // `translate` 这条**独立属性**要 Chrome **104+**（本机老内核实测 83）⇒ 老内核把
  // 这两条连同过渡**整条丢弃**。后果（真机实测）：书照旧占满整跨的宽度（576px），
  // 而封面只画在**右半边**（x=378..666）、封底只画在**左半边**（x=90..378）——
  // 屏幕另一半是空的，看着就是佘先生报的「封面不居中」。
  //
  // 这里用**等价的 `transform: translateX(±25%)`** 补一遍：百分比同样相对元素自身
  // （576 × 25% = 144px，正好半页宽），落点与书的原设计逐像素一致；
  // 过渡名一起换掉，不然平移是瞬移、没有书想要的滑动。
  // ⚠ `.book` 上没有别的 transform（它的内联样式只有库写的一组尺寸），补这两条不打架。
  // ⚠ 只补这两条；**书一个字不改**。
  (function patchEdgeTranslate() {
    var st = document.createElement('style');
    st.id = 'compat-edge-translate';
    st.textContent = [
      '.book[data-layout="landscape"][data-edge="front"] { transform: translateX(-25%); }',
      '.book[data-layout="landscape"][data-edge="back"]  { transform: translateX(25%); }',
      '/* 过渡：书的 `transition: translate` 老内核不认，换成 transform；',
      '   包在 no-preference 里，尊重「减少动态效果」——那种偏好下不挂过渡。 */',
      '@media (prefers-reduced-motion: no-preference) { .book { transition: transform 760ms ease; } }'
    ].join('\n');
    (document.head || document.documentElement).appendChild(st);
  })();

  // ---- 补回老内核不认的 CSS 简写属性 `inset` -----------------------------
  // 书的灯箱（Phase 35「照片上双击 ⇒ 这张单独全屏看」）靠这一条铺满整个视口：
  //     .lightbox { position: fixed; inset: 0; z-index: 300; background: rgb(16 18 14 / 95%); }
  // `inset` 这个**简写**要 Chrome **87+**（本机老内核实测 83）⇒ 老内核把**整条声明丢弃**
  // ⇒ 四个偏移全落回 `auto` ⇒ `position:fixed` + 全 auto + 子元素又都是绝对定位
  // ⇒ **宽高双双塌成 0×0**，落点还是 body 文档流末尾的静态位置
  // ⇒ 盒子停在**视口下边缘之外**，画面一个像素都不变。
  //
  // ★ 真机实测（A8 复跑，vivo Z5 / Chrome 83，`tools/a8_device.py`）：
  //     状态：`window.__lightbox.state()` 非空、`s = 1.00`        ← JS 说"开着"
  //     几何：`.lightbox` = **0×0 @(0,360)**，视口 756×360         ← 画面上什么都没有
  //     截图：开之后与开之前 **逐字节相同**（sha256 一致）          ← 就是佘先生说的"双击没反应"
  //   对照：模拟器 Chrome 113 上同一动作截图**明显不同** —— 与 F54 的"两套观感"同源。
  //
  // 这里用**等价的四个长写**补一遍：`inset:0` ≡ `top/right/bottom/left:0`，语义完全一致；
  // 晚出现的同特异度规则胜出 ⇒ 位置与尺寸逐像素还原书的原设计。
  // ⚠ `.lightbox` 上没有别的定位声明，补这四条不打架。
  // ⚠ **只补这一处**。书里另外几处 `inset` 都另有显式宽高或纯装饰：
  //     `.book .stf__block` / `.art-page .plate`（都有 width/height:100%）
  //     `.cover-scrim` / `.outer-x` / `.outer-y`（装饰性渐变与压边）
  //   —— 动它们会**改变真机上已有的观感**，属于"看得见的变化"，要佘先生点头再动（见 findings F68）。
  (function patchLightboxInset() {
    var st = document.createElement('style');
    st.id = 'compat-lightbox-inset';
    st.textContent = '.lightbox { top: 0; right: 0; bottom: 0; left: 0; }';
    (document.head || document.documentElement).appendChild(st);
  })();

  // ---- 补回老内核不认的 flex `gap` ---------------------------------------
  // 壳自己的右侧竖栏（`layout.js` 注入的那份 CSS）用了两处 `gap`：
  //     footer.controls { gap: 8px }        竖排每两项之间 8px
  //     .jump-row       { gap: 3px }        输入框与「跳转」按钮之间 3px
  // `gap` 用在 **flex** 容器上要 Chrome **84+**（本机老内核实测 83）⇒ 这一整栏在真机上
  // **所有间距都是 0**：上一页 / 页码 / 下一页 / 跳页 / 自动翻页挤成一坨。
  // （模拟器 Chrome 113 上一切正常 —— 又一个"只有真机才露"的坑，同 F68 一族。）
  //
  // 用**等价的长写** `margin` 补一遍：flex 的 `gap` 就是"相邻项之间的间距"，
  // 除第一项外逐项给 `margin-top` 与它**逐像素等价**。
  //
  // ⚠ 判据必须是**摊平之后的实际 flex 项**：中间两层（`.status` / `.status-row`）被
  //   `display: contents` 抹掉了 —— 它们在 DOM 上还是容器、在布局上是"空气" ⇒
  //   `footer.controls > * + *` 这类兄弟选择器**选不中真正的项**，只能一项项列出来。
  // ⚠ 只在老内核跑（本文件开头就 `return` 了）⇒ **新内核上既有的 `gap` 一个字节没动**，
  //   不存在"margin 与 gap 叠加 ⇒ 间距翻倍"的问题。
  (function patchFlexGap() {
    var st = document.createElement('style');
    st.id = 'compat-flex-gap';
    st.textContent = [
      '/* 竖排：除第一项（#previous）外，每一项上方 8px = footer.controls 的 gap */',
      'footer.controls #page-jump,',
      'footer.controls #page-input,',
      'footer.controls .jump-row,',
      'footer.controls #page-auto,',
      'footer.controls #page-auto-speed,',
      '/* ★ 2026-10-08：新插进来的两颗速度下拉（speed.js）—— 老内核上同样要这份 8px。',
      '   ⚠ 这里列的是 **容器 .shell-speed-row**，不是两颗 select：',
      '     `.status-row` 被 layout.js 第 3 条摊成了 contents，容器的 margin 才是生效的那个。',
      '     漏了它 ⇒ 老内核上这一行与上一项贴死，与新内核观感不一致（假红）。 */',
      'footer.controls .shell-speed-row,',
      'footer.controls #page-full,',
      'footer.controls #next {',
      '  margin-top: 8px;',
      '}',
      '/* 跳页那一行：输入框与「跳转」之间 3px = .jump-row 的 gap */',
      '.jump-row > * + * { margin-left: 3px; }'
    ].join('\n');
    (document.head || document.documentElement).appendChild(st);
  })();

  // ---- 启动 --------------------------------------------------------------
  if (document.readyState === 'interactive' || document.readyState === 'complete') {
    setTimeout(kick, 0);
  } else {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(kick, 0); });
  }

  // 照片是异步加载的，加载完布局高度可能变 ⇒ 补测两次
  setTimeout(kick, 400);
  setTimeout(kick, 1200);

  // 转屏后重算
  window.addEventListener('orientationchange', function () { setTimeout(kick, 300); });
})();
