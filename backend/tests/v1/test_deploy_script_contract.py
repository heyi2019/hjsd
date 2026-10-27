"""发布脚本的首次部署与健康检查退出码守卫。"""
from __future__ import annotations

import os
import shutil
import stat
import subprocess
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[3]
SOURCE_SCRIPT = PROJECT_ROOT / "deploy" / "scripts" / "deploy.sh"


def _release_tree(
    tmp_path: Path, *, curl_exit: int = 0, backup_exit: int = 99, admin_password: str | None = None
) -> tuple[Path, Path]:
    """创建隔离发布目录；仅替换 Docker 与 curl 这两个外部边界。"""
    deploy_dir = tmp_path / "deploy"
    script_dir = deploy_dir / "scripts"
    script_dir.mkdir(parents=True)
    script = script_dir / "deploy.sh"
    shutil.copy2(SOURCE_SCRIPT, script)
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
        "set -euo pipefail\n"
        "if [[ \"$*\" == *\"test -f /app/data/heijin_erp_v1.db\"* ]]; then exit 1; fi\n"
        f"if [[ \" $* \" == *\" run \"* && \"$*\" == *backup_db.py* ]]; then exit {backup_exit}; fi\n"
        "exit 0\n",
        encoding="utf-8",
    )
    curl = fake_bin / "curl"
    curl.write_text(f"#!/usr/bin/env bash\nexit {curl_exit}\n", encoding="utf-8")
    docker.chmod(0o755)
    curl.chmod(0o755)
    return script, fake_bin


def _run(script: Path, fake_bin: Path) -> subprocess.CompletedProcess[str]:
    env = {**os.environ, "PATH": f"{fake_bin}{os.pathsep}{os.environ['PATH']}"}
    return subprocess.run([str(script)], text=True, capture_output=True, env=env, check=False)


def test_first_deployment_skips_backup_when_database_does_not_exist(tmp_path):
    """空数据卷首次发布不应因“备份不存在的库”而退出。"""
    script, fake_bin = _release_tree(tmp_path)

    result = _run(script, fake_bin)

    assert result.returncode == 0, result.stdout + result.stderr


def test_deploy_exits_nonzero_when_post_start_health_check_fails(tmp_path):
    """服务健康检查失败必须阻止脚本报告发布成功。"""
    script, fake_bin = _release_tree(tmp_path, curl_exit=1, backup_exit=0)

    result = _run(script, fake_bin)

    assert result.returncode != 0


def test_deploy_uses_admin_password_from_deploy_env_file(tmp_path):
    """管理员密码写入部署环境文件后，首次发布必须实际执行初始化。"""
    script, fake_bin = _release_tree(tmp_path, backup_exit=0, admin_password="admin123456")

    result = _run(script, fake_bin)

    assert result.returncode == 0, result.stdout + result.stderr
    assert "未设置 ADMIN_PASSWORD" not in result.stdout
