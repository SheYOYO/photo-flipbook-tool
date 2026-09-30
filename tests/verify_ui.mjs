/**
 * UI 端到端验收（真实浏览器 / Playwright）—— 选择器严格对齐 app.js 实际渲染
 *
 * 成功路径：
 *   1 首屏加载，缩略图全部渲染
 *   2 跨页预览结构 == 书页数
 *   3 拖拽调序真的回环到服务端
 *   4 改书名 → 服务端 title 变化 + 预览跟着变
 *   4b 书名能删干净（删到空不许被服务端兜底值写回输入框）
 *   5 改单张图版式（先选中）→ 服务端 plate 变化
 *   6 点「生成画册」→ 真实产出 index.html
 *   7 界面代码（js/css）必须是 no-store，改完刷新就能看到
 *   3b 左栏逐张管理：叉号删单张 · 序号点开填位次挪位置（Phase 37）
 *      ★ 序号显示的是**当前位次**（1..N 连续），删除 / 换序 / 挪位后都刷新（Phase 38）
 *   3c 全屏看预览：右下角进真全屏 / 右下角淡叉号退 / 三秒隐形但仍可点（Phase 38）
 * 失败路径：
 *   A 目录里没照片   B 目录不存在   C 损坏图片混入
 *   D 输出目录被文件占位   E 端口占用自动换端口
 *   附加：控制台零错误、零失败请求（证明代理没捣乱）
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.argv[2] || 'http://127.0.0.1:8791';
const OUT = path.resolve('.ui-shots');
fs.mkdirSync(OUT, { recursive: true });

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail}`);
}

/** 用页面自己的 fetch 打后端，天然绕过本机代理 */
async function api(page, route, body) {
  return page.evaluate(async ([r, b]) => {
    const res = await fetch(r, {
      method: b === undefined ? 'GET' : 'POST',
      headers: b === undefined ? {} : { 'Content-Type': 'application/json' },
      body: b === undefined ? undefined : JSON.stringify(b),
    });
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, 300) }; }
    return { status: res.status, data };
  }, [route, body]);
}

const browser = await chromium.launch();   // 默认 headless —— 跑验收不会弹窗口
const page = await browser.newPage({ viewport: { width: 1500, height: 960 } });

// ★ 兜底关闭（与 verify_book_ui.mjs 同款）：
//   末尾 finally 里的 `browser.close()` 只管"脚本自己走到了末尾"。
//   被 Ctrl+C、被宿主掐掉时 Node 直接退出，finally 根本不执行 ⇒
//   留下一只孤儿 chromium + 一个 %TEMP%\playwright_chromiumdev_profile-* 目录。
//   所以把"关浏览器"也挂到信号上。本层每轮验收都要跑，漏一次就攒一个。
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    browser.close().catch(() => {}).finally(() => process.exit(130));
  });
}
// 开发期静态资源带 max-age，验收时强制不吃缓存，否则拿到旧 CSS 会误判
await page.route('**/static/**', (route) =>
  route.continue({ headers: { ...route.request().headers(), 'cache-control': 'no-cache' } }));
await page.route('**/?*', (route) => route.continue());

const consoleErrors = [];
const failedRequests = [];
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('requestfailed', (r) => failedRequests.push(`${r.url()} :: ${r.failure()?.errorText}`));
page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + e.message));

/** 关掉可能挡路的错误弹窗，不让它影响后续点击 */
async function dismissModal() {
  await page.evaluate(() => {
    const m = document.getElementById('modal');
    if (m && !m.hidden) m.hidden = true;
  });
}

try {
  // ---------- 1 首屏 ----------
  await page.goto(BASE + '/?v=' + Date.now(), { waitUntil: 'load' });
  await dismissModal();
  await page.waitForSelector('#grid .card', { timeout: 25000 });
  await page.waitForFunction(() => {
    const imgs = [...document.querySelectorAll('#grid .card img')];
    return imgs.length > 0 && imgs.every((i) => i.complete && i.naturalWidth > 0);
  }, { timeout: 25000 });

  const cards = await page.locator('#grid .card').count();
  const thumbOk = await page.evaluate(() =>
    [...document.querySelectorAll('#grid .card img')].every((i) => i.naturalWidth > 0));
  const chip = await page.textContent('#chip-photos');
  record('成功1 首屏缩略图', cards === 6 && thumbOk, `${cards} 张卡片全解码；角标「${chip}」`);
  await page.screenshot({ path: path.join(OUT, '01-first-load.png'), fullPage: true });

  // ---------- 2 跨页预览结构 ----------
  const st = await page.evaluate(() => {
    const spreads = [...document.querySelectorAll('#spreads .spread')];
    return {
      spreadCount: spreads.length,
      pageCount: spreads.reduce((n, s) => n + s.querySelectorAll('.page').length, 0),
      hasCover: !!document.querySelector('#spreads .spread .cover-wrap'),
    };
  });
  // ★ 期望值**从服务端的排版方案推算**，不写死 —— 页数会随张数/构图变，
  //   而「前言 4 页、后记 4 页、正文按跨页摆」这套规则是唯一事实来源。
  //
  //   ★★ 跨页数不是简单的 `页数 / 2`：预览里**封面单独占第一组**
  //      （showCover=true，封面必须自己亮一面），剩下的页才是两页一组。
  //      所以 `页数 = 1 + 2 * (跨页数 - 1)` → `跨页数 = 1 + ceil((页数 - 1) / 2)`。
  //      16 页 → 1 + 8 = 9 组。曾经按 `ceil(pageCount / 2)` 算（得 8），
  //      于是每次都是「跨页 9 组（期望 8）」这种假红。
  //      更早还写死过 `spreadCount === 7 && pageCount === 12`（对应旧的前言 3 页），
  //      前言改成 4 页后 6 张照片变 10 组，断言同样假红。
  const planPages = (await api(page, '/api/plan')).data.plan.pageCount;
  const showCover = true;
  const expectSpreads = showCover
    ? 1 + Math.ceil((planPages - 1) / 2)
    : Math.ceil(planPages / 2);
  record('成功2 跨页预览结构',
    st.spreadCount === expectSpreads && st.pageCount === planPages && st.hasCover,
    `跨页 ${st.spreadCount} 组（期望 ${expectSpreads}）/ 书页 ${st.pageCount} 页（期望 ${planPages}）/ 封面${st.hasCover ? '在' : '缺'}`);
  await page.screenshot({ path: path.join(OUT, '02-spread-preview.png'), fullPage: true });

  // ---------- 3 拖拽调序 ----------
  const before = (await api(page, '/api/plan')).data.plan.photos.map((p) => p.name);
  await page.evaluate(() => {
    const cards = [...document.querySelectorAll('#grid .card')];
    const dt = new DataTransfer();
    cards[0].dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
    cards[2].dispatchEvent(new DragEvent('dragover', { bubbles: true, dataTransfer: dt }));
    cards[2].dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: dt }));
  });
  await page.waitForTimeout(1500);
  const after = (await api(page, '/api/plan')).data.plan.photos.map((p) => p.name);
  const expect = [before[1], before[2], before[0], ...before.slice(3)];
  record('成功3 拖拽调序',
    JSON.stringify(after) === JSON.stringify(expect),
    `第 1 张拖到第 3 位 → ${after.slice(0, 3).map((n) => n.slice(-8)).join(' → ')}`);
  await page.screenshot({ path: path.join(OUT, '03-after-drag.png'), fullPage: true });

  // ---------- 3b 左栏逐张管理：叉号删 / 序号挪（Phase 37） ----------
  //
  // ★ 为什么这组判据要**永久留在这里**（不是一次性探针）：
  //   叉号与序号组块长在每一张卡片上，任何一次 renderGrid() 的改动都可能
  //   把它们碰掉 —— 而"碰掉"不会让别的断言变红（卡片数、图解码、拖拽都还正常）。
  //   所以必须有一条守着"这两个组块真的在、真的能用"的常驻断言。
  //
  // ★★ 隔离纪律（本轮真踩过）：
  //   这三段会**真的改服务端状态**（删照片、重排）。而第 3 步刚做过一次拖拽调序，
  //   第 6 步的 `orderOk` 断言**依赖那次拖拽的结果**（"145929 排在 145907 前面"）。
  //   所以收尾**绝不能**用 `/api/scan` 重扫 —— 那会把次序重新洗回扫描序，
  //   第 6 步就会红成「顺序错误」，而红的地方离真正的原因隔了两百行。
  //   正解：进来先把**(删之前的)完整图纸**拍下来，收尾时把次序和照片原样提交回去。
  //
  // ★ 位置口径用**数值坐实**（铁律 9）：叉号中心要落在图片矩形的右上四分之一内，
  //   序号组块要落在图片下方那一行的左半边。光"元素存在"不算数。
  const snapshot3b = (await api(page, '/api/plan')).data.plan.photos;
  const p37 = await page.evaluate(() => {
    const cs = [...document.querySelectorAll('#grid .card')];
    const probe = (c) => {
      const img = c.querySelector('img');
      const idx = c.querySelector('.card-idx');
      const del = c.querySelector('.card-del');
      const meta = c.querySelector('.card-meta');
      if (!img || !idx || !del || !meta) return null;
      const ri = img.getBoundingClientRect();
      const rd = del.getBoundingClientRect();
      const rx = idx.getBoundingClientRect();
      const rm = meta.getBoundingClientRect();
      return {
        order: Number(c.dataset.order),
        idxText: idx.textContent.trim(),
        delInTopRight: (rd.x + rd.width / 2) > ri.x + ri.width / 2
          && (rd.y + rd.height / 2) < ri.y + ri.height / 2
          && (rd.x + rd.width / 2) >= ri.x && (rd.y + rd.height / 2) >= ri.y,
        idxInLeftBottom: Math.abs((rx.x + rx.width / 2) - (rm.x + rm.width * 0.25)) < rm.width * 0.4
          && Math.abs((rx.y + rx.height / 2) - (rm.y + rm.height / 2)) < 3,
      };
    };
    return { all: cs.length, probed: cs.map(probe).filter(Boolean) };
  });
  record('成功3b 每张卡片都有叉号 + 序号组块',
    p37.probed.length === p37.all && p37.probed.length > 0,
    `${p37.probed.length}/${p37.all} 张齐全`);
  record('成功3b 叉号在图片右上角 / 序号在左下角（数值坐实）',
    p37.probed.every((p) => p.delInTopRight && p.idxInLeftBottom),
    `右上 ${p37.probed.filter((p) => p.delInTopRight).length}/${p37.probed.length}，` +
    `左下 ${p37.probed.filter((p) => p.idxInLeftBottom).length}/${p37.probed.length}`);
  record('成功3b 序号组块显示的是**当前位次**（1、2、3…连续）',
    p37.probed.every((p, i) => p.idxText === String(i + 1)),
    p37.probed.map((p) => p.idxText).join(','));

  // ---- 序号组块：点一下就地变输入框，填位次回车即挪 ----
  {
    const beforeIdx = await page.evaluate(() =>
      [...document.querySelectorAll('#grid .card')].map((c) => Number(c.dataset.order)));
    const mover = beforeIdx[0];
    const expectIdx = beforeIdx.slice();
    expectIdx.splice(2, 0, expectIdx.splice(0, 1)[0]);   // 第 1 张 → 第 3 位

    await page.locator('#grid .card').first().locator('.card-idx').click();
    await page.waitForTimeout(160);
    const hasInput = await page.evaluate(() => {
      const i = document.querySelector('#grid .card .card-idx input');
      return !!i && document.activeElement === i;
    });
    record('成功3b 点序号组块 → 就地出现输入框并拿到焦点', hasInput, '');

    await page.locator('#grid .card .card-idx input').fill('3');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(900);

    const gotIdx = await page.evaluate(() =>
      [...document.querySelectorAll('#grid .card')].map((c) => Number(c.dataset.order)));
    const srvIdx = (await api(page, '/api/plan')).data.plan.photos.map((p) => p.order);
    record('成功3b ★ 填 3 → 照片挪到第 3 位，其余顺位让开',
      JSON.stringify(gotIdx) === JSON.stringify(expectIdx)
      && JSON.stringify(srvIdx) === JSON.stringify(gotIdx),
      `${gotIdx.slice(0, 5).join(',')}…（原第 1 张=${mover} 现在第 3 位=${gotIdx[2]}）`);
    // ★ 编号不重编号：集合必须一模一样，只有次序变了
    record('成功3b ★ 挪位只是换次序，照片编号集合没变（不重编号）',
      JSON.stringify([...gotIdx].sort((a, b) => a - b))
      === JSON.stringify([...beforeIdx].sort((a, b) => a - b)), '');

    // ★ 序号要**跟着位次刷新**（Phase 38）—— 挪完必须重排成 1..N，
    //   而不是留着照片原来的身份号。这条是佘先生明确要求的那个「不更新」。
    const idxAfterMove = await page.evaluate(() =>
      [...document.querySelectorAll('#grid .card .card-idx')].map((e) => e.textContent.trim()));
    record('成功3b ★ 挪位后序号刷新为当前位次（1..N 连续，不留旧号）',
      JSON.stringify(idxAfterMove) === JSON.stringify(gotIdx.map((_, i) => String(i + 1))),
      idxAfterMove.join(','));

    // ---- 越界 / 非法 → 默默退回原位，不报错 ----
    const guardBefore = gotIdx.slice();
    for (const bad of ['9999', '0', 'abc']) {
      await page.locator('#grid .card').first().locator('.card-idx').click();
      await page.waitForTimeout(130);
      await page.locator('#grid .card .card-idx input').fill(bad);
      await page.keyboard.press('Enter');
      await page.waitForTimeout(450);
    }
    const guardAfter = await page.evaluate(() =>
      [...document.querySelectorAll('#grid .card')].map((c) => Number(c.dataset.order)));
    const modalUp = await page.evaluate(() => !document.getElementById('modal').hidden);
    record('成功3b ★ 填越界/非法数 → 退回原位且不弹错（他明确选的"不理它"）',
      JSON.stringify(guardAfter) === JSON.stringify(guardBefore) && !modalUp,
      `次序未变=${JSON.stringify(guardAfter) === JSON.stringify(guardBefore)}，弹窗=${modalUp}`);
  }

  // ---- 叉号：删一张，其余编号保持不变 ----
  {
    const beforeDel = await page.evaluate(() =>
      [...document.querySelectorAll('#grid .card')].map((c) => ({
        order: Number(c.dataset.order), src: c.querySelector('img').getAttribute('src'),
      })));
    const victim = beforeDel[1];
    const delBox = await page.evaluate(() => {
      const d = document.querySelectorAll('#grid .card')[1].querySelector('.card-del');
      const r = d.getBoundingClientRect();
      return { cx: r.x + r.width / 2, cy: r.y + r.height / 2 };
    });
    await page.mouse.click(delBox.cx, delBox.cy);        // ★ 按实际位置点
    await page.waitForTimeout(1000);

    const afterDel = await page.evaluate(() =>
      [...document.querySelectorAll('#grid .card')].map((c) => ({
        order: Number(c.dataset.order), src: c.querySelector('img').getAttribute('src'),
      })));
    const srvDel = (await api(page, '/api/plan')).data.plan.photos;
    record('成功3b ★ 点叉号 → 正好少掉那一张（按缩略图 src 认）',
      afterDel.length === beforeDel.length - 1
      && !afterDel.some((c) => c.src === victim.src)
      && !srvDel.some((p) => p.order === victim.order),
      `${beforeDel.length} → ${afterDel.length}，被删 order=${victim.order}`);
    record('成功3b ★ 删完剩下照片的编号与相对次序都没变（不重编号）',
      JSON.stringify(afterDel.map((c) => c.order))
      === JSON.stringify(beforeDel.filter((c) => c.order !== victim.order).map((c) => c.order)),
      '');

    // ★ 删完也要重排成 1..N-1 —— 以前这里会缺号（1、2、4…），是他不要的做法。
    const idxAfterDel = await page.evaluate(() =>
      [...document.querySelectorAll('#grid .card .card-idx')].map((e) => e.textContent.trim()));
    record('成功3b ★ 删一张后序号收敛成 1..N-1（不再缺号）',
      JSON.stringify(idxAfterDel) === JSON.stringify(afterDel.map((_, i) => String(i + 1))),
      idxAfterDel.join(','));
    // ★ 缩略图取图键仍有效 —— 这是"没被重编号"最硬的证据
    const thumbStill = await page.evaluate(async (o) => {
      const r = await fetch(`/thumb?id=${o}`, { cache: 'no-store' });
      return { s: r.status, n: (await r.blob()).size };
    }, afterDel[0].order);
    record('成功3b ★ 删/排之后 /thumb 仍按原编号取到图',
      thumbStill.s === 200 && thumbStill.n > 1000,
      `HTTP ${thumbStill.s} ${thumbStill.n}B`);

    // ---- 反向自证：证明上面这些不是假绿 ----
    // 人为拿掉一个叉号，确认"叉号数会真的少一个"——说明判据看得见红。
    const neg = await page.evaluate(() => {
      const n0 = document.querySelectorAll('#grid .card .card-del').length;
      document.querySelector('#grid .card .card-del')?.remove();
      return { n0, n1: document.querySelectorAll('#grid .card .card-del').length };
    });
    record('成功3b 负向自证：人为拿掉叉号后计数真的少 1（判据看得见红）',
      neg.n1 === neg.n0 - 1, `${neg.n0} → ${neg.n1}`);
    // 恢复：让前端重画一次网格（点一下序号组块再按 Esc 就会重画）——
    // 这样不用动服务端状态，也不会污染后面的断言。
    await page.locator('#grid .card').first().locator('.card-idx').click();
    await page.waitForTimeout(150);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(400);
    const repaired = await page.evaluate(() => {
      const cs = document.querySelectorAll('#grid .card').length;
      const ds = document.querySelectorAll('#grid .card .card-del').length;
      return { cs, ds };
    });
    record('成功3b 负向自证后界面恢复正常（每张卡片又都有叉号）',
      repaired.cs > 0 && repaired.ds === repaired.cs, `${repaired.ds}/${repaired.cs}`);

    // ---- 只剩一张时不许删光 ----
    // 直接删到只剩第一张（服务端一次请求就能删多张，且会拒绝"全删光"）。
    await page.evaluate(async () => {
      const p = await (await fetch('/api/plan', { cache: 'no-store' })).json();
      const orders = p.plan.photos.map((x) => x.order);
      await fetch('/api/plan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ remove: orders.slice(1) }),
      });
    });
    await page.reload({ waitUntil: 'load' });
    await page.waitForSelector('#grid .card', { timeout: 20000 });
    await page.waitForTimeout(600);
    const oneLeft = await page.evaluate(() => document.querySelectorAll('#grid .card').length);
    const delLast = await page.evaluate(() => {
      const d = document.querySelector('#grid .card .card-del');
      const r = d.getBoundingClientRect();
      return { cx: r.x + r.width / 2, cy: r.y + r.height / 2 };
    });
    await page.mouse.click(delLast.cx, delLast.cy);
    await page.waitForTimeout(800);
    const stillOne = await page.evaluate(() => document.querySelectorAll('#grid .card').length);
    const guardMsg = await page.evaluate(() => {
      const m = document.getElementById('modal');
      return { hidden: m.hidden, text: (m.querySelector('#modal-body') || {}).textContent || '' };
    });
    record('成功3b ★ 只剩一张时点叉号 → 拦住并给人话提示',
      oneLeft === 1 && stillOne === 1 && !guardMsg.hidden && /至少|留一张|删光/.test(guardMsg.text),
      `点之前 ${oneLeft} 张、点之后 ${stillOne} 张；提示「${guardMsg.text.slice(0, 22)}」`);
    await dismissModal();

    // ---- 收尾还原 ----
    // ★ 必须**重扫素材目录**（把被删掉的几张弄回来，因为 `/api/plan` 没有"加回来"的口子），
    //   然后**再把次序提交回快照里的原样** —— 重扫会把次序洗成扫描序，
    //   而第 6 步的 orderOk 依赖第 3 步拖拽后的次序。
    const srcDir = (await api(page, '/api/plan')).data.plan.sourceDir;
    await api(page, '/api/scan', { path: srcDir });
    const restoreOrders = snapshot3b.map((p) => p.order);
    await api(page, '/api/plan', { order: restoreOrders });
    // 顺手把版式也恢复（第 5 步会把某张改成 small，但那是第 5 步之后的事，这里不动它）
    await page.reload({ waitUntil: 'load' });
    await page.waitForSelector('#grid .card', { timeout: 20000 });
    await page.waitForFunction(() => {
      const imgs = [...document.querySelectorAll('#grid .card img')];
      return imgs.length > 0 && imgs.every((i) => i.complete && i.naturalWidth > 0);
    }, { timeout: 25000 });
    const after3b = (await api(page, '/api/plan')).data.plan.photos.map((p) => p.order);
    record('成功3b 收尾：照片与次序都还原成跑这组判据之前的原样',
      after3b.length === snapshot3b.length
      && JSON.stringify(after3b) === JSON.stringify(restoreOrders),
      `现 ${after3b.length} 张，次序 ${after3b.join(',')}（应为 ${restoreOrders.join(',')}）`);
  }

  // ---------- 3c 全屏看预览：右下角进、右下角淡叉号退（Phase 38） ----------
  //
  // 佘先生（2026-09-30）：「我想要电脑整个屏幕的全屏显示的功能，就是新增一个组块
  //   在工具的右下角，主要不是在图片上，我点击进入真正的全屏，右下角再放一个叉号的
  //   组件用于退出全屏，注意叉号的颜色要淡，不能抢眼，当没有操作三秒后时叉号不显示，
  //   但在相应的位置仍有其功能，当我再次操作时比如光标移动和翻页时叉号显示」。
  //   他选的那一项：进全屏后**只留中间那栏跨页预览**。
  //
  // ★ 这里量的是**浏览器真全屏**（Fullscreen API），不是"看起来铺满了" ——
  //   fullscreenElement / :fullscreen / fs-mode 三个都要对上。实测无头 Chromium
  //   支持真全屏，所以这条是真判据，没有打桩、没有假绿。
  // ★ 「隐形但仍有功能」是本组最要紧的一条：光断言"看不见"会把
  //   display:none 那种连点击一起没了的实现放过去 —— 所以必须**在隐形状态下
  //   真点一下**，并确认它真退出了全屏。
  // ⚠ 键盘 Esc 退全屏是**浏览器外壳的行为**，无头 Chromium 不响应（已取证：
  //   按 Esc 前后 fullscreenElement 都是 true）。所以退出这条路量的是
  //   **点叉号**（＝ exitFullscreen），不是 Esc。
  {
    const entryBox = await page.evaluate(() => {
      const b = document.getElementById('btn-full');
      if (!b) return null;
      const r = b.getBoundingClientRect();
      const col = b.closest('.panel-settings').getBoundingClientRect();
      const foot = b.closest('.panel-foot').getBoundingClientRect();
      return {
        visible: !b.hidden && b.offsetParent !== null,
        rightBottom: (r.x + r.width / 2) > col.x + col.width * 0.5
          && (r.y + r.height / 2) > foot.y && r.right > col.right - 40,
      };
    });
    record('成功3c 工具右下角有「全屏看预览」组块（位置数值坐实）',
      !!(entryBox && entryBox.visible && entryBox.rightBottom), JSON.stringify(entryBox));

    await page.locator('#btn-full').click();
    await page.waitForTimeout(700);
    const fsOn = await page.evaluate(() => {
      const vis = (s) => {
        const e = document.querySelector(s);
        if (!e) return null;
        const c = getComputedStyle(e);
        return c.display !== 'none' && c.visibility !== 'hidden';
      };
      const pp = document.querySelector('.panel-preview').getBoundingClientRect();
      const ex = document.getElementById('fs-exit');
      const cs = getComputedStyle(ex);
      const er = ex.getBoundingClientRect();
      const m = /rgba?\(([^)]+)\)/.exec(cs.color);
      const parts = m ? m[1].split(',') : [];
      return {
        real: !!document.fullscreenElement,
        matches: document.documentElement.matches(':fullscreen'),
        cls: document.documentElement.classList.contains('fs-mode'),
        gone: !vis('.topbar') && !vis('.panel-photos') && !vis('.panel-settings'),
        previewVisible: vis('.panel-preview'),
        covers: Math.abs(pp.width - window.innerWidth) < 2
          && Math.abs(pp.height - window.innerHeight) < 2,
        spreadsW: document.querySelector('.spreads').getBoundingClientRect().width,
        display: cs.display,
        alpha: parts.length === 4 ? Number(parts[3]) : 1,
        opacity: Number(cs.opacity),
        rightGap: window.innerWidth - er.right,
        bottomGap: window.innerHeight - er.bottom,
        vw: window.innerWidth,
        vh: window.innerHeight,
      };
    });
    record('成功3c ★ 点它进的是浏览器真全屏（不是自己画个铺满的层）',
      fsOn.real && fsOn.matches && fsOn.cls,
      `fullscreenElement=${fsOn.real} :fullscreen=${fsOn.matches} fs-mode=${fsOn.cls}`);
    record('成功3c ★ 全屏里只留中间那栏预览，并且铺满整屏',
      fsOn.gone && fsOn.previewVisible && fsOn.covers,
      `顶栏/左栏/右栏都收起=${fsOn.gone}；预览盖住视口(${fsOn.vw}x${fsOn.vh})=${fsOn.covers}；跨页宽 ${Math.round(fsOn.spreadsW)}px`);
    record('成功3c 退出叉号在屏幕右下角、颜色淡（不抢眼）',
      fsOn.display === 'flex' && fsOn.rightGap > 0 && fsOn.rightGap < 60
      && fsOn.bottomGap > 0 && fsOn.bottomGap < 60 && fsOn.alpha <= 0.5,
      `display=${fsOn.display} 距右/下 ${Math.round(fsOn.rightGap)}/${Math.round(fsOn.bottomGap)}px 颜色透明度=${fsOn.alpha}`);
    await page.screenshot({ path: path.join(OUT, '03c-fullscreen.png') });

    // ---- 三秒没操作 → 隐形；但位置与点击都还在 ----
    await page.waitForTimeout(3600);
    const idle = await page.evaluate(() => {
      const e = document.getElementById('fs-exit');
      const cs = getComputedStyle(e);
      const r = e.getBoundingClientRect();
      return {
        idle: e.classList.contains('is-idle'), opacity: Number(cs.opacity),
        display: cs.display, visibility: cs.visibility,
        w: r.width, h: r.height, cx: r.x + r.width / 2, cy: r.y + r.height / 2,
      };
    });
    record('成功3c ★ 三秒没操作 → 叉号隐形',
      idle.idle && idle.opacity === 0, `is-idle=${idle.idle} opacity=${idle.opacity}`);
    record('成功3c ★ 隐形是「变透明」不是「移除」（位置与尺寸都还在）',
      idle.display === 'flex' && idle.visibility !== 'hidden' && idle.w > 0 && idle.h > 0,
      `display=${idle.display} visibility=${idle.visibility} ${Math.round(idle.w)}x${Math.round(idle.h)}`);
    await page.screenshot({ path: path.join(OUT, '03c-idle.png') });

    // ★★ 隐形状态下真点一下 —— 这是「仍有其功能」唯一算数的证据。
    await page.mouse.click(idle.cx, idle.cy);
    await page.waitForTimeout(700);
    const quit = await page.evaluate(() => ({
      real: !!document.fullscreenElement,
      cls: document.documentElement.classList.contains('fs-mode'),
      topbar: getComputedStyle(document.querySelector('.topbar')).display,
      exitDisplay: getComputedStyle(document.getElementById('fs-exit')).display,
    }));
    record('成功3c ★★ 隐形状态下点那块地方 → 仍退得出全屏（"相应位置仍有其功能"）',
      !quit.real && !quit.cls && quit.topbar !== 'none' && quit.exitDisplay === 'none',
      `fullscreenElement=${quit.real} fs-mode=${quit.cls} 顶栏=${quit.topbar} 叉号=${quit.exitDisplay}`);

    // ---- 再进去：光标一动，叉号重新显形 ----
    await page.locator('#btn-full').click();
    await page.waitForTimeout(600);
    await page.waitForTimeout(3600);
    const idleAgain = await page.evaluate(() =>
      document.getElementById('fs-exit').classList.contains('is-idle'));
    await page.mouse.move(320, 320);
    await page.waitForTimeout(800);   // 淡入 .5s，等它走完再量 —— 这里吃过一次"量到半路"的假红
    const poked = await page.evaluate(() => {
      const e = document.getElementById('fs-exit');
      return { idle: e.classList.contains('is-idle'), opacity: Number(getComputedStyle(e).opacity) };
    });
    record('成功3c ★ 隐形后光标一动 → 叉号重新显形',
      idleAgain && !poked.idle && poked.opacity === 1,
      `动之前 idle=${idleAgain}；动之后 idle=${poked.idle} opacity=${poked.opacity}`);

    // ---- 滚轮也算"在操作"（＝翻到下一组跨页）----
    // ⚠ 这里**故意先不移动光标**：移动本身就会把叉号叫出来，那就测不出滚轮了。
    await page.waitForTimeout(3600);
    const wheelBefore = await page.evaluate(() => ({
      idle: document.getElementById('fs-exit').classList.contains('is-idle'),
      sc: document.querySelector('.preview-scroll').scrollTop,
    }));
    await page.mouse.wheel(0, 240);
    await page.waitForTimeout(300);
    const wheelAfter = await page.evaluate(() => ({
      idle: document.getElementById('fs-exit').classList.contains('is-idle'),
      sc: document.querySelector('.preview-scroll').scrollTop,
    }));
    record('成功3c ★ 隐形后滚一下（＝翻到下一组跨页）→ 叉号也显形',
      wheelBefore.idle && !wheelAfter.idle && wheelAfter.sc > wheelBefore.sc,
      `滚之前 idle=${wheelBefore.idle}；滚之后 idle=${wheelAfter.idle}；预览 ${Math.round(wheelBefore.sc)} → ${Math.round(wheelAfter.sc)}px`);

    // ---- 收尾：退出来，界面必须收回原样（后面的步骤全依赖左右两栏可见）----
    await page.evaluate(() => { if (document.fullscreenElement) document.exitFullscreen(); });
    await page.waitForTimeout(700);
    const closed = await page.evaluate(() => ({
      real: !!document.fullscreenElement,
      cls: document.documentElement.classList.contains('fs-mode'),
      topbar: getComputedStyle(document.querySelector('.topbar')).display,
      photos: getComputedStyle(document.querySelector('.panel-photos')).display,
      exitDisplay: getComputedStyle(document.getElementById('fs-exit')).display,
      idle: document.getElementById('fs-exit').classList.contains('is-idle'),
    }));
    record('成功3c 收尾：退出后界面收回原样，不给后面的步骤留状态',
      !closed.real && !closed.cls && closed.topbar !== 'none' && closed.photos !== 'none'
      && closed.exitDisplay === 'none' && !closed.idle,
      `fs-mode=${closed.cls} 顶栏=${closed.topbar} 左栏=${closed.photos} 叉号=${closed.exitDisplay}`);
  }

  // ---------- 4 改书名 ----------
  await page.fill('#input-title', '小虎的夏天');
  await page.waitForTimeout(1200); // 等 420ms 防抖 + 往返
  const titleInPlan = (await api(page, '/api/plan')).data.plan.title;
  const titleInPreview = await page.evaluate(() =>
    document.querySelector('#spreads')?.innerText?.includes('小虎的夏天') ?? false);
  record('成功4 改书名同步', titleInPlan === '小虎的夏天' && titleInPreview,
    `服务端 title=「${titleInPlan}」，预览${titleInPreview ? '已' : '未'}显示`);
  await page.screenshot({ path: path.join(OUT, '04-title-changed.png'), fullPage: true });

  // ---------- 4b 书名能删干净 ----------
  // 曾经的 bug：服务端把空书名兜底成默认书名，回包又被写回输入框 →
  // 删掉最后一个字的 420ms 后，原文字自己回来，用户永远删不干净。
  // 判据只看行为：用户最后一次按键之后没有再输入，输入框的值就不许再变。
  await page.click('#input-title');
  await page.keyboard.press('Control+A');
  await page.keyboard.press('Backspace');
  const justCleared = await page.inputValue('#input-title');
  await page.waitForTimeout(1400);            // 420ms 防抖 + 往返 + 余量
  const stillEmpty = await page.inputValue('#input-title');
  record('成功4b 书名能删干净', justCleared === '' && stillEmpty === '',
    `全选退格后 value=「${stillEmpty}」（旧版本会被写回「我的小狗」）`);

  const fallback = (await api(page, '/api/plan')).data.plan.title;
  record('成功4c 删空仍按默认书名出书', fallback === '我的小狗',
    `服务端 title=「${fallback}」（兜底逻辑没被改动）`);

  // 再触发一次真正的重渲染（改版式 → applyPlan → renderStatus），空状态不许被顶回来。
  // ★ 刻意选第 2 张卡（不是后面第 5 步要用的第 4 张）：点同一张会「取消选中」，
  //   把后面的 #selected-box 断言等空。
  await page.locator('#grid .card').nth(1).click();
  await page.waitForSelector('#selected-box:not([hidden])', { timeout: 8000 });
  await page.click('#plate-options button[data-plate="medium"]');
  await page.waitForTimeout(1200);
  const afterRerender = await page.inputValue('#input-title');
  record('成功4d 重渲染后仍然空着', afterRerender === '',
    `改版式触发重渲染后 value=「${afterRerender}」`);
  await page.click('#btn-close-sel');       // 还原选中状态，别影响后面
  await page.waitForTimeout(300);

  const hintShown = await page.evaluate(() => {
    const h = document.getElementById('hint-title');
    return h && !h.hidden ? h.textContent : '';
  });
  record('成功4e 留空有说明小字', hintShown.includes('我的小狗'),
    `输入框下面显示「${hintShown}」`);
  await page.screenshot({ path: path.join(OUT, '04b-title-cleared.png'), fullPage: true });

  // 恢复成自定义书名：后面的「生成画册」还要用它
  await page.fill('#input-title', '小虎的夏天');
  await page.waitForTimeout(1400);

  // ---------- 5 改单张图版式 ----------
  await dismissModal();
  // 必须先点选一张卡片，右侧「版面」面板才出现
  await page.locator('#grid .card').nth(3).click();
  await page.waitForSelector('#selected-box:not([hidden])', { timeout: 8000 });
  const selOrder = await page.evaluate(() => {
    const sel = document.querySelector('#grid .card.selected');
    return sel ? Number(sel.dataset.order) : null;
  });
  await page.click('#plate-options button[data-plate="small"]');
  await page.waitForTimeout(1200);
  const plateNow = (await api(page, '/api/plan')).data.plan.photos
    .find((p) => p.order === selOrder)?.plate;
  const plateBadge = await page.evaluate(() =>
    document.querySelector('#grid .card.selected .card-plate')?.textContent ?? '');
  record('成功5 改版式同步', plateNow === 'small',
    `第 ${selOrder} 张 → ${plateNow}（卡片显示「${plateBadge}」）`);
  await page.screenshot({ path: path.join(OUT, '05-plate-changed.png'), fullPage: true });

  // ---------- 6 真的出书 ----------
  // ★ 书的落点由 /api/generate 自己报（indexHtml），不要拿 outputDir 去拼：
  //   outputDir 是「画册集」，书进的是它下面的「书名」子文件夹。
  //   照旧拼下来只会得到 画册集/index.html，一个永远不存在的路径。
  const albumDir = (await api(page, '/api/plan')).data.plan.outputDir;
  // 出书只能点按钮触发（生成是 POST）。顺手把这一路的回包接下来看落点。
  const genWait = page.waitForResponse(
    (r) => r.url().includes('/api/generate') && r.request().method() === 'POST',
    { timeout: 90000 });
  await page.click('#btn-generate');
  const genResult = await (await genWait).json();
  await page.waitForSelector('#after-gen:not([hidden])', { timeout: 90000 });
  await page.waitForTimeout(800);
  const indexHtml = genResult.indexHtml || '';
  const bookExists = !!indexHtml && fs.existsSync(indexHtml);
  const html = bookExists ? fs.readFileSync(indexHtml, 'utf8') : '';
  // 运行时用的类名是 book-page（article 元素），不是 .page
  const bookPages = (html.match(/class="[^"]*book-page[^"]*"/g) || []).length;
  const hardLeaves = (html.match(/data-density="hard"/g) || []).length;
  // 契约：首尾两张硬纸，中间不硬
  const contractOk = hardLeaves === 2;
  // 书名与顺序应体现在成品里
  const hasTitle = html.includes('小虎的夏天');
  const orderOk = html.indexOf('IMG_20260724_145929') < html.indexOf('IMG_20260724_145907');
  // ★ 页数从**这本书自己的 book-plan.json** 读，不写死（第 12/13 轮的教训：
  //   写死 `=== 12` 会在张数或构图一变时集体假红）。
  // ⚠ 这里原来还断言 `bookPages % 4 === 0`。那条是**错设的假设**：
  //   `runtime/vendor/page-flip.browser.js` 里没有 %2/%4，`runtime/flipbook.js`
  //   里也没有任何页数断言；实测 102/103 页的书都能正常翻（见 `_probe_t.mjs`）。
  //   改成断言**页数账**：封面 + 照片页 + 版权页 + 封底 = 照片数 + 3。
  let planPageCount = 0;
  let planPhotoCount = 0;
  try {
    const planPath = path.join(path.dirname(indexHtml), 'book-plan.json');
    const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));
    planPageCount = plan.page_count;
    planPhotoCount = (plan.photos || []).length;
  } catch { /* 读不到就走下面的失败分支 */ }
  const pagesOk = planPageCount > 0
    && bookPages === planPageCount
    && bookPages === planPhotoCount + 3;
  record('成功6 生成画册',
    bookExists && pagesOk && contractOk && hasTitle && orderOk,
    bookExists
      ? `index.html 含 ${bookPages} 页（book-plan 记 ${planPageCount}，${planPhotoCount} 张照片，应为 ${planPhotoCount + 3} 页）、硬纸 ${hardLeaves} 张、书名${hasTitle ? '已' : '未'}写入、顺序${orderOk ? '正确' : '错误'}`
      : '没找到 index.html');
  // ★ 出书的落点必须比画册集再深一层（画册集/<书名>/index.html），
  //   绝不能把书平铺在画册集根上。这条曾经漏掉，结果出一次书就把画册集搞乱一次。
  const bookDir = indexHtml ? path.dirname(indexHtml) : '';
  const inSubfolder = !!bookDir
    && path.dirname(bookDir) === path.resolve(albumDir)
    && path.basename(bookDir) === '小虎的夏天';
  record('成功6b 书落在画册集的子文件夹里', inSubfolder,
    inSubfolder
      ? `画册集/${path.basename(bookDir)}/ （书不在画册集根上）`
      : `画册集=${albumDir} 书=${bookDir}`);
  await page.screenshot({ path: path.join(OUT, '06-generated.png'), fullPage: true });

  // ---------- 7 界面代码不许被浏览器缓存 ----------
  // 曾经的坑：静态资源统一 max-age=3600，改了 app.js / style.css 之后刷新还是旧副本，
  // 现象是「改动没生效」，排查方向会被带偏。代码类资源必须是 no-store。
  const staticCache = await page.evaluate(async () => {
    const out = {};
    for (const url of ['/static/app.js', '/static/style.css']) {
      const r = await fetch(url, { cache: 'no-store' });
      out[url] = r.headers.get('cache-control') || '';
    }
    return out;
  });
  const noStore = Object.values(staticCache).every((v) => v.includes('no-store'));
  record('成功7 界面代码不缓存', noStore,
    Object.entries(staticCache).map(([k, v]) => `${k.split('/').pop()}=${v || '(无)'}`).join('、'));

  // 成功路径跑完：此刻控制台必须干净（后面故意打错的请求另算）
  record('代理干扰下页面可用', consoleErrors.length === 0 && failedRequests.length === 0,
    `控制台错误 ${consoleErrors.length}、失败请求 ${failedRequests.length}` +
    (consoleErrors.length ? ` → ${consoleErrors[0].slice(0, 120)}` : ''));
  const successPhaseErrors = consoleErrors.length;

  // ---------- 8 封面文案编辑窗口（Phase 24 起；Phase 25 改成弹窗）----------
  //   佘先生（2026-09-25）：「把封面文案样式那里改成点击唤起编辑封面的窗口，
  //   窗口处要可以移动文字框，编辑文字的大小、字体、颜色，
  //   然后点击确定后返回工具的主窗口」。
  //
  //   ★ 这里必须**跨进 iframe 里量计算样式**，不能只看界面上的滑块值。
  //     "滑块动了、预览没跟着动"正是这个功能最可能的坏法，只看滑块值会全绿放过。
  //   ★ 拖动必须用 `page.mouse` **打真事件** —— 手工 `dispatchEvent` 打不到
  //     那个命中框上的 pointerdown 监听器，会假通过。
  const entryHidden = await page.evaluate(() => document.getElementById('cover-entry').hidden);
  record('成功8 有照片时右栏出现「封面文案样式」入口', entryHidden === false, `hidden=${entryHidden}`);
  record('成功8 没点之前不拉预览（不白起一个文档）', await page.evaluate(() => {
    const f = document.getElementById('cover-frame');
    const src = f.getAttribute('src');
    return !src || src === 'about:blank';
  }), 'iframe 无 src');
  const modalClosed = await page.evaluate(() => document.getElementById('cover-modal').hidden);
  record('成功8 编辑窗口默认是关着的（不打扰不调封面的人）', modalClosed === true,
    `cover-modal.hidden=${modalClosed}`);

  await page.click('#cover-open');
  await page.waitForTimeout(200);
  const modalOpened = await page.evaluate(() => document.getElementById('cover-modal').hidden === false);
  const srcOpened = await page.evaluate(() =>
    document.getElementById('cover-frame').getAttribute('src') || '');
  record('成功8 点入口 → 编辑窗口打开', modalOpened, `cover-modal.hidden=${!modalOpened}`);
  record('成功8 窗口里的预览是带编辑器的那一份', srcOpened.includes('/preview/cover') && srcOpened.includes('edit=1'),
    `src=${srcOpened.slice(0, 60)}`);

  /** 找到 iframe 里那个已经渲染出封面的 frame；找不到返回 null */
  const coverFrame = async () => {
    for (let i = 0; i < 40; i++) {
      const fr = page.frames().find((f) => f.url().includes('/preview/cover'));
      if (fr) {
        try {
          if (await fr.evaluate(() => !!document.querySelector('.cover-title'))) return fr;
        } catch { /* 正在导航，下一轮再试 */ }
      }
      await page.waitForTimeout(250);
    }
    return null;
  };
  /** 等「防抖 + 提交 + 把服务端样式串写回预览」跑完 */
  const settleCover = async () => { await page.waitForTimeout(650); return coverFrame(); };
  const styleOf = (fr, sel, prop) =>
    fr.evaluate(([s, p]) => {
      const el = document.querySelector(s);
      return el ? getComputedStyle(el)[p] : '';
    }, [sel, prop]);
  const setRange = async (sel, v) => page.locator(sel).evaluate((el, val) => {
    el.value = String(val);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, v);
  /** 量「封面元素相对整页」的盒子，画面与配置对齐时要用 */
  const boxOf = (fr, sel) => fr.evaluate((s) => {
    const b = document.querySelector('.art-page').getBoundingClientRect();
    const r = document.querySelector(s).getBoundingClientRect();
    return { x: r.left - b.left, y: r.top - b.top, w: b.width, h: b.height, bw: r.width, bh: r.height };
  }, sel);

  let cfr = await coverFrame();
  record('成功8 预览里真的渲染出封面', !!cfr,
    cfr ? 'iframe 内 .cover-title 已存在' : '40 次重试仍没出现');
  const coverTextNow = async () =>
    (await api(page, '/api/plan')).data?.plan?.coverText ?? null;

  if (cfr) {
    const defAlign = await styleOf(cfr, '.cover-title', 'textAlign');
    const defLeft = parseFloat(await styleOf(cfr, '.cover-title', 'left'));
    const defSize = parseFloat(await styleOf(cfr, '.cover-title', 'fontSize'));
    const defColor = await styleOf(cfr, '.cover-title', 'color');
    const defFamily = await styleOf(cfr, '.cover-title', 'fontFamily');
    record('成功8 默认封面对齐=居左、配置为空',
      (defAlign === 'left' || defAlign === 'start')
      && JSON.stringify(await coverTextNow()) === '{}',
      `text-align=${defAlign} coverText=${JSON.stringify(await coverTextNow())}`);

    // ① 拖动文字框（本轮新加的功能，也是最容易"看着能动其实没记下"的一处）
    const hitCount = await cfr.evaluate(() => (window.__cve ? window.__cve.hits : -1));
    record('成功8 预览里挂上了 3 个可拖的文字框', hitCount === 3, `__cve.hits=${hitCount}`);

    const fb = await page.locator('#cover-frame').boundingBox();
    const hitRect = await cfr.evaluate(() => {
      const r = document.querySelector('.cve-hit').getBoundingClientRect();   // 第一个 = 书名
      return { x: r.x, y: r.y, w: r.width, h: r.height };
    });
    const before = await boxOf(cfr, '.cover-title');
    const sx = fb.x + hitRect.x + hitRect.w / 2;
    const sy = fb.y + hitRect.y + hitRect.h / 2;
    const DX = 90;
    const DY = 70;
    await page.mouse.move(sx, sy);
    await page.mouse.down();
    for (let i = 1; i <= 8; i += 1) {
      await page.mouse.move(sx + (DX * i) / 8, sy + (DY * i) / 8);
    }
    await page.mouse.up();
    cfr = await settleCover();
    const after = await boxOf(cfr, '.cover-title');
    record('成功8 ★拖文字框 → 画面真的跟着动',
      after.x > before.x + 20 && after.y > before.y + 10,
      `left ${before.x.toFixed(0)}→${after.x.toFixed(0)}px；top ${before.y.toFixed(0)}→${after.y.toFixed(0)}px`);
    // ★ 画面上的位置和记下来的配置必须对得上 —— 「拖到哪儿就记到哪儿」。
    //   只断"画面动了"会漏掉"松手后配置被服务端样式串覆盖回原位"这种坏法。
    const live = { x: (after.x / after.w) * 100, y: (after.y / after.h) * 100 };
    const cfgD = (await coverTextNow())?.title || {};
    record('成功8 ★拖完的画面位置 = 配置里的数值（视觉与状态一致）',
      Math.abs(live.x - cfgD.x) < 1 && Math.abs(live.y - cfgD.y) < 1,
      `画面 ${live.x.toFixed(2)}% / ${live.y.toFixed(2)}%，配置 ${cfgD.x} / ${cfgD.y}`);

    // ② 对齐 → 居中
    await page.click('#cv-align button[data-align="center"]');
    cfr = await settleCover();
    const nowAlign = await styleOf(cfr, '.cover-title', 'textAlign');
    // ★ 光看 text-align 会漏掉一种坏法：文字盒被挤成 0 宽（标题整条消失），
    //   而 text-align 照样算"center"。所以同时量**盒子实际宽高**。
    const centeredBox = await cfr.evaluate(() => {
      const el = document.querySelector('.cover-title');
      const r = el.getBoundingClientRect();
      return { w: Math.round(r.width), h: Math.round(r.height), text: (el.textContent || '').length };
    });
    record('成功8 点「居中」→ 预览真的居中', nowAlign === 'center',
      `text-align: ${defAlign} → ${nowAlign}`);
    record('成功8 居中后文字盒没被挤瘪（宽高都 > 0）',
      centeredBox.w > 10 && centeredBox.h > 10,
      `盒 ${centeredBox.w}×${centeredBox.h}px，${centeredBox.text} 个字`);

    // ②b ★ 居中**之后**再拖一次。
    //     居中的锚点是"文字盒中心"而不是左边缘，抓的位置一旦算错，
    //     表现就是"一改对齐，第一次拖动跳一下"。这条专门守它。
    {
      const hb = await page.locator('#cover-frame').boundingBox();
      const hr = await cfr.evaluate(() => {
        const r = document.querySelector('.cve-hit').getBoundingClientRect();
        return { x: r.x, y: r.y, w: r.width, h: r.height };
      });
      const cx = hb.x + hr.x + hr.w / 2;
      const cy = hb.y + hr.y + hr.h / 2;
      const preDrag = await boxOf(cfr, '.cover-title');
      const preCfg = (await coverTextNow())?.title || {};
      await page.mouse.move(cx, cy);
      await page.mouse.down();
      for (let i = 1; i <= 6; i += 1) {
        await page.mouse.move(cx - (60 * i) / 6, cy + (40 * i) / 6);
      }
      await page.mouse.up();
      cfr = await settleCover();
      const post = await boxOf(cfr, '.cover-title');
      const postCfg = (await coverTextNow())?.title || {};
      const wantX = preCfg.x - (60 / preDrag.w) * 100;
      const anchorX = ((post.x + post.bw / 2) / post.w) * 100;
      record('成功8 ★居中之后再拖 → 不跳、锚点（中心）仍与配置一致',
        Math.abs(anchorX - postCfg.x) < 1
        && Math.abs((post.y / post.h) * 100 - postCfg.y) < 1
        && Math.abs(postCfg.x - wantX) < 1.5,
        `锚点 x=${anchorX.toFixed(2)}% 配置=${postCfg.x}；拖动前 ${preCfg.x} → 后 ${postCfg.x}（应左移 ${(60 / preDrag.w * 100).toFixed(1)}%）`);
    }

    // ③ 左右 → 60%
    await setRange('#cv-x', 60);
    cfr = await settleCover();
    const nowLeft = parseFloat(await styleOf(cfr, '.cover-title', 'left'));
    const cfgX = (await coverTextNow())?.title?.x;
    // ★ 这条就是"居中 + 大 x"那个坑的守门人：宽度必须仍然 > 0
    const wideBox = await boxOf(cfr, '.cover-title');
    record('成功8 拖「左右」→ 配置记下 60 且位置真的右移',
      cfgX === 60 && nowLeft > defLeft + 20,
      `coverText.title.x=${cfgX}；left ${defLeft}px → ${nowLeft}px`);
    record('成功8 x=60 且居中时文字仍看得见', wideBox.bw > 10 && wideBox.bh > 10,
      `盒 ${wideBox.bw.toFixed(0)}×${wideBox.bh.toFixed(0)}px`);

    // ④ 字号 → 12
    await setRange('#cv-size', 12);
    cfr = await settleCover();
    const nowSize = parseFloat(await styleOf(cfr, '.cover-title', 'fontSize'));
    record('成功8 拖「字号」→ 预览字真的变大', nowSize > defSize * 1.3,
      `font-size ${defSize}px → ${nowSize}px`);

    // ⑤ 颜色 → #ffd166
    await page.locator('#cv-color').evaluate((el) => {
      el.value = '#ffd166';
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
    cfr = await settleCover();
    const nowColor = await styleOf(cfr, '.cover-title', 'color');
    record('成功8 改「颜色」→ 预览字色真的变了',
      nowColor === 'rgb(255, 209, 102)' && nowColor !== defColor,
      `color ${defColor} → ${nowColor}`);

    // ⑥ 字体 → 楷体
    await page.selectOption('#cv-font', 'kai');
    cfr = await settleCover();
    const nowFamily = await styleOf(cfr, '.cover-title', 'fontFamily');
    record('成功8 换「字体」→ 预览字族真的换了',
      /KaiTi|Kaiti/i.test(nowFamily) && nowFamily !== defFamily,
      `font-family → ${nowFamily.slice(0, 60)}`);

    // ⑦ 斜体
    await page.click('#cv-italic');
    cfr = await settleCover();
    const nowStyle = await styleOf(cfr, '.cover-title', 'fontStyle');
    record('成功8 勾「斜体」→ 预览真的斜了', nowStyle === 'italic', `font-style=${nowStyle}`);

    // ⑧ ★★ 改了半天之后，「编辑中的预览」必须**逐字符等于**服务端现渲染的封面。
    //    这是"预览 = 成品"的机器判据：两边的 `.art-page` 样式属性必须一模一样。
    //    前端要是自己拼了一套 CSS 变量（字号 cqw / 字体族 / 对齐的 translateX…），
    //    这条立刻红 —— 而那种跑偏只靠"页面看着对"是抓不住的。
    await api(page, '/api/cover', { coverText: await coverTextNow() });   // 落定最后一拍
    await page.waitForTimeout(400);
    cfr = await coverFrame();
    const liveStyle = await cfr.evaluate(() =>
      document.querySelector('.art-page').getAttribute('style') || '');
    const fresh = await browser.newPage();
    let freshStyle = null;
    try {
      await fresh.goto(BASE + '/preview/cover?t=' + Date.now(), { waitUntil: 'load' });
      freshStyle = await fresh.evaluate(() =>
        (document.querySelector('.art-page') || {}).getAttribute
          ? (document.querySelector('.art-page').getAttribute('style') || '') : null);
    } finally {
      await fresh.close();
    }
    record('成功8 ★★编辑后的预览 == 服务端现渲染的封面（同一串样式）',
      freshStyle !== null && freshStyle === liveStyle && liveStyle.length > 20,
      `服务端「${String(freshStyle).slice(0, 70)}…」/ 编辑中「${String(liveStyle).slice(0, 70)}…」`);

    // 切到「副标题」页签，控件要换成副标题自己的值（默认距顶 33%）
    await page.click('#cover-tabs button[data-el="subtitle"]');
    const subY = await page.evaluate(() => document.getElementById('cv-y').value);
    record('成功8 切页签 → 控件换成该元素的值', Math.abs(Number(subY) - 33) < 0.01,
      `副标题的「距顶」显示 ${subY}（默认 33）`);

    // 「这块恢复默认」
    await page.click('#cover-reset-el');
    cfr = await settleCover();
    const afterSubReset = (await coverTextNow()) || {};
    record('成功8 「这块恢复默认」只清掉当前元素',
      afterSubReset.title && !afterSubReset.subtitle,
      `coverText 里的元素：${Object.keys(afterSubReset).join('、') || '(空)'}`);

    // 「全部恢复默认」→ 回默认且预览回默认
    await page.click('#cover-reset-all');
    cfr = await settleCover();
    const backDefaults = (await coverTextNow()) || {};
    const backLeft = parseFloat(await styleOf(cfr, '.cover-title', 'left'));
    const backAlign = await styleOf(cfr, '.cover-title', 'textAlign');
    record('成功8 「全部恢复默认」→ 配置清空、预览回默认',
      JSON.stringify(backDefaults) === '{}'
      && Math.abs(backLeft - defLeft) < 1 && backAlign === defAlign,
      `coverText=${JSON.stringify(backDefaults)} left ${backLeft}px text-align=${backAlign}`);

    // ⑨ 确定 → 关窗口、回到主窗口
    const beforeOk = (await coverTextNow()) || {};
    await page.click('#cover-ok');
    await page.waitForTimeout(600);
    const closed = await page.evaluate(() => ({
      hidden: document.getElementById('cover-modal').hidden,
      focused: document.activeElement ? document.activeElement.id : '',
      frameSrc: document.getElementById('cover-frame').getAttribute('src') || '',
    }));
    const afterOk = (await coverTextNow()) || {};
    record('成功8 点「确定」→ 窗口关闭并回到主窗口',
      closed.hidden === true && closed.focused === 'cover-open'
      && JSON.stringify(afterOk) === JSON.stringify(beforeOk),
      `modal.hidden=${closed.hidden} 焦点=${closed.focused || '(无)'} 配置未变=${JSON.stringify(afterOk) === JSON.stringify(beforeOk)}`);
    record('成功8 关窗口后不再留着预览文档', closed.frameSrc === 'about:blank' || !closed.frameSrc,
      `iframe src=${closed.frameSrc || '(空)'}`);

    // ⑩ 取消 → 还原到打开窗口那一刻
    await page.click('#cover-open');
    await page.waitForTimeout(300);
    await page.click('#cv-align button[data-align="center"]');
    await settleCover();
    const dirtyNow = (await coverTextNow()) || {};
    await page.click('#cover-cancel');
    await page.waitForTimeout(600);
    const restored = (await coverTextNow()) || {};
    record('成功8 「取消」→ 改的那些被撤回，配置还原到打开时',
      JSON.stringify(dirtyNow) !== JSON.stringify(restored)
      && JSON.stringify(restored) === JSON.stringify(afterOk),
      `改后 ${JSON.stringify(dirtyNow)} → 取消后 ${JSON.stringify(restored)}`);

    // ---------- ⑪ ★ Phase 26：自定义文字框的「增添 / 删减 / 缩放」----------
    //   佘先生（2026-09-25）：「编辑封面UI要可以增添和删减选框，选框也能够缩放」。
    //
    //   ★ 这一段必须**跨进 iframe 里量**。这个功能最可能的坏法有三种 ——
    //     "页签多了但封面上没多"、"拖了手柄可字号没变"、"删了但配置还在" ——
    //     只看界面上的数字（页签数、滑块值）**全都会绿**。
    await page.click('#cover-open');
    await page.waitForTimeout(250);
    cfr = await coverFrame();

    const tabEls = () => page.evaluate(() =>
      [...document.querySelectorAll('#cover-tabs button')].map((b) => b.dataset.el));
    const fontPx = (sel) => cfr.evaluate((s) => {
      const el = document.querySelector(s);
      return el ? parseFloat(getComputedStyle(el).fontSize) : -1;
    }, sel);
    // ★ 下面这几个都**吞异常**：iframe 每次重载都会销毁旧的执行上下文，
    //   这时 evaluate 会抛 —— 那属于"正在换页"，不是失败，重试就好。
    const extraDomsIn = async (fr) => {
      try { return await fr.evaluate(() => document.querySelectorAll('.cover-extra[data-ct]').length); }
      catch { return -1; }
    };
    const hitsIn = async (fr) => {
      try {
        return await fr.evaluate(() =>
          ((window.__cve && window.__cve.keys) || []).filter((k) => /^x\d+$/.test(k)).length);
      } catch { return -1; }
    };
    const textOfExtra = async (fr, k) => {
      try {
        return await fr.evaluate((key) => {
          const el = document.querySelector('.cover-extra[data-ct="' + key + '"]');
          return el ? el.textContent : null;
        }, k);
      } catch { return null; }
    };
    const handleOf = async (fr, k) => {
      try {
        return await fr.evaluate((key) => {
          const hit = document.querySelector('.cve-hit[data-ct="' + key + '"]');
          if (!hit || !hit.querySelector('.cve-handle')) return null;
          const r = hit.querySelector('.cve-handle').getBoundingClientRect();
          return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height };
        }, k);
      } catch { return null; }
    };
    /** 等预览里真的出现（want 个）自定义框。
     *  ★ 必须轮询，不能等固定毫秒数：加/删框走的是**"提交回来才重载预览"**，
     *    慢机器上固定 650ms 会假红（而那是产品正确行为，不是缺陷）。 */
    const waitExtraDoms = async (want) => {
      for (let i = 0; i < 45; i += 1) {
        const fr = await coverFrame();
        if (fr) {
          const n = await extraDomsIn(fr);
          if (n === want) return { fr, n };
          if (n >= 0) cfr = fr;
        }
        await page.waitForTimeout(200);
      }
      const fr = await coverFrame();
      return { fr, n: fr ? await extraDomsIn(fr) : -1 };
    };

    const tabsBefore = await tabEls();
    await page.click('#cover-add');
    await page.waitForTimeout(200);          // 页签是本地立刻变的，先让它落定
    const tabsAfter = await tabEls();
    const newKey = tabsAfter[tabsAfter.length - 1];
    const addedFrame = await waitExtraDoms(1);
    if (addedFrame.fr) cfr = addedFrame.fr;
    const domAfter = addedFrame.n;
    const hitsAfter = cfr ? await hitsIn(cfr) : -1;
    record('成功8 ★点「＋ 加文字框」→ 页签 / 命中框 / 封面三处一起多一个',
      tabsAfter.length === tabsBefore.length + 1 && /^x\d+$/.test(newKey)
      && hitsAfter === 1 && domAfter === 1,
      `页签 ${tabsBefore.join('/')} → ${tabsAfter.join('/')}；命中框 ${hitsAfter}；封面上的自定义框 ${domAfter}`);

    // 加了框要能写字，而且要**立刻**出现在封面上 —— 不然用户加完框在右边打字，
    // 封面一动不动，根本分不清自己正在改哪个框。
    await page.fill('#cv-text', '二〇二六 · 深圳');
    let newText = null;
    for (let i = 0; i < 25; i += 1) {
      const fr = await coverFrame();
      if (fr) {
        const t = await textOfExtra(fr, newKey);
        if (t !== null) { newText = t; cfr = fr; }
        if (t === '二〇二六 · 深圳') break;
      }
      await page.waitForTimeout(200);
    }
    record('成功8 ★在「文字」里打字 → 封面上那个框同步写出来',
      newText === '二〇二六 · 深圳', `data-ct=${newKey} 上写着 ${JSON.stringify(newText)}`);

    // 选中它（页签一点，预览里那个框才会高亮、缩放手柄才露出来）
    await page.click(`#cover-tabs button[data-el="${newKey}"]`);
    await page.waitForTimeout(200);
    const extraSel = '.cover-extra[data-ct="' + newKey + '"]';
    let handle = cfr ? await handleOf(cfr, newKey) : null;
    for (let i = 0; i < 10 && !handle; i += 1) {     // 选中后手柄要显示出来才算数
      await page.waitForTimeout(200);
      const fr = await coverFrame();
      if (fr) { cfr = fr; handle = await handleOf(fr, newKey); }
    }
    record('成功8 选中的框右下角真的有个缩放手柄',
      !!handle && handle.w > 6 && handle.h > 6,
      handle ? `手柄 ${handle.w.toFixed(0)}×${handle.h.toFixed(0)}px` : '没找到可见的 .cve-handle');

    // 拖手柄 → **宽度和字号等比一起变大**（只改宽度的话文字会重新折行，
    // 看起来像"内容变成了另一段"，那不叫缩放）
    //
    // ★ 手柄不在时**不许把整层打断**：原来这里直接 `frameBox.x + handle.x`，
    //   handle 为 null 就抛 TypeError → 后面（删除/封顶/收尾）一条都不跑，
    //   验收只报一句"脚本异常"，看不出是哪一步坏的。判红 + continue 才对。
    const preBox = cfr ? await boxOf(cfr, extraSel) : { x: 0, y: 0, w: 1, h: 1, bw: 0, bh: 0 };
    const preSize = cfr ? await fontPx(extraSel) : -1;
    const frameBox = await page.locator('#cover-frame').boundingBox();
    const shift = handle ? Math.max(60, Math.round(preBox.w * 0.18)) : 0;
    let postBox = preBox;
    let postSize = preSize;
    let postCfg = {};
    if (handle) {
      const hx = frameBox.x + handle.x;
      const hy = frameBox.y + handle.y;
      await page.mouse.move(hx, hy);
      await page.mouse.down();
      for (let i = 1; i <= 8; i += 1) {
        await page.mouse.move(hx + (shift * i) / 8, hy);
      }
      await page.mouse.up();
      const afterDrag = await settleCover();
      if (afterDrag) cfr = afterDrag;
      postBox = cfr ? await boxOf(cfr, extraSel) : preBox;
      postSize = cfr ? await fontPx(extraSel) : preSize;
      postCfg = ((await coverTextNow()) || {})[newKey] || {};
    }
    record('成功8 ★拖右下角手柄 → 框变宽、字也等比变大（这才叫缩放）',
      !!handle && postBox.bw - preBox.bw > shift * 0.6 && postSize > preSize * 1.15,
      handle
        ? `宽 ${preBox.bw.toFixed(0)}→${postBox.bw.toFixed(0)}px（拖了 ${shift}px）；`
          + `字号 ${preSize}→${postSize}px（比值 宽 ${(postBox.bw / preBox.bw).toFixed(2)} vs 字 ${(postSize / preSize).toFixed(2)}）`
        : '没有可见的 .cve-handle，拖不起来');
    // 画面与配置必须对得上 —— 只断"画面变大了"会漏掉"松手后被服务端样式串
    // 覆盖回原样"这种坏法（那正是 Phase 25 定下的"松手才提交"路径）。
    const wantPx = (postCfg.size / 100) * postBox.w;
    record('成功8 ★缩放后画面 == 配置里记下的 w / size',
      !!handle && postCfg.w !== undefined && postCfg.size !== undefined
      && Math.abs((postBox.bw / postBox.w) * 100 - postCfg.w) < 1.5
      && Math.abs(postSize - wantPx) < 0.8,
      handle
        ? `宽度 画面 ${((postBox.bw / postBox.w) * 100).toFixed(2)}% vs 配置 ${postCfg.w}%；`
          + `字号 画面 ${postSize}px vs 配置 ${postCfg.size}%（应 ${wantPx.toFixed(2)}px）`
        : '没拖成，无从对账');

    /** 轮询"iframe 里的某个读数"，直到满足条件。
     *  ★ 元素**增减/隐藏/恢复**都会重载预览，而重载只在"提交回来之后"才发生 ⇒
     *    固定等 650ms 会在慢机器上读到旧文档 = 假红（产品行为其实是对的）。 */
    const waitFrameValue = async (getter, ok, tries = 35) => {
      let last = null;
      for (let i = 0; i < tries; i += 1) {
        const fr = await coverFrame();
        if (fr) {
          cfr = fr;
          try { last = await getter(fr); } catch { last = null; }
          if (ok(last)) return last;
        }
        await page.waitForTimeout(200);
      }
      return last;
    };
    const countExtras = () => waitFrameValue((fr) => extraDomsIn(fr), (v) => v === 0);

    // 删减（自定义框）：配置里的键真没了，封面上和页签上也不该留着
    await page.click('#cover-del');
    cfr = await settleCover();
    const afterDel = (await coverTextNow()) || {};
    const domDel = await countExtras();
    const tabsDel = await tabEls();
    record('成功8 ★点「删掉这个框」（自定义框）→ 键没了、封面上没了、页签也撤了',
      domAfter === 1 && !(newKey in afterDel) && domDel === 0 && !tabsDel.includes(newKey),
      `删之前封面上的自定义框 ${domAfter}（该是 1）；coverText 键=${Object.keys(afterDel).join('、') || '(空)'}；`
      + `删之后 ${domDel}；页签 ${tabsDel.join('/')}`);

    // 删减（内置元素）：内容来自书名/张数，**不能真删** —— 只能藏起来，而且能恢复
    await page.click('#cover-tabs button[data-el="foot"]');
    await page.waitForTimeout(200);
    const delLabelBefore = await page.evaluate(() =>
      document.getElementById('cover-del').textContent.trim());
    await page.click('#cover-del');
    // ★ 口径修正（2026-09-25）：内置元素被"删掉"的实现是**从封面 HTML 里整个不生成它**
    //   （`make_flipbook.cover_text_html()` 按 hide 过滤），所以 DOM 里根本查不到这个元素
    //   ⇒ 读数是 `'missing'`，不是 `'none'`。判"从封面上消失了没有"必须两种都算数 ——
    //   只认 `display:none` 是把**实现细节**当行为来断言（原来那条就是这么擦边红的）。
    //   判据本身没松：配置里 `hide:true`、命中框不再挂，两条照旧都要满足。
    const goneFromCover = (v) => v === 'none' || v === 'missing';
    const footDisplay = () => waitFrameValue(
      (fr) => fr.evaluate(() => {
        const el = document.querySelector('.cover-foot');
        return el ? getComputedStyle(el).display : 'missing';
      }),
      goneFromCover);
    const delFootDisplay = await footDisplay();
    const footCfg = ((await coverTextNow()) || {}).foot || {};
    const footHit = await waitFrameValue(
      (fr) => fr.evaluate(() => ((window.__cve && window.__cve.keys) || []).includes('foot')),
      (v) => v === false);
    const delLabelAfter = await page.evaluate(() =>
      document.getElementById('cover-del').textContent.trim());
    record('成功8 ★删内置页脚 = 藏起来（不是真删，按钮变「恢复显示」）',
      delLabelBefore === '删掉这个框' && goneFromCover(delFootDisplay)
      && footCfg.hide === true && footHit === false && delLabelAfter === '恢复显示',
      `按钮「${delLabelBefore}」→「${delLabelAfter}」；页脚 ${delFootDisplay === 'missing' ? '已从封面上移除' : `display=${delFootDisplay}`}；`
      + `配置 foot=${JSON.stringify(footCfg)}；还挂着命中框=${footHit}`);

    await page.click('#cover-del');           // 此刻它是「恢复显示」
    const footBack = await waitFrameValue(
      (fr) => fr.evaluate(() => {
        const el = document.querySelector('.cover-foot');
        return el ? getComputedStyle(el).display : 'missing';
      }),
      (v) => v !== 'none' && v !== 'missing');
    const footCfg2 = ((await coverTextNow()) || {}).foot || {};
    record('成功8 ★点「恢复显示」→ 页脚回来了',
      footBack !== 'none' && footBack !== 'missing' && footCfg2.hide !== true,
      `页脚 display=${footBack}；配置 foot=${JSON.stringify(footCfg2)}`);

    // 上限：「最多 8 个」前后端是同一个数（核心层成功S 静态对账过），这里验界面真封顶
    let added = 0;
    for (let i = 0; i < 12; i += 1) {
      const disabled = await page.evaluate(() => document.getElementById('cover-add').disabled);
      if (disabled) break;
      await page.click('#cover-add');
      added += 1;
      await page.waitForTimeout(140);
    }
    const addDisabled = await page.evaluate(() => document.getElementById('cover-add').disabled);
    const extraTotal = (await tabEls()).filter((k) => /^x\d+$/.test(k)).length;
    record('成功8 ★文字框加到 8 个就封顶（加号变灰、不再多给）',
      addDisabled === true && extraTotal === 8 && added <= 8,
      `本轮加了 ${added} 个，共 ${extraTotal} 个自定义框，加号禁用=${addDisabled}`);

    // 收尾：清干净，不给后面的失败项留状态
    await page.click('#cover-reset-all');
    const cleaned = await (async () => {
      for (let i = 0; i < 25; i += 1) {
        const c = await coverTextNow();
        if (c && JSON.stringify(c) === '{}') return c;
        await page.waitForTimeout(200);
      }
      return (await coverTextNow()) || null;
    })();
    const domClean = await countExtras();
    record('成功8 ★收尾：全部恢复默认 → 自定义框全消失、配置回空',
      JSON.stringify(cleaned) === '{}' && domClean === 0,
      `coverText=${JSON.stringify(cleaned)}；封面上的自定义框 ${domClean}`);
    await page.click('#cover-ok');
    await page.waitForTimeout(400);
  }

  // ---------- A 目录里没照片 ----------
  const emptyDir = path.resolve('.ui-probe/empty');
  fs.mkdirSync(emptyDir, { recursive: true });
  const rA = await api(page, '/api/scan', { path: emptyDir });
  const aRejected = rA.status >= 400 || rA.data?.ok === false;
  record('失败A 空目录报错', aRejected, `HTTP ${rA.status} ${JSON.stringify(rA.data?.error ?? rA.data).slice(0, 110)}`);
  // 界面仍可用：照片列表还在
  const afterA = await page.locator('#grid .card').count();
  record('失败A 界面仍可用', afterA === 6, `报错后照片列表仍为 ${afterA} 张`);

  // ---------- B 目录不存在 ----------
  const rB = await api(page, '/api/scan', { path: 'C:/definitely/not/here/xyz' });
  record('失败B 目录不存在', rB.status >= 400 || rB.data?.ok === false,
    `HTTP ${rB.status} ${JSON.stringify(rB.data?.error ?? rB.data).slice(0, 110)}`);
  const afterB = await page.locator('#grid .card').count();
  record('失败B 界面仍可用', afterB === 6, `报错后照片列表仍为 ${afterB} 张`);

  // ---------- C 损坏图片混入 ----------
  const mixedDir = path.resolve('.ui-probe/mixed');
  fs.rmSync(mixedDir, { recursive: true, force: true });
  fs.mkdirSync(mixedDir, { recursive: true });
  const srcPhotos = path.resolve('..', '图片');
  const names = fs.readdirSync(srcPhotos).filter((f) => /\.jpe?g$/i.test(f)).sort();
  fs.copyFileSync(path.join(srcPhotos, names[0]), path.join(mixedDir, names[0]));
  fs.writeFileSync(path.join(mixedDir, 'broken.jpg'), 'this is definitely not a jpeg');
  const rC = await api(page, '/api/scan', { path: mixedDir });
  const cCount = rC.data?.plan?.photoCount ?? 0;
  record('失败C 损坏图片被跳过', cCount >= 1 && rC.data?.ok !== false,
    `正常 ${cCount} 张被读入，坏文件被跳过（HTTP ${rC.status}）`);
  await page.screenshot({ path: path.join(OUT, '07-broken-mixed.png'), fullPage: true });

  // 恢复成真实照片目录，方便后续失败项不影响
  await api(page, '/api/scan', { path: srcPhotos });

  // ---------- D 输出目录被文件占位 ----------
  const locked = path.resolve('.ui-probe/locked-file');
  fs.writeFileSync(locked, 'x');
  const rD1 = await api(page, '/api/plan', { outputDir: locked });
  // 单独再取一次状态，确认上一个请求的错误没有污染后续请求
  const statusAfterD = await api(page, '/api/status');
  const rD2 = await api(page, '/api/generate');
  const dBlocked = rD1.status >= 400 || rD1.data?.ok === false;
  record('失败D 输出被文件占位', dBlocked,
    `plan HTTP ${rD1.status} → ${JSON.stringify(rD1.data?.error ?? rD1.data).slice(0, 120)}`);
  record('失败D 后续请求未受污染', statusAfterD.status === 200 && statusAfterD.data?.ok === true,
    `紧接的 status HTTP ${statusAfterD.status}、generate HTTP ${rD2.status}（应能正常走到生成或给出干净报错）`);
  const afterD = await page.locator('#grid .card').count();
  record('失败D 界面仍可用', afterD === 6, `报错后照片列表仍为 ${afterD} 张`);
  await page.screenshot({ path: path.join(OUT, '08-output-locked.png'), fullPage: true });

  // ---------- 代理干扰 / 控制台 ----------
  // 上面几步是故意打错的请求，会产生 400 的控制台噪音，这属于预期。
  // 这里只确认：失败请求（真正连不上的）始终为 0，说明代理没捣乱。
  record('代理干扰下无失败请求', failedRequests.length === 0,
    `失败请求 ${failedRequests.length} 条（含故意打错的请求，其 400 属预期）`);

} catch (err) {
  record('验收脚本异常', false, String(err).slice(0, 500));
  await page.screenshot({ path: path.join(OUT, 'error.png'), fullPage: true }).catch(() => {});
} finally {
  await browser.close();
}

console.log('\n===== 汇总 =====');
for (const r of results) console.log(`${r.ok ? '✅' : '❌'}  ${r.name} — ${r.detail}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`\n通过 ${results.length - failed}/${results.length}`);
fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify(results, null, 2));
process.exit(failed === 0 ? 0 : 1);
