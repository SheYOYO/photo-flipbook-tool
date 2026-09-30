/* 画册工作台前端。
   原则：排版方案的唯一事实来源在服务端。这里每次改动都提交回去，
   服务端重算书页结构后再返回，前端只负责画出来。
   前端不自己算排版，避免两边状态不同步。 */

(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);

  /** 当前方案（服务端返回的权威状态） */
  let plan = null;
  /** 当前选中的照片编号 */
  let selectedOrder = null;
  /** 生成后的成品路径 */
  let generatedHtml = '';
  /** 当前这次渲染的组内页数，outerShadow() 要用（1 = 单页，2 = 跨页） */
  let groupLenSafe = 2;

  /** 用户手打的草稿。`null` = 这一栏跟随服务端。
   *
   * 一旦用户在这两栏敲过键盘，这一栏就归用户所有 —— **包括他自己把它删成空串**。
   *
   * ★ 为什么必须隔离：服务端把空书名兜底成默认书名（`我的小狗`）。
   *   不隔离的话，删掉最后一个字的 420ms 后回包一到，`renderStatus()` 就把
   *   兜底值写回输入框 —— 表现就是"永远删不掉最后一个字，原文字自己回来了"。
   *   而且任何一次别的重渲染（改版式、拖序）都会再顶一次。
   */
  const drafts = { title: null, subtitle: null };

  /** 「输出到」的默认落点。
   *
   * 不写死在界面里 —— 服务端没被改过时返回的那个目录就是默认值
   * （现在是工作区的 `画册集/`，工具默认把画册都放那儿）。
   * 用户临时选了别处之后，靠「恢复默认」按钮一键回来。
   */
  let outputDefault = '';

  // ---------------------------------------------------------------- 请求

  async function api(path, options = {}) {
    let res;
    try {
      res = await fetch(path, {
        headers: { 'Content-Type': 'application/json' },
        cache: 'no-store',
        ...options,
      });
    } catch (err) {
      throw new Error('连不上后台服务。窗口可能被关掉了，重新双击「画册.bat」即可。');
    }
    let data = null;
    try {
      data = await res.json();
    } catch (err) {
      throw new Error(`后台返回了无法理解的内容（HTTP ${res.status}）。`);
    }
    if (!res.ok || data.ok === false) {
      throw new Error(data && data.error ? data.error : `请求失败（HTTP ${res.status}）`);
    }
    return data;
  }

  const post = (path, body) =>
    api(path, { method: 'POST', body: JSON.stringify(body || {}) });

  // ---------------------------------------------------------------- 提示

  let toastTimer = null;

  function toast(msg, ms = 2200) {
    const el = $('toast');
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, ms);
  }

  function showError(msg) {
    $('modal-title').textContent = '出错了';
    $('modal-body').textContent = msg;
    $('modal').hidden = false;
  }

  // ---------------------------------------------------------------- 渲染

  function plateLabel(plate) {
    return { small: '小图', medium: '中图', large: '大图', portrait: '竖版' }[plate] || plate;
  }

  // ---- 输入框与服务端状态的同步 --------------------------------------------

  /**
   * 把服务端的值写进输入框。
   * 两条铁律，缺一条就会把用户正在打的字顶掉：
   *   1 这一栏已经归用户了（有草稿）→ 一个字都不动，包括他自己删成空的情况；
   *   2 光标正停在这一栏 → 也不动。
   */
  function syncField(id, serverValue, draftKey) {
    const el = $(id);
    if (draftKey && drafts[draftKey] !== null) return;
    if (document.activeElement === el) return;
    if (el.value !== serverValue) el.value = serverValue;
  }

  /**
   * 用户把某一栏删空、而服务端会用默认值兜底时，给一行明确的小字。
   * 不说清楚的话，用户会以为「我明明删了，为什么书里还有字」。
   */
  function hintFallback(id, draft, effective, label) {
    const el = $(id);
    const blank = draft !== null && draft.trim() === '';
    if (!blank || !effective) {
      el.hidden = true;
      return;
    }
    el.textContent = `${label}留空时用默认「${effective}」`;
    el.hidden = false;
  }

  function renderStatus() {
    if (!plan) return;

    // ★ 「输出到」被选了别的目录后要能回到默认（= 画册集），否则用户只能手工去改路径。
    //   默认值不是写死在界面里的 —— 界面上没动过它时，服务端给什么就显示什么。
    if (plan.outputDir) outputDefault = plan.outputDir;

    $('chip-photos').textContent = plan.photoCount ? `${plan.photoCount} 张照片` : '还没有照片';
    $('chip-pages').textContent = plan.pageCount ? `${plan.pageCount} 页` : '—';
    $('btn-generate').disabled = !plan.photoCount;
    $('btn-auto').hidden = !plan.photoCount;

    syncField('input-title', plan.title || '', 'title');
    syncField('input-subtitle', plan.subtitle || '', 'subtitle');
    syncField('input-output', plan.outputDir || '');
    hintFallback('hint-title', drafts.title, plan.title, '书名');
    hintFallback('hint-subtitle', drafts.subtitle, plan.subtitle, '副标题');
    if ($('btn-output-default')) $('btn-output-default').hidden = plan.outputDir === outputDefault;

    const hasPhotos = plan.photoCount > 0;
    $('picker-empty').hidden = hasPhotos;
    $('picker-path').hidden = !hasPhotos;
    $('preview-empty').hidden = hasPhotos;
    if (hasPhotos) $('picker-path').textContent = plan.sourceDir;

    // 没照片时进全屏只能看个空壳，所以跟「重新自动排版」一个待遇：有照片才给。
    if ($('fs-row')) $('fs-row').hidden = !hasPhotos;

    renderCover();
  }

  function renderGrid() {
    const grid = $('grid');
    grid.innerHTML = '';
    if (!plan || !plan.photoCount) return;

    for (const photo of plan.photos) {
      const card = document.createElement('div');
      card.className = 'card';
      card.draggable = true;
      card.dataset.order = String(photo.order);
      if (photo.order === selectedOrder) card.classList.add('selected');

      const img = document.createElement('img');
      img.src = `/thumb?id=${photo.order}`;
      img.alt = photo.name;
      img.loading = 'lazy';
      card.appendChild(img);

      // 右上角叉号：删掉这一张。
      // ★ 必须 stopPropagation —— 不然点叉号会顺带把这张"选中"，
      //   删完选中态就挂在一个已经不存在的编号上了。
      // ★ 还要拦 pointerdown/mousedown：卡片是 draggable 的，
      //   手指按在叉号上往下拖会变成"拖整张卡片"，而不是"点叉号"。
      // 「第几张」按**位次**说 —— 界面上的号现在就是位次，两处必须是同一套说法。
      const pos = plan.photos.indexOf(photo) + 1;
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'card-del';
      del.title = '删掉这张照片';
      del.setAttribute('aria-label', `删掉第 ${pos} 张照片`);
      del.textContent = '×';
      for (const evName of ['pointerdown', 'mousedown', 'click', 'dblclick']) {
        del.addEventListener(evName, (ev) => {
          ev.stopPropagation();
          if (evName === 'click') removePhoto(photo.order);
        });
      }
      card.appendChild(del);

      const meta = document.createElement('div');
      meta.className = 'card-meta';
      meta.innerHTML = `<span class="card-plate">${plateLabel(photo.plate)}</span>`;
      card.appendChild(meta);

      // 左下角编号：显示**当前位次**（第几个），点一下就地变成输入框，
      // 填个位次回车即挪过去。删除 / 换序后整格会重画，所以它永远是新的。
      meta.insertBefore(makeIdxBox(photo), meta.firstChild);

      // 选中
      card.addEventListener('click', () => {
        selectedOrder = selectedOrder === photo.order ? null : photo.order;
        renderGrid();
        renderSelected();
      });

      // 拖拽调序
      card.addEventListener('dragstart', (ev) => {
        ev.dataTransfer.setData('text/plain', String(photo.order));
        ev.dataTransfer.effectAllowed = 'move';
        card.classList.add('dragging');
      });
      card.addEventListener('dragend', () => {
        card.classList.remove('dragging');
        document.querySelectorAll('.card.drop-target')
          .forEach((el) => el.classList.remove('drop-target'));
      });
      card.addEventListener('dragover', (ev) => {
        ev.preventDefault();
        ev.dataTransfer.dropEffect = 'move';
        card.classList.add('drop-target');
      });
      card.addEventListener('dragleave', () => card.classList.remove('drop-target'));
      card.addEventListener('drop', async (ev) => {
        ev.preventDefault();
        card.classList.remove('drop-target');
        const from = Number(ev.dataTransfer.getData('text/plain'));
        const to = photo.order;
        if (!from || from === to) return;
        await reorder(from, to);
      });

      grid.appendChild(card);
    }
  }

  /** 左下角那个编号组块：不点时是个小圆片，点一下就地变成输入框。
   *
   * 「不动 DOM、只换控件」是刻意的 —— 重画整格会把这个输入框连焦点一起
   * 冲掉，用户刚点开就没了。所以这里在组块内部换 span 与 input。
   *
   * ★ 显示的是**位次**（第几个，从 1 数起），不是 `Photo.order`。
   *   佘先生（2026-09-30）：「那个图片的顺序数字显示不更新，要求我每次删除
   *   图片和修改图片顺序都能刷新图片的真实顺序显示」。
   *   ⇒ 以前显示身份号，删完会缺号（1、2、4…），他不要；现在显示真实位次，
   *     删掉 / 换序 / 挪位之后一律重排成连续的 1、2、3…
   *   ⚠ `Photo.order` 仍然**只做身份号与 /thumb 取图键**，一个字都不许动它
   *     （重编号会让缩略图取错图，findings 112）。这里改的只是"显示哪张脸"。
   *
   * ★ 位次要**现算**，不能沿用建卡片那会儿的值 —— 卡片虽然是 renderGrid
   *   重画的，但这个 paint() 会被 finish() 再叫一次，那时 plan 可能已经换了。
   */
  function makeIdxBox(photo) {
    const box = document.createElement('span');
    box.className = 'card-idx';

    const posNow = () => {
      const i = plan.photos.findIndex((p) => p.order === photo.order);
      return i < 0 ? 0 : i + 1;
    };

    const paint = () => {
      box.classList.remove('editing');
      const pos = posNow();
      box.textContent = pos > 0 ? String(pos) : '';
      box.title = `第 ${pos} 张 · 点一下改成别的位置`;
    };

    const openEditor = () => {
      if (box.classList.contains('editing')) return;
      box.classList.add('editing');
      const input = document.createElement('input');
      input.type = 'text';
      input.inputMode = 'numeric';
      input.className = 'card-idx-input';
      input.value = String(posNow());
      input.title = '填第几个，回车挪过去';
      box.textContent = '';
      box.appendChild(input);
      input.focus();
      input.select();

      let done = false;
      const finish = async (commit) => {
        if (done) return;
        done = true;
        const want = Number.parseInt(input.value, 10);
        paint();
        if (!commit) return;
        // 越界 / 非数字 → moveToPosition 自己会拒绝，这里直接退回原位（不报错）。
        await moveToPosition(photo.order, want);
      };
      input.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') { ev.preventDefault(); finish(true); }
        else if (ev.key === 'Escape') { ev.preventDefault(); finish(false); }
      });
      input.addEventListener('blur', () => finish(true));
    };

    paint();
    for (const evName of ['pointerdown', 'mousedown', 'dblclick']) {
      box.addEventListener(evName, (ev) => ev.stopPropagation());
    }
    box.addEventListener('click', (ev) => {
      // 别顺带把这张选中；也别让卡片开始拖拽。
      ev.stopPropagation();
      ev.preventDefault();
      openEditor();
    });
    return box;
  }

  function renderSelected() {
    const box = $('selected-box');
    if (!plan || selectedOrder === null) {
      box.hidden = true;
      return;
    }
    const photo = plan.photos.find((p) => p.order === selectedOrder);
    if (!photo) {
      box.hidden = true;
      return;
    }
    box.hidden = false;
    box.hidden = false;
    const pos = plan.photos.indexOf(photo) + 1;
    box.querySelector('.field-label').textContent = `第 ${pos} 张的版面`;

    document.querySelectorAll('#plate-options button').forEach((btn) => {
      btn.classList.toggle('on', btn.dataset.plate === photo.plate);
    });
    document.querySelectorAll('#pos-options button').forEach((btn) => {
      const cur = photo.position || '';
      btn.classList.toggle('on', btn.dataset.pos === cur);
    });
  }

  // ------------------------------------------------- 封面文案编辑窗口（P24/P25）
  //
  // 佘先生（2026-09-25）：「把封面文案样式那里改成点击唤起编辑封面的窗口，
  //   窗口处要可以移动文字框，编辑文字的大小、字体、颜色，
  //   然后点击确定后返回工具的主窗口」。
  //
  // ★ 四条必须守住的：
  //   1. **没动过的项不写进配置**。控件显示的"当前值"是 CSS 里的默认值
  //      （COVER_DEFAULTS），但只有用户真动过某一项，那一项才会被提交上去。
  //      于是"完全没碰封面"的书与旧版一字不差 —— 这是「原功能不变」的机器判据。
  //   2. 预览**不是前端画的近似图**，是服务端用出书那份 page_html + 同一套 CSS
  //      生成的 iframe。前端自己画的话，两套样式迟早跑偏。
  //   3. ★★ **预览里的样式也不许前端自己拼**。改一项 → POST /api/cover →
  //      拿回包里的 `coverStyle`（服务端算好的那串 CSS 变量）**原样写到封面元素上**。
  //      唯一例外是**拖动过程中**：那时每帧都发请求不现实，就地改
  //      `--ct-<元素>-x/y` 两个变量，**松手立刻用服务端样式串覆盖回去**。
  //      于是"预览=成品"这件事只有一份映射，且它住在服务端。
  //   4. 走独立的 /api/cover，不走 /api/plan —— 后者会重算整本书并让前端重画
  //      100 张缩略图，拖滑块时会把界面拖卡。

  /** 各元素的默认值 = style/book-style.css 里的字面量。改 CSS 记得同步这里。 */
  const COVER_DEFAULTS = {
    title: { x: 13.5, y: 15, size: 7.2, color: '#f7f6f0', font: 'serif', align: 'left', italic: false },
    subtitle: { x: 13.5, y: 33, size: 2.1, color: '#f7f6f0', font: 'serif', align: 'left', italic: false },
    foot: { x: 13.5, y: 7, size: 1.6, color: '#f7f6f0', font: 'sans', align: 'left', italic: false },
  };
  /** 竖直位置对三个元素的含义不同：前后是两个标题锚在顶部，页脚锚在底部。 */
  const COVER_Y_LABEL = { title: '距顶', subtitle: '距顶', foot: '距底' };

  // ------------------------------------------------- 自定义文字框（Phase 26）
  //
  // 佘先生：「编辑封面UI要可以增添和删减选框，选框也能够缩放」。
  //
  // ★ 自定义框沿用**同一套**键名机制（`x1`、`x2`…，见 make_flipbook 的说明），
  //   所以下面大量逻辑对内置和自定义是一视同仁的 —— 少数必须分家的地方
  //   （比如"删掉"对两者含义不同），都写清理由。

  /** 内置的三个元素，顺序 = 页签顺序。 */
  const COVER_ELEMENTS = ['title', 'subtitle', 'foot'];
  const COVER_ELEMENT_LABEL = { title: '书名', subtitle: '副标题', foot: '页脚' };

  /** 自己加的框的默认值。
   *  ★ 必须与 `make_flipbook.cover_extra_html()` 里那串内联默认**一字不差**，
   *    否则"没配过的框"在右边控件上显示的数字，与封面上实际的样子会对不上
   *    （selftest 的成功S 拿这条做静态对账）。 */
  const COVER_EXTRA_DEFAULTS = {
    x: 13.5, y: 50, size: 2.1, w: null, color: '#f7f6f0',
    font: 'serif', align: 'left', italic: false,
  };
  /** 一本封面上最多几个自己加的文字框。与 `make_flipbook.COVER_EXTRA_MAX` 一致。 */
  const COVER_EXTRA_MAX = 8;
  /** 宽度下限（%）。与 `make_flipbook._COVER_NUM_RANGES["w"]` 的下限一致。 */
  const COVER_MIN_W = 5;
  const COVER_EXTRA_RE = /^x[1-9]\d?$/;

  function isExtraKey(key) { return COVER_EXTRA_RE.test(String(key)); }
  function extraNum(key) { return Number(String(key).slice(1)); }

  /** 当前该有哪些文字框：内置三个恒在 + 配置里出现过的自定义框（按数字序）。 */
  function coverElementList() {
    const cfg = (plan && plan.coverText) || {};
    const extras = Object.keys(cfg)
      .filter(isExtraKey)
      .sort((a, b) => extraNum(a) - extraNum(b));
    return COVER_ELEMENTS.concat(extras);
  }

  /** 页签上写什么字。自定义框就用它自己的文字开头几个字，一眼认出是谁。 */
  function coverLabel(key, conf) {
    if (COVER_ELEMENT_LABEL[key]) return COVER_ELEMENT_LABEL[key];
    const text = String((conf || {}).text || '').trim();
    return text ? text.slice(0, 5) : `文字框${extraNum(key)}`;
  }

  let coverEl = 'title';
  let coverTimer = null;
  /** 提交成功后要不要**重载预览**。
   *
   *  ★★ 这是 2026-09-25 界面层 39/43 抓到的一个真 bug，成因必须记下来：
   *     `loadCoverFrame()` 是**立刻**换 iframe 的 `src`，而提交走 `flushCover()`
   *     有 60~160ms 防抖 —— 于是"加一个文字框"变成了：
   *       ① 本地记下 x1  →  ② 立刻重载预览（服务端**还没**收到 x1）
   *       →  ③ 60ms 后提交（服务端这才有 x1）
   *     ②渲染出来的预览里没有那个框，而 ③ 回来只走 `applyCoverStyle()`
   *     （只改样式串、**不重载**）⇒ 表现是「加了框，页签有了，封面上却一直不出现」。
   *     删除 / 隐藏 / 恢复显示 全都有同一个病。
   *  ⇒ 规矩：**结构变了**（元素增减、显隐切换）一律等提交回来再重载；
   *    样式变了（位置/字号/颜色…）只管写样式串，永远不用重载。 */
  let coverReloadPending = false;
  /** 打开窗口那一刻的配置。点「取消」/ 按 Esc 时用它还原。 */
  let coverSnapshot = null;
  /** 拖动是否进行中。拖动期间**不要**提交，免得每个鼠标移动都发一个请求。 */
  let coverDragging = false;
  /** 窗口是否开着。关着时不做任何预览相关的活儿。 */
  let coverOpen = false;
  /** 页签的结构签名。只有它变了才重建页签 —— 拖滑块时每帧重建既白费又丢焦点。 */
  let coverTabsSig = '';

  function coverCfg(el) {
    return (plan && plan.coverText && plan.coverText[el]) || {};
  }

  /** 取一项的当前值：配置里有就用它，没有就用该类元素的默认值。 */
  function coverVal(el, key) {
    const v = coverCfg(el)[key];
    if (v !== undefined && v !== null) return v;
    const d = COVER_DEFAULTS[el] || COVER_EXTRA_DEFAULTS;
    const fallback = d[key];
    return fallback === undefined ? null : fallback;
  }

  // ---- 外部字体（Phase 30）-------------------------------------------------
  //
  // 内置那 5 项写在 HTML 里，用户导入的从服务端来 ⇒ 下拉**每次重建**：
  // 这样新导入的字体立刻出现在列表里，也不会把当前选中项冲掉。
  // ★ 「＋ 从电脑里选字体…」不是一款字体，是个动作 —— 选中它只弹文件框，
  //   绝不把它当字体值提交上去。

  const FONT_IMPORT = '__import__';
  let userFonts = [];
  let builtinFontOpts = null;

  function fillFontOptions(current) {
    const sel = $('cv-font');
    if (!sel) return;
    if (!builtinFontOpts) {
      builtinFontOpts = Array.from(sel.options)
        .filter((o) => o.value && o.value !== FONT_IMPORT)
        .map((o) => ({ v: o.value, t: o.textContent }));
    }
    sel.innerHTML = '';
    builtinFontOpts.forEach((o) => sel.add(new Option(o.t, o.v)));
    userFonts.forEach((f) => sel.add(new Option(`${f.label}（导入）`, f.key)));
    sel.add(new Option('＋ 从电脑里选字体…', FONT_IMPORT));
    if (current) sel.value = current;
    // 赋不上（那款字体被删了 / 换电脑没带过来）就退回衬线，别留一个空选中
    if (!sel.value) sel.value = 'serif';
  }

  /** 打开封面窗口时拉一次字体清单。取不到就当没有 —— 下拉仍是内置 5 项，不挡人用。 */
  async function loadUserFonts() {
    try {
      const data = await api('/api/fonts');
      userFonts = data.fonts || [];
    } catch (err) {
      userFonts = [];
    }
  }

  function fontSizeText(n) {
    const v = Number(n) || 0;
    return v >= 1048576 ? `${(v / 1048576).toFixed(1)} MB`
      : `${Math.max(1, Math.round(v / 1024))} KB`;
  }

  /** 把选中的字体文件交给服务端。大文件（几 MB）走 dataURL，本机回环没有压力。 */
  async function importFont(file) {
    const dataUrl = await new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(String(fr.result));
      fr.onerror = () => reject(new Error('这个文件读不出来，换一个试试'));
      fr.readAsDataURL(file);
    });
    const res = await post('/api/fonts', { name: file.name, data: dataUrl });
    userFonts = res.fonts || [];
    toast(`已导入「${res.font.label}」（${fontSizeText(res.font.size)}）`);
    return res.font.key;
  }

  /** 改一项。本地先认，再防抖提交 —— 拖滑块时不会一个像素发一次请求。 */
  function coverSet(el, key, value) {
    const next = Object.assign({}, (plan && plan.coverText) || {});
    next[el] = Object.assign({}, next[el] || {}, { [key]: value });
    plan.coverText = next;
    // 文字内容能立刻反映到预览上：不然在右边打字时封面一动不动，
    // 根本分不清自己正在改哪个框。
    // ★ 只改 textContent，**不碰任何样式** —— 样式仍然只有服务端一份来源。
    if (key === 'text') {
      const api = coverApi();
      // ★ 就地写文字是"顺手让预览跟着动"的加分项，**不是唯一通路**。
      //   预览正巧在重载（结构刚变过）时 `api` 取不到，这一下就丢了 ——
      //   写不进去就顺手排一次重载，让服务端渲染时把文字带上。
      const wrote = !!(api && typeof api.setText === 'function'
        && api.setText(el, String(value)));
      if (!wrote) coverReloadPending = true;
    }
    renderCover();
    if (coverDragging) return;    // 拖动中只更新本地 + 控件，松手才提交
    clearTimeout(coverTimer);
    coverTimer = setTimeout(flushCover, 160);
  }

  /** 删一项（回到默认）。某一元素下什么都不剩时，连这个元素一起删掉。 */
  function coverDel(el, key) {
    const next = Object.assign({}, (plan && plan.coverText) || {});
    if (next[el]) {
      const cfg = Object.assign({}, next[el]);
      delete cfg[key];
      if (Object.keys(cfg).length) next[el] = cfg;
      else delete next[el];
    }
    plan.coverText = next;
    renderCover();
    clearTimeout(coverTimer);
    coverTimer = setTimeout(flushCover, 60);
  }

  /** 落一次提交。`structural=true` 表示**封面上元素增减 / 显隐变了** ——
   *  这种改动提交回来之后必须重载预览（理由见 coverReloadPending 那段注释）。 */
  function coverCommitSoon(structural) {
    if (structural) coverReloadPending = true;
    clearTimeout(coverTimer);
    coverTimer = setTimeout(flushCover, 60);
  }

  /** 「删掉这个框」。
   *
   *  ★ 两种元素两种做法 —— 因为这个动作对它们**不是同一件事**：
   *    · 自己加的框：把它的配置删了，框就真没了（要它回来就再"加"一个）。
   *    · 内置的三项（书名 / 副标题 / 页脚）：内容来自别处（书名输入框、副标题
   *      输入框、照片张数），**不能真删** —— 只能"藏起来"（`hide`），
   *      并且随时能恢复显示。页签留着它、只是划掉，就是为了让人找得回来。
   */
  function coverRemoveEl(el) {
    if (!plan) return;
    if (isExtraKey(el)) {
      const next = Object.assign({}, plan.coverText || {});
      delete next[el];
      plan.coverText = next;
      coverEl = 'title';
    } else {
      const next = Object.assign({}, plan.coverText || {});
      next[el] = Object.assign({}, next[el] || {}, { hide: true });
      plan.coverText = next;
    }
    renderCover();
    coverCommitSoon(true);   // ★ 元素增减了 → 等提交回来再重载预览（见 coverReloadPending）
  }

  /** 把一个被藏起来的内置元素放回来。 */
  function coverRestoreEl(el) {
    coverDel(el, 'hide');     // 清掉 hide（其余设置保留）
    coverCommitSoon(true);    // ★ 它要重新露出来 = 结构变了 → 提交回来再重载
  }

  /** 「这块恢复默认」：清掉当前元素的**全部样式设置**。
   *
   *  ★ 自定义框要**留住它自己那段文字** —— 用户按这个按钮是想"样式回默认"，
   *    不是想把自己写的那句话删掉。（要连句子一起去掉，用左边的「删掉这个框」。）
   */
  function coverResetEl(el) {
    if (!plan) return;
    const before = Object.assign({}, plan.coverText || {});
    const wasHidden = !!(before[el] || {}).hide;
    const next = Object.assign({}, before);
    if (isExtraKey(el)) {
      const text = (next[el] || {}).text;
      if (text === undefined) delete next[el];
      else next[el] = { text };
    } else {
      delete next[el];
    }
    plan.coverText = next;
    renderCover();
    // 之前是藏着的 → 现在它要重新露出来 = 结构变了 → 提交回来再重载
    coverCommitSoon(wasHidden);
  }

  /** 「＋ 加文字框」：挑一个没用过的编号，给一句占位文字，落点在封面下半部。 */
  function addCoverExtra() {
    if (!plan) return;
    const used = new Set(Object.keys(plan.coverText || {}).filter(isExtraKey));
    let key = '';
    for (let i = 1; i <= COVER_EXTRA_MAX; i += 1) {
      if (!used.has(`x${i}`)) { key = `x${i}`; break; }
    }
    if (!key) return;                      // 满了（按钮本来就是禁用的）
    const next = Object.assign({}, plan.coverText || {});
    next[key] = { text: '新文字' };
    plan.coverText = next;
    coverEl = key;
    renderCover();
    // ★ 新框得由服务端渲染出来 → 结构变了，等提交回来再重载（**不能**在这里立刻重载，
    //   那时服务端还没收到 x1，重载出来的封面里没有它 —— 就是 39/43 那个 bug）
    coverCommitSoon(true);
    const el = $('cv-text');
    if (el) { el.value = '新文字'; el.focus(); el.select(); }
  }

  function coverDelAll() {
    if (!plan) return;
    plan.coverText = {};
    coverEl = 'title';
    renderCover();
    coverCommitSoon(true);   // ★ 自定义框全没了 = 结构变了 → 提交回来再重载
  }

  /** 取封面预览那个 iframe（同源，可直接操作它的文档）。 */
  function coverFrame() {
    return $('cover-frame');
  }

  /** 取预览里编辑器暴露的接口；还没挂上就返回 null。 */
  function coverApi() {
    const frame = coverFrame();
    try {
      return (frame && frame.contentWindow && frame.contentWindow.__cve) || null;
    } catch (err) {
      return null;      // 跨域 / 还没加载好
    }
  }

  /**
   * ★ 把服务端算出来的样式串**原样**写到预览的封面上。
   *
   * 这是整件事的关键一步：预览显示什么，完全由服务端那串变量决定，
   * 前端不参与"拼样式"这件事（拖动过程除外，见 coverSet 的注释）。
   * 空串 ⇒ 连 style 属性都不写 —— 与成品 `cover_attr` 的写法一字不差。
   */
  function applyCoverStyle(styleText) {
    const api = coverApi();
    if (!api) return false;
    api.setStyle(typeof styleText === 'string' ? styleText : '');
    return true;
  }

  async function flushCover() {
    clearTimeout(coverTimer);
    coverTimer = null;
    try {
      const res = await post('/api/cover', { coverText: (plan && plan.coverText) || {} });
      if (plan) plan.coverText = res.coverText || {};
      applyCoverStyle(res.coverStyle);
      renderCover();
      // ★ 结构变了（加 / 删 / 隐藏 / 恢复文字框）：**现在**服务端已经拿到新配置，
      //   这时候重载才会渲染出正确的封面。提交失败就不清标记，留给下一次提交补上。
      if (coverReloadPending) {
        coverReloadPending = false;
        loadCoverFrame();
      }
    } catch (err) {
      showError(err.message);
    }
  }

  /** 装载编辑预览。`edit=1` 才会注入拖文字框那套脚本。 */
  function loadCoverFrame() {
    const frame = coverFrame();
    if (!frame) return;
    frame.src = `/preview/cover?edit=1&t=${Date.now()}`;
  }

  /** 预览文档加载完 → 挂上主窗口这边的回调。 */
  function wireCoverFrame() {
    // 关窗口时把 iframe 指到了 about:blank，那也会触发一次 load —— 得忽略掉，
    // 否则关个窗口还会在界面上留下一句"预览加载失败"。
    if (!coverOpen) return;
    const api = coverApi();
    if (!api) {
      // 挂不上就是真坏了（比如编辑器脚本没注入）。必须说出来，
      // 不能装作没事 —— 那样用户只会看到"拖不动，也不报错"。
      setCoverHint('封面预览没能加载出来，请关掉窗口重开一次。', true);
      return;
    }
    api.onSelect = (key) => {
      // ★ 判"这个键认不认"要用 coverElementList()，**不能**用 `COVER_DEFAULTS[key]`
      //   —— 自定义框不在 COVER_DEFAULTS 里，那样点一下预览里的新框会"选不中"，
      //   右边控件纹丝不动，用户只会觉得"点了没反应"。
      if (coverElementList().indexOf(key) >= 0) { coverEl = key; renderCover(); }
    };
    api.onDrag = (key, x, y) => {
      // 拖动中：只同步本地状态和右边的读数，**不发请求**。
      // （拖到哪儿是每帧都在变，一帧一个请求既没必要也会让手感发涩。）
      coverDragging = true;
      const next = Object.assign({}, (plan && plan.coverText) || {});
      next[key] = Object.assign({}, next[key] || {}, { x, y });
      plan.coverText = next;
      renderCover();
    };
    // 拖角缩放（Phase 26）：与拖动同理，改的是 `w` 和 `size` 两项。
    // 松手同样走 onDragEnd → 提交一次 → 用服务端样式串覆盖回来。
    api.onScale = (key, w, size) => {
      coverDragging = true;
      const next = Object.assign({}, (plan && plan.coverText) || {});
      next[key] = Object.assign({}, next[key] || {}, { w, size });
      plan.coverText = next;
      renderCover();
    };
    api.onDragEnd = () => {
      coverDragging = false;
      // 松手：提交一次，然后拿服务端样式串覆盖 —— 拖动时的临时变量到此为止。
      clearTimeout(coverTimer);
      coverTimer = setTimeout(flushCover, 40);
    };
    setCoverHint('');
    renderCover();
    // ★ 重载之后把"当前选中"再点一遍。新渲染出来的封面里，编辑器自己默认选中的是
    //   第一个框（书名）—— 不重新 select 的话，用户刚加完一个文字框会看到高亮
    //   跳回书名；而缩放手柄只画在"当前选中"的框上 ⇒ 表现成
    //   「明明选中着它，却没有手柄可拖」（39/43 里那条就是这么红的）。
    api.select(coverEl);
  }

  function setCoverHint(text, bad) {
    const el = $('cover-hint');
    if (!el) return;
    if (!text) {
      el.textContent = '在预览里拖文字框挪位置、拖右下角的小方块改大小。'
        + '不调的项自动跟随默认，不必逐项去设。';
      el.style.color = '';
      return;
    }
    el.textContent = text;
    el.style.color = bad ? 'var(--danger)' : '';
  }

  async function openCover() {
    if (!plan || !plan.photoCount) return;
    coverSnapshot = JSON.parse(JSON.stringify((plan && plan.coverText) || {}));
    coverOpen = true;
    // 强制重建一次页签：配置可能在窗口关着的时候被别处改过（换照片、换书名…
    // 都会让 plan 整体重来），拿旧签名兜着就会显示一份过时的清单。
    coverTabsSig = '';
    $('cover-modal').hidden = false;
    setCoverHint('');
    // ★ 先拿到字体清单再渲染（Phase 30）：不然下拉里没有外部字体那几项，
    //   回填时会把它当成"不认识的值"、静默退回衬线。
    await loadUserFonts();
    updateCoverDirty();
    loadCoverFrame();
    const ok = $('cover-ok');
    if (ok) ok.focus();
  }

  /** 关窗口。`restore=true` 时先把配置还原到打开那一刻（取消 / Esc）。 */
  async function closeCover(restore) {
    if (!coverOpen) return;
    coverOpen = false;
    clearTimeout(coverTimer);
    coverTimer = null;
    // 窗口关了就别再惦记着重载预览 —— 留着这个标记会让下一次提交白重载一次。
    coverReloadPending = false;
    const frame = coverFrame();
    try { if (frame) frame.src = 'about:blank'; } catch (err) { /* 无所谓 */ }
    $('cover-modal').hidden = true;

    if (restore && coverSnapshot !== null) {
      plan.coverText = coverSnapshot;
      renderCover();
      try {
        const res = await post('/api/cover', { coverText: coverSnapshot });
        if (plan) plan.coverText = res.coverText || {};
        renderCover();
      } catch (err) {
        showError(err.message);
      }
    }
    coverSnapshot = null;
    renderCover();
    // 回到主窗口：把焦点还给那个入口按钮，键盘用户不会掉到页面外面去。
    const entry = $('cover-open');
    if (entry && !entry.hidden) entry.focus();
  }

  /** 底栏那句「已调 N 项」，让"改没改过"一眼可见。 */
  function updateCoverDirty() {
    const el = $('cover-dirty');
    if (!el) return;
    const cfg = (plan && plan.coverText) || {};
    let n = 0;
    let boxes = 0;
    Object.keys(cfg).forEach((k) => {
      if (isExtraKey(k)) boxes += 1;
      n += Object.keys(cfg[k] || {}).length;
    });
    if (n === 0) el.textContent = '未调整（用默认样式）';
    else if (boxes) el.textContent = `已调 ${n} 项 · 加了 ${boxes} 个文字框`;
    else el.textContent = `已调 ${n} 项`;
  }

  function setCoverRange(id, vid, value, fmt) {
    const el = $(id);
    const out = $(vid);
    if (!el || !out) return;
    // 正在拖的那根不许被写回，否则手感会一顿一顿的
    if (document.activeElement !== el) el.value = String(value);
    out.textContent = fmt(Number(el.value));
  }

  /** 同 setCoverRange，但读数文字直接给（宽度要用它显示「自动 76.5%」这种）。 */
  function setCoverRangeText(id, vid, value, text) {
    const el = $(id);
    const out = $(vid);
    if (!el || !out) return;
    if (document.activeElement !== el) el.value = String(value);
    out.textContent = text;
  }

  /** 量一下这个元素当前实际占多宽（占整页的百分比）。
   *  用途：宽度没配过时（= 自动），控件上显示实测值，并写明"自动"。 */
  function coverMeasureWidth(key) {
    const api = coverApi();
    if (!api || typeof api.widthOf !== 'function') return null;
    const v = api.widthOf(key);
    return typeof v === 'number' && isFinite(v) ? v : null;
  }

  /** 页签的结构签名。只有它变了才重建页签 —— 拖滑块时每帧重建既白费又丢焦点。 */
  function coverTabsSignature() {
    const cfg = (plan && plan.coverText) || {};
    return coverElementList()
      .map((k) => `${k}|${coverLabel(k, cfg[k])}|${(cfg[k] || {}).hide ? 'off' : 'on'}`)
      .join('~');
  }

  function renderCoverTabs() {
    const wrap = $('cover-tabs');
    if (!wrap) return;
    const cfg = (plan && plan.coverText) || {};
    const sig = coverTabsSignature();
    if (sig !== coverTabsSig) {
      coverTabsSig = sig;
      wrap.innerHTML = '';
      coverElementList().forEach((k) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.dataset.el = k;
        b.setAttribute('role', 'tab');
        b.textContent = coverLabel(k, cfg[k]);
        if ((cfg[k] || {}).hide) b.classList.add('is-off');
        b.addEventListener('click', () => selectCoverEl(k));
        wrap.appendChild(b);
      });
    }
    wrap.querySelectorAll('button').forEach((b) => {
      b.classList.toggle('on', b.dataset.el === coverEl);
    });
  }

  /** 选中某个文字框：右边控件切过去，预览里对应的框也高亮。 */
  function selectCoverEl(key) {
    coverEl = key;
    renderCover();
    const api = coverApi();
    if (api) api.select(key);
  }

  /** 加 / 删那两个按钮的可用状态与文案。 */
  function updateCoverActions() {
    const cfg = (plan && plan.coverText) || {};
    const extras = coverElementList().filter(isExtraKey);
    const add = $('cover-add');
    if (add) {
      const full = extras.length >= COVER_EXTRA_MAX;
      add.disabled = full;
      add.title = full ? `最多 ${COVER_EXTRA_MAX} 个文字框` : '';
    }
    const del = $('cover-del');
    if (del) {
      // 内置的已被藏起来 → 同一个按钮变成反向动作「恢复显示」
      const hidden = !!(cfg[coverEl] || {}).hide;
      del.textContent = (!isExtraKey(coverEl) && hidden) ? '恢复显示' : '删掉这个框';
    }
  }

  function renderCover() {
    const entry = $('cover-entry');
    if (!entry || !plan) return;
    // 没有照片就没有封面可调（预览要那张封面照）
    entry.hidden = !plan.photoCount;
    if (entry.hidden) return;

    // 选中的那个框若已经不存在了（刚被删、或整份配置被清空），退回第一个
    if (coverElementList().indexOf(coverEl) < 0) coverEl = COVER_ELEMENTS[0];

    renderCoverTabs();
    updateCoverActions();

    const isExtra = isExtraKey(coverEl);
    const val = (k) => coverVal(coverEl, k);

    // 「文字」这一行只对**自己加的**框有意义 —— 书名/副标题/页脚的内容
    // 分别来自右边那栏的书名框、副标题框和照片张数，不该在这里改。
    const textRow = $('cv-text-row');
    if (textRow) textRow.hidden = !isExtra;
    const textEl = $('cv-text');
    if (textEl && document.activeElement !== textEl) textEl.value = String(val('text') || '');

    setCoverRange('cv-x', 'cv-x-v', val('x'), (v) => `${v}%`);
    setCoverRange('cv-y', 'cv-y-v', val('y'), (v) => `${v}%`);
    setCoverRange('cv-size', 'cv-size-v', val('size'), (v) => String(v));
    if ($('cv-y-k')) $('cv-y-k').textContent = COVER_Y_LABEL[coverEl] || '距顶';

    // 宽度（Phase 26）：没配过就是"自动"（由左边距 + 右边距定宽），
    // 这时显示实测值并写出"自动" —— 否则用户会以为那个数字是自己设的。
    const wCfg = coverCfg(coverEl).w;
    if (wCfg === undefined || wCfg === null) {
      const auto = coverMeasureWidth(coverEl);
      const shown = auto === null ? COVER_MIN_W : Math.round(auto * 10) / 10;
      setCoverRangeText('cv-w', 'cv-w-v', shown, auto === null ? '自动' : `自动 ${shown}%`);
    } else {
      setCoverRangeText('cv-w', 'cv-w-v', wCfg, `${wCfg}%`);
    }

    // <input type="color"> 只吃 #rrggbb；服务端只放行合法颜色，
    // 但只要不是 6 位 hex（比如用户手填的 rgb()），就保持控件原样不动。
    const colorEl = $('cv-color');
    if (colorEl && document.activeElement !== colorEl && /^#[0-9a-fA-F]{6}$/.test(String(val('color')))) {
      colorEl.value = String(val('color'));
    }

    const fontEl = $('cv-font');
    if (fontEl && document.activeElement !== fontEl) {
      // ★ 先**补齐**用户字体再回填：直接给 select 赋一个它还没有的值会失败，
      //   表现为"选了外部字体、刷新后又变回衬线"。
      fillFontOptions(String(val('font')));
    }

    const align = String(val('align'));
    document.querySelectorAll('#cv-align button').forEach((b) => {
      b.classList.toggle('on', b.dataset.align === align);
    });

    const italicEl = $('cv-italic');
    if (italicEl && document.activeElement !== italicEl) italicEl.checked = !!val('italic');

    updateCoverDirty();
  }

  /** 把服务端的书页结构画成跨页预览。 */
  function renderPreview() {
    const wrap = $('spreads');
    wrap.innerHTML = '';
    if (!plan || !plan.photoCount) return;

    const pages = plan.pages;
    const byOrder = new Map(plan.photos.map((p) => [p.order, p]));

    // 封面独占一张（showCover=true 的行为），之后两页一个跨页
    let i = 0;
    const groups = [];
    groups.push([pages[0]]);
    for (i = 1; i < pages.length; i += 2) {
      groups.push(pages.slice(i, i + 2));
    }

    groups.forEach((group, gi) => {
      const spread = document.createElement('div');
      const single = group.length === 1;
      spread.className = 'spread' + (single ? ' single' : '');

      const label = document.createElement('span');
      label.className = 'spread-label';
      label.textContent =
        gi === 0 ? '封面' :
        gi === groups.length - 1 ? '封底' :
        `跨页 ${gi}`;
      spread.appendChild(label);

      group.forEach((page, pi) => {
        spread.appendChild(renderPage(page, byOrder, pi, group.length));
      });

      wrap.appendChild(spread);
    });
  }

  // 照片外侧「淡淡的黑色渐变阴影」的载体，和成品 HTML 一一对应。
  // 只画不挨着另一页的那几条边；贴中线的那条不画（那边已有跨页过渡带 + 分界线）。
  function outerShadow(posInGroup) {
    if (groupLenSafe <= 1) {
      // 单页（封面、封底）四周都可以算「外侧」，但预览里保持克制：
      // 只按 verso/recto 的规则给左右，上下照给。
      return `<span class="outer-y top"></span>
              <span class="outer-y bottom"></span>`;
    }
    const horiz = posInGroup === 0 ? 'left' : 'right';
    return `<span class="outer-y top"></span>
            <span class="outer-y bottom"></span>
            <span class="outer-x ${horiz}"></span>`;
  }

  function renderPage(page, byOrder, posInGroup, groupLen) {
    groupLenSafe = groupLen;
    const el = document.createElement('div');
    el.className = 'page';

    if (page.kind === 'cover' || page.kind === 'backcover') {
      el.classList.add('cloth-page');
    } else if (page.kind === 'endpaper') {
      el.classList.add('endpaper-page');
    }

    // 书脊渐变：只在双页跨页的内侧加
    if (groupLen === 2) {
      el.classList.add(posInGroup === 0 ? 'spine-left' : 'spine-right');
    }
    el.classList.add(posInGroup === 0 ? 'verso' : 'recto');

    if (page.kind === 'cover') {
      // 封面也用第一张照片满版铺开，和成品一致。
      // 没有照片时才退回布面封面。
      const coverPhoto = byOrder.get(plan.photos[0]?.order);
      if (coverPhoto) {
        el.classList.add('photo-page');
        el.innerHTML =
          `<div class="pl">
             <img src="/thumb?id=${coverPhoto.order}&hero=1" alt="封面" loading="eager">
           </div>
           <div class="cover-scrim"></div>
           ${outerShadow(posInGroup)}
           <div class="cover-wrap">
             <h3 class="cover-t">${esc(plan.title)}</h3>
             <p class="cover-s">${esc(plan.subtitle)}</p>
           </div>
           <span class="cover-foot">${plan.photoCount} PHOTOGRAPHS</span>`;
      } else {
        el.innerHTML =
          `<div class="cover-wrap">
             <h3 class="cover-t">${esc(plan.title)}</h3>
             <p class="cover-s">${esc(plan.subtitle)}</p>
           </div>
           <span class="cover-foot">${plan.photoCount} PHOTOGRAPHS</span>`;
      }
    } else if (page.kind === 'backcover') {
      el.innerHTML = `<span class="backmark">${esc(plan.title)}</span>`;
    } else if (page.kind === 'title') {
      el.innerHTML =
        `<div class="tp"><h3>${esc(plan.title)}</h3><p>${esc(plan.subtitle)}</p></div>`;
    } else if (page.kind === 'colophon') {
      el.innerHTML =
        `<div class="cp">
           <p>${esc(plan.title)}</p>
           <p>${esc(plan.subtitle)}</p>
           <p>${plan.photoCount} 张照片 · 本地生成</p>
         </div>`;
    } else if (page.kind === 'plate' && page.photoOrder != null) {
      const photo = byOrder.get(page.photoOrder);
      if (photo) {
        el.classList.add('photo-page');
        const posCls = {
          '': 'pos-center', high: 'pos-high', low: 'pos-low', aside: 'pos-aside',
        }[photo.position || ''] || 'pos-center';
        el.innerHTML =
          `<div class="pl ${photo.plate} ${posCls}">
             <img src="/thumb?id=${photo.order}&hero=1" alt="${esc(photo.name)}" loading="lazy">
           </div>
           ${outerShadow(posInGroup)}`;
      }
    }

    if (page.kind !== 'cover' && page.kind !== 'backcover') {
      const folio = document.createElement('span');
      folio.className = 'folio';
      folio.textContent = String(page.index);
      el.appendChild(folio);
    }
    return el;
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // ---------------------------------------------------------------- 动作

  async function applyPlan(next) {
    plan = next.plan;
    renderStatus();
    renderGrid();
    renderSelected();
    renderPreview();
    // 封面预览用的是"当前书名/副标题"，改了那两栏这里也要跟着刷新。
    // ★ 只在编辑窗口开着时才重载 —— 关着的时候不该白起一个预览文档。
    //   窗口开着时书名也改不了（模态挡住了），所以不存在"编辑到一半被冲掉"。
    if (coverOpen) loadCoverFrame();
  }

  async function reorder(from, to) {
    if (!plan) return;
    const orders = plan.photos.map((p) => p.order);
    const fromIdx = orders.indexOf(from);
    const toIdx = orders.indexOf(to);
    if (fromIdx < 0 || toIdx < 0) return;
    orders.splice(toIdx, 0, orders.splice(fromIdx, 1)[0]);
    try {
      await applyPlan(await post('/api/plan', { order: orders }));
      toast('已换顺序');
    } catch (err) {
      showError(err.message);
    }
  }

  /** 把某张照片挪到「第 want 个」位置（want 从 1 数起，指人看到的位次）。
   *
   * ★ 位次 ≠ 照片编号（`Photo.order`）。编号是身份号、是缩略图的取图键，
   *   从头到尾不变；重排只动列表次序。所以这里拿"目标位次"去查数组下标，
   *   而不是拿编号去比大小 —— 否则编号一旦乱序（拖过序就会乱）就全错。
   *
   * ★ 越界 / 填了非数字：**什么都不做，默默退回原位**（他的明确选择）。
   *   不弹窗、不提示 —— 敲错了不该被弹一脸。
   */
  async function moveToPosition(orderNo, want) {
    if (!plan) return false;
    const n = plan.photos.length;
    if (!Number.isInteger(want) || want < 1 || want > n) return false;
    const orders = plan.photos.map((p) => p.order);
    const fromIdx = orders.indexOf(orderNo);
    if (fromIdx < 0 || fromIdx === want - 1) return false;
    orders.splice(want - 1, 0, orders.splice(fromIdx, 1)[0]);
    try {
      await applyPlan(await post('/api/plan', { order: orders }));
      toast(`已挪到第 ${want} 张`);
      return true;
    } catch (err) {
      showError(err.message);
      return false;
    }
  }

  /** 删掉一张照片。
   *
   * ★ `Photo.order` **不重编号**（findings 112）—— 它是身份号兼缩略图取图键，
   *   重编号会让界面上的图与数据对不上。界面上左下角显示的是**位次**，
   *   由 renderGrid 重画后自动收敛成连续的 1、2、3…（Phase 38）。
   */
  async function removePhoto(orderNo) {
    if (!plan) return;
    if (plan.photos.length <= 1) {
      showError('至少要留一张照片，不能把照片全删光。');
      return;
    }
    try {
      await applyPlan(await post('/api/plan', { remove: [orderNo] }));
      // 选中的那张被删了，选中态要跟着清掉。
      if (selectedOrder === orderNo) selectedOrder = null;
      toast('已删掉一张');
      renderGrid();
      renderSelected();
    } catch (err) {
      showError(err.message);
    }
  }

  async function editPlate(plate) {
    if (selectedOrder === null) return;
    try {
      await applyPlan(await post('/api/plan', {
        edits: [{ order: selectedOrder, plate }],
      }));
    } catch (err) {
      showError(err.message);
    }
  }

  async function editPosition(position) {
    if (selectedOrder === null) return;
    try {
      await applyPlan(await post('/api/plan', {
        edits: [{ order: selectedOrder, position }],
      }));
    } catch (err) {
      showError(err.message);
    }
  }

  async function pickFolder() {
    const btn = $('btn-pick');
    btn.disabled = true;
    btn.textContent = '等待选择…';
    try {
      const picked = await post('/api/pick-folder');
      if (picked.cancelled) return;
      btn.textContent = '正在读取照片…';
      await applyPlan(await post('/api/scan', { path: picked.path }));
      selectedOrder = null;
      toast(`载入 ${plan.photoCount} 张照片`);
    } catch (err) {
      showError(err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = '选择照片文件夹…';
    }
  }

  async function autoArrange() {
    try {
      await applyPlan(await post('/api/auto-arrange'));
      toast('已重新自动排版');
    } catch (err) {
      showError(err.message);
    }
  }

  async function generate() {
    const btn = $('btn-generate');
    btn.disabled = true;
    $('after-gen').hidden = true;
    $('progress').hidden = false;
    $('progress-text').textContent = '正在处理照片…';

    try {
      // 先把书名与输出目录存下来，再出书
      await applyPlan(await post('/api/plan', {
        title: $('input-title').value,
        subtitle: $('input-subtitle').value,
        outputDir: $('input-output').value,
      }));

      const result = await post('/api/generate');
      generatedHtml = result.indexHtml;
      $('progress').hidden = true;
      $('after-gen').hidden = false;
      toast('画册做好了');

      // 按共识：生成完直接在浏览器里打开成品
      await post('/api/open-output');
    } catch (err) {
      $('progress').hidden = true;
      showError(err.message);
    } finally {
      btn.disabled = !(plan && plan.photoCount);
    }
  }

  // ---------------------------------------------------------------- 绑定

  // ------------------------------------------------- 全屏看预览（Phase 38）
  //
  // 佘先生（2026-09-30）：「我想要电脑整个屏幕的全屏显示的功能，就是新增一个组块
  //   在工具的右下角，主要不是在图片上，我点击进入真正的全屏，右下角再放一个叉号的
  //   组件用于退出全屏，注意叉号的颜色要淡，不能抢眼，当没有操作三秒后时叉号不显示，
  //   但在相应的位置仍有其功能，当我再次操作时比如光标移动和翻页时叉号显示」。
  //   他选的那一项：进全屏后**只留中间那栏跨页预览**。
  //
  // ★ 四件必须守住的：
  //   1. 用**浏览器真全屏**（Fullscreen API），不是自己拿一个铺满的层冒充 ——
  //      「真正的全屏」= 浏览器边框、地址栏都让出去。实测无头 Chromium 也支持
  //      （fullscreenElement 有值、:fullscreen 命中），所以验收里这条是真判据，
  //      没有打桩、没有假绿。
  //   2. 「只留预览」靠 html 上的 fs-mode 类切，进 / 退全屏都在 fullscreenchange
  //      里同步。★ 光靠 :fullscreen 伪类不够 —— 用户按 Esc / F11 自己退出时，
  //      类是我们自己说了算的那一份，必须收敛。
  //   3. 叉号"隐形"**只能用 opacity**。换成 display:none / visibility:hidden
  //      会把点击一起取消，就不满足他要求的「在相应的位置仍有其功能」。
  //   4. 任何动静都算"在操作"：光标移动、滚轮、键盘、点击、滚动。
  //      监听挂 **capture 阶段** —— scroll 不冒泡，挂冒泡阶段收不到内层滚动。

  const FS_IDLE_MS = 3000;
  let fsIdleTimer = 0;

  /** 三秒没操作就把叉号隐掉（只是变透明，位置与点击都留着）。 */
  function fsPoke() {
    if (!document.fullscreenElement) return;   // 不在全屏就别白跑计时器
    const el = $('fs-exit');
    if (!el) return;
    el.classList.remove('is-idle');
    clearTimeout(fsIdleTimer);
    fsIdleTimer = setTimeout(() => el.classList.add('is-idle'), FS_IDLE_MS);
  }

  /** 进 / 退全屏都把界面收敛到同一份状态 —— 不管是谁触发的：
   *  我们的按钮、键盘 Esc、还是浏览器自己的 F11。 */
  function fsSync() {
    const on = !!document.fullscreenElement;
    document.documentElement.classList.toggle('fs-mode', on);
    clearTimeout(fsIdleTimer);
    const el = $('fs-exit');
    if (!on && el) el.classList.remove('is-idle');
    if (on) fsPoke();
  }

  async function fsEnter() {
    try {
      await document.documentElement.requestFullscreen({ navigationUI: 'hide' });
    } catch (err) {
      showError('浏览器没让进全屏：' + (err && err.message ? err.message : String(err)));
    }
  }

  async function fsExit() {
    // 退不出去也没什么可补救的 —— 浏览器自己还留着 Esc 这条路。
    try { if (document.fullscreenElement) await document.exitFullscreen(); } catch { /* 忽略 */ }
  }

  function wireFullscreen() {
    if ($('btn-full')) $('btn-full').addEventListener('click', fsEnter);
    const x = $('fs-exit');
    if (x) x.addEventListener('click', fsExit);
    document.addEventListener('fullscreenchange', fsSync);
    for (const ev of ['mousemove', 'pointerdown', 'wheel', 'keydown', 'scroll', 'touchstart']) {
      document.addEventListener(ev, fsPoke, { passive: true, capture: true });
    }
  }

  function bind() {
    $('btn-pick').addEventListener('click', pickFolder);
    $('btn-auto').addEventListener('click', autoArrange);
    $('btn-generate').addEventListener('click', generate);

    wireFullscreen();

    $('btn-pick-output').addEventListener('click', async () => {
      try {
        const picked = await post('/api/pick-folder');
        if (picked.cancelled) return;
        $('input-output').value = picked.path;
        await applyPlan(await post('/api/plan', { outputDir: picked.path }));
      } catch (err) {
        showError(err.message);
      }
    });

    // 临时改过输出目录后一键回到默认（画册集）
    if ($('btn-output-default')) {
      $('btn-output-default').addEventListener('click', async () => {
        if (!outputDefault) return;
        try {
          $('input-output').value = outputDefault;
          await applyPlan(await post('/api/plan', { outputDir: outputDefault }));
        } catch (err) {
          showError(err.message);
        }
      });
    }

    document.querySelectorAll('#plate-options button').forEach((btn) => {
      btn.addEventListener('click', () => editPlate(btn.dataset.plate));
    });
    document.querySelectorAll('#pos-options button').forEach((btn) => {
      btn.addEventListener('click', () => editPosition(btn.dataset.pos));
    });

    $('btn-close-sel').addEventListener('click', () => {
      selectedOrder = null;
      renderGrid();
      renderSelected();
    });

    // ---- 封面文案编辑窗口 ------------------------------------------------
    // 佘先生：「点击唤起编辑封面的窗口 … 点击确定后返回工具的主窗口」。
    $('cover-open').addEventListener('click', openCover);
    // 预览文档每次加载完（首次打开、或书名变了重载）都要重新挂回调 ——
    // 重载后 window.__cve 是个新对象，旧回调不作数了。
    $('cover-frame').addEventListener('load', wireCoverFrame);

    $('cover-ok').addEventListener('click', async () => {
      clearTimeout(coverTimer);
      coverTimer = null;
      await flushCover();     // 确定 = 把当前配置落定（其实改的时候就在提交，这里补最后一拍）
      await closeCover(false);
    });
    $('cover-cancel').addEventListener('click', () => { closeCover(true); });
    $('cover-x').addEventListener('click', () => { closeCover(true); });

    // Esc = 取消。只在窗口开着时接管，别影响主窗口的其他键盘操作。
    document.addEventListener('keydown', (ev) => {
      if (!coverOpen || ev.key !== 'Escape') return;
      ev.preventDefault();
      ev.stopPropagation();
      closeCover(true);
    });

    const onCoverRange = (id, key) => {
      $(id).addEventListener('input', () => coverSet(coverEl, key, Number($(id).value)));
    };
    onCoverRange('cv-x', 'x');
    onCoverRange('cv-y', 'y');
    onCoverRange('cv-w', 'w');
    onCoverRange('cv-size', 'size');

    $('cv-text').addEventListener('input', () => coverSet(coverEl, 'text', $('cv-text').value));

    $('cv-color').addEventListener('input', () => coverSet(coverEl, 'color', $('cv-color').value));
    $('cv-color-reset').addEventListener('click', () => coverDel(coverEl, 'color'));
    $('cv-font').addEventListener('change', () => {
      const value = $('cv-font').value;
      if (value === FONT_IMPORT) {
        // 选的是「导入」这个动作，不是一款字体：把下拉退回当前值，再弹文件框。
        const cfg = coverCfg(coverEl);
        fillFontOptions(String((cfg && cfg.font) || 'serif'));
        const picker = $('cv-font-file');
        if (picker) picker.click();
        return;
      }
      coverSet(coverEl, 'font', value);
    });

    // 选完字体文件：上传 → 成功后**选中它**（这一次 coverSet 会把预览刷新）。
    // ★ 先清空 value，否则再选同一个文件不会触发 change。
    $('cv-font-file').addEventListener('change', async (ev) => {
      const file = ev.target.files && ev.target.files[0];
      ev.target.value = '';
      if (!file) return;
      try {
        const key = await importFont(file);
        coverSet(coverEl, 'font', key);
      } catch (err) {
        showError(String(err.message || err));
        const cfg = coverCfg(coverEl);
        fillFontOptions(String((cfg && cfg.font) || 'serif'));
      }
    });
    $('cv-italic').addEventListener('change', () => coverSet(coverEl, 'italic', $('cv-italic').checked));
    document.querySelectorAll('#cv-align button').forEach((btn) => {
      btn.addEventListener('click', () => coverSet(coverEl, 'align', btn.dataset.align));
    });

    // ★ 页签的点击**不在这里绑**：页签是按配置动态重建的（见 renderCoverTabs），
    //   在那儿逐个绑。在这里绑一次的话，重建出来的新按钮一个都不会响应 ——
    //   而"点了没反应"这种症状最容易被当成"功能没做"。

    // 「＋ 加文字框」/「删掉这个框」（Phase 26）
    $('cover-add').addEventListener('click', addCoverExtra);
    $('cover-del').addEventListener('click', () => {
      const cfg = coverCfg(coverEl);
      // 内置元素被藏起来时，同一个按钮变成反向的「恢复显示」
      if (!isExtraKey(coverEl) && cfg.hide) coverRestoreEl(coverEl);
      else coverRemoveEl(coverEl);
    });

    $('cover-reset-el').addEventListener('click', () => coverResetEl(coverEl));
    $('cover-reset-all').addEventListener('click', coverDelAll);

    $('btn-open').addEventListener('click', async () => {
      try { await post('/api/open-output'); }
      catch (err) { showError(err.message); }
    });
    $('btn-reveal').addEventListener('click', async () => {
      try { await post('/api/reveal-output'); }
      catch (err) { showError(err.message); }
    });

    $('btn-shutdown').addEventListener('click', async () => {
      try { await post('/api/shutdown'); } catch (err) { /* 服务可能已退出 */ }
      $('modal-title').textContent = '工具已关闭';
      $('modal-body').textContent = '后台服务已停止，可以关掉这个页面了。';
      $('modal').hidden = false;
      $('modal-ok').addEventListener('click', () => window.close(), { once: true });
    });

    $('modal-ok').addEventListener('click', () => { $('modal').hidden = true; });

    // 书名/副标题实时同步（防抖），让预览立刻反映。
    // ★ 敲键盘的同时把这两栏标记成「用户所有」：服务端的回包从此不再写回输入框，
    //   否则删到空的那一瞬间会被服务端兜底的默认书名顶回来（这是修掉的 bug）。
    let textTimer = null;
    const flushText = async () => {
      clearTimeout(textTimer);
      textTimer = null;
      try {
        await applyPlan(await post('/api/plan', {
          title: $('input-title').value,
          subtitle: $('input-subtitle').value,
        }));
      } catch (err) { /* 输入过程中出错不打断 */ }
    };
    const syncText = () => {
      drafts.title = $('input-title').value;
      drafts.subtitle = $('input-subtitle').value;
      clearTimeout(textTimer);
      textTimer = setTimeout(flushText, 420);
    };
    $('input-title').addEventListener('input', syncText);
    $('input-subtitle').addEventListener('input', syncText);

    // 离开输入框时把还卡在防抖里的最后几个字立刻落一次
    const flushOnBlur = () => { if (textTimer) flushText(); };
    $('input-title').addEventListener('blur', flushOnBlur);
    $('input-subtitle').addEventListener('blur', flushOnBlur);

    document.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape') {
        $('modal').hidden = true;
        selectedOrder = null;
        renderGrid();
        renderSelected();
      }
    });
  }

  // ---------------------------------------------------------------- 启动

  async function boot() {
    bind();
    try {
      const status = await api('/api/status');
      if (!status.pillow) {
        showError('缺少图像处理库 Pillow，无法处理照片。');
        return;
      }
      if (!status.runtimePresent) {
        showError('找不到画册运行时文件，工具目录可能不完整。');
        return;
      }
      await applyPlan(await api('/api/plan'));
    } catch (err) {
      showError(err.message);
    }
  }

  document.addEventListener('DOMContentLoaded', boot);
})();
