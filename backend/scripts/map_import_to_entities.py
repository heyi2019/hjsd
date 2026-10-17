"""把已落地的导入原始行映射为 v1 正式实体（导入第 2/3 步）。

只做**口径已明确**的部分，对「需要业务裁决」的类别一律拒绝导入并说明原因，
绝不猜测补齐（PRD §23：禁止自动匹配、不得要求开发猜测补齐）。

## 已明确的口径（可直接导）

| 源「订单类型」 | v1 类型 | 行数 | 依据 |
|---|---|---|---|
| 回收 | `HS` 回收（STOCK 库存型） | 30 | 种子 SEED_ORDER_TYPES |
| 氪金联盟提号 | `TH` 提号（STOCK，关联 PICKUP 实体） | 15 | 同上 |
| 代挂 | `DG` 代挂（ZERO 零本金） | 24 | 同上 |
| 蹭点 | `DG` 代挂（同上） | 1 | PRD §术语等价表：蹭点 = 代挂的叫法，非独立业务 |

## 明确不导的部分

| 源 | 行数 | 原因 |
|---|---|---|
| 返点 | 19 | v1 已把返点建成独立实体 `rebate_records`，源数据当订单类型是旧口径。转 rebate 需要「渠道 + 费率」口径，源数据无此字段 |
| leads | 12 | v1 的 26 张表无线索实体 |
| 账号 18 条无账号信息 | — | 裁决点 4 未定，本脚本先跳过全部账号 |

## 金额口径（关键）

源数据 `交易金额` **不等于** `本金 + 利润`（89 单中 74 单不满足，实测）。
所以：
- `本金` → `order_events` 的 PRINCIPAL 份额
- `利润` → `order_events` 的 PROFIT 份额
- `交易金额` → GROSS 份额

三者是**并列的份额记录**，不是恒等式。任何「gross = principal + profit」的
校验都会误报（这正是 memory 里 89 单 74 单不满足的那条口径）。

## 池路由

源「回款账户（本金/利润）」是数组，取值只有两种：
- `投资款荷包（本金）` → `HJ_INVEST`
- `利润荷包（利润）` → `HJ_PROFIT`

用种子 `SEED_ROUTES` 决定每种类型 + 份额的落池，不自行推断。

用法：
```bash
cd backend
python3 scripts/map_import_to_entities.py --dry-run
python3 scripts/map_import_to_entities.py --only orders
```

幂等：已 MAPPED 的行跳过；已存在同 source_name 批次的订单不重复生成。
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import date, datetime
from decimal import Decimal
from pathlib import Path
from typing import Any

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from app.core.database import get_session_factory  # noqa: E402
from app.core.money import to_money  # noqa: E402
from app.domain.foundation import OrderTypeDef, Pool  # noqa: E402
from app.domain.enums import (  # noqa: E402
    ImportRowStatus,
    LinkStatus,
    OrderStatus,
    Portion,
)
from app.imports import service as import_service  # noqa: E402
from app.orders import service as order_service  # noqa: E402

# 源「订单类型」→ v1 order_type_defs.code
ORDER_TYPE_MAP: dict[str, str] = {
    "回收": "HS",
    "氪金联盟提号": "TH",
    "代挂": "DG",
    # PRD §术语等价表：「蹭点 → DG 代挂，主理人口述确认：蹭点就是代挂」，
    # 是代挂的叫法而非独立业务。数据侧佐证：该单本金为 0，与其余 20 单代挂同形态，
    # 且与提号库存型（TH）应有本金的前提矛盾。
    "蹭点": "DG",
}

# 明确不导的源类型 → 原因（会出现在运行报告里，避免「静默漏导」）
SKIP_TYPES: dict[str, str] = {
    "返点": "v1 已把返点建成独立实体 rebate_records；源数据无渠道/费率字段，口径不足",
}

# 源池名 → v1 资金池 code（与 SEED 种子一致，仅缺编码）
POOL_MAP: dict[str, str] = {
    "投资款荷包（本金）": "HJ_INVEST",
    "利润荷包（利润）": "HJ_PROFIT",
}

# 源「类别」→ (cashflow.nature, cashflow.category 是否沿用原值)
# 类别值逐字保留（含「房租/日用」的斜杠），不做归一化。
CASHFLOW_CATEGORY_NATURE: dict[str, str] = {
    "投资款": "EXTERNAL_IN",
    "账号回收": "BUSINESS_IN",
    "运营": "BUSINESS_OUT",
    "办公用品": "BUSINESS_OUT",
    "员工薪资": "BUSINESS_OUT",
    "房租/日用": "BUSINESS_OUT",
}

ACTOR = "map_import"


def _num(value: Any) -> Decimal:
    """源数据金额 → Decimal。空/非数一律 0（原始值已在 import_rows.raw 里留存）。"""
    if value in (None, "", [], {}):
        return Decimal("0")
    try:
        return Decimal(str(value))
    except Exception:  # noqa: BLE001 — 源数据是脏的，任何异常都归 0
        return Decimal("0")


def _date(value: Any) -> date | None:
    text = str(value or "").strip()
    if not text:
        return None
    for fmt in ("%Y-%m-%d", "%Y/%m/%d", "%Y.%m.%d", "%Y年%m月%d日"):
        try:
            return datetime.strptime(text, fmt).date()
        except ValueError:
            continue
    return None


def _pools_in(row: dict[str, Any]) -> set[str]:
    raw = row.get("回款账户（本金/利润）")
    if not isinstance(raw, list):
        return set()
    return {POOL_MAP[item] for item in raw if item in POOL_MAP}


def _order_rows(session: Any) -> list[Any]:
    from app.domain.imports import ImportBatch, ImportRow

    batch = (
        session.query(ImportBatch).filter_by(source_name="金山文档·订单").one_or_none()
    )
    if batch is None:
        return []
    return (
        session.query(ImportRow)
        .filter_by(batch_id=batch.id)
        .order_by(ImportRow.row_no)
        .all()
    )


def map_orders(session: Any, *, dry_run: bool) -> dict[str, Any]:
    """把订单原始行映射为 orders + order_events。"""
    from app.domain.trade import OrderEvent

    report: dict[str, Any] = {
        "scanned": 0,
        "mapped": 0,
        "skipped_type": {},
        "skipped_missing_date": 0,
        "skipped_already_mapped": 0,
        "orders": 0,
        "events": 0,
        "gross_sum": Decimal("0"),
        "principal_sum": Decimal("0"),
        "profit_sum": Decimal("0"),
    }

    rows = _order_rows(session)
    report["scanned"] = len(rows)
    available = {
        d.code for d in session.query(OrderTypeDef).filter_by(is_active=True).all()
    }

    for row in rows:
        # 幂等：已映射过的行直接跳过。
        # 少了这一段，重跑会静默翻倍——order_no 唯一约束拦不住，
        # 因为编号是按序列新生成的，重复的是「业务事实」而不是「编号」。
        if row.status == ImportRowStatus.MAPPED.value:
            report["skipped_already_mapped"] += 1
            continue

        raw = row.raw if isinstance(row.raw, dict) else json.loads(row.raw)
        src_type = str(raw.get("订单类型") or "")

        if src_type in SKIP_TYPES:
            report["skipped_type"][src_type] = (
                report["skipped_type"].get(src_type, 0) + 1
            )
            continue

        target = ORDER_TYPE_MAP.get(src_type)
        if target is None:
            report["skipped_type"][src_type or "(空)"] = (
                report["skipped_type"].get(src_type or "(空)", 0) + 1
            )
            continue
        if target not in available:
            report["skipped_type"][f"{src_type}→{target}(类型未启用)"] = (
                report["skipped_type"].get(f"{src_type}→{target}(类型未启用)", 0) + 1
            )
            continue

        trade_date = _date(raw.get("日期"))
        if trade_date is None:
            report["skipped_missing_date"] += 1
            continue

        if dry_run:
            report["mapped"] += 1
            report["gross_sum"] += to_money(_num(raw.get("交易金额")))
            report["principal_sum"] += to_money(_num(raw.get("本金")))
            report["profit_sum"] += to_money(_num(raw.get("利润")))
            continue

        order = order_service.create_order(
            session,
            order_type=target,
            trade_date=trade_date,
            account_id=None,  # 无可靠关联键 → 留空（PRD 允许）
            owner_id=None,  # 源数据是中文姓名，v1 用整数 id，不可自动映射
            note=(
                f"导入：源类型={src_type}，源行 {row.row_no}，"
                f"售卖员={raw.get('售卖员')}，回收员={raw.get('回收员')}"
            ),
            actor=ACTOR,
        )
        # 导入数据一律标 UNLINKED：没有任何自动匹配
        order.link_status = LinkStatus.UNLINKED.value

        # 份额事件：源「回款账户」决定哪些份额落哪个池
        pools = _pools_in(raw)
        plan = [
            (Portion.PRINCIPAL.value, _num(raw.get("本金")), "HJ_INVEST"),
            (Portion.PROFIT.value, _num(raw.get("利润")), "HJ_PROFIT"),
            (Portion.GROSS.value, _num(raw.get("交易金额")), "HJ_PROFIT"),
        ]
        pool_ids = {p.code: p.id for p in session.query(Pool).all()}
        for portion, amount, default_pool in plan:
            if amount == 0:
                continue
            # 源明确指定了池就用源的；源没提到该份额时用类型默认池
            pool_code = default_pool if default_pool in pools or not pools else next(iter(pools))
            pool_id = pool_ids.get(pool_code)
            if pool_id is None:
                continue
            session.add(
                OrderEvent(
                    event_no=order.order_no + "-" + portion[:3],
                    order_id=order.id,
                    event_type="SELL",
                    amount=to_money(amount),
                    portion=portion,
                    occurred_on=trade_date,
                    pool_id=pool_id,
                    is_posted=False,  # 导入数据默认未登记，池余额不受影响
                    reason="标准导入",
                    created_by=ACTOR,
                    updated_by=ACTOR,
                )
            )
            report["events"] += 1
            if portion == Portion.GROSS.value:
                report["gross_sum"] += to_money(amount)
            elif portion == Portion.PRINCIPAL.value:
                report["principal_sum"] += to_money(amount)
            else:
                report["profit_sum"] += to_money(amount)

        # autoflush=False 的会话（测试环境）下，必须显式 flush，
        # 否则刚 add 的 OrderEvent 对后续查询不可见——报告说 events=N 但库里查不到。
        session.flush()

        row.status = ImportRowStatus.MAPPED.value
        row.mapping_basis = f"ORDER_TYPE_MAP:{src_type}→{target}"
        row.mapped_by = ACTOR
        row.mapped_at = date.today()
        report["mapped"] += 1
        report["orders"] += 1

    return report


def main() -> int:
    parser = argparse.ArgumentParser(
        description="把导入原始行映射为 v1 实体（只做口径已明确的部分）"
    )
    parser.add_argument("--dry-run", action="store_true", help="只报告不写库")
    parser.add_argument("--only", default="orders", help="当前支持：orders")
    args = parser.parse_args()

    if args.only != "orders":
        print(f"暂不支持 --only={args.only}（当前仅 orders）", file=sys.stderr)
        return 2

    session = get_session_factory()()
    try:
        report = map_orders(session, dry_run=args.dry_run)
        if not args.dry_run:
            session.commit()
        else:
            session.rollback()

        print(f"扫描订单原始行：{report['scanned']}")
        print(f"可映射：{report['mapped']}  单  →  orders {report['orders']} / events {report['events']}")
        if report["skipped_already_mapped"]:
            print(f"跳过（此前已映射，幂等）：{report['skipped_already_mapped']}")
        if report["skipped_missing_date"]:
            print(f"跳过（日期不可解析）：{report['skipped_missing_date']}")
        if report["skipped_type"]:
            print("\n按类型跳过（口径未定，不猜测）：")
            for name, count in sorted(report["skipped_type"].items()):
                reason = SKIP_TYPES.get(name, "未在 ORDER_TYPE_MAP 中")
                print(f"  {name:20} {count:3} 行  原因：{reason}")
        print(
            f"\n金额合计（并列份额，非恒等式）：\n"
            f"  交易金额(GROSS)   {report['gross_sum']:>14}\n"
            f"  本金  (PRINCIPAL) {report['principal_sum']:>14}\n"
            f"  利润  (PROFIT)    {report['profit_sum']:>14}"
        )
        if args.dry_run:
            print("\n[dry-run] 未写库。去掉 --dry-run 实际落地。")
        else:
            print("\n完成。注意：导入事件的 is_posted=False，池余额不受影响。")
    except Exception:
        session.rollback()
        raise
    finally:
        session.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
