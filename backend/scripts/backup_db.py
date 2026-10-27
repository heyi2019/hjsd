"""生产库在线备份（P0：补齐“备份恢复”缺口）。

做法：
- 用 sqlite3 在线备份 API（Connection.backup）做一致快照，无需停服务；
- 备份前先 PRAGMA wal_checkpoint(TRUNCATE) 把 WAL 合并进主库，避免漏掉未落盘事务；
- 写 SHA256 校验和 sidecar，恢复端据此校验完整性；
- 滚动保留最近 N 份（默认 30），超量自动删最旧。

用法：
    python3 scripts/backup_db.py                 # 备份默认 v1 库到 data/backups/
    python3 scripts/backup_db.py --db /path/a.db --out-dir /bak --keep 14
"""
from __future__ import annotations

import argparse
import hashlib
import sqlite3
import sys
from datetime import datetime
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))


def resolve_source_db(explicit: str | None) -> Path:
    if explicit:
        return Path(explicit).expanduser()
    # 与 core.settings 保持同一真相：v1 库位于 backend/data/heijin_erp_v1.db
    candidate = BACKEND_DIR / "data" / "heijin_erp_v1.db"
    if not candidate.exists():
        # 回退到环境变量 / .env 指定的库（避免硬编码路径与实际不符）
        try:
            from app.core.settings import get_settings

            settings = get_settings()
            if settings.sqlite_file is not None:
                candidate = settings.sqlite_file
        except Exception:
            pass
    if not candidate.exists():
        raise SystemExit(f"源库不存在：{candidate}")
    return candidate


def sha256_of(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def backup_database(src: Path, out_dir: Path, keep: int = 30) -> Path:
    """对单个源库做一次在线备份，返回备份文件路径。"""
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    dest = out_dir / f"heijin_erp_v1_{stamp}.db"
    sidecar = dest.with_suffix(".db.sha256")

    # 1) 合并 WAL，保证备份包含全部已提交事务
    conn = sqlite3.connect(f"file:{src}?mode=ro", uri=True)
    try:
        conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
    except sqlite3.OperationalError:
        pass  # 非 WAL 模式忽略
    conn.close()

    # 2) 在线一致性拷贝
    src_conn = sqlite3.connect(f"file:{src}?mode=ro", uri=True)
    dest_conn = sqlite3.connect(str(dest))
    try:
        src_conn.backup(dest_conn)
        # 备份库会继承源库的 WAL 标志。若此时备份库自己的 -wal 里还留有页，而 SHA256 只
        # 覆盖 .db 主文件，恢复端就会「校验通过却丢掉这些页」。故显式合并 WAL 并切回
        # rollback journal，让「单文件 + 单 SHA256」真正自洽。
        dest_conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        mode = dest_conn.execute("PRAGMA journal_mode=DELETE").fetchone()[0]
        if str(mode).lower() != "delete":
            raise RuntimeError(f"备份库未能切回 rollback journal（当前 {mode}），拒绝产出不自洽的备份")
    finally:
        src_conn.close()
        dest_conn.close()

    # 清掉可能残留的空 WAL 影子文件：备份目录应只有 .db 与 .sha256 两类文件。
    for suffix in ("-wal", "-shm"):
        Path(str(dest) + suffix).unlink(missing_ok=True)

    # 3) 校验和 sidecar
    digest = sha256_of(dest)
    sidecar.write_text(f"{digest}  {dest.name}\n")

    # 4) 滚动保留
    backups = sorted(out_dir.glob("heijin_erp_v1_*.db"))
    while len(backups) > keep:
        old = backups.pop(0)
        old.unlink(missing_ok=True)
        old.with_suffix(".db.sha256").unlink(missing_ok=True)

    return dest


def main() -> int:
    parser = argparse.ArgumentParser(description="黑金时代 ERP v1 生产库在线备份")
    parser.add_argument("--db", default=None, help="源库路径（默认 backend/data/heijin_erp_v1.db）")
    parser.add_argument("--out-dir", default=str(BACKEND_DIR / "data" / "backups"), help="备份目录")
    parser.add_argument("--keep", type=int, default=30, help="保留最近 N 份（默认 30）")
    args = parser.parse_args()

    src = resolve_source_db(args.db)
    dest = backup_database(src, Path(args.out_dir), keep=args.keep)
    digest = sha256_of(dest)
    print(f"BACKUP_OK path={dest} size={dest.stat().st_size} sha256={digest} keep={args.keep}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
