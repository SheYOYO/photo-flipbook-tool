/* 线B · 手机出书引擎 —— 特征探测（照片 -> 与链①同结构的数字）
 * ============================================================================
 * 为什么要在 JS 里自写重采样
 *   链①（电脑端）算特征用 Pillow：`img.resize((96,96), BILINEAR)`。
 *   手机 WebView 的 `drawImage(96,96)` 与它不是一回事（B1c 实测：换批照片名次必翻）。
 *   ⇒ 走甲：在 JS 里**照 Pillow 的公式**自己算。
 *
 * 依据（已逐像素坐实，见 tools/_b1b_resample.py）
 *   Pillow 12.3.0 `src/libImaging/Resample.c`：
 *     · 两趟分离：水平 ->（先量化成 8bit 中间图）-> 垂直
 *     · **每个输出像素的系数单独归一化**（除以该像素自己的 Σk），不是全局归一化
 *     · 8bpc 定点路径：系数 round(×2^22)；累加初值 2^21；`>>22` 后 clamp[0,255]
 *     · BILINEAR 核 f(t)=1-|t| (|t|<1)、support=1；**缩小时核按比例放大**
 *       （filterscale = max(scale,1)，support = filterscale，权重取 t=(x+xmin-center+0.5)/filterscale）
 *     · 逐字复刻的还有：xmin=(int)(center-support+0.5) 截断、xmax 存的是**个数**、
 *       center=in0+(xx+0.5)*scale、以及「H > W*100 的超长条走垂直先/水平后」那条分支
 *   Pillow 的 `convert("L")` 是**定点式** `(r*19595+g*38470+b*7471+32768)>>16`，
 *   不是教科书上的 `0.299r+0.587g+0.114b`（后者实测**一半像素差 1**）—— sharpness 的命门。
 *
 * 实测（20 张真图 + 5 张合成图，见 tools/_emu_shot/b1b-resample.json）
 *   · 重采样逐像素完全相同：25/25，max|Δ| = 0
 *   · 灰度公式：max|Δ| = 0（60512 个抽样点）
 *   · 端到端 vs 链① batch20.json：Δlum / Δwarmth / Δsharp ≤ 4.6e-11（浮点 ulp 级）
 *
 * 接口
 *   __engineProbe.probe(rgb, w, h) -> {mean_rgb:[r,g,b], mean_lum, warmth, sharpness}
 *       rgb: Uint8Array / Uint8ClampedArray / Array，长度 w*h*3，**行主序 RGB**
 *   __engineProbe.resizeBilinear(rgb, w, h, outW, outH) -> Uint8ClampedArray
 *   __engineProbe.grayL(rgb) -> Uint8Array
 *
 * 老内核（真机 WebView = Chrome 83）约束：本文件只用 ES5 + 类型化数组，不用可选链等新语法。
 * 解码（JPEG -> RGB）不在这里：由调用方用 <img>/createImageBitmap + canvas 取 getImageData。
 * ============================================================================
 */
(function (root) {
  'use strict';

  /* ---- Pillow 的定点常量（Resample.c） ---- */
  var PRECISION_BITS = 22;              /* 32 - 8 - 2 */
  var ONE = 1 << PRECISION_BITS;        /* 1<<22 = 4194304 */
  var HALF = 1 << (PRECISION_BITS - 1); /* 1<<21 = 2097152，累加舍入偏置 */

  /* ==========================================================================
   * precompute_coeffs()  —— 逐字照抄 Pillow（box = 全图，故 in0=0、in1=inSize）
   * 返回 { kk: Int32Array(outSize*ksize) 定点系数, bounds: Int32Array(outSize*2) [xmin,cnt], ksize }
   * ======================================================================== */
  function precomputeCoeffs(inSize, outSize) {
    var scale = inSize / outSize;
    var filterscale = scale < 1.0 ? 1.0 : scale;
    var support = filterscale;                       /* BILINEAR.support = 1.0 */
    var ksize = Math.ceil(support) * 2 + 1;
    var inv = 1.0 / filterscale;
    var kk = new Int32Array(outSize * ksize);        /* 尾部全是 0，与 C 的尾部清零等价 */
    var bd = new Int32Array(outSize * 2);
    var w = new Float64Array(ksize);

    for (var xx = 0; xx < outSize; xx++) {
      var center = (xx + 0.5) * scale;
      var xmin = Math.trunc(center - support + 0.5); /* C 的 (int) 截断 */
      if (xmin < 0) { xmin = 0; }
      var xmax = Math.trunc(center + support + 0.5);
      if (xmax > inSize) { xmax = inSize; }
      var cnt = xmax - xmin;                         /* C 里 xmax -= xmin ⇒ 存个数 */

      var ww = 0.0, x;
      for (x = 0; x < cnt; x++) {
        var t = (x + xmin - center + 0.5) * inv;
        var at = t < 0.0 ? -t : t;
        var wv = at < 1.0 ? (1.0 - at) : 0.0;        /* bilinear_filter */
        w[x] = wv;
        ww += wv;
      }
      if (ww !== 0.0) {
        for (x = 0; x < cnt; x++) { w[x] /= ww; }
      }

      var base = xx * ksize;
      for (x = 0; x < cnt; x++) {
        /* normalize_coeffs_8bpc：正数 +0.5、负数 -0.5 后截断（四舍五入） */
        var v = w[x] * ONE;
        kk[base + x] = w[x] < 0.0 ? Math.trunc(v - 0.5) : Math.floor(v + 0.5);
      }
      bd[xx * 2] = xmin;
      bd[xx * 2 + 1] = cnt;
    }
    return { kk: kk, bounds: bd, ksize: ksize };
  }

  /* clip8(ss) = clip8_lookups[ss >> 22]，表有效范围 -640..639 ⇒ 等价 clamp 到 [0,255] */
  function clip8(s) {
    var v = Math.floor(s / ONE);                     /* s>=0 时与算术右移一致 */
    if (v < 0) { return 0; }
    if (v > 255) { return 255; }
    return v;
  }

  /* 水平趟：src(H,W,3) -> (H,outW,3) */
  function passH(src, w, h, outW, C) {
    var kk = C.kk, bd = C.bounds, ksize = C.ksize;
    var tmp = new Uint8ClampedArray(h * outW * 3);
    for (var y = 0; y < h; y++) {
      var rowIn = y * w * 3;
      var rowOut = y * outW * 3;
      for (var xx = 0; xx < outW; xx++) {
        var xmin = bd[xx * 2], cnt = bd[xx * 2 + 1], base = xx * ksize;
        var s0 = HALF, s1 = HALF, s2 = HALF;
        var p = rowIn + xmin * 3;
        for (var x = 0; x < cnt; x++) {
          var k = kk[base + x];
          s0 += src[p] * k;
          s1 += src[p + 1] * k;
          s2 += src[p + 2] * k;
          p += 3;
        }
        var q = rowOut + xx * 3;
        tmp[q] = clip8(s0);
        tmp[q + 1] = clip8(s1);
        tmp[q + 2] = clip8(s2);
      }
    }
    return tmp;
  }

  /* 垂直趟：src(h,w,3) -> (outH,w,3) */
  function passV(src, w, h, outH, C) {
    var kk = C.kk, bd = C.bounds, ksize = C.ksize;
    var out = new Uint8ClampedArray(outH * w * 3);
    var stride = w * 3;
    for (var yy = 0; yy < outH; yy++) {
      var ymin = bd[yy * 2], cnt = bd[yy * 2 + 1], base = yy * ksize;
      var rowOut = yy * stride;
      for (var xx = 0; xx < w; xx++) {
        var s0 = HALF, s1 = HALF, s2 = HALF;
        var p = ymin * stride + xx * 3;
        for (var y = 0; y < cnt; y++) {
          var k = kk[base + y];
          s0 += src[p] * k;
          s1 += src[p + 1] * k;
          s2 += src[p + 2] * k;
          p += stride;
        }
        var q = rowOut + xx * 3;
        out[q] = clip8(s0);
        out[q + 1] = clip8(s1);
        out[q + 2] = clip8(s2);
      }
    }
    return out;
  }

  /* Image.resize(size, BILINEAR)：box=None、reducing_gap=None（链①就是这么调的） */
  function resizeBilinear(src, w, h, outW, outH) {
    if (w === outW && h === outH) { return src; }    /* Pillow: return self.copy() */

    /* Pillow 的超长条分支：h > w*100 且要缩高 ⇒ 先只缩高、再只缩宽 */
    if (h > w * 100 && outH < h) {
      var t1 = passV(src, w, h, outH, precomputeCoeffs(h, outH));   /* (outH, w, 3) */
      return passH(t1, w, outH, outW, precomputeCoeffs(w, outW));   /* (outH, outW, 3) */
    }
    var tmp = passH(src, w, h, outW, precomputeCoeffs(w, outW));    /* (h, outW, 3) */
    return passV(tmp, outW, h, outH, precomputeCoeffs(h, outH));    /* (outH, outW, 3) */
  }

  /* Image.convert("L")：ITU-R 601-2 定点实现 */
  function grayL(rgb) {
    var n = (rgb.length / 3) | 0;
    var out = new Uint8Array(n);
    for (var i = 0; i < n; i++) {
      var j = i * 3;
      out[i] = (rgb[j] * 19595 + rgb[j + 1] * 38470 + rgb[j + 2] * 7471 + 32768) >> 16;
    }
    return out;
  }

  /* 照抄链① probe() 的特征口径（app/make_flipbook.py:192-207） */
  function probe(rgb, w, h) {
    var small = resizeBilinear(rgb, w, h, 96, 96);
    var n = 96 * 96, sr = 0, sg = 0, sb = 0, i;
    for (i = 0; i < n; i++) {
      var j = i * 3;
      sr += small[j];
      sg += small[j + 1];
      sb += small[j + 2];
    }
    var r = sr / n, g = sg / n, b = sb / n;

    var gray = grayL(small);
    var diffs = 0;
    for (var y = 0; y < 96; y++) {
      var row = y * 96;
      for (var x = 0; x < 95; x++) {
        var d = gray[row + x] - gray[row + x + 1];
        diffs += d < 0 ? -d : d;
      }
    }

    return {
      mean_rgb: [r, g, b],
      mean_lum: 0.299 * r + 0.587 * g + 0.114 * b,
      warmth: (r - b) / 255.0,
      sharpness: diffs / (96 * 95 * 255.0)
    };
  }

  var API = {
    probe: probe,
    resizeBilinear: resizeBilinear,
    grayL: grayL,
    precomputeCoeffs: precomputeCoeffs,
    PRECISION_BITS: PRECISION_BITS
  };

  root.__engineProbe = API;
  if (typeof module !== 'undefined' && module.exports) { module.exports = API; }
})(typeof window !== 'undefined' ? window : (typeof global !== 'undefined' ? global : this));
