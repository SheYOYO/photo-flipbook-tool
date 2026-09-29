#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""双击这个文件就能做画册：选文件夹 → 生成 → 自动打开浏览器。

它自己会去找能用的 Python（本机已装的那些），不需要用户配环境变量。
"""

from __future__ import annotations

import glob
import os
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent

# ★ 不要写死绝对路径。写死的话，工具换个用户名、换台机器就直接失效。
# 这里按「随工具携带 → 常见安装位置 → PATH」的顺序动态找，
# 并且每个候选都要先验证能 import PIL 才采用。

CANDIDATE_PYTHONS: list[Path] = []

# 1) 随工具一起携带的便携解释器（优先级最高）
CANDIDATE_PYTHONS += [
    HERE / "python" / "python.exe",
    HERE / "runtime" / "python" / "python.exe",
]

# 2) 常见的按用户 / 全机安装位置（新版本排在前面）
INSTALL_PATTERNS = [
    r"%LOCALAPPDATA%\Programs\Python\Python3*\python.exe",
    r"%ProgramFiles%\Python3*\python.exe",
    r"%ProgramFiles(x86)%\Python3*\python.exe",
]

for raw in INSTALL_PATTERNS:
    pattern = os.path.expandvars(raw)
    if "%" in pattern:
        # 环境变量没展开成功（比如 ProgramFiles(x86) 不存在），跳过
        continue
    for hit in sorted(glob.glob(pattern), reverse=True):
        CANDIDATE_PYTHONS.append(Path(hit))


def has_pillow(python: str) -> bool:
    """确认这个解释器能 import PIL。"""

    try:
        result = subprocess.run(
            [python, "-c", "import PIL, sys; sys.exit(0)"],
            capture_output=True,
            timeout=25,
        )
        return result.returncode == 0
    except Exception:
        return False


def find_python() -> str | None:
    """找一个带 Pillow 的 Python。"""

    # 用 dict 去重，保持优先级顺序
    seen: dict[str, None] = {}
    for candidate in CANDIDATE_PYTHONS:
        seen.setdefault(str(candidate), None)

    for candidate in seen:
        if Path(candidate).is_file() and has_pillow(candidate):
            return candidate

    # 退路：PATH 上的 python / 系统启动器
    for name in ("py", "python", "python3"):
        try:
            found = subprocess.run(
                [name, "-c", "import PIL, sys; sys.exit(0)"],
                capture_output=True,
                timeout=25,
            )
            if found.returncode == 0:
                return name
        except Exception:
            continue
    return None


def _ensure_streams() -> None:
    """保证 print 不会把脚本打崩。

    用 pythonw.exe（无控制台）启动时 sys.stdout / sys.stderr 都是 None，
    print 会抛 AttributeError。另外控制台默认是 GBK，中文提示会乱码，
    所以顺手把编码改成 utf-8。
    """

    class _Sink:
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
            pass


def main() -> int:
    _ensure_streams()

    python = find_python()
    if python is None:
        print("找不到带 Pillow 的 Python 解释器，无法生成画册。")
        print()
        print("可选修复方式：")
        print("  1) 在本机装一个 Pillow：  pip install Pillow")
        print("  2) 或把本工具的 python 列表补上你的解释器路径")
        print()
        try:
            input("按回车关闭…")
        except Exception:
            pass
        return 1

    print("正在启动画册生成器…")
    print(f"使用解释器：{python}")
    print()

    argv = [python, str(HERE / "make_flipbook.py"), *sys.argv[1:]]
    return subprocess.call(argv, cwd=str(HERE))


if __name__ == "__main__":
    raise SystemExit(main())
