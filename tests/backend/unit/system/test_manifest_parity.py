"""TESTING-06 磁盘测试文件集合、区域归属与分层归属必须与 tests/manifest.json 一致。

背景：本仓库搬过三次测试目录，每次都有一批东西「不报错地消失」——
``catalog.all_backend_test_files()`` 指向已死的 ``backend/tests/v1`` 让
``run_regression.py B`` 打印「无匹配文件」然后 exit 0；``gen_test_case_library.py``
只用 ``os.listdir`` 扫一层，文件一下沉就从用例库里整批消失；``record_frontend_results``
用 ``relative_to(frontend)`` 失败时 ``return None``，记录被静默丢弃。

共同点是**扫描范围写死在旧路径，而失败表现是「结果为空」而不是「报错」**。
空集合上的「磁盘 ⊆ 清单」类断言恒真，守卫看起来全绿。

本守卫的做法：manifest 只存「应该收到多少」，文件集合永远扫磁盘，
两边对不上就红。目录存在时才校验目录归属，故搬迁前后的结构都能跑。
"""

from __future__ import annotations

import json
import csv
import sys
from pathlib import Path

import pytest

# 向上找 pytest.ini 定位仓库根：本文件会被搬进 tests/backend/{unit,integration}/<区域>/，
# 届时 parents[N] 的层数会变，写死层数必错。
def _repo_root() -> Path:
    here = Path(__file__).resolve()
    for candidate in (here, *here.parents):
        if (candidate / "pytest.ini").exists():
            return candidate
    raise RuntimeError("找不到仓库根（没有 pytest.ini）")


REPO = _repo_root()
BE_TESTS = REPO / "tests" / "backend"
MANIFEST_PATH = REPO / "tests" / "manifest.json"
BACKEND = REPO / "backend"
KINDS = ("unit", "integration")
GUARD_AREA = {
    "test_manifest_parity.py": "SYS12",
    "test_promise_declaration.py": "SYS12",
    "test_group_coverage.py": "SYS11",
    "test_db_channel.py": "SYS10",
}


def test_feature_catalog_columns_and_risk_are_aligned():
    path = REPO / "docs" / "testing" / "测试元数据台账.csv"
    with path.open(encoding="utf-8-sig", newline="") as handle:
        reader = csv.DictReader(handle)
        reader.fieldnames = [name.lstrip("\ufeff") for name in reader.fieldnames or []]
        features = [row for row in reader if row["记录类型"] == "FEATURE"]
    assert features
    for row in features:
        assert row["代码域/路由"] and row["说明"], row["功能编号"]
        assert row["风险等级"] in {"高", "中", "低"}, row["功能编号"]
        assert not row.get(None), row["功能编号"]
        assert row["关联旧编号(BIZ)"] not in {"高", "中", "低"}, row["功能编号"]


def test_backend_result_does_not_claim_missing_log(tmp_path, monkeypatch):
    import conftest as recorder

    result = tmp_path / "results.jsonl"
    monkeypatch.setattr(recorder, "_RESULTS_JSONL", result)
    monkeypatch.setattr(recorder, "_RUN_STATE", {
        "run_id": "sample", "rows": {"tests/example.py::test_one": {"status": "PASS"}},
        "case_index": {},
    })
    recorder.pytest_sessionfinish(None, 0)
    record = json.loads(result.read_text(encoding="utf-8"))
    assert record["status"] == "PASS"
    assert record["evidence"] == ""


def test_case_number_map_uses_published_numbers_when_cache_conflicts(tmp_path, monkeypatch):
    from scripts import gen_test_case_library as generator

    csv_path = tmp_path / "cases.csv"
    cache_path = tmp_path / "map.json"
    csv_path.write_text("\ufeff\ufeff测试编号,功能编号,测试层级,自动化测试文件及函数,测试函数标识\nIT-B01-003,B01,IT,tests/a.test.ts,case a\n", encoding="utf-8")
    cache_path.write_text(json.dumps({"IT|B01|a.test.ts|case a": 8, "IT|B01|old.test.ts|old": 3, "IT|B01|b.test.ts|case b": 9}), encoding="utf-8")
    monkeypatch.setattr(generator, "OUT_CSV", str(csv_path))
    monkeypatch.setattr(generator, "CASE_MAP", str(cache_path))

    numbers = generator._load_number_map()
    assert numbers["IT|B01|a.test.ts|case a"] == 3
    assert "IT|B01|old.test.ts|old" not in numbers
    assert numbers["IT|B01|b.test.ts|case b"] == 9


def test_case_library_rejects_silent_reclassification(tmp_path, monkeypatch):
    from scripts import gen_test_case_library as generator

    csv_path = tmp_path / "cases.csv"
    csv_path.write_text("测试编号,功能编号,测试层级,自动化测试文件及函数,测试函数标识\nIT-B01-003,B01,IT,tests/a.test.ts,case a\n", encoding="utf-8")
    monkeypatch.setattr(generator, "OUT_CSV", str(csv_path))
    case = {"自动化测试文件及函数": "tests/a.test.ts", "测试函数标识": "case a", "测试层级": "IT", "功能编号": "B02"}
    with pytest.raises(ValueError, match="分类发生变化"):
        generator._check_published_classifications([case])
    migrations = tmp_path / "migrations.json"
    migrations.write_text(json.dumps([{"nodeid": "tests/a.test.ts::case a", "old_id": "IT-B01-003", "new_id": "IT-B02-004"}]), encoding="utf-8")
    monkeypatch.setattr(generator, "CASE_MIGRATIONS", str(migrations))
    assert generator._check_published_classifications([case]) == {"tests/a.test.ts::case a": "IT-B02-004"}


def _manifest() -> dict:
    assert MANIFEST_PATH.exists(), f"manifest 不存在：{MANIFEST_PATH}"
    return json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))


def _test_files() -> list[Path]:
    """递归扫盘。用 rglob 而非 glob 是本守卫存在的意义之一。"""
    return sorted(BE_TESTS.rglob("test_*.py"))


sys.path.insert(0, str(REPO / "tests" / "config"))
import catalog as tc  # noqa: E402 — 必须先调整 sys.path


def _area_of(fname: str) -> str:
    """功能编号首字母 → 区域目录名。

    目录与 manifest 用区域全名（business/customer/…），功能编号仍是字母前缀
    （B03、SYS12），映射表在 manifest.regionByCode，避免两套命名各写一份。
    """
    func = tc.BACKEND_FILE_TO_FUNC.get(fname) or GUARD_AREA.get(fname)
    assert func, f"{fname} 既不在 BACKEND_FILE_TO_FUNC 也无守卫区域登记"
    code = func[0] if func[0] in "ABCDEF" else "SYS"
    return _manifest()["regionByCode"][code]


def test_manifest_has_all_three_layers() -> None:
    """manifest 自带结构完整性：三端齐全、区域与目录声明不空。"""
    m = _manifest()
    assert m["version"] >= 1
    for layer in ("backend", "frontend", "e2e"):
        assert layer in m["layers"], f"manifest 缺 {layer} 层"
        assert m["layers"][layer]["root"].startswith("tests/"), f"{layer}.root 必须指向 tests/"
    for key in ("shared", "system"):
        assert key in m["regions"], f"regions 缺 {key}"


def test_backend_file_count_matches_manifest() -> None:
    """文件总数与 manifest 一致。搬丢一个就红。"""
    expected = _manifest()["layers"]["backend"]["expected"]["files"]
    files = _test_files()
    assert files, "rglob 扫不到任何后端测试文件——扫描根写错了（这正是要防的静默归零）"
    assert len(files) == expected, (
        f"后端测试文件 {len(files)} 个，manifest 记 {expected} 个；"
        f"差异集合：{[p.name for p in files][:10]}"
    )


def test_backend_area_distribution_matches_manifest() -> None:
    """区域归属分布与 manifest 一致：防止有人新增文件却不登记功能编号（落 SYS 兜底会改分布）。"""
    m = _manifest()
    expected: dict[str, int] = {}
    for kind_data in m["layers"]["backend"]["expected"]["kinds"].values():
        for area, count in kind_data["byArea"].items():
            expected[area] = expected.get(area, 0) + count

    actual: dict[str, int] = {}
    for path in _test_files():
        area = _area_of(path.name)
        actual[area] = actual.get(area, 0) + 1

    assert actual == expected, f"区域分布不一致：磁盘 {actual} vs manifest {expected}"


@pytest.mark.parametrize("kind", KINDS)
def test_kind_directories_match_manifest_when_present(kind: str) -> None:
    """目录存在时，每个区域的 unit/integration 文件数必须与 manifest 一致。

    旧结构（文件平铺在 tests/backend/ 下）没有这两个目录，跳过；
    搬迁后自动生效，搬错一半（例如只搬了 unit/）会被 test_no_stray_backend_files 抓到。
    """
    kind_dir = BE_TESTS / kind
    if not kind_dir.is_dir():
        pytest.skip(f"{kind}/ 尚未建立（搬迁前的扁平结构）")

    expected = _manifest()["layers"]["backend"]["expected"]["kinds"][kind]["byArea"]
    actual: dict[str, int] = {}
    for area_dir in sorted(kind_dir.iterdir()):
        if not area_dir.is_dir():
            continue
        n = len(list(area_dir.glob("test_*.py")))
        if n:
            actual[area_dir.name] = n

    assert actual == expected, f"{kind}/ 区域分布 {actual} 与 manifest {expected} 不一致"


def test_no_stray_backend_files_when_partitioned() -> None:
    """一旦开始分区，tests/backend 根目录就不许再留 test_*.py（防「搬了一半」）。"""
    if not any((BE_TESTS / k).is_dir() for k in KINDS):
        pytest.skip("尚未分区（扁平结构）")

    stray = sorted(p.name for p in BE_TESTS.glob("test_*.py"))
    assert not stray, f"分区后根目录仍残留测试文件：{stray}"


def test_case_total_matches_manifest(request: pytest.FixtureRequest) -> None:
    """用例总数与 manifest 一致，只在全量收集时校验。

    判据用「本次收集的后端测试文件数 == manifest 登记数」，而不是写死用例数阈值。
    早期版本用 ``total < 1000`` 判断全量：测试一旦缩水到 1000 以下，守卫反而
    静默 skip，恰好在最该报警时失效。文件数判据没有这个盲区——
    - 文件级缩水（文件被删/搬丢）由 test_backend_file_count_matches_manifest 抓；
    - 文件内用例级缩水（文件数没变、用例少了）由本测试的总数对账抓。
    两者互补，不引入新的魔法数字。
    """
    expected_files = _manifest()["layers"]["backend"]["expected"]["files"]
    collected = {
        p.resolve()
        for p in (
            Path(str(getattr(item, "path", ""))) for item in request.session.items
        )
        if str(p) != "." and p.is_relative_to(BE_TESTS)
    }
    if len(collected) < expected_files:
        pytest.skip(
            f"本次收集覆盖 {len(collected)}/{expected_files} 个后端测试文件，非全量运行，跳过总数对账"
        )
    expected_cases = _manifest()["layers"]["backend"]["expected"]["cases"]
    total = len(request.session.items)
    assert total == expected_cases, f"用例总数 {total}，manifest 记 {expected_cases}"


def test_guards_declare_area() -> None:
    """三个守卫自身必须有区域归属，否则会落 SYS 兜底并悄悄改变区域分布。"""
    on_disk = {p.name for p in BE_TESTS.rglob("test_*.py")}
    for fname in GUARD_AREA:
        assert fname in on_disk, f"守卫文件丢失：{fname}"
        _area_of(fname)  # 无区域登记会 AssertionError
