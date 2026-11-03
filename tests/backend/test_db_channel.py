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
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
BE_TESTS = REPO / "tests" / "backend"

# db 用例数基线：只允许上升。派生机制被删除、v1_engine 被改名时，数字会塌下来。
# 要下调这条基线，必须同时证明「确实有用例不再需要数据库」，不能图省事直接改数。
DB_BASELINE = 1360

# 允许在模块级手工声明 db 的文件。派生机制覆盖不到的只能是「自建引擎并连接」这类，
# 每新增一个都必须在这里登记——否则「手工标记」就成了绕过守卫的后门。
DECLARED_DB_FILES = {"test_migration.py", "test_numbering.py"}

_SELF_ENGINE = re.compile(r"create_engine\s*\(")
_CONNECTS = re.compile(r"\.connect\(\)")


def _sources() -> dict[str, str]:
    return {p.name: p.read_text(encoding="utf-8") for p in sorted(BE_TESTS.glob("test_*.py"))}


def test_db_marker_is_derived_from_fixtures(pytestconfig) -> None:
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
    assert db_count < total, "全部用例都被标 db，快速通道为空，派生规则把范围放大了"
    if total >= 1000:  # 全量收集（当前 1672），基线才有意义
        assert db_count > 0, "没有任何用例被标 db，派生规则已失效"
        assert db_count >= DB_BASELINE, (
            f"db 用例数 {db_count} 低于基线 {DB_BASELINE}："
            "要么派生规则被削弱，要么基线需要连同理由一起下调"
        )


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
