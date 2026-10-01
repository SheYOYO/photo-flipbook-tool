const bookElement = document.querySelector("#book");
const pages = bookElement.querySelectorAll(".book-page");
const previousButton = document.querySelector("#previous");
const nextButton = document.querySelector("#next");
const pageStatus = document.querySelector("#page-status");
// 跳页控件（Phase 19）：点页码就地变成输入框。可能不存在（老成品 HTML），
// 所以下面用到它们的地方都要判空，不能假定一定有。
const jumpButton = document.querySelector("#page-jump");
const jumpInput = document.querySelector("#page-input");
// 自动翻页开关（Phase 20）。同样可能不存在（老成品 HTML），用法全部判空。
const autoButton = document.querySelector("#page-auto");
// 自动翻页调速（Phase 23，1~10 秒/页，每档 1 秒）。同样判空 —— 老成品没有它。
const autoSpeedSelect = document.querySelector("#page-auto-speed");
// 控制条上那个**常驻**的「跳到第 N 页」（Phase 26）：输入框 + 跳转按钮。
// 和上面的 #page-jump 一样可能不存在（Phase 26 之前出的成品），用法一律判空。
const pageSelectInput = document.querySelector("#page-select");
const pageGoButton = document.querySelector("#page-go");
const orientationStatus = document.querySelector("#orientation");
const pageWidth = Number(bookElement.dataset.pageWidth) || 512;
const pageHeight = Number(bookElement.dataset.pageHeight) || 640;
document.documentElement.style.setProperty("--page-ratio", pageWidth / pageHeight);

const pageFlip = new St.PageFlip(bookElement, {
  width: pageWidth,
  height: pageHeight,
  size: "stretch",
  // ★★★ Phase 44：这两个上限**够大就行，绝不能变成天花板** ★★★
  //   库在 stretch 分支里有一句 `h > maxWidth && (h = maxWidth)` —— maxWidth 一收紧，
  //   `html.fs-net .book-rig` 撤掉 640px 上限那件事就**白做了**：书恒 ≤ 1064×665，
  //   净屏时四周留一圈白（真机 1280×800 全屏下两张照片只占屏 69.1%，findings 130）。
  //   这里给到 8K 屏（7680 CSS px）也用不完的宽度 ⇒ **尺寸只剩 CSS 一个来源**：
  //   普通窗口由 `.book-rig` 写死的 640px 上限管着（书仍是 1024×640，观感一字未变），
  //   净屏（`.fs-net` 撤了那个上限）就顶满整个视口。
  //   ⚠ 别指望 `maxHeight` 当第二道闸：库在 stretch 分支压根**不读**它 ——
  //     高度是拿 `getBlockHeight()`（即容器实高）兜的。这里一并放大只为不留下误导性的数。
  minWidth: Math.max(1, Math.round(pageWidth * 0.56)),
  maxWidth: Math.max(1, Math.round(pageWidth * 8)),
  minHeight: Math.max(1, Math.round(pageHeight * 0.56)),
  maxHeight: Math.max(1, Math.round(pageHeight * 8)),
  drawShadow: true,
  flippingTime: 760,
  usePortrait: true,
  startZIndex: 10,
  autoSize: true,
  maxShadowOpacity: 0.42,
  showCover: true,
  mobileScrollSupport: false,
  clickEventForward: true,
  useMouseEvents: true,
  swipeDistance: 24,
  showPageCorners: false,   // ★ 见下方「拖拽卡顿」注释
  disableFlipByClick: false,
});

let currentPage = 0;
let isTurning = false;
// 自动翻页是否在播（Phase 20）。★ 声明必须放在这里，不能跟下面那段自成一体的
// 代码放一起 —— updateControls() 在模块加载时就会被调用一次，
// 那时若还处在 `let autoPlaying` 的暂时性死区里，会当场 ReferenceError。
let autoPlaying = false;

// ★★★ Phase 28：翻到"后壳"之后再点「→」= 整本翻回封面 ★★★
//
// 佘先生：「我翻到后壳后再点击两下就可以翻到封面，就是整本书翻转」。
// 也就是：末跨页(版权页+封底) 点一下**合上**、再点一下**整本翻回封面**，从头再看。
//
// ⚠ 这个开关**必须声明在这里**，不能跟下面那段自成一体的大注释放一起：
//   `updateControls()` 在模块加载时（第 308 行附近）就会被调用一次，它要读这个常量；
//   声明在后面的话，那一瞬间还处在 `const` 的暂时性死区里 ⇒ 当场 ReferenceError。
//   （同一个坑 Phase 20 加 `let autoPlaying` 时已经踩过一次。）
const WRAP_TO_COVER = true;

// ★★★ Phase 29：封面 / 后壳双击整本翻转 ★★★
//
// 佘先生：「在封面我连击鼠标左键两次是翻转画册到后壳，
//   在后壳我连击鼠标左键两次则翻转画册到封面」
//
// ⚠ 这两个状态同样**必须声明在这里**：`changeState` 的回调（文件靠前处注册）
//   会在翻页落定时读 `closingToBack`，而它可能在模块还没跑完时就被触发一次 ——
//   声明在后面会踩暂时性死区。同一个坑 Phase 20（`let autoPlaying`）、
//   Phase 28（`WRAP_TO_COVER`）各踩过一次，别再踩第三次。
// ⚠ Phase 29 原本还有一条「滚轮翻页」和它的冷却（WHEEL_COOLDOWN_MS / wheelReadyAt）；
//   Phase 32 滚轮改成缩放之后这两个变量就全无用处了 ⇒ **直接删掉**，
//   不留"声明了没人用"的死代码（那种东西下次改代码的人会当成"功能还在"）。
// ★ Phase 33：Phase 29 那两个状态位（`backCoverStage` / `pendingCover`）已随
//   "两步跳到后壳"整套实现一起删掉 —— 现在只有 `coverRun` 一个状态（见文件前部）。
//   留"声明了没人用"的死代码，会让下次改代码的人以为那条旧路还在。
// ★ 双击时书在哪 —— 必须在**按下那一刻**记，不能等 dblclick：
//   等 dblclick 触发时，前面那两次单击已经把书翻走了（详见下面双击那段的注释）。
let pageAtLastDown = 0;
let finalAtLastDown = false;
let pageAtPrevDown = 0;
let finalAtPrevDown = false;
// ★★ Phase 36：双击那一趟要"数翻了几下" ⇒ 把库派发过的 `flip` 计数也照同一规矩留快照。
//    实测（`_p36_probe0.mjs` M1）：真双击封面**只派发 1 个 flip**（页位 0→1）——
//    第二下在翻页途中被库吞了。所以"双击自带几下"**绝不能写死**，只能靠这份快照算差。
let flipsAtLastDown = 0;
let flipsAtPrevDown = 0;

// ★★★ Phase 31 / 32：鼠标滚轮 = 缩放照片 ★★★
//
// Phase 31 佘先生：「摁下鼠标中键滚动可以缩放图片，图片放缩要有中心瞄点，
//   不要一放大图片就跑出屏幕」。
// Phase 32 他改口并加码：「鼠标中键滑动改成缩放功能，摁住鼠标中键暂时不要有什么操作；
//   图片放大时要全屏显示，注意不是窗口大小不变而图片只放大一部分」。
//
// ⇒ **不再需要按住任何键**：单独滚滚轮就是缩放（和看图软件一样），
//   中键按住什么都不做（只负责"别去翻页/别去拖拽"）。
//   ⚠ 这条把 Phase 29 的「滚轮翻页」取代了 —— 是他本人点名要改的，
//     不是我们私自砍功能。下面 `wheel` 那个监听器里写着原先那条分支的来龙去脉。
//
// 三条硬指标各自对应下面一件事：
//   ① **中心瞄点** —— 缩放前后，"鼠标底下那一点"必须停在同一个屏幕位置上
//      （就是地图、看图软件那种手感），否则一放大画面就往一边蹿。
//   ② **全屏显示** —— 放大之后照片要**铺满整个屏幕**，不是"窗口不变、照片在
//      那一小块里放大"。基准矩形因此取**舞台（整个画面）**，不是书页。
//   ③ **有上限、能复位** —— 1~4 倍；缩回 1 倍就自动摘掉放大状态；
//      翻页也一并复位（放大状态不该跟着翻到下一页）。
//
// ⚠ 这些常量同样**必须声明在这里**：`pointerdown` 的回调在下面注册，
//   而它可能在模块还没跑完时就被触发 —— 声明在后面会踩暂时性死区。
//   （同一个坑 Phase 20 / 28 / 29 各踩过一次。）
const ZOOM_MIN = 1;            // 最小 1 倍 = 原样
const ZOOM_MAX = 4;            // 最大 4 倍：够看清细节，又不至于一格滚到糊
const ZOOM_FACTOR = 1.18;      // 每滚一格的倍率（连续滚十格 ≈ 4 倍，手感不暴冲）
// ★★ Phase 34：Ctrl 那条"两张一起缩"的量程与滚轮**不一样**。
//   佘先生 2026-09-28：「一是 Ctrl 和加减号的两张图片同时放大的效果改成
//     **图片全屏后还能放大四倍**」（他选的算法：**铺满倍率 × 4**）。
//   ⇒ 单张照片的"全屏（铺满）"倍率是 sCover = max(舞台宽/照片宽, 舞台高/照片高)
//     （这本书实测 ≈2.81），再乘 SPREAD_TURNS ⇒ 上限 ≈ 11 倍，够看清细节。
//   ⚠ 滚轮仍是 ZOOM_MAX=4 封顶（他没要求改滚轮的量程，别顺手改）。
const SPREAD_TURNS = 4;
const ZOOM_COOLDOWN_MS = 80;   // 触控板一次甩出十几个事件，别一格直接滚到底
const ZOOM_TRANSITION_MS = 110; // 与 book-style.css 里那条过渡对齐（同改同收）
let middleDown = false;        // 中键是否正被按住（按住期间不做任何操作）
let zoomReadyAt = 0;           // 缩放冷却到点的时间戳

// ★★★ Phase 35：双击照片 ⇒ 单张全屏看（灯箱）。状态位同样声明在这里，
//   原因见上面那条：wheel / keydown 的回调可能在模块跑完前就被触发一次。
let lightboxBox = null;        // 灯箱的元素（第一次用到时才建）
let lightboxState = null;      // { s, x, y, w, h } —— 与 applyZoom 同一套量纲
let lightboxReadyAt = 0;       // 灯箱里缩放的冷却到点时间戳
let lightboxReturnTo = null;   // 关掉灯箱后，书要回到哪一页（双击前那一页）
let lightboxReturnRun = 0;     // "待还原"的班次号：用户自己一翻页就把它加一，旧的那趟自动作废
// ★ Phase 41 优化一：按住左键拖 = **移动照片**
//   （佘先生 2026-09-30：「单个图片的全屏状态下，我鼠标左键摁住移动光标时允许移动图片」）
let lightboxDrag = null;        // { id, x, y, ox, oy } —— 按下的那一点 + 当时的左上角
let lightboxDragged = false;    // 这一下到底拖没拖（用来吃掉随之而来的那个 click）
let photoAtLastDown = null;    // 本次按下点到的照片（只在软页上才算）
let photoAtPrevDown = null;    // 上一次按下点到的照片（双击读这份，与 pageAtPrevDown 同源）
const LIGHTBOX_MAX = 8;        // 灯箱里最多放大到 8 倍（再大就是看像素了）
const LIGHTBOX_COOLDOWN_MS = 60;

// ★★★ Phase 34：双击封面/后壳 = **先正常翻两页，再把剩下的一整叠"块面"翻过去** ★★★
//
// 佘先生 2026-09-28：「三是双击鼠标左键翻转画册的效果需要是**先翻两页再一起翻过去**，
//   那个一起翻过的时候**书页是不止一张**，所以做成那种**厚书整块成叠整体翻过**，
//   要有**横截面**的就是书的切面翻转，**块面翻页**」（他选定：**落到后壳**、
//   切面要"**看得出是一叠纸**"）。
//
// 历史（**别走回头路**）：Phase 29 一步到底（"闪一下就到后面"，突兀）；
//   Phase 33 一页页连播 52 页（看得清，但太久）；Phase 34/35 自绘"整叠方块"转 180°
//   （他本人看到成品后否掉了 —— 见下面 Phase 36 那段）。
//
// ★ 为什么"多页连翻"必须**自己排节拍**、不能靠库连调 `flipNext()`：
//   库一次只翻一页；硬连调会让它把整趟挤在**同一毫秒**跑完
//   （Phase 33 实测 52 次 `flip` 全在 155~156ms，见 findings 92）⇒ 画面只闪一下。
//
// ⚠ 这些常量必须声明在模块前部：回调可能在模块跑完前就被触发一次
//   （Phase 20/28/29/31/33 各踩过一次暂时性死区，别踩第六次）。
//
// ★★★ Phase 36（2026-09-30 佘先生亲自改口径）★★★
//   他原话：「逐页急翻五面，然后就不翻了，直接跳到封面和后壳，在后壳处翻转也是一样的」
//   追问确认：① 五下 = 五张跨页；② 收尾 = **瞬间切过去**（不要过渡）；
//             ③ 落点 = 封面→后壳、后壳→封面。
//   ⇒ **Phase 34/35 那套"整叠块面翻页"（`.stack-flip` 三面方块 + 衬底白纸）整套退役**。
//     他看到成品后的反馈是「一整块转半圈太机械」—— 真书翻过去是**一页页**的，
//     不是一块板。**隐喻错了，参数调得再好都救不回来**，别再往那个方向改。
const RIFFLE_TURNS = 5;          // 双击那一趟**总共翻几下**（含双击自带的那几下）
const RIFFLE_MS = 260;           // 每一"急翻"的用时；临时覆盖 flippingTime，收尾**必须还原**
const RIFFLE_POLL_MS = 50;       // 自排节拍：等"这一下翻完"的轮询间隔
/** 正在跑的那一趟：null = 没在跑；dir=+1 封面→后壳、-1 后壳→封面。
 *  `{ dir, turns, need, keep, timer }` —— turns = 自己翻了几下、
 *  need = 还需要自己翻几下（总数扣掉双击自带的）、keep = 提速前的 flippingTime。 */
let coverRun = null;
/** 库一共派发过多少个 `flip`。「翻了几下」的**唯一**口径 —— 别拿页位差去推算：
 *  实测封面那一下只 +1、之后每下 +2（`_p36_probe0.mjs` M2），换算是错的。 */
let flipCount = 0;
/** 上一趟的**结算**（自测用）：`{ dir, already, own, total }`。
 *  ⚠ 为什么需要它：收尾那次"瞬间切"内部也走 `turnToPage` + `flipNext`，**它也会派发
 *    `flip` 事件**（实测 +2 个）。所以拿 `flipCount` 的差值当"翻了几下"会被污染 ——
 *    这里把"急翻段自己翻了几下"当场结算下来，判据才有确定的口径。 */
let lastRiffle = null;

// ★★★ 拖拽翻页的「卡一下」是怎么来的，以及这里在修什么 ★★★
//
// 库内部把「翻页」分成两条完全不同的代码路径：
//
//   A. 点一下 / 按方向键  → App.userStop() → flipController.flip(point)
//      flip() 里 setState("flipping") 后**立刻** startAnimation 走一个固定
//      flippingTime(760ms) 的补间，从头到尾匀速，中途不依赖任何鼠标位置。
//
//   B. 手指按住不放拖动  → 每次 mousemove/touchmove 都调 fold(point) →
//      calc.calc(point) → do() 直接**按当前指针位置**算翻页进度。
//      松手时 App.userStop() → flipController.stopMove()，它从「松手那一刻的位置」
//      再补一段动画到落点，补间时长用 getAnimationDuration() 算，正比于剩余距离。
//
// 症状「点一下没事、按住拖动会短暂卡一下」正好对上 B。
// 原因有两个，叠加在一起：
//
//   1. showPageCorners: true（原来是 true）会在鼠标**悬停**到页面角落时
//      触发 showCorner() —— 让页面角先自己掀起来一点点（50px）做一个"可翻页"的
//      提示动画。拖动开始时如果指针恰好扫过角落，就会先播这个提示动画，
//      再切到 fold()，于是看到一次明显的顿挫。
//      → 关掉它（showPageCorners:false）。按钮/键盘/拖拽都不需要这个悬停提示。
//
//   2. isTurning 这个互斥量会把拖拽中的"合法空档"误判成冲突。
//      changeState 事件在 fold 过程中会经过 user_fold，松手后经 flipping 再到 read。
//      原来的 updateControls() 用 isTurning 去 disable 按钮，但更麻烦的是：
//      拖拽期间 state 来回切，按钮的 disabled 属性被反复写，
//      同时 pointer 事件的默认行为与库的 preventDefault 相互打架，
//      在部分帧上造成一次可见的停顿。
//      → 拖拽期间不再去动按钮的 disabled，等真正稳定到 read 再统一刷新。
//
// 下面用一个「当前是否处于用户拖拽中」的标记把这两件事隔开。

let isDragging = false;

bookElement.addEventListener("pointerdown", (event) => {
  // ★ Phase 32：中键按下 = **什么操作都不要有**（佘先生：「摁住鼠标中键暂时不要
  //   有什么操作」）。这里只做两件事：
  //     ① 挡住拖拽翻页（否则按住中键一挪鼠标，书就被拖走半页）；
  //     ② 置起标记，供"松手中键不该翻页"那条断言用。
  //   ⚠ 缩放本身**不再依赖它**：单独滚滚轮就能缩放，按住中键反而没有任何额外效果。
  if (event.button === 1) {
    middleDown = true;
    stopAuto();          // 手一碰就让位，与其余手势同一条规矩
    return;
  }
  isDragging = true;
  // ★ Phase 29：记下"这次按下时书在哪"。last 是当前这次，prev 是上一次 ——
  //   双击的第二次按下会把 last 挤到 prev，于是在 dblclick 里读 prev 就能拿到
  //   "这次双击是从哪儿开始的"。晚一步再问就问不到了（书已经被单击翻走了）。
  pageAtPrevDown = pageAtLastDown;
  finalAtPrevDown = finalAtLastDown;
  flipsAtPrevDown = flipsAtLastDown;
  pageAtLastDown = currentPage;
  finalAtLastDown = atFinalSpread();
  flipsAtLastDown = flipCount;
  // ★ Phase 35：照片那一份照同样的规矩留快照 —— 等 `dblclick` 到手时书已经被
  //   那两下单击翻走了，现场问"他点的是哪张照片"是问不到的（元素还在，但页已经不在眼前）。
  photoAtPrevDown = photoAtLastDown;
  photoAtLastDown = softPhotoAt(event.clientX, event.clientY);
  // 手碰到书页 = 用户要自己来 → 自动翻页让位（Phase 20）。
  // stopAuto() 是函数声明（会提升），这里能安全引用。
  stopAuto();
  // 拖拽期间关掉 .book 外层那条 translate 过渡。
  // .book 上有 `transition: translate 760ms ease`，用于封面/封底贴在书脊位置时
  // 的挪动。拖拽时库每帧都在改内部元素的 transform，外层再挂一条 760ms 的
  // 缓动过渡，会在拖拽起步和松手两处各产生一次可见的迟滞感。
  // 给它加 data-dragging，由 CSS 把 transition 设为 none。
  bookElement.dataset.dragging = "1";
});

window.addEventListener("pointerup", () => {
  if (!isDragging) return;
  isDragging = false;
  delete bookElement.dataset.dragging;
  // 松手后等库把自己的收尾动画跑完，再统一刷新控件状态
  window.setTimeout(updateControls, 0);
});

window.addEventListener("pointercancel", () => {
  isDragging = false;
  delete bookElement.dataset.dragging;
});

// ★ Phase 31：中键"松开"和"窗口失焦"都必须把标记收掉。
//   漏掉失焦这一支的后果很隐蔽：中键在窗口外松开（或按着中键切走了窗口），
//   回来之后 middleDown 一直是 true ⇒ 中键按下这条分流会一直生效。
window.addEventListener("pointerup", (event) => {
  if (event.button === 1) middleDown = false;
});
window.addEventListener("blur", () => { middleDown = false; });
// ---------------------------------------------------------------------------
// ★ Phase 31 补丁（实测出来的真 bug）：中键必须在**翻页库之前**被拦下来。
// ---------------------------------------------------------------------------
//
// 光"我们自己分流"是不够的 —— 实测：按住中键缩放完松开，页码 04 → 02，
// 书自己翻回了上一页。抓库的方法调用看到的序列是
//     startUserTouch →（鼠标没动）→ userStop → turnToPrevPage。
// 原因：翻页库走的是 **mouse** 事件（useMouseEvents，绑在书的元素上），
// 不是 pointer 事件 ⇒ 上面那道 pointerdown 分流根本拦不到它，
// 库照样收到 mousedown 并 startUserTouch() 进入"用户拖拽"态；
// 而它的收尾是
//     userStop(p, false){ isUserTouch && (isUserMove ? stopMove() : flip(p)) }
// 缩放时鼠标压根没动（isUserMove=false）⇒ 走的是 `flip(p)`，
// 等于"在左半页点了一下" ⇒ 翻到上一页。
//
// ⇒ 必须在 **捕获阶段**（比翻页库、比书元素上任何监听器都早）把中键拦掉：
//   stopImmediatePropagation() 让事件根本到不了库，库就不会进入拖拽态。
//
// ★ Phase 32 之后这段的处境变了，但**一个字都不能删**：
//   他的新要求是「摁住鼠标中键暂时不要有什么操作」，也就是中键按下去应该**完全无事发生**。
//   这道拦截正是"无事发生"的执行者 —— 少了它，按住中键随便晃一下鼠标，
//   书就会被当成"拖拽"而掀起来半页，那就恰恰是"有操作"了。
// ⚠ 只拦中键（button===1）：左键拖拽翻页、左键双击翻整本，一个字都不动。
// ⚠ 顺带把 Windows 按住中键弹出的"自动滚动"十字图标也挡掉（preventDefault）。
for (const evt of ["mousedown", "mouseup"]) {
  window.addEventListener(evt, (event) => {
    if (event.button !== 1) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);                       // ← capture：必须比翻页库早
}
// 在链接上按中键会新开标签页 —— auxclick 不受上面那道拦截影响，单独挡掉。
window.addEventListener("auxclick", (event) => {
  if (event.button === 1) event.preventDefault();
});

function updateControls() {
  const pageCount = pageFlip.getPageCount();
  const lastPage = pageCount - 1;
  bookElement.dataset.edge = currentPage === 0 ? "front" : currentPage === lastPage ? "back" : "inside";

  // 拖拽过程中状态的中间态太多，这时改 disabled 会造成按钮闪烁 + 一次卡顿，
  // 等拖拽结束（pointerup 的 setTimeout）再刷新。
  if (!isDragging) {
    // ★ 自动翻页播放期间，两侧箭头**不因为 isTurning 而禁用**（Phase 20）。
    //   起因是实测出来的：**禁用的 <button> 根本不派发 click 事件**，
    //   于是"手一碰就停"会在每次翻页动画的那 0.76 秒里失效 ——
    //   连测 6 次点「→」，有 1 次点击被整个吞掉（按钮正好落在禁用窗口里），
    //   用户看到的现象就是"点了没反应"，正是最让人窝火的那种。
    //   播放中保持可点：点下去就算这一拍翻不动（turnNext 里 isTurning 挡着），
    //   至少先把自动翻页停住 —— 按了键却什么都没发生，比"没翻页但停了"糟得多。
    const holdForAuto = autoPlaying;
    previousButton.disabled = currentPage === 0 || (isTurning && !holdForAuto);
    // ★ Phase 28：`#next` 不再因为"到了末页"而变灰 —— 它现在在末页**有事可做**
    //   （末跨页点它 = 合上封底；已合上再点它 = 整本翻回封面）。
    //   原来那句 `currentPage === lastPage ||` 会让用户在末页看到一个点不动的按钮，
    //   而"点不动的按钮"正是「点了没反应」的祖宗（Phase 27 那条"点了没反应"
    //   之所以难查，就是因为按钮看着还能点，而这次反过来 —— 能点的按钮被禁了）。
    //   真正判断"能不能往前"这件事交给 atFinalSpread()：它问的是**库的跨页表**，
    //   不是"页码等不等于总页数"（后者在末跨页上就是错的，见 atLastSpread 的注释）。
    nextButton.disabled = !canFlipForward() || (isTurning && !holdForAuto);
  }

  if (currentPage === 0) {
    pageStatus.textContent = "Cover";
  } else if (currentPage === lastPage) {
    pageStatus.textContent = "Back cover";
  } else {
    pageStatus.textContent = `${String(currentPage + 1).padStart(2, "0")} / ${String(pageCount).padStart(2, "0")}`;
  }

  // ★ 「跳到第 N 页」输入框跟着当前页走，让人一眼看出"现在在第几页"。
  //   但它正被输入时不回写 —— 否则用户打到一半的数字会被冲掉（一个字都进不去）。
  if (pageSelectInput && document.activeElement !== pageSelectInput) {
    pageSelectInput.value = String(currentPage + 1);
  }
}

// ★★★ 书脊折痕阴影（fold shadow）★★★
//
// 为什么需要自己加一层，而不是调库的 maxShadowOpacity
// ---------------------------------------------------------------
// 库确实自带两层 fold 阴影（.stf__outerShadow / .stf__innerShadow），
// 但它们**没有落在书脊上**。实测（把两层分别染成红/蓝再截屏，见 _tint 诊断）：
//
//   书脊在 x=700（书本正中），而两层阴影实际渲染成两条竖直色带，
//   落在 x≈806~930（inner）和 x≈930~1130（outer）—— 距书脊 106~230px，
//   整个跨页里**书脊附近那一段的阴影量恰好是 0**。
//
// 后果：把 maxShadowOpacity 从 0.42 提到 0.88，量到的压暗峰值会从 21.6
// 涨到 45.5 灰度，但那些灰度全加在「书脊右边那两块错位的带子」上。
// 观感上不是「折痕更深了」，而是「照片上多了一条竖直的灰带」—— 就是脏。
//
// 所以这里补的正是缺的那一块：**一道贴着书脊、随翻页弧度呼吸的阴影**。
// 书脊是两张纸折进去的地方，现实中一定是整本书里最暗的一条 ——
// 这是「折痕」最强的感知线索，也是库唯一没提供的东西。
//
// 做法（刻意做到最轻）
// ---------------------------------------------------------------
// 1. 往 #book 里挂一个绝对定位的 div，画布范围内以 50% 为轴心的对称渐变。
//    它是 #book 的子元素、在 .stf__wrapper 之后，所以天然盖在所有书页之上。
// 2. 只在翻页期间用 rAF 改它的 opacity —— 单元素 opacity 是纯合成器操作，
//    不触发布局/重绘，每帧成本可忽略（已用帧断言守住：>50ms 长帧必须为 0）。
// 3. 强度走 sin 曲线：翻到一半时页面弯曲最厉害 → 最深；两端归零。
//    所以静止跨页的观感**完全不变**（原来是怎么好看现在还怎么好看）。
//
// 这一层与库自带的两层并不冲突：库那两层表现的是「翻起的那页投在下面那页上的投影」，
// 这一层表现的是「书脊本身的凹陷」。
//
// ★ 强度：0.21 → 0.10（第九轮）
// ---------------------------------------------------------------
// 佘先生反馈翻页时这一层偏重、照片被压得看不清，要求调淡。
// 实测两层各自的压暗量（翻页 50% 冻结、逐列平均亮度）：
//     书脊折痕层（本层）  书脊 ±108px 内，最深 **-23.8 灰度**（在书脊上）
//     库自带阴影层        书脊上≈0，从 +108px 起向外越铺越深（+252px 处 -6.3）
// 两层落点完全不同、互不重叠，翻页时那种「暗」主要来自本层。
//
// 0.10 正好是 0.21 的一半：书脊最深压暗约 -11 灰度，
// 仍然看得出书脊凹陷，但照片在翻页过程中明显更容易看清。
// 想更淡改 0.05，想完全不要就把它设成 0（或者把 .fold-shade 那层删掉）。
//
// 参照系：相邻两页上那条静态书脊过渡带的峰值是 26%。
const FOLD_SHADE_PEAK = 0.10;

const foldShade = document.createElement("div");
foldShade.className = "fold-shade";
foldShade.setAttribute("aria-hidden", "true");
bookElement.appendChild(foldShade);

let foldShadeRunning = false;

function foldShadeTick() {
  if (!foldShadeRunning) return;

  // 库在空闲时 getCalculation() 返回 null，翻页过程中才拿得到进度。
  const controller = pageFlip.getFlipController();
  const calculation = controller ? controller.getCalculation() : null;
  const progress = calculation ? calculation.getFlippingProgress() : null;

  if (progress === null || progress === undefined || Number.isNaN(progress)) {
    foldShade.style.opacity = "0";
  } else {
    const clamped = Math.min(Math.max(progress, 0), 100);
    const bend = Math.sin((clamped / 100) * Math.PI);   // 0 → 1 → 0
    foldShade.style.opacity = (bend * FOLD_SHADE_PEAK).toFixed(3);
  }

  window.requestAnimationFrame(foldShadeTick);
}

function startFoldShade() {
  if (foldShadeRunning) return;
  foldShadeRunning = true;
  window.requestAnimationFrame(foldShadeTick);
}

function stopFoldShade() {
  foldShadeRunning = false;
  foldShade.style.opacity = "0";
}

// 供自测脚本使用
window.__foldShade = foldShade;

pageFlip.on("flip", (event) => {
  flipCount += 1;                      // ★ Phase 36：双击那一趟"翻了几下"就数它（一下 = 一个 flip）
  currentPage = Number(event.data);
  updateControls();
  // ★ Phase 31：翻页就把缩放收掉。放大状态跟着页走会让人以为"新的一页也被放大了"，
  //   而他不记得是自己按了中键 —— 翻页回到原样是最不容易误解的一种。
  resetZoomAll();
});

pageFlip.on("changeState", (event) => {
  isTurning = event.data !== "read";
  updateControls();
  // 翻页期间同步驱动书脊折痕阴影（见文件末尾）
  if (isTurning) startFoldShade(); else stopFoldShade();

  // ★ Phase 34：双击那一趟**不在这里推进** —— 它自带定时器（见 coverTick）。
  //   实测过：在这里"一落定就再翻一页"会让库把整趟翻页**同步跑完**（52 页挤在同一毫秒），
  //   动画一帧都播不出来；改成自带节奏之后才真的看得出"先翻两页、再整叠翻过去"。
  //   （Phase 29 那套"一步跳到末跨页、再合上"的两步状态机、Phase 33 那套"一页页连播"
  //    都已按他 2026-09-28 的新要求删除 —— 见文件前部那段说明。）
});

function updateOrientation(orientation) {
  bookElement.dataset.layout = orientation;
  orientationStatus.textContent = orientation === "portrait" ? "Single page" : "Open spread";
}

pageFlip.on("init", (event) => updateOrientation(event.data.mode));
pageFlip.on("changeOrientation", (event) => updateOrientation(event.data));

pageFlip.loadFromHTML(pages);

// ★★★ 「后壳也能翻页合上」（Phase 27）★★★
//
// 佘先生：「画册的后壳也要可以翻页合上」。
//
// 现象（真浏览器实测）：走到最后一跨页 (版权页, 封底) 之后再点「→」**完全没反应**，
// 而且那个按钮**看起来仍然能点**（`disabled` 还是 false）—— 最让人窝火的那种"坏了"。
//
// 根因在库建跨页表的算法里（`PageCollection.createSpread`，见 vendor 那份实现）：
//   开了 showCover 时，它先把第 0 页单列成一个跨页（下标从 1 起），
//   然后从 1 起、**步长 2** 两两成对；只有当轮到的那个下标恰好等于
//   `总页数 - 1` 时，才把末页单独列出来。
//   ⇒ **总页数为奇数时，末页永远被配进上一对里，"只含末页"的跨页根本不存在。**
//     我们的《深圳》是 103 页（封面 + 100 张照片 + 版权页 + 封底 = N+3），正是奇数。
//
// 更难受的是库自己的两道守卫**互相矛盾**：
//   `checkDirection(0)` 判「currentPageIndex < 总页数-1」就放行（实测 101 < 102 → 放行），
//   可紧接着 `getFlippingPage(0)` 要去取 `跨页表[当前+1]`，取到 undefined，
//   里层一读 `.length` 就抛错 —— 而那句 `try/catch` **把异常整个吞掉**、只 `return false`。
//   于是就成了「守卫说能翻、执行时静默失败」：点了没反应，连报错都没有。
//
// 修法：**不动页数、不动版式、不动 book-plan**，只把末页补成一个"只含它自己"的跨页。
//   库对单页跨页本来就有完整支持 —— `showSpread()` 里专门有一支：
//   **横屏**时末页放**左页**、右页留空；配套的 CSS
//   `.book[data-edge="back"]` 再把整本书右移 25%，正好把它居中。
//   也就是说"合上"这个状态库早就设计好了，只是**奇数页数时到不了**。
//
// 实测（1440×900，103 页《深圳》）：
//   补之前：flipNext 之后仍停在跨页 51，edge 还是 "inside"，nextDisabled=false，画面纹丝不动
//   补之后：翻到跨页 52，画面**只剩封底一页、居中**，edge="back"、nextDisabled=true、
//           状态条写 "Back cover"；**再往回翻能原样翻回跨页 51（可逆）**
//
// ⚠ 只在**需要时**补，而且必须幂等：
//     竖屏本来就每页一个跨页（末页天然单独）；
//     横屏总页数为偶数时库也会自己把末页单列 —— 这两种情况都不该再补。
// ⚠ `getSpread()` 返回的是库内部那张表**本身**（不是副本），push 进去就生效；
//   而库只在 `load()` 里建一次表（不随 resize / 旋屏重建），所以补一次就够。
//   横屏那张表在 `collection.landscapeSpread` 上（竖屏不需要补）。
// ⚠ 这是对库内部结构的**一次性、幂等的**小补丁。它一旦失效，症状是
//   「末页又翻不动了」—— 所以 verify_book_ui.mjs 里有一条断言专门盯着这个
//   （翻完之后必须是 edge="back" + 只可见一页），别删那条。
(function ensureBackCoverSpread() {
  const collection = pageFlip.getPageCollection?.();
  if (!collection) return;
  const spreads = collection.landscapeSpread;
  if (!Array.isArray(spreads) || spreads.length === 0) return;
  const lastIndex = pageFlip.getPageCount() - 1;
  const tail = spreads[spreads.length - 1];
  if (tail && tail.length === 2 && tail[tail.length - 1] === lastIndex) {
    spreads.push([lastIndex]);
  }
})();

updateControls();

const requestedPage = Number(new URLSearchParams(location.search).get("page"));
if (Number.isInteger(requestedPage) && requestedPage >= 0 && requestedPage < pages.length) {
  pageFlip.turnToPage(requestedPage);
}

// ★★ 翻页方向必须用 "top"，不能用 "bottom" ★★
//
// flipNext/flipPrev 的参数是「从哪个角开始卷」，不是「往哪个方向翻」。
//   "top"    → 从顶部起卷，页面绕书脊竖直翻转 —— 就是真书翻页的样子。
//   "bottom" → 从底部角起卷，是「捏住书角斜着掀起来」的手势动画：
//              整页会绕对角线做一个斜切变换（clip-path 多边形 + rotate），
//              翻到中途会同时盖住左右两半跨页，并且明显向上/向下探出书框。
//
// 用按钮/键盘触发时，用户期待的是「啪」地整页翻过去，而不是书角被掀起来，
// 所以一律用 "top"。
//
// 另外把 pageFlip 实例挂到 window 上，方便自测脚本直接调用（也是调试入口）。

// ★★ 「库真的翻不动了吗」—— 只有这一个判据（Phase 28）★★
//
// ⚠ 别拿"页码 == 总页数-1"来判断（那是错的，见 atLastSpread 的注释：
//   横屏末跨页的 `getCurrentPageIndex()` 报的是**左页位** 101，而总页数是 103）。
//   也别拿 atLastSpread() 来判断 —— 它是给**自动翻页**用的"该停了"，
//   它在**末跨页**（版权页+封底）就已经是 true（因为 getSpreadIndexByPage(末页)
//   返回的是那个跨页的序号），而我们这里要的是"再往前一格还有没有路"。
//
// 正确做法：直接问库的**当前跨页表**，看现在这一格是不是最后一格。
//   `getSpread()` 会按当前朝向返回横屏那张表或竖屏那张表 —— 竖屏是每页一格，
//   横屏在 Phase 27 之后末尾多出「只含封底」的那一格，两边的"最后一格"都对得上。
function atFinalSpread() {
  const collection = pageFlip.getPageCollection?.();
  const table = typeof collection?.getSpread === "function" ? collection.getSpread() : null;
  const index = typeof collection?.getCurrentSpreadIndex === "function"
    ? collection.getCurrentSpreadIndex() : null;
  if (Array.isArray(table) && Number.isInteger(index)) return index >= table.length - 1;
  return currentPage >= pageFlip.getPageCount() - 1;   // 兜底，理论上到不了
}

/** 再点「→」还会不会发生事情（永远为真 ⇒ 按钮永远可点） */
function canFlipForward() {
  return !atFinalSpread() || WRAP_TO_COVER;
}

function turnNext() {
  // ★ Phase 36：让位**必须排在 `isTurning` 之前**。
  //   急翻那一趟每一下都占着 `isTurning`（260ms 一下、间隙只有 50ms），
  //   照着老顺序写，用户在这 1.5 秒里点箭头会被**完全无视** —— 像卡住了一样。
  //   ⚠ 让位本身是"停掉接着往下翻"，那一下点击依旧照库的规矩被吞（不额外翻页），
  //     但用户至少能**立刻叫停**，第二次点就正常翻页了。
  //     没有急翻在跑时 `stopCoverRun()` 是空操作 ⇒ 正常翻页行为一个字没变。
  stopCoverRun();
  if (isTurning) return;
  cancelLightboxReturn();  // ★ Phase 35：收掉灯箱欠下的那次"还原"，别把用户拽回去
  // ★ Phase 28：到头了不再"什么都不做" —— 整本翻回封面，从头再看一遍。
  //   用 `flip(0, "top")` 而不是 `turnToPage(0)`：后者走的是 showSpread()，
  //   是**瞬间跳**、没有翻页动画；前者走 FlipController.flipToPage()，
  //   会真的演一次翻页（一本合上的书被整个翻过来，落到封面）。
  //   这正是佘先生说的「就是整本书翻转」。
  //   ⚠ 自动翻页**不走这条路**：autoTick 在 atLastSpread() 就自停了，
  //     所以"放着不管"永远不会自己绕回封面（原行为，一个字没动）。
  if (atFinalSpread()) {
    if (WRAP_TO_COVER) pageFlip.flip(0, "top");
    return;
  }
  pageFlip.flipNext("top");
}

function turnPrev() {
  stopCoverRun();      // ★ Phase 36：同上 —— 让位必须排在 `isTurning` 之前，否则急翻期间点不动
  if (isTurning) return;
  cancelLightboxReturn();  // ★ Phase 35：同上
  pageFlip.flipPrev("top");
}

previousButton.addEventListener("click", () => {
  stopAuto();          // 手动翻页 = 用户要自己来 → 自动翻页让位（Phase 20）
  turnPrev();
});
nextButton.addEventListener("click", () => {
  stopAuto();
  turnNext();
});

// ---------------------------------------------------------------
// ★★★ Phase 31 / 32：滚轮缩放照片（中心瞄点 / 放大后铺满整屏）★★★
// ---------------------------------------------------------------
//
// 佘先生（Phase 31）：「摁下鼠标中键滚动可以缩放图片，图片放缩要有中心瞄点，
//   不要一放大图片就跑出屏幕」。
// 佘先生（Phase 32）：「鼠标中键滑动改成缩放功能，摁住鼠标中键暂时不要有什么操作；
//   图片放大时要全屏显示，注意不是窗口大小不变而图片只放大一部分」。
//
// ★ Phase 32 改了两件根本的事，先说清楚，否则后面每一行都对不上：
//
//   **一、基准矩形从"书页"换成"整个舞台"**
//     上一版是拿 `.plate`（书页那一块，实测 512×640）当基准夹紧的，
//     于是"放大"只在书页那一小块里发生 —— 屏幕上一个像素都没变大
//     （实测：4 倍时照片外接矩形 2048×2560，但右边和下边**超出页面的部分是 0**，
//      因为左边和上边顶到头之后就被夹死了）。这正是他说的
//     「窗口大小不变而图片只放大一部分」。
//     ⇒ 基准改成 `.stage`（整个可用画面），照片放大后**铺满屏幕**，
//       并且靠 `.zoomed` 那组 CSS 把书页的裁切打开，让它真的能画到屏幕边。
//
//   **二、坐标原点改成"舞台左上角"**
//     照片的 transform 仍然挂在 img 上、原点仍是 img 的左上角
//     （book-style.css 里 `transform-origin: 0 0`），但**位移量的参考点**
//     换成舞台左上角：记照片左上角在舞台坐标系里是 (X, Y)，
//     则照片上的点 a（舞台坐标）→ 屏幕位置 p = X + s · a。
//     1 倍时 X = 书页相对舞台的偏移（横屏时左页约为 0，右页约为半本书宽）。
//
// ⚠ `getBoundingClientRect()` 给的是**变换之后**的外接矩形，不能拿来当基准 ——
//    基准一律用**没挂 transform 的舞台**：`.stage` 的矩形。
//    书页在舞台里的偏移 = 书页矩形 − 舞台矩形，两个都是未变换的布局矩形，
//    而 img 的 `s=1` 时位置恰好等于书页左上角（它是 width:100%;height:100%）。

/** 鼠标底下那张照片（不在照片上 / 压在别的东西上 ⇒ null） */
function photoImgAt(clientX, clientY) {
  const el = document.elementFromPoint(clientX, clientY);
  if (!el || !el.closest) return null;
  // ⚠ 书页上那两条渐变（跨页过渡带）是 ::before 且 pointer-events:none，
  //   命中测试穿过它之后可能落到宿主 .book-page 上，而不是 img ⇒
  //   这里退一步：命中的是某页，就用那一页里的照片。
  const plate = el.closest(".plate")
    || (() => { const p = el.closest(".book-page"); return p ? p.querySelector(".plate") : null; })();
  if (!plate) return null;                 // 版权页 / 封底 / 控制条上 → 不缩放
  return plate.querySelector("img");
}

/** 读一张照片当前的 (s, X, Y)。
 *
 *  ★★ 没缩放时 `X` / `Y` **不是 0**，而是"照片 1 倍时在舞台坐标系里的落位"
 *     —— 左页 (208,105)、右页 (720,105)（实测）。量纲见 `applyZoom` 上面那段。
 *     ⚠ 早先这里对空数据返回 0 ⇒ 第一次缩放时 `a = (m − X)/s` 用的是错的 X，
 *       滑一格就"瞄点漂移 59.9px"。**别再把这里改回 0。**
 */
function zoomStateOf(img) {
  const s = Number(img.dataset.zoomS);
  const x = Number(img.dataset.zoomX);
  const y = Number(img.dataset.zoomY);
  const sc = Number.isFinite(s) && s >= ZOOM_MIN ? s : ZOOM_MIN;
  const o = zoomOriginOf(img);
  return {
    s: sc,
    x: Number.isFinite(x) && sc > ZOOM_MIN + 0.001 ? x : o.x,
    y: Number.isFinite(y) && sc > ZOOM_MIN + 0.001 ? y : o.y,
  };
}

/** 缩放要铺满的那块区域 —— 整个可用画面（`.stage`），不是书页 */
function zoomViewport() {
  const st = bookElement.closest(".stage") || bookElement.parentElement;
  return st ? st.getBoundingClientRect() : null;
}

/** 照片左上角在**舞台坐标系**里的位置（未变换时的布局位置）
 *
 *  ★★ Phase 33 修的第二个真 bug：**必须量"没有 transform 的那个盒子"**。
 *     img 身上挂着 `translate(...) scale(...)` ⇒ `getBoundingClientRect()` 给的是
 *     **变换之后**的矩形（实测：缩一格后 img.rect = (162,48)，而它 1 倍时的落位是 (208,105)）。
 *     拿变换后的值当"1 倍落位 o"用，`translate(nx − o.x)` 里就多减了一个上格的位移 ⇒
 *     每滚一格，鼠标底下那一点就往外滑一段（实测两格漂 33 个照片像素 ≈ 屏幕上 39px）
 *     —— 这正是佘先生说的「放大的时候图片左右晃动」。
 *     修法：改用它的父级 `.plate` 的矩形 —— 那个盒子是 `position:absolute;inset:0`、
 *     **身上没有 transform**，实测恒为 (208,105)；而 img 是 width/height:100%，
 *     两者的布局盒完全相同。
 *     ⚠ 别改回 `img.getBoundingClientRect()`；也别用 `offsetLeft`（那是相对 offsetParent 的）。
 */
function zoomOriginOf(img) {
  const view = zoomViewport();
  if (!view) return { x: 0, y: 0, w: img.clientWidth, h: img.clientHeight };
  const box = img.closest(".plate") || img;    // .plate 没有 transform = 布局位置
  const r = box.getBoundingClientRect();
  return { x: r.left - view.left, y: r.top - view.top, w: r.width, h: r.height };
}

/** 把一张照片摆到 (s, X, Y)（舞台坐标系）。**不做任何夹紧，绝不为了铺满而挪图。**
 *
 *  ★★ 量纲约定（Phase 32 修掉的一个真 bug，务必看懂再改）：
 *     `X` / `Y` 是**照片左上角在舞台坐标系里的位置**（含 1 倍时的落位 o），
 *     不是"相对自身布局位置的位移"。因为照片 1 倍时并不在舞台原点：
 *     左页 o=(208,105)、右页 o=(720,105)（实测，见 `_p32_origin.mjs`）。
 *     于是：
 *       外观位置 = o + 位移        ⇒ 位移 = X − o.x
 *       照片上的点 a 落屏位置 m = X + s·a   （不再需要额外加 o）
 *
 *  ★★★ Phase 34：**"分轴夹紧"整段删掉了，不许加回来** ★★★
 *     佘先生 2026-09-28：「我想要的效果是我鼠标中键滑动时如果光标在图片之内就
 *       **固定光标**然后**以光标为中心放大图片**，**不要为了全屏显示单个图片而移动图片**」。
 *     Phase 32 那版是"够长的那条边就夹住、保证不露底"（他当时要"放大要全屏"）——
 *     它恰恰就是**会让照片自己挪动**的那件事，本次按他的新口径撤掉：
 *     位置**只由中心瞄点决定**，光标底下那一点钉住不动，照片超出屏幕也不管。
 *     ⇒ 这也是这里连 `clamp` 参数都没有了的原因。
 *     ⚠ 分轴夹紧要真回来了，"放大时左右晃动 / 图片乱跑"会一起回来。
 *
 *  ⚠ `maxScale`：量程上限由调用方给 —— 滚轮是 `ZOOM_MAX`；
 *     Ctrl 那条"两张一起缩"要能放大到"单张铺满倍率 × 4"（见 spreadZoom）。
 */
function applyZoom(img, s, X, Y, maxScale = ZOOM_MAX) {
  const o = zoomOriginOf(img);
  const sc = Math.min(Math.max(s, ZOOM_MIN), maxScale);
  img.dataset.zoomS = String(sc);
  img.dataset.zoomX = String(X);
  img.dataset.zoomY = String(Y);
  if (sc > ZOOM_MIN + 0.001) {
    img.dataset.zoomOn = "1";
    // 位移 = 目标位置 − 1 倍时的落位（transform 是相对自身布局位置的）
    img.style.transform =
      `translate(${X - o.x}px, ${Y - o.y}px) scale(${sc})`;
    // ★ 放大期间挂上 .zoomed：由 book-style.css 打开书页的裁切，让照片能画出页面。
    //   没这一下，照片照样被 `.art-page{overflow:hidden}` 关在页面里。
    img.closest(".book-page")?.classList.add("zoomed");
  } else {
    delete img.dataset.zoomOn;
    img.style.transform = "";
    img.closest(".book-page")?.classList.remove("zoomed");
  }
  return { s: sc, x: X, y: Y };
}

/** 回到原样：上一页放大的状态不该跟到下一页 */
function resetZoomAll() {
  const list = document.querySelectorAll(".plate img[data-zoom-on]");
  for (const img of list) {
    img.style.transform = "";
    delete img.dataset.zoomOn;
    delete img.dataset.zoomS;
    delete img.dataset.zoomX;
    delete img.dataset.zoomY;
  }
  // 放大状态可能落在任何一个没有被上面那条选择器命中的页上（比如刚缩回 1 倍
  // 但 class 还没摘的），所以专门清一遍标记 —— 留着它会让那一页的裁切一直开着。
  for (const p of document.querySelectorAll(".book-page.zoomed")) {
    p.classList.remove("zoomed");
  }
}

/** 滚一格。**返回是否真的处理了** —— 调用方（wheel 监听器）靠它决定要不要
 *  preventDefault；不返回 false 的话，"鼠标不在照片上"时页面会露出默认滚动行为。 */
function zoomBy(event) {
  const deltaY = Number(event.deltaY);
  if (!Number.isFinite(deltaY) || Math.abs(deltaY) < 4) return false;  // 触控板抖动
  const now = Date.now();
  if (now < zoomReadyAt) return false;
  zoomReadyAt = now + ZOOM_COOLDOWN_MS;

  const img = photoImgAt(event.clientX, event.clientY);
  if (!img) return false;
  const view = zoomViewport();
  if (!view || !view.width || !view.height) return false;

  const st = zoomStateOf(img);
  // 向上滚 = 放大（看图软件的通用习惯）；向下滚 = 缩回去
  const raw = deltaY < 0 ? st.s * ZOOM_FACTOR : st.s / ZOOM_FACTOR;
  // ★★ Phase 33 修掉的一个真 bug：**先把目标倍率夹进量程，再判断"到底有没有变"**。
  //    原来拿没夹紧的 raw 去算新位置 —— 到 4 倍封顶后每滚一格，raw 仍然是 4×1.18，
  //    于是"新左上角 = m − raw·a"每一格都比当前位置更远，照片被一格格推出去、
  //    又被夹紧拉回来 ⇒ 实测在 -95 与 -305 之间**来回横跳 210px**
  //    （佘先生：「整个重点避免放大的时候图片左右晃动」）。到顶/到底就什么都不做。
  const s2 = Math.min(Math.max(raw, ZOOM_MIN), ZOOM_MAX);
  // 已经在 1 倍还往下滚（或已在 4 倍还往上滚）——**照样算处理掉了**，
  // 否则这两下会露出页面的默认滚动行为。
  if (Math.abs(s2 - st.s) < 0.0005) return true;

  // ① 中心瞄点：鼠标在**舞台**里的位置 m；照片上那一点的舞台坐标 a = (m − X)/s；
  //    缩放到 s′ 之后把同一个 a 摆回 m ⇒ X′ = m − s′·a。
  //
  // ★★ Phase 34：这里就是"光标钉住不动"的全部实现 —— 算出来的 X′/Y′ **原样**交给
  //    applyZoom，**不夹紧**（applyZoom 里那段分轴夹紧已按他新要求撤掉）。
  //    佘先生 2026-09-28：「鼠标中键滑动时如果光标在图片之内就**固定光标**然后以
  //      光标为中心放大图片，**不要为了全屏显示单个图片而移动图片**」。
  //    ⚠ 别在这里补任何"挪回屏幕内"的修正 —— 那正是他不要的那个行为。
  const mx = event.clientX - view.left;
  const my = event.clientY - view.top;
  const ax = (mx - st.x) / st.s;
  const ay = (my - st.y) / st.s;
  applyZoom(img, s2, mx - s2 * ax, my - s2 * ay);
  return true;
}

/** 当前跨页上"看得见的那几张照片"（横屏时最多两张；版权页/封底返回空数组）。
 *
 *  ⚠ 库在 DOM 里保留全部 103 页，只把不在当前跨页的页 `display:none` 掉 ⇒
 *    这里必须同时判 display 与"有没有落在视口里"，不能只数第几个 `.plate img`。
 */
function visiblePhotoImgs() {
  const out = [];
  for (const p of document.querySelectorAll(".book-page")) {
    if (getComputedStyle(p).display === "none") continue;
    const img = p.querySelector(".plate img");
    if (!img) continue;
    const r = img.getBoundingClientRect();
    if (r.width < 20 || r.height < 20) continue;
    if (r.right < 4 || r.bottom < 4 || r.left > innerWidth - 4 || r.top > innerHeight - 4) continue;
    out.push(img);
  }
  return out;
}

/** ★★ Phase 34：Ctrl + 加/减号 = **围绕左右两张照片的正中心**整体缩放；
 *                    而且**铺满屏幕之后还能再放大 4 倍** ★★
 *
 *  佘先生 2026-09-28：「键盘上的 Ctrl 和加减键位放缩时就围绕两张图片的正中心缩放，
 *    注意是两张图片同时放大」＋「一是 Ctrl 和加减号的两张图片同时放大的效果改成
 *    **图片全屏后还能放大四倍**」。
 *
 *  上限口径（他选定）：**单张"铺满"倍率 × SPREAD_TURNS(4)**。
 *    单张铺满倍率 sCover = max(舞台宽/照片宽, 舞台高/照片高)（这本书实测 ≈2.81）
 *    ⇒ 最高能到 ≈11 倍。**不是**"两张合起来铺满就停"（那是 Phase 33 的旧口径，
 *    已按他的新要求换掉 —— 铁律 7：需求被本人改掉，旧判据显式换掉）。
 *
 *  ⚠ 和滚轮那套是两种语义，别混：
 *      滚轮 —— 只动鼠标底下那**一张**，纯光标锚点、绝不挪图（Phase 34）；
 *      Ctrl —— 两张**一起**按同一个比例缩，中心取"两张合起来的外接矩形"的中心。
 *  ⚠ 两张照片的 s 可能不同（用户先用滚轮放大过其中一张）⇒ 用同一个比例 k
 *    各自乘上去，相对位置与相对大小都保持不变。
 *  ⚠ 全程**不夹紧**（applyZoom 里已无夹紧）——两张各自夹紧会把它们朝两边挤散。
 */
function spreadZoom(dir) {
  const imgs = visiblePhotoImgs();
  if (!imgs.length) return false;
  const view = zoomViewport();
  if (!view || !view.width || !view.height) return false;

  // 1) 量出"两张合起来"的外接矩形与它的中心。
  //    ⚠ 用 (X, Y, s) 自己算，**不能**用 getBoundingClientRect：那给的是变换后的
  //      矩形，两张各自的外接框会互相干扰。
  const items = imgs.map((img) => {
    const o = zoomOriginOf(img);
    const st = zoomStateOf(img);
    return {
      img, st,
      // 单张的"铺满"倍率：两个方向里更费劲的那个（这就是它"全屏"的倍率）
      sCover: Math.max(view.width / o.w, view.height / o.h),
      l: st.x, t: st.y, r: st.x + st.s * o.w, b: st.y + st.s * o.h,
    };
  });
  const l = Math.min(...items.map((i) => i.l));
  const t = Math.min(...items.map((i) => i.t));
  const r = Math.max(...items.map((i) => i.r));
  const b = Math.max(...items.map((i) => i.b));
  const cx = (l + r) / 2;
  const cy = (t + b) / 2;

  const k = dir > 0 ? ZOOM_FACTOR : 1 / ZOOM_FACTOR;
  let moved = false;
  for (const it of items) {
    // 上限 = 这一张的"铺满倍率 × 4"（Phase 34 新口径），**不再是全局 ZOOM_MAX**
    const sMax = it.sCover * SPREAD_TURNS;
    const s2 = Math.min(Math.max(it.st.s * k, ZOOM_MIN), sMax);
    if (Math.abs(s2 - it.st.s) < 0.0005) continue;
    const ratio = s2 / it.st.s;
    // 围绕中心等比缩放：中心不动 ⇒ 每张的左上角也按 ratio 从中心推出去
    const nx = cx + (it.st.x - cx) * ratio;
    const ny = cy + (it.st.y - cy) * ratio;
    applyZoom(it.img, s2, nx, ny, sMax);
    moved = true;
  }
  return moved;
}

// ---------------------------------------------------------------
// ★★★ Phase 35：双击照片 ⇒ 单张全屏看（灯箱） ★★★
// ---------------------------------------------------------------
//
// 佘先生 2026-09-29：「双击画册中的图片可以**单独一个图片显示**，在单击右上角
//   **叉号**退出当前图片的显示，放大的效果也是**光标位置为中心**放大」。
//
// 交互（照他的话做，不加多余设计）：
//   双击**中间页上的照片** → 这张照片单独铺满画面（保持原比例、居中）
//   右上角**叉号**         → 退出（另留两条顺手入口：Esc、点图片外的暗处）
//   在灯箱里滚滚轮         → **以光标那一点为中心**放大 / 缩小（1~8 倍）
//
// 两个容易踩错的点：
//   ① 双击那两下"单击"本来就会各翻一页（库的 `disableFlipByClick:false`，原功能保留）。
//      等 `dblclick` 到手时，书其实已经往后走了两页。所以**打开灯箱的同时**把书
//      悄悄还原到"双击之前那一页" —— 灯箱是不透明铺满的，这一下用户看不见；
//      不还的话，关掉灯箱会发现书凭空跳了两页。
//   ② **封面 / 封底不归灯箱管**（它们的双击是"整叠翻页"）。判据是页元素上的
//      `data-density="hard"` —— 封面虽然在 DOM 里也带一张 `.plate img`，
//      但它是硬页，得留给"整叠翻页"那条。
//
// ⚠ 这一套 DOM 全部现拼，**模板里一行不加**：改了模板就得重出成品，
//   而现拼的话老书只要同步 CSS/JS 两个文件就拿到这个功能。

/** 鼠标底下那张照片，**但只在软页上才算**（封面 / 封底返回 null，留给整叠翻页） */
function softPhotoAt(clientX, clientY) {
  const img = photoImgAt(clientX, clientY);
  if (!img) return null;
  const page = img.closest(".book-page");
  if (!page || page.dataset.density === "hard") return null;
  return img;
}

/** 灯箱的元素（惰性建一次，之后复用） */
function lightboxEnsure() {
  if (lightboxBox) return lightboxBox;
  const box = document.createElement("div");
  box.className = "lightbox";
  box.hidden = true;
  const img = document.createElement("img");
  img.className = "lightbox__img";
  img.alt = "";
  img.draggable = false;
  const close = document.createElement("button");
  close.type = "button";
  close.className = "lightbox__close";
  close.setAttribute("aria-label", "关闭");
  close.title = "关闭（Esc）";
  close.textContent = "\u00d7";
  box.appendChild(img);
  box.appendChild(close);
  document.body.appendChild(box);
  close.addEventListener("click", () => lightboxClose());
  // ★ Phase 41：按住左键拖 = 移动照片。灯箱铺满视口 ⇒ 指针永远落在 box 上，
  //   pointermove 会自己冒泡过来，**不要 setPointerCapture** ——
  //   一旦捕获，mousedown/mouseup 会被重定向到 box ⇒ 连"点一下图片"都会被当成
  //   "点到暗处"而误关（实测踩过这一下）。
  box.addEventListener("pointerdown", lightboxPanDown);
  box.addEventListener("pointermove", lightboxPanMove);
  box.addEventListener("pointerup", lightboxPanUp);
  box.addEventListener("pointercancel", lightboxPanUp);
  box.addEventListener("click", (event) => {
    if (lightboxDragged) { lightboxDragged = false; return; }   // 刚拖过 ⇒ 这一下是拖的余波
    if (event.target === box) lightboxClose();
  });
  lightboxBox = box;
  return box;
}

/** 把那张图按"原比例铺满画面"居中摆好，并把缩放复位到 1 倍 */
function lightboxFit() {
  const box = lightboxBox;
  const st = lightboxState;
  if (!box || box.hidden || !st) return;
  const img = box.querySelector(".lightbox__img");
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const k = Math.min(vw / st.w, vh / st.h);
  const w = Math.max(1, Math.round(st.w * k));
  const h = Math.max(1, Math.round(st.h * k));
  img.style.width = `${w}px`;
  img.style.height = `${h}px`;
  lightboxState = { s: ZOOM_MIN, x: (vw - w) / 2, y: (vh - h) / 2, w, h };
  lightboxApply();
}

/** 落位。与 applyZoom 同一套量纲：`transform-origin: 0 0`、位移 = 目标位置 − 1 倍落位 */
function lightboxApply() {
  const box = lightboxBox;
  const st = lightboxState;
  if (!box || !st) return;
  const img = box.querySelector(".lightbox__img");
  img.style.transform = `translate(${st.x}px, ${st.y}px) scale(${st.s})`;
}

/** 打开：显示一张照片。`natW/natH` 是像素尺寸，图还没解码完时先用它摆一次 */
function lightboxOpen(src, natW, natH, returnPage) {
  const box = lightboxEnsure();
  const img = box.querySelector(".lightbox__img");
  stopAuto();
  stopCoverRun();
  cancelLightboxReturn();        // 上一轮关灯箱欠下的"还原"作废：它认的是旧目标，留着会拽错
  lightboxReturnTo = returnPage;
  img.removeAttribute("style");
  img.src = src;
  lightboxState = { s: ZOOM_MIN, x: 0, y: 0, w: natW || 1280, h: natH || 853 };
  box.hidden = false;
  if (img.complete && img.naturalWidth) {
    lightboxState.w = img.naturalWidth;
    lightboxState.h = img.naturalHeight;
    lightboxFit();
    return;
  }
  img.addEventListener("load", () => {
    if (img.naturalWidth) {
      lightboxState.w = img.naturalWidth;
      lightboxState.h = img.naturalHeight;
    }
    if (!box.hidden) lightboxFit();
  }, { once: true });
  lightboxFit();            // 先用调用方给的尺寸摆一次，图解码完再校正
}

/** 关掉灯箱（书页位那一下在 lightboxReturnBook 里悄悄做掉） */
function lightboxClose() {
  const box = lightboxBox;
  if (!box || box.hidden) return;
  box.hidden = true;
  lightboxState = null;
  const img = box.querySelector(".lightbox__img");
  img.removeAttribute("src");
  img.removeAttribute("style");
  lightboxReturnBook();
}

/** 把书还原到"双击之前那一页"（灯箱盖着，看不见）。
 *
 *  双击那两下单击已经各翻了一页，不还的话关掉灯箱书会凭空往后跳两页。
 *  做法：先把 `flippingTime` 压到 1（让"半路那一翻"立刻收尾），再**等它落定**
 *  之后把页位纠过去。
 *  ⚠⚠ 这里踩过一个真坑（findings 101）：原来的退出条件是"页位 == 目标"就收手，
 *     而 `turnToPage()` 调完的那一瞬间页位**确实**等于目标，可**第二下单击的翻页
 *     还在飞**，它落下来又把人推走 ⇒ 循环已经退出了，书最后停在错的地方。
 *     所以退出条件必须是**「页位 == 目标 **且** 书已经落定」**，
 *     而且只在落定的时候才去调 `turnToPage()`。
 *  ⚠ 库的 `turnToPage()` 是**瞬移**（不产生 flip 事件）—— 正是这里要的。
 */
function lightboxReturnBook() {
  const target = lightboxReturnTo;
  lightboxReturnTo = null;
  if (target == null) return;
  const run = ++lightboxReturnRun;        // ★ 认班次：用户中途自己翻页 ⇒ 这趟作废（见 cancelLightboxReturn）
  const s = pageFlip.getSettings?.();
  const keep = s ? s.flippingTime : null;
  if (s) s.flippingTime = 1;
  let tries = 0;
  const step = () => {
    if (run !== lightboxReturnRun) return;   // 被后一趟/被用户导航顶掉了 ⇒ 悄悄收手，别抢
    tries += 1;
    const settled = bookSettled();
    if (settled && pageFlip.getCurrentPageIndex() === target) {
      if (s && keep != null) s.flippingTime = keep;
      updateControls();
      return;
    }
    if (tries > 40) {                     // 兜底：别无限纠下去（最多 2 秒）
      if (s && keep != null) s.flippingTime = keep;
      updateControls();
      return;
    }
    if (settled) pageFlip.turnToPage(target);
    window.setTimeout(step, 50);
  };
  step();
}

/** ★ 用户自己导航（翻页 / 跳页 / Home / End）⇒ 撤掉"待还原"，别跟他抢。
 *
 *  那一下"待还原"本来是替双击多出来的两下单击擦屁股（不擦的话关掉灯箱书会
 *  凭空往后跳两页）。可它最长要纠 2 秒（等书落定再瞬移），这中间用户要是自己
 *  跳了一页，那趟纠正在落定后**还会再拽他一把** —— 实测就是这样：按 Esc 关掉
 *  灯箱、紧接着跳到第 1 页，半秒后被拽回双击那张照片所在的页。
 *  口径：用户一旦自己动手，就等于"我不要那次补偿了"，和 `stopCoverRun()` 一个道理。
 */
function cancelLightboxReturn() {
  lightboxReturnTo = null;
  lightboxReturnRun += 1;                // 正在跑的那趟 step 循环看到班次变了就收手
}

/** 灯箱里滚一格：**以光标那一点为中心**放大 / 缩小（算式与 zoomBy 完全一致） */
function lightboxZoom(event) {
  const deltaY = Number(event.deltaY);
  if (!Number.isFinite(deltaY) || Math.abs(deltaY) < 4) return false;   // 触控板抖动
  const now = Date.now();
  if (now < lightboxReadyAt) return false;
  lightboxReadyAt = now + LIGHTBOX_COOLDOWN_MS;
  const st = lightboxState;
  if (!st) return false;
  // 向上滚 = 放大（看图软件的通用习惯）
  const raw = deltaY < 0 ? st.s * ZOOM_FACTOR : st.s / ZOOM_FACTOR;
  // ★ 与 zoomBy 同一条规矩：**先把目标倍率夹进量程，再判断到底变没变**，
  //   不然到顶之后每一格还会把图往外推一点（Phase 33 修过的那个真 bug）。
  const s2 = Math.min(Math.max(raw, ZOOM_MIN), LIGHTBOX_MAX);
  if (Math.abs(s2 - st.s) < 0.0005) return true;      // 到顶了，但仍算"处理掉了"
  const mx = event.clientX;                            // 灯箱铺满视口 ⇒ 视口坐标就是它的坐标
  const my = event.clientY;
  const ax = (mx - st.x) / st.s;                       // 光标底下那点在**图上**的位置
  const ay = (my - st.y) / st.s;
  lightboxState = { s: s2, x: mx - s2 * ax, y: my - s2 * ay, w: st.w, h: st.h };
  lightboxApply();
  return true;
}

// ---------------------------------------------------------------
// ★★★ Phase 41 优化一：灯箱里按住左键拖 = 移动照片 ★★★
// ---------------------------------------------------------------
//
// 量纲与 `lightboxZoom` 完全一致（`transform-origin: 0 0`、位移就是左上角坐标），
// 所以拖拽只是"起点 + 位移"，不做任何换算 —— 另写一套量纲正是当初"放大时左右晃"
// 的根因（findings 91），这里不重犯。
// ⚠ 拖过（位移 ≥ 3px）就吃掉松手那一下 click：拖到图片外面松手时，浏览器补的 click
//   的 target 是灯箱本身 ⇒ 不挡的话"拖一下"会顺带把灯箱关掉。

const LIGHTBOX_DRAG_MIN = 3;

function lightboxPanDown(event) {
  const st = lightboxState;
  if (event.button !== 0 || !st) return;                       // 只认左键
  if (event.target && event.target.closest && event.target.closest(".lightbox__close")) {
    return;                                                    // 叉号上按下不当作拖拽
  }
  lightboxDrag = { id: event.pointerId, x: event.clientX, y: event.clientY,
                   ox: st.x, oy: st.y };
  lightboxDragged = false;
  // ⚠ 这里**故意不 preventDefault**：在 Chrome 里取消 pointerdown 会把随后的
  //   兼容鼠标事件（含 click）一起吞掉 ⇒ 「点暗处关闭」那条就被废了（实测踩过）。
  //   防原生拖图/选字已经由 `.lightbox{user-select:none}` 和 `img.draggable=false`
  //   兜住了；真要拦，等位移过阈值以后在 pointermove 里拦。
}

function lightboxPanMove(event) {
  const d = lightboxDrag;
  const st = lightboxState;
  if (!d || !st || event.pointerId !== d.id) return;
  const dx = event.clientX - d.x;
  const dy = event.clientY - d.y;
  if (!lightboxDragged && Math.abs(dx) + Math.abs(dy) < LIGHTBOX_DRAG_MIN) return;
  if (!lightboxDragged) event.preventDefault();                 // 起步这一下才拦
  lightboxDragged = true;
  lightboxBox.classList.add("is-panning");
  lightboxState = { s: st.s, x: d.ox + dx, y: d.oy + dy, w: st.w, h: st.h };
  lightboxApply();
}

function lightboxPanUp(event) {
  const d = lightboxDrag;
  if (!d) return;
  if (event && event.pointerId != null && event.pointerId !== d.id) return;
  lightboxDrag = null;
  if (lightboxBox) lightboxBox.classList.remove("is-panning");
}

// 指针要是拖到窗口外面才松手，box 上收不到 pointerup ⇒ 窗口这一层兜一下
window.addEventListener("pointerup", lightboxPanUp);

/** 窗口尺寸变了就重新摆一次（灯箱开着时） */
window.addEventListener("resize", () => {
  if (lightboxBox && !lightboxBox.hidden) lightboxFit();
});

// ---------------------------------------------------------------
// ★★★ Phase 29 一（**Phase 32 起改成缩放**）：滚轮那一下给谁 ★★★
// ---------------------------------------------------------------
//
// 历史：Phase 29 这里做的是「滚轮翻页（向上往左翻 / 向下往右翻）」，
// 带一个 260ms 冷却挡惯性连翻。Phase 32 佘先生要求把滚轮改成缩放
// ⇒ 冷却、翻页分支、那两个常量全部撤掉（见上面那段注释）。
// 下面只留下**仍然有用**的那件事：焦点在输入框里时让路。
//
// ★ 焦点在输入框里时让路：和键盘那条规则一致（在页码框里滚一下不该缩放）。
//
function wheelShouldYield() {
  // ⚠ 判的是**键盘焦点**（document.activeElement），不是 event.target ——
  //   wheel 的 event.target 永远是"鼠标指针底下那个元素"（鼠标在书上滚时就是书页），
  //   拿它判"焦点在不在输入框"会永远判成"不在"。实测过：焦点在跳页框里滚轮照样翻页。
  const el = document.activeElement;
  return !!(el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA"
                   || el.isContentEditable));
}

window.addEventListener("wheel", (event) => {
  // ★★★ Phase 35：灯箱开着 ⇒ 滚轮**只管灯箱里那张图**（书页一概不碰）。
  //   这一条必须排在 `wheelShouldYield()` 之前：灯箱是模态的，它开着的时候
  //   "焦点在不在跳页输入框里"与用户此刻的意图无关；排在后面的话，
  //   万一焦点还在那个输入框上，灯箱里滚轮就会变成"什么都不发生"。
  if (lightboxBox && !lightboxBox.hidden) {
    if (lightboxZoom(event)) event.preventDefault();
    return;
  }
  if (wheelShouldYield()) return;
  // ★★★ Phase 32：滚轮 = **缩放照片**（佘先生：「鼠标中键滑动改成缩放功能」）。
  //
  //   Phase 29 那条「滚轮翻页」在这里被**取代**：
  //     原来  ——  单独滚滚轮：向上往左翻、向下往右翻（Phase 29 的原功能）；
  //     现在  ——  单独滚滚轮：放大 / 缩小照片。
  //   ⚠ 是他本人点名要改的（"改成"），不是我们私自砍功能。
  //     真要翻页，还有箭头按钮、方向键、拖页角、常驻跳页框四条路，一条没少。
  //   ⚠ 中键按不按**不一样**：按住中键期间滚轮/拖动一律不产生任何效果
  //     （他的要求一「摁住鼠标中键暂时不要有什么操作」），见下面那行 `if (middleDown)`。
  //   ⚠ 中键按住期间**一律让路**（他的要求一：「摁住鼠标中键暂时不要有什么操作」）：
  //     这一条必须在 zoomBy 之前，否则按着中键滚滚轮照样会把照片缩放起来 ——
  //     实测踩过（按着中键滚 6 格，倍率 1.00 → 2.70）。
  if (middleDown) { event.preventDefault(); return; }
  if (zoomBy(event)) {
    event.preventDefault();     // 页面本身不该跟着滚（passive:false 才生效）
    return;
  }
  // 鼠标不在照片上（版权页 / 封底 / 控制条那一带）时，滚轮不该有任何副作用 ——
  // 尤其**不能再翻页**：否则"想缩放却啥也没放大，书反倒翻过去了"。
  // 只有页面真能滚（本页面 body overflow:hidden，正常滚不动）时才放行默认行为。
}, { passive: false });

// ---------------------------------------------------------------
// ★★★ 封面 / 后壳双击 ⇒ 先"逐页急翻"几下，再**瞬间切**到另一头 ★★★
// ---------------------------------------------------------------
//
// 佘先生：「在封面我连击鼠标左键两次是翻转画册到后壳，
//   在后壳我连击鼠标左键两次则翻转画册到封面」。
//
// 四版历史（**别走回头路**）：
//   Phase 29：`flip(末页)` 一步到末跨页 + `flipNext()` 合上 —— 两下都很快，
//             观感是"闪一下就到后面了"。
//   Phase 33：一页页连播 52 页 —— 看得清，但太久，而且不像厚书。
//   Phase 34/35：自绘一个"整叠方块"绕书脊转 180°（先做过 18 层薄片扇开，
//             后改成三面纯白方块 + 书口切面 + 衬底白纸）。
//             ⚠ **他本人看到成品后否掉了**：「一整块转半圈太机械」。
//               真书翻过去是一页页的、不是一块板 —— **隐喻错了，参数救不回来**。
//   Phase 36（当前）：**逐页急翻 5 下 ⇒ 停下 ⇒ 瞬间切到另一头**。
//             他原话：「逐页急翻五面，然后就不翻了，直接跳到封面和后壳，
//               在后壳处翻转也是一样的」；追问确认：五下 = 五张跨页、
//               收尾是"瞬间切过去"（不要过渡）、封面→后壳 / 后壳→封面。
//
// 状态只有一处：`coverRun`（null = 没在跑；否则 `{ dir, turns, need, keep, timer }`）。
// 终点：封面→后壳 = `atFinalSpread()`（书已合上、只剩封底一页）；后壳→封面 = 第 0 页。
//
// ★★ 为什么"翻了几下"必须用 `flipCount` 数、不能拿页位换算 ★★
//   实测（`_p36_probe0.mjs` M1/M2）：真双击封面**只派发 1 个 `flip`**（页位 0→1，
//   第二下在翻页途中被库吞了）；而单次 `flipNext("top")` 的页位增量是
//   **封面那一下 +1、之后每下 +2**。两个事实合起来 ⇒ 页位差和"翻了几下"不是线性关系。
//   **一下 = 一个 `flip` 事件**，这是唯一口径。

/** 库现在是不是"闲着"（翻页动画收尾了没有）
 *  库里 `getState()` 在动画结束时会回到 "read"；产品这边 changeState 的镜像就是 `isTurning`。 */
function bookSettled() {
  return pageFlip.getState?.() === "read" || !isTurning;
}

/** 一趟巡演推进一步：**逐页急翻，翻够就瞬间切到终点**（Phase 36）。
 *
 *  ⚠⚠ 推进**必须自己排 setTimeout**，不能靠 changeState 递归（Phase 33 实测踩到）：
 *     在"落定后立刻再 flipNext()"的递归里，库会把整趟翻页在**同一毫秒**内
 *     同步走完（52 个 `flip` 全挤在 155~156ms）⇒ 画面"闪一下"就到后壳（findings 92）。
 *     这里每一拍都留 `RIFFLE_POLL_MS` 给库一帧。
 *
 *  ★ 节拍不靠猜：每一拍先问"上一下翻完了没"（`bookSettled()`），翻完了才发下一拍。
 *    实测（`_p36_probe0.mjs` M3）`RIFFLE_MS=260` 时每下 248ms 落定 ⇒ 间隔 ≈ 300ms。
 */
function coverTick() {
  if (!coverRun) return;
  const dir = coverRun.dir;
  const cur = pageFlip.getCurrentPageIndex();
  // 到了吗？封面→后壳看"是不是已经合上"，后壳→封面看"是不是已经回到第 0 页"。
  // ⚠ 短书（跨页数不足 5）会在这里提前收尾 —— **按这本书自己的跨页数算，别写死页码**
  //   （findings 51：短书会打穿"还有下一页"这类前提）。
  if (dir > 0 ? atFinalSpread() : cur <= 0) {
    stopCoverRun();
    return;
  }
  // ① 上一下还转着 ⇒ 让一帧再看（抢着发会被库吞掉，那一下就白数了）
  if (!bookSettled()) {
    coverRun.timer = window.setTimeout(coverTick, RIFFLE_POLL_MS);
    return;
  }
  // ② 还没翻够 ⇒ 再急翻一下
  if (coverRun.turns < coverRun.need) {
    coverRun.turns += 1;
    if (dir > 0) pageFlip.flipNext("top");
    else pageFlip.flipPrev("top");
    coverRun.timer = window.setTimeout(coverTick, RIFFLE_POLL_MS);
    return;
  }
  // ③ 急翻完了 ⇒ 结算这一趟，收掉，**瞬间切**到终点（他要的就是"直接跳"，别加过渡）
  lastRiffle = {
    dir,
    already: coverRun.already,
    own: coverRun.turns,
    total: coverRun.already + coverRun.turns,   // ★ "翻了几下"以它为准（不含收尾那一跳）
  };
  stopCoverRun();
  jumpToEndInstant(dir);
}

/** 急翻用的"提速"：把库的 `flippingTime` 临时压到 `RIFFLE_MS`。
 *
 *  ★ 实测（`_p36_probe0.mjs` M3/M5）：`getSettings()` 拿到的是**活对象**，改了下一拍
 *    就生效（760 → 248ms）；而且**正在转的那一页不受影响** —— M5 里起手 760ms 的那一下
 *    途中改成 260 后，总耗时仍是 724ms、角度曲线 165°→134°→177° 平滑无跳变。
 *    ⇒ 所以"起手就提速"是安全的：双击自带的那一下照旧平滑走完，之后几下才变急。
 *  ⚠ 收尾**必须无条件还原**（findings 92），否则用户之后自己点箭头会快得看不清。
 */
function applyRiffleSpeed(run) {
  const s = pageFlip.getSettings?.();
  if (!s) { run.keep = null; return; }
  run.keep = s.flippingTime;
  s.flippingTime = RIFFLE_MS;
}

/** 还原 `flippingTime`（幂等；没提过速就什么都不做） */
function restoreRiffleSpeed(run) {
  if (!run || run.keep == null) return;
  const s = pageFlip.getSettings?.();
  if (s) s.flippingTime = run.keep;
  run.keep = null;
}

/** 起一趟；已经在跑、或已经在终点时不重复起步 */
function startCoverRun(dir) {
  if (coverRun) return;
  if (dir > 0 && atFinalSpread()) return;                        // 已经摊在后壳
  if (dir < 0 && pageFlip.getCurrentPageIndex() <= 0) return;    // 已经在封面
  // ★ "双击自带的那几下"要**从总数里扣掉** —— 他说的五下是"我看到翻了几下"。
  //   快照取"**第一下 pointerdown 之前**"的值：等 dblclick 到手时，头一下已经翻过去了。
  //   实测那只派发 1 个 `flip`（不是 2），所以这里**算差、不写死**。
  const already = Math.max(0, flipCount - flipsAtPrevDown);
  coverRun = {
    dir,
    turns: 0,
    already,
    need: Math.max(1, RIFFLE_TURNS - already),   // 至少还要自己翻一下，别退化成"一步到位"
    keep: null,
    timer: 0,
  };
  applyRiffleSpeed(coverRun);
  coverTick();
}

/** 中途收掉（用户自己按了箭头 / 键盘翻页 ⇒ 别跟他的操作抢）。
 *  ⚠ 只停"接着往下翻"，**不回滚**页位 —— 已经翻过去的那几下是真的翻过去了，
 *    硬回滚反而和用户眼前看到的不一致。 */
function stopCoverRun() {
  if (!coverRun) return;
  if (coverRun.timer) window.clearTimeout(coverRun.timer);
  restoreRiffleSpeed(coverRun);
  coverRun = null;
}

/** 瞬间落到终点：前翻 = 合上的后壳（封底），后翻 = 封面。
 *  ★ Phase 36：这就是"急翻完之后**直接跳**"的那一下 —— 他点名要**瞬间切过去**，
 *    所以这里**刻意不配任何过渡**（淡出/滑过都不要）。
 *
 *  ★ 前翻为什么要两步：库的 `turnToPage(末页)` 只把书**摊到末跨页**（版权页+封底，
 *    书还开着）。实测（`_p36_probe0.mjs` M4）：`getCurrentPageIndex() = 101`、
 *    `edge = "inside"` —— "合上"是 Phase 27 补的那一格（`edge="back"`），
 *    只能靠一次 `flipNext()` 拿到（M1 收尾实测拿到 idx=102、`edge="back"`）。
 *  ⚠ 那一次 `flipNext` 必须**几乎不花时间**（不然"瞬间切"就成了慢慢合）
 *    ⇒ 临时把 `flippingTime` 压到 1，下一拍还原（库每帧读它，立刻生效）。
 */
function jumpToEndInstant(dir) {
  if (dir > 0) {
    pageFlip.turnToPage(pageFlip.getPageCount() - 1);
    const s = pageFlip.getSettings?.();
    const keep = s ? s.flippingTime : null;
    if (s) s.flippingTime = 1;
    pageFlip.flipNext("top");
    if (s && keep != null) {
      window.setTimeout(() => { s.flippingTime = keep; }, 120);
    }
  } else {
    pageFlip.turnToPage(0);
  }
  updateControls();
}

bookElement.addEventListener("dblclick", (event) => {
  if (event.button !== 0) return;      // 只认鼠标左键
  stopAuto();

  // ★★★ Phase 41：全屏里控制条收着 ⇒ 这一下双击先把它**唤回来**（见文件末尾 fsBar* 那段）。
  //   ⚠ 必须排在照片/封面那两条之前：全屏时每个页面本身就是整张照片，不先接管的话
  //     "叫 UI"永远会被"单张全屏"抢走，用户就找不到按钮了。
  //   ⚠ 双击的那两下单击已经各翻了一页 ⇒ 借灯箱那套"悄悄还回去"的机制把页位复原，
  //     不能让"叫个 UI"顺手把书翻走两页。
  if (fsReadingMode() && !fsBarVisible()) {
    fsBarShow();
    if (pageAtPrevDown != null) {
      lightboxReturnTo = pageAtPrevDown;
      lightboxReturnBook();
    }
    return;
  }

  // ⚠⚠ **必须用按下那一刻记下的 prev 快照来判起点**，不能看当下：
  //   库默认 `disableFlipByClick:false` ⇒ 单击书页本来就会翻页（原功能，保留）。
  //   于是一次双击 = 两次单击，书先被翻走两页，等 dblclick 派发过来时
  //   `currentPage` / `atFinalSpread()` 都已经是翻完之后的了 ——
  //   拿它们判"这次双击是不是从封面开始的"，必然判不出来（实测整段失效）。
  //
  //   ★ Phase 34：那两下单击带来的**前两页翻动，正好就是他要的"先翻两页"**
  //     （实测封面 0 → 2），所以这里不再重复翻两页，只负责"补足到两页 +
  //     把剩下的一整叠当块面翻过去"（见 coverTick）。

  // ★★★ Phase 35：**照片上双击 ⇒ 这张照片单独全屏看**（灯箱）。
  //   放在最前面。⚠ `photoAtPrevDown` 只认**软页**上的照片（封面/封底是硬页，
  //   已在 `softPhotoAt` 里排掉）⇒ 不会把封面那两次双击抢走。
  //   起点页位仍用 pointerdown 快照（pageAtPrevDown）：那两下单击已经翻过页了，
  //   关掉灯箱时要用它把书还原到原处（见 lightboxReturnBook）。
  if (photoAtPrevDown) {
    const src = photoAtPrevDown.currentSrc || photoAtPrevDown.src || "";
    if (src) {
      lightboxOpen(src, photoAtPrevDown.naturalWidth, photoAtPrevDown.naturalHeight,
                   pageAtPrevDown);
      return;
    }
  }

  if (finalAtPrevDown) {               // 起点是后壳 ⇒ 两页 + 整叠翻回封面
    startCoverRun(-1);
    return;
  }
  if (pageAtPrevDown === 0) {          // 起点是封面 ⇒ 两页 + 整叠翻到后壳
    startCoverRun(1);
    return;
  }
  // 起点是中间任何一页、且没点到照片 ⇒ 不接管
  //（那两次单击照旧各翻一页，原功能保持不变）
});

window.addEventListener("keydown", (event) => {
  // ★★★ Phase 35：灯箱开着 ⇒ 键盘只认 Esc（其余一律不碰）。
  //   不拦的话，在灯箱里按方向键/空格会把**背后的书**翻走，而用户看不见它。
  if (lightboxBox && !lightboxBox.hidden) {
    if (event.key === "Escape") {
      event.preventDefault();
      lightboxClose();
    }
    return;
  }
  // ★ 焦点在输入框里时，所有翻页快捷键都要让路（Phase 19 加跳页时补的）。
  //   否则在页码输入框里打字，按空格会翻页，按 Home/End 会直接跳到首/末页 ——
  //   而 Home/End 恰恰是"把光标移到行首/行尾"的常用键，冲突起来非常烦人。
  //   输入框自己的 Enter / Esc 由 jumpInput 的监听处理，这里直接放行。
  const target = event.target;
  if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) {
    return;
  }

  // ★★ Phase 33：Ctrl + 加/减号 = 围绕**两张照片的正中心**整体缩放（他的要求二）。
  //    必须排在下面那条"带 Ctrl 一律让路"之前，否则永远轮不到这里。
  //    键名三套都要认：`=` / `+` 是主键盘，`Add` / `Subtract` 是数字小键盘。
  if (event.ctrlKey && !event.altKey && !event.metaKey) {
    const k = event.key;
    if (k === "+" || k === "=" || k === "Add") {
      event.preventDefault();
      stopAuto();
      spreadZoom(1);
      return;
    }
    if (k === "-" || k === "_" || k === "Subtract") {
      event.preventDefault();
      stopAuto();
      spreadZoom(-1);
      return;
    }
  }

  if (event.altKey || event.ctrlKey || event.metaKey) return;

  // ★ 翻页键一律先「手动接管」（Phase 20）：先停自动翻页，再谈翻不翻得动。
  //   顺序不能颠倒 —— 若先判 isTurning 就 return，那么用户在翻页动画正跑的
  //   那 0.76 秒里按方向键，会既不翻页、也不停自动翻页，看起来像按键失灵。
  const flipKeys = ["ArrowLeft", "ArrowRight", " ", "Home", "End"];
  if (flipKeys.includes(event.key)) stopAuto();

  if (isTurning) return;

  if (event.key === "ArrowLeft") {
    event.preventDefault();
    turnPrev();
  }

  if (event.key === "ArrowRight" || event.key === " ") {
    event.preventDefault();
    turnNext();
  }

  if (event.key === "Home") { cancelLightboxReturn(); pageFlip.turnToPage(0); }
  if (event.key === "End") {
    cancelLightboxReturn();
    pageFlip.turnToPage(pageFlip.getPageCount() - 1);
  }
});

// ★★★ 点击页码跳页（Phase 19）★★★
//
// 起因：佘先生「我在查看画册时只能一页一页地看，不方便，要求可以选择页数，
// 就点击页数就可以输入页数」——《深圳》103 页，想看第 60 页要按 59 次「下一页」。
//
// 交互（照他的话做，不加多余设计）：
//   点页码 → 就地变成输入框（预填当前页、全选）→ 输数字回车 → 跳过去
//   回车 = 跳 / Esc = 取消 / **失焦也按跳转处理**（打了数字又点别处，意图仍然是跳）
//
// 两个刻意的选择：
//   1. **限幅，不报错**：输入 0 或 9999 都夹到 [1, 总页数]。这里不是表单，
//      没有任何理由因为多打一个 0，就给正在看书的人弹一个错误。
//   2. **页码口径与眼睛看到的一致**：页面角上印的 folio、状态条的 "12 / 103"
//      都是 1 起算的页位，所以输入框里那个数字就是页面上的那个数字。
//      封面/封底在状态条上写的是 "Cover" / "Back cover"，但它们就是第 1 页
//      和最后一页 —— 输入 1 或总页数照样跳得到。
//
// 不做：滑块、书签、缩略图总览。佘先生要的是「点页码输页数」，就只做这一件。

let jumpInputOpen = false;

function openJumpInput() {
  if (jumpInputOpen) return;
  // 「我要去看第 N 页」= 明确的手动意图 → 自动翻页必须停，
  // 否则页在用户打字的时候自己往下翻，输入框里的数字立刻就对不上了（Phase 20）。
  stopAuto();
  jumpInputOpen = true;
  jumpInput.value = String(currentPage + 1);
  jumpInput.hidden = false;
  jumpButton.hidden = true;
  jumpInput.focus();
  jumpInput.select();
}

function closeJumpInput() {
  jumpInputOpen = false;
  jumpInput.hidden = true;
  jumpButton.hidden = false;
}

// ★★ 「打的数字 → 页位」：两个入口共用同一个函数（Phase 26 收拢）★★
//
// Phase 26 之后有两个地方都要做这件事：
//   ① 点页码 → 就地变输入框（Phase 19，`#page-jump` / `#page-input`）
//   ② 控制条上**常驻**的「跳到第 N 页」（Phase 26，`#page-select` / `#page-go`）
// 各写一遍是**真会出事的**：同一件事有了两种答案，而且只在边界页码上显形 ——
// 一个把 9999 夹到 total、另一个夹到 total-1，用户看到的就是"两个入口差一页"。
// 所以收成这一个函数，两个入口都调它（selftest「成功T」静态钉住这条）。
function pageIndexOf(raw, total) {
  const digits = (String(raw).match(/\d+/) || [])[0];   // 「12」「12 / 103」「第 12 页」都认
  if (!digits) return null;                             // 空的、或没打出数字 → 当取消
  return Math.min(Math.max(Number(digits), 1), total) - 1;   // ★ 限幅
}

function commitJump() {
  if (!jumpInputOpen) return;
  const raw = jumpInput.value;
  closeJumpInput();
  const target = pageIndexOf(raw, pageFlip.getPageCount());
  if (target === null) return;                     // 当取消，不报错
  cancelLightboxReturn();                          // ★ Phase 35：自己跳页 ⇒ 撤掉灯箱欠下的"还原"
  pageFlip.turnToPage(target);
}

if (jumpButton && jumpInput) {
  jumpButton.addEventListener("click", openJumpInput);

  jumpInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      commitJump();
    } else if (event.key === "Escape") {
      event.preventDefault();
      closeJumpInput();
      jumpButton.focus();
    }
  });

  jumpInput.addEventListener("blur", commitJump);
} else {
  // 旧成品 HTML（没有跳页控件）配新版 flipbook.js —— 不要整段脚本炸掉，
  // 只是跳页功能不启用，其余翻页一切照旧。
  console.warn("flipbook: 页面里没有 #page-jump / #page-input，跳页功能未启用");
}

// ★★★ 控制条上常驻的「跳到第 N 页」（Phase 26）★★★
//
// 佘先生：「在查看画册的界面的选择查看的页数的功能恢复，就设计在自动翻页的
// 组块的上方，注意布局协调」。
//
// 「恢复」= 把跳页做成**一眼看得见**的常驻入口。Phase 19 那个"点页码才变输入框"
// 的入口他觉得看不见 —— 但那是原功能，一个字没动、也没删；两个入口同时存在，
// 而且**共用同一个页面换算函数 pageIndexOf()**，不会给出两种答案。
//
// 打字时自动翻页必须让位：否则页自己往下翻，输入框里的数字立刻对不上
// （与 openJumpInput 同一个理由）。所以 focus 就停。
function commitPageSelect() {
  if (!pageSelectInput) return;
  const target = pageIndexOf(pageSelectInput.value, pageFlip.getPageCount());
  if (target === null) {
    // 打的是汉字 / 留空 → 回显当前页，别把一个会造成误解的旧数字留在框里
    pageSelectInput.value = String(currentPage + 1);
    return;
  }
  stopAuto();
  // ★ 立刻回显**要去的那个页号**，而不是 `currentPage + 1`：
  //   翻页动画要 0.76 秒，这段里 currentPage 还是旧值 —— 写旧值的话，
  //   用户点了「跳转」框里的数字纹丝不动，看着像"没反应"。
  pageSelectInput.value = String(target + 1);
  cancelLightboxReturn();   // ★ Phase 35：自己跳页 ⇒ 撤掉灯箱欠下的"还原"（否则半秒后被拽回去）
  pageFlip.turnToPage(target);
  // ★ 松掉焦点：框里那个数字最终该由 `updateControls()` 按"真正停在哪一页"
  //   统一回写（它在框里有焦点时不回写，否则会冲掉用户正在打的字）。
  //   不松焦点的话，上面那句"要去的页号"会一直留着 —— 而跨页是 (奇,偶) 配对，
  //   需求页号是偶数时 `currentPage + 1` 恰好差 1，框里的数字会和状态条的
  //   「12 / 103」**长期差一页**，那是最容易让人以为功能坏了的那种不一致。
  //
  //   顺带记一笔：常驻框**没有**挂"失焦提交"。老入口 `#page-jump` 是"点一下
  //   弹出来"的临时控件，失焦=确认是合理的；而常驻框上"点别处就翻页"会吓人
  //   一跳 —— 它只认回车和「跳转」按钮两个明确动作。
  pageSelectInput.blur();
}

if (pageSelectInput) {
  pageSelectInput.addEventListener("focus", stopAuto);
  pageSelectInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      commitPageSelect();
    } else if (event.key === "Escape") {
      event.preventDefault();
      pageSelectInput.value = String(currentPage + 1);
      pageSelectInput.blur();
    }
  });
} else {
  console.warn("flipbook: 页面里没有 #page-select，常驻跳页未启用（老的「点页码」入口照旧）");
}

if (pageGoButton) {
  pageGoButton.addEventListener("click", commitPageSelect);
}

// 自测 / 调试用的句柄
window.__pf = pageFlip;
// ★ Phase 31 缩放（自测用）：
//   state(img) 读一张照片现在的倍率与平移；at(x, y) 找鼠标底下那张照片；
//   zoom(img, s, mx, my) 以容器内某点为中心缩放到指定倍率（走的是同一套瞄点数学）；
//   reset() = 翻页时的那个复位。
window.__zoom = {
  state: zoomStateOf,
  at: photoImgAt,
  /** 以舞台内某点为中心缩放到指定倍率（坐标系与产品那条路完全一致） */
  zoom: (img, s, mx, my) => {
    const st = zoomStateOf(img);
    const ax = (mx - st.x) / st.s;
    const ay = (my - st.y) / st.s;
    return applyZoom(img, s, mx - s * ax, my - s * ay);
  },
  reset: resetZoomAll,
  /** 放大要铺满的那块区域（= 整个可用画面），量"够不够全屏"就以它为准 */
  viewport: zoomViewport,
  /** 照片左上角在舞台坐标系里的位置（未变换时） */
  origin: zoomOriginOf,
  /** Ctrl + 加/减号那条（两张一起、绕合成中心缩）—— 探针可以拿它做确定性驱动 */
  spread: spreadZoom,
  limits: {
    min: ZOOM_MIN, max: ZOOM_MAX, factor: ZOOM_FACTOR,
    /** ★ Phase 34：Ctrl 那条的上限 = 单张"铺满倍率" × 这个倍数 */
    spreadTurns: SPREAD_TURNS,
  },
};
// ★ Phase 36 双击那一趟（自测用）：start(±1) = 走一趟 / stop() = 收掉 / state() = 看进度。
//   `flips()` 是**唯一**的"翻了几下"口径（一下 = 一个库的 `flip` 事件）。
//   ⚠ 这里**故意不留**任何"方块元素"的选择器：Phase 34/35 那套退役后，
//     真代码里应当**一个 `stack-` 字面量都不剩**（判据就按零来卡）。
//     探针要验"方块真的没了"，直接问 DOM 就行，不必经这里。
window.__cover = {
  start: startCoverRun,
  stop: stopCoverRun,
  state: () => (coverRun ? { ...coverRun, timer: 0 } : null),
  flips: () => flipCount,
  last: () => lastRiffle,
};
window.__jump = {
  open: openJumpInput, commit: commitJump, close: closeJumpInput,
  select: commitPageSelect,            // Phase 26 的常驻入口
  selectValue: () => (pageSelectInput ? pageSelectInput.value : null),
};
// ★ Phase 35 灯箱（自测用）：state() = 开着时的 { s, x, y, w, h, src }，关着返回 null
window.__lightbox = {
  state: () => (lightboxBox && !lightboxBox.hidden
    ? { ...(lightboxState || {}),
        src: lightboxBox.querySelector(".lightbox__img").getAttribute("src") }
    : null),
  close: lightboxClose,
  limits: { min: ZOOM_MIN, max: LIGHTBOX_MAX, factor: ZOOM_FACTOR },
};

// ★★★ 自动翻页（Phase 20）★★★
//
// 佘先生：「再新增一个自动翻页的功能，该功能手动打开」。
// **手动打开**是这条需求的全部重点：默认永远是关的，只有点了那个按钮才开跑，
// 再点一下停。不做"一打开画册就自己播"之类的自作主张。
//
// 一、什么时候它才自己停
// ---------------------------------------------------------------
// 只有两种情况，其余任何时候都听用户的：
//   1. 翻到最后一页 —— 翻不动了还空转，会让用户以为卡死；
//   2. 用户手动动了它 —— 按 ←/→/空格/Home/End、点两侧箭头、拖书页、
//      点页码要跳页。**手一碰就让位**，这是最好记的一条规则。
//
// ⚠ stopAuto() 绝不能挂进 turnNext() / turnPrev() 里：自动翻页自己也是调
//   它们前进的，挂进去会自己把自己掐停（差点这么写）。所以只挂在**用户手势**
//   的入口上：两个箭头按钮、键盘分支、pointerdown、openJumpInput。
//
// 二、已经停在最后一页时点「开始」
// ---------------------------------------------------------------
// 从封面重新播一遍。不是为了花哨 —— 而是因为"点了没反应"在用户眼里
// 和"坏了"是同一件事。
//
// 三、翻页动画还没跑完就轮到下一拍
// ---------------------------------------------------------------
// 库的翻页动画是 760ms。默认间隔 5000ms 远大于它，正常撞不上；但自测会把
// 间隔压到几百毫秒来省时间，所以这里要能处理：撞上就退让 320ms 再看一眼，
// 而不是硬翻或者干脆丢掉这一拍。
//
// 四、按钮文案不写死在 JS 里
// ---------------------------------------------------------------
// 同一份 flipbook.js 被两处用：英语的 runtime/index.html 和中文的成品书。
// 所以两套文案都由**按钮自己**带过来：
//   按钮文本              = 未播放时的文案
//   data-stop-label       = 播放中的文案
//   title / data-stop-title = 鼠标悬停提示
// 初始的 aria-pressed 由 HTML 写成 "false"（= 默认关；按钮的长相也认这个属性）。
//
// 间隔默认 5 秒/页 —— 他嫌一页页点太累，开了就是要放手让它自己走。
//
// ★ Phase 23：间隔改成**可选**。佘先生：「最快是两秒一页，最慢是十秒一页，
//   每增加一档速度翻页就每页增加一秒」⇒ 2,3,4,5,6,7,8,9,10 共 9 档。
// ★ Phase 26：佘先生「自动翻页的速度增加一个一秒一页为最快」⇒ 下限降到 1 秒，
//   变成 1,2,3,…,10 共 10 档。**默认仍是 5 秒**（下拉里带 selected 的那项不变），
//   所以"没动过速度"的成品行为与上一版一字不差。
//   控件不存在时（老成品 HTML 配新 flipbook.js）仍旧按 5 秒走，
//   行为与 Phase 20 完全一致 —— 这也是为什么默认值留在这里、而不是只写在控件上。
const AUTO_FLIP_INTERVAL_MS = 5000;
const AUTO_SPEED_MIN_S = 1;
const AUTO_SPEED_MAX_S = 10;

function readSpeedSeconds() {
  const fallback = AUTO_FLIP_INTERVAL_MS / 1000;
  if (!autoSpeedSelect) return fallback;
  const n = Number.parseInt(autoSpeedSelect.value, 10);
  if (!Number.isFinite(n)) return fallback;
  // 夹紧：HTML 被改坏、或以后有人写错档位，都不许把间隔搞成 0 / 负数
  // （0 会让 setTimeout 每轮狂转，等于把页面卡死）。
  return Math.min(AUTO_SPEED_MAX_S, Math.max(AUTO_SPEED_MIN_S, n));
}

let autoInterval = readSpeedSeconds() * 1000;
let autoTimer = 0;
const AUTO_START_LABEL = autoButton ? autoButton.textContent.trim() : "";
const AUTO_STOP_LABEL = autoButton ? (autoButton.dataset.stopLabel || AUTO_START_LABEL) : "";
const AUTO_START_TITLE = autoButton ? autoButton.title : "";
const AUTO_STOP_TITLE = autoButton ? (autoButton.dataset.stopTitle || AUTO_START_TITLE) : "";

function renderAutoButton() {
  if (!autoButton) return;
  autoButton.textContent = autoPlaying ? AUTO_STOP_LABEL : AUTO_START_LABEL;
  // 提示语里带着当前秒数：模板写 {n}，这里换成真的数 —— 用户调过速度之后，
  // 那句「每 N 秒翻一页」才不会变成假话。
  const base = autoPlaying ? AUTO_STOP_TITLE : AUTO_START_TITLE;
  autoButton.title = base.includes("{n}")
    ? base.replace("{n}", String(Math.round(autoInterval / 1000)))
    : base;
  autoButton.setAttribute("aria-pressed", autoPlaying ? "true" : "false");
}

// 播放中改档位 → **立刻**生效：把还在等的那一次计时换掉，
// 不让用户等完旧的间隔（选 2 秒却还要再等 8 秒，会以为没生效）。
function applySpeedFromSelect() {
  autoInterval = readSpeedSeconds() * 1000;
  if (autoPlaying) {
    window.clearTimeout(autoTimer);
    autoTimer = window.setTimeout(autoTick, autoInterval);
  }
  renderAutoButton();
}

function stopAuto() {
  if (!autoPlaying) return;
  autoPlaying = false;
  window.clearTimeout(autoTimer);
  autoTimer = 0;
  renderAutoButton();
}

// ★★ "还能不能往下翻"这件事 —— 去问库，不自己算 ★★
//
// 第一版写的是 `currentPage >= 总页数 - 1`，看着天经地义，实际是错的：
// 横屏时最后一跨页是 (101,102)，而 `getCurrentPageIndex()` 报的是**左页位 101**，
// 总页数却是 103 ⇒ `101 >= 102` 为假 ⇒ 判成"还没到头" ⇒ 在末页一遍遍调
// flipNext，库当然什么都不动 —— 界面就永远停在"播放中"干转（真浏览器实测抓到的）。
//
// 改成比库自己的跨页索引。实测两次（103 页的书，同一份代码）：
//                         getSpreadIndexByPage(102)   末页 getCurrentSpreadIndex()
//     横屏 1440×900              51                          51      ← 对得上
//     竖屏  460×900             102                         102      ← 也对得上
// 横竖两套坐标都不用特判，比"自己推最后一个是几号"稳得多。
function atLastSpread() {
  const collection = pageFlip.getPageCollection?.();
  if (collection?.getCurrentSpreadIndex && collection?.getSpreadIndexByPage) {
    return collection.getCurrentSpreadIndex() >=
           collection.getSpreadIndexByPage(pageFlip.getPageCount() - 1);
  }
  return currentPage >= pageFlip.getPageCount() - 1;   // 兜底，理论上到不了
}

function startAuto() {
  if (autoPlaying) return;
  // 已经在最后一页 → 从封面重播（不然点了没反应，看起来像坏了）
  if (atLastSpread()) pageFlip.turnToPage(0);
  autoPlaying = true;
  renderAutoButton();
  autoTimer = window.setTimeout(autoTick, autoInterval);
}

function autoTick() {
  autoTimer = 0;
  if (!autoPlaying) return;
  if (isTurning) {                 // 上一次翻页动画还没收尾，让一让
    autoTimer = window.setTimeout(autoTick, 320);
    return;
  }
  if (atLastSpread()) {            // 到头了 → 自停（绝不空转）
    stopAuto();
    return;
  }
  turnNext();
  autoTimer = window.setTimeout(autoTick, autoInterval);
}

function toggleAuto() {
  if (autoPlaying) stopAuto();
  else startAuto();
}

if (autoButton) {
  autoButton.addEventListener("click", toggleAuto);
} else {
  // 老成品 HTML（没有这个按钮）配新版 flipbook.js —— 不启用自动翻页，其余照旧
  console.warn("flipbook: 页面里没有 #page-auto，自动翻页未启用");
}

if (autoSpeedSelect) {
  autoSpeedSelect.addEventListener("change", applySpeedFromSelect);
}

window.__auto = {
  start: startAuto,
  stop: stopAuto,
  toggle: toggleAuto,
  isPlaying: () => autoPlaying,
  // 当前每页多少秒（Phase 23 之后它由控件决定，不再是个常数）
  speedSeconds: () => autoInterval / 1000,
  // 自测口子：把 5 秒压到几百毫秒，几秒内就能观察到两次翻页。
  // 下限 300ms —— 比一次翻页动画（760ms）还短得离谱的间隔没有意义。
  setInterval: (ms) => {
    const n = Number(ms);
    autoInterval = Number.isFinite(n) && n >= 300 ? n : AUTO_FLIP_INTERVAL_MS;
  },
  interval: () => autoInterval,
};

renderAutoButton();


// ============================================================================
// 全屏（Phase 39）：佘先生「我想可以不可以真正的全屏，就是说浏览器没有标签页」
// ============================================================================
//
// 他要的"真正的全屏"就是**浏览器的全屏模式**（F11 那种）：标签页、地址栏，
// 连 Windows 任务栏一起收走，整块屏幕只剩画册。这事只有 Fullscreen API 做得到
// —— 单把页面 CSS 拉大永远留着浏览器的壳。
//
// ★ 为什么按钮是 JS 现拼、不写进 HTML：
//   成品的 index.html 由 make_flipbook.py 的内嵌模板生成，改模板就得**重出书**；
//   而 flipbook.js / styles.css 是逐字节拷贝的，改完同步一下即可。
//   所以按钮在脚本里 createElement、插进 .auto-row（和灯箱同一个套路）。
//
// 出口有三条，都是浏览器/系统自带的：再点一下这颗按钮、按 Esc、按 F11。
// 三条都走 fullscreenchange ⇒ 按钮文案永远跟真实状态一致，不会"看着没进全屏"。
//
// ⚠ 无头 Chromium **支持** requestFullscreen（fullscreenElement 有值），
//   但 **Esc 退全屏不生效** —— 所以验收里退全屏只量"再点一下这颗按钮"，
//   别量 Esc（量了是假红，findings 117）。
// ⚠ 老成品 HTML 可能没有 .auto-row ⇒ 安静地不加按钮，其余功能一字不动。

const FULLSCREEN_OFF_LABEL = "全屏";
const FULLSCREEN_ON_LABEL = "退出全屏";
const FULLSCREEN_OFF_TITLE = "全屏看（浏览器标签页会收起来）";
const FULLSCREEN_ON_TITLE = "退出全屏（也可以按 Esc）";

const fullscreenButton = (() => {
  const row = document.querySelector(".status .auto-row") ||
              document.querySelector(".auto-row");
  if (!row) return null;                                        // 老成品没有这一行
  if (!document.documentElement.requestFullscreen) return null;  // 浏览器不支持
  if (row.querySelector("#page-full")) return null;              // 已经有一颗了
  const btn = document.createElement("button");
  btn.id = "page-full";
  btn.type = "button";
  btn.className = "page-full";
  btn.textContent = FULLSCREEN_OFF_LABEL;
  btn.title = FULLSCREEN_OFF_TITLE;
  btn.setAttribute("aria-pressed", "false");
  row.appendChild(btn);
  return btn;
})();

function renderFullscreenButton() {
  if (!fullscreenButton) return;
  const on = Boolean(document.fullscreenElement);
  fullscreenButton.textContent = on ? FULLSCREEN_ON_LABEL : FULLSCREEN_OFF_LABEL;
  fullscreenButton.title = on ? FULLSCREEN_ON_TITLE : FULLSCREEN_OFF_TITLE;
  fullscreenButton.setAttribute("aria-pressed", on ? "true" : "false");
}

// requestFullscreen 必须在**用户手势**里调用，否则被拒 —— 这是浏览器的规矩，
// 不是 bug。所以这里只被 click 处理器调用，并且把失败安静地记一笔就好。
function enterFullscreen() {
  const p = document.documentElement.requestFullscreen({ navigationUI: "hide" });
  if (p && typeof p.catch === "function") {
    p.catch((err) => { console.warn("flipbook: 进全屏被拒", err); });
  }
}

function exitFullscreen() {
  const p = document.exitFullscreen ? document.exitFullscreen() : null;
  if (p && typeof p.catch === "function") {
    p.catch(() => { /* 已经不在全屏了，忽略 */ });
  }
}

function toggleFullscreen() {
  if (document.fullscreenElement) exitFullscreen();
  else enterFullscreen();
}

if (fullscreenButton) {
  fullscreenButton.addEventListener("click", toggleFullscreen);
  // 进/退都靠这一条同步 —— Esc、F11、系统手势退出的，也一样能同步到
  document.addEventListener("fullscreenchange", renderFullscreenButton);
  renderFullscreenButton();
}

// 自测口子（验收里主要点真按钮，这几个是兜底/取证用）
window.__full = {
  toggle: toggleFullscreen,
  enter: enterFullscreen,
  exit: exitFullscreen,
  isOn: () => Boolean(document.fullscreenElement),
  hasButton: () => Boolean(fullscreenButton),
};


// ============================================================================
// ★★★ Phase 41/42：真全屏里「净屏阅读」—— 操作条收起来，双击再唤回来 ★★★
// ============================================================================
//
// 佘先生 2026-09-30：「两张图片的全屏模式时，四周不要有任何留白，包括下面的图片
//   页面操作UI组件也不要显示，我点击 Esc 或者双击鼠标左键后再显示图片页面操作UI组件，
//   此时的 UI 组件可以显示在图片上」。
// 佘先生 2026-09-30 晚（Phase 42）：「无论单个或两个图片全屏显示后**退出恢复成原来的
//   界面** —— 页面操作UI组块显示在图片**下方**（注意不是图片之内）……只允许两张图片
//   全屏的情况下有页数操作UI组块放在图片之内」＋「增加一个隐藏页数操作UI组块的功能，
//   当然也可以关闭，就在右下角的位置放这个功能的操作组块」。
//
// ★ 什么算"全屏"—— 两条硬信号，一条都不靠猜：
//   ① 走 Fullscreen API（控制条那颗「全屏」按钮）⇒ `document.fullscreenElement` 有值；
//   ② **浏览器自带全屏（F11）**、或工作台「打开画册」的 `--app=… --start-fullscreen`
//      ⇒ `matchMedia("(display-mode: fullscreen)")` 为真。
//   （Phase 41 曾经用过第三条"URI 上挂 `#fullscreen` 标记"，**已整条撤掉**：
//    那个标记会赖着不走 ⇒ 退出全屏后页面永远停在静读态，见 findings 126。）
//   ⚠ **绝不能用几何去猜「浏览器壳收走了没」**。实测（findings 122/123）：无头
//     Chromium 在**普通窗口**下 `innerHeight === outerHeight === screen.height` 同样
//     成立 ⇒ 一切几何判据在无头验收里恒为真，会把整套断言变成假绿/假红。
//   ⚠ `display-mode` 在 Chrome **新无头**下恒为 false（即便 `fullscreenElement` 有值）
//     ⇒ 必须是"或"：两条都认。
//
// ★ 手势（写清楚，免得下次自己都忘了）：
//   · 进全屏 / 带标记启动 ⇒ 控制条立刻收起来，画册顶满整屏；
//   · **双击左键** ⇒ 控制条冒出来，浮在照片上；再双击照片仍是"单张全屏"、
//     双击封面/封底仍是"整叠翻页"（原功能一个都不夺）；
//   · 控制条闲着（6 秒没动静、鼠标也不压在上面）⇒ 自己收回去；
//   · **Esc** 在真全屏里是浏览器保留的（按下去直接退出全屏，脚本拦不住）⇒ 退出全屏后
//     控制条自然回到页面下方。想"只收 UI 而不退全屏"，用双击。
//
// 换行符提醒：这套全是 JS 现拼 + CSS 类，模板里一行不加 ⇒ 老书同步这两个文件即可。

const FS_READING_CLASS = "fs-reading";
const FS_BAR_CLASS = "fs-bar";
const FS_NET_CLASS = "fs-net";
const FS_BAR_IDLE_MS = 6000;

let fsBarTimer = 0;
let fsBarHover = false;
let fsNetOn = false;          // 操作条这会儿收着没（<html>.fs-net 与它同步）
let fsNetUserOff = false;     // ★ Phase 42：普通窗口里用户按右下角那颗开关收起来了
let fsWasReading = false;     // 上一轮算出来在不在全屏里（用来判"刚进/刚退"）
// ★★★ Phase 45：净屏"顶满屏幕"用的放大倍数 ★★★
//   佘先生 2026-10-01：「允许少量裁剪，优化撤掉尺寸上限的全屏显示」。
//   Phase 44 撤掉库那道尺寸天花板之后，书是按容器量出来的，但它**仍然按跨页比例 1.6
//   定格**（= 2 × --page-ratio）⇒ 屏幕正好 16:10 时逐像素顶满，别的比例会在短的那一边
//   剩一条背景（1920×1080 上左右各 96px，findings 131）。
//   这里给 .book-rig 加一个 scale 把那条边补掉，多出来的由 .stage 裁掉 —— 代价是每条边
//   裁掉一点照片。倍数怎么算见下面的 fsFillScale()。
//   ⚠ 这三个常量**必须声明在这里**：applyFsNet() 会在模块加载末尾就被调用一次，
//     声明在后面会踩暂时性死区（同一个坑 Phase 20 / 28 / 29 各踩过一次）。
const FS_FILL_MAX_SCALE = 1.25;   // 最多放大 1.25 倍 ⇒ 每条边最多裁掉可见跨页的 10%（公式 (s-1)/(2s)）。要调"允许裁多少"只改这里
let fsScale = 1;                  // 当前倍数（1 = 不放大，也就是本机 16:10 的常态）
let fsRelayDrag = false;          // 手上正有一次"坐标已还原过"的拖拽


// ★ Phase 42：浏览器外壳收走了没 —— 只认 `display-mode` 这条媒体特性。
//   实测（findings 123/124）：真机普通窗口 false、真机 `--app=` 全屏 true；
//   无头壳普通窗口也是 false、点 API 全屏变 true ⇒ 真机分得开、无头也不假绿。
//   ⚠ 几何量（inner/outer/screen）在无头里恒等，绝不能拿来当判据（findings 122）。
const fsDisplayQuery = window.matchMedia("(display-mode: fullscreen)");

function fsDisplayFullscreen() {
  return Boolean(fsDisplayQuery.matches);
}

/** 现在该不该"净屏阅读"（画册顶满整屏、操作条收起来） */
function fsReadingMode() {
  return Boolean(document.fullscreenElement) || fsDisplayFullscreen();
}

function fsBarVisible() {
  return document.documentElement.classList.contains(FS_BAR_CLASS);
}

function fsBarHide() {
  document.documentElement.classList.remove(FS_BAR_CLASS);
  window.clearTimeout(fsBarTimer);
  fsBarTimer = 0;
  applyFsNet();
}

function fsBarPoke() {
  if (!fsBarVisible()) return;
  window.clearTimeout(fsBarTimer);
  fsBarTimer = window.setTimeout(fsMaybeAutoHide, FS_BAR_IDLE_MS);
}

/** 闲够了就收回去 —— 但**正在用**的时候不许收 */
function fsMaybeAutoHide() {
  if (!fsReadingMode() || !fsBarVisible()) return;
  if (fsBarHover) return;                                     // 鼠标还压在控制条上
  const el = document.activeElement;                          // 正在输入框里打字
  if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) {
    return;
  }
  const auto = document.getElementById("page-auto");          // 自动翻页开着 ⇒ 留着「停止」
  if (auto && auto.getAttribute("aria-pressed") === "true") return;
  fsBarHide();
}

function fsBarShow() {
  if (!fsReadingMode()) return;
  document.documentElement.classList.add(FS_BAR_CLASS);
  fsBarPoke();
  applyFsNet();
}

/**
 * 把「该不该净屏 / 操作条收没收」落到 <html> 上；版面真变了再补派一次 resize。
 *
 *  · 全屏里：操作条默认收着；双击或按右下角那颗开关把它叫出来时是**浮层**
 *    （position:fixed，不占版面）⇒ 画面不会因此缩回去（他要的"UI 浮在图片上"）。
 *  · 普通窗口：只有用户按了开关才收（收起来 ⇒ 画面顶满；再按恢复"照片下方"的原样）。
 */
function applyFsNet() {
  const reading = fsReadingMode();
  const hidden = reading ? !fsBarVisible() : fsNetUserOff;
  let changed = false;
  if (document.documentElement.classList.contains(FS_READING_CLASS) !== reading) {
    document.documentElement.classList.toggle(FS_READING_CLASS, reading);
    changed = true;
  }
  if (fsNetOn !== hidden) {
    fsNetOn = hidden;
    document.documentElement.classList.toggle(FS_NET_CLASS, hidden);
    changed = true;
  }
  syncBarToggle();
  applyFsFill();
  // 书是按容器尺寸算页大小的（翻页库自己监听 window resize）⇒ 版面变了就派一次让它重排
  if (changed) window.dispatchEvent(new Event("resize"));
}
// ---------------------------------------------------------------------------
// ★★★ Phase 45：净屏铺满 —— 允许少量裁剪，把整本书等比放大到顶满屏幕 ★★★
//
// Phase 44 之后书已经是"容器量多少就摊多开"，但它**仍然按跨页比例 1.6 定格**
// （= 2 × --page-ratio）：屏幕正好 16:10 ⇒ 逐像素顶满；别的比例就在短的那一边剩一条
// 背景 —— 实测 1920×1080 上左右各剩 96px（findings 131）。
//
// 这里用**放大**把那条边补掉：.book-rig 整体 scale 到"短边也盖住"，多出来的由 .stage
// 裁掉（overflow:hidden）。代价是每条边裁掉一点照片，所以有上限：
//   · 本机 2560×1600（16:10）⇒ 需要 1.000 倍 ⇒ **一个像素都不裁**，老观感原样不动；
//   · 16:9 要 1.111 倍、4:3 要 1.200 倍 ⇒ 都低于上限，完全顶满；
//   · 更极端的比例（21:9 之类）到上限就停 —— 宁可在短边留一点，也不把照片裁狠了。
//
// ⚠ 只挂 .fs-net（真全屏 / 用户主动收起操作条）⇒ 普通窗口一个像素都不会变。
// ---------------------------------------------------------------------------

/** 净屏顶满屏幕需要把书放大几倍（1 = 不用放大） */
function fsFillScale() {
  if (!fsNetOn) return 1;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  if (!(vw > 0) || !(vh > 0)) return 1;
  const spread = 2 * (pageWidth / pageHeight);   // 跨页比例（本书 1.6）
  const ratio = vw / vh;
  return Math.min(Math.max(ratio / spread, spread / ratio), FS_FILL_MAX_SCALE);
}

/** 把倍数落到 --fs-scale 上；CSS 那边只管用，不自己算 */
function applyFsFill() {
  const next = fsFillScale();
  if (Math.abs(next - fsScale) < 0.0005) return;   // 没变就别写，省一次样式失效
  fsScale = next;
  document.documentElement.style.setProperty("--fs-scale", next.toFixed(4));
  fsRelayDrag = false;                             // 倍数换了，手上那次拖拽别再续着
}


/**
 * 进/退全屏都收敛到这一条。
 *
 * ★★ Phase 42 的关键一条：**退出全屏必须把界面还原** —— 把浮层收掉，把用户那次
 *    "收起"也一并清掉 ⇒ 操作条回到照片**下方**（他要的"退出恢复成原来的界面"）。
 *    Phase 41 漏了这一步：URI 上的 `#fullscreen` 标记一直在，退出后页面还赖在静读态
 *    （findings 126）。现在状态挂在会自己变回去的信号上，退出去就真的退出去。
 */
function syncFsReading() {
  const on = fsReadingMode();
  if (on !== fsWasReading) {
    fsWasReading = on;
    fsBarHide();                    // 刚进 / 刚退，先把浮层收起来
    // ★ Phase 42 修：只有“真的退出全屏”这一刻才清用户那次收起
    //——普通窗口里的 resize（包括 applyFsNet 自己补派的那次）不许清，否则开关等于没按。
    if (!on) fsNetUserOff = false;
  }
  applyFsNet();
}

// 任何一点动静都把"闲着"的计时重新开始（capture：库会 stopPropagation，findings 75）
for (const type of ["pointermove", "pointerdown", "wheel", "keydown", "scroll", "touchstart"]) {
  window.addEventListener(type, fsBarPoke, true);
}

const fsFooter = document.querySelector(".controls");
if (fsFooter) {
  fsFooter.addEventListener("pointerenter", () => { fsBarHover = true; fsBarPoke(); });
  fsFooter.addEventListener("pointerleave", () => { fsBarHover = false; fsBarPoke(); });
}

// ---------------------------------------------------------------------------
// ★★ Phase 42：右下角那颗「收起条 / 显示条」开关
//   他：「增加一个隐藏页数操作UI组块的功能，当然也可以关闭，就在右下角的位置放这个
//   功能的操作组块」。它和"净屏阅读"共用一套状态：
//     · 全屏里按它 ⇒ 把浮层叫出来 / 收回去（与双击等效）；
//     · 普通窗口里按它 ⇒ 操作条整条收起、画面顶满；再按恢复"照片下方"的原样。
//   ⚠ 这颗开关自己**永远不藏**（藏了就再也叫不回来了）；灯箱 z-index:300 会盖住它。
// ---------------------------------------------------------------------------
const barToggle = document.createElement("button");
barToggle.id = "bar-toggle";
barToggle.type = "button";
barToggle.className = "bar-toggle";
document.body.appendChild(barToggle);

function syncBarToggle() {
  const reading = fsReadingMode();
  const shown = reading ? fsBarVisible() : !fsNetUserOff;
  barToggle.textContent = shown ? "收起条" : "显示条";
  barToggle.setAttribute("aria-pressed", shown ? "true" : "false");
  barToggle.setAttribute("aria-label", shown ? "收起页面操作组块" : "显示页面操作组块");
  barToggle.title = shown ? "把页面操作组块收起来（画面更大）" : "把页面操作组块显示出来";
  // 操作条在版面里时别压住它：抬到它上面；收起来了就贴底
  const footer = document.querySelector(".controls");
  const footerH = footer && getComputedStyle(footer).display !== "none"
    ? footer.offsetHeight : 0;
  barToggle.style.bottom = (footerH > 0 ? footerH + 12 : 14) + "px";
}

barToggle.addEventListener("click", () => {
  if (fsReadingMode()) {
    if (fsBarVisible()) fsBarHide(); else fsBarShow();
  } else {
    fsNetUserOff = !fsNetUserOff;
  }
  applyFsNet();
});

document.addEventListener("fullscreenchange", syncFsReading);
// 浏览器自带全屏（F11）/ 命令行 `--start-fullscreen` 的进出，只有这条媒体特性会动
if (fsDisplayQuery.addEventListener) {
  fsDisplayQuery.addEventListener("change", syncFsReading);
} else if (fsDisplayQuery.addListener) {
  fsDisplayQuery.addListener(syncFsReading);   // 老内核兜底
}
window.addEventListener("resize", syncFsReading);
syncFsReading();                    // 命令行拉起的全屏窗口，一进来就是净屏的

// ---------------------------------------------------------------------------
// ★★★ Phase 45：放大之后，得把鼠标坐标"还原"回去 ★★★
//
// 翻页库换算鼠标位置靠的是 `.stf__block.getBoundingClientRect()`（vendor 里的
// getMousePos：x = clientX - rect.left）。祖先一放大，它量到的矩形跟着放大，
// 于是它以为的坐标 = 真实坐标 × s ⇒ 翻页判定的"中线"整条往左偏、拖拽跟手会跑快。
// 实测：1920×1080 上 s = 1.111，中线左偏 96px（屏幕宽度的 5%）。
//
// 做法：在**捕获阶段**截下来，按"矩形左/上边不动、把偏移量除回去"还原坐标，再原样
// 转发一个同类型事件给库；原事件 stopPropagation，免得库算两遍（mouseup 算两遍，
// 第二遍会拿错的那一份去翻页）。
//
// ⚠ 只截 mousedown / mousemove / mouseup —— 本脚本自己一个都不用这三个
//   （书上是 pointerdown、双击是 dblclick、按钮是 click），所以拦掉不伤自己。
//   vendor 还监听 touchstart/move/end，触屏那条路没做还原（本工具是桌面端）。
// ⚠ s === 1（本机 16:10 就是）时整个函数第一行就返回，等于不存在；
//   普通窗口更进不来（fsScale 恒为 1）。
// ---------------------------------------------------------------------------
const fsRelayTypes = ["mousedown", "mousemove", "mouseup"];
let fsRelaying = false;

function fsRelay(event) {
  if (fsRelaying || !(fsScale > 1.0005) || event.button !== 0) return;
  const block = document.querySelector(".stf__block");
  if (!block || !(event.target instanceof Element)) return;
  const rect = block.getBoundingClientRect();
  if (!(rect.width > 0)) return;
  const inside = event.clientX >= rect.left && event.clientX <= rect.right
    && event.clientY >= rect.top && event.clientY <= rect.bottom;
  if (event.type === "mousedown") {
    if (!inside) return;
    fsRelayDrag = true;
  } else if (event.type === "mousemove") {
    if (!inside && !fsRelayDrag) return;          // 拖拽出了画面也继续跟着还原
  } else {
    if (!fsRelayDrag) return;
    fsRelayDrag = false;
  }
  const target = event.target;
  const clientX = rect.left + (event.clientX - rect.left) / fsScale;
  const clientY = rect.top + (event.clientY - rect.top) / fsScale;
  event.stopPropagation();
  fsRelaying = true;
  try {
    target.dispatchEvent(new MouseEvent(event.type, {
      bubbles: true, cancelable: true, composed: true, view: window,
      clientX: clientX, clientY: clientY,
      button: event.button, buttons: event.buttons, detail: event.detail,
      screenX: event.screenX, screenY: event.screenY,
    }));
  } finally {
    fsRelaying = false;
  }
}
for (const type of fsRelayTypes) window.addEventListener(type, fsRelay, true);

Object.assign(window.__full, {
  clean: () => fsReadingMode(),        // 该不该净屏阅读
  displayFs: fsDisplayFullscreen,      // 浏览器外壳收走了没（F11 那条路的判据）
  net: () => fsNetOn,                  // 操作条这会儿收着没
  bar: () => fsBarVisible(),           // 浮层露着没
  showBar: fsBarShow,
  hideBar: fsBarHide,
  toggleBar: () => barToggle.click(),
  hasBarToggle: () => Boolean(document.getElementById("bar-toggle")),
  idleMs: FS_BAR_IDLE_MS,
  scale: () => fsScale,                  // 净屏放大倍数（探针用）
});
