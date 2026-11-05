"""导入 WPS 资金流水表中非订单的 90 行（投资款 / 房租日用 / 办公 / 薪资 / 运营 / 押金 / 退款）。

口径（用户 2026-11-01 裁决）：
- 全部 90 行进投资款荷包 HJ_INVEST（pool_id=1）；
- 「八月利润转入」13,470.42 按投资款性质入账（EXTERNAL_FUNDING）；
- 走 finance.cashflows.create_cashflow 正规入口，自动分配流水号 + 写审计。

默认 dry-run（整批滚回），--apply 才提交。
"""
from __future__ import annotations

import json
import sys
from datetime import date
from decimal import Decimal
from pathlib import Path

sys.path.insert(0, "/Users/aries/黑金时代/backend")

from sqlalchemy import select

from app.core.database import get_session_factory
from app.core.security import CurrentUser
from app.core.settings import get_settings
from app.domain.trade_models.cashflow import Cashflow
from app.finance import cashflows as cashflow_service

RAW = Path("/Users/aries/黑金时代/rawdata/原始数据/sheet3_cashflow.json")
BACKUP = Path(__file__).with_name("bak_wps_cashflow_20261101-2315.json")
ACTOR = "wps-import"
POOL_ID = 1  # 用户裁决：全部进投资款荷包

INVEST_NOTE = "八月利润转入"


def load_rows() -> list[dict]:
    data = json.loads(RAW.read_text(encoding="utf-8"))["records"]
    out = []
    for rec in data:
        f = rec.get("fields") or {}
        cat = str(f.get("类别") or "").strip()
        if cat == "账号回收":
            continue  # 已由订单 BUY 事件派生，不重复导入
        out.append(
            {
                "date": str(f.get("日期") or "").replace("/", "-"),
                "dir_raw": str(f.get("收支") or "").strip(),
                "cat": cat,
                "amt": Decimal(str(f.get("金额") or 0)),
                "note": str(f.get("明细") or "").strip(),
            }
        )
    return out


def classify(x: dict) -> dict:
    """按 WPS 类别/明细映射到 (direction, nature, fund_nature, accounting_attribute, category)。"""
    note = x["note"]
    cat = x["cat"]

    # 投资款 + 八月利润转入 → 外部注资
    if cat == "投资款" or INVEST_NOTE in note:
        return {
            "direction": "IN",
            "nature": "EXTERNAL_IN",
            "fund_nature": "EXTERNAL",
            "accounting_attribute": "EXTERNAL_FUNDING",
            "category": "投资款",
        }
    # 押金/保证金 → 保证金性质（钱还在，只是被占用）
    if "押金" in note or "保证金" in note:
        return {
            "direction": "OUT",
            "nature": "BUSINESS_OUT",
            "fund_nature": "EXTERNAL",
            "accounting_attribute": "DEPOSIT",
            "category": "押金",
        }
    # 收入侧
    if x["dir_raw"] == "收入":
        if "企服管理" in note:
            return {
                "direction": "IN",
                "nature": "BUSINESS_IN",
                "fund_nature": "BUSINESS",
                "accounting_attribute": "SERVICE_REVENUE",
                "category": "其他收入",
            }
        return {
            "direction": "IN",
            "nature": "BUSINESS_IN",
            "fund_nature": "BUSINESS",
            "accounting_attribute": "REFUND",
            "category": "退款",
        }
    # 支出侧
    return {
        "direction": "OUT",
        "nature": "BUSINESS_OUT",
        "fund_nature": "BUSINESS",
        "accounting_attribute": "OPERATING_EXPENSE",
        "category": cat or "运营",
    }


def already_imported(session, x: dict, spec: dict) -> bool:
    """幂等键：业务日 + 方向 + 金额 + 摘要。"""
    stmt = select(Cashflow.id).where(
        Cashflow.occurred_on == date.fromisoformat(x["date"]),
        Cashflow.direction == spec["direction"],
        Cashflow.amount == x["amt"],
        Cashflow.note == x["note"],
        Cashflow.pool_id == POOL_ID,
    )
    return session.scalar(stmt) is not None


def main() -> None:
    apply = "--apply" in sys.argv
    rows = load_rows()
    session = get_session_factory(get_settings().alembic_url)()
    admin = CurrentUser.build(
        id=1, username="admin", roles=("ADMIN",), owner_scope="ALL", pool_ids=(1, 2)
    )

    plan = []
    skipped = []
    for x in rows:
        spec = classify(x)
        if already_imported(session, x, spec):
            skipped.append(x)
            continue
        plan.append({"row": x, "spec": spec})

    tin = sum(v["row"]["amt"] for v in plan if v["spec"]["direction"] == "IN")
    tout = sum(v["row"]["amt"] for v in plan if v["spec"]["direction"] == "OUT")
    print(f"源表非订单行 {len(rows)} | 待导入 {len(plan)} | 已存在跳过 {len(skipped)}")
    print(f"待导入合计：收入 {tin} / 支出 {tout} / 净 {tin - tout}")
    print("\n分类分布：")
    agg: dict[tuple, list] = {}
    for v in plan:
        k = (v["spec"]["category"], v["spec"]["direction"], v["spec"]["accounting_attribute"])
        agg.setdefault(k, [0, Decimal("0")])
        agg[k][0] += 1
        agg[k][1] += v["row"]["amt"]
    for k, (n, amt) in sorted(agg.items()):
        print(f"  {k[0]:8s} {k[1]:3s} {k[2]:20s} {n:3d} 笔 {amt:>12}")

    if not apply:
        print("\n[dry-run] 校验每条能否通过 create_cashflow，随后整批滚回")
    else:
        snap = [
            {c.name: getattr(r, c.name) for c in Cashflow.__table__.columns}
            for r in session.scalars(
                select(Cashflow).where(Cashflow.pool_id == POOL_ID)
            ).all()
        ]
        BACKUP.write_text(
            json.dumps({"pool1_cashflow": snap}, ensure_ascii=False, indent=1, default=str),
            encoding="utf-8",
        )
        print(f"\n已备份池1流水 {len(snap)} 条 → {BACKUP.name}")

    ok = 0
    failed = []
    for v in plan:
        x, spec = v["row"], v["spec"]
        try:
            with session.begin_nested():
                cashflow_service.create_cashflow(
                    session,
                    pool_id=POOL_ID,
                    occurred_on=date.fromisoformat(x["date"]),
                    direction=spec["direction"],
                    nature=spec["nature"],
                    fund_nature=spec["fund_nature"],
                    accounting_attribute=spec["accounting_attribute"],
                    category=spec["category"],
                    amount=x["amt"],
                    note=x["note"] or spec["category"],
                    actor=ACTOR,
                    user=admin,
                )
            ok += 1
        except Exception as exc:  # noqa: BLE001 - 逐行隔离，失败留人工
            failed.append((x, spec, str(exc)[:120]))

    print(f"\n写入成功 {ok} 条，失败 {len(failed)} 条")
    for x, spec, err in failed:
        print(f"  !! {x['date']} {spec['category']} {x['amt']} {x['note']!r} → {err}")

    if apply and not failed:
        session.commit()
        print("已提交。")
    else:
        session.rollback()
        print("已滚回（dry-run 或有失败行，全部不落地）。")
    session.close()


if __name__ == "__main__":
    main()
