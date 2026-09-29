#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""给「画册集」写一份索引（`画册集/画册目录.md`）。

佘先生的用法是：**工具做出来的画册都放进工作区的 `画册集/`，以后一本本翻回去看。**
书一多，光看文件夹名就想不起来哪本是哪本 —— 所以这里按每本书自己写下的
`book-plan.json`（唯一事实来源）汇总成一份目录：书名、副标题、几张照片、
来源目录、做好时间、以及**双击哪个文件能看**。

设计上的两条：
1. **只读每本书的 `book-plan.json`**，不猜、不重算。书里写了什么就记什么。
2. **绝不打扰书本身**：只在 `画册集/` 下写这一个 `.md`，不往书目录里塞任何东西
   （书目录被塞了多余文件，拷给别人时会显得脏）。

用法：
    python make_index.py                       # 扫默认的 画册集/
    python make_index.py --dir "D:\\我的画册"
    python make_index.py --print               # 只打印，不落盘
"""
from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime
from pathlib import Path

HERE = Path(__file__).resolve().parent
INDEX_NAME = "画册目录.md"


def default_album_dir() -> Path:
    """「画册集」的默认位置 —— 与出书默认落点是同一个函数，避免两处各写一份。"""
    import importlib.util

    spec = importlib.util.spec_from_file_location("_core_idx", HERE / "make_flipbook.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules["_core_idx"] = module          # dataclass 解析需要模块已注册
    try:
        spec.loader.exec_module(module)
    finally:
        sys.modules.pop("_core_idx", None)
    return Path(module.default_output_dir())


def read_book(book_dir: Path) -> dict | None:
    """读一本书自己的档案。读不到就当它不是一本书，跳过。"""

    plan_file = book_dir / "book-plan.json"
    if not (book_dir / "index.html").is_file() or not plan_file.is_file():
        return None
    try:
        data = json.loads(plan_file.read_text(encoding="utf-8"))
    except Exception:
        return None

    photos = data.get("photos") or []
    dates = [p.get("taken_at") for p in photos if p.get("taken_at")]
    return {
        "dir": book_dir,
        "title": (data.get("title") or "").strip() or book_dir.name,
        "subtitle": (data.get("subtitle") or "").strip(),
        "photo_count": data.get("photo_count") or len(photos),
        "page_count": data.get("page_count") or 0,
        "generated_at": (data.get("generated_at") or "").strip(),
        "source_dir": (data.get("source_dir") or "").strip(),
        "shot_from": min(dates) if dates else "",
        "shot_to": max(dates) if dates else "",
        "cover": next(
            (p.get("artwork") for p in photos if p.get("artwork")), ""
        ),
    }


def collect(album_dir: Path) -> list[dict]:
    """把画册集里所有书汇总起来（新做的排前面）。"""

    if not album_dir.is_dir():
        return []
    books = []
    for child in sorted(album_dir.iterdir()):
        if not child.is_dir() or child.name.startswith("."):
            continue
        book = read_book(child)
        if book:
            books.append(book)
    # 按生成时间倒序；没有时间的排最后（按名字）
    books.sort(key=lambda b: (b["generated_at"] == "", b["generated_at"], b["dir"].name),
               reverse=False)
    books.sort(key=lambda b: b["generated_at"], reverse=True)
    return books


def render(album_dir: Path, books: list[dict]) -> str:
    lines = [
        "# 画册集 · 目录",
        "",
        f"工作区里所有用工具做出来的画册都在这儿，每本都能双击打开、反复翻看。",
        f"（本目录由工具自动生成，最近更新 {datetime.now().strftime('%Y-%m-%d %H:%M')}）",
        "",
    ]

    if not books:
        lines += [
            "> 还是空的。双击工具目录里的 `画册.bat`（或打开工作台点「生成画册」），",
            "> 出来的书会自动放进这里。",
            "",
        ]
        return "\n".join(lines) + "\n"

    lines += [
        f"一共 **{len(books)} 本**。",
        "",
        "| 画册 | 照片 | 页数 | 拍摄日期 | 做好时间 | 打开 |",
        "|---|---|---|---|---|---|",
    ]
    for b in books:
        title = b["title"] + (f"<br><sub>{b['subtitle']}</sub>" if b["subtitle"] else "")
        rel = b["dir"].name
        shot = "—"
        if b["shot_from"]:
            shot = b["shot_from"] if b["shot_from"] == b["shot_to"] else f"{b['shot_from']} ~ {b['shot_to']}"
        lines.append(
            f"| **{title}** | {b['photo_count']} 张 | {b['page_count']} 页 | {shot} "
            f"| {b['generated_at'] or '—'} | `{rel}/index.html` |"
        )

    lines += ["", "## 打开方式", ""]
    lines += [
        "每本画册是一个文件夹，直接用浏览器打开里面那个 `index.html` 就能看。",
        "整本都是离线的：不联网、不装东西，把文件夹整个拷给别人也能看。",
        "",
        "## 每本书里各有什么",
        "",
        "| 文件 | 作用 |",
        "|---|---|",
        "| `index.html` | 画册本体。双击它就能翻页 |",
        "| `assets/photos/` | 压缩后的照片（原图不会被改动） |",
        "| `排版清单.txt` | 人看的排版说明：第几页放了哪张、多大版面 |",
        "| `book-plan.json` | 机器读的方案存档（这份目录就是从它汇总来的） |",
        "| `vendor/` `style/` | 翻页引擎与字体材质（含 MIT / OFL 授权原文） |",
        "",
        "## 来源",
        "",
    ]
    for b in books:
        src = b["source_dir"] or "（没记录）"
        lines.append(f"- **{b['title']}** — 照片来自 `{src}`")
    lines.append("")
    return "\n".join(lines) + "\n"


def write_index(album_dir: Path, content: str) -> Path:
    album_dir.mkdir(parents=True, exist_ok=True)
    target = album_dir / INDEX_NAME
    # 不删旧文件，直接覆盖同名 —— 与出书流程同一条规矩
    target.write_text(content, encoding="utf-8")
    return target


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="给画册集生成一份书目录")
    parser.add_argument("--dir", help="画册集目录（默认取工具约定的那个）")
    parser.add_argument("--print", dest="dry_run", action="store_true",
                        help="只打印，不写文件")
    args = parser.parse_args(argv)

    album_dir = Path(args.dir).expanduser().resolve() if args.dir else default_album_dir()
    books = collect(album_dir)
    content = render(album_dir, books)

    if args.dry_run:
        print(content)
        return 0

    if not album_dir.is_dir() and not books:
        print(f"画册集还不存在，先做一本画册吧：\n{album_dir}")
        return 0

    target = write_index(album_dir, content)
    print(f"已更新目录：{target}")
    print(f"  收录 {len(books)} 本画册")
    for b in books:
        print(f"    · {b['title']}（{b['photo_count']} 张 / {b['generated_at'] or '时间未知'}）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
