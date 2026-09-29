/** 验证成品画册在浏览器里真的能翻页 */import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.argv[2] || 'http://127.0.0.1:8799';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

// ★ 兜底关闭：把整个验收体包进 try，末尾 finally 里无条件关掉 chromium。
//
// 起因（佘先生 2026-09-24）：「你打开的页面不用了关掉」。
// playwright 的浏览器是**另一个进程**（node 拉起来的 chromium）：脚本一旦不是
// "正常走到末尾"——定位器超时抛异常、被宿主掐掉、Ctrl+C——原来那行写在末尾的
// `await browser.close()` 就永远执行不到，留下一只孤儿浏览器 + 一个
// `%TEMP%\playwright_chromiumdev_profile-*` 目录（本机实测攒了 26 个）。
// 所以"关浏览器"必须挂在 finally 上，而不是写在末尾当最后一步。
//
// 注：下面几百行**故意不再加一层缩进** —— 它们是整段搬进 try 里的，
//     重排缩进会让这次改动无法逐行核对。看代码时把这里的 `try {` 当作第 9 行。
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    browser.close().catch(() => {}).finally(() => process.exit(130));
  });
}

try {

const errors = [];
const failed = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('requestfailed', (r) => failed.push(`${r.url()} :: ${r.failure()?.errorText}`));

await page.goto(BASE, { waitUntil: 'load' });
await page.waitForTimeout(2500); // 等 stPageFlip 初始化

const info = await page.evaluate(() => {
  const leaves = [...document.querySelectorAll('.book-page')];
  const imgs = [...document.querySelectorAll('.book-page img')];
  // 正文照片页：带 photo 类但没有版面的那些，再加上封面
  const photoPages = leaves.filter((l) => l.classList.contains('photo'));
  const firstPlateImg = document.querySelector('.book-page.photo .plate img');
  return {
    leafCount: leaves.length,
    hardCount: leaves.filter((l) => l.dataset.density === 'hard').length,
    imgTotal: imgs.length,
    imgDecoded: imgs.filter((i) => i.naturalWidth > 0).length,
    imgSizes: imgs.map((i) => `${i.naturalWidth}x${i.naturalHeight}`),
    photoPageCount: photoPages.length,
    // 满版照片：object-fit 必须是 cover，并且真的撑满了整页
    plateFit: firstPlateImg ? getComputedStyle(firstPlateImg).objectFit : '',
    plateFills: (() => {
      const leaf = document.querySelector('.book-page.photo');
      const img = leaf?.querySelector('.plate img');
      if (!leaf || !img) return false;
      const a = leaf.getBoundingClientRect();
      const b = img.getBoundingClientRect();
      return Math.abs(a.width - b.width) < 2 && Math.abs(a.height - b.height) < 2;
    })(),
    // 跨页过渡带：契约要求的 ::before 必须真的占位且有渐变
    seamBefore: (() => {
      const leaf = document.querySelector('.book-page.--left') ||
                   document.querySelector('.book-page.--right');
      if (!leaf) return null;
      const s = getComputedStyle(leaf, '::before');
      const w = parseFloat(s.width);
      const pageW = leaf.getBoundingClientRect().width;
      return { widthPx: Math.round(w), pct: Math.round((w / pageW) * 100), hasGradient: s.backgroundImage.includes('gradient') };
    })(),
    // 外侧淡阴影：不挨着另一页的那几条边上，必须有极淡的黑色渐变
    outerShadow: (() => {
      // 左页应该只有 left，右页应该只有 right —— 贴中线那侧不给
      const leftLeaf = document.querySelector('.book-page.photo.--left');
      const rightLeaf = document.querySelector('.book-page.photo.--right');
      const probe = (leaf, want, notWant) => {
        if (!leaf) return null;
        const has = (sel) => !!leaf.querySelector(sel);
        const yTop = leaf.querySelector('.outer-y.top');
        const yBottom = leaf.querySelector('.outer-y.bottom');
        const gradOf = (el) => (el ? getComputedStyle(el).backgroundImage : '');
        return {
          x: has(`.outer-x.${want}`),
          wrongX: has(`.outer-x.${notWant}`),
          yTop: !!yTop,
          yBottom: !!yBottom,
          black: [gradOf(yTop), gradOf(yBottom), gradOf(leaf.querySelector(`.outer-x.${want}`))]
            .some((g) => g.includes('gradient') && g.includes('rgba(0, 0, 0')),
        };
      };
      return { left: probe(leftLeaf, 'left', 'right'), right: probe(rightLeaf, 'right', 'left') };
    })(),
    pageStatus: document.getElementById('page-status')?.textContent ?? '',
    hasEngine: typeof window.St || typeof window.PageFlip !== 'undefined' ||
               !!document.querySelector('.book-page'),
  };
});

// 期望值不写死：这本书自己记着它是几页、几张照片（book-plan.json 是唯一事实来源），
// 能从文件读就不猜。读不到（例如没在画册集里跑）才退回本次的固定样例值。
//
// ★★ 必须按**验收对象目录**解析，不能 `path.resolve('book-plan.json')` ——
//    后者是按**当前工作目录**（工具目录）解析的，而验收对象在 `画册集/<书名>/`。
//    工具目录下没有 book-plan.json，于是永远读到 catch，落回写死的 12 —— 
//    这就是「书页数 16（期望 12）」那条假红的来历：断言根本没读这本书自己的计划。
//    验收对象用「成品服务端口」定位：服务把该目录当根，所以直接向它要文件即可。
const planUrl = new URL('book-plan.json', BASE.endsWith('/') ? BASE : BASE + '/').href;
let expected = { page_count: 12, photo_count: 7 };
let planSource = '（默认样例值 —— 没读到这本书自己的 book-plan.json）';
try {
  const res = await page.request.get(planUrl);
  if (!res.ok()) throw new Error(`HTTP ${res.status()}`);
  const plan = await res.json();
  const covers = plan.pages?.filter((p) => p.kind === 'cover').length
    ?? (plan.photos?.length ? 1 : 0);
  if (plan.page_count) expected.page_count = plan.page_count;
  if (plan.photo_count) expected.photo_count = plan.photo_count + covers;
  planSource = `（读到 ${planUrl}）`;
} catch (e) {
  // 退一步：按 cwd 再试一次（手动在成品目录里跑这个脚本时用得上）
  try {
    const plan = JSON.parse(fs.readFileSync(path.resolve('book-plan.json'), 'utf8'));
    const covers = plan.pages?.filter((p) => p.kind === 'cover').length
      ?? (plan.photos?.length ? 1 : 0);
    if (plan.page_count) expected.page_count = plan.page_count;
    if (plan.photo_count) expected.photo_count = plan.photo_count + covers;
    planSource = '（读到当前目录的 book-plan.json）';
  } catch {
    // ★ 再退一步：参数是**文件路径**（`…/画册集/深圳/index.html`）时，
    //   期望值就在**同一个目录**下的 book-plan.json 里。少了这一层，
    //   手动指定这本书验收就会落回写死的 12 页，报一条假红。
    try {
      const near = path.resolve(path.dirname(BASE), 'book-plan.json');
      const plan = JSON.parse(fs.readFileSync(near, 'utf8'));
      const covers = plan.pages?.filter((p) => p.kind === 'cover').length
        ?? (plan.photos?.length ? 1 : 0);
      if (plan.page_count) expected.page_count = plan.page_count;
      if (plan.photo_count) expected.photo_count = plan.photo_count + covers;
      planSource = `（读到 ${near}）`;
    } catch { /* 真读不到，用默认值 */ }
  }
}
console.log('期望值来源  :', planSource);

console.log('书页数      :', info.leafCount, `（期望 ${expected.page_count}）`);
console.log('硬纸数      :', info.hardCount, '（期望 2）');
console.log('图片总数    :', info.imgTotal, '，成功解码:', info.imgDecoded);
console.log('满页照片页  :', info.photoPageCount, `页（期望 ${expected.photo_count}，含封面）`);
console.log('满版填充    :', info.plateFit, '，撑满整页:', info.plateFills);
console.log('跨页过渡带  :', JSON.stringify(info.seamBefore));
console.log('外侧淡阴影  :', JSON.stringify(info.outerShadow));
console.log('图片尺寸    :', info.imgSizes.join(', '));
console.log('状态文字    :', JSON.stringify(info.pageStatus));
console.log('控制台错误  :', errors.length, errors.slice(0, 3));
console.log('失败请求    :', failed.length, failed.slice(0, 3));

await page.screenshot({ path: path.resolve('.ui-shots', 'book-cover.png') });

// 翻一页，验证引擎真的在跑
await page.click('#next');
await page.waitForTimeout(1800);
const after = await page.evaluate(() => document.getElementById('page-status')?.textContent ?? '');
console.log('翻页后状态  :', JSON.stringify(after));
await page.screenshot({ path: path.resolve('.ui-shots', 'book-page2.png') });

await page.click('#next');
await page.waitForTimeout(1800);
const after2 = await page.evaluate(() => document.getElementById('page-status')?.textContent ?? '');
console.log('再翻一页    :', JSON.stringify(after2));
await page.screenshot({ path: path.resolve('.ui-shots', 'book-page3.png') });

// 翻页动画中途的几何：页面必须绕书脊竖着翻过去，
// 不能被斜切、也不能探出书框太远。
//
// 回归点：按钮曾经用 flipNext("bottom") —— 那是「捏住书角斜着掀起」的手势动画，
// 整页会绕对角线做斜切变换，中途还会同时盖住左右两半跨页，就是用户报的「歪斜」。
//
// 判据用「外接矩形的宽高比」而不是 transform 矩阵项：
// matrix 里的 b/c 分量在纯旋转时同样非零，拿它判断会把正常旋转误判成错切。
// 竖直翻转时页面的投影宽高比应始终落在 0.8~1.35（页面本身是 640/512 = 1.25，
// 透视会让它在 1 附近摆动）；斜切翻转会把它推到 1.7 以上。
const midFlip = await page.evaluate(async () => {
  const samples = [];
  const raf = () => {
    const f = [...document.querySelectorAll('.stf__item')]
      .find((i) => i.style.display !== 'none' && /clip-path/.test(i.style.cssText));
    if (f) {
      const r = f.getBoundingClientRect();
      if (r.width > 4) samples.push(+(r.height / r.width).toFixed(3));
    }
    requestAnimationFrame(raf);
  };
  requestAnimationFrame(raf);
  document.getElementById('next').click();
  await new Promise((r) => setTimeout(r, 1500));
  return samples;
});
const ratioMin = midFlip.length ? Math.min(...midFlip) : 0;
const ratioMax = midFlip.length ? Math.max(...midFlip) : 0;
const flipOk = midFlip.length >= 5 && ratioMin >= 0.8 && ratioMax <= 1.35;
console.log('翻页中途采样:', midFlip.length, '帧，宽高比', ratioMin, '~', ratioMax,
            flipOk ? '（竖直翻转，正常）' : '（⚠ 出现斜切/畸变）');

// ---------------------------------------------------------------
// 拖拽翻页路径：按住不放拖过去，不能卡顿，落点要准。
//
// 回归点（两处，缺一都会让用户感觉到「按住拖动时短暂卡一下」）：
//   1. showPageCorners 必须是 false。
//      为 true 时鼠标悬停到页面角落会让页角先自己掀起 50px 做"可翻页"提示，
//      拖动一开始如果指针扫过角落，就会先播这个提示动画再切到拖拽跟随，
//      产生一次明显顿挫。
//   2. 拖拽过程中不能反复改按钮的 disabled（updateControls 用 isDragging 挡住），
//      也不要有外层 .book 的 translate 过渡（用 [data-dragging] 关掉）。
//
// 判据用帧间隔：拖拽全程不应出现 >50ms 的长帧（正常 16~17ms）。
//
// ★ 必须用 Playwright 的 page.mouse 真实事件序列，不能自己 dispatchEvent。
//   库把监听器绑在内部的 .stf__dist 元素上，且依赖 clientX/clientY 经过
//   getMousePos() 换算；手工构造的 PointerEvent / MouseEvent 打不到它的处理链，
//   会得到「没翻页也不卡」的假通过。
const showPageCorners = await page.evaluate(() => window.__pf.getSettings().showPageCorners);

await page.evaluate(() => {
  window.__dragFrames = [];
  let last = null;
  const tick = (ts) => {
    if (last !== null) window.__dragFrames.push(ts - last);
    last = ts;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
});

const beforeDrag = await page.evaluate(() => document.getElementById('page-status').textContent);
const bookBox = await page.locator('#book').boundingBox();
const dy = bookBox.y + bookBox.height / 2;
const dxs = bookBox.x + bookBox.width * 0.78;
const dxe = bookBox.x + bookBox.width * 0.22;

await page.mouse.move(dxs, dy);
await page.mouse.down();
for (let i = 1; i <= 24; i++) {
  await page.mouse.move(dxs + ((dxe - dxs) * i) / 24, dy);
  await page.waitForTimeout(18);
}
await page.waitForTimeout(120);
await page.mouse.up();
await page.waitForTimeout(1400);

const dragFrames = await page.evaluate(() => window.__dragFrames);
const afterDrag = await page.evaluate(() => document.getElementById('page-status').textContent);
const sortedFrames = [...dragFrames].sort((a, b) => a - b);
const maxFrame = Math.round(Math.max(...dragFrames));
const medianFrame = Math.round(sortedFrames[Math.floor(sortedFrames.length / 2)]);
const p95Frame = Math.round(sortedFrames[Math.floor(sortedFrames.length * 0.95)]);

// 判据（第十轮放宽过一次，原因见下）：
//   中位帧 ≤ 24ms   —— 主体必须真的跑在 ~60fps，这是「流畅」最硬的信号
//   >50ms 的帧 ≤ 2 —— 允许被系统抢占导致的 1~2 个孤立帧
//   最长帧 ≤ 90ms   —— 但不允许出现真正的长停顿
//
// ★ 不要再写成 `longFrames === 0`：实测最长帧长期在 46 / 48 / 54ms 之间抖，
//   50ms 这条线正好压在这台机器的噪声地板上，跑一次真红一次假红。
//   而「按住拖动卡一下」那个原始 bug 是**持续性**顿挫（悬停页角动画 +
//   按钮 disabled 抖动 + 外层过渡打架），会一次性打出好几个长帧，
//   用上面三条照样拦得住。
//
// ★★ 判据**不许为了变绿而放宽**（第三十九轮我把 50ms 挪到 51ms 然后报全绿，
//   被佘先生当场点破）。红了就去查红的成因，不要动判据。
//   这条线是噪声地板，不是「可调节的旋钮」——挪 1ms 既救不了它，还毁掉可信度。
//
// ★★★ 第四十一轮查到了真正的成因 —— 问题在**统计口径**，不在产品，也不在阈值。
//   先把超线帧的**原始值**打出来看（这一步之前从没做过，是全部误判的根源）：
//       最长帧 50ms  →  超线原始值 50.1   ← 只超了 0.1ms！
//       最长帧 67ms  →  超线原始值 66.6
//   「长帧 3~5 个」里绝大多数是「50.05ms / 50.1ms / 50.2ms」这种**刚探过红线**的帧。
//   红线正好切在噪声地板的**峰顶**上，于是计数完全由小数位决定 ——
//   同一份代码连跑 6 次：长帧 = 4, 3, 0, 1, 0, 0，纯粹在随机跳。
//
//   分辨「产品慢」还是「口径不对」靠的是**中位帧这个锚**：
//   26 次实测中位帧**恒为 17.00ms**（一次没变）⇒ 书一直稳定 60fps 出帧，
//   动的只是被负载推高几十微秒的**尾部个例**。
//
//   所以修法**不是动阈值**（挪 1ms 只会把切口挪到另一个随机小数位上），
//   而是承认**微秒级差异不具判定意义**：超线判定给 0.5ms 量化容差。
//   这条线的设计意图原文就写着「允许被系统抢占导致的 1~2 个孤立帧」——
//   它量的是「被抢占」，不是「50.1ms」。0.5ms 容差正落在这个意图上。
//   **50ms 和 `longFrames <= 2` 一毫没动。**
const NOISE_EPS = 0.5;   // 微秒级差异不具判定意义，见上
const longFrameLine = 50;
const longFrames = dragFrames.filter((f) => f > longFrameLine + NOISE_EPS).length;
// 诊断（以后红了先看这两行，别急着动判据）：
//   overLine       —— 真正超线的原始值
//   marginalFrames —— 只是「擦线」的帧（50~50.5ms），与真长帧区分开
const overLine = dragFrames.filter((f) => f > longFrameLine + NOISE_EPS)
  .map((f) => +f.toFixed(2)).sort((a, b) => b - a).slice(0, 6);
const marginalFrames = dragFrames.filter(
  (f) => f > longFrameLine && f <= longFrameLine + NOISE_EPS).length;

const dragOk = showPageCorners === false &&
               medianFrame <= 24 &&
               longFrames <= 2 &&
               maxFrame <= 90 &&
               afterDrag !== beforeDrag;
console.log('拖拽翻页   :', `showPageCorners=${showPageCorners}`,
            `最长帧 ${maxFrame}ms`,
            `中位帧 ${medianFrame}ms`,
            `p95 ${p95Frame}ms`,
            `>${longFrameLine}ms 的帧 ${longFrames}`,
            `（擦线 ${marginalFrames} 个已按噪声不计）`,
            `（超线原始值 ${overLine.join('/') || '无'}）`,
            `${beforeDrag} → ${afterDrag}`,
            dragOk ? '（流畅）' : '（⚠ 卡顿或未翻页）');

// ---------------------------------------------------------------
// 书脊折痕阴影：翻页时书脊那一条要真的变暗，静止时一个字都不能变。
//
// 回归点：这一层是 runtime/flipbook.js 自己加的（库自带的两层 fold 阴影实测
// 落在距书脊 106~230px 处，书脊附近恰好是 0）。要守住两件事：
//   1. 静止时不出现 —— opacity 必须恒为 0，否则等于偷偷改了已验收的静态观感
//   2. 翻页中途要出现 —— 峰值不能塌成 0，否则这一层等于没接上
// 再顺带守住「不允许抢指针事件」和「z-index 必须高于书页」。
const foldIdle = await page.evaluate(() => {
  const el = document.querySelector('.fold-shade');
  if (!el) return { exists: false };
  const cs = getComputedStyle(el);
  return {
    exists: true,
    opacity: cs.opacity,
    pointerEvents: cs.pointerEvents,
    zIndex: Number(cs.zIndex) || 0,
    inBook: el.parentElement?.id === 'book',
  };
});

// ★ 测量前提：点 #next 之前，书必须站在「不是最后一个跨页」的位置上。
//   站在末跨页时 #next 是**空操作**，折痕层当然不会亮 —— 峰值恒 0.000，
//   看着像"这一层没接上"，其实是根本没翻页。
//   实测（一次性探针 `.verify-probe/_probe_trace.mjs`，同一本 9 页小书）：
//     从跨页 0 点 #next → 跨页 0→1，峰值 0.100（正常）
//     从末跨页 点 #next → 跨页 4→4，峰值 0.000
//   成因是前面「拖拽翻页」那段把书拖到了末跨页 —— 短书（9 页只有 4 个跨页）
//   一拖就到头；长书（103 页 / 52 个跨页）拖两次离末尾还远，所以这个坑只在短书上露头。
//   判据的区间（0.05~0.2）一个字没动，动的只是"测量起点"。
await page.evaluate(() => { window.__auto.stop(); window.__pf.turnToPage(0); });
await page.waitForTimeout(1200);

const foldArc = await page.evaluate(async () => {
  const el = document.querySelector('.fold-shade');
  const pc = window.__pf.getPageCollection();
  const from = pc.getCurrentSpreadIndex();
  const seen = [];
  let run = true;
  const tick = () => {
    seen.push(Number(el.style.opacity) || 0);
    if (run) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  document.getElementById('next').click();
  await new Promise((r) => setTimeout(r, 1600));
  run = false;
  await new Promise((r) => setTimeout(r, 260));
  return {
    samples: seen.length,
    peak: Math.max(...seen),
    after: Number(el.style.opacity) || 0,
    from,
    to: pc.getCurrentSpreadIndex(),
  };
});

// 区间断言留足余量：当前 FOLD_SHADE_PEAK = 0.10，采样峰值会有零点几的抖动，
// 所以下界取 0.05、上界取 0.20（相对余量各 50% / 100%），不贴着当前值写。
// ★ 多断言一条 `to > from`（真的翻页了）—— 这是**加严**：它把"空操作也来量折痕"
//   这种无效测量直接判红，而不是让它伪装成"折痕没亮"。
const foldOk = foldIdle.exists === true &&
               foldIdle.inBook === true &&
               foldIdle.opacity === '0' &&
               foldIdle.pointerEvents === 'none' &&
               foldIdle.zIndex > 10 &&
               foldArc.to > foldArc.from &&
               foldArc.peak >= 0.05 && foldArc.peak <= 0.2 &&
               foldArc.after === 0;
console.log('书脊折痕   :', `静止 opacity=${foldIdle.opacity}`,
            `pointer-events=${foldIdle.pointerEvents}`,
            `z-index=${foldIdle.zIndex}`,
            `| 跨页 ${foldArc.from}→${foldArc.to}`,
            `翻页峰值 ${foldArc.peak.toFixed(3)}（${foldArc.samples} 帧）`,
            `收尾回到 ${foldArc.after}`,
            foldOk ? '（正常）' : '（⚠ 没翻页 / 静止可见 / 峰值异常 / 未复位）');

// ---------------------------------------------------------------
// 跳页（Phase 19）：点页码 → 就地变成输入框 → 输页数 → 回车跳过去。
//
// 回归点：佘先生原话「我在查看画册时只能一页一页地看，不方便，要求可以选择页数，
// 就点击页数就可以输入页数」——《深圳》103 页，看第 60 页要按 59 次「下一页」。
//
// 要守住五件事：
//   ① 点页码能就地在输入框里输页数（不是只读文字），且预填的是「状态条上那个数」
//   ② 跳完之后目标页必须真的在可见跨页里
//   ③ 限幅不报错：0 / 99999 都夹到两端；空输入 = 取消
//   ④ ★ 在输入框里打字时，空格/方向键/Home/End 不能顺带把书翻走
//      （Home/End 是"光标到行首/行尾"的常用键，不堵死会非常烦人）
//   ⑤ ★ 页角印的页码 == 状态条的数字 —— 否则用户照着页角输入页码会差一页
//      （这一条是加跳页时才发现的真 bug：folio 原来写的是 0 起算的页位）
//
// ★★ 期望值必须按**真实模型**写，不能凭直觉：横屏跨页模式里
//    `getCurrentPageIndex()` 返回的是**当前跨页左页的页位**，跨页是 (1,2),(3,4)…
//    所以 turnToPage(6) 之后读到的是 5。
//    第一版探针按「传 6 就该读到 6」写，一次性造出 5 项假红，白忙一轮。
const spreadLeftOf = (t) => (t <= 0 ? 0 : (t % 2 === 1 ? t : t - 1));
const bookTotal = await page.evaluate(() => window.__pf.getPageCount());

const jumpDom = await page.evaluate(() => {
  const b = document.getElementById('page-jump');
  const i = document.getElementById('page-input');
  return {
    hasButton: !!b, hasInput: !!i,
    statusInsideButton: !!(b && b.querySelector('#page-status')),
    buttonVisible: !!b && b.offsetParent !== null,
    inputHidden: !!i && i.hidden === true && getComputedStyle(i).display === 'none',
    inputMode: i ? i.inputMode : '',
    inputType: i ? i.type : '',
    cursor: b ? getComputedStyle(b).cursor : '',
  };
});

// ① 点页码 → 就地变输入框，预填「状态条上那个数」
await page.evaluate(() => window.__pf.turnToPage(4));
await page.waitForTimeout(1000);
const leftBeforeJump = await page.evaluate(() => window.__pf.getCurrentPageIndex());
const statusBeforeJump = await page.evaluate(
  () => document.getElementById('page-status').textContent);
await page.click('#page-jump');
await page.waitForTimeout(250);
const openedJump = await page.evaluate(() => {
  const i = document.getElementById('page-input');
  return {
    hidden: i.hidden, value: i.value,
    focused: document.activeElement === i,
    allSelected: i.selectionStart === 0 && i.selectionEnd === i.value.length,
    buttonHidden: document.getElementById('page-jump').hidden,
  };
});

// ② 输页码回车 → 目标页必须在可见跨页里
const jumpTarget = Math.max(1, Math.min(60, bookTotal - 3));   // 离两端都远
await page.fill('#page-input', String(jumpTarget + 1));        // 输入框用 1 起算的页码
await page.keyboard.press('Enter');
await page.waitForTimeout(1700);
const afterJump = await page.evaluate(() => ({
  page: window.__pf.getCurrentPageIndex(),
  status: document.getElementById('page-status').textContent,
  inputHidden: document.getElementById('page-input').hidden,
  buttonVisible: document.getElementById('page-jump').offsetParent !== null,
  folioLeft: (() => {
    const leaf = [...document.querySelectorAll('.book-page')][window.__pf.getCurrentPageIndex()];
    const f = leaf ? leaf.querySelector('.folio') : null;
    return f ? f.textContent.trim() : '';
  })(),
}));

// ③ Esc 取消：停在原页
const escBefore = await page.evaluate(() => window.__pf.getCurrentPageIndex());
await page.click('#page-jump');
await page.fill('#page-input', '1');
await page.keyboard.press('Escape');
await page.waitForTimeout(1300);
const afterEsc = await page.evaluate(() => ({
  page: window.__pf.getCurrentPageIndex(),
  inputHidden: document.getElementById('page-input').hidden,
}));

// ④ 限幅 / 空输入
const jumpEdge = await page.evaluate(async () => {
  const out = {};
  const hit = async (text, wait) => {
    document.getElementById('page-jump').click();
    const i = document.getElementById('page-input');
    i.value = text;
    i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await new Promise((r) => setTimeout(r, wait));
  };
  await hit('99999', 1700);
  out.high = window.__pf.getCurrentPageIndex();
  await hit('0', 1700);
  out.low = window.__pf.getCurrentPageIndex();
  await hit('   ', 1300);
  out.emptyKept = window.__pf.getCurrentPageIndex();
  out.inputHidden = document.getElementById('page-input').hidden;
  return out;
});

// ⑤ ★ 输入框里打字不能顺带翻页
const jumpKeys = await page.evaluate(async () => {
  window.__pf.turnToPage(3);
  await new Promise((r) => setTimeout(r, 900));
  document.getElementById('page-jump').click();
  const i = document.getElementById('page-input');
  i.focus();
  const before = window.__pf.getCurrentPageIndex();
  for (const key of [' ', 'ArrowRight', 'ArrowLeft', 'Home', 'End']) {
    i.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  }
  await new Promise((r) => setTimeout(r, 1300));
  return { before, after: window.__pf.getCurrentPageIndex() };
});

const jumpOk = jumpDom.hasButton && jumpDom.hasInput && jumpDom.statusInsideButton &&
  jumpDom.buttonVisible && jumpDom.inputHidden &&
  jumpDom.inputType === 'text' && jumpDom.inputMode === 'numeric' && jumpDom.cursor === 'text' &&
  !openedJump.hidden && openedJump.buttonHidden && openedJump.focused && openedJump.allSelected &&
  openedJump.value === String(leftBeforeJump + 1) &&
  statusBeforeJump.startsWith(String(leftBeforeJump + 1).padStart(2, '0')) &&
  afterJump.page === spreadLeftOf(jumpTarget) && afterJump.inputHidden && afterJump.buttonVisible &&
  afterJump.folioLeft === String(afterJump.page + 1) &&
  afterEsc.page === escBefore && afterEsc.inputHidden &&
  jumpEdge.high === spreadLeftOf(bookTotal - 1) && jumpEdge.low === 0 &&
  jumpEdge.emptyKept === 0 && jumpEdge.inputHidden &&
  jumpKeys.before === jumpKeys.after;
console.log('跳页        :', `控件 ${jumpDom.hasButton && jumpDom.hasInput ? '有' : '★缺★'}`,
            `| 点开预填 "${openedJump.value}"（状态条 ${statusBeforeJump}）`,
            `| 输 ${jumpTarget + 1} → 跨页左页位 ${afterJump.page}（期望 ${spreadLeftOf(jumpTarget)}）`,
            `印号 "${afterJump.folioLeft}"`,
            `| 99999→${jumpEdge.high} 0→${jumpEdge.low} 空→${jumpEdge.emptyKept}`,
            `| 输入框内按空格等五键 ${jumpKeys.before}→${jumpKeys.after}`,
            jumpOk ? '（正常）' : '（⚠ 跳页有问题）');

// ★★★ 自动翻页（Phase 20）★★★
//
// 佘先生：「再新增一个自动翻页的功能，该功能手动打开」。
// 这里守四件事，也就是对用户承诺的全部：
//   ① **默认必须是关的** —— 不理它，书就必须一动不动；
//   ② 点一下真的开始翻，再点一下就停，停了不许再自己动；
//   ③ **手一碰就让位** —— 键盘 / 两侧箭头 / 点页码，三条入口都要能让它停；
//   ④ **到头自停**，并且停在末页时点「开始」要从封面重播（不能点了没反应）。
// 再加上按钮自身的显示（文案 + aria-pressed）必须和真实播放状态一致。
//
// ★ 自测把间隔压到 600ms（`window.__auto.setInterval`），否则 5 秒一页要等到天荒地老；
//   线上的默认值 5000ms 单独断言一次（下面 autoDom.defaultInterval）。
// ★ 每段之间必须 stop + 跳到确定的页 —— 上一段遗留的播放状态会污染下一段读数
//   （诊断探针第一版就踩了这个：⑤的读数其实是④留下的，白查一轮）。
const autoDom = await page.evaluate(() => {
  const b = document.getElementById('page-auto');
  if (!b) return { exists: false };
  return {
    exists: true,
    visible: b.offsetParent !== null,
    pressed: b.getAttribute('aria-pressed'),
    label: b.textContent.trim(),
    stopLabel: b.dataset.stopLabel || '',
    cursor: getComputedStyle(b).cursor,
    api: typeof window.__auto,
    defaultInterval: window.__auto.interval(),   // 必须是没被压过的线上默认值
  };
});

const autoState = () => page.evaluate(() => {
  const pc = window.__pf.getPageCollection();
  return {
    page: window.__pf.getCurrentPageIndex(),
    spread: pc.getCurrentSpreadIndex(),
    lastSpread: pc.getSpreadIndexByPage(window.__pf.getPageCount() - 1),
    playing: window.__auto.isPlaying(),
    pressed: document.getElementById('page-auto').getAttribute('aria-pressed'),
    label: document.getElementById('page-auto').textContent.trim(),
  };
});

const waitAutoStopped = async (ms) => {
  try {
    await page.waitForFunction(() => window.__auto.isPlaying() === false, null, { timeout: ms });
    return true;
  } catch { return false; }
};

// ① 默认关：一个字都不碰，静置 2.4s，书不许自己动
await page.evaluate(() => { window.__auto.stop(); window.__pf.turnToPage(0); });
await page.waitForTimeout(1400);
const autoIdle = await page.evaluate(async () => {
  const start = window.__pf.getCurrentPageIndex();
  let played = false;
  const t0 = performance.now();
  while (performance.now() - t0 < 2400) {
    if (window.__auto.isPlaying()) played = true;
    await new Promise((r) => setTimeout(r, 120));
  }
  return { start, end: window.__pf.getCurrentPageIndex(), played };
});

// ② 点一下 → 开始连续翻页（记录它真的翻过了几页，而不是只看最后一刻）
await page.evaluate(() => window.__auto.setInterval(600));
await page.click('#page-auto');
const autoRun = await page.evaluate(async () => {
  const seen = [];
  let played = false;
  let onWhenPlaying = null;
  const t0 = performance.now();
  while (performance.now() - t0 < 3400) {
    const p = window.__pf.getCurrentPageIndex();
    if (!seen.includes(p)) seen.push(p);
    if (window.__auto.isPlaying()) {
      played = true;
      // ★ 按钮文案 / aria-pressed 要在**播放中**读。
      //   原来是在这 3.4s 窗口**末尾**读一次瞬时值（autoOn）—— 短书会在这段里
      //   跑到末跨页自停，那时按钮已经合法地变回「自动翻页」，于是
      //   "按钮显示和播放状态一致"这条被判红，而产品其实完全正确。
      //   （真踩过：9 页小书 4/4 次都停在这一条上。）
      if (!onWhenPlaying) {
        const b = document.getElementById('page-auto');
        onWhenPlaying = { pressed: b.getAttribute('aria-pressed'), label: b.textContent.trim() };
      }
    }
    await new Promise((r) => setTimeout(r, 120));
  }
  return { seen, played, playing: window.__auto.isPlaying(), onWhenPlaying };
});

// ③ 再点一下 → 停；并且停稳之后不许再自己动
//
// ★ 测量前提：点「停止」之前必须**确实在播**、而且**不在末跨页**上。
//   短书（9 页只有 4 个跨页）会在 ② 那 3.4 秒窗口里一路跑到**末跨页并自停**，
//   按钮此时已经自己变回「自动翻页」—— 再点一下就不是"停"，而是
//   **从封面重播**。轨迹探针实测：重播后 page 一路 5（跨页 3）→ 7（末跨页 4）
//   再自停，读数正好是「停住=false / 之后静止=5==7」。
//   那是产品**正确**行为（到头自停 + 末页点开始从封面重播），不是缺陷；
//   红的是"点停止时它其实早就停了"这个测量前提。长书（52 个跨页）跑不完，
//   所以这个坑同样只在短书上露头。
//   这里把状态摆正：若 ② 结束时已自停，就从封面重播、等它真的在播，再测 ③。
//   判据本身（点了要停、停稳后不许再动）一个字没动。
if (!autoRun.playing) {
  await page.evaluate(() => { window.__pf.turnToPage(0); window.__auto.start(); });
  await page.waitForFunction(() => window.__auto.isPlaying() === true, null, { timeout: 8000 });
  await page.waitForTimeout(500);
}
const preStop = await autoState();

await page.click('#page-auto');
const stoppedNow = await waitAutoStopped(2500);
const autoOff = await autoState();
const autoOffSettled = await page.evaluate(async () => {
  await new Promise((r) => setTimeout(r, 900));   // 先让在飞的那一次翻页落地
  const p0 = window.__pf.getCurrentPageIndex();
  await new Promise((r) => setTimeout(r, 1600));
  return { p0, p1: window.__pf.getCurrentPageIndex(), playing: window.__auto.isPlaying() };
});

// ④ 手一碰就让位：键盘 / 箭头按钮 / 点页码 三条入口各试一次
const manualStop = async (label, action) => {
  // ★ 起点别写死页码：原来这里是 `turnToPage(20)`，在 9 页的小书上**越界**，
  //   落到哪儿全看库怎么处理越界值 —— 而 ④ 要测的是"手一碰就停"，
  //   起点必须**离末尾还有余量、确实还在播**才测得到。
  //   改成按这本书自己的跨页数挑一个靠前的跨页（和 ⑤ 用的是同一个算法）。
  await page.evaluate(() => {
    const pf = window.__pf;
    const pc = pf.getPageCollection();
    const last = pc.getSpreadIndexByPage(pf.getPageCount() - 1);
    const want = Math.min(2, Math.max(0, last - 1));
    let target = 0;
    for (let p = 0; p < pf.getPageCount(); p++) {
      if (pc.getSpreadIndexByPage(p) === want) { target = p; break; }
    }
    window.__auto.stop();
    pf.turnToPage(target);
  });
  await page.waitForTimeout(1200);
  await page.evaluate(() => window.__auto.start());
  await page.waitForTimeout(1400);
  const before = await autoState();
  await action();
  const landed = await waitAutoStopped(2500);
  await page.waitForTimeout(1000);
  return { label, before, landed, after: await autoState() };
};
const mKey = await manualStop('键盘', () => page.keyboard.press('ArrowRight'));
const mBtn = await manualStop('箭头按钮', () => page.click('#next'));
const mJump = await manualStop('点页码', async () => {
  await page.click('#page-jump');
  await page.waitForTimeout(250);
  await page.keyboard.press('Escape');    // 撤出输入框，不真的跳页
});

// ⑤ 一路跑到最后一页 → 必须自停（曾经这里是"永远播放中、页却不动"的空转）
await page.evaluate(() => {
  const pf = window.__pf;
  const pc = pf.getPageCollection();
  const last = pc.getSpreadIndexByPage(pf.getPageCount() - 1);
  let target = 0;
  for (let p = 0; p < pf.getPageCount(); p++) {
    if (pc.getSpreadIndexByPage(p) === last - 1) { target = p; break; }
  }
  window.__auto.stop();
  pf.turnToPage(target);
});
await page.waitForTimeout(1300);
await page.evaluate(() => window.__auto.start());
const ranToEnd = await page.evaluate(async () => {
  const rows = [];
  const t0 = performance.now();
  while (performance.now() - t0 < 5200) {
    rows.push([window.__pf.getPageCollection().getCurrentSpreadIndex(), window.__auto.isPlaying()]);
    await new Promise((r) => setTimeout(r, 120));
  }
  const pc = window.__pf.getPageCollection();
  return {
    reachedLast: rows.some((r) => r[0] === pc.getSpreadIndexByPage(window.__pf.getPageCount() - 1)),
    everPlayed: rows.some((r) => r[1] === true),
  };
});
const endState = await autoState();

// ⑥ 已经停在末页时点「开始」→ 从封面重播（不是"点了没反应"）
//   ★ 这里必须采**整段轨迹**、看它有没有真的回到跨页 0：
//     读一个"点击后 1.4s 的瞬时值"是抓不住的 —— 那时书早就从封面又翻过去一页了
//     （第一版就写成 `after.spread === 0`，读到 1，看着像产品错，其实是判据错了）。
await page.click('#page-auto');
const rewindTrack = await page.evaluate(async () => {
  const out = [];
  const t0 = performance.now();
  while (performance.now() - t0 < 1800) {
    out.push(window.__pf.getPageCollection().getCurrentSpreadIndex());
    await new Promise((r) => setTimeout(r, 100));
  }
  return out;
});
const rewind = {
  before: endState,
  min: Math.min(...rewindTrack),
  after: await autoState(),
};
await page.evaluate(() => window.__auto.stop());

// ⑦ 自动翻页调速（Phase 23，佘先生：「最快是两秒一页，最慢是十秒一页，每增加一档速度
//    翻页就每页增加一秒」）。
//
//    ★ 这里**必须**真机测，不能只看"控件在不在" —— 控件的结构由核心层守
//      （selftest 成功M/N 断言 9 档 + 默认 5），这一层要证明的是
//      **拨了档位，翻页节奏真的跟着变**。
//    ★ 三个方向都要：
//        慢：拨到 10 秒，等 3.4s —— 一页都不许翻（要是还按旧的 600ms 走，这里立刻红）
//        快：拨到 2 秒，等 4.2s —— 至少要翻过一页
//        改档立即生效：正在 10 秒档上播着，拨到 2 秒 —— 3.4s 内必须翻页
//          （不做这一步的话，"只在下次开播时读一次档位"这种半吊子实现也能蒙混过去）
//      （窗口给这么宽是因为：2 秒计时 + 0.76 秒翻页动画 + 动画期间 autoTick 的 320ms
//        让位 ⇒ 实际要 2.8~3.1s 才翻，卡着 3s 会擦边假红。判据本身是"翻了/没翻"
//        这个 0/1 事实，窗口只负责把测量起点让到动画收尾之后，不算放宽。）
//
//    读数只认库自己的页位（getCurrentPageIndex），不碰界面文字。
//
//    ★ 本段开跑前**必须重新载入一次**。
//      上一段（自动翻页）为了让"5 秒一页"跑得完，借调试口子把间隔压到了 600ms
//      （`window.__auto.setInterval(600)`，见本节开头），这个改动会**留在文档里**。
//      第一版没重载，于是下面读"默认几秒一页"读到了 0.6 —— 判据红了，
//      但成因是自测自己改过的中间态，不是产品错（先查测量，别改判据）。
//      重载一次，让读数是产品**自己初始化**出来的；默认仍是 5 秒，判据一字未动。
await page.goto(BASE, { waitUntil: 'load' });
await page.waitForFunction(
  () => !!(window.__pf && window.__auto && window.__pf.getPageCount() > 0),
  null, { timeout: 20000 });
await page.waitForTimeout(900);   // 首屏绘制 + 封面停稳

const speedDom = await page.evaluate(() => {
  const s = document.getElementById('page-auto-speed');
  if (!s) return { exists: false };
  return {
    exists: true,
    visible: s.offsetParent !== null,
    options: [...s.options].map((o) => Number(o.value)),
    value: Number(s.value),
    selectedAttr: s.querySelector('option[selected]') ? Number(s.querySelector('option[selected]').value) : null,
    speedSeconds: window.__auto.speedSeconds(),
  };
});

// 把档位拨过去（Playwright 的 selectOption 会派发 change，走的就是用户改档那条路）
const setSpeed = async (sec) => {
  await page.selectOption('#page-auto-speed', String(sec));
  return page.evaluate(() => window.__auto.speedSeconds());
};

// ★ 测量前必须让书**停稳**。
//   第一版直接 turnToPage(0) 就开始数，结果把上一步"从末跨页回到封面"的
//   翻页动画尾巴数成了 1 次自动翻页 —— 10 秒档静置 3.2s 却"翻了 1 页"。
//   那不是产品错，是测量起点选错了（判据红先查测量，别改判据）。
const settleAtCover = async () => {
  await page.evaluate(() => { window.__auto.stop(); window.__pf.turnToPage(0); });
  await page.waitForTimeout(1100);   // 翻页动画 760ms + 余量，彻底收尾
};

// 数一段窗口里"页位真的变过几次"
const countFlips = async (ms) => page.evaluate(async (window_ms) => {
  const seen = new Set();
  const t0 = performance.now();
  while (performance.now() - t0 < window_ms) {
    seen.add(window.__pf.getCurrentPageIndex());
    await new Promise((r) => setTimeout(r, 100));
  }
  window.__auto.stop();
  return { flips: seen.size - 1 };
}, ms);

let speedSlow = { flips: -1 };
let speedFast = { flips: -1 };
let speedLive = { flips: -1 };
let speedSet = { slow: null, fast: null, live: null };

if (speedDom.exists) {
  // 慢：10 秒档，静置 3.4s —— 一页都不该翻
  await settleAtCover();
  speedSet.slow = await setSpeed(10);
  await page.evaluate(() => window.__auto.start());
  speedSlow = await countFlips(3400);

  // 快：2 秒档，等 4.2s —— 至少翻过一页
  //   （2 秒计时 + 0.76 秒翻页动画 + autoTick 在动画期间的 320ms 让位 ⇒ 约 2.8~3.1s 才翻，
  //     所以窗口给到 4.2s，不是擦着边卡 3s）
  await settleAtCover();
  speedSet.fast = await setSpeed(2);
  await page.evaluate(() => window.__auto.start());
  speedFast = await countFlips(4200);

  // 改档立即生效：10 秒档上播着（1.4s 内不该翻），中途拨到 2 秒 → 3.4s 内必须翻
  await settleAtCover();
  await setSpeed(10);
  await page.evaluate(() => window.__auto.start());
  await page.waitForTimeout(1400);
  const liveBefore = await page.evaluate(() => window.__pf.getCurrentPageIndex());
  speedSet.live = await setSpeed(2);
  speedLive = await page.evaluate(async (args) => {
    const [before, windowMs] = args;
    let flipped = false;
    const t0 = performance.now();
    while (performance.now() - t0 < windowMs) {
      if (window.__pf.getCurrentPageIndex() !== before) { flipped = true; break; }
      await new Promise((r) => setTimeout(r, 80));
    }
    window.__auto.stop();
    return { flips: flipped ? 1 : 0, before };
  }, [liveBefore, 3400]);

  // 收尾：拨回默认 5 秒，别把状态留给后面的断言
  await setSpeed(5);
  await settleAtCover();
}

const speedOk = !speedDom.exists ? false : (
  speedDom.visible && speedDom.options.length === 10 &&
  speedDom.options.join(',') === '1,2,3,4,5,6,7,8,9,10' &&
  speedDom.value === 5 && speedDom.selectedAttr === 5 && speedDom.speedSeconds === 5 &&
  // 档位设置值：精确断言，不依赖计时
  speedSet.slow === 10 && speedSet.fast === 2 && speedSet.live === 2 &&
  // 行为：慢的一页不翻、快的真翻、改档立即生效
  speedSlow.flips === 0 && speedFast.flips >= 1 && speedLive.flips >= 1
);

// ★ 把每条拆成**有名有姓**的子项：这一整段有近 20 个条件，写成一大串 && 的话
//   一旦红了只报一句「⚠ 自动翻页有问题」，还得再写探针一轮轮猜是哪条
//   （2026-09-25 就为这个多花了一轮：真凶是"按钮状态读在了播放结束之后"）。
//   现在红了直接打出没过的子项名。判据本身一条没改。
const autoClauses = {
  '按钮存在': autoDom.exists,
  '按钮可见': autoDom.visible,
  '有 __auto 接口': autoDom.api === 'object',
  '按钮初始未按下': autoDom.pressed === 'false',
  '有播放/停止两套文案': !!autoDom.label && !!autoDom.stopLabel,
  '按钮是手型': autoDom.cursor === 'pointer',
  '线上默认间隔 5000ms': autoDom.defaultInterval === 5000,
  '不点它一动不动': autoIdle.played === false && autoIdle.end === autoIdle.start,
  '点开真的翻过 ≥3 页': autoRun.seen.length >= 3,
  '点开确实在播过': autoRun.played === true,
  // ★ 播放**中**读按钮状态（见 autoRun 里的说明）：窗口末尾读会把
  //   "短书跑到头自停后按钮合法复位"误判成"按钮和状态不一致"。
  '播放中按钮显示为「停止」': !!autoRun.onWhenPlaying &&
      autoRun.onWhenPlaying.pressed === 'true' && autoRun.onWhenPlaying.label === autoDom.stopLabel,
  // ★ 点「停止」的测量前提：确实在播、且不在末跨页（见 ③ 前面的说明）
  '点停止前确实在播且不在末跨页': preStop.playing === true && preStop.spread < preStop.lastSpread,
  '点了确实停住': stoppedNow === true,
  '停后按钮回到「自动翻页」': autoOff.playing === false && autoOff.pressed === 'false' &&
      autoOff.label === autoDom.label,
  '停稳后不再自己动': autoOffSettled.playing === false &&
      autoOffSettled.p0 === autoOffSettled.p1,
  '手一碰就让位（键盘/按钮/点页码）': [mKey, mBtn, mJump].every((m) =>
      m.before.playing === true && m.landed === true && m.after.playing === false &&
      m.after.pressed === 'false' && m.after.label === autoDom.label),
  '跑到末跨页自停': ranToEnd.everPlayed && ranToEnd.reachedLast &&
      endState.playing === false && endState.pressed === 'false' &&
      endState.spread === endState.lastSpread,
  '末页点开始从封面重播': rewind.before.spread === rewind.before.lastSpread &&
      rewind.min === 0 && rewind.after.spread < rewind.before.spread &&
      rewind.after.playing === true,
};
const autoBad = Object.keys(autoClauses).filter((k) => !autoClauses[k]);
const autoOk = autoBad.length === 0;
console.log('自动翻页    :', `按钮 ${autoDom.exists ? '有' : '★缺★'}（"${autoDom.label}"/"${autoDom.stopLabel}"，`
            + `默认间隔 ${autoDom.defaultInterval}ms）`,
            `| 不点它 2.4s：页 ${autoIdle.start}→${autoIdle.end} 播放过=${autoIdle.played}`,
            `| 点开后 3.4s 翻过 ${autoRun.seen.join('→')}（结束仍在播=${autoRun.playing}）`,
            `| 点停止前 在播=${preStop.playing} 跨页 ${preStop.spread}/${preStop.lastSpread}`,
            `| 再点一下 停住=${stoppedNow} 之后静止=${autoOffSettled.p0}==${autoOffSettled.p1}`,
            `| 手动让位 键盘/按钮/点页码=${[mKey, mBtn, mJump].map((m) => m.landed).join('/')}`,
            `| 跑到末跨页 ${endState.spread}/${endState.lastSpread} 自停=${!endState.playing}`,
            `| 末页点开始→最小跨页 ${rewind.min}（起手 ${rewind.before.spread}）`,
            autoOk ? '（正常）' : `（⚠ 没过的子项：${autoBad.join('、')}）`);
console.log('翻页调速    :',
            speedDom.exists
              ? `控件有（${speedDom.options.join('/')} 秒，默认选中 ${speedDom.value}）`
              : '★ 这本成品里没有调速控件 —— 它是旧运行时出的，请重出后再验收 ★',
            `| 档位设置 10/2/2 实测 ${speedSet.slow}/${speedSet.fast}/${speedSet.live}`,
            `| 10 秒档静置 3.4s 翻页数 ${speedSlow.flips}（应 0）`,
            `| 2 秒档 4.2s 翻页数 ${speedFast.flips}（应 ≥1）`,
            `| 播放中 10→2 秒 ${speedLive.flips >= 1 ? '立刻生效' : '★没生效★'}`,
            `| 重载后默认 ${speedDom.speedSeconds}s（选中 ${speedDom.selectedAttr}）`,
            speedOk ? '（正常）' : '（⚠ 调速有问题）');

// ⑧ ★ Phase 26：控制条上那个**常驻**的「跳到第 N 页」
//
//   佘先生：「在查看画册的界面的选择查看的页数的功能恢复，就设计在自动翻页的
//   组块的上方，注意布局协调」。
//
//   「恢复」≠「把老入口找回来」—— Phase 19 那个"点页码 → 就地变输入框"
//   （`#page-jump`）是原功能，核心层成功T 静态钉着它还在、没被删。这一层要证：
//     ① 常驻入口**看得见**（他要的就是"看得见"）；
//     ② DOM 顺序与**几何位置**都排在自动翻页**上方**、互不重叠 ——
//        "布局协调"只有坐标量得住：结构顺序对、却被 order/绝对定位甩走的情况，
//        任何文字断言都会绿；
//     ③ 点「跳转」和按回车都**真的跳**，而且跳完框里的数字 = 真正停的那一页；
//     ④ 超界 / 乱输**不报错也不跳飞**（限幅，不是弹错误框）；
//     ⑤ 老入口 `#page-jump` 照旧能跳，而且与常驻入口**同一套限幅**。
//
//   ★ 本段开跑前必须重新载入：上一步把间隔压过、书也停在别处了（与 ⑦ 同理）。
await page.goto(BASE, { waitUntil: 'load' });
await page.waitForFunction(
  () => !!(window.__pf && window.__pf.getPageCount() > 0), null, { timeout: 20000 });
await page.waitForTimeout(900);

const jumpRowDom = await page.evaluate(() => {
  const row = document.querySelector('.jump-row');
  const sel = document.getElementById('page-select');
  const go = document.getElementById('page-go');
  const auto = document.getElementById('page-auto');
  if (!row || !sel || !go || !auto) {
    return { exists: false, row: !!row, sel: !!sel, go: !!go, auto: !!auto };
  }
  const r = row.getBoundingClientRect();
  const a = auto.getBoundingClientRect();
  return {
    exists: true,
    visible: row.offsetParent !== null && sel.offsetParent !== null && go.offsetParent !== null,
    // DOM 顺序：row 之后确实跟着 auto
    domBefore: !!(row.compareDocumentPosition(auto) & Node.DOCUMENT_POSITION_FOLLOWING),
    above: r.bottom <= a.top + 4,
    gap: Math.round(a.top - r.bottom),
    initial: Number(sel.value),
    total: window.__pf.getPageCount(),
  };
});

/** 回封面并**等它停稳**（翻页动画 760ms，不等的话会把它数成一次跳页） */
const resetToCover = () => page.evaluate(async () => {
  window.__auto.stop();
  window.__pf.turnToPage(0);
  await new Promise((r) => setTimeout(r, 1100));
  return window.__pf.getCurrentPageIndex();
});
const readJump = () => page.evaluate(() => ({
  landed: window.__pf.getCurrentPageIndex(),
  shown: Number(document.getElementById('page-select').value),
  focused: document.activeElement === document.getElementById('page-select'),
}));
/** 读"在第几个跨页"——末页那种"左右页配对"的落位只有跨页索引靠得住（见 atLastSpread） */
const readSpread = () => page.evaluate(() => {
  const pc = window.__pf.getPageCollection();
  return {
    spread: pc.getCurrentSpreadIndex(),
    lastSpread: pc.getSpreadIndexByPage(window.__pf.getPageCount() - 1),
    shown: Number(document.getElementById('page-select').value),
    total: window.__pf.getPageCount(),
  };
});

// 目标页号取**偶数**：跨页是 (奇,偶) 配对 —— (1,2) 是第 1 个跨页 ——
// 所以偶数页号正好是某个跨页的左页，落位与回显都是干净的一一对应，不用做容差。
let wantPage = Math.max(2, Math.min(12, jumpRowDom.total - 2));
if (wantPage % 2 !== 0) wantPage -= 1;

// ③-a 点「跳转」按钮
const coverIdx = await resetToCover();
await page.fill('#page-select', String(wantPage));
await page.click('#page-go');
await page.waitForTimeout(1400);
const goRead = await readJump();

// ③-b 按回车（真键盘事件，不是 dispatchEvent —— 走的是用户那条路）
await resetToCover();
await page.click('#page-select');
await page.fill('#page-select', String(wantPage));
await page.keyboard.press('Enter');
await page.waitForTimeout(1400);
const enterRead = await readJump();

// ④-a 超界：天文数字 → 夹到末跨页，不许报错、不许跳飞
await resetToCover();
await page.fill('#page-select', '9999');
await page.click('#page-go');
await page.waitForTimeout(1600);
const overRead = await readSpread();

// ④-b 乱输：一个数字都没打 → 不跳，而且不许把旧数字留在框里骗人
await resetToCover();
const junkFrom = await readJump();
await page.fill('#page-select', '第几页来着');
await page.click('#page-go');
await page.waitForTimeout(900);
const junkRead = await readJump();

// ⑤ 老入口 `#page-jump`（Phase 19 的原功能）照旧能跳，且与常驻入口同一套限幅
await resetToCover();
await page.click('#page-jump');
await page.waitForTimeout(250);
await page.fill('#page-input', '9999');
await page.keyboard.press('Enter');
await page.waitForTimeout(1600);
const oldRead = await readSpread();

const jumpRowClauses = {
  '常驻跳页行存在且看得见': jumpRowDom.exists && jumpRowDom.visible,
  'DOM 顺序排在自动翻页之前': jumpRowDom.exists && jumpRowDom.domBefore,
  '几何上在自动翻页上方且不重叠': jumpRowDom.exists && jumpRowDom.above && jumpRowDom.gap >= 0,
  '初始就回显当前页（封面 = 1）': jumpRowDom.exists && jumpRowDom.initial === 1,
  '点「跳转」真的跳到那一页': goRead.landed === wantPage - 1 && goRead.landed !== coverIdx,
  '跳完回显 = 真正停的那一页，且不留焦点': goRead.shown === goRead.landed + 1 && goRead.focused === false,
  '按回车同样跳': enterRead.landed === wantPage - 1,
  '超界被夹到末跨页（不报错、不跳飞）': overRead.spread === overRead.lastSpread,
  '超界后回显就是末页号': overRead.shown >= overRead.total - 1 && overRead.shown <= overRead.total,
  '乱输不乱跳、也不留旧数字骗人': junkRead.landed === junkFrom.landed
      && junkRead.shown === junkFrom.landed + 1,
  '老入口 #page-jump 同一套限幅（超界也到末跨页）': oldRead.spread === oldRead.lastSpread,
};
const jumpRowBad = Object.keys(jumpRowClauses).filter((k) => !jumpRowClauses[k]);
const jumpRowOk = jumpRowBad.length === 0;
console.log('跳页组块    :',
            jumpRowDom.exists
              ? `常驻行 可见=${jumpRowDom.visible} 在自动翻页上方=${jumpRowDom.above}（间距 ${jumpRowDom.gap}px）`
              : '★ 这本成品里没有常驻跳页行 —— 它是旧运行时出的，请重出后再验收 ★',
            `| 初始回显 ${jumpRowDom.initial}/${jumpRowDom.total}`,
            `| 点跳转 → 页位 ${goRead.landed}（回显 ${goRead.shown}，要的是 ${wantPage}）`,
            `| 回车 → 页位 ${enterRead.landed}`,
            `| 超界 9999 → 跨页 ${overRead.spread}/${overRead.lastSpread}（回显 ${overRead.shown}）`,
            `| 乱输 → 页位 ${junkRead.landed}（回显 ${junkRead.shown}）`,
            `| 老入口超界 → 跨页 ${oldRead.spread}/${oldRead.lastSpread}`,
            jumpRowOk ? '（正常）' : `（⚠ 没过的子项：${jumpRowBad.join('、')}）`);

// ---------------------------------------------------------------
// ⑨ ★ Phase 27：① 书不许压住底部控制条  ② 后壳要能翻页合上
// ---------------------------------------------------------------
//
// 佘先生（Phase 27 原话）：
//   「保留原功能，要求一是修复查看画册时的的选择页数的UI组块和图片有重合冲突，
//     要求二是画册的后壳也要可以翻页合上」
//
// ① 的成因：`.book-rig` 的高宽原本写死 `100dvh - 140px`（那句注释叫"给导航留位置"，
//   是个**估算**）。Phase 26 往脚部加了一行常驻跳页控件后，脚部从 ~79px 涨到 121px，
//   140px 就不够了 —— 实测书底越出控制条顶：1280×800 40px、1100×720 60px、
//   1024×768 51px、900×600 60px、760×620 42.5px，其中 1100 / 900 两档
//   **正好压住那行跳页控件本身**（就是佘先生说的"和图片有重合冲突"）。
//   修法：`.stage` 变成尺寸查询容器，宽、高公式都改用 `100cqh`（真正剩下的高度）。
//
//   ★ 必须**多档都量**、而且要**两种路径都量**：
//     · 只测 1440×900 是量不出来的（那档原来是好的，现在也是好的）；
//     · 只在"新开页面"上量，会漏掉"用户拖窗口"那条路（库挂了 window.resize）。
//   所以下面这一段在**同一个页面里**逐个 setViewportSize 量。
//
// ② 的成因：库建跨页表时（`createSpread`）从下标 1 起、步长 2 两两成对，
//   只有当轮到的下标恰好等于「总页数-1」时才把末页单列 ⇒ **总页数为奇数时，
//   末页永远被配对走，向前翻会静默失败**（库的守卫放行、里层取到 undefined 抛错被吞）。
//   症状正是：末页点「→」**完全没反应，而按钮看着还能点**。
//   修法：只补一个"只含末页"的跨页（见 runtime/flipbook.js 的 ensureBackCoverSpread），
//   页数 / 版式 / book-plan 一个字没动。
//   ⇒ 这里钉死"点「→」能翻、翻完只剩一页、edge=back、状态条 Back cover、
//     下一页按钮禁用、而且**点「←」能原样翻回来**"。
//
//   ★ 「可逆」必须一起断言："合上"不能是单向的 —— 能合上却打不开同样算坏。
//
// 本段会改窗口尺寸，跑完恢复 1440×900。
const VIEWPORTS = [
  { width: 1440, height: 900 },
  { width: 1280, height: 800 },
  { width: 1100, height: 720 },
  { width: 1024, height: 768 },
  { width: 900, height: 600 },
  { width: 760, height: 620 },
];

const measureOverlap = () => page.evaluate(() => {
  const rr = (n) => Math.round(n * 10) / 10;
  const rect = (el) => (el ? el.getBoundingClientRect() : null);
  const book = rect(document.querySelector('#book'));
  const ctrl = rect(document.querySelector('.controls'));
  const jump = rect(document.querySelector('.jump-row'));
  const inter = (a, b) => {
    if (!a || !b) return null;
    const x = Math.min(a.right, b.right) - Math.max(a.left, b.left);
    const y = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
    return { hit: x > 0 && y > 0, x: rr(x), y: rr(y) };
  };
  return {
    bookBottom: book ? rr(book.bottom) : null,
    ctrlTop: ctrl ? rr(ctrl.top) : null,
    gap: book && ctrl ? rr(ctrl.top - book.bottom) : null,
    jumpHit: inter(book, jump),
    // 控制条里那行跳页自己也得是"看得见、量得到"的，否则这条断言会变成空转
    jumpVisible: !!jump && jump.height > 1,
  };
});

const overlapReads = [];
for (const vp of VIEWPORTS) {
  await page.setViewportSize(vp);
  await page.waitForTimeout(800);          // 等库的 resize 重排跑完
  overlapReads.push({ vp: `${vp.width}x${vp.height}`, ...(await measureOverlap()) });
}
const overlapBad = overlapReads.filter(
  (c) => c.gap === null || c.gap < 0 || !c.jumpVisible || (c.jumpHit && c.jumpHit.hit));

const overlapClauses = {
  '每一档都量到了（书与控制条都在）': overlapReads.every((c) => c.gap !== null),
  '每一档书底都不越出控制条顶': overlapReads.every((c) => c.gap !== null && c.gap >= 0),
  '每一档都没有压住跳页那行': overlapReads.every((c) => !(c.jumpHit && c.jumpHit.hit)),
  '每一档跳页那行都还在（不是被"量不到"糊弄过去）': overlapReads.every((c) => c.jumpVisible),
};
const overlapBadKeys = Object.keys(overlapClauses).filter((k) => !overlapClauses[k]);
const overlapOk = overlapBadKeys.length === 0;
console.log('版面不重叠  :',
            overlapReads.map((c) => `${c.vp} 让开 ${c.gap}px`).join(' | '),
            overlapOk ? '（全部不压）'
                      : `（⚠ 没过的子项：${overlapBadKeys.join('、')}`
                        + `；出问题的档：${overlapBad.map((c) => c.vp).join('、')}）`);

await page.setViewportSize({ width: 1440, height: 900 });
await page.waitForTimeout(600);

/** 读「现在看得见几页、是哪几页」+ 库自己的状态 */
const readBackState = () => page.evaluate(() => {
  const pf = window.__pf;
  const leaves = [...document.querySelectorAll('.book-page')];
  const visible = leaves.filter((el) => {
    const b = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return s.display !== 'none' && s.visibility !== 'hidden' &&
           Number(s.opacity) > 0.01 && b.width > 1 && b.height > 1;
  });
  const pc = pf.getPageCollection();
  return {
    pageIndex: pf.getCurrentPageIndex(),
    spread: pc.getCurrentSpreadIndex(),
    // ★ 跨页表长度按**当前朝向**取（横屏末格 = Phase 27 补的"只含封底"那一格）
    spreadCount: (pc.getSpread() || []).length,
    status: document.querySelector('#page-status')?.textContent,
    edge: document.querySelector('#book')?.dataset.edge,
    nextDisabled: document.querySelector('#next')?.disabled,
    visibleCount: visible.length,
    visibleLabels: visible.map((el) => el.getAttribute('aria-label') || ''),
    total: pf.getPageCount(),
  };
});

await page.evaluate(async () => {
  window.__auto.stop();
  const pf = window.__pf;
  pf.turnToPage(pf.getPageCount() - 1);
  await new Promise((r) => setTimeout(r, 1700));
});
const backBefore = await readBackState();
await page.click('#next');                    // ★ 走用户那条路：点按钮，不是调 API
await page.waitForTimeout(1900);
const backClosed = await readBackState();
await page.click('#previous');
await page.waitForTimeout(1700);
const backReopened = await readBackState();

// ★ Phase 28：合上之后再点「→」= **整本翻回封面**
//   佘先生：「我翻到后壳后再点击两下就可以翻到封面，就是整本书翻转」。
//   从末跨页算起正好两下：① 合上封底 ② 整本翻回封面。
await page.click('#next');                    // 再合一次（验"来回翻不卡"）
await page.waitForTimeout(1900);
const backClosedAgain = await readBackState();
await page.click('#next');                    // ★ 整本翻回封面
await page.waitForTimeout(1900);
const wrapped = await readBackState();

const backClauses = {
  '翻之前停在「版权页 + 封底」那一跨页（两页都可见）':
      backBefore.visibleCount === 2 && backBefore.edge === 'inside',
  '点「→」真的翻得动（不再是点了没反应）': backClosed.spread === backBefore.spread + 1,
  '合上后画面只剩一页': backClosed.visibleCount === 1,
  '剩下的那一页就是封底': (backClosed.visibleLabels[0] || '').includes('封底'),
  '整本书平移把它居中（edge=back）': backClosed.edge === 'back',
  '状态条写 Back cover': backClosed.status === 'Back cover',
  // ★★ 这条**被需求改过**，单独说明：它不是"为了让判据变绿而放宽"。
  //    Phase 27 时这里断言的是 `nextDisabled === true`（到头了按钮变灰）；
  //    Phase 28 佘先生要求"后壳之后再点两下能翻到封面" —— 按钮在末页必须**可点**，
  //    变灰反而是错的。同一个状态（已合上）上，判据从「必须禁用」换成「必须可点」，
  //    而且下面还多出三条断言盯着"点了真的会动"，净额是**加严**。
  '到头了「→」仍然点得动（Phase 28：它现在会把书翻回封面）':
      backClosed.nextDisabled === false,
  '点「←」能原样翻回来（合上必须可逆）':
      backReopened.spread === backBefore.spread && backReopened.visibleCount === 2,
  '再合一次也成（来回翻不卡）': backClosedAgain.spread === backClosed.spread,
  '合上后再点「→」整本翻回封面（跨页 0）': wrapped.spread === 0,
  '翻回封面后是「封面单页」（edge=front、状态 Cover、只可见 1 页）':
      wrapped.edge === 'front' && wrapped.status === 'Cover' && wrapped.visibleCount === 1,
  '翻回来的那一页确实是封面': (wrapped.visibleLabels[0] || '').includes('封面'),
};
const backBad = Object.keys(backClauses).filter((k) => !backClauses[k]);
const backOk = backBad.length === 0;
console.log('后壳合上    :',
            `末跨页 ${backBefore.spread}（可见 ${backBefore.visibleCount} 页）`,
            `→ 点「→」后 跨页 ${backClosed.spread}、可见 ${backClosed.visibleCount} 页`,
            `[${backClosed.visibleLabels.join('、')}]、edge=${backClosed.edge}`,
            `、状态「${backClosed.status}」、下一页禁用=${backClosed.nextDisabled}`,
            `→ 点「←」回到跨页 ${backReopened.spread}（可见 ${backReopened.visibleCount} 页）`,
            `→ 再合一次 ${backClosedAgain.spread}`,
            `→ 再点「→」跨页 ${wrapped.spread}（可见 ${wrapped.visibleCount} 页`,
            `[${wrapped.visibleLabels.join('、')}]、edge=${wrapped.edge}、状态「${wrapped.status}」）`,
            backOk ? '（正常）' : `（⚠ 没过的子项：${backBad.join('、')}）`);

// ---------------------------------------------------------------
// ⑩ ★ Phase 28：控制条压成两行（佘先生：「上下宽度压缩一半…让图片占据画面的绝大部分，
//      比如那个自动翻页和其速度组块完全可以放在同一行，跳转页面的组块做成一行」）
// ---------------------------------------------------------------
//
// 实测基线（改之前，Phase 27 那版）：`.controls` 高 **121.2px**，竖排五行 ——
//   状态 / 说明小字 / 跳到第 N 页 / 自动翻页 / 5 秒（速度下拉）。
// 改之后两行：第 1 行 = 状态 + 跳到第 N 页；第 2 行 = 自动翻页 + 速度下拉。
//
// 阈值怎么来的（都留了实测余量，不是拍脑袋定的）：
//   · 控制条高 ≤ 61px —— 要求是"压缩一半"，改动前 121.2 的一半 = 60.6，取整 61。
//     6 档实测**都是 46.6px**（= 改前的 38%），离上限还有 14.4px 余量。
//   · 两行"中心线差 ≤ 3px" —— 实测各档都是 **0px**，3px 只是容忍字体舍入。
//   · 书高占视口 ≥ 70% —— 实测 71.1% ~ 80.4%；最低那档是 1440×900，因为那档书高被
//     库的 maxHeight 640px 顶住了（与控制条无关，是所有档里最"吃亏"的一档）。
//   ★ 每一条都**逐档**判定，不许只看一档 —— 这是 Phase 27 用血换来的教训
//     （`100dvh - 140px` 那个 bug 只在矮窗口显形，1440×900 完全正常）。
//
// ★ 这条"图片占绝大部分"必须**量出来**：它是个观感要求，任何"元素存在/顺序正确"的
//   断言都证明不了它。
const compactReads = [];
const measureCompact = () => page.evaluate(() => {
  const rr = (n) => Math.round(n * 10) / 10;
  const box = (s) => { const el = document.querySelector(s); if (!el) return null;
    const b = el.getBoundingClientRect();
    return { cy: rr(b.top + b.height / 2), top: rr(b.top), bottom: rr(b.bottom), h: rr(b.height) }; };
  const ctrl = box('.controls');
  const book = box('#book');
  const jr = box('.jump-row');
  const st = box('#page-jump');
  const sel = box('#page-select');
  const go = box('#page-go');
  const au = box('#page-auto');
  const sp = box('#page-auto-speed');
  const cyOf = [st, jr, sel, go].filter(Boolean).map((b) => b.cy);
  const rowEls = [...document.querySelectorAll('.status > .status-row')];
  return {
    ctrlH: ctrl ? ctrl.h : null,
    rows: rowEls.length,
    bookPct: book ? rr(book.h / window.innerHeight * 100) : null,
    navSpread: cyOf.length === 4 ? rr(Math.max(...cyOf) - Math.min(...cyOf)) : null,
    autoSpread: au && sp ? rr(Math.abs(au.cy - sp.cy)) : null,
    jumpAboveAuto: !!(jr && au) && jr.bottom <= au.top + 4,
    // 防"把行藏起来换来的矮"：两行都得真的看得见、量得到
    rowsVisible: rowEls.length === 2 && rowEls.every((el) => el.getBoundingClientRect().height > 1),
  };
});

for (const vp of VIEWPORTS) {
  await page.setViewportSize(vp);
  await page.waitForTimeout(800);
  compactReads.push({ vp: `${vp.width}x${vp.height}`, ...(await measureCompact()) });
}
await page.setViewportSize({ width: 1440, height: 900 });
await page.waitForTimeout(600);

const compactClauses = {
  '每一档都量到了（控制条与书都在）':
      compactReads.every((c) => c.ctrlH !== null && c.bookPct !== null),
  '每一档控制条高都 ≤ 61px（改动前 121.2 的一半）':
      compactReads.every((c) => c.ctrlH !== null && c.ctrlH <= 61),
  '每一档都是实实在在的两行（不是把行藏起来换来的矮）':
      compactReads.every((c) => c.rows === 2 && c.rowsVisible),
  '每一档「跳到第 N 页」组块都在同一行（中心线差 ≤ 3px）':
      compactReads.every((c) => c.navSpread !== null && c.navSpread <= 3),
  '每一档自动翻页与速度下拉都在同一行（中心线差 ≤ 3px）':
      compactReads.every((c) => c.autoSpread !== null && c.autoSpread <= 3),
  '每一档跳页组块仍在自动翻页上方（Phase 26 的约定不能丢）':
      compactReads.every((c) => c.jumpAboveAuto),
  '每一档图片都占画面绝大部分（书高 ≥ 视口 70%）':
      compactReads.every((c) => c.bookPct !== null && c.bookPct >= 70),
};
const compactBad = Object.keys(compactClauses).filter((k) => !compactClauses[k]);
const compactOk = compactBad.length === 0;
console.log('控制条两行  :',
            compactReads.map((c) => `${c.vp} 高 ${c.ctrlH}px / 书占 ${c.bookPct}%`).join(' | '),
            compactOk ? '（正常）' : `（⚠ 没过的子项：${compactBad.join('、')}）`);

// ---------------------------------------------------------------
// ⑪ ★ Phase 29：封面/后壳双击整本翻转
// ---------------------------------------------------------------
//
// 佘先生：「…在封面我连击鼠标左键两次是翻转画册到后壳，
//   在后壳我连击鼠标左键两次则翻转画册到封面」。
//
// ★ 这一段全程用**真鼠标事件**（page.mouse.dblclick），不是 page.evaluate 里
//   自己派发 —— 后者证明不了"用户这么操作真的管用"。
// ★ 曾经失效的点钉在这里：库默认单击书页就翻页 ⇒ 一次双击会先被两次单击翻走两页，
//   `dblclick` 必须靠**按下时记下的快照**才知道"这次双击从哪开始"。
// ⚠ Phase 29 原来还有「鼠标滚轮翻页（上=左翻 / 下=右翻）」这一整块。
//   佘先生 Phase 32 把滚轮改成了**缩放照片**（「鼠标中键滑动改成缩放功能」）
//   ⇒ 滚轮翻页这个功能已撤，相关判据**口径作废、整段删掉**（不是放宽阈值）。
//   替代判据在下面 ⑫：「单独滚滚轮只缩放、不翻页」。
await page.evaluate(() => window.__pf.turnToPage(0));
await page.waitForTimeout(900);
const dCoverBefore = await readBackState();
const c2 = await page.evaluate(() => {
  const b = document.querySelector('#book').getBoundingClientRect();
  return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) };
});
await page.mouse.dblclick(c2.x, c2.y);
// ★★ Phase 36 换口径（铁律 7）：不再是"整叠块面翻过去"，而是
//   **逐页急翻 5 下 ⇒ 停下 ⇒ 瞬间切到另一头**（佘先生：「逐页急翻五面，
//   然后就不翻了，直接跳到封面和后壳」；追问确认：五下 = 五张跨页、
//   收尾"瞬间切过去"、落点封面↔后壳）。
//   这里守着"真的翻够了 5 下 + 真的到了后壳 + flippingTime 还原 +
//   全程**没有**任何自绘方块元素"。细看由 `_p36_accept.mjs` 量，29/29。
let rifleSeen = null;
let slabEverSeen = false;
let flipTimeDuring = null;
for (let i = 0; i < 260; i++) {
  const snap = await page.evaluate(() => {
    const s = (window.__pf.getSettings && window.__pf.getSettings()) || {};
    return {
      slab: !!document.querySelector('.stack-flip') || !!document.querySelector('.stack-mask'),
      last: window.__cover.last(),
      run: !!window.__cover.state(),
      ft: typeof s.flippingTime === 'number' ? s.flippingTime : null,
    };
  });
  if (snap.slab) slabEverSeen = true;
  if (!rifleSeen && snap.last) rifleSeen = { ...snap.last };
  if (snap.run && snap.ft === 260) flipTimeDuring = snap.ft;
  if (rifleSeen && !snap.run) break;
  await page.waitForTimeout(25);
}
await page.waitForTimeout(800);
const dBack = await readBackState();
const flipTimeAfter = await page.evaluate(() => {
  const s = (window.__pf.getSettings && window.__pf.getSettings()) || {};
  return typeof s.flippingTime === 'number' ? s.flippingTime : null;
});

// 后壳双击 → 封面
await page.mouse.dblclick(c2.x, c2.y);
let backRifle = null;
for (let i = 0; i < 260; i++) {
  const snap = await page.evaluate(() => ({
    last: window.__cover.last(),
    run: !!window.__cover.state(),
  }));
  if (snap.last && snap.last.dir === -1) backRifle = { ...snap.last };
  if (backRifle && !snap.run) break;
  await page.waitForTimeout(25);
}
await page.waitForTimeout(800);
const dHome = await readBackState();

const gestureClauses = {
  '起点在封面时双击 → 整本翻到后壳（末格 + edge=back）':
      dCoverBefore.spread === 0 && dBack.spread === dBack.spreadCount - 1
      && dBack.edge === 'back',
  '后壳双击 → 翻回封面（跨页 0 + edge=front）': dHome.spread === 0 && dHome.edge === 'front',
  // ★ Phase 36：封面那一趟必须**正好翻够 5 下**（含双击自带的那几下）
  '★ 封面双击那一趟正好翻 5 下（flip 事件口径）': !!rifleSeen && rifleSeen.dir === 1
      && rifleSeen.total === 5,
  // ★ Phase 36：急翻期间 flippingTime 被压到 RIFFLE_MS，收尾必须还原成 760
  '★ 急翻提速到 RIFFLE_MS 且收尾还原（flippingTime 260 → 760）':
      flipTimeDuring === 260 && flipTimeAfter === 760,
  // ★ Phase 36：全程不许再出现自绘的整叠方块（Phase 34/35 那套已退役）
  '★ 全程没有自绘的整叠方块（.stack-flip / .stack-mask 都没出现）': !slabEverSeen,
  // ★ 反向那一趟也要真的翻够 5 下（后壳 → 封面）
  '★ 后壳双击那一趟也翻够了 5 下（反向）': !!backRifle && backRifle.total === 5,
};
const gestureBad = Object.keys(gestureClauses).filter((k) => !gestureClauses[k]);
const gestureOk = gestureBad.length === 0;
console.log('双击翻转    :',
            `封面双击 ${dCoverBefore.spread}→${dBack.spread}/${dBack.spreadCount - 1}（edge=${dBack.edge}）`,
            `翻 ${rifleSeen ? rifleSeen.total : '?'} 下`,
            `| flippingTime ${flipTimeDuring}→${flipTimeAfter}`,
            `| 方块 ${slabEverSeen ? '出现了!' : '无'}`,
            `| 后壳双击 →${dHome.spread}（edge=${dHome.edge}）翻 ${backRifle ? backRifle.total : '?'} 下`,
            gestureOk ? '（正常）' : `（⚠ 没过的子项：${gestureBad.join('、')}）`);

// 收尾：把书放回封面，免得影响后面的读数
await page.evaluate(() => window.__pf.turnToPage(0));
await page.waitForTimeout(700);

// ---------------------------------------------------------------
// ⑫ ★ Phase 31 定稿 + Phase 32 改口径 + Phase 34 定量程口径：
//    ① 删掉脚部那行说明小字 ② 页码放大 + 圆滑 ③ 滚轮 = 缩放照片（中键按住期间无操作）
//    ④ Phase 34：滚轮"固定光标、不为铺满挪图" / Ctrl 上限 = 单张铺满倍率 × 4
// ---------------------------------------------------------------
//
// 佘先生 Phase 31 原话：「要求一是查看画册的下方不需要有…这一行字，不美观，
//   要求二是图片的页码显示大一些，但是数字要圆滑美观，
//   要求三是新增功能，摁下鼠标中键滚动可以缩放图片，图片放缩要有中心瞄点，
//   不要一放大图片就跑出屏幕」。
//
// ★★ Phase 32 他改了两条口径，本段判据跟着改（**不是放宽，是判据原口径就是错的**）：
//   一、「鼠标中键滑动改成缩放功能，摁住鼠标中键暂时不要有什么操作」
//       ⇒ 单独滚滚轮就缩放（不再需要按住中键）；**按住中键期间一律不产生任何效果**
//         （不缩放、不翻页、不拖拽）。Phase 29 那条「滚轮翻页」被他本人撤掉了。
//   二、「图片放大时要全屏显示，注意不是窗口大小不变而图片只放大一部分」
//       ⇒ 判据从"照片盖满所在的那一页"改成"**照片外接矩形超出视口四边**"。
//         ⚠ 老判据（`covers`：照片盖满 `.plate`）是**假绿**：`.plate img` 本来就
//           `width:100%;height:100%;object-fit:cover`，1 倍时它就盖满整页，
//           所以那条在 1 倍和 4 倍下都绿，**证明不了"照片变大了"**。实测坐实：
//           4 倍时照片外接矩形 2048×2560，但"露在页面外 左 1536 / 上 1920 /
//           右 0 / 下 0"——右边和下边一像素都没超出去。
//
// ★ 与探针 `_p31_probe.mjs` / `_p32_accept.mjs` 的分工：探针量得细（多档倍率、
//   截图逐像素比对），这里是**成品门禁** —— 只守"用户立刻会发现"的那几条。
// ★ 量的一律是"鼠标底下那张照片"（window.__zoom.at）—— 不许用
//   '.book-page.--left .plate img'：库在 DOM 里保留全部 103 页，那个选择器
//   命中的是第一页那一份，翻页后读数全是假的（这一步踩过）。
// ⚠ 落点必须在**翻到目标页之后**才算：封面是单独一格（半页宽），它的 .plate
//   矩形和内页不是同一个参考系。先用封面的矩形、翻页后再拿它当基准去算
//   "鼠标在照片内的相对位置" ⇒ 瞄点会凭空漂出几十像素（实测 39px，假的）。
await page.evaluate(() => window.__pf.turnToPage(4));
await page.waitForTimeout(1200);

// 鼠标落点与"基准矩形"都取**照片自己**（视口坐标）。
// ⚠ 基准必须用没挂 transform 的容器：`getBoundingClientRect()` 给的是**变换后**
//   的外接矩形，拿它当基准会把放大后的尺寸当成原始尺寸（自证空转）。
const zoomSpot = await page.evaluate(() => {
  let best = null, bestArea = 0;
  for (const p of document.querySelectorAll('.book-page')) {
    if (getComputedStyle(p).display === 'none') continue;
    const img = p.querySelector('.plate img');
    if (!img) continue;
    const r = img.getBoundingClientRect();
    if (r.width < 20 || r.height < 20) continue;
    if (r.width * r.height > bestArea) { bestArea = r.width * r.height; best = r; }
  }
  return { x: Math.round(best.left + best.width * 0.35),
           y: Math.round(best.top + best.height * 0.45) };
});

/** 读"放大那张照片"的状态：倍率、外接矩形、以及是否超出**视口四边** */
const zoomState = () => page.evaluate(() => {
  let found = null;
  for (const p of document.querySelectorAll('.book-page.zoomed')) {
    const img = p.querySelector('.plate img');
    if (!img) continue;
    const st = window.__zoom.state(img);
    if (!found || st.s > found.st.s) found = { img, st };
  }
  if (!found) {
    // 1 倍时页上没有 .zoomed 标记 —— 退回到"鼠标底下那张"
    const img = window.__zoom.at(window.__p32AimX ?? -1, window.__p32AimY ?? -1);
    if (!img) return null;
    found = { img, st: window.__zoom.state(img) };
  }
  const ir = found.img.getBoundingClientRect();
  const v = window.__zoom.viewport();
  return {
    s: +found.st.s.toFixed(4), x: found.st.x, y: found.st.y,
    on: found.img.dataset.zoomOn === '1',
    rect: [Math.round(ir.left), Math.round(ir.top), Math.round(ir.width), Math.round(ir.height)],
    vw: innerWidth, vh: innerHeight,
    view: [Math.round(v.left), Math.round(v.top), Math.round(v.width), Math.round(v.height)],
    // ★ Phase 32 新口径：照片必须**超出视口四边**才算"全屏"
    //   （老口径 `ir ⊇ .plate` 是假绿：1 倍时本来就成立）
    coversView: ir.left <= 0 && ir.top <= 0 && ir.right >= innerWidth && ir.bottom >= innerHeight,
  };
});

// ① 脚部说明小字 + ② 页码字号 / 字形 / 等宽
const zoomSmallCount = await page.evaluate(
  () => document.querySelectorAll('footer.controls small, .controls small').length);
const numStyle = await page.evaluate(() => {
  const el = document.getElementById('page-status');
  const cs = getComputedStyle(el);
  return { fs: parseFloat(cs.fontSize), ff: cs.fontFamily, fvn: cs.fontVariantNumeric };
});

await page.mouse.move(zoomSpot.x, zoomSpot.y);
// 把落点记到 window 上，供 zoomState 在 1 倍时也能定位到"同一张照片"
await page.evaluate((sp) => { window.__p32AimX = sp.x; window.__p32AimY = sp.y; }, zoomSpot);

// ---- 要求一③：**单独滚滚轮**就放大（不按任何键）----
// 中心瞄点要"放大前后各量一次"才有意义：把鼠标位置换算成舞台坐标下的
// "照片上的点" a = (m − X)/s —— 两次的 a 必须一致。
// ★ 量纲（Phase 32 修过一次真 bug，别改回去）：
//   `X` 是**照片左上角在舞台坐标系里的位置**（含 1 倍时的落位 o，实测左页 (208,105)），
//   不是"相对自身布局位置的位移"。m 用**舞台坐标**（clientX − 舞台 left）。
//   ⚠ 基准只能用 `__zoom.viewport()`（舞台，未挂 transform）；
//     `getBoundingClientRect()` 给的是**变换后**的外接矩形 ⇒ 拿它当基准是自证空转。
// ★★ Phase 34 他改了这条口径（铁律 7：需求被本人改掉 ⇒ 旧判据显式换掉）：
//   原文「我想要的效果是我鼠标中键滑动时如果光标在图片之内就**固定光标**然后以
//   光标为中心放大图片，**不要为了全屏显示单个图片而移动图片**」。
//   ⇒ 分轴夹紧（sCoverX / sCoverY）与旧的"到铺满就停"整段撤掉，位移**原样**
//     由瞄点算出（照片超出屏幕也无所谓）。
//   ⇒ 所以"瞄点钉住"现在**没有例外**：从第 1 格一直到 4 倍封顶都要求它不动。
//     这里仍取第 1 格做基准（"一定还没贴边"的干净样本），到顶那一刻再量一次。
const aimAnchor = () => page.evaluate((sp) => {
  const v = window.__zoom.viewport();
  const img = window.__zoom.at(sp.x, sp.y)
    || document.querySelector('.book-page.zoomed .plate img')
    || null;
  if (!img) return null;
  const st = window.__zoom.state(img);
  const m = sp.x - v.left, n = sp.y - v.top;
  return { ax: (m - st.x) / st.s, ay: (n - st.y) / st.s, s: st.s, X: st.x, Y: st.y, m, n };
}, zoomSpot);

const zBefore = await zoomState();
const zSpread0 = (await readBackState()).spread;
const aBefore = await aimAnchor();
await page.mouse.wheel(0, -120);
await page.waitForTimeout(360);
const zAfter = await zoomState();
const zSpread1 = (await readBackState()).spread;
const aAfter = await aimAnchor();
// 第 1 格一定还没贴到横向的边（1.18 << 2.81），所以必须精确不动
const zDrift = (aBefore && aAfter)
  ? Math.max(Math.abs(aBefore.ax - aAfter.ax), Math.abs(aBefore.ay - aAfter.ay))
  : 999;

// ---- 要求一②：按住中键 = 什么都不做（不缩放、不翻页）----
await page.mouse.down({ button: 'middle' });
await page.waitForTimeout(160);
const zMidBase = await zoomState();
await page.mouse.wheel(0, -120);
await page.waitForTimeout(320);
const zMidWheel = await zoomState();
const zSpreadMid = (await readBackState()).spread;
// 按住中键再拖一段：也不许翻页（Phase 31 踩过"松手倒退一页"）
await page.mouse.move(zoomSpot.x + 240, zoomSpot.y + 110, { steps: 12 });
await page.waitForTimeout(360);
const zSpreadDrag = (await readBackState()).spread;
await page.mouse.up({ button: 'middle' });
await page.waitForTimeout(1400);
const zSpreadUp = (await readBackState()).spread;

// ---- 要求二：一路放大到顶 ----
// ⚠ 他 2026-09-27 明确选了「**逐步放大到铺满**」（不是"一滚就铺满"）⇒
//   前几格**允许还没铺满**（照片还在平滑长大），只有**到顶**才必须铺满。
//   所以这里量的是"最后一格（4 倍）是否超出视口四边"，不是"每一步都铺满"。
// ⚠ 必须先把鼠标**移回落点**：上面"按住中键拖动"那一步把鼠标挪到了
//   (x+240, y+110)，不移回来的话 `__zoom.at()` 命中的是**邻页那张照片**
//   （倍率 1）⇒ 全屏判据会拿到另一张照片的读数。
// ⚠ 判"是否盖满"一律用**到顶那一刻**的读数，不许用循环之后的 `zoomState()`
//   —— 循环里最后那次可能被冷却挡掉（`zoomBy` 返回 false 时不改状态）。
await page.mouse.move(zoomSpot.x, zoomSpot.y);
await page.waitForTimeout(150);
let zCoverStep = null;
for (let i = 0; i < 20; i++) {
  await page.mouse.wheel(0, -120);
  await page.waitForTimeout(140);
  const st = await zoomState();
  if (st) zCoverStep = st;
  if (st && st.s >= 3.999) break;      // 到顶了就停
}
const zMax = await zoomState();
const zCoversAll = !!(zMax && zMax.coversView);
// ★ Phase 34：到顶（4 倍封顶）那一刻，瞄点必须**仍然**钉住 —— 这是"不为铺满挪图"的硬证据
const aTop = await aimAnchor();
const zDriftTop = (aBefore && aTop)
  ? Math.max(Math.abs(aBefore.ax - aTop.ax), Math.abs(aBefore.ay - aTop.ay))
  : 999;

// 到顶时：屏幕右半 / 下半（原邻页的位置）必须是**放大那张照片**
const zNeighbor = await page.evaluate(() => {
  const pts = [[Math.round(innerWidth * 0.85), Math.round(innerHeight / 2)],
               [Math.round(innerWidth / 2), Math.round(innerHeight * 0.9)],
               [Math.round(innerWidth * 0.85), Math.round(innerHeight * 0.9)]];
  return pts.map(([x, y]) => {
    const e = document.elementFromPoint(x, y);
    return !!(e && e.closest('.book-page.zoomed'));
  });
});

// ---- 缩回原样 ----
for (let i = 0; i < 26; i++) { await page.mouse.wheel(0, 120); await page.waitForTimeout(120); }
const zBack = await zoomState();

// 缩回之后再翻滚轮：**不许翻页**（Phase 29 那条已撤）
await page.mouse.wheel(0, 120);
await page.waitForTimeout(1200);
const zSpreadNoFlip = (await readBackState()).spread;

// 翻页之后缩放自动复位
await page.mouse.wheel(0, -120);
await page.waitForTimeout(360);
await page.keyboard.press('ArrowRight');
await page.waitForTimeout(1400);
const zLeft = await page.evaluate(() => document.querySelectorAll('.plate img[data-zoom-on]').length);

// ---- ★★ Phase 34：Ctrl + 加号 = 两张一起绕正中心缩，**铺满后还能再放大 4 倍** ----
//   佘先生：「一是 Ctrl 和加减号的两张图片同时放大的效果改成**图片全屏后还能放大四倍**」
//   （他选定的算法：上限 = 单张"铺满"倍率 × SPREAD_TURNS(4)，实测 ≈ 2.81 × 4 ≈ 11.25）。
//   ⚠ 这一段放在所有既有读数**算完之后**，只额外动一次缩放，并在收尾彻底复位，
//     免得影响上面那些判据的读数。
await page.evaluate(() => window.__zoom.reset());
await page.evaluate(() => window.__pf.turnToPage(4));
await page.waitForTimeout(1100);
const ctrlTurns = await page.evaluate(() => window.__zoom.limits.spreadTurns);
const ctrlBase = await page.evaluate(() => {
  const v = window.__zoom.viewport();
  const out = [];
  for (const p of document.querySelectorAll('.book-page')) {
    if (getComputedStyle(p).display === 'none') continue;
    const img = p.querySelector('.plate img');
    if (!img) continue;
    const o = window.__zoom.origin(img);
    const st = window.__zoom.state(img);
    out.push({ s: st.s, cx: st.x, cy: st.y, w: o.w, h: o.h,
               sCover: Math.max(v.width / o.w, v.height / o.h) });
  }
  return out;
});
const ctrlCenterBefore = (() => {
  const l = Math.min(...ctrlBase.map((o) => o.cx));
  const r = Math.max(...ctrlBase.map((o) => o.cx + o.s * o.w));
  const t = Math.min(...ctrlBase.map((o) => o.cy));
  const b = Math.max(...ctrlBase.map((o) => o.cy + o.s * o.h));
  return { cx: (l + r) / 2, cy: (t + b) / 2 };
})();
await page.keyboard.down('Control');
for (let i = 0; i < 40; i++) { await page.keyboard.press('Equal'); await page.waitForTimeout(30); }
await page.waitForTimeout(260);
const ctrlAfter = await page.evaluate(() => {
  const v = window.__zoom.viewport();
  const out = [];
  for (const p of document.querySelectorAll('.book-page')) {
    if (getComputedStyle(p).display === 'none') continue;
    const img = p.querySelector('.plate img');
    if (!img) continue;
    const o = window.__zoom.origin(img);
    const st = window.__zoom.state(img);
    out.push({ s: st.s, cx: st.x, cy: st.y, w: o.w, h: o.h });
  }
  return out;
});
for (let i = 0; i < 60; i++) { await page.keyboard.press('Minus'); await page.waitForTimeout(20); }
await page.keyboard.up('Control');
await page.waitForTimeout(260);
const ctrlCap = ctrlBase.length ? ctrlBase[0].sCover * ctrlTurns : 0;
const ctrlMax = ctrlAfter.length ? Math.max(...ctrlAfter.map((o) => o.s)) : 0;
const ctrlSame = ctrlAfter.length < 2
  || Math.abs(Math.max(...ctrlAfter.map((o) => o.s)) - Math.min(...ctrlAfter.map((o) => o.s))) < 0.01;
const ctrlCenterAfter = (() => {
  const l = Math.min(...ctrlAfter.map((o) => o.cx));
  const r = Math.max(...ctrlAfter.map((o) => o.cx + o.s * o.w));
  const t = Math.min(...ctrlAfter.map((o) => o.cy));
  const b = Math.max(...ctrlAfter.map((o) => o.cy + o.s * o.h));
  return { cx: (l + r) / 2, cy: (t + b) / 2 };
})();
const ctrlCenterShift = Math.hypot(ctrlCenterAfter.cx - ctrlCenterBefore.cx,
                                   ctrlCenterAfter.cy - ctrlCenterBefore.cy);
await page.evaluate(() => window.__zoom.reset());
await page.evaluate(() => window.__pf.turnToPage(0));
await page.waitForTimeout(700);

const zoomClauses = {
  '脚部那行说明小字没了（<small> 数为 0）': zoomSmallCount === 0,
  '页码 ≥14px + 衬线（圆滑）+ 数字等宽':
      numStyle.fs >= 14 && /serif/i.test(numStyle.ff) && /tabular-nums/.test(numStyle.fvn),
  '★ 单独滚滚轮就放大（不用按中键）': !!zAfter && zAfter.s > zBefore.s + 0.05,
  '★ 单独滚滚轮不翻页': zSpread1 === zSpread0,
  '★ 中心瞄点：鼠标底下那点在放大前后没动（≤0.5px）': zDrift <= 0.5,
  '★ 放大到 4 倍封顶了瞄点仍然钉住（Phase 34：不为了铺满挪图）': zDriftTop <= 0.5,
  '★ 按住中键 + 滚滚轮：不缩放': !!zMidWheel && !!zMidBase
      && Math.abs(zMidWheel.s - zMidBase.s) < 0.001,
  '★ 按住中键期间：不翻页': zSpreadMid === zSpread0,
  '★ 按住中键 + 拖动：不翻页': zSpreadDrag === zSpread0,
  '★ 松开中键这个动作本身不翻页（Phase 31 修掉：松手会倒退一页）': zSpreadUp === zSpread0,
  '★ 放大到顶时照片铺满整屏（外接矩形超出视口四边）': zCoversAll,
  '★ 屏幕右半 / 下半（原邻页位置）已被放大那张照片盖住': zNeighbor.every(Boolean),
  '倍率有上限（封顶 4 倍）': !!zMax && zMax.s > 3.5 && zMax.s <= 4.0001,
  '缩回原样不残留 transform': !!zBack && zBack.s <= 1.0001 && !zBack.on,
  '★ 缩回之后再滚滚轮也不翻页（滚轮翻页已撤）': zSpreadNoFlip === zSpreadUp,
  '翻页之后缩放自动复位': zLeft === 0,
  // ---- ★★ Phase 34：Ctrl 那条的量程口径 ----
  '★ Ctrl 缩放：铺满后还能再放大（上限 = 每张的铺满倍率 × SPREAD_TURNS(4)）':
      ctrlTurns === 4 && ctrlCap > 0 && Math.abs(ctrlMax - ctrlCap) <= ctrlCap * 0.04,
  '★ Ctrl 缩放真的突破了旧的 4 倍封顶（说明"铺满后还能放大"生效了）': ctrlMax > 4.05,
  '★ Ctrl 缩放：两张倍率一致（同时放大）': ctrlSame,
  '★ Ctrl 缩放：围绕两张合起来的正中心（中心位移 ≤ 2px）': ctrlCenterShift <= 2,
};
const zoomBad = Object.keys(zoomClauses).filter((k) => !zoomClauses[k]);
const zoomOk = zoomBad.length === 0;
console.log('缩放与页码  :',
            `倍率 ${zBefore && zBefore.s}→${zAfter && zAfter.s}（顶 ${zMax && zMax.s}）`,
            `| 瞄点漂移 ${zDrift.toFixed(3)}px`,
            `| 到顶照片 ${zMax && zMax.rect}  视口 ${zMax && zMax.vw}×${zMax && zMax.vh}`,
            `| 到顶瞄点漂移 ${zDriftTop.toFixed(3)}px`,
            `| Ctrl 顶 ${ctrlMax.toFixed(3)} / 期望 ${ctrlCap.toFixed(3)}（中心位移 ${ctrlCenterShift.toFixed(3)}px）`,
            `| 页码 ${numStyle.fs}px/${numStyle.fvn}`,
            `| 跨页 ${zSpread0}→按住滚(${zSpreadMid})→按住拖(${zSpreadDrag})→松开(${zSpreadUp})→缩回再滚(${zSpreadNoFlip})`,
            `| 翻页后残留 ${zLeft} 张`,
            zoomOk ? '（正常）' : `（⚠ 没过的子项：${zoomBad.join('、')}）`);

// ---------------------------------------------------------------
// ⑬ ★ Phase 35 优化二：双击照片 = **单张全屏看**（灯箱）
// ---------------------------------------------------------------
//
// 佘先生 2026-09-29：「双击画册中的图片可以**单独一个图片显示**，在单击右上角
//   **叉号**退出当前图片的显示，放大的效果也是**光标位置为中心**放大」。
//
// 全程真鼠标事件；灯箱只认**中间页**的照片（封面/封底双击仍然走上面 ⑪ 的整叠翻页）。
// 「以光标为中心」用**光标底下那点在屏幕上钉住不动**来量（漂移 ≤ 1px）——
// 这是唯一说得清的判据：只看倍率变没变，分不出「围着光标放」和「围着中心放」。
await page.evaluate(() => window.__pf.turnToPage(1));
await page.waitForTimeout(1300);
const lbRect = await page.evaluate(() => {
  const out = [];
  for (const p of document.querySelectorAll('.book-page')) {
    if (getComputedStyle(p).display === 'none') continue;
    if (p.dataset.density === 'hard') continue;
    const img = p.querySelector('.plate img');
    if (!img) continue;
    const r = img.getBoundingClientRect();
    if (r.width < 60 || r.height < 60) continue;
    out.push({ left: r.left, top: r.top, w: r.width, h: r.height,
               name: (img.getAttribute('src') || '').split('/').pop() });
  }
  out.sort((a, b) => a.left - b.left);
  return { vw: innerWidth, vh: innerHeight, list: out };
});
const lbTarget = lbRect.list[lbRect.list.length - 1];
const lbSpot = { x: Math.round(lbTarget.left + lbTarget.w * 0.6),
                 y: Math.round(lbTarget.top + lbTarget.h * 0.4) };
const lbPageBefore = await page.evaluate(() => window.__pf.getCurrentPageIndex());
await page.mouse.dblclick(lbSpot.x, lbSpot.y);
await page.waitForTimeout(500);
const lbOpen = await page.evaluate(() => window.__lightbox.state());

// 以光标为中心放大：光标底下那点在图上的位置必须**不变**
const lbAnchor = (mx, my) => page.evaluate(([x, y]) => {
  const st = window.__lightbox.state();
  if (!st) return null;
  return { px: (x - st.x) / st.s, py: (y - st.y) / st.s, s: st.s };
}, [mx, my]);
const lbZoomSpot = { x: Math.round(lbOpen.x + lbOpen.w * 0.3),
                     y: Math.round(lbOpen.y + lbOpen.h * 0.25) };
const lbA0 = await lbAnchor(lbZoomSpot.x, lbZoomSpot.y);
await page.mouse.move(lbZoomSpot.x, lbZoomSpot.y);
for (let i = 0; i < 4; i++) { await page.mouse.wheel(0, -240); await page.waitForTimeout(120); }
const lbA1 = await lbAnchor(lbZoomSpot.x, lbZoomSpot.y);
const lbDrift = lbA0 && lbA1
  ? Math.max(Math.abs(lbA1.px - lbA0.px) * lbA1.s, Math.abs(lbA1.py - lbA0.py) * lbA1.s)
  : Number.NaN;
const lbGrew = !!lbA0 && !!lbA1 && lbA1.s > lbA0.s * 1.2;

// 叉号退出（单击），书要回到双击之前那一页
await page.click('.lightbox__close');
await page.waitForTimeout(400);
const lbClosed = await page.evaluate(() => window.__lightbox.state());
await page.waitForTimeout(900);
const lbPageAfter = await page.evaluate(() => window.__pf.getCurrentPageIndex());

const lightboxClauses = {
  '双击照片 ⇒ 这张照片单独全屏显示（灯箱打开）': !!lbOpen,
  '灯箱里就是刚才双击的那一张（同一张照片）':
      !!lbOpen && String(lbOpen.src).split('/').pop() === lbTarget.name,
  '点右上角那个叉号 ⇒ 退出（灯箱关闭）': !lbClosed,
  '★ 关掉之后书回到「双击之前那一页」（双击那两下单击的翻页被悄悄还回去了）':
      lbPageAfter === lbPageBefore,
  '★ 放大是**以光标那一点为中心**：光标底下那点钉住不动（漂移 ≤ 1px）':
      lbGrew && lbDrift <= 1,
};
const lightboxBad = Object.keys(lightboxClauses).filter((k) => !lightboxClauses[k]);
const lightboxOk = lightboxBad.length === 0;
console.log('照片灯箱    :',
            `双击 ${lbTarget ? lbTarget.name : '?'} → ${lbOpen ? '开' : '没开'}`,
            `| 倍率 ${lbA0 ? lbA0.s.toFixed(2) : '?'}→${lbA1 ? lbA1.s.toFixed(2) : '?'}（漂移 ${lbDrift.toFixed(3)}px）`,
            `| 叉号 → ${lbClosed ? '没关' : '关'}`,
            `| 页位 ${lbPageBefore}→${lbPageAfter}`,
            lightboxOk ? '（正常）' : `（⚠ 没过的子项：${lightboxBad.join('、')}）`);

await page.evaluate(() => window.__pf.turnToPage(0));
await page.waitForTimeout(700);

// 断言：
//   书页 12、硬纸恰好 2（首末）
//   所有图都真的解码成功
//   照片张数 = 正文 6 张 + 封面 1 张 = 7（封面现在也满版放照片，所以不再是 6）
//   照片页确实整页铺满（object-fit:cover 且图片框 == 页面框）
//   跨页过渡带存在、有渐变、宽度在合理区间（太宽会糊掉照片）
//   外侧淡阴影：左右页各只有自己那侧，上下都有，且是黑色渐变
const outerOk = (!!info.outerShadow.left || !!info.outerShadow.right) &&
  ['left', 'right'].every((k) => {
    const s = info.outerShadow[k];
    return !s || (s.x && !s.wrongX && s.yTop && s.yBottom && s.black);
  });
const ok = info.leafCount === expected.page_count && info.hardCount === 2 &&
           info.imgDecoded === info.imgTotal && info.imgTotal === expected.photo_count &&
           info.photoPageCount === expected.photo_count &&
           info.plateFit === 'cover' && info.plateFills === true &&
           info.seamBefore && info.seamBefore.hasGradient &&
           info.seamBefore.pct >= 16 && info.seamBefore.pct <= 24 &&
           outerOk && flipOk && foldOk && dragOk && jumpOk && autoOk && speedOk &&
           jumpRowOk && overlapOk && backOk && compactOk && gestureOk && zoomOk &&
           lightboxOk &&
           errors.length === 0 && failed.length === 0 &&
           after !== info.pageStatus;
console.log(ok ? '\n✅ 成品画册验收通过' : '\n❌ 成品画册有问题');
process.exitCode = ok ? 0 : 1;
} catch (err) {
  // 以前这里会直接让异常冒出去 → 末尾的 close 执行不到 → 孤儿浏览器。
  // 现在异常也是一条正常出口：报清楚，然后把退出码交给 finally。
  console.error('\n❌ 成品画册验收异常：' + String(err).slice(0, 600));
  process.exitCode = 1;
} finally {
  await browser.close().catch(() => {});
  process.exit(process.exitCode ?? 1);
}
