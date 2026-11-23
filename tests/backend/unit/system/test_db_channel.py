"""TESTING-05 快通道必须真的不连库：`pytest -m "not db"` 里不得出现任何连库用例。

判据不用目录，也不用文件名，只用两条可验证的事实：

1. **夹具依赖派生**。全仓唯一创建引擎的夹具是 `v1_engine`，pytest 已把传递依赖
   展开进 `item.fixturenames`，`conftest.py` 据此自动加 `db` 标记。搬目录、改文件名
   都绕不过它——因为它读的是运行期真实依赖，不是声明。

2. **自建连接的显式声明**。不走 `v1_engine`、自己在用例里 `create_engine` 并
   `.connect()` 的文件，派生机制看不见，必须在模块级写 `pytestmark = pytest.mark.db`。
   `test_migration.py` 与 `test_numbering.py` 曾因此漏在快通道里，是死端口实验
   （把 DATABASE_URL 指向不可达端口后跑 `-m "not db"`，12 错误 1 失败）抓出来的。

本文件只做静态核对与收集期统计校验，自身不连库。
"""

from __future__ import annotations

import re
from types import SimpleNamespace

import pytest
import run_regression

# 测试文件下沉后 parents[N] 的层数变了，写死层数只能撑到下一次搬家。
from _repo import BE_TESTS

# db 用例数基线：只允许上升。派生机制被删除、v1_engine 被改名时，数字会塌下来。
# 要下调这条基线，必须同时证明「确实有用例不再需要数据库」，不能图省事直接改数。
# 2026-11-19 据实下调 1360 → 1267：f6e8b690 五档清理收口删除 8 个测试文件（3260 行），
# 全量收集数 1672 → 1521，随删掉的 db 用例同步减少；派生规则未削弱（1267/1521 ≈ 83%）。
DB_BASELINE = 1267

# 允许在模块级手工声明 db 的文件。派生机制覆盖不到的只能是「自建引擎并连接」这类，
# 每新增一个都必须在这里登记——否则「手工标记」就成了绕过守卫的后门。
DECLARED_DB_FILES = {
    "test_core_contract.py",
    "test_migration.py",
    "test_numbering.py",
    # 并发测试额外创建临时数据库并使用独立连接，必须排除在不连库通道之外。
    "test_installment_payment_concurrency.py",
    "test_inventory_offsale_concurrency.py",
    "test_cashflow_write_concurrency.py",
    "test_order_execution_edit.py",  # 账号编辑并发测试使用独立临时数据库
    "test_leads_contract.py",  # 客户合并和需求状态并发使用独立临时数据库
    "test_cashflow_totals.py",  # 导出快照并发验证使用独立连接
}

_SELF_ENGINE = re.compile(r"create_engine\s*\(")
_CONNECTS = re.compile(r"\.connect\(\)")


def _sources() -> dict[str, str]:
    paths = sorted(BE_TESTS.rglob("test_*.py"))
    # 非空是这类守卫的命门：扫描根写错时 glob 返回空集合，所有「磁盘 ⊆ 清单」
    # 断言在空集上恒真，守卫看起来全绿（搬迁到子目录后正是如此）。
    assert paths, "rglob 扫不到任何测试文件：扫描根写错了"
    return {p.name: p.read_text(encoding="utf-8") for p in paths}


def test_db_baseline_applies_only_to_full_collection():
    _check_db_marker_counts(787, 1100, full_collection=False)
    with pytest.raises(AssertionError, match="低于基线"):
        _check_db_marker_counts(787, 1910, full_collection=True)
    _check_db_marker_counts(DB_BASELINE, 1910, full_collection=True)


def test_full_collection_detects_files_and_selection_filters():
    registered = {"tests/backend/a.py", "tests/backend/b.py"}
    assert _is_full_backend_collection(registered, registered, filtered=False)
    assert not _is_full_backend_collection({"tests/backend/a.py"}, registered, filtered=False)
    assert not _is_full_backend_collection(registered, registered, filtered=True)
    assert not _is_full_backend_collection(set(), set(), filtered=False)


def test_db_guard_rejects_low_full_count_but_accepts_large_partial(monkeypatch):
    monkeypatch.setattr(run_regression, "all_paths", lambda: ["tests/backend/a.py", "tests/backend/b.py"])
    options = SimpleNamespace(keyword="", markexpr="", deselect=[], ignore=[], ignore_glob=[])
    config = SimpleNamespace(_hei_db_channel_stats=(787, 1100), option=options, args=["tests/backend"])
    request = SimpleNamespace(session=SimpleNamespace(items=[SimpleNamespace(nodeid="tests/backend/a.py::test_a")]))
    test_db_marker_is_derived_from_fixtures(config, request)
    request.session.items.append(SimpleNamespace(nodeid="tests/backend/b.py::test_b"))
    with pytest.raises(AssertionError, match="低于基线"):
        test_db_marker_is_derived_from_fixtures(config, request)
    options.keyword = "test_a"
    test_db_marker_is_derived_from_fixtures(config, request)


def _is_full_backend_collection(collected_files: set[str], registered_files: set[str], *, filtered: bool) -> bool:
    return not filtered and bool(registered_files) and registered_files.issubset(collected_files)


def _check_db_marker_counts(db_count: int, total: int, *, full_collection: bool) -> None:
    assert db_count < total, "全部用例都被标 db，快速通道为空，派生规则把范围放大了"
    if full_collection:
        assert db_count > 0, "没有任何用例被标 db，派生规则已失效"
        assert db_count >= DB_BASELINE, (
            f"db 用例数 {db_count} 低于基线 {DB_BASELINE}："
            "要么派生规则被削弱，要么基线需要连同理由一起下调"
        )


def test_db_marker_is_derived_from_fixtures(pytestconfig, request) -> None:
    """派生机制必须仍在工作：既不能一条都不标，也不能把全部用例标成连库。

    统计随「本次收集了多少」变化，所以数量基线只在全量收集时校验；单跑本文件或
    跑某个业务域组时，只校验 hook 存在且没有把全部用例吞成 db。
    """
    stats = getattr(pytestconfig, "_hei_db_channel_stats", None)
    assert stats is not None, (
        "收集期统计缺失：conftest.py 的 pytest_collection_modifyitems 已不再写 db 标记，"
        "`pytest -m \"not db\"` 会静默退化成「跑全部用例」。"
    )
    db_count, total = stats
    selected_files = {item.nodeid.split("::", 1)[0] for item in request.session.items}
    options = pytestconfig.option
    filtered = bool(options.keyword or options.markexpr or options.deselect or
                    options.ignore or options.ignore_glob or any("::" in arg for arg in pytestconfig.args))
    is_full = _is_full_backend_collection(selected_files, set(run_regression.all_paths()), filtered=filtered)
    _check_db_marker_counts(db_count, total, full_collection=is_full)


def test_v1_engine_fixture_still_exists() -> None:
    """派生规则的锚点是 v1_engine 夹具。它一旦改名，标记会静默全丢。"""
    conftest = (BE_TESTS / "conftest.py").read_text(encoding="utf-8")
    assert re.search(r"^def v1_engine\s*\(", conftest, re.MULTILINE), (
        "conftest.py 里找不到 v1_engine 夹具定义。db 标记靠它派生，改名会让快通道失效。"
    )


def test_self_engine_files_declare_db_marker() -> None:
    """自建引擎并实际连接的文件，必须在模块级声明 db。

    只建 engine 对象不连接的不算（如 test_core_contract.py 仅构造 URL 校验用），
    这条阈值就是靠「是否出现 .connect()」区分的，避免把纯对象构造误判成连库。
    """
    undeclared = []
    for name, src in _sources().items():
        if not _SELF_ENGINE.search(src) or not _CONNECTS.search(src):
            continue
        has_pytestmark = re.search(
            r"^pytestmark\s*=.*pytest\.mark\.db", src, re.MULTILINE
        )
        if not has_pytestmark:
            undeclared.append(name)
    assert not undeclared, (
        "以下文件自建引擎并实际连接数据库，但没有模块级 db 声明，"
        "会漏进快通道（pytest -m \"not db\"）：\n  "
        + "\n  ".join(undeclared)
    )


def test_manual_db_marks_are_registered() -> None:
    """手工 db 标记必须逐个登记，防止它变成绕过派生的后门。"""
    marked = {
        name
        for name, src in _sources().items()
        if re.search(r"@pytest\.mark\.db|^pytestmark\s*=.*pytest\.mark\.db", src, re.MULTILINE)
    }
    unexpected = sorted(marked - DECLARED_DB_FILES)
    stale = sorted(DECLARED_DB_FILES - marked)
    assert not unexpected, (
        f"以下文件手工标了 db 但未在本守卫登记：{unexpected}\n"
        "如果它们确实自建连接，请加入 DECLARED_DB_FILES 并说明原因；"
        "如果只是想让用例变慢，请改用 v1_engine 夹具让标记自动派生。"
    )
    assert not stale, (
        f"DECLARED_DB_FILES 里以下文件已不再手工标 db：{stale}\n"
        "条目失效必须删除，否则守卫会替一个不存在的声明背书。"
    )
