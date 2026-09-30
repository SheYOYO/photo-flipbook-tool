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
    # ★ 本文件住在 app/ 里；logs/ 在工具根（仓库根）。
    d = Path(__file__).parent.parent / LOG_DIR_NAME
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


# --------------------------------------------------------------------------
# 浏览器：连浏览器外壳一起收走的「无边框全屏」
# --------------------------------------------------------------------------
#
# 佘先生 2026-09-30 定的口径：「我要的全屏是类似电脑游戏的全屏模式，屏幕上方
# 不能有浏览器显示」。这件事**浏览器自己那套 Fullscreen API 靠不住** ——
# 它做不做得到取决于浏览器肯不肯放行；而 Chromium 的 `--app=` 加
# `--start-fullscreen` 是命令行层面的事，不经过任何权限，开出来就是一个
# 没有标签页、没有地址栏、顶满整屏的窗口（2026-09-30 在他屏幕上实拍验证过）。
#
# ★ 但 `--app=` 只有 Chromium 系认。别的浏览器收到只当垃圾参数丢掉，然后开出
#   一个**带标签页**的窗口 —— "上面没有浏览器"就落空了，而且**不报错**。
#   所以这里宁可多一步认亲：认不出来就退回老办法（普通标签页打开）。
#   认亲看的是"家当"文件，不看 exe 名字 —— 套壳的 Chromium 名字五花八门。

_CHROMIUM_MARKERS = frozenset(
    {
        "chrome.dll",
        "msedge.dll",
        "chrome_proxy.exe",
        "msedge_proxy.exe",
        "chrome_pwa_launcher.exe",
        "chrome_launcher.exe",
        "resources.pak",
    }
)

_REG_HTTP_CHOICE = (
    r"Software\Microsoft\Windows\Shell\Associations\UrlAssociations\http\UserChoice"
)


def _default_browser_command() -> str | None:
    """默认浏览器（http 协议）的 shell\\open\\command；拿不到返回 None。"""

    if not sys.platform.startswith("win"):
        return None
    try:
        import winreg

        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, _REG_HTTP_CHOICE) as key:
            prog_id = winreg.QueryValueEx(key, "ProgId")[0]
        if not prog_id:
            return None
        with winreg.OpenKey(
            winreg.HKEY_CLASSES_ROOT, f"{prog_id}\\shell\\open\\command"
        ) as key:
            return winreg.QueryValueEx(key, "")[0]
    except Exception:
        return None


def browser_exe_from_command(command: str | None) -> Path | None:
    """从 `"C:\\...\\x.exe" --args %1` 里抠出 exe 路径；抠不出返回 None。

    ★ 只认**带引号**的那种。路径里有空格时，不引号根本没法切分，硬切只会切出
      半截路径 —— 那还不如老老实实退回默认打开。
    """

    if not command:
        return None
    text = command.strip()
    if not text.startswith('"'):
        return None
    end = text.find('"', 1)
    if end <= 1:
        return None
    exe = Path(text[1:end])
    return exe if exe.is_file() else None


def looks_chromium(exe: Path | str) -> bool:
    """exe 旁边（含各版本子目录）有没有 Chromium 的"家当"。"""

    folder = Path(exe).parent
    probes = [folder]
    try:
        probes += [d for d in folder.iterdir() if d.is_dir()]
    except OSError:
        pass
    for probe in probes:
        try:
            names = {p.name.lower() for p in probe.iterdir() if p.is_file()}
        except OSError:
            continue
        if names & _CHROMIUM_MARKERS:
            return True
    return False


def app_fullscreen_command(exe: Path | str, target: Path | str) -> list[str]:
    """无边框全屏打开某个本地 HTML 的命令行（纯函数，不启动任何东西）。"""

    # ★ Phase 42：URI 上**不再挂任何标记**。Phase 41 挂过 `#fullscreen`，可它是
    #   "赖着不走"的（findings 126）：用户按 F11 退出全屏后标记还在，阅读器就永远停在
    #   静读态、控制条再也回不来。现在 reader 认的是 `(display-mode: fullscreen)` ——
    #   一条**会自己变回去**的媒体特性（findings 124：真机 `--app=` 全屏时它确为
    #   true、普通窗口为 false）⇒ 命令照旧，进也对、退也对。
    uri = Path(target).resolve().as_uri()
    return [str(exe), f"--app={uri}", "--start-fullscreen"]


def _run_detached(command: list[str]) -> None:
    """把浏览器放出去，不接管它的生命周期。测试里会把这个换掉。"""

    kwargs: dict[str, object] = {"close_fds": True}
    if sys.platform.startswith("win"):
        # DETACHED_PROCESS | CREATE_NO_WINDOW —— 浏览器跟着工具一起死是最烦的
        kwargs["creationflags"] = 0x00000008 | 0x08000000
    subprocess.Popen(command, **kwargs)


def open_book_fullscreen(target: Path | str) -> bool:
    """打开一本做好的画册，**连浏览器外壳一起收走**（无边框 + 顶满整屏）。

    任何一步不成立（不是 Windows / 认不出默认浏览器 / 不是 Chromium 系 /
    放出去就失败）⇒ 退回 `open_in_browser` 用普通标签页打开。
    **绝不静默什么都不做** —— 用户点了「打开画册」，就必须有东西开出来。
    """

    path = Path(target).resolve()
    if not path.is_file():
        raise FileNotFoundError(f"要打开的文件不存在：{path}")
    if sys.platform.startswith("win"):
        exe = browser_exe_from_command(_default_browser_command())
        if exe is not None and looks_chromium(exe):
            try:
                _run_detached(app_fullscreen_command(exe, path))
                return True
            except Exception:
                pass
    return open_in_browser(path)
