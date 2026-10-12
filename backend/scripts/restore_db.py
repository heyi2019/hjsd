"""生产库恢复（P0：补齐“备份恢复”缺口，且“实际验证能恢复”）。

恢复流程：
- 用 SHA256 sidecar 校验备份文件未被篡改/损坏；
- 对备份文件跑 PRAGMA integrity_check，确认 SQLite 页级完整；
- 原子替换目标库（先写临时文件再 os.replace），保留被替换的旧库为 .bak 以便回滚；
- 打印校验和与结果，供恢复演练/CI 断言。

注意：若目标库正被运行中的服务占用，替换文件后需重启服务才能加载新库。

用法：
    python3 scripts/restore_db.py --backup data/backups/heijin_erp_v1_20261013_040000.db
    python3 scripts/restore_db.py --backup x.db --target data/heijin_erp_v1.db --force
"""
from __future__ import annotations

import argparse
import hashlib
import os
import sqlite3
import sys
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))


def _sha256_of(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _expect_digest(backup: Path) -> str | None:
    sidecar = backup.with_suffix(".db.sha256")
    if not sidecar.exists():
        return None
    line = sidecar.read_text().splitlines()[0].strip()
    return line.split()[0] if line else None


def verify_backup(backup: Path) -> str:
    """返回通过校验的 SHA256；失败直接抛异常。"""
    if not backup.exists():
        raise SystemExit(f"备份文件不存在：{backup}")
    digest = _sha256_of(backup)
    expected = _expect_digest(backup)
    if expected is not None and digest != expected:
        raise SystemExit(f"校验和不匹配：期望 {expected}，实得 {digest}（备份可能损坏）")
    # 页级完整性
    conn = sqlite3.connect(f"file:{backup}?mode=ro", uri=True)
    try:
        rows = conn.execute("PRAGMA integrity_check").fetchall()
    finally:
        conn.close()
    verdict = [r[0] for r in rows]
    if verdict != ["ok"]:
        raise SystemExit(f"SQLite 完整性检查未通过：{verdict}")
    return digest


def restore(backup: Path, target: Path, *, force: bool = False) -> str:
    digest = verify_backup(backup)
    target = target.expanduser()
    if target.exists() and not force:
        # 安全：默认不覆盖已有库，除非 --force
        raise SystemExit(f"目标库已存在：{target}，请加 --force 覆盖（旧库会先存为 .bak）")

    # 若目标已存在，先保留一份以防恢复后业务异常需回滚
    if target.exists():
        target.replace(target.with_suffix(target.suffix + ".bak"))

    tmp = target.with_suffix(target.suffix + ".tmp")
    conn = sqlite3.connect(str(tmp))
    try:
        src = sqlite3.connect(f"file:{backup}?mode=ro", uri=True)
        try:
            src.backup(conn)
        finally:
            src.close()
    finally:
        conn.close()
    os.replace(tmp, target)  # 同一文件系统原子替换
    print(f"RESTORE_OK target={target} size={target.stat().st_size} sha256={digest}")
    return digest


def main() -> int:
    parser = argparse.ArgumentParser(description="黑金时代 ERP v1 生产库恢复")
    parser.add_argument("--backup", required=True, help="备份文件路径")
    parser.add_argument("--target", default=str(BACKEND_DIR / "data" / "heijin_erp_v1.db"), help="恢复目标库")
    parser.add_argument("--force", action="store_true", help="覆盖已存在的目标库（旧库存为 .bak）")
    args = parser.parse_args()
    restore(Path(args.backup), Path(args.target), force=args.force)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
