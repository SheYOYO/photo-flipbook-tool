/* ============================================================================
 * 翻页音效（sfx.js）—— 由 App 外壳在页面加载完成后注入
 * ============================================================================
 *
 * 佘先生的要求（2026-10-10，逐条对应下面"三条规则"）
 * ------------------------------------------------
 *   1. 翻**里面的书页**要有翻书声；**翻开封面、翻到尾页时不响**
 *   2. 手动翻页：翻得**快** ⇒ 声音**相应地缩短**；翻得**慢** ⇒ **只放一遍**
 *   3. 自动翻页：**间隔有多长就响多久**（长了重复、短了缩短）
 *   4. 书架页那个开关（`shelf-sfx`）关掉 ⇒ 一声不出
 *
 * 音频
 * ----
 *   `/sfx/flip.mp3`（= `assets/sfx/flip.mp3`）
 *   ★ R32（2026-10-14）换成 BigSoundBank 编号 **0164**（turned-page），**CC0 公共领域**，
 *   作者 Joseph SARDIN。他嫌 2215 那版"不够柔和"，选中 0164 的**音色与音高**，
 *   但嫌它**太短**（原 0.63s）⇒ 用 ffmpeg `atempo` **两级拉伸**到 0.97s、
 *   **音高不变**（单级不能低于 0.5 倍速，故拆成 0.794×0.794）。
 *   0.97s / 192kbps / 24KB（比原 46KB 还小一半）。
 *   授权与来源、以及"为什么这么处理"见 `assets/sfx/ATTRIBUTION.md`。
 *
 * ★★ 为什么监听 `flip` 而不是 `changeState`
 * ------------------------------------------
 *   · `changeState → "flipping"` 是**动画开始**，但它**不告诉你是哪一页**
 *     ⇒ 没法实现第 1 条（封面/尾页不响）
 *   · `flip` 是**翻完落定**才触发，`event.data` = 落定后的页码 ⇒ 能判断
 *   · 而且真实翻书声本来就是**纸张落下**那一下 ⇒ 落定时响反而更像真的
 *
 * ★★ 怎么区分「手动翻页」和「自动翻页」
 * ------------------------------------
 *   不猜——直接问 `speed.js` 已经对外挂好的口子（`speed.js:703`）：
 *       window.__shellSpeed.autoMs()   > 0 ⇒ **正在自动翻页**，值就是间隔（毫秒）
 *                                      = 0 ⇒ 不在自动翻页（= 手动）
 *       window.__shellSpeed.flipMs()        ⇒ 手动翻页的动画时长（毫秒）
 *
 * ★★ 为什么"慢 = 只放一遍"不用单独判断
 * ------------------------------------
 *   时长统一按 `min(全长, 可用时长)` 算，且**手动不循环**：
 *       慢（flipMs 2000）⇒ min(1550, 2000) = 1550 ⇒ 正好一整遍，之后静音 ✅
 *       快（flipMs  500）⇒ min(1550,  500) =  500 ⇒ 0.5s 处掐掉      ✅
 *   ⇒ 快慢只是同一个公式的两端，不需要再划一条"快慢分界线"。
 *
 * 六道保险（保证不影响原功能）
 * --------------------------
 *   1. 整段 try-catch；任何一步出错都只打日志，翻页照常
 *   2. `pageFlip` 还没初始化 ⇒ 轮询等，等不到就彻底放弃（不报错、不死循环）
 *   3. 音频加载/播放失败 ⇒ 静默（老内核、ROM 限制、文件缺失都不影响看书）
 *   4. 节流 MIN_GAP ⇒ 连翻不会叠成一团糊音
 *   5. POOL 个 Audio 实例轮换 ⇒ 快速连翻不丢音
 *   6. 音量、开关都留 `window.__shellSfx` 接口，随时可调
 *
 * ⚠ 本机有利条件：App 里已设 `mediaPlaybackRequiresUserGesture = false`
 *   （`BookPageActivity.kt`），否则翻页声会被浏览器自动播放策略拦掉。
 *   这里仍额外做一次"首次真实触摸时 0 音量解锁"，双保险。
 * ==========================================================================*/
(function () {
  'use strict';

  var TAG = '[sfx]';
  function log(m) { try { console.log(TAG + ' ' + m); } catch (e) { /* 忽略 */ } }

  // ---- 可调参数（改这里就行，不用动逻辑） --------------------------------
  var SRC = '/sfx/flip.mp3';   // 相对虚拟域根（appassets.androidplatform.net）
  var LEN_MS = 970;            // ★ R32：换音频了 ⇒ 同步改这个数（0164 拉伸版 ≈0.97s）
                               //   注：下面 `loadedmetadata` 会用**实际** duration 覆盖它，
                               //   这里只是元数据到手前的初值；填个接近的数即可。
  var VOL = 0.55;              // 音量 0~1
  var MIN_GAP = 110;           // 两次发声的最小间隔（毫秒）⇒ 连翻不叠加
  var POOL = 3;                // Audio 实例数（轮换用）
  var WAIT_TRIES = 40;         // 等 pageFlip 的轮数（×150ms ⇒ 最多 6 秒）

  if (window.__shellSfxInstalled) { log('已装过 ⇒ 不再重复安装'); return; }
  window.__shellSfxInstalled = true;

  var pool = [];
  var pi = 0;
  var dead = false;            // 音频彻底不可用 ⇒ 之后一次都不试
  var prevIdx = -1;            // 上一次落定的页码（用来判断"从封面翻开"）
  var lastPlay = 0;
  var unlocked = false;

  // ★ 验收用计数：音频播放是"黑盒"（听不见、也不在 DOM 里），
  //   没有这两个数就没法验证「封面/尾页到底响没响」「这次响多久」。
  var plays = 0;
  var lastMs = 0;
  var skipped = 0;             // 因"封面/尾页"规则而主动不响的次数

  function now() { return (Date.now && Date.now()) || new Date().getTime(); }

  /** 开关：书架页那个控件写进 `window.__shellSfxOn`（默认开）。 */
  function enabled() { return window.__shellSfxOn !== false; }

  // ---- 音频池 ------------------------------------------------------------
  function build() {
    for (var i = 0; i < POOL; i++) {
      try {
        var a = new Audio(SRC);
        a.preload = 'auto';
        a.volume = VOL;
        pool.push(a);
      } catch (e) {
        log('建 Audio 失败（无害）：' + e);
      }
    }
    if (!pool.length) {
      dead = true;
      log('★ 一个 Audio 都建不出来 ⇒ 放弃（翻页照常，只是没声）');
      return;
    }
    log('音频池就绪：' + pool.length + ' 个实例，标称全长 ' + LEN_MS + 'ms');

    // ★ 真机实测发现：MP3 的**标称**时长（按体积/码率估）与浏览器读到的**实际**
    //   `duration` 差得多（本文件 2215 号：估 1.55s，`audio.duration` 实测 **1.18s**——
    //   它是 VBR，首帧 224kbps 不代表全程）。
    //   ⇒ 拿 1.55s 当全长，"慢翻播完整一遍"就会按错的数截断。
    //   ⇒ 这里在元数据到手后**用实际值覆盖**，换音频再也不用改代码。
    try {
      pool[0].addEventListener('loadedmetadata', function () {
        try {
          var d = this.duration;
          if (d && isFinite(d) && d > 0.05) {
            LEN_MS = Math.round(d * 1000);
            log('实际时长 = ' + LEN_MS + 'ms（已覆盖标称值）');
          }
        } catch (e) { /* 忽略 */ }
      });
    } catch (e) { /* 忽略 */ }
  }

  function nextAudio() {
    var a = pool[pi];
    pi = (pi + 1) % pool.length;
    return a;
  }

  /**
   * 播 ms 毫秒：短了截断，长了重复（循环），到点一定停。
   * ★ 他与我的约定：**截断**（只播前一段，音高不变），不是加速播放。
   */
  function playFor(ms) {
    if (dead || !pool.length) return;
    if (!(ms > 0)) return;
    plays++;
    lastMs = ms;
    var a = nextAudio();
    var t0 = now();
    var stopped = false;

    function stop() {
      if (stopped) return;
      stopped = true;
      try { a.pause(); a.currentTime = 0; } catch (e) { /* 忽略 */ }
      try { a.onended = null; } catch (e) { /* 忽略 */ }
    }

    // 播完一遍还有余量 ⇒ 再来一遍（这就是"自动翻页时重复播满间隔"）
    a.onended = function () {
      if (stopped) return;
      if (now() - t0 + 40 >= ms) { stop(); return; }
      try { a.currentTime = 0; a.play(); } catch (e) { stop(); }
    };

    try {
      a.currentTime = 0;
      a.play();
    } catch (e) {
      log('play 失败（无害）：' + e);
      return;
    }
    setTimeout(stop, ms);           // ★ 到点必停 ⇒ 短则截断、长则收住循环
  }

  // ---- 时长：手动 / 自动 -------------------------------------------------
  function targetMs() {
    var auto = 0, flip = 0;
    try {
      if (window.__shellSpeed) {
        if (typeof window.__shellSpeed.autoMs === 'function') { auto = window.__shellSpeed.autoMs() || 0; }
        if (typeof window.__shellSpeed.flipMs === 'function') { flip = window.__shellSpeed.flipMs() || 0; }
      }
    } catch (e) { /* 拿不到就按默认的来 */ }

    if (auto > 0) { return auto; }                 // 自动翻页：间隔多长就响多久（可重复可截断）
    if (flip > 0) { return Math.min(LEN_MS, flip); } // 手动：截断到动画时长，且不超过全长
    return LEN_MS;                                  // 都拿不到 ⇒ 完整一遍
  }

  function totalPages() {
    try {
      if (typeof pageFlip !== 'undefined' && pageFlip && typeof pageFlip.getPageCount === 'function') {
        var n = pageFlip.getPageCount();
        if (n > 0) return n;
      }
    } catch (e) { /* 忽略 */ }
    try {
      var m = document.querySelectorAll('.book-page, .page, .stf__item');
      if (m && m.length) return m.length;
    } catch (e) { /* 忽略 */ }
    return 0;
  }

  // ---- 翻页事件 ---------------------------------------------------------
  function onFlip(e) {
    try {
      if (!enabled()) { return; }                  // 书架开关关着 ⇒ 一声不出
      var idx = Number(e && e.data);
      if (!isFinite(idx)) { return; }

      var total = totalPages();
      var from = prevIdx;
      prevIdx = idx;

      // ★ 第 1 条：封面 / 尾页 不响。
      //   口径是「**翻页的两端任一是封面或尾页**就不响」—— 不只是"落点"。
      //   为什么取这个口径（他原话「翻开封面和尾页时不要有翻书声」）：
      //     · 起点＝封面 ⇒ 那是"翻开封面"那一下          ⇒ 不响
      //     · 落点＝封底 ⇒ 那是"翻到尾页"那一下          ⇒ 不响
      //     · 起点＝封底 ⇒ 那是**从尾页往回翻**那一下 ——
      //       只判落点的话这里会漏（实测 16→15 响了），而它同样是"在尾页那一下"
      //     ⇒ 取"两端任一"把两个方向都盖住，中间那一段内页照常响。
      var lastIdx = (total > 0) ? (total - 1) : -1;
      if (idx <= 0 || from <= 0) { skipped++; log('涉及封面（' + from + '→' + idx + '）⇒ 不响'); return; }
      if (lastIdx >= 0 && (idx >= lastIdx || from >= lastIdx)) {
        skipped++; log('涉及尾页（' + from + '→' + idx + '，末页 ' + lastIdx + '）⇒ 不响'); return;
      }

      // 节流
      var t = now();
      if (t - lastPlay < MIN_GAP) { return; }
      lastPlay = t;

      var ms = targetMs();
      log('翻到第 ' + idx + ' 页 ⇒ 响 ' + Math.round(ms) + 'ms（' +
          ((window.__shellSpeed && window.__shellSpeed.autoMs && window.__shellSpeed.autoMs() > 0)
            ? '自动' : '手动') + '）');
      playFor(ms);
    } catch (err) {
      log('onFlip 出错（无害）：' + (err && err.message));
    }
  }

  // ---- 首次真实触摸时解锁（0 音量播一声）--------------------------------
  function unlock() {
    if (unlocked) { return; }
    unlocked = true;
    try {
      var a = pool[0];
      if (a) {
        var old = a.volume;
        a.volume = 0;
        var p = a.play();
        if (p && typeof p['catch'] === 'function') { p['catch'](function () { /* 忽略 */ }); }
        setTimeout(function () {
          try { a.pause(); a.currentTime = 0; a.volume = old; } catch (e) { /* 忽略 */ }
        }, 80);
        log('已用首次触摸解锁音频');
      }
    } catch (e) { /* 忽略 */ }
    try { document.removeEventListener('touchstart', unlock, true); } catch (e) { /* 忽略 */ }
    try { document.removeEventListener('pointerdown', unlock, true); } catch (e) { /* 忽略 */ }
  }

  // ---- 安装 -------------------------------------------------------------
  var waited = 0;
  function install() {
    if (dead) { return; }
    var pf = null;
    try { if (typeof pageFlip !== 'undefined') { pf = pageFlip; } } catch (e) { pf = null; }
    if (!pf || typeof pf.on !== 'function') {
      if (++waited > WAIT_TRIES) {
        log('等不到 pageFlip ⇒ 放弃（翻页照常，只是没声）');
        return;
      }
      setTimeout(install, 150);
      return;
    }
    try {
      pf.on('flip', onFlip);
      try { if (pf.getCurrentPageIndex) { prevIdx = pf.getCurrentPageIndex(); } } catch (e) { /* 忽略 */ }
      log('已挂上 flip 监听（起始页 ' + prevIdx + '，共 ' + totalPages() + ' 页，开关=' +
          (enabled() ? '开' : '关') + '）');
    } catch (e) {
      log('挂监听失败（无害）：' + (e && e.message));
    }
  }

  // ---- 对外接口（以后要加 UI 开关 / 调音量直接用它）---------------------
  window.__shellSfx = {
    /** 开 / 关（与书架那个控件同源；这里改只影响当前这一页） */
    setOn: function (b) { try { window.__shellSfxOn = !!b; } catch (e) { /* 忽略 */ } },
    /** 音量 0~1 */
    setVolume: function (v) {
      try {
        VOL = Math.max(0, Math.min(1, Number(v) || 0));
        for (var i = 0; i < pool.length; i++) { pool[i].volume = VOL; }
      } catch (e) { /* 忽略 */ }
    },
    /** 当前状态，验收脚本用 */
    state: function () {
      return {
        enabled: enabled(), volume: VOL, lenMs: LEN_MS,
        pool: pool.length, dead: dead, prevIdx: prevIdx, pages: totalPages(),
        plays: plays, lastMs: lastMs, skipped: skipped
      };
    },
    /** 手动试听（验收用）：__shellSfx.test(800) = 响 800ms */
    test: function (ms) { try { playFor(isFinite(ms) ? ms : LEN_MS); } catch (e) { /* 忽略 */ } }
  };

  try {
    build();
    install();
    try { document.addEventListener('touchstart', unlock, true); } catch (e) { /* 忽略 */ }
    try { document.addEventListener('pointerdown', unlock, true); } catch (e) { /* 忽略 */ }
  } catch (e) {
    log('启动失败（无害）：' + (e && e.message));
  }
})();
