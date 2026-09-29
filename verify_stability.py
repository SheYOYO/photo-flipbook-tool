#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""稳定性验收：把「五层验收」连跑 N 轮，给出分布，而不是单次结论。

★ 为什么必须连跑多轮（本项目铁律一第 3 条）
------------------------------------------------
单次、甚至三次全绿都**不构成证据**。本项目实测过同一份代码连跑 6 次，
长帧数 = `4, 3, 0, 1, 0, 0` —— **纯随机**。拿一次的颜色下结论会得错答案。

用途
----
    python verify_stability.py              # 跑 6 轮（默认）
    python verify_stability.py --rounds 10  # 跑 10 轮
    python verify_stability.py --rounds 2 --tag chunkA   # 分块连跑，日志不互相覆盖

每层的原始输出留档在 `.verify-probe/rounds/roundN-*.log`，
所以任何一轮红了都能直接翻原始记录定位，不用重跑。

★ 为什么要识别「环境拦截」
------------------------------------------------
宿主有**批量删除保护**：一轮里删得太多（阈值约 50 个），之后任何进程的删除
动作都会被拦（`SAFE_DELETE_BULK_CONFIRM_REQUIRED`）。
被拦住的进程会**中途退出、不打末尾汇总**，于是看起来「整层红」——
但那是**环境假红，不是产品红**（本项目实测：清理 462 个探针文件后的 3 轮全红，
单独重跑立刻 26/26）。

所以本脚本把这种轮次单独标成 `⛔环境拦截`，**既不算绿、也不算产品红**，
并提示「本轮无效，需在干净环境重跑」。**判据本身一个字没动。**
"""
from __future__ import annotations

import argparse
import os
import re
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROUND_LOGS = HERE / ".verify-probe" / "rounds"

PY = sys.executable
# 强制用带 Pillow 的解释器跑（selftest / 出书都要 PIL）
_PILLOW_CANDIDATES = [
    Path(os.environ.get("LOCALAPPDATA", "")) / "Programs" / "Python" / "Python312" / "python.exe",
    Path.home() / ".workbuddy" / "binaries" / "python" / "envs" / "default" / "Scripts" / "python.exe",
]
for _c in _PILLOW_CANDIDATES:
    if _c.is_file():
        try:
            if subprocess.run([str(_c), "-c", "import PIL"],
                              capture_output=True, timeout=30).returncode == 0:
                PY = str(_c)
                break
        except Exception:
            pass

# 本地回环被代理毒害 → 跑前一律清掉
ENV = dict(os.environ, PYTHONIOENCODING="utf-8")
for _k in [k for k in ENV if "PROXY" in k.upper()]:
    ENV.pop(_k, None)
ENV["NO_PROXY"] = "*"

# 宿主的批量删除保护标记（出现在被测进程的 stdout/stderr 里）
GUARD_MARK = "SAFE_DELETE_BULK_CONFIRM_REQUIRED"

LAYERS = ("契约", "核心", "界面", "成品", "快捷入口")


def run(cmd: list[str]) -> tuple[int, str]:
    r = subprocess.run(cmd, capture_output=True, env=ENV, cwd=str(HERE))
    out = (r.stdout or b"").decode("utf-8", "replace")
    out += (r.stderr or b"").decode("utf-8", "replace")
    return r.returncode, out


def count_marks(text: str) -> str | None:
    """数末尾汇总里的 ✅/❌（verify_shortcut.py 的汇总是一行一项）。"""
    marks = re.findall(r"^\s*([✅❌])", text, re.M)
    if not marks:
        return None
    return "%d/%d" % (marks.count("✅"), len(marks))


def parse_round(out_all: str, out_shortcut: str, rc_all: int, rc_shortcut: int) -> dict:
    """把两段输出解析成五层结论。"""
    res: dict[str, str] = {}

    m = re.search(r"契约层\s*[—\-:：]\s*(\S+)", out_all)
    res["契约"] = m.group(1) if m else ("4/4" if "# fail 0" in out_all else "FAIL")

    m = re.search(r"核心层\s*[—\-:：]\s*(\S+)", out_all)
    if m:
        res["核心"] = m.group(1)
    else:                       # 汇总行没打出来（多半是中途被拦），去 selftest 原文里捞
        m2 = re.search(r"共\s*(\d+)\s*项，通过\s*(\d+)", out_all)
        res["核心"] = "%s/%s" % (m2.group(2), m2.group(1)) if m2 else "FAIL"

    m = re.search(r"界面层\s*[—\-:：]\s*(\S+)", out_all)
    if m:
        res["界面"] = m.group(1)
    else:                       # 同上：别写死 22/22，去 verify_ui 的「通过 N/M」里捞
        m2 = re.search(r"通过\s*(\d+)/(\d+)", out_all)
        res["界面"] = "%s/%s" % (m2.group(1), m2.group(2)) if m2 else "FAIL"

    res["成品"] = "OK" if ("成品画册验收通过" in out_all and "全部通过" in out_all) else "FAIL"

    res["快捷入口"] = count_marks(out_shortcut) or "FAIL"
    if rc_shortcut != 0:
        res["快捷入口"] = "FAIL"

    res["_rc"] = (rc_all, rc_shortcut)
    res["_guard"] = GUARD_MARK in (out_all + out_shortcut)
    res["_allok"] = all(v not in ("FAIL", "?") for k, v in res.items() if k in LAYERS)
    return res


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="五层验收连跑 N 轮，给出分布")
    ap.add_argument("--rounds", type=int, default=6, help="跑几轮（默认 6）")
    # ★ 分块连跑（前台每块 2 轮，见模块 docstring）时，roundN 这个名字块块重复、
    #   会把前一块的原始日志覆盖掉 —— 那等于「6 轮留档」只留了最后 2 轮。
    #   给每块一个 --tag，日志名变成 <tag>-roundN-*.log，各块互不覆盖。
    ap.add_argument("--tag", default="", help="给本轮日志加前缀（分块连跑时避免互相覆盖）")
    args = ap.parse_args(argv)

    ROUND_LOGS.mkdir(parents=True, exist_ok=True)

    print("=" * 78)
    print("五层验收 × %d 轮  （%s）" % (args.rounds, " / ".join(LAYERS)))
    print("解释器：%s" % PY)
    print("=" * 78)

    prefix = (args.tag + "-") if args.tag else ""

    green = blocked = 0
    for i in range(1, args.rounds + 1):
        rc1, out1 = run([PY, "verify_all.py"])
        rc2, out2 = run([PY, "verify_shortcut.py"])

        (ROUND_LOGS / ("%sround%d-verify_all.log" % (prefix, i))).write_text(out1, encoding="utf-8")
        (ROUND_LOGS / ("%sround%d-verify_shortcut.log" % (prefix, i))).write_text(out2, encoding="utf-8")

        r = parse_round(out1, out2, rc1, rc2)

        if r["_guard"]:
            tag = "⛔环境拦截"
            blocked += 1
        elif r["_allok"]:
            tag = "全绿"
            green += 1
        else:
            tag = "★有红★"

        print("第 %d 次  %s  %s"
              % (i, "  ".join("%s=%s" % (k, r[k]) for k in LAYERS), tag), flush=True)

        if tag == "★有红★":
            # 红项要连**原始值**一起打出来（铁律二：别看四舍五入后的显示值）
            print("   --- 红项原文 ---", flush=True)
            for ln in (out1 + "\n" + out2).splitlines():
                if re.match(r"^\s*[❌✗]", ln) or re.search(r"# fail [1-9]", ln) \
                        or ln.strip().startswith("FAIL"):
                    print("   " + ln.strip()[:170], flush=True)
            print("   原始输出：%s" % (ROUND_LOGS / ("%sround%d-*.log" % (prefix, i))), flush=True)
        elif tag == "⛔环境拦截":
            print("   ↑ 宿主的批量删除保护拦了被测进程（不是产品红）。", flush=True)
            print("     本轮**无效**，请在「本轮没有批量删除」的环境重跑。", flush=True)

    print()
    print("=" * 78)
    if blocked:
        print("结果：%d 轮有效且全绿 / 共 %d 轮；**其中 %d 轮被环境拦截（无效，需重跑）**"
              % (green, args.rounds, blocked))
    else:
        print("结果：%d/%d 轮五层全绿" % (green, args.rounds))
    print("=" * 78)

    # 只在「所有轮次都有效且全绿」时才返回 0
    return 0 if (green == args.rounds) else 1


if __name__ == "__main__":
    raise SystemExit(main())
