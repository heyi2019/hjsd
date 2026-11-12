"""把 rawdata/原始数据/ 的 5 份金山文档导出 JSON 落成 import_batches/import_rows。

对应「数据导入映射草案 v0.1」的实施顺序第 1 步：**只落原始行，不做任何字段推断、
不自动匹配、不生成任何业务实体**。后续映射由人工在页面指派（assign_mapping），
或由 commit_batch 在口径裁决后执行。

三条硬约束（PRD §23 + 回归锁死项）：

1. **禁止自动匹配**：`create_batch` 内部只写 `raw` 与 `status=UNMAPPED`，
   `mapped_order_id` / `mapped_account_id` 一律留空。
2. **凭据字段不落库**：`密码` / `账号密码` / `账密` / `绑定手机号` / `买家联系方式`
   在写入前剥离并替换为占位符（`[REDACTED]`），只记录「原字段存在且非空」的事实。
   理由是业务口径——v1 的 26 张表没有任何列能承载游戏账号登录凭据，
   写进 `import_rows.raw` 等于把凭据复制进一个新系统。
3. **原始值逐字保留**：`房租/日用` 这类类别值原样写入 `raw`，
   不做任何归一化或改写（曾写成「房租日用」会导致 ¥11,989.90 漏计）。

用法：
```bash
cd backend
python3 scripts/land_raw_import.py               # 落地全部 5 份
python3 scripts/land_raw_import.py --dry-run     # 只报告不写库
python3 scripts/land_raw_import.py --only sheet9_orders
```

脚本幂等：同一份文件重复执行不会产生重复批次（按 source_name 查重）。
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

PROJECT_ROOT = BACKEND_DIR.parent
SOURCE_DIR = PROJECT_ROOT / "rawdata" / "原始数据"

REDACTED = "[REDACTED]"

# 凭据 / 直接个人身份信息：写入前剥离，不进 import_rows.raw。
# 「联系方式」类同样剥离——它是买家个人信息，且 v1 有 customers.phone 可承载，
# 不该塞进 raw 这种「原文暂存」区。
SENSITIVE_FIELDS: frozenset[str] = frozenset(
    {
        "密码",
        "账号密码",
        "账密",
        "绑定手机号",
        "买家联系方式",
    }
)

# 每份源文件 → (source_kind, 人类可读来源名)
SOURCE_FILES: dict[str, tuple[str, str]] = {
    "sheet3_cashflow": ("STANDARD_CASHFLOW", "金山文档·资金流水"),
    "sheet9_orders": ("STANDARD_ORDER", "金山文档·订单"),
    "sheet16_accounts": ("STANDARD_ACCOUNT", "金山文档·账号"),
    "sheet17_installments": ("STANDARD_INSTALLMENT", "金山文档·分期"),
    "sheet21_leads": ("STANDARD_LEAD", "金山文档·需求线索"),
}


def _strip_sensitive(fields: dict[str, Any]) -> tuple[dict[str, Any], list[str]]:
    """剥离凭据字段，返回 (净化后的 dict, 被剥离的字段名列表)。

    只在值非空时记录字段名——「字段存在但为空」与「字段不存在」对映射没有区别，
    写进 raw 只会增加噪音。
    """
    cleaned: dict[str, Any] = {}
    removed: list[str] = []
    for key, value in fields.items():
        if key in SENSITIVE_FIELDS:
            if value not in (None, "", [], {}):
                cleaned[key] = REDACTED
                removed.append(key)
            # 值为空则整个字段丢弃，不留空键
            continue
        cleaned[key] = value
    return cleaned, removed


def _load(stem: str) -> tuple[list[dict[str, Any]], dict[str, int]]:
    """读一份源 JSON，返回 (行列表, 脱敏统计)。

    兼容两种行结构：`{fields: {...}}` 嵌套与 `{中文键}` 平铺。
    真实数据实测 5 份均为平铺，但两种都要支持——源文件随时可能被重新导出。
    """
    path = SOURCE_DIR / f"{stem}.json"
    if not path.is_file():
        raise FileNotFoundError(f"源文件不存在：{path}")

    payload = json.loads(path.read_text(encoding="utf-8"))
    records = payload.get("records") if isinstance(payload, dict) else payload
    if not isinstance(records, list):
        raise ValueError(f"{path.name} 顶层不是 records 数组")

    rows: list[dict[str, Any]] = []
    stats = {"rows": 0, "redacted_cells": 0, "empty_sensitive": 0}
    for record in records:
        fields = record.get("fields") if isinstance(record.get("fields"), dict) else record
        # 保留金山文档行 ID，便于回溯原文位置
        source_id = record.get("id")
        cleaned, removed = _strip_sensitive(dict(fields))
        if source_id is not None:
            cleaned["_source_id"] = source_id
        stats["rows"] += 1
        stats["redacted_cells"] += len(removed)
        stats["empty_sensitive"] += sum(
            1 for key in SENSITIVE_FIELDS if key in fields and fields[key] in (None, "", [], {})
        )
        rows.append(cleaned)
    return rows, stats


def _existing_batches(session: Any) -> set[str]:
    from app.domain.imports import ImportBatch

    return {row.source_name for row in session.query(ImportBatch).all()}


def main() -> int:
    parser = argparse.ArgumentParser(description="把源 JSON 落成 import_rows（只存原文，零推断）")
    parser.add_argument("--dry-run", action="store_true", help="只报告不写库")
    parser.add_argument("--only", help=f"只处理指定文件，逗号分隔。可选：{', '.join(SOURCE_FILES)}")
    args = parser.parse_args()

    stems = [s.strip() for s in args.only.split(",") if s.strip()] if args.only else list(SOURCE_FILES)
    unknown = [s for s in stems if s not in SOURCE_FILES]
    if unknown:
        print(f"未知源文件：{unknown}；可选：{list(SOURCE_FILES)}", file=sys.stderr)
        return 2

    # 预检：先把所有文件读一遍并脱敏，任何一步失败都不写库（避免半批状态）
    loaded: dict[str, tuple[str, str, list[dict[str, Any]], dict[str, int]]] = {}
    for stem in stems:
        try:
            rows, stats = _load(stem)
        except (FileNotFoundError, ValueError, json.JSONDecodeError) as exc:
            print(f"读取失败 {stem}：{exc}", file=sys.stderr)
            return 1
        source_kind, source_name = SOURCE_FILES[stem]
        loaded[stem] = (source_kind, source_name, rows, stats)

    print(f"源目录：{SOURCE_DIR}")
    print(f"待处理 {len(loaded)} 份：{'、'.join(stems)}\n")

    total_rows = 0
    total_redacted = 0
    for stem, (source_kind, source_name, rows, stats) in loaded.items():
        total_rows += stats["rows"]
        total_redacted += stats["redacted_cells"]
        detail = f"（脱敏 {stats['redacted_cells']} 格" if stats["redacted_cells"] else ""
        print(f"  {stem:22} {stats['rows']:4} 行  {source_kind:20} {source_name}{detail}")

    print(f"\n合计 {total_rows} 行，脱敏 {total_redacted} 格")

    if args.dry_run:
        print("\n[dry-run] 未写库。去掉 --dry-run 实际落地。")
        return 0

    from app.core.database import get_session_factory
    from app.imports import batches as imp_batches

    session = get_session_factory()()
    try:
        done = _existing_batches(session)
        created = 0
        skipped = 0
        for stem, (source_kind, source_name, rows, _stats) in loaded.items():
            if source_name in done:
                print(f"  跳过 {stem}：批次「{source_name}」已存在（幂等）")
                skipped += 1
                continue
            batch = imp_batches.create_batch(
                session,
                source_name=source_name,
                rows=rows,
                source_kind=source_kind,
                actor="land_raw_import",
                note=f"由 land_raw_import.py 从 {stem}.json 落地；仅存原文，凭据字段已脱敏",
            )
            print(f"  落地 {stem}：批次 {batch['batch_no']}（{batch['id']}）")
            created += 1
        session.commit()
        print(f"\n完成：新建 {created} 个批次，跳过 {skipped} 个已存在批次。")
        print("下一步：在页面按批次逐行指派映射（/imports/batches/{id}/rows），")
        print("或等口径裁决后提交导入批次，保留标准导入记录。")
    except Exception:
        session.rollback()
        raise
    finally:
        session.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
