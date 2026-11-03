#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Playwright E2E 执行结果 → 测试结果库/results.jsonl（后端执行记录器的 E2E 补口）。

为什么需要它：`tests/v1/conftest.py` 只能记录 pytest，`record_frontend_results.py`
只能记录 vitest。E2E 跑完原本只在终端留痕 —— 浏览器用例在《测试报告》里
永远显示「未执行」，报告的 E2E 行恒为 0。本脚本把 Playwright 的 JSON 报告翻成
与后端完全相同的记录格式，追加进同一份 results.jsonl，报告侧无需任何特判。

用法：
    npx playwright test            # playwright.config.ts 已配 json reporter
    python3 scripts/record_e2e_results.py --json test-results/playwright-report.json

关联口径：case_index.json 的 E2E 键为 `frontend/e2e/<规格文件名>::<标题>`。
Playwright JSON 的 `spec.file` 是**相对 testDir 的路径**（`modal-footer.spec.ts`，
不是 `frontend/e2e/modal-footer.spec.ts`），故必须显式补 `frontend/e2e/` 前缀，
否则全部记录落空、报告仍旧显示 0。

状态映射：
    test.status  expected   -> PASS
                 unexpected -> FAIL
                 flaky      -> PASS（重试后最终通过），reason 记「重试后通过」，
                               不能记 FAIL —— 那会让报告把「不稳定」误报成「一直红」
                 skipped    -> SKIP
同一 spec 在多个 project / 多次重试下有多条 test，按最差状态归并，与后端
「参数化变体按 base nodeid 归并、同 run 内取最差」保持一致。
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from datetime import datetime
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
FRONTEND = REPO / "frontend"
CASE_INDEX = REPO / "backend" / "tests" / "v1" / "_report" / "case_index.json"
RESULTS = REPO / "docs" / "testing" / "测试结果库" / "results.jsonl"

_RANK = {"PASS": 0, "SKIP": 1, "FAIL": 2, "ERROR": 3}

# Playwright test.status -> 体系状态
_STATUS = {
    "expected": "PASS",
    "unexpected": "FAIL",
    "flaky": "PASS",
    "skipped": "SKIP",
}
# 结果级状态：timedOut / interrupted 都属执行异常，先归 ERROR 交由 report 区分
_RESULT_STATUS = {
    "passed": "PASS",
    "failed": "FAIL",
    "timedOut": "FAIL",
    "interrupted": "ERROR",
    "skipped": "SKIP",
}


def _git_commit() -> str:
    try:
        out = subprocess.run(["git", "rev-parse", "--short", "HEAD"], cwd=REPO,
                             capture_output=True, text=True, check=False)
        if out.returncode == 0 and out.stdout.strip():
            return out.stdout.strip()
    except Exception:
        pass
    return "unknown"


def _skip_expr(text: str, i: int) -> int:
    """i 指向 `{`，返回配对 `}` 之后的位置。

    嵌套 `${...}` 里的 `{` 同样计入深度，故两层模板（`` `a${x ? `${n}` : ""}` ``）
    也能正确配对。标题里不会出现裸花括号，无需区分是否在字符串内。
    """
    depth = 0
    j = i
    while j < len(text):
        ch = text[j]
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                return j + 1
        j += 1
    return len(text)


def _template_regex(title: str) -> "re.Pattern[str]":
    """用例库里的模板标题（含 `${...}`）→ 匹配运行时展开标题的正则。

    与 `record_frontend_results.py` 处理 `it.each` 的 `%s` 同构：源码里一个
    ``test(`导航可达：${label}`)`` 是一条用例定义，运行时展开成 5 条，必须归并
    回同一条，否则用例库会凭空多出 4 条「未收录」。
    """
    parts: list[str] = []
    i = 0
    while i < len(title):
        j = title.find("${", i)
        if j < 0:
            parts.append(re.escape(title[i:]))
            break
        parts.append(re.escape(title[i:j]))
        parts.append(".*?")
        i = _skip_expr(title, j + 1)
    return re.compile("^" + "".join(parts) + "$", re.S)


def _build_templates(index: dict) -> dict:
    """文件 → [(模板正则, 用例键)]，供模板标题的运行时展开归并。"""
    out: dict = {}
    for key in index:
        if not key.startswith("frontend/e2e/"):
            continue
        fname, _, title = key.partition("::")
        if "${" in title:
            out.setdefault(fname, []).append((_template_regex(title), key))
    return out


def _match_template(templates: dict, key: str) -> str | None:
    fname, _, title = key.partition("::")
    cands = [k for pat, k in templates.get(fname, []) if pat.match(title)]
    return cands[0] if len(cands) == 1 else None


def _walk_suites(suites, out: list) -> None:
    """递归收集 spec（describe 嵌套时 suites 会套 suites）。"""
    for s in suites or []:
        for sp in s.get("specs") or []:
            out.append(sp)
        _walk_suites(s.get("suites"), out)


def main() -> int:
    ap = argparse.ArgumentParser(description="把 Playwright E2E JSON 结果写入测试结果库")
    ap.add_argument("--json", default="test-results/playwright-report.json",
                    help="playwright json reporter 的输出文件（相对 frontend/）")
    ap.add_argument("--dry-run", action="store_true", help="只统计不写入")
    args = ap.parse_args()

    report_path = Path(args.json)
    if not report_path.is_absolute():
        report_path = (FRONTEND / report_path).resolve()
    if not report_path.exists():
        print(f"[e2e] 找不到 Playwright JSON：{report_path}")
        print("[e2e] 请先执行 `npx playwright test`（playwright.config.ts 已配 json reporter）")
        return 2

    index: dict = json.loads(CASE_INDEX.read_text(encoding="utf-8"))
    data = json.loads(report_path.read_text(encoding="utf-8"))

    specs: list = []
    _walk_suites(data.get("suites"), specs)

    raw: dict[str, dict] = {}
    for sp in specs:
        file = (sp.get("file") or "").replace("\\", "/").lstrip("./")
        title = sp.get("title") or ""
        if not file:
            continue
        key = f"frontend/e2e/{file}::{title}"

        duration = 0.0
        reason = ""
        flaky = False
        for t in sp.get("tests") or []:
            st = _STATUS.get(t.get("status") or "", "FAIL")
            if st == "PASS" and t.get("status") == "flaky":
                flaky = True
            results = t.get("results") or []
            for r in results:
                duration += float(r.get("duration") or 0) / 1000.0
            if st == "FAIL":
                # 取最后一次尝试的错误摘要，便于直接看出红在哪
                errs = (results[-1].get("errors") or []) if results else []
                msg = errs[0].get("message") if errs and isinstance(errs[0], dict) else ""
                reason = re.sub(r"\s+", " ", (msg or ""))[:400]
            cur = raw.get(key)
            if cur is None or _RANK[st] > _RANK[cur["status"]]:
                raw[key] = {"status": st, "duration": duration,
                            "reason": reason, "flaky": flaky}
            else:
                cur["duration"] += duration
                if flaky:
                    cur["flaky"] = True
        if key in raw and flaky and raw[key]["status"] == "PASS":
            raw[key]["flaky"] = True

    # 归并到用例库编号
    templates = _build_templates(index)
    matched: dict[str, dict] = {}
    unmatched: list[str] = []
    variants = 0
    for key, v in raw.items():
        target = key if key in index else _match_template(templates, key)
        if target is None:
            unmatched.append(key)
            continue
        if target != key:
            variants += 1
        cur = matched.get(target)
        if cur is None:
            matched[target] = dict(v)
            if v["flaky"]:
                matched[target]["reason"] = "重试后通过（flaky）"
        else:
            cur["duration"] += v["duration"]
            if _RANK[v["status"]] > _RANK[cur["status"]]:
                cur["status"] = v["status"]
                cur["reason"] = v["reason"]
            if v["flaky"]:
                cur["flaky"] = True

    now = datetime.now()
    commit = _git_commit()
    run_id = f"{now.strftime('%Y%m%d-%H%M%S')}-{commit}-e2e"
    env = "ci" if (os.environ.get("CI") or os.environ.get("GITHUB_ACTIONS")) else "local"
    evidence = str(report_path.relative_to(FRONTEND)) if report_path.is_relative_to(FRONTEND) \
        else str(report_path.name)

    if not args.dry_run and matched:
        RESULTS.parent.mkdir(parents=True, exist_ok=True)
        with RESULTS.open("a", encoding="utf-8") as f:
            for key, v in matched.items():
                f.write(json.dumps({
                    "run_id": run_id,
                    "commit": commit,
                    "env": env,
                    "db": "heijin_erp_e2e",
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
    flaky_n = sum(1 for v in matched.values() if v.get("flaky"))

    print(f"[e2e] spec={len(specs)} 唯一用例={len(raw)} 命中用例库={len(matched)} "
          f"（模板展开归并 {variants} 条） 未命中={len(unmatched)} flaky={flaky_n}")
    print(f"[e2e] 状态分布={dist}")
    if unmatched:
        print("[e2e] 未命中示例（用例库标题与规格漂移、或新规格未登记）：")
        for k in unmatched[:8]:
            print(f"     {k}")
    if args.dry_run:
        print("[e2e] --dry-run：未写入")
    elif matched:
        print(f"[e2e] 已追加 {len(matched)} 条 → {RESULTS}")
    else:
        print("[e2e] 无命中，未写入")
    return 0


if __name__ == "__main__":
    sys.exit(main())
