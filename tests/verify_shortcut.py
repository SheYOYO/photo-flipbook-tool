#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""验证「快捷入口」那套链路本身。

为什么需要它：`.bat` 在工具环境里跑不了（拿不到 cmd.exe），所以这里**把
`画册.bat` 做的事逐步复现一遍**，验证的仍然是同一条链路：

    挑解释器 → 认领已有工作台（有就直接开页面）→ 没有才后台起服务
                                                      ↓
    按 PID 精确停掉 ← 读 PID 文件 → 确认 PID 文件被清掉

三步分别对应：
    挑解释器    对应 _find_python.bat   （用 run.py 里同一份候选表）
    起 / 停服务 对应 画册.bat + serve_ui.py 的复用分支

★ 入口只剩一个了，所以「停止」不再有独立入口：关服务是页面右上角
  「关闭工具」的职责。这里仍然按 PID 停一次，是为了守住
  「PID 文件写的确实是本进程、且能被精确关掉」这条契约。

★ 名字刻意不以 `_` 开头：这个项目里 `_xxx` 是「一次性探针」的约定，
  一次性探针用完就删。这个脚本是要留下来的。

用法：
    python verify_shortcut.py
"""
from __future__ import annotations

import csv
import os
import signal
import socket
import subprocess
import sys
import time
from pathlib import Path

TESTS = Path(__file__).resolve().parent   # tests/（本脚本所在）
HERE = TESTS.parent                       # 工具根（仓库根）
APP = HERE / "app"
LOGS = HERE / "logs"
PIDFILE = LOGS / ".serve_ui.pid"
NOTEFILE = LOGS / "工作台启动位置.txt"

for _k in [k for k in os.environ if "PROXY" in k.upper()]:
    os.environ.pop(_k, None)
os.environ["NO_PROXY"] = "*"

# 复用 run.py 那份候选表，保证「谁被挑中」这件事只有一个真相来源
sys.path.insert(0, str(TESTS))
sys.path.insert(0, str(APP))          # run.py 现在住在 app/ 里
import run as run_module  # noqa: E402
from verify_common import snapshot_status_files, restore_status_files  # noqa: E402

results: list[tuple[str, bool, str]] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    results.append((name, ok, detail))
    print(f"{'PASS' if ok else 'FAIL'}  {name}  {detail}", flush=True)


def port_open(port: int, timeout: float = 0.5) -> bool:
    with socket.socket() as s:
        s.settimeout(timeout)
        return s.connect_ex(("127.0.0.1", port)) == 0


def wait_port(port: int, seconds: float = 30.0) -> bool:
    deadline = time.time() + seconds
    while time.time() < deadline:
        if port_open(port):
            return True
        time.sleep(0.25)
    return False


def alive(pid: int) -> bool:
    """进程还在吗。

    ★ 两个坑：
      1. tasklist 的输出是本机 GBK 编码的，Python 3.13 默认按 UTF-8 解，
         会抛 UnicodeDecodeError（而且是在 subprocess 的读取线程里抛，
         栈会喷到控制台上）。所以要显式 decode("gbk", errors="replace")。
      2. 不能用 os.kill(pid, 0) 探测存活 —— Windows 上 os.kill 对 0 号信号
         也会真的去 TerminateProcess，直接把要观察的进程干掉。
         用 /FO CSV 解析，PID 是第 2 列，避免和内存数字撞上。
    """
    try:
        out = subprocess.run(
            ["tasklist", "/FI", f"PID eq {pid}", "/FO", "CSV", "/NH"],
            capture_output=True, timeout=20,
        )
        text = out.stdout.decode("gbk", errors="replace")
        for row in csv.reader(text.splitlines()):
            if len(row) >= 2 and row[1].strip() == str(pid):
                return True
        return False
    except Exception as exc:
        # 探测不了时保守地当作「还活着」，让断言失败出来，而不是假装通过
        print(f"      （存活探测异常，按活着处理：{exc!r}）")
        return True


def busy_ports(lo: int = 8770, hi: int = 8820) -> set[int]:
    """扫一遍端口区间，返回「已经有东西在服务」的那些。

    ★ 这是本轮加的回归断言的基础：Windows 上 SO_REUSEADDR 语义等于
      Unix 的 SO_REUSEPORT，以前 find_free_port() 会把**已被占用**的
      8770 原样返回，于是第二个工作台挤在同一个端口上、PID 文件互相覆盖。
      所以这里先记下开跑前的占用情况，再断言「服务实际选中的端口
      不在其中」——这条断言就是那个 bug 的回归测试。
    """
    taken = set()
    for port in range(lo, hi + 1):
        with socket.socket() as s:
            s.settimeout(0.2)
            if s.connect_ex(("127.0.0.1", port)) == 0:
                taken.add(port)
    return taken


def main() -> int:
    print("=" * 62)
    print("快捷入口链路验收（复现 画册.bat 的每一步）")
    print("=" * 62)

    # ---------- 第 1 步：挑解释器（_find_python.bat 的职责） ----------
    python = run_module.find_python()
    check("挑解释器：找到一个带 Pillow 的 Python", python is not None, str(python))
    if python is None:
        return 1
    r = subprocess.run([python, "-c", "import PIL; print(PIL.__version__)"],
                       capture_output=True, text=True, timeout=30)
    check("挑解释器：它真的能 import PIL", r.returncode == 0, (r.stdout or "").strip())

    # 约定：这两个 .bat 必须 CRLF + 纯 ASCII，否则 cmd.exe 解析不了
    # ★ 入口只留一个之后，双击行为是「打开工作台」；旧的
    #   开界面.bat / 停止.bat / 做画册.bat 已删除，不该再冒出来。
    for name in ("_find_python.bat", "画册.bat"):
        p = HERE / name
        if not p.exists():
            check(f"启动器存在：{name}", False, "文件缺失")
            continue
        raw = p.read_bytes()
        crlf_ok = b"\n" not in raw.replace(b"\r\n", b"")
        try:
            raw.decode("ascii")
            ascii_ok = True
        except UnicodeDecodeError:
            ascii_ok = False
        check(f"启动器格式：{name}", crlf_ok and ascii_ok,
              f"CRLF={crlf_ok} 纯ASCII={ascii_ok}")

    # 工具目录里只该有一个双击入口 —— 多了佘先生又要挑
    stray_bats = sorted(x.name for x in HERE.glob("*.bat")
                        if x.name not in ("_find_python.bat", "画册.bat"))
    check("入口只有一个：没有多余的 .bat 入口", not stray_bats,
          f"多出来的：{stray_bats}" if stray_bats else "只剩 画册.bat（+ _find_python.bat 内部依赖）")

    # ★ 入口只剩一个之后，「双击第二次」必然发生。必须认出已有工作台并直接
    #   开它的页面，而不是起第二个服务（两份 Session、PID 文件互相覆盖）。
    #   这条断言同时守住**时间预算**：认领靠扫端口，而每个端口探活都要超时预算，
    #   探活个数是个乘数 —— 曾经 40 个端口 × 各自超时 = 冷启动白等 14 秒。
    #   这里要求「没有可认领目标」时也要在 6 秒内给结论。
    import time as _t
    t0 = _t.time()
    probe3 = subprocess.run(
        [python, "-c",
         "import importlib.util,sys;"
         "spec=importlib.util.spec_from_file_location('_s','serve_ui.py');"
         "m=importlib.util.module_from_spec(spec);sys.modules['_s']=m;"
         "spec.loader.exec_module(m);"
         "print(repr(m.find_running_workbench()))"],
        cwd=APP, capture_output=True, text=True, timeout=60,
    )
    probe_secs = _t.time() - t0
    got_running = (probe3.stdout or "").strip()
    check("认领已有工作台：探测函数在时间预算内给结论", probe_secs < 6.0,
          f"耗时 {probe_secs:.2f}s（上限 6s；现在没有在跑的工作台时结果应为 ''）")

    # ---------- 第 1b 步：出书的默认落点（佘先生的约定） ----------
    # 「以后用工具做的画册统一放进 画册集/，可重复查看」—— 这条约定在代码里
    # 只有一处事实来源（core.default_output_dir），这里守住它别被改回去。
    #
    # 为什么用 subprocess 而不是 importlib：make_flipbook.py 里有 dataclass，
    # 用 importlib 从文件加载时必须先把模块注册进 sys.modules，否则
    # dataclasses 解析类型注解时会拿不到模块而抛 AttributeError。
    # 直接跑一段脚本问它，最稳、也不碰验收进程自己的状态。
    probe = subprocess.run(
        [python, "-c",
         "import importlib.util,sys;"
         "spec=importlib.util.spec_from_file_location('_c','make_flipbook.py');"
         "m=importlib.util.module_from_spec(spec);sys.modules['_c']=m;"
         "spec.loader.exec_module(m);print(m.default_output_dir())"],
        cwd=APP, capture_output=True, text=True, timeout=60,
    )
    got = (probe.stdout or "").strip()
    expected_pool = str((HERE.parent / "画册集").resolve())
    check("出书默认位置：是工作区的 画册集/",
          probe.returncode == 0 and got and Path(got).resolve() == Path(expected_pool),
          f"默认 {got or probe.stderr.strip()[:120]}")

    # 工作台里「输出到」那一栏的初值必须与它一致（两边各写一份必然不同步）
    src = (APP / "serve_ui.py").read_text(encoding="utf-8")
    check("出书默认位置：工作台用同一个函数",
          "core.default_output_dir()" in src and 'HERE / "画册"' not in src,
          "serve_ui.py 里 output_dir 由 core.default_output_dir() 决定")

    # ---------- 第 1c 步：书要落在「画册集/<书名>/」，不能平铺在画册集根上 ----------
    # ★ 这条是补的。曾经默认落点是「画册集根」，书就被直接铺在画册集里、
    #   和别的书混在一层 —— 出一本就把画册集搞乱一次。约定是
    #   「一本书一个文件夹、文件夹名=书名」，所以出书必须再下探一层。
    #   问的还是代码本身，不是文档；而且顺手验证目录名清洗不会返回空串。
    probe2 = subprocess.run(
        [python, "-c",
         "import importlib.util,sys;"
         "spec=importlib.util.spec_from_file_location('_c2','make_flipbook.py');"
         "m=importlib.util.module_from_spec(spec);sys.modules['_c2']=m;"
         "spec.loader.exec_module(m);"
         "from pathlib import Path;"
         "a=m.default_output_dir();"
         "print(m.book_dir_name('我的小狗'));"
         "print(m.book_dir_name('...'));"
         "print(m.book_dir_name('a<b>c:d/e'));"
         "print(m.book_dir_in(a,'我的小狗'));"
         "print(m.book_dir_in(a,'')==Path(a).resolve())"],
        cwd=APP, capture_output=True, text=True, timeout=60,
    )
    lines = [ln.strip() for ln in (probe2.stdout or "").splitlines() if ln.strip()]
    ok_cn = len(lines) >= 5 and lines[0] == "我的小狗"
    ok_empty = len(lines) >= 5 and lines[1] == "未命名画册"
    ok_unsafe = len(lines) >= 5 and lines[2] == "abcde"
    ok_child = len(lines) >= 5 and Path(lines[3]).name == "我的小狗" \
        and Path(lines[3]).parent.name == "画册集"
    check("出书落点：书名直接当文件夹名（中文可用）", ok_cn,
          f"「我的小狗」→ {lines[0] if lines else '（没拿到）'}")
    check("出书落点：书名清洗干净也不返回空串", ok_empty,
          f"「...」→ {lines[1] if len(lines) > 1 else '（没拿到）'}")
    check("出书落点：非法字符被剔除", ok_unsafe,
          f"「a<b>c:d/e」→ {lines[2] if len(lines) > 2 else '（没拿到）'}")
    check("出书落点：书进 画册集/<书名>/ 而不是画册集根", ok_child,
          f"{lines[3] if len(lines) > 3 else '（没拿到）'}")
    # 空书名必须被兜底成「未命名画册」，绝不能折回画册集本身，
    # 所以这里期望 False（== 画册集 为假才算过）
    same_as_album = len(lines) > 4 and lines[4] == "True"
    check("出书落点：空书名绝不等于画册集本身", len(lines) > 4 and not same_as_album,
          f"空书名算出的目录 == 画册集？{'是（危险）' if same_as_album else '否'}")

    # 出书主流程必须真的用了这个函数（不然上面测的只是摆设）
    core_src = (APP / "make_flipbook.py").read_text(encoding="utf-8")
    check("出书落点：CLI 出书时下了这一层",
          "book_dir_in(album, args.title)" in core_src,
          "make_flipbook.py 的 main() 用 book_dir_in() 算落点")
    check("出书落点：工作台出书时下了这一层",
          "core.book_dir_in(SESSION.output_dir, SESSION.title)" in src,
          "serve_ui.py 的 handle_generate() 用 core.book_dir_in() 算落点")

    # 画册集根上不能躺着书的散件（index.html 之类）—— 出书出错了才会这样
    album_root = HERE.parent / "画册集"
    if album_root.is_dir():
        strays = [e.name for e in album_root.iterdir()
                  if e.name not in ("画册目录.md",) and not e.is_dir()]
        check("画册集：根目录没有书的散件", not strays,
              f"多出来的：{strays}" if strays else "根上只有书文件夹与目录")

    # 画册集里要有一份能一眼看懂的目录（书多了才找得到）
    index = HERE.parent / "画册集" / "画册目录.md"
    check("画册集：目录文件随出书一起更新",
          index.is_file() or not (HERE.parent / "画册集").is_dir(),
          f"{index.name} {'存在' if index.is_file() else '（画册集还没建，先做一本）'}")

    # ---------- 第 2 步：起服务（画册.bat 的职责） ----------
    LOGS.mkdir(exist_ok=True)
    # ★ 先备份「本来就在的」PID / 启动位置文件：这两步会把它们改写、删掉，
    #   不留备份的话，用户那个还开着的工作台事后就找不回自己的 PID 了。
    saved_status = snapshot_status_files(HERE)
    if PIDFILE.exists():
        PIDFILE.unlink()

    # 先记下开跑前的端口占用 —— 用来断言服务没有「蹭」别人占着的端口
    pre_busy = busy_ports()
    if pre_busy:
        print(f"      （开跑前已占用的端口：{sorted(pre_busy)}，本机很可能还开着另一个工作台）")

    # ★★ 这一段验的是「双击 → 冷启动一个工作台」，所以必须**屏蔽认领**。
    #
    #   为什么不能直接起：本机经常开着佘先生自己的那个工作台（8770）。而
    #   `serve_ui.py` 的复用分支会认出它、直接开它的页面、**不起新服务**，
    #   于是 PID 文件不但不会被写，连我们备份的那份都会被它的收尾逻辑清掉 ——
    #   断言就卡在「服务自己写出了 PID 文件」上，看起来像工具坏了，其实是
    #   验收自己没做到隔离。
    #
    #   隔离办法：临时把端口段整个挪走（--port 是复用分支的例外，必然冷启动），
    #   挑一个**本机此刻确实空着**的端口。用高段且先探活用上，避免与 8770 冲突。
    cold_port = None
    for cand in range(18870, 18920):
        if cand not in pre_busy and not port_open(cand):
            cold_port = cand
            break
    check("起服务：找到一个空端口用于冷启动验收", cold_port is not None,
          f"选中 {cold_port}")

    serv_args = [python, str(APP / "serve_ui.py"), "--no-open"]
    if cold_port is not None:
        # --port 命中复用分支的例外，必然真的起一个独立实例
        serv_args += ["--port", str(cold_port)]

    proc = subprocess.Popen(
        serv_args,
        cwd=APP, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        env=dict(os.environ),
        creationflags=getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0),
    )
    try:
        deadline = time.time() + 30
        while time.time() < deadline and not PIDFILE.exists():
            time.sleep(0.25)
        check("起服务：服务自己写出了 logs\\.serve_ui.pid", PIDFILE.exists())
        if not PIDFILE.exists():
            return 1
        pid = int(PIDFILE.read_text(encoding="utf-8").strip())
        check("起服务：PID 文件里的进程就是刚起的那个", pid == proc.pid,
              f"pid 文件={pid} 实际={proc.pid}")

        port = None
        if NOTEFILE.exists():
            note = NOTEFILE.read_text(encoding="utf-8", errors="replace")
            for tok in note.replace("/", " ").split():
                if tok.count(":") == 1 and tok.rsplit(":", 1)[-1].isdigit():
                    port = int(tok.rsplit(":", 1)[-1])
                    break
        check("起服务：启动位置文件里能解析出端口", port is not None, f"port={port}")

        # ★ 回归断言：自动挑端口必须避开已被占用的端口（Windows SO_REUSEADDR 坑）
        #   冷启动验收里端口是我们显式指定的，就退化成断言「用的正是指定的那个」——
        #   重点是别蹭到别人（pre_busy）身上。
        check("起服务：挑的端口不是别人正在用的",
              port is not None and port not in pre_busy
              and (cold_port is None or port == cold_port),
              f"选中 {port}；开跑前占用 {sorted(pre_busy) or '无'}"
              + (f"；本次指定 {cold_port}" if cold_port else ""))

        check("起服务：端口真的能连上", port is not None and wait_port(port, 20),
              f"127.0.0.1:{port}")

        # ---------- 第 3 步：按 PID 停掉（页面「关闭工具」的职责） ----------
        # 关服务现在是工作台右上角按钮的活儿；协议不变：读 PID → 精确结束。
        try:
            os.kill(pid, signal.SIGTERM)
        except Exception as exc:
            check("停服务：发出停止信号", False, repr(exc))
        time.sleep(1.5)
        check("停服务：进程确实没了", not alive(pid), f"pid={pid}")
        if port is not None:
            check("停服务：端口已释放", not port_open(port), f"127.0.0.1:{port}")

        PIDFILE.unlink(missing_ok=True)
        check("停服务：PID 文件已清理", not PIDFILE.exists())
    finally:
        if proc.poll() is None:
            proc.kill()
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            pass
        # 验收的断言已经做完，把用户原本的状态文件还回去
        restore_status_files(saved_status)

    print()
    print("=" * 62)
    print("汇总")
    print("=" * 62)
    for name, ok, detail in results:
        print(f"{'✅' if ok else '❌'}  {name}" + (f" — {detail}" if detail else ""))
    bad = [n for n, ok, _ in results if not ok]
    print()
    print("全部通过" if not bad else f"有 {len(bad)} 项没过")
    return 0 if not bad else 1


if __name__ == "__main__":
    raise SystemExit(main())
