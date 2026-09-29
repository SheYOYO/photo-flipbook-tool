#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""验收脚本的公共工具。

★ 名字刻意不以 `_` 开头：这个项目里 `_xxx` 是「一次性探针」的约定，
  一次性探针用完就删。这个模块是要留下来的。

## 为什么需要 `status_files_guard()`

`serve_ui.py` 启动时会写两个**全局唯一**的文件：

    logs\\.serve_ui.pid          服务自己的 PID（工作台的「关闭工具」靠它精确关进程）
    logs\\工作台启动位置.txt       服务实际监听的地址

它们是「同一时刻只应该有一个工作台」这个假设的产物。但验收脚本也起服务，
一起就会把它们改写/删掉 —— 后果是**用户那个还开着的工作台，事后点「关闭工具」
关不掉了**（PID 文件没了）。跑一次验收，把用户的环境弄坏，这不合适。

所以：跑之前把「本来就在的」文件读进内存，跑完原样还回去。
验收脚本自己那几步断言照常做（断言的是它自己的效果），只是不留后遗症。
"""
from __future__ import annotations

from pathlib import Path
from typing import Callable
from contextlib import contextmanager

LOGS_NAME = "logs"
PIDFILE_NAME = ".serve_ui.pid"
NOTEFILE_NAME = "工作台启动位置.txt"


def _global_files(here: Path) -> list[Path]:
    logs = here / LOGS_NAME
    return [logs / PIDFILE_NAME, logs / NOTEFILE_NAME]


def snapshot_status_files(here: Path, log: Callable[[str], None] = print) -> dict[Path, bytes]:
    """把「本来就在的」状态文件读进内存。返回 {路径: 内容}（可能为空）。

    两种用法都对：
        saved = snapshot_status_files(HERE)
        try: ...
        finally: restore_status_files(saved)

    或者 `with status_files_guard(HERE): ...`（内部就是这两个函数）。
    """
    saved: dict[Path, bytes] = {}
    for path in _global_files(here):
        if path.exists():
            try:
                saved[path] = path.read_bytes()
            except OSError as exc:
                log(f"      （{path.name} 读不到，跳过备份：{exc!r}）")
    if saved:
        names = "、".join(p.name for p in saved)
        log(f"      发现本机已有正在运行的工作台状态文件（{names}），先备份，跑完还原")
    return saved


def restore_status_files(saved: dict[Path, bytes],
                         log: Callable[[str], None] = print) -> None:
    """把 `snapshot_status_files()` 存下的内容原样写回。

    本来就不存在的文件不会在退出时被凭空造出来。
    """
    for path, data in saved.items():
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)
        except OSError as exc:
            log(f"      ⚠ 还原 {path.name} 失败：{exc!r}")
    if saved:
        log("      已还原上面备份的状态文件（不影响你正开着的那个工作台）")


@contextmanager
def status_files_guard(here: Path, log: Callable[[str], None] = print):
    """跑验收期间保证「用户在用的 PID / 位置文件」不受影响（成功失败都还原）。"""
    saved = snapshot_status_files(here, log=log)
    try:
        yield
    finally:
        restore_status_files(saved, log=log)


# --------------------------------------------------------------------------
# 浏览器卫生：别把 chromium 和它的临时 profile 留在用户的系统里
# --------------------------------------------------------------------------
#
# 起因（佘先生 2026-09-24）：「自动清理调用的浏览器页面，你跑一次代码，
# 开了十多个页面，你打开的页面不用了关掉」。
#
# 查下来是两件事叠加：
#   ① 出书/起服务会**自动开浏览器**（本机默认浏览器是 Tabbit）——
#      脚本起十几次服务，就在他眼前弹十几个标签页。已在 make_flipbook.should_open_browser()
#      与 serve_ui.auto_open_enabled() 里堵住（脚本调用一律不开）。
#   ② playwright 的 chromium 是被**进程外**的 node 拉起来的：node 一旦不是
#      「正常走到末尾」，末尾那句 await browser.close() 就执行不到，
#      留下一只孤儿浏览器 + 一个 %TEMP%\playwright_chromiumdev_profile-* 目录。
#      实测本机攒了 26 个（09-19 ~ 09-24）。脚本里能加 finally 的都加了，
#      但被强杀（宿主保护掐进程、超时 kill）那一类 finally 也没机会跑，
#      所以还需要这里兜一次底。
#
# 判据用「目录多久没动过」而不是「有没有对应进程」：查进程要 WMI，慢且脆；
# 而 playwright 的临时 profile 只在浏览器活着时被写。跑一轮验收约 2 分钟，
# 取 30 分钟作阈值 —— 比任何一次验收都长，绝不会误删正在用的那个。

BROWSER_TEMP_GLOBS = ("playwright_chromiumdev_profile-*", "playwright-artifacts-*")
BROWSER_LEFTOVER_MIN_AGE_MIN = 30


def sweep_browser_leftovers(
    min_age_min: int = BROWSER_LEFTOVER_MIN_AGE_MIN,
    log: Callable[[str], None] = print,
) -> tuple[int, int]:
    """删掉 %TEMP% 里**陈旧**的 playwright 痕迹。返回 (删了几个目录, 释放字节)。

    只删自己名下（playwright）的东西，且只删足够久没动过的；
    目录不存在 / 正被占用都当作正常情况跳过，绝不抛异常打断验收。
    """

    import os
    import shutil
    import tempfile
    import time as _time

    root = Path(tempfile.gettempdir())
    cutoff = _time.time() - min_age_min * 60
    killed = 0
    freed = 0

    for pattern in BROWSER_TEMP_GLOBS:
        for path in root.glob(pattern):
            try:
                if path.stat().st_mtime > cutoff:
                    continue            # 还新鲜 —— 可能正在用，别碰
                for dirpath, _dirnames, filenames in os.walk(path):
                    for name in filenames:
                        try:
                            freed += (Path(dirpath) / name).stat().st_size
                        except OSError:
                            pass
                shutil.rmtree(path, ignore_errors=True)
                if not path.exists():
                    killed += 1
            except OSError:
                continue

    if killed:
        log(f"      顺手清掉 {killed} 个 playwright 遗留的临时目录（约 {freed / 1048576:.1f} MB）")
    return killed, freed

