#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""宜游轩 ERP 测试用例库生成器（A—F + SYS 测试编号体系）。

扫描后端 pytest + 前端 vitest 测试文件，自动生成：
  - docs/testing/测试用例库.csv   （12 核心字段 + 测试名称/功能名称/关联旧编号/流程编号/备注）
  - docs/testing/测试用例库.md    （按功能编号分组的可读视图）
  - tests/v1/_report/case_index.json   （nodeid -> 测试用例编号，供执行记录器关联）
  - tests/v1/_report/case_number_map.json（持久化序号，保证编号稳定不漂移）

编号规则：<类型>-<功能编号>-<三位序号>，类型=UT/IT/E2E，功能编号见 功能编号注册表.csv。
类型判定：后端落在 run_regression.py 的 unit 组 -> UT，其余 -> IT；前端 vitest -> IT。
幂等：重复运行只追加新用例序号，已分配编号冻结（case_number_map.json 持久化）。

文件 -> 功能 -> 模块(A/B/C/D/E/F/SYS) 的映射统一取自 scripts/test_catalog.py（单一事实源）。
"""
from __future__ import annotations

import ast
import csv
import json
import os
import re
import sys
from datetime import datetime, timezone

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))  # /Users/aries/黑金时代
BACKEND = os.path.join(REPO, "backend")
FRONTEND = os.path.join(REPO, "frontend")
REGISTRY = os.path.join(REPO, "docs/testing", "功能编号注册表.csv")
OUT_CSV = os.path.join(REPO, "docs/testing", "测试用例库.csv")
OUT_MD = os.path.join(REPO, "docs/testing", "测试用例库.md")
REPORT_DIR = os.path.join(BACKEND, "tests", "v1", "_report")
CASE_MAP = os.path.join(REPORT_DIR, "case_number_map.json")
CASE_INDEX = os.path.join(REPORT_DIR, "case_index.json")

# 统一目录（单一事实源）
sys.path.insert(0, os.path.join(BACKEND, "scripts"))
from test_catalog import (  # noqa: E402
    BACKEND_FILE_TO_FUNC,
    CROSS_FLOW_LABEL,
    backend_file_modules,
    frontend_func_for,
    frontend_file_modules,
    load_registry,
)


# ---------------------------------------------------------------------------
# 扫描测试函数
# ---------------------------------------------------------------------------
def scan_py(path: str):
    """返回 [(限定名, docstring, 函数源码)]。

    限定名必须带类名（`TestX::test_y`）：
      - 不同 Test 类下允许同名方法，只用函数名会让它们撞同一个编号；
      - `case_index.json` 的 nodeid 要与 pytest 真实 nodeid 逐字一致，否则执行记录
        关联不到编号，结果是「测了但报告里永远显示未执行」。
    只收模块级与类级函数 —— pytest 不会收集嵌套在其他函数里的 test_*。
    """
    src = open(path, encoding="utf-8").read()
    try:
        tree = ast.parse(src)
    except SyntaxError:
        return []
    out: list = []

    def _emit(node, prefix: str) -> None:
        out.append((prefix + node.name, ast.get_docstring(node),
                    ast.get_source_segment(src, node) or ""))

    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name.startswith("test_"):
            _emit(node, "")
        elif isinstance(node, ast.ClassDef):
            for sub in node.body:
                if isinstance(sub, (ast.FunctionDef, ast.AsyncFunctionDef)) and sub.name.startswith("test_"):
                    _emit(sub, f"{node.name}::")
    return out


TS_TOKEN = re.compile(r'\b(it|test)\s*\(\s*[\'"]([^\'"]+)[\'"]')


def scan_ts(path: str):
    src = open(path, encoding="utf-8").read()
    out = []
    for m in TS_TOKEN.finditer(src):
        out.append((m.group(2), None, ""))
    return out


# ---------------------------------------------------------------------------
# 提取 测试方法 / 合格标准 / 优先级 / 前置条件 / 输入数据
# ---------------------------------------------------------------------------
CALL_PATTERNS = [
    (re.compile(r'(?:client|api|requests)\.(get|post|put|delete|patch)\(\s*[\'"]([^\'"]+)[\'"]'),
     lambda m: f"{m.group(1).upper()} {m.group(2)}"),
    (re.compile(r'\b(post_event|create_order|reverse_cashflow|create_installment|pay|deliver|'
                r'allocate_number|to_money|mask_phone|seed_default_users|create_pool)\s*\('),
     lambda m: m.group(1) + "()"),
]

PRIORITY_HIGH = re.compile(r'contract|guard|security|auth|state_machine|ratelimit|public_release|critical', re.I)
PRIORITY_LOW = re.compile(r'\.deep\.|write\.|\.regression\.', re.I)
EXPECT_KW = re.compile(r'应|必须|返回|等于|拒绝|raise|正确|一致|不变|为\b|→|校验|不\b|仅', re.I)
NUM_LIT = re.compile(r'\b(?:Decimal\()?["\']?(\d{1,9}(?:\.\d{1,4})?)["\']?\)?')


def clean_doc(doc: str | None) -> str:
    if not doc:
        return ""
    d = re.sub(r'BIZ-[A-Z0-9\-]+', '', doc)
    d = re.sub(r'\(高\)|\(P0\)|\(P1\)|（高）|（待确认）', '', d)
    d = re.sub(r'\s+', ' ', d).strip()
    return d


def extract_method(test_type: str, relpath: str, body: str, func_id: str) -> str:
    if test_type == "UT":
        isolate = "无 DB/纯函数"
    elif relpath.startswith("frontend/"):
        isolate = "组件测试(mount/交互)"
    else:
        isolate = "真实 PG 隔离库(TRUNCATE 单事务)"
    main_op = "—"
    for pat, fmt in CALL_PATTERNS:
        m = pat.search(body)
        if m:
            main_op = fmt(m)
            break
    if relpath.startswith("frontend/") and main_op == "—":
        comp = os.path.basename(relpath).split(".")[0]
        main_op = f"组件渲染/交互({comp})"
    return f"{test_type}：{relpath}::{func_id}；{isolate}；主操作={main_op}"


def extract_input_data(body: str) -> str:
    # 从函数体提取前几个数值/字符串字面量作为典型输入
    nums = NUM_LIT.findall(body)
    seen = []
    for n in nums:
        if n not in seen:
            seen.append(n)
        if len(seen) >= 4:
            break
    if seen:
        return "典型输入量=" + ", ".join(seen)
    return "见测试方法主操作"


def extract_criteria(doc: str | None, body: str) -> tuple[str, str]:
    cd = clean_doc(doc)
    expected = cd or "见合格标准"
    sentences = re.split(r'[。；\n]', cd) if cd else []
    for s in sentences:
        s = s.strip()
        if EXPECT_KW.search(s) and len(s) >= 4:
            return expected, s
    for m in re.finditer(r'assert\s+[^,]+,\s*[\'"]([^\'"]+)[\'"]', body):
        return expected, m.group(1)
    if cd:
        return expected, cd
    return expected, "待确认"


def extract_priority(test_type: str, relpath: str, fname: str, func_id: str) -> str:
    if test_type == "UT":
        return "P2"
    hay = f"{relpath} {func_id} {fname}"
    if PRIORITY_HIGH.search(hay):
        return "P0"
    if PRIORITY_LOW.search(hay):
        return "P1"
    return "P1"


def extract_precond(relpath: str, body: str) -> str:
    if relpath.startswith("frontend/"):
        return "组件挂载；mock 网络层(apiMock)；局部渲染"
    items = []
    if "seeded_db" in body:
        items.append("隔离库 seeded_db")
    if "seeded_client" in body or "TestClient" in body:
        items.append("HTTP 客户端 seeded_client")
    if re.search(r'\bheaders\b|X-Dev-User|viewer_headers|operator_headers', body):
        items.append("admin/viewer/operator 鉴权头")
    if not items:
        items.append("无外部依赖")
    return "；".join(items)


# ---------------------------------------------------------------------------
# 主流程
# ---------------------------------------------------------------------------
def main() -> None:
    os.makedirs(REPORT_DIR, exist_ok=True)
    reg = load_registry()

    number_map: dict[str, int] = {}
    if os.path.exists(CASE_MAP):
        number_map = json.load(open(CASE_MAP, encoding="utf-8"))

    cases: list[dict] = []
    index: dict[str, str] = {}

    # ---- 后端 ----
    be_files = sorted(f for f in os.listdir(os.path.join(BACKEND, "tests", "v1"))
                      if f.startswith("test_") and f.endswith(".py"))
    for fname in be_files:
        func = BACKEND_FILE_TO_FUNC.get(fname, "SYS12")
        rel = f"backend/tests/v1/{fname}"
        primary, related = backend_file_modules(fname)
        is_unit = fname in _unit_files()
        ttype = "UT" if is_unit else "IT"
        flow = CROSS_FLOW_LABEL.get(fname, "")
        for tname, doc, body in scan_py(os.path.join(BACKEND, "tests", "v1", fname)):
            cases.append(_stage(ttype, func, rel, tname, doc, body, fname, primary, related, flow))

    # ---- 前端 ----
    for root, _dirs, files in os.walk(os.path.join(FRONTEND, "src")):
        for fn in files:
            if not (fn.endswith(".test.ts") or fn.endswith(".test.tsx")
                    or fn.endswith(".spec.ts") or fn.endswith(".spec.tsx")):
                continue
            full = os.path.join(root, fn)
            rel = "frontend/" + os.path.relpath(full, FRONTEND)
            func = frontend_func_for(rel)
            primary, related = frontend_file_modules(rel)
            for tname, doc, body in scan_ts(full):
                cases.append(_stage("IT", func, rel, tname, doc, body, fn, primary, related, ""))

    # ---- 稳定分配序号 ----
    cases.sort(key=lambda c: (c["功能编号"], c["测试层级"], c["自动化测试文件及函数"], c["测试函数标识"]))

    counters: dict[tuple[str, str], int] = {}
    for k, v in number_map.items():
        # map_key = 层级|功能编号|文件名|函数名 —— 只取前两段作计数维度。
        # 曾写成 k.split("|", 1)，把「功能编号|文件名|函数」整段当成功能编号，
        # 计数种子永远匹配不上，新用例从 001 重数并与既有编号撞号。
        parts = k.split("|")
        if len(parts) < 2:
            continue
        counters[(parts[0], parts[1])] = max(counters.get((parts[0], parts[1]), 0), v)

    for c in cases:
        base = os.path.basename(c["自动化测试文件及函数"])
        func_id = c["测试函数标识"]
        map_key = f"{c['测试层级']}|{c['功能编号']}|{base}|{func_id}"
        if map_key in number_map:
            n = number_map[map_key]
        else:
            # 兼容迁移：早期版本只记裸函数名（丢类名），历史 map 里存的是
            # `...|test_x`。首次以 `...|TestX::test_x` 出现时继承旧号，
            # 避免把 29% 的类内方法整体重编号、留下大量空洞与孤儿键。
            # 同名跨类冲突时按排序先后，先声明者继承，其余照常新编。
            inherited = f"{c['测试层级']}|{c['功能编号']}|{base}|{func_id.rsplit('::', 1)[-1]}"
            inherited_no = number_map.pop(inherited, None) if inherited != map_key else None
            if inherited_no is not None:
                n = inherited_no
            else:
                counters[(c["测试层级"], c["功能编号"])] = counters.get(
                    (c["测试层级"], c["功能编号"]), 0) + 1
                n = counters[(c["测试层级"], c["功能编号"])]
            number_map[map_key] = n
        case_no = f"{c['测试层级']}-{c['功能编号']}-{n:03d}"
        c["测试编号"] = case_no
        rel = c["自动化测试文件及函数"]
        # nodeid 必须与 pytest 真实 nodeid 逐字一致：backend/ 前缀对仓库可见，测试内不是。
        pytest_path = rel[len("backend/"):] if rel.startswith("backend/") else rel
        nodeid = f"{pytest_path}::{c['测试函数标识']}"
        index[nodeid] = case_no

    # 编号与 nodeid 都必须唯一：重复即编号体系已失效（报告会漏行、执行记录会错挂），
    # 宁可让生成器失败，也不产出看着整齐实则串号的文件。
    _assert_unique("测试编号", [c["测试编号"] for c in cases])
    _assert_unique("nodeid", list(index))

    json.dump(number_map, open(CASE_MAP, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
    json.dump(index, open(CASE_INDEX, "w", encoding="utf-8"), ensure_ascii=False, indent=2)

    # ---- 写 CSV（12 核心字段 + 辅助字段）----
    fields = ["测试编号", "功能编号", "所属模块", "关联模块", "测试层级", "测试方法",
              "前置条件", "输入数据", "预期结果", "合格标准", "自动化测试文件及函数",
              "测试函数标识", "优先级", "测试名称", "功能名称", "关联旧编号(BIZ)", "流程编号", "备注"]
    with open(OUT_CSV, "w", encoding="utf-8-sig", newline="") as f:
        w = csv.DictWriter(f, fieldnames=fields)
        w.writeheader()
        for c in cases:
            row = {k: c.get(k, "") for k in fields}
            row["功能名称"] = reg.get(c["功能编号"], {}).get("name", "")
            row["关联旧编号(BIZ)"] = reg.get(c["功能编号"], {}).get("old", "")
            w.writerow(row)

    _write_md(cases, reg)

    by_type = {}
    by_module = {}
    for c in cases:
        by_type[c["测试层级"]] = by_type.get(c["测试层级"], 0) + 1
        by_module[c["所属模块"]] = by_module.get(c["所属模块"], 0) + 1
    print(f"[gen] 用例总数={len(cases)}  UT={by_type.get('UT',0)}  IT={by_type.get('IT',0)}  "
          f"E2E={by_type.get('E2E',0)}")
    print(f"[gen] 模块分布={by_module}")
    print(f"[gen] 输出: {OUT_CSV}")
    print(f"[gen] 索引: {CASE_INDEX}")


def _assert_unique(label: str, values: list) -> None:
    """值必须唯一；否则打印重复项并中止生成。"""
    seen: dict = {}
    dups: dict = {}
    for v in values:
        seen[v] = seen.get(v, 0) + 1
    for v, n in seen.items():
        if n > 1:
            dups[v] = n
    if not dups:
        return
    detail = "；".join(f"{v} ×{n}" for v, n in list(dups.items())[:5])
    raise SystemExit(
        f"[gen] {label} 重复，共 {len(dups)} 个（前 5）：{detail}\n"
        "  常见原因：同名测试函数未被类名限定、或计数器种子没接上既有编号。"
    )


def _unit_files() -> set:
    from test_catalog import UNIT_FILES
    return UNIT_FILES


def _stage(ttype, func, rel, tname, doc, body, fname, primary, related, flow) -> dict:
    expected, criteria = extract_criteria(doc, body)
    related_str = "/".join(sorted(related)) if len(related) > 1 else ""
    row = {
        "功能编号": func,
        "所属模块": primary,
        "关联模块": related_str,
        "测试层级": ttype,
        "测试名称": (clean_doc(doc).split("。")[0][:60] if doc else tname),
        "测试方法": extract_method(ttype, rel, body, tname),
        "前置条件": extract_precond(rel, body),
        "输入数据": extract_input_data(body),
        "预期结果": expected,
        "合格标准": criteria,
        "优先级": extract_priority(ttype, rel, fname, tname),
        "自动化测试文件及函数": rel,
        "测试函数标识": tname,
        "流程编号": flow,
        "备注": "跨模块流程" if flow else "",
    }
    return row


def _write_md(cases: list[dict], reg: dict) -> None:
    groups: dict[str, list[dict]] = {}
    for c in cases:
        groups.setdefault(c["功能编号"], []).append(c)
    lines = ["# 宜游轩 ERP 测试用例库", "",
             f"> 生成时间：{datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M UTC')} ｜ "
             "自动生成（scripts/gen_test_case_library.py）｜ 编号规则见《测试编号设计规范》",
             "", "## 总览", ""]
    by_type: dict[str, int] = {}
    for c in cases:
        by_type[c["测试层级"]] = by_type.get(c["测试层级"], 0) + 1
    lines.append(f"- 用例总数：**{len(cases)}**（UT={by_type.get('UT',0)} / "
                 f"IT={by_type.get('IT',0)} / E2E={by_type.get('E2E',0)}）")
    lines.append(f"- 覆盖功能：**{len(groups)}** 个（A/B/C/D/E/F/SYS）")
    lines.append("")
    for func in sorted(groups):
        meta = reg.get(func, {})
        lines.append(f"## {func} {meta.get('name', '')}（模块 {meta.get('module','')}）")
        if meta.get("old"):
            lines.append(f"- 关联旧编号：{meta['old']}")
        lines.append("")
        lines.append("| 测试编号 | 测试名称 | 层级 | 优先级 | 合格标准 |")
        lines.append("|---|---|---|---|---|")
        for c in groups[func]:
            crit = c["合格标准"].replace("|", "/")
            if len(crit) > 50:
                crit = crit[:50] + "…"
            name = c["测试名称"].replace("|", "/")
            lines.append(f"| {c['测试编号']} | {name} | {c['测试层级']} | {c['优先级']} | {crit} |")
        lines.append("")
    with open(OUT_MD, "w", encoding="utf-8") as f:
        f.write("\n".join(lines))


if __name__ == "__main__":
    main()
