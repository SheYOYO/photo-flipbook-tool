#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""失败路径自测：确认工具在异常输入下不崩、给可读提示、写日志。

每条用例都在一个临时目录里跑，不碰用户的真实照片。
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import traceback
from pathlib import Path

HERE = Path(__file__).resolve().parent
PY = sys.executable
TOOL = HERE / "make_flipbook.py"
# 源照片目录：默认取「本机桌面 / 3D画册2.0 / 图片」。
# ★ 用 Path.home() 拼、不写死用户名 —— 换机器只需改这一行，仓库里也不留本机账号痕迹。
SRC = Path.home() / "Desktop" / "3D画册2.0" / "图片"

results: list[tuple[str, str, str]] = []


def run_tool(source: Path, out: Path, extra: list[str] | None = None) -> tuple[int, str]:
    """跑一次出书。

    ★ 固定加 `--flat`：`-o` 的语义是「画册集」（书会进它下面的书名子文件夹），
      而这一层测的是**出书本身对不对**（页数、图版、失败路径），不是目录约定。
      `--flat` 让书直接落在 `out` 里，断言「书就在 out 下」才写得干净。
      目录约定有专门的验收：verify_shortcut.py 与 verify_ui.mjs 里的 6b。
    """
    env = dict(os.environ)
    for key in list(env):
        if "PROXY" in key.upper():
            env.pop(key, None)
    env["NO_PROXY"] = "*"
    proc = subprocess.run(
        [PY, str(TOOL), str(source), "-o", str(out), "--flat", "--no-open", *(extra or [])],
        capture_output=True,
        timeout=300,
        cwd=str(HERE),
        env=env,
    )
    text = (proc.stdout or b"").decode("utf-8", "replace")
    text += (proc.stderr or b"").decode("utf-8", "replace")
    return proc.returncode, text


def check(name: str, expect_ok: bool, rc: int, text: str, must_contain: str = "") -> None:
    ok = (rc == 0) if expect_ok else (rc != 0)
    if must_contain and must_contain not in text:
        ok = False
    # 失败路径还要求：不许出现原始栈回溯
    if not expect_ok and "Traceback (most recent call last)" in text:
        ok = False
    verdict = "通过" if ok else "失败"
    results.append((name, verdict, text.strip().splitlines()[-1] if text.strip() else "(无输出)"))


# --------------------------------------------------------------------------
# 跨页配对回归（第三十六轮：一次放很多张照片时「跨页只有一面有图」）
# --------------------------------------------------------------------------


def _load_engine():
    """把 make_flipbook.py 当模块加载进来，用来直接检查排好的页序。

    ★ 必须先注册进 sys.modules 再 exec_module —— 它在 dataclass 装饰器里
      会用模块命名空间解析类型注解，不注册会 AttributeError。
    """

    import importlib.util

    spec = importlib.util.spec_from_file_location("flipbook_engine", TOOL)
    module = importlib.util.module_from_spec(spec)
    sys.modules["flipbook_engine"] = module
    spec.loader.exec_module(module)
    return module


def _fake_photos(module, count: int, landscape_at: set[int]):
    from pathlib import Path as _P

    photos = []
    for i in range(count):
        photo = module.Photo(path=_P("x") / f"{i:03d}.jpg", order=i)
        if i in landscape_at:
            photo.orientation = "landscape"
        photos.append(photo)
    return photos


def _audit_spreads(pages, photo_count: int, landscape_count: int) -> list[str]:
    """检查排好的页序，返回问题清单（空 = 全对）。

    ★★★ 判据必须写在中「读者坐标系」里（2026-09-24 第六版定稿）
    ==========================================================
    **读者跨页 ≠ 文件里的 (2k, 2k+1)。**
      每张纸 = `(2k, 2k+1)`（正面/背面），那是**装订单位**；
      读者翻开看到的跨页 = 「上一张纸的背面 + 这张纸的正面」= `(2k+1, 2k+2)`，
      也就是 `(1,2), (3,4), (5,6) …`；第 0 页封面单独显示。
      实测见 `_probe_t.mjs`（Playwright 真翻页）：
          turnToPage(1) → [扉页(1), 照片(2)]   turnToPage(3) → [照片(3), 照片(4)]

    ★ 前五版判据写在**错坐标系**里（拿 `(2k, 2k+1)` 当跨页），所以在
      `solo`（照片 + 留白）上完全看不出问题 —— 换到读者坐标系，
      那正是「一面有图、一面白纸」，也就是用户报的毛病。
      **坐标系错了，判据写得再细也没用。**

    当前版式（`build_page_sequence`）：封面 → 照片 1..N → 版权页 → 封底，
    总页数 T = N + 3。不变量（读者坐标系）：

      · 照片落在页位 1..N 连续区间上 → 与读者跨页 (1,2),(3,4)… 天然对齐。
      · **每个两页跨页照片数是 2**，唯一的例外是**最后一个两页跨页**：
          - T 为奇数（N 为偶数）→ 该跨页 = [版权页, 封底]，0 张照片；
          - T 为偶数（N 为奇数）→ 该跨页 = [照片, 版权页]，1 张照片。
        两种情形都**不允许**出现「双面无内容」的跨页。
      · ★★★ **绝不允许「两面都没有内容」的跨页** —— 那是用户报的空白页。
      · 页上照片总数 = photo_count，不丢不重。
    """

    problems: list[str] = []
    total = len(pages)
    N = photo_count

    hard = [i for i, p in enumerate(pages) if p["density"] == "hard"]
    if hard != [0, total - 1]:
        problems.append(f"硬封面位置不对：{hard}（应为 [0, {total - 1}]）")
    if pages and pages[-1]["kind"] != "backcover":
        problems.append(f"末页不是封底，而是 {pages[-1]['kind']}")

    # ---- 按**读者视角**切跨页： [0] 单独，(1,2),(3,4),…，末页可能单独 ----
    spreads: list[list[int]] = [[0]] if total else []
    i = 1
    while i < total:
        if i + 1 < total:
            spreads.append([i, i + 1])
            i += 2
        else:
            spreads.append([i])
            i += 1

    two_page = [sp for sp in spreads if len(sp) == 2]
    for sp in two_page:
        kinds = [pages[k]["kind"] for k in sp]
        cnt = sum(1 for k in kinds if k == "plate")
        is_last = sp is two_page[-1]

        if cnt == 2:
            continue

        if all(k in ("blank", "endpaper") for k in kinds):
            # ★★★ 主 bug 判据
            problems.append(f"★★ 页位 {sp} 两面全空：{kinds}")
            continue

        if not is_last:
            problems.append(f"中途冒出非双图跨页 页位 {sp}：{kinds}（图数 {cnt}）")
        elif total % 2 == 1:
            # N 为偶数 → 最后一跨页应是 [版权页, 封底]
            if sorted(kinds) != ["backcover", "colophon"]:
                problems.append(f"末跨页应为 [版权页, 封底]，实际 {sp}：{kinds}")
        else:
            # N 为奇数 → 最后一跨页应是 [照片, 版权页]
            if not (cnt == 1 and kinds[0] == "plate" and "colophon" in kinds):
                problems.append(f"末跨页应为 [照片, 版权页]，实际 {sp}：{kinds}")

    names = [p["photo"].name for p in pages if p["kind"] == "plate"]
    if len(names) != N or len(set(names)) != N:
        problems.append(f"照片不齐：{len(names)} 张 / 去重后 {len(set(names))} 张")

    return problems



def check_spreads() -> None:
    """多种张数 × 多种构图组合下，跨页配对都必须成立。

    ★ 覆盖 1~24 每一种张数（含奇数、含边界 1 张）+ 若干大张数，
      以及全横构图、全竖构图、随机混合三类构图分布。
      这是「一次放很多张照片也不会出错」这条要求的**可执行凭证**。
    """

    import random

    try:
        engine = _load_engine()
    except Exception:
        results.append(("跨页配对 引擎加载", "失败", traceback.format_exc().splitlines()[-1]))
        return

    random.seed(20260923)
    cases: list[tuple[int, tuple[int, ...]]] = []

    for n in range(1, 25):
        cases.append((n, ()))
    for n in (30, 40, 50, 64, 99, 100, 101, 120, 150, 200):
        cases.append((n, ()))
    for n in (4, 7, 10, 21, 30, 50, 100, 101):
        for _ in range(3):
            picks = sorted(random.sample(range(n), max(1, n // 5)))
            cases.append((n, tuple(picks)))
    cases += [
        (1, (0,)),
        (2, (0, 1)),
        (5, (0, 1, 2, 3, 4)),
        (9, (0, 2, 4, 6, 8)),
        (9, (1, 3, 5, 7)),
        (30, tuple(range(0, 30, 2))),
    ]

    bad: list[str] = []
    for count, landscapes in cases:
        photos = _fake_photos(engine, count, set(landscapes))
        pages = engine.build_page_sequence(photos)
        problems = _audit_spreads(pages, count, len(landscapes))
        if problems:
            bad.append(f"{count} 张(横{len(landscapes)})：{problems[0]}")

    label = "跨页配对回归"
    if bad:
        results.append((label, "失败", f"{len(bad)}/{len(cases)} 组不合格 ← {bad[0]}"))
        for line in bad[:5]:
            results.append(("  └", "失败", line))
    else:
        # 顺带把最有代表性的一档拎出来放进摘要，便于人工核对
        hundred = engine.build_page_sequence(_fake_photos(engine, 100, set()))
        dist: dict[int, int] = {}
        for k in range(0, len(hundred), 2):
            c = sum(1 for q in hundred[k : k + 2] if q["kind"] == "plate")
            dist[c] = dist.get(c, 0) + 1
        results.append(
            (
                label,
                "通过",
                f"{len(cases)} 组（1~24 全张数 + 大张数 + 横构图混合）；"
                f"100 张 → {len(hundred)} 页，跨页分布 {dict(sorted(dist.items()))}",
            )
        )


def main() -> int:
    tmp = Path(tempfile.mkdtemp(prefix="flipbook-selftest-"))
    print(f"临时目录：{tmp}\n")

    # --- 失败路径 1：不存在的目录
    try:
        rc, text = run_tool(tmp / "根本不存在的目录", tmp / "o1")
        check("失败1 目录不存在", False, rc, text, "不是文件夹")
    except Exception:
        results.append(("失败1 目录不存在", "失败", traceback.format_exc().splitlines()[-1]))

    # --- 失败路径 2：空目录
    empty = tmp / "空目录"
    empty.mkdir(parents=True, exist_ok=True)
    rc, text = run_tool(empty, tmp / "o2")
    check("失败2 空目录", False, rc, text, "没有找到任何图片")

    # --- 失败路径 3：只有非图片文件
    nonimg = tmp / "只有文档"
    nonimg.mkdir(parents=True, exist_ok=True)
    (nonimg / "readme.txt").write_text("hello", encoding="utf-8")
    (nonimg / "data.csv").write_text("a,b\n1,2", encoding="utf-8")
    rc, text = run_tool(nonimg, tmp / "o3")
    check("失败3 只有非图片", False, rc, text, "没有找到任何图片")

    # --- 失败路径 4：损坏的图片文件（扩展名是 jpg，内容是垃圾）
    broken = tmp / "损坏图片"
    broken.mkdir(parents=True, exist_ok=True)
    (broken / "broken.jpg").write_bytes(b"this is definitely not a jpeg file" * 100)
    rc, text = run_tool(broken, tmp / "o4")
    check("失败4 损坏图片", False, rc, text, "读不了")

    # --- 失败路径 5：混入一张坏图 + 一张好图（应跳过坏图继续做）
    mixed = tmp / "好坏混合"
    mixed.mkdir(parents=True, exist_ok=True)
    (mixed / "坏图.jpg").write_bytes(b"garbage" * 500)
    good = sorted(SRC.glob("*.jpg"))[:2]
    for g in good:
        shutil.copy2(g, mixed / g.name)
    rc, text = run_tool(mixed, tmp / "o5")
    check("失败5 坏图+好图应跳过坏图继续", True, rc, text, "跳过")

    # --- 失败路径 6：输出目录指向一个已存在的文件
    # run_tool 已固定带 --flat，所以这里 -o 指向的就是书的落点本身，
    # 正好走到「输出位置被一个同名文件占用」这条检查
    blocker = tmp / "占用名"
    blocker.write_text("i am a file", encoding="utf-8")
    rc, text = run_tool(SRC, blocker)
    check("失败6 输出路径被文件占用", False, rc, text)

    # --- 失败路径 7：缺少 runtime 目录
    fake = tmp / "假工具"
    fake.mkdir(parents=True, exist_ok=True)
    shutil.copy2(TOOL, fake / "make_flipbook.py")
    proc = subprocess.run(
        [PY, str(fake / "make_flipbook.py"), str(SRC), "-o", str(tmp / "o7"),
         "--flat", "--no-open"],
        capture_output=True,
        timeout=300,
        cwd=str(fake),
    )
    text7 = (proc.stdout or b"").decode("utf-8", "replace") + (proc.stderr or b"").decode("utf-8", "replace")
    check("失败7 runtime 缺失", False, proc.returncode, text7, "找不到内置运行时目录")

    # --- 成功路径 A：真实照片，默认排版
    rc, text = run_tool(SRC, tmp / "ok-default")
    check("成功A 真实照片默认排版", True, rc, text, "完成！")
    pages_a = 0
    if rc == 0:
        html = (tmp / "ok-default" / "index.html").read_text(encoding="utf-8")
        pages_a = html.count('class="book-page')
        # ★ 页数账（读者坐标系定稿版式）：封面 + 照片… + 版权页 + 封底
        #   → 总页数 = 照片页数 + 2（照片页数含封面那张照片）
        #   ⚠ 原来这里断言「4 的倍数」，那是**错设的假设** —— 库里没有任何
        #     %2/%4 校验，实测 102/103 页都能正常翻（见 _probe_t.mjs）。
        photo_pages = html.count('art-page photo')
        ok4 = pages_a == photo_pages + 2
        results.append(("成功A 页数 = 照片页 + 2", "通过" if ok4 else "失败",
                        f"{pages_a} 页 / 照片页 {photo_pages}"))

    # --- 成功路径 B：单张照片（最小规模）
    one = tmp / "单张"
    one.mkdir(parents=True, exist_ok=True)
    shutil.copy2(sorted(SRC.glob("*.jpg"))[0], one / "solo.jpg")
    rc, text = run_tool(one, tmp / "ok-one")
    check("成功B 只有一张照片", True, rc, text, "完成！")

    # --- 成功路径 C：两张照片
    two = tmp / "两张"
    two.mkdir(parents=True, exist_ok=True)
    for g in sorted(SRC.glob("*.jpg"))[:2]:
        shutil.copy2(g, two / g.name)
    rc, text = run_tool(two, tmp / "ok-two")
    check("成功C 只有两张照片", True, rc, text, "完成！")

    # --- 成功路径 D：中文路径 + 中文文件名
    zh = tmp / "中文目录 测试" / "我的 照片集"
    zh.mkdir(parents=True, exist_ok=True)
    for i, g in enumerate(sorted(SRC.glob("*.jpg"))[:3], 1):
        shutil.copy2(g, zh / f"狗狗照片{i}.jpg")
    rc, text = run_tool(zh, tmp / "ok-zh")
    check("成功D 中文路径与中文文件名", True, rc, text, "完成！")

    # --- 成功路径 E：重复运行同一输出目录（覆盖旧产物）
    rc1, _ = run_tool(SRC, tmp / "ok-rerun")
    rc2, text2 = run_tool(SRC, tmp / "ok-rerun")
    check("成功E 重复生成覆盖旧产物", True, rc2, text2, "完成！")

    # --- 成功路径 F：目录里混有非图片文件
    withtxt = tmp / "含杂项"
    withtxt.mkdir(parents=True, exist_ok=True)
    for g in sorted(SRC.glob("*.jpg"))[:3]:
        shutil.copy2(g, withtxt / g.name)
    (withtxt / "说明.txt").write_text("these are my photos", encoding="utf-8")
    (withtxt / "album.psd").write_bytes(b"8BPS" + b"\x00" * 100)
    rc, text = run_tool(withtxt, tmp / "ok-mixed")
    check("成功F 混有txt/psd等非图片", True, rc, text, "完成！")

    # --- 成功路径 G：一次放很多张照片（100 张，佘先生报障的场景）
    many = tmp / "一百张"
    many.mkdir(parents=True, exist_ok=True)
    pool = sorted(SRC.glob("*.jpg"))
    for i in range(100):
        src = pool[i % len(pool)]
        shutil.copy2(src, many / f"{i:03d}-{src.name}")
    rc, text = run_tool(many, tmp / "ok-many")
    check("成功G 一次放 100 张照片", True, rc, text, "完成！")
    if rc == 0:
        plan = json.loads((tmp / "ok-many" / "book-plan.json").read_text(encoding="utf-8"))
        # 末页必须是封底（补白页不能顶掉封底）
        last = plan["pages"][-1]
        results.append(
            (
                "成功G 末页是封底",
                "通过" if last["kind"] == "backcover" else "失败",
                f"末页 kind = {last['kind']}",
            )
        )
        results.append(
            (
                "成功G 页数 = 照片数 + 3",
                "通过" if plan["page_count"] == len(plan["photos"]) + 3 else "失败",
                f"{plan['page_count']} 页 / {len(plan['photos'])} 张照片",
            )
        )

    # --- 成功路径 H：阅读器带「点页码跳页」控件（Phase 19）
    #     佘先生：「我在查看画册时只能一页一页地看，不方便，要求可以选择页数，
    #     就点击页数就可以输入页数」。
    #     这里守两件**结构上**的事（真实的点/输/跳行为由 verify_book_ui.mjs
    #     的成品层在浏览器里守）：
    #       1. 生成的 HTML 里有 #page-jump / #page-input，并且 #page-status
    #          **仍然在那个按钮里** —— 它是既有验收读的元素，不能被挤掉；
    #       2. 页角印的页码 = 页位 + 1，与状态条 "12 / 103" 同一套账。
    #          （做跳页时才发现的真 bug：原来印的是 0 起算的页位，
    #           于是同一跨页上页角写 "5"、状态条写 "06"，
    #           用户照着页角输入页码会**差一页**。）
    jump_src = tmp / "跳页三张"
    jump_src.mkdir(parents=True, exist_ok=True)
    for i in range(3):
        src = pool[i % len(pool)]
        shutil.copy2(src, jump_src / f"j{i:02d}-{src.name}")
    rc, text = run_tool(jump_src, tmp / "ok-jump")
    check("成功H 带跳页控件的出书", True, rc, text, "完成！")
    if rc == 0:
        html = (tmp / "ok-jump" / "index.html").read_text(encoding="utf-8")
        has_btn = 'id="page-jump"' in html
        has_input = 'id="page-input"' in html
        status_inside = bool(
            re.search(r'<button[^>]*id="page-jump"[^>]*>\s*<span id="page-status"', html, re.S)
        )
        results.append(
            (
                "成功H 跳页控件齐备",
                "通过" if (has_btn and has_input and status_inside) else "失败",
                f"#page-jump={has_btn} #page-input={has_input} 页码仍在按钮里={status_inside}",
            )
        )
        arts = re.findall(r"<article\b[^>]*>.*?</article>", html, re.S)
        printed = [
            (i, m.group(1).strip())
            for i, a in enumerate(arts)
            if (m := re.search(r'<p class="folio">\s*([^<]*?)\s*</p>', a))
        ]
        wrong = [(i, v) for i, v in printed if v != str(i + 1)]
        results.append(
            (
                "成功H 页角页码 = 页位+1",
                "通过" if (len(printed) == len(arts) - 2 and not wrong) else "失败",
                f"{len(printed)} 个印号 / 共 {len(arts)} 页（封面封底不印）；不符：{wrong or '无'}",
            )
        )

        # --- 成功路径 I：阅读器带「自动翻页」开关（Phase 20）
        #     佘先生：「再新增一个自动翻页的功能，该功能手动打开」。
        #     「手动打开」= **默认必须是关的**。这里守两件**结构上**的事
        #     （真实的开、停、手一碰就让位、到头自停、末页重播，
        #       都由 verify_book_ui.mjs 拿真浏览器守）：
        #       1. 出书的 HTML 里有 #page-auto，且初始就是"未播放"态
        #          —— aria-pressed="false"，按钮文案是未播放文案，
        #          另备一份播放中的文案（data-stop-label / data-stop-title）；
        #       2. flipbook.js 里那套逻辑还在，尤其是"到头"必须**问库的跨页索引**
        #          （getSpreadIndexByPage）—— 我第一版写成「页位 >= 总页数 - 1」，
        #          横屏下 101 >= 102 永不为真，于是末页一直空转不肯停。
        auto_btn = 'id="page-auto"' in html
        auto_off = 'aria-pressed="false"' in html
        auto_stop_text = ("data-stop-label" in html and "data-stop-title" in html)
        results.append(
            (
                "成功I 自动翻页控件齐备",
                "通过" if (auto_btn and auto_off and auto_stop_text) else "失败",
                f"#page-auto={auto_btn} 初始未播放={auto_off} 停止文案齐={auto_stop_text}",
            )
        )
        js_file = tmp / "ok-jump" / "flipbook.js"
        code = js_file.read_text(encoding="utf-8") if js_file.is_file() else ""
        need = {
            "间隔常量": "AUTO_FLIP_INTERVAL_MS = 5000" in code,
            "到头判据问库": "getSpreadIndexByPage" in code,
            "到头判据函数": "function atLastSpread" in code,
            "自测句柄": "window.__auto" in code,
            "手势即停": "stopAuto()" in code,
        }
        results.append(
            (
                "成功I 自动翻页逻辑在位",
                "通过" if all(need.values()) else "失败",
                " ".join(f"{k}={'有' if v else '缺'}" for k, v in need.items()),
            )
        )

        # --- 成功M/N：自动翻页调速（Phase 23 / 26）
        #     佘先生：「最快是两秒一页，最慢是十秒一页，每增加一档速度翻页
        #     就每页增加一秒」⇒ 最初是 2~10 共 9 档；
        #     Phase 26 他又说「自动翻页的速度增加一个一秒一页为最快」⇒ 补上 1 秒档，
        #     现在是 1~10 共 **10 档**；**默认仍是 5 秒**，也就是原来的行为，原功能不变。
        speed_sel = 'id="page-auto-speed"' in html
        opts = re.findall(r'<option value="(\d+)"([^>]*)>', html)
        values = [int(v) for v, _attr in opts]
        ten = values == list(range(1, 11))
        default_five = any(v == "5" and "selected" in attr for v, attr in opts)
        results.append(
            (
                "成功M 调速控件 1~10 秒共 10 档",
                "通过" if (speed_sel and ten and default_five) else "失败",
                f"控件={speed_sel} 档位={values} 默认5秒={default_five}",
            )
        )
        speed_need = {
            "读了控件": "readSpeedSeconds" in code,
            "有下限": "AUTO_SPEED_MIN_S = 1" in code,
            "有上限": "AUTO_SPEED_MAX_S = 10" in code,
            "改档立即生效": "applySpeedFromSelect" in code,
            "提示语秒数会跟着变": '{n}' in html and 'includes("{n}")' in code,
        }
        results.append(
            (
                "成功N 调速逻辑在位",
                "通过" if all(speed_need.values()) else "失败",
                " ".join(f"{k}={'有' if v else '缺'}" for k, v in speed_need.items()),
            )
        )

        # --- 成功O：封面文案可配置（Phase 24）
        #     佘先生：「增加封面预览编辑功能，要可以调文案的位置和大小颜色和字体等」。
        #     核心层只守「结构 + 白名单」这三件：
        #       1. **默认一个字不改** —— 没配置时封面上不许出现 style 属性。
        #          这是"原功能不变"的机器判据：属性一冒出来，就说明默认态被动过了。
        #       2. CSS 侧的开关都在，且每个 `var(--ct-*, X)` 的 X = 改之前的字面量。
        #          少一个回退值、或回退值写成别的数，默认渲染就悄悄变了。
        #       3. 白名单真的在挡脏数据（越界夹回边界、颜色注入丢弃、不认识的全丢）。
        #     真实的"调了滑块封面就跟着动"由成品层拿真浏览器守（verify_book_ui.mjs）。
        eng = _load_engine()
        cov_tags = [a for a in re.findall(r"<article\b[^>]*>", html) if 'aria-label="封面"' in a]
        styled = sum("style=" in a for a in cov_tags)
        results.append(
            (
                "成功O 默认封面不写 style（默认态未变）",
                "通过" if (cov_tags and styled == 0) else "失败",
                f"封面 article {len(cov_tags)} 个，写 style 的 {styled} 个",
            )
        )

        css_file = HERE / "runtime" / "style" / "book-style.css"
        cover_css = css_file.read_text(encoding="utf-8") if css_file.is_file() else ""
        css_need = {
            "标题左": "left:var(--ct-title-x,13.5%)" in cover_css,
            "标题上": "top:var(--ct-title-y,15%)" in cover_css,
            "标题字号": "font-size:var(--ct-title-size,7.2cqw)" in cover_css,
            "副标题上": "top:var(--ct-subtitle-y,33%)" in cover_css,
            "副标题字号": "font-size:var(--ct-subtitle-size,2.1cqw)" in cover_css,
            "页脚下边距": "bottom:var(--ct-foot-y,7%)" in cover_css,
            "页脚字号": "font-size:var(--ct-foot-size,1.6cqw)" in cover_css,
            "对齐回退 start": "text-align:var(--ct-title-align,start)" in cover_css,
            "照片封面色走变量": "color:var(--ct-title-color,#f7f6f0)" in cover_css,
            # Phase 26：宽度与隐藏两个新开关，回退值必须还是"没有这两个开关时"的样子
            # （auto = 由 left/right 决定宽度；block = 元素本来的 display）。
            "标题宽度开关": "width:var(--ct-title-w,auto)" in cover_css,
            "副标题宽度开关": "width:var(--ct-subtitle-w,auto)" in cover_css,
            "页脚宽度开关": "width:var(--ct-foot-w,auto)" in cover_css,
            "标题隐藏开关": "display:var(--ct-title-display,block)" in cover_css,
            "页脚隐藏开关": "display:var(--ct-foot-display,block)" in cover_css,
            # 自定义框的默认墨色挂在**页面级**变量上：键名是动态的，
            # CSS 里没法为每个键各写一条默认色。
            "自定义框墨色（照片封面）": "--cover-extra-ink:#f7f6f0" in cover_css,
            "自定义框通用的规则": ".art-page .cover-extra{" in cover_css,
        }
        results.append(
            (
                "成功O 封面文案 CSS 开关齐备且回退=旧值",
                "通过" if all(css_need.values()) else "失败",
                " ".join(f"{k}={'有' if v else '缺'}" for k, v in css_need.items()),
            )
        )

        bad = []
        if eng.normalize_cover_text({"title": {"x": 999}}) != {"title": {"x": 100.0}}:
            bad.append("越界没夹回")
        if eng.normalize_cover_text({"title": {"color": "url(x)"}}) != {}:
            bad.append("颜色注入没挡住")
        if eng.normalize_cover_text({"title": {"x": float("nan")}}) != {}:
            bad.append("NaN 没丢")
        if eng.normalize_cover_text({"cover": {"x": 1}, "foot": 3}) != {}:
            bad.append("不认识的东西没丢")
        if eng.cover_text_style({}) != "":
            bad.append("空配置没返回空串")
        style_probe = eng.cover_text_style({"title": {"x": 20, "size": 9, "align": "center"}})
        if ("--ct-title-x:20%" not in style_probe
                or "--ct-title-size:9cqw" not in style_probe
                or "--ct-title-shift:translateX(-50%)" not in style_probe
                or "--ct-title-r:auto" not in style_probe):
            bad.append("样式串映射不对")
        # ★ 居中/居右**绝不能**把右边距镜像成 x —— x>50 时 left+right 会把宽度算成 0，
        #   文字整条消失；而 text-align 照样算"居中"，只看对齐值的自测会全绿放过。
        #   这里直接钉住这个坑。
        mirror = eng.cover_text_style({"title": {"x": 80, "align": "center"}})
        if "--ct-title-r:80%" in mirror:
            bad.append("居中把右边距镜像成 x（会宽 0）")
        results.append(
            (
                "成功O 封面配置白名单",
                "通过" if not bad else "失败",
                "白名单全部生效" if not bad else "；".join(bad),
            )
        )

        # --- 成功P：预览页的包装类名**不许**和产品 CSS 撞名（Phase 24 真踩过）
        #
        #     事故：预览页引的是产品那套 styles.css（这是故意的 —— 预览必须与出书同源），
        #     结果包装层我顺手叫了 `.stage`，而 styles.css 里本来就有
        #     `.stage{display:grid;place-items:center;padding:16px 0}`。
        #     两条规则一起生效 ⇒ 封面变成网格项、宽度按 fit-content 收缩；
        #     封面内部又全是绝对定位 + `container-type:inline-size`（定宽不看内容）
        #     ⇒ **封面宽度算成 0px**，`cqw` 字号全变 0。
        #     用户看到的是「一个完全空白的预览框」，而字号/位置怎么拖都没反应。
        #
        #     浏览器里实测：`.stage` 755×32（32 = 产品的 padding 16px×2）、
        #     `.art-page` 计算宽度 0px。截图 `.ui-shots/_diag-cover-panel.png`。
        #
        #     这里用**静态文本**守：把预览页自己那段 <style> 里的类名全抠出来，
        #     逐个到产品 CSS 里找同名选择器，找到就是红。
        #     不依赖浏览器、不依赖服务端状态，改坏了立刻红。
        serve_src = (HERE / "serve_ui.py").read_text(encoding="utf-8")
        # 主窗口的脚本也要读：成功R 要拿它的 COVER_Y_LABEL 跟 CSS 对账。
        app_js = (HERE / "ui" / "app.js").read_text(encoding="utf-8")
        m_style = re.search(r"<style>\s*(.*?)</style>", serve_src, re.S)
        preview_css = m_style.group(1) if m_style else ""
        # Phase 25 起，预览页还会注入编辑器的 CSS / JS（`?edit=1`）。
        # 它们是**同一份文档里的**样式与脚本，所以同一条铁律也要管到。
        m_edit_css = re.search(r'COVER_EDITOR_CSS = """(.*?)"""', serve_src, re.S)
        editor_css = m_edit_css.group(1) if m_edit_css else ""
        m_edit_js = re.search(r'COVER_EDITOR_JS = """(.*?)"""', serve_src, re.S)
        editor_js = m_edit_js.group(1) if m_edit_js else ""
        prod_css = ((HERE / "runtime" / "styles.css").read_text(encoding="utf-8")
                    + (HERE / "runtime" / "style" / "book-style.css").read_text(encoding="utf-8"))

        def _classes(css: str) -> list[str]:
            """抠出 `.xxx` 形式的**选择器**类名。

            两个坑，都是这条判据自己踩出来的：
              1. 注释要先剥 —— 注释里提到「styles.css」会被误当成类名 `css`（假红）；
              2. 要求处在选择器位置（前面不能是字母/数字/`/`）—— `styles.css` 里的
                 `.css` 前面是 `s`，这样就被排除了。
            """
            body = re.sub(r"/\*.*?\*/", "", css, flags=re.S)
            return sorted(set(re.findall(r"(?<![\w/.])\.([A-Za-z][\w-]*)", body)))

        # 编辑器 JS 里写死的类名（`className = 'x'` / `classList.add('x')`）。
        # 这些不是 CSS 选择器，扫不到，所以单独抠出来 —— 铁律的另一半在 JS 里。
        js_classes = sorted(set(
            re.findall(r"className\s*=\s*'([^']+)'", editor_js)
            + re.findall(r"classList\.(?:add|remove|toggle)\(\s*'([^']+)'", editor_js)
        ))

        preview_classes = _classes(preview_css)
        editor_classes = _classes(editor_css)
        clashes = [c for c in (preview_classes + editor_classes)
                   if re.search(r"\." + re.escape(c) + r"\b", prod_css)]
        not_prefixed = [c for c in js_classes if not c.startswith("cve-")]
        # ★ 负向自证：这条判据必须**真的抓得住**已知会撞名的 `.stage`。
        #   抓不住说明它是个空判据（比如正则写残了），此时应当红而不是绿。
        detector_works = "stage" in [c for c in _classes(".stage {{ width: 10px; }}")
                                     if re.search(r"\.stage\b", prod_css)]
        results.append(
            (
                "成功P 预览/编辑器的类名不撞产品 CSS 且带 cve- 前缀",
                "通过" if (preview_classes and editor_classes and js_classes
                           and not clashes and not not_prefixed and detector_works) else "失败",
                f"预览类 {preview_classes}；编辑器类 {editor_classes}；"
                f"JS 写死类 {js_classes}；撞名 {clashes or '无'}；"
                f"缺 cve- 前缀 {not_prefixed or '无'}；判据可抓住 .stage={detector_works}",
            )
        )

        # --- 成功Q：编辑窗口的样式**只有一份来源**（Phase 25）
        #
        #     佘先生（2026-09-25）：「把封面文案样式那里改成点击唤起编辑封面的窗口，
        #     窗口处要可以移动文字框，编辑文字的大小、字体、颜色，
        #     然后点击确定后返回工具的主窗口」。
        #
        #     ★ 弹窗编辑器最容易长成"前端自己再拼一套 CSS 变量"（字号 cqw、字体族、
        #       对齐的 translateX…）。那就成了**两份映射要人肉同步**，迟早跑偏；
        #       而那种跑偏只有"拿真浏览器逐项量计算样式"才抓得住，改起来还特别隐蔽。
        #     定规：**除拖动外，样式串一律由服务端给**（`/api/cover` 回包的 `coverStyle`）。
        #     拖动中只许就地改那几个**纯数值**变量（Phase 26 起是 x/y/w/size 四个：
        #     挪位置改 x/y，拖角缩放改 w/size），松手立刻由服务端串覆盖。
        #
        #     这条判据静态钉住它 —— 不依赖浏览器、不依赖服务端状态。
        q_js = re.sub(r"/\*.*?\*/", "", editor_js, flags=re.S)
        q_js = re.sub(r"//[^\n]*", "", q_js)          # 注释里提到变量名不算违规
        q_bad = []
        if '"coverStyle"' not in serve_src:
            q_bad.append("回包里没有 coverStyle 字段")
        if "core.cover_text_style(" not in serve_src:
            q_bad.append("回包没用 core.cover_text_style() 去算")
        if "setStyle" not in q_js:
            q_bad.append("编辑器没有 setStyle 接口")
        # ★★ 2026-09-25 判据修正（Phase 26）：黑名单 → 白名单 ★★
        #
        #   原来写的是「`-family/-align/-color/-size/-style` 一个都不许出现在前端」。
        #   Phase 26 加了"拖右下角缩放手柄"之后这条开始红 —— 而红的原因是**判据写窄了**：
        #   缩放必须让**宽度和字号同时跟手**，否则拖的时候框在变、字不动（松手才跳一下），
        #   那不叫缩放。而 x/y 当初被放行，凭的就是"拖动要跟手"这同一条理由。
        #   ⇒ 允许的**拖动变量**从 {x,y} 扩到 {x,y,w,size}，四者都是**纯数值 + 单位**
        #     的直接写入（`x.toFixed(3)+'%'`），不是"值 → CSS 声明"的映射表。
        #
        #   同时把判据机制**换强**：改成列全"编辑器写过的每一个变量"，
        #   要求 ⊆ {x,y,w,size}。黑名单是漏的（以后偷偷加个 `--ct-x1-shadow`
        #   照样全绿），白名单不漏。真正算"第二份映射"的四项
        #   （字体族 / 对齐的 translateX / 颜色 / 斜体）照旧一个都不许在前端出现。
        q_writes = sorted(set(re.findall(r"'--ct-'\s*\+\s*\w+\s*\+\s*'-([A-Za-z]+)'", q_js)))
        q_literal = re.findall(r"setProperty\(\s*'(--ct-[A-Za-z0-9-]+)'", q_js)
        q_allowed = {"x", "y", "w", "size"}
        bad_vars = [v for v in q_writes if v not in q_allowed]
        if not q_writes:
            q_bad.append("解析不出编辑器写过的变量（判据成了空壳）")
        if bad_vars:
            q_bad.append("编辑器写了清单外的变量：" + "、".join(bad_vars))
        if q_literal:
            q_bad.append("编辑器写死了变量名（该走 key 拼接）：" + "、".join(q_literal))
        leaked = [k for k in ("-family", "-align", "-color", "-style") if k in q_js]
        if leaked:
            q_bad.append("编辑器自己拼了样式项：" + "、".join(leaked))
        if not {"x", "y"} <= set(q_writes):
            q_bad.append("编辑器没有就地改 x/y（拖动会没法实时跟手）")
        # ★ 负向自证：这条判据必须真比得出差异。把 `-size` 换成一个清单外的名字，
        #   再跑一遍提取 —— 抓不住就说明它只是个摆设（成功R 那边踩过同样的坑）。
        q_probe_bad = [v for v in re.findall(
            r"'--ct-'\s*\+\s*\w+\s*\+\s*'-([A-Za-z]+)'", q_js.replace("'-size'", "'-shadow'")
        ) if v not in q_allowed]
        if not q_probe_bad:
            q_bad.append("判据抓不住清单外的变量（空壳判据）")
        results.append(
            (
                "成功Q 编辑窗口的样式串只有服务端一份来源",
                "通过" if not q_bad else "失败",
                f"拖动变量白名单 {q_writes}、写死变量名 0、映射重的四项不在前端；"
                f"其余全部由 /api/cover 的 coverStyle 原样写回"
                if not q_bad else "；".join(q_bad),
            )
        )

        # --- 成功R：拖动时 y 到底该加还是该减（顶部锚 / 底部锚）
        #
        #     ★ 这个坑是 2026-09-25 真踩的，而且症状**非常隐蔽**：
        #     我本来想省事，用 `getComputedStyle(el).bottom !== 'auto'` 现场推导
        #     "这个元素是不是锚在底部"。看着天经地义 —— 页脚是 `bottom:7%`，
        #     标题是 `top:15%`，`bottom` 该是 auto 才对。
        #     实际上**绝对定位元素的 `bottom` 在 getComputedStyle 里返回 used value(px)**，
        #     永远不是 `auto` ⇒ 三个元素全被判成底部锚。
        #     后果：**X 轴拖得完全正确，只有 Y 轴反向走**（往下拖，文字往上跑）。
        #     而"画面确实动了" ⇒ 只看「有没有动」的断言照样全绿。
        #
        #     最终做法：前端写死一张 `Y_AXIS` 表，再用这条判据**静态对账 book-style.css**。
        #     两边一不一致，改 CSS 的人立刻知道自己漏了前端。
        m_axis = re.search(r"Y_AXIS\s*=\s*\{([^}]*)\}", editor_js)
        fe_axis = {}
        for k, v in re.findall(r"(\w+)\s*:\s*'(\w+)'", m_axis.group(1) if m_axis else ""):
            fe_axis[k] = v
        css_axis = {}
        for el in ("title", "subtitle", "foot"):
            top_hit = f"top:var(--ct-{el}-y" in cover_css
            bot_hit = f"bottom:var(--ct-{el}-y" in cover_css
            css_axis[el] = "bottom" if (bot_hit and not top_hit) else (
                "top" if (top_hit and not bot_hit) else "?")
        # 主窗口那个滑块标签也得跟着这张表（对用户是可见文字，写反了就是"距顶/距底"乱指）
        m_label = re.search(r"COVER_Y_LABEL\s*=\s*\{([^}]*)\}", app_js)
        y_label = dict(re.findall(r"(\w+)\s*:\s*'([^']+)'", m_label.group(1) if m_label else ""))
        label_want = {"top": "距顶", "bottom": "距底"}
        # ★ 负向自证：这条判据必须真的比得出差异。把 foot 故意说反一遍，
        #   如果它跟 CSS 的答案"一样"，说明 css_axis 根本没解析出来（全 '?'），
        #   那时应当红而不是绿 —— 否则这就是个空壳判据。
        wrong_map = dict(css_axis)
        wrong_map["foot"] = "top" if css_axis.get("foot") == "bottom" else "bottom"
        detector_ok = wrong_map != css_axis
        r_bad = []
        if not detector_ok:
            r_bad.append("CSS 侧没解析出锚点（判据是空壳）")
        if css_axis != fe_axis:
            r_bad.append(f"CSS 说 {css_axis}，前端写的是 {fe_axis}")
        for el, ax in css_axis.items():
            if ax != "?" and y_label.get(el) != label_want[ax]:
                r_bad.append(f"{el} 的标签是「{y_label.get(el)}」，按 CSS 该是「{label_want[ax]}」")
        results.append(
            (
                "成功R y 轴锚点（距顶/距底）前端与 CSS 一致",
                "通过" if (fe_axis and not r_bad) else "失败",
                f"CSS {css_axis} / 拖拽表 {fe_axis} / 滑块标签 {y_label}"
                + ("；" + "；".join(r_bad) if r_bad else ""),
            )
        )

        # --- 成功S：自定义文字框 —— 增删 + 缩放（Phase 26）
        #
        #     佘先生：「编辑封面UI要可以增添和删减选框，选框也能够缩放」。
        #
        #     ★ 这条守的是**三处一致**。自定义框的默认值分散在三个地方：
        #       ① 服务端渲染元素时写进内联 style 的默认
        #          （`make_flipbook.cover_extra_html`）
        #       ② 工作台控件显示"当前值"时用的默认（`ui/app.js` 的 COVER_EXTRA_DEFAULTS）
        #       ③ CSS 里那条通用的 `.cover-extra` 规则
        #     任何一处改了、另两处没跟上，症状都是「没配过这个框时，右边显示的数字
        #     跟封面上的实际样子对不上」—— 而且**只有在没配过时才显形**，
        #     配过一次就再也看不出来，是那种最难发现的偏差。
        s_bad = []
        probe = eng.normalize_cover_text({
            "title": {"text": "内置不该有文字", "hide": True},
            "x1": {"text": "2026 深圳", "x": 30, "w": 40},
            "x2": {"hide": True},        # 自定义框没有 hide 这回事 → 整条丢掉
            "x0": {"text": "键名不合法"},
            "yz": {"text": "键名不合法"},
        })
        if probe.get("x1", {}).get("text") != "2026 深圳":
            s_bad.append("自定义框的文字没留住")
        if "text" in probe.get("title", {}):
            s_bad.append("内置元素不该接受 text（它的文字来自书名/副标题/张数）")
        if probe.get("title", {}).get("hide") is not True:
            s_bad.append("内置元素的 hide 没留住")
        if "x2" in probe or "x0" in probe or "yz" in probe:
            s_bad.append("不该认的键没丢掉")
        if "text" not in eng.normalize_cover_text({"x1": {"text": ""}}).get("x1", {}):
            s_bad.append("空文字被丢了（用户清空文字是想留个空框继续摆）")
        many_extras = {f"x{i}": {"text": str(i)} for i in range(1, 13)}
        if [k for k in eng.normalize_cover_text(many_extras)] != [f"x{i}" for i in range(1, 9)]:
            s_bad.append("自定义框上限不是 8 个（或没按数字序截断）")
        if len(eng.normalize_cover_text({"x1": {"text": "字" * 300}})["x1"]["text"]) != 80:
            s_bad.append("文字长度没夹到 80")
        style2 = eng.cover_text_style({"x1": {"x": 30, "w": 40, "size": 2.4, "align": "center"}})
        for want2 in ("--ct-x1-x:30%", "--ct-x1-w:40%", "--ct-x1-size:2.4cqw",
                      "--ct-x1-shift:translateX(-50%)"):
            if want2 not in style2:
                s_bad.append("样式串缺 " + want2)
        if eng.cover_text_style({"foot": {"hide": True}}) != "--ct-foot-display:none":
            s_bad.append("hide 没生成 display:none")
        # 渲染：默认（无配置）不许冒出自定义框元素；配了才出现，且只引用变量
        page_probe = {"kind": "cover", "index": 0, "density": "hard",
                      "photo": None, "folio": None}
        plain = eng.page_html(page_probe, "书名", "Photographs", 10, None)
        if "cover-extra" in plain:
            s_bad.append("没配过却在封面上渲染了自定义框元素（默认态被改了）")
        rich = eng.page_html(page_probe, "书名", "Photographs", 10,
                             {"foot": {"hide": True}, "x2": {"text": "B"}, "x1": {"text": "A"}})
        if 'data-ct="x1"' not in rich or 'data-ct="x2"' not in rich:
            s_bad.append("自定义框没渲染出来")
        elif rich.index('data-ct="x1"') > rich.index('data-ct="x2"'):
            s_bad.append("自定义框没按数字序输出")
        if "cover-foot" in rich:
            s_bad.append("被 hide 的页脚还在封面上")
        # ★ 服务端内联默认  ←→  前端控件默认，逐个对账
        extra_html = eng.cover_extra_html("x1", "A")
        m_extra_def = re.search(r"COVER_EXTRA_DEFAULTS\s*=\s*\{([^}]*)\}", app_js, re.S)
        fe_extra = dict(re.findall(r"(\w+)\s*:\s*([\w.'#-]+)",
                                   m_extra_def.group(1) if m_extra_def else ""))
        for ekey, eval_ in (("x", "13.5"), ("y", "50"), ("size", "2.1")):
            if f"var(--ct-x1-{ekey},{eval_}" not in extra_html:
                s_bad.append(f"服务端内联默认 {ekey} 不是 {eval_}")
            if fe_extra.get(ekey) != eval_:
                s_bad.append(f"前端默认 {ekey}={fe_extra.get(ekey)}，服务端是 {eval_}")
        # 上限与宽度下限：前后端必须是同一个数（不然"拖到头"两边答案不一样）
        m_max = re.search(r"COVER_EXTRA_MAX\s*=\s*(\d+)", app_js)
        if not m_max or int(m_max.group(1)) != eng.COVER_EXTRA_MAX:
            s_bad.append("前后端「最多几个文字框」不一致")
        m_min_w_fe = re.search(r"COVER_MIN_W\s*=\s*([\d.]+)", app_js)
        m_min_w_srv = re.search(r'"w":\s*\(([\d.]+),', (HERE / "make_flipbook.py").read_text(encoding="utf-8"))
        if (not m_min_w_fe or not m_min_w_srv
                or float(m_min_w_fe.group(1)) != float(m_min_w_srv.group(1))):
            s_bad.append("前后端「文字框宽度下限」不一致")
        # 编辑器得真的能"动态认框"（写死三个选择器的话，新加的框拖不动）
        if "EXTRA_SELECTOR" not in editor_js or "data-ct" not in editor_js:
            s_bad.append("编辑器没有动态识别自定义框")
        if "cve-handle" not in editor_js or "cve-handle" not in editor_css:
            s_bad.append("缩放手柄没实现")
        results.append(
            (
                "成功S 自定义文字框（增删 / 缩放）白名单与三处默认值一致",
                "通过" if not s_bad else "失败",
                "白名单 · 上限 · 渲染 · 前后端默认值全部对齐"
                if not s_bad else "；".join(s_bad),
            )
        )

        # --- 成功T：阅读器里的「跳到指定页」（Phase 26）
        #
        #     佘先生：「在查看画册的界面的选择查看的页数的功能恢复，就设计在
        #     自动翻页的组块的上方，注意布局协调」。
        #
        #     「恢复」—— 跳页本身一直在（第 ⑥ 段那个"点页码 → 就地变输入框"就是，
        #     `#page-jump` 现在也还在），他要的是一个**看得见**的常驻入口。
        #     这条守结构：控件在、且**排在自动翻页前面**。
        #     几何上的"真的在上方"由成品层拿真浏览器量 —— 结构对、位置被
        #     order/绝对定位甩走的情况，只有坐标判得住。
        t_bad = []
        for token in ('class="jump-row"', 'id="page-select"', 'id="page-go"'):
            if token not in html:
                t_bad.append("成品缺少 " + token)
        if 'id="page-jump"' not in html or 'id="page-input"' not in html:
            t_bad.append("老的「点页码跳页」入口被删了（那是原功能，不能动）")
        if 'class="jump-row"' in html and 'id="page-auto"' in html:
            if html.index('class="jump-row"') > html.index('id="page-auto"'):
                t_bad.append("跳页组块排在自动翻页**后面**了（要求是上方）")
        if "commitPageSelect" not in code:
            t_bad.append("flipbook.js 没有显式跳页的实现")
        # ★ 两个入口必须是**同一套限幅**：页号 1..总页数 → 页位 0..total-1。
        #   只改一个入口的话，同一件事会出现两种答案，而且只在边界页码上显形
        #   （一个把 9999 夹到 total、另一个夹到 total-1，就差这一页）。
        #
        #   ★★ 2026-09-25 判据修正：原来写的是「限幅字面量**至少出现 2 次**」，
        #     那句**自相矛盾** —— "共用同一套"的正确写法恰恰是算式只写一遍，
        #     而"出现 2 次"奖励的是**复制粘贴**（改一处漏一处，正是它想防的事）。
        #     换成按真意判三条：① 算式全文只写 1 遍；② 它待在一个具名函数里；
        #     ③ **两个入口都在调这个函数**（直接调，或经由同一个中间函数）。
        clamp_re = re.escape("Math.min(Math.max(Number(digits), 1), total)") + r"\s*-\s*1"
        clamp_defs = len(re.findall(clamp_re, code))

        def _fn_body(fname, src=None):
            """抠出一个顶层函数的花括号正文（顶层函数以行首 `}` 收尾）。"""
            m = re.search(r"function\s+" + re.escape(fname) + r"\s*\([^)]*\)\s*\{(.*?)\n\}",
                          code if src is None else src, re.S)
            return m.group(1) if m else ""

        # ★ 取数口径：找出"花括号正文里就是那段限幅"的那个具名函数。
        #   不去要求 `digits` 出现在**形参**上 —— 实现既可以收页号字符串
        #   （形参叫 raw、digits 是函数内的局部量），也可以直接收 digits。
        #   只认"谁的身体里写着这段算式"，两种写法都认。
        m_clamp_fn = re.search(
            r"function\s+(\w+)\s*\([^)]*\)\s*\{([^{}]*?" + clamp_re + r")", code)
        clamp_fn = m_clamp_fn.group(1) if m_clamp_fn else ""

        def _shared_reach(src):
            """两个入口**共同调用**的名字里，哪些能走到限幅（本身是它 / 内部调了它）。"""
            bodies = [_fn_body("commitJump", src), _fn_body("commitPageSelect", src)]
            if not clamp_fn or not all(bodies):
                return None
            common = (set(re.findall(r"\b([A-Za-z_$][\w$]*)\s*\(", bodies[0]))
                      & set(re.findall(r"\b([A-Za-z_$][\w$]*)\s*\(", bodies[1])))
            return sorted(n for n in common
                          if n == clamp_fn or (clamp_fn + "(") in _fn_body(n, src))

        reach = _shared_reach(code)
        if clamp_defs != 1:
            t_bad.append(f"限幅算式写了 {clamp_defs} 遍（共用的写法应当只有 1 遍）")
        if not clamp_fn:
            t_bad.append("限幅没收进具名函数，两个入口没法共用")
        elif reach is None:
            t_bad.append("没解析出两个入口的函数体（判据可能是个空壳）")
        elif not reach:
            t_bad.append("两个入口没有共用同一个能走到限幅的函数")
        else:
            # ★ 负向自证：把常驻入口里那一行调用拿掉（模拟"两个入口各写一套"），
            #   判据必须当场判红 —— 抓不住就说明它只是个摆设。
            probe = code.replace(
                "pageIndexOf(pageSelectInput.value, pageFlip.getPageCount())", "0")
            if _shared_reach(probe):
                t_bad.append("判据抓不住「两个入口各写一套」（空壳判据）")
        if "pageSelectInput" not in code:
            t_bad.append("跳页输入框没跟当前页联动")
        results.append(
            (
                "成功T 阅读器跳页组块（排在自动翻页上方）",
                "通过" if not t_bad else "失败",
                f"结构齐备、顺序正确、限幅只写 1 遍且两个入口共用 {clamp_fn}()"
                if not t_bad else "；".join(t_bad),
            )
        )

        # --- 成功U：① 书不压底部控制条  ② 后壳能翻页合上（Phase 27）
        #
        #     佘先生：「要求一是修复查看画册时的选择页数的UI组块和图片有重合冲突，
        #     要求二是画册的后壳也要可以翻页合上」。
        #
        #     ① 的根因：`.book-rig` 的宽高写死 `100dvh - 140px`
        #       （原注释 "Reserve room for navigation"，是个**估算**）。
        #       Phase 26 往脚部加了一行常驻跳页控件之后，脚部从 ~79px 涨到 121px，
        #       140px 就不够了 —— 真浏览器实测越界 40~60px，其中 1100×720 / 900×600
        #       两档**正好压住那行跳页控件本身**。
        #       修法：`.stage` 变成尺寸查询容器，宽、高两个公式都改用 `100cqh`。
        #       ② 的根因：库建跨页表时从下标 1 起、步长 2，总页数为**奇数**时
        #       末页永远被配对走 ⇒ 末页向前翻会静默失败（守卫放行、里层抛错被吞）。
        #       修法：只在需要时补一个"只含末页"的跨页，且必须幂等。
        #
        #     这一层只守**"修法还在、且没被改回坏版本"**；
        #     几何上"真的不重叠"和交互上"真的翻得动"由成品层 ⑨ 段拿真浏览器量 ——
        #     静态判据不可能替代量盒子。
        u_bad: list[str] = []
        book_css = (tmp / "ok-jump" / "styles.css").read_text(encoding="utf-8")

        def _u_strip_css(css_src: str) -> str:
            """★ 查字面量之前**必须先剥注释**。

            这条差点又踩老坑：`styles.css` 里我自己写的修法说明注释里，为了讲清楚
            "原来错在哪"，原样写了 `100dvh - 140px` 这个**坏实现**的字面量 ——
            于是判据把"解释里提到它"读成了"实现里还在用它"，第一次跑就是假红。
            （同一类坑在契约层已经踩过两次：注释里写出被禁字面量、把全文正则自己判红。）
            """
            return re.sub(r"/\*.*?\*/", "", css_src, flags=re.S)

        def _u_ok(css_src: str, js_src: str) -> bool:
            """把"修法"拆成四条可查的硬事实；任一条不成立就算坏。

            查的是**剥掉注释之后**的代码 —— 说明文里提到坏实现不算数，
            只有**真的写在规则/逻辑里**才算。
            """
            css_code = _u_strip_css(css_src)
            m_stage = re.search(r"\.stage\s*\{([^}]*)\}", css_code)
            if not m_stage or "container-type: size" not in m_stage.group(1):
                return False                       # 量不到"真实剩余高度"就无从谈起
            if "100dvh - 140px" in css_code:
                return False                       # 写死的估算又回来了（这次是真的在规则里）
            m_rig = re.search(r"\.book-rig\s*\{([^}]*)\}", css_code)
            if not m_rig:
                return False
            # ★ 宽和**高**都要用 100cqh：只收高度不收宽度的话，
            #   库是 size:"stretch"（按宽推高），宽度照样把书撑高 —— 还是压。
            if m_rig.group(1).count("100cqh") < 2:
                return False
            if "ensureBackCoverSpread" not in js_src:
                return False
            # ② 必须"带幂等条件地"补，不是无脑 push
            if not re.search(
                r"tail\.length === 2\s*&&\s*tail\[tail\.length - 1\] === lastIndex",
                js_src,
            ):
                return False
            if "spreads.push([lastIndex])" not in js_src:
                return False
            return True

        if not _u_ok(book_css, code):
            u_bad.append("成品里读不到「Phase 27 的修法」（CSS 或 JS 有一处不在）")
        else:
            # ★ 负向自证：把实现**改回坏版本**，判据必须当场判红。
            #   抓不住就说明这三条只是摆设（成功Q / 成功T 都踩过这个坑）。
            if _u_ok(book_css.replace("100cqh", "calc(100dvh - 140px)"), code):
                u_bad.append("判据抓不住「书框又改回写死 100dvh-140px」")
            if _u_ok(book_css, code.replace("spreads.push([lastIndex])", "void 0")):
                u_bad.append("判据抓不住「末页跨页补丁被拿掉」")
            if _u_ok(book_css, code.replace("tail.length === 2", "false")):
                u_bad.append("判据抓不住「补丁失去幂等条件」")
        results.append(
            (
                "成功U 书不压控制条 + 后壳能翻页合上（Phase 27）",
                "通过" if not u_bad else "失败",
                "书框宽高都量真实剩余高度（100cqh）；末页跨页补丁在且幂等；"
                "三处负向自证都抓得住"
                if not u_bad else "；".join(u_bad),
            )
        )

        # --- 成功V：① 控制条压成两行  ② 到头再点「→」整本翻回封面（Phase 28）
        #
        #     佘先生：「要求一是，查看画册时的那个页数和自动翻页UI组块太大了，
        #     上下宽度压缩一半，要让图片占据画面的绝大部分，比如那个自动翻页和其
        #     速度组块完全可以放在同一行，跳转页面的组块做成一行，要求二是我翻到
        #     后壳后再点击两下就可以翻到封面，就是整本书翻转」。
        #
        #     ① 改之前脚部 121.2px、竖排五行；改成两行之后真浏览器实测 46.6px
        #       （= 改前的 38%）。行数少了一半就得把中间那列放宽（280 → 344px），
        #       窄了会挤到换行、反而更高。
        #     ② 到头"再点一下有事可做"：用 `flip(0, "top")`（真翻页动画）而不是
        #       `turnToPage(0)`（瞬间跳、没动画）。同时 `#next` 不能再因为
        #       "到了末页"而变灰 —— 变灰了就没法翻回封面。
        #       ⚠ 判"到头了没有"必须问**库的当前跨页表**（`getSpread()` 按朝向返回
        #       横屏/竖屏那张表），不能拿 `currentPage === 总数-1` 去判，也不能复用
        #       自动翻页那个 `atLastSpread()`（它在**末跨页**就已经是 true）。
        #
        #     这一层只守**"修法还在、且没被改回坏版本"**；
        #     "控制条真的只有 46.6px 高"、"点了真的回到封面"由成品层 ⑩ 段
        #     拿真浏览器量 —— 静态判据不可能替代量盒子。
        v_bad: list[str] = []
        book_html = (tmp / "ok-jump" / "index.html").read_text(encoding="utf-8")

        def _v_ok(css_src: str, html_src: str, js_src: str) -> bool:
            """把 Phase 28 的两条修法拆成可查的硬事实；任一条不成立就算坏。

            CSS/JS 一律查**剥掉注释之后**的代码（说明文里提到坏写法不算数）。
            """
            css_code = _u_strip_css(css_src)
            # ① 两行结构：恰好两个 .status-row，且各自的身份明确
            if html_src.count('class="status-row') != 2:
                return False
            if 'class="status-row nav-row"' not in html_src:
                return False
            if 'class="status-row auto-row"' not in html_src:
                return False
            # 跳页组块仍在自动翻页之前（Phase 26 的 DOM 顺序约定）
            if html_src.index('class="jump-row"') >= html_src.index('id="page-auto"'):
                return False
            # 老入口（点页码变输入框）不许被"为了压缩"删掉
            if 'id="page-jump"' not in html_src or 'id="page-input"' not in html_src:
                return False
            # ② 中间那列放宽到 344px（行数少一半就必须更宽）
            if "min(100%, 344px)" not in css_code:
                return False
            m_row = re.search(r"\.status\s+\.status-row\s*\{([^}]*)\}", css_code)
            if not m_row or "display: flex" not in m_row.group(1):
                return False
            # ③ 到头翻回封面：开关在、问库的跨页表、真翻页而不是瞬间跳
            if "const WRAP_TO_COVER = true;" not in js_src:
                return False
            if "function atFinalSpread()" not in js_src or "atFinalSpread()" not in js_src:
                return False
            # ★ "到头了没有"必须问库的**当前跨页表**（按朝向取），不许自己用页号推
            if ".getSpread()" not in js_src:
                return False
            if 'pageFlip.flip(0, "top")' not in js_src:
                return False
            if "canFlipForward()" not in js_src:
                return False
            # ④ 旧写法不许回来：#next 不能再因为"到了末页"而禁用
            if "nextButton.disabled = currentPage === lastPage" in js_src:
                return False
            # ⑤ 自动翻页仍要"到头自停"（Phase 20 的原行为，Phase 28 一个字没动）
            if not re.search(r"if \(atLastSpread\(\)\) \{[^}]*stopAuto\(\)", js_src, re.S):
                return False
            return True

        if not _v_ok(book_css, book_html, code):
            v_bad.append("成品里读不到「Phase 28 的修法」（HTML / CSS / JS 有一处不在）")
        else:
            # ★ 负向自证：把实现**改回坏版本**，判据必须当场判红。
            if _v_ok(book_css, book_html.replace('class="status-row nav-row"', 'class="row-a nav-row"'), code):
                v_bad.append("判据抓不住「两行结构被拆掉」")
            if _v_ok(book_css, book_html, code.replace("const WRAP_TO_COVER = true;", "const WRAP_TO_COVER = false;")):
                v_bad.append("判据抓不住「到头翻回封面的开关被关掉」")
            if _v_ok(book_css, book_html, code.replace('pageFlip.flip(0, "top")', "return;")):
                v_bad.append("判据抓不住「翻回封面那一步被拿掉（变成点了没反应）」")
            if _v_ok(book_css, book_html, code.replace("!canFlipForward() ||", "currentPage === lastPage ||")):
                v_bad.append("判据抓不住「#next 又在末页变灰」")
            if _v_ok(book_css.replace("min(100%, 344px)", "min(100%, 280px)"), book_html, code):
                v_bad.append("判据抓不住「中间那列又缩回 280px」")
        results.append(
            (
                "成功V 控制条两行 + 到头翻回封面（Phase 28）",
                "通过" if not v_bad else "失败",
                "两张 .status-row（状态+跳页 / 自动翻页+速度）；中间列 344px；"
                "到头用 getSpread() 判、flip(0) 翻回封面；#next 不再因末页变灰；"
                "自动翻页仍到头自停；五处负向自证都抓得住"
                if not v_bad else "；".join(v_bad),
            )
        )

        # --- 成功W：封面/后壳双击 = 逐页急翻 5 下 + 瞬间切到另一头（Phase 29 提 / 36 定稿）
        #
        #     佘先生（Phase 29）：「在封面我连击鼠标左键两次是翻转画册到后壳，
        #     在后壳我连击鼠标左键两次则翻转画册到封面」。
        #
        #     ★★ 这一条的口径被本人**改过三次**，每次都**显式换掉**旧判据（铁律 7）：
        #
        #     Phase 33：不准"先翻一页再整本翻转"，要**一页页连着翻**；
        #     Phase 34：改成"先正常翻两页 + 剩下的一整叠当**厚书整块**翻过去，
        #               要有横截面（书口切面）" ⇒ 自绘方块 `.stack-flip`；
        #     Phase 35：那套方块再定稿成"三面纯白 + 底下垫不透明纸"。
        #
        #     ★★★ Phase 36（当前）：佘先生看完说**不好看** —— 「一整块转半圈太机械」。
        #     他原话：「逐页急翻五面，然后就不翻了，直接跳到封面和后壳，
        #     在后壳处翻转也是一样的」；追问确认：五下 = 五张跨页、
        #     收尾是"**瞬间切过去**"（不要过渡）、落点封面↔后壳。
        #     ⇒ Phase 34/35 的整叠方块（`startSlabFlip` / `slabJumpToEnd` /
        #       `SLAB_*` / `COVER_NORMAL_*` / `.stack-flip` / `.stack-mask`）
        #       **整套退役**，一个 token 都不许回来。
        #
        #     这一条钉死的几个**真踩到的坑**（跨 Phase 一直有效）：
        #
        #     ① 滚轮监听里的**让位判定必须看 `document.activeElement`**，
        #        不能看 `event.target`（焦点在跳页框里时鼠标不一定压在框上）。
        #        Phase 32 起滚轮干的是"缩放"，但让位口径没变。
        #
        #     ② 库默认 `disableFlipByClick:false` ⇒ **单击书页本来就会翻页**
        #        （原功能，必须保留）。于是一次双击 = 两次单击，书先被翻走，
        #        等 `dblclick` 派发过来时 `currentPage` 已是翻完之后的值
        #        ⇒ 判"这次双击从哪开始"必须用 **pointerdown 快照**
        #        （pageAtPrevDown / finalAtPrevDown）。
        #
        #     ③ ★ "翻了几下"**只能数 `flip` 事件**（一下 = 一个 `flip`），
        #        不能拿页位差换算。实测（`_p36_probe0.mjs` M1/M2）：真双击封面
        #        **只派发 1 个 `flip`**（0→1，第二下在动画中被库吞）；而 `flipNext`
        #        的页位增量是"封面那一下 +1、之后每下 +2"。两者不成线性 ⇒
        #        用 `flipCount` 计数、把双击自带的几下用 `flipsAtPrevDown`
        #        快照扣掉（`already`），`need = max(1, RIFFLE_TURNS - already)`。
        #
        #     ④ ★ 推进**绝不能靠 changeState 递归**（Phase 33 实测踩到）：
        #        在"落定即再 flipNext"的递归里，库会把 52 次翻页在**同一毫秒**
        #        走完（全挤在 155~156ms）⇒ 画面"闪一下"就到后壳（findings 92）。
        #        必须**自己用 setTimeout 排步**（`coverTick` + `RIFFLE_POLL_MS`）。
        #
        #     ⑤ ★ 提速（把库的 `flippingTime` 临时压到 `RIFFLE_MS`）**必须还原**
        #        （findings 92）。实测（M3/M5）`getSettings()` 是**活对象**、改了下
        #        一拍就生效，且**正在转的那一页不受影响**（起手 760ms 那一下途中
        #        改成 260，总耗时仍是 724ms、角度曲线平滑无跳变）。
        #
        #     ⑥ ★ Phase 36 修掉一个真 bug：`turnNext` / `turnPrev` 里
        #        `stopCoverRun()` 原本排在 `if (isTurning) return;` **后面** ——
        #        急翻那 1.5 秒里 isTurning 恒真 ⇒ 点箭头被完全无视（像卡住）。
        #        让位必须排在前面。
        #
        #     ⚠ Phase 32 已撤掉「滚轮翻页」；这里仍钉"老口径不许回来"。
        #
        #     这一层只守"修法还在、且没被改成坏写法"；真实的"真的翻 5 下、
        #     真的落到后壳、全程没有方块元素、flippingTime 还原"由探针
        #     `_p36_accept.mjs` 拿真鼠标事件量（29/29）。
        w_bad: list[str] = []

        def _w_ok(js_src: str) -> bool:
            """把双击急翻那一趟拆成可查的硬事实；任一条不成立就算坏。

            ★ 一律查**剥掉注释之后**的代码 —— 说明文里提到某个词不算"代码里写了"。
            """
            js_code = re.sub(r"/\*.*?\*/", "", js_src, flags=re.S)   # 块注释
            js_code = re.sub(r"//[^\n]*", "", js_code)                # 行注释
            # ① 滚轮监听还在（Phase 32 起它干的是"缩放"，不是"翻页"），
            #    且仍是 active（passive:false ⇒ 能 preventDefault）
            if 'window.addEventListener("wheel"' not in js_src:
                return False
            if "{ passive: false }" not in js_src:
                return False
            # ★ 让位看的是键盘焦点，不是 event.target
            if "document.activeElement" not in js_src:
                return False
            # ★ 负向：滚轮翻页不许回来（Phase 32 已按他要求撤掉）
            if "WHEEL_COOLDOWN_MS" in js_code:
                return False
            if "wheelReadyAt" in js_code:
                return False
            if re.search(r"deltaY\s*<\s*0\s*\)\s*turnPrev", js_code):
                return False
            # ② 双击：监听在 + 起点快照在（起点靠"按下那一刻"记，不靠当下问库）
            if 'bookElement.addEventListener("dblclick"' not in js_src:
                return False
            if "pageAtPrevDown" not in js_code:
                return False
            if "finalAtPrevDown" not in js_code:
                return False
            if re.search(r"dblclick[^;]{0,400}?currentPage === 0", js_src, re.S):
                return False
            # ③ Phase 36 那一套在（状态 / 起步 / 收尾 / 节拍 / 提速还原 / 瞬跳）
            for token in ("coverRun", "function bookSettled(", "function coverTick(",
                          "function startCoverRun(", "function stopCoverRun(",
                          "function applyRiffleSpeed(", "function restoreRiffleSpeed(",
                          "function jumpToEndInstant(",
                          "RIFFLE_TURNS", "RIFFLE_MS", "RIFFLE_POLL_MS",
                          "flipCount", "flipsAtPrevDown", "lastRiffle"):
                if token not in js_code:
                    return False
            # ④ "翻几下"必须**数 flip 事件**（一下 = 一个 flip），且把双击自带的扣掉
            if "flipCount += 1" not in js_code:
                return False
            if not re.search(r"flipCount\s*-\s*flipsAtPrevDown", js_code):
                return False
            if not re.search(r"RIFFLE_TURNS\s*=\s*5\s*;", js_code):
                return False
            if not re.search(r"need:\s*Math\.max\(1,\s*RIFFLE_TURNS - already\)", js_code):
                return False
            # ★ 提速/节拍两个常量的**量级**也要对（改回 760 那种就等于没提速）
            m_rms = re.search(r"RIFFLE_MS\s*=\s*(\d+)\s*;", js_code)
            if not m_rms or not (100 <= int(m_rms.group(1)) <= 400):
                return False
            m_rpoll = re.search(r"RIFFLE_POLL_MS\s*=\s*(\d+)\s*;", js_code)
            if not m_rpoll or not (10 <= int(m_rpoll.group(1)) <= 120):
                return False
            # ⑤ 收尾：结算这一趟 + **先停急翻、再瞬跳**到终点
            if not re.search(r"total:\s*coverRun\.already \+ coverRun\.turns", js_code):
                return False
            if not re.search(r"stopCoverRun\(\);\s*jumpToEndInstant\(dir\);", js_code):
                return False
            # ⑥ 节拍**自己排 setTimeout**（不许 changeState 同步递归 ⇒ 会"闪一下"）
            if not re.search(r"setTimeout\(coverTick,\s*RIFFLE_POLL_MS\)", js_code):
                return False
            # ⑦ 前翻的瞬跳 = 末跨页 + 一次"几乎不花时间"的 flipNext（才能合上到 edge=back）
            if not re.search(r"turnToPage\(pageFlip\.getPageCount\(\) - 1\)", js_code):
                return False
            if not re.search(r'function jumpToEndInstant\(dir\)[\s\S]{0,600}?flipNext\("top"\)',
                             js_code):
                return False
            # ⑧ 提速与还原：applyRiffleSpeed 压 flippingTime；stopCoverRun 里还原
            if not re.search(r"s\.flippingTime\s*=\s*RIFFLE_MS", js_code):
                return False
            if not re.search(r"function stopCoverRun\(\)[\s\S]{0,400}?restoreRiffleSpeed\(",
                             js_code):
                return False
            # ⑨ ★ Phase 36 修的真 bug：用户自己按箭头时**先让位、再判"正在翻"**
            for fn in ("function turnNext()", "function turnPrev()"):
                m_fn = re.search(re.escape(fn) + r"([\s\S]{0,600}?)\n\}\n", js_code)
                body = m_fn.group(1) if m_fn else ""
                if "stopCoverRun()" not in body:
                    return False
                i_stop, i_guard = body.find("stopCoverRun()"), body.find("if (isTurning)")
                if i_guard >= 0 and i_stop > i_guard:
                    return False
            # ⑩ 自测句柄（"翻了几下"的**唯一**口径就从这儿读）
            for token in ("window.__cover", "flips: () => flipCount", "last: () => lastRiffle"):
                if token not in js_code:
                    return False
            # ★★ 负向（Phase 36）：Phase 34/35 的整叠块面翻页 **一个 token 都不许回来**
            for gone in ("startSlabFlip", "stopSlabFlip", "slabGeometry", "slabJumpToEnd",
                         "SLAB_THICK_RATIO", "SLAB_LEAVES", "SLAB_FAN_DEG", "SLAB_FADE_MS",
                         "stack-flip", "stack-mask", "COVER_SLAB_MS", "COVER_NORMAL_PAGES",
                         "COVER_NORMAL_MS"):
                if gone in js_code:
                    return False
            # ★ 负向：Phase 33 的"快慢两档"也不许回来
            for gone in ("COVER_SLOW_PAGES", "COVER_SLOW_MS", "COVER_FAST_MS",
                         "COVER_GAP_MS", "setCoverSpeed", "restoreCoverSpeed"):
                if gone in js_code:
                    return False
            # ★ 负向：旧口径（Phase 29 的"两步跳到后壳"）不许回来
            for stale in ("advanceBackCover", "flipToBackCover", "pendingCover", "backCoverStage"):
                if stale in js_code:
                    return False
            # ⑪ 原功能一个字没动：**单击书页翻页**必须还开着
            if re.search(r"disableFlipByClick\s*:\s*true", js_code):
                return False
            return True

        if not _w_ok(code):
            w_bad.append("成品里读不到「双击逐页急翻 5 下 + 瞬间切到另一头」的修法（那一组有一处不在）")
        else:
            # ★ 负向自证：把实现改成坏版本，判据必须当场判红
            if _w_ok(code.replace("document.activeElement", "event.target")):
                w_bad.append("判据抓不住「滚轮让位改回 event.target（焦点判定形同虚设）」")
            if _w_ok(code.replace("{ passive: false }", "{ passive: true }")):
                w_bad.append("判据抓不住「滚轮监听退回被动（preventDefault 失效）」")
            #   Phase 32 之后新增的两条：老口径（滚轮翻页）**不许回来**
            if _w_ok(code.replace("const ZOOM_COOLDOWN_MS", "const WHEEL_COOLDOWN_MS")):
                w_bad.append("判据抓不住「滚轮翻页的冷却常量又冒出来」")
            if _w_ok(code.replace("if (!img) return false;",
                                  "if (!img) return false;\n        if (deltaY < 0) turnPrev(); else turnNext();")):
                w_bad.append("判据抓不住「滚轮翻页分支又加回来」")
            #   Phase 33：双击起点必须靠快照，不许当场取
            if _w_ok(code.replace("pageAtPrevDown", "pageAtLastDown")):
                w_bad.append("判据抓不住「双击起点改成当场取（会被单击翻页抢先）」")
            #   ★★ Phase 36：这一套的名字/节奏/计数/瞬跳一动，必须当场判红
            if _w_ok(code.replace("function coverTick(", "function coverTickX(")):
                w_bad.append("判据抓不住「逐步急翻的函数被改名/拿掉」")
            if _w_ok(code.replace("window.setTimeout(coverTick, RIFFLE_POLL_MS)", "coverTick()")):
                w_bad.append("判据抓不住「急翻改回同步递归（会闪一下就到后面）」")
            if _w_ok(code.replace("const RIFFLE_TURNS = 5", "const RIFFLE_TURNS = 0")):
                w_bad.append("判据抓不住「不再翻够 5 下（直接瞬跳）」")
            if _w_ok(code.replace("const RIFFLE_MS = 260", "const RIFFLE_MS = 760")):
                w_bad.append("判据抓不住「急翻不提速（慢吞吞翻完不是他要的）」")
            if _w_ok(code.replace("flipCount += 1", "flipCount += 0")):
                w_bad.append("判据抓不住「不再数 flip 事件（翻了几下没法算）」")
            if _w_ok(code.replace("flipCount - flipsAtPrevDown", "RIFFLE_TURNS")):
                w_bad.append("判据抓不住「不把双击自带的几下扣掉（会多翻几下）」")
            if _w_ok(code.replace("Math.max(1, RIFFLE_TURNS - already)", "0")):
                w_bad.append("判据抓不住「need 不再保底 ≥1（退化成一步到位）」")
            if _w_ok(code.replace("stopCoverRun();\n  jumpToEndInstant(dir);", "jumpToEndInstant(dir);")):
                w_bad.append("判据抓不住「收尾不再先停急翻（状态会悬着）」")
            if _w_ok(code.replace("function jumpToEndInstant(", "function jumpToEndInstantX(")):
                w_bad.append("判据抓不住「瞬间切到终点那一段被拿掉」")
            if _w_ok(code.replace("turnToPage(pageFlip.getPageCount() - 1)", "turnToPage(0)")):
                w_bad.append("判据抓不住「前翻的瞬跳没到末页」")
            if _w_ok(code.replace("s.flippingTime = RIFFLE_MS", "s.flippingTime = 760")):
                w_bad.append("判据抓不住「急翻不再提速」")
            if _w_ok(code.replace("restoreRiffleSpeed(coverRun);", "void 0;")):
                w_bad.append("判据抓不住「收尾不还原 flippingTime（之后点箭头会快得看不清）」")
            # ★ 让位顺序：把 stopCoverRun 挪回 isTurning 之后，必须判红
            if _w_ok(code.replace("  stopCoverRun();\n  if (isTurning) return;",
                                  "  if (isTurning) return;\n  stopCoverRun();")):
                w_bad.append("判据抓不住「让位又排回 isTurning 之后（急翻期间点不动箭头）」")
            if _w_ok(code.replace("function startCoverRun(", "function flipToBackCover(){}\n        function startCoverRun(")):
                w_bad.append("判据抓不住「旧的两步跳到后壳实现又冒回来」")
            # ★ Phase 34/35 的方块 token 又冒回来
            if _w_ok(code.replace("let coverRun = null;", "let coverRun = null;\nconst startSlabFlip = 0;")):
                w_bad.append("判据抓不住「Phase 34/35 的整叠方块又冒回来」")

        # ★★ Phase 34 提 · 35 定稿 · 36 退役：块面翻页那一套的**样式**
        #     Phase 36 已把这套 CSS 整块删掉 ⇒ 这里改成**只守灯箱 + 钉死方块不许回来**。
        def _w_css_ok(css_src: str) -> bool:
            """剥掉注释后查：灯箱那几条规则在 + 整叠方块样式**一个都不许回来**。"""
            css_c = re.sub(r"/\*.*?\*/", "", css_src, flags=re.S)
            q = "".join(css_c.split())
            # ---- 优化二：灯箱（独立层，压在所有东西之上）----
            for token in (".lightbox{position:fixed;inset:0;z-index:300",
                          ".lightbox[hidden]{display:none;}",
                          ".lightbox__img{position:absolute;top:0;left:0;transform-origin:00;",
                          ".lightbox__close{position:absolute;top:14px;right:16px;"):
                if token not in q:
                    return False
            # ★ 契约测试全文扫 `box-shadow: inset` —— 绝不许写
            if "box-shadow:inset" in q:
                return False
            # ★★ 负向（Phase 36）：Phase 34/35 的整叠方块样式**一个都不许回来**
            for gone in (".stack-flip", ".stack-mask", "stack-flip__face", "stack-flip__leaf",
                         "--slab-", "perspective:3200px"):
                if gone in q:
                    return False
            # ★ 灯箱只当独立固定层，绝不往书页里塞样式
            #   （书页 style 每帧被库重写，见 findings 73/82）
            for rule in q.split("}"):
                sel = rule.split("{")[0]
                if "lightbox" in sel and ".book-page" in rule:
                    return False
            return True

        try:
            w_css = (HERE / "runtime" / "styles.css").read_text(encoding="utf-8")
        except OSError as exc:                                   # noqa: BLE001
            w_bad.append(f"读不到 styles.css：{exc}")
            w_css = ""

        if w_css and not _w_css_ok(w_css):
            w_bad.append("成品里读不到「灯箱那一套样式」或方块样式又冒回来了（有一处不对）")
        elif w_css:
            if _w_css_ok(w_css.replace("z-index: 300", "z-index: 3")):
                w_bad.append("判据抓不住「灯箱不再压在所有东西之上（会被书盖住）」")
            if _w_css_ok(w_css.replace(".lightbox[hidden] { display: none; }",
                                       ".lightbox[hidden] { display: block; }")):
                w_bad.append("判据抓不住「灯箱关不掉（hidden 时还显示）」")
            # ★ 负向自证：往 CSS 里塞回一个方块 token，必须当场判红
            if _w_css_ok(w_css + "\n.stack-flip { position: absolute; }\n"):
                w_bad.append("判据抓不住「Phase 34/35 的整叠方块样式又冒回来」")
            if _w_css_ok(w_css + "\n.stack-mask { position: absolute; }\n"):
                w_bad.append("判据抓不住「底下那片白纸的样式又冒回来」")
        results.append(
            (
                "成功W 封面/后壳双击 = 逐页急翻 5 下 + 瞬间切到另一头（Phase 29 提 / 36 定稿）",
                "通过" if not w_bad else "失败",
                "滚轮监听仍在且 passive:false、让位看 document.activeElement；"
                "滚轮翻页的老口径（WHEEL_COOLDOWN_MS / wheelReadyAt / turnPrev 分支）不许回来；"
                "双击走 pointerdown 起点快照（prev / finalPrev）；"
                "一趟 = 用 flipCount 数「翻了几下」（扣掉双击自带的 already）"
                "⇒ need = max(1, RIFFLE_TURNS(5) - already)，逐页急翻到够，"
                "再 stopCoverRun + jumpToEndInstant 瞬间切到封面/后壳；"
                "节拍自己排 setTimeout（RIFFLE_POLL_MS）；applyRiffleSpeed 压"
                "flippingTime=RIFFLE_MS、stopCoverRun 里 restoreRiffleSpeed 还原；"
                "turnNext/turnPrev 先 stopCoverRun 再判 isTurning；"
                "Phase 34/35 的整叠方块（SLAB_* / stack-flip / COVER_NORMAL_* / slabJumpToEnd）"
                "与 Phase 33 的快慢档、旧的两步跳实现都不许回来；"
                "单击翻页原功能保留；新增的负向自证都抓得住"
                if not w_bad else "；".join(w_bad),
            )
        )

        # --- 成功Z：双击照片 = 单张全屏看（灯箱）（Phase 35 优化二）
        #
        #     佘先生 2026-09-29：「双击画册中的图片可以**单独一个图片显示**，
        #     在单击右上角**叉号**退出当前图片的显示，放大的效果也是
        #     **光标位置为中心**放大」。
        #
        #     必须钉住的几条口径（都是真踩过的）：
        #     ① 灯箱只认**软页**上的照片 —— 封面 / 封底双击仍然是「整叠翻页」，
        #        不能被灯箱抢走（`softPhotoAt` 判 `dataset.density === "hard"`）。
        #     ② 双击 = 两下单击 = 库自己翻走两页 ⇒ 关掉灯箱得把那两页**悄悄还回去**，
        #        否则书凭空往后跳两页。而且**还原必须等书落定**再瞬移 ——
        #        旧写法「页位 == 目标」当场就成立，可第二下单击还在飞（findings 101）。
        #     ③ 用户**自己**导航（翻页 / 跳页 / Home / End）⇒ 撤掉那笔「待还原」，
        #        免得半秒后把人拽回双击那一页（`cancelLightboxReturn` 四处都要挂）。
        #     ④ 放大的算式必须和书页那套**同一套量纲**（`(m - st.x) / st.s`），
        #        光标底下那点才钉得住（另写一套 = 当初"放大时左右晃"的根，findings 91）。
        #     ⑤ 灯箱开着时键盘**不许**翻背后的书。
        #
        #     这一层只守「修法还在、且没被改成坏写法」；真实交互由探针
        #     `_p35_accept.mjs` 拿真鼠标事件量（25/25）。
        z_bad: list[str] = []

        def _z_ok(js_src: str) -> bool:
            """把灯箱那一套拆成可查的硬事实；任一条不成立就算坏（查的是剥注释后的代码）。"""
            zc = re.sub(r"/\*.*?\*/", "", js_src, flags=re.S)
            zc = re.sub(r"//[^\n]*", "", zc)
            # ① 只认软页上的照片（封面 / 封底的双击仍然走整叠翻页）
            if "function softPhotoAt(" not in zc:
                return False
            if 'dataset.density === "hard"' not in zc:
                return False
            # ② 灯箱本体齐备
            for token in ("function lightboxEnsure(", "function lightboxOpen(",
                          "function lightboxClose(", "function lightboxReturnBook(",
                          "function cancelLightboxReturn(", "function lightboxZoom(",
                          "LIGHTBOX_MAX", '"lightbox__close"', '"lightbox__img"',
                          "window.__lightbox"):
                if token not in zc:
                    return False
            # ③ 右上角那个叉号点了要关（单击，不是双击）
            if not re.search(r'addEventListener\("click",\s*\(\)\s*=>\s*lightboxClose\(\)', zc):
                return False
            # ④ Esc 也能关；而且灯箱开着时先把键盘截住（不许翻背后的书）
            if "Escape" not in zc:
                return False
            m_key = re.search(r'addEventListener\("keydown"(.*?)\n\}\);', zc, re.S)
            if not m_key or "lightboxBox" not in m_key.group(1):
                return False
            # ⑤ 那笔「待还原」认班次号，而且四条用户导航都要撤掉它
            if not re.search(r"run\s*!==\s*lightboxReturnRun", zc):
                return False
            if zc.count("cancelLightboxReturn();") < 4:
                return False
            # ⑥ 放大以**光标**为中心：瞄点算式必须是 (光标 − 位移) / 当前倍率
            m_zoom = re.search(r"function lightboxZoom\(event\)(.*?)\n\}", zc, re.S)
            body = m_zoom.group(1) if m_zoom else ""
            if "const ax = (mx - st.x) / st.s;" not in body:
                return False
            if "x: mx - s2 * ax, y: my - s2 * ay" not in body:
                return False
            # ★ 先夹紧再判变没变（到顶之后不再把图往外推 —— Phase 33 修过的真 bug）
            if not re.search(r"Math\.min\(Math\.max\(raw,\s*ZOOM_MIN\),\s*LIGHTBOX_MAX\)", body):
                return False
            return True

        if not _z_ok(code):
            z_bad.append("成品里读不到「双击照片 = 单张全屏看」那一套（那一组有一处不在）")
        else:
            if _z_ok(code.replace('dataset.density === "hard"', "false")):
                z_bad.append("判据抓不住「灯箱把封面也抢走了（封面双击不再整叠翻页）」")
            if _z_ok(code.replace('addEventListener("click", () => lightboxClose())',
                                  'addEventListener("dblclick", () => lightboxClose())')):
                z_bad.append("判据抓不住「叉号改成要双击才关（他要求的是单击）」")
            if _z_ok(code.replace("const ax = (mx - st.x) / st.s;", "const ax = 0;")):
                z_bad.append("判据抓不住「放大不再以光标为中心（改成固定瞄点）」")
            if _z_ok(code.replace("if (run !== lightboxReturnRun) return;", "void 0")):
                z_bad.append("判据抓不住「待还原那趟不再认班次号（会中途把用户拽回去）」")
            if _z_ok(code.replace("cancelLightboxReturn();", "")):
                z_bad.append("判据抓不住「用户自己导航时不再撤掉待还原」")
            if _z_ok(code.replace("function lightboxReturnBook()", "function lightboxReturnBookX()")):
                z_bad.append("判据抓不住「关灯箱后把书还回原页那一段被拿掉」")
        results.append(
            (
                "成功Z 双击照片 = 单张全屏看：叉号 / Esc 退出、以光标为中心放大（Phase 35）",
                "通过" if not z_bad else "失败",
                "softPhotoAt 只认软页（封面双击仍整叠翻）；lightboxEnsure/Open/Close/"
                "ReturnBook/Zoom 齐；叉号单击关闭；Esc 关闭；"
                "keydown 最前拦灯箱（不翻背后的书）；待还原认班次号且四条用户导航都撤它；"
                "瞄点算式 (mx - st.x)/st.s 与书页同一套量纲、先夹紧再判变没变；"
                "六处负向自证都抓得住"
                if not z_bad else "；".join(z_bad),
            )
        )

        # --- 成功X：封面引入外部字体（Phase 30）+ 封面变量不被翻页库冲掉
        #
        #     佘先生：「在不改变原功能的前提下，在编辑封面组块那里新增一个引入
        #     外部字体的功能」。
        #
        #     ★★ 顺手钉死一个**真踩到、而且此前一直没被发现**的坑：
        #     封面那些 `--ct-*` 变量原本只写在封面那张页的 `style="…"` 上，
        #     可成品里翻页库初始化时会**整体重写每一页的 style 属性**（写定位与
        #     尺寸），服务端写进 HTML 的自定义属性被一并冲掉 ⇒ 封面调过的字体 /
        #     位置 / 字号 / 颜色在**成品里从来没生效过**，而预览页没有翻页库、
        #     看着却是好的。
        #     这种"预览对、成品不对"的问题，静态对账和历史自测都抓不到 ——
        #     配置明明写进了 HTML。是到浏览器里量字体宽度才暴露的。
        #     解法：同一份值在 head 的 `<style>` 里再落一份（库不碰 `<style>`）。
        #
        #     这一层守"这条链的每个环节都还在、且没被改成坏写法"；
        #     "浏览器里真的换了字形"由探针 `_p30_font.mjs` 量文字宽度来定。
        x_bad: list[str] = []
        x_core = (HERE / "make_flipbook.py").read_text(encoding="utf-8")
        x_ui = (HERE / "serve_ui.py").read_text(encoding="utf-8")

        def _x_ok(core_text: str, ui_text: str) -> bool:
            """外部字体整条链 + 封面变量的两个落点，少一样就算坏。"""
            for needle in (
                "def cover_vars_css(",
                "def install_user_fonts(",
                "def font_format_of(",
                "def load_user_fonts(",
                "def available_font_families(",
                "USER_FONT_MAX_BYTES",
                # ★ 封面变量除了封面页的 style，还必须在 head 的 <style> 里落一份
                '.art-page[aria-label="封面"]',
                "{font_link}{cover_block}",
            ):
                if needle not in core_text:
                    return False
            # 白名单：登记 / 出样式串都得只认 available_font_families()
            if core_text.count("available_font_families()") < 3:
                return False
            for needle in ("def save_user_font(", '"/api/fonts"', '"/preview/font/"'):
                if needle not in ui_text:
                    return False
            return True

        if not _x_ok(x_core, x_ui):
            x_bad.append("读不到「外部字体这条链」（字体库 / 进成品 / 导入接口有一处不在）")
        else:
            if _x_ok(x_core.replace("def cover_vars_css(", "def cover_vars_cssX("), x_ui):
                x_bad.append("判据抓不住「head 里那份封面变量没了（会被翻页库冲掉）」")
            if _x_ok(x_core.replace('.art-page[aria-label="封面"]', ".art-page.cover"), x_ui):
                x_bad.append("判据抓不住「封面变量的 CSS 选择器指错了页」")
            if _x_ok(x_core.replace("{font_link}{cover_block}", "{font_link}"), x_ui):
                x_bad.append("判据抓不住「head 不写封面变量（成品里全失效）」")
            if _x_ok(x_core.replace("def install_user_fonts(", "def install_user_fontsX("), x_ui):
                x_bad.append("判据抓不住「字体不拷进成品（换台电脑就没了）」")
            if _x_ok(x_core, x_ui.replace("def save_user_font(", "def save_user_fontX(")):
                x_bad.append("判据抓不住「导入接口没了」")

        # 动态那一半：造一个临时字体库，真跑一遍「登记 → 白名单 → 出书」
        try:
            import make_flipbook as core  # noqa: PLC0415

            x_tmp = Path(tempfile.mkdtemp(prefix="p30-fonts-"))
            try:
                (x_tmp / "fonts").mkdir()
                # 假字体：`font_format_of` 只认文件头，四个字节的 TrueType 魔数足够
                (x_tmp / "fonts" / "t1.ttf").write_bytes(b"\x00\x01\x00\x00" + bytes(64))
                (x_tmp / "registry.json").write_text(
                    json.dumps(
                        {
                            "version": 1,
                            "fonts": [{
                                "key": "t1", "label": "测试体", "file": "t1.ttf",
                                "fmt": "truetype", "size": 68,
                                "license": "自造", "source": "selftest",
                            }],
                        },
                        ensure_ascii=False,
                    ),
                    encoding="utf-8",
                )
                x_keep = (core.USER_FONTS_DIR, core.USER_FONT_FILES_DIR, core.USER_FONT_REGISTRY)
                core.USER_FONTS_DIR = x_tmp
                core.USER_FONT_FILES_DIR = x_tmp / "fonts"
                core.USER_FONT_REGISTRY = x_tmp / "registry.json"
                core._user_font_cache = None
                try:
                    fams = core.user_font_families()
                    if fams.get("t1") != "'测试体',var(--book-serif)":
                        x_bad.append(f"用户字体的 CSS 值不对：{fams.get('t1')}")
                    if core.normalize_cover_text({"title": {"font": "t1"}}).get("title", {}).get("font") != "t1":
                        x_bad.append("登记过的字体没被白名单放行")
                    if core.normalize_cover_text({"title": {"font": "随便写一个"}}):
                        x_bad.append("没登记的字体名没被白名单挡住（会原样写进 CSS）")
                    rule = core.cover_vars_css({"title": {"font": "t1", "size": 9}})
                    if not (
                        rule.startswith('.art-page[aria-label="封面"]{')
                        and "--ct-title-family:'测试体'" in rule
                        and "--ct-title-size:9cqw" in rule
                    ):
                        x_bad.append(f"封面变量那条 CSS 规则不对：{rule[:90]}")
                    out = x_tmp / "book"
                    if not core.install_user_fonts(out, ["t1"]):
                        x_bad.append("字体没被拷进成品")
                    face_file = out / "style" / "user-fonts.css"
                    face = face_file.read_text(encoding="utf-8") if face_file.is_file() else ""
                    if "@font-face" not in face or "fonts/t1.ttf" not in face:
                        x_bad.append(f"成品里的 @font-face 不对：{face[:90]}")
                    if not (out / "style" / "fonts" / "t1.ttf").is_file():
                        x_bad.append("字体文件没跟着书走（换台电脑就变样）")
                    if core.install_user_fonts(out, ["没登记过的"]):
                        x_bad.append("没登记的字体也被装进成品了")
                    html_a = core.build_index_html(
                        core.BookPlan(title="A", subtitle="s", cover_text={"title": {"font": "t1"}}),
                        [], user_fonts=True,
                    )
                    if html_a.count('href="style/user-fonts.css"') != 1:
                        x_bad.append("用到外部字体时，head 里那行引用不是恰好一次")
                    if "--ct-title-family:'测试体'" not in html_a:
                        x_bad.append("head 里那份封面变量没写进去（成品里会被翻页库冲掉）")
                    html_b = core.build_index_html(core.BookPlan(title="B", subtitle="s"), [])
                    if "user-fonts.css" in html_b or "<style>--ct" in html_b:
                        x_bad.append("没用外部字体 / 没调封面时 head 多出了东西（默认态变了）")
                finally:
                    (core.USER_FONTS_DIR, core.USER_FONT_FILES_DIR, core.USER_FONT_REGISTRY) = x_keep
                    core._user_font_cache = None
            finally:
                shutil.rmtree(x_tmp, ignore_errors=True)
        except Exception as exc:  # 不许崩：把原因并进结论
            x_bad.append(f"外部字体的动态检查跑不起来：{type(exc).__name__}: {exc}")

        results.append(
            (
                "成功X 封面引入外部字体 + 封面变量不被翻页库冲掉（Phase 30）",
                "通过" if not x_bad else "失败",
                "字体库零依赖识别 / 白名单只认登记的 / 用到才拷进成品 / 没用到时 head 一字不多；"
                "封面变量在 head 的 <style> 里另落一份（躲开翻页库重写 style）；"
                "五处负向自证都抓得住"
                if not x_bad else "；".join(x_bad),
            )
        )

        # --- 成功Y：① 删掉脚部那行说明小字 ② 页码放大 + 圆滑 ③ 中键 + 滚轮缩放
        #     （Phase 31 提出 / Phase 32 改"滚轮=缩放、放大要全屏" / Phase 34 定量程口径）
        #
        #     佘先生原话：「要求一是查看画册的下方不需要有，点击页码可跳转 · 拖动或
        #     方向键翻页，这一行字，不美观，要求二是图片的页码显示大一些，但是数字要
        #     圆滑美观，要求三是新增功能，摁下鼠标中键滚动可以缩放图片，图片放缩要有
        #     中心瞄点，不要一放大图片就跑出屏幕」。
        #
        #     这一层只守**静态事实**：模板里确实没有那行字、字号字形确实换了、
        #     缩放的实现确实在（含 Phase 32 修掉的那个真 bug）。真实的"瞄点漂几像素"
        #     "放大后有没有跑出屏幕""松开中键会不会翻页"由探针 `_p31_probe.mjs`
        #     在浏览器里拿真鼠标事件量（19/19）；Phase 34 的两条量程口径
        #     （Ctrl 铺满×4 / 滚轮纯光标锚点）由 `_p34_accept.mjs` 量（15/15）。
        #
        # ★★ 本轮修掉的真 bug（必须钉死，否则会悄悄回来）★★
        #     翻页库走的是 **mouse** 事件（useMouseEvents，绑在书的元素上），
        #     不是 pointer 事件 ⇒ 我们在 bookElement 上的 pointerdown 分流
        #     **根本拦不住它**：库照样收到 mousedown 并 startUserTouch() 进入拖拽态；
        #     缩放时鼠标压根没动（isUserMove=false）⇒ 它的收尾
        #         userStop(p){ isUserMove ? stopMove() : flip(p) }
        #     走的是 `flip(p)` —— 等于"在左半页点了一下" ⇒ **松手时书自己翻回上一页**
        #     （实测 04 → 02）。修法：在**捕获阶段**把中键 stopImmediatePropagation 掉，
        #     让库根本看不到中键（只拦 button===1，左键拖拽/双击一个字不动）。
        y_bad: list[str] = []

        def _y_code(src: str) -> str:
            """剥掉注释再查 —— 说明文里提到某个词不算"代码里写了"。"""
            src = re.sub(r"/\*.*?\*/", "", src, flags=re.S)
            return re.sub(r"//[^\n]*", "", src)

        def _y_ok(js: str, css: str, book_css: str, tpl: str) -> bool:
            js_c, css_c, bcss_c = _y_code(js), _y_code(css), _y_code(book_css)
            # ① 那行说明小字不许回来
            #    ⚠ python 这边不剥 # 注释：模板字符串里带着颜色值（#565c4d 之类），
            #      按行剥 # 会把颜色后面的内容一起吃掉，反而漏判 ⇒ 直接查原始文本。
            if "<small>" in tpl:
                return False
            # ② 页码：字号真的变大了 + 衬线（圆滑）+ 数字等宽（翻页时不左右抖）
            m = re.search(r"\.status\s+span\s*\{([^}]*)\}", css_c, re.S)
            if not m:
                return False
            blk = m.group(1)
            if not re.search(r"font\s*:[^;]*\b(1[4-9]|[2-9]\d)px", blk):
                return False
            if "var(--book-serif)" not in blk:
                return False
            if "tabular-nums" not in blk:
                return False
            # ③ 缩放：四个函数 + 上限 + 中键状态位 + 捕获阶段拦截（本轮修的 bug）
            for needle in ("function photoImgAt(", "function applyZoom(", "function zoomBy(",
                           "function resetZoomAll(", "ZOOM_MAX", "let middleDown = false"):
                if needle not in js_c:
                    return False
            if "stopImmediatePropagation" not in js_c:
                return False
            #   变换原点必须钉在左上角 —— 默认 50% 50% 会让整套瞄点数学全错
            m2 = re.search(r"\.art-page\s+\.plate\s+img\s*\{([^}]*)\}", bcss_c, re.S)
            if not m2 or not re.search(r"transform-origin\s*:\s*0\s+0", m2.group(1)):
                return False
            # ---- ★★ Phase 32：滚轮改缩放、中键什么都不做、放大要全屏 ----
            #
            #  佘先生原话：「优化一是鼠标中键滑动改成缩放功能，摁住鼠标中键暂时不要
            #    有什么操作，优化二是图片放大时要全屏显示，注意不是窗口大小不变而
            #    图片只放大一部分」。
            #
            #  ① 基准从书页换成**舞台**（否则"放大"只发生在书页那一小块里）
            if "function zoomViewport(" not in js_c:
                return False
            if not re.search(r'closest\(\s*"\.stage"\s*\)', js_c):
                return False
            #  ② 中键按住期间**一律让路**（不缩放、不翻页）—— 必须在 zoomBy 之前
            if "if (middleDown) { event.preventDefault(); return; }" not in js_c:
                return False
            #  ③ 滚轮翻页（Phase 29 那条）必须**已撤**：那两个常量与分支都不许在
            if "WHEEL_COOLDOWN_MS" in js_c or "wheelReadyAt" in js_c:
                return False
            if "turnPrev(); else turnNext();" in js_c:
                return False
            #  ④ X 的量纲：必须是"照片左上角的舞台坐标"（含 1 倍落位 o），
            #     位移要减掉 o；且未缩放时**不许返回 0**
            if "const o = zoomOriginOf(img);" not in js_c:
                return False
            if "translate(${X - o.x}px, ${Y - o.y}px) scale(${sc})" not in js_c:
                return False
            if "? x : o.x" not in js_c:
                return False
            #  ⑤ ★★ Phase 34：两条缩放的**量程口径**都换了（他本人改的，铁律 7）——
            #      · Ctrl + 加减号：从"到两张合起来铺满就停"改成
            #        **"图片全屏（铺满）后还能再放大 4 倍"** ⇒ 上限 = 每张自己的
            #        铺满倍率 × SPREAD_TURNS(4)（实测 ≈ 2.81 × 4 ≈ 11.25 倍）。
            #      · 滚轮：从"分轴夹紧、逐步放大到铺满"改成
            #        **"光标在照片里就钉住光标、以光标为中心放大，不许为了铺满
            #        显示单张照片而挪动照片"** ⇒ 分轴夹紧（sCoverX / sCoverY）与
            #        "到铺满就停"整段撤掉，位移原样交给 applyZoom。
            if "const SPREAD_TURNS = 4;" not in js_c:
                return False
            if "const sMax = it.sCover * SPREAD_TURNS;" not in js_c:
                return False
            if "sCover: Math.max(view.width / o.w, view.height / o.h)" not in js_c:
                return False
            if "function applyZoom(img, s, X, Y, maxScale = ZOOM_MAX)" not in js_c:
                return False
            if "applyZoom(it.img, s2, nx, ny, sMax);" not in js_c:
                return False
            if "applyZoom(img, s2, mx - s2 * ax, my - s2 * ay);" not in js_c:
                return False
            #     ★ 瞄点必须是"光标那点在照片坐标系里的位置"，不许写死
            if "const ax = (mx - st.x) / st.s;" not in js_c:
                return False
            if "const ay = (my - st.y) / st.s;" not in js_c:
                return False
            #     ★ 分轴夹紧与旧"到铺满就停"必须**已消失**（新口径明确不要它们）
            if re.search(r"sCoverX|sCoverY", js_c):
                return False
            if "if (dir > 0 && covered) return true;" in js_c:
                return False
            #  ⑥ 两道"围栏"要能打开，且 z-index 必须 !important（否则被库的内联 11 冲掉）
            if "overflow:visible !important" not in bcss_c:
                return False
            if not re.search(r"\.book-page\.zoomed\s*\{[^}]*z-index\s*:\s*\d+\s*!important", bcss_c):
                return False
            #      ⚠ `.zoomed` 只挂在 .book-page 上 —— 写成 .plate.zoomed 永不命中
            if ".plate.zoomed" in bcss_c:
                return False
            return True

        try:
            y_js = (HERE / "runtime" / "flipbook.js").read_text(encoding="utf-8")
            y_css = (HERE / "runtime" / "styles.css").read_text(encoding="utf-8")
            y_bcss = (HERE / "runtime" / "style" / "book-style.css").read_text(encoding="utf-8")
            y_tpl = (HERE / "make_flipbook.py").read_text(encoding="utf-8")
        except OSError as exc:                                   # noqa: BLE001
            y_bad.append(f"读不到源文件：{exc}")
            y_js = y_css = y_bcss = y_tpl = ""

        if y_js and not _y_ok(y_js, y_css, y_bcss, y_tpl):
            y_bad.append("成品里读不到「Phase 31 的三条」（① 小字还在 / ② 字号字形没换 / ③ 缩放有一处不在）")
        elif y_js:
            # ★ 负向自证：把实现改成坏版本，判据必须当场判红（换整个 token / 函数名）
            if _y_ok(y_js, y_css, y_bcss,
                     y_tpl.replace("</select>", "</select>\n<small>点击页码可跳转</small>")):
                y_bad.append("判据抓不住「那行说明小字被加回脚部」")
            if _y_ok(y_js, y_css.replace("15px", "10px"), y_bcss, y_tpl):
                y_bad.append("判据抓不住「页码字号退回 10px」")
            if _y_ok(y_js, y_css.replace("var(--book-serif)", "var(--book-sans)"), y_bcss, y_tpl):
                y_bad.append("判据抓不住「页码字形退回无衬线（不圆滑）」")
            if _y_ok(y_js, y_css.replace("tabular-nums", "normal"), y_bcss, y_tpl):
                y_bad.append("判据抓不住「数字不再等宽（翻页时左右抖）」")
            if _y_ok(y_js.replace("function zoomBy(", "function zoomByX("), y_css, y_bcss, y_tpl):
                y_bad.append("判据抓不住「缩放函数被改名」")
            # ---- ★ Phase 32 的负向自证：每一条都要造一个坏样本，换整个 token ----
            if _y_ok(y_js.replace('closest(".stage")', 'closest(".plate")'), y_css, y_bcss, y_tpl):
                y_bad.append("判据抓不住「缩放基准退回书页（放大只发生在书页那一小块）」")
            if _y_ok(y_js.replace("if (middleDown) { event.preventDefault(); return; }", ""),
                     y_css, y_bcss, y_tpl):
                y_bad.append("判据抓不住「中键按住期间不让路（按着中键滚轮仍在缩放）」")
            if _y_ok(y_js, y_css, y_bcss.replace("overflow:visible !important", "overflow:visible"), y_tpl):
                y_bad.append("判据抓不住「书页裁切围栏没打开（照片画不出页面）」")
            if _y_ok(y_js, y_css, y_bcss.replace("z-index:50 !important", "z-index:50"), y_tpl):
                y_bad.append("判据抓不住「放大页 z-index 掉了 !important（被库的内联 11 冲掉）」")
            if _y_ok(y_js.replace("translate(${X - o.x}px, ${Y - o.y}px) scale(${sc})",
                                  "translate(${X}px, ${Y}px) scale(${sc})"),
                     y_css, y_bcss, y_tpl):
                y_bad.append("判据抓不住「位移没减 1 倍落位（量纲错 ⇒ 瞄点漂移）」")
            if _y_ok(y_js.replace("? x : o.x", "? x : 0"), y_css, y_bcss, y_tpl):
                y_bad.append("判据抓不住「未缩放时 X 退回 0（漂移的根因）」")
            # ---- ★★ Phase 34 的负向自证：Ctrl 上限 / 滚轮不挪图 ----
            if _y_ok(y_js.replace("const SPREAD_TURNS = 4;", "const SPREAD_TURNS = 1;"),
                     y_css, y_bcss, y_tpl):
                y_bad.append("判据抓不住「Ctrl 上限退回 1 倍（铺满后不能再放大）」")
            if _y_ok(y_js.replace("const sMax = it.sCover * SPREAD_TURNS;",
                                  "const sMax = ZOOM_MAX * SPREAD_TURNS;"),
                     y_css, y_bcss, y_tpl):
                y_bad.append("判据抓不住「Ctrl 上限退回全局 ZOOM_MAX 那一套（不按每张自己的铺满倍率）」")
            if _y_ok(y_js.replace("applyZoom(it.img, s2, nx, ny, sMax);",
                                  "applyZoom(it.img, s2, nx, ny);"),
                     y_css, y_bcss, y_tpl):
                y_bad.append("判据抓不住「Ctrl 缩放不再按自己的上限夹紧」")
            if _y_ok(y_js.replace("applyZoom(img, s2, mx - s2 * ax, my - s2 * ay);",
                                  "applyZoom(img, s2, mx - s2 * ax, my - s2 * ay, s2);"),
                     y_css, y_bcss, y_tpl):
                y_bad.append("判据抓不住「滚轮那行的落位写法被改（光标可能不再钉住）」")
            if _y_ok(y_js.replace("const ax = (mx - st.x) / st.s;", "const ax = 0;"),
                     y_css, y_bcss, y_tpl):
                y_bad.append("判据抓不住「瞄点被写死（不再是光标底下那一点）」")
            #     ★ 负向自证要**注入**那个作废的 token（只"删"是抓不住的）：
            if _y_ok(y_js.replace("function zoomBy(",
                                  "let sCoverX = 1;\n        let sCoverY = 1;\n        function zoomBy("),
                     y_css, y_bcss, y_tpl):
                y_bad.append("判据抓不住「分轴夹紧又冒回来」")
            if _y_ok(y_js.replace("function zoomBy(",
                                  "if (dir > 0 && covered) return true;\n        function zoomBy("),
                     y_css, y_bcss, y_tpl):
                y_bad.append("判据抓不住「旧的分轴『到铺满就停』又冒回来」")
            if _y_ok(y_js.replace("function applyZoom(", "function applyZoomX("), y_css, y_bcss, y_tpl):
                y_bad.append("判据抓不住「落位夹紧函数被改名（会跑出屏幕）」")
            if _y_ok(y_js.replace("function photoImgAt(", "function photoImgAtX("), y_css, y_bcss, y_tpl):
                y_bad.append("判据抓不住「命中照片的函数被改名」")
            if _y_ok(y_js.replace("stopImmediatePropagation", "preventDefaultX"), y_css, y_bcss, y_tpl):
                y_bad.append("判据抓不住「中键没在捕获阶段拦住翻页库（松手会倒退一页）」")
            if _y_ok(y_js, y_css, y_bcss.replace("transform-origin:0 0", "transform-origin:50% 50%"), y_tpl):
                y_bad.append("判据抓不住「变换原点回到 50% 50%（瞄点数学全错）」")

        results.append(
            (
                "成功Y 删说明小字 + 页码放大圆滑 + 中键/滚轮缩放（Phase 31 提 / Phase 34 定量程口径）",
                "通过" if not y_bad else "失败",
                "脚部 <small> 一行不留（连 .status small 规则一起删）；页码 15px 衬线 + tabular-nums；"
                "缩放四函数 + 原点 0 0 + 中键在捕获阶段拦在翻页库之前（修掉松手倒退一页）；"
                "Ctrl 上限 = 每张铺满倍率 × SPREAD_TURNS(4)、滚轮纯光标锚点不挪图"
                "（分轴夹紧 sCoverX/sCoverY 与「到铺满就停」按新口径已撤）；"
                "二十二处负向自证都抓得住"
                if not y_bad else "；".join(y_bad),
            )
        )

    # --- 成功 J / K / L：脚本调用不许弹浏览器 + 浏览器残留清扫（P22）
    #
    #     佘先生（2026-09-24）：「自动清理调用的浏览器页面，你跑一次代码，
    #     开了十多个页面，你打开的页面不用了关掉」。
    #     起因是**我自己**写的诊断脚本连着出十几本书，每出一本就在他的默认浏览器
    #     （本机 = Tabbit）里弹一个页签。而他原来的手感（人在控制台敲一条命令，
    #     生成完自动打开看）必须保住 —— 所以判据不是"一律不开"，而是
    #     **"只有在真的终端里才开"**。
    #
    #     这里守的是判据本身；真实的"新开浏览器窗口数 = 0"由
    #     `.verify-probe/_p22_noopen.py` 枚举窗口实测（那是集成层）。
    engine = _load_engine()

    class _FakeTty:
        def isatty(self) -> bool:
            return True

        def write(self, *_a) -> None:
            pass

        def flush(self) -> None:
            pass

    def _judge(stdout_obj, env_value, no_open: bool) -> bool:
        saved_env = os.environ.get(engine.NO_OPEN_ENV)
        saved_out = sys.stdout
        try:
            if env_value is None:
                os.environ.pop(engine.NO_OPEN_ENV, None)
            else:
                os.environ[engine.NO_OPEN_ENV] = env_value
            sys.stdout = stdout_obj
            return bool(engine.should_open_browser(no_open))
        finally:
            sys.stdout = saved_out
            if saved_env is None:
                os.environ.pop(engine.NO_OPEN_ENV, None)
            else:
                os.environ[engine.NO_OPEN_ENV] = saved_env

    # ★ "不是终端"必须用**真文件句柄**来造。第一版图省事用了 os.devnull，
    #   而 Windows 的 devnull 是 `nul` 这个字符设备，isatty() 竟然为真 ——
    #   测试自己把输入造错了，看着像判据红。（教训照旧：红了先查输入。）
    pipe_path = tmp / "_definitely_not_a_tty.txt"
    with open(pipe_path, "w", encoding="utf-8") as pipe:
        as_script = _judge(pipe, None, False)
        as_script_env = _judge(pipe, "1", False)
    as_human = _judge(_FakeTty(), None, False)
    as_human_flag = _judge(_FakeTty(), None, True)
    as_human_env = _judge(_FakeTty(), "1", False)
    as_human_zero = _judge(_FakeTty(), "0", False)

    results.append(
        (
            "成功J 脚本调用不弹浏览器",
            "通过" if (as_script is False and as_script_env is False) else "失败",
            f"管道={as_script} 管道+环境变量={as_script_env}（都应 False）",
        )
    )
    results.append(
        (
            "成功K 人敲命令仍自动打开",
            "通过" if (as_human and as_human_zero and not as_human_flag and not as_human_env) else "失败",
            f"终端={as_human} +env=0={as_human_zero} +--no-open={as_human_flag} +env=1={as_human_env}",
        )
    )

    # 成功L：残留清扫 —— 只碰 playwright 名下、且足够久没动过的目录；
    #         新鲜的一律放过（那可能是正开着的浏览器）。
    try:
        import importlib.util as _ilu
        import time as _time

        _spec = _ilu.spec_from_file_location("verify_common_for_selftest", HERE / "verify_common.py")
        _vc = _ilu.module_from_spec(_spec)
        sys.modules["verify_common_for_selftest"] = _vc
        _spec.loader.exec_module(_vc)

        fresh_dir = Path(tempfile.gettempdir()) / "playwright_chromiumdev_profile-SELFTEST"
        stale_dir = Path(tempfile.gettempdir()) / "playwright_chromiumdev_profile-SELFTEST-OLD"
        for _d in (fresh_dir, stale_dir):
            shutil.rmtree(_d, ignore_errors=True)
            _d.mkdir(parents=True, exist_ok=True)
        _old = _time.time() - 3 * 3600
        os.utime(stale_dir, (_old, _old))

        _vc.sweep_browser_leftovers(log=lambda _s: None)
        swept_ok = (not stale_dir.exists()) and fresh_dir.exists()
        summary = f"陈旧目录被清={not stale_dir.exists()} 新鲜目录被放过={fresh_dir.exists()}"
        shutil.rmtree(fresh_dir, ignore_errors=True)
        shutil.rmtree(stale_dir, ignore_errors=True)
    except Exception as _exc:  # noqa: BLE001
        swept_ok = False
        summary = f"{type(_exc).__name__}: {_exc}"
    results.append(("成功L 浏览器残留清扫", "通过" if swept_ok else "失败", summary))

    # --- 成功AB：删照片 / 按位次挪位 都不重编号（Phase 37）
    #
    #     佘先生（2026-09-29）：「左侧对扫描到的照片的操作需要有删除和排序功能……
    #     每个图片的预览图的右上方要有一个叉号的组块…… 左下角的数字处做一个可以
    #     点击输入数字的组块，输入数字后图片排序到相应位置」。
    #
    #     ★ 这一层守的是**服务端语义**：`Photo.order` 是身份号、同时还是
    #       `/thumb?id=<order>` 的取图键（findings 113）⇒ 删除与挪位**都不许重编号**。
    #       "界面上点得到、点得对"由 verify_ui.mjs 的「成功3b」那 14 条常驻断言定。
    #
    #     ★ 判据要**负向自证**（铁律 6）：不只是"删一张少一张"，
    #       还要证明"被拒的请求一个脚印都没留下"、"剩下的人的编号一个都没动"。
    ab_bad: list[str] = []
    try:
        import importlib.util as _ab_ilu  # noqa: PLC0415

        _spec = _ab_ilu.spec_from_file_location("serve_ui_for_selftest", HERE / "serve_ui.py")
        _su = _ilu.module_from_spec(_spec)
        sys.modules["serve_ui_for_selftest"] = _su
        _spec.loader.exec_module(_su)
        _core = _load_engine()

        # 造 6 张真照片（很小），直接塞进 SESSION，绕过扫描
        ab_dir = tmp / "p37_photos"
        ab_dir.mkdir(parents=True, exist_ok=True)
        for i in range(6):
            from PIL import Image  # noqa: PLC0415
            Image.new("RGB", (60, 80), (40 * i % 256, 90, 160)).save(
                ab_dir / f"p37_{i:02d}.jpg", quality=70)
        _photos = _core.scan(ab_dir)
        _core.assign_plates(_photos)
        with _su.SESSION.lock:
            _su.SESSION.source_dir = ab_dir
            _su.SESSION.photos = _photos
            _su.SESSION.pages = _su.SESSION.pages_of()

        class _FakeHandler(_su.Handler):
            """不真的走 HTTP —— 直接喂 payload 进去、把回包截下来。"""

            def __init__(self, payload):  # noqa: D107
                self._payload = payload
                self._sent = None

            def read_json(self):  # noqa: D102
                return self._payload

        def _plan_call(payload):
            h = _FakeHandler(payload)
            _su.Handler.handle_plan(h)
            return h._sent

        # 拦掉 json_response，把它改成"记下回包"
        _real_resp = _su.json_response

        def _capture(handler, obj, *a, **k):
            handler._sent = obj
            return obj

        _su.json_response = _capture
        try:
            orders0 = [p.order for p in _su.SESSION.photos]
            n0 = len(orders0)
            if n0 != 6:
                ab_bad.append(f"素材不是 6 张（{n0}）")

            # ① 负向：删不存在的编号、想全删光、remove 非数组、元素非数字 —— 全要拒
            for bad_payload, why in (
                ({"remove": [999999]}, "删不存在的编号"),
                ({"remove": orders0}, "想全删光"),
                ({"remove": "abc"}, "remove 不是数组"),
                ({"remove": ["x"]}, "remove 里是非数字"),
            ):
                try:
                    _plan_call(bad_payload)
                    ab_bad.append(f"「{why}」竟然没被拒")
                except (ValueError, TypeError):
                    pass
            # ② 负向自证：上面全被拒之后，照片一张没少、次序一个没动
            if [p.order for p in _su.SESSION.photos] != orders0:
                ab_bad.append("被拒的请求留下了脚印（次序变了）")

            # ③ 正向：删掉第 3 张
            victim = orders0[2]
            _plan_call({"remove": [victim]})
            got = [p.order for p in _su.SESSION.photos]
            if got != [o for o in orders0 if o != victim]:
                ab_bad.append(f"删完次序不对：{got} 期望 {[o for o in orders0 if o != victim]}")

            # ④ ★ 挪位：把当前第 1 张挪到第 3 位（位次口径），编号集合必须一毫不变
            cur = [p.order for p in _su.SESSION.photos]
            expect = cur[:]
            expect.insert(2, expect.pop(0))
            _plan_call({"order": expect})
            now = [p.order for p in _su.SESSION.photos]
            if now != expect:
                ab_bad.append(f"挪位次序不对：{now} 期望 {expect}")
            if sorted(now) != sorted(cur):
                ab_bad.append("挪位把照片编号集合改了（重编号了）")

            # ⑤ 负向：order 长度对不上 / 塞未知编号 —— 拒，且状态不动
            before = [p.order for p in _su.SESSION.photos]
            for bad_payload, why in (
                ({"order": before[:-1]}, "order 少一个"),
                ({"order": before[:-1] + [999999]}, "order 里塞未知编号"),
            ):
                try:
                    _plan_call(bad_payload)
                    ab_bad.append(f"「{why}」竟然没被拒")
                except (ValueError, TypeError):
                    pass
            if [p.order for p in _su.SESSION.photos] != before:
                ab_bad.append("被拒的 order 请求留下了脚印")

            # ⑥ 组合：一次请求里「先删再排」
            drop = before[1]
            rest = [o for o in before if o != drop]
            neworder = rest[2:] + rest[:2]
            _plan_call({"remove": [drop], "order": neworder})
            final = [p.order for p in _su.SESSION.photos]
            if final != neworder:
                ab_bad.append(f"「先删后排」结果不对：{final} 期望 {neworder}")

            # ⑦ ★★ /thumb 的取图键仍有效 —— 这是"没重编号"最硬的证据。
            #    真照片文件还在，按原编号应该能取到图（不重编号 ⇒ 编号仍指向同一张）。
            sample = final[len(final) // 2]
            hit = [p for p in _su.SESSION.photos if p.order == sample]
            if len(hit) != 1 or not hit[0].path.exists():
                ab_bad.append(f"/thumb 取图键失效：order={sample} 找不到唯一照片")

            summary_ab = (
                f"删 {n0}→{len(got)} 张、挪位后编号集合不变、"
                f"四处非法输入全被拒且零脚印、一次请求「先删后排」也对；"
                f"负向自证全过（四种拒绝 + 两处零脚印）"
            ) if not ab_bad else "；".join(ab_bad)
        finally:
            _su.json_response = _real_resp
    except Exception as _exc:  # noqa: BLE001
        summary_ab = f"{type(_exc).__name__}: {_exc}"
        ab_bad = [summary_ab]
    results.append((
        "成功AB 删照片/挪位都不重编号（Phase 37）",
        "通过" if not ab_bad else "失败",
        summary_ab,
    ))

    # ------------------------------------------------------------------
    # 成功AC 「打开画册」= 无边框全屏（Phase 40；Phase 42 起 URI 上不挂任何标记）
    # ------------------------------------------------------------------
    # 佘先生 2026-09-30：「我要的全屏是类似电脑游戏的全屏模式，屏幕上方不能有
    # 浏览器显示」。做法：命令行 `--app=<uri>` 加 `--start-fullscreen`。
    #
    # ★ 这一题**一个浏览器都不启动**：把 _run_detached 换成记录器，只看
    #   「该发什么命令」和「什么情况下该退回老办法」。
    # ★ 负向自证：拿**故意错的**命令行喂给判据，它必须报错 —— 否则它只是碰巧
    #   全绿，抓不住"其实开成了一个带标签页的普通窗口"这种坏法。
    ac_bad: list[str] = []
    try:
        import importlib

        _uc = importlib.import_module("ui_common")

        fake_book = tmp / "fsbook" / "我的 小狗" / "index.html"
        fake_book.parent.mkdir(parents=True, exist_ok=True)
        fake_book.write_text("<html></html>", encoding="utf-8")

        launched: list[list[str]] = []
        fell_back: list[str] = []

        _real_run = _uc._run_detached
        _real_fallback = _uc.open_in_browser
        _real_looks = _uc.looks_chromium
        _real_exe = _uc.browser_exe_from_command

        def _ab_check(cmd: list[str]) -> list[str]:
            """判据本体：给一条命令行，挑毛病。"""
            if len(cmd) < 3:
                return [f"命令行太短：{cmd}"]
            problems: list[str] = []
            uri = str(cmd[1])
            if not uri.startswith("--app=file:///"):
                problems.append(f"第 2 个参数不是 --app=file:///：{uri}")
            if "--start-fullscreen" not in cmd:
                problems.append("少了 --start-fullscreen（会开成一个带标签页的普通窗口）")
            if "--user-data-dir" in " ".join(str(c) for c in cmd):
                problems.append("带了 --user-data-dir（会甩开用户自己的浏览器配置）")
            if " " in uri:
                problems.append(f"URI 没转义（空格会喂坏命令行）：{uri}")
            # ★ Phase 42：URI 上**不许**再挂标记。Phase 41 挂过 `#fullscreen`，可它
            #   会赖着不走（findings 126）⇒ 用户退出全屏后阅读器永远停在静读态、
            #   控制条再也回不来。现在 reader 自己认 `(display-mode: fullscreen)`
            #   （findings 123/124），命令行只要给一个干净的书页地址。
            if "#" in uri:
                problems.append(f"URI 带了 # 标记（退全屏后会赖着不走，findings 126）：{uri}")
            if not uri.endswith("/index.html"):
                problems.append(f"URI 指歪了：{uri}")
            return problems

        try:
            _uc._run_detached = lambda cmd: launched.append(list(cmd))
            _uc.open_in_browser = lambda t: fell_back.append(str(t)) or True
            _uc.looks_chromium = lambda p: True
            _uc.browser_exe_from_command = lambda c: Path("C:/fake/Chromium Browser.exe")

            # ① 正向：认得出 Chromium 系 ⇒ 发无边框全屏命令，且不退
            _uc.open_book_fullscreen(fake_book)
            if len(launched) != 1:
                ac_bad.append(f"该发 1 条命令，实际 {len(launched)} 条")
            else:
                ac_bad += _ab_check(launched[0])
            if fell_back:
                ac_bad.append("认得出 Chromium 却退回了普通打开")

            good = list(launched[0]) if launched else []

            # ② ★ 负向自证：判据必须挑得出毛病，逐条试（缺一个都不能放过）
            if good:
                if _ab_check(good):
                    ac_bad.append(f"判据把对的也报错：{_ab_check(good)}")
                for mutated, why in (
                    ([c for c in good if c != "--start-fullscreen"], "缺 --start-fullscreen"),
                    (["x", "file:///a/index.html", "--start-fullscreen"], "不是 --app="),
                    (good + ["--user-data-dir=C:/tmp/x"], "多带 --user-data-dir"),
                    (["x", "--app=file:///a/ 有空格.html", "--start-fullscreen"], "URI 没转义"),
                    (["x", "--app=file:///a/other.html", "--start-fullscreen"], "URI 指歪"),
                    ([c + "#fullscreen" if c.startswith("--app=") else c for c in good],
                     "URI 又挂上了 #fullscreen 标记"),
                ):
                    if not _ab_check(mutated):
                        ac_bad.append(f"判据抓不住「{why}」（假绿）")

            # ③ 负向：不是 Chromium 系（比如 Firefox）⇒ 必须退回普通打开
            launched.clear()
            fell_back.clear()
            _uc.looks_chromium = lambda p: False
            _uc.open_book_fullscreen(fake_book)
            if launched:
                ac_bad.append("认不出 Chromium 还硬发 --app=（会开出一个带标签页的窗口）")
            if len(fell_back) != 1:
                ac_bad.append("认不出 Chromium 时没退回普通打开")

            # ④ 负向：抠不出浏览器 exe ⇒ 也退回
            launched.clear()
            fell_back.clear()
            _uc.looks_chromium = _real_looks
            _uc.browser_exe_from_command = lambda c: None
            _uc.open_book_fullscreen(fake_book)
            if launched or len(fell_back) != 1:
                ac_bad.append("抠不出浏览器 exe 时没退回普通打开")

            # ⑤ 负向：放出去就失败 ⇒ 退回，且不许把异常丢给用户
            launched.clear()
            fell_back.clear()
            _uc.browser_exe_from_command = lambda c: Path("C:/fake/Chromium Browser.exe")
            _uc.looks_chromium = lambda p: True

            def _boom(cmd):
                raise OSError("模拟浏览器起不来")

            _uc._run_detached = _boom
            _uc.open_book_fullscreen(fake_book)
            if len(fell_back) != 1:
                ac_bad.append("启动失败时没退回普通打开（用户点了会毫无反应）")

            # ⑥ 真抠命令行：复刻"路径带空格 + --single-argument %1"这种形态
            #    ★ 自己造一个真实存在的 exe 再抠（抠取逻辑要求 exe 真的存在）——
            #      原先拿本机装的浏览器当样本，换台没装它的机器这条就假红；
            #      自造样本既与机器解耦，也不在仓库里留本机账号名。
            probe_dir = Path(tempfile.mkdtemp(prefix="示例用户（本机）Tabbit Browser "))
            try:
                probe_exe = probe_dir / "Tabbit Browser.exe"
                probe_exe.write_bytes(b"")
                tabbit_cmd = f'"{probe_exe}" --single-argument %1'
                got = _real_exe(tabbit_cmd)
                if got is None or got.name != "Tabbit Browser.exe":
                    ac_bad.append(f"从 shell 命令行里抠 exe 失败：{got}")
            finally:
                shutil.rmtree(probe_dir, ignore_errors=True)
            if _real_exe("python.exe %1") is not None:
                ac_bad.append("不带引号也硬抠（会切出半截路径）")

            # ⑦ 真认亲：本机默认浏览器必须认得出（认不出就等于这条功能没生效）
            real_exe_path = _real_exe(_uc._default_browser_command())
            if real_exe_path is not None and not _real_looks(real_exe_path):
                ac_bad.append(f"本机默认浏览器没认出来：{real_exe_path}")
        finally:
            _uc._run_detached = _real_run
            _uc.open_in_browser = _real_fallback
            _uc.looks_chromium = _real_looks
            _uc.browser_exe_from_command = _real_exe

        summary_ac = (
            "认得出 Chromium 就发 --app=<干净的书页地址> + --start-fullscreen；"
            "认不出／抠不到 exe／启动失败，三种情况都退回普通打开；"
            "负向自证全过（6 种坏命令行全被抓出，含「又挂上 #fullscreen 标记」那条）"
        ) if not ac_bad else "；".join(ac_bad)
    except Exception as _exc:  # noqa: BLE001
        summary_ac = f"{type(_exc).__name__}: {_exc}"
        ac_bad = [summary_ac]
    results.append((
        "成功AC 「打开画册」走无边框全屏（Phase 40/42）",
        "通过" if not ac_bad else "失败",
        summary_ac,
    ))

    # --- 跨页配对回归（核心不变量，见 check_spreads 的说明）
    check_spreads()

    # --- 输出报告
    print(f"{'用例':<34} {'结果':<6} 摘要")
    print("-" * 88)
    for name, verdict, summary in results:
        print(f"{name:<34} {verdict:<6} {summary[:44]}")

    passed = sum(1 for _, v, _ in results if v == "通过")
    print("-" * 88)
    print(f"共 {len(results)} 项，通过 {passed}，失败 {len(results) - passed}")

    # 清理临时目录
    shutil.rmtree(tmp, ignore_errors=True)
    return 0 if passed == len(results) else 1


if __name__ == "__main__":
    sys.exit(main())
