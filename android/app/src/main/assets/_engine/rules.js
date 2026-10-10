/* 线B · 手机出书引擎 —— 排版规则（特征数字 -> 档位 / 页序）
 * ============================================================================
 * 这是链① `app/make_flipbook.py` 里三段纯规则的**逐条照搬**（B2）：
 *   ① orientation 判定   —— probe() 内、:183-189
 *   ② assign_plates()    —— :237-288（五步，顺序不能换）
 *   ③ build_page_sequence() —— :369-390（纯枚举，无分支）
 * 对照件：**链①原件冻结，只读 import 取真值**（tools/_b2_edges.py）。
 *
 * ★ 照搬的六条硬规矩（错了就"看着像、其实不一样"）：
 *   1. orientation 用 **EXIF 纠正后**的宽高；`ratio = width / max(1, height)`
 *      ⇒ `>1.08` landscape · `<0.93` portrait · **其余（含恰好 1.08 / 0.93）= square**
 *      （比较是**严格**的，等于不算）
 *   2. `landscape` **只**在第一步赋 `large`+`position=""`，之后**不参与任何排序/修正**
 *   3. `uprights = 非 landscape`（**square 也算 upright**）；空 ⇒ ②直接 return
 *   4. 排序 key 是 **归一化值 `(sh-lo)/span`**（不是裸 sharpness）；
 *      `span = (hi-lo) or 1.0` ⇒ **全相等时 span 退化成 1.0（不是 0、不除零）**
 *   5. `frac = i / max(1, n-1)`；`n==1` ⇒ `frac = 0.0`；分档用 **`<=`**（0.34 / 0.67）
 *   6. **两条修正走的是"原始顺序"，不是 ranked**：
 *      · 修正A（同跨页两个 large）走 `photos`、按 `(0,1),(2,3)…` 配对，
 *        `range(0, len-1, 2)` ⇒ **奇数张时最后一张不参与**；**只改 plate、不动 position**
 *      · 修正B（相邻两 small）走 `uprights`、`i` 从 1 起、比较**已改过的** plate
 *
 * 与链①的等价性说明
 *   · Python `sorted` 是**稳定排序** ⇒ 本文件用「key 降序 + 原索引升序」显式 tie-break，
 *     在任意引擎上都与它等价（不依赖 V8 的 sort 稳定性）。
 *   · Python `(hi-lo) or 1.0` ⟺ JS `(hi-lo) || 1.0`（0 为 falsy，语义相同）。
 *
 * 接口
 *   __engineRules.orientationOf(width, height) -> 'landscape' | 'portrait' | 'square'
 *   __engineRules.assignPlates(items) -> items
 *       items: [{name?, width, height, mean_lum, sharpness}]（**顺序语义 = 已按自然序排好**）
 *       就地写入 `orientation` / `plate` / `position`，返回同一数组。
 *   __engineRules.buildPageSequence(items) -> [{kind, photo, density, index, folio}]
 *       `photo` 是**传入的那一项本身**（不是名字）；封面/版权页/封底为 null。
 *   __engineRules.sortNatural(names) / __engineRules.naturalKey(name)
 *       复刻链① `list_images()` 的自然排序（IMG_2 在 IMG_10 之前），供扫描环节用。
 *   __engineRules.PLATE_GEOMETRY  链① :63-68 的档位几何（宽%, 高%）
 *
 * 老内核（真机 WebView = Chrome 83）约束：本文件只用 ES5 语法，不用箭头函数/可选链。
 * ============================================================================
 */
(function (root) {
  'use strict';

  /* 链① `PLATE_GEOMETRY`（make_flipbook.py:63-68），取自运行时 book-style.css */
  var PLATE_GEOMETRY = {
    small: [49, 53],
    medium: [68, 65],
    large: [86, 82],
    portrait: [67, 66]
  };

  /* 链① `probe()` 里的朝向阈值（:184-189） */
  var LANDSCAPE_RATIO = 1.08;
  var PORTRAIT_RATIO = 0.93;

  /* 链① `assign_plates()` 里的分档阈值（:266/:269） */
  var FRAC_LARGE = 0.34;
  var FRAC_MEDIUM = 0.67;
  /* 链① :270/:283 的"亮/暗"分界（亮 >= 140 给 medium，暗给 portrait） */
  var LUM_MEDIUM_MIN = 140;

  function orientationOf(width, height) {
    var ratio = width / Math.max(1, height);
    if (ratio > LANDSCAPE_RATIO) { return 'landscape'; }
    if (ratio < PORTRAIT_RATIO) { return 'portrait'; }
    return 'square';
  }

  function isLandscape(it) {
    return it.orientation === 'landscape';
  }

  /* --------------------------------------------------------------------------
   * ② assign_plates()：给每张照片定 plate 与 position
   * ------------------------------------------------------------------------ */
  function assignPlates(items) {
    if (!items || !items.length) { return items; }

    var i, n;

    /* ① 朝向先落地（链①是在 probe() 里算的，这里补上，保证口径一致） */
    for (i = 0; i < items.length; i++) {
      var it = items[i];
      it.orientation = orientationOf(it.width, it.height);
      if (it.plate === undefined || it.plate === null) { it.plate = 'medium'; }
      if (it.position === undefined || it.position === null) { it.position = ''; }
    }

    /* ② 横构图天然占满一整页，给最大；**它自己就是跨页重心**（不参与下面排序） */
    for (i = 0; i < items.length; i++) {
      if (isLandscape(items[i])) {
        items[i].plate = 'large';
        items[i].position = '';
      }
    }

    /* ③ 竖构图（含方图）单独拎出来 */
    var uprights = [];
    for (i = 0; i < items.length; i++) {
      if (!isLandscape(items[i])) { uprights.push(items[i]); }
    }
    if (!uprights.length) { return items; }

    var lo = uprights[0].sharpness, hi = uprights[0].sharpness;
    for (i = 1; i < uprights.length; i++) {
      var s = uprights[i].sharpness;
      if (s < lo) { lo = s; }
      if (s > hi) { hi = s; }
    }
    var span = (hi - lo) || 1.0;   /* ★ 全相等时退化 1.0，与 Python `or 1.0` 同语义 */

    /* ④ ranked：按归一化清晰度降序；同值按原顺序（= Python 稳定排序） */
    var ranked = uprights.slice();
    for (i = 0; i < ranked.length; i++) { ranked[i].__ord = i; }
    ranked.sort(function (a, b) {
      var ka = (a.sharpness - lo) / span;
      var kb = (b.sharpness - lo) / span;
      if (kb !== ka) { return kb - ka; }      /* 降序 */
      return a.__ord - b.__ord;               /* 同值：保持原顺序 */
    });

    n = ranked.length;
    for (i = 0; i < n; i++) {
      var ph = ranked[i];
      var frac = (n > 1) ? (i / (n - 1)) : 0.0;
      if (frac <= FRAC_LARGE) {
        ph.plate = 'large';
        ph.position = (i % 2 === 0) ? 'high' : '';
      } else if (frac <= FRAC_MEDIUM) {
        ph.plate = (ph.mean_lum >= LUM_MEDIUM_MIN) ? 'medium' : 'portrait';
        ph.position = '';
      } else {
        ph.plate = 'small';
        ph.position = (i % 2 === 0) ? 'low' : 'aside';
      }
    }
    for (i = 0; i < ranked.length; i++) { delete ranked[i].__ord; }

    /* ⑤ 修正A：同一个跨页（读者看到的 (0,1),(2,3)… 配对）不要出现两个 large */
    for (i = 0; i + 1 < items.length; i += 2) {
      var a = items[i], b = items[i + 1];
      if (isLandscape(a) || isLandscape(b)) { continue; }
      if (a.plate === 'large' && b.plate === 'large') {
        b.plate = (b.mean_lum < LUM_MEDIUM_MIN) ? 'portrait' : 'medium';
        /* ★ position 保持不变（链①就是这么写的） */
      }
    }

    /* ⑥ 修正B：相邻两张不要都是 small（走 uprights，用**已改过**的 plate 比较） */
    for (i = 1; i < uprights.length; i++) {
      if (uprights[i].plate === 'small' && uprights[i - 1].plate === 'small') {
        uprights[i].plate = 'medium';
      }
    }

    return items;
  }

  /* --------------------------------------------------------------------------
   * ③ build_page_sequence()：封面 → 照片… → 版权页 → 封底
   * ------------------------------------------------------------------------ */
  function buildPageSequence(photos) {
    var pages = [{ kind: 'cover', photo: null }];
    var i;
    for (i = 0; i < photos.length; i++) {
      pages.push({ kind: 'plate', photo: photos[i] });
    }
    pages.push({ kind: 'colophon', photo: null });
    pages.push({ kind: 'backcover', photo: null });

    for (i = 0; i < pages.length; i++) {
      pages[i].density = (i === 0 || i === pages.length - 1) ? 'hard' : 'soft';
      pages[i].index = i;
      pages[i].folio = i + 1;   /* ★ 封面算第 1 页，与状态条同一套账 */
    }
    return pages;
  }

  /* --------------------------------------------------------------------------
   * 扫描环节：复刻链① `list_images()` 的自然排序（:139-152）
   *   IMG_2 排在 IMG_10 之前 —— 按「数字段 / 非数字段」交替切分后逐段比较。
   * ------------------------------------------------------------------------ */
  function naturalKey(name) {
    var parts = String(name).split(/(\d+)/);
    var key = [];
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i];
      if (p === '') { continue; }
      key.push(/^\d+$/.test(p) ? parseInt(p, 10) : p.toLowerCase());
    }
    return key;
  }

  function cmpNatural(a, b) {
    var ka = naturalKey(a), kb = naturalKey(b);
    var n = Math.min(ka.length, kb.length);
    for (var i = 0; i < n; i++) {
      var x = ka[i], y = kb[i];
      var xn = typeof x === 'number', yn = typeof y === 'number';
      if (xn && yn) {
        if (x !== y) { return x - y; }
      } else if (xn !== yn) {
        /* Python `int if part.isdigit() else str` 的混合比较在 py3 会抛错，
           实际输入里同一位置要么都是数字要么都是文字，这里给一个确定次序兜底。 */
        return xn ? -1 : 1;
      } else if (x !== y) {
        return x < y ? -1 : 1;
      }
    }
    return ka.length - kb.length;
  }

  function sortNatural(names) {
    var arr = names.slice();
    arr.sort(cmpNatural);
    return arr;
  }

  var API = {
    orientationOf: orientationOf,
    assignPlates: assignPlates,
    buildPageSequence: buildPageSequence,
    naturalKey: naturalKey,
    sortNatural: sortNatural,
    PLATE_GEOMETRY: PLATE_GEOMETRY,
    LANDSCAPE_RATIO: LANDSCAPE_RATIO,
    PORTRAIT_RATIO: PORTRAIT_RATIO,
    FRAC_LARGE: FRAC_LARGE,
    FRAC_MEDIUM: FRAC_MEDIUM,
    LUM_MEDIUM_MIN: LUM_MEDIUM_MIN
  };

  root.__engineRules = API;
  if (typeof module !== 'undefined' && module.exports) { module.exports = API; }
})(typeof window !== 'undefined' ? window : (typeof global !== 'undefined' ? global : this));
