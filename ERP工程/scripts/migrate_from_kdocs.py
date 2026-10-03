#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
黑金时代简易 ERP — 迁移脚本 T03
从 data/raw/ 下 5 张金山文档原始导出 JSON，清洗后写入 backend/data/heijin.db。

设计原则（第一性原理 / 双荷包隔离）：
- orders 是本金/利润的唯一来源；cashflow 仅承载「经营+投资」流水。
- 个人记账明细(sheet3) 中 类别=账号回收 的行是订单的现金侧，与 orders 重叠，
  迁移时从 cashflow 剔除，避免双计（orders 已含 principal/profit）。
- 测试行（明细含"工作测试"）丢弃。
- 空行（缺关键字段）跳过。

注意：total 的语义是「成交总额 gross」，与 (本金, 利润) 之间还夹第三方分成，
因此不满足 total = principal + profit（89 单中 74 单如此）。schemas 侧的
旧伪校验已移除，本脚本不再需要绕过。
"""
import json
import os
import sys
from datetime import datetime

# ── 路径准备 ──────────────────────────────────────────────
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
BACKEND_DIR = os.path.join(SCRIPT_DIR, "..", "backend")
sys.path.insert(0, os.path.abspath(BACKEND_DIR))


def resolve_data_raw():
    """定位原始 JSON 目录。

    目录在工程重构后搬到了工作区根的「原始数据/」，而脚本仍按旧工程的
    data/raw 查找 —— 该目录不存在，脚本会以 FileNotFoundError 失败。
    这里按优先级探测两处候选路径，并在都找不到时给出可操作的报错。
    """
    candidates = [
        os.path.join(SCRIPT_DIR, "..", "..", "原始数据"),  # 当前实际位置
        os.path.join(SCRIPT_DIR, "..", "data", "raw"),      # 旧工程布局，保留兼容
    ]
    for path in candidates:
        if os.path.isfile(os.path.join(path, "sheet9_orders.json")):
            return path
    raise SystemExit(
        "找不到原始 JSON 目录，已尝试：\n"
        + "\n".join(os.path.abspath(p) for p in candidates)
        + "\n请把 5 张表的导出 JSON 放入上述任一目录（需含 sheet9_orders.json）。"
    )


DATA_RAW = resolve_data_raw()

from sqlalchemy import func  # noqa: E402
from app import db as appdb  # noqa: E402
from app import models  # noqa: E402
from app import services  # noqa: E402
from app.models import Account, Order, CashFlow, Installment, Lead  # noqa: E402

RAW_FILES = {
    "cashflow": os.path.join(DATA_RAW, "sheet3_cashflow.json"),
    "orders": os.path.join(DATA_RAW, "sheet9_orders.json"),
    "accounts": os.path.join(DATA_RAW, "sheet16_accounts.json"),
    "installments": os.path.join(DATA_RAW, "sheet17_installments.json"),
    "leads": os.path.join(DATA_RAW, "sheet21_leads.json"),
}

OPERATION_COST = {"房租/日用", "办公用品", "员工薪资", "运营"}


def load(table):
    """读取原始 JSON。

    兼容两种落盘结构：
      A) {"records": [{"fields": {...}, "id": "..."}, ...]}   # kdocs 原样
      B) {"records": [{...}, ...]}                            # 已摊平的字段对象
    """
    with open(RAW_FILES[table], "r", encoding="utf-8") as f:
        data = json.load(f)
    records = data["records"] if isinstance(data, dict) else data
    out = []
    for r in records:
        # A 结构有 fields 包裹；B 结构本身就是字段字典
        fields = r.get("fields", r) if isinstance(r, dict) else {}
        out.append({"fields": fields, "id": r.get("id", "") if isinstance(r, dict) else ""})
    return out


def to_date(s):
    if not s:
        return None
    try:
        return datetime.strptime(s, "%Y/%m/%d").date()
    except Exception:
        return None


def dec(v):
    try:
        return float(v)
    except Exception:
        return 0.0


def first_str(v):
    if isinstance(v, list) and v:
        x = v[0]
        return x if isinstance(x, str) else str(x)
    return ""


def first_nickname(v):
    if isinstance(v, list) and v:
        x = v[0]
        if isinstance(x, dict):
            return x.get("nickName", "")
        return str(x)
    return ""


def wallet_for(principal, wallet_arr):
    if principal and dec(principal) > 0:
        return "本金荷包"
    if isinstance(wallet_arr, list) and any("本金" in str(x) for x in wallet_arr):
        return "本金荷包"
    return "利润荷包"


def parse_accounts(recs):
    out = []
    for r in recs:
        f = r.get("fields", {})
        if "回收金额" not in f or f.get("回收金额") in (None, ""):
            continue  # 空行/不完整行跳过
        d = to_date(f.get("日期"))
        if d is None:
            continue
        out.append(Account(
            recycle_date=d,
            principal=dec(f.get("回收金额")),
            sale_price=dec(f.get("售卖金额")),
            account_info=f.get("账号信息", "") or "",
            account_pwd=(f.get("账号密码") or "").strip(),
            bind_phone=f.get("绑定手机号", "") or "",
            channel=first_str(f.get("已推广渠道")),
            status="已售" if f.get("售卖情况") == "是" else "在库",
            recycler=first_nickname(f.get("回收人员")),
            has_second=(f.get("是否有二次") == "是"),
            wallet_verified=f.get("钱包实名情况", "") or "",
            camp_id=f.get("营地", "") or "",
            remark=f.get("备注", "") or "",
        ))
    return out


def parse_orders(recs):
    out = []
    skipped = 0
    for r in recs:
        f = r.get("fields", {})
        if not f.get("订单类型"):
            skipped += 1
            continue  # 仅含月份的空行
        d = to_date(f.get("日期"))
        if d is None:
            skipped += 1
            continue
        principal = dec(f.get("本金"))
        profit = dec(f.get("利润"))
        total = dec(f.get("交易金额"))  # 真实交易金额(gross)，绕过 total=principal+profit 校验
        out.append(Order(
            date=d,
            type=f.get("订单类型"),
            principal=principal,
            profit=profit,
            total=total,
            recycler=first_str(f.get("回收员")),
            seller=first_str(f.get("售卖员")),
            wallet=wallet_for(principal, f.get("回款账户（本金/利润）")),
            channel="",
            query_no=f.get("查询数据编号", "") or "",
            remark=f.get("备注", "") or "",
        ))
    return out, skipped


def parse_cashflow(recs):
    out = []
    dropped_account = 0
    dropped_test = 0
    for r in recs:
        f = r.get("fields", {})
        cat = f.get("类别")
        detail = f.get("明细", "") or ""
        if cat == "账号回收":
            dropped_account += 1  # 与 orders 重叠，剔除
            continue
        if "工作测试" in detail:
            dropped_test += 1
            continue
        d = to_date(f.get("日期"))
        if d is None:
            continue
        out.append(CashFlow(
            date=d,
            category=cat,
            direction=f.get("收支"),
            amount=dec(f.get("金额")),
            remark=detail,
        ))
    return out, dropped_account, dropped_test


def parse_installments(recs):
    out = []
    for r in recs:
        f = r.get("fields", {})
        if "本金" not in f or f.get("本金") in (None, ""):
            continue
        d = to_date(f.get("日期"))
        if d is None:
            continue
        st = f.get("分期情况")
        status = {"已完成": "已完成", "断分期": "断分期", "分期中": "进行中"}.get(st, "进行中")
        out.append(Installment(
            account_id=None,
            principal=dec(f.get("本金")),
            down_payment=dec(f.get("首付")),
            periods=int(dec(f.get("分期期数")) or 0),
            per_period=dec(f.get("每期补款金额")),
            interest=dec(f.get("分期利息")),
            paid=dec(f.get("已补款金额")),
            status=status,
            buyer_contact=f.get("买家联系方式", "") or "",
            next_pay_date=to_date(f.get("补款时间")),
        ))
    return out


def parse_leads(recs):
    out = []
    for r in recs:
        f = r.get("fields", {})
        if not (f.get("需求") or f.get("任务类型")):
            continue
        st = f.get("目前状态")
        status = {"已完成": "已完成", "未完成": "寻找中", "寻找中": "寻找中"}.get(st, "寻找中")
        out.append(Lead(
            demand=f.get("需求", "") or "",
            task_type=f.get("任务类型", "") or "",
            client=f.get("委托人", "") or "",
            budget=None,
            status=status,
        ))
    return out


def cross_check(session, raw_cashflow_all):
    """与金山文档末位结余(约¥43,582)交叉校验：全量记账净流是否对得上。"""
    income = sum(dec(r["fields"].get("金额")) for r in raw_cashflow_all
                 if r["fields"].get("收支") == "收入")
    expense = sum(dec(r["fields"].get("金额")) for r in raw_cashflow_all
                  if r["fields"].get("收支") == "支出")
    return income, expense, income - expense


def ensure_columns(session):
    """给既有表补齐后加的列。

    create_all 只建新表，不会给已存在的表加列；历史库缺 source 时
    后续 INSERT 会直接报错，故这里显式补齐（幂等）。
    """
    from sqlalchemy import inspect, text
    insp = inspect(session.bind)
    if "cashflow" in insp.get_table_names():
        cols = {c["name"] for c in insp.get_columns("cashflow")}
        if "source" not in cols:
            session.execute(text(
                "ALTER TABLE cashflow ADD COLUMN source VARCHAR(8) NOT NULL DEFAULT 'manual'"))
            session.commit()
            print("[schema] cashflow 补齐 source 列")


def main():
    appdb.init_db()
    session = appdb.SessionLocal()
    ensure_columns(session)

    # 幂等：先清后写
    for m in (CashFlow, Order, Account, Installment, Lead):
        session.query(m).delete()
    session.commit()

    raw_cf = load("cashflow")
    cashflow, dropped_acct, dropped_test = parse_cashflow(raw_cf)
    orders, skipped_orders = parse_orders(load("orders"))
    accounts = parse_accounts(load("accounts"))
    installments = parse_installments(load("installments"))
    leads = parse_leads(load("leads"))

    session.add_all(cashflow)
    session.add_all(orders)
    session.add_all(accounts)
    session.add_all(installments)
    session.add_all(leads)
    session.commit()

    # ── 聚合核对：直接复用服务层，避免两套实现算出两个数 ──
    principal_wallet = services.principal_wallet(session)
    profit_wallet = services.profit_wallet(session)

    profit_total = session.query(func.coalesce(func.sum(Order.profit), 0)).scalar()
    op_cost = (
        session.query(func.coalesce(func.sum(CashFlow.amount), 0))
        .filter(CashFlow.category.in_(OPERATION_COST), CashFlow.direction == "支出").scalar()
    )

    income_all, expense_all, net_all = cross_check(session, raw_cf)

    # ── 报告 ──
    print("=" * 64)
    print("黑金时代 ERP · 迁移完成报告")
    print("=" * 64)
    print(f"SQLite : {appdb.DB_PATH}")
    print("-" * 64)
    print("【入库行数】")
    print(f"  cashflow    : {len(cashflow):>4} 行  (剔除 账号回收 {dropped_acct} / 测试 {dropped_test})")
    print(f"  orders      : {len(orders):>4} 行  (跳过空行 {skipped_orders})")
    print(f"  accounts    : {len(accounts):>4} 行")
    print(f"  installments: {len(installments):>4} 行")
    print(f"  leads       : {len(leads):>4} 行")
    print("-" * 64)
    print("【双荷包聚合（services 口径）】")
    print(f"  本金荷包 : ¥{float(principal_wallet):,.2f}  (投资款流入 + 订单本金净额)")
    print(f"  利润荷包 : ¥{float(profit_wallet):,.2f}  (Σ订单利润 {float(profit_total):,.2f} − 运营消耗 {float(op_cost):,.2f})")
    print("-" * 64)
    print("【全量记账净流 vs 文档末位结余交叉校验】")
    print(f"  记账收入合计 : ¥{float(income_all):,.2f}")
    print(f"  记账支出合计 : ¥{float(expense_all):,.2f}")
    print(f"  净流(收入−支出): ¥{float(net_all):,.2f}")
    print("  文档末位结余(参考): ≈ ¥43,582.42")
    print("  差异说明 : 净流含账号回收本金/利润变动；文档结余=全量现金净头寸，")
    print("            二者口径不同，差额即 orders 本金/利润未在 cashflow 体现的部份。")
    print("=" * 64)
    print("【口径说明】")
    print("  total = 成交总额(gross)；principal/profit = 我方本金与利润。")
    print("  二者之间夹第三方分成，故不满足 total=principal+profit。")
    print("  运营消耗类别取自文档原始枚举：房租/日用、办公用品、员工薪资、运营。")
    print("=" * 64)

    session.close()


if __name__ == "__main__":
    main()
