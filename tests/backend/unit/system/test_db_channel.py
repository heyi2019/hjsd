"""TESTING-05 快通道必须真的不连库：`pytest -m "not db"` 里不得出现任何连库用例。

判据不用目录，也不用文件名，只用两条可验证的事实：

1. **夹具依赖派生**。全仓唯一创建引擎的夹具是 `v1_engine`，pytest 已把传递依赖
   展开进 `item.fixturenames`，`conftest.py` 据此自动加 `db` 标记。搬目录、改文件名
   都绕不过它——因为它读的是运行期真实依赖，不是声明。

2. **自建连接的显式声明**。不走 `v1_engine`、自己在用例里 `create_engine` 并
   `.connect()` 的文件，派生机制看不见，必须在模块级写 `pytestmark = pytest.mark.db`。
   `test_migration.py` 与 `test_numbering.py` 曾因此漏在快通道里，是死端口实验
   （把 DATABASE_URL 指向不可达端口后跑 `-m "not db"`，12 错误 1 失败）抓出来的。

本文件执行静态、收集期和离线入口校验，自身不连库。
"""

from __future__ import annotations

import os
import re
import shlex
import subprocess
from types import SimpleNamespace

import pytest
import run_regression

# 测试文件下沉后 parents[N] 的层数变了，写死层数只能撑到下一次搬家。
from _repo import BE_TESTS, REPO_ROOT

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
    "test_notifications_service.py",  # 已读并发测试使用独立连接观察接收人锁
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


def test_temporary_database_names_are_safe_and_distinct():
    from scripts.ephemeral_test_db import make_database_name, validate_owned_database

    first = make_database_name("test")
    second = make_database_name("test")
    assert first != second
    assert validate_owned_database(first, "test")
    assert not validate_owned_database("heijin_erp_dev", "test")
    assert not validate_owned_database("heijin_erp_test", "test")
    assert not validate_owned_database(first, "e2e")


def test_failed_e2e_retention_is_not_used_for_other_runs():
    from scripts.ephemeral_test_db import should_retain

    assert should_retain("e2e", 1)
    assert not should_retain("e2e", 0)
    assert not should_retain("test", 1)


@pytest.mark.parametrize("returncode", [0, 1])
def test_e2e_attachments_are_isolated_and_follow_run_outcome(tmp_path, monkeypatch, returncode):
    """E2E 文件不能污染原目录；失败时保留附件以便排查。"""
    import sys
    import tempfile
    from pathlib import Path
    from scripts import ephemeral_test_db

    class Cursor:
        def __enter__(self):
            return self

        def __exit__(self, *_args):
            pass

        def execute(self, *_args):
            pass

        def fetchall(self):
            return []

    class Connection:
        def __enter__(self):
            return self

        def __exit__(self, *_args):
            pass

        def cursor(self):
            return Cursor()

    monkeypatch.setattr(ephemeral_test_db, "database_urls", lambda *_: (
        "postgresql://localhost/postgres",
        "postgresql://localhost/heijin_tmp_e2e_1234567890_abcdef123456",
    ))
    monkeypatch.setattr(ephemeral_test_db.psycopg, "connect", lambda *_args, **_kwargs: Connection())
    monkeypatch.setattr(tempfile, "tempdir", str(tmp_path))
    original = tmp_path / "original-attachments"
    original.mkdir()
    (original / "keep.txt").write_text("keep")
    monkeypatch.setenv("ATTACHMENT_STORAGE_DIR", str(original))
    seen = tmp_path / "seen.txt"
    child = (
        "import os, pathlib, sys; "
        "p = pathlib.Path(os.environ['ATTACHMENT_STORAGE_DIR']); "
        "(p / 'upload.txt').write_text('test'); "
        "pathlib.Path(sys.argv[1]).write_text(str(p)); "
        "sys.exit(int(sys.argv[2]))"
    )

    assert ephemeral_test_db.run("e2e", [sys.executable, "-c", child, str(seen), str(returncode)]) == returncode
    used = Path(seen.read_text())
    assert used.parent == tmp_path and used != original
    if returncode:
        assert (used / "upload.txt").read_text() == "test"
    else:
        assert not used.exists()
    assert list(original.iterdir()) == [original / "keep.txt"]


def test_interrupted_e2e_retains_evidence_even_if_child_exits_zero(tmp_path):
    """子进程优雅退出也不能把被中断的 E2E 当作成功清理。"""
    import signal
    import sys
    import time

    controller = """
import sys, tempfile
from pathlib import Path
from scripts import ephemeral_test_db as runner
root = Path(sys.argv[1])
class Cursor:
    def __enter__(self): return self
    def __exit__(self, *_): pass
    def execute(self, *_): pass
    def fetchall(self): return []
class Connection:
    def __enter__(self): return self
    def __exit__(self, *_): pass
    def cursor(self): return Cursor()
runner.database_urls = lambda *_: ('postgresql://localhost/postgres', 'postgresql://localhost/heijin_tmp_e2e_1234567890_abcdef123456')
runner.psycopg.connect = lambda *_args, **_kwargs: Connection()
tempfile.tempdir = str(root)
child = '''
import os, pathlib, signal, subprocess, sys, time
root = pathlib.Path(sys.argv[1])
def stop(*_): sys.exit(0)
signal.signal(signal.SIGTERM, stop)
grandchild = '; '.join([
    'import os, pathlib, signal, sys',
    'root = pathlib.Path(sys.argv[1])',
    "signal.signal(signal.SIGTERM, lambda *_: ((root / 'grandchild-stopped').touch(), os._exit(0)))",
    "(root / 'grandchild-pid').write_text(str(os.getpid()))",
    'signal.pause()',
])
subprocess.Popen([sys.executable, '-c', grandchild, str(root)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
while not (root / 'grandchild-pid').exists(): time.sleep(0.01)
pathlib.Path(os.environ['ATTACHMENT_STORAGE_DIR'], 'upload').write_text('test')
(root / 'child-pid').write_text(str(os.getpid()))
(root / 'ready').touch()
while True: time.sleep(0.05)
'''
sys.exit(runner.run('e2e', [sys.executable, '-c', child, str(root)]))
"""
    process = subprocess.Popen([sys.executable, "-c", controller, str(tmp_path)],
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    try:
        deadline = time.monotonic() + 10
        while not (tmp_path / "ready").exists() and time.monotonic() < deadline:
            assert process.poll() is None
            time.sleep(0.02)
        assert (tmp_path / "ready").exists()
        process.terminate()
        stdout, stderr = process.communicate(timeout=10)
        assert process.returncode == 143, stderr
        assert "E2E 失败，保留" in stdout
        assert [p.read_text() for p in tmp_path.glob("heijin-e2e-attachments-*/upload")] == ["test"]
        deadline = time.monotonic() + 2
        while not (tmp_path / "grandchild-stopped").exists() and time.monotonic() < deadline:
            time.sleep(0.02)
        assert (tmp_path / "grandchild-stopped").exists()
    finally:
        if process.poll() is None:
            process.kill()
            process.wait()
            pid = tmp_path / "child-pid"
            if pid.exists():
                try:
                    os.kill(int(pid.read_text()), signal.SIGKILL)
                except ProcessLookupError:
                    pass
        pid = tmp_path / "grandchild-pid"
        if pid.exists() and not (tmp_path / "grandchild-stopped").exists():
            try:
                os.kill(int(pid.read_text()), signal.SIGKILL)
            except ProcessLookupError:
                pass


def test_expired_e2e_cleanup_removes_only_owned_attachment_directories(tmp_path, monkeypatch):
    """过期的隔离库和附件一起回收，其他目录与符号链接保持不变。"""
    import tempfile
    from scripts import ephemeral_test_db

    old = "heijin_tmp_e2e_1234567890_abcdef123456"
    recent = "heijin_tmp_e2e_1999999999_abcdef123456"
    stale_dir = tmp_path / f"heijin-e2e-attachments-{old}-abcdefgh"
    live_dir = tmp_path / f"heijin-e2e-attachments-{recent}-abcdefgh"
    orphan_name = "heijin_tmp_e2e_1234567890_deadbeef1234"
    orphan = tmp_path / f"heijin-e2e-attachments-{orphan_name}-abcdefgh"
    unowned = tmp_path / f"heijin-e2e-attachments-{orphan_name}-ijklmnop"
    outside = tmp_path / "outside"
    for directory in (stale_dir, live_dir, orphan, unowned, outside):
        directory.mkdir()
        (directory / "keep").touch()
    for directory, name in ((stale_dir, old), (live_dir, recent), (orphan, orphan_name)):
        (directory / ".heijin-e2e-owner").write_text(f"{ephemeral_test_db.MARKER}:{name}")
    link = tmp_path / f"heijin-e2e-attachments-{old}-ijklmnop"
    link.symlink_to(outside, target_is_directory=True)

    class Cursor:
        def __enter__(self):
            return self

        def __exit__(self, *_args):
            pass

        def execute(self, *_args):
            pass

        def fetchall(self):
            return [(1, old, ephemeral_test_db.MARKER), (2, recent, ephemeral_test_db.MARKER)]

        def fetchone(self):
            return None

    class Connection:
        def cursor(self):
            return Cursor()

    monkeypatch.setattr(tempfile, "tempdir", str(tmp_path))
    monkeypatch.setattr(ephemeral_test_db.time, "time", lambda: 2_000_000_000)
    ephemeral_test_db.cleanup_expired_e2e(Connection())
    assert not stale_dir.exists()
    assert not orphan.exists()
    assert (live_dir / "keep").exists()
    assert (unowned / "keep").exists()
    assert link.is_symlink() and (outside / "keep").exists()


def test_expired_e2e_attachment_cleanup_can_retry_after_failure(tmp_path, monkeypatch):
    """附件删除失败不阻断后续测试，下次可以根据所有权标记重试。"""
    import tempfile
    from scripts import ephemeral_test_db

    name = "heijin_tmp_e2e_1234567890_abcdef123456"
    directory = tmp_path / f"heijin-e2e-attachments-{name}-abcdefgh"
    directory.mkdir()
    (directory / ".heijin-e2e-owner").write_text(f"{ephemeral_test_db.MARKER}:{name}")

    class Cursor:
        def __enter__(self): return self
        def __exit__(self, *_args): pass
        def execute(self, *_args): pass
        def fetchall(self): return []

    class Connection:
        def cursor(self): return Cursor()

    original = ephemeral_test_db.shutil.rmtree
    attempts = []
    def remove(path):
        attempts.append(path)
        if len(attempts) == 1:
            raise OSError("simulated cleanup failure")
        original(path)

    monkeypatch.setattr(tempfile, "tempdir", str(tmp_path))
    monkeypatch.setattr(ephemeral_test_db.time, "time", lambda: 2_000_000_000)
    monkeypatch.setattr(ephemeral_test_db.shutil, "rmtree", remove)
    ephemeral_test_db.cleanup_expired_e2e(Connection())
    assert directory.exists()
    ephemeral_test_db.cleanup_expired_e2e(Connection())
    assert not directory.exists()


def test_temporary_database_rejects_development_and_remote_targets():
    from scripts.ephemeral_test_db import database_urls

    with pytest.raises(ValueError, match="测试库与开发库相同"):
        database_urls("test", {
            "DATABASE_URL": "postgresql://u:p@localhost:5433/heijin_erp_test",
            "TEST_DATABASE_URL": "postgresql://u:p@127.0.0.1:5433/heijin_erp_test",
        })
    with pytest.raises(ValueError, match="仅允许本机"):
        database_urls("test", {"TEST_DATABASE_URL": "postgresql://u:p@example.com/heijin_erp_test"})


def test_ci_can_use_its_disposable_base_service_without_reusing_it():
    from sqlalchemy.engine import make_url
    from scripts.ephemeral_test_db import database_urls

    base = "postgresql://u:p@127.0.0.1:5432/heijin_erp_test"
    _, target = database_urls("test", {"GITHUB_ACTIONS": "true", "DATABASE_URL": base, "TEST_DATABASE_URL": base})
    assert make_url(target).database != "heijin_erp_test"


def _offline_test_local(tmp_path, *args):
    # 用轻量替身检查入口交给 pytest 的环境和参数，不依赖本机 Python 或再次启动 pytest。
    root = tmp_path / "local-runner"
    scripts = root / "scripts/ops"
    scripts.mkdir(parents=True)
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    setup_python = bin_dir / "python3"
    setup_python.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
    setup_python.chmod(0o755)
    fake_pytest = bin_dir / "pytest-python"
    fake_pytest.write_text(
        '#!/bin/sh\nprintf "%s\\n" "$DATABASE_URL" "$TEST_DATABASE_URL" "$@"\n', encoding="utf-8"
    )
    fake_pytest.chmod(0o755)
    launcher = (REPO_ROOT / "scripts/ops/test-local.sh").read_text(encoding="utf-8")
    local_python = "/Users/aries/Applications/Python_3.13/bin/python3"
    assert local_python in launcher
    launcher_path = scripts / "test-local.sh"
    launcher_path.write_text(launcher.replace(local_python, shlex.quote(str(fake_pytest))), encoding="utf-8")
    launcher_path.chmod(0o755)
    (scripts / "test-local-mode.sh").write_text(
        (REPO_ROOT / "scripts/ops/test-local-mode.sh").read_text(encoding="utf-8"), encoding="utf-8"
    )
    env = os.environ.copy()
    env["DATABASE_URL"] = "postgresql+psycopg://test:test@127.0.0.1:1/heijin_erp_dev"
    env["TEST_DATABASE_URL"] = "postgresql+psycopg://test:test@127.0.0.1:1/heijin_erp_test"
    env["PATH"] = str(bin_dir) + os.pathsep + env.get("PATH", "")
    env.pop("PYTEST_ADDOPTS", None)
    for key in ("PYTEST_XDIST_WORKER", "PYTEST_XDIST_WORKER_COUNT", "PYTEST_XDIST_TESTRUNUID"):
        env.pop(key, None)
    return subprocess.run(
        [str(launcher_path), *args],
        cwd=REPO_ROOT, env=env, capture_output=True, text=True, timeout=45,
    )


def _offline_mode(*args, env_overrides=None):
    env = os.environ.copy()
    env.pop("PYTEST_ADDOPTS", None)
    env.pop("PYTEST_XDIST_WORKER", None)
    env.update(env_overrides or {})
    return subprocess.run(
        ["/bin/sh", "-c", '. "$1"; shift; heijin_is_offline "$@"',
         "test-local-mode", str(REPO_ROOT / "scripts/ops/test-local-mode.sh"), *args],
        cwd=REPO_ROOT, env=env, capture_output=True, text=True,
    )


@pytest.mark.parametrize("args,offline", [
    (("-m", "not db"), True),
    (("--collect-only",), True),
    (("--co",), True),
    (("-m", "not db or db"), False),
    (("-m", "not db", "-m", "db"), False),
    (("-n", "2", "-m", "not db"), False),
    (("--collect-only", "--numprocesses=2"), False),
    (("-m", "not db", "-o", "addopts=-n2"), False),
    (("--collect-only", "-c", "custom.ini"), False),
    (("-mnot db",), False),
    (("--", "--collect-only"), False),
    (("-q",), False),
    (("-m",), False),
])
def test_offline_mode_is_conservative(args, offline):
    """仅明确离线的选测参数跳过临时库，含糊和并行参数保留隔离。"""
    result = _offline_mode(*args)
    assert result.returncode == (0 if offline else 1), result.stderr


@pytest.mark.parametrize("overrides", [
    {"PYTEST_ADDOPTS": "-m db"},
    {"PYTEST_XDIST_WORKER": "gw0"},
])
def test_offline_mode_rejects_ambient_options(overrides):
    """附加 pytest 选项和 xdist 工作进程不使用离线通道。"""
    assert _offline_mode("-m", "not db", env_overrides=overrides).returncode == 1


def test_offline_channel_blocks_database_urls_and_preserves_selection(tmp_path):
    """离线入口使用不可达数据库地址，并原样传递选测参数。"""
    from sqlalchemy.engine import make_url

    for index, args in enumerate((
        ("-q", "tests/example.py", "-m", "not db"),
        ("--collect-only", "-q", "tests/example.py"),
    )):
        result = _offline_test_local(tmp_path / str(index), *args)
        assert result.returncode == 0, result.stdout + result.stderr
        lines = result.stdout.splitlines()
        for raw_url, database in zip(lines[:2], ("heijin_erp_dev", "heijin_erp_test")):
            url = make_url(raw_url)
            assert url.database == database
            assert url.query.get("host") == "/dev/null"
        assert lines[2:] == ["-m", "pytest", *args]
