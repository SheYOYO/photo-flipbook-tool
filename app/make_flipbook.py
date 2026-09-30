#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把一整个照片文件夹做成一本可翻页的画册（单文件 HTML）。

像素级复用开源项目 HaichaoLihc/create-photo-flipbook-ui 的 2D book 运行时：
  - vendor/page-flip.browser.js   stPageFlip 翻页引擎 (MIT)
  - style/fonts/SourceSerif4-*    Source Serif 4 (SIL OFL)
  - style/paper-grain.svg 等      纸纹 / 布纹
  - flipbook.js / styles.css      阅读器外壳

排版规则（跨页摄影集节奏）：
  - 版式固定为「封面 → 照片… → 版权页 → 封底」，**总页数 T = 照片数 + 3**，
    首末页固定为硬封面。详见 `build_page_sequence()`。
    ★ 这里**没有**「凑 4 的倍数」这回事 —— 那条是早期错设的假设（前后坑了五版），
      库（stPageFlip）并不要求，见 `build_page_sequence` 的说明。
  - 每张照片按「气质」分配 plate 尺寸：特写/情绪强的给大图，安静的给小图
  - ★★ 判据的坐标系：**读者看到的跨页 = (1,2),(3,4),(5,6)…（奇数页在左）**，
    不是文件里的 (2k, 2k+1)。照片从**页位 1** 起连续排，于是除尾巴那一跨页外，
    每个跨页恰好两张照片。详见 `build_page_sequence()`。
  - 横构图铺满整页（`object-fit: cover`），竖构图居中留白
"""

from __future__ import annotations

import argparse
import json
import math
import os
import re
import shutil
import sys
import traceback
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any, Iterable, Sequence

# ★ 本文件住在 app/ 里：_APP = 本文件所在目录，_TOOL = 工具根（仓库根）。
_APP = Path(__file__).resolve().parent
_TOOL = _APP.parent

try:
    from PIL import Image, ImageOps
except ImportError:  # pragma: no cover - 由启动器兜底提示
    Image = None  # type: ignore[assignment]
    ImageOps = None  # type: ignore[assignment]

# --------------------------------------------------------------------------
# 常量
# --------------------------------------------------------------------------

IMAGE_SUFFIXES = (".jpg", ".jpeg", ".png", ".webp", ".bmp", ".tif", ".tiff", ".heic")

# 页面长边上限由运行时契约规定，不能超过 640
PAGE_LONG_EDGE = 640

# 生成图的长边。页面长边 640，留 2 倍余量给 2x 屏
ARTWORK_LONG_EDGE = 1280

JPEG_QUALITY = 86

# plate 尺寸 -> (宽%, 高%)，取自运行时 book-style.css
PLATE_GEOMETRY = {
    "small": (49, 53),
    "medium": (68, 65),
    "large": (86, 82),
    "portrait": (67, 66),
}

# 正文页码的起算见 build_page_sequence()：folio = 页位 + 1（封面算第 1 页），
# 与阅读器状态条的 "12 / 103" 同一套账。
DEFAULT_TITLE = "我的小狗"
DEFAULT_SUBTITLE = "Photographs"


# --------------------------------------------------------------------------
# 数据模型
# --------------------------------------------------------------------------


@dataclass
class Photo:
    """一张照片在画册里的全部已知信息。"""

    path: Path
    order: int
    width: int = 0
    height: int = 0
    orientation: str = "portrait"  # portrait | landscape | square
    mean_lum: float = 128.0
    mean_rgb: tuple[float, float, float] = (128.0, 128.0, 128.0)
    warmth: float = 0.0
    sharpness: float = 0.0
    exif_orientation: int | None = None
    taken_at: str = ""
    # 自动排版结果
    plate: str = "medium"
    position: str = ""
    artwork: str = ""  # 生成后的相对路径
    artwork_width: int = 0
    artwork_height: int = 0
    caption: str = ""

    @property
    def name(self) -> str:
        return self.path.name

    @property
    def is_landscape(self) -> bool:
        return self.orientation == "landscape"


@dataclass
class BookPlan:
    """一本书的完整排布方案，可序列化便于人工微调。"""

    title: str
    subtitle: str
    photos: list[Photo] = field(default_factory=list)
    generated_at: str = ""
    source_dir: str = ""
    blank_plan: list[str] = field(default_factory=list)
    page_count: int = 0
    # 封面文案的可调样式（Phase 24）。空 dict = 全部用 CSS 默认值。
    cover_text: dict[str, dict[str, Any]] = field(default_factory=dict)


# --------------------------------------------------------------------------
# 1. 扫描与读图
# --------------------------------------------------------------------------


def list_images(folder: Path) -> list[Path]:
    """列出目录下的图片，按文件名自然排序（IMG_2 在 IMG_10 之前）。"""

    if not folder.is_dir():
        raise NotADirectoryError(f"不是文件夹：{folder}")

    def natural_key(p: Path):
        return [
            int(part) if part.isdigit() else part.lower()
            for part in re.split(r"(\d+)", p.name)
        ]

    files = [
        p
        for p in folder.iterdir()
        if p.is_file() and p.suffix.lower() in IMAGE_SUFFIXES and not p.name.startswith(".")
    ]
    # 跳过 macOS / Windows 产生的缩略图垃圾
    files = [p for p in files if not p.name.startswith("._") and "thumb" not in p.stem.lower()]
    return sorted(files, key=natural_key)


def _parse_exif_datetime(exif) -> str:
    """从 EXIF 里尽力取一个拍摄时间字符串。"""

    for tag in (36867, 36868, 306):  # DateTimeOriginal / DateTimeDigitized / DateTime
        try:
            raw = exif.get(tag)
        except Exception:
            raw = None
        if raw:
            text = str(raw).strip()
            m = re.match(r"(\d{4})[:\-](\d{2})[:\-](\d{2})", text)
            if m:
                return f"{m.group(1)}-{m.group(2)}-{m.group(3)}"
    return ""


def probe(photo: Photo) -> Photo:
    """读一张图：纠 EXIF 方向、量尺寸、算色彩与清晰度特征。"""

    with Image.open(photo.path) as raw:
        try:
            photo.exif_orientation = raw.getexif().get(274)
        except Exception:
            photo.exif_orientation = None
        photo.taken_at = _parse_exif_datetime(raw.getexif())
        img = ImageOps.exif_transpose(raw).convert("RGB")

    photo.width, photo.height = img.size
    ratio = photo.width / max(1, photo.height)
    if ratio > 1.08:
        photo.orientation = "landscape"
    elif ratio < 0.93:
        photo.orientation = "portrait"
    else:
        photo.orientation = "square"

    # 特征：整体亮度、冷暖、细节密度（用缩略图的灰度梯度近似）
    small = img.resize((96, 96), Image.Resampling.BILINEAR)
    px = list(small.get_flattened_data())
    r = sum(p[0] for p in px) / len(px)
    g = sum(p[1] for p in px) / len(px)
    b = sum(p[2] for p in px) / len(px)
    photo.mean_lum = 0.299 * r + 0.587 * g + 0.114 * b
    photo.warmth = (r - b) / 255.0

    gray = small.convert("L")
    gp = list(gray.get_flattened_data())
    diffs = 0
    for y in range(96):
        row = y * 96
        for x in range(95):
            diffs += abs(gp[row + x] - gp[row + x + 1])
    photo.sharpness = diffs / (96 * 95 * 255.0)
    return photo


def scan(folder: Path) -> list[Photo]:
    """扫描整个文件夹，返回已探测特征的照片列表。"""

    files = list_images(folder)
    if not files:
        raise ValueError(
            f"这个文件夹里没有找到任何图片。\n\n"
            f"目录：{folder}\n"
            f"支持的格式：{'、'.join(IMAGE_SUFFIXES)}\n\n"
            f"请确认选的是装照片的那个文件夹。"
        )
    photos, skipped = probe_many(files)
    if not photos:
        raise ValueError("所有文件都读不了，可能是文件损坏或不是真正的图片。\n\n" + "\n".join(skipped[:10]))
    if skipped:
        print(f"[警告] 跳过 {len(skipped)} 个读不了的文件：")
        for line in skipped[:10]:
            print(f"       - {line}")
    return photos


# --------------------------------------------------------------------------
# 2. 自动排版
# --------------------------------------------------------------------------


def assign_plates(photos: Sequence[Photo]) -> None:
    """给每张照片定 plate 尺寸与位置，形成跨页节奏。

    思路：清晰度 + 画面亮度共同决定"这张图值得多大版面"。
    特写（细节密度高）给 large/portrait，安静的远景给 small/medium。
    """

    if not photos:
        return

    # 横构图天然占满一整页，尺寸给最大；它自己就是跨页的重心
    for photo in photos:
        if photo.is_landscape:
            photo.plate = "large"
            photo.position = ""

    uprights = [p for p in photos if not p.is_landscape]
    if not uprights:
        return

    sharp = [p.sharpness for p in uprights]
    lo, hi = min(sharp), max(sharp)
    span = (hi - lo) or 1.0

    # 竖构图按"值得多大版面"分档：细节密、张力足的给大图，安静的留白多
    ranked = sorted(uprights, key=lambda p: (p.sharpness - lo) / span, reverse=True)
    n = len(ranked)
    for i, photo in enumerate(ranked):
        frac = i / max(1, n - 1) if n > 1 else 0.0
        if frac <= 0.34:
            photo.plate = "large"
            photo.position = "high" if i % 2 == 0 else ""
        elif frac <= 0.67:
            photo.plate = "medium" if photo.mean_lum >= 140 else "portrait"
            photo.position = ""
        else:
            photo.plate = "small"
            photo.position = "low" if i % 2 == 0 else "aside"

    # 同一个跨页里不要出现两个 large，避免版面打架
    ordered = list(photos)
    for i in range(0, len(ordered) - 1, 2):
        a, b = ordered[i], ordered[i + 1]
        if a.is_landscape or b.is_landscape:
            continue
        if a.plate == "large" and b.plate == "large":
            b.plate = "portrait" if b.mean_lum < 140 else "medium"

    # 相邻两张不要都是 small，否则跨页会显得空
    for i in range(1, len(uprights)):
        if uprights[i].plate == "small" and uprights[i - 1].plate == "small":
            uprights[i].plate = "medium"


def build_page_sequence(photos: Sequence[Photo]) -> list[dict]:
    """把照片摊成一条书页序列：封面 → 照片… → 版权页 → 封底。

    返回的每一项是一个 page dict：{"kind": str, "photo": Photo | None}
    kind ∈ {cover, title, colophon, plate, blank, backcover}
    （`title` / `blank` 目前不再产出，`page_html()` 里保留着它们的渲染分支。）

    =======================================================================
    ★★★ 2026-09-24 定稿：以「读者真正看到的跨页」为唯一判据
    =======================================================================
    这个函数前后错了五版，根子全在**把配对算在了错误的坐标系上**。

    **读者看到的跨页 ≠ 文件里的 (2k, 2k+1)。**
      每张纸 = `(2k, 2k+1)`（正面 2k、背面 2k+1），那是**装订单位**；
      读者翻开看到的跨页 = **「上一张纸的背面 + 这张纸的正面」**
      = `(2k+1, 2k+2)`，也就是 `(1,2), (3,4), (5,6) …`
      第 0 页是封面单独显示，最后一页是封底单独显示。

    这条不是推的，是**实测**的（`_probe_t.mjs`，Playwright 真翻页）。
    实测对象是**旧版式**（封面 → 扉页 → 照片… → 版权页 → 封底）的 104 页《深圳》：
        turnToPage(1) → 可见 [扉页(1), 照片(2)]
        turnToPage(3) → 可见 [照片(3), 照片(4)]
    即配对是 `(1,2),(3,4),…` —— **奇数页在左、偶数页在右**。
    （旧版式正是因此让第一跨页变成「扉页 + 照片」= 一面没图。）

    ★★「总页数必须是 4 的倍数」是**我们自己错设的假设**，库并不要求
    ---------------------------------------------------------------
    翻遍 `runtime/vendor/page-flip.browser.js`：**没有 `%2`、也没有 `%4`**；
    `runtime/flipbook.js` 里也没有任何页数断言。实测把 104 页的书裁成
    **102 页 / 103 页**，都能正常初始化、正常翻页、零报错（见 `_probe_t.mjs`）。
    所以第一到第五版为「凑 4 的倍数」做的全部动作（前言/后记塞页、solo）
    **都在解一个不存在的问题** —— 而且解法本身还有害，见下。

    ★★ 为什么「solo（某张照片满版独占 + 旁边留白）」必须删掉
    -------------------------------------------------------
    前五版在页数"对不上"时，会让开头几张照片各占一个「满版 + 留白」的跨页。
    在**错误的坐标系**下它看着没问题；换成读者坐标系就露馅：
        页序 … [照片, 留白] … → 读者看到 {留白, 下一张照片}
                               = **一面有图、一面是白纸**
    也就是**恰好复现了佘先生报的那个毛病**（「无法在左右两面各显示一张图片」）。
    ★ 教训：判据的坐标系错了，越"精确"的补偿越会制造新 bug。

    ★ 正确的版式（本函数现在就这么排：没有分支、没有特例、没有补白）
    --------------------------------------------------------------
        页位 0         封面（硬）
        页位 1 … N     照片 1 … N   ← **一页一张、紧挨着，中间绝不插任何页**
        页位 N+1       版权页
        页位 N+2       封底（硬）
        总页数 T = N + 3

    ★★ 为什么照片必须从**页位 1** 开始（而不是 2）
    ---------------------------------------------
    读者跨页是 `(1,2), (3,4), (5,6) …` —— **奇数页在左、偶数页在右**。
    照片若从页位 1 开始连续排，就正好落进这些 (奇, 偶) 对里，
    于是**除尾巴那一跨页外，每个跨页都恰好两张照片**。
    如果前面先放一页扉页（照片从 2 开始），第一跨页必然变成
    `[扉页, 照片1]` = 一面有图一面没图 —— 正是用户报的那个毛病。

    为什么结尾是 [版权页, 封底] 而不是「照片 + 版权页」：
      · 版权页与封底合成**唯一一个纯文字跨页**，而且落在**全书最后**，
        观感上就是"翻完照片看到版权页和封底"，是正常的书末装帧页；
      · 这样照片一跨页都不缺，**全本没有任何「一面有图一面是白纸」的跨页**。
      · 扉页不再单独占位 —— 书名/副标题本来就印在**封面**上
        （`cover-title` / `cover-subtitle` / `cover-foot`），信息不丢。

    ★ N 为偶数（照片正好配完）：读者看到的跨页序列是
        [封面单独] → (1,2)…(N-1,N) 共 N/2 个「双图跨页」 → (N+1,N+2) 版权页+封底
        → 结束。**全本零个「缺图的跨页」。**
      N 为奇数（例如 5）：最后一张照片会和版权页共用一个跨页
        （`(N, N+1)` = [照片, 版权页]），封底再单独出现一次。
        奇数张照片本来就配不完 —— 这是理论下限，而且它落在**全书最后**，
        观感上就是「最后一张照片收在版权页前」。**同样零个空白跨页。**

    ★ 本函数里**不存在**「补白」「solo」「奇偶修正」这些动作。
      若日后发现某个 N 出问题，请**先用 `_probe_t.mjs` 量一遍读者看到的跨页**，
      不要凭 `(2k, 2k+1)` 的直觉去改 —— 那正是前五版翻车的地方。
    """

    pages: list[dict] = [
        # 0 硬封面（照片由 build_book_from 挂 cover_photo 铺满）
        {"kind": "cover", "photo": None},
    ]
    # 正文：一页一张照片，严格按传入顺序，中间不插任何东西
    pages.extend({"kind": "plate", "photo": p} for p in photos)
    # 收尾：版权页 + 封底（读者在最后一跨页看到这两页）
    pages.append({"kind": "colophon", "photo": None})
    pages.append({"kind": "backcover", "photo": None})

    # 首末必须是硬封面，中间一律软页
    for i, page in enumerate(pages):
        page["density"] = "hard" if i in (0, len(pages) - 1) else "soft"
        page["index"] = i
        # ★ folio 是**印在页角上的页码**，必须和状态条的 "12 / 103" 用同一套账：
        #   1 起算、封面算第 1 页。所以是 i + 1，不是 i。
        #   （2026-09-24 做跳页功能时才发现：原来写 i，于是同一跨页上
        #     页角印 "5"、状态条却写 "06"，用户照着页角输入页码就会差一页。
        #     封面/封底本来就不印页码，所以视觉上只是正文数字整体 +1。）
        page["folio"] = i + 1

    return pages


def _runs_by_orientation(photos: Sequence[Photo]) -> list[tuple[str, list[Photo]]]:
    """把照片按**在序列里连续的同构图**切成若干组，保持原有先后顺序。

    只切「竖 ↔ 横」两种（方构图归到竖构图那一类，它们占的页数一样）。
    返回 [(orientation, [photo, ...]), ...]，orientation 只有
    "portrait" / "landscape" 两种取值。
    """

    def bucket(photo: Photo) -> str:
        return "landscape" if photo.is_landscape else "portrait"

    runs: list[tuple[str, list[Photo]]] = []
    for photo in photos:
        key = bucket(photo)
        if runs and runs[-1][0] == key:
            runs[-1][1].append(photo)
        else:
            runs.append((key, [photo]))
    return runs


def describe_plan(pages: Sequence[dict]) -> list[str]:
    """生成人类可读的排版清单，方便人工微调时对照。"""

    lines = []
    for page in pages:
        i = page["index"]
        kind = page["kind"]
        photo = page["photo"]
        if kind == "plate" and photo is not None:
            lines.append(
                f"{i:>3}  图 {photo.order:>2}  {photo.plate:<8} {photo.position or '-':<6} "
                f"{photo.orientation:<9} {photo.name}"
            )
        else:
            lines.append(f"{i:>3}  --  {kind}")
    return lines


# --------------------------------------------------------------------------
# 3. 出图
# --------------------------------------------------------------------------


def render_artwork(photo: Photo, out_dir: Path, index: int) -> None:
    """把一张照片写成网页用的 JPEG：纠方向、限长边、去元数据。

    注意：photo.width/height 已经在 probe() 里按 EXIF 纠正过，
    这里必须沿用同一尺寸，不能再拿 raw.size 判断朝向，否则那张
    EXIF orientation=8 的照片会横竖颠倒。
    """

    with Image.open(photo.path) as raw:
        img = ImageOps.exif_transpose(raw).convert("RGB")

    # 只缩不放，避免把小图糊成马赛克；同时保证长边不超过上限
    if max(img.size) > ARTWORK_LONG_EDGE:
        img.thumbnail((ARTWORK_LONG_EDGE, ARTWORK_LONG_EDGE), Image.Resampling.LANCZOS)

    name = f"{index:02d}-{sanitize_stem(photo.path.stem)}.jpg"
    target = out_dir / name
    img.save(target, "JPEG", quality=JPEG_QUALITY, optimize=True, progressive=True)
    photo.artwork = f"assets/photos/{name}"
    photo.artwork_width, photo.artwork_height = img.size
    # 记录真实长边，核对方向是否与探测一致
    assert (img.width > img.height) == (photo.orientation == "landscape") or photo.orientation == "square", (
        f"方向不一致：{photo.name} 探测为 {photo.orientation}，实际生成 {img.size}"
    )


def sanitize_stem(stem: str) -> str:
    """把文件名变成安全的资源名（去掉连续点、保留中文）。"""

    cleaned = re.sub(r"[\s]+", "-", stem.strip())
    cleaned = re.sub(r"[^\w\u4e00-\u9fff\-]+", "", cleaned)
    cleaned = re.sub(r"\.{2,}", ".", cleaned).strip(".-")
    return cleaned[:60] or "photo"


# --------------------------------------------------------------------------
# 3.5 并行读图 / 并行出图（2026-09-24：只改「谁去干」，不改「干什么」）
# --------------------------------------------------------------------------
#
# 为什么要有这一段：一张 1200 万像素的照片，probe() 约 0.1 秒、出图约 0.18 秒，
# 全是纯 CPU 的活，而且**每张照片之间互不影响**。100 张串行要 28 秒 ——
# 用户会以为工具卡死了。本机 12 个逻辑核，分给 8 个进程就快 5 倍左右。
#
# ★ 三条底线（有逐字节比对的自证，见 findings）：
#   1. **算法一个字没改**：每个进程跑的还是同一份 probe() / render_artwork()，
#      照片之间没有共享状态，所以结果与串行**逐字节相同**。
#   2. **绝不因为并行而崩**：任何一步出问题都自动退回单进程重跑（行为一致，
#      只是慢一点）—— 宁可慢，也不能把栈丢给用户。
#   3. 进程数可关可调：CLI `--jobs N`、环境变量 `FLIPBOOK_JOBS=N`、`--jobs 1` 关掉。

PARALLEL_MIN_ITEMS = 4      # 少于这个数，起进程的开销比省下的还多
PARALLEL_MAX_WORKERS = 8    # 上限：给系统、以及用户正开着的程序留几个核

_JOBS_OVERRIDE: int | None = None   # 由 CLI 的 --jobs 设置；None = 自动


def _parallel_ok() -> bool:
    """只有以「脚本本身」或 `make_flipbook` 这两个名字加载时才能开多进程。

    ★ Windows 用 spawn：子进程要按**模块名**重新 import 一次本模块。
      若本模块是被 importlib 以别的名字加载的（selftest.py 里的
      `flipbook_engine` 就是这么干的），子进程找不到那个名字 —— 退回单进程。
    """

    return __name__ in ("__main__", "make_flipbook")


def _worker_count(jobs: int | None = None) -> int:
    """用几个进程。默认自动：min(8, 核数 - 1)。"""

    if jobs is None:
        jobs = _JOBS_OVERRIDE
    if jobs is not None:
        return max(1, int(jobs))
    env = os.environ.get("FLIPBOOK_JOBS", "").strip()
    if env.isdigit():
        return max(1, int(env))
    cpu = os.cpu_count() or 1
    return max(1, min(PARALLEL_MAX_WORKERS, cpu - 1))


def _probe_task(photo: Photo) -> tuple[Photo | None, str]:
    """子进程里跑一张图的 probe()。单张坏图只记录、不抛（跳过坏图是既有行为）。"""

    try:
        probe(photo)
    except Exception as exc:  # noqa: BLE001 - 与串行版一样：坏图跳过、继续做书
        return None, f"{photo.path.name}（{type(exc).__name__}）"
    return photo, ""


def _render_task(task: tuple[Photo, int, str]) -> Photo:
    photo, index, out_dir = task
    render_artwork(photo, Path(out_dir), index)
    return photo


def probe_many(paths: Sequence[Path]) -> tuple[list[Photo], list[str]]:
    """逐张探测，返回 (能用的照片, 跳过的说明)。

    ★ 序号口径与串行版完全一致：第 i 个文件 → `order = i`（1 起算），
      并且 `map` 保持输入顺序，所以筛选后的列表与串行逐个 append 一模一样。
    """

    photos = [Photo(path=Path(p), order=i) for i, p in enumerate(paths, start=1)]
    workers = _worker_count()
    if workers > 1 and len(photos) >= PARALLEL_MIN_ITEMS and _parallel_ok():
        try:
            from concurrent.futures import ProcessPoolExecutor

            with ProcessPoolExecutor(max_workers=workers) as pool:
                done = list(pool.map(_probe_task, photos, chunksize=2))
            print(f"      （{workers} 个进程并行读图）")
            return [p for p, _ in done if p is not None], [err for _, err in done if err]
        except Exception as exc:  # noqa: BLE001 - 退回串行，绝不让并行把工具搞崩
            print(f"      （并行读图不可用，改用单进程：{type(exc).__name__}: {exc}）")

    kept: list[Photo] = []
    skipped: list[str] = []
    for photo in photos:
        one, err = _probe_task(photo)
        if one is None:
            skipped.append(err)
        else:
            kept.append(one)
    return kept, skipped


def render_many(photos: Sequence[Photo], out_dir: Path) -> list[Photo]:
    """把每张照片写成网页用的 JPEG，返回同一批照片（顺序不变，字段已更新）。

    ★★ 必须把结果**写回原来那些 Photo 对象**，不能只替换列表：
       `build_page_sequence()` 已经把 Photo 的引用存进每个 page 字典里了，
       若这里换成一批新的对象，那些 page 还指着「没出图信息」的旧对象 →
       生成的 HTML 会变成 `<img src="" width="0" height="0">`（实测踩到过，
       靠「串行 vs 并行逐字节比对」抓出来的：JPEG 全部一致、只有 index.html 不同）。
    """

    tasks = [(photo, i, str(out_dir)) for i, photo in enumerate(photos, start=1)]
    workers = _worker_count()
    if workers > 1 and len(tasks) >= PARALLEL_MIN_ITEMS and _parallel_ok():
        try:
            from concurrent.futures import ProcessPoolExecutor

            with ProcessPoolExecutor(max_workers=workers) as pool:
                done = list(pool.map(_render_task, tasks, chunksize=2))
            print(f"      （{workers} 个进程并行出图）")
            for original, fresh in zip(photos, done):
                original.artwork = fresh.artwork
                original.artwork_width = fresh.artwork_width
                original.artwork_height = fresh.artwork_height
            return list(photos)
        except Exception as exc:  # noqa: BLE001 - 退回串行；真错误会在串行里照原样报出来
            print(f"      （并行出图不可用，改用单进程：{type(exc).__name__}: {exc}）")

    for task in tasks:
        _render_task(task)
    return list(photos)


def alt_text(photo: Photo) -> str:
    kind = {"portrait": "竖构图", "landscape": "横构图", "square": "方构图"}[photo.orientation]
    return f"第 {photo.order} 张照片（{kind}）"


# --------------------------------------------------------------------------
# 4. 生成 HTML
# --------------------------------------------------------------------------


def esc(text: str) -> str:
    return (
        str(text)
        .replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
    )


def outer_shadow_html(side: str) -> str:
    """照片外侧那几圈「淡淡的黑色渐变阴影」的载体。

    只画「没有和另一页相接」的边：
      verso（左页）→ 上 / 左 / 下
      recto（右页）→ 上 / 右 / 下
    贴中线的那条边故意不画 —— 那里已经有一条跨页过渡带 + 一条 2px 分界线，
    再叠一层阴影就会显脏。

    上下两个方向相反，一个元素做不出来，所以拆成 outer-y（上/下）和
    outer-x（左/右）两组。具体颜色和强度全部写在 style/book-style.css 里。
    """
    horiz = "left" if side == "verso" else "right"
    return (
        f'          <span class="outer-y top" aria-hidden="true"></span>\n'
        f'          <span class="outer-y bottom" aria-hidden="true"></span>\n'
        f'          <span class="outer-x {horiz}" aria-hidden="true"></span>\n'
    )


def _full_bleed_html(photo: Photo, side: str, density: str) -> str:
    """一张照片铺满整页（和封面同一套写法）。

    ★★ 用在「独占一个跨页」的横向照片上（第三十六轮）
    --------------------------------------------------
    横向（横构图）照片独自占一个跨页时，它的搭档那一面必然是留白。
    如果还按普通的 `.plate` 画 —— 照片只占页面中间一块、四周留出
    纸的白边 —— 那翻开跨页看到的就是「半页图 + 半页刺眼的白」，
    正是佘先生说的「不能同时两面都显示图片」那种观感。

    改用满版（`object-fit: cover`，与封面同款），照片就自己铺满一整面、
    中间只留一条书缝，视觉上和「这张照片占了整个跨页」一致，
    另一半是留白也就不显眼了。

    样式全部复用已有的 `.art-page.photo` / `.plate` 规则，不新造 CSS。
    """

    return (
        f'        <article class="book-page art-page photo {side}"{density} aria-label="{esc(alt_text(photo))}">\n'
        f'          <figure class="plate">'
        f'<img src="{photo.artwork}" alt="{esc(alt_text(photo))}" '
        f'width="{photo.artwork_width}" height="{photo.artwork_height}" '
        f'loading="eager" decoding="async"></figure>\n'
        + outer_shadow_html(side)
        + f"        </article>"
    )


# --------------------------------------------------------------------------
# 4b. 封面文案的可调样式（Phase 24）
# --------------------------------------------------------------------------
#
# 佘先生：「增加封面预览编辑功能，要可以调文案的位置和大小颜色和字体等」。
#
# 设计要点
# --------
# ★ **默认一个字节都不改**。没有配置时不往 `<article>` 上写 style 属性；
#   `style/book-style.css` 里的写法是 `var(--ct-*, <改之前的字面量>)`，
#   回退值就等于旧字面量 ⇒「没调过封面」的成品与上一版逐字节相同、渲染也相同。
# ★ **白名单制**。只认 元素 × 字段 两个白名单里的东西；不认识的键直接丢，
#   非法值退回默认。界面/JSON 里的脏数据进不了成品，也不会因此报错。
# ★ 单位：`x`/`y` 是百分比（`left` / `top` 或 `bottom`）；
#   `size` 用 `cqw`（页宽的 1%）。`.art-page` 是 `container-type:inline-size`，
#   所以字号随页宽等比缩放 —— 预览页与成品书不同尺寸下比例一致，才能"预览=成品"。

COVER_TEXT_ELEMENTS = ("title", "subtitle", "foot")

# 自定义文字框的键名（Phase 26）：`x1`、`x2`…
#
# 佘先生：「编辑封面UI要可以增添和删减选框，选框也能够缩放」。
#
# ★ 为什么把自定义框也塞进**同一个字典**、而不是另开一个 `extras` 列表：
#   整套机制（白名单清洗、CSS 变量 `--ct-<key>-*`、样式串生成、拖动时就地改变量）
#   的形状都是「键 → 配置」。沿用同一个形状，自定义框就白拿这一整套逻辑，
#   不必再造第二条平行的路 —— 而两条平行的路迟早会跑偏。
_COVER_EXTRA_RE = re.compile(r"^x[1-9]\d?$")


def _extra_key_num(key: str) -> int:
    """自定义框的键名 → 序号。

    ★ 排序**必须按数字**，不能按字符串：字符串序里 `x10` 排在 `x2` 前面，
      于是一旦框多了，"最多留 8 个"截断会留下 x1、x10、x11… 这种组合，
      渲染顺序也会让 x10 挤到 x2 前头。上限是 8，正常到不了两位数，
      但这种"到不了就不管"的假设正是以后冒 bug 的地方。
    """
    return int(key[1:])
# 一本封面上最多放 8 个自定义文字框：够用，也不至于糊成一片
COVER_EXTRA_MAX = 8
# 单个自定义文字框的字数上限（挡住"整篇文案贴上去把封面撑爆"）
COVER_TEXT_MAX_LEN = 80

# 字体白名单：键 → CSS font-family 值。
# ★ 一律用**单引号**包字体名：这段值最后会进 `style="..."`（双引号属性），
#   里面再出现双引号会被 esc() 转义成 &quot; 而根本解析不出来。
COVER_FONT_FAMILIES = {
    "serif": "var(--book-serif)",
    "sans": "var(--book-sans)",
    "hei": "'Microsoft YaHei','PingFang SC','Noto Sans CJK SC',var(--book-sans)",
    "song": "'SimSun','Songti SC',var(--book-serif)",
    "kai": "'KaiTi','Kaiti SC',var(--book-serif)",
}

COVER_ALIGNS = ("left", "center", "right")


# --------------------------------------------------------------------------
# 用户自带字体（Phase 30）
#
# 佘先生：「在编辑封面组块那里新增一个引入外部字体的功能」。
#
# ★ 字体**跟着书走**，不是跟着电脑走：内置那 5 项里有 3 项（黑体 / 宋体 / 楷体）
#   是靠系统自带的，换台电脑就变样；用户导入的字体**拷进成品**
#   （`style/fonts/`），所以哪台机器打开都是同一个样子。
# ★ 一本书没用外部字体时，**一个字节都不多写**：不出 `user-fonts.css`、
#   head 不插引用 ⇒ 老成品重出依然逐字节一致。
# ★ 字体是"锦上添花"：登记文件坏了、字体丢了、拷不进去，一律退回默认字体，
#   **绝不让出书失败**（`load_user_fonts()` 不出异常是硬要求）。
# --------------------------------------------------------------------------

USER_FONTS_DIR = _TOOL / "user-fonts"
USER_FONT_FILES_DIR = USER_FONTS_DIR / "fonts"
USER_FONT_REGISTRY = USER_FONTS_DIR / "registry.json"
# 单个字体文件的上限：中文字体整包常见 3~20 MB，40 MB 足够宽松，
# 同时挡住"误选了一个视频文件"这种把书撑爆的情况。
USER_FONT_MAX_BYTES = 40 * 1024 * 1024

# 文件头 4 个字节 → (CSS format(), 扩展名)。够用且零依赖：
# 不需要装任何字体库就能判断"这是不是字体、是哪种字体"。
_FONT_MAGIC = {
    b"\x00\x01\x00\x00": ("truetype", ".ttf"),
    b"true": ("truetype", ".ttf"),
    b"OTTO": ("opentype", ".otf"),
    b"wOFF": ("woff", ".woff"),
    b"wOF2": ("woff2", ".woff2"),
}
_FONT_EXT_OK = {".ttf", ".otf", ".woff", ".woff2"}
_FONT_FMT_OK = {"truetype", "opentype", "woff", "woff2"}
# key 就是配置里的键，会进 JSON 与 CSS 类名之外的任何地方 —— 只放行"安全字符集"
_USER_FONT_KEY_RE = re.compile(r"^[\w一-龥-]{1,32}$")
_user_font_cache: dict | None = None


def font_format_of(data: bytes) -> tuple[str, str] | None:
    """看文件头判断是不是字体，返回 `(CSS format(), 扩展名)`；不是字体返回 `None`。"""
    return _FONT_MAGIC.get(bytes(data[:4]))


def load_user_fonts(*, refresh: bool = False) -> list[dict]:
    """读字体库登记表，返回干净可信的条目列表。

    ★ **永不抛异常**：文件不存在 / 内容坏了 / 条目缺字段，一律当"没有字体"。
      注册表按 `(mtime, size)` 缓存，导入新字体后同进程内立刻生效。
    """
    global _user_font_cache
    try:
        stat = USER_FONT_REGISTRY.stat()
        stamp = (stat.st_mtime_ns, stat.st_size)
    except OSError:
        if refresh:
            _user_font_cache = None
        return []
    if _user_font_cache and not refresh and _user_font_cache.get("stamp") == stamp:
        return [dict(f) for f in _user_font_cache["fonts"]]

    fonts: list[dict] = []
    try:
        raw = json.loads(USER_FONT_REGISTRY.read_text(encoding="utf-8"))
        items = raw.get("fonts") if isinstance(raw, dict) else None
    except Exception:
        items = None
    for item in items if isinstance(items, list) else []:
        if not isinstance(item, dict):
            continue
        key = str(item.get("key") or "")
        label = str(item.get("label") or key)
        file_name = str(item.get("file") or "")
        fmt = str(item.get("fmt") or "")
        # label 会原样进 CSS（`font-family:'…'`）与 HTML 属性 ⇒ 掐掉能作乱的字符。
        # ★ 引号 / 分号 / 尖括号必须去掉：分号能把一条 CSS 声明截断成两条。
        label = re.sub(r"['\";<>{}\\()]", "", label).strip()[:40] or key[:40]
        if not label:
            continue
        if not _USER_FONT_KEY_RE.match(key):
            continue
        # 文件名不许带路径分隔符（防目录穿越），扩展名必须在白名单里
        if not file_name or "/" in file_name or "\\" in file_name:
            continue
        if Path(file_name).suffix.lower() not in _FONT_EXT_OK:
            continue
        if fmt not in _FONT_FMT_OK:
            continue
        target = USER_FONT_FILES_DIR / file_name
        if not target.is_file():
            continue  # 登记了但文件没了：当它不存在，别让出书半路炸掉
        try:
            size = int(item.get("size") or target.stat().st_size)
        except OSError:
            size = 0
        fonts.append(
            {
                "key": key,
                "label": label,
                "file": file_name,
                "fmt": fmt,
                "size": size,
                "license": str(item.get("license") or ""),
                "source": str(item.get("source") or ""),
            }
        )
    _user_font_cache = {"stamp": stamp, "fonts": [dict(f) for f in fonts]}
    return [dict(f) for f in fonts]


def user_font_families() -> dict[str, str]:
    """用户字体 key → CSS `font-family` 值。

    ★ 字体名**用单引号包住**（值要进 `style="…"` 双引号属性）。
    ★ 末尾接内置衬线做回退：字体万一没加载上，至少还是衬线，不会掉成默认黑体。
    """
    out: dict[str, str] = {}
    for font in load_user_fonts():
        out[font["key"]] = f"'{font['label']}',{COVER_FONT_FAMILIES['serif']}"
    return out


def available_font_families() -> dict[str, str]:
    """封面字体白名单 = 内置 5 项 + 用户导入的。改名/加项都只认这一份来源。"""
    fams = dict(COVER_FONT_FAMILIES)
    fams.update(user_font_families())
    return fams


def cover_user_font_keys(cover_text: Any) -> list[str]:
    """这本书封面上真正用到的**用户**字体（内置那 5 项不算：它们本来就在书里）。"""
    cover = normalize_cover_text(cover_text)
    users = user_font_families()
    keys: list[str] = []
    for conf in cover.values():
        key = conf.get("font") if isinstance(conf, dict) else None
        if key in users and key not in keys:
            keys.append(key)
    return keys


def user_font_face_css(keys: Sequence[str], url_prefix: str = "fonts/") -> str:
    """`@font-face` 段。`url_prefix` 是**相对于这份 css 自己**的位置。

    成品里这份 css 落在 `style/user-fonts.css`，所以默认 `fonts/` 正对
    `style/fonts/`；预览页传的是 http 绝对路径。
    """
    table = {f["key"]: f for f in load_user_fonts()}
    parts: list[str] = []
    for key in keys:
        font = table.get(key)
        if not font:
            continue
        parts.append(
            f"@font-face{{font-family:'{font['label']}';"
            f'src:url("{url_prefix}{font["file"]}") format("{font["fmt"]}");'
            f"font-weight:400;font-style:normal;font-display:swap}}"
        )
    return "\n".join(parts)


def install_user_fonts(output_dir: Path, keys: Sequence[str]) -> bool:
    """把这本书用到的用户字体拷进成品，并写出 `style/user-fonts.css`。

    返回"有没有真的装进去" —— 决定 `index.html` 要不要多引一行。
    ★ 拷不动也**不让出书失败**：打一句招呼，书照出（只是封面退回默认字体）。
    """
    if not keys:
        return False
    css = user_font_face_css(keys)
    if not css:
        return False
    table = {f["key"]: f for f in load_user_fonts()}
    style_dir = output_dir / "style"
    font_dir = style_dir / "fonts"
    try:
        font_dir.mkdir(parents=True, exist_ok=True)
        (style_dir / "user-fonts.css").write_text(css + "\n", encoding="utf-8")
        for key in keys:
            font = table.get(key)
            if font:
                shutil.copy2(USER_FONT_FILES_DIR / font["file"], font_dir / font["file"])
    except OSError as exc:
        print(f"      ⚠ 外部字体没能拷进成品（{exc}），封面将退回默认字体")
        return False
    return True

# 颜色只放行这几种写法：挡住 url(...) / expression(...) / 分号注入。
_COVER_COLOR_RE = re.compile(
    r"^(#[0-9a-fA-F]{3,8}"
    r"|rgba?\(\s*[0-9.,%\s]+\)"
    r"|hsla?\(\s*[0-9.,%\s]+\)"
    r"|[a-zA-Z]{3,20})$"
)

# 数值字段 → (最小, 最大)。越界夹回边界（而不是丢弃），用户拖到头就是边界值。
# `w` 是文字框宽度（Phase 26）：5% 是"比一个字还窄就没法排了"的下限。
_COVER_NUM_RANGES = {
    "x": (0.0, 100.0),
    "y": (0.0, 100.0),
    "size": (0.5, 40.0),
    "w": (5.0, 100.0),
}


def normalize_cover_text(raw: Any) -> dict[str, dict[str, Any]]:
    """把界面 / JSON 交上来的封面文案配置洗成可信的一份。

    返回形如 `{"title": {"x": 20.0, "color": "#ffd166"}, "x1": {"text": "…"}}`。
    任何不认识的东西一律丢掉（等于退回 CSS 默认），并且**绝不抛异常** ——
    界面上多勾一个框、多发一个字段，都不该让出书失败。

    三个内置键（title / subtitle / foot）之外，还认 `x1`…`x99` 这种**自定义文字框**
    （Phase 26，最多 `COVER_EXTRA_MAX` 个）。自定义框比内置的多一个 `text` 字段，
    而内置的可以带 `hide`（= 把这一项从封面上撤掉）。
    """

    if not isinstance(raw, dict):
        return {}
    extras = sorted(
        (k for k in raw if isinstance(k, str) and _COVER_EXTRA_RE.match(k)),
        key=_extra_key_num,
    )[:COVER_EXTRA_MAX]
    clean: dict[str, dict[str, Any]] = {}
    for element in list(COVER_TEXT_ELEMENTS) + extras:
        conf = raw.get(element)
        if not isinstance(conf, dict):
            continue
        is_extra = element in extras
        item: dict[str, Any] = {}
        for key, value in conf.items():
            if key in _COVER_NUM_RANGES:
                lo, hi = _COVER_NUM_RANGES[key]
                try:
                    num = float(value)
                except (TypeError, ValueError):
                    continue
                if not math.isfinite(num):  # NaN / inf 夹不出边界值，直接丢
                    continue
                item[key] = round(min(hi, max(lo, num)), 3)
            elif key == "color":
                text = str(value).strip()
                if _COVER_COLOR_RE.match(text):
                    item[key] = text
            elif key == "font":
                # 白名单 = 内置 5 项 + 用户导入的（Phase 30）。
                # ★ 仍然**只认白名单**：字体值会原样写进 CSS，放任意字符串就是注入口子。
                #   用户字体必须先登记进字体库才可能出现在 `available_font_families()` 里。
                if value in available_font_families():
                    item[key] = value
            elif key == "align":
                if value in COVER_ALIGNS:
                    item[key] = value
            elif key == "italic":
                item[key] = bool(value)
            elif key == "hide" and not is_extra:
                # 只有内置元素能"藏起来"：自定义框要撤掉就直接把它的键删了，
                # 留着一条 `{"x3": {"hide": true}}` 只会让配置越攒越脏。
                item[key] = bool(value)
            elif key == "text" and is_extra:
                # ★ 空串**也要存**：用户把某个框的文字清空，是想"留一个空框继续摆"，
                #   不是想删掉它。这里如果丢掉空串，item 可能整个变空、框就凭空消失了。
                item[key] = str(value).replace("\n", " ").strip()[:COVER_TEXT_MAX_LEN]
        if item:
            clean[element] = item
    return clean


def cover_text_style(cover_text: dict | None) -> str:
    """封面文案配置 → 一串 CSS 自定义属性；没配置就返回 `""`。

    调用方拿到空串时**不要**写 `style=""` —— 这正是"默认成品逐字节不变"的开关。

    ★ 自定义文字框走的还是同一套 `--ct-<key>-*`，所以它们**白拿**了拖动、
      缩放、换色等全部逻辑；前端不必知道哪个键是内置的、哪个是后加的。
    """

    cover = normalize_cover_text(cover_text)
    if not cover:
        return ""
    parts: list[str] = []
    for element, conf in cover.items():
        prefix = f"--ct-{element}"
        for key, value in conf.items():
            if key == "x":
                parts.append(f"{prefix}-x:{value:g}%")
            elif key == "y":
                parts.append(f"{prefix}-y:{value:g}%")
            elif key == "size":
                parts.append(f"{prefix}-size:{value:g}cqw")
            elif key == "w":
                # 文字框宽度（Phase 26）。CSS 侧写 `width:var(--ct-<key>-w,auto)`：
                # 没配过时 `auto` + left/right 决定宽度（老行为），配过就是定宽。
                parts.append(f"{prefix}-w:{value:g}%")
            elif key == "color":
                parts.append(f"{prefix}-color:{value}")
            elif key == "font":
                family = available_font_families().get(value)
                # 取不到（字体从库里删了、换电脑没带过来）就**这一项不写**，
                # CSS 侧会退回 `var(--book-serif)`。绝不 KeyError。
                if family:
                    parts.append(f"{prefix}-family:{family}")
            elif key == "align":
                parts.append(f"{prefix}-align:{value}")
                # ★ 居中 / 居右不是"在 左边距→右边距 那条带子里居中"，
                #   而是把 x 当**锚点**：
                #     居中 → 文字盒以 x 为中心（translateX(-50%)）
                #     居右 → 文字盒以 x 为右端（translateX(-100%)）
                #   同时把右边距收回 `auto`。
                #   ⚠ 第一版是"右边距镜像成 x"（left:60%;right:60%），
                #     只要 x > 50 宽度就负成 0 —— 标题整条消失，
                #     而 text-align 照样算"居中"，自测全绿。必须用锚点式。
                if value in ("center", "right"):
                    parts.append(f"{prefix}-r:auto")
                    shift = "-50%" if value == "center" else "-100%"
                    parts.append(f"{prefix}-shift:translateX({shift})")
            elif key == "italic":
                parts.append(f"{prefix}-style:{'italic' if value else 'normal'}")
            elif key == "hide":
                # `text` 不进样式串（它是内容，不是样式），所以这里只认 hide。
                parts.append(f"{prefix}-display:none")
    return ";".join(parts)


def cover_vars_css(cover_text: dict | None) -> str:
    """封面文案变量 → 一条 CSS 规则（放进 `<head>` 的 `<style>` 里）。

    ★★ 为什么还要在 head 里再写一遍（Phase 30 修掉的一个真 bug）：
    这些变量本来只写在封面那张页的 `style="…"` 上，可**成品里翻页库初始化时会把
    每一页的 style 整体重写**（写定位与尺寸），服务端写在 HTML 里的自定义属性
    会被一并冲掉 ⇒ 封面调过的字体 / 位置 / 字号 / 颜色在**成品里全部失效**，
    而预览页没有翻页库、看着却是好的 —— 这种"预览对、成品不对"的坑，静态对账
    和历史自测都抓不到（配置明明写进了 HTML），只有到浏览器里量才算数。
    写进 `<style>` 就绕开了它：库不碰 `<style>`。

    ★ 值仍然只由 `cover_text_style()` 生成一处（两个落点、同一份来源），
      且没配置时返回空串 ⇒ 默认态的产物与上一版逐字节相同。
    """
    style = cover_text_style(cover_text)
    if not style:
        return ""
    return f'.art-page[aria-label="封面"]{{{style}}}'


def cover_extra_html(key: str, text: str) -> str:
    """一个自定义文字框（Phase 26）。

    ★ 元素自己那段 `style` 只**引用**变量，值全部住在封面 article 的
      `--ct-<key>-*` 上（由 `cover_text_style()` 生成）。于是"样式只有服务端
      一份来源"这条规矩对自定义框同样成立 —— 前端拖动/缩放时也只是改 article
      上的变量，不必碰元素本身，也就不可能长出第二套映射。
    ★ 默认墨色走一个**页面级**变量 `--cover-extra-ink`（照片封面浅色、布面封面
      深色）：自定义框的键名是动态的，CSS 里没法为每个键各写一条默认色。
    ★ 默认值接的是**副标题**那一档（13.5% / 50% / 2.1cqw），这样新加的框一上来
      就落在封面下半部的常见位置，不会跟书名撞在一起。
    """

    refs = ";".join(
        [
            f"left:var(--ct-{key}-x,13.5%)",
            f"right:var(--ct-{key}-r,auto)",
            f"top:var(--ct-{key}-y,50%)",
            f"width:var(--ct-{key}-w,auto)",
            f"font-size:var(--ct-{key}-size,2.1cqw)",
            f"font-family:var(--ct-{key}-family,var(--book-serif))",
            f"font-style:var(--ct-{key}-style,normal)",
            f"text-align:var(--ct-{key}-align,start)",
            f"color:var(--ct-{key}-color,var(--cover-extra-ink))",
            f"text-shadow:var(--cover-extra-shadow)",
            f"transform:var(--ct-{key}-shift,none)",
        ]
    )
    return (
        f'          <p class="cover-extra" data-ct="{key}" style="{refs}">'
        f"{esc(text)}</p>\n"
    )


def cover_text_html(title: str, subtitle: str, foot: str,
                    cover_text: dict | None = None) -> str:
    """封面上的全部文字：三个内置元素（可被 `hide` 撤掉）+ 用户自加的文字框。

    ★ 顺序就是**叠加顺序**：内置在前、自定义在后 —— 后加的盖在先加的上面，
      与"后加的东西更想要它露出来"的直觉一致。
    ★ 一个都没配（`cover_text` 为空）时，输出与 Phase 24 之前**一字不差**：
      就是原来那三行，不多一个属性、不多一个元素。
    """

    cover = normalize_cover_text(cover_text)
    out: list[str] = []
    if not (cover.get("title") or {}).get("hide"):
        out.append(f'          <h2 class="cover-title">{esc(title)}</h2>\n')
    if not (cover.get("subtitle") or {}).get("hide"):
        out.append(f'          <p class="cover-subtitle">{esc(subtitle)}</p>\n')
    if not (cover.get("foot") or {}).get("hide"):
        out.append(f'          <p class="cover-foot">{esc(foot)}</p>\n')
    for key in sorted(
        (k for k in cover if _COVER_EXTRA_RE.match(k)), key=_extra_key_num
    ):
        out.append(cover_extra_html(key, cover[key].get("text", "")))
    return "".join(out)


def page_html(page: dict, title: str, subtitle: str, photo_count: int,
              cover_text: dict | None = None) -> str:
    kind = page["kind"]
    photo: Photo | None = page["photo"]
    density = f' data-density="{page["density"]}"' if page["density"] == "hard" else ""
    side = "recto" if page["index"] % 2 == 0 else "verso"
    aria = esc(kind if not photo else f"图 {photo.order}")
    # 封面文案的可调样式（Phase 24）。
    # ★ 没有配置时 cover_style 是空串 → **一整个 style 属性都不写**，
    #   这样"没调过封面"的成品 HTML 与上一版逐字节相同。
    cover_style = cover_text_style(cover_text) if kind in ("cover", "frontcover") else ""
    cover_attr = f' style="{esc(cover_style)}"' if cover_style else ""

    if kind == "cover":
        # 封面也满页：照片铺满，文字压在照片上。
        # 没有照片就退回原来的布面封面。
        # ★ 封面上的文字统一由 `cover_text_html()` 出（Phase 26 起它还会带上
        #   用户自加的文字框，并尊重内置元素的 `hide`）。
        #   没配过封面时它输出的就是原来那三行，一字不差。
        first = page.get("cover_photo")
        words = cover_text_html(
            title, subtitle, f"{photo_count} PHOTOGRAPHS", cover_text
        )
        if first is not None:
            return (
                f'        <article class="book-page art-page photo {side}"{density}{cover_attr} aria-label="封面">\n'
                f'          <figure class="plate">'
                f'<img src="{first.artwork}" alt="{esc(alt_text(first))}" '
                f'width="{first.artwork_width}" height="{first.artwork_height}" '
                f'loading="eager" decoding="async" fetchpriority="high"></figure>\n'
                f'          <div class="cover-scrim"></div>\n'
                + outer_shadow_html(side)
                + words
                + f"        </article>"
            )
        return (
            f'        <article class="book-page art-page cloth {side}"{density}{cover_attr} aria-label="封面">\n'
            + words
            + f"        </article>"
        )

    if kind == "frontcover":
        # ---- N ≤ 1 特例专用：硬封面承载那唯一一张照片（见
        #      `build_page_sequence` 的「N ≤ 1 特例」）----
        #   和 "cover" 的区别：封面本身就是照片页（`photo` 直接挂在 page 上），
        #   不依赖 `cover_photo`，也不画布面退路 —— 这条路只在 N ≤ 1 时走。
        #   纸张质感（cloth 类）不要加：那是「没有照片时的布面封面」。
        words = cover_text_html(
            title, subtitle, f"{photo_count} PHOTOGRAPH", cover_text
        )
        if photo is not None:
            return (
                f'        <article class="book-page art-page photo {side}"{density}{cover_attr} aria-label="封面">\n'
                f'          <figure class="plate">'
                f'<img src="{photo.artwork}" alt="{esc(alt_text(photo))}" '
                f'width="{photo.artwork_width}" height="{photo.artwork_height}" '
                f'loading="eager" decoding="async" fetchpriority="high"></figure>\n'
                f'          <div class="cover-scrim"></div>\n'
                + outer_shadow_html(side)
                + words
                + f"        </article>"
            )
        return (
            f'        <article class="book-page art-page cloth {side}"{density}{cover_attr} aria-label="封面">\n'
            + words
            + f"        </article>"
        )

    if kind == "backcover":
        return (
            f'        <article class="book-page art-page cloth {side}"{density} aria-label="封底">\n'
            f'          <span class="back-mark">{esc(title)}</span>\n'
            f"        </article>"
        )

    if kind == "endpaper":
        return (
            f'        <article class="book-page art-page endpaper {side}" aria-label="{aria}"></article>'
        )

    if kind == "title":
        return (
            f'        <article class="book-page art-page paper {side}" aria-label="扉页">\n'
            f'          <div class="title-block"><h2>{esc(title)}</h2><p>{esc(subtitle)}</p></div>\n'
            f'          <p class="folio">{page["folio"]:>2}</p>\n'
            f"        </article>"
        )

    if kind == "colophon":
        return (
            f'        <article class="book-page art-page paper {side}" aria-label="版权页">\n'
            f'          <div class="colophon">\n'
            f"            <p>{esc(title)}</p>\n"
            f"            <p>{esc(subtitle)}</p>\n"
            f'            <p class="small-print">{photo_count} 张照片 · 本地生成</p>\n'
            f"          </div>\n"
            f'          <p class="folio">{page["folio"]:>2}</p>\n'
            f"        </article>"
        )

    if kind == "plate" and photo is not None:
        # 独占一个跨页的横向照片 → 满版铺开（见 _full_bleed_html 的说明）
        if page.get("alone"):
            return _full_bleed_html(photo, side, density)

        cls = f'plate {photo.plate}'
        if photo.position:
            cls += f" {photo.position}"
        return (
            f'        <article class="book-page art-page photo {side}" aria-label="{aria}">\n'
            f'          <figure class="{cls}">'
            f'<img src="{photo.artwork}" alt="{esc(alt_text(photo))}" '
            f'width="{photo.artwork_width}" height="{photo.artwork_height}" loading="eager" decoding="async">'
            f"</figure>\n"
            + outer_shadow_html(side)
            + f'          <p class="folio">{page["folio"]:>2}</p>\n'
            f"        </article>"
        )

    # blank / 分节页：干净的白纸，不印页码
    return (
        f'        <article class="book-page art-page paper {side}" aria-label="留白页">\n'
        f"        </article>"
    )


def build_index_html(plan: BookPlan, pages: Sequence[dict], *, user_fonts: bool = False) -> str:
    title = plan.title
    subtitle = plan.subtitle
    count = len(plan.photos)
    body = "\n".join(
        page_html(p, title, subtitle, count, plan.cover_text) for p in pages
    )
    # ★ 只有这本书**真的用到**外部字体时才多这一行引用（Phase 30）。
    #   没用到时 `font_link` 是空串，head 与改之前一字不差 ⇒ 老成品重出仍然
    #   逐字节一致（这条是硬要求，动过一次就知道了）。
    font_link = (
        '  <link rel="stylesheet" href="style/user-fonts.css">\n' if user_fonts else ""
    )
    # 封面文案变量（Phase 24）也要在 head 里落一份 —— 见 `cover_vars_css()` 的注释：
    # 写在封面页 style 属性上的那份会被翻页库冲掉，成品里得靠这一份。
    cover_css = cover_vars_css(plan.cover_text)
    cover_block = f"  <style>{cover_css}</style>\n" if cover_css else ""

    return f"""<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>{esc(title)}</title>
  <link rel="stylesheet" href="styles.css">
{font_link}{cover_block}</head>
<body>
<main class="room">
  <header class="book-header">
    <span>{esc(subtitle)}</span><h1>{esc(title)}</h1><span id="orientation">Open spread</span>
  </header>
  <section class="stage" aria-label="可翻页的摄影集">
    <div class="book-rig">
      <div id="book" class="book" data-page-width="512" data-page-height="{PAGE_LONG_EDGE}">
{body}
      </div>
    </div>
  </section>
  <footer class="controls" aria-label="翻页控制">
    <button id="previous" type="button" aria-label="上一页">←</button>
    <!-- ★ Phase 28：中间那列从**五行**压成**两行**（佘先生：「查看画册时的那个页数和
         自动翻页UI组块太大了，上下宽度压缩一半，要让图片占据画面的绝大部分，比如那个
         自动翻页和其速度组块完全可以放在同一行，跳转页面的组块做成一行」）。
         第 1 行 `.nav-row`  = 状态（老入口：点页码变输入框）+ 常驻「跳到第 N 页」；
         第 2 行 `.auto-row` = 自动翻页开关 + 它的速度下拉；
         Phase 28 时说明小字挪进第 2 行末尾，窄窗口由 CSS 藏掉。
         改前脚部实测 121.2px → 改后实测 **46.6px**（6 档窗口量下来都是这个数）。
         ★ Phase 31：佘先生说脚部那行说明小字不美观 ⇒ **整行删掉**（不是藏起来）。
         ⚠ 注释里也别把那行字的原文写出来：核心层「成功Y」有一条判据扫整个
         HTML 模板、不许那句话再出现，注释命中同样算（findings 71 同族的坑）。
         ⚠ .jump-row 仍必须排在 #page-auto **之前**：DOM 顺序与几何位置都有断言守着。 -->
    <div class="status">
      <div class="status-row nav-row">
        <button id="page-jump" type="button" class="page-jump" aria-label="跳转到指定页"
                title="点击输入页码，回车跳转"><span id="page-status" aria-live="polite">Cover</span></button>
        <input id="page-input" class="page-input" type="text" inputmode="numeric" autocomplete="off"
               spellcheck="false" aria-label="输入页码后按回车跳转" hidden>
        <!-- 跳到指定页（Phase 26）：佘先生「在查看画册的界面的选择查看的页数的功能
             恢复，就设计在自动翻页的组块的上方，注意布局协调」。
             原来跳页只有一个"点页码 → 就地变输入框"的隐藏入口（#page-jump），
             功能是在的，但看不出来。这里补一个常驻入口 —— Phase 28 起它与状态
             并排在同一行，不再自己占一行。 -->
        <div class="jump-row">
          <label class="jump-row-k" for="page-select">跳到第</label>
          <input id="page-select" class="page-select" type="text" inputmode="numeric"
                 autocomplete="off" spellcheck="false" aria-label="输入页码，回车跳转">
          <span class="jump-row-u">页</span>
          <button id="page-go" class="page-go" type="button">跳转</button>
        </div>
      </div>
      <div class="status-row auto-row">
        <!-- 自动翻页开关（Phase 20）：默认关（aria-pressed="false"、文案=未播放态），
             点了才开始自动翻。按钮文本 / data-stop-* 是"未播放 / 播放中"两套文案，
             由 flipbook.js 换用，所以这里不要把它们写进别的脚本里。
             title 里的 {{n}} 由 flipbook.js 换成当前秒数 —— 调过速度后提示语不能还停在 5。 -->
        <button id="page-auto" type="button" class="page-auto" aria-pressed="false"
                data-stop-label="停止自动翻页" data-stop-title="点击停止自动翻页"
                title="自动翻页：每 {{n}} 秒翻一页">自动翻页</button>
        <!-- 自动翻页调速（Phase 23 起 2~10 秒/页；Phase 26 补了最快的 **1 秒**档，
             现在共 10 档；默认仍是 5 秒 ⇒ 没动过速度的成品与上一版一字不差）。
             少了它（老成品 HTML）就退回 5 秒，行为与 Phase 20 一致。 -->
        <select id="page-auto-speed" class="page-auto-speed" aria-label="自动翻页速度"
                title="每页停几秒（1~10 秒）">
          <option value="1">1 秒</option>
          <option value="2">2 秒</option>
          <option value="3">3 秒</option>
          <option value="4">4 秒</option>
          <option value="5" selected>5 秒</option>
          <option value="6">6 秒</option>
          <option value="7">7 秒</option>
          <option value="8">8 秒</option>
          <option value="9">9 秒</option>
          <option value="10">10 秒</option>
        </select>
      </div>
    </div>
    <!-- Phase 28：翻到最后一跨页之后再点它 = 合上封底；合上之后再点它 = **整本翻回封面**，
         所以它不再在末页变灰（原来末页它是 disabled，点了没反应）。 -->
    <button id="next" type="button" aria-label="下一页">→</button>
  </footer>
</main>
<script src="vendor/page-flip.browser.js"></script>
<script src="flipbook.js"></script>
</body>
</html>
"""


# --------------------------------------------------------------------------
# 5. 组装
# --------------------------------------------------------------------------


def remove_tree_contents(folder: Path) -> None:
    """清空一个目录里的内容（保留目录本身）。

    一般不需要调用：重新生成时直接覆盖同名文件即可，效果完全一样，
    还省掉一大堆删除动作。只有确实要清掉旧产物时才用。

    刻意不用 shutil.rmtree：宿主环境的批量删除保护按"单次会话累计删除数"
    计数（阈值 50），一次性删几十个文件会直接把进程打死。
    这里逐条删，且在调用方保证数量不大时才用。
    """

    try:
        entries = sorted(folder.rglob("*"), key=lambda p: len(p.parts), reverse=True)
    except OSError:
        return

    for entry in entries:
        try:
            if entry.is_dir() and not entry.is_symlink():
                entry.rmdir()
            else:
                entry.unlink()
        except OSError:
            continue


def default_output_dir() -> Path:
    """默认把画册出到哪 —— 这是「画册集」在哪，不是「这本书」在哪。

    ★ 这里是「画册放哪儿」的**唯一事实来源**。
      佘先生的约定：工具做出来的画册统一放进工作区的 `画册集/` 文件夹，
      以后翻回去还能一本一本看。想换地方只改这一个函数。

    只往上找一层：`<工具根>/../画册集`。找不到（工具被单独拷到别处）
    就退回工具目录内的 `画册/`，绝不往更上层乱找 —— 免得写进别人的目录。

    ★ 注意语义：返回的是**画册集**（一堆书的父目录），不是某一本书的目录。
      一本书的目录由 `book_dir_in()` 从它算出来。混淆这两者会把书平铺在
      画册集根上，和别的书混在一起 —— 这个坑真踩过。
    """

    beside = _TOOL.parent / "画册集"
    if beside.parent.is_dir():
        return beside
    return _TOOL / "画册"


# 文件名里不能出现的字符（Windows 最严）：< > : " / \ | ? * 以及控制字符
_UNSAFE_IN_NAME = '<>:"/\\|?*'


def book_dir_name(title: str) -> str:
    """书名 → 文件夹名。

    ★ 这里是「书名怎么就变成目录名」的**唯一事实来源**。

    规矩：中文直接用（佘先生的书名是中文，要能一眼认出来）；
    只剔掉文件名里不能要的字符，再把首尾的空格与点去掉（Windows 不许
    文件夹名以点结尾）。清洗后什么都不剩时退回 `未命名画册`，
    **绝不返回空串** —— 空串会让 `album / ""` 变回画册集本身，
    于是「这本书的目录」就成了画册集根目录（这个坑也真踩过）。
    """

    cleaned = "".join(
        ch for ch in str(title) if ch not in _UNSAFE_IN_NAME and ord(ch) >= 32
    )
    cleaned = cleaned.strip().strip(".").strip()
    # 全是空白/点，或本来就空 → 给个兜底名字
    if not cleaned:
        return "未命名画册"
    # 太长会把整个路径顶到 Windows 的 260 字符上限上，截断留尾
    if len(cleaned) > 80:
        cleaned = cleaned[:80].rstrip().rstrip(".")
        if not cleaned:
            return "未命名画册"
    # Windows 保留名（CON/PRN/AUX/NUL/COM1-9/LPT1-9）不能当文件夹名
    if cleaned.upper().split(".")[0] in {
        "CON", "PRN", "AUX", "NUL",
        *(f"COM{i}" for i in range(1, 10)),
        *(f"LPT{i}" for i in range(1, 10)),
    }:
        return cleaned + "_"
    return cleaned


def book_dir_in(album_dir: Path, title: str) -> Path:
    """画册集 + 书名 → 这本书该落的目录。

    约定是「一本书一个文件夹，文件夹名 = 书名」，所以出书时把
    `--output`（画册集）和目标书名一起算，得出最终落点。
    """

    return Path(album_dir).expanduser().resolve() / book_dir_name(title)


def build_book(
    source_dir: Path,
    output_dir: Path,
    *,
    title: str = DEFAULT_TITLE,
    subtitle: str = DEFAULT_SUBTITLE,
    runtime_dir: Path | None = None,
    cover_text: dict | None = None,
) -> BookPlan:
    """主流程：扫描 → 自动排版 → 出图 → 生成 HTML。"""

    folder = Path(source_dir).expanduser().resolve()

    def prepare() -> list[Photo]:
        found = scan(folder)
        assign_plates(found)
        return found

    return build_book_from(
        prepare,
        output_dir,
        title=title,
        subtitle=subtitle,
        runtime_dir=runtime_dir,
        cover_text=cover_text,
    )


def build_book_ordered(
    ordered_paths: Sequence[Path],
    output_dir: Path,
    *,
    title: str = DEFAULT_TITLE,
    subtitle: str = DEFAULT_SUBTITLE,
    runtime_dir: Path | None = None,
    plate_override: dict[int, tuple[str, str]] | None = None,
    cover_text: dict | None = None,
) -> BookPlan:
    """按界面里排好的顺序出书。

    与 build_book 共用同一套出图与生成逻辑，只是照片来源不同 ——
    顺序与版面由用户在界面上定，而不是自动排版。
    """

    ordered_paths = [Path(p) for p in ordered_paths]
    if not ordered_paths:
        raise ValueError("没有照片可以出书")

    def prepare() -> list[Photo]:
        # ★ 与 scan() 同一套并行读图。`order` 仍是「第几个文件」（1 起算），
        #   所以 plate_override 的键语义没变；且 map 保持顺序，筛选结果同串行。
        photos, failed = probe_many(ordered_paths)
        if plate_override:
            for photo in photos:
                # 用户指定的版面优先于自动判断
                plate, position = plate_override.get(photo.order, ("", ""))
                if plate:
                    photo.plate = plate
                    photo.position = position
                else:
                    photo.plate = "large" if photo.is_landscape else "medium"
        if not photos:
            raise ValueError(
                "所有照片都读不了，可能是文件损坏或不是真正的图片。\n\n"
                + "\n".join(failed[:10])
            )
        if failed:
            print(f"[警告] 跳过 {len(failed)} 个读不了的文件：")
            for line in failed[:10]:
                print(f"       - {line}")
        return photos

    return build_book_from(
        prepare,
        output_dir,
        title=title,
        subtitle=subtitle,
        runtime_dir=runtime_dir,
        cover_text=cover_text,
    )


def build_book_from(
    prepare_photos,
    output_dir: Path,
    *,
    title: str,
    subtitle: str,
    runtime_dir: Path | None = None,
    cover_text: dict | None = None,
) -> BookPlan:
    """出书的共同实现：拿到照片后拷贝运行时、出图、写 HTML。

    ★ 语义：`output_dir` 就是**这本书自己的目录**，内容直接铺在里面。
      它由调用方算好（CLI 用 `book_dir_in(画册集, 书名)`），本函数不替
      调用方决定层级 —— 免得「用户已经指到具体文件夹」时又被套一层。
    """

    # 先查工具自身是否完整，再查运行环境。
    # 顺序很重要：工具被拷走时该报"缺运行时"，而不是怪罪 Python 环境。
    output_dir = Path(output_dir).expanduser().resolve()
    runtime_dir = Path(runtime_dir or (_TOOL / "runtime")).resolve()

    if not runtime_dir.is_dir():
        raise FileNotFoundError(
            f"找不到内置运行时目录：\n{runtime_dir}\n\n"
            f"工具文件可能被移动或删除了，请重新解压一份完整的工具。"
        )

    if Image is None:
        raise RuntimeError(
            "缺少 Pillow（图像处理库），无法生成画册。\n\n"
            "请让工具使用带 Pillow 的 Python 运行，或执行：pip install Pillow"
        )

    print("[1/5] 读取照片并分析画面特征")
    photos = prepare_photos()
    print(f"      共 {len(photos)} 张照片")

    print("[2/5] 计算书页结构")
    pages = build_page_sequence(photos)
    print(f"      {len(pages)} 页（{len(pages) // 2} 张纸）")

    print(f"[3/5] 拷贝运行时资源 → {output_dir}")
    # 不删旧产物：同名文件直接覆盖，结果与"先清空再生成"完全一致，
    # 但避免了大量删除动作触发宿主环境的一次性删除保护（会把进程打死）。
    # 照片文件按 序号-文件名 命名，张数变化时旧的残留不影响成品显示。
    output_dir.mkdir(parents=True, exist_ok=True)
    photo_out = output_dir / "assets" / "photos"
    photo_out.mkdir(parents=True, exist_ok=True)

    for item in ("vendor", "style"):
        # dirs_exist_ok=True：目录已存在（重新生成时）也能覆盖写入，
        # 不抛 FileExistsError
        shutil.copytree(runtime_dir / item, output_dir / item, dirs_exist_ok=True)
    for item in ("styles.css", "flipbook.js"):
        shutil.copy2(runtime_dir / item, output_dir / item)
    # 带上授权与契约测试，交付物可自检、可合规
    shutil.copy2(runtime_dir / "html-contract.test.mjs", output_dir / "html-contract.test.mjs")
    shutil.copy2(runtime_dir / "vendor" / "PAGE-FLIP-LICENSE", output_dir / "vendor" / "PAGE-FLIP-LICENSE")

    print(f"[4/5] 处理 {len(photos)} 张照片（纠方向 / 缩图 / 压缩）")
    # ★ 并行出图，并把返回值接回来：`render_artwork` 会把 artwork 路径与尺寸
    #   写回 Photo 上，并行时那些赋值发生在子进程的副本里。
    photos = render_many(photos, photo_out)

    # 封面用第一张照片满版铺开。必须等 render_artwork 跑完 —— 那时
    # photo.artwork 才有值，在此之前挂上去会生成一个空 src。
    if photos:
        pages[0]["cover_photo"] = photos[0]
        # ★ N ≤ 1 特例：那条路的封面（kind="frontcover"）是自己承载照片的，
        #   不吃 cover_photo，所以这里要单独把照片挂到 page["photo"] 上。
        if pages[0]["kind"] == "frontcover":
            pages[0]["photo"] = photos[0]

    print("[5/5] 生成 index.html")
    # 照片来源目录：取第一张照片所在目录，这样从界面出书时也能记录来源
    source_dir = str(photos[0].path.parent) if photos else ""
    # 封面文案配置先洗一遍白名单再落地：写进 HTML 的那份与写进
    # book-plan.json 的那份**必须是同一份**，否则"下次打开工作台继续改"
    # 会看到与成品不一样的数字。
    clean_cover = normalize_cover_text(cover_text)
    plan = BookPlan(
        title=title,
        subtitle=subtitle,
        photos=list(photos),
        generated_at=datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        source_dir=source_dir,
        page_count=len(pages),
        cover_text=clean_cover,
    )
    # 封面用到的外部字体（Phase 30）：拷进成品 + 出一份 `@font-face`。
    # 一本书没用到时这两步**都不发生**，产物与改之前逐字节一致。
    font_keys = cover_user_font_keys(clean_cover)
    used_fonts = install_user_fonts(output_dir, font_keys)
    if font_keys:
        print(f"      封面外部字体：{len(font_keys)} 款 → style/fonts/")
    (output_dir / "index.html").write_text(
        build_index_html(plan, pages, user_fonts=used_fonts), encoding="utf-8"
    )

    # 留一份排版清单 + 机器可读的方案，方便人工微调
    plan_txt = "\n".join(
        [
            f"画册：{title}",
            f"来源：{source_dir}",
            f"生成：{plan.generated_at}",
            f"照片：{len(photos)} 张",
            f"书页：{len(pages)} 页",
            "",
            "页码  内容  尺寸      位置    构图      文件名",
            "-" * 66,
            *describe_plan(pages),
        ]
    )
    (output_dir / "排版清单.txt").write_text(plan_txt, encoding="utf-8")
    (output_dir / "book-plan.json").write_text(
        json.dumps(
            {
                "title": title,
                "subtitle": subtitle,
                "generated_at": plan.generated_at,
                "source_dir": str(source_dir),
                "photo_count": len(photos),
                "page_count": len(pages),
                "cover_text": clean_cover,
                "photos": [
                    {
                        "order": p.order,
                        "file": p.name,
                        "artwork": p.artwork,
                        "plate": p.plate,
                        "position": p.position,
                        "orientation": p.orientation,
                        "size": [p.width, p.height],
                        "exif_orientation": p.exif_orientation,
                        "mean_lum": round(p.mean_lum, 1),
                        "sharpness": round(p.sharpness, 4),
                        "taken_at": p.taken_at,
                    }
                    for p in photos
                ],
                "pages": [
                    {
                        "index": p["index"],
                        "kind": p["kind"],
                        "density": p["density"],
                        "photo": p["photo"].order if p["photo"] else None,
                    }
                    for p in pages
                ],
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )

    print()
    print("=" * 62)
    print("完成！")
    # ★ 「张纸」= 叶子（leaf）：一张纸两个面 = 2 页。所以是 // 2，不是 // 4。
    #   曾经写成 //4（把「一张纸 4 页」当成折页印刷的算法），用户看到的张数少一半。
    print(f"  画册页数：{len(pages)} 页（{len(pages)//2} 张纸）")
    print(f"  输出目录：{output_dir}")
    print(f"  打开这个文件：{output_dir / 'index.html'}")
    print("=" * 62)

    refresh_album_index(output_dir)

    for line in describe_plan(pages):
        print("  " + line)
    return plan


def refresh_album_index(output_dir: Path) -> None:
    """让「画册集」的目录跟上刚做好的这本书。

    目录是画册集的一个便利贴，**更新失败绝不能影响出书结果** ——
    书已经生成好了，这里只是顺手维护一份索引，所以异常一律吞掉。

    ★ 只在**这本书确实落在画册集里**时才更新。
      判据是「刚出的书目录的父目录就是画册集」：
      - 正常出书 → 画册集/<书名>/ → 父目录是画册集 → 更新 ✓
      - `--flat` 出到别处 / 出到别的画册集 → 不碰默认画册集的索引 ✓
      这比早先写的 `album_dir == output_dir or album_dir.is_dir()` 靠谱得多：
      那个写法只要画册集存在就会重写一遍索引，用户把书出到哪儿都逃不掉。
    """

    try:
        import importlib.util

        album_dir = default_output_dir().resolve()
        book_dir = Path(output_dir).resolve()
        if book_dir.parent != album_dir:
            # 书没进这个画册集（出到别处了），不动它的索引
            return

        spec = importlib.util.spec_from_file_location("_mkindex", Path(__file__).parent / "make_index.py")
        module = importlib.util.module_from_spec(spec)
        sys.modules["_mkindex"] = module          # dataclass 解析需要模块已注册
        try:
            spec.loader.exec_module(module)
        finally:
            sys.modules.pop("_mkindex", None)

        books = module.collect(album_dir)
        if not books:
            return
        module.write_index(album_dir, module.render(album_dir, books))
        print(f"  画册集目录已更新：{album_dir / module.INDEX_NAME}")
    except Exception:
        pass


# --------------------------------------------------------------------------
# CLI
# --------------------------------------------------------------------------


def load_ui_common():
    """尽力加载界面助手；加载不到就退回一个最小实现。

    工具文件被单独拷走时 ui_common.py 可能不在，这不该让报错本身也崩掉。
    """

    try:
        import importlib.util

        spec = importlib.util.spec_from_file_location(
            "ui_common", str(Path(__file__).parent / "ui_common.py")
        )
        if spec and spec.loader:
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
            return module
    except Exception:
        pass
    return None


UI = load_ui_common()

# 关掉「自动开浏览器」的环境变量（任何非空且非 "0" 的值都算关）。
# 为什么除了 --no-open 还要一个环境变量：给「脚本生的小进程」用 ——
# 那些地方不方便改命令行（例如 .bat 转手、或验收里连开好几层子进程），
# 但环境变量会一路继承下去。
NO_OPEN_ENV = "FLIPBOOK_NO_OPEN"


def should_open_browser(explicit_no_open: bool = False) -> bool:
    """生成完之后，要不要自动把成品丢给浏览器打开。

    ★ 只在「人自己敲的那条命令行」里开；脚本 / 验收 / 批处理一律不开。

    起因（佘先生 2026-09-24）：「自动清理调用的浏览器页面，你跑一次代码，
    开了十多个页面」。查下来是我自己写的诊断脚本连着出十几本书，
    每出一本就在他的默认浏览器（本机 = Tabbit）里弹一个标签页。
    他原来的手感（人在控制台里敲一条命令 → 生成完自动看）要保住，
    所以判据不是「默认关」，而是「只有在真的终端里才开」：

      1. `--no-open` 或 `FLIPBOOK_NO_OPEN=1`  → 不开（显式要求，最高优先）
      2. stdout 不是终端（被重定向 / 管道 / 被父进程捕获）
         → 不开。**这正是「脚本在跑」最可靠的信号**：
         我的 Bash 调用、验收脚本、CI 全是管道；他双击 .bat 或在控制台里敲才是终端。
      3. 其余 → 开（原功能不变）。
    """

    if explicit_no_open:
        return False
    if os.environ.get(NO_OPEN_ENV, "").strip() not in ("", "0"):
        return False
    if UI is None:
        return False
    try:
        # pythonw 下 sys.stdout 是 None；被重定向时 isatty() 为 False。
        if sys.stdout is None or not sys.stdout.isatty():
            return False
    except Exception:
        return False
    return True


def parse_cover_text_arg(raw: str | None) -> dict[str, dict[str, Any]]:
    """解析 `--cover-text`：既接受一段 JSON，也接受一个 .json 文件的路径。

    ★ 传了不合法的东西**只警告、不报错**（封面退回默认样式照常出书）——
      出书是用户的主目的，不该被一个可选参数绊倒。这与"不许崩溃"是同一条规矩。
    """

    if not raw:
        return {}
    text = raw.strip()
    # 先当路径试一次（工作台会把配置写成 book-plan.json，用户可能直接指过来）。
    if len(text) < 500:
        try:
            candidate = Path(text).expanduser()
            if candidate.is_file():
                text = candidate.read_text(encoding="utf-8")
        except (OSError, ValueError):
            pass  # 不像路径就当它是 JSON，下面继续试
    try:
        return normalize_cover_text(json.loads(text))
    except (ValueError, TypeError):
        print("[警告] --cover-text 既不是合法 JSON、也不是可读的 .json 文件，已忽略（封面用默认样式）。")
        return {}


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="把照片文件夹变成一本可翻页的画册",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("source", nargs="?", help="照片文件夹（省略则弹选择框）")
    parser.add_argument(
        "-o", "--output",
        help="画册集目录（默认：工作区的 画册集/）；书会放进它下面的「书名」文件夹",
    )
    parser.add_argument("-t", "--title", default=DEFAULT_TITLE, help="画册标题")
    parser.add_argument("-s", "--subtitle", default=DEFAULT_SUBTITLE, help="副标题")
    parser.add_argument(
        "--no-open", action="store_true",
        help="生成后不自动打开浏览器（脚本里调用时本该带上；环境变量 FLIPBOOK_NO_OPEN=1 等效）",
    )
    parser.add_argument(
        "--flat", action="store_true",
        help="不建「书名」子文件夹，直接把书铺在 --output 里",
    )
    parser.add_argument(
        "--jobs", type=int, default=None, metavar="N",
        help="读图/出图用几个进程（默认自动，最多 8；1 = 关掉并行）",
    )
    parser.add_argument(
        "--cover-text", default=None, metavar="JSON",
        help="封面文案样式：一段 JSON，或一个 .json 文件路径。"
             "键为 title / subtitle / foot，各自可设 x y size color font align italic；"
             "不认识的键会被忽略。不传 = 全部用内置默认样式",
    )
    args = parser.parse_args(argv)

    # 并行度：CLI 优先。不改任何算法，只决定「几个进程去干同样的活」。
    global _JOBS_OVERRIDE
    if args.jobs is not None:
        _JOBS_OVERRIDE = max(1, args.jobs)

    source = args.source
    if not source:
        if UI is None:
            print("找不到界面模块 ui_common.py，请手工传入照片文件夹路径。")
            return 1
        source = UI.choose_folder("请选择装照片的文件夹")
        if not source:
            print("已取消。")
            return 1

    # --output 指的是"画册集"，不是"这本书的文件夹"：
    # 约定是一本书一个文件夹、文件夹名=书名，所以这里再下探一层。
    # --flat 留给"就要直接铺在指定目录里"的情形。
    album = Path(args.output).expanduser() if args.output else default_output_dir()
    out = album if args.flat else book_dir_in(album, args.title)
    try:
        build_book(
            Path(source),
            out,
            title=args.title,
            subtitle=args.subtitle,
            cover_text=parse_cover_text_arg(args.cover_text),
        )
    except Exception as exc:
        print()
        print("!" * 62)
        print("生成失败：")
        print(f"  {type(exc).__name__}: {exc}")
        print("!" * 62)
        # 已知的、可读的错误不给用户看栈；详细栈只写进日志文件
        if UI is not None:
            try:
                log_path = UI.log_error(exc)
                print(f"  详细日志：{log_path}")
            except Exception:
                pass
        elif not isinstance(exc, (ValueError, FileNotFoundError, RuntimeError, NotADirectoryError)):
            traceback.print_exc()
        return 1

    if should_open_browser(args.no_open):
        try:
            UI.open_book_fullscreen(Path(out) / "index.html")
        except Exception:
            pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
