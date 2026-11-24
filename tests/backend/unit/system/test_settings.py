"""CONFIG-01 T01 / SYS-01-01：配置必须来自**根目录 .env**，且不得指向旧库。"""
from __future__ import annotations

import re

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from app.api import create_app
from app.core.settings import (
    PROJECT_ROOT,
    Settings,
    get_settings,
    locate_env_file,
)

SECURE_TEST_SECRET = "test-production-secret-0123456789-abcdef"


def _release_record_file(root, section=""):
    path = root / "docs" / "版本管理.md"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("# 版本管理\n\n## 版本发布记录\n\n" + section, encoding="utf-8")
    return path


def _release_script_fixture(root, *script_names):
    import shutil

    scripts = root / "scripts" / "ops"
    scripts.mkdir(parents=True)
    for name in (*script_names, "release_record_fields.py"):
        shutil.copy2(PROJECT_ROOT / "scripts" / "ops" / name, scripts / name)
    versions = root / "backend" / "alembic" / "release_versions"
    versions.mkdir(parents=True)
    (versions / "release_baseline.py").write_text('revision: str = "0099"\n', encoding="utf-8")
    (root / "backend" / "alembic.ini").write_text(
        "[alembic]\nversion_locations = %(here)s/alembic/release_versions\n", encoding="utf-8",
    )
    return scripts


def test_default_application_version_is_semver_without_release_prefix(monkeypatch):
    """API 对外使用 SemVer；V 前缀只属于系统发布标签。

    项目根目录 VERSION 是唯一事实源，配置默认值从该文件读取并校验格式。
    """
    # CI 可能注入 APP_VERSION（部署脚本的发布版本），会覆盖配置默认值；
    # 本用例测的是「缺省值 == 事实源」，必须屏蔽外部环境变量。
    monkeypatch.delenv("APP_VERSION", raising=False)
    from app.version import __version__ as release_version

    assert Settings().app_version == release_version
    assert re.fullmatch(r"\d+\.\d+\.\d+", release_version), "必须是 x.y.z 形式，且不带 v 前缀"


def test_project_version_is_the_only_release_version():
    """项目版本统一存根目录，前端包和锁文件不维护独立的发布版本。"""
    import json

    from app.version import __version__ as release_version

    version_file = PROJECT_ROOT / "VERSION"
    assert version_file.is_file(), "项目根目录应有唯一的 VERSION 文件"
    assert version_file.read_text(encoding="utf-8").strip() == release_version
    pkg = json.loads((PROJECT_ROOT / "frontend" / "package.json").read_text(encoding="utf-8"))
    lock = json.loads((PROJECT_ROOT / "package-lock.json").read_text(encoding="utf-8"))
    assert "version" not in pkg
    assert "version" not in lock["packages"]["frontend"]


def test_backend_reads_project_version_in_a_fresh_layout(tmp_path):
    """更换项目版本后重新启动时，API 必须读取新值而非后端内的常量。"""
    import shutil
    import subprocess
    import sys

    module = tmp_path / "backend" / "app" / "version.py"
    module.parent.mkdir(parents=True)
    shutil.copy2(PROJECT_ROOT / "backend" / "app" / "version.py", module)
    (tmp_path / "VERSION").write_text("2.3.4\n", encoding="utf-8")
    result = subprocess.run(
        [sys.executable, "-c", "import runpy,sys; print(runpy.run_path(sys.argv[1])['__version__'])", str(module)],
        check=True, capture_output=True, text=True,
    )
    assert result.stdout.strip() == "2.3.4"


@pytest.mark.parametrize(("mode", "expected"), [("patch", "2.3.5"), ("minor", "2.4.0"), ("major", "3.0.0")])
def test_version_bump_updates_the_project_version_only(tmp_path, mode, expected):
    """升版不依赖也不修改前端 package 或 lock 文件。"""
    import shutil
    import subprocess

    script = tmp_path / "scripts" / "ops" / "bump_version.sh"
    script.parent.mkdir(parents=True)
    shutil.copy2(PROJECT_ROOT / "scripts" / "ops" / "bump_version.sh", script)
    (tmp_path / "VERSION").write_text("2.3.4\n", encoding="utf-8")
    (tmp_path / "frontend").mkdir()
    package = tmp_path / "frontend" / "package.json"
    package.write_text('{"name":"frontend","private":true}\n', encoding="utf-8")
    lock = tmp_path / "package-lock.json"
    lock.write_text('{"packages":{"frontend":{"name":"frontend"}}}\n', encoding="utf-8")
    originals = (package.read_bytes(), lock.read_bytes())

    result = subprocess.run(["bash", str(script), mode], cwd=tmp_path, capture_output=True, text=True)

    assert result.returncode == 0, result.stdout + result.stderr
    assert (tmp_path / "VERSION").read_text(encoding="utf-8").strip() == expected
    assert (package.read_bytes(), lock.read_bytes()) == originals


@pytest.mark.parametrize(
    ("subject", "expected"),
    [("fix: 修复问题", "2.3.5"), ("feat: 新增功能", "2.4.0"), ("feat!: 不兼容调整", "3.0.0")],
)
def test_automatic_release_uses_the_project_version(tmp_path, subject, expected):
    """自动发版按提交类型升项目版本，并生成对应的发布记录。"""
    import subprocess

    scripts = _release_script_fixture(tmp_path, "bump_version.sh", "auto_release.sh")
    auto_script = scripts / "auto_release.sh"
    (tmp_path / "VERSION").write_text("2.3.4\n", encoding="utf-8")
    notes_file = _release_record_file(tmp_path, "### V2.3.4\n**发布状态：** 已发布\n")

    def git(*args):
        return subprocess.run(["git", *args], cwd=tmp_path, check=True, capture_output=True, text=True).stdout.strip()

    git("init", "-q")
    git("config", "user.name", "Version Test")
    git("config", "user.email", "version-test@example.invalid")
    git("config", "commit.gpgsign", "false")
    git("config", "core.hooksPath", "/dev/null")
    git("add", ".")
    git("commit", "-qm", "test: baseline")
    baseline = git("rev-parse", "HEAD")
    git("commit", "-q", "--allow-empty", "-m", subject)
    result = subprocess.run(["bash", str(auto_script), baseline, "HEAD"], cwd=tmp_path, capture_output=True, text=True)

    assert result.returncode == 0, result.stdout + result.stderr
    assert (tmp_path / "VERSION").read_text(encoding="utf-8").strip() == expected
    notes = notes_file.read_text(encoding="utf-8")
    assert f"### V{expected}" in notes
    assert f"**前端版本：** V{expected}" in notes
    assert f"**后端版本：** V{expected}" in notes
    assert "**数据库迁移编号：** `0099`" in notes
    assert "**发布日期：** 待发布" in notes
    assert "**发布时间：** 待发布" in notes
    assert "**发布状态：** 待发布" in notes
    assert "#### 本次更新内容" in notes
    assert subject.split(": ", 1)[1] in notes


def test_automatic_release_preserves_the_chosen_project_version(tmp_path):
    """发布前明确指定的版本不能被提交类型自动升版覆盖。"""
    import subprocess

    scripts = _release_script_fixture(tmp_path, "bump_version.sh", "auto_release.sh")
    version_file = tmp_path / "VERSION"
    version_file.write_text("2.3.4\n", encoding="utf-8")
    notes_file = _release_record_file(tmp_path, "### V2.3.4\n**发布状态：** 已发布\n")

    def git(*args):
        return subprocess.run(["git", *args], cwd=tmp_path, check=True, capture_output=True, text=True).stdout.strip()

    git("init", "-q")
    git("config", "user.name", "Version Test")
    git("config", "user.email", "version-test@example.invalid")
    git("config", "commit.gpgsign", "false")
    git("config", "core.hooksPath", "/dev/null")
    git("add", ".")
    git("commit", "-qm", "test: baseline")
    baseline = git("rev-parse", "HEAD")
    version_file.write_text("2.3.9\n", encoding="utf-8")
    git("add", "VERSION")
    git("commit", "-qm", "feat: 按用户指定版本发布")

    result = subprocess.run(
        ["bash", str(scripts / "auto_release.sh"), baseline, "HEAD"],
        cwd=tmp_path, capture_output=True, text=True,
    )

    assert result.returncode == 0, result.stdout + result.stderr
    assert version_file.read_text(encoding="utf-8").strip() == "2.3.9"
    assert "### V2.3.9" in notes_file.read_text(encoding="utf-8")


def test_first_project_version_release_respects_chosen_version(tmp_path):
    """从旧版后端常量迁移到 VERSION 时，也不能覆盖用户指定的版本。"""
    import subprocess

    scripts = _release_script_fixture(tmp_path, "bump_version.sh", "auto_release.sh")
    old_module = tmp_path / "backend" / "app" / "version.py"
    old_module.parent.mkdir(parents=True)
    old_module.write_text('__version__ = "2.3.4"\n', encoding="utf-8")
    notes_file = _release_record_file(tmp_path, "### V2.3.4\n**发布状态：** 已发布\n")

    def git(*args):
        return subprocess.run(["git", *args], cwd=tmp_path, check=True, capture_output=True, text=True).stdout.strip()

    git("init", "-q")
    git("config", "user.name", "Version Test")
    git("config", "user.email", "version-test@example.invalid")
    git("config", "commit.gpgsign", "false")
    git("config", "core.hooksPath", "/dev/null")
    git("add", ".")
    git("commit", "-qm", "test: legacy baseline")
    baseline = git("rev-parse", "HEAD")
    (tmp_path / "VERSION").write_text("2.3.9\n", encoding="utf-8")
    git("add", "VERSION")
    git("commit", "-qm", "feat: 使用指定项目版本")

    result = subprocess.run(
        ["bash", str(scripts / "auto_release.sh"), baseline, "HEAD"],
        cwd=tmp_path, capture_output=True, text=True,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    assert (tmp_path / "VERSION").read_text(encoding="utf-8").strip() == "2.3.9"
    assert "### V2.3.9" in notes_file.read_text(encoding="utf-8")


@pytest.mark.parametrize(
    ("chosen", "record_state", "should_succeed"),
    [("2.3.4", "none", True), ("2.3.4", "pending", True),
     ("2.5.0", "none", False), ("abc", "none", False),
     ("2.3.4", "published", False)],
)
def test_release_marker_selects_the_exact_unreleased_version(tmp_path, chosen, record_state, should_succeed):
    """用户确认的版本即使与当前相同也不可擅自升版或覆盖已有记录。"""
    import subprocess

    scripts = _release_script_fixture(tmp_path, "bump_version.sh", "auto_release.sh")
    version_file = tmp_path / "VERSION"
    version_file.write_text("2.3.4\n", encoding="utf-8")
    section = ""
    if record_state != "none":
        status = "待发布" if record_state == "pending" else "已发布"
        section = (f"### V2.3.4\n**版本号：** V2.3.4\n**发布日期：** 待发布\n"
                   f"**发布时间：** 待发布\n**发布状态：** {status}\n"
                   "#### 本次更新内容\n- 保留用户填写的内容\n")
    notes_file = _release_record_file(tmp_path, section)
    original_notes = notes_file.read_text(encoding="utf-8")

    def git(*args):
        return subprocess.run(["git", *args], cwd=tmp_path, check=True, capture_output=True, text=True).stdout.strip()

    git("init", "-q")
    git("config", "user.name", "Version Test")
    git("config", "user.email", "version-test@example.invalid")
    git("config", "commit.gpgsign", "false")
    git("config", "core.hooksPath", "/dev/null")
    git("add", ".")
    git("commit", "-qm", "test: baseline")
    baseline = git("rev-parse", "HEAD")
    git("commit", "-q", "--allow-empty", "-m", "feat: 功能更新", "-m", f"Release-Version: {chosen}")

    result = subprocess.run(
        ["bash", str(scripts / "auto_release.sh"), baseline, "HEAD"],
        cwd=tmp_path, capture_output=True, text=True,
    )
    assert (result.returncode == 0) is should_succeed, result.stdout + result.stderr
    assert version_file.read_text(encoding="utf-8").strip() == "2.3.4"
    if should_succeed:
        notes = notes_file.read_text(encoding="utf-8")
        assert notes.count("### V2.3.4") == 1
        assert notes.count("**前端版本：** V2.3.4") == 1
        assert notes.count("**后端版本：** V2.3.4") == 1
        assert notes.count("**数据库迁移编号：** `0099`") == 1
        if record_state == "pending":
            assert "保留用户填写的内容" in notes
        assert "功能更新" in notes
    else:
        assert notes_file.read_text(encoding="utf-8") == original_notes


def test_tag_uses_the_committed_project_version(tmp_path):
    """单独打标签要指向含当前 VERSION 的提交，重复执行不能覆盖已有标签。"""
    import shutil
    import subprocess

    script = tmp_path / "scripts" / "ops" / "bump_version.sh"
    script.parent.mkdir(parents=True)
    shutil.copy2(PROJECT_ROOT / "scripts" / "ops" / "bump_version.sh", script)
    (tmp_path / "VERSION").write_text("2.3.4\n", encoding="utf-8")

    def git(*args):
        return subprocess.run(["git", *args], cwd=tmp_path, check=True, capture_output=True, text=True).stdout.strip()

    git("init", "-q")
    git("config", "user.name", "Version Test")
    git("config", "user.email", "version-test@example.invalid")
    git("config", "commit.gpgsign", "false")
    git("config", "core.hooksPath", "/dev/null")
    git("add", ".")
    git("commit", "-qm", "test: version baseline")
    first = subprocess.run(["bash", str(script), "--tag"], cwd=tmp_path, capture_output=True, text=True)
    assert first.returncode == 0, first.stdout + first.stderr
    assert git("rev-parse", "v2.3.4^{}") == git("rev-parse", "HEAD")
    second = subprocess.run(["bash", str(script), "--tag"], cwd=tmp_path, capture_output=True, text=True)
    assert second.returncode != 0
    assert (tmp_path / "VERSION").read_text(encoding="utf-8") == "2.3.4\n"


def _release_sections(text: str) -> dict[str, str]:
    """把版本管理文档中的版本记录切成 {版本: 章节正文}。"""
    sections: dict[str, str] = {}
    current: str | None = None
    buffer: list[str] = []

    for line in text.splitlines():
        match = re.match(r"^###\s+V?(\d+\.\d+\.\d+)(?:\s|$)", line)
        if match:
            if current is not None:
                sections[current] = "\n".join(buffer)
            current = match.group(1)
            buffer = []
            continue
        if line.startswith("## "):
            if current is not None:
                sections[current] = "\n".join(buffer)
            current = None
            buffer = []
            continue
        if current is not None:
            buffer.append(line)

    if current is not None:
        sections[current] = "\n".join(buffer)
    return sections


def test_release_notes_has_section_for_current_version():
    """项目版本必须有发布记录，每条记录都有对应的组件版本。"""
    from app.version import __version__ as release_version

    release_path = PROJECT_ROOT / "docs" / "版本管理.md"
    assert release_path.is_file(), f"缺少发布记录：{release_path}"

    sections = _release_sections(release_path.read_text(encoding="utf-8"))
    assert sections, "版本管理文档中没有 `### Vx.y.z` 发布章节"

    assert release_version in sections, (
        f"版本管理文档缺少当前版本 V{release_version} 的章节"
        f"（现有：{', '.join('V' + v for v in sections)}）。\n"
        f"发版请依次执行：\n"
        f"  1) scripts/ops/bump_version.sh {release_version}   # 更新项目版本\n"
        f"  2) scripts/ops/changelog.sh --write                # 生成章节草稿并插入\n"
        f"  3) 人工补充实际更新内容"
    )

    for version, section in sections.items():
        for component in ("前端版本", "后端版本"):
            matches = re.findall(rf"^\*\*{component}：\*\* (.+)$", section, re.M)
            assert matches == [f"V{version}"], f"V{version} 的{component}与项目版本不一致"
        revisions = re.findall(r"^\*\*数据库迁移编号：\*\* `([A-Za-z0-9_-]+)`$", section, re.M)
        assert len(revisions) == 1, f"V{version} 缺少明确的数据库迁移编号"

    body = sections[release_version]
    for required in ("版本号", "发布日期", "发布时间", "发布状态", "本次更新内容"):
        assert required in body, (
            f"V{release_version} 章节缺少「{required}」。"
            "空章节等于没写——它挡不住「这版到底改了什么」这个问题"
        )


def test_release_time_is_recorded_only_after_confirmed_publication(tmp_path):
    """已验证部署后才记录实际日期和北京时间，并保留人工填写的更新内容。"""
    import subprocess
    import sys

    notes = _release_record_file(
        tmp_path,
        "### V2.3.4\n**版本号：** V2.3.4\n**前端版本：** V2.3.4\n**后端版本：** V2.3.4\n"
        "**数据库迁移编号：** `0099`\n**发布日期：** 待发布\n"
        "**发布时间：** 待发布\n**发布状态：** 待发布\n"
        "#### 本次更新内容\n- 用户填写的说明\n",
    )
    script = PROJECT_ROOT / "scripts" / "ops" / "record_release_published.py"
    result = subprocess.run(
        [sys.executable, str(script), "2.3.4", "--file", str(notes),
         "--at", "2026-11-21T04:34:56+00:00"], capture_output=True, text=True,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    text = notes.read_text(encoding="utf-8")
    assert "**发布日期：** 2026-11-21" in text
    assert "**发布时间：** 12:34:56（北京时间）" in text
    assert "**发布状态：** 已发布" in text
    assert "**前端版本：** V2.3.4" in text
    assert "**后端版本：** V2.3.4" in text
    assert "**数据库迁移编号：** `0099`" in text
    assert "用户填写的说明" in text


@pytest.mark.parametrize(("version", "timestamp"), [
    ("2.3.5", "2026-11-21T04:34:56+00:00"),
    ("2.3.4", "2026-11-21T04:34:56"),
])
def test_release_time_rejects_missing_record_or_ambiguous_timestamp(tmp_path, version, timestamp):
    import subprocess
    import sys

    notes = _release_record_file(
        tmp_path, "### V2.3.4\n**发布日期：** 待发布\n**发布时间：** 待发布\n**发布状态：** 待发布\n",
    )
    original = notes.read_text(encoding="utf-8")
    result = subprocess.run(
        [sys.executable, str(PROJECT_ROOT / "scripts" / "ops" / "record_release_published.py"),
         version, "--file", str(notes), "--at", timestamp], capture_output=True, text=True,
    )
    assert result.returncode != 0
    assert notes.read_text(encoding="utf-8") == original


def test_manual_changelog_preserves_the_pending_release_details(tmp_path):
    """手动生成提交摘要不能覆盖已有说明或伪造上线时间。"""
    import subprocess

    script = _release_script_fixture(tmp_path, "changelog.sh") / "changelog.sh"
    (tmp_path / "VERSION").write_text("1.0.0\n", encoding="utf-8")
    notes = _release_record_file(
        tmp_path,
        "### V1.0.0\n**版本号：** V1.0.0\n**前端版本：** V0.1.0\n**发布日期：** 待发布\n"
        "**发布时间：** 待发布\n**发布状态：** 待发布\n"
        "#### 本次更新内容\n- 手工填写的说明\n",
    )
    def git(*args):
        return subprocess.run(["git", *args], cwd=tmp_path, check=True, capture_output=True, text=True).stdout.strip()

    git("init", "-q")
    git("config", "user.name", "Version Test")
    git("config", "user.email", "version-test@example.invalid")
    git("config", "commit.gpgsign", "false")
    git("config", "core.hooksPath", "/dev/null")
    git("add", ".")
    git("commit", "-qm", "test: baseline")
    baseline = git("rev-parse", "HEAD")
    git("commit", "-q", "--allow-empty", "-m", "fix: 修复登录")
    migration = tmp_path / "backend" / "alembic" / "release_versions" / "release_baseline.py"
    migration.write_text('revision = "0199"\n', encoding="utf-8")
    original = notes.read_text(encoding="utf-8")
    draft = subprocess.run(["bash", str(script), "--from", baseline], cwd=tmp_path, capture_output=True, text=True)
    assert draft.returncode == 0, draft.stderr
    assert "**数据库迁移编号：** `0099`" in draft.stdout
    assert notes.read_text(encoding="utf-8") == original

    result = subprocess.run(["bash", str(script), "--from", baseline, "--write"], cwd=tmp_path, capture_output=True, text=True)
    assert result.returncode == 0, result.stdout + result.stderr
    text = notes.read_text(encoding="utf-8")
    assert text.count("### V1.0.0") == 1
    assert "手工填写的说明" in text
    assert text.count("**前端版本：**") == 1
    assert "**前端版本：** V1.0.0" in text
    assert "**后端版本：** V1.0.0" in text
    assert "**数据库迁移编号：** `0099`" in text
    assert "修复登录" in text
    assert "**发布日期：** 待发布" in text
    assert "**发布时间：** 待发布" in text


def test_confirmed_publication_workflow_updates_release_history_in_git(tmp_path):
    """用本地裸仓库验证部署成功后的记录提交与重复执行。"""
    import os
    import shutil
    import subprocess
    import textwrap

    remote = tmp_path / "remote.git"
    source = tmp_path / "source"
    runner = tmp_path / "runner"
    source.mkdir()
    _release_record_file(
        source, "### V2.3.4\n**版本号：** V2.3.4\n**发布日期：** 待发布\n"
        "**发布时间：** 待发布\n**发布状态：** 待发布\n"
        "#### 本次更新内容\n- 原有说明\n",
    )
    helper = source / "scripts" / "ops" / "record_release_published.py"
    helper.parent.mkdir(parents=True)
    shutil.copy2(PROJECT_ROOT / "scripts" / "ops" / helper.name, helper)

    def git(*args, cwd=source):
        return subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True, text=True).stdout.strip()

    git("init", "-q", "-b", "main")
    git("config", "user.name", "Version Test")
    git("config", "user.email", "version-test@example.invalid")
    git("config", "commit.gpgsign", "false")
    git("config", "core.hooksPath", "/dev/null")
    git("add", ".")
    git("commit", "-qm", "test: pending release")
    deployed_sha = git("rev-parse", "HEAD")
    git("init", "--bare", "-q", str(remote), cwd=tmp_path)
    git("remote", "add", "origin", str(remote))
    git("push", "-q", "origin", "HEAD:main")
    git("clone", "-q", "--branch", "main", str(remote), str(runner), cwd=tmp_path)
    git("config", "commit.gpgsign", "false", cwd=runner)
    git("config", "core.hooksPath", "/dev/null", cwd=runner)

    workflow = (PROJECT_ROOT / ".github" / "workflows" / "deploy-production.yml").read_text(encoding="utf-8")
    step = workflow.split("      - name: Record confirmed publication\n", 1)[1]
    commands = textwrap.dedent(step.split("        run: |\n", 1)[1].split("\n      - name:", 1)[0])
    env = {**os.environ, "APP_VERSION": "2.3.4", "RELEASE_PUBLISHED_AT": "2026-11-21T12:34:56+08:00"}
    for _ in range(2):
        git("checkout", "--detach", deployed_sha, cwd=runner)
        result = subprocess.run(["bash", "-c", commands], cwd=runner, env=env, capture_output=True, text=True)
        assert result.returncode == 0, result.stdout + result.stderr

    history = git("--git-dir", str(remote), "show", "main:docs/版本管理.md", cwd=tmp_path)
    assert "**发布日期：** 2026-11-21" in history
    assert "**发布时间：** 12:34:56（北京时间）" in history
    assert "**发布状态：** 已发布" in history
    assert "原有说明" in history
    assert git("--git-dir", str(remote), "rev-list", "--count", "main", cwd=tmp_path) == "2"


def test_env_file_is_project_root_dotenv():
    """本地开发与联调指南 §1：必须读根目录 .env，而不是 backend/.env。"""
    path = locate_env_file()
    assert path is not None, "根目录缺少 .env，请从 .env.example 复制后替换 JWT 密钥"
    assert path.parent == PROJECT_ROOT
    assert path.name == ".env"


def test_settings_loads_from_root_env():
    settings = get_settings()
    assert settings.env_file_path is not None
    assert settings.env_file_path.parent == PROJECT_ROOT
    assert settings.api_prefix == "/api"
    assert settings.access_token_expire_minutes >= 1


def test_default_database_is_postgres(monkeypatch):
    """SQLite 已彻底下线：缺 .env 时的兜底地址也必须是 PG。

    以前兜底是某个本地文件库地址——连不上库时会静默新建一个本地文件，
    数据写进没人知道的地方。现在宁可连不上明确报错。
    """
    # CI 会显式注入 DATABASE_URL / TEST_DATABASE_URL 指向测试库；
    # 本用例测的是「配置缺省值」，先屏蔽环境变量才能取到真正的兜底地址。
    monkeypatch.delenv("DATABASE_URL", raising=False)
    monkeypatch.delenv("TEST_DATABASE_URL", raising=False)
    settings = Settings(_env_file=None)
    assert settings.database_url.startswith("postgresql")
    assert settings.database_url.endswith("/heijin_erp_dev")


def test_alembic_url_equals_database_url():
    """PG 下不需要再拼绝对路径，engine 与 alembic 共用同一串。"""
    settings = Settings(database_url="postgresql+psycopg://u:p@127.0.0.1:5432/x")
    assert settings.alembic_url == settings.database_url


def test_sqlite_is_no_longer_supported():
    """残留的 SQLite 配置不再有专属处理路径：没有 sqlite_file / sqlalchemy_url。"""
    settings = Settings(database_url="sqlite:///./data/probe.db", _env_file=None)
    assert not hasattr(settings, "sqlite_file")
    assert not hasattr(settings, "sqlalchemy_url")


def test_describe_does_not_leak_secret():
    payload = get_settings().describe()
    assert isinstance(payload, dict)
    for key, value in payload.items():
        assert "secret" not in key.lower()
        assert isinstance(value, str)


def test_describe_redacts_database_password():
    """连接串里的口令绝不能出现在健康检查/日志里（describe 会被原样输出）。"""
    settings = Settings(
        database_url="postgresql+psycopg://erp_app:s3cr3t@db.internal:5432/heijin_erp"
    )
    payload = settings.describe()
    assert payload["database"] == "postgresql://db.internal:5432/heijin_erp"
    assert "s3cr3t" not in str(payload)


# --- CORS：dev 端口通配 ---------------------------------------------------
# 背景（实测事故）：前端换到 5199 端口后，CORS 预检返回 400，
# axios 全部 Failed to fetch，但页面**不报错**，只静默显示
# 「资金账户数量 0 / 尚未配置资金账户」，与「真的没有数据」无法区分。


def test_dev_allows_any_local_port():
    """development 下必须放行本机任意端口，避免换端口即静默失败。"""
    settings = Settings(app_env="development")
    assert settings.cors_origin_regex is not None
    assert "localhost" in settings.cors_origin_regex
    assert "127" in settings.cors_origin_regex


def test_dev_cors_middleware_accepts_frontend_port():
    settings = Settings(
        app_env="development",
        database_url="postgresql+psycopg://erp_app@127.0.0.1:5432/heijin_erp_test",
    )
    response = TestClient(create_app(settings)).options(
        "/api/orders",
        headers={
            "Origin": "http://127.0.0.1:5188",
            "Access-Control-Request-Method": "GET",
        },
    )
    assert response.status_code == 200
    assert response.headers["access-control-allow-origin"] == "http://127.0.0.1:5188"


def test_production_never_widens_cors():
    """生产环境必须收紧：端口通配一律失效，且不得回落成 *。"""
    for env in ("production", "staging", "prod"):
        settings = Settings(app_env=env, jwt_secret_key=SECURE_TEST_SECRET)
        assert settings.cors_origin_regex is None, f"{env} 不应放宽 CORS"
        assert "*" not in settings.cors_origin_list


def test_production_rejects_default_jwt_secret():
    with pytest.raises(ValidationError) as exc:
        Settings(
            app_env="production",
            jwt_secret_key="dev-insecure-secret-not-for-production-use!!",
        )
    assert "JWT" in str(exc.value)


def test_production_rejects_wildcard_cors():
    with pytest.raises(ValidationError) as exc:
        Settings(
            app_env="production",
            jwt_secret_key=SECURE_TEST_SECRET,
            cors_origins="*",
        )
    assert "CORS" in str(exc.value)


def test_cors_origin_list_still_parses_env():
    """显式白名单仍走环境变量，不因通配而失效。"""
    settings = Settings(cors_origins="http://a.test, http://b.test ,")
    assert settings.cors_origin_list == ["http://a.test", "http://b.test"]


def test_dev_wildcard_can_be_disabled():
    """显式关闭开关后立即收紧，便于生产或收紧策略。"""
    settings = Settings(app_env="development", cors_dev_allow_any_local_port=False)
    assert settings.cors_origin_regex is None


class TestLoginRateLimitKnob:
    """登录限流次数：负值必须炸，否则窗口计数永远打不满、限流形同关闭。"""

    def test_default_is_positive(self):
        assert Settings().login_rate_limit_per_minute >= 1

    def test_negative_is_rejected(self):
        with pytest.raises(ValidationError):
            Settings(login_rate_limit_per_minute=-1)



class TestTestDatabaseSeparation:
    """测试库必须与开发库分开配置：曾因回落 DATABASE_URL 把开发库 118 单清空。"""

    def test_test_database_url_defaults_to_empty(self, monkeypatch):
        """缺省为空表示「未单独配置」，夹具据此拒绝运行，不猜一个库去清空。"""
        # 必须显式屏蔽 .env 与 CI 注入的环境变量：本机 .env 已配了 TEST_DATABASE_URL，
        # CI 也会注入 DATABASE_URL / TEST_DATABASE_URL，否则测的是环境而非缺省值。
        monkeypatch.delenv("DATABASE_URL", raising=False)
        monkeypatch.delenv("TEST_DATABASE_URL", raising=False)
        assert Settings(_env_file=None).test_database_url == ""

    def test_test_database_url_is_independent_of_database_url(self):
        settings = Settings(
            database_url="postgresql+psycopg://u:p@127.0.0.1:5432/heijin_erp_dev",
            test_database_url="postgresql+psycopg://u:p@127.0.0.1:5432/heijin_erp_test",
        )
        assert settings.test_database_url.endswith("/heijin_erp_test")
        assert settings.database_url.endswith("/heijin_erp_dev")

    def test_env_file_value_is_loaded(self, monkeypatch, tmp_path):
        """`.env` 里的 TEST_DATABASE_URL 必须真的被读进来，而不是只认环境变量。"""
        env_file = tmp_path / ".env"
        env_file.write_text(
            "DATABASE_URL=postgresql+psycopg://u:p@127.0.0.1:5432/heijin_erp_dev\n"
            "TEST_DATABASE_URL=postgresql+psycopg://u:p@127.0.0.1:5432/heijin_erp_test\n",
            encoding="utf-8",
        )
        monkeypatch.delenv("TEST_DATABASE_URL", raising=False)
        # CI 注入的 DATABASE_URL 优先级高于 env_file，不屏蔽就测不到「.env 被读进来」。
        monkeypatch.delenv("DATABASE_URL", raising=False)
        settings = Settings(_env_file=env_file)
        assert settings.test_database_url.endswith("/heijin_erp_test")
        assert settings.database_url.endswith("/heijin_erp_dev")
