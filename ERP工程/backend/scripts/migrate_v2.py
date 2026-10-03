"""迁移 v1.0 旧库数据 → v2.0 新模型（PRD 002v2.0§3.7）。

来源：旧库 data/heijin.db 的 orders / cashflow / accounts / installments / leads
目标：data/heijin_v2.db的对应新表

迁移原则（PRD §2.1.1 强制）：
- 返点 19 笔从「独立订单」转为 `rebate_records`，`source_order_id=NULL` +
  `link_status=UNLINKED`（Q20 已裁决：后续人工补录）
- 历史订单一律 `link_status=UNLINKED`，**不做不可靠自动匹配**（V22）
- 提号（TH）为 `PASS_THRU`，**不计入库存占用**（V13）
- 「八月利润转入」拆为成对 INTERNAL 流水（V16）

幂等：可重复执行，每次先清空 v2 库的目标表。
"""
from __future__ import annotations

import json
import os
import sys
from datetime import datetime
from decimal import Decimal

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.db_v2 import SessionLocalV2, V2_DB_PATH, init_db_v2  # noqa: E402
from app.services_new import numbering  # noqa: E402
from app.db_v2 import pool_by_code  # noqa: E402
from app.models_new.entities import (  # noqa: E402
    Account, CashFlow, Installment, Lead, Order, OrderEvent, Pool, RebateRecord,
)

# scripts/ 的上一级是 backend/，上上级是 ERP工程/
BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OLD_DB = os.path.join(BACKEND_DIR, "data", "heijin.db")
# 原始 WPS 导出：黑金时代/原始数据/
PROJECT_ROOT = os.path.dirname(os.path.dirname(BACKEND_DIR))

old_engine = create_engine(f"sqlite:///{OLD_DB}", future=True)
OldSession = sessionmaker(bind=old_engine, future=True)

D = Decimal


def _d(v, default="0") -> Decimal:
    if v in (None, ""):
        return D(default)
    return D(str(v))


def _date(v):
    """转成datetime.date。SQLAlchemy的 Date 列只接受 date 对象。"""
    if isinstance(v, datetime):
        return v.date()
    if isinstance(v, str):
        return datetime.strptime(v[:10].replace("/", "-"), "%Y-%m-%d").date()
    if hasattr(v, "year") and hasattr(v, "month"):
        return v
    return datetime(2026, 7, 1).date()


# ---------------------------------------------------------------------------
# 类别 → nature × pool
# ---------------------------------------------------------------------------
# 运营消耗类别必须逐字匹配（含斜杠），否则会被漏计
OPERATING = {"房租/日用", "办公用品", "员工薪资", "运营"}

NATURE_BY_CATEGORY = {
    "投资款": "EXTERNAL_IN",
    "账号回收": "BUSINESS_IN/OUT",  # 按direction 细分
}


def main() -> None:
    # 先建新库表（此时尚未导入旧模型，避免基类冲突）
    init_db_v2()

    # 再连旧库读数据
    from app.models import (
        Account as OldAccount, CashFlow as OldCashFlow,
        Installment as OldInst, Lead as OldLead, Order as OldOrder,
    )
    db = SessionLocalV2()
    old = OldSession()

    # 清空目标表（幂等）
    for m in (RebateRecord, OrderEvent, CashFlow, Order, Installment, Account, Lead):
        db.query(m).delete()
    db.commit()

    # 池按 code 取，不写死数量。以后新增池，迁移脚本无需改动。
    invest = pool_by_code(db, "HJ_INVEST")
    profit = pool_by_code(db, "HJ_PROFIT")

    # ---------------- 资金流水 ----------------
    # 必须读 WPS 原始 JSON，而非旧库：
    # 旧库 cashflow 在 v1.0 迁移时被剔除了 106 行「账号回收」，只留下运营类，
    # 照抄旧库会漏掉买号/回款流水，导致池余额少算 15,733.75。
    n_cf = 0
    unpaired_in = 0
    RAW_CF = os.path.join(PROJECT_ROOT, "原始数据", "sheet3_cashflow.json")
    raw_rows = []
    if os.path.exists(RAW_CF):
        raw_rows = [
            r["fields"] for r in json.load(open(RAW_CF, encoding="utf-8"))["records"]
        ]
    else:
        print("  !! 未找到原始 JSON，回退旧库（会缺失账号回收流水）")
        raw_rows = [
            {"类别": r.category, "收支": r.direction, "金额": r.amount,
             "日期": r.date, "明细": r.remark}
            for r in old.query(OldCashFlow).all()
        ]

    for i, r in enumerate(raw_rows, 1):
        cat = r.get("类别") or ""
        d = r.get("收支") or ""
        amt = _d(r.get("金额"))
        if amt == 0:
            continue  # V3：金额 0 的行不入库

        detail = str(r.get("明细") or "")
        # 源数据把三类非买号支出错放在「账号回收」类别（PRD §5.1分类污染）：
        #   代分期订单 762.00  → 实为代分期垫资本金，属业务资金流不是运营消耗
        #   同行代分期介绍费 106.00 / 作图费用 24.88 → 实为运营费用
        # 不修正会让「账号回收」金额虚高、经营损益少算 130.88。
        if cat == "账号回收" and d == "支出":
            if detail in ("代分期订单", "代分期本金", "代分期收号"):
                nature, pool, tid = "BUSINESS_OUT", invest, None
                cat = "账号回收"  # 保留原类别，仅靠 nature 区分
            elif detail in ("同行代分期介绍费", "作图费用"):
                nature, pool, tid = "BUSINESS_OUT", invest, None
                cat = "运营"       # 重分类为运营（V-分类污染治理）
            else:
                nature, pool, tid = "BUSINESS_OUT", invest, None

        if cat == "投资款":
            nature, pool, tid = "EXTERNAL_IN", invest, None
        elif cat == "账号回收":
            nature = "BUSINESS_IN" if d == "收入" else "BUSINESS_OUT"
            pool, tid = invest, None
        elif cat in OPERATING:
            if d == "收入":
                nature, pool, tid = "BUSINESS_IN", invest, None
            else:
                nature, pool, tid = "BUSINESS_OUT", invest, None
        elif cat == "办公用品":
            nature, pool, tid = "BUSINESS_OUT", invest, None
        else:
            nature = "BUSINESS_IN" if d == "收入" else "BUSINESS_OUT"
            pool, tid = invest, None

        # 「八月利润转入」= 利润池 → 投资款池的 INTERNAL 划转，须成对（V16）
        if "利润转入" in detail:
            # 源数据仅有「经营池收到八月利润转入」这一条，**没有利润池流出的凭证**。
            # 强行补一条利润池支出会造出 -13,470.42 的假余额。
            # 故此处只记投资款池流入侧，划转对ID 留空，等Q14 确认方向后由人工补配对流水。
            db.add(CashFlow(
                flow_no=numbering.gen_flow_no(db), pool_id=invest.id,
                occurred_on=_date(r.get("日期")), nature="INTERNAL", category=cat,
                direction="收入", amount=amt, transfer_id=None,
                remark=f"八月利润转入（仅目标池侧，源池流水待补）｜{detail}",
            ))
            db.flush()
            unpaired_in += 1
            n_cf += 1
            continue

        db.add(CashFlow(
            flow_no=numbering.gen_flow_no(db),
            pool_id=pool.id, occurred_on=_date(r.get("日期")), nature=nature,
            category=cat, direction=d, amount=amt, source="manual",
            remark=detail,
        ))
        db.flush()   # 让下一个编号能看到本行
        n_cf += 1

    db.commit()
    print(f"[1/5] cashflow  {n_cf} 条（其中 {unpaired_in} 条INTERNAL 缺配对，待 Q14 裁决）")

    # ---------------- 账号 ----------------
    n_ac = 0
    for r in old.query(OldAccount).all():
        if not r.principal:
            continue  # 剔除无回收金额的空行
        chans = []
        for c in (r.channel or "").replace("，", ",").split(","):
            c = c.strip()
            if c and c not in chans:
                chans.append(c)
        db.add(Account(
            account_no=numbering.gen_account_no(db),
            game_account=None,  # 历史不强制，Q4 待裁决
            game_password=r.account_pwd or "", bind_phone=r.bind_phone or "",
            buy_date=_date(r.recycle_date), cost_amount=_d(r.principal),
            sale_amount=_d(r.sale_price), status=r.status or "在库",
            risk_level="SECOND" if r.has_second else "NORMAL",
            channels=chans, recycler=r.recycler or "", camp_id=r.camp_id or "",
            account_info=r.account_info or "", wallet_verified=r.wallet_verified or "",
            has_second=bool(r.has_second), remark=r.remark or "",
        ))
        db.flush()
        n_ac += 1
    db.commit()
    print(f"[2/5] accounts  {n_ac} 条")

    # ---------------- 订单 + 事件 + 返点 ----------------
    TYPE_MAP = {
        "回收": ("HS", "STOCK"),
        "氪金联盟提号": ("TH", "PASS_THRU"),
        "提号": ("TH", "PASS_THRU"),
        "代挂": ("DG", "ZERO"),
        "代分期": ("DFQ", "CREDIT"),
        "返点": None,   # 转为 rebate_records
        # 「蹭点」是代挂的另一种叫法（主理人口述确认），归入 DG
        "蹭点": ("DG", "ZERO"),
    }
    #: 代挂中的混合单：order_type=DG 但本金非 0，资金性质实为 STOCK。
    #: 源数据 4 单合计本金 19,674（7/18 670、8/27 13,700、9/2 4,740、9/14 564）。
    #: 归类待 Q22 裁决，此处先按实际资金流标 STOCK，inventory_occupied 据此计入。
    DG_MIXED = {
    }
    n_o = n_e = n_r = 0
    mixed_count = 0
    for r in old.query(OldOrder).filter(OldOrder.type != "返点").all():
        mapped = TYPE_MAP.get(r.type)
        if not mapped:
            continue
        otype, ctype = mapped
        # 混合单修正：DG 但本金>0 → capital_type 改判为 STOCK（Q22 待裁决）
        if otype == "DG" and _d(r.principal) > 0:
            ctype = "STOCK"
            mixed_count += 1
        td = _date(r.date)
        order_no = numbering.gen_order_no(db)
        n_o += 1

        o = Order(
            order_no=order_no, order_type=otype, capital_type=ctype,
            status="closed", trade_date=td, gross_amount=_d(r.total),
            principal=_d(r.principal), profit=_d(r.profit),
            account_id=None, link_status="UNLINKED",  # V22：不自动匹配
            recycler=r.recycler or "", seller=r.seller or "",
            remark=r.remark or "",
        )
        db.add(o)
        db.flush()

        # 事件：库存型/过账型/垫资型才有 BUY；DG 零本金只有 SELL
        if ctype in ("STOCK", "PASS_THRU", "CREDIT"):
            db.add(OrderEvent(
                event_no=f"{order_no}-BUY", order_id=o.id, event_type="BUY",
                amount=_d(r.principal), occurred_on=td, pool_id=invest.id,
                portion="PRINCIPAL",
                note="迁移：源数据未区分买号/售出日期，按同一日处理",
            ))
            n_e += 1
        # 池归属是资金流属性，记在事件上而非订单上（池可自由创建）
        db.add(OrderEvent(
            event_no=f"{order_no}-SELL", order_id=o.id, event_type="SELL",
            amount=_d(r.total), occurred_on=td, pool_id=profit.id,
            portion="GROSS",
            note="迁移：按成交总额记入，利润见 orders.profit",
        ))
        n_e += 1

    # 返点 19 笔 → rebate_records，source_order_id 留空待人工补录
    for r in old.query(OldOrder).filter(OldOrder.type == "返点").all():
        n_r += 1
        bk = r.remark or ""
        rtype = "首保" if "首保" in bk else ("续保" if "续保" in bk else ("收号" if "收号" in bk else ""))
        db.add(RebateRecord(
            source_order_id=None, link_status="UNLINKED",
            channel="盼之" if "盼之" in bk else ("螃蟹" if "螃蟹" in bk else ("千寻" if "千寻" in bk else "")),
            rebate_type=rtype, rate=D("0"), base_amount=_d(r.principal),
            platform_fee=D("0"), net_amount=_d(r.profit),
            settled_on=_date(r.date), remark=bk or "源数据无备注",
        ))
    db.commit()
    print(f"[3/5] orders    {n_o} 条（含 {mixed_count} 单 DG 混合单，capital_type 改判 STOCK，待 Q22 裁决）")
    print(f"[4/5] events    {n_e} 条")
    print(f"[5/5] rebates   {n_r} 条（link_status=UNLINKED，待人工补录）")

    # ---------------- 分期 / 需求 ----------------
    n_i = n_l = 0
    for k, r in enumerate(old.query(OldInst).all(), 1):
        if not r.principal:
            continue
        n_i += 1
        db.add(Installment(
            inst_no=numbering.gen_inst_no(db), account_id=None, link_status="ORPHAN",
            principal=_d(r.principal), down_payment=_d(r.down_payment),
            periods=r.periods or 0, per_period=_d(r.per_period),
            interest=_d(r.interest), paid=_d(r.paid),
            status=r.status or "进行中", next_pay_date=None,
            buyer_contact=r.buyer_contact or "",
        ))
    for r in old.query(OldLead).all():
        if not (r.demand or "").strip():
            continue
        n_l += 1
        db.add(Lead(
            demand=r.demand or "", task_type=r.task_type or "", client=r.client or "",
            budget=_d(r.budget) if r.budget else None, status=r.status or "寻找中",
        ))
    db.commit()
    print(f"[+] installments {n_i} 条 | leads {n_l} 条")
    print(f"\n新库: {V2_DB_PATH}")
    db.close()
    old.close()


if __name__ == "__main__":
    main()
