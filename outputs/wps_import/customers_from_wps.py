"""把 WPS「需求」表落成 ERP 客户主数据 + 客户需求池，并停用前端联调遗留的测试客户。

数据来源：kdocs 多维表 `需求` 表（17 行），字段 任务类型 / 委托人 / 日期 / 目前状态 / 需求。

口径：
- 一种「委托人」= 一个客户（display_name 即委托人昵称），source 标 `WPS需求表`。
- 任务类型 代蹲 → FIND_ACCOUNT（帮客户找号）；代出 → SELL_ACCOUNT（客户委托出售）；
  定找 → SPECIFIC_SEARCH。
- 状态「寻找中」→ OPEN（系统只有 OPEN/CONVERTED/CLOSED，没有更细的状态）。
- 预算只解析文本里能确定的数量，拿不准就留空，原文全部留在 target 里。
- 空行 / 无委托人的行不导入，单独列出待人工确认。

用法：
    python customers_from_wps.py            # dry-run，只打印计划
    python customers_from_wps.py --apply    # 真正写库
"""

from __future__ import annotations

import argparse
import re
import sys
from decimal import Decimal
from pathlib import Path

sys.path.insert(0, "/Users/aries/黑金时代/backend")

from sqlalchemy import create_engine, select, text  # noqa: E402
from sqlalchemy.orm import Session  # noqa: E402

from app.core.settings import get_settings  # noqa: E402
from app.domain.parties import Customer  # noqa: E402
from app.parties import customers as customers_service  # noqa: E402
from app.parties import leads as leads_service  # noqa: E402

ACTOR = "wps-import"

# WPS 需求表 17 行原样（任务类型 / 委托人 / 需求正文）
LEADS: list[dict] = [
    {"type": "代蹲", "who": "周周", "text": "低场次700皮以上的  1.5w预算  女号"},
    {"type": "定找", "who": None, "text": ""},
    {"type": "代出", "who": "安妮", "text": "💰7888 二 IV极品无双v10 9w流光 积分 小国标镜 金标瑶、妲己、裴擒虎（有梅西）、庄周 无一丑 背包2水晶 9k紫星币 1.3k点卷 1.3k荣耀积分 5水 11无 7珍品 99传说 1小兵 总皮616 粉乔 游龙 紫瑶 8星传说 营地：营地358917163", "date": "2026-07-25"},
    {"type": None, "who": None, "text": ""},
    {"type": None, "who": None, "text": ""},
    {"type": None, "who": None, "text": ""},
    {"type": "代蹲", "who": "周周", "text": "3w内预算，满小兵，接近满皮"},
    {"type": "代蹲", "who": "周周", "text": "9k预算，漂亮星元，女无双全"},
    {"type": "代蹲", "who": "周周", "text": "700p以上 最好是aq 有二次 有妲己/蔡文姬金灵宝的号 预算最高1.8w"},
    {"type": "代蹲", "who": "周周", "text": "7k-8k无双珍品尽可能满，女号，慕夏全套"},
    {"type": "代蹲", "who": "周周", "text": "相柳，越低越好"},
    {"type": "代蹲", "who": "周周", "text": "福星绿巧隐藏，不缺绝版  2.5w预算"},
    {"type": "代出", "who": "淮黎", "text": "🥬秒杀 1499 IQ小国标马克 1水 1无 10珍传 29传 1683903615，有二，千寻续保 喜欢dd", "date": "2026-07-25"},
    {"type": "代出", "who": "淮黎", "text": "💰4688 IQ精品无双v10 77段中路 奥特曼已补 7水 6无 11珍传 62传 总皮589 1小国（扁鹊） 12金标（安琪拉 不知火舞 杨玉环 甄姬等） 营地：373584828 喜欢d", "date": "2026-07-25"},
    {"type": "代出", "who": "淮黎", "text": "💰1288 AQv8精氪漂亮号 2水 2无 1珍传 16传 总皮296 瑶 西施 大乔 小乔 少思源 海诺 营地：1829364534", "date": "2026-07-25"},
    {"type": "代出", "who": "周周", "text": "苹果q区654皮肤 星耀 无双贵族 营地361223847 小国小乔西施 小乔妲己安琪拉西施甄姬玉环昭君女辅助均全皮", "date": "2026-07-25"},
    {"type": "代出", "who": None, "text": ""},
]

TYPE_MAP = {"代蹲": "FIND_ACCOUNT", "代出": "SELL_ACCOUNT", "定找": "SPECIFIC_SEARCH"}

# 客户推进：三三（id=1）为默认归属人，避免客户无主
OWNER_ID = 1

# 前端联调遗留的测试客户（按 display_name 识别，逐条列出便于复核）
TEST_CUSTOMERS = [
    "111111",
    "1112322",
    "111",
    "1111",
    "测试回收客户01",
    "测试回收客户02",
    "测试代挂客户01",
    "测试买家-HS0004",
    "测试分期买家-TH0002",
    "测试客户-全页面-20261101",
    "测试客户-手机号格式-20261101",
    "测试代挂客户-120261101-02",
    "测试代挂客户-20261101-02",
]


def parse_budget(text_value: str) -> Decimal | None:
    """只解析能确定金额的表达，含糊的一律留空。"""
    if not text_value:
        return None
    # 💰7888 / 秒杀 1499 这类明确标价
    m = re.search(r"💰\s*(\d+(?:\.\d+)?)", text_value) or re.search(
        r"秒杀\s*(\d+(?:\.\d+)?)", text_value
    )
    if m:
        return Decimal(m.group(1))
    # 预算最高1.8w / 2.5w预算 / 9k预算 / 3w内预算 / 1.5w预算
    m = re.search(r"(\d+(?:\.\d+)?)\s*([wWkK])\s*(?:内)?(?:预算|$)", text_value) or re.search(
        r"预算(?:最高)?\s*(\d+(?:\.\d+)?)\s*([wWkK])", text_value
    )
    if m:
        value = Decimal(m.group(1))
        return value * 10000 if m.group(2).lower() == "w" else value * 1000
    # 7k-8k 取上限
    m = re.search(r"(\d+(?:\.\d+)?)\s*[kK]\s*[-~]\s*(\d+(?:\.\d+)?)\s*[kK]", text_value)
    if m:
        return Decimal(m.group(2)) * 1000
    return None


def next_customer_seq(session: Session, max_existing: int) -> tuple[int, int]:
    current = session.execute(
        text("select current_value from document_sequences where sequence_key='CUSTOMER'")
    ).scalar()
    return int(current or 0), max_existing


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true", help="真正写库；缺省只 dry-run")
    args = ap.parse_args()

    engine = create_engine(get_settings().alembic_url)
    session = Session(engine)
    try:
        existing = list(session.scalars(select(Customer).order_by(Customer.id)))
        by_name = {c.display_name: c for c in existing}
        max_no = max(
            (int(c.customer_no.removeprefix("CUS")) for c in existing if c.customer_no), default=0
        )
        cur_seq, _ = next_customer_seq(session, max_no)

        plan_customers = []
        for row in LEADS:
            who = row["who"]
            if not who or who in plan_customers:
                continue
            plan_customers.append(who)

        print("=" * 78)
        print(f"客户序列 current_value={cur_seq}，现有最大编号 CUS{max_no:04d}")
        if cur_seq < max_no:
            print(f"  !! 序列落后，需先校正为 {max_no}，否则会撞号")
        print()
        print("=== 计划新建客户 ===")
        for name in plan_customers:
            state = "已存在，跳过" if name in by_name else "新建"
            print(f"  {name:6s} {state}")
        print()
        print("=== 计划写入需求池（{} 条）===".format(sum(1 for r in LEADS if r["who"])))
        for i, row in enumerate(LEADS, start=1):
            if not row["who"]:
                print(f"  [{i:2d}] 跳过：{'无任务类型' if not row['type'] else '无委托人'} | {row['text'][:30]}")
                continue
            budget = parse_budget(row["text"])
            print(
                f"  [{i:2d}] {row['who']:4s} {row['type']:3s}->{TYPE_MAP[row['type']]:15s}"
                f" 预算={budget if budget is not None else '—':>8}  {row['text'][:28]}"
            )
        print()
        print("=== 计划停用测试客户 ===")
        to_disable = []
        for name in TEST_CUSTOMERS:
            c = by_name.get(name)
            if c is None:
                continue
            if c.status == "MERGED":
                print(f"  {c.customer_no} {name:24s} 已是 MERGED，保持不动")
                continue
            if c.status == "DISABLED":
                print(f"  {c.customer_no} {name:24s} 已是 DISABLED，跳过")
                continue
            to_disable.append(c)
            print(f"  {c.customer_no} {name:24s} ACTIVE -> DISABLED")
        print()

        if not args.apply:
            print("dry-run 结束。加 --apply 才写库。")
            return

        # 1) 校正客户编号序列
        if cur_seq < max_no:
            session.execute(
                text(
                    "update document_sequences set current_value=:v where sequence_key='CUSTOMER'"
                ),
                {"v": max_no},
            )
            session.flush()
            print(f"序列已校正：CUSTOMER current_value {cur_seq} -> {max_no}")

        # 2) 建客户
        created = []
        for name in plan_customers:
            if name in by_name:
                created.append(by_name[name])
                continue
            c = customers_service.create_customer(
                session,
                display_name=name,
                actor=ACTOR,
                source="WPS需求表",
                owner_id=OWNER_ID,
                note="由 WPS「需求」表导入，委托人昵称即客户称呼",
            )
            created.append(c)
            print(f"新建客户 {c.customer_no} {c.display_name}")
        session.flush()
        cmap = {c.display_name: c for c in created}

        # 3) 需求入池
        made = 0
        for row in LEADS:
            if not row["who"]:
                continue
            c = cmap[row["who"]]
            lead = leads_service.create_lead(
                session,
                customer_id=c.id,
                request_type=TYPE_MAP[row["type"]],
                target=row["text"] or "（原文为空）",
                actor=ACTOR,
                budget=parse_budget(row["text"]),
                owner_id=OWNER_ID,
                note=f"WPS 需求表导入；原始任务类型「{row['type']}」"
                + (f"；填报日期 {row['date']}" if row.get("date") else ""),
            )
            made += 1
            print(f"需求 {lead.lead_no} {c.display_name} {lead.request_type}")

        # 4) 停用测试客户
        disabled = 0
        for c in to_disable:
            customers_service.set_customer_status(
                session, c.id, "DISABLED", actor=ACTOR
            )
            disabled += 1

        session.commit()
        print()
        print(f"提交完成：客户 {len(cmap)} 个（新建 {len(cmap) - len(by_name & cmap.keys())} 视上文）、"
              f"需求 {made} 条、停用测试客户 {disabled} 个")
    except Exception:
        session.rollback()
        raise
    finally:
        session.close()


if __name__ == "__main__":
    main()
