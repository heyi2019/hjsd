#!/usr/bin/env python3
"""一次性 ETL：旧 ECS schema（0009 时代）→ 当前 v1 schema（head=0001 单基线）。

用法：
    python migrate_old_to_v1.py OLD_DB NEW_DB [--ref-db REF_NEW_DB]

前置条件：
    * NEW_DB 已通过 `alembic upgrade head` 建好空表（当前 schema=0001 单基线，37 张数据表）。
    * OLD_DB 为旧 0009 时代数据库（29 张表）。
    * REF_NEW_DB（可选）为已完整 seed 的当前库，用于补齐 OLD_DB 缺失的
      document_sequences 键。

行为：
    * 对旧、新 schema 共有的每张表，逐行逐列复制。同名列直接复制；RENAMES
      处理重命名；旧表有而新表无目标的列丢弃；新表有而旧行无的列留 NULL。
    * 绝不触碰 alembic_version。
    * document_sequences：旧计数器覆盖同键 seed 值；REF_NEW_DB 独有键插入。
    * ETL 期间关闭新库外键约束，整库包在单事务内。
"""
from __future__ import annotations

import argparse
import sqlite3
import sys


# 表级列重命名：仅此处列出的旧列名会被映射到新列名，其余同名自动对应。
RENAMES: dict[str, dict[str, str]] = {
    "accounts": {"region": "channel_region"},
    "rebate_records": {"rebate_group_no": "rebate_no"},
    "quality_issues": {"issue_type": "code"},
}

# 已知旧表有、新表无（确认丢弃）的列；用于显式跳过与日志核对。
EXPECTED_DROPPED: dict[str, set[str]] = {
    "accounts": {"account_no", "risk_level", "channels"},
    "deposits": {"deposit_no"},
    "installments": {"account_id"},
    "quality_issues": {"entity_label", "amount", "detected_on", "owner_id", "note"},
}

SKIP_TABLES = {"alembic_version"}

# 值级变换：旧枚举值 -> 新枚举值。键为 (表, 列)，值为 {旧值: 新值}。
# 依据：当前 v1 代码 seed 已把 提号(TH) 归为 capital_type='STOCK'（旧 PASS_THRU 过账型
# 在新 schema 已无对应枚举，统一并入 STOCK）。如后续发现其他枚举漂移，在此追加即可。
TRANSFORMS: dict[tuple[str, str], dict[str, str]] = {
    ("order_type_defs", "capital_type"): {"PASS_THRU": "STOCK"},
}


def _columns(con: sqlite3.Connection, table: str) -> list[str]:
    rows = con.execute(f'PRAGMA table_info("{table}")').fetchall()
    return [r[1] for r in rows]


def _table_names(con: sqlite3.Connection) -> list[str]:
    rows = con.execute(
        "SELECT name FROM sqlite_master WHERE type='table' "
        "AND name NOT LIKE 'sqlite_%' ORDER BY name"
    ).fetchall()
    return [r[0] for r in rows]


def migrate(old_path: str, new_path: str, ref_path: str | None) -> None:
    old = sqlite3.connect(old_path)
    new = sqlite3.connect(new_path)
    new.isolation_level = None  # 手动事务
    new.execute("PRAGMA foreign_keys=OFF")

    try:
        new.execute("BEGIN")
        old_tables = set(_table_names(old))
        new_tables = set(_table_names(new))

        total_rows = 0
        for table in sorted(old_tables):
            if table in SKIP_TABLES:
                continue
            if table not in new_tables:
                print(f"[skip] {table}: 旧表在新建 schema 中不存在（新表为 {8} 张新增表之一，留空）")
                continue

            old_cols = _columns(old, table)
            new_cols = set(_columns(new, table))
            rename = RENAMES.get(table, {})

            # 计算旧列 -> 新列的插入映射
            insert_cols: list[str] = []
            dropped: list[str] = []
            for c in old_cols:
                target = rename.get(c, c)
                if target in new_cols:
                    insert_cols.append(target)
                else:
                    dropped.append(c)

            expected = EXPECTED_DROPPED.get(table, set())
            unexpected = set(dropped) - expected
            if unexpected:
                print(f"[warn] {table}: 以下旧列无新目标且非预期丢弃 -> {sorted(unexpected)}")

            placeholders = ", ".join("?" for _ in insert_cols)
            col_sql = ", ".join(f'"{c}"' for c in insert_cols)
            insert_sql = f'INSERT INTO "{table}" ({col_sql}) VALUES ({placeholders})'

            # 幂等：先清空目标表再插入（target 为 ETL 自有输出，整库单事务内执行，
            # 配合 FK=OFF 安全；首次运行目标为空，等同 no-op）。
            new.execute(f'DELETE FROM "{table}"')

            rows = old.execute(f'SELECT * FROM "{table}"').fetchall()
            # 按 insert_cols 顺序取索引
            col_index = {c: i for i, c in enumerate(old_cols)}
            transforms = {
                oc: TRANSFORMS[(table, oc)]
                for oc in insert_cols
                if (table, oc) in TRANSFORMS
            }
            mapped_rows = []
            for row in rows:
                vals = [row[col_index[oc]] for oc in insert_cols]
                if transforms:
                    vals = [
                        transforms[oc].get(v, v) if oc in transforms else v
                        for oc, v in zip(insert_cols, vals)
                    ]
                mapped_rows.append(tuple(vals))

            if mapped_rows:
                new.executemany(insert_sql, mapped_rows)
            total_rows += len(mapped_rows)
            print(
                f"[ok]   {table}: {len(mapped_rows)} 行 | "
                f"插入列 {len(insert_cols)} | 丢弃 {dropped or '-'}"
            )

        # document_sequences：旧计数器覆盖 seed，ref 独有键插入
        _merge_sequences(old, new, ref_path)
        new.execute("COMMIT")
        print(f"\nETL 完成：共写入 {total_rows} 行。")
    except Exception:
        new.execute("ROLLBACK")
        raise
    finally:
        old.close()
        new.close()


def _merge_sequences(old: sqlite3.Connection, new: sqlite3.Connection, ref_path: str | None) -> None:
    table = "document_sequences"
    old_cols = _columns(old, table)
    new_cols = set(_columns(new, table))
    common = [c for c in old_cols if c in new_cols]
    idx = {c: i for i, c in enumerate(old_cols)}
    rows = old.execute(f'SELECT * FROM "{table}"').fetchall()
    mapped = [tuple(r[idx[c]] for c in common) for r in rows]
    if mapped:
        ph = ", ".join("?" for _ in common)
        cs = ", ".join(f'"{c}"' for c in common)
        new.executemany(f'INSERT OR REPLACE INTO "{table}" ({cs}) VALUES ({ph})', mapped)
    print(f"[ok]   {table}: 覆盖 {len(mapped)} 行（旧计数器优先）")

    if ref_path:
        ref = sqlite3.connect(ref_path)
        ref_keys = {
            r[0]
            for r in ref.execute("SELECT sequence_key FROM document_sequences")
        }
        new_keys = {
            r[0]
            for r in new.execute("SELECT sequence_key FROM document_sequences")
        }
        missing = ref_keys - new_keys
        ref_cols = _columns(ref, table)
        new_cols = set(_columns(new, table))
        common = [c for c in ref_cols if c in new_cols]
        idx = {c: i for i, c in enumerate(ref_cols)}
        for key in sorted(missing):
            row = ref.execute(
                f'SELECT * FROM "{table}" WHERE sequence_key=?', (key,)
            ).fetchone()
            vals = tuple(row[idx[c]] for c in common)
            cs = ", ".join(f'"{c}"' for c in common)
            ph = ", ".join("?" for _ in common)
            new.execute(
                f'INSERT OR IGNORE INTO "{table}" ({cs}) VALUES ({ph})', vals
            )
        ref.close()
        if missing:
            print(f"[ok]   {table}: 从 ref 补齐 {len(missing)} 个缺失键 {sorted(missing)}")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("old_db")
    ap.add_argument("new_db")
    ap.add_argument("--ref-db", default=None)
    args = ap.parse_args()
    migrate(args.old_db, args.new_db, args.ref_db)
    return 0


if __name__ == "__main__":
    sys.exit(main())
