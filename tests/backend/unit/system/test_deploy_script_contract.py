"""DEPLOY-01 发布脚本的首次部署与健康检查退出码守卫。"""
from __future__ import annotations

import os
import shutil
import stat
import subprocess
from pathlib import Path
import _repo  # 仓库根解析：向上找 pytest.ini，避免写死 parents[N]
import pytest


PROJECT_ROOT = _repo.REPO_ROOT
SOURCE_SCRIPT = PROJECT_ROOT / "deploy" / "scripts" / "deploy.sh"
COMPOSE_FILE = PROJECT_ROOT / "deploy" / "docker-compose.yml"


def test_frontend_full_cloud_gate_includes_isolated_browser_tests():
    workflow = (PROJECT_ROOT / ".github" / "workflows" / "frontend-gate.yml").read_text(encoding="utf-8")
    assert "  browser-e2e:" in workflow
    job = workflow.split("  browser-e2e:", 1)[1]
    assert "inputs.full_suite" in job and "inputs.release_sha" in job
    assert "github.event_name == 'workflow_dispatch'" in job
    assert "heijin_erp_e2e" in job and "E2E_DATABASE_URL:" in job
    assert "npx playwright install --with-deps chromium" in job
    assert "npm run test:e2e" in job
    assert "E2E_RESET" not in job


def _release_tree(
    tmp_path: Path,
    *,
    curl_exit: int = 0,
    dump_exit: int = 0,
    admin_password: str | None = None,
    partial_schema: bool = False,
    empty_users: bool = False,
) -> tuple[Path, Path]:
    """创建隔离发布目录；仅替换 Docker 与 curl 这两个外部边界。"""
    deploy_dir = tmp_path / "deploy"
    script_dir = deploy_dir / "scripts"
    script_dir.mkdir(parents=True)
    script = script_dir / "deploy.sh"
    # deploy.sh 迁移前会调用同目录的 backup_daily.sh，整目录拷入才接近真实部署树。
    for source in SOURCE_SCRIPT.parent.glob("*.sh"):
        target = script_dir / source.name
        shutil.copy2(source, target)
    script.chmod(script.stat().st_mode | stat.S_IXUSR)
    env_text = "APP_ENV=production\n"
    if admin_password is not None:
        env_text += f"ADMIN_PASSWORD={admin_password}\n"
    (deploy_dir / ".env").write_text(env_text, encoding="utf-8")

    fake_bin = tmp_path / "bin"
    fake_bin.mkdir()
    docker = fake_bin / "docker"
    schema_probe = "2|alembic_version|NONE|NONE" if partial_schema else "41|alembic_version|users|policy_definitions"
    docker.write_text(
        "#!/usr/bin/env bash\n"
        "set -uo pipefail\n"
        'if [ -n "${FAKE_DOCKER_ARGUMENTS:-}" ]; then printf "%s\\n" "$@" >> "$FAKE_DOCKER_ARGUMENTS"; fi\n'
        'args="$*"\n'
        'case "$args" in\n'
        '  *"ps --status running --services"*) printf "db\\nbackend\\n"; exit 0 ;;\n'
        '  *"ps -q"*) printf "fakecid0123456789\\n"; exit 0 ;;\n'
        f'  *"public.users"*) printf "{schema_probe}\\n"; exit 0 ;;\n'
        '  *"to_regclass"*"public.policy_definitions"*) printf "NONE\\n"; exit 0 ;;\n'
        # schema_probe 需要 4 列；db_snapshot 单独查询旧策略表后读取 7 列状态。
        + (
            '  *"from option_sets"*) if [ -f "$FAKE_ADMIN_FILE" ]; then '
            'printf "41|NONE|63|13|220|1|0001\\n"; else '
            'printf "41|NONE|63|13|220|0|0001\\n"; fi; exit 0 ;;\n'
            '  *"create_admin.py"*) touch "$FAKE_ADMIN_FILE"; exit 0 ;;\n'
            if empty_users else
            '  *"from option_sets"*) printf "41|NONE|63|13|220|1|0001\\n"; exit 0 ;;\n'
        )
        +
        '  *"create_admin.py"*) if [ -n "${FAKE_ADMIN_FILE:-}" ]; then touch "$FAKE_ADMIN_FILE"; fi; exit 0 ;;\n'
        "  *SALEREC*) printf '28|28|21\\n'; exit 0 ;;\n"
        "  *psql*)\n"
        "    printf '1\\n'\n"
        "    exit 0 ;;\n"
        "  *pg_dump*)\n"
        f"    [[ {dump_exit} -ne 0 ]] && exit {dump_exit}\n"
        "    printf 'PGDMP fake pg_dump archive body\\n'\n"
        "    exit 0 ;;\n"
        '  *"pg_restore --list"*) printf "1; 0 0 TABLE public orders erp_app\\n2; 0 0 TABLE DATA public orders erp_app\\n"; exit 0 ;;\n'
        "esac\n"
        "exit 0\n",
        encoding="utf-8",
    )
    curl = fake_bin / "curl"
    curl.write_text(f"#!/usr/bin/env bash\nexit {curl_exit}\n", encoding="utf-8")
    # deploy.sh 的后端健康检查是 `for attempt in {1..30}; do curl ...; sleep 2; done`：
    # 失败路径要真等满 60 秒，单个用例就占全量 184.8s 的 33%（实测 61.42s）。
    # 契约测的是退出码与输出文案，不测真实等待时长，故把 sleep 短路。
    # 仍放在 fake_bin 而不是改 deploy.sh：生产脚本必须保留真实的等待语义。
    sleep = fake_bin / "sleep"
    sleep.write_text("#!/usr/bin/env bash\nexit 0\n", encoding="utf-8")
    docker.chmod(0o755)
    curl.chmod(0o755)
    sleep.chmod(0o755)
    return script, fake_bin


def _run(
    script: Path, fake_bin: Path, *, extra_env: dict[str, str] | None = None
) -> subprocess.CompletedProcess[str]:
    env = {
        **os.environ,
        **(extra_env or {}),
        "PATH": f"{fake_bin}{os.pathsep}{os.environ['PATH']}",
    }
    return subprocess.run(
        [str(script)], encoding="utf-8", errors="replace", capture_output=True, env=env, check=False
    )


def test_first_deployment_backs_up_empty_database_then_deploys(tmp_path):
    """首次发布：空库也必须先备份再迁移，且备份成功不阻断发布。"""
    script, fake_bin = _release_tree(tmp_path)

    result = _run(script, fake_bin)

    assert result.returncode == 0, result.stdout + result.stderr
    assert "BACKUP_OK" in result.stdout, "迁移前应产出一次 pg_dump 备份"


def test_partial_schema_rebuilds_from_active_migration_chain(tmp_path):
    """只剩 Alembic 元表的半初始化库必须恢复到完整 0001 结构。"""
    script, fake_bin = _release_tree(tmp_path, partial_schema=True)

    result = _run(script, fake_bin)

    assert result.returncode == 0, result.stdout + result.stderr
    assert "半初始化数据库" in result.stdout


def test_deploy_aborts_when_pre_migration_backup_fails(tmp_path):
    """备份失败必须中止发布：没有可信快照就改结构是最高危的操作。"""
    script, fake_bin = _release_tree(tmp_path, dump_exit=1)

    result = _run(script, fake_bin)

    assert result.returncode != 0
    assert "迁移前备份失败" in result.stdout + result.stderr


def test_deploy_exits_nonzero_when_post_start_health_check_fails(tmp_path):
    """服务健康检查失败必须阻止脚本报告发布成功。"""
    script, fake_bin = _release_tree(tmp_path, curl_exit=1)

    result = _run(script, fake_bin)

    assert result.returncode != 0


def test_empty_database_deployment_can_create_first_administrator(tmp_path):
    """空库创建第一个管理员后，发布不能错误地判定用户数不变量失败。"""
    script, fake_bin = _release_tree(tmp_path, admin_password="admin123456", empty_users=True)
    marker = tmp_path / "admin-created"

    result = _run(script, fake_bin, extra_env={"FAKE_ADMIN_FILE": str(marker)})

    assert result.returncode == 0, result.stdout + result.stderr
    assert marker.is_file()


def test_admin_password_is_not_exposed_in_docker_command_arguments(tmp_path):
    """创建管理员时密码随环境传入，不暴露在 Docker 命令参数中。"""
    password = "test-initial-password"
    script, fake_bin = _release_tree(tmp_path, admin_password=password, empty_users=True)
    marker = tmp_path / "admin-created"
    arguments = tmp_path / "docker-arguments"

    result = _run(script, fake_bin, extra_env={"FAKE_ADMIN_FILE": str(marker), "FAKE_DOCKER_ARGUMENTS": str(arguments)})

    assert result.returncode == 0, result.stdout + result.stderr
    assert marker.is_file()
    assert password not in arguments.read_text(encoding="utf-8")


def test_existing_users_do_not_have_their_admin_password_reset_on_deploy(tmp_path):
    """发布不应把已有管理员密码重置为服务器上的初始密码。"""
    script, fake_bin = _release_tree(tmp_path, admin_password="test-initial-password")
    marker = tmp_path / "admin-reset"

    result = _run(script, fake_bin, extra_env={"FAKE_ADMIN_FILE": str(marker)})

    assert result.returncode == 0, result.stdout + result.stderr
    assert not marker.exists()


def test_deploy_accepts_current_schema_without_legacy_policy_table(tmp_path):
    """当前 0001 不含旧策略表，部署不应查询不存在的表而失败。"""
    script, fake_bin = _release_tree(tmp_path)
    docker = fake_bin / "docker"
    contents = docker.read_text(encoding="utf-8")
    contents = contents.replace(
        'case "$args" in\n',
        'case "$args" in\n  *"from policy_definitions"*) echo "relation does not exist" >&2; exit 1 ;;\n',
        1,
    )
    docker.write_text(contents, encoding="utf-8")

    result = _run(script, fake_bin)

    assert result.returncode == 0, result.stdout + result.stderr


def _reset_tree(tmp_path, *, dump_exit=0, admin_password="test-admin-secret"):
    """模拟云端 Docker 边界，真实执行备份及数据库重建脚本。"""
    deploy_script, fake_bin = _release_tree(tmp_path, dump_exit=dump_exit, admin_password=admin_password)
    docker = fake_bin / "docker"
    contents = docker.read_text(encoding="utf-8")
    contents = contents.replace(
        'case "$args" in\n',
        'case "$args" in\n'
        '  *"down -v"*) rm -f "$FAKE_ATTACHMENT"; exit 0 ;;\n'
        '  *"dropdb"*) '
        'find "$FAKE_BACKUP_ROOT" -name "*.dump" | grep -q . || exit 41; '
        'rm -f "$FAKE_BUSINESS_DATA"; exit 0 ;;\n',
        1,
    )
    docker.write_text(contents, encoding="utf-8")
    business_data = tmp_path / "business-data"
    attachment = tmp_path / "attachment"
    business_data.write_text("old order", encoding="utf-8")
    attachment.write_text("keep attachment", encoding="utf-8")
    env = {
        **os.environ,
        "PATH": f"{fake_bin}{os.pathsep}{os.environ['PATH']}",
        "APP_VERSION": "1.0.0",
        "RESET_DATABASE": "true",
        "FAKE_BACKUP_ROOT": str(tmp_path / "backups"),
        "FAKE_BUSINESS_DATA": str(business_data),
        "FAKE_ATTACHMENT": str(attachment),
    }
    env.pop("ADMIN_PASSWORD", None)
    return deploy_script.parent / "reset_database.sh", env, business_data, attachment


def test_database_reset_backs_up_before_clearing_and_keeps_other_volumes(tmp_path):
    """重建前先生成备份，只替换数据库；重复执行不能再清库。"""
    script, env, business_data, attachment = _reset_tree(tmp_path)
    run = lambda: subprocess.run(["bash", str(script)], env=env, capture_output=True, text=True)

    result = run()

    assert result.returncode == 0, result.stdout + result.stderr
    assert not business_data.exists()
    assert attachment.read_text(encoding="utf-8") == "keep attachment"
    assert len(list((tmp_path / "backups").rglob("*.dump"))) == 1
    business_data.write_text("new order", encoding="utf-8")
    second = run()
    assert second.returncode != 0
    assert business_data.read_text(encoding="utf-8") == "new order"


def test_database_reset_does_not_clear_when_backup_fails(tmp_path):
    script, env, business_data, attachment = _reset_tree(tmp_path, dump_exit=1)

    result = subprocess.run(["bash", str(script)], env=env, capture_output=True, text=True)

    assert result.returncode != 0
    assert "备份失败" in result.stdout + result.stderr
    assert business_data.read_text(encoding="utf-8") == "old order"
    assert attachment.read_text(encoding="utf-8") == "keep attachment"


def test_database_reset_requires_admin_before_clearing(tmp_path):
    script, env, business_data, attachment = _reset_tree(tmp_path, admin_password=None)

    result = subprocess.run(["bash", str(script)], env=env, capture_output=True, text=True)

    assert result.returncode != 0
    assert "ADMIN_PASSWORD" in result.stdout + result.stderr
    assert business_data.read_text(encoding="utf-8") == "old order"
    assert attachment.read_text(encoding="utf-8") == "keep attachment"
    assert not list((tmp_path / "backups").rglob("*.dump"))


def test_database_reset_is_not_available_to_other_versions(tmp_path):
    script, env, business_data, attachment = _reset_tree(tmp_path)
    env["APP_VERSION"] = "1.0.1"

    result = subprocess.run(["bash", str(script)], env=env, capture_output=True, text=True)

    assert result.returncode != 0
    assert business_data.read_text(encoding="utf-8") == "old order"
    assert attachment.read_text(encoding="utf-8") == "keep attachment"
    assert not list((tmp_path / "backups").rglob("*.dump"))


def test_only_explicit_v1_release_request_enables_database_reset(tmp_path):
    """普通发布不清库；只有指定版本和明确的重建标记才选择重建。"""
    import sys

    scripts = tmp_path / "scripts" / "ops"
    scripts.mkdir(parents=True)
    helper = scripts / "release_reset_requested.py"
    source = PROJECT_ROOT / "scripts" / "ops" / helper.name
    if source.exists():
        shutil.copy2(source, helper)

    def git(*args):
        return subprocess.run(["git", *args], cwd=tmp_path, check=True, capture_output=True, text=True).stdout.strip()

    git("init", "-q")
    git("config", "user.name", "Version Test")
    git("config", "user.email", "version-test@example.invalid")
    git("config", "commit.gpgsign", "false")
    git("config", "core.hooksPath", "/dev/null")
    git("commit", "--allow-empty", "-qm", "test: baseline")
    base = git("rev-parse", "HEAD")
    git("commit", "--allow-empty", "-qm", "release: v1.0.0", "-m", "Reset-Production-Database: empty")
    run = lambda base_sha, version: subprocess.run(
        [sys.executable, str(helper), base_sha, "HEAD", version], cwd=tmp_path, capture_output=True, text=True,
    )

    selected = run(base, "1.0.0")
    assert selected.returncode == 0, selected.stderr
    assert selected.stdout.strip() == "true"
    wrong_version = run(base, "1.0.1")
    assert wrong_version.returncode != 0
    assert not wrong_version.stdout.strip()
    current = git("rev-parse", "HEAD")
    git("commit", "--allow-empty", "-qm", "fix: ordinary release")
    ordinary = run(current, "1.0.1")
    assert ordinary.returncode == 0, ordinary.stderr
    assert ordinary.stdout.strip() == "false"
    missing_v1_marker = run(current, "1.0.0")
    assert missing_v1_marker.returncode != 0
    assert not missing_v1_marker.stdout.strip()
    current = git("rev-parse", "HEAD")
    git("commit", "--allow-empty", "-qm", "release: invalid", "-m", "Reset-Production-Database: unexpected")
    invalid = run(current, "1.0.0")
    assert invalid.returncode != 0
    assert not invalid.stdout.strip()


@pytest.mark.parametrize(
    ("version", "reset_marker", "expected"),
    [("1.0.0", "\nReset-Production-Database: empty", "true"), ("1.0.1", "", "false")],
)
def test_release_workflow_outputs_the_requested_database_mode(tmp_path, version, reset_marker, expected):
    """隔离 Git 仓库中，V1 重建走全量门禁，普通发布按变更选测。"""
    import re
    import textwrap

    repo = tmp_path / "repo"
    remote = tmp_path / "remote.git"
    fake_bin = tmp_path / "bin"
    repo.mkdir()
    fake_bin.mkdir()
    scripts = repo / "scripts" / "ops"
    scripts.mkdir(parents=True)
    for name in ("auto_release.sh", "bump_version.sh", "release_reset_requested.py", "ci_test_scope.py"):
        source = PROJECT_ROOT / "scripts" / "ops" / name
        if source.exists():
            shutil.copy2(source, scripts / name)
    (repo / "VERSION").write_text(f"{version}\n", encoding="utf-8")
    notes = repo / "docs" / "版本管理.md"
    notes.parent.mkdir()
    notes.write_text(
        f"# 版本管理\n\n## 版本发布记录\n\n### V{version}\n"
        "**发布日期：** 待发布\n**发布时间：** 待发布\n**发布状态：** 待发布\n"
        "#### 本次更新内容\n- 初始版本\n", encoding="utf-8",
    )

    def git(*args, cwd=repo):
        return subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True, text=True).stdout.strip()

    git("init", "-q", "-b", "main")
    git("config", "user.name", "Version Test")
    git("config", "user.email", "version-test@example.invalid")
    git("config", "commit.gpgsign", "false")
    git("config", "core.hooksPath", "/dev/null")
    git("add", ".")
    git("commit", "-qm", "test: baseline")
    base = git("rev-parse", "HEAD")
    git("init", "--bare", "-q", str(remote), cwd=tmp_path)
    git("remote", "add", "origin", str(remote))
    git("push", "-q", "origin", "HEAD:main")
    changed = repo / "backend" / "app" / "business" / "orders" / "sample.py"
    changed.parent.mkdir(parents=True)
    changed.write_text("example = True\n", encoding="utf-8")
    git("add", str(changed.relative_to(repo)))
    git("commit", "-qm", f"release: v{version}", "-m",
        f"Release-Version: {version}{reset_marker}")
    head = git("rev-parse", "HEAD")
    fake_gh = fake_bin / "gh"
    fake_gh.write_text("#!/usr/bin/env bash\nexit 90\n", encoding="utf-8")
    fake_gh.chmod(0o755)
    workflow = (PROJECT_ROOT / ".github" / "workflows" / "main-ci-cd.yml").read_text(encoding="utf-8")
    step = workflow.split("      - name: Bump version and summarize changes\n", 1)[1]
    commands = textwrap.dedent(re.split(r"\n  [a-zA-Z][a-zA-Z0-9_-]*:\s*\n", step.split("        run: |\n", 1)[1], maxsplit=1)[0])
    env = {
        **os.environ, "PATH": f"{fake_bin}{os.pathsep}{os.environ['PATH']}",
        "BASE_SHA": base, "HEAD_SHA": head, "RUNNER_TEMP": str(tmp_path),
        "GITHUB_STEP_SUMMARY": str(tmp_path / "summary"), "GITHUB_OUTPUT": str(tmp_path / "output"),
        "REPO": "local/test",
    }

    result = subprocess.run(["bash", "-c", commands], cwd=repo, env=env, capture_output=True, text=True)

    assert result.returncode == 0, result.stdout + result.stderr
    outputs = dict(line.split("=", 1) for line in (tmp_path / "output").read_text(encoding="utf-8").splitlines())
    assert outputs["sha"] == git("rev-parse", "HEAD")
    assert outputs["reset_database"] == expected
    assert outputs["full_suite"] == expected
    if expected == "false":
        assert outputs["changed_paths"] == "backend/app/business/orders/sample.py"


def test_explicit_app_version_overrides_deploy_env_file(tmp_path):
    """CI 传入的发布版本必须优先于 ECS .env 中遗留的旧版本。"""
    script, fake_bin = _release_tree(tmp_path)
    script.parent.parent.joinpath(".env").write_text(
        "APP_ENV=production\nAPP_VERSION=1.0.0\n", encoding="utf-8"
    )

    result = _run(script, fake_bin, extra_env={"APP_VERSION": "1.0.1"})

    assert result.returncode == 0, result.stdout + result.stderr
    assert "发布版本 V1.0.1" in result.stdout


def test_deploy_reads_project_version_when_not_overridden(tmp_path):
    """部署包的 VERSION 决定镜像使用的项目版本。"""
    script, fake_bin = _release_tree(tmp_path)
    (tmp_path / "VERSION").write_text("2.3.4\n", encoding="utf-8")

    result = _run(script, fake_bin)

    assert result.returncode == 0, result.stdout + result.stderr
    assert "发布版本 V2.3.4" in result.stdout


def test_backend_runtime_receives_explicit_release_version():
    """运行中的 API 健康信息必须与导入镜像的发布版本一致。"""
    compose = COMPOSE_FILE.read_text(encoding="utf-8")
    assert "APP_VERSION: ${APP_VERSION:-latest}" in compose


def test_offline_deploy_refuses_missing_rate_limit_image(tmp_path):
    script, fake_bin = _release_tree(tmp_path)
    docker = fake_bin / "docker"
    source = docker.read_text(encoding="utf-8")
    source = source.replace('case "$args" in\n', 'case "$args" in\n  *"image inspect redis:7.4-alpine"*) exit 1 ;;\n  *"image inspect"*"--format"*) printf "amd64\\n"; exit 0 ;;\n', 1)
    docker.write_text(source, encoding="utf-8")
    result = _run(script, fake_bin, extra_env={"ERP_SKIP_BUILD": "1", "APP_VERSION": "1.0.1"})
    assert result.returncode != 0
    assert "redis:7.4-alpine" in result.stdout + result.stderr
