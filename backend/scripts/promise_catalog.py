"""承诺（promise）单一事实源：把「什么绝对不能错」从文件路径里解耦出来。

设计背景（见 docs/testing/测试元数据台账.csv 的 PROMISE 记录与 tests/README.md）：
- 承诺 ID 形如 ``MONEY-01`` / ``POOL-01``，与文件路径无关——搬目录、改文件名都不影响；
- 测试文件在 docstring 头部声明 ``（MONEY-01 …）``；解析不到时回落到
  ``catalog.BACKEND_FILE_TO_FUNC`` 的历史功能码，保证过渡期 110 个文件
  既不空转也能被逐步补声明；
- 本模块只做解析与校验，不参与测试运行；守卫见
  ``tests/backend/test_promise_declaration.py``。

命令行：``python scripts/promise_catalog.py`` 打印承诺覆盖报告。
"""
from __future__ import annotations

import ast
import csv
import re
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
BACKEND_TESTS = REPO / "tests" / "backend"
# 功能编号与业务承诺合并于一份台账；本模块只取 PROMISE 记录（见 load_ledger）。
LEDGER = REPO / "docs" / "testing" / "测试元数据台账.csv"

# 承诺 ID：两段式，域字母 2-12 位 + 两位序号（MONEY-01 / INSTALLMENT-02）
PROMISE_RE = re.compile(r"(?<![A-Z0-9-])([A-Z]{2,12}-\d{2})(?![0-9])")

HEADER_LINES = 6


def load_ledger(path: Path | str | None = None) -> dict[str, dict]:
    """读取合并台账中的 PROMISE 记录，返回 {承诺编号: 行字典}。

    FEATURE 行的承诺编号为空，必须跳过；否则会生成空 key，守卫测试
    test_ledger_entries_are_well_formed 会把它判成非法编号。
    """
    target = Path(path) if path else LEDGER
    with open(target, encoding="utf-8-sig", newline="") as handle:
        return {
            row["承诺编号"].strip(): row
            for row in csv.DictReader(handle)
            if (row.get("承诺编号") or "").strip()
        }


def alias_index(ledger: dict[str, dict] | None = None) -> dict[str, str]:
    """历史别名 -> 承诺编号。别名以 `;` 分隔，用于承接 docstring 里的旧功能码。"""
    data = ledger if ledger is not None else load_ledger()
    index: dict[str, str] = {}
    for code, row in data.items():
        for alias in re.split(r"[;,]", row.get("历史别名") or ""):
            alias = alias.strip()
            if alias:
                index[alias] = code
    return index


def _docstring_head(path: Path) -> str:
    """取模块 docstring 前若干行；无 docstring 或语法错误时返回空串。"""
    try:
        tree = ast.parse(path.read_text(encoding="utf-8"))
    except (SyntaxError, UnicodeDecodeError):
        return ""
    doc = ast.get_docstring(tree) or ""
    return "\n".join(doc.splitlines()[:HEADER_LINES])


def declared_in_header(path: Path) -> str | None:
    """文件头声明的第一个承诺 ID（仅形态匹配，不校验是否登记）。"""
    matched = PROMISE_RE.search(_docstring_head(path))
    return matched.group(1) if matched else None


def promise_of(path: Path, ledger: dict[str, dict] | None = None,
               aliases: dict[str, str] | None = None) -> tuple[str | None, str]:
    """返回 (承诺编号或功能码, 来源)。

    来源取值：
      ``header``    文件头声明且已在清单登记（健康态）
      ``alias``     文件头写的是历史功能码，经别名归一到承诺（过渡态）
      ``func``      无声明，回落 ``BACKEND_FILE_TO_FUNC``（过渡态）
      ``unregistered`` 有声明但既不在清单也无别名（需登记，守卫会失败）
      ``none``      既无声明也不在历史表（新文件漏登记，守卫会失败）
    """
    data = ledger if ledger is not None else load_ledger()
    index = aliases if aliases is not None else alias_index(data)

    declared = declared_in_header(path)
    if declared:
        if declared in data:
            return declared, "header"
        if declared in index:
            return index[declared], "alias"
        return declared, "unregistered"

    func = _func_code(path.name)
    if func:
        return func, "func"
    return None, "none"


def _func_code(filename: str) -> str | None:
    """历史手写表兜底。延迟导入，避免本模块作为脚本运行时反向依赖 pytest。"""
    import sys

    config = str(REPO / "tests" / "config")
    if config not in sys.path:
        sys.path.insert(0, config)
    from catalog import BACKEND_FILE_TO_FUNC  # noqa: PLC0415

    return BACKEND_FILE_TO_FUNC.get(filename)


def scan_backend(ledger: dict[str, dict] | None = None) -> list[dict]:
    """扫描全部后端测试文件，返回每条的归属与来源。"""
    data = ledger if ledger is not None else load_ledger()
    index = alias_index(data)
    rows: list[dict] = []
    # rglob：测试文件已按 unit|integration/<区域>/ 分层，glob 只认根目录会返回空，
    # 承诺守卫随即空转（文件名对不上、清单证据找不到，全是恒真断言）。
    for path in sorted(BACKEND_TESTS.rglob("test_*.py")):
        code, source = promise_of(path, data, index)
        rows.append({"file": path.name, "code": code, "source": source})
    return rows


def gaps(ledger: dict[str, dict] | None = None) -> list[dict]:
    """清单里状态标记为缺失/待核的承诺（真缺口与证据待核）。"""
    data = ledger if ledger is not None else load_ledger()
    result = []
    for code, row in data.items():
        status = (row.get("覆盖状态") or "").strip()
        if status.startswith("缺失") or status.startswith("待核"):
            result.append({"code": code, "status": status, "text": row.get("承诺内容", "")})
    return result


def main() -> int:
    data = load_ledger()
    rows = scan_backend(data)
    by_source: dict[str, int] = {}
    for row in rows:
        by_source[row["source"]] = by_source.get(row["source"], 0) + 1

    print(f"承诺清单 {len(data)} 条　后端测试文件 {len(rows)} 个")
    print("来源分布：" + "　".join(f"{k}={v}" for k, v in sorted(by_source.items())))

    pending = [r for r in rows if r["source"] in {"func", "unregistered", "none"}]
    if pending:
        print(f"\n待补文件头声明（{len(pending)} 个，暂由历史功能码兜底）：")
        for row in pending[:15]:
            print(f"  {row['file']:<46} {row['code'] or '-':<10} {row['source']}")
        if len(pending) > 15:
            print(f"  …… 其余 {len(pending) - 15} 个")

    missing = gaps(data)
    if missing:
        print(f"\n清单内缺口（{len(missing)} 条）：")
        for item in missing:
            print(f"  {item['code']:<16} {item['status']:<12} {item['text'][:38]}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
