/* ============================================================================
 * 手机控制条布局（layout.js）—— 由 App 外壳在页面加载完成后注入
 * ============================================================================
 *
 * 为什么要它
 * ----------
 * 画册本来是按**电脑**排的：翻页控制条横在画面**底部**（`.room` 的第二行），
 * 占掉 49.3px 高。在手机横屏（实测视口 756×360）上这笔账很难看：
 *
 *     .room  = 310.7px（书）+ 49.3px（控制条）
 *     书因此只有 303px 高、还得让出宽度 ⇒ 跨页门槛（2×minWidth = 574）够不着
 *     ⇒ 退成单页小书，屏幕左右各空着一大条。
 *
 * 佘先生（2026-10-02）看穿了这个浪费：
 *   「控制条重新排版放在右侧，大小缩小，右侧有空白位置，一些多余的文字提示
 *     不能放就不放」。
 *
 * 于是把控制条整条搬到**右侧竖排**——那一列本来就是空白（书 576 宽 vs 视口
 * 756 宽 ⇒ 右侧空 90px）。底部让出来之后，舞台恢复整屏高，书自己就跨页顶满了。
 *
 * 怎么做到的
 * ----------
 *   · **DOM 一个节点都不动**：只注入一段 <style>，用 CSS 重排
 *   · 中间两层（`.status` / `.status-row`）用 `display: contents` **摊平**，
 *     好让页码、跳页、自动翻页排进同一条竖列 —— DOM 树不动，只是布局上"少一层"
 *   · 顺序用 flex `order` 指定（竖栏从上到下：上一页 → 页码 → 下一页 → 跳页 → 自动翻页）
 *   · **书（成品）一个字不改，电脑工具一个字不改**
 *
 * 砍掉了什么（按"不能放就不放"）
 * ------------------------------
 *   · 「跳到第」「页」两个文字标签 → 窄栏里放不下，藏掉；输入框与「跳转」按钮还在，
 *     回车或点按钮都能跳页。页码那颗按钮点一下还能就地变输入框（书自带的入口，没动）
 *   · 其余功能一个不少：上/下一页、页码、跳页、自动翻页、速度、全屏
 *
 * ★★ 2026-10-02 二次改动（佘先生真机实测后提的两条）
 * -------------------------------------------------
 * 他的原话：「画面有些不美观，优化一是把收起条这个UI组块的操作功能变成只有收起操作条，
 *   而不调整画册大小，事实上调整了画面大小反而不美观，优化二是收起条的UI组块显示变成
 *   一个圆形，空心圆，很简洁的圆，不需要有文字在上面，总之是改变操作链和视觉链」。
 *
 *   一、**收起条只收条，画面一个像素不动**（改动 11 + 文件末尾那段 JS）
 *       书原本的做法是给 <html> 挂一个 `.fs-net`，可这一个类**同时**干三件事：
 *         ① `html.fs-net .controls { display: none }`   藏起控制条   ← 我们要
 *         ② `html.fs-net .book-rig { … 100cqh … }`      撤尺寸上限   ← 不要
 *         ③ `html.fs-net .book-rig { transform: scale(var(--fs-scale,1)) }` 放大顶满 ← 不要
 *       ②③ 就是"画面突然变大"的来源：手机上 fsFillScale() 算出 **1.25 倍**
 *       （756×360 比跨页比例 1.6 宽得多），放大后被 .stage 裁掉 ⇒ **每条边少 10% 照片**。
 *       而我们的舞台早就把控制条做成了 `position: fixed`（不占版面）、书也本来就在
 *       舞台里顶满 ⇒ ②③ 在这里纯属副作用。
 *       做法：JS 在 **capture 阶段**把那颗按钮的 click 拦下来（书的处理器收不到事件），
 *       改挂外壳自己的 `html.shell-bar-off` —— 书那边的 `.fs-net` 永远不会被挂上。
 *       ⚠ 真全屏（`document.fullscreenElement` / `display-mode: fullscreen`）里**不接管**，
 *         那边"顶满"是本来就要的，原样交给书。
 *
 *   二、**那颗开关变成一个空心圆**（改动 12）
 *       按钮文案（「收起条」/「显示条」）是书里的脚本写进去的，DOM 里抹不掉 ⇒
 *       用 `font-size: 0` 把它压没：不显形、不占地方，无障碍名字照旧留着
 *       （书会写 aria-label，我们接管后再写一遍）。
 *       顺带修掉一个实测出来的毛病：触摸点过的按钮会留住焦点，浏览器给它套一圈
 *       橙色方框（`outline: 1px auto rgb(229, 151, 0)`，vivo 主题色），一颗干净的
 *       圆环边上多一个方块 —— 已用 `outline: none` + 处理完 `blur()` 去掉。
 *       老内核不认 `:focus-visible`，所以另外补了一条 `:focus-visible` 规则：
 *       83 上被丢弃 ⇒ 手机永远不出现橙框；新内核上键盘聚焦仍有灰绿描边。
 *
 *   三、**按下时圆环里的空白充黑**（改动 13）
 *       佘先生：「点击不要发蓝光方形特效，要求是圆形中的空白充黑」。
 *       那个"蓝光方形"是 Android WebView 自带的**点击高亮**：
 *           `-webkit-tap-highlight-color` 算出来 = rgba(51, 181, 229, 0.4)
 *        而且它**不跟随圆角** ⇒ 圆形按钮上盖出一个蓝色方块。已在第 5b) 条全页关掉。
 *       新的反馈是给 <html> 挂 480ms 的 `shell-bar-hit`，让圆环内部填成墨色
 *       （只填 background、边框不动 ⇒ 黑盘 + 一圈细环）。时长由 BAR_HIT_MS 定。
 *
 * ⚠ 踩过的坑（别重犯）
 * --------------------
 *   `.status`/`.status-row` 摊平成 `display: contents` 之后，**绝对不要再给同一个
 *   元素写 `display`** —— 哪怕写在后面一点点。两条规则特异性相同（都是 0,2,1）、
 *   都带 !important，**后写的赢**，于是摊平被静默顶掉：
 *   现象是「上一页/页码/下一页排好了，只有自动翻页那一组还挤成一块」。
 *   所以下面**没有** `.auto-row { display: … }` 这条 —— 它摊平之后，子元素
 *   直接受 `footer.controls` 的 flex 与 gap 管，不需要也不应该单独写。
 *
 * ★★★ 2026-10-03 三次改动（佘先生：「双击右下角的圆形 UI 组块可以两张图片全屏，
 *   再点击一下，就是退出两张图片全屏」）
 * -------------------------------------------------------------------------
 *   那颗圆现在有两种按法：
 *     · **单击**（等满判定窗、没有第二下）= 只收 / 显控制条，**画面一个像素不动**（= 二次改动）
 *     · **双击**                        = 进 / 出「两张全屏」
 *
 *   「两张全屏」**不自己实现** —— 书在**普通窗口**下的原生行为正好就是它：
 *   `barToggle` 的 click 在 `fsReadingMode()` 为假时走 `fsNetUserOff = !fsNetUserOff`
 *   ⇒ `applyFsNet()` 挂 / 摘 `html.fs-net`
 *   ⇒ 藏条 **+ 把书放大到 `--fs-scale`（手机算出来 1.25 倍）铺满屏幕**（每条边裁掉 10%）。
 *   ⇒ 做法就是**放行一次 click 给书**，不拦不改；壳只做一件事：把 `shell-bar-off` 摘掉，
 *     免得壳的状态与书的 `.fs-net` 叠在一起、退出时"条回不来"。
 *
 *   ⚠ 为什么不自己加类：书的净屏是**内部状态**（`fsNetOn` / `fsNetUserOff`）驱动的一整套
 *     （尺寸、`--fs-scale`、派发 resize、放大后的坐标折回 `fsRelay`）。外面只加类，
 *     内部状态就对不上，下一次翻页 / 缩放会从错的基准算起（A7 的灯箱踩过同一个坑）。
 *   ⚠ 单击也要**延后**：不然双击的第一下会先把条收掉 —— 变成"点两下收两次条 + 进一次全屏"。
 *     延后时长 `BAR_DOUBLE_MS` **必须与 `gesture.js` 的 `SINGLE_DELAY_MS` 一致**（都是 350ms）
 *     —— 两个文件各是一个 IIFE、共享不了常量，**改一个要记得改另一个**。
 *   ⚠ 真全屏里不接管（`inRealFullscreen()`）：那边书有自己的"条显/隐"一套，原样交给它。
 *
 * 风险控制
 * --------
 *   · 整段包在 try-catch 里，出错只打日志，**绝不把 App 带走**
 *   · 只在**找得到 `footer.controls`** 时才注入（找不到就是书换版式了，静默不动）
 *   · 注入后主动让翻页库重算一次：底部那 49px 一让出来，舞台尺寸就变了，
 *     库需要重算才能从"单页"切回"跨页"
 *   · 接管开关是**幂等**的（挂在 window 上的处理器每次注入先摘再挂），
 *     反复注入不会出现"点一下切两次"这种鬼打墙
 * ==========================================================================*/
(function () {
  'use strict';

  var TAG = '[layout]';
  function log(m) { try { console.log(TAG + ' ' + m); } catch (e) { /* 忽略 */ } }

  var CSS = [
    '/* ============================================================',
    '   手机控制条布局（layout.js 注入）—— 底部横排 → 右侧竖栏',
    '   ============================================================ */',

    '/* 1) 整页不许滚动；舞台不再为底部控制条让行（.room 收回单行）',
    '      舞台上下那 4px 内边距也必须去掉 —— 它正好卡在跨页门槛上：',
    '      书宽 = 舞台可用高 × 每页比例 × 2，扣掉内边距是 352×0.8×2 = 563.2，',
    '      小于门槛 574（= 2 × 书配置 minWidth 287）⇒ 退成单页；',
    '      去掉后舞台可用高 360 ⇒ 书宽 576 ≥ 574 ✓ 跨页 */',
    'html { overflow: hidden !important; }',
    '.room { grid-template-rows: minmax(0, 1fr) !important; }',
    '.stage { padding: 0 !important; }',
    /* ★ 二十一轮（2026-10-10）：**顶部让开状态栏**。
       App 铺满整屏后（Kotlin `setDecorFitsSystemWindows(false)` 恒开），WebView 视口
       变成 780×360，而**顶部 28 CSS px 压着状态栏** ⇒ 书必须避开它，否则封面被压住。
       `--shell-safe-top` 由 App 注入（单位 CSS px，全屏态系统栏收起时为 0）。
       ⚠ 为什么书的大小一个像素不变：`compat.js` 量的是 `stage.clientHeight` 再**减掉
         paddingTop+paddingBottom**，得到 `availH` ⇒ 360 − 28 = **332**，与铺满前完全相同
         ⇒ 书的高仍是 332、宽仍是 531，**跨页门槛照样过**。
       ⚠ 变量没注入时退化成 0 ⇒ 与改动前逐像素一致（不会把电脑上的书弄坏）。 */
    '.stage { padding-top: var(--shell-safe-top, 0px) !important; }',

    '/* 2) 控制条：脱离文档流，贴屏幕右侧垂直居中 */',
    'footer.controls {',
    '  position: fixed !important;',
    '  left: auto !important;',
    '  right: 4px !important;',
    /* ★ 二十一轮：视口铺满后，**书的中心比视口中心低「安全区的一半」**
       （书在 28..360 之间、中心 194；视口中心 180）⇒ 竖栏若还按 50% 居中，
       相对书就会偏高 14px。这里下移 safe/2 与书对齐。变量缺失 ⇒ 退化成 50%，与原来一致。 */
    '  top: calc(50% + var(--shell-safe-top, 0px) / 2) !important;',
    '  bottom: auto !important;',
    '  transform: translateY(-50%) !important;',
    '  width: 74px !important;',
    '  height: auto !important;',
    '  min-height: 0 !important;',
    '  margin: 0 !important;',
    '  padding: 9px 5px !important;',
    '  display: flex !important;',
    '  flex-direction: column !important;',
    '  align-items: center !important;',
    '  justify-content: center !important;',
    '  gap: 8px !important;',
    '  grid-template-columns: none !important;',
    '  grid-template-rows: none !important;',
    '  background: rgb(255 255 255 / 88%) !important;',
    '  border-radius: 15px !important;',
    '  box-shadow: 0 4px 14px rgb(29 37 21 / 14%) !important;',
    '  z-index: 30 !important;',
    '}',

    '/* 3) 摊平中间两层（DOM 不动，只在布局上少一层）',
    '      ⇒ 页码 / 跳页 / 自动翻页 升格成同一条竖列里的兄弟项，好排序',
    '      ⚠ 别给 .status-row 再写 display，会顶掉这里的 contents（见文件头"踩过的坑"） */',
    'footer.controls > .status,',
    'footer.controls .status-row { display: contents !important; }',

    '/* 4) 竖排顺序（默认 DOM 序是 上一页 → 状态块 → 下一页，这里重排） */',
    'footer.controls #previous        { order: 1 !important; }',
    'footer.controls #page-jump       { order: 2 !important; }',
    'footer.controls #next            { order: 3 !important; }',
    'footer.controls #page-input      { order: 4 !important; }',
    'footer.controls .jump-row        { order: 5 !important; }',
    '/* ★ 2026-10-08：两个速度组块（由 speed.js 直接插进 .status）。',
    '   佘先生：「跳转页面的功能下方先放翻页的速度…在翻页组块的下方放调节自动翻页的',
    '   组块」⇒ 翻页组块 order 6、自动翻页组块 order 7，都排在跳页行(5)之下。',
    '   ⚠ 两块是**各自**占一个 order 的兄弟项，中间不能再包一层 —— 包了就共享 order',
    '     （第一版就是被 .shell-speed-row 那一层坑的，见 speed.js 文件头）。',
    '   ⚠ 书自带的 #page-auto（开关）与 #page-auto-speed（10 档）由 speed.js display:none，',
    '     这里仍给它们 order —— **不能把节点摘掉**：书的 flipbook.js 一开头就',
    '     querySelector 拿引用并挂 click/change，摘了会让自动调速失灵。 */',
    'footer.controls #shell-speed-flip { order: 6 !important; }',
    'footer.controls #shell-speed-auto { order: 7 !important; }',
    'footer.controls #page-auto       { order: 8 !important; }',
    'footer.controls #page-auto-speed { order: 9 !important; }',
    'footer.controls #page-full       { order: 10 !important; }',

    '/* 5) 控件统一缩小（原来按钮是 36px 见方、字号 15px，窄栏里放不下） */',
    'footer.controls button {',
    '  min-width: 0 !important;',
    '  border: 1px solid #dcdfd5 !important;',
    '  border-radius: 7px !important;',
    '  background: #fff !important;',
    '  color: inherit !important;',
    '  font: 400 11px/1.3 var(--book-sans) !important;',
    '  cursor: pointer !important;',
    '}',

    '/* 5b) ★ 2026-10-02：关掉 Android WebView 自带的「点击高亮」方块 ——',
    '       佘先生真机反馈：「点击不要发蓝光方形特效」。',
    '       成因（读计算值取的，不是猜）：',
    '           getComputedStyle(#bar-toggle).webkitTapHighlightColor',
    '             = rgba(51, 181, 229, 0.4)      ← #33B5E5，安卓经典的 Holo 蓝',
    '       WebView 在手指按下时会把这一层盖在元素上，而且**不跟随 border-radius**',
    '       ⇒ 一颗圆环上凭空多出一个**蓝色方块**。',
    '       ⚠ 这东西**截图抓不到**：抬手后很快消失。实测按住不动 + 连拍 8 帧，',
    '         像素扫描的蓝色差值恒为 0（只有圆环自身边框浓淡在变）—— 要判它只能读计算值。',
    '       `-webkit-tap-highlight-color` 是**继承属性** ⇒ 写在 html 上全页生效；',
    '       下面再单独点一遍按钮，是让"这两处是故意关的"留下凭据。',
    '       只关 App 里的这一份（这段 CSS 只由手机壳注入），**电脑上那份书一个字没动**。 */',
    'html { -webkit-tap-highlight-color: transparent !important; }',
    'footer.controls button,',
    '#fs-dock button {',
    '  -webkit-tap-highlight-color: transparent !important;',
    '  -webkit-user-select: none !important;',
    '  user-select: none !important;',
    '}',

    '/* 5c) ★★ A11（2026-10-04）：全 App 根除「点完留下焦点黄框」',
    '       佘先生：「我在单个图片全屏的时候点击退出的 UI 组块，是不要显示一个圆圈被黄色',
    '       方框包裹的效果，以后就是说不管我点击那个 UI 组块包括功能条的组块都不要有类似的',
    '       效果，除非我之前或者之后有指定」。',
    '       ⚠ 这与第 5b) 条的「蓝色方块」是**两件事**：那个是 tap-highlight（点击高亮：',
    '         手指按下时盖一层半透明色、**不跟随圆角**，抬手就没）；',
    '         这个是**焦点框**（focus outline）—— 手指抬起之后**留在按钮上**（因为它拿到了',
    '         焦点），所以看起来就是"圆圈被一个方框包住"。',
    '       实测（A11 真机 vivo Z5，`tools/_dbg_close.py`，两条都是真实输入）：',
    '           · 真实点一下功能条的「上一页」⇒ 松手后 document.activeElement = #previous、',
    '             getComputedStyle(它).outline = 1px auto rgb(229, 151, 0)  ← 橙黄，vivo 主题色；',
    '           · 先把焦点 blur 掉，再真实按住灯箱那颗关闭钮 ⇒ 松手后',
    '             activeElement = .lightbox__close、outline 同样是 1px auto rgb(229,151,0)。',
    '       ⚠ 第 12)/14) 条当年**只治了壳自己那两颗圆钮**（#bar-toggle / #shelf-back），',
    '         书里的元素（灯箱的 .lightbox__close、footer.controls 里的按钮、.bar-toggle …）',
    '         一个都没治 ⇒ 真机上点它们照样出黄框。这一条把口径**提到全页**。',
    '       ⚠ 书自己写过 `.lightbox__close:focus-visible { outline: 2px solid #fff }`，',
    '         但 **`:focus-visible` 是 Chrome 86+**，真机是 Chrome 83 ⇒ 整条被丢弃',
    '         ⇒ 落回 UA 默认的橙框。所以兜底必须用「无条件 :focus」那一条。',
    '       做法（与第 12) 条对 #bar-toggle 的写法**完全同一套**，只是提到全页）：',
    '         · 第一条给**触摸 / 鼠标**：点完不留框 ⇒ 老内核上看到的就是一颗干净的圆；',
    '         · 第二条给**键盘 / 无障碍**：新内核 Tab 过去仍然看得见（灰绿描边）——',
    '           83 不认识 :focus-visible，整条会被丢弃，**正是我们要的**。',
    '       ⚠ 必须带 !important：书里那些 :focus-visible 规则特异性更高（0,2,0 > 0,1,0），',
    '         不带就压不住它们。',
    '       ⚠ 只由手机壳注入 ⇒ **电脑上那份书一个像素没动**。 */',
    ':focus { outline: none !important; }',
    ':focus-visible {',
    '  outline: 2px solid rgb(75 81 66 / 70%) !important;',
    '  outline-offset: 2px !important;',
    '}',

    'footer.controls #previous,',
    'footer.controls #next {',
    '  width: 32px !important;',
    '  height: 32px !important;',
    '  padding: 0 !important;',
    '  border-radius: 50% !important;',
    '  font-size: 15px !important;',
    '}',

    '/* 页码：点它还能就地变输入框（书自带入口，没动） */',
    'footer.controls #page-jump {',
    '  width: auto !important;',
    '  height: auto !important;',
    '  padding: 3px 8px !important;',
    '  border-color: transparent !important;',
    '  background: none !important;',
    '  font: 400 13px/1.2 var(--book-serif) !important;',
    '  font-variant-numeric: tabular-nums !important;',
    '  letter-spacing: .02em !important;',
    '}',
    'footer.controls #page-jump #page-status { font: inherit !important; color: #565c4d !important; }',

    '/* 6) 跳页：砍掉「跳到第 / 页」文字标签，输入框与按钮并排一行 */',
    'footer.controls .jump-row {',
    '  width: 100% !important;',
    '  display: flex !important;',
    '  flex-direction: row !important;',
    '  align-items: center !important;',
    '  justify-content: center !important;',
    '  gap: 3px !important;',
    '}',
    'footer.controls .jump-row .jump-row-k,',
    'footer.controls .jump-row .jump-row-u { display: none !important; }',
    'footer.controls .jump-row input {',
    '  width: 33px !important;',
    '  margin: 0 !important;',
    '  padding: 3px 2px !important;',
    '  text-align: center !important;',
    '  font: 400 11px/1.3 var(--book-sans) !important;',
    '}',
    'footer.controls .jump-row .page-go {',
    '  width: 28px !important;',
    '  padding: 3px 0 !important;',
    '  font-size: 10px !important;',
    '}',

    '/* 7) 自动翻页 / 速度 / 全屏（摊平后直接是竖列的兄弟项，只收宽度） */',
    'footer.controls #page-auto       { width: 64px !important; padding: 3px 0 !important; }',
    'footer.controls #page-auto-speed { width: 64px !important; padding: 2px 0 !important; font-size: 11px !important; }',
    'footer.controls #page-full       { width: 64px !important; padding: 3px 0 !important; }',

    /* 7b) ★ 2026-10-08（第二轮）：两个速度组块（speed.js 直接插进 .status）。
     *
     *  组块 = 一颗折叠按钮 + 一块展开面板。折叠态只写名称（「翻页」/「自动翻页」），
     *  点开就地展开成档位按钮。宽度与右侧竖列其它项一致（64px）——
     *  Phase 28 刚把脚部从 121px 压到 46px，加控件不能把它又撑回去。
     *  ⚠ 面板的开合**不用 hidden 属性**：下面那条 display:none 带 !important，
     *    而 hidden 只等价于一条普通 display:none ⇒ 会被它顶掉、面板永远看得见。
     *    所以用 data-open 属性做开关，规则只有两条、谁也别想盖。
     *  ⚠ 档位只写数字、单位放进小标题与输入行的「秒」里 —— 64px 宽的竖栏里放不下
     *    「0.76 秒」（约 40px）。
     *  ⚠ 两块**都是 2 列**：翻页 4 档排 2×2；自动翻页 = 「关」占满一行 + 4 档排 2×2。
     *    （第二轮自动翻页用过 3 列 —— 那是为了塞下 11 档；现在只剩 4 档，回 2 列更好按。）
     *    2 列时每颗档位 = (64 − 3) / 2 = **30.5px**，放「0.5 / 1.5」这种两位小数够用。
     *
     *  ★★ 2026-10-08 真机实测修（**横向溢出**，首版栽在这，差点当观感小毛病放过去）：
     *    现象：自动翻页那 3 列里，**第 3 列（3 / 6 / 9）整列画到屏幕外**，
     *      真点被 clamp 到屏幕右缘 ⇒「点 3 秒」实际点到「2 秒」。
     *    量出来的账（真机 780×360）：
     *      竖栏内容宽 64px；而网格的**计算轨道**是 `36px 36px 36px`（+gap = 114px），
     *      每颗档位的**计算宽度 = 36px**。
     *    根因两截，缺一个都不会溢出：
     *      ① 书自带 CSS 给 `footer.controls button` 定了 **36px 见方**。
     *         第 5) 条当年只压了 `min-width`，**没压 `width`** ⇒ 我们的档位继承到 36px 宽。
     *      ② `1fr` 等价于 `minmax(auto, 1fr)`，那个 `auto` 最小值会**吃到档位的
     *         指定宽度 36px** ⇒ 轨道被顶到 36px，`min-width:0` 也拦不住。
     *    修法（两条一起上，少一条都不稳）：
     *      · `minmax(0, 1fr)` —— 把轨道最小值**显式钉成 0**（这是 grid 溢出的标准写法）；
     *      · 档位 `width: 100%` + `box-sizing: border-box` —— 宽度交给轨道决定，
     *        长度不再由书的 36px 说了算，边框也不会把 19px 的列再撑出 2px。
     *    ⚠ 教训同 F122：「有宽度」不算修好，判据必须**宽高两个维度都卡**。
     *      本轮的验收脚本原来只卡了纵向（竖栏没顶出屏幕）⇒ 横向溢出**一条都没报**。
     *      已补：每颗档位 `x + w ≤ viewport 宽`、网格不越出竖栏内容盒。 */
    'footer.controls .shell-speed-block {',
    '  width: 100% !important;',
    '  display: flex !important;',
    '  flex-direction: column !important;',
    '  align-items: center !important;',
    '}',
    'footer.controls .shell-speed-btn {',
    '  box-sizing: border-box !important;',
    '  width: 100% !important;',
    '  height: 22px !important;',
    '  padding: 0 !important;',
    '  border: 1px solid #dcdfd5 !important;',
    '  border-radius: 7px !important;',
    '  background: #fff !important;',
    '  color: inherit !important;',
    '  font: 400 11px/1.3 var(--book-sans) !important;',
    '  cursor: pointer !important;',
    '}',
    'footer.controls .shell-speed-block[data-open="1"] .shell-speed-btn {',
    '  border-color: rgb(75 81 66 / 55%) !important;',
    '  background: rgb(75 81 66 / 8%) !important;',
    '}',
    'footer.controls .shell-speed-panel { display: none !important; }',
    'footer.controls .shell-speed-block[data-open="1"] .shell-speed-panel {',
    '  display: block !important;',
    '  width: 100% !important;',
    '  margin-top: 4px !important;',
    '}',
    'footer.controls .shell-speed-cap {',
    '  margin: 0 0 3px !important;',
    '  font: 400 10px/1.3 var(--book-sans) !important;',
    '  color: #8a8f80 !important;',
    '  text-align: center !important;',
    '}',
    'footer.controls .shell-speed-grid {',
    '  display: grid !important;',
    '  grid-template-columns: repeat(2, minmax(0, 1fr)) !important;',
    '  gap: 3px !important;',
    '  margin-top: 3px !important;',
    '}',
    'footer.controls .shell-speed-chip {',
    '  box-sizing: border-box !important;',
    '  width: 100% !important;',
    '  min-width: 0 !important;',
    '  height: 20px !important;',
    '  padding: 0 !important;',
    '  border: 1px solid #dcdfd5 !important;',
    '  border-radius: 5px !important;',
    '  background: #fff !important;',
    '  color: inherit !important;',
    '  font: 400 11px/1.3 var(--book-sans) !important;',
    '  text-align: center !important;',
    '  cursor: pointer !important;',
    '}',
    'footer.controls .shell-speed-chip[aria-pressed="true"] {',
    '  border-color: rgb(75 81 66 / 55%) !important;',
    '  background: rgb(75 81 66 / 12%) !important;',
    '}',
    'footer.controls #shell-speed-auto .shell-speed-chip:first-child {',
    '  grid-column: 1 / -1 !important;',
    '}',

    '/* 7c) ★ 2026-10-08（第三轮）：自定义数值输入行 + 提示行。',
    '   · 输入行 = 输入框（弹性占满）+ 「秒」；越界时输入框描红（data-bad="1"）。',
    '   · 提示行**常驻保留高度**（min-height:12px）—— 出错时才显示文字，',
    '     这样"出红字"不会把整条竖栏又顶高一截（几何稳定比省那 12px 重要）。',
    '   · 单位「秒」固定在右边不被压缩（flex:0 0 auto），输入框 min-width:0 才收得住。 */',
    'footer.controls .shell-speed-input {',
    '  box-sizing: border-box !important;',
    '  width: 100% !important;',
    '  margin-top: 3px !important;',
    '  display: flex !important;',
    '  flex-direction: row !important;',
    '  align-items: center !important;',
    '  justify-content: center !important;',
    '  gap: 2px !important;',
    '}',
    'footer.controls .shell-speed-num {',
    '  box-sizing: border-box !important;',
    '  flex: 1 1 auto !important;',
    '  min-width: 0 !important;',
    '  height: 20px !important;',
    '  margin: 0 !important;',
    '  padding: 0 2px !important;',
    '  border: 1px solid #dcdfd5 !important;',
    '  border-radius: 5px !important;',
    '  background: #fff !important;',
    '  color: inherit !important;',
    '  font: 400 11px/1.3 var(--book-sans) !important;',
    '  text-align: center !important;',
    '  -webkit-appearance: none !important;',
    '  appearance: none !important;',
    '}',
    'footer.controls .shell-speed-num[data-bad="1"] {',
    '  border-color: #c0392b !important;',
    '  color: #c0392b !important;',
    '}',
    'footer.controls .shell-speed-unit {',
    '  flex: 0 0 auto !important;',
    '  font: 400 10px/1.3 var(--book-sans) !important;',
    '  color: #8a8f80 !important;',
    '}',
    'footer.controls .shell-speed-tip {',
    '  min-height: 12px !important;',
    '  margin-top: 2px !important;',
    '  font: 400 10px/1.2 var(--book-sans) !important;',
    '  color: #8a8f80 !important;',
    '  text-align: center !important;',
    '  word-break: break-all !important;',
    '}',
    'footer.controls .shell-speed-tip[data-bad="1"] {',
    '  color: #c0392b !important;',
    '}',

    '/* 7d) ★★ 2026-10-08（第三轮）：**打字时把竖栏提到键盘上方**。',
    '  真机实测：书页横屏 780×360，数字键盘一弹顶边在 CSS y≈231（盖掉下半屏），',
    '  而自定义输入框在 y≈263、提示行在 y≈285 ⇒ **双双在键盘后面**：',
    '  用户看不见自己在输什么，也看不见「数值不合理」。',
    '  ⚠ 页面上**量不到键盘高度**（innerHeight 与 visualViewport.height 都恒为 360，',
    '    app 是 adjustNothing）⇒ 只能"钉到顶部 + 收起上面几行"，不能按键盘精确定位。',
    '  ⚠ 收起的那几行只是**打字期间**暂时不显示，松焦/失焦立刻恢复（speed.js 的 focus/blur）。',
    '  ⚠ 钉的位置用 top:4px + transform:none 覆盖第 2) 条的垂直居中；',
    '    收起 #previous/#page-jump/#next/.jump-row 后，整条竖栏只剩两块组块（≤170px），',
    '    稳稳落在键盘上方。 */',
    'footer.controls[data-typing="1"] {',
    /* ★ 二十一轮：原来「钉到 top:4px」是相对**视口顶**；铺满后视口顶压着状态栏
       ⇒ 整条栏会钻到状态栏底下 ⇒ 必须加上安全区。 */
    '  top: calc(4px + var(--shell-safe-top, 0px)) !important;',
    '  bottom: auto !important;',
    '  transform: none !important;',
    '}',
    'footer.controls[data-typing="1"] #previous,',
    'footer.controls[data-typing="1"] #page-jump,',
    'footer.controls[data-typing="1"] #next,',
    'footer.controls[data-typing="1"] .jump-row { display: none !important; }',

    '/* 8) 书自带的浮动座（#fs-dock，里面是「收起条」那颗）挪到右下角 ——',
    '      书是按「控制条在底部」给它算位置的（脚本内联了 bottom:204px），',
    '      控制条一搬到右侧，它就插进竖栏中间、把页码盖住。',
    '      ⚠ 位置来自脚本的**内联样式**，所以必须 !important 才压得住。',
    '      ★ 第七轮：佘先生「右下角的圆形组块往屏幕中心移一点，注意是一点，',
    '        **绝不能和图片重合**，以方便用户点击」。实测（`_bar_geom.py` 真机）：',
    '          非全屏 视口756×332  书右缘在 x=644  ⇒ 书右侧空当 **112px**',
    '          全屏   视口780×360  书右缘在 x=678  ⇒ 书右侧空当 **102px**',
    '        圆心原本在 (737,313) / (761,341)，**本来就不压图**，但贴边（right:4px）。',
    '        ⇒ 取 **right: 40px**：两种视口下都仍在书外（40 < 102），',
    '          水平位移 36px（一个多按钮宽），是"往中心移一点"而不是"跑到中间"。',
    '      ⚠ 40 这个值是**按真机量的**；换机型/横竖屏若书更宽，需要重跑 `_bar_geom.py`。',
    '      ⚠ 只动水平（right），**垂直不动**：书的**下缘空当 = 0**（书是满高的），',
    '        往上移就必然压到图片 —— 佘先生说得很明确：绝不能和图片重合。',
    '      ⚠ 顺带确认：右侧竖栏（页码/翻页那颗）在 x≈678..752，',
    '        right:40 ⇒ 圆落在 x≈686..716，会与竖栏**同一区域**——',
    '        所以额外给一点透明背衬，让它在竖栏上也看得清（见下）。 */',
    '#fs-dock {',
    '  left: auto !important;',
    '  right: 40px !important;',
    '  bottom: 4px !important;',
    '  top: auto !important;',
    '}',
    '/* ★ 第七轮：移过来之后那颗圆会落在右侧竖栏那条带上，竖栏本身是半透明面板',
    '   ⇒ 圆容易被"吃"进面板色里。给它一个自己的圆形背衬（不遮字、只垫底）。',
    '   ⚠ 用 box-shadow 画外圈而不是 background：圆本身 30px，background 会盖住',
    '     竖栏底色；外圈扩散不占布局、也不挡点击。 */',
    '#fs-dock #bar-toggle {',
    '  box-shadow: 0 0 0 4px rgba(255, 255, 255, 0.55), 0 1px 6px rgb(29 37 21 / 18%) !important;',
    '}',

    '/* 9) 让书自带的「收起条」重新管用 ——',
    '      书的收起逻辑：给 <html> 加 .fs-net，再由它自己的规则',
    '          html.fs-net .controls { display: none; }',
    '      把控制条整条藏掉（按钮文字也会变成「显示条」）。',
    '      可上面第 2) 条给 footer.controls 写了 display: flex !important，',
    '      把书那条没有 !important 的规则**压住了** ⇒ 实测：点了之后 .fs-net 加上了、',
    '      按钮文字也换了，唯独控制条纹丝不动 —— 一颗点了没反应的按钮。',
    '      这里补一条**特异性更高**的规则（两个类 + 两个元素 > 一个类 + 一个元素），',
    '      把「整条控制条消失」的意图还原。 */',
    'html.fs-net footer.controls { display: none !important; }',

    '/* 10) 真全屏 + 阅读模式下，书要把控制条摆到「屏幕底部居中」——',
    '       那会回来跟照片抢地方，统一按回右侧竖栏。',
    '       （App 里 fsReadingMode() 实测为假，走的是第 9) 条那条路；这条是防它以后改。 */',
    'html.fs-reading.fs-bar footer.controls {',
    '  left: auto !important;',
    '  top: calc(50% + var(--shell-safe-top, 0px) / 2) !important;',
    '  bottom: auto !important;',
    '  right: 4px !important;',
    '  transform: translateY(-50%) !important;',
    '}',

    '/* 11) ★ 2026-10-02：手机壳自己的「收起」状态 ——',
    '       只把控制条藏起来，**画册一个像素都不动**。',
    '       书是给 <html> 挂 .fs-net 来做这事的，但那一个类还会顺带撤掉 .book-rig 的',
    '       尺寸上限、并用 transform: scale() 把书放大顶满（手机上算出来 1.25 倍 ⇒',
    '       每条边裁掉 10% 照片）。控制条在我们这儿是 fixed、本来就不占版面，',
    '       书也本来就在舞台里顶满 ⇒ 那两下全是多余的，观感上就是"画面突然跳一下"。',
    '       所以改由 layout.js 在 capture 阶段拦下那颗按钮的 click，挂外壳自己的类；',
    '       书那边的 .fs-net 永远挂不上 ⇒ 这条规则是手机壳私有的，别处一行不变。 */',
    'html.shell-bar-off footer.controls { display: none !important; }',

    '/* 12) ★ 2026-10-02：右下角那颗开关做成一个**空心圆**，不要文字',
    '       （佘先生：「变成一个圆形，空心圆，很简洁的圆，不需要有文字在上面」）',
    '       ⚠ 按钮文案是书里的脚本写进去的（「收起条」/「显示条」），DOM 里抹不掉 ——',
    '         这里用 font-size: 0 把它压没：不显形、也不占地方；',
    '         无障碍名字照旧留着（书会写 aria-label，我们接管后再写一遍）。',
    '       ⚠ 别用 display/visibility 藏文字，那会连按钮一起藏掉。 */',
    '#bar-toggle {',
    '  width: 30px !important;',
    '  height: 30px !important;',
    '  min-width: 0 !important;',
    '  min-height: 0 !important;',
    '  padding: 0 !important;',
    '  outline: none !important;',
    '  border: 1.5px solid rgb(75 81 66 / 55%) !important;',
    '  border-radius: 50% !important;',
    '  background: rgb(255 255 255 / 70%) !important;',
    '  color: transparent !important;',
    '  font-size: 0 !important;',
    '  line-height: 0 !important;',
    '  letter-spacing: 0 !important;',
    '  box-shadow: 0 1px 4px rgb(29 37 21 / 10%) !important;',
    '  -webkit-backdrop-filter: blur(4px) !important;',
    '  backdrop-filter: blur(4px) !important;',
    '}',
    '/* 条显示中 → 环画实一点；条收起了 → 淡下去。只改浓淡，不换形状、不加字，',
    '   给"现在收没收"留一个不吵人的提示。 */',
    'html.shell-bar-off #bar-toggle {',
    '  border-color: rgb(75 81 66 / 28%) !important;',
    '  background: rgb(255 255 255 / 34%) !important;',
    '}',
    '/* ⚠ 上面那条 outline: none 是给**触摸**用的（点完不留框）；',
    '   下面这条是给**键盘 / 无障碍**用的（聚焦时看得见）。',
    '   ⚠ 老内核（Chrome 83）不认识 :focus-visible ⇒ 这条会被整块丢掉，正是我们要的：',
    '     手机上永远不出现那圈橙框，桌面新内核上该有的焦点提示一个不少。 */',
    '#bar-toggle:focus-visible {',
    '  outline: 2px solid rgb(75 81 66 / 70%) !important;',
    '  outline-offset: 2px !important;',
    '}',

    '/* 13) ★ 2026-10-02：按一下 → **把圆环里的空白充黑**',
    '       （佘先生：「要求是圆形中的空白充黑」，时长他让我定）',
    '       这是一个纯反馈：条到底收没收起，仍旧只看圆环的浓淡（第 12 条）。',
    '       时长 480ms —— 由 layout.js 的 BAR_HIT_MS 给，进/出各 180ms 的过渡由下面管。',
    '       ⚠ 只改 background、**不动 border** ⇒ 得到的是"黑盘 + 一圈灰绿细环"，',
    '         是"里面被填满"而不是"整颗变成一块黑"（后者会把圆环吃掉）。',
    '       ⚠ 特异性 (1,1,1) > 第 12 条的 (1,0,0)，压得住；依旧带 !important，',
    '         是为了跟第 12 条写法一致、以后改写不容易漏。',
    '       ⚠ 别名（reduced-motion）下下面那条过渡不生效 ⇒ 黑是"硬切"上去再硬切回来：',
    '         仍然是清楚的一次按压反馈，只是没有渐变。 */',
    'html.shell-bar-hit #bar-toggle {',
    '  background: #1a1c18 !important;',
    '}',
    '@media (prefers-reduced-motion: no-preference) {',
    '  #bar-toggle { transition: border-color .18s ease, background-color .18s ease !important; }',
    '}',

    '/* 14) ★ 2026-10-02：左上角那颗「返回书架」圆钮 ——',
    '       佘先生：「我点击一个画册后要能返回书架」。',
    '       实测：Android 返回键**是好用的**（书架→书是 WebView 历史里的一条，',
    '       canGoBack() 为真）。缺的不是通路，是**看得见、点得着**的入口 ——',
    '       App 是沉浸式全屏、系统栏全藏，画面上一个提示都没有，',
    '       没人猜得到"按返回键能回书架"。',
    '       所以补一颗按钮：与右下角那颗空心圆**同一套视觉语言**（同直径、同环色、',
    '       同毛玻璃底、同按压充黑），放在**左上角** —— 那里正好是书左边那条留白',
    '       （书 576 宽居中于 756 的视口 ⇒ 左右各空 90px），压在纸上不碍事。',
    '       ⚠ 它必须**常驻**：控制条收起来（.shell-bar-off）时也在，',
    '         否则"收起了条就回不去书架" —— 所以下面不给它写 shell-bar-off 分支。',
    '       ⚠ 按钮由 layout.js **动态建**（书里没有这个节点，也不该有）：',
    '         书一个字不改，全靠外壳这一层加。 */',
    '#shelf-back {',
    '  position: fixed !important;',
    '  left: 4px !important;',
    /* ★ 二十一轮：返回圆钮同理 —— 铺满后 top:4px 会钻进状态栏，加上安全区。 */
    '  top: calc(4px + var(--shell-safe-top, 0px)) !important;',
    '  right: auto !important;',
    '  bottom: auto !important;',
    '  width: 30px !important;',
    '  height: 30px !important;',
    '  min-width: 0 !important;',
    '  min-height: 0 !important;',
    '  margin: 0 !important;',
    '  padding: 0 !important;',
    '  display: flex !important;',
    '  align-items: center !important;',
    '  justify-content: center !important;',
    '  outline: none !important;',
    '  border: 1.5px solid rgb(75 81 66 / 55%) !important;',
    '  border-radius: 50% !important;',
    '  background: rgb(255 255 255 / 70%) !important;',
    '  color: #4b5142 !important;',
    '  box-shadow: 0 1px 4px rgb(29 37 21 / 10%) !important;',
    '  cursor: pointer !important;',
    '  z-index: 31 !important;',
    '  -webkit-tap-highlight-color: transparent !important;',
    '  -webkit-user-select: none !important;',
    '  user-select: none !important;',
    '  -webkit-backdrop-filter: blur(4px) !important;',
    '  backdrop-filter: blur(4px) !important;',
    '}',
    '#shelf-back svg { display: block !important; width: 17px !important; height: 17px !important; }',
    '/* 按下时同样"圆里充黑"（与第 13) 条那颗对称），时长由 layout.js 的 BAR_HIT_MS 给 */',
    'html.shell-back-hit #shelf-back {',
    '  background: #1a1c18 !important;',
    '  color: #f2efe6 !important;',
    '}',
    '@media (prefers-reduced-motion: no-preference) {',
    '  #shelf-back {',
    '    transition: border-color .18s ease, background-color .18s ease, color .18s ease !important;',
    '  }',
    '}',
    '/* 同第 12) 条：触摸不留橙框（83 不认 :focus-visible ⇒ 这条会被丢掉，正合我们要的） */',
    '#shelf-back:focus-visible {',
    '  outline: 2px solid rgb(75 81 66 / 70%) !important;',
    '  outline-offset: 2px !important;',
    '}',

    '/* 15) ★ 2026-10-03：全屏里把这颗也**淡到"不仔细看发现不了"** ——',
    '       和右下角那颗**完全同一套口径**。',
    '       书里 Phase 46（2026-10-01）给 `.bar-toggle` 与 `#fs-dock .page-full` 定的就是',
    '       `opacity: .3`，他当时的原话是「右下角的退出全屏的 UI 组块……颜色淡化，',
    '       就是用户不仔细看发现不了这个 UI 组块」。这次他要把同一条用到**左上角这颗**上：',
    '       佘先生 2026-10-03：「我点击两张图片的全屏后，那个返回的 UI 组块的颜色变淡，',
    '       让肉眼不仔细看不出来」。',
    '       ★ 用 opacity（**不用** display / visibility）⇒ 看不见 ≠ 点不着：',
    '         opacity 不参与命中测试，摸上去照样点得动；按下去 / 聚焦立刻亮回来。',
    '         ⚠ 手机上没有 hover ⇒ 必须带上 `:active`，否则"淡了之后就真找不着了"。',
    '       ★ 判据用 `html.fs-net`（= 画面顶满、操作条收着）而**不是** `fs-reading`：',
    '         实测「点右下角那颗把操作条叫出来」之后 `<html>` 由 `fs-reading fs-net`',
    '         变成 `fs-reading fs-bar`（`fs-net` 被摘掉）⇒ 那一刻这颗会跟着亮回来，',
    '         与旁边两颗的明暗节奏天然一致。',
    '       ⚠ 只有手机壳注入这一段 ⇒ 电脑上那颗按钮一个像素都不动。 */',
    'html.fs-net #shelf-back {',
    '  opacity: .3 !important;',
    '  transition: border-color .18s ease, background-color .18s ease, color .18s ease, opacity .18s ease !important;',
    '}',
    'html.fs-net #shelf-back:active,',
    'html.fs-net #shelf-back:focus-visible {',
    '  opacity: 1 !important;',
    '}',

    '/* 16) ★ 2026-10-08（第七轮）：`#page-full`（那颗「全屏」钮）**只在非全屏时露出**。',
    '       历史：10-03（F59/F61）曾把它全砍 —— 理由是那时 App **开书就自动全屏**，',
    '       它没有可退的东西；第四轮取消自动全屏后恢复，成了**进**全屏的入口。',
    '       ★ 本轮佘先生：「点击全屏之后的退出全屏的UI组块直接砍掉」',
    '         ⇒ **进**全屏仍用它；**全屏态下不给任何退出全屏的钮**（含书自己搬进',
    '           `#fs-dock` 的那颗、以及壳第四轮补的 `#shell-fs-exit`）。',
    '         退全屏改由**左上角返回圆钮**负责（见 `backOne()` 新增的那一层）。',
    '       ⚠ 用 CSS 而不是删节点：书的 `syncExitDock()` 会在两张全屏时',
    '         `fsDock.insertBefore(fullscreenButton, barToggle)` —— 节点删了它**反而会插回来**。',
    '       ⚠ 只有手机壳注入这一段 ⇒ 电脑上那颗按钮一个像素都不动。 */',
    'html.fs-net #page-full,',
    'html.shell-native-fs #page-full {',
    '  display: none !important;',
    '}',

    '/* 16b) ★ 2026-10-08（第七轮）：第四轮补的兜底「退出全屏」**整条停用**。',
    '       它是为了解决「进了全屏退不出来」而加的；本轮佘先生把退出全屏那颗 UI 组块',
    '       **直接砍掉**，退全屏改由左上角返回圆钮负责 ⇒ 这颗补位按钮**不能再出现**',
    '       （否则它自己又成了「退出全屏的 UI 组块」，与他的要求相反）。',
    '       ⚠ 保留这条 `display:none` 而不是删样式：万一别的代码路径又建出这个节点，',
    '         它也不会冒出来（JS 侧也一并停掉了 `syncDockExit` 的补位）。',
    '       ⚠ F107 提醒：注释收尾前不许出现紧跟斜杠的强调标记，这里一律纯文字。 */',
    '#shell-fs-exit {',
    '  display: none !important;',
    '}',

    '/* 17) ★ 2026-10-03：书自己挂上 `.fs-net`（= **双击那颗圆进了"两张全屏"**）时，',
    '       右下角这颗圆环也要跟着淡下去 —— 与"控制条收起来了"是同一个视觉口径。',
    '       不加这条的话：进了两张全屏、条也确实藏起来了，可圆环还画成"实"的，',
    '       与"现在到底收没收"对不上（第 12) 条那条浓淡规则的判据只有 `.shell-bar-off`）。',
    '       ⚠ 判据用 `html.fs-net`，与第 15) 条（左上角那颗返回钮）**同一个标记**',
    '         ⇒ 两颗的明暗节奏天然一致，不会一颗亮一颗暗。 */',
    'html.fs-net #bar-toggle {',
    '  border-color: rgb(75 81 66 / 28%) !important;',
    '  background: rgb(255 255 255 / 34%) !important;',
    '}',

    '/* 18) ★ 2026-10-04（A12 · F93）：**放大中的照片页，把自己的底色让开**。',
    '       书的照片页写死了 `.art-page.photo { background: var(--ink) }`（= #292c26，深橄榄黑）。',
    '       "两张全屏"里放大/平移时照片会画到自己页面之外 —— 左页照片溢出到右页的那部分，',
    '       会被**右页这块不透明的 ink 底盖掉**（两页是两个不透明盒子，DOM 里靠后画的赢；',
    '       两个 `.zoomed` 都被抬到 z-index:50，谁在上仍由文档序决定 ⇒ 抬 z-index 解决不了）。',
    '       后果：屏幕上两图之间凭空多出一条纯色带，且**元素盒明明是相接的**',
    '       （实测带子 = CSS 378→497.7，正好从"右页左缘"到"右图内容左缘"）。',
    '       ⇒ 只在"净屏 + 该页正被放大"时把这块底色让开，照片溢出就画得过去，',
    '         两张的接缝才真叫"绑在一起"（元素盒相接 + 像素上也相接）。',
    '       ⚠ 普通窗口 / 灯箱 / 翻页动画都**不带** `.zoomed`（它由书的 `applyZoom` 挂、',
    '         `resetZoomAll` 摘，而书翻页时必调后者）⇒ 这些场合一个像素不变。',
    '       ⚠ 判据必须看**屏幕像素**：元素盒相接 ≠ 画得上（这正是 F93 的第二副面孔）。',
    '         运行时注入对照（`tools/_a12_ink.py`）：注入前全高 ink 色柱 = 361 物理 px、',
    '         注入后 = 无；1 倍态注入前后都没有带。 */',
    'html.fs-net .book-page.zoomed.art-page.photo {',
    '  background-color: transparent !important;',
    '}',
    '',
    '/* 19) ★ 2026-10-05：**书缝（两张照片之间的连接线）加粗 + 两侧虚化 + 稍微明显的阴影**。',
    '   佘先生：「两张图片中的连接线加粗，尽力模拟现实生活中的书本摊开后的书缝，',
    '            具体数值你自己定，然后连接线的两侧做虚化，要稍微明显的阴影」。',
    '',
    '   ★★★ 为什么"非改不可"（根因，实测）：',
    '   书上那两条规则用的是 `inset-block: 0`',
    '     （`styles.css:218` 的 ::before、`style/book-style.css:160-161` 的 ::after）',
    '   而真机 WebView 是 **Chrome 83**，实测 `CSS.supports("inset-block","0") === false`',
    '   ⇒ `top`/`bottom` 全是 auto ⇒ 伪元素**高 0**：',
    '       实测 `getComputedStyle(--left,"::after").height`  = 0px（width 2px）',
    '       实测 `getComputedStyle(--left,"::before").height` = 0px（width 57.6px）',
    '   ⇒ **真机上"纸缝"和"跨页过渡带"一个都没画出来**，两张照片是硬碰硬接在一起的。',
    '     所以下面四条**必须把 top/bottom 写死**——否则改什么颜色都是个 0 高度的空盒子',
    '     （这一条已踩过：只改 background/width 的候选，量出来差分恒为 0）。',
    '',
    '   ⚠ 方向账（想清楚一次，别再翻车）：伪元素都贴在**装订线那一侧** ——',
    '       --left  用 right:0（缝在它的右边）｜--right 用 left:0（缝在它的左边）；',
    '       ::after  要"贴缝最深" ⇒ --left 走 `to right`、--right 走 `to left`；',
    '       ::before 要"贴缝最深" ⇒ --left 走 `to left` 、--right 走 `to right`。',
    '     （第一版把 ::before 写反了 ⇒ 变成"外深内浅"，被真机亮度剖面当场抓出来。）',
    '',
    '   ⚠ 数值来源：真机现场比选（`tools/_gutter_tune.py`，临时注入、量完摘掉，',
    '     产品文件不动），缝区亮度剖面差分见 `tools/_emu_shot/gutter-tune.log`。',
    '     书上原样 = 缝 2px/最深 40% + 过渡带 20%宽/贴缝 26%（叠起来贴缝 ≈ 56%）。',
    '     这一版 = 缝 **17 书内px（≈9.5 CSS px）、最深 50%** + 过渡带贴缝 30%（宽 13.3%）',
    '     ⇒ 叠起来贴缝 ≈ 65%，深色核心从 1.1 CSS px 摊到 ~8 CSS px：',
    '       同一峰值、更窄、两侧更虚 ⇒ 正好是"加粗 + 虚化 + 稍微明显"三件事。',
    '',
    '   ⚠ 2026-10-05 第二版（findings F107）：宽度整体 ×2/3。',
    '     佘先生实测这批之后说：「阴影只存在在右侧，而且阴影的宽度太多了，减少三分之一」。',
    '       ① 只有右侧 = 左页 ::after 那条规则**根本没进 CSS**（根因见下面 ⚠⚠⚠ 那段）；',
    '       ② 宽度 ×2/3 = 缝 26→17px、过渡带 20%→13.3%；**刻度百分比一个没动**，',
    '          峰值深度仍是 50% / 30% ⇒ 是"同一个影子变窄"，不是"换了个影子"。',
    '',
'   ⚠ 2026-10-12 第三版（F162，佘先生拍板选 **A**）：**只降深度 ×0.65，几何一格不动**',
'     （缝仍 17px、过渡带仍 13.3%、刻度百分比一个没动）。',
'     他说前两版「连接线处的阴影过于明显」 ⇒ 峰值 50%→**33%**、30%→**20%**，',
'     叠起来贴缝 ≈ 65% → **46%**。',
'     ⚠ 数值不是估的：离线用真书渲染 + 「关掉阴影」作零点，量亮度剖面',
'       （`tools/_gutter_probe.mjs` + `tools/_gut_analyze.py`）：',
'         缝心暗度 59.2（现状）→ 41.4（A，−30%）｜B 29.5（−50%）｜C 21.0（−65%）。',
'   ⚠ 只挂 `.photo`（照片页）；内页/版权页不参与。',
'   ⚠ 放大时这两条伪元素本来就被书自己 `display:none` 掉（book-style.css:79-80）',
'     ⇒ 净屏放大里一个像素都不变。',
'   ⚠ 封面那条例外见下面第 **19b) 条**。 */',
    '/* ⚠⚠⚠ 本文件是「用 JS 字符串拼出来的 CSS」，注释里**绝不能**出现',
    '       一个星号紧接着一个斜杠 —— 那正是 CSS 注释的结束符。',
    '       实测踩过（F107 / 2026-10-05）：正文里一个加粗词组的收尾 ** 后面接了个斜杠，',
    '       注释就在那一处**提前结束**，剩下的说明文字被当成选择器 ⇒',
    '       浏览器一路吞到下一对 { } 为止 ⇒ **紧跟在注释后面的第一条规则被整条丢弃**。',
    '       症状极具迷惑性：后面三条规则全对，只有第一条像"没写" ——',
    '       而它恰好是左页的缝 ⇒ 肉眼看到的就是"阴影只存在在右侧"。',
    '       ⇒ 正文里写加粗，收尾别接斜杠；每次改完跑一遍 `tools/_css_lint.py`（专查这个）。 */',
    '.book-page.art-page.photo.--left::after {',
    '  content: "" !important;',
    '  position: absolute !important;',
    '  top: 0 !important; bottom: 0 !important;',
    '  right: 0 !important; left: auto !important;',
    '  z-index: 4 !important; pointer-events: none !important;',
    '  width: 17px !important;',
    '  background: linear-gradient(to right,',
'    rgba(16,18,13,0) 0%, rgba(16,18,13,.03) 18%, rgba(16,18,13,.08) 42%,',
'    rgba(16,18,13,.17) 68%, rgba(16,18,13,.27) 87%, rgba(16,18,13,.33) 100%) !important;',
    '}',
    '.book-page.art-page.photo.--right::after {',
    '  content: "" !important;',
    '  position: absolute !important;',
    '  top: 0 !important; bottom: 0 !important;',
    '  left: 0 !important; right: auto !important;',
    '  z-index: 4 !important; pointer-events: none !important;',
    '  width: 17px !important;',
    '  background: linear-gradient(to left,',
'    rgba(16,18,13,0) 0%, rgba(16,18,13,.03) 18%, rgba(16,18,13,.08) 42%,',
'    rgba(16,18,13,.17) 68%, rgba(16,18,13,.27) 87%, rgba(16,18,13,.33) 100%) !important;',
    '}',
    '.book-page.art-page.photo.--left::before {',
    '  content: "" !important;',
    '  position: absolute !important;',
    '  top: 0 !important; bottom: 0 !important;',
    '  right: 0 !important; left: auto !important;',
    '  z-index: 3 !important; pointer-events: none !important;',
    '  width: 13.3% !important;',
    '  background: linear-gradient(to left,',
'    rgba(28,30,24,.20) 0%, rgba(28,30,24,.10) 13%, rgba(28,30,24,.05) 32%,',
'    rgba(28,30,24,.01) 58%, rgba(28,30,24,0) 88%) !important;',
    '}',
    '.book-page.art-page.photo.--right::before {',
    '  content: "" !important;',
    '  position: absolute !important;',
    '  top: 0 !important; bottom: 0 !important;',
    '  left: 0 !important; right: auto !important;',
    '  z-index: 3 !important; pointer-events: none !important;',
    '  width: 13.3% !important;',
'  background: linear-gradient(to right,',
'    rgba(28,30,24,.20) 0%, rgba(28,30,24,.10) 13%, rgba(28,30,24,.05) 32%,',
'    rgba(28,30,24,.01) 58%, rgba(28,30,24,0) 88%) !important;',
'}',
'',
/* 19b) ★★ 2026-10-12（F162）：**封面不要书缝那条阴影**。
 *   佘先生：「封面不需要有书缝处的阴影，即左侧的阴影」。
 *
 *   ★ 为什么封面会有"左侧的阴影"（机理，本轮才查清，之前没人写下过）：
 *     `--left` / `--right` **不是书写的、也不是壳加的**，是**翻页库自己加的** ——
 *     `books/book1/vendor/page-flip.browser.js` 里 `setOrientation()` 干的事：
 *          classList.add(1 === t ? "--right" : "--left")     // 1=右页, 0=左页
 *     它按**当前跨页**动态赋类：左页拿 `--left`、右页拿 `--right`。
 *     而 `buildPageSequence` 里 `showCover` 让**封面（index 0）独占第一格**，
 *     库把它当**右页** ⇒ 拿到 `--right` ⇒ 上面第 19) 条那个 `::after` 就落在
 *     `left: 0` ⇒ 阴影正好压在**封面的左缘**。这就是他看到的"左侧的阴影"。
 *
 *   ⚠⚠ 选择器必须**凑到 4 级**（带上 `.photo`）：
 *     第 19) 条是 `.book-page.art-page.photo.--right::after`（4 个类 = 0,4,0）；
 *     若这里只写 `.book-page.art-page[aria-label=...]`（2 类 + 1 属性 = 0,3,0），
 *     特异性不够 ⇒ 被它压过 ⇒ **规则"写了等于没写"**（本轮第一版就踩了：
 *     两张截图逐像素完全相同，靠比对才发现）。写成 3 类 + 1 属性 = 同级，靠"后出现"胜出。
 *
 *   ⚠ 只关**伪元素**（书缝那两条）；外侧那圈淡阴影是 `.outer-x` / `.outer-y`
 *     两个真元素（template.js 的 `outerShadowHtml`），**不受影响、也不该去掉** ——
 *     合上的书本来就该在外缘有一点点投影。 */
'.book-page.art-page.photo[aria-label="封面"]::after,',
'.book-page.art-page.photo[aria-label="封面"]::before {',
'  background: none !important;',
'}',

    /* 20) ★★ 2026-10-08（第五轮 F132）：**新内核下「点全屏」不再触发书的"净屏放大"**。
     *
     *  现象（模拟器 Android 14 实测；真机 Chrome 83 上 `display-mode` 恒 false ⇒ 从不触发，
     *        一直潜伏）：用户点一下书里那颗「全屏」⇒ 原生沉浸式 ⇒ 系统栏藏掉 ⇒
     *  WebView 的 `display-mode` 变成 **fullscreen** ⇒ 书的 `fsReadingMode()` 判定为真
     *  ⇒ 自动挂 `html.fs-net` ⇒ **把书等比放大 1.25 倍顶满**（`--fs-scale`）**并藏起整条控制条**。
     *  ⇒ 佘先生说的「不能自动进入全屏模式」的**另一副面孔**：全屏里又被二次放大，
     *    照片边缘**被裁掉**，看着就是"画册显示不全"。
     *
     *  修法（纯 CSS，一处不改书）：
     *   · `html.fs-net` 本身**留着**（它是书整套"净屏"状态机的标记，摘了会让它的
     *     `syncExitDock` / 浮层显隐 / 双击那颗圆的语义错乱 ⇒ 那是书的地盘，别碰）；
     *   · 只把两样"观感副作用"压掉：
     *       ① `--fs-scale` 复位到 1 ⇒ **不再放大、不裁照片**（页宽由容器决定，本来就正好）；
     *       ② `.book-rig` 的 `transform: scale(var(--fs-scale))` 一并 neutralize。
     *   ⇒ 进全屏 = **只把系统栏收掉、画面按容器重新摊开**，不再偷偷裁边。
     *   ⚠ 为什么要复位而不是"禁止 fs-net"：`fs-net` 同时也是"控制条藏起来了"的标记，
     *     而**藏条正是我们想要的**（全屏就该看不到操作条）—— 要改的只是那个 1.25 倍。
     *   ⚠ 用户主动**双击右下角那颗圆**仍能进"两张全屏"（那里放大是刻意的玩法）——
     *     那条路走的是壳第 17 条那套，与本条互不干扰（本条只中和**放大**这一样）。
     *   ⚠ F107：下面注释里的强调标记后面都跟了空格，CSS 注释不会提前结束。
     */
    'html.fs-net {',
    '  --fs-scale: 1 !important;',
    '}',
    'html.fs-net .book-rig {',
    '  transform: none !important;',
    '}',

    /* ============================================================
       20) 第八轮（2026-10-08）：除封面外，页面上不许有"制作时追加的文字"
       ============================================================
     * 佘先生：「二是画册的后壳和最后一页不能有文字，就是说除了封面外不能有
     *   其他地方有制作画册时追加的文字」⇒ 他随后拍板：**版权页不留、页码留**。
     *
     * ⛔ 为什么只能在壳层做：这三处文字都由**冻结的 `_engine/template.js`** 渲染
     *   （`backcover` → `.back-mark`、`colophon` → `.colophon`、`plate` → `.folio`），
     *   一个字都不许改 ⇒ 只能用 CSS 盖住。**结构不动、引擎不动。**
     *
     * · `.back-mark`  封底（最后一页）上的书名 —— 藏
     * · `.colophon`   版权页整块（书名 + 副标题 + "N 张照片 · 本地生成"）—— 藏
     * · `.folio`      照片页页码 —— **保留**（佘先生明说"页码留"）
     *
     * ⚠ 用 `display:none`（不是 `visibility`、不是 `opacity`）：`display:none` 的元素
     *   `getClientRects().length === 0` ⇒ 验收能直接判"看不见"（F134 同族坑：
     *   `textContent` 在隐藏元素上照样读得到，**不能按文案判**）。
     * ⚠ 只藏文字、**不藏页**：版权页那一页仍是干净的白纸（页码照旧印），
     *   页序/页数与书完全一致 —— 藏掉整页会改动翻页库的页数账本，风险远大于收益。
     * ⚠ F107：注释里的强调标记后面都跟了空格，CSS 注释不会提前结束。
     */
    '.art-page .back-mark,',
    '.art-page .colophon {',
    '  display: none !important;',
    '}',

    /* ------------------------------------------------------------
       20b) 第二十二轮（2026-10-11）：版权页那格 → 与封底同款布面
       ------------------------------------------------------------
     * 佘先生：「书的最后一页，就是后壳的前一页，不能有空白页，
     *   要求这一页和后壳的样式相同」（他拍板：**整页做成布面**）。
     *
     * 为什么真机上看着"一片空白"：就是紧邻上面的第 20) 条 —— `.colophon` 整块
     *   `display:none` 之后，那格只剩一张米色纸。页序是
     *   `封面 → 图… → 版权页 → 封底`，所以"后壳的前一页"正是它。
     *
     * ⛔ 页序 / 页数 / 节点结构**一个字不动**：增删页都会改动翻页库的跨页账本
     *   （本项目最贵的一课：任何"凑页数"都会自己凑出一个两面对白的跨页）。
     *   这里只在壳层**盖一层布面** —— 用的是书自带样式里封底 `.art-page.cloth`
     *   那两样东西：`--cloth` 与 `cloth-weave.svg`（`style/book-style.css`）。
     *   ⚠ 本规则注入到**文档**里的 `<style>` ⇒ 相对 URL 按 `index.html` 解析，
     *     必须写 `style/cloth-weave.svg`（不能照抄书里那份的裸 `cloth-weave.svg`）。
     *   ⚠ 底下垫实色 `#7d8572`：万一纹样图取不到，也只是少了织纹，不会又变回白纸。
     *   ⚠ 页码一起藏掉：真机上的封底**没有页码**（第 20) 条口径），
     *     要求"样式相同"就不该单留一个浅色数字躺在布面上。
     *   ⚠ 只认 `aria-label="版权页"` 这一种标记 —— 引擎渲染 `kind:'colophon'`
     *     时写的就是它（`_engine/template.js`）；本规则匹配不到时是**空操作**，
     *     不会误伤别的页。
     */
    '.book-page.art-page[aria-label="版权页"] {',
    '  background: var(--cloth, #7d8572) url("style/cloth-weave.svg") repeat !important;',
    '  color: #f2efdf !important;',
    '}',
    '.book-page.art-page[aria-label="版权页"] .folio {',
    '  display: none !important;',
    '}',

    /* ============================================================
       21) 第八轮③（2026-10-08）：查看画册时，背景改成「磨砂木桌」
       ============================================================
     * 佘先生在三个候选里点名 **B 浅橡木**（样本 `木桌背景样本.html`）。
     *
     * ⛔ 为什么只能在壳层做：成品书的底色写在**冻结的 `books/book1/styles.css`**
     *   第 2/5 行（`:root` 与 `body` 的 `background: #fff`），一个字不许改 ⇒ 只能
     *   在这里用 `!important` 压过去。**结构不动、书不动、链①不动。**
     *   已核：`.room` / `.stage` 自身**没有**背景色（透明）⇒ 压 `html`/`body` 就够，
     *   木纹会从书四周的留白露出来；书页自己不透明（`--paper` + `paper-grain.svg`），
     *   **页面本身仍是纸**，只有背景变成木桌。
     *
     * ★ 磨砂质感怎么做的（**零图片、零联网、零 CDN**）：噪点是一张**内联 SVG**
     *   的 `feTurbulence`，用 `background-blend-mode: overlay` 压在木纹之上。
     *   ⚠ 特意**不用 `mix-blend-mode` 伪元素** —— 那要去动 `.stage` 的 z-index，
     *     而 `.stage` 的 padding/高度正是 F132「画册被裁」的敏感点，一碰就有风险。
     *   `background-blend-mode` 纯在背景层内部混合，**不碰任何布局**。
     *
     * ⚠ 真机 Chrome 83（本APK 的兼容下界）：`inset`(87+) / `aspect-ratio`(88+) 一律不用。
     *   这里只用到 `radial/linear/repeating-linear-gradient`（都很老）+ `background-blend-mode`
     *   （Chrome 52+）⇒ 安全。斜切角度取 93°（不是正 90°），免得木纹和书脊撞成一条线。
     */
    'html, body {',
    '  background:',
    '    url("data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' width=\'220\' height=\'220\'%3E%3Cfilter id=\'n\'%3E%3CfeTurbulence type=\'fractalNoise\' baseFrequency=\'.82\' numOctaves=\'4\' stitchTiles=\'stitch\'/%3E%3C/filter%3E%3Crect width=\'220\' height=\'220\' filter=\'url(%23n)\'/%3E%3C/svg%3E"),',
    '    radial-gradient(120% 90% at 50% -10%, rgb(255 248 230 / .35), transparent 60%),',
    '    repeating-linear-gradient(93deg,',
    '      rgb(0 0 0 / .04) 0 2px, transparent 2px 8px,',
    '      rgb(255 255 255 / .06) 8px 10px, transparent 10px 24px),',
    '    radial-gradient(36% 24% at 26% 70%, rgb(120 84 44 / .22), transparent 70%),',
    '    linear-gradient(160deg, #d8b183, #c39a67 58%, #b1895a) !important;',
    '  background-blend-mode: overlay, normal, normal, normal, normal;',
    '  background-repeat: repeat, no-repeat, repeat, no-repeat, no-repeat;',
    '}',

    /* ============================================================
       22) 第九轮④（2026-10-09）：照片边缘不再「硬贴」—— 柔和投影 + 纸纹统一
       ============================================================
     * 他的原话：「画册的图片的边缘和背景结合处太僵硬，感觉像是图片的拼接，
     * 完全没有层次立体感，缺少现实感」。他点名**方案 2 + 4 组合**。
     *
     * ⚠⚠★ **落点与原方案不一样，是他实测照片后我重新核实的**（别照样本硬搬）：
     *   书里的照片是 **满版出血（full-bleed）**，不是"贴在纸上的小照片"：
     *     · `template.js:232fullBleedHtml()` → `<article class="art-page photo">
     *       <figure class="plate"><img …>`
     *     · `book-style.css:12` `.art-page .plate{position:absolute;inset:0;…}`
     *     · `book-style.css:20` `.plate img{width:100%;height:100%;object-fit:cover}`
     *     · `.art-page` 自己是 `overflow:hidden`
     *   ⇒ **给照片本身加 `box-shadow` 一定会被页面裁掉，看不见任何效果**
     *     （原样本里那张是"纸上的小照片"，所以投影成立 —— 那是**样本的情形，
     *     不是真实成品的情形**）。
     *   ⇒ 方案 2 改成**能在满版上成立的两个等价手法**：
     *       (a) **投影落在「书」上**（`.book-rig` 投影 + `.room` 底色变化）
     *           ⇒ 照片连同整本书从木桌上升起，这是照片"浮起来"的真实来源；
     *       (b) **照片内侧加一圈极淡暗角**（四边，inset 味）
     *           ⇒ 照片边缘不再是"切出来的硬线"，而是"有厚度的纸边"。
     *           ⚠ 书自己已有 `.outer-x/.outer-y`（`book-style.css:174-181`，
     *             最深14% × opacity .72）但**只画三条外边**，贴中线那条不管
     *             ⇒ 这里**补齐第四条 + 上下加厚**，让四边强度一致。
     *
     * ★ 方案 4（质感统一）：⚠⚠ **第一版用 `feTurbulence` 噪点，被他一眼看穿**
     *   「图片出现异常，有很多白噪点」—— 真机实测照片亮度 **+22%**，
     *   而混合模式 / `feComponentTransfer` alpha / opacity / 图层顺序**全试过都压不住**
     *   ⇒ Chrome 83 的 `feTurbulence` 输出**本身就偏亮**，同一手法在木桌上安全、
     *     **在照片上就是错的** ⇒ 已换成**低频云斑**（亮度 +0.0% · 标准差 +1.1%）。
     *   ★ 完整实测数据见下面第 ② 段内的注释。
     *   ⛔ 全程**不用 `mix-blend-mode` 伪元素**：那要抬 `.stage` 的 z-index，
     *     而 `.stage` 的 padding/高度正是 F132「画册被裁」的敏感点
     *     （跨页门槛 574，差 4px 就退单页）⇒ 一个布局属性都不动。
     *
     * ⚠ 真机 Chrome 83：`inset`(87+) / `aspect-ratio`(88+) / `cqh`(105+) 一律不用
     *   ⇒ 内暗角改用四条 `linear-gradient` 逐边叠加，**不写 `inset` 关键字**。
     *   ⚠ 投影里**绝不能出现 `inset` 字面量**（书 CSS 第 49/309/371/429/464/494 行
     *     反复重申：不许把 inset 塞进 box-shadow，契约测试会红）⇒ 一律外投影。
     *   ⚠⚠ **不要用 `html.fs-reading` 门控**（第一版写过）：实测那个类只在**真全屏**
     *     时才挂上（`styles.css:547` 自己写了这条），正常翻页时**根本不命中**
     *     ⇒ 那段投影等于死代码，正是「改了却看不出变化」的典型。
     */
    '.room,',
    '.stage {',
    '  background-image:',
    '    radial-gradient(130% 120% at 50% 40%, rgb(0 0 0 / 0%) 40%, rgb(0 0 0 / 22%) 100%);',
    '}',

    /* ---- ② 照片内侧极淡云斑（四边暗角已于 2026-10-18 删除，见下）---- */
    '.art-page.photo .plate::after {',
    '  content: "";',
    '  position: absolute;',
    '  top: 0; left: 0; right: 0; bottom: 0;',
    '  z-index: 2;',
    '  pointer-events: none;',
    '  background:',
    /* ★★ 2026-10-18（佘先生）：「去除图片内部的阴影」—— 原先四条边的那圈
     *   内暗角（上/下 26% 起、左/右 22% 起的 linear-gradient）**整组删除**。
     *   历史因果：那圈暗角正是他早先自己点名要的「方案 2b」（原话「图片的
     *   边缘和背景结合处太僵硬…缺少现实感」，要照片边缘「有厚度」）；
     *   现在他反过来要求去掉（真机实测把那圈边缘压暗 245→203）⇒ 以本次为准。
     *   ⚠ 只删图片**内部**暗角；图片**外部**投在木桌上的书影（下面 ③ 的
     *   `.book-rig` box-shadow）按他的要求**原样保留**。
     *   ⚠ 云斑（方案 4，相纸质感）不是阴影、实测亮度 +0.0%，保留。 */
    /* ★★ 方案 4 的「质感统一」——⚠⚠ 这里**曾经**用的是 `feTurbulence` 噪点，
     *   结果被他一眼看出「图片出现异常，有很多白噪点」——**已彻底删除**，原因：
     *
     *   真机实测（同一块屏幕区域的亮度均值，`_round9f.py`）：
     *     ·基准（无噪点）119.3 · 只加噪点 145.5 ⇒★ **+22%**，照片被"蒙了一层白纱"。
     *   ★★ **根因不是混合模式，也不是 alpha 不够压**（`feComponentTransfer`
     *     slope .12 / .06 全试过，opacity .9 / .5 全试过，overlay / soft-light /
     *     图层顺序（底层/顶层）也全试过 ⇒ **亮度一律 +22%，纹丝不动**）
     *     ⇒ 说明 Chrome 83 上 `feTurbulence` 输出的图案**本身就偏亮**，
     *       铺满整页 = 在照片上盖一层白纱 ⇒ **任何混合模式都救不回来**
     *       （混合只改两端关系，改不了「一层本身偏亮的图盖上去」）。
     *   ⇒ ★★ 同一手法在**木桌**上安全（底色浅、颗粒细），但用在**照片**上就是错的
     *     ⇒ **不是"参数没调好"，是"这个手法不能上照片"**。
     *
     *   ✅ 现在的替代：**低频** `radial-gradient` 云斑（大尺度明暗，模拟相纸的不匀）
     *   实测 **亮度 +0.0%**（完全不破坏照片）、**局部标准差 +1.1%**（确实有层次）
     *   ⇒ 既有"照片与纸页质感统一"的意图，又不毁照片。 */
    'radial-gradient(38% 30% at 22% 26%, rgb(255 240 210 / 5%), transparent 70%),',
    'radial-gradient(34% 26% at 74% 68%, rgb(60 48 30 / 5%), transparent 70%),',
    'radial-gradient(46% 36% at 52% 46%, rgb(255 246 225 / 3.5%), transparent 72%);',
    '  background-repeat: no-repeat, no-repeat, no-repeat;',
    '}',
    /*★ ① 他的要求：「**点进画册还未翻开时不要出现**，等我翻开（两个图片展示）时出现」。
     *   ⚠ 实测（`F143`）：进书页的那一刻 `::after` 就已经生效（原 637 字符 / 7 个 gradient；
     *     2026-10-18 删掉四边暗角后只剩 3 个云斑 gradient，门控机制不变），
     *     而「是否翻开」**书没有给任何标记**（`.stf__item--current` 为 0、`html` 上无 class）。
     *   ⇒ 所以门控由壳自己加：`.shell-opened` **只有翻页后才挂上**（见下面的 `syncOpened()`）。
     *   ★ 用 `html` 上的 class 门控（与 `.fs-net` / `.fs-reading` 同一套语言），不碰任何布局属性。
     *   ⚠ **书自己那三条外边阴影**（`book-style.css:174-181`）不受此门控 ——
     *     那是冻结的、不归我们管；我们要管的是自己加的这一层。
     */
    'html:not(.shell-opened) .art-page.photo .plate::after {',
    '  content: none !important;',
    '}',

    /* ---- ③ 方案 2 的真正落点：投影给「书」（照片满版，投影只能落在这一层）---- */
    '.room .book-rig,',
    '.stage .book-rig {',
    '  box-shadow:',
    /* 近处一层实的（把书从桌面上"抬起来"） */
    '    0 6px 14px rgb(40 28 14 / 30%),',
    /* 远处一层散的（环境阴影，让桌面有纵深） */
    '    0 26px 60px rgb(40 28 14 / 22%),',
    /* 桌面接触面的紧实暗影（让书"坐"在桌上而不是浮在天上） */
    '    0 2px 5px rgb(40 28 14 / 24%) !important;',
    '}',

    /* ── ★★ `F151`（2026-10-09）：**未翻开时这一圈投影也不要出现** ──────────────
     * 他的第二次要求：「画册的**图片的边缘特效固定在背景上**，需要修复，
     *   用户**翻开画册、两张图片展示时**才出现这个边缘特效」。
     *
     * ★★ 受控实验定因（`_round14b.py`：停封面 → 截 → 注入"关掉某一层" → 再截 → 比同坐标亮度）：
     *   · 关掉**背景暗角**（`.room/.stage` 的 radial-gradient）⇒ 亮度差 **最大 1** ⇒ **根本看不见**
     *     （被木桌纹理 + `background-blend-mode` 吃掉了，不是主角）
     *   · 关掉**书的投影**（就是这一条 `.book-rig` 的 box-shadow）⇒ 亮度差
     *     **离书越近越大：1 → 3 → 5 → 8 → 12 → 30**（x=400 紧贴书的左缘）
     *     ⇒ ★ **"固定在背景（木桌）上的那圈边缘暗影"就是它**，而且它**没有门控**
     *     （`shell-opened` 当时只管了照片自己那层 `::after`）。
     *   ⇒ 补上这条门控：**未翻开（只看得到封面 1 页）⇒ 投影 none；翻开（同屏 2 页）⇒ 投影回来**。
     *
     * ⚠ 选择器比原规则更具体（多一个 `html:not(.shell-opened)`），两条都带 `!important`，
     *   按 CSS 特异性，这条赢 ⇒ 不需要动原规则一个字符。
     * ⚠ 与照片那层同一个开关（`.shell-opened`）⇒ 两层的出现时机**永远一致**，
     *   不会出现"照片暗角出现了、投影还没出现"这种半开状态。
     */
    'html:not(.shell-opened) .room .book-rig,',
    'html:not(.shell-opened) .stage .book-rig {',
    '  box-shadow: none !important;',
    '}'
  ].join('\n');

  var STYLE_ID = 'shell-mobile-controls';
  /** 挂到 <html> 上表示「控制条收起来了」——外壳私有，书的脚本不认识它 */
  var BAR_OFF_CLASS = 'shell-bar-off';
  /** 挂到 <html> 上表示「这颗按钮刚被按了一下」——纯反馈，与收没收起无关 */
  var BAR_HIT_CLASS = 'shell-bar-hit';
  /**
   * 圆环充黑保持多久（毫秒）。
   * 佘先生先说了「一秒」，紧接着改口「我不限制为一秒，你自己定」⇒ 取 480ms：
   *   · 比一次眨眼略长，看得清"确实按上了"
   *   · 又短到连点两下不会互相压住（每次重新计时）
   * 进/出各 180ms 的过渡在 CSS 里（第 13 条），所以肉眼看到的黑约 0.3~0.5s。
   */
  var BAR_HIT_MS = 480;

  /**
   * ★ A9：按了那颗圆之后**等多久才认定是"单击"**（毫秒）。
   *
   * 单击 = 只收 / 显控制条（画面不动）；双击 = 进 / 出「两张全屏」。要分开这两件事，
   * 单击就**必须等** —— 不然双击的第一下会先把条收掉（变两次收条 + 一次全屏）。
   * ⚠ **必须与 `gesture.js` 的 `SINGLE_DELAY_MS` 一致**（两边都是 350ms）：两个文件
   *   各是一个 IIFE、共享不了常量，**改一个要记得改另一个**。
   */
  var BAR_DOUBLE_MS = 350;
  /** 那颗圆的双击计时器（挂着 = 第一下还在等第二下） */
  var barTimer = null;

  /** 注入样式；返回是否找到了控制条（找不到 = 书的版式变了，静默不动） */
  function install() {
    var found = !!document.querySelector('footer.controls');
    if (!found) { log('没找到 footer.controls，跳过（书可能换了版式）'); return false; }

    var old = document.getElementById(STYLE_ID);
    if (old && old.parentNode) { old.parentNode.removeChild(old); }

    var st = document.createElement('style');
    st.id = STYLE_ID;
    st.textContent = CSS;
    (document.head || document.documentElement).appendChild(st);
    log('已注入控制条布局（右侧竖栏）');
    return true;
  }

  /**
   * ★★ 2026-10-08（第五轮）：**别让翻页库退成单页**（佘先生报的「画册显示不全」）。
   *
   * 账（真机 vivo 实测 + 读库源码 `calculateBoundsRect`）：
   *   · 书给库的 `minWidth` = `round(pageWidth × 0.56)` = **287**（`flipbook.js` 第 36 行）；
   *   · 库的判据是 **容器宽 `< 2 × minWidth`（= 574）⇒ 退「单页」**；
   *   · 容器的宽 = `.book-rig` 的宽 = `min(可用宽, 高 × 1.6)`：
   *       · 全屏 360 高 ⇒ 576 ≥ 574 ⇒ 跨页 ✓ —— **只富余 2px，一直是踩线过的**；
   *       · 非全屏 332 高 ⇒ 531 < 574 ⇒ **单页** ⇒ 单页宽 = 整个容器宽（531）、
   *         高 = 531 ÷ 0.8 = **663.75**（比 332 的视口还高一倍）⇒ **整本书上下被裁**。
   *   · ⚠ **新老内核都有**：新内核用 `cqh` 算出 531.2，一样低于 574。
   *
   * 修：把库运行时那份设置里的 `minWidth` 压到 1 ⇒ 那条判据永不成立 ⇒ **始终按跨页排**。
   *   ⚠ 只改**库对象上的一个字段**（`getSettings()` 返回的就是它自己那份可写设置）；
   *     **书（成品）与链① 一个字没动**，也不动任何 CSS。
   *   ⚠ 尺寸仍由 `.book-rig` 决定（库从容器宽反推页宽、再夹到容器高）⇒
   *     容器多宽书就多宽、**不会变形也不会溢出**（332 高时书 = 531×331.875，正好放得下）。
   */
  function forceSpread() {
    try {
      /* eslint-disable no-undef */
      if (typeof pageFlip === 'undefined' || !pageFlip) { return 'no-lib'; }
      var s = (typeof pageFlip.getSettings === 'function') ? pageFlip.getSettings() : null;
      if (!s) { return 'no-settings'; }
      var changed = false;
      if (s.minWidth !== 1) { s.minWidth = 1; changed = true; }
      if (s.minHeight > 1) { s.minHeight = 1; changed = true; }
      /* ★★ 参数改了还不够 —— 库在**构造时**已经把 `min-width/min-height` 写成行内样式了：
       *   `t.style.minHeight = i.minHeight * s + 'px'`，而 `minHeight = round(640×0.56) = 358`
       *   ⇒ `.book` 被钉到 **358 高**，而容器只有 332 ⇒ **容器比舞台高 26px**（实测）。
       *   页面本身没被裁（每页 331.875 高，正好），但要修干净，否则库的
       *   `getBlockHeight()`（= offsetHeight = 358）会拿错误的高度去算居中偏移。
       *   ⇒ 把那两条行内 min 清掉（`.book` 完全跟着容器走）。 */
      var el = null;
      try { el = document.getElementById('book'); } catch (e0) { el = null; }
      if (el && el.style) {
        if (el.style.minHeight) { el.style.minHeight = ''; changed = true; }
        if (el.style.minWidth) { el.style.minWidth = ''; changed = true; }
      }
      if (changed && typeof pageFlip.update === 'function') { pageFlip.update(); }
      return 'ok(minWidth=' + s.minWidth + (changed ? ',已重排' : '') + ')';
    } catch (e) { return 'err:' + e; }
  }

  /**
   * 底部那 49px 一让出来，舞台尺寸就变了 ⇒ 必须让书重算：
   *   · 老内核（装 compat.js）：派发 resize，compat 的监听会重新回写 .book-rig 尺寸
   *   · 新内核：尺寸是 CSS 自己算的，但翻页库的「单页/跨页」判定要手动 update 一次
   * 两条都做，谁在谁生效（幂等）。
   */
  function nudge() {
    /* ★ 先钉住「跨页」，再派 resize —— 顺序反了的话，库那次 resize 里
     *   还会按旧的 minWidth 判一次单页（判完就被夹死，后面改也来不及）。 */
    try { forceSpread(); } catch (e) { /* 忽略 */ }
    var how = [];
    try {
      window.dispatchEvent(new Event('resize'));
      how.push('resize');
    } catch (e) { /* 忽略 */ }
    try {
      /* eslint-disable no-undef */
      if (typeof pageFlip !== 'undefined' && pageFlip && typeof pageFlip.update === 'function') {
        pageFlip.update();
        how.push('pageFlip.update');
      }
    } catch (e) { /* 忽略 */ }
    try { window.scrollTo(0, 0); } catch (e) { /* 忽略 */ }
    /* ★ 第十轮①：每次重排都顺手对一次「翻开了没有」——这是最省事的时机
     *   （此时页位置刚被库重排过，正是该判的时候）。 */
    try { syncOpened(); } catch (e) { /* 忽略 */ }
    log('已让书重算：' + (how.length ? how.join(' + ') : '（没有可用途径）'));
  }

  /**
   * ★★ 2026-10-09（第十轮①）：**判断书「翻开了没有」**，据此给`<html>` 挂/摘 `shell-opened`。
   *
   * 他的要求：「图片边缘的特效**不要我点进画册还未翻开时就出现**，
   * 等我翻开画册时即**两个图片展示时**出现边缘效果」。
   *
   * ⚠ 书**没有给任何「已翻开」的标记**（实测）：进书页那一刻
   *   `.stf__item--current` 是 0、`html` 的 class 是空 ⇒ 只能自己测。
   *
   *★ 判据 = **同时可见的 `.art-page` 数量**（`getClientRects().length > 0`）：
   *   · 进书页未翻开 → 只看到**封面 1 页** ⇒ 1
   *   · 翻开跨页 → **左右两页同时在屏** ⇒ 2
   *   这正是他描述的「**两个图片展示**」，口径与他的原话一致。
   *   ⚠ **不可按 `textContent` 判「看不见」**（F132 六诫；且页有内容但仍在屏外）。
   *
   * ⚠ 为什么要挂 class 而不是直接改样式：class 门控是**幂等**的
   *   （反复同步只是反复加/摘同一个 class，不会叠加任何层）。
   */
  function syncOpened() {
    try {
      var pages = document.querySelectorAll('.art-page');
      var shown = 0;
      for (var i = 0; i < pages.length; i++) {
        // ★ 判「在屏上」必须用 getClientRects().length（不是 offsetWidth/display）
        if (pages[i].getClientRects().length > 0) { shown++; }
      }
      var opened = shown >= 2;
      var root = document.documentElement;
      if (opened) {
        if (!root.classList.contains('shell-opened')) {
          root.classList.add('shell-opened');
          log('书已翻开（同屏' + shown + ' 页）⇒ 照片边缘特效已开启');
        }
      } else if (root.classList.contains('shell-opened')) {
        root.classList.remove('shell-opened');
        log('书回到单页（同屏' + shown + ' 页）⇒ 照片边缘特效已关闭');
      }
    } catch (e) {
      log('判断是否翻开失败（忽略，不影响看书）：' + e);
    }
  }

  /**
   * ★★ 第十轮① 的**触发器**：让「翻没翻开」这件事**随时保持正确**。
   *
   * ⚠⚠ 真机踩过的坑（第一版没生效的原因）：我把 `syncOpened()` 挂在 `nudge()` 里，
   *   而 **`nudge()` 全文件只被调用两次**（`start()` 里的 120ms / 700ms 定时器），
   *   **翻页之后再也不会跑** ⇒ `shell-opened` 永远停在启动那一刻（未翻开）。
   *   ⚠ 书也**没有派发任何翻页事件**（`flipbook.js` 里只有一次 `resize`）。
   *
   *⇒ 所以用两条**兜底**通道（都不需要书配合）：
   *   ① **`MutationObserver` 监听页元素的 class/属性** —— 翻页库每次翻页必然改
   *      `.stf__item` 的 class 与 style，这是**最灵敏**的一条。
   *   ② **低频轮询** —— 每400ms 判一次。★ 之所以敢轮询：
   *      `syncOpened` 只做 `querySelectorAll` + `getClientRects`（**只读、不触发布局写**），
   *      在 F140 已确认「WebView 帧率上限是 29.7fps」的机器上，400ms 一次读开销可忽略。
   *   ⚠ **幂等**：`syncOpened` 内部只在 class 真的该变时才 `add/remove`，
   *     反复调用**不会**反复触发样式重算（`classList.add` 已存在时是no-op）。
   */
  var openedWatcher = null;
  function watchOpened() {
    if (openedWatcher) { return; }
    try {
      var host = document.querySelector('.stf__parent') ||
                 document.querySelector('.stf__block') ||
                 document.body;
      if (window.MutationObserver) {
        var mo = new MutationObserver(function () {
          try { syncOpened(); } catch (e) { /* 忽略 */ }
        });
        /* ★ 只看 class / style —— 书改的就是这两样；`subtree` 必须开
         *   （页元素是 `.stf__parent` 的后代，不开就听不到）。 */
        mo.observe(host, {
          attributes: true,
          attributeFilter: ['class', 'style'],
          subtree: true
        });
        openedWatcher = mo;
      }
    } catch (e) {
      log('装翻开监听失败（会退回轮询）：' + e);
    }
    // 兜底轮询（★ 万一 MutationObserver 没装上，靠这条也够用）
    setInterval(function () {
      try { syncOpened(); } catch (e) { /* 忽略 */ }
    }, 400);
  }

  // -------------------------------------------------------------------------
  // ★★ 2026-10-02：接管右下角那颗「收起条 / 显示条」开关
  //
  //   佘先生：「把收起条这个UI组块的操作功能变成只有收起操作条，而不调整画册大小」。
  //
  //   书原本是 `barToggle.addEventListener("click", …)` ⇒ 它挂在**按钮自己**身上。
  //   我们在 **document 的 capture 阶段**先拿到事件，`stopPropagation()` 一按，
  //   事件就走不到按钮了 —— 书的那个处理器一次都不会被调用，`.fs-net` 永远挂不上。
  //   （capture 从 window 往下走到目标；在 document 这一站拦住，后面全不执行。）
  //
  //   ⚠ 真全屏里**不拦**：那边"顶满"是本来就要的，整条链路原样交给书。
  //   ⚠ 幂等：处理器先摘再挂（window 上留个把手）—— 反复注入也不会"点一下切两次"。
  // -------------------------------------------------------------------------

  function barToggleEl() {
    try { return document.getElementById('bar-toggle'); } catch (e) { return null; }
  }

  function inRealFullscreen() {
    try {
      if (document.fullscreenElement) { return true; }
      return !!(window.matchMedia && window.matchMedia('(display-mode: fullscreen)').matches);
    } catch (e) { return false; }
  }

  /** 把「现在收没收」写回按钮的无障碍属性（文字已经用 CSS 压没了） */
  function syncShellBar() {
    var b = barToggleEl();
    if (!b) { return; }
    var off = document.documentElement.classList.contains(BAR_OFF_CLASS);
    var label = off ? '显示页面操作组块' : '收起页面操作组块';
    try {
      b.setAttribute('aria-pressed', off ? 'false' : 'true');
      b.setAttribute('aria-label', label);
      b.title = label;
    } catch (e) { /* 忽略 */ }
  }

  /**
   * 按一下 → 圆环里的空白充黑（CSS 第 13 条），BAR_HIT_MS 之后自动褪回。
   * 连点两下：把上一根计时器清掉重新计时（不会出现"第二次半路被第一次掐断"）。
   * 幂等：处理器反复注入时，window 上那根计时器把手足以保证不会叠出多个。
   * 出错只打日志 —— 这纯粹是装饰，绝不能因此影响收条。
   */
  var hitTimer = null;
  function pulseBar() {
    try {
      var root = document.documentElement;
      root.classList.add(BAR_HIT_CLASS);
      if (hitTimer) { clearTimeout(hitTimer); }
      hitTimer = setTimeout(function () {
        hitTimer = null;
        try { root.classList.remove(BAR_HIT_CLASS); } catch (e) { /* 忽略 */ }
      }, BAR_HIT_MS);
    } catch (e) { log('充黑反馈失败（不影响收条）：' + e); }
  }

  /**
   * **单击**那颗圆：只收 / 显控制条，**画面一个像素不动**（二次改动的口径，没变）。
   */
  function toggleShellBar() {
    var root = document.documentElement;
    var off = !root.classList.contains(BAR_OFF_CLASS);
    if (off) { root.classList.add(BAR_OFF_CLASS); }
    else { root.classList.remove(BAR_OFF_CLASS); }
    syncShellBar();
    /* 触摸点过的按钮会**留住焦点**，浏览器（这台是 vivo 主题色）会给它套一圈橙色方框，
       实测 `outline: 1px auto rgb(229, 151, 0)` —— 一颗干净的圆环边上多一个方块，很难看。
       老内核又用不了 :focus-visible 去区分"鼠标点"和"键盘 Tab" ⇒ 处理完直接让它失焦。
       键盘用户不受影响：那颗按钮是"按一下换个状态"的即动型，状态本来就画在圆环上。 */
    try { barToggleEl().blur(); } catch (e) { /* 忽略 */ }
    log('控制条' + (off ? '已收起（画面尺寸未动）' : '已显示'));
  }

  /**
   * **双击**那颗圆：进 / 出「两张全屏」（三次改动新增）。
   *
   * 做法 = **放行给书**（不 `stopPropagation`、不改 DOM）—— 书的 `barToggle` click
   * 处理器在普通窗口下走 `fsNetUserOff = !fsNetUserOff` ⇒ `applyFsNet()` 挂 / 摘
   * `html.fs-net` ⇒ 藏条 + 把书放大到 `--fs-scale` 铺满（手机 1.25 倍）。
   * 壳只负责把 `shell-bar-off` 摘掉，免得壳的状态与书的 `.fs-net` 叠着、退出时"条回不来"。
   */
  function onBarToggleDouble() {
    try {
      var root = document.documentElement;
      if (root.classList.contains(BAR_OFF_CLASS)) {
        root.classList.remove(BAR_OFF_CLASS);
        syncShellBar();
      }
    } catch (e) { /* 忽略 */ }
    log('双击那颗圆 → 进/出「两张全屏」（放行给书，由它自己切 .fs-net）');
  }

  function onBarToggleClick(e) {
    var t = e.target;
    var hit = t && t.nodeType === 1 && (t.id === 'bar-toggle' ||
      (typeof t.closest === 'function' && t.closest('#bar-toggle')));
    if (!hit) { return; }

    /* 先给按压反馈：**不论全局还是真全屏都给** ——
       它只是"这一下收到了"，不含任何状态，所以走哪条链路都该亮一下。 */
    pulseBar();

    if (inRealFullscreen()) { return; }        // 真全屏：那一套是书自己的（含"条显/隐"）

    // ---- ★ A9：先看这一下是不是"第二下" ----
    if (barTimer) {
      clearTimeout(barTimer);
      barTimer = null;
      /* ★ 双击 ⇒ **这里刻意不 `stopPropagation`**：这一下要放行给书，让它自己切 `.fs-net`。
         ⚠ 第一下已经被我们吃掉了 ⇒ 书**只会收到这一次** click ⇒ 它只翻转一次，
           `fsNetUserOff` 不会被一次双击翻两回。 */
      onBarToggleDouble();
      return;
    }

    // ---- 第一下：先吃掉、先挂起，等 `BAR_DOUBLE_MS` 看有没有第二下 ----
    e.stopPropagation();                       // ★ 拦住书的处理器：这一下不许它切 .fs-net
    e.preventDefault();
    barTimer = setTimeout(function () {
      barTimer = null;
      toggleShellBar();                        // 等满了、没有第二下 ⇒ 这就是一次**单击**
    }, BAR_DOUBLE_MS);
  }

  function bindBarToggle() {
    var b = barToggleEl();
    if (!b) { log('没找到 #bar-toggle，收起条开关仍归书自己管'); return false; }

    /* 先摘掉上一次注入挂的那个（幂等） */
    try {
      if (window.__shellBarClick) {
        document.removeEventListener('click', window.__shellBarClick, true);
        window.__shellBarClick = null;
      }
    } catch (e) { /* 忽略 */ }

    window.__shellBarClick = onBarToggleClick;
    document.addEventListener('click', onBarToggleClick, true);

    /* 书可能在我们之后又刷了一次文案，这里顺手把状态对齐一次 */
    syncShellBar();
    if (b.getAttribute('data-shell-bar') !== '1') {
      b.setAttribute('data-shell-bar', '1');
      log('已接管右下角开关（只收条，不动画面）');
    }
    return true;
  }

  // -------------------------------------------------------------------------
  // ★★ 2026-10-08（第四轮）：把书里那颗「全屏」钮（`#page-full`）接回**原生沉浸式**
  //
  //   佘先生：「不能自动进入全屏模式，要求用户手动进入」+ 选定「复用书里那颗全屏钮」。
  //   ⇒ `BookPageActivity` 不再自动隐系统栏；**这颗钮就是唯一的手动入口**
  //     （它此前被本文件 CSS 第 16) 条 `display:none` 砍掉，本轮恢复出来）。
  //
  //   书原本点它走 Fullscreen API（`documentElement.requestFullscreen()`），
  //   而 WebView 里那条路要 `WebChromeClient.onShowCustomView` —— 我们没实现，
  //   点了**什么也不会发生**（这正是"手动进不去全屏"的成因）。
  //   ⇒ 这里接管它的 click（document capture 阶段，与 `#bar-toggle` 同一套手法），
  //     改叫原生桥 `FlipbookShell.toggleFullscreen()`，由 Activity 真去 hide/show 系统栏。
  //
  //   ⚠ 文案由**原生回报**：Kotlin 切完会调 `window.__shellFullscreen(on)`。
  //     书自己那套读的是 `document.fullscreenElement`，走原生后它**永远是 null**
  //     ⇒ 不接管文案的话按钮会一直写着「全屏」（哪怕已经在全屏里）。
  //   ⚠ 幂等：处理器先摘再挂（window 上留把手）—— 反复注入不会"点一下切两次"。
  //   ⚠ 没有原生桥（电脑浏览器里直接翻书）⇒ **不拦**，原样交给书自己那条路。
  // -------------------------------------------------------------------------

  var FULL_ID = 'page-full';
  /** 全屏态下补位的那颗「退出全屏」（见 [syncDockExit]）。★ 第七轮起**只清理、不补位**。 */
  var FULL_EXIT_ID = 'shell-fs-exit';
  /**
   * ★ 第七轮：壳私有的"现在是原生沉浸式全屏"标记（挂 <html>）。
   * ⚠ 书有自己的 `fs-net` / `fs-reading` —— 那是它整套状态机的标记，**不许碰**；
   *   所以这里另起一个只有壳知道的名字。
   */
  var NATIVE_FS_CLASS = 'shell-native-fs';

  function fullEl() {
    try { return document.getElementById(FULL_ID); } catch (e) { return null; }
  }

  /**
   * 原生回报全屏状态 ⇒ 同步那颗钮的文案 / title / aria。
   * 挂在 `window.__shellFullscreen` 上 —— Kotlin **注入完补丁**与**每次切换**都会调。
   * （所以它在 IIFE 体里就赋好，不等 DOMContentLoaded。）
   */
  function applyFullscreenState(on) {
    var b = fullEl();
    /* ★ 2026-10-08（第七轮）：给 <html> 挂一个**壳私有**的标记 `shell-native-fs`，
     *   表示"现在是原生沉浸式全屏"。CSS 第 16) 条靠它把「全屏」那颗钮藏掉
     *   （佘先生：点击全屏之后的退出全屏 UI 组块直接砍掉）。
     *   ⚠ 必须是**壳自己的类**：书的 `fs-net`/`fs-reading` 是它整套状态机的标记，
     *     我们去摘/改会让它的语义全乱。 */
    try {
        var root = document.documentElement;
        if (on) { root.classList.add(NATIVE_FS_CLASS); }
        else { root.classList.remove(NATIVE_FS_CLASS); }
    } catch (e0) { /* 忽略 */ }
    /* ★ 第七轮：左上角返回钮的**无障碍名字随全屏态变** ——
     *   全屏中它退的是「全屏」不是「书架」（第七轮新增的那一层）。 */
    try {
      var bk = backEl();
      if (bk) {
        var nm = on ? '退出全屏（回到画册）' : '返回书架';
        bk.title = nm;
        bk.setAttribute('aria-label', nm);
      }
    } catch (e05) { /* 忽略 */ }
    if (b) {
      try {
        b.textContent = on ? '退出全屏' : '全屏';
        b.title = on ? '退出全屏（回到带系统栏的界面）' : '全屏看';
        b.setAttribute('aria-pressed', on ? 'true' : 'false');
      } catch (e) { /* 忽略 */ }
    }
    /* ⚠ 第七轮：**不再补位「退出全屏」那颗钮**（佘先生要求砍掉那个 UI 组块）⇒
     *   布局补判那几行也一并去掉，退全屏由左上角返回钮负责（见 backOne）。 */
    return b ? 'ok' : 'no-button';
  }

  /**
 * 第七轮：**只清理那颗补位按钮，不再补位**。
 *
 * 背景：第四轮为解决「进了全屏退不出来」，在全屏且书那颗「全屏」钮不可见时，
 *   往 `#fs-dock` 里补了一颗 `#shell-fs-exit`。本轮佘先生要求把退出全屏那颗
 *   UI 组块**直接砍掉** ⇒ 它**不能再出现**（否则自己又成了那个 UI 组块）。
 *
 * 仍保留这个函数：注入是幂等重跑的，若某个旧路径已经建出了那颗节点，
 *   进来时顺手**删掉**，避免留下一个点不动的孤儿按钮。
 */
function syncDockExit() {
    try {
      var mine = document.getElementById(FULL_EXIT_ID);
      if (mine && mine.parentNode) { mine.parentNode.removeChild(mine); }
      return true;
    } catch (e) {
      return false;
    }
  }

  function onPageFullClick(e) {
    var t = e && e.target;
    if (!t || t.nodeType !== 1) { return; }
    var hit = false;
    try {
      hit = (t.id === FULL_ID) || (t.id === FULL_EXIT_ID) ||
        (typeof t.closest === 'function' &&
         !!(t.closest('#' + FULL_ID) || t.closest('#' + FULL_EXIT_ID)));
    } catch (e2) { hit = false; }
    if (!hit) { return; }

    var n = null;
    try { n = window.FlipbookShell; } catch (e3) { n = null; }
    if (!n || typeof n.toggleFullscreen !== 'function') { return; }   // 没桥 ⇒ 交给书

    /* capture 阶段就按住：书的 `toggleFullscreen`（点在自己身上）一次都不会跑 */
    try { e.preventDefault(); e.stopPropagation(); } catch (e4) { /* 忽略 */ }
    try { n.toggleFullscreen(); }
    catch (e5) { log('叫原生切全屏失败：' + e5); }
  }

  function bindPageFull() {
    if (!fullEl()) { return false; }                 // 书还没把钮建出来（调用方会重试）
    try {
      if (window.__shellFullClick) {
        document.removeEventListener('click', window.__shellFullClick, true);
      }
    } catch (e) { /* 忽略 */ }
    window.__shellFullClick = onPageFullClick;
    try { document.addEventListener('click', onPageFullClick, true); }
    catch (e2) { log('接管全屏钮失败：' + e2); return false; }
    log('已接管书里那颗「全屏」钮 ⇒ 原生沉浸式');
    return true;
  }

  /* 原生（Kotlin）回报全屏状态的入口 —— 必须在 IIFE 里就挂好 */
  try { window.__shellFullscreen = applyFullscreenState; } catch (e) { /* 忽略 */ }

  // -------------------------------------------------------------------------
  // ★★ 2026-10-02：左上角「返回书架」圆钮（样式见 CSS 第 14 条）
  //
  //   佘先生：「我点击一个画册后要能返回书架」。
  //   实测（vivo Z5 真机，CDP 探 _shelf → book1）：书架 → 书是 WebView 历史里
  //   多出来的一条（`history.length` 从 1 变 2）⇒ 系统返回键**本来就能回去**。
  //   缺的不是通路，是**看得见、点得着**的入口 —— App 沉浸式全屏、系统栏全藏，
  //   画面上没有任何提示，没人猜得到"按返回键能回书架"。
  //
  //   跳转口径：优先 `history.back()` —— **不新增历史条目**，所以回到书架后
  //   再按返回键就直接退 App，与"只有返回键"时的行为一模一样；
  //   万一历史里没有上一条（书被直接打开这种非常规入口），退到 location.replace。
  //   ⚠ 延迟 BAR_HIT_MS 再跳：让"圆里充黑"这一下看得见，不是点完瞬间闪走。
  //   ⚠ 幂等：节点已经在了就不再建 —— 反复注入不会叠出两颗。
  // -------------------------------------------------------------------------

  var BACK_ID = 'shelf-back';
  var BACK_HIT_CLASS = 'shell-back-hit';
  /**
   * 回书架的去处 —— ⚠ **相对 `books/<id>/index.html` 要退两级**：
   *   书在  assets/books/<id>/index.html
   *   书架在 assets/_shelf/index.html
   *   `../../_shelf/index.html` ⇒ assets/_shelf/index.html  ✓
   *   `../_shelf/index.html`    ⇒ assets/books/_shelf/...   ✗ 死路
   * ★ 这一级是**实测出来的**：在 book1 页上真机调 `location.replace('../_shelf/index.html')`，
   *   页面落到 `file:///`（空白，卡片 0）—— 一眼看着像"跳转函数没写对"，
   *   其实是相对路径少退了一级。**别凭感觉写相对层级，落到设备上验一次。**
   * ⚠ 正常路径其实轮不到它：`history.back()` 先命中（书架→书是历史里的一条）。
   *   这条只在"历史里没有上一条"时才用（例如书被直接打开）。
   */
  var SHELF_HREF = '../../_shelf/index.html';

  /**
   * 回书架去处的**权威来源** = 外壳的 JS 桥（A4 起）。
   *
   * ⚠ 为什么不能只认上面那条相对路径：**导入的书不在 assets/ 里** ——
   *   它们住在 `getExternalFilesDir()/books/<id>/index.html`，
   *   `../../_shelf/index.html` 在那边会解析到一个**根本不存在的目录**（死路）。
   *   桥给的 `shelfUrl()` 是绝对 `file:///android_asset/_shelf/index.html`，两边都对。
   * ⚠ 没有桥（比如在电脑浏览器里直接翻书）就退回相对路径 —— 那边只有内置书，规则照旧。
   */
  function shelfHref() {
    try {
      var b = window.FlipbookShell;
      if (b && typeof b.shelfUrl === 'function') {
        var u = b.shelfUrl();
        if (u) { return String(u); }
      }
    } catch (e) { /* 没有桥就用相对路径 */ }
    return SHELF_HREF;
  }

  function backEl() {
    try { return document.getElementById(BACK_ID); } catch (e) { return null; }
  }

  var backTimer = null;
  /** 按一下 → 圆里充黑（与右下角那颗同款反馈，时长同一个常量） */
  function pulseBack() {
    try {
      var root = document.documentElement;
      root.classList.add(BACK_HIT_CLASS);
      if (backTimer) { clearTimeout(backTimer); }
      backTimer = setTimeout(function () {
        backTimer = null;
        try { root.classList.remove(BACK_HIT_CLASS); } catch (e) { /* 忽略 */ }
      }, BAR_HIT_MS);
    } catch (e) { /* 纯装饰，失败不影响返回 */ }
  }

  // -------------------------------------------------------------------------
  // ★★ A15（2026-10-05）：**逐层返回** —— 佘先生原话：
  //    「关于左上角的圆形返回的UI组块，要求**一级一级地返回**，比如我此时全屏点击返回
  //      不要直接返回到选择画册的界面，而是返回正常的查看画册的界面，就是刚进来的界面」
  //
  //   改前（实测复现，`tools/_back_probe.py`）：灯箱里点、两张全屏里点，**都是一步跳回书架**
  //     —— 因为 `onBackClick` 无条件 `goShelf()`。
  //   改后：**从最外层往里退；退到"刚进来的界面"再点，才回书架**：
  //     ① 灯箱开着  → 关灯箱（书自己的 `window.__lightbox.close()`）
  //     ② 两张全屏  → 退两张全屏（让书收到一次 `#bar-toggle` 的 click）
  //     ③ 都不是    → 回书架（= 改前的行为，一个字没动）
  //   ⚠ ①必须排在②前面：**两张全屏里也能开灯箱**（双击照片）⇒ 两层会叠着，
  //     必须从最上面那层往下退，才叫"一级一级"。
  //   ⚠ 判据一律**先取权威来源、拿不到才自己兜一份**（下面每个函数都写了它认谁）——
  //     与 A14b 的教训同源：判据不许散开、不许各判各的。
  // -------------------------------------------------------------------------

  /** 灯箱开着没。
   *  **权威来源 = 书自己的 `window.__lightbox.state()`**（A15 实测：开着返回对象、关着 null）；
   *  拿不到就退回"找到 `.lightbox` 且没 hidden"——与 gesture.js 里 `lightboxOpenNow()` 同口径。*/
  function backLightboxOpen() {
    try {
      var L = window.__lightbox;
      if (L && typeof L.state === 'function') { return !!L.state(); }
    } catch (e) { /* 落到下面的兜底 */ }
    try {
      var b = document.querySelector('.lightbox');
      return !!(b && !b.hidden);
    } catch (e2) { return false; }
  }

  /** 关灯箱。**真调到了才返回 true**（书没给这个接口 ⇒ false ⇒ 调用方退回"回书架"）。*/
  function backCloseLightbox() {
    try {
      var L = window.__lightbox;
      if (L && typeof L.close === 'function') { L.close(); return true; }
    } catch (e) { /* 落到下面的兜底 */ }
    try {
      var c = document.querySelector('.lightbox__close');
      if (c) { c.click(); return true; }          // 兜底：按那颗关闭钮（书自己的入口）
    } catch (e2) { /* 忽略 */ }
    return false;
  }

  /** 在不在「两张全屏」。
   *  **单一真相源 = gesture.js 的 `fnActive()`**（经 `window.__shellGesture.inFsNet` 暴露
   *  —— 它已经排掉"真全屏的默认净屏"那一类，见 A14b）；拿不到就自己兜一份**同口径**判据：
   *  `fs-net` 且 非 `fs-reading` 且 非真全屏。*/
  function backInFsNet() {
    try {
      var g = window.__shellGesture;
      if (g && typeof g.inFsNet === 'function') { return !!g.inFsNet(); }
    } catch (e) { /* 落到下面的兜底 */ }
    try {
      if (inRealFullscreen()) { return false; }
      var r = document.documentElement;
      if (!r.classList.contains('fs-net')) { return false; }
      if (r.classList.contains('fs-reading')) { return false; }
      return true;
    } catch (e2) { return false; }
  }

  /** 退「两张全屏」= 让书收到**一次** `#bar-toggle` 的 click（书在它自己的处理器里翻
   *  `fsNetUserOff` 再 `applyFsNet()`）。
   *  ⚠ 必须**临时摘掉壳自己的 capture 监听**（`window.__shellBarClick`）：不然壳会把这一下
   *    当成"单击/双击那颗圆"接走（第一下 `stopPropagation` + 挂 350ms 计时器，书收不到）。
   *  ⚠ 用 `b.click()` 而不是构造 `MouseEvent`：书那个处理器挂的是普通 click，两者等价，
   *    前者更短、也不容易踩到老内核对 `MouseEvent` 构造器的支持差异。
   *  实测（`tools/_back_probe.py` [4]）：退得掉，且**留在书里**（页位不变）。*/
  function backQuitFsNet() {
    var b = barToggleEl();
    if (!b) { return false; }
    var h = null;
    try { h = window.__shellBarClick; } catch (e) { h = null; }
    try { if (h) { document.removeEventListener('click', h, true); } } catch (e2) { /* 忽略 */ }
    try { b.click(); } catch (e3) { /* 忽略 */ }
    /* 无论上面成没成，都把壳的拦截装回去（`onBarToggleClick` 幂等，重装安全） */
    try { document.addEventListener('click', onBarToggleClick, true); } catch (e4) { /* 忽略 */ }
    try { window.__shellBarClick = onBarToggleClick; } catch (e5) { /* 忽略 */ }
    return true;
  }

  /** **一级一级退**。返回 true = 这一下退的是书里的某一层（**别回书架**）；
   *  返回 false = 已经站在"刚进来的界面"上了（调用方去 `goShelf()`）。*/
  function backOne() {
    /* ★★ 2026-10-08（第七轮）：**原生沉浸式全屏要退出来**，且退完**留在书里**。
     *   佘先生：「在全屏状态下的返回时返回画册，就是我点击后书架上的画册后刚进来的界面，
     *   注意不是返回书架」。
     *   ⇒ 这一层排在最前面：全屏中点左上角返回 ⇒ 先叫原生把系统栏放回来（回到画册），
     *     再点一下才走下面的灯箱 / 两张全屏 / 回书架。
     *   ⚠ 判据用壳自己的 `shell-native-fs`（原生回报时挂上的），**不用** `fs-net`
     *     （那是书自己的净屏标记，与原生全屏不是一回事）。 */
    try {
      var root = document.documentElement;
      if (root && root.classList && root.classList.contains(NATIVE_FS_CLASS)) {
        if (backQuitNativeFs()) { log('返回：退出全屏（留在画册里）'); return true; }
        log('返回：在全屏里但退不掉（原生桥不在？）⇒ 直接退全屏以免卡住');
        return false;
      }
    } catch (e0) { log('返回：判原生全屏出错 → ' + e0); }
    try {
      if (backLightboxOpen()) {
        if (backCloseLightbox()) { log('返回：关掉灯箱（留在书里）'); return true; }
        log('返回：灯箱开着但关不掉（书没给关灯箱的口），退回"回书架"');
        return false;
      }
    } catch (e) { log('返回：判灯箱出错 → ' + e); }
    try {
      if (backInFsNet()) {
        if (backQuitFsNet()) { log('返回：退出「两张全屏」（留在书里）'); return true; }
        log('返回：在两张全屏里但退不掉（没找到那颗圆），退回"回书架"');
        return false;
      }
    } catch (e2) { log('返回：判两张全屏出错 → ' + e2); }
    return false;
  }

  /**
   * 叫原生退出沉浸式全屏（系统栏放回来）。
   *
   * ★ 与 `goShelf()` 同一套：原生桥 `FlipbookShell.toggleFullscreen()` 存在时走它
   *   （Activity 里 hide/show 系统栏）；没有桥（电脑浏览器里翻书）⇒ 返回 false，
   *   由调用方落到"回书架"那条路（网页版那条 Fullscreen API 是死路，别去试）。
   */
  function backQuitNativeFs() {
    try {
      var n = window.FlipbookShell;
      if (n && typeof n.toggleFullscreen === 'function') { n.toggleFullscreen(); return true; }
    } catch (e) { /* 没有原生桥 */ }
    return false;
  }

  function goShelf() {
    /* ★★ 2026-10-08（Kotlin 新工程）：**原生快路优先**。
     *
     *  背景（真机复现的根因）：新工程的货架是 Kotlin 原生 Activity，assets 里
     *  **没有 `_shelf/index.html`** ⇒ 下面那条 `location.replace('../../_shelf/index.html')`
     *  是一条**死链**：WebView 不拦截它（loader 只注册了 /books/ 与 /ubooks/）⇒
     *  真的去解析 https://appassets.androidplatform.net/... ⇒ DNS 失败
     *  ⇒ **系统那张「网页无法打开」**。佘先生原话：「绝不能在切换时有这个问题」。
     *
     *  做法：外壳桥 `FlipbookShell.goToShelf()` 存在时，直接叫**原生 finish**
     *  （BookPageActivity.closeSelf()：先 stopLoading + GONE，再 finish ⇒ 退场全程无网页内容）。
     *  没有桥（电脑浏览器里直接翻书）⇒ 退回原来那两条，行为一个字没变。
     */
    try {
      var n = window.FlipbookShell;
      if (n && typeof n.goToShelf === 'function') { n.goToShelf(); return; }
    } catch (e) { /* 没有原生桥就退回下面那两条 */ }
    try {
      if (window.history && history.length > 1) { history.back(); return; }
    } catch (e2) { /* 落到下面那条 */ }
    var href = shelfHref();
    try { location.replace(href); }
    catch (e3) { try { location.href = href; } catch (e4) { log('回书架失败：' + e4); } }
  }

  function onBackClick(e) {
    try { e.preventDefault(); e.stopPropagation(); } catch (err) { /* 忽略 */ }
    pulseBack();
    /* ★ A15：先试着**退一层**（灯箱 / 两张全屏）；退掉了就留在书里 —— 只有已经站在
       "刚进来的界面"上，这一下才回书架。延迟与反馈时长同改前（BAR_HIT_MS），
       让"圆里充黑"那一下看得见。 */
    setTimeout(function () {
      try {
        if (backOne()) { return; }
      } catch (e2) { log('返回：逐层退出错 → ' + e2); }
      goShelf();
    }, BAR_HIT_MS);
  }

  function installBackButton() {
    if (!document.body) { return false; }
    if (backEl()) { return true; }                 // 幂等
    var b = null;
    try { b = document.createElement('button'); }
    catch (e) { log('建返回钮失败：' + e); return false; }
    b.id = BACK_ID;
    b.type = 'button';
    b.title = '返回书架';
    b.setAttribute('aria-label', '返回书架');
    /* 图标 = 内联 SVG（一段静态字符串，无外部资源、无数据注入面）：朝左的折线箭头 */
    b.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true">' +
      '<path d="M15 4.5 L7.5 12 L15 19.5" fill="none" stroke="currentColor"' +
      ' stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    try {
      document.body.appendChild(b);
      b.addEventListener('click', onBackClick);
    } catch (e) { log('装返回钮失败：' + e); return false; }
    log('已装上「返回书架」（左上角，常驻）');
    return true;
  }

  function start() {
    var ok = false;
    try { ok = install(); } catch (e) { log('注入失败：' + e); }
    if (!ok) { return; }
    try { installBackButton(); } catch (e) { log('返回钮失败：' + e); }
    try { bindBarToggle(); } catch (e) { log('接管开关失败：' + e); }
    // ★ 第七轮：清掉第四轮可能已建出的补位「退出全屏」那颗（佘先生要求砍掉那个 UI 组块）
    try { syncDockExit(); } catch (e9) { /* 忽略 */ }
    // ★ 2026-10-08（第五轮）：钉住「跨页」（见 forceSpread 的注释）—— 必须赶在
    //   compat.js 那几次 kick 之前（注入顺序上 layout.js 在前，所以这里一定赢）
    try { log('跨页钉住：' + forceSpread()); } catch (e1) { log('跨页钉住失败：' + e1); }
    // ★ 2026-10-08（第四轮）：接管书里那颗「全屏」钮（⇒ 原生沉浸式切换）
    try { bindPageFull(); } catch (e2) { log('接管全屏钮失败：' + e2); }
    // 等样式生效后再通知；照片是异步加载的，再补一次
    setTimeout(nudge, 120);
    setTimeout(nudge, 700);
    // ★ 第十轮①：装「翻没翻开」的监听（启动即判一次 + 之后自动跟随翻页）
    try { syncOpened(); watchOpened(); } catch (e) { log('翻开监听启动失败（不影响看书）：' + e); }
    // 返回钮要是因为 body 当时还没就绪而没装上，补一次
    if (!backEl()) {
      setTimeout(function () { try { installBackButton(); } catch (e) { /* 忽略 */ } }, 500);
    }
    // 书要是把按钮来晚了一步，再补两次
    if (!barToggleEl()) {
      setTimeout(function () { try { bindBarToggle(); } catch (e) { /* 忽略 */ } }, 400);
      setTimeout(function () { try { bindBarToggle(); } catch (e) { /* 忽略 */ } }, 1500);
    }
    // 全屏钮同理（书的 flipbook.js 是同步建的，正常第一次就找得到）
    if (!fullEl()) {
      setTimeout(function () { try { bindPageFull(); } catch (e) { /* 忽略 */ } }, 400);
      setTimeout(function () { try { bindPageFull(); } catch (e) { /* 忽略 */ } }, 1500);
    }
    // ★「跨页钉住」再补两次：照片是异步加载的，库/书可能在那之后又重排一次
    setTimeout(function () { try { forceSpread(); } catch (e) { /* 忽略 */ } }, 500);
    setTimeout(function () { try { forceSpread(); } catch (e) { /* 忽略 */ } }, 1600);
  }

  try {
    if (document.readyState === 'complete' || document.readyState === 'interactive') {
      setTimeout(start, 0);
    } else {
      document.addEventListener('DOMContentLoaded', function () { setTimeout(start, 0); });
    }
  } catch (e) { log('启动失败：' + e); }
})();
