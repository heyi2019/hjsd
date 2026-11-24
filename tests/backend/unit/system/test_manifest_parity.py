"""TESTING-06 磁盘测试文件集合、区域归属与分层归属必须与 tests/manifest.json 一致。

背景：本仓库搬过三次测试目录，每次都有一批东西「不报错地消失」——
``catalog.all_backend_test_files()`` 指向已死的 ``backend/tests/v1`` 让
``run_regression.py B`` 打印「无匹配文件」然后 exit 0；``gen_test_case_library.py``
只用 ``os.listdir`` 扫一层，文件一下沉就从用例库里整批消失；``record_frontend_results``
用 ``relative_to(frontend)`` 失败时 ``return None``，记录被静默丢弃。

共同点是**扫描范围写死在旧路径，而失败表现是「结果为空」而不是「报错」**。
空集合上的「磁盘 ⊆ 清单」类断言恒真，守卫看起来全绿。

本守卫的做法：manifest 只存「应该收到多少」，文件集合永远扫磁盘，
两边对不上就红。unit/integration 目录是现行结构，缺失时直接报错。
"""

from __future__ import annotations

import json
import csv
import sys
from pathlib import Path

import pytest

# 向上找 pytest.ini 定位仓库根，避免依赖固定目录层数。
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


def test_case_library_regenerates_only_automated_section(tmp_path, monkeypatch):
    from scripts import gen_test_case_library as generator

    path = tmp_path / "cases.md"
    manual = "# 测试用例库\n\n## 手工用例\n\nFE-001 检查登录。\n\n"
    path.write_text(
        manual + "<!-- CASE_LIBRARY_AUTO_BEGIN -->\n旧自动化用例\n<!-- CASE_LIBRARY_AUTO_END -->\n",
        encoding="utf-8",
    )
    monkeypatch.setattr(generator, "OUT_MD", str(path))
    case = {"测试编号": "UT-A01-001", "功能编号": "A01", "测试名称": "订单汇总",
            "测试层级": "UT", "优先级": "P2", "合格标准": "按期间统计"}
    generator._write_md([case], {"A01": {"name": "工作台", "module": "A"}})

    updated = path.read_text(encoding="utf-8")
    assert updated.startswith(manual)
    assert updated.count("UT-A01-001") == 1
    assert "旧自动化用例" not in updated


def test_case_library_refuses_to_overwrite_markdown_without_markers(tmp_path, monkeypatch):
    from scripts import gen_test_case_library as generator

    path = tmp_path / "cases.md"
    manual = "## 手工用例\n\nFE-001 检查登录。\n"
    path.write_text(manual, encoding="utf-8")
    monkeypatch.setattr(generator, "OUT_MD", str(path))

    with pytest.raises(ValueError, match="自动化区块标记"):
        generator._write_md([], {})
    assert path.read_text(encoding="utf-8") == manual


@pytest.mark.parametrize("body,expected", [
    ('await screen.findByText("保存成功");', 'findByText("保存成功")'),
    ('expectTypeOf(changePassword).parameter(0).toEqualTypeOf<string>();', 'expectTypeOf(changePassword)'),
])
def test_frontend_case_criteria_recognizes_implicit_and_type_assertions(body, expected):
    from scripts import gen_test_case_library as generator

    _, criteria = generator.extract_criteria(None, body, frontend=True)
    assert expected in criteria


def test_e2e_case_method_identifies_disposable_database():
    from scripts import gen_test_case_library as generator

    path = "tests/e2e/example.spec.ts"
    method = generator.extract_method("E2E", path, "", "example")
    precondition = generator.extract_precond(path, "")
    assert "临时" in method
    assert "常驻" not in method
    assert "每轮独立临时库" in precondition
    assert "常驻复用" not in precondition


def _manifest() -> dict:
    assert MANIFEST_PATH.exists(), f"manifest 不存在：{MANIFEST_PATH}"
    return json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))


def _test_files() -> list[Path]:
    """递归扫盘。用 rglob 而非 glob 是本守卫存在的意义之一。"""
    return sorted(BE_TESTS.rglob("test_*.py"))


sys.path.insert(0, str(REPO / "tests" / "config"))
import catalog as tc  # noqa: E402 — 必须先调整 sys.path


def _area_of(path: Path) -> str:
    """功能编号维持原样；系统功能测试可随 settings 代码归位。"""
    func = tc.BACKEND_FILE_TO_FUNC.get(path.name) or GUARD_AREA.get(path.name)
    assert func, f"{path.name} 既不在 BACKEND_FILE_TO_FUNC 也无守卫区域登记"
    area = path.relative_to(BE_TESTS).parts[1]
    if area == "settings" and func in {"SYS01", "SYS05", "SYS06", "SYS08"}:
        return area
    code = func[0] if func[0] in "ABCDEF" else "SYS"
    return _manifest()["regionByCode"][code]


def test_system_feature_in_settings_keeps_its_feature_number_but_uses_directory_area(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """系统功能测试可随代码归入 settings，功能编号仍保持不变。"""
    monkeypatch.setattr(sys.modules[__name__], "BE_TESTS", tmp_path)

    for relative, function in (
        ("auth/test_auth_contract.py", "SYS01"),
        ("field_definitions/test_foundation_pools_service.py", "SYS06"),
        ("attachments/test_attachments_service.py", "SYS08"),
    ):
        test_file = tmp_path / "integration" / "settings" / relative
        test_file.parent.mkdir(parents=True, exist_ok=True)
        test_file.touch()
        assert tc.BACKEND_FILE_TO_FUNC[test_file.name] == function
        assert _area_of(test_file) == "settings"


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
        area = _area_of(path)
        actual[area] = actual.get(area, 0) + 1

    assert actual == expected, f"区域分布不一致：磁盘 {actual} vs manifest {expected}"


@pytest.mark.parametrize("kind", KINDS)
def test_kind_directories_match_manifest(kind: str) -> None:
    """现行分层目录必须存在，每个区域的文件数与 manifest 一致。"""
    kind_dir = BE_TESTS / kind
    assert kind_dir.is_dir(), f"后端测试分层目录缺失：{kind_dir}"

    expected = _manifest()["layers"]["backend"]["expected"]["kinds"][kind]["byArea"]
    actual: dict[str, int] = {}
    for area_dir in sorted(kind_dir.iterdir()):
        if not area_dir.is_dir():
            continue
        n = len(list(area_dir.rglob("test_*.py")))
        if n:
            actual[area_dir.name] = n

    assert actual == expected, f"{kind}/ 区域分布 {actual} 与 manifest {expected} 不一致"


def test_kind_directories_count_nested_module_tests(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """业务模块下沉一层后，清单仍须统计其中的测试文件。"""
    nested = tmp_path / "integration" / "finance" / "cashflow"
    nested.mkdir(parents=True)
    (nested / "test_cashflow.py").touch()
    monkeypatch.setattr(sys.modules[__name__], "BE_TESTS", tmp_path)
    monkeypatch.setattr(
        sys.modules[__name__],
        "_manifest",
        lambda: {"layers": {"backend": {"expected": {"kinds": {
            "integration": {"byArea": {"finance": 1}},
        }}}}},
    )

    test_kind_directories_match_manifest("integration")


def test_no_stray_backend_files() -> None:
    """tests/backend 根目录不许留 test_*.py，避免遗漏区域归属。"""
    stray = sorted(p.name for p in BE_TESTS.glob("test_*.py"))
    assert not stray, f"分区后根目录仍残留测试文件：{stray}"


def test_kind_case_counts_add_up_to_backend_total() -> None:
    expected = _manifest()["layers"]["backend"]["expected"]
    assert sum(expected["kinds"][kind]["cases"] for kind in KINDS) == expected["cases"]


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
    kinds = _manifest()["layers"]["backend"]["expected"]["kinds"]
    for kind in KINDS:
        actual = sum(Path(str(item.path)).resolve().is_relative_to(BE_TESTS / kind) for item in request.session.items)
        assert actual == kinds[kind]["cases"], f"{kind} 用例数 {actual}，manifest 记 {kinds[kind]['cases']}"


def test_guards_declare_area() -> None:
    """三个守卫自身必须有区域归属，否则会落 SYS 兜底并悄悄改变区域分布。"""
    on_disk = {p.name: p for p in BE_TESTS.rglob("test_*.py")}
    for fname in GUARD_AREA:
        assert fname in on_disk, f"守卫文件丢失：{fname}"
        _area_of(on_disk[fname])  # 无区域登记会 AssertionError
