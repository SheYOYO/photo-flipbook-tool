/**
 * artwork.js —— 链① `render_artwork()` 里那两个**纯算术**部分的 JS 复刻（B3.5）
 *
 * 为什么要单独一个小文件
 *   手机出书时，index.html 里每张照片要写
 *       <img src="{artwork}" width="{artwork_width}" height="{artwork_height}">
 *   这三个值来自链① app/make_flipbook.py 的 render_artwork()（:437-460）：
 *       name   = f"{index:02d}-{sanitize_stem(photo.path.stem)}.jpg"
 *       img.thumbnail((ARTWORK_LONG_EDGE, ARTWORK_LONG_EDGE), LANCZOS)
 *       photo.artwork_width, photo.artwork_height = img.size
 *   它们**只依赖文件名和 EXIF 纠正后的像素尺寸**，是纯字符串 + 纯算术，
 *   ⚠ 与 JPEG 编码无关（index.html 不引用像素内容）⇒ 本文件不复刻编码。
 *
 *   独立成文件是为了**不动** probe.js / rules.js / template.js（"能不改就不改"）。
 *
 * 逐字照搬的三条硬语义（都是**实测**出来的，不是猜的）
 *   1) Python `re` 的 `\w`（str 模式）：
 *      全量 1,112,064 个码位实测 ⇒ == `[\p{L}\p{N}]` ∪ {U+005F}，
 *      仅 9 个例外（都是 Pc 且不是 `_`：203F 2040 2054 FE33 FE34 FE4D FE4E FE4F FF3F）。
 *      JS 的 `\w` 只认 ASCII ⇒ 绝不能照抄。
 *   2) Python 的 `\s`（== str.isspace()）：**29 个码位**
 *      09 0A 0B 0C 0D 1C 1D 1E 1F 20 85 A0 1680 2000..200A 2028 2029 202F 205F 3000
 *      JS 的 `\s` **不同**（多 FEFF、少 1C-1F 与 85）⇒ 硬编码这 29 个。
 *   3) PIL 12.3 `Image.thumbnail()` 的尺寸公式（只要尺寸，不做重采样）：
 *      x=y=EDGE；若 x>=w 且 y>=h ⇒ 不缩；
 *      否则按 aspect=w/h 择一：
 *          x/y >= aspect ⇒ x = round_aspect(y*aspect, |aspect - n/y|)
 *          否则           ⇒ y = round_aspect(x/aspect, |aspect - x/n|)
 *      round_aspect(number, key) = max(min(floor(number), ceil(number), key=key), 1)
 *      —— 即 floor / ceil 里**更贴近原比例**的那个，且不小于 1。
 *
 * ES5 约束（老内核 Chrome 83）：不用 let/const/箭头/class/padStart/Object.assign/可选链。
 * 例外：`\p{...}` 需 `u` 标志（Chrome 64+ 就支持，83 没问题）。
 */

(function (root) {
  'use strict';

  var ARTWORK_LONG_EDGE = 1280; // 链① make_flipbook.py :58

  // ---------------------------------------------------------------------------
  // 1) Python 的空白符（re \s == str.isspace()，29 个码位）
  // ---------------------------------------------------------------------------
  // 09 0A 0B 0C 0D | 1C 1D 1E 1F | 20 | 85 | A0 | 1680 | 2000-200A |
  // 2028 2029 | 202F | 205F | 3000
  var PY_SPACE =
    '\u0009\u000A\u000B\u000C\u000D\u001C\u001D\u001E\u001F\u0020' +
    '\u0085\u00A0\u1680' +
    '\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200A' +
    '\u2028\u2029\u202F\u205F\u3000';

  function isPySpace(ch) {
    return PY_SPACE.indexOf(ch) >= 0;
  }

  /** Python `s.strip()`（无参）—— 按**码位**去首尾空白。 */
  function pyStrip(s) {
    var a = String(s);
    var i = 0;
    var j = a.length;
    while (i < j && isPySpace(a.charAt(i))) i++;
    while (j > i && isPySpace(a.charAt(j - 1))) j--;
    return a.slice(i, j);
  }

  // ---------------------------------------------------------------------------
  // 2) Python 的 `\w`：[\p{L}\p{N}] ∪ {_}
  // ---------------------------------------------------------------------------
  // ⚠ 用 try 兜底：万一某个极老内核不认 \p{}（< Chrome 64），退到 ASCII+常用汉字区，
  //    宁可"少删几个字符"也不能整段崩（"不许崩溃"是硬要求）。
  var RE_W;
  try {
    RE_W = new RegExp('[\\p{L}\\p{N}_]', 'u');
    // 自检：中文与拉丁都应命中，emoji 不应命中
    if (!RE_W.test('中') || !RE_W.test('A') || RE_W.test('\uD83D\uDE00')) {
      RE_W = null;
    }
  } catch (e) {
    RE_W = null;
  }
  if (!RE_W) {
    // 兜底（不期望走到）：ASCII 字/数/下划线 + CJK 基本区 + 兼容汉字
    RE_W = /[0-9A-Za-z_\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/;
  }

  function isWord(ch) {
    // 单个"码位"：可能是代理对，正则带 u 标志会按码位匹配
    return RE_W.test(ch);
  }

  /**
   * Python `re.sub(r"[^\w\u4e00-\u9fff\-]+", "", s)` —— 按**码位**删。
   * ⚠ 白名单是**三样**：`\w` ∪ `\u4e00-\u9fff` ∪ **连字符 `-`**
   *   （漏了 `-` 会把 `night-street-lamp` 压成 `nightstreetlamp`）。
   */
  function keepChar(ch, cp) {
    return ch === '-' || isWord(ch) || inCjkBmp(cp);
  }

  function stripNonWord(s) {
    var a = String(s);
    var out = '';
    var i = 0;
    while (i < a.length) {
      var cp = a.charCodeAt(i);
      // 代理对：两个 UTF-16 单元 = 一个码位，整体判、整体留
      if (cp >= 0xD800 && cp <= 0xDBFF && i + 1 < a.length) {
        var lo = a.charCodeAt(i + 1);
        if (lo >= 0xDC00 && lo <= 0xDFFF) {
          var pair = a.slice(i, i + 2);
          if (isWord(pair)) out += pair; // \p{L}/\p{N} 可能落在 SMP
          i += 2;
          continue;
        }
      }
      var ch = a.charAt(i);
      if (keepChar(ch, cp)) out += ch;
      i++;
    }
    return out;
  }

  /** 链①白名单里额外保留的 `\u4e00-\u9fff`。 */
  function inCjkBmp(cp) {
    return cp >= 0x4E00 && cp <= 0x9FFF;
  }

  /** Python `re.sub(r"[\s]+", "-", s)` —— 连续空白压成一个 `-`。 */
  function collapseSpaceToDash(s) {
    var a = String(s);
    var out = '';
    var i = 0;
    while (i < a.length) {
      if (isPySpace(a.charAt(i))) {
        out += '-';
        while (i < a.length && isPySpace(a.charAt(i))) i++;
        continue;
      }
      out += a.charAt(i);
      i++;
    }
    return out;
  }

  /** Python `re.sub(r"\.{2,}", ".", s)` —— 两个以上的点压成一个。 */
  function collapseDots(s) {
    var a = String(s);
    var out = '';
    var i = 0;
    while (i < a.length) {
      if (a.charAt(i) === '.') {
        var n = 0;
        while (i + n < a.length && a.charAt(i + n) === '.') n++;
        out += '.';
        i += n;
        continue;
      }
      out += a.charAt(i);
      i++;
    }
    return out;
  }

  /** Python `s.strip(".-")` —— 去首尾的 `.` 与 `-`。 */
  function stripDotDash(s) {
    var a = String(s);
    var i = 0;
    var j = a.length;
    while (i < j && (a.charAt(i) === '.' || a.charAt(i) === '-')) i++;
    while (j > i && (a.charAt(j - 1) === '.' || a.charAt(j - 1) === '-')) j--;
    return a.slice(i, j);
  }

  /** 按**码位**截断（中文也算 1 个，不能按 UTF-16 单元切，否则会切出半个代理对）。 */
  function headByCodePoints(s, n) {
    var a = String(s);
    var out = '';
    var k = 0;
    var i = 0;
    while (i < a.length && k < n) {
      var cp = a.charCodeAt(i);
      if (cp >= 0xD800 && cp <= 0xDBFF && i + 1 < a.length) {
        var lo = a.charCodeAt(i + 1);
        if (lo >= 0xDC00 && lo <= 0xDFFF) {
          out += a.slice(i, i + 2);
          i += 2;
          k++;
          continue;
        }
      }
      out += a.charAt(i);
      i++;
      k++;
    }
    return out;
  }

  /**
   * 链① `sanitize_stem(stem)` 的逐字复刻（make_flipbook.py :463-469）。
   *
   *   cleaned = re.sub(r"[\s]+", "-", stem.strip())
   *   cleaned = re.sub(r"[^\w\u4e00-\u9fff\-]+", "", cleaned)
   *   cleaned = re.sub(r"\.{2,}", ".", cleaned).strip(".-")
   *   return cleaned[:60] or "photo"
   */
  function sanitizeStem(stem) {
    var cleaned = collapseSpaceToDash(pyStrip(String(stem == null ? '' : stem)));
    cleaned = stripNonWord(cleaned);
    cleaned = stripDotDash(collapseDots(cleaned));
    cleaned = headByCodePoints(cleaned, 60); // Python 切片按码位
    return cleaned === '' ? 'photo' : cleaned;
  }

  // ---------------------------------------------------------------------------
  // 3) PIL 的 thumbnail 尺寸公式
  // ---------------------------------------------------------------------------

  /**
   * Python `round_aspect`：
   *   max(min(math.floor(number), math.ceil(number), key=key), 1)
   * —— floor / ceil 里 key 更小的那个（更贴近原比例），下限 1。
   */
  function roundAspect(number, keyOf) {
    var f = Math.floor(number);
    var c = Math.ceil(number);
    var pick = keyOf(f) <= keyOf(c) ? f : c; // min(..., key=key)
    return pick < 1 ? 1 : pick;              // max(..., 1)
  }

  /**
   * 链① `img.thumbnail((EDGE, EDGE), LANCZOS)` 之后的 `img.size`。
   * 只算尺寸，**不做重采样**（index.html 只用到尺寸）。
   *
   * ⚠ 与 render_artwork() 的调用条件一致：只有 max(w,h) > EDGE 才会缩；
   *    但 thumbnail 内部还有一道 `x>=w 且 y>=h ⇒ 不缩`，这里一并照搬
   *    （两条其实是同一件事，保留两层以防将来 EDGE 改小）。
   */
  function thumbnailSize(w, h, edge) {
    var E = (typeof edge === 'number' && edge > 0) ? edge : ARTWORK_LONG_EDGE;
    w = Math.floor(w);
    h = Math.floor(h);
    var x = E;
    var y = E;
    if (x >= w && y >= h) return { width: w, height: h };
    var aspect = w / h;
    if (x / y >= aspect) {
      x = roundAspect(y * aspect, function (n) { return Math.abs(aspect - n / y); });
    } else {
      y = roundAspect(x / aspect, function (n) {
        return n === 0 ? 0 : Math.abs(aspect - x / n);
      });
    }
    return { width: x, height: y };
  }

  /** Python `f"{index:02d}-{stem}.jpg"` + `assets/photos/` 前缀。 */
  function artworkName(index, stem) {
    var n = String(Math.floor(index));
    while (n.length < 2) n = '0' + n; // :02d
    return 'assets/photos/' + n + '-' + sanitizeStem(stem) + '.jpg';
  }

  /**
   * 一步到位：给出一张照片在 index.html 里需要的三个值。
   * @param {number} index 1 起的序号（链① render_artwork 的 index 是 1 起）
   * @param {string} stem  原文件主名（不含扩展名）
   * @param {number} width  EXIF 纠正后的宽
   * @param {number} height EXIF 纠正后的高
   */
  function artworkOf(index, stem, width, height) {
    var sz = thumbnailSize(width, height, ARTWORK_LONG_EDGE);
    return {
      artwork: artworkName(index, stem),
      artwork_width: sz.width,
      artwork_height: sz.height
    };
  }

  var API = {
    ARTWORK_LONG_EDGE: ARTWORK_LONG_EDGE,
    pySpaceSet: PY_SPACE,
    isPySpace: isPySpace,
    pyStrip: pyStrip,
    collapseSpaceToDash: collapseSpaceToDash,
    stripNonWord: stripNonWord,
    collapseDots: collapseDots,
    stripDotDash: stripDotDash,
    headByCodePoints: headByCodePoints,
    sanitizeStem: sanitizeStem,
    roundAspect: roundAspect,
    thumbnailSize: thumbnailSize,
    artworkName: artworkName,
    artworkOf: artworkOf
  };

  root.__engineArtwork = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
}(typeof window !== 'undefined' ? window : (typeof global !== 'undefined' ? global : this)));
