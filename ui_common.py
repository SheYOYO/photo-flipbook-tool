#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""界面与系统交互的公共部分：选文件夹、开浏览器、错误弹窗与日志。

Windows 上踩过的坑都在这里统一处理：
  - 中文路径：一律用 pathlib 传，不做 str 拼接
  - 控制台编码：把 stdout 切成 UTF-8，避免 GBK 下打印中文崩掉
  - 出错不许丢栈给用户：弹一个可读对话框 + 写日志文件
"""

from __future__ import annotations

import os
import subprocess
import sys
import traceback
from datetime import datetime
from pathlib import Path

LOG_DIR_NAME = "logs"


# --------------------------------------------------------------------------
# 控制台编码
# --------------------------------------------------------------------------


def setup_console() -> None:
    """让标准输出能安全打印中文。"""

    for stream_name in ("stdout", "stderr"):
        stream = getattr(sys, stream_name, None)
        if stream is None:
            continue
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass


# --------------------------------------------------------------------------
# 日志
# --------------------------------------------------------------------------


def log_dir() -> Path:
    d = Path(__file__).parent / LOG_DIR_NAME
    d.mkdir(parents=True, exist_ok=True)
    return d


def log_error(exc: BaseException) -> Path:
    """把异常连同栈写进日志文件，返回日志路径。"""

    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    path = log_dir() / f"error-{stamp}.log"
    detail = "".join(traceback.format_exception(type(exc), exc, exc.__traceback__))
    try:
        path.write_text(
            f"时间：{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}\n"
            f"Python：{sys.version}\n"
            f"可执行文件：{sys.executable}\n"
            f"工作目录：{os.getcwd()}\n"
            f"\n{'=' * 60}\n{detail}",
            encoding="utf-8",
        )
    except Exception:
        pass
    return path


# --------------------------------------------------------------------------
# 对话框
# --------------------------------------------------------------------------


def _tk_root():
    """建一个隐藏的 Tk 根窗口。"""

    import tkinter as tk

    root = tk.Tk()
    root.withdraw()
    root.attributes("-topmost", True)
    return root


def choose_folder(title: str = "请选择文件夹", initial: str | None = None) -> str | None:
    """弹系统文件夹选择框，返回绝对路径；用户取消则返回 None。

    弹不出来（比如没有图形界面）时退回命令行输入，不让工具直接崩。
    """

    try:
        from tkinter import filedialog

        root = _tk_root()
        try:
            chosen = filedialog.askdirectory(
                title=title,
                mustexist=True,
                initialdir=initial or os.path.expanduser("~"),
            )
        finally:
            root.destroy()
        return str(Path(chosen).resolve()) if chosen else None
    except Exception as exc:
        print(f"[提示] 无法弹出选择框（{type(exc).__name__}），改为手工输入路径。")
        entered = input(f"{title}（直接回车取消）：").strip().strip('"')
        return str(Path(entered).expanduser().resolve()) if entered else None


def message(title: str, text: str, *, error: bool = False) -> None:
    """弹一个可读的消息框；弹不出来就打印。"""

    try:
        from tkinter import messagebox

        root = _tk_root()
        try:
            if error:
                messagebox.showerror(title, text)
            else:
                messagebox.showinfo(title, text)
        finally:
            root.destroy()
    except Exception:
        print(f"\n[{title}]\n{text}")


# --------------------------------------------------------------------------
# 浏览器
# --------------------------------------------------------------------------


def open_in_browser(target: Path | str) -> bool:
    """用系统默认浏览器打开本地 HTML。"""

    path = Path(target).resolve()
    if not path.is_file():
        raise FileNotFoundError(f"要打开的文件不存在：{path}")
    if sys.platform.startswith("win"):
        os.startfile(str(path))  # noqa: S606 - Windows 专用
        return True
    subprocess.Popen(["xdg-open", str(path)])
    return True
