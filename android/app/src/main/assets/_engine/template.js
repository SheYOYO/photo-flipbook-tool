/* 线B · 手机出书引擎 —— 模板（页序 -> index.html 文本）
 * ============================================================================
 * 这是链① `app/make_flipbook.py` 的 **B3 逐字照搬**：
 *   `page_html()`（:1124-1247）· `build_index_html()`（:1250-1355）
 *   及其全部依赖：esc / alt_text / outer_shadow_html / _full_bleed_html /
 *   normalize_cover_text / cover_text_style / cover_vars_css / cover_extra_html /
 *   cover_text_html
 * 对照件：链①原件冻结，**只读 import 取真值**（tools/_b3_ref.py → tools/_b3_check.js）。
 *
 * ★★ 照搬时最容易错的地方（错了就"看着像、其实差一个字节"）
 *   1. `{page["folio"]:>2}` 是 Python 的**右对齐宽度 2**（3 ⇒ " 3"、12 ⇒ "12"），
 *      不是"补零"。JS 没有现成的，得手写 pad2()。
 *   2. `round(x, 3)` 是 **Python 的 round**：按 x 的**精确二进制值**四舍六入五成双。
 *      教科书写法 `Math.round(x*1000)/1000` 在 2.675 这类数上**必错**
 *      （Python: 2.67，JS 朴素: 2.68）。这里用 BigInt 精确展开实现 pyRound()。
 *   3. `f"{value:g}"` 是 Python 的 **%g**（6 位有效数字、去尾零、必要时转指数）。
 *      JS 的 `toString()` 不是这个。用 fmtG()。
 *   4. `esc()` 的替换**顺序**是 & → < → > → "（顺序错了会跑出 &amp;lt;）。
 *   5. f-string 里 `{{n}}` 会被转义成字面量 `{n}`；JS 模板串里那处**不要**加反斜杠。
 *   6. `frontcover` / `alone` 两条分支现引擎不产生（只在 serve_ui.py 的预览里出现），
 *      但 `page_html()` 里保留着 ⇒ **照搬不许省**，判据里要主动把它们逼出来。
 *   7. 字体白名单：链① 靠 `available_font_families()`（内置 5 项 + 用户字体库）。
 *      手机端暂时没有用户字体库 ⇒ 默认就是内置 5 项；参考对账时由调用方注入
 *      当时的完整表（`__engineTemplate.setFontFamilies(map)`）。
 *
 * 接口
 *   __engineTemplate.buildIndexHtml(plan, pages, opts) -> string
 *     plan = {title, subtitle, photos:[Photo...], cover_text:{...}}
 *     pages = [{kind, density, index, folio, photo, cover_photo, alone}]
 *     opts  = {userFonts:boolean, fontFamilies:{key:cssFamily}}
 *     其中 page.photo / page.cover_photo 必须是 **Photo 对象**（不是下标）。
 */
(function (root) {
  'use strict';

  var PAGE_LONG_EDGE = 640;
  var DEFAULT_TITLE = '我的小狗';
  var DEFAULT_SUBTITLE = 'Photographs';

  var COVER_TEXT_ELEMENTS = ['title', 'subtitle', 'foot'];
  var COVER_EXTRA_RE = /^x[1-9]\d?$/;
  var COVER_EXTRA_MAX = 8;
  var COVER_TEXT_MAX_LEN = 80;

  // 字体白名单：键 -> CSS font-family 值。一律**单引号**包字体名
  //（这段值会进 `style="..."` 双引号属性，里面再出现双引号会被 esc() 转义掉）。
  var COVER_FONT_FAMILIES = {
    serif: 'var(--book-serif)',
    sans: 'var(--book-sans)',
    hei: "'Microsoft YaHei','PingFang SC','Noto Sans CJK SC',var(--book-sans)",
    song: "'SimSun','Songti SC',var(--book-serif)",
    kai: "'KaiTi','Kaiti SC',var(--book-serif)"
  };

  var COVER_ALIGNS = ['left', 'center', 'right'];

  // 颜色只放行这几种写法：挡住 url(...) / expression(...) / 分号注入。
  var COVER_COLOR_RE = new RegExp(
    '^(#[0-9a-fA-F]{3,8}' +
    '|rgba?\\(\\s*[0-9.,%\\s]+\\)' +
    '|hsla?\\(\\s*[0-9.,%\\s]+\\)' +
    '|[a-zA-Z]{3,20})$'
  );

  // 数值字段 -> [最小, 最大]。越界**夹回边界**（而不是丢弃）。
  // `w` 是文字框宽度（Phase 26）：5% 是"比一个字还窄就没法排了"的下限。
  var COVER_NUM_RANGES = {
    x: [0.0, 100.0],
    y: [0.0, 100.0],
    size: [0.5, 40.0],
    w: [5.0, 100.0]
  };

  // ------------------------------------------------------------------------
  // Python 语义小工具（第 1~3 条坑）
  // ------------------------------------------------------------------------

  /** Python 的 `str()` —— 至少把 None / True / False 对齐，免得 esc(None) 出 "null"。 */
  function pyStr(v) {
    if (v === null || v === undefined) { return 'None'; }
    if (v === true) { return 'True'; }
    if (v === false) { return 'False'; }
    return String(v);
  }

  /** Python 的 `float()`（认下划线分隔、inf/nan 家族；**不认** 0x/0o/0b 前缀）。 */
  var _DEC = '[0-9](?:_?[0-9])*';
  var _PYFLOAT_RE = new RegExp(
    '^[+-]?(?:' + _DEC + '(?:\\.(?:' + _DEC + ')?)?|\\.' + _DEC + ')(?:[eE][+-]?' + _DEC + ')?$'
  );

  function pyFloat(v) {
    if (typeof v === 'number') { return v; }
    if (typeof v === 'boolean') { return v ? 1 : 0; }   // float(True) == 1.0
    if (typeof v !== 'string') { return NaN; }          // None / list / dict → TypeError
    var s = v.replace(/^\s+|\s+$/g, '');
    if (s === '') { return NaN; }
    if (/^[+-]?inf(inity)?$/i.test(s)) { return s.charAt(0) === '-' ? -Infinity : Infinity; }
    if (/^[+-]?nan$/i.test(s)) { return NaN; }
    if (!_PYFLOAT_RE.test(s)) { return NaN; }
    return Number(s.replace(/_/g, ''));
  }

  /** Python 的 `{v:>2}`：右对齐、宽度 2、**不截断**。 */
  function pad2(v) {
    var s = '' + v;
    return s.length >= 2 ? s : new Array(2 - s.length + 1).join(' ') + s;
  }

  var _BIG = function (n) { return BigInt(n); };

  /** 把非负整数的 BigInt 除以 10^s，按**四舍六入五成双**取整（Python 的 round）。 */
  function roundHalfEvenScaled(D, s) {
    var p = _BIG(10) ** _BIG(s);
    var q = D / p;
    var r = D % p;
    var twice = r * _BIG(2);
    if (twice > p) { q += _BIG(1); }
    else if (twice === p) { if (q % _BIG(2) === _BIG(1)) { q += _BIG(1); } }
    return q;
  }

  /** Python 的 `round(x, nd)`（按精确二进制值、五成双）。 */
  function pyRound(x, nd) {
    if (!isFinite(x)) { return x; }
    if (x === 0) { return x; }
    var neg = x < 0;
    var ax = Math.abs(x);
    var dv = new DataView(new ArrayBuffer(8));
    dv.setFloat64(0, ax);
    var hi = dv.getUint32(0);
    var lo = dv.getUint32(4);
    var expBits = (hi >>> 20) & 0x7ff;
    var m = (_BIG(hi & 0xfffff) << _BIG(32)) | _BIG(lo);
    var e;
    if (expBits === 0) { e = -1074; }                    // 次正规数
    else { m = m | (_BIG(1) << _BIG(52)); e = expBits - 1075; }
    var D, k;
    if (e >= 0) { D = m << _BIG(e); k = 0; }
    else { D = m * (_BIG(5) ** _BIG(-e)); k = -e; }       // x = D * 10^-k
    // ★ 精确值的小数位不超过 nd ⇒ 四舍五入**不动它**，直接返回原值。
    //   （不只是省算量：DBL_MAX 这类数走下面那条会把 BigInt 转成 Infinity。）
    if (k <= nd) { return x; }
    var s = k - nd;                                       // 此时 s > 0
    var Q = roundHalfEvenScaled(D, s);
    var res = Number(Q) / Math.pow(10, nd);
    return neg ? -res : res;
  }

  /** Python 的 `f"{v:g}"`（6 位有效数字、去尾零、必要时转指数）。 */
  function fmtG(v) {
    if (typeof v !== 'number') { return pyStr(v); }
    if (v !== v) { return 'nan'; }
    if (v === Infinity) { return 'inf'; }
    if (v === -Infinity) { return '-inf'; }
    if (v === 0) { return Object.is(v, -0) ? '-0' : '0'; }   // Python: f"{-0.0:g}" == '-0'
    var e = Math.abs(v).toExponential(5);                 // 6 位有效数字
    var mm = /^(\d)(?:\.(\d+))?e([+-]\d+)$/.exec(e);
    var lead = mm[1], frac = mm[2] || '', X = parseInt(mm[3], 10);
    if (X < -4 || X >= 6) {
      var mant = lead + (frac ? '.' + frac : '');
      mant = mant.replace(/\.?0+$/, '');
      var es = (X < 0 ? '-' : '+') + (Math.abs(X) < 10 ? '0' : '') + Math.abs(X);
      return mant + 'e' + es;
    }
    var digits = lead + frac;
    var intLen = X + 1;
    var out;
    if (intLen <= 0) {
      out = '0.' + new Array(-intLen + 1).join('0') + digits;
    } else if (intLen >= digits.length) {
      out = digits + new Array(intLen - digits.length + 1).join('0');
    } else {
      out = digits.slice(0, intLen) + '.' + digits.slice(intLen);
    }
    out = out.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
    return out;
  }

  // ------------------------------------------------------------------------
  // 字体白名单（链① 的 available_font_families()）
  // ------------------------------------------------------------------------

  var _FONT_TABLE = null;

  /** 覆盖字体白名单（参考对账用；不设就是内置 5 项）。 */
  function setFontFamilies(map) {
    _FONT_TABLE = map || null;
  }

  function availableFontFamilies() {
    if (!_FONT_TABLE) { return COVER_FONT_FAMILIES; }
    var out = {};
    var k;
    for (k in COVER_FONT_FAMILIES) {
      if (Object.prototype.hasOwnProperty.call(COVER_FONT_FAMILIES, k)) {
        out[k] = COVER_FONT_FAMILIES[k];
      }
    }
    for (k in _FONT_TABLE) {
      if (Object.prototype.hasOwnProperty.call(_FONT_TABLE, k)) { out[k] = _FONT_TABLE[k]; }
    }
    return out;
  }

  // ------------------------------------------------------------------------
  // 基础件
  // ------------------------------------------------------------------------

  function altText(photo) {
    var kind = { portrait: '竖构图', landscape: '横构图', square: '方构图' }[photo.orientation];
    return '第 ' + photo.order + ' 张照片（' + kind + '）';
  }

  function esc(text) {
    return pyStr(text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  var OUTER_Y_TOP = '          <span class="outer-y top" aria-hidden="true"></span>\n';
  var OUTER_Y_BOTTOM = '          <span class="outer-y bottom" aria-hidden="true"></span>\n';

  function outerShadowHtml(side) {
    var horiz = side === 'verso' ? 'left' : 'right';
    return OUTER_Y_TOP + OUTER_Y_BOTTOM +
      '          <span class="outer-x ' + horiz + '" aria-hidden="true"></span>\n';
  }

  function fullBleedHtml(photo, side, density) {
    return '        <article class="book-page art-page photo ' + side + '"' + density +
      ' aria-label="' + esc(altText(photo)) + '">\n' +
      '          <figure class="plate">' +
      '<img src="' + photo.artwork + '" alt="' + esc(altText(photo)) + '" ' +
      'width="' + photo.artwork_width + '" height="' + photo.artwork_height + '" ' +
      'loading="eager" decoding="async"></figure>\n' +
      outerShadowHtml(side) +
      '        </article>';
  }

  // ------------------------------------------------------------------------
  // 封面文案（Phase 24 / 26 / 30）
  // ------------------------------------------------------------------------

  function extraKeyNum(key) {
    return parseInt(key.slice(1), 10);
  }

  /** 把界面 / JSON 交上来的封面文案配置洗成可信的一份（**绝不抛异常**）。 */
  function normalizeCoverText(raw) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) { return {}; }
    var extras = [];
    for (var k0 in raw) {
      if (Object.prototype.hasOwnProperty.call(raw, k0) &&
          typeof k0 === 'string' && COVER_EXTRA_RE.test(k0)) {
        extras.push(k0);
      }
    }
    extras.sort(function (a, b) { return extraKeyNum(a) - extraKeyNum(b); });
    extras = extras.slice(0, COVER_EXTRA_MAX);

    var families = availableFontFamilies();
    var clean = {};
    var elements = COVER_TEXT_ELEMENTS.concat(extras);
    for (var i = 0; i < elements.length; i++) {
      var element = elements[i];
      var conf = raw[element];
      if (conf === null || typeof conf !== 'object' || Array.isArray(conf)) { continue; }
      var isExtra = extras.indexOf(element) >= 0;
      var item = {};
      for (var key in conf) {
        if (!Object.prototype.hasOwnProperty.call(conf, key)) { continue; }
        var value = conf[key];
        if (Object.prototype.hasOwnProperty.call(COVER_NUM_RANGES, key)) {
          var lo = COVER_NUM_RANGES[key][0];
          var hi = COVER_NUM_RANGES[key][1];
          var num = pyFloat(value);
          if (num !== num || !isFinite(num)) { continue; }
          item[key] = pyRound(Math.min(hi, Math.max(lo, num)), 3);
        } else if (key === 'color') {
          var text = pyStr(value).trim();
          if (COVER_COLOR_RE.test(text)) { item[key] = text; }
        } else if (key === 'font') {
          if (Object.prototype.hasOwnProperty.call(families, value)) { item[key] = value; }
        } else if (key === 'align') {
          if (COVER_ALIGNS.indexOf(value) >= 0) { item[key] = value; }
        } else if (key === 'italic') {
          item[key] = !!value;
        } else if (key === 'hide' && !isExtra) {
          item[key] = !!value;
        } else if (key === 'text' && isExtra) {
          item[key] = pyStr(value).replace(/\n/g, ' ').trim().slice(0, COVER_TEXT_MAX_LEN);
        }
      }
      var has = false;
      for (var kk in item) { if (Object.prototype.hasOwnProperty.call(item, kk)) { has = true; break; } }
      if (has) { clean[element] = item; }
    }
    return clean;
  }

  /** 封面文案配置 -> 一串 CSS 自定义属性；没配置就返回 `""`。 */
  function coverTextStyle(coverText) {
    var cover = normalizeCoverText(coverText);
    var elements = [];
    for (var e0 in cover) { if (Object.prototype.hasOwnProperty.call(cover, e0)) { elements.push(e0); } }
    if (!elements.length) { return ''; }
    var families = availableFontFamilies();
    var parts = [];
    for (var i = 0; i < elements.length; i++) {
      var element = elements[i];
      var conf = cover[element];
      var prefix = '--ct-' + element;
      for (var key in conf) {
        if (!Object.prototype.hasOwnProperty.call(conf, key)) { continue; }
        var value = conf[key];
        if (key === 'x') { parts.push(prefix + '-x:' + fmtG(value) + '%'); }
        else if (key === 'y') { parts.push(prefix + '-y:' + fmtG(value) + '%'); }
        else if (key === 'size') { parts.push(prefix + '-size:' + fmtG(value) + 'cqw'); }
        else if (key === 'w') { parts.push(prefix + '-w:' + fmtG(value) + '%'); }
        else if (key === 'color') { parts.push(prefix + '-color:' + value); }
        else if (key === 'font') {
          var family = families[value];
          if (family) { parts.push(prefix + '-family:' + family); }
        } else if (key === 'align') {
          parts.push(prefix + '-align:' + value);
          if (value === 'center' || value === 'right') {
            parts.push(prefix + '-r:auto');
            parts.push(prefix + '-shift:translateX(' + (value === 'center' ? '-50%' : '-100%') + ')');
          }
        } else if (key === 'italic') {
          parts.push(prefix + '-style:' + (value ? 'italic' : 'normal'));
        } else if (key === 'hide') {
          parts.push(prefix + '-display:none');
        }
      }
    }
    return parts.join(';');
  }

  /** 封面文案变量 -> 一条 CSS 规则（放进 `<head>` 的 `<style>` 里）。 */
  function coverVarsCss(coverText) {
    var style = coverTextStyle(coverText);
    if (!style) { return ''; }
    return '.art-page[aria-label="封面"]{' + style + '}';
  }

  /** 一个自定义文字框（Phase 26）。 */
  function coverExtraHtml(key, text) {
    var refs = [
      'left:var(--ct-' + key + '-x,13.5%)',
      'right:var(--ct-' + key + '-r,auto)',
      'top:var(--ct-' + key + '-y,50%)',
      'width:var(--ct-' + key + '-w,auto)',
      'font-size:var(--ct-' + key + '-size,2.1cqw)',
      'font-family:var(--ct-' + key + '-family,var(--book-serif))',
      'font-style:var(--ct-' + key + '-style,normal)',
      'text-align:var(--ct-' + key + '-align,start)',
      'color:var(--ct-' + key + '-color,var(--cover-extra-ink))',
      'text-shadow:var(--cover-extra-shadow)',
      'transform:var(--ct-' + key + '-shift,none)'
    ].join(';');
    return '          <p class="cover-extra" data-ct="' + key + '" style="' + refs + '">' +
      esc(text) + '</p>\n';
  }

  /** 封面上的全部文字：三个内置元素（可被 `hide` 撤掉）+ 用户自加的文字框。 */
  function coverTextHtml(title, subtitle, foot, coverText) {
    var cover = normalizeCoverText(coverText);
    var out = [];
    if (!(cover.title || {}).hide) {
      out.push('          <h2 class="cover-title">' + esc(title) + '</h2>\n');
    }
    if (!(cover.subtitle || {}).hide) {
      out.push('          <p class="cover-subtitle">' + esc(subtitle) + '</p>\n');
    }
    if (!(cover.foot || {}).hide) {
      out.push('          <p class="cover-foot">' + esc(foot) + '</p>\n');
    }
    var keys = [];
    for (var k in cover) {
      if (Object.prototype.hasOwnProperty.call(cover, k) && COVER_EXTRA_RE.test(k)) { keys.push(k); }
    }
    keys.sort(function (a, b) { return extraKeyNum(a) - extraKeyNum(b); });
    for (var i = 0; i < keys.length; i++) {
      var conf = cover[keys[i]];
      out.push(coverExtraHtml(keys[i], conf.text === undefined ? '' : conf.text));
    }
    return out.join('');
  }

  // ------------------------------------------------------------------------
  // 一页
  // ------------------------------------------------------------------------

  function pageHtml(page, title, subtitle, photoCount, coverText) {
    var kind = page.kind;
    var photo = page.photo || null;
    var density = page.density === 'hard' ? ' data-density="' + page.density + '"' : '';
    var side = (page.index % 2 === 0) ? 'recto' : 'verso';
    var aria = esc(!photo ? kind : '图 ' + photo.order);
    // 封面文案的可调样式（Phase 24）：没有配置时是一整个 style 属性都不写。
    var coverStyle = (kind === 'cover' || kind === 'frontcover') ? coverTextStyle(coverText) : '';
    var coverAttr = coverStyle ? ' style="' + esc(coverStyle) + '"' : '';

    if (kind === 'cover') {
      var first = page.cover_photo || null;
      var words = coverTextHtml(title, subtitle, photoCount + ' PHOTOGRAPHS', coverText);
      if (first) {
        return '        <article class="book-page art-page photo ' + side + '"' + density + coverAttr +
          ' aria-label="封面">\n' +
          '          <figure class="plate">' +
          '<img src="' + first.artwork + '" alt="' + esc(altText(first)) + '" ' +
          'width="' + first.artwork_width + '" height="' + first.artwork_height + '" ' +
          'loading="eager" decoding="async" fetchpriority="high"></figure>\n' +
          '          <div class="cover-scrim"></div>\n' +
          outerShadowHtml(side) + words +
          '        </article>';
      }
      return '        <article class="book-page art-page cloth ' + side + '"' + density + coverAttr +
        ' aria-label="封面">\n' + words + '        </article>';
    }

    if (kind === 'frontcover') {
      // N ≤ 1 特例专用：硬封面承载那唯一一张照片（见 build_page_sequence 的「N ≤ 1 特例」）
      var words2 = coverTextHtml(title, subtitle, photoCount + ' PHOTOGRAPH', coverText);
      if (photo) {
        return '        <article class="book-page art-page photo ' + side + '"' + density + coverAttr +
          ' aria-label="封面">\n' +
          '          <figure class="plate">' +
          '<img src="' + photo.artwork + '" alt="' + esc(altText(photo)) + '" ' +
          'width="' + photo.artwork_width + '" height="' + photo.artwork_height + '" ' +
          'loading="eager" decoding="async" fetchpriority="high"></figure>\n' +
          '          <div class="cover-scrim"></div>\n' +
          outerShadowHtml(side) + words2 +
          '        </article>';
      }
      return '        <article class="book-page art-page cloth ' + side + '"' + density + coverAttr +
        ' aria-label="封面">\n' + words2 + '        </article>';
    }

    if (kind === 'backcover') {
      return '        <article class="book-page art-page cloth ' + side + '"' + density + ' aria-label="封底">\n' +
        '          <span class="back-mark">' + esc(title) + '</span>\n' +
        '        </article>';
    }

    if (kind === 'endpaper') {
      return '        <article class="book-page art-page endpaper ' + side +
        '" aria-label="' + aria + '"></article>';
    }

    if (kind === 'title') {
      return '        <article class="book-page art-page paper ' + side + '" aria-label="扉页">\n' +
        '          <div class="title-block"><h2>' + esc(title) + '</h2><p>' + esc(subtitle) + '</p></div>\n' +
        '          <p class="folio">' + pad2(page.folio) + '</p>\n' +
        '        </article>';
    }

    if (kind === 'colophon') {
      return '        <article class="book-page art-page paper ' + side + '" aria-label="版权页">\n' +
        '          <div class="colophon">\n' +
        '            <p>' + esc(title) + '</p>\n' +
        '            <p>' + esc(subtitle) + '</p>\n' +
        '            <p class="small-print">' + photoCount + ' 张照片 · 本地生成</p>\n' +
        '          </div>\n' +
        '          <p class="folio">' + pad2(page.folio) + '</p>\n' +
        '        </article>';
    }

    if (kind === 'plate' && photo) {
      // 独占一个跨页的横向照片 -> 满版铺开
      if (page.alone) { return fullBleedHtml(photo, side, density); }
      var cls = 'plate ' + photo.plate;
      if (photo.position) { cls += ' ' + photo.position; }
      return '        <article class="book-page art-page photo ' + side + '" aria-label="' + aria + '">\n' +
        '          <figure class="' + cls + '">' +
        '<img src="' + photo.artwork + '" alt="' + esc(altText(photo)) + '" ' +
        'width="' + photo.artwork_width + '" height="' + photo.artwork_height + '" loading="eager" decoding="async">' +
        '</figure>\n' +
        outerShadowHtml(side) +
        '          <p class="folio">' + pad2(page.folio) + '</p>\n' +
        '        </article>';
    }

    // blank / 分节页：干净的白纸，不印页码
    return '        <article class="book-page art-page paper ' + side + '" aria-label="留白页">\n' +
      '        </article>';
  }

  // ------------------------------------------------------------------------
  // 整本
  // ------------------------------------------------------------------------

  function buildIndexHtml(plan, pages, opts) {
    opts = opts || {};
    if (opts.fontFamilies) { setFontFamilies(opts.fontFamilies); }
    var title = plan.title;
    var subtitle = plan.subtitle;
    var count = plan.photos.length;
    var coverText = plan.cover_text;
    var body = [];
    for (var i = 0; i < pages.length; i++) {
      body.push(pageHtml(pages[i], title, subtitle, count, coverText));
    }
    body = body.join('\n');
    var fontLink = opts.userFonts
      ? '  <link rel="stylesheet" href="style/user-fonts.css">\n' : '';
    var coverCss = coverVarsCss(coverText);
    var coverBlock = coverCss ? '  <style>' + coverCss + '</style>\n' : '';

    return '<!doctype html>\n' +
      '<html lang="zh-CN">\n' +
      '<head>\n' +
      '  <meta charset="utf-8">\n' +
      '  <meta name="viewport" content="width=device-width,initial-scale=1">\n' +
      '  <title>' + esc(title) + '</title>\n' +
      '  <link rel="stylesheet" href="styles.css">\n' +
      fontLink + coverBlock + '</head>\n' +
      '<body>\n' +
      '<main class="room">\n' +
      '  <header class="book-header">\n' +
      '    <span>' + esc(subtitle) + '</span><h1>' + esc(title) + '</h1><span id="orientation">Open spread</span>\n' +
      '  </header>\n' +
      '  <section class="stage" aria-label="可翻页的摄影集">\n' +
      '    <div class="book-rig">\n' +
      '      <div id="book" class="book" data-page-width="512" data-page-height="' + PAGE_LONG_EDGE + '">\n' +
      body + '\n' +
      '      </div>\n' +
      '    </div>\n' +
      '  </section>\n' +
      '  <footer class="controls" aria-label="翻页控制">\n' +
      '    <button id="previous" type="button" aria-label="上一页">←</button>\n' +
      '    <!-- ★ Phase 28：中间那列从**五行**压成**两行**（佘先生：「查看画册时的那个页数和\n' +
      '         自动翻页UI组块太大了，上下宽度压缩一半，要让图片占据画面的绝大部分，比如那个\n' +
      '         自动翻页和其速度组块完全可以放在同一行，跳转页面的组块做成一行」）。\n' +
      '         第 1 行 `.nav-row`  = 状态（老入口：点页码变输入框）+ 常驻「跳到第 N 页」；\n' +
      '         第 2 行 `.auto-row` = 自动翻页开关 + 它的速度下拉；\n' +
      '         Phase 28 时说明小字挪进第 2 行末尾，窄窗口由 CSS 藏掉。\n' +
      '         改前脚部实测 121.2px → 改后实测 **46.6px**（6 档窗口量下来都是这个数）。\n' +
      '         ★ Phase 31：佘先生说脚部那行说明小字不美观 ⇒ **整行删掉**（不是藏起来）。\n' +
      '         ⚠ 注释里也别把那行字的原文写出来：核心层「成功Y」有一条判据扫整个\n' +
      '         HTML 模板、不许那句话再出现，注释命中同样算（findings 71 同族的坑）。\n' +
      '         ⚠ .jump-row 仍必须排在 #page-auto **之前**：DOM 顺序与几何位置都有断言守着。 -->\n' +
      '    <div class="status">\n' +
      '      <div class="status-row nav-row">\n' +
      '        <button id="page-jump" type="button" class="page-jump" aria-label="跳转到指定页"\n' +
      '                title="点击输入页码，回车跳转"><span id="page-status" aria-live="polite">Cover</span></button>\n' +
      '        <input id="page-input" class="page-input" type="text" inputmode="numeric" autocomplete="off"\n' +
      '               spellcheck="false" aria-label="输入页码后按回车跳转" hidden>\n' +
      '        <!-- 跳到指定页（Phase 26）：佘先生「在查看画册的界面的选择查看的页数的功能\n' +
      '             恢复，就设计在自动翻页的组块的上方，注意布局协调」。\n' +
      '             原来跳页只有一个"点页码 → 就地变输入框"的隐藏入口（#page-jump），\n' +
      '             功能是在的，但看不出来。这里补一个常驻入口 —— Phase 28 起它与状态\n' +
      '             并排在同一行，不再自己占一行。 -->\n' +
      '        <div class="jump-row">\n' +
      '          <label class="jump-row-k" for="page-select">跳到第</label>\n' +
      '          <input id="page-select" class="page-select" type="text" inputmode="numeric"\n' +
      '                 autocomplete="off" spellcheck="false" aria-label="输入页码，回车跳转">\n' +
      '          <span class="jump-row-u">页</span>\n' +
      '          <button id="page-go" class="page-go" type="button">跳转</button>\n' +
      '        </div>\n' +
      '      </div>\n' +
      '      <div class="status-row auto-row">\n' +
      '        <!-- 自动翻页开关（Phase 20）：默认关（aria-pressed="false"、文案=未播放态），\n' +
      '             点了才开始自动翻。按钮文本 / data-stop-* 是"未播放 / 播放中"两套文案，\n' +
      '             由 flipbook.js 换用，所以这里不要把它们写进别的脚本里。\n' +
      '             title 里的 {n} 由 flipbook.js 换成当前秒数 —— 调过速度后提示语不能还停在 5。 -->\n' +
      '        <button id="page-auto" type="button" class="page-auto" aria-pressed="false"\n' +
      '                data-stop-label="停止自动翻页" data-stop-title="点击停止自动翻页"\n' +
      '                title="自动翻页：每 {n} 秒翻一页">自动翻页</button>\n' +
      '        <!-- 自动翻页调速（Phase 23 起 2~10 秒/页；Phase 26 补了最快的 **1 秒**档，\n' +
      '             现在共 10 档；默认仍是 5 秒 ⇒ 没动过速度的成品与上一版一字不差）。\n' +
      '             少了它（老成品 HTML）就退回 5 秒，行为与 Phase 20 一致。 -->\n' +
      '        <select id="page-auto-speed" class="page-auto-speed" aria-label="自动翻页速度"\n' +
      '                title="每页停几秒（1~10 秒）">\n' +
      '          <option value="1">1 秒</option>\n' +
      '          <option value="2">2 秒</option>\n' +
      '          <option value="3">3 秒</option>\n' +
      '          <option value="4">4 秒</option>\n' +
      '          <option value="5" selected>5 秒</option>\n' +
      '          <option value="6">6 秒</option>\n' +
      '          <option value="7">7 秒</option>\n' +
      '          <option value="8">8 秒</option>\n' +
      '          <option value="9">9 秒</option>\n' +
      '          <option value="10">10 秒</option>\n' +
      '        </select>\n' +
      '      </div>\n' +
      '    </div>\n' +
      '    <!-- Phase 28：翻到最后一跨页之后再点它 = 合上封底；合上之后再点它 = **整本翻回封面**，\n' +
      '         所以它不再在末页变灰（原来末页它是 disabled，点了没反应）。 -->\n' +
      '    <button id="next" type="button" aria-label="下一页">→</button>\n' +
      '  </footer>\n' +
      '</main>\n' +
      '<script src="vendor/page-flip.browser.js"></script>\n' +
      '<script src="flipbook.js"></script>\n' +
      '</body>\n' +
      '</html>\n';
  }

  var API = {
    buildIndexHtml: buildIndexHtml,
    pageHtml: pageHtml,
    esc: esc,
    altText: altText,
    outerShadowHtml: outerShadowHtml,
    fullBleedHtml: fullBleedHtml,
    normalizeCoverText: normalizeCoverText,
    coverTextStyle: coverTextStyle,
    coverVarsCss: coverVarsCss,
    coverExtraHtml: coverExtraHtml,
    coverTextHtml: coverTextHtml,
    setFontFamilies: setFontFamilies,
    availableFontFamilies: availableFontFamilies,
    pyRound: pyRound,
    pyFloat: pyFloat,
    fmtG: fmtG,
    pad2: pad2,
    PAGE_LONG_EDGE: PAGE_LONG_EDGE,
    DEFAULT_TITLE: DEFAULT_TITLE,
    DEFAULT_SUBTITLE: DEFAULT_SUBTITLE,
    COVER_FONT_FAMILIES: COVER_FONT_FAMILIES,
    COVER_TEXT_ELEMENTS: COVER_TEXT_ELEMENTS,
    COVER_EXTRA_MAX: COVER_EXTRA_MAX,
    COVER_TEXT_MAX_LEN: COVER_TEXT_MAX_LEN
  };

  root.__engineTemplate = API;
  if (typeof module !== 'undefined' && module.exports) { module.exports = API; }
})(typeof window !== 'undefined' ? window : (typeof global !== 'undefined' ? global : this));
