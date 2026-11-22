"""TESTING-02 每个测试文件必须至少登记在一个运行分组内。

背景：``backend/run_regression.py`` 的 ``GROUPS`` 是逐文件手写的白名单，
``all`` / ``ci`` / 各域组 / ``changed`` 四条路径都只从它取值。白名单里没有的
文件不会报错、不会告警，只是永远不执行——13 个文件 68 个用例曾因此从未进过 CI。

本守卫把「人必须记得登记」变成「CI 必须通过」：

1. 磁盘 ⊆ 分组：新增测试文件不登记就跑不过；
2. 分组 ⊆ 磁盘：重命名或删除文件后必须同步白名单，避免死条目；
3. 路径前缀规范：防止旧目录（``backend/tests/v1``）残留；
4. 同一组内无重复路径；
5. ``all`` / ``ci`` 的取值必须覆盖全部分组。

设计约束：本文件不连数据库，属 unit 组，毫秒级。它只做静态解析。
"""
from __future__ import annotations

import sys
from pathlib import Path

import pytest
from _repo import BACKEND_DIR as BACKEND, BE_TESTS, REPO_ROOT as REPO

sys.path.insert(0, str(BACKEND))

import run_regression as rr  # noqa: E402

EXPECTED_PREFIX = "tests/backend/"


def test_macos_regression_uses_isolated_python313(monkeypatch, tmp_path):
    python = tmp_path / "python3"
    python.touch()
    dependencies = tmp_path / "runtime"
    dependencies.mkdir()
    monkeypatch.setattr(rr.sys, "platform", "darwin")
    monkeypatch.setattr(rr.Path, "home", lambda: Path("/Users/aries"))
    monkeypatch.setattr(rr, "LOCAL_TEST_PYTHON", python, raising=False)
    monkeypatch.setattr(rr, "LOCAL_TEST_DEPENDENCIES", dependencies, raising=False)
    monkeypatch.delenv("CI", raising=False)
    monkeypatch.delenv("TEST_REDIS_URL", raising=False)
    monkeypatch.setenv("PYTHONPATH", "/existing")

    runner, env = rr.pytest_runtime()
    assert runner == str(python)
    assert env["PYTHONPATH"] == f"{dependencies}:/existing"
    assert env["TEST_REDIS_URL"] == "redis://127.0.0.1:6389/0"
    monkeypatch.setenv("TEST_REDIS_URL", "redis://127.0.0.1:6390/1")
    assert rr.pytest_runtime()[1]["TEST_REDIS_URL"] == "redis://127.0.0.1:6390/1"

    dependencies.rmdir()
    with pytest.raises(SystemExit, match="隔离依赖"):
        rr.pytest_runtime()


def test_ci_regression_uses_its_own_python(monkeypatch, tmp_path):
    python = tmp_path / "venv-python"
    python.touch()
    monkeypatch.setattr(rr.sys, "platform", "linux")
    monkeypatch.setattr(rr, "PYTHON", python)
    monkeypatch.setenv("CI", "true")
    monkeypatch.setenv("PYTHONPATH", "/ci")
    runner, env = rr.pytest_runtime()
    assert runner == str(python)
    assert env["PYTHONPATH"] == "/ci"
    monkeypatch.setattr(rr.sys, "platform", "darwin")
    assert rr.pytest_runtime()[0] == str(python)


def test_changed_and_group_regressions_use_selected_runtime(monkeypatch):
    from types import SimpleNamespace

    calls = []
    monkeypatch.setattr(rr, "pytest_runtime", lambda: ("test-python", {"PYTHONPATH": "isolated"}))
    monkeypatch.setattr(rr.subprocess, "run", lambda command, **kwargs: calls.append((command, kwargs)) or SimpleNamespace(returncode=0))
    monkeypatch.setattr(rr, "is_structural_change", lambda paths: False)
    monkeypatch.setattr(rr, "groups_for_changes", lambda paths: [])
    for args in (["run_regression.py", "changed", "--backend-only", "--changed-paths", "docs/example.md"],
                 ["run_regression.py", "smoke"]):
        monkeypatch.setattr(rr.sys, "argv", args)
        assert rr.main() == 0
    assert len(calls) == 2
    assert all(command[:3] == ["test-python", "-m", "pytest"] and kwargs["env"]["PYTHONPATH"] == "isolated"
               for command, kwargs in calls)


def _disk_names() -> set[str]:
    """磁盘上实际存在的测试文件名。"""
    paths = sorted(BE_TESTS.rglob("test_*.py"))
    assert paths, "rglob 扫不到任何测试文件：扫描根写错了（空集合会让下面的断言恒真）"
    return {path.name for path in paths}


def _grouped_names() -> dict[str, list[str]]:
    """文件名 -> 所属分组列表。"""
    names: dict[str, list[str]] = {}
    for group, items in rr.GROUPS.items():
        for item in items:
            names.setdefault(Path(item).name, []).append(group)
    return names


def _all_group_items() -> list[str]:
    """所有分组里的路径条目（含重复）。"""
    return [item for items in rr.GROUPS.values() for item in items]


def test_every_test_file_is_grouped() -> None:
    """磁盘上的每个测试文件都必须出现在至少一个分组里。"""
    grouped = set(_grouped_names())
    orphans = sorted(_disk_names() - grouped)
    assert not orphans, (
        "以下测试文件不在 run_regression.GROUPS 的任何组内，永远不会被执行：\n"
        + "\n".join(f"  - {name}" for name in orphans)
        + "\n请把它加入对应域组（orders / finance / accounts / installments 等）。"
    )


def test_groups_have_no_dead_entries() -> None:
    """分组里的每个路径都必须指向真实存在的文件。"""
    dead = sorted({item for item in _all_group_items() if not (REPO / item).exists()})
    assert not dead, "GROUPS 指向了不存在的文件（重命名或删除后未同步白名单）：\n" + "\n".join(
        f"  - {item}" for item in dead
    )


def test_group_paths_use_tests_backend_prefix() -> None:
    """分组路径必须统一使用 tests/backend/ 前缀。"""
    bad = sorted({item for item in _all_group_items() if not item.startswith(EXPECTED_PREFIX)})
    assert not bad, "GROUPS 路径必须以 " + EXPECTED_PREFIX + " 开头：\n" + "\n".join(
        f"  - {item}" for item in bad
    )


def test_no_duplicate_paths_within_a_group() -> None:
    """同一组内不允许重复登记同一路径。"""
    dupes = {
        group: sorted({item for item in items if items.count(item) > 1})
        for group, items in rr.GROUPS.items()
        if len(items) != len(set(items))
    }
    assert not dupes, f"同一组内出现重复路径：{dupes}"


def test_all_paths_cover_every_group() -> None:
    """all / ci 的取值必须覆盖所有已登记路径。"""
    covered = set(rr.all_paths())
    missing = sorted(set(_all_group_items()) - covered)
    assert not missing, "all / ci 未覆盖以下已登记路径：\n" + "\n".join(
        f"  - {item}" for item in missing
    )
