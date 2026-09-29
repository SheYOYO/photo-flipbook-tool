#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""画册工作台的本地服务。

只用标准库，不起第三方依赖。刻意做了三件事来避开本机的环境坑：

1. **只绑 127.0.0.1** —— 局域网里别人访问不到你的照片。
2. **服务端所有出站请求显式绕过代理** —— 本机常驻 HTTP_PROXY，
   不绕过的话连自己都会走代理，回环地址直接失败。
3. **页面不引用任何 CDN** —— 全部资源本地提供，
   否则代理抖动时界面会白屏（zen_garden.html 就是这么卡住的）。

接口一览（全部 JSON，除非注明）：

    GET  /                     工作台界面
    GET  /static/*             界面资源（css/js/字体/图）
    GET  /api/status           服务与依赖状态
    POST /api/pick-folder      弹系统文件夹选择框，返回路径
    POST /api/scan             扫描照片目录，返回照片清单（含缩略图地址）
    GET  /thumb?id=<n>         按当前方案的顺序出某张照片的缩略图
    GET  /api/plan             取当前排版方案
    POST /api/plan             改排版方案（调序 / 改 plate / 改书名 / 改封面文案样式）
    POST /api/auto-arrange     重新自动排版
    POST /api/generate         出书，返回成品路径
    POST /api/open-output      在浏览器里打开成品
    POST /api/shutdown         关掉服务

    GET  /preview/cover        封面文案的「所见即所得」预览页（只读）
    GET  /preview/asset/<n>    预览页要用的运行时资源（styles.css / style/**），只读
"""

from __future__ import annotations

import base64
import copy
import io
import json
import os
import re
import socket
import sys
import threading
import time
import traceback
import urllib.parse
import urllib.request
import webbrowser
from dataclasses import asdict
from datetime import datetime
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent

# 本工作台的身份证。双击入口靠它在「已经跑着的服务」里认出自己人 ——
# 只凭「端口有人应答」不够：任何程序都可能占着那个端口。
APP_TAG = "photo-flipbook-workbench"

# 让 make_flipbook 与 ui_common 能被 import
sys.path.insert(0, str(HERE))

import make_flipbook as core  # noqa: E402


def _ensure_writable_streams() -> None:
    """保证 stdout / stderr 一定可用。

    用 pythonw.exe（无控制台）启动时，sys.stdout 和 sys.stderr 都是 None，
    任何 print 都会抛 AttributeError: 'NoneType' object has no attribute 'write'，
    表现为双击后一闪就没、或者完全没反应。这里给它们补一个丢弃写入的假流，
    顺便把编码设成 utf-8，免得中文提示在 GBK 控制台下变成乱码或直接报错。
    """

    class _Sink:
        """吞掉所有写入的假流。"""

        def write(self, _data: str) -> int:
            return 0

        def flush(self) -> None:
            return None

        def isatty(self) -> bool:
            return False

        @property
        def encoding(self) -> str:
            return "utf-8"

    for name in ("stdout", "stderr"):
        stream = getattr(sys, name, None)
        if stream is None:
            setattr(sys, name, _Sink())
            continue
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[union-attr]
        except Exception:
            # 不支持 reconfigure 的流（被重定向等）就原样留着
            pass


_ensure_writable_streams()


# --------------------------------------------------------------------------
# 全局状态：当前工作会话
# --------------------------------------------------------------------------


class Session:
    """界面与后端共享的唯一状态。

    排版方案只在这里存一份 —— 前端每次改动都提交回来，
    服务端据此重算书页结构再返回。禁止两边各存一份，否则必然不同步。
    """

    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.source_dir: Path | None = None
        self.title = core.DEFAULT_TITLE
        self.subtitle = core.DEFAULT_SUBTITLE
        self.photos: list[core.Photo] = []
        self.output_dir: Path = core.default_output_dir()
        self.last_generated: Path | None = None
        self.generating = False
        # 开始生成的时间戳。用来识别「卡住的」生成标记：
        # 如果进程被杀、或某次生成异常退出，generating 可能一直是 True，
        # 那「生成画册」按钮就会永远回一句"正在生成中"，用户彻底没法用。
        self.generating_since: float = 0.0
        self.pages: list[dict] = []
        # 封面文案的可调样式（Phase 24）。空 dict = 全部走 CSS 默认值。
        # ★ 只在服务端存一份：界面每次改动都提交回来，和排版方案同一条规矩。
        self.cover_text: dict[str, dict[str, Any]] = {}
        # 缩略图缓存：文件名 -> jpeg bytes
        self._thumb_cache: dict[str, bytes] = {}

    # ---- 生成标记 ----------------------------------------------------------

    def begin_generating(self) -> None:
        """进入生成态。调用方必须已持有 self.lock。"""

        self.generating = True
        self.generating_since = time.time()

    def end_generating(self) -> None:
        """退出生成态。调用方必须已持有 self.lock。"""

        self.generating = False
        self.generating_since = 0.0

    def generating_blocked(self) -> bool:
        """是否有一次「还在进行中」的生成。

        超过 10 分钟仍标记为生成中，视为上一次是异常退出留下的僵尸标记，
        自动清掉，让用户能重新点。宁可偶尔并行一次，也不要永久卡死。
        """

        if not self.generating:
            return False
        if self.generating_since and time.time() - self.generating_since > 600:
            self.end_generating()
            return False
        return True

    # ---- 派生数据 ----------------------------------------------------------

    def pages_of(self, photos: list[core.Photo] | None = None) -> list[dict]:
        """按当前照片顺序算出书页结构。"""

        items = photos if photos is not None else self.photos
        return core.build_page_sequence(items)

    def plan_payload(self) -> dict[str, Any]:
        """给前端的完整状态。"""

        pages = self.pages_of()
        self.pages = pages
        return {
            "sourceDir": str(self.source_dir) if self.source_dir else "",
            "outputDir": str(self.output_dir),
            "title": self.title,
            "subtitle": self.subtitle,
            "coverText": self.cover_text,
            "photoCount": len(self.photos),
            "pageCount": len(pages),
            "photos": [
                {
                    "order": p.order,
                    "name": p.name,
                    "path": str(p.path),
                    "orientation": p.orientation,
                    "width": p.width,
                    "height": p.height,
                    "plate": p.plate,
                    "position": p.position,
                    "meanLum": round(p.mean_lum, 1),
                    "sharpness": round(p.sharpness, 4),
                    "takenAt": p.taken_at,
                    "exifOrientation": p.exif_orientation,
                }
                for p in self.photos
            ],
            "pages": [
                {
                    "index": pg["index"],
                    "kind": pg["kind"],
                    "density": pg["density"],
                    "photoOrder": pg["photo"].order if pg["photo"] else None,
                }
                for pg in pages
            ],
        }


SESSION = Session()


# --------------------------------------------------------------------------
# 代理规避
# --------------------------------------------------------------------------


def bypass_proxy() -> None:
    """让本进程的出站请求不走系统代理。

    本机常驻 HTTP_PROXY/HTTPS_PROXY，回环地址会被送去代理而失败。
    这里既清环境变量，也装一个空 ProxyHandler 作为双保险。
    """

    for key in list(os.environ):
        if "PROXY" in key.upper():
            os.environ.pop(key, None)
    os.environ["NO_PROXY"] = "*"
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    urllib.request.install_opener(opener)


# --------------------------------------------------------------------------
# 打开浏览器
# --------------------------------------------------------------------------


def open_browser(url: str) -> None:
    """用系统默认浏览器打开一个本机地址。

    优先 os.startfile：它直接交给系统 shell，不经过 webbrowser 的
    浏览器探测，也不会被 HTTP_PROXY 绕一道（webbrowser 在某些走代理的
    环境下会打不开回环地址）。失败了再退回 webbrowser。
    """

    try:
        if sys.platform.startswith("win"):
            os.startfile(url)  # noqa: S606
            return
    except Exception:
        pass
    try:
        webbrowser.open(url)
    except Exception:
        pass


# 关掉「自动开浏览器」的环境变量（任何非空且非 "0" 的值都算关）。
# 与 make_flipbook.NO_OPEN_ENV 同名同义 —— 两个进程用的是同一套约定。
NO_OPEN_ENV = "FLIPBOOK_NO_OPEN"


def auto_open_enabled(no_open_flag: bool = False) -> bool:
    """工作台启动后要不要自动开浏览器。

    ★ 这里**故意不加**「只在终端里才开」那条判据（make_flipbook 那边有）：
    佘先生双击 `画册.bat` 走的是 pythonw，根本没有终端，加了就把他的正路堵死了。
    他的原话是「你打开的页面不用了关掉」—— 要治的是**脚本**起服务那一路，
    所以这里认两样：命令行 `--no-open`，以及环境变量 `FLIPBOOK_NO_OPEN`
    （环境变量会随子进程一路继承，命令行不一定过得了我们手）。
    """

    if no_open_flag:
        return False
    return os.environ.get(NO_OPEN_ENV, "").strip() in ("", "0")


# --------------------------------------------------------------------------
# 缩略图
# --------------------------------------------------------------------------


def thumbnail_bytes(photo: core.Photo, long_edge: int = 420) -> bytes:
    """生成一张缩略图的 JPEG 字节。EXIF 方向在这里一并纠正。"""

    try:
        stamp = photo.path.stat().st_mtime_ns
    except OSError:
        stamp = 0
    cache_key = f"{photo.path}|{stamp}|{long_edge}"
    cached = SESSION._thumb_cache.get(cache_key)
    if cached is not None:
        return cached

    from PIL import Image, ImageOps

    with Image.open(photo.path) as raw:
        img = ImageOps.exif_transpose(raw).convert("RGB")
    img.thumbnail((long_edge, long_edge), Image.Resampling.LANCZOS)

    buf = io.BytesIO()
    img.save(buf, "JPEG", quality=80, optimize=True)
    data = buf.getvalue()

    # 缓存别无限涨
    if len(SESSION._thumb_cache) > 400:
        SESSION._thumb_cache.clear()
    SESSION._thumb_cache[cache_key] = data
    return data


# --------------------------------------------------------------------------
# 处理请求
# --------------------------------------------------------------------------


def json_response(handler: BaseHTTPRequestHandler, payload: Any, status: int = 200) -> None:
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Content-Length", str(len(body)))
    handler.send_header("Cache-Control", "no-store")
    handler.end_headers()
    handler.wfile.write(body)


def drain_request_body(handler: BaseHTTPRequestHandler) -> None:
    """把还没读完的请求体读掉。

    仅用于「确定请求体一个字都没读过」的路由兜底（比如 404 分支）。
    绝不能在已经调用过 read_json() 之后再调用 —— 那时 body 已消费，
    再按 Content-Length 去读会永久阻塞，把服务卡死。
    用非阻塞探测：先看缓冲区里还有没有可读数据，没有就直接返回。
    """

    try:
        length = int(handler.headers.get("Content-Length") or 0)
    except (TypeError, ValueError):
        length = 0
    if length <= 0:
        return

    import select

    remaining = length
    while remaining > 0:
        try:
            ready, _, _ = select.select([handler.rfile], [], [], 0.05)
        except Exception:
            return
        if not ready:
            return  # 没有待读数据了，别等
        chunk = handler.rfile.read(min(remaining, 65536))
        if not chunk:
            return
        remaining -= len(chunk)


def error_response(handler: BaseHTTPRequestHandler, exc: Exception, status: int = 400) -> None:
    """把异常变成前端可读的中文提示，不把栈丢给界面。"""

    detail = str(exc) or type(exc).__name__
    # 关键：直接关连接，不要在异常路径上再读 socket。
    # 之前在此处 drain 请求体，遇到已消费过的 body 会永久阻塞，
    # 表现为界面点了按钮就一直转圈。
    handler.close_connection = True
    try:
        json_response(
            handler,
            {"ok": False, "error": detail, "kind": type(exc).__name__},
            status,
        )
    except Exception:
        handler.close_connection = True


# --------------------------------------------------------------------------
# 封面文案预览 + 弹窗编辑器（Phase 24 / 25）
# --------------------------------------------------------------------------
#
# 佘先生（2026-09-25）：「把封面文案样式那里改成点击唤起编辑封面的窗口，
#   窗口处要可以移动文字框，编辑文字的大小、字体、颜色，然后点击确定后返回工具的主窗口」。
#
# 做法：预览页多认一个 `?edit=1`，加了它才注入下面两个常量（CSS + JS）。
# 不加参数的 `/preview/cover` 与 Phase 24 一字不差 —— 少一个开关就少一处风险。
#
# ★★ 两条硬约束，都是真踩过或要防的：
#
#   1. **类名一律 `cve-` 前缀**。
#      这个文档同时加载了产品那套 `styles.css`（故意的 —— 预览必须与出书同源），
#      所以任何与产品重名的类都会被产品的规则渗进来。
#      2026-09-24 的 `.stage` 事故就是这么来的：包装层撞名 ⇒ 封面宽度算成 0px
#      ⇒ `cqw` 字号全塌成 0 ⇒ 用户看到一个**完全空白**的预览框，
#      而 HTML / CSS / 服务端三层全绿。见 findings 第 47 条。
#
#   2. **除了「拖动」，其他样式一律用服务端给的样式串**。
#      拖动中只允许就地改 `--ct-<元素>-x/y` 这两个变量（拖完由主窗口把
#      服务端的完整样式串原样覆盖回去）。
#      这样「预览 = 成品」**不靠前端复刻一套映射来维持** —— 前端一旦自己拼
#      `--ct-*-family` / `-align` / `-color`，就迟早和 `cover_text_style()` 跑偏，
#      而那种跑偏只有"拿真浏览器逐项量"才抓得住。selftest 成功Q 静态钉住这条。

COVER_EDITOR_CSS = """
/* 拖动用的命中框。
   ★ `position: fixed` 是有意的：坐标直接取 `getBoundingClientRect()` 的视口值，
     不需要任何祖先当定位参照 —— 这个文档的 body 是 grid，不能拿来当参照物；
     而且 fixed 保证不会被产品 CSS 里 `html, body` 那两条规则影响。 */
.cve-layer { position: fixed; inset: 0; z-index: 2147483000; pointer-events: none; }
.cve-hit {
  position: fixed; pointer-events: auto; cursor: move; box-sizing: border-box;
  border: 1px dashed rgb(255 209 102 / 85%); border-radius: 3px;
  background: rgb(255 209 102 / 8%);
}
.cve-hit:hover { background: rgb(255 209 102 / 18%); }
.cve-hit.cve-on { background: rgb(255 209 102 / 15%); box-shadow: 0 0 0 2px rgb(255 209 102 / 24%); }
.cve-hit.cve-dragging { cursor: grabbing; background: rgb(255 209 102 / 26%); }
/* 右下角的缩放手柄（Phase 26）：只有**当前选中**的那个框才露出来。
   小方块 + 斜向光标，一眼看出这是"拖着改大小"。
   ★ 它在 .cve-hit 里面，所以 pointerdown 必须 stopPropagation ——
     否则同一下会连着触发"挪位置"，框会斜着跑（见 COVER_EDITOR_JS 的说明）。 */
.cve-handle {
  position: absolute; right: -6px; bottom: -6px;
  width: 12px; height: 12px; border-radius: 2px;
  background: rgb(255 209 102 / 95%); border: 1px solid rgb(122 92 20 / 75%);
  cursor: nwse-resize; display: none;
}
.cve-hit.cve-on .cve-handle { display: block; }
"""

COVER_EDITOR_JS = """
(function () {
  'use strict';

  var page = document.querySelector('.art-page');
  if (!page) return;

  var TARGETS = [
    ['title', '.cover-title'],
    ['subtitle', '.cover-subtitle'],
    ['foot', '.cover-foot']
  ];

  // 自定义文字框（Phase 26）：服务端渲染时带了 `data-ct="x1"` 这样的标记，
  // 所以这里认得出它们。**一律锚在顶部**（CSS 里就是 `top:var(--ct-x1-y,…)`）。
  //
  // ★ 这样"新增的框"和"内置的三个"在拖动/缩放上是同一套代码 —— 前端不必
  //   知道哪个是先天的、哪个是后加的。少一条分支就少一处会跑偏的地方。
  var EXTRA_SELECTOR = '.cover-extra[data-ct]';

  /** 每个元素的 y 锚在**顶部**还是**底部** —— 答案在 `style/book-style.css` 里：
   *    标题/副标题是 `top:var(--ct-*-y)`，页脚是 `bottom:var(--ct-foot-y)`。
   *
   *  ★ 这里**必须写出来**，不能"问计算样式推导"。
   *    我第一版想省事，用 `getComputedStyle(el).bottom !== 'auto'` 判断，
   *    结果**页脚和标题都被判成底部锚**：绝对定位元素的 `bottom` 在
   *    `getComputedStyle` 里返回的是**used value（px）**，不是 `auto`。
   *    症状很隐蔽 —— X 轴拖得完全正确，只有 Y 轴**反向走**；
   *    而"画面确实动了"，只看"动了没有"的自测照样全绿。
   *    （2026-09-24 实测：拖 DY=+70px，y 从 15% 跑到 62.7%（正向但过大）…
   *      追下去才知道是 `drag.bottom` 为真 ⇒ 取负 ⇒ 越拖越反向。）
   *  ⇒ 前端写死的部分靠 `selftest.py` 的「成功R」静态对账 `book-style.css`，
   *    两处不一致立刻红，不靠人眼盯。 */
  var Y_AXIS = { title: 'top', subtitle: 'top', foot: 'bottom' };

  var layer = document.createElement('div');
  layer.className = 'cve-layer';
  document.body.appendChild(layer);

  var items = [];

  /** 给一个文字元素挂上命中框（+ 右下角的缩放手柄）。
   *
   *  ★ `offsetParent === null` 说明它是 `display:none` —— 也就是被用户"删掉"
   *    的内置元素（Phase 26 的「删减选框」）。这种元素不挂框：量出来是 0×0，
   *    挂了只会在页角留一个假框，让用户以为那里有东西可拖。
   */
  function addItem(key, el, axis) {
    if (!el || el.offsetParent === null) return;
    var hit = document.createElement('div');
    hit.className = 'cve-hit';
    hit.dataset.ct = key;
    var handle = document.createElement('div');
    handle.className = 'cve-handle';
    hit.appendChild(handle);
    layer.appendChild(hit);
    items.push({
      key: key, el: el, hit: hit, handle: handle,
      axis: axis === 'bottom' ? 'bottom' : 'top'
    });
  }

  TARGETS.forEach(function (pair) {
    // Y_AXIS 表里没有的键（理论上不会）按顶部算，别让拖动整个失效
    addItem(pair[0], document.querySelector(pair[1]), Y_AXIS[pair[0]]);
  });
  Array.prototype.forEach.call(document.querySelectorAll(EXTRA_SELECTOR), function (el) {
    addItem(el.dataset.ct, el, 'top');
  });
  if (!items.length) return;

  var active = items[0].key;
  var drag = null;

  function clamp(v) { return v < 0 ? 0 : (v > 100 ? 100 : v); }

  /** 文字框宽度下限（%）。★ 必须和 `make_flipbook._COVER_NUM_RANGES["w"]` 的
   *  下限一致 —— 前端拖到 5%、后端夹到 5%，两边同一个数。
   *  否则会出现"拖的时候停在这，一提交弹到那"，而且只有拖到头才看得出来。 */
  var COVER_MIN_W = 5;

  function clampRange(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  /** 量出这个元素当前的位置，换算成「锚点占整页的百分比」。
   *
   *  x 永远是 `left` 的值；但**视觉锚点**随对齐方式不同：
   *    居左 → 左边缘；居中 → 中心（CSS 里是 translateX(-50%)）；
   *    居右 → 右边缘（translateX(-100%)）。
   *  所以不能直接读 `rect.left`，得按 text-align 反推 —— 否则一改对齐，
   *  第一次拖动就会跳一下。
   *
   *  y 的锚点在顶部还是底部查 `Y_AXIS`（理由见那里的注释：算不出来）。
   */
  function anchorOf(item) {
    var box = page.getBoundingClientRect();
    var r = item.el.getBoundingClientRect();
    var cs = getComputedStyle(item.el);
    var x;
    if (cs.textAlign === 'center') x = r.left - box.left + r.width / 2;
    else if (cs.textAlign === 'right' || cs.textAlign === 'end') x = r.right - box.left;
    else x = r.left - box.left;
    var bottomAnchored = item.axis === 'bottom';
    var y = bottomAnchored ? box.bottom - r.bottom : r.top - box.top;
    return {
      x: box.width > 0 ? x / box.width * 100 : 0,
      y: box.height > 0 ? y / box.height * 100 : 0,
      bottom: bottomAnchored
    };
  }

  /** 让命中框贴着文字。文字一移位（拖动、换字号、换字体）就得重来一次。 */
  function sync() {
    items.forEach(function (item) {
      var r = item.el.getBoundingClientRect();
      var s = item.hit.style;
      s.left = r.left + 'px';
      s.top = r.top + 'px';
      s.width = Math.max(6, r.width) + 'px';
      s.height = Math.max(6, r.height) + 'px';
      item.hit.classList.toggle('cve-on', item.key === active);
      item.hit.classList.toggle('cve-dragging', !!(drag && drag.key === item.key));
    });
  }

  function setActive(key) {
    active = key;
    sync();
    if (window.__cve && window.__cve.onSelect) window.__cve.onSelect(key);
  }

  /** ★ 拖动中**只改这两个变量**，别的一律不碰（见文件顶部第 2 条硬约束）。 */
  function previewPos(key, x, y) {
    page.style.setProperty('--ct-' + key + '-x', x.toFixed(3) + '%');
    page.style.setProperty('--ct-' + key + '-y', y.toFixed(3) + '%');
  }

  /** 缩放中：只改宽度与字号这两个变量（同上，其余一律由服务端串覆盖回来）。 */
  function previewSize(key, w, size) {
    page.style.setProperty('--ct-' + key + '-w', w.toFixed(3) + '%');
    page.style.setProperty('--ct-' + key + '-size', size.toFixed(3) + 'cqw');
  }

  function onMove(ev) {
    if (!drag) return;
    var box = page.getBoundingClientRect();
    var dw = box.width / 100;
    var dh = box.height / 100;
    var dx = ev.clientX - drag.clientX;
    var dy = ev.clientY - drag.clientY;

    if (drag.mode === 'scale') {
      // 缩放：横向拖多远，框就（等比）变多宽，**字号跟着同一个比例走**。
      // ★ 为什么等比、而不是"只改宽度"：只改宽度的话文字立刻重新折行，
      //   看起来像"内容变成了另一段"，而用户想要的通常是"这块整体大/小一点"。
      //   宽度和字号各自还有滑块可以单独细调 —— 手柄负责顺手的那个，
      //   滑块负责较真的那个。
      var nw = clampRange(drag.w0 + (dw > 0 ? dx / dw : 0), COVER_MIN_W, 100);
      var ratio = drag.w0 > 0 ? nw / drag.w0 : 1;
      var ns = clampRange(drag.size0 * ratio, 0.5, 40);
      previewSize(drag.key, nw, ns);
      sync();
      if (window.__cve && window.__cve.onScale) window.__cve.onScale(drag.key, nw, ns);
      return;
    }

    // 页脚锚的是 bottom：往下拖 = 距底变小，所以取负。
    var nx = clamp(drag.x + (dw > 0 ? dx / dw : 0));
    var ny = clamp(drag.y + (dh > 0 ? (drag.bottom ? -dy : dy) / dh : 0));
    previewPos(drag.key, nx, ny);
    sync();
    if (window.__cve && window.__cve.onDrag) window.__cve.onDrag(drag.key, nx, ny);
  }

  function endDrag() {
    if (!drag) return;
    var done = drag.key;
    drag = null;
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', endDrag);
    window.removeEventListener('pointercancel', endDrag);
    sync();
    if (window.__cve && window.__cve.onDragEnd) window.__cve.onDragEnd(done);
  }

  /** 开始一次拖动。位置和缩放共用收尾逻辑（松手才提交，见主窗口的 onDragEnd）。 */
  function beginDrag(ev, item, state) {
    ev.preventDefault();
    setActive(item.key);
    drag = state;
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', endDrag);
    window.addEventListener('pointercancel', endDrag);
    sync();
  }

  items.forEach(function (item) {
    // 拖框身 = 挪位置
    item.hit.addEventListener('pointerdown', function (ev) {
      var a = anchorOf(item);
      beginDrag(ev, item, {
        mode: 'move',
        key: item.key, clientX: ev.clientX, clientY: ev.clientY,
        x: a.x, y: a.y, bottom: a.bottom
      });
    });

    // 拖右下角手柄 = 缩放（Phase 26）。
    // ★ `stopPropagation` 是必须的：手柄在命中框**里面**，不拦住的话同一下
    //   pointerdown 会冒泡到 hit 上，位置拖动也跟着起来 —— 于是"拖角缩放"
    //   变成了"边缩放边挪位"，框会斜着跑。
    item.handle.addEventListener('pointerdown', function (ev) {
      ev.stopPropagation();
      var box = page.getBoundingClientRect();
      var r = item.el.getBoundingClientRect();
      var fontPx = parseFloat(getComputedStyle(item.el).fontSize) || 0;
      // 起点宽度 / 字号都**按当前实际渲染值反推**，不去查配置。
      // 这样"没配过宽度"的元素（宽度由 left/right 决定）也能被拖角缩放：
      // 量出来多宽，起点就是多宽 —— 不会因为缺少配置而跳一下。
      beginDrag(ev, item, {
        mode: 'scale',
        key: item.key, clientX: ev.clientX, clientY: ev.clientY,
        w0: box.width > 0 ? r.width / box.width * 100 : 100,
        size0: box.width > 0 ? fontPx / box.width * 100 : 2
      });
    });
  });

  window.addEventListener('resize', sync);

  /** 主窗口的接口。
   *  预览是**同源** iframe，父级直接取用即可，不必绕 postMessage。 */
  window.__cve = {
    /** 命中框个数。主窗口用它确认"编辑器真的挂上了"（挂不上必须报错，不能装作没事）。 */
    hits: items.length,
    /** 当前挂了框的键（含自定义框）。主窗口用它核对"该有的框都在"。 */
    keys: items.map(function (i) { return i.key; }),
    sync: sync,
    select: setActive,
    /** 把服务端的样式串**原样**写到封面上。
     *  空串 ⇒ 连 style 属性都不写 —— 与成品 `cover_attr` 的写法完全一致。 */
    setStyle: function (style) {
      if (style) page.setAttribute('style', style);
      else page.removeAttribute('style');
      sync();
    },
    /** 就地改一个框的**文字内容**（Phase 26）。
     *  ★ 只改 textContent，不碰任何样式 —— 样式仍然只有服务端一份来源
     *    （成功Q 钉住的就是这条）。放在这里只是为了让用户打字时预览跟着动：
     *    不这样的话，加完新框在右边写字，封面上一点反应都没有，
     *    根本分不清自己正在改哪个框。 */
    setText: function (key, text) {
      var hit = null;
      for (var i = 0; i < items.length; i += 1) {
        if (items[i].key === key) { hit = items[i]; break; }
      }
      if (!hit) return false;
      hit.el.textContent = text;
      sync();
      return true;
    },
    /** 量一个框当前占整页多宽（%）。主窗口用它显示「自动 76.5%」。 */
    widthOf: function (key) {
      var hit = null;
      for (var i = 0; i < items.length; i += 1) {
        if (items[i].key === key) { hit = items[i]; break; }
      }
      if (!hit) return null;
      var box = page.getBoundingClientRect();
      if (!(box.width > 0)) return null;
      return hit.el.getBoundingClientRect().width / box.width * 100;
    },
    onSelect: null,
    onDrag: null,
    onDragEnd: null,
    /** 拖角缩放中回调 `(key, w, size)`。与 onDrag 分开，是因为两者改的
     *  变量不同 —— 合成一个回调会让主窗口不得不用一个 mode 参数去分叉。 */
    onScale: null
  };

  sync();
})();
"""


_FONT_NAME_BAD = re.compile(r"[^\w一-龥-]+")


def _font_slug(name: str) -> str:
    """字体名 → 安全的内部名（同时用作文件名和配置键）。"""
    slug = _FONT_NAME_BAD.sub("-", name).strip("-").lower()
    return slug[:32] or "font"


def save_user_font(name: str, payload: str) -> dict:
    """把一个字体文件收进字体库，返回它的登记条目。

    任何一步不对都抛 `ValueError` —— 由 `error_response()` 变成人话提示，
    不弹栈、不崩。★ 只有真正能用的字体才会被登记，免得下拉里躺着一条废项。
    """
    raw = (payload or "").strip()
    if raw.startswith("data:"):      # 前端给的是 dataURL，剥掉前缀
        raw = raw.split(",", 1)[-1]
    try:
        data = base64.b64decode(raw, validate=False)
    except Exception as exc:
        raise ValueError(f"这个字体文件读不出来（{exc}）") from exc
    if not data:
        raise ValueError("这个字体文件是空的")
    if len(data) > core.USER_FONT_MAX_BYTES:
        raise ValueError(
            f"这个字体太大了（{len(data) / 1048576:.1f} MB），"
            f"最多支持 {core.USER_FONT_MAX_BYTES // 1048576} MB"
        )
    kind = core.font_format_of(data)
    if kind is None:
        raise ValueError("这个文件不是字体（只认 .ttf / .otf / .woff / .woff2）")
    fmt, ext = kind

    stem = Path(name or "font").stem or "font"
    # label 会原样进 CSS 的 font-family，先按 core 那边的规矩掐掉能作乱的字符
    label = re.sub(r"['\";<>{}\\()]", "", stem).strip()[:40] or "字体"
    key = _font_slug(stem)
    fonts_dir = core.USER_FONT_FILES_DIR
    fonts_dir.mkdir(parents=True, exist_ok=True)
    taken = {f["key"] for f in core.load_user_fonts()}
    if key in taken:                 # 同名往后排，不覆盖已有的
        n = 2
        while f"{key}_{n}" in taken:
            n += 1
        key = f"{key}_{n}"
    (fonts_dir / f"{key}{ext}").write_bytes(data)

    try:                             # 原样保留已有条目（连 added 字段一起）
        old = json.loads(core.USER_FONT_REGISTRY.read_text(encoding="utf-8"))
        entries = [
            e for e in old.get("fonts", [])
            if isinstance(e, dict) and e.get("key") != key
        ]
    except Exception:
        entries = [dict(f) for f in core.load_user_fonts()]
    entry = {
        "key": key,
        "label": label,
        "file": f"{key}{ext}",
        "fmt": fmt,
        "size": len(data),
        "license": "使用者自备，请确认有权使用",
        "source": f"本机导入：{name}",
        "added": time.strftime("%Y-%m-%d"),
    }
    entries.append(entry)
    core.USER_FONTS_DIR.mkdir(parents=True, exist_ok=True)
    core.USER_FONT_REGISTRY.write_text(
        json.dumps({"version": 1, "fonts": entries}, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    core.load_user_fonts(refresh=True)
    return entry


def cover_preview_document(edit: bool = False) -> str:
    """封面文案的预览页。**和成品同一份生成器、同一套 CSS。**

    为什么不做成"前端自己拿 CSS 画一个像的"：
    那样两份样式迟早跑偏（改一处忘一处），用户会看到"预览好看、出书难看"。
    这里直接调 `core.page_html()` 生成那张封面 article —— 除了照片换成缩略图，
    其余与成品同源；引用的也是成品用的那两个 CSS 文件（styles.css 里
    `@import` 了 style/book-style.css，字体和纸纹的相对路径都能对上）。

    `edit=True` 时多注入编辑器的 CSS / JS（弹窗里拖文字框要用）。
    不传就与 Phase 24 完全一致 —— 少一个开关就少一处风险。
    """

    with SESSION.lock:
        photos = list(SESSION.photos)
        pages = SESSION.pages_of(photos)
        title = SESSION.title
        subtitle = SESSION.subtitle
        cover_text = dict(SESSION.cover_text)
        if not pages:
            raise ValueError("还没有照片，先选一个照片文件夹")
        page = dict(pages[0])
        if photos:
            # ★ 只改**浅拷贝**的 artwork，绝不碰 SESSION.photos[0] 本体 ——
            #   碰了它，下一次真出书时封面的 src 会变成 http://…，
            #   做出来的本地书就废了（双击打开是空白）。
            preview = copy.copy(photos[0])
            preview.artwork = f"/thumb?id={preview.order}&hero=1"
            # 缩略图尺寸和原图不同，但 CSS 里 .plate img 是 100%/100% + object-fit:cover，
            # 这两个属性只当占位；给照片自身尺寸，免得写出 width="0" height="0"。
            preview.artwork_width = preview.width
            preview.artwork_height = preview.height
            if page.get("kind") == "frontcover":
                page["photo"] = preview
            else:
                page["cover_photo"] = preview

    body = core.page_html(page, title, subtitle, len(photos), cover_text)
    # ★ 预览里也要能选到外部字体（Phase 30）：把字体库的 `@font-face` 一并给浏览器。
    #   浏览器只下载**真正被引用**的那一个 —— 光声明不引用不会白下 3 MB。
    font_css = core.user_font_face_css(
        [f["key"] for f in core.load_user_fonts()], url_prefix="/preview/font/"
    )
    # 封面文案变量**与成品同一份来源**（Phase 30）：预览页没有翻页库，写在封面
    # 那张页 style 属性上的变量不会被冲掉，但两边走同一条路才不会
    # 「预览好看、出书不对」—— 这也是上面那个坑的由来。
    cover_css = core.cover_vars_css(cover_text)
    # ★ 这两段**并进下面那个现成的样式块**，不要另开一块：
    #   成功P 那条判据是"预览页自己那段样式里的类名不许撞产品 CSS"，
    #   它按「源码里第一个 style 标签」定位。另开一块会让它抓错对象（假红）。
    #   ⚠ 同理，注释里也别写出那对标签的字面 —— 它会把定位抢到注释这儿来。
    # ★ 预览页不翻页，故意**不加** `.--left` / `.--right`：
    #   那两个类由 stPageFlip 在翻页时按位置加，是书脊折痕那层渐变的开关。
    #   单张封面孤零零放在这里，加了会凭空多一道暗边，反倒不像成品。
    # ★★ 包装层的类名必须**带自己的前缀**（`cv-`），绝不能叫 `.stage`。
    #   预览页引的是产品那套 styles.css，而它里面已经有一个 `.stage`
    #   （`display:grid; place-items:center; padding:16px 0`）。同名的话两条规则一起生效：
    #   我们的宽度规则 + 产品的 display:grid ⇒ 封面变成网格项、宽度按 fit-content 收缩；
    #   而封面内部全是绝对定位子元素、又带 container-type:inline-size（定宽不参考内容）
    #   ⇒ 宽度塌成 0px，`cqw` 字号全变 0，用户看到的就是**一个空白预览框**。
    #   （2026-09-24 实测：.stage 755×32 —— 那个 32 正是产品的 padding:16px 0；
    #     .art-page 计算宽度 0px。截图见 .ui-shots/_diag-cover-panel.png）
    #
    # ★ 编辑器的 `<script>` 放在 `</body>` 之前、**模板字符串外面**：
    #   它是纯静态文本，用拼接而不是插值，省得把 JS/CSS 里成堆的 `{}` 逐个转义
    #   （转义漏一个就是语法错误，而且只在浏览器里才炸）。
    editor = ""
    if edit:
        editor = (
            f'<style id="cve-style">{COVER_EDITOR_CSS}</style>\n'
            f"<script>{COVER_EDITOR_JS}</script>\n"
        )
    return f"""<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>封面预览</title>
<link rel="stylesheet" href="/preview/asset/styles.css">
<style>
  html, body {{ margin: 0; height: 100%; }}
  body {{ background: #ecebe4; display: grid; place-items: center; overflow: hidden; }}
  /* 让封面按自身比例尽量占满预览框高度，同时不超出宽度。
     ⚠ 类名保持 `cv-fit`：任何与产品 styles.css 重名的类都会被产品的布局规则
     污染（详见上面那段说明）。改名前先 `grep` 一遍 runtime/ 下的 CSS。 */
  .cv-fit {{ width: min(96%, calc((100vh - 16px) * var(--page-ratio, .8))); }}
{font_css}{cover_css}</style>
</head>
<body>
<div class="cv-fit">
{body}
</div>
{editor}</body>
</html>
"""


class Handler(BaseHTTPRequestHandler):
    server_version = "FlipbookUI/1.0"
    # 明写 HTTP/1.0：每个请求独占一条连接，处理完即关。
    # 这是本机单用户工具，压根不需要吞吐量，却换来了「一条请求出错
    # 绝不会污染下一条」的确定性 —— 之前用默认长连接时，
    # 出错后紧接着的下一个请求会从残留字节解析，报出莫名的 404。
    protocol_version = "HTTP/1.0"

    # 关掉逐条访问日志，控制台太吵
    def log_message(self, fmt: str, *args: Any) -> None:
        pass

    # ---- 工具 --------------------------------------------------------------

    def read_json(self) -> dict:
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0:
            self._body_consumed = True
            return {}
        raw = self.rfile.read(length)
        self._body_consumed = True
        try:
            data = json.loads(raw.decode("utf-8"))
        except Exception as exc:
            raise ValueError(f"请求内容不是合法 JSON：{exc}") from exc
        if not isinstance(data, dict):
            raise ValueError("请求内容必须是一个 JSON 对象")
        return data

    def send_file(self, path: Path, content_type: str) -> None:
        if not path.is_file():
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        data = path.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        # 代码类资源（html/js/css）一律不缓存：改完刷新就能看到。
        # ★ 之前统一写 max-age=3600，结果改了界面代码、浏览器还在用一小时前的旧副本，
        #   现象是"改动没生效"，排查方向会被带偏。本机工具，这几 KB 没有缓存的必要。
        # 字体/图片体积大、极少改动，继续允许缓存。
        fresh = path.suffix.lower() in {".html", ".js", ".css"}
        self.send_header("Cache-Control", "no-store" if fresh else "public, max-age=3600")
        self.end_headers()
        self.wfile.write(data)

    def send_bytes(self, data: bytes, content_type: str, *, cache: bool = True) -> None:
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "public, max-age=3600" if cache else "no-store")
        self.end_headers()
        self.wfile.write(data)

    # ---- 路由 --------------------------------------------------------------

    def do_GET(self) -> None:  # noqa: N802
        parsed = urllib.parse.urlparse(self.path)
        route = parsed.path
        query = urllib.parse.parse_qs(parsed.query)

        try:
            if route in ("/", "/index.html"):
                return self.send_file(HERE / "ui" / "index.html", "text/html; charset=utf-8")

            if route.startswith("/static/"):
                rel = urllib.parse.unquote(route[len("/static/"):])
                target = (HERE / "ui" / rel).resolve()
                # 防目录穿越
                if not str(target).startswith(str((HERE / "ui").resolve())):
                    return self.send_error(HTTPStatus.FORBIDDEN)
                return self.send_file(target, guess_type(target))

            if route == "/api/status":
                return json_response(self, status_payload())

            if route == "/api/plan":
                with SESSION.lock:
                    return json_response(self, {"ok": True, "plan": SESSION.plan_payload()})

            if route == "/api/fonts":
                # 字体库清单：封面弹窗打开时用它把下拉补上
                return json_response(self, {"ok": True, "fonts": core.load_user_fonts()})

            if route.startswith("/preview/font/"):
                return self.serve_preview_font(route)

            if route == "/preview/cover":
                # `?edit=1` 才注入编辑器（拖文字框）。不带参数时与 Phase 24 一致。
                edit = query.get("edit", ["0"])[0] in ("1", "true", "yes")
                return self.send_bytes(
                    cover_preview_document(edit=edit).encode("utf-8"),
                    "text/html; charset=utf-8",
                    cache=False,
                )

            if route.startswith("/preview/asset/"):
                return self.serve_preview_asset(route)

            if route == "/thumb":
                return self.serve_thumb(query)

            self.send_error(HTTPStatus.NOT_FOUND)
        except Exception as exc:  # 任何未预料异常都要变成可读回应
            error_response(self, exc, 500)

    def do_POST(self) -> None:  # noqa: N802
        parsed = urllib.parse.urlparse(self.path)
        route = parsed.path
        try:
            if route == "/api/pick-folder":
                return self.handle_pick_folder()
            if route == "/api/scan":
                return self.handle_scan()
            if route == "/api/plan":
                return self.handle_plan()
            if route == "/api/auto-arrange":
                return self.handle_auto_arrange()
            if route == "/api/cover":
                return self.handle_cover()
            if route == "/api/fonts":
                return self.handle_fonts_post()
            if route == "/api/generate":
                return self.handle_generate()
            if route == "/api/open-output":
                return self.handle_open_output()
            if route == "/api/reveal-output":
                return self.handle_reveal_output()
            if route == "/api/shutdown":
                return self.handle_shutdown()
            # 路由没命中：请求体确实一个字都没读过，可以安全排空
            if not getattr(self, "_body_consumed", False):
                drain_request_body(self)
            return self.send_error(HTTPStatus.NOT_FOUND)
        except Exception as exc:
            error_response(self, exc, 400)

    # ---- 具体处理 ----------------------------------------------------------

    # ---- 外部字体（Phase 30）------------------------------------------------

    def handle_fonts_post(self) -> None:
        """收下一个字体文件。出错由 `save_user_font` 抛 `ValueError` → 人话提示。"""
        payload = self.read_json()
        entry = save_user_font(
            str(payload.get("name") or "font.ttf"),
            str(payload.get("data") or ""),
        )
        json_response(
            self, {"ok": True, "font": entry, "fonts": core.load_user_fonts()}
        )

    def serve_preview_font(self, route: str) -> None:
        """预览页要用的用户字体。★ 只读字体库那一个目录，越界一律 404
        （与 `/preview/asset/` 同一条规矩：顺手开成任意文件读取是万万不行的）。"""
        rel = urllib.parse.unquote(route[len("/preview/font/"):])
        root = core.USER_FONT_FILES_DIR.resolve()
        target = (root / rel).resolve()
        if not str(target).startswith(str(root)) or not target.is_file():
            return self.send_error(HTTPStatus.NOT_FOUND)
        return self.send_file(target, guess_type(target))

    def serve_thumb(self, query: dict) -> None:
        try:
            order = int(query.get("id", ["0"])[0])
        except (TypeError, ValueError):
            raise ValueError("缩略图编号不合法")

        # 预览里的照片要大一点（hero），列表里的缩略图小一点
        hero = query.get("hero", ["0"])[0] in ("1", "true", "yes")
        long_edge = 560 if hero else 320

        with SESSION.lock:
            photo = next((p for p in SESSION.photos if p.order == order), None)
        if photo is None:
            raise ValueError("找不到这张照片，可能还没扫描目录")

        data = thumbnail_bytes(photo, long_edge)
        self.send_bytes(data, "image/jpeg")

    def serve_preview_asset(self, route: str) -> None:
        """预览页要用的运行时资源（只读）。

        ★ 只从 `runtime/` 里取，越界或取不到一律 404 ——
          预览页是给界面自己用的，绝不能顺手开成"任意文件读取"的口子。
        """

        rel = urllib.parse.unquote(route[len("/preview/asset/"):])
        root = (HERE / "runtime").resolve()
        target = (root / rel).resolve()
        if not str(target).startswith(str(root)) or not target.is_file():
            return self.send_error(HTTPStatus.NOT_FOUND)
        return self.send_file(target, guess_type(target))

    def handle_pick_folder(self) -> None:
        """弹系统文件夹选择框。这是 UI 里唯一一次用到原生对话框。"""

        import ui_common

        chosen = ui_common.choose_folder("请选择装照片的文件夹")
        if not chosen:
            return json_response(self, {"ok": True, "cancelled": True, "path": ""})
        json_response(self, {"ok": True, "cancelled": False, "path": chosen})

    def handle_scan(self) -> None:
        payload = self.read_json()
        folder = (payload.get("path") or "").strip()
        if not folder:
            raise ValueError("请先选择照片文件夹")

        folder_path = Path(folder).expanduser()
        if not folder_path.is_dir():
            raise NotADirectoryError(f"这个路径不是一个文件夹：\n{folder_path}")

        photos = core.scan(folder_path)
        with SESSION.lock:
            SESSION.source_dir = folder_path
            SESSION.photos = photos
            SESSION._thumb_cache.clear()
            core.assign_plates(photos)
            SESSION.pages = SESSION.pages_of()
            out = payload.get("outputDir")
            if out:
                SESSION.output_dir = Path(out).expanduser()
            return json_response(self, {"ok": True, "plan": SESSION.plan_payload()})

    def handle_plan(self) -> None:
        """接收前端提交的排版改动。

        只接受这几类改动：照片顺序、每张的 plate / position、书名、副标题、
        输出位置、封面文案样式（coverText）。其他一律忽略，
        避免界面传上来的脏数据污染服务端状态。

        ★ `coverText` 走 `core.normalize_cover_text()` 洗白名单再存 ——
          界面能提交什么，和成品愿意接受什么，必须是同一套判据，
          否则会出现"预览好看、出书却按另一套值渲染"的偏差。
        """

        payload = self.read_json()
        valid_plates = set(core.PLATE_GEOMETRY) | {""}
        valid_positions = {"", "high", "low", "aside"}

        with SESSION.lock:
            if not SESSION.photos:
                raise ValueError("还没有扫描照片，无法调整排版")

            order = payload.get("order")
            if order is not None:
                if not isinstance(order, list) or len(order) != len(SESSION.photos):
                    raise ValueError("提交的照片顺序与当前照片数量不一致")
                try:
                    orders = [int(x) for x in order]
                except (TypeError, ValueError) as exc:
                    raise ValueError("照片顺序里出现了非数字") from exc
                if sorted(orders) != sorted(p.order for p in SESSION.photos):
                    raise ValueError("提交的照片编号与当前照片不匹配")
                by_order = {p.order: p for p in SESSION.photos}
                SESSION.photos = [by_order[o] for o in orders]

            edits = payload.get("edits")
            if edits is not None:
                if not isinstance(edits, list):
                    raise ValueError("edits 必须是数组")
                by_order = {p.order: p for p in SESSION.photos}
                for edit in edits:
                    if not isinstance(edit, dict):
                        continue
                    target = by_order.get(int(edit.get("order", -1)))
                    if target is None:
                        continue
                    plate = edit.get("plate")
                    if plate is not None:
                        if plate not in valid_plates:
                            raise ValueError(f"不认识的版面尺寸：{plate}")
                        target.plate = plate or "medium"
                    position = edit.get("position")
                    if position is not None:
                        if position not in valid_positions:
                            raise ValueError(f"不认识的位置：{position}")
                        target.position = position

            title = payload.get("title")
            if isinstance(title, str):
                SESSION.title = title.strip() or core.DEFAULT_TITLE
            subtitle = payload.get("subtitle")
            if isinstance(subtitle, str):
                SESSION.subtitle = subtitle.strip() or core.DEFAULT_SUBTITLE
            out = payload.get("outputDir")
            if isinstance(out, str) and out.strip():
                candidate = Path(out.strip()).expanduser()
                # 早失败：输出位置必须是个目录（或本来就不存在，可以新建）。
                # 如果那里已经被一个同名文件占了，现在就说清楚，
                # 不要等生成到一半再报一句难懂的错。
                if candidate.exists() and not candidate.is_dir():
                    raise NotADirectoryError(
                        f"输出位置被一个同名文件占用了：\n{candidate}\n\n"
                        f"请换一个位置，或先把这个文件删掉/改名。"
                    )
                SESSION.output_dir = candidate

            # 封面文案样式（Phase 24）。`null` / 缺省 = 这次不动它；
            # 传 `{}` = 明确的"全部恢复默认"。两种情况要分得清，
            # 否则「恢复默认」按钮会点了没反应。
            if "coverText" in payload:
                SESSION.cover_text = core.normalize_cover_text(payload.get("coverText"))

            SESSION.pages = SESSION.pages_of()
            return json_response(self, {"ok": True, "plan": SESSION.plan_payload()})

    def handle_auto_arrange(self) -> None:
        with SESSION.lock:
            if not SESSION.photos:
                raise ValueError("还没有扫描照片，无法自动排版")
            core.assign_plates(SESSION.photos)
            SESSION.pages = SESSION.pages_of()
            return json_response(self, {"ok": True, "plan": SESSION.plan_payload()})

    def handle_cover(self) -> None:
        """只改封面文案样式。

        ★ 为什么不复用 /api/plan：那个接口会重算整本书结构，还会让前端
          重画照片网格（100 张缩略图）。拖一次滑块要发十几个请求，
          拿它来干这个会把界面拖卡。这里只动一个字段、回包也只回它。
        ★ 洗白名单的活交给 `core.normalize_cover_text()` —— 界面能提交什么、
          成品愿意接受什么，必须是同一套判据（否则会"预览好看、出书另一套"）。
        ★★ 回包里多带一个 `coverStyle`：**服务端算出来的那串 CSS 变量**，
          主窗口把它原样写到预览的封面元素上。
          做弹窗编辑器时想"前端自己拼变量"的冲动很大 —— 拼了就变成两套映射要人肉同步，
          迟早跑偏。这里让它从源头只有一份。
        """

        payload = self.read_json()
        with SESSION.lock:
            SESSION.cover_text = core.normalize_cover_text(payload.get("coverText"))
            return json_response(self, {
                "ok": True,
                "coverText": SESSION.cover_text,
                "coverStyle": core.cover_text_style(SESSION.cover_text),
            })


    def handle_generate(self) -> None:
        with SESSION.lock:
            if not SESSION.photos:
                raise ValueError("还没有扫描照片，无法生成画册")
            # generating_blocked 会自动清掉两次生成之间卡住的僵尸标记
            if SESSION.generating_blocked():
                raise ValueError("正在生成中，请稍等")
            # 再查一次输出位置，避免绕过 /api/plan 直接出书时踩到同名文件
            if SESSION.output_dir.exists() and not SESSION.output_dir.is_dir():
                raise NotADirectoryError(
                    f"输出位置被一个同名文件占用了：\n{SESSION.output_dir}\n\n"
                    f"请换一个位置，或先把这个文件删掉/改名。"
                )
            SESSION.begin_generating()
            # SESSION.output_dir 指的是「画册集」（见 make_flipbook.default_output_dir），
            # 约定一本书一个文件夹、文件夹名=书名，所以这里再下探一层。
            target = core.book_dir_in(SESSION.output_dir, SESSION.title)
            title = SESSION.title
            subtitle = SESSION.subtitle
            cover_text = dict(SESSION.cover_text)

        try:
            # 生成用的照片顺序以当前方案为准，所以把顺序落成一份临时清单，
            # 让 build_book 按用户排好的顺序扫。
            ordered_paths = []
            with SESSION.lock:
                ordered_paths = [p.path for p in SESSION.photos]
            plates = {p.order: (p.plate, p.position) for p in SESSION.photos}

            plan = core.build_book_ordered(
                ordered_paths,
                target,
                title=title,
                subtitle=subtitle,
                runtime_dir=HERE / "runtime",
                plate_override=plates,
                cover_text=cover_text,
            )
            with SESSION.lock:
                SESSION.last_generated = target
                SESSION.end_generating()
            return json_response(
                self,
                {
                    "ok": True,
                    "outputDir": str(target),
                    "indexHtml": str(target / "index.html"),
                    "pageCount": plan.page_count,
                },
            )
        except Exception:
            # 无论怎么失败，都必须把生成标记放掉，否则按钮会被永久卡住
            with SESSION.lock:
                SESSION.end_generating()
            raise

    def handle_open_output(self) -> None:
        with SESSION.lock:
            # 没出过书时兜底到画册集 —— 那里至少没有 index.html，
            # 于是会走到下面那句「先点生成画册」，提示是对的。
            target = SESSION.last_generated or SESSION.output_dir
        index = Path(target) / "index.html"
        if not index.is_file():
            raise FileNotFoundError("还没有生成画册，先点「生成画册」")
        import ui_common

        ui_common.open_in_browser(index)
        json_response(self, {"ok": True})

    def handle_reveal_output(self) -> None:
        """在资源管理器里打开输出目录。

        还没出过书时打开的是**画册集**（能看到已经做过的书），
        出过书之后打开的是**这本新书的文件夹**。
        """

        with SESSION.lock:
            target = Path(SESSION.last_generated or SESSION.output_dir)
        if not target.exists():
            raise FileNotFoundError("输出目录还不存在，先点「生成画册」")
        if sys.platform.startswith("win"):
            os.startfile(str(target))  # noqa: S606
        json_response(self, {"ok": True})

    def handle_shutdown(self) -> None:
        json_response(self, {"ok": True, "bye": True})

        def stop() -> None:
            import time

            time.sleep(0.4)
            self.server.shutdown()  # type: ignore[attr-defined]

        threading.Thread(target=stop, daemon=True).start()

        # ★ 光 shutdown() 只是让 serve_forever() 回头，进程还得等到
        #   main() 里写完收尾才真的退出 —— 观察到的现象是「点了关闭工具，
        #   页面关了，pythonw 却还挂在端口上」。这里补一刀硬退出：
        #   它是本进程的收尾，不是开新东西，比留个僵尸干净。
        #
        #   退出前先把 PID 文件清掉（仅当里面写的是自己），否则下次启动
        #   会照着一个死 PID 去探活，白等一轮。
        threading.Thread(target=_exit_after_shutdown, daemon=True).start()


# --------------------------------------------------------------------------
# 辅助
# --------------------------------------------------------------------------


def _clear_own_pidfile() -> None:
    """把 PID 文件清掉 —— 但只在它写的是「本进程」时才清。

    防的是这种情况：两个过程前后脚起服务，后一个已经把文件覆盖成自己的
    PID，前一个收尾时不该把别人的记号擦掉。
    """
    path = HERE / "logs" / ".serve_ui.pid"
    try:
        if path.read_text(encoding="utf-8").strip() == str(os.getpid()):
            path.unlink(missing_ok=True)
    except Exception:
        pass


def _exit_after_shutdown() -> None:
    """被「关闭工具」叫停之后，确保进程真的走掉。

    为什么要它：`server.shutdown()` 只是让 `serve_forever()` 回头，
    `main()` 那边还要跑完 `server_close()` 才算完。实测有 `pythonw.exe`
    在页面关掉之后仍然占着端口挂在那里 —— 用户点的是「关掉工具」，
    他期望的就是它没了。所以给一小段时间让正常收尾，然后硬退出兜底。
    """
    import time

    time.sleep(1.5)
    _clear_own_pidfile()
    os._exit(0)


def guess_type(path: Path) -> str:
    ext = path.suffix.lower()
    return {
        ".html": "text/html; charset=utf-8",
        ".css": "text/css; charset=utf-8",
        ".js": "text/javascript; charset=utf-8",
        ".json": "application/json; charset=utf-8",
        ".svg": "image/svg+xml",
        ".woff2": "font/woff2",
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".webp": "image/webp",
        ".ico": "image/x-icon",
    }.get(ext, "application/octet-stream")


def status_payload() -> dict:
    try:
        from PIL import Image  # noqa: F401

        pillow = True
    except Exception:
        pillow = False
    with SESSION.lock:
        generating = SESSION.generating_blocked()
    return {
        "ok": True,
        # ★ 标记「这是本工具的工作台」。双击入口靠它认领已经跑着的服务 ——
        #   不能只凭「那个端口有人应答」就认（可能是任何别的程序）。
        "app": APP_TAG,
        "pillow": pillow,
        "runtimePresent": (HERE / "runtime" / "vendor" / "page-flip.browser.js").is_file(),
        "hasPhotos": bool(SESSION.photos),
        "generating": generating,
    }


def find_running_workbench(tries: int = 12) -> str:
    """已经有一个本工具的工作台在跑吗？在的话返回它的网址。

    ★ 为什么需要它
    --------------
    入口只留一个之后，「双击两次」是必然会发生的操作。照旧会起第二个服务：
    两个工作台各持一份 Session，用户在 A 里选的封面在 B 里看不见；
    PID 文件还会被后起的覆盖，前一个变成找不到的僵尸。

    所以启动前先认领：从 PID 文件读端口 → 探活 → **确认对面是本工具**
    （用 /api/status 的 app 标记，不能只看端口有人应答就认）。

    ★ 时间预算
    ----------
    探活本身要时间：每个「没人应答」的端口吃掉 `_port_is_taken` 的 0.35 秒，
    每个「有人应答但不是自己人」的端口还要再赔 `_is_our_workbench` 的超时。
    所以端口扫描的个数是**乘数**，别随手调大：扫 40 个 ≈ 14 秒，
    双击一下等 14 秒，用户会以为工具坏了。本工具只会在端口段最前面几个里
    落脚，所以默认扫 12 个（≈4 秒封顶）。PID 文件里那个**排在最前面**，
    命中它只花 0.35 秒 + 一次本地 HTTP 往返。
    """

    candidates: list[int] = []

    # 1) 先看 PID 文件记下的那个端口（最可能是自己人）
    #
    # ★ 顺序很讲究，别把这两步调过来。PID 文件可能是「上一任」留下的死 PID，
    #   它对应的端口没人应答；而这个端口又躺在 range(8770, 8770+tries) 里 ——
    #   先扫一遍再回头验它，等于白等一整轮。
    try:
        pid_txt = (HERE / "logs" / ".serve_ui.pid").read_text(encoding="utf-8").strip()
        port_txt = (HERE / "logs" / "工作台启动位置.txt").read_text(encoding="utf-8")
        import re as _re

        m = _re.search(r"127\.0\.0\.1:(\d+)", port_txt)
        if pid_txt.isdigit() and m:
            candidates.append(int(m.group(1)))
    except Exception:
        pass

    # 2) 再扫常规端口段（PID 文件可能被清掉，但服务还在）
    candidates.extend(range(8770, 8770 + tries))

    seen = set()
    for port in candidates:
        if port in seen:
            continue
        seen.add(port)
        if not _port_is_taken(port):
            continue
        if not _is_our_workbench(port):
            continue
        return f"http://127.0.0.1:{port}/"
    return ""


def _is_our_workbench(port: int, timeout: float = 0.6) -> bool:
    """这个端口上是不是**本工具**的工作台（而不是别的碰巧占着的程序）。

    ★ timeout 要短，别写成 2.5 秒。调用方会一口气试几十个端口，
      超时值会被乘上那个次数 —— 2.5 秒 × 40 个 = 100 秒，双击一次等到天荒地老。
      对面是本机回环上的自己人，0.6 秒足够；真连不上就说明那不是它。
    """

    import json as _json
    import urllib.request

    try:
        # ★ 必须显式绕过代理：本机常驻 HTTP_PROXY，回环地址会被送去代理直接失败
        opener = urllib.request.build_opener(
            urllib.request.ProxyHandler({})       # 空字典 = 不走任何代理
        )
        with opener.open(f"http://127.0.0.1:{port}/api/status", timeout=timeout) as resp:
            if resp.status != 200:
                return False
            data = _json.loads(resp.read().decode("utf-8", "replace"))
        return data.get("app") == APP_TAG and data.get("ok") is True
    except Exception:
        return False


def _port_is_taken(port: int) -> bool:
    """这个端口上是不是已经有东西在服务了。

    ★ 为什么不能只靠 bind 探测（Windows 特有的坑，第二十轮踩到）
    ------------------------------------------------------------
    原来这里写的是「绑得上就算空闲」，而且 bind 之前设了 SO_REUSEADDR。
    但 **Windows 上的 SO_REUSEADDR 语义等于 Unix 的 SO_REUSEPORT** ——
    它允许你把套接字绑到一个*别人已经绑着*的端口上，而且 bind 会成功！
    于是 find_free_port() 会把已经被占用的 8770 原样返回，
    ThreadingHTTPServer 那边默认也是 allow_reuse_address=True，
    同样绑得上 —— 两个工作台就挤在同一个端口上服务。

    后果很实际：PID 文件被后起的那个覆盖，于是关服务只关得掉一个，
    另一个变成谁也找不到的僵尸服务，端口一直被占着。
    （实测就是这么发现的：8770 上留着一个没关的 pythonw.exe。）

    所以先用 connect 探活 —— 有人应答就是被占了，直接跳过。
    """
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        # ★ 0.2 秒够回环用了，别调大：这个值会被端口扫描的次数乘一遍
        #   （见 find_running_workbench 的「时间预算」）。
        s.settimeout(0.2)
        if s.connect_ex(("127.0.0.1", port)) == 0:
            return True           # 有人应答 → 已被占用

    # 没人应答，再用 bind 兜一次（挡住「已绑定但还没开始 accept」的窗口期）。
    # 这里**不能**用 SO_REUSEADDR；Windows 上用 SO_EXCLUSIVEADDRUSE 才能
    # 保证「别人占着就一定绑不上」。
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        exclusive = getattr(socket, "SO_EXCLUSIVEADDRUSE", None)
        if exclusive is not None:
            try:
                s.setsockopt(socket.SOL_SOCKET, exclusive, 1)
            except OSError:
                pass
        try:
            s.bind(("127.0.0.1", port))
        except OSError:
            return True
    return False


def find_free_port(start: int = 8770, tries: int = 40) -> int:
    """从 start 开始找一个**真的**没被占用的端口。"""

    for offset in range(tries):
        port = start + offset
        if not _port_is_taken(port):
            return port
    raise RuntimeError("找不到可用端口，请关掉一些程序再试")


def main() -> int:
    import argparse

    parser = argparse.ArgumentParser(description="画册工作台")
    parser.add_argument("--port", type=int, default=0, help="指定端口（默认自动找）")
    parser.add_argument("--no-open", action="store_true", help="不自动开浏览器")
    parser.add_argument("--source", help="启动时直接载入这个照片目录")
    parser.add_argument(
        "--output",
        help="启动时指定画册集目录（默认用工具约定的 画册集/）",
    )
    args = parser.parse_args()

    bypass_proxy()

    # ★ 已经有一个工作台在跑？那就别再起第二个，直接把它的页面打开。
    #   入口只留一个之后「双击两次」是必然操作；照旧会起两个服务：
    #   两边各持一份 Session（在 A 里选的封面 B 里看不见），
    #   PID 文件还会被后者覆盖，前一个变成谁也找不到的僵尸。
    #
    #   例外：明确指定了 --port 或 --output 时不起复用 ——
    #   那是验收/脚本在起一个**独立**的实例，必须真的起来。
    if not args.port and not args.output:
        running = find_running_workbench()
        if running:
            print("=" * 58)
            print("  画册工作台已经在运行了")
            print(f"  直接打开：{running}")
            print("=" * 58)
            if auto_open_enabled(args.no_open):
                open_browser(running)
            return 0

    if not status_payload()["pillow"]:
        print("缺少 Pillow，无法处理照片。请安装：pip install Pillow")
        return 1
    if not status_payload()["runtimePresent"]:
        print("找不到 runtime 目录，工具文件可能不完整。")
        return 1

    # ★ 指定输出位置：验收用它把出书隔离到临时目录里，
    #   不然每跑一次验收就会用固定书名把用户画册集里那本书覆盖一遍。
    if args.output:
        try:
            out_dir = Path(args.output).expanduser().resolve()
            if out_dir.exists() and not out_dir.is_dir():
                print(f"[警告] 输出位置被同名文件占用，忽略：{out_dir}")
            else:
                out_dir.mkdir(parents=True, exist_ok=True)
                with SESSION.lock:
                    SESSION.output_dir = out_dir
                print(f"出书位置已设为 {out_dir}")
        except Exception as exc:
            print(f"[警告] 设置输出位置失败：{exc}")

    if args.source:
        try:
            photos = core.scan(Path(args.source).expanduser())
            core.assign_plates(photos)
            with SESSION.lock:
                SESSION.source_dir = Path(args.source).expanduser().resolve()
                SESSION.photos = photos
                SESSION.pages = SESSION.pages_of()
            print(f"已载入 {len(photos)} 张照片")
        except Exception as exc:
            print(f"[警告] 载入初始目录失败：{exc}")

    port = args.port or find_free_port()
    url = f"http://127.0.0.1:{port}/"

    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    server.daemon_threads = True

    # 把启动信息同时写进日志。
    # 用 pythonw 启动时没有控制台，出问题时用户看不到任何提示，
    # 只能靠这个文件排查。
    startup_note = (
        f"画册工作台已启动\n"
        f"界面地址：{url}\n"
        f"启动时间：{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}\n"
        f"照片目录：{SESSION.source_dir or '(未选择)'}\n"
        f"要结束服务：点界面右上角「关闭工具」\n"
    )
    try:
        logs = HERE / "logs"
        logs.mkdir(exist_ok=True)
        (logs / "工作台启动位置.txt").write_text(startup_note, encoding="utf-8")
        # 记下自己的 PID。入口只留一个之后没人靠它停服务了，
        # 但「双击第二次时认出自己人」要用它 —— 见 find_running_workbench()
        (logs / ".serve_ui.pid").write_text(str(os.getpid()), encoding="utf-8")
    except Exception:
        pass

    print("=" * 58)
    print("  画册工作台已启动")
    print(f"  界面地址：{url}")
    print("  要结束：点界面右上角「关闭工具」")
    print("=" * 58)

    if auto_open_enabled(args.no_open):
        threading.Timer(0.6, lambda: open_browser(url)).start()

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止。")
    finally:
        server.server_close()
        # ★ 正常收尾时也要把 PID / 启动位置文件清掉。
        #   不清的话，下次启动会先照着一个**死 PID** 去探活 —— 虽然探得到底
        #   （后面还有端口扫描兜底），但白转一秒多，双击体验很差。
        #   真正管这事的是 _clear_own_pidfile()：只在自己仍是那个标记时才删。
        _clear_own_pidfile()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
