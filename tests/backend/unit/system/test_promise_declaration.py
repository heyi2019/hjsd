"""TESTING-01 每个测试文件必须能归属到一条业务承诺。

守卫对象是「承诺清单 ↔ 测试文件」的双向一致性，回答两个问题：

1. 每个测试文件在守什么？（防止游离文件——不在任何分组、也不知保护何物的用例）
2. 清单里每条承诺是否真的有测试？（防止清单变成只写不验的文档）

设计约束：本文件**不得连数据库**，属 unit 组，百毫秒级。它只做静态解析。
"""
from __future__ import annotations

import sys
from functools import lru_cache
from pathlib import Path

from _repo import BACKEND_DIR as BACKEND, BE_TESTS, REPO_ROOT as REPO
FRONTEND = REPO / "frontend"

sys.path.insert(0, str(BACKEND / "scripts"))

import promise_catalog as pc  # noqa: E402

# 未登记承诺预算固定为零；新增文件头声明必须先登记进承诺清单。
# 否则本测试变红，阻止「加测试不登记」。
UNREGISTERED_BUDGET = 0

VALID_LEVELS = {"L0", "L1", "L2", "L3"}
VALID_OWNERS = {"后端", "前端", "双端"}


def _rows() -> list[dict]:
    return pc.scan_backend()


def test_every_test_file_has_owner() -> None:
    """不允许存在既无承诺声明、又不在功能映射表里的测试文件。"""
    orphans = [row["file"] for row in _rows() if row["source"] == "none"]
    assert not orphans, (
        "以下测试文件既没有文件头承诺声明，也不在 test_catalog.BACKEND_FILE_TO_FUNC 中，"
        f"属于无归属测试：{orphans}"
    )


def test_unregistered_promise_budget() -> None:
    """文件头声明的承诺必须已登记，或消耗基线额度（只降不升）。"""
    pending = sorted(row["file"] for row in _rows() if row["source"] == "unregistered")
    assert len(pending) <= UNREGISTERED_BUDGET, (
        f"未登记承诺声明 {len(pending)} 个，超出基线 {UNREGISTERED_BUDGET}。"
        "新增测试请先把承诺写进 docs/testing/承诺清单.csv，再改基线。\n"
        f"当前未登记：{pending}"
    )


def test_ledger_entries_are_well_formed() -> None:
    """清单自身的结构约束：编号唯一、层级合法、负责端合法、必填项非空。"""
    ledger = pc.load_ledger()
    assert ledger, "承诺清单为空"

    problems: list[str] = []
    for code, row in ledger.items():
        if not pc.PROMISE_RE.fullmatch(code):
            problems.append(f"{code}: 编号不符合 <域>-<两位序号>")
        if row["层级"] not in VALID_LEVELS:
            problems.append(f"{code}: 层级 {row['层级']!r} 非法")
        if row["负责端"] not in VALID_OWNERS:
            problems.append(f"{code}: 负责端 {row['负责端']!r} 非法")
        for field in ("承诺内容", "失效后果", "覆盖状态"):
            if not (row.get(field) or "").strip():
                problems.append(f"{code}: {field} 为空")
    assert not problems, "承诺清单结构问题：\n" + "\n".join(problems)


@lru_cache(maxsize=1)
def _backend_evidence_index() -> dict[str, Path]:
    index: dict[str, Path] = {}
    for path in sorted(BE_TESTS.rglob("test_*.py")):
        index.setdefault(path.name, path)
    return index


@lru_cache(maxsize=None)
def _evidence_path(name: str) -> Path:
    """解析验证证据路径。

    默认按后端测试文件名（相对 tests/backend）解析；以 `tests/` 开头的写仓库根相对路径，
    用于「证据本身是前端/E2E 守卫」的跨端承诺（如 vi.mock 模块标识守卫）。
    没有这条路，负责端为「双端」的承诺只能把证据留空，等于放弃证据链。
    """
    if name.startswith("tests/"):
        return REPO / name
    if name.startswith("frontend:"):  # frontend:<仓库根相对路径>
        return REPO / name[len("frontend:") :]
    direct = BE_TESTS / name
    if direct.exists():
        return direct
    # 测试文件按 unit|integration/<区域>/ 分层，而清单里存的是裸文件名。
    return _backend_evidence_index().get(name, direct)


def test_ledger_evidence_files_exist() -> None:
    """清单里写的验证证据必须真实存在，防止证据链指向不存在的文件。"""
    ledger = pc.load_ledger()
    missing: list[str] = []
    for code, row in ledger.items():
        evidence = (row.get("验证证据") or "").strip()
        if not evidence:
            continue
        for name in evidence.replace(",", ";").split(";"):
            name = name.strip()
            if name and not _evidence_path(name).exists():
                missing.append(f"{code} -> {name}")
    assert not missing, (
        "承诺清单引用了不存在的测试文件"
        "（前端证据写仓库根相对路径，如 `tests/frontend/unit/system/x.test.ts`）：\n" + "\n".join(missing)
    )


def test_missing_promises_state_a_reason() -> None:
    """标记为缺失的承诺必须写明原因，禁止无声缺失。"""
    ledger = pc.load_ledger()
    silent = [
        code
        for code, row in ledger.items()
        if (row.get("覆盖状态") or "").startswith("缺失")
        and not (row.get("备注") or "").strip()
    ]
    assert not silent, f"以下承诺标记缺失但未写原因：{silent}"
