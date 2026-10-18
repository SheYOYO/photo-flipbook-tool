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
      '   包在 no-preference 里，尊重「减少动态效果」——那种偏好下不挂过渡。',
      '   ★ R48：filter 一起挂过渡 —— data-wb-open 撤掉后书影 300ms 淡回，不瞬现。 */',
      '@media (prefers-reduced-motion: no-preference) { .book { transition: transform 760ms ease, filter 300ms ease; } }'
    ].join('\n');
    (document.head || document.documentElement).appendChild(st);
  })();

  // ---- ★★ R47：让「书的归位」与「翻动」同步（方案 A，2026-10-17）--------------
  //
  // 病灶（佘先生三问三答，与实测三重对齐）：
  //   ·「所有画册都这样」  ⇒ 与内容无关，是书本身
  //   ·「只有翻封面/后壳」 ⇒ 这两处是 data-edge 会从 front/back 变 inside 的**唯一**两处
  //   ·「一直在，直到翻页结束」 ⇒ 不是闪帧，是一个**位置状态**
  //
  // 机制（tools/_cdp_r51_deep.py 实测，拖过 90° 按住不放）：
  //   翻页**第一帧**，库就把下一跨页的两页按跨页位置**整张摆好**
  //     （实测 `1..257 / 257..523`，合计 531 = 摊开大小）
  //   而书壳还停在单页位置 —— `.book[data-edge=front]` 的 `translateX(-25%)`
  //     ⇒ 书盒实测 `[-8..523]`；要等翻完、data-edge 变 inside，才由那条
  //     760ms 过渡滑到 `[125..656]`。
  //   ⇒ 整个翻动过程中，跨页内容比书壳**多伸出 133px**，那半页正搭在木桌背景上。
  //   翻封面伸出在左、翻后壳伸出在右（对称）；翻内页时 data-edge 恒为 inside、
  //   书本来就在 0 ⇒ 不会露出 —— 与「只有封面/后壳才有」完全吻合。
  //
  // 修法：翻动一开始就把目的地设上（`data-wb-open` ⇒ `translateX(0)`），书与翻动
  //   **同时**滑动；掀动一停就撤掉，交回按 data-edge 的规则。
  //   · 翻成：撤掉时两处同值（都是 0）⇒ 无跳变
  //   · 回弹：edge 恒为 front ⇒ 由 CSS 的 760ms 过渡平滑滑回原位
  //
  // ⚠ 只加一条 CSS + 一个属性；**不碰透明度、不隐藏、不羽化**（R46 已把那些全撤了）。
  // ⚠ 判据**只认 edge ∈ {front, back}**：翻内页时书本来就在 0，设了也是 0，
  //    而且能避免「翻完之后 rotateY 还在 ⇒ 永远摘不掉 ⇒ 书被钉住」。
  // ⚠ 用 `transform`（不是 `translate`）：本机 Chrome 83 **不认** `translate` 简写属性，
  //    书自己的那条位移实际是靠上面 patchEdgeTranslate 的 transform 生效的。
  //    `!important` 是必须的 —— 上面那条是「.book + 2 个属性」(0,3,0)，比这条重。
  (function patchBookFollowsFlip() {
    var book = document.getElementById('book');
    if (!book) { return; }

    var css = document.createElement('style');
    css.id = 'compat-wb-open';
    css.textContent = [
      '@media (prefers-reduced-motion: no-preference) {',
      '  /* 拖拽期间 flipbook.js 会给 .book 加 data-dragging 把过渡关掉；',
      '     这里连同 transform 一起钉住，保证书是**滑**到位而不是瞬移。 */',
      '  .book[data-layout="landscape"][data-wb-open] {',
      '    transform: translateX(0) !important;',
      '    transition: transform 760ms ease, filter 240ms ease !important;',
      '  }',
      '}',
      '/* ★★ R48（2026-10-17）：翻动中**藏起书影**。',
      '   佘先生验收 R47 仍未过：「一个和画册摊开大小相同的矩形，翻封面/后壳时',
      '   瞬间出现在背景上，图片的展开需要时间」。R62 录屏逐帧 + R66 注入对照',
      '   定位：R47 让书盒在翻动第一帧就滑向摊开位，书盒的 drop-shadow（一个',
      '   摊开大小的矩形暗影）随之**瞬间铺在木桌背景上**——而左页图片要随',
      '   rotateY 从书脊往外展开 340ms 才到，观感就是「矩形先出现、图片后到」。',
      '   修法：data-wb-open 期间把书影关掉（filter:none），翻完撤掉属性让影子',
      '   240ms 淡回。静止态观感零变化；不碰透明度、不隐藏任何图片。 */',
      '.book[data-layout="landscape"][data-wb-open] { filter: none !important; }',
      '/* ★★★ R49（2026-10-18）：翻动中藏掉**库给硬页画的两层阴影**。',
      '   佘先生最终澄清：「就是那个**背景和图片的边缘线**…**两边都有**…',
      '   图片还没有归位时，就先划出一个线，线的位置到两个图片的轮廓」。',
      '   R69 真机实测（拖半翻按住，活数据）：',
      '     · .stf__hardShadow       x=125..390（左页位）266×332  z=14',
      '     · .stf__hardInnerShadow  x=390..656（右页位）266×332  z=15',
      '   两个矩形**各占一页**、合起来正好是摊开跨页；z 比页元素(11)高；',
      '   渐变在 5% 处最浓 ⇒ 形成**一条清晰的竖直边线**；且**只在硬页',
      '   （封面/封底）翻动时 display:block**（库 drawHardOuterShadow /',
      '   drawHardInnerShadow）⇒ 完全对上「只有翻封面和后壳」「两边都有」',
      '   「先划出一条线」。翻内页用 soft 阴影、位置在书内，所以看不到。',
      '   ⚠ 前几轮逐层剥全漏了这两层（R59 只剥了 img/plate/book-page/',
      '     fold-shade；R35 当时测的是书外木桌，而这两层在书内）。',
      '   修法：翻动中 display:none，翻完由库自己恢复。不碰图片、不碰透明度。 */',
      '.book[data-layout="landscape"][data-wb-open] .stf__hardShadow,',
      '.book[data-layout="landscape"][data-wb-open] .stf__hardInnerShadow { display: none !important; }',
      '/* ★★★ R50（2026-10-18）：翻动中把**书脊两侧的边缘阴影**淡出。',
      '   佘先生第三轮澄清：「我指的是那个**背景和图片的边缘线**」「**两边都有**」。',
      '   R74 逐层剥（藏掉 img 模拟"图片还没到"，再逐层删装饰，各截一张量化）：',
      '     L0 只藏图 → 书脊两侧**两条明显深色竖带**',
      '     L3 再藏 ::before(20% 宽过渡带) → 差 max=22（4.1% 像素）',
      '     L4 再藏 ::after(2px 书脊竖线)   → 差 max=94（5.8% 像素）← 最明显的一层',
      '     放大 4 倍的 A/B 图：藏掉后两条竖带**完全消失**（_shots_r74/spine_ab.png）',
      '   这三层都是 **CSS 渐变**（书脊两侧 --left/--right 的 ::before 20% 宽渐变带、',
      '   ::after 2px 深色竖线、.fold-shade 折痕）——和底色一样「瞬间就能画」，',
      '   而照片要解码光栅化 ⇒ **线先出现、图片后到**；而且只在跨页成立',
      '   （封面/封底翻动时书才从单页变跨页）⇒ 完全对上「只有翻封面和后壳」',
      '   「两边都有」「加边缘阴影后才出现」。',
      '   修法：data-wb-open 期间 opacity:0（220ms 淡出），翻完 220ms 淡回。',
      '   ⚠ 只藏**装饰伪元素**，不碰图片、不碰底色、不动书与库。',
      '   ⚠ 翻内页时 data-wb-open 不设 ⇒ 书脊阴影完全不受影响。 */',
      '#book .book-page.--left::before, #book .book-page.--right::before,',
      '#book .book-page.--left::after,  #book .book-page.--right::after {',
      '  transition: opacity 220ms ease;',
      '}',
      '.book[data-layout="landscape"][data-wb-open] .book-page.--left::before,',
      '.book[data-layout="landscape"][data-wb-open] .book-page.--right::before,',
      '.book[data-layout="landscape"][data-wb-open] .book-page.--left::after,',
      '.book[data-layout="landscape"][data-wb-open] .book-page.--right::after {',
      '  opacity: 0 !important;',
      '}',
      '/* ★★★ R54（2026-10-18）：翻动中把**舞台暗角**关掉。',
      '   佘先生圈图指出「左右两块矩形」后，R83 用 elementFromPoint 逐层问出来：',
      '     .stage / .room 的背景 = radial-gradient(130% 120% at 50% 40%,',
      '                                 transparent 40%, rgba(0,0,0,.22) 100%)',
      '   两层叠加 ≈ 39% 黑 ⇒ 画面中间亮、四周暗（vignette）。书的不透明内容',
      '   正好把中间挖空 ⇒ 书的外面就剩**一圈矩形暗框** —— 他说的「页面四周一圈」',
      '   「左右两块」「背景和图片的边缘线」。翻封面时书一移动，这圈暗框跟着变形，',
      '   看着就是「先划出一圈线」。',
      '   实证：注入 background-image:none 后，那两块**完全消失**（Q1_no_gradient.png）。',
      '   修法：data-wb-flip（由 JS 与 data-wb-open 同步挂到 <html>）期间关掉这两层渐变；',
      '   翻完立刻恢复 ⇒ **静止态暗角一个字不动**。',
      '   ⚠ .stage/.room 是 #book 的祖先，CSS 无法向上选择 ⇒ 用 <html> 上的属性。',
      '   ⚠ 只动背景渐变，不碰图片、不碰书、不碰透明度值。 */',
      'html[data-wb-flip] .stage, html[data-wb-flip] .room { background-image: none !important; }'
    ].join('\n');
    (document.head || document.documentElement).appendChild(css);

    var live = false, quiet = 0;

    function isFlipping() {
      var edge = book.getAttribute('data-edge');
      if (edge !== 'front' && edge !== 'back') { return false; }   // 只管封面/后壳
      var a = book.querySelectorAll('article');
      if (!a.length) { return false; }
      var el = (edge === 'back') ? a[a.length - 1] : a[0];
      var s = el.getAttribute('style');
      if (!s) { return false; }
      // 库 drawHard 每帧写 `transform: … rotateY(Ndeg)`；静止态 simpleDraw 不带 rotateY
      if (s.indexOf('rotateY') >= 0) { return true; }
      // 软页走 drawSoft：`clip-path` 多边形 + `rotate(Nrad)`
      if (s.indexOf('clip-path') >= 0 && s.indexOf('rotate(') >= 0) { return true; }
      return false;
    }

    setInterval(function () {
      if (!book.isConnected) { return; }
      if (isFlipping()) {
        live = true;
        quiet = 0;
        if (!book.hasAttribute('data-wb-open')) {
          book.setAttribute('data-wb-open', '');
        }
        // R54：舞台暗角跟着一起关（<html> 上的标记，CSS 用它选 .stage/.room）
        if (!document.documentElement.hasAttribute('data-wb-flip')) {
          document.documentElement.setAttribute('data-wb-flip', '');
        }
      } else if (live) {
        // 掀动刚停。edge 已到 inside ⇒ 立刻撤（同值、不跳）；
        // 否则（真回弹，edge 还是 front/back）先让库跑完收尾再撤，
        // 之后由 CSS 的 760ms 过渡平滑滑回原位。
        quiet++;
        if (book.getAttribute('data-edge') === 'inside' || quiet >= 3) {
          live = false;
          quiet = 0;
          book.removeAttribute('data-wb-open');
          document.documentElement.removeAttribute('data-wb-flip');
        }
      }
    }, 60);
  })();



  // ---- ★★★ R49b（2026-10-18）：照片页底色改透明，掐掉「矩形先于图片」的根 -----
  //
  // 佘先生的原话（这一轮把现象锁死）：
  //   ①「应该是**两边都有**…翻开封面或者后壳时是让一张图片的显示变成两张，
  //      这个时候**图片还没有归位**时，就**先划出一个线**，让图片到线的那个位置，
  //      线的位置到**两个图片的轮廓**」
  //   ②「我指的是那个**背景和图片的边缘线**」
  //   ③「我记得当时为了加**边缘阴影**后才出现的问题」
  //
  // R72 受控实测（真机 vivo Z5，拖半翻按住 + 藏掉 img 模拟"图片还没到"那一瞬）：
  //   T1 正常底色 + 藏图 → **一个跨页大小的深色矩形 rgb(41,44,38)** 压在木桌上，
  //                        左边一块、右边一块，中间书脊折痕，边界清清楚楚
  //   T2 底色透明 + 藏图 → 同一位置只剩**木桌**，矩形完全消失
  // ⇒ 那个「矩形 / 轮廓 / 边缘线」的真身 = 照片页的**元素底色**：
  //     `.art-page.photo{background:var(--ink)}`（#292c26 深色）。
  //     纯色**当场就能画**，而照片位图要解码 + 光栅化几十~几百毫秒
  //     ⇒ 先见矩形框、后见照片 ⇒「矩形的出现是瞬间的，图片的展开需要时间」。
  //   边缘阴影（cover-scrim / outer-x / outer-y / fold-shade）给这个色块
  //     加了边界强化 ⇒「加边缘阴影后才出现」——与他的记忆吻合。
  //
  // 修法：把这个**底色**改成透明。图片没到时透出木桌（不会有框），图片到了才有边界。
  //   · 静止/落定态：照片 width/height:100% + object-fit:cover 铺满整页
  //     ⇒ 底色永远看不见 ⇒ **观感零变化**（R71 实测注入前后 max diff = 0）
  //   · ⚠ 只匹配 `.art-page.photo`：封面与全部内页都是它；封底是
  //     `.art-page.cloth`（布纹、无 img）⇒ 不受影响，保持原底色
  //   · ⚠ 纯说明/文字页没有 .photo ⇒ 不受影响
  //   · ⛔ 不碰图片本身（不透明、不缩放、不隐藏、不羽化）—— 只改**元素底色**
  (function patchPhotoPageTransparentBg() {
    var st = document.createElement('style');
    st.id = 'compat-photo-bg';
    st.textContent = '#book article.art-page.photo { background: transparent !important; }';
    (document.head || document.documentElement).appendChild(st);
  })();

  // ---- 补回老内核不认的 CSS 简写属性 `inset` -----------------------------  // 书的灯箱（Phase 35「照片上双击 ⇒ 这张单独全屏看」）靠这一条铺满整个视口：
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

  // ---- 翻页时"框先画、图片后填"（佘先生：矩形瞬间出现、图片展开需要时间）----
  // 现象（2026-10-16，佘先生逐轮纠正后的精确描述）：
  //   「一个矩形、**和画册摊开的大小相同**，翻封面/后壳时**直接出现在背景上**；
  //     注意**图片的展开需要时间，而矩形的出现是瞬间出现的**」
  //
  // 根源：翻页第一帧，翻页库把下一跨页的**两个页面元素**从 display:none 变可见——
  //   这一步是瞬间的，元素框（左页+右页拼起来正好是跨页大小）连同它外边界立刻
  //   被画到木桌上；而框里的 <img> 位图要**解码 + 光栅化**，晚一拍才填进去。
  //   ⇒ 看到的顺序就是"矩形先出现 → 图片随后展开"。不是图片太亮、不是边缘太硬。
  //   （这也解释了为什么过去几轮反复取证都看不到：我总用"慢速分步拖"定格，
  //    等于给了图片足够的解码时间；而真机连拍只有 ~3fps，抓不到那几十毫秒。）
  //
  // 修法：**让图片在翻页那一刻就已经解码好**，元素框与图片就能同帧画出来。
  //   ⛔ 绝不做 R38/R42/R44 那套（把图片两侧弄透明、整页淡出）—— 佘先生明确反对：
  //      「**不要透明图片啊**…不是让你直接把图片的两侧透明」。这里一个透明度都不碰。
  //   ⚠ 只改壳；**书一个字不改**（不动 assets、不改 index.html）。
  (function patchPageImageWarmup() {
    var book = document.querySelector('#book') || document.querySelector('.book');
    if (!book) { return; }
    var imgs = book.querySelectorAll('article img');
    if (!imgs.length) { return; }
    var list = [];
    for (var i = 0; i < imgs.length; i++) { list.push(imgs[i]); }

    // ① 同步解码：告诉浏览器绘制这张图时**不要**"先画占位、后补图"
    for (var j = 0; j < list.length; j++) {
      try { list[j].setAttribute('decoding', 'sync'); } catch (e) { }
    }

    function warm() {
      // ② 预解码：把每张图的解码提前做掉，翻页时位图已在内存里
      for (var k = 0; k < list.length; k++) {
        try {
          var p = list[k].decode && list[k].decode();
          if (p && p.catch) { p.catch(function () { }); }
        } catch (e) { }
      }
      // ③ 离屏预热（佘先生选的"更彻底"）：同一 URL 再画一份在屏幕外，
      //   逼浏览器把位图真正光栅化好；留在视口外，用户永远看不到，之后移除。
      //   ⚠ 不能去动真实页面元素的可见性 —— 那是翻页库用 display:none 管的，
      //     强行显示会把布局打乱。这里只用一份**副本**在屏幕外预热。
      try {
        var box = document.createElement('div');
        box.setAttribute('aria-hidden', 'true');
        box.style.cssText = 'position:fixed;left:-12000px;top:0;width:600px;height:900px;'
                          + 'overflow:hidden;pointer-events:none;z-index:-1;';
        for (var m = 0; m < list.length; m++) {
          var im = document.createElement('img');
          im.src = list[m].getAttribute('src');
          im.width = 600;
          im.height = 900;
          box.appendChild(im);
        }
        document.body.appendChild(box);
        setTimeout(function () {
          if (box.parentNode) { box.parentNode.removeChild(box); }
        }, 1500);
      } catch (e) { }
    }

    // 书初始化完再预热，别挡着首屏
    if (document.readyState === 'complete') {
      setTimeout(warm, 200);
    } else {
      window.addEventListener('load', function () { setTimeout(warm, 200); });
    }
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
