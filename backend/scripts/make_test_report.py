#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""宜游轩 ERP 测试报告生成器。

聚合：
  - docs/testing/测试用例库.csv   （用例定义：编号/模块/层级/功能/文件）
  - docs/testing/测试结果库/results.jsonl  （每次执行的追加记录，历史不覆盖）

产出：
  - docs/testing/测试报告.md   （模块×层级矩阵、SKIP/ERROR 单列、跨模块覆盖、按功能查询）
  - docs/testing/测试报告.json （机器可读汇总，供 CI 上传/比对）

验收对齐：
  - A–F/SYS 各模块用例数 + 最近执行结果
  - UT/IT/E2E 各层级用例数 + 最近执行结果
  - 跨模块测试覆盖情况（FLOW-*）
  - 任意功能编号 -> 用例 / 方法 / 合格标准 / 最近是否通过 / 历史 / 失败原因 / 代码
"""
from __future__ import annotations

import csv
import json
import os
from collections import Counter, defaultdict
from datetime import datetime, timezone

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
CASE_CSV = os.path.join(REPO, "docs", "testing", "测试用例库.csv")
RESULTS = os.path.join(REPO, "docs", "testing", "测试结果库", "results.jsonl")
OUT_MD = os.path.join(REPO, "docs", "testing", "测试报告.md")
OUT_JSON = os.path.join(REPO, "docs", "testing", "测试报告.json")

MODULES = ["A", "B", "C", "D", "E", "F", "SYS"]
LAYERS = ["UT", "IT", "E2E"]


def load_cases() -> dict[str, dict]:
    cases: dict[str, dict] = {}
    if not os.path.exists(CASE_CSV):
        return cases
    with open(CASE_CSV, encoding="utf-8-sig") as f:
        for row in csv.DictReader(f):
            no = row.get("测试编号", "").strip()
            if no:
                cases[no] = row
    return cases


def load_results() -> list[dict]:
    if not os.path.exists(RESULTS):
        return []
    out = []
    with open(RESULTS, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                out.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    return out


def main() -> None:
    cases = load_cases()
    results = load_results()

    # case_no -> 最近一次执行（按 run 聚合）+ 历史
    # 重要：参数化变体（test_x[param]）在 conftest 里按 base nodeid 归并到同一 case_no，
    # 故同一 run 内可能出现多条不同 status 的记录。latest 口径必须是「最近一次 run」内取最差，
    # 不能逐条比 time（秒级精度会碰撞，且末条可能是 PASS 而掩盖同 run 内的 FAIL）。
    history: dict[str, list[dict]] = defaultdict(list)
    run_ids = []
    records_by_case: dict[str, list[dict]] = defaultdict(list)
    for r in results:
        run_id = r.get("run_id")
        if run_id and run_id not in run_ids:
            run_ids.append(run_id)  # 文件顺序=追加顺序=时间顺序，末尾即最近 run
        no = r.get("case_no") or ""
        if no:
            history[no].append(r)
            records_by_case[no].append(r)

    def worst(statuses: list[str]) -> str:
        if any(s in ("FAIL", "ERROR") for s in statuses):
            return "FAIL"
        if any(s == "SKIP" for s in statuses):
            return "SKIP"
        if statuses and all(s == "PASS" for s in statuses):
            return "PASS"
        return "—"

    latest: dict[str, dict] = {}
    for no, recs in records_by_case.items():
        last_run_for_no = recs[-1].get("run_id")  # 文件末尾=最近一次运行
        in_last = [x for x in recs if x.get("run_id") == last_run_for_no]
        if not in_last:
            in_last = recs
        st = worst([x.get("status", "—") for x in in_last])
        # 代表记录：优先取失败记录以便展示原因，否则取末条
        rep = next((x for x in in_last if x.get("status") in ("FAIL", "ERROR")), in_last[-1])
        rep = dict(rep)
        rep["status"] = st
        latest[no] = rep

    last_run = run_ids[-1] if run_ids else None

    # 模块 × 层级：用例定义数 与 最近执行结果分布
    def_mod = Counter()          # 定义数（按 模块|层级）
    def_mod_total = Counter()    # 定义数（按 模块）
    last_status = defaultdict(Counter)   # 最近状态（按 模块）
    for no, c in cases.items():
        mod = c.get("所属模块", "")
        layer = c.get("测试层级", "")
        def_mod[f"{mod}|{layer}"] += 1
        def_mod_total[mod] += 1
        st = latest.get(no, {}).get("status", "—")
        last_status[mod][st] += 1

    # 层级定义数 / 最近结果
    layer_def = Counter()
    layer_last = Counter()
    for no, c in cases.items():
        layer_def[c.get("测试层级", "")] += 1
        layer_last[latest.get(no, {}).get("status", "—")] += 1

    # 跨模块覆盖（FLOW-*）
    flow_cases = [c for c in cases.values() if c.get("流程编号", "").strip()]
    flow_status = Counter()
    for c in flow_cases:
        no = c["测试编号"]
        flow_status[latest.get(no, {}).get("status", "—")] += 1

    # ----- 输出 MD -----
    now = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    L = ["# 宜游轩 ERP 测试报告", "", f"> 生成：{now} ｜ 最近执行 run_id：`{last_run or '无'}` ｜ "
         f"历史执行批次：{len(run_ids)} 次", ""]
    L.append("## 一、模块 × 层级 用例分布与最近结果")
    L.append("")
    L.append("| 模块 | 定义用例 | UT最近 | IT最近 | E2E最近 | PASS | FAIL | SKIP | ERROR |")
    L.append("|---|---|---|---|---|---|---|---|---|")
    for m in MODULES:
        d_ut = def_mod.get(f"{m}|UT", 0)
        d_it = def_mod.get(f"{m}|IT", 0)
        d_e2e = def_mod.get(f"{m}|E2E", 0)
        st = last_status.get(m, Counter())
        L.append(f"| {m} | {def_mod_total.get(m,0)} | {d_ut} | {d_it} | {d_e2e} | "
                 f"{st.get('PASS',0)} | {st.get('FAIL',0)} | {st.get('SKIP',0)} | {st.get('ERROR',0)} |")
    L.append("")

    L.append("## 二、测试层级分布（定义 / 最近结果）")
    L.append("")
    L.append("| 层级 | 定义用例 | PASS | FAIL | SKIP | ERROR |")
    L.append("|---|---|---|---|---|---|")
    for ly in LAYERS:
        st = Counter()
        for no, c in cases.items():
            if c.get("测试层级") == ly:
                st[latest.get(no, {}).get("status", "—")] += 1
        L.append(f"| {ly} | {layer_def.get(ly,0)} | {st.get('PASS',0)} | {st.get('FAIL',0)} | "
                 f"{st.get('SKIP',0)} | {st.get('ERROR',0)} |")
    L.append("")

    L.append("## 三、跨模块测试覆盖（FLOW-*）")
    L.append("")
    if flow_cases:
        L.append(f"- 跨模块流程用例：**{len(flow_cases)}** 条；最近结果 "
                 f"PASS={flow_status.get('PASS',0)} FAIL={flow_status.get('FAIL',0)} "
                 f"SKIP={flow_status.get('SKIP',0)} ERROR={flow_status.get('ERROR',0)}")
        L.append("")
        L.append("| 流程编号 | 测试编号 | 主功能 | 跨模块 | 最近状态 |")
        L.append("|---|---|---|---|---|")
        seen = set()
        for c in flow_cases:
            fl = c.get("流程编号", "")
            if fl in seen:
                continue
            seen.add(fl)
            L.append(f"| {fl} | {c['测试编号']} | {c.get('功能名称','')} | "
                     f"{c.get('关联模块','') or c.get('所属模块','')} | "
                     f"{latest.get(c['测试编号'], {}).get('status','—')} |")
    else:
        L.append("- 暂无跨模块流程用例记录（请先运行 run_regression.py cross 生成执行记录）。")
    L.append("")

    L.append("## 四、未覆盖 / 风险")
    L.append("")
    no_exec = [no for no in cases if no not in latest]
    if no_exec:
        L.append(f"- 已定义但未执行（无执行记录）：**{len(no_exec)}** 条，例如 "
                 + "、".join(no_exec[:10]) + " …")
    fails = [no for no, r in latest.items() if r.get("status") in ("FAIL", "ERROR")]
    if fails:
        L.append(f"- 最近执行 FAIL/ERROR：**{len(fails)}** 条："
                 + "、".join(fails[:15]) + " …")
    skips = [no for no, r in latest.items() if r.get("status") == "SKIP"]
    if skips:
        L.append(f"- 最近执行 SKIP：**{len(skips)}** 条（SKIP 不计入 PASS）："
                 + "、".join(skips[:10]) + " …")
    pending = [no for no, c in cases.items() if c.get("合格标准", "") == "待确认"]
    if pending:
        L.append(f"- 合格标准「待确认」（业务规则待澄清）：**{len(pending)}** 条，需逐条补确认。")
    if not (no_exec or fails or skips or pending):
        L.append("- 当前无显著未覆盖/风险项。")
    L.append("")

    L.append("## 五、按功能编号查询（节选：最近执行状态）")
    L.append("")
    by_func: dict[str, list[dict]] = defaultdict(list)
    for no, c in cases.items():
        by_func[c.get("功能编号", "")].append(c)
    L.append("| 功能编号 | 功能名称 | 模块 | 用例数 | 最近PASS | 最近FAIL | 最近SKIP | 最近ERROR |")
    L.append("|---|---|---|---|---|---|---|---|")
    for fn in sorted(by_func):
        group = by_func[fn]
        name = group[0].get("功能名称", "")
        mod = group[0].get("所属模块", "")
        st = Counter()
        for c in group:
            st[latest.get(c["测试编号"], {}).get("status", "—")] += 1
        L.append(f"| {fn} | {name} | {mod} | {len(group)} | {st.get('PASS',0)} | "
                 f"{st.get('FAIL',0)} | {st.get('SKIP',0)} | {st.get('ERROR',0)} |")
    L.append("")

    L.append("---")
    L.append("> 用例定义见《测试用例库.csv》；每次执行明细见《测试结果库/results.jsonl》（按 run_id 可查历史，不覆盖）。")
    L.append("> 关联规则见《测试编号设计规范》《模块与跨模块测试集规范》。")

    with open(OUT_MD, "w", encoding="utf-8") as f:
        f.write("\n".join(L))

    # 机器可读汇总
    summary = {
        "generated_at": now,
        "last_run_id": last_run,
        "run_batches": len(run_ids),
        "cases_total": len(cases),
        "module_def": dict(def_mod_total),
        "layer_def": dict(layer_def),
        "cross_flow_cases": len(flow_cases),
        "no_execution": len(no_exec),
        "fail_error": len(fails),
        "skip": len(skips),
        "pending_criteria": len(pending),
    }
    with open(OUT_JSON, "w", encoding="utf-8") as f:
        json.dump(summary, f, ensure_ascii=False, indent=2)

    print(f"[report] 用例定义={len(cases)} 历史批次={len(run_ids)} 最近 run={last_run}")
    print(f"[report] 未执行={len(no_exec)} FAIL/ERROR={len(fails)} SKIP={len(skips)} 待确认合格标准={len(pending)}")
    print(f"[report] 输出：{OUT_MD}")


if __name__ == "__main__":
    main()
