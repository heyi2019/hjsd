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

设计约束：本文件不连数据库，属 unit 组；变更范围测试使用临时隔离 Git 仓库。
"""
from __future__ import annotations

import os
import subprocess
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
    monkeypatch.setattr(rr, "runtime_mismatches", lambda _lock, _runtime: [])
    monkeypatch.delenv("CI", raising=False)
    monkeypatch.delenv("TEST_REDIS_URL", raising=False)
    monkeypatch.setenv("PYTHONPATH", "/existing")

    runner, env = rr.pytest_runtime()
    assert runner == str(python)
    assert env["PYTHONPATH"] == f"{dependencies}:/existing"
    assert env["TEST_REDIS_URL"] == "redis://127.0.0.1:6389/0"
    checked = []
    monkeypatch.setattr(rr, "runtime_mismatches", lambda lock, _runtime: checked.append(lock.name) or [])
    rr.pytest_runtime()
    assert "requirements-dev.lock.txt" in checked
    monkeypatch.setenv("TEST_REDIS_URL", "redis://127.0.0.1:6390/1")
    assert rr.pytest_runtime()[1]["TEST_REDIS_URL"] == "redis://127.0.0.1:6390/1"
    monkeypatch.setattr(rr, "runtime_mismatches", lambda _lock, _runtime: ["redis 版本不符"])
    with pytest.raises(SystemExit, match="锁文件不一致"):
        rr.pytest_runtime()

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
    assert all(command[:7] == ["test-python", "scripts/ephemeral_test_db.py", "test", "--", "test-python", "-m", "pytest"] and kwargs["env"]["PYTHONPATH"] == "isolated"
               for command, kwargs in calls)


def test_frontend_module_regression_uses_repository_relative_test_path(monkeypatch, tmp_path):
    repo = tmp_path / "repo"
    (repo / "frontend").mkdir(parents=True)
    relative = "tests/frontend/module/finance/example.test.tsx"
    test_file = repo / relative
    test_file.parent.mkdir(parents=True)
    test_file.write_text("// test fixture\n", encoding="utf-8")
    bin_dir = repo / "node_modules" / ".bin"
    bin_dir.mkdir(parents=True)
    vitest = bin_dir / "vitest"
    vitest.write_text('#!/bin/sh\nfor arg in "$@"; do case "$arg" in --outputFile=*) out=${arg#--outputFile=};; esac; target="$arg"; done\ntest -f "../$target" || exit 2\nprintf "{}" > "$out"\n', encoding="utf-8")
    vitest.chmod(0o755)
    monkeypatch.setattr(rr, "REPO", repo)
    recorded = []
    monkeypatch.setattr(rr, "record_frontend", lambda path: recorded.append((path, path.read_text())))

    assert rr.run_frontend_files([relative]) == 0
    assert len(recorded) == 1
    report, contents = recorded[0]
    assert contents == "{}"
    assert not report.exists()


@pytest.mark.parametrize("full", [False, True])
def test_frontend_regression_rejects_missing_local_vitest(monkeypatch, tmp_path, full):
    repo = tmp_path / "repo"
    (repo / "frontend").mkdir(parents=True)
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    npx = bin_dir / "npx"
    npx.write_text('#!/bin/sh\nexit 0\n', encoding="utf-8")
    npx.chmod(0o755)
    monkeypatch.setenv("PATH", f"{bin_dir}{os.pathsep}{os.environ.get('PATH', '')}")
    monkeypatch.setattr(rr, "REPO", repo)

    result = rr.run_frontend_full() if full else rr.run_frontend_files(["tests/frontend/example.test.ts"])
    assert result != 0


@pytest.mark.parametrize("full", [False, True])
def test_frontend_regression_never_records_stale_report(monkeypatch, tmp_path, full):
    repo = tmp_path / "repo"
    cache = repo / "frontend" / "node_modules" / ".cache"
    cache.mkdir(parents=True)
    old = cache / ("vitest-full.json" if full else "vitest-module.json")
    old.write_text('{"old":true}', encoding="utf-8")
    bin_dir = repo / "node_modules" / ".bin"
    bin_dir.mkdir(parents=True)
    vitest = bin_dir / "vitest"
    vitest.write_text('#!/bin/sh\nexit 17\n', encoding="utf-8")
    vitest.chmod(0o755)
    npx = tmp_path / "npx"
    npx.write_text('#!/bin/sh\nexit 17\n', encoding="utf-8")
    npx.chmod(0o755)
    monkeypatch.setenv("PATH", f"{tmp_path}{os.pathsep}{os.environ.get('PATH', '')}")
    monkeypatch.setattr(rr, "REPO", repo)
    recorded = []
    monkeypatch.setattr(rr, "record_frontend", lambda path: recorded.append(path.read_text()))

    result = rr.run_frontend_full() if full else rr.run_frontend_files(["tests/frontend/example.test.ts"])
    assert result == 17
    assert recorded == []
    assert old.read_text(encoding="utf-8") == '{"old":true}'


def test_frontend_regression_rejects_success_without_a_report(monkeypatch, tmp_path):
    repo = tmp_path / "repo"
    (repo / "frontend").mkdir(parents=True)
    bin_dir = repo / "node_modules" / ".bin"
    bin_dir.mkdir(parents=True)
    for path in (bin_dir / "vitest", tmp_path / "npx"):
        path.write_text('#!/bin/sh\nexit 0\n', encoding="utf-8")
        path.chmod(0o755)
    monkeypatch.setenv("PATH", f"{tmp_path}{os.pathsep}{os.environ.get('PATH', '')}")
    monkeypatch.setattr(rr, "REPO", repo)
    recorded = []
    monkeypatch.setattr(rr, "record_frontend", lambda path: recorded.append(path))

    assert rr.run_frontend_files(["tests/frontend/example.test.ts"]) != 0
    assert recorded == []


def test_frontend_failed_run_records_only_its_fresh_report(monkeypatch, tmp_path):
    repo = tmp_path / "repo"
    (repo / "frontend").mkdir(parents=True)
    bin_dir = repo / "node_modules" / ".bin"
    bin_dir.mkdir(parents=True)
    command = '#!/bin/sh\nfor arg in "$@"; do case "$arg" in --outputFile=*) out=${arg#--outputFile=};; esac; done\nprintf "new" > "$out"\nexit 17\n'
    for path in (bin_dir / "vitest", tmp_path / "npx"):
        path.write_text(command, encoding="utf-8")
        path.chmod(0o755)
    monkeypatch.setenv("PATH", f"{tmp_path}{os.pathsep}{os.environ.get('PATH', '')}")
    monkeypatch.setattr(rr, "REPO", repo)
    recorded = []
    monkeypatch.setattr(rr, "record_frontend", lambda path: recorded.append(path.read_text()))

    assert rr.run_frontend_files(["tests/frontend/example.test.ts"]) == 17
    assert recorded == ["new"]


def test_frontend_result_recorder_uses_published_index_on_clean_checkout(tmp_path):
    import json
    import shutil

    repo = tmp_path / "repo"
    scripts = repo / "backend/scripts"
    scripts.mkdir(parents=True)
    for name in ("record_frontend_results.py", "_git.py", "_result_rank.py"):
        shutil.copy2(BACKEND / "scripts" / name, scripts / name)
    library = repo / "docs/testing/测试用例库.csv"
    library.parent.mkdir(parents=True)
    library.write_text(
        "测试编号,自动化测试文件及函数,测试函数标识\n"
        "IT-D01-001,tests/frontend/module/finance/example.test.tsx,case example\n",
        encoding="utf-8-sig",
    )
    report = repo / "frontend/report.json"
    report.parent.mkdir(parents=True)
    report.write_text(json.dumps({"testResults": [{
        "name": str(repo / "tests/frontend/module/finance/example.test.tsx"),
        "assertionResults": [{"title": "case example", "status": "passed", "duration": 1}],
    }]}), encoding="utf-8")

    result = subprocess.run([sys.executable, str(scripts / "record_frontend_results.py"), "--json", str(report), "--transient"],
                            cwd=repo, capture_output=True, text=True)
    assert result.returncode == 0, result.stderr
    output = repo / "docs/testing/测试结果库/results.jsonl"
    row = json.loads(output.read_text(encoding="utf-8"))
    assert row["case_no"] == "IT-D01-001" and row["status"] == "PASS"
    assert row["evidence"] == ""


def test_e2e_list_shows_real_browser_specs_without_launch(monkeypatch, tmp_path, capsys):
    repo = tmp_path / "repo"
    spec = repo / "tests/e2e/finance/finance.spec.ts"
    spec.parent.mkdir(parents=True)
    spec.touch()
    monkeypatch.setattr(rr, "REPO", repo)
    monkeypatch.setattr(rr.sys, "argv", ["run_regression.py", "e2e", "--list"])

    assert rr.main() == 0
    assert "tests/e2e/finance/finance.spec.ts" in capsys.readouterr().out


def test_e2e_runs_isolated_launcher_and_propagates_exit_code(monkeypatch, tmp_path):
    repo = tmp_path / "repo"
    spec = repo / "tests/e2e/finance/finance.spec.ts"
    spec.parent.mkdir(parents=True)
    spec.touch()
    launcher = repo / "scripts/ops/test-e2e.sh"
    launcher.parent.mkdir(parents=True)
    launcher.write_text('#!/bin/sh\nprintf called > "$E2E_PROBE_LOG"\nexit 23\n', encoding="utf-8")
    marker = tmp_path / "launcher-called"
    monkeypatch.setenv("E2E_PROBE_LOG", str(marker))
    monkeypatch.setattr(rr, "REPO", repo)
    monkeypatch.setattr(rr.sys, "argv", ["run_regression.py", "e2e"])

    assert rr.main() == 23
    assert marker.read_text() == "called"


@pytest.mark.parametrize("list_only", [False, True])
def test_module_e2e_filter_fails_closed_when_not_supported(monkeypatch, list_only):
    args = ["run_regression.py", "B", "--type", "e2e"]
    if list_only:
        args.append("--list")
    monkeypatch.setattr(rr.sys, "argv", args)
    assert rr.main() != 0


def _ci_scope(repo: Path, **overrides: str) -> dict[str, str]:
    env = {**os.environ, "CI_EVENT_NAME": "push", "CI_FULL_SUITE": "false", "CI_CHANGED_PATHS": "",
           "CI_BASE_SHA": "", "CI_HEAD_SHA": "", **overrides}
    result = subprocess.run([sys.executable, str(REPO / "scripts/ops/ci_test_scope.py")],
                            cwd=repo, env=env, capture_output=True, text=True)
    assert result.returncode == 0, result.stdout + result.stderr
    return dict(line.split("=", 1) for line in result.stdout.splitlines())


@pytest.mark.parametrize(("paths", "full", "mode", "expected"), [
    ("docs/研发流程.md", "false", "none", ""),
    (
        "frontend/src/business/shared/order-create/CreateBusinessModal.tsx,backend/app/finance/cashflow/writes/create.py",
        "false", "selected",
        "tests/e2e/cross/business-write.spec.ts,tests/e2e/cross/orders-lifecycle.spec.ts,"
        "tests/e2e/cross/finance-write-ui.spec.ts,tests/e2e/finance/other-integration.spec.ts",
    ),
    (
        "backend/app/business/orders/create.py,frontend/src/finance/cashflow/CashflowTab.tsx",
        "false", "selected",
        "tests/e2e/cross/business-write.spec.ts,tests/e2e/cross/orders-lifecycle.spec.ts,"
        "tests/e2e/cross/finance-write-ui.spec.ts,tests/e2e/finance/other-integration.spec.ts",
    ),
    (
        "frontend/src/business/shared/operations/offsale-modal.tsx", "false", "selected",
        "tests/e2e/cross/business-write.spec.ts,tests/e2e/cross/orders-lifecycle.spec.ts",
    ),
    (
        "backend/app/business/shared/operations/consignment.py", "false", "selected",
        "tests/e2e/cross/business-write.spec.ts,tests/e2e/cross/orders-lifecycle.spec.ts",
    ),
    (
        "tests/e2e/system/auth-login.spec.ts,frontend/src/settings/auth/LoginPage.tsx",
        "false", "selected", "tests/e2e/system/auth-login.spec.ts,tests/e2e/system/role-switch.spec.ts",
    ),
    (
        "backend/app/settings/auth/service.py", "false", "selected",
        "tests/e2e/system/auth-login.spec.ts,tests/e2e/system/role-switch.spec.ts",
    ),
    ("backend/requirements-dev.lock.txt", "false", "all", ""),
    ("tests/e2e/system/fallback.spec.ts", "false", "selected", "tests/e2e/system/fallback.spec.ts"),
    ("tests/e2e/support/api-stub.ts", "false", "all", ""),
    ("tests/e2e/system/deleted.spec.ts", "false", "all", ""),
    ("frontend/src/finance/FinancePage.tsx", "true", "all", ""),
])
def test_ci_selects_changed_e2e_specs(paths, full, mode, expected):
    script = REPO / "scripts/ops/e2e_test_scope.py"
    assert script.exists(), "E2E 变更需要可执行的选测入口"
    result = subprocess.run([sys.executable, str(script)], cwd=REPO, check=True, capture_output=True, text=True,
                            env={**os.environ, "E2E_CHANGED_PATHS": paths, "E2E_FULL_SUITE": full})
    output = dict(line.split("=", 1) for line in result.stdout.splitlines())
    assert output == {"e2e_mode": mode, "e2e_paths": expected}


def test_ci_scope_includes_all_commits_and_both_sides_of_renames(tmp_path):
    def git(*args):
        return subprocess.run(["git", *args], cwd=tmp_path, check=True, capture_output=True, text=True).stdout.strip()

    git("init", "-q")
    git("config", "user.name", "CI Test")
    git("config", "user.email", "ci-test@example.invalid")
    git("config", "commit.gpgsign", "false")
    (tmp_path / "backend").mkdir()
    (tmp_path / "backend/original.py").write_text("original\n")
    git("add", "backend/original.py")
    git("commit", "-qm", "test: base")
    base = git("rev-parse", "HEAD")
    (tmp_path / "frontend").mkdir()
    git("mv", "backend/original.py", "frontend/moved.py")
    git("commit", "-qm", "test: rename")
    (tmp_path / "notes.md").write_text("changed\n")
    git("add", "notes.md")
    git("commit", "-qm", "test: second change")
    head = git("rev-parse", "HEAD")

    scope = _ci_scope(tmp_path, CI_BASE_SHA=base, CI_HEAD_SHA=head)
    assert scope["mode"] == "changed" and scope["full_suite"] == "false"
    assert set(scope["changed_paths"].split(",")) == {"backend/original.py", "frontend/moved.py", "notes.md"}
    pr_scope = _ci_scope(tmp_path, CI_EVENT_NAME="pull_request", CI_BASE_SHA=base, CI_HEAD_SHA=head)
    assert pr_scope == scope
    git("commit", "--allow-empty", "-qm", "test: empty")
    empty_scope = _ci_scope(tmp_path, CI_BASE_SHA=head, CI_HEAD_SHA=git("rev-parse", "HEAD"))
    assert empty_scope["mode"] == "changed" and empty_scope["changed_paths"] == "VERSION"
    (tmp_path / "unsafe,name.py").write_text("changed\n")
    git("add", "unsafe,name.py")
    git("commit", "-qm", "test: unsafe path")
    unsafe = _ci_scope(tmp_path, CI_BASE_SHA=head, CI_HEAD_SHA=git("rev-parse", "HEAD"))
    assert unsafe["mode"] == "full" and unsafe["full_suite"] == "true"


@pytest.mark.parametrize(("event", "full", "paths", "expected_mode"), [
    ("push", "false", "backend/app/finance/balances.py", "changed"),
    ("workflow_dispatch", "false", "backend/app/finance/balances.py", "changed"),
    ("workflow_dispatch", "false", "", "full"),
    ("push", "true", "backend/app/finance/balances.py", "full"),
    ("push", "false", "", "full"),
    ("pull_request", "false", "", "full"),
    ("push", "false", "bad\npath", "full"),
])
def test_ci_scope_requires_full_suite_when_change_range_is_unknown(tmp_path, event, full, paths, expected_mode):
    scope = _ci_scope(tmp_path, CI_EVENT_NAME=event, CI_FULL_SUITE=full, CI_CHANGED_PATHS=paths)
    assert scope["mode"] == expected_mode
    assert scope["full_suite"] == ("true" if expected_mode == "full" else "false")
    if expected_mode == "changed":
        assert scope["changed_paths"] == paths
    else:
        assert scope["groups"] == "ci"


@pytest.mark.parametrize("path", [".github/workflows/main-ci-cd.yml", "scripts/ops/auto_release.sh", "tests/manifest.json", "tests/backend/conftest.py"])
def test_ci_configuration_changes_require_full_backend_regression(path):
    assert rr.is_structural_change([path])


def test_changed_paths_includes_renamed_and_untracked_test_files(tmp_path, monkeypatch):
    def git(*args):
        return subprocess.run(["git", *args], cwd=tmp_path, check=True, capture_output=True, text=True)

    git("init", "-q")
    git("config", "user.name", "Regression Test")
    git("config", "user.email", "regression-test@example.invalid")
    git("config", "commit.gpgsign", "false")
    old = Path("tests/backend/integration/finance/test_moved.py")
    new = Path("tests/backend/integration/finance/deposits/test_moved.py")
    extra = Path("tests/backend/integration/finance/deposits/test_new.py")
    (tmp_path / old).parent.mkdir(parents=True)
    (tmp_path / old).write_text("def test_moved(): pass\n", encoding="utf-8")
    (tmp_path / "backend").mkdir()
    git("add", str(old))
    git("commit", "-qm", "test: initial file")
    (tmp_path / new).parent.mkdir(parents=True)
    git("mv", str(old), str(new))
    (tmp_path / extra).write_text("def test_new(): pass\n", encoding="utf-8")
    monkeypatch.setattr(rr, "ROOT", tmp_path / "backend")

    assert set(rr.changed_paths()) == {str(old), str(new), str(extra)}


def test_removed_test_path_uses_full_regression_but_new_unregistered_file_still_fails(tmp_path, monkeypatch):
    monkeypatch.setattr(rr, "REPO", tmp_path)
    old = "tests/backend/integration/finance/test_moved.py"
    new = "tests/backend/integration/finance/deposits/test_new_unregistered.py"
    (tmp_path / new).parent.mkdir(parents=True)
    (tmp_path / new).write_text("def test_new(): pass\n", encoding="utf-8")

    assert rr.is_structural_change([old, new])
    assert not rr.is_structural_change([new])
    with pytest.raises(SystemExit, match="不在 GROUPS"):
        rr.groups_for_changes([new])


@pytest.mark.parametrize("path", [
    "backend/app/business/orders/mutations.py",
    "backend/app/business/orders/events.py",
    "backend/app/business/orders/importing/cashflows.py",
    "backend/app/business/shared/order_detail/editing/cashflows.py",
])
def test_order_financial_changes_select_order_and_funds_regressions(path):
    assert {"orders", "finance"}.issubset(rr.groups_for_changes([path]))


def test_funds_regressions_include_cross_domain_import_and_installment_flows():
    assert {
        "tests/backend/integration/business/orders/test_order_import.py",
        "tests/backend/integration/business/installments/test_installments_finance_integration.py",
    }.issubset(rr.GROUPS["finance"])


@pytest.mark.parametrize("path", [
    "backend/app/finance/cashflow/writes/reverse.py",
    "backend/app/finance/deposits/writes.py",
    "backend/app/finance/rebates.py",
])
def test_funds_writes_select_order_and_reporting_regressions(path):
    assert {"finance", "orders", "reporting"}.issubset(rr.groups_for_changes([path]))


def test_studio_summary_changes_select_finance_and_reporting_regressions():
    assert {"finance", "reporting"}.issubset(rr.groups_for_changes(["backend/app/finance/cashflow/reads/studio.py"]))


def test_shared_order_amounts_are_structural_for_test_selection():
    assert rr.is_structural_change(["backend/app/shared/order_amounts.py"])


def test_runtime_check_detects_missing_and_stale_locked_dependencies(tmp_path):
    from scripts.setup_test_environment import runtime_mismatches

    lock = tmp_path / "requirements.lock.txt"
    lock.write_text("redis==5.2.1\nsqlalchemy==2.1.9\n", encoding="utf-8")
    target = tmp_path / "runtime"
    target.mkdir()
    dist = target / "redis-5.2.0.dist-info"
    dist.mkdir()
    (dist / "METADATA").write_text("Name: redis\nVersion: 5.2.0\n", encoding="utf-8")
    assert runtime_mismatches(lock, target) == ["redis: 5.2.0 != 5.2.1", "sqlalchemy: 未安装 != 2.1.9"]
    (dist / "METADATA").write_text("Name: redis\nVersion: 5.2.1\n", encoding="utf-8")
    dist2 = target / "sqlalchemy-2.1.9.dist-info"
    dist2.mkdir()
    (dist2 / "METADATA").write_text("Name: SQLAlchemy\nVersion: 2.1.9\n", encoding="utf-8")
    assert runtime_mismatches(lock, target) == []
    dev = tmp_path / "requirements-dev.lock.txt"
    dev.write_text("pytest==9.1.1\npytest-xdist==3.8.0\nhttpcore==1.0.9\n", encoding="utf-8")
    assert len(runtime_mismatches(dev, target)) == 3
    for name, version in (("pytest", "9.1.1"), ("pytest-xdist", "3.8.0"), ("httpcore", "1.0.9")):
        package = target / f"{name}-{version}.dist-info"
        package.mkdir()
        (package / "METADATA").write_text(f"Name: {name}\nVersion: {version}\n", encoding="utf-8")
    assert runtime_mismatches(dev, target) == []
    (target / "httpcore-1.0.9.dist-info" / "METADATA").write_text("Name: httpcore\nVersion: 1.0.8\n", encoding="utf-8")
    assert runtime_mismatches(dev, target) == ["httpcore: 1.0.8 != 1.0.9"]


def test_failed_runtime_install_keeps_existing_dependencies(monkeypatch, tmp_path):
    import subprocess
    from scripts import setup_test_environment as setup

    runtime = tmp_path / "runtime"
    runtime.mkdir()
    (runtime / "existing").write_text("keep", encoding="utf-8")
    python = tmp_path / "python3"
    python.touch()
    monkeypatch.setattr(setup, "RUNTIME", runtime)
    monkeypatch.setattr(setup, "PYTHON", python)
    monkeypatch.setattr(setup, "runtime_mismatches", lambda _lock, _runtime: ["not ready"])
    def fail(command, **_kwargs):
        if "venv" in command:
            return
        assert "installer" in command[0]
        assert "--ignore-installed" in command
        raise subprocess.CalledProcessError(1, "pip")
    monkeypatch.setattr(setup.subprocess, "run", fail)
    with pytest.raises(subprocess.CalledProcessError):
        setup.prepare_runtime()
    assert (runtime / "existing").read_text(encoding="utf-8") == "keep"


def test_setup_rejects_redis_with_nonlocal_port(monkeypatch):
    import json
    from types import SimpleNamespace
    from scripts import setup_test_environment as setup

    calls = []
    container = [{"HostConfig": {"PortBindings": {"6379/tcp": [{"HostIp": "0.0.0.0", "HostPort": "6389"}]}},
                  "Config": {"Image": "redis:7-alpine"}, "State": {"Running": True}}]
    def fake_run(command, **_kwargs):
        calls.append(command)
        return SimpleNamespace(returncode=0, stdout=json.dumps(container))
    monkeypatch.setattr(setup.subprocess, "run", fake_run)
    with pytest.raises(RuntimeError, match="不是预期的独立本机 Redis"):
        setup.ensure_redis()
    assert len(calls) == 1


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
