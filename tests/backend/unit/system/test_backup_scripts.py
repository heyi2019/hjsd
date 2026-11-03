"""BACKUP-01 备份/恢复脚本契约（PostgreSQL 时代）。

背景：正式库切 PG 后，原 SQLite 备份链（`backup_db.py` / `restore_db.py` /
`heijin_erp_v1_*.db`）已整体下线。SQLite 版脚本在 PG 下有两种坏结局——每日
FATAL exit 1（cron 报警但没备份），或「成功」备份一份早已过期的 SQLite 文件
（比没备份更危险）。本文件把新链路的契约锁死：

1. 脚本层不得再出现 SQLite 备份入口；
2. `backup_daily.sh` 在 db 容器内跑 `pg_dump -Fc`，产物 = `.dump` + `.sha256`，
   并按 `ERP_BACKUP_KEEP` 滚动，失败必须非零退出且不留半成品；
3. `restore_pg.sh` 默认拒绝执行、校验和不符必须拒收、恢复必须单事务
   （失败不留半套表）。

外部边界（docker / pg_dump / pg_restore）全部用假 docker 桩替换，不依赖真实
PostgreSQL 与 docker，可在 CI 与本地秒级跑完。
"""
from __future__ import annotations

import os
import shutil
import stat
import subprocess
from pathlib import Path
import _repo  # 仓库根解析：向上找 pytest.ini，避免写死 parents[N]

PROJECT_ROOT = _repo.REPO_ROOT
DEPLOY_SCRIPTS = PROJECT_ROOT / "deploy" / "scripts"
BACKEND_SCRIPTS = PROJECT_ROOT / "backend" / "scripts"

def _fake_toc(toc_tables: int) -> str:
    """生成与真实 pg_dump 一致的 TOC 片段：每张表一条 TABLE + 一条 TABLE DATA。"""
    lines = ["; Archive created at 2026-11-02 03:20:00"]
    seq = 1
    for i in range(toc_tables):
        lines.append(f"{seq}; 0 0 TABLE public tbl{i} erp_app")
        seq += 1
    for i in range(toc_tables):
        lines.append(f"{seq}; 0 0 TABLE DATA public tbl{i} erp_app")
        seq += 1
    lines.append(f"{seq}; 0 0 SEQUENCE public tbl0_id_seq erp_app")
    return "\n".join(lines)


def _fake_docker(
    tmp_path: Path,
    *,
    dump_exit: int = 0,
    restore_exit: int = 0,
    psql_tables: int = 1,
    toc_tables: int | None = None,
) -> Path:
    """桩掉 docker：只模拟本链路真正用到的几类调用。

    psql_tables 与 toc_tables 分开可控，用来构造「源库表数 ≠ 归档表数」的截断场景。
    """
    toc = _fake_toc(psql_tables if toc_tables is None else toc_tables)
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir(exist_ok=True)
    docker = bin_dir / "docker"
    docker.write_text(
        "#!/usr/bin/env bash\n"
        "set -uo pipefail\n"
        'args="$*"\n'
        'case "$args" in\n'
        '  *"ps --status running --services"*) printf "db\\nbackend\\n"; exit 0 ;;\n'
        '  *"ps -q"*) printf "fakecid0123456789\\n"; exit 0 ;;\n'
        "  *psql*)\n"
        f"    printf '{psql_tables}\\n'\n"
        "    exit 0 ;;\n"
        "  *pg_dump*)\n"
        f"    [[ {dump_exit} -ne 0 ]] && exit {dump_exit}\n"
        "    printf 'PGDMP fake pg_dump archive body\\n'\n"
        "    exit 0 ;;\n"
        '  *"pg_restore --list"*) cat <<\'TOC\'\n'
        f"{toc}\n"
        "TOC\n"
        "    exit 0 ;;\n"
        "  *pg_restore*)\n"
        f"    exit {restore_exit} ;;\n"
        "esac\n"
        "exit 0\n",
        encoding="utf-8",
    )
    docker.chmod(docker.stat().st_mode | stat.S_IXUSR)
    return bin_dir


def _deploy_tree(tmp_path: Path, **kwargs) -> tuple[Path, Path, Path]:
    """搭一个隔离的 deploy 目录：脚本全量拷入、.env 就位、docker 走桩。"""
    deploy_dir = tmp_path / "deploy"
    scripts_dir = deploy_dir / "scripts"
    scripts_dir.mkdir(parents=True)
    for script in DEPLOY_SCRIPTS.glob("*.sh"):
        shutil.copy2(script, scripts_dir / script.name)
    (deploy_dir / ".env").write_text("POSTGRES_DB=heijin_erp\nPOSTGRES_USER=erp_app\n", encoding="utf-8")
    bin_dir = _fake_docker(tmp_path, **kwargs)
    return deploy_dir, scripts_dir, bin_dir


def _run(script: Path, bin_dir: Path, *args: str, extra_env: dict[str, str] | None = None):
    env = {
        **os.environ,
        **(extra_env or {}),
        "PATH": f"{bin_dir}{os.pathsep}{os.environ['PATH']}",
    }
    return subprocess.run(
        ["bash", str(script), *args],
        # 脚本输出含中文：显式钉 UTF-8 并容错，避免 CI 的非 UTF-8 locale 让断言挂在解码上
        encoding="utf-8",
        errors="replace",
        capture_output=True,
        env=env,
        check=False,
    )


def test_no_sqlite_backup_entry_point_left() -> None:
    """备份链只允许 pg_dump：残留 SQLite 入口会让「备份成功」变成一句谎话。"""
    offenders: list[str] = []
    for directory in (DEPLOY_SCRIPTS, BACKEND_SCRIPTS):
        for path in directory.glob("*.sh"):
            text = path.read_text(encoding="utf-8")
            # 注释里说明历史可以，但不能有可执行调用。
            for line in text.splitlines():
                stripped = line.strip()
                if stripped.startswith("#"):
                    continue
                if "backup_db.py" in stripped or "restore_db.py" in stripped:
                    offenders.append(f"{path.name}: {stripped}")
    assert not offenders, "仍存在 SQLite 备份入口调用：\n" + "\n".join(offenders)
    assert not (BACKEND_SCRIPTS / "backup_db.py").exists(), "SQLite 备份脚本应已删除"
    assert not (BACKEND_SCRIPTS / "restore_db.py").exists(), "SQLite 恢复脚本应已删除"


def test_backup_daily_writes_dump_and_sha256(tmp_path: Path) -> None:
    _, scripts_dir, bin_dir = _deploy_tree(tmp_path)

    result = _run(scripts_dir / "backup_daily.sh", bin_dir)

    assert result.returncode == 0, result.stdout + result.stderr
    assert "BACKUP_OK" in result.stdout
    dumps = sorted((tmp_path / "backups").glob("heijin_erp_pg_*.dump"))
    assert len(dumps) == 1, result.stdout
    sidecar = dumps[0].with_suffix(".dump.sha256")
    assert sidecar.exists(), "备份必须配一个 sha256 sidecar（异地留存与恢复都靠它）"
    assert len(sidecar.read_text().split()[0]) == 64
    assert not list((tmp_path / "backups").glob("*.partial")), "失败/成功的中间文件都不许留在备份目录"


def test_backup_daily_allows_empty_database(tmp_path: Path) -> None:
    """空库是合法状态（首次部署 / 刚建的空目标库），不能因此拒绝备份。

    回归背景：闸门最初写成「归档里必须有 schema 对象」，结果空库备份被判为坏备份，
    连带把「恢复前先备份当前库」这条退路也堵死了——首次部署与空库恢复都会卡在这里。
    """
    _, scripts_dir, bin_dir = _deploy_tree(tmp_path, psql_tables=0)

    result = _run(scripts_dir / "backup_daily.sh", bin_dir)

    assert result.returncode == 0, result.stdout + result.stderr
    assert "BACKUP_OK" in result.stdout
    assert "空库" in result.stderr
    assert len(list((tmp_path / "backups").glob("*.dump"))) == 1


def test_backup_daily_rejects_truncated_archive(tmp_path: Path) -> None:
    """源库 5 张表、归档只有 1 张 = 截断或连错库，必须拒收而不是留成「最新备份」。"""
    _, scripts_dir, bin_dir = _deploy_tree(tmp_path, psql_tables=5, toc_tables=1)

    result = _run(scripts_dir / "backup_daily.sh", bin_dir)

    assert result.returncode != 0
    assert "备份表数不一致" in result.stderr
    assert not list((tmp_path / "backups").glob("*.dump")), "不一致的归档不许落成正式备份"


def test_backup_daily_rotates_and_keeps_latest(tmp_path: Path) -> None:
    """KEEP 必须在宿主机侧生效：超量只删最旧，最新一份必须留下。"""
    _, scripts_dir, bin_dir = _deploy_tree(tmp_path)
    out = tmp_path / "backups"
    out.mkdir()
    for stamp in ("20200101_000000", "20200102_000000", "20200103_000000"):
        old = out / f"heijin_erp_pg_{stamp}.dump"
        old.write_bytes(b"PGDMP stale")
        (out / f"heijin_erp_pg_{stamp}.dump.sha256").write_text("0" * 64 + "  x\n", encoding="utf-8")

    result = _run(scripts_dir / "backup_daily.sh", bin_dir, extra_env={"ERP_BACKUP_KEEP": "2"})

    assert result.returncode == 0, result.stdout + result.stderr
    kept = sorted(p.name for p in out.glob("heijin_erp_pg_*.dump"))
    assert len(kept) == 2, kept
    assert "heijin_erp_pg_20200101_000000.dump" not in kept, "最旧一份应被滚动删除"
    assert not (out / "heijin_erp_pg_20200101_000000.dump.sha256").exists(), "sidecar 必须随备份一起删"


def test_backup_daily_fails_loudly_when_pg_dump_fails(tmp_path: Path) -> None:
    """pg_dump 失败必须非零退出且不留半成品——cron 不能把失败伪装成「今天没数据」。"""
    _, scripts_dir, bin_dir = _deploy_tree(tmp_path, dump_exit=1)

    result = _run(scripts_dir / "backup_daily.sh", bin_dir)

    assert result.returncode != 0
    assert "pg_dump 失败" in result.stderr
    out = tmp_path / "backups"
    assert not list(out.glob("*.dump")), "失败的备份不许落成 .dump"
    assert not list(out.glob("*.partial")), "半成品必须清掉"


def test_backup_daily_refuses_when_db_service_not_running(tmp_path: Path) -> None:
    """db 没起来时不能「备份成功」，否则留下一个空产物让人误以为有备份。"""
    _, scripts_dir, bin_dir = _deploy_tree(tmp_path)
    docker = bin_dir / "docker"
    # 覆盖桩：db 服务不在运行列表里
    docker.write_text(
        "#!/usr/bin/env bash\n"
        'args="$*"\n'
        'case "$args" in\n'
        '  *"ps --status running --services"*) printf "frontend\\n"; exit 0 ;;\n'
        "  *) exit 0 ;;\n"
        "esac\n",
        encoding="utf-8",
    )
    docker.chmod(0o755)

    result = _run(scripts_dir / "backup_daily.sh", bin_dir)

    assert result.returncode != 0
    assert "db 容器未运行" in result.stderr


def test_restore_requires_explicit_confirmation(tmp_path: Path) -> None:
    """不加 --yes 必须拒绝：恢复会覆盖正式库全部数据，不能靠「顺手跑一下」。"""
    _, scripts_dir, bin_dir = _deploy_tree(tmp_path)
    dump = tmp_path / "heijin_erp_pg_20261102_032000.dump"
    dump.write_bytes(b"PGDMP payload")

    result = _run(scripts_dir / "restore_pg.sh", bin_dir, "--backup", str(dump))

    assert result.returncode != 0
    assert "--yes" in result.stderr


def test_restore_rejects_checksum_mismatch(tmp_path: Path) -> None:
    _, scripts_dir, bin_dir = _deploy_tree(tmp_path)
    dump = tmp_path / "heijin_erp_pg_20261102_032000.dump"
    dump.write_bytes(b"PGDMP payload")
    dump.with_suffix(".dump.sha256").write_text("f" * 64 + "  x\n", encoding="utf-8")

    result = _run(scripts_dir / "restore_pg.sh", bin_dir, "--backup", str(dump), "--yes", "--no-pre-backup")

    assert result.returncode != 0
    assert "校验和不匹配" in result.stderr


def test_restore_is_single_transaction_and_tolerates_broken_backup(tmp_path: Path) -> None:
    """恢复必须单事务，且 pg_restore 报错时以非零退出（库由事务回滚保证不变）。"""
    _, scripts_dir, bin_dir = _deploy_tree(tmp_path, restore_exit=1)
    text = (scripts_dir / "restore_pg.sh").read_text(encoding="utf-8")
    assert "--single-transaction" in text, "恢复必须单事务，否则失败会留下半套表"

    dump = tmp_path / "heijin_erp_pg_20261102_032000.dump"
    dump.write_bytes(b"PGDMP payload")

    result = _run(scripts_dir / "restore_pg.sh", bin_dir, "--backup", str(dump), "--yes", "--no-pre-backup")

    assert result.returncode != 0
    assert "pg_restore 失败" in result.stderr
