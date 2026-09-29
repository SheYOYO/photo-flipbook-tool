#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""四层验收一把跑完。

层        脚本                    验的是什么
--------  ----------------------  --------------------------------------------
契约      runtime/html-contract   上游 create-photo-flipbook-ui 的硬契约
                                        （必须在「成品目录」里跑，它要找
                                          vendor/page-flip.browser.js 和
                                          assets/photos/）
核心      selftest.py             排版引擎的双向自测（成功 6 + 失败 7 + 边界）
    界面      verify_ui.mjs           工作台端到端（真实浏览器，48 项）
成品      verify_book_ui.mjs      成品画册在浏览器里能翻、翻得正、不卡

用法：
    python verify_all.py                # 全跑
    python verify_all.py --only 成品     # 只跑某一层（契约 / 核心 / 界面 / 成品）

★ 名字刻意不以 `_` 开头：这个项目里 `_xxx` 是「一次性探针」的约定，
  一次性探针用完就删。这个脚本是要留下来的，别被顺手清掉。
"""
from __future__ import annotations

import argparse
import functools
import http.server
import json
import os
import socket
import socketserver
import subprocess
import sys
import threading
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
# ★ 验收对象所在的书架。默认就是用户那个「画册集」—— 契约层与成品层验的正是
#   **他手上真实的成品**，这是这套门禁的意义所在。
#
#   只有在**他画册集里一本书都没有**时（他清空过、或新机器上还没出过书），
#   才退到沙箱里的替身书架 `.verify-probe/gate-画册集/`，让这两层仍然跑得起来
#   —— 不然「画册集空着」会让两层直接变成"没法跑"。
#   ⚠ 这**不是放宽判据**：断言、阈值一个字没动，改的只是「去哪儿取被测对象」。
#   ⚠ 也**不会**往他的画册集里写任何东西。
#   ⚠ 替身书架**绝不能**和界面层的出书丢弃目录（`.verify-probe/ui-sandbox/`）
#     共用一个目录：界面层每轮都会新出一本《小虎的夏天》，时间戳更新，
#     会把替身书架里那本长的《深圳》**顶掉** —— 于是成品层悄悄换成验一本
#     9 页小书（2026-09-25 真踩过，症状是成品层时红时绿、红在"书脊折痕
#     峰值 0.000"，最后一查是测量对象变了）。
#   `FLIPBOOK_ALBUM` 只是**显式覆盖**口子，日常不需要。
SANDBOX_GATE_ALBUM = HERE / ".verify-probe" / "gate-画册集"


def _newest_in(album: Path) -> Path | None:
    """书架里最新做好的那本。

    为什么不是固定目录名：`--output` 允许把书出到任何地方、工作台里也能改，
    写死某个名字的话，验收会在「书名一改就找不到成品」上假失败。
    所以按 book-plan.json 里的 `generated_at` 挑最新的一本。
    """
    if not album.is_dir():
        return None
    best: tuple[str, Path] | None = None
    for child in album.iterdir():
        plan = child / "book-plan.json"
        if not child.is_dir() or not (child / "index.html").is_file() or not plan.is_file():
            continue
        try:
            stamp = json.loads(plan.read_text(encoding="utf-8")).get("generated_at", "")
        except Exception:
            stamp = ""
        if best is None or stamp > best[0]:
            best = (stamp, child)
    return best[1] if best else None


def _pick_album() -> Path:
    """决定契约层 / 成品层验哪本书（选书架的规矩见上面那段注释）。"""
    override = os.environ.get("FLIPBOOK_ALBUM")
    if override:
        return Path(override)
    user = ROOT / "画册集"
    if _newest_in(user) is not None:
        return user
    if _newest_in(SANDBOX_GATE_ALBUM) is not None:
        return SANDBOX_GATE_ALBUM
    return user          # 两边都没有 → 仍指向他的画册集，让两层照旧报"找不到成品"


ALBUM = _pick_album()
ALBUM_IS_SANDBOX = ALBUM == SANDBOX_GATE_ALBUM

BOOK = _newest_in(ALBUM) or (ALBUM / "（还没做过画册）")

sys.path.insert(0, str(HERE))
from verify_common import snapshot_status_files, restore_status_files, sweep_browser_leftovers  # noqa: E402

# 本机常驻 HTTP_PROXY/HTTPS_PROXY，回环请求会被送去代理直接失败。
for _k in [k for k in os.environ if "PROXY" in k.upper()]:
    os.environ.pop(_k, None)
os.environ["NO_PROXY"] = "*"

PY = None  # 见 _pick_python()


def _pick_python() -> str:
    """挑一个**带 Pillow** 的解释器。

    ★ 这里绝不能直接用 `sys.executable`：
      selftest.py 与 serve_ui.py 都依赖 Pillow，而「跑验收的那个」解释器
      未必带 PIL（比如托管版 3.13.12 就没有）。用错解释器会出现两种假失败：
        - selftest.py → 11 项整片失败
        - serve_ui.py → 打印「缺少 Pillow」直接退出 → 界面层「工作台启动超时」
      复用 `run.py` 的候选表（单一事实来源），它已覆盖用户本机装的 Python。
    """
    try:
        import importlib.util
        spec = importlib.util.spec_from_file_location("_run", HERE / "run.py")
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)           # run.py 模块级无副作用
        found = mod.find_python()
        if found:
            return found
    except Exception as exc:                    # noqa: BLE001
        print(f"（提示）复用 run.py 挑解释器失败：{exc}", flush=True)
    print("（提示）找不到带 Pillow 的解释器，退回当前解释器 —— 自测可能假失败", flush=True)
    return sys.executable


PY = _pick_python()
NODE = Path(r"C:\Users\Admin（无密码）\.workbuddy\binaries\node\versions\22.22.2-3\node.exe")
if not NODE.exists():                      # 回退到 PATH 里的 node
    NODE = Path("node")

WORKBENCH_PORT = 8791
BOOK_PORT = 8799

results: list[tuple[str, bool, str]] = []


def log(msg: str = "") -> None:
    print(msg, flush=True)


def run(cmd, cwd=None, timeout=900):
    return subprocess.run(
        [str(c) for c in cmd],
        cwd=str(cwd) if cwd else None,
        capture_output=True, text=True,
        encoding="utf-8", errors="replace",
        env=dict(os.environ), timeout=timeout,
    )


def wait_port(port: int, seconds: float = 30.0) -> bool:
    """等端口真的能连上——不能只 sleep，机器慢的时候会假失败。"""
    deadline = time.time() + seconds
    while time.time() < deadline:
        with socket.socket() as s:
            s.settimeout(0.4)
            if s.connect_ex(("127.0.0.1", port)) == 0:
                return True
        time.sleep(0.25)
    return False


# ---------------------------------------------------------------- 1 契约
def layer_contract() -> None:
    log("\n" + "=" * 60)
    log("第一层：上游官方契约测试")
    log("=" * 60)
    test = BOOK / "html-contract.test.mjs"
    if not test.exists():
        results.append(("契约", False, f"找不到 {test}（先跑一次 make_flipbook.py 生成成品）"))
        log(f"跳过：{test} 不存在")
        return
    r = run([NODE, "--test", "html-contract.test.mjs"], cwd=BOOK)
    tail = (r.stdout or "") + (r.stderr or "")
    log(tail.strip()[-1500:])
    ok = r.returncode == 0
    summary = "4/4" if ok else "有失败"
    results.append(("契约", ok, summary))


# ---------------------------------------------------------------- 2 核心
def layer_selftest() -> None:
    log("\n" + "=" * 60)
    log("第二层：核心双向自测")
    log("=" * 60)
    r = run([PY, "selftest.py"], cwd=HERE)
    out = (r.stdout or "") + (r.stderr or "")
    log(out.strip()[-2600:])
    ok = r.returncode == 0 and "失败 0" in out
    # ★ 汇总里那个分母写成死数字就会和 selftest 实际用例数脱节
    #   （2026-09-23 加了「跨页配对回归」后从 14 变 18）。这里直接去
    #   selftest 的输出里把「共 N 项，通过 M」读出来，别再写死。
    import re as _re

    m = _re.search(r"共\s*(\d+)\s*项，通过\s*(\d+)", out)
    summary = f"{m.group(2)}/{m.group(1)}" if m else ("全部通过" if ok else "有失败")
    results.append(("核心", ok, summary))


# ---------------------------------------------------------------- 3 界面
def layer_ui() -> None:
    log("\n" + "=" * 60)
    log("第三层：工作台端到端（真实浏览器）")
    log("=" * 60)
    # ★ 必须用 --source 预载照片目录：不预载的话工作台首屏是一张空列表，
    #   verify_ui.mjs 会死在「等 #grid .card 出现」上直接超时。
    source = ROOT / "图片"
    if not source.is_dir():
        results.append(("界面", False, f"照片目录不存在：{source}"))
        log(f"跳过：{source} 不存在")
        return
    # ★ serve_ui.py 一启动就会写 logs 下的 PID / 启动位置文件，那是「全局唯一」的。
    #   不备份的话，跑一次验收就把用户正开着的那个工作台的状态文件冲掉，
    #   事后他那个还开着的工作台就找不回自己的 PID 了。跑完（无论成败）原样还原。
    saved_status = snapshot_status_files(HERE, log=log)
    # ★ 把出书位置隔离到临时目录：界面层验收会真的出一本书（书名固定），
    #   照默认走的话每跑一次就把用户画册集里那本书覆盖一遍 —— 验收不该
    #   动用户的作品。这里让它出到 .verify-probe/ 里，跑完丢掉。
    #   ⚠ 这个目录必须和契约层/成品层的取书书架 `SANDBOX_GATE_ALBUM` **分开**：
    #     它每轮都会新出一本（时间戳最新），放同一个目录里会把书架里那本
    #     长书顶掉、把成品层的验收对象偷偷换成一本 9 页小书（真踩过）。
    probe_album = HERE / ".verify-probe" / "ui-sandbox"
    server = subprocess.Popen(
        [PY, "serve_ui.py", "--port", str(WORKBENCH_PORT), "--no-open",
         "--source", str(source), "--output", str(probe_album)],
        cwd=HERE, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        env=dict(os.environ),
    )
    try:
        if not wait_port(WORKBENCH_PORT):
            results.append(("界面", False, "工作台没起来"))
            log("工作台启动超时")
            return
        log(f"工作台已就绪 127.0.0.1:{WORKBENCH_PORT}")
        r = run([NODE, "verify_ui.mjs", f"http://127.0.0.1:{WORKBENCH_PORT}"], cwd=HERE)
        out = (r.stdout or "") + (r.stderr or "")
        log(out.strip()[-3200:])
        ok = r.returncode == 0
        # ★ 分母别写死：verify_ui.mjs 的用例数会随功能增加（Phase 24 加了封面编辑
        #   的「成功 8」），写死 22/22 会变成假精度 —— 明明跑了 34 项却报 22/22。
        #   直接从它末尾那行「通过 N/M」读，读不到才回退。
        import re as _re
        m = _re.search(r"通过\s*(\d+)/(\d+)", out)
        n = f"{m.group(1)}/{m.group(2)}" if m else ("通过" if ok else "有失败")
        results.append(("界面", ok, n))
    finally:
        server.terminate()
        try:
            server.wait(timeout=10)
        except subprocess.TimeoutExpired:
            server.kill()
        restore_status_files(saved_status, log=log)
        log("已关掉工作台。")
        # 隔离用的出书目录**不删**：删除动作又慢又可能触发宿主的批量删除
        # 保护（把进程打死），而它只是一个固定名字的小目录，下次跑验收
        # 会被原样覆盖 —— 与出书流程同一条规矩：覆盖，不删。
        if probe_album.is_dir():
            log(f"（验收用的出书目录留着复用，不删：{probe_album}）")


# ---------------------------------------------------------------- 4 成品
class _Quiet(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True

    def handle_error(self, *a):     # 浏览器断开时不要往控制台喷栈
        pass


def layer_book() -> None:
    log("\n" + "=" * 60)
    log("第四层：成品画册浏览器验收")
    log("=" * 60)
    log(f"验收对象：{BOOK}")
    if not (BOOK / "index.html").exists():
        results.append(("成品", False, f"找不到 {BOOK / 'index.html'}"))
        log("跳过：成品还没生成")
        return

    class H(http.server.SimpleHTTPRequestHandler):
        def log_message(self, *a):      # 关掉每个请求的访问日志
            pass

    handler = functools.partial(H, directory=str(BOOK))
    srv = _Quiet(("127.0.0.1", BOOK_PORT), handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    try:
        url = f"http://127.0.0.1:{BOOK_PORT}"
        log(f"成品服务已就绪 {url}")
        r = run([NODE, "verify_book_ui.mjs", url], cwd=HERE)
        out = (r.stdout or "") + (r.stderr or "")
        log(out.strip()[-3200:])
        ok = r.returncode == 0 and "验收通过" in out
        results.append(("成品", ok, "通过" if ok else "有失败"))
    finally:
        srv.shutdown()
        srv.server_close()


LAYERS = {
    "契约": layer_contract,
    "核心": layer_selftest,
    "界面": layer_ui,
    "成品": layer_book,
}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", default=None,
                    help="只跑某一层：" + " / ".join(LAYERS))
    args = ap.parse_args()

    todo = [args.only] if args.only else list(LAYERS)
    log(f"解释器：{PY}")
    log(f"node  ：{NODE}")
    # ★ 回落必须**看得见**：契约层/成品层验的是哪本书，是结论可信度的前提。
    #   静默换对象会让"全绿"变成一句没法核对的话。
    log(f"书架  ：{ALBUM}"
        + ("   ← 他的画册集里还没有书，用沙箱替身书架顶上（判据未变，只换了被测对象）"
           if ALBUM_IS_SANDBOX else "   ← 他手上真实的画册集"))
    # 跑之前先扫一遍：上一轮被强杀的验收可能留下孤儿 chromium 的临时 profile。
    # 只删「足够久没动过」的，正在用的那个绝不会被误删（判据见 verify_common）。
    sweep_browser_leftovers(log=log)
    for name in todo:
        if name not in LAYERS:
            log(f"未知层：{name}")
            return 2
        LAYERS[name]()

    log("\n" + "=" * 60)
    log("汇总")
    log("=" * 60)
    for name, ok, detail in results:
        log(f"{'✅' if ok else '❌'}  {name}层 — {detail}")
    bad = [n for n, ok, _ in results if not ok]
    log()
    log("全部通过" if not bad else f"有 {len(bad)} 层没过：{'、'.join(bad)}")
    return 0 if not bad else 1


if __name__ == "__main__":
    raise SystemExit(main())
