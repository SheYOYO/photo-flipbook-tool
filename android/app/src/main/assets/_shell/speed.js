/* ============================================================================
 * _shell/speed.js —— 手机壳补丁：**翻页速度** + **自动翻页** 两个可点组块
 * ============================================================================
 *
 * 佘先生（2026-10-08 第一轮）：
 *   「新增一个功能，可以调节翻页的速度，参考自动翻页的速度模式设计，
 *     ui组块设计放在自动翻页上面，我点击翻页多少秒一翻就是改翻页速度，
 *     我点击自动翻页就是改自动翻页速度」
 *
 * 佘先生（2026-10-08 第二轮 · UI 改版）：
 *   「跳转页面的功能下方先放翻页的速度，用户点击后原来的翻页组块显示变成调节速度，
 *     在翻页组块的下方放调节自动翻页的组块，点击后调解自动翻页的速度」
 *   ⇒ 定案：折叠**只写名称** · 点开就地展开 **档位按钮** · 两组**互斥** + **选完自动收** ·
 *     自动翻页的**开/关并进档位**。
 *
 * 佘先生（2026-10-08 第三轮 · 本轮）：★ **档位减到 4 个 + 一行自定义数值**
 *   「一是调节翻页速度只要设置四个档位，砍掉的那那行就放成用户自己输入具体数字，
 *     注意是正数，支持小数点，二是自动翻页的速度档位只要保留四个从零点五秒到两秒，
 *     最后留出一行给用户设置具体数值」
 *   ⇒ 定案（逐条问过）：
 *     ① 翻页 4 档 = **0.3 / 0.5 / 1 / 2 秒**；
 *     ② 自动 4 档 = **0.5 / 1 / 1.5 / 2 秒**（外加一整行「关」，见下）；
 *     ③ 「关」**保留一整行**（否则"开起来停不掉"）；
 *     ④ 自定义输入 **回车生效**；**越界（过小/过大）不执行 + 提示「数值不合理」**。
 *
 * ── 一、两颗旋钮各管什么（最容易搞混的一处，先钉死）───────────────────────
 * | 控件        | 管的事                          | 权威接口                          |
 * |-------------|---------------------------------|-----------------------------------|
 * | 「翻页」    | **翻一张的动画时长**（快慢手感）  | `__pf.getSettings().flippingTime` |
 * | 「自动翻页」| **停几秒再翻下一张**（播放节奏）  | `window.__auto.setInterval(ms)`   |
 *
 * ⚠⚠ 这两个是**完全不同的东西**，别再混：把自动翻页调成 1 秒/页，翻页动画**还是**那么长。
 *
 * ── 二、为什么全部做在壳层，书一个字节都不改 ─────────────────────────────
 * 书（`content/`、`flipbook.js`、`index.html`）是**冻结资产**，动一字就前功尽弃。
 * 好在书自己把权威入口挂到了 window 上（实测过，不是猜）：
 *   · `window.__pf`   = stPageFlip 实例（`flipbook.js:1641 window.__pf = pageFlip`）
 *     库有 `getSettings()`；`getAnimationDuration()` **每次都现读** `flippingTime`
 *     ⇒ 就地改返回对象**即刻生效**，不需要重建实例、也不打断正在进行的动画。
 *     （库**没有** `setSettings` 方法 —— 逐个方法名核过。）
 *   · `window.__auto` = 自动翻页对象（`flipbook.js:1855`，有 start/stop/isPlaying/
 *     speedSeconds/setInterval/interval）。
 *   · `#page-auto-speed` = 书自带的 1~10 秒下拉（**整数**）。
 *
 * ── 三、★★ 自动翻页为什么改走 `setInterval`，不再动书那颗下拉 ─────────────
 * 本轮他要求自动翻页能有 **0.5 秒**。而书自带的 `#page-auto-speed`：
 *   `readSpeedSeconds()` = `parseInt(值,10)` 再 `Math.min(10, Math.max(1, n))`
 *   ⇒ **只认 1~10 的整数，0.5 秒它表达不出来**。
 * 更关键的是 `#page-auto-speed` 上挂着 `change → applySpeedFromSelect()`，
 * 那个函数会**用下拉里的整数重算 autoInterval**（第一轮就是靠派发 change 让它生效的）。
 * ⇒ 本轮改成：
 *   · 速度一律走 **`__auto.setInterval(ms)`**（书里给的自测口子，**下限 300ms**）；
 *   · **绝不再派发 `change`** —— 派了就等于让书按整数把速度**拍回去**；
 *   · 下拉的 value 仍**程序化同步**一下（只为"万一有人读它"时不至于太离谱）。
 *     ⚠ 程序化赋值 **永远不会触发 change**，所以这是安全的。
 *   · 播放中改速要**立刻换掉**正在等的那一次计时。书的 `autoInterval` 是模块内的 `let`
 *     （不在 window 上，取不到）⇒ 只能走公开 API：`stop()` 清计时 → `start()` 按新间隔重排。
 *     不这么做就会重现老毛病：「选 2 秒却还要再等 8 秒」。
 *   ⚠ `setInterval(ms)` 对 `ms < 300` 会**静默回落到 5000**（书里的写法）⇒ 我们的
 *     自定义下限就定在 **0.3 秒**，正好齐平，不给自己埋雷。
 *
 * ── 四、★ 0.5 秒/页 与翻页动画的关系（他要求的下限，先说清楚）────────────
 * 书里 `autoTick()` 有守卫：`if (isTurning) { 再等 320ms 重试 }`
 * ⇒ 间隔短于翻页动画时，节奏会被动画**兜住**（不会崩、不会空转，只是快不过动画）。
 * 想真正 0.5 秒/页，得把「翻页」也调到 ≤0.5 秒（本轮 4 档里就有 0.3 / 0.5）。
 *
 * ── 五、UI 排布（layout.js 第 4 条 order 决定，order 越小越靠上）──────────
 *   上一页(1) → 页码(2) → 下一页(3) → 跳页(5) → **翻页组块(6)** → **自动翻页组块(7)**
 * ⚠ 两组块**直接 append 进 `footer.controls .status`**：`.status` / `.status-row` 已被
 *   layout.js 摊成 `display: contents` ⇒ 组块升格成 `footer.controls` 的 flex 子项
 *   ⇒ **各自的 order 才生效**。第一版塞进中间一层是错的（两块会共享 order）。
 * ⚠ 展开面板（每组块）= 小标题 + 档位网格 + **自定义输入行** + **提示行**：
 *   · 翻页：4 档排 2×2 → 输入行「[ 1.4 ] 秒」→ 提示行
 *   · 自动：「关」占满一行 + 4 档排 2×2 → 输入行 → 提示行
 *   ⚠ 竖栏内容宽只有 **64px**（`width:74px` 减左右各 5px）⇒ 档位只写数字，
 *     单位提到小标题/输入行的「秒」里。见文件头 layout.js 第 7b 条的实测账。
 *
 * ── 六、书自带的 `#page-auto` / `#page-auto-speed`：**只藏不摘** ──────────
 * 书的 `flipbook.js` 一开头就 `querySelector('#page-auto')` 拿引用并挂 click，
 * 摘掉节点虽不报错，但 `#page-auto-speed` 的 change 监听会失效（将来若有人派发 change
 * 就会读不到值）⇒ 只 `display:none`，**绝不 remove**。这条别碰。
 *
 * ── 七、状态持久化 ────────────────────────────────────────────────────────
 * `localStorage`：`shell.flipMs`（库参数）/ `shell.autoMs`（毫秒，0 = 关）。
 * ⚠ 写入必须 try-catch：隐私模式 / storage 被禁用时 WebView 会抛 SecurityError。
 * ⚠ 旧键 `shell.autoMode`（整数秒）留着做一次性迁移。
 * ⚠ **自定义值一律忠实保留**，不再"吸附到最近的档位"：以前吸附是因为 `<select>`
 *   匹配不到就显示空白；现在有输入框，能如实显示 0.76 秒这种非档位值 —— 不能骗用户。
 *
 * ── 八、老内核兜底 ────────────────────────────────────────────────────────
 * 书是给电脑浏览器写的，`window.__pf` / `window.__auto` 未必都在。任何一个拿不到
 * ⇒ 这颗控件不装，**绝不显示一颗点了没反应的按钮**（本项目的铁律）。
 * ⚠ 全程 ES5（`var` / 闭包），真机 Chrome 83 不认箭头函数与 `let`。
 */
(function () {
  'use strict';

  var TAG = '[shell-speed]';
  function log(m) { try { console.log(TAG + ' ' + m); } catch (e) { /* 忽略 */ } }

  /* ======================================================================
   * 一、换算与档位
   * ==================================================================== */
  /**
   * `K = 0.54` = **实测**系数（gesture.js 注释里记着，不是我猜的）：
   *   「翻一页」的实际时长 = `flippingTime × 0.54`。
   *   例：1400 × 0.54 ≈ 757ms —— 正是他调出来的那个"实体感"。
   * ⇒ 用户看到的"秒"= 参数 × K ÷ 1000；写进库的参数 = 秒 × 1000 ÷ K。
   */
  var K = 0.54;
  function ms2sec(ms) { return Math.round((Number(ms) * K) * 100) / 100; }

  /**
   * 秒 → 库参数（`flippingTime` 的尺度）。
   * ⚠ **不做 round 到整档**：自定义值要忠实于用户输入。
   * ⚠ 参数 **1** 是书自己的哨兵（`flipbook.js:1049` 瞬移、`:1309` 急翻都写 `= 1`
   *   让翻页立刻收尾）⇒ 恰好落上就挪开一格。本范围（≥0.1 秒 ⇒ 参数 ≥185）够不到它，
   *   守卫只为"将来有人放宽下限"时不至于踩雷。
   */
  function sec2FlipMs(sec) {
    var v = Math.round(Number(sec) * 1000 / K);
    if (v === 1) { v = 2; }
    return v;
  }

  /**
   * ★ 翻页 4 档（他第三轮定的）：**0.3 / 0.5 / 1 / 2 秒**。
   * `ms` 是权威值（直接写进 `flippingTime`），`label` 只是给人看的。
   * 为什么直接给库参数而不是写秒再换算：`K` 是**实测近似值**，拿它反算会被 round
   * 放大成整档偏差（0.3 → 556 vs round(0.3/0.54)=1 ⇒ 正好撞哨兵）。
   * ⚠ 想再调手感只改这一行的 `ms` —— 库每帧现读它，即刻生效。
   */
  var FLIP_STEPS = [
    { ms: 556, label: '0.3 秒', chip: '0.3' },   // 556 × 0.54 = 300.2ms
    { ms: 926, label: '0.5 秒', chip: '0.5' },   // 926 × 0.54 = 500.0ms
    { ms: 1852, label: '1 秒', chip: '1' },      // 1852 × 0.54 = 1000.1ms
    { ms: 3704, label: '2 秒', chip: '2' }       // 3704 × 0.54 = 2000.2ms
  ];
  /** 库参数与 localStorage 用的都是"库参数尺度"（毫秒）。 */
  var FLIP_DEFAULT_MS = 1400;      // = gesture.js 的 FLIP_MS（1400×0.54 ≈ 0.76 秒）

  /**
   * ★ 翻页自定义数值的**允许范围（秒）**。越界 ⇒ **不执行** + 提示「数值不合理」。
   * 下限 0.1 秒：再小已小于一帧动画，体验上等于"立即翻"，没有意义。
   * 上限 10 秒：比最慢档（2 秒）宽裕 5 倍，够用且不至于让人以为卡死。
   */
  var FLIP_CUSTOM = { min: 0.1, max: 10 };

  /**
   * ★ 自动翻页档位（他第三轮定的）：**「关」+ 0.5 / 1 / 1.5 / 2 秒**。
   * ⚠ 值统一用**毫秒**（0 = 关）。以前用"整数秒"是因为要走书那颗下拉，
   *   现在走 `setInterval(ms)` ⇒ 毫秒才是原生尺度，0.5 秒也表达得了。
   */
  var AUTO_STEPS = [
    { v: 0, label: '关', chip: '关' },
    { v: 500, label: '0.5 秒', chip: '0.5' },
    { v: 1000, label: '1 秒', chip: '1' },
    { v: 1500, label: '1.5 秒', chip: '1.5' },
    { v: 2000, label: '2 秒', chip: '2' }
  ];
  var AUTO_DEFAULT_MS = 5000;      // = 书自己的默认 5 秒/页
  /** ★ 自动自定义范围（秒）。下限与书 `setInterval` 的 300ms 下限**齐平**（见文件头第三条）。 */
  var AUTO_CUSTOM = { min: 0.3, max: 60 };
  var AUTO_MIN_MS = 300;

  /* ======================================================================
   * 二、小工具
   * ==================================================================== */
  function store(key, val) {
    try {
      if (val === null || val === undefined) { window.localStorage.removeItem(key); }
      else { window.localStorage.setItem(key, String(val)); }
    } catch (e) { /* 隐私模式/存储禁用：静默，功能不依赖持久化 */ }
  }
  function load(key) {
    try { return window.localStorage.getItem(key); } catch (e) { return null; }
  }

  /** ★ 唯一的"权威来源"：拿不到 `__pf` / `__auto` 就不装控件。 */
  function pf() {
    try {
      var p = window.__pf;
      return (p && typeof p.getSettings === 'function') ? p : null;
    } catch (e) { return null; }
  }
  function autoApi() {
    try {
      var a = window.__auto;
      return (a && typeof a.start === 'function' && typeof a.setInterval === 'function') ? a : null;
    } catch (e) { return null; }
  }
  function bookSpeedSelect() {
    try { return document.getElementById('page-auto-speed'); } catch (e) { return null; }
  }

  /** 现在翻一张要多少毫秒（读书/库的真实值，不猜）。 */
  function currentFlipMs() {
    var p = pf();
    if (!p) { return FLIP_DEFAULT_MS; }
    var s = null;
    try { s = p.getSettings(); } catch (e) { /* 忽略 */ }
    var v = s && Number(s.flippingTime);
    return (isFinite(v) && v > 0) ? v : FLIP_DEFAULT_MS;
  }

  /** 自动翻页当前间隔（毫秒）。优先问 `__auto`（它是 setInterval 写进去的，最权威）。 */
  function currentAutoMs() {
    var a = autoApi();
    if (a && typeof a.speedSeconds === 'function') {
      var s = Number(a.speedSeconds());
      if (isFinite(s) && s > 0) { return Math.round(s * 1000); }
    }
    return AUTO_DEFAULT_MS;
  }
  function autoPlaying() {
    var a = autoApi();
    if (a && typeof a.isPlaying === 'function') {
      try { return !!a.isPlaying(); } catch (e) { /* 忽略 */ }
    }
    var b = document.getElementById('page-auto');
    if (b) { return b.getAttribute('aria-pressed') === 'true'; }
    return false;
  }

  /** 命中的**档位值**；没有就 null。**只用于"高亮哪一颗"，绝不拿它改写用户的设定。** */
  function presetOf(steps, val, key) {
    var n = Number(val);
    for (var i = 0; i < steps.length; i++) {
      if (Number(steps[i][key]) === n) { return n; }
    }
    return null;
  }

  /** 用户输入的"秒"：只收正数（可带小数点）。不接受 '1.5abc' / 'abc' / '' ⇒ NaN。 */
  function parseSec(txt) {
    var s = String(txt === null || txt === undefined ? '' : txt).trim();
    if (!/^\d*\.?\d+$/.test(s)) { return NaN; }
    var n = parseFloat(s);
    return isFinite(n) ? n : NaN;
  }
  /** 秒 → 给人看的短文案（0.76 → "0.76"，2 → "2"）。 */
  function secText(sec) {
    var n = Math.round(Number(sec) * 1000) / 1000;
    return String(n);
  }

  /* ======================================================================
   * 三、真正生效的两条动作
   * ==================================================================== */

  /**
   * 改**翻页速度**：写 `flippingTime`。
   * ⚠ 为什么就地改 `getSettings()` 返回的对象：这个库**没有** `setSettings`（实测核过），
   *   而 `getAnimationDuration()` 每次现读 ⇒ 就地改即刻生效。
   * ★★ **必须同时写 `window.__shellFlipMs`**（单一真相源）：只写 `flippingTime` 的话，
   *   下一次翻页时 `gesture.js` 的 `tuneFlipDuration()` 会把它拍回 `FLIP_MS`。
   */
  function applyFlipSpeed(ms) {
    var p = pf();
    if (!p) { return false; }
    var s = null;
    try { s = p.getSettings(); } catch (e) { return false; }
    if (!s) { return false; }
    var n = Number(ms);
    if (!isFinite(n) || n <= 0) { n = FLIP_DEFAULT_MS; }
    /* ⚠ **只抬"恰好等于 1"**（书自己的急翻/瞬移哨兵）。
     *   别写成 `n < 2` —— 那会把合法的最快档也毙掉（第一轮真机+仿真两头撞过）。 */
    if (n === 1) { n = FLIP_DEFAULT_MS; }

    try { window.__shellFlipMs = n; } catch (e2) { /* 忽略 */ }   // ① 先落真相源
    try {
      s.flippingTime = n;
      try { var st2 = p.setting; if (st2 && st2 !== s) { st2.flippingTime = n; } } catch (e3) { /* 忽略 */ }
      store('shell.flipMs', n);
      log('翻页速度 → 参数 ' + n + '（实际约 ' + (ms2sec(n) / 1000) + ' 秒）');
      return true;
    } catch (e) { log('写 flippingTime 失败：' + e); return false; }
  }

  /**
   * 改**自动翻页**：`ms` = 每页停多少毫秒；`0` = 关。
   * ★ 走 `__auto.setInterval(ms)`，**不碰书那颗下拉的 change**（理由见文件头第三条）。
   * 返回 { ok, reason }：`reason === 'range'` 表示数值不合理（**没执行**）。
   */
  function applyAutoMs(ms) {
    var a = autoApi();
    var n = Math.round(Number(ms));
    if (!isFinite(n) || n < 0) { n = 0; }

    if (n === 0) {                                  // 关
      try { if (a) { a.stop(); } } catch (e) { /* 忽略 */ }
      store('shell.autoMs', 0);
      log('自动翻页 → 关');
      return { ok: true, reason: '' };
    }
    if (n < AUTO_MIN_MS) {                          // 低于书的 setInterval 下限 ⇒ 不执行
      return { ok: false, reason: 'range' };
    }

    try { if (a) { a.setInterval(n); } } catch (e2) { log('设间隔失败：' + e2); }

    /* 下拉值**程序化**同步（只为"万一有人读它"时别太离谱）。
       ⚠ 只赋值、**绝不派发 change** —— 派了就会触发 applySpeedFromSelect() 按整数拍回。 */
    var sel = bookSpeedSelect();
    if (sel) {
      try { sel.value = String(Math.min(10, Math.max(1, Math.round(n / 1000)))); } catch (e3) { /* 忽略 */ }
    }

    /* 播放中改速：**立刻换掉**正在等的那一次计时（否则要等完旧间隔 = "看着没生效"）。
       书的 autoInterval 是模块内 let、取不到 ⇒ 走公开 API：stop() 清计时 → start() 重排。 */
    try {
      if (a.isPlaying()) { a.stop(); a.start(); } else { a.start(); }
    } catch (e4) { log('起自动翻页失败：' + e4); }

    store('shell.autoMs', n);
    log('自动翻页 → ' + (n / 1000) + ' 秒/页');
    return { ok: true, reason: '' };
  }

  /* ======================================================================
   * 四、UI
   * ==================================================================== */
  var FLIP_BLOCK_ID = 'shell-speed-flip';
  var AUTO_BLOCK_ID = 'shell-speed-auto';

  /**
   * ★ 把书自带的「自动翻页开关 + 它的 10 档下拉」**藏起来**（只藏，不摘）。
   * 见文件头第六条 ⚠ —— 它们必须留在 DOM 里。
   */
  function hideBookSpeedWidgets() {
    var st = document.getElementById('shell-speed-hide');
    if (!st) {
      st = document.createElement('style');
      st.id = 'shell-speed-hide';
      (document.head || document.documentElement).appendChild(st);
    }
    st.textContent = [
      '#page-auto,',
      '#page-auto-speed {',
      '  display: none !important;',
      '}'
    ].join('\n');
  }

  /* ----------------------------------------------------------------------
   * 组块注册表 + 开合状态
   * ⚠ 开合（互斥、选完自动收）**只在这两个函数里改** —— 单一真相源，
   *   免得又出现"两处各写一半、谁后跑谁拍回"那种鬼打墙（F128 的教训）。
   * -------------------------------------------------------------------- */
  var BLOCKS = {};        // id -> { box, btn, chips, inp, tip, custom }
  var OPEN_ID = null;     // 当前展开的组块 id；null = 全收起

  /** 把某个组块的档位高亮切到 `val`；`val` 为 null ⇒ 一颗都不亮（自定义值就是这情况）。 */
  function markBlock(id, val) {
    var b = BLOCKS[id];
    if (!b) { return; }
    var n = (val === null || val === undefined) ? NaN : Number(val);
    for (var i = 0; i < b.chips.length; i++) {
      var on = Number(b.chips[i].getAttribute('data-val')) === n;
      b.chips[i].setAttribute('aria-pressed', on ? 'true' : 'false');
    }
  }

  /**
   * ★★ 打字避让：输入框聚焦时给 `footer.controls` 挂 `data-typing="1"`，
   * 由壳层 CSS 把整条竖栏**提到屏幕顶部**（并临时收起上面那几行），
   * 这样输入框和提示行就落在键盘**上方**、看得见。
   *
   * 真机实测（必须这么做，不是洁癖）：
   *   · 书页是**横屏 780×360**，数字键盘一弹，顶边在 **CSS y≈231**（盖掉下半屏）；
   *   · 新加的输入框在 CSS y≈263、提示行在 y≈285 ⇒ **双双在键盘后面**：
   *     用户看不见自己在输什么，**也看不见「数值不合理」**（那正是定案④要的东西）。
   *   · ⚠ **页面上量不到键盘高度**：`window.innerHeight` 与 `window.visualViewport.height`
   *     **都恒为 360**（app 是 `adjustNothing`，键盘是盖在上面的系统窗口，不缩 WebView）
   *     ⇒ 只能"把竖栏挪到顶部"，没法按键盘高度精确定位。
   *     （第三轮为此连猜两次：先猜"被元素盖住"、再猜"视口变矮"，都被实测否掉 ——
   *       `elementFromPoint` 回的就是那颗按钮；`innerHeight` 一次没变。教训同 F111：**对照物选错**。）
   */
  function setTyping(on) {
    try {
      var f = document.querySelector('footer.controls');
      if (f) { f.setAttribute('data-typing', on ? '1' : '0'); }
    } catch (e) { /* 忽略：避让失败也绝不能影响输入本身 */ }
  }

  /** 提示行：`bad` = true 时标红（「数值不合理」）。 */
  function setTip(id, text, bad) {
    var b = BLOCKS[id];
    if (!b || !b.tip) { return; }
    b.tip.textContent = text || '';
    b.tip.setAttribute('data-bad', bad ? '1' : '0');
  }
  /** 把自定义输入框填成当前值（用于"存过的是非档位值"时如实显示）。 */
  function fillCustom(id, sec) {
    var b = BLOCKS[id];
    if (!b || !b.inp) { return; }
    b.inp.value = secText(sec);
    b.inp.setAttribute('data-bad', '0');
  }
  function clearCustom(id) {
    var b = BLOCKS[id];
    if (!b || !b.inp) { return; }
    b.inp.value = '';
    b.inp.setAttribute('data-bad', '0');
    setTip(id, '', false);
  }

  /**
   * ★★ **回读真实状态**重画界面（高亮 + 输入框 + 提示）。
   *
   * ⚠ 唯一允许"写界面"的入口 —— 别在别处拿变量直接 markBlock/fillCustom。
   *   理由：`applyFlipSpeed` / `applyAutoMs` 都可能**夹紧或改值**
   *   （哨兵守卫把参数 1 抬到 1400、自动低于 300ms 直接拒、播放中改速会重排计时），
   *   拿"我以为的值"去画界面 = 界面与真实状态错位（D1 那类 bug 的通用形态）。
   *   `currentFlipMs()` / `currentAutoMs()` 读的是**库与 `__auto` 的真实值**，信它们。
   */
  function syncUI() {
    var fm = currentFlipMs();
    var fp = presetOf(FLIP_STEPS, fm, 'ms');
    markBlock(FLIP_BLOCK_ID, fp);
    if (fp === null) { fillCustom(FLIP_BLOCK_ID, ms2sec(fm) / 1000); } else { clearCustom(FLIP_BLOCK_ID); }

    var am = autoPlaying() ? currentAutoMs() : 0;
    var ap = presetOf(AUTO_STEPS, am, 'v');
    markBlock(AUTO_BLOCK_ID, ap);
    if (ap === null) { fillCustom(AUTO_BLOCK_ID, am / 1000); } else { clearCustom(AUTO_BLOCK_ID); }
  }

  /** 展开 `id`（传 null = 全收起）。★ 互斥与 aria 同步都只在这一处做。 */
  function openBlock(id) {
    OPEN_ID = id;
    for (var k in BLOCKS) {
      if (!BLOCKS.hasOwnProperty(k)) { continue; }
      var b = BLOCKS[k];
      var on = (k === id);
      b.box.setAttribute('data-open', on ? '1' : '0');
      b.btn.setAttribute('aria-expanded', on ? 'true' : 'false');
    }
  }
  function toggleBlock(id) { openBlock(OPEN_ID === id ? null : id); }
  function closeAll() { openBlock(null); }

  /**
   * 造一个「折叠只写名称 / 点开 = 档位按钮 + 自定义输入行」的组块。
   *
   * @param o.id      组块 id（同时也是 CSS order 的挂点）
   * @param o.name    折叠态文案（定案①：只写名称）
   * @param o.cap     展开后的小标题（**单位写这儿**，档位只留数字）
   * @param o.steps   档位表
   * @param o.valOf   取档位值（翻页用 ms，自动翻页用 v）
   * @param o.onPick  选中回调（真生效的那条链路）。返回 `{ok:false}` ⇒ 界面判为"数值不合理"
   * @param o.valKey  档位表里"值"的字段名（翻页 = `ms`，自动翻页 = `v`）
   * @param o.custom  自定义输入：`{ min, max, toVal(sec) }`（不给就没有输入行）
   */
  function mkBlock(o) {
    var id = o.id;
    var box = document.createElement('div');
    box.className = 'shell-speed-block';
    box.id = id;
    box.setAttribute('data-open', '0');

    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'shell-speed-btn';
    btn.setAttribute('aria-label', o.cap);
    btn.setAttribute('aria-expanded', 'false');
    btn.textContent = o.name;
    box.appendChild(btn);

    var panel = document.createElement('div');
    panel.className = 'shell-speed-panel';
    var capEl = document.createElement('div');
    capEl.className = 'shell-speed-cap';
    capEl.textContent = o.cap;
    panel.appendChild(capEl);

    var grid = document.createElement('div');
    grid.className = 'shell-speed-grid';
    var chips = [];
    for (var i = 0; i < o.steps.length; i++) {
      var v = o.valOf(o.steps[i]);
      var chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'shell-speed-chip';
      chip.setAttribute('data-val', String(v));
      chip.setAttribute('aria-pressed', 'false');
      chip.textContent = (o.steps[i].chip !== undefined) ? o.steps[i].chip : String(v);
      /* ⚠ 每个 chip 要关住**自己的** v 与 DOM 引用 —— ES5 的 var 没有块作用域。
       *   （`addEventListener` 本身是同步调用、传的是当轮那个 chip，所以不闭也对；
       *     但显式闭起来更稳，免得将来有人在 click 回调里写 `chip`。） */
      (function (val, el) {
        el.addEventListener('click', function () {
          try { o.onPick(Number(val)); } catch (e) { log('选档出错：' + e); }
          clearCustom(id);                  // 换成档位了 ⇒ 自定义输入框让位
          markBlock(id, val);
          closeAll();                       // ★ 定案③：选完自动收
        });
      })(v, chip);
      grid.appendChild(chip);
      chips.push(chip);
    }

    /* ---- 自定义输入行 + 提示行（本轮新增；定案④：回车生效，越界不执行 + 提示）----
     * ★★ 位置：**放在档位网格的上面**（不是下面）。这是真机逼出来的：
     *   书页是横屏 780×360，数字键盘一弹顶边在 **CSS y≈108**（只留上面 ~108px 可见）。
     *   输入行若在网格下面，它的 y≈92、提示行 y≈114 ⇒ **提示行仍被键盘压住**，
     *   用户看不见「数值不合理」（那正是定案④要的东西）。
     *   放到上面后：输入行 y≈49、提示行 y≈72，两个都稳稳在键盘上方 ✓
     *   （档位网格仍在下方，能看见第一行、键盘收起后全见 —— 不影响它原有的用法。） */
    var inp = null;
    var tip = null;
    if (o.custom) {
      var rowIn = document.createElement('div');
      rowIn.className = 'shell-speed-input';
      inp = document.createElement('input');
      inp.className = 'shell-speed-num';
      inp.type = 'text';
      inp.setAttribute('inputmode', 'decimal');   // 手机弹数字键盘（Chrome 66+ 支持）
      inp.setAttribute('autocomplete', 'off');
      inp.setAttribute('spellcheck', 'false');
      inp.setAttribute('maxlength', '6');
      inp.setAttribute('aria-label', o.cap + '，自定义数值，回车生效');
      inp.placeholder = secText(o.custom.min) + '~' + secText(o.custom.max);
      rowIn.appendChild(inp);
      var unit = document.createElement('span');
      unit.className = 'shell-speed-unit';
      unit.textContent = '秒';
      rowIn.appendChild(unit);
      panel.appendChild(rowIn);

      tip = document.createElement('div');
      tip.className = 'shell-speed-tip';
      tip.setAttribute('data-bad', '0');
      panel.appendChild(tip);

      function commit() {
        var raw = inp.value;
        if (String(raw === null || raw === undefined ? '' : raw).trim() === '') {
          setTip(id, '', false);                 // 空输入：不动作、不报错
          inp.setAttribute('data-bad', '0');
          return;
        }
        var sec = parseSec(raw);
        if (!isFinite(sec) || sec < o.custom.min || sec > o.custom.max) {
          /* ★ 定案④：**不执行**，只提示。绝不"猜一个近似值"替用户决定。 */
          inp.setAttribute('data-bad', '1');
          setTip(id, '数值不合理', true);
          log('自定义值越界，不执行：' + raw);
          return;
        }
        var val = o.custom.toVal(sec);
        var r = null;
        try { r = o.onPick(val); } catch (e) { log('应用自定义值出错：' + e); }
        if (r && r.ok === false) {               // 动作层再拦一道（如自动低于 300ms）
          inp.setAttribute('data-bad', '1');
          setTip(id, '数值不合理', true);
          return;
        }
        inp.setAttribute('data-bad', '0');
        setTip(id, secText(sec) + ' 秒', false);  // 如实回显生效值
        markBlock(id, presetOf(o.steps, val, o.valKey || 'ms'));   // 不是档位就不亮
        /* ★★ 成功之后**主动收起键盘**（blur）—— 两个理由，都是真机逼出来的：
         *   ① 不 blur 的话输入框一直拿着焦点 ⇒ 打字避让一直生效（竖栏钉在顶部、
         *      上面几行被收起），用户想接着点档位会看不懂界面；
         *   ② 键盘不关，那句「1.4 秒」的回显就被键盘挡着，算什么"如实回显"。
         *   ⚠ 而**输了不合理值时不 blur** —— 保持焦点好让他直接改，
         *     提示行由打字避让保证在键盘上方可见。这是两条路故意的不对称。 */
        try { if (inp.blur) { inp.blur(); } } catch (e2) { /* 忽略 */ }
        /* ⚠ 这里**不 closeAll()**：面板留着 —— 用户可能想接着调下一个值。
         *   要收起点一下折叠按钮即可（档位那条路仍是"选完自动收"）。 */
        log('自定义生效：' + sec + ' 秒');
      }

      inp.addEventListener('keydown', function (e) {
        var k = e && (e.key || e.keyCode);
        if (k === 'Enter' || k === 13) { commit(); }
      });
      /* ★ 打字避让：聚焦 ⇒ 竖栏提到顶部（否则输入框在键盘后面，见 setTyping 注释） */
      inp.addEventListener('focus', function () { setTyping(true); });
      inp.addEventListener('blur', function () { setTyping(false); });
      /* 输入期间先把红字清掉：用户已经在改了，不该继续挂着上一次的报错 */
      inp.addEventListener('input', function () {
        if (inp.getAttribute('data-bad') === '1') {
          inp.setAttribute('data-bad', '0');
          setTip(id, '', false);
        }
      });
    }

    panel.appendChild(grid);               // ★ 档位网格在**下方**（见上面那段注释）

    /* ★★ 面板必须挂到组块上 —— 写成这样一行是**故意的**：
     *   第三轮改版时我把这一行漏了（改完 `if (o.custom)` 那一段后直接进了 `return box`），
     *   后果是"组块只有一颗按钮、点开什么都不出现"（档位/输入行全在游离的 panel 里）。
     *   离线仿真第 (A) 组当场报红（`shell-speed-chip` 一个都找不到）⇒ 别删这一行。 */
    box.appendChild(panel);

    btn.addEventListener('click', function () { toggleBlock(id); });

    BLOCKS[id] = { box: box, btn: btn, chips: chips, inp: inp, tip: tip, custom: o.custom };
    return box;
  }

  /**
   * 造两个组块，插进 `.status`。见文件头第五条 ⚠。
   * ⚠ 找不到就退出 —— 书改版式了就静默不动，绝不留半截控件。
   */
  function install() {
    if (document.getElementById(FLIP_BLOCK_ID)) { return true; }   // 幂等

    var p = pf();
    var a = autoApi();
    if (!p) { log('拿不到 window.__pf（老内核？）⇒ 不装翻页速度组块'); return false; }
    if (!a) { log('拿不到 window.__auto（老内核？）⇒ 不装自动翻页组块'); return false; }

    var status = document.querySelector('footer.controls .status');
    if (!status) { log('没找到 footer.controls .status，跳过'); return false; }

    /* ---- 恢复上次的设定；**自定义值原样保留，不吸附到档位**（见文件头第七条）---- */
    var savedFlip = parseInt(load('shell.flipMs'), 10);
    var flipMs = (isFinite(savedFlip) && savedFlip > 0) ? savedFlip : currentFlipMs();
    var savedAuto = parseInt(load('shell.autoMs'), 10);
    if (!isFinite(savedAuto)) {                       // 一次性迁移：旧键存的是"整数秒"
      var legacy = parseInt(load('shell.autoMode'), 10);
      savedAuto = isFinite(legacy) ? legacy * 1000 : NaN;
    }
    var autoMs = (isFinite(savedAuto) && savedAuto >= 0)
      ? savedAuto
      : (autoPlaying() ? currentAutoMs() : 0);        // 没存过 ⇒ 关（书自己的默认也是关）

    /* ---- ① 翻页组块：折叠「翻页」，点开 = 4 档 + 自定义 ---- */
    status.appendChild(mkBlock({
      id: FLIP_BLOCK_ID, name: '翻页', cap: '翻页速度 · 秒',
      steps: FLIP_STEPS,
      valOf: function (s) { return s.ms; },
      valKey: 'ms',
      onPick: function (v) { return { ok: applyFlipSpeed(v) !== false, reason: '' }; },
      /* ★ 翻页自定义：输入的是**秒**，写进库的是**参数**（见 sec2FlipMs 的换算与哨兵守卫） */
      custom: {
        min: FLIP_CUSTOM.min, max: FLIP_CUSTOM.max,
        toVal: function (sec) { return sec2FlipMs(sec); }
      }
    }));

    /* ---- ② 自动翻页组块：折叠「自动翻页」，点开 = 关 + 4 档 + 自定义 ---- */
    status.appendChild(mkBlock({
      id: AUTO_BLOCK_ID, name: '自动翻页', cap: '自动翻页 · 秒',
      steps: AUTO_STEPS,
      valOf: function (s) { return s.v; },
      valKey: 'v',
      onPick: function (v) { return applyAutoMs(v); },
      /* ★ 自动翻页自定义：输入的是**秒**，setInterval 收的是**毫秒** */
      custom: {
        min: AUTO_CUSTOM.min, max: AUTO_CUSTOM.max,
        toVal: function (sec) { return Math.round(Number(sec) * 1000); }
      }
    }));

    /* ---- ★★ 恢复设定 ⇒ 然后**回读真实状态**再画界面 ----
     * ⚠ 本轮踩的坑（离线仿真当场抓出来）：
     *   原来这里是「先画界面（用变量 flipMs / autoMs）→ 再恢复设定」。两条都不对：
     *   ① 存档是脏值（老版本存过参数 `1`）时，`applyFlipSpeed` 的哨兵守卫会把它抬到 1400，
     *      而界面按变量画出 **0.001 秒** —— 又是第一轮 D1 那个「框里写着 X、实际生效 Y」；
     *   ② 恢复排在画界面之后 ⇒ 面板高亮着「关」、其实已经在 1.7 秒/页地播。
     * ⇒ 正解：**先真正应用，再从 `__pf` / `__auto` 回读**，界面永远跟着真相走。
     *   （只在"用户真的存过"时才应用 —— 没动过的人观感一字不差。） */
    if (isFinite(savedFlip) && savedFlip > 0) { applyFlipSpeed(flipMs); }
    if (isFinite(savedAuto) && savedAuto > 0) { applyAutoMs(savedAuto); }

    syncUI();                              // ★ 回读真实值 ⇒ 高亮 / 输入框 / 提示
    openBlock(null);                       // 定案③：初始全收起
    hideBookSpeedWidgets();

    log('已装上两个组块：翻页=' + (ms2sec(currentFlipMs()) / 1000) + '秒（参数 ' + currentFlipMs()
        + '），自动翻页=' + (autoPlaying() ? (currentAutoMs() / 1000) + '秒' : '关'));
    return true;
  }

  /* ---- 书可能晚一点才把脚部挂出来 ⇒ 补几次机会（幂等，靠 id 判重）---- */
  function start() {
    var tries = 0;
    function attempt() {
      tries++;
      try {
        if (install()) { return; }
      } catch (e) { log('装控件出错：' + e); }
      if (tries < 8) { window.setTimeout(attempt, 300); }
      else { log('试了 ' + tries + ' 次都装不上，放弃（书可能没有自动翻页）'); }
    }
    attempt();
  }

  try {
    if (document.readyState === 'complete' || document.readyState === 'interactive') {
      window.setTimeout(start, 0);
    } else {
      document.addEventListener('DOMContentLoaded', function () { window.setTimeout(start, 0); });
    }
  } catch (e) { /* 忽略 */ }

  /* 给验收脚本的自测口子（与书里那几颗同风格：一个对象、只读或幂等写） */
  try {
    window.__shellSpeed = {
      /** 当前展开的组块 id（null = 全收起）。读的是真状态，不是另记一份。 */
      openId: function () { return OPEN_ID; },
      /** 两个组块的 id（验收脚本用，免得写死字符串） */
      IDS: { flip: FLIP_BLOCK_ID, auto: AUTO_BLOCK_ID },
      flipMs: function () { return currentFlipMs(); },
      /** 用户看到的**秒**（= 库参数 × 0.54，保留两位）。名字带 Sec 就必须返秒。 */
      flipSec: function () { return ms2sec(currentFlipMs()) / 1000; },
      flipLabel: function () {
        var v = currentFlipMs();
        for (var i = 0; i < FLIP_STEPS.length; i++) {
          if (FLIP_STEPS[i].ms === v) { return FLIP_STEPS[i].label; }
        }
        /* ⚠ 非档位值也要走**同一套取整**（secText，3 位）——
         *   第三轮第一版这里直接拼 `(ms2sec(v)/1000)` ⇒ 吐出「0.75978 秒」这种鬼话，
         *   而提示行显示的是「0.76 秒」，两处口径不一致。 */
        return secText(ms2sec(v) / 1000) + ' 秒';
      },
      /** 自动翻页当前间隔（毫秒）；没在播 ⇒ 0。 */
      autoMs: function () { return autoPlaying() ? currentAutoMs() : 0; },
      autoSec: function () { return (autoPlaying() ? currentAutoMs() : 0) / 1000; },
      /** 自测用：直接设，不写 localStorage（免得把用户的设定改脏） */
      probeFlip: function (ms) {
        var p = pf();
        if (!p) { return false; }
        try {
          p.getSettings().flippingTime = Number(ms);
          try { window.__shellFlipMs = Number(ms); } catch (e1) { /* 忽略 */ }
          return true;
        } catch (e) { return false; }
      },
      /** 供验收脚本读档位表与范围（不用把数字写死在脚本里） */
      STEPS: { flip: FLIP_STEPS, auto: AUTO_STEPS },
      RANGES: { flip: FLIP_CUSTOM, auto: AUTO_CUSTOM, autoMinMs: AUTO_MIN_MS }
    };
  } catch (e2) { /* 忽略 */ }
})();
