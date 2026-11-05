"""DEPLOY-01 发布脚本的首次部署与健康检查退出码守卫。"""
from __future__ import annotations

import os
import shutil
import stat
import subprocess
from pathlib import Path
import _repo  # 仓库根解析：向上找 pytest.ini，避免写死 parents[N]


PROJECT_ROOT = _repo.REPO_ROOT
SOURCE_SCRIPT = PROJECT_ROOT / "deploy" / "scripts" / "deploy.sh"
COMPOSE_FILE = PROJECT_ROOT / "deploy" / "docker-compose.yml"


def _release_tree(
    tmp_path: Path, *, curl_exit: int = 0, dump_exit: int = 0, admin_password: str | None = None
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
    docker.write_text(
        "#!/usr/bin/env bash\n"
        "set -uo pipefail\n"
        'args="$*"\n'
        'case "$args" in\n'
        '  *"ps --status running --services"*) printf "db\\nbackend\\n"; exit 0 ;;\n'
        '  *"ps -q"*) printf "fakecid0123456789\\n"; exit 0 ;;\n'
        # deploy.sh 的发布前后库状态自检需要 7 列状态与 3 列售出作用域计数；
        # 其余 psql（backup_daily.sh 的表数探测）沿用原来的单列返回。
        "  *information_schema.tables*) printf '41|NONE|0|63|13|220|0001\\n'; exit 0 ;;\n"
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


def test_deploy_uses_admin_password_from_deploy_env_file(tmp_path):
    """管理员密码写入部署环境文件后，首次发布必须实际执行初始化。"""
    script, fake_bin = _release_tree(tmp_path, admin_password="admin123456")

    result = _run(script, fake_bin)

    assert result.returncode == 0, result.stdout + result.stderr
    assert "未设置 ADMIN_PASSWORD" not in result.stdout


def test_explicit_app_version_overrides_deploy_env_file(tmp_path):
    """CI 传入的发布版本必须优先于 ECS .env 中遗留的旧版本。"""
    script, fake_bin = _release_tree(tmp_path)
    script.parent.parent.joinpath(".env").write_text(
        "APP_ENV=production\nAPP_VERSION=1.0.0\n", encoding="utf-8"
    )

    result = _run(script, fake_bin, extra_env={"APP_VERSION": "1.0.1"})

    assert result.returncode == 0, result.stdout + result.stderr
    assert "发布版本 V1.0.1" in result.stdout


def test_backend_runtime_receives_explicit_release_version():
    """运行中的 API 健康信息必须与导入镜像的发布版本一致。"""
    compose = COMPOSE_FILE.read_text(encoding="utf-8")
    assert "APP_VERSION: ${APP_VERSION:-latest}" in compose
