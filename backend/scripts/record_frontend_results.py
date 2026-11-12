#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""前端 vitest 执行结果 → 测试结果库/results.jsonl（后端执行记录器的前端补口）。

为什么需要它：`tests/backend/conftest.py` 是 pytest 插件，只能记录后端用例。前端
vitest 跑完原本对报告毫无贡献 —— 1033 条前端用例在《测试报告》里永远显示
「未执行」。本脚本把 vitest 的 JSON 报告翻成与后端完全相同的记录格式，
追加进同一份 results.jsonl，报告侧无需任何特判。

用法：
    npx vitest run --reporter=json --outputFile=/tmp/vitest.json
    python3 scripts/record_frontend_results.py --json /tmp/vitest.json

关联口径：case_index.json 的前端键为 `frontend/src/<相对路径>::<测试标题>`，
vitest 的 `title` 即 `it()/test()` 第一个字符串参数，两者逐字对应。
同一 (文件, 标题) 的多个断言（describe 重名/多次调用）按最差状态归并，
与后端「参数化变体按 base nodeid 归并、同 run 内取最差」保持一致。
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
from datetime import datetime
from pathlib import Path

from _git import git_commit

REPO = Path(__file__).resolve().parents[2]
FRONTEND = REPO / "frontend"
CASE_INDEX = REPO / "tests" / "backend" / "_report" / "case_index.json"

RESULTS = REPO / "docs" / "testing" / "测试结果库" / "results.jsonl"

_RANK = {"PASS": 0, "SKIP": 1, "FAIL": 2, "ERROR": 3}


def _status(raw: str) -> str:
    return {
        "passed": "PASS",
        "failed": "FAIL",
        "skipped": "SKIP",
        "pending": "SKIP",
        "todo": "SKIP",
        "disabled": "SKIP",
    }.get(raw, "FAIL" if raw else "SKIP")


def _rel_key(abs_path: str, title: str) -> str | None:
    """绝对路径 → `tests/frontend/...::标题`（仓库根基准）。

    2026-11-04 前端测试整体迁到仓库根 tests/frontend/ 后，键必须改成仓库根基准；
    旧口径用 relative_to(FRONTEND)，对包外路径直接 ``return None``——那是静默丢记录，
    不是报错（曾经每天丢掉整批前端记录而报告只显示「未执行」）。
    """
    try:
        p = Path(abs_path).resolve()
        rel = p.relative_to(REPO.resolve())
    except Exception:
        return None
    return f"{rel.as_posix()}::{title}"


# it.each 的占位符：用例库记的是模板（`按字段数量 %s 使用标准宽度 %s`），
# 运行时展开成具体值（`按字段数量 2 使用标准宽度 520px`）。与后端 parametrize
# 一个函数一条用例同构 —— 变体必须归并回模板那一条，否则会凭空多出 N 条未收录用例。
#
# JS 模板字面量同理（2026-11-05）：用例库按源码收的是
# `测试文件总数等于 manifest 的 ${expected.files}`，vitest 报出的却是插值后的
# `... manifest 的 96`。此前只认 %s，这条用例一直落不了库，在官方报告里显示「未执行」。
# 两类占位符统一在此归并；**不要改测试标题**（标题是用例编号的键，改了会漂移）。
_PLACEHOLDER = re.compile(r"%[sdifjoO]|\$\{[^{}]*\}")


def _template_regex(title: str) -> "re.Pattern[str]":
    parts = _PLACEHOLDER.split(title)
    return re.compile("^" + "(.*?)".join(re.escape(p) for p in parts) + "$", re.S)


def _build_templates(index: dict) -> dict:
    """文件 → [(模板正则, 用例键)]，供 it.each 变体归并。"""
    out: dict = {}
    for key in index:
        if not key.startswith("tests/frontend/"):
            continue
        fname, _, title = key.partition("::")
        if _PLACEHOLDER.search(title):
            out.setdefault(fname, []).append((_template_regex(title), key))
    return out


def _match_template(templates: dict, key: str) -> str | None:
    fname, _, title = key.partition("::")
    cands = [lib for pat, lib in templates.get(fname, []) if pat.match(title)]
    return cands[0] if len(cands) == 1 else None


def main() -> int:
    ap = argparse.ArgumentParser(description="把 vitest JSON 结果写入测试结果库")
    ap.add_argument("--json", required=True, help="vitest --reporter=json 的输出文件")
    ap.add_argument("--dry-run", action="store_true", help="只统计不写入")
    args = ap.parse_args()

    report_path = Path(args.json)
    if not report_path.is_absolute():
        report_path = (FRONTEND / report_path).resolve()
    if not report_path.exists():
        print(f"[fe] 找不到 vitest JSON：{report_path}")
        return 2

    index: dict = json.loads(CASE_INDEX.read_text(encoding="utf-8"))
    data = json.loads(report_path.read_text(encoding="utf-8"))
    tests = data.get("testResults") or []

    # nodeid -> (最差状态, 累计耗时)
    agg: dict[str, dict] = {}
    unmatched: list[str] = []
    total_assert = 0
    for suite in tests:
        fname = suite.get("name") or ""
        for a in suite.get("assertionResults") or []:
            total_assert += 1
            key = _rel_key(fname, a.get("title") or "")
            if key is None:
                continue
            st = _status(a.get("status") or "")
            dur = float(a.get("duration") or 0) / 1000.0
            cur = agg.get(key)
            if cur is None:
                agg[key] = {"status": st, "duration": dur,
                            "reason": "" if st == "PASS" else (a.get("failureMessages") or [""])[0][:400]}
            else:
                cur["duration"] += dur
                if _RANK[st] > _RANK[cur["status"]]:
                    cur["status"] = st
                    if st != "PASS":
                        cur["reason"] = (a.get("failureMessages") or [""])[0][:400]

    templates = _build_templates(index)
    matched: dict[str, dict] = {}
    unmatched: list[str] = []
    variants = 0
    for key, v in agg.items():
        target = key if key in index else _match_template(templates, key)
        if target is None:
            unmatched.append(key)
            continue
        if target != key:
            variants += 1
        cur = matched.get(target)
        if cur is None:
            matched[target] = dict(v)
        else:
            cur["duration"] += v["duration"]
            if _RANK[v["status"]] > _RANK[cur["status"]]:
                cur["status"] = v["status"]
                cur["reason"] = v["reason"]

    now = datetime.now()
    run_id = f"{now.strftime('%Y%m%d-%H%M%S')}-{git_commit(REPO)}-fe"
    commit = git_commit(REPO)
    env = "ci" if (os.environ.get("CI") or os.environ.get("GITHUB_ACTIONS")) else "local"
    evidence = str(report_path.name)

    if not args.dry_run and matched:
        RESULTS.parent.mkdir(parents=True, exist_ok=True)
        with RESULTS.open("a", encoding="utf-8") as f:
            for key, v in matched.items():
                f.write(json.dumps({
                    "run_id": run_id,
                    "commit": commit,
                    "env": env,
                    "db": "",
                    "time": now.isoformat(timespec="seconds"),
                    "nodeid": key,
                    "case_no": index[key],
                    "status": v["status"],
                    "duration": round(v["duration"], 4),
                    "reason": (v["reason"] or "").replace("\n", " "),
                    "evidence": evidence,
                }, ensure_ascii=False) + "\n")

    dist: dict[str, int] = {}
    for v in matched.values():
        dist[v["status"]] = dist.get(v["status"], 0) + 1

    print(f"[fe] vitest 断言={total_assert} 唯一用例={len(agg)} 命中用例库={len(matched)} "
          f"（其中 it.each 变体归并 {variants} 条） 未命中={len(unmatched)}")
    print(f"[fe] 状态分布={dist}")
    if unmatched:
        print("[fe] 未命中示例（用例库标题与源码漂移或未收录）：")
        for k in unmatched[:8]:
            print(f"     {k}")
    if args.dry_run:
        print("[fe] --dry-run：未写入")
    elif matched:
        print(f"[fe] 已追加 {len(matched)} 条 → {RESULTS}")
    else:
        print("[fe] 无命中，未写入")
    return 0


if __name__ == "__main__":
    sys.exit(main())
