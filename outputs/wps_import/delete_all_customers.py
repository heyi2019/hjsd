"""清空客户主数据（customers）与其需求池（customer_leads）。

背景：WPS 订单表没有「客户」列，客户无法与订单建立可靠的归属关系；
2026-11-02 用户裁决把客户主数据整体清空重建，CUS/REQ 编号按规矩不回退
（删除后下一次分别从 CUS0017 / REQ0013 起，见 document_sequences）。

删除顺序：customer_leads（RESTRICT 外键）→ customers。
order_customer_roles 当前为空，若将来有数据会被 RESTRICT 拦住，脚本会先自检。

用法：
    python delete_all_customers.py            # dry-run，只列清单
    python delete_all_customers.py --apply    # 写库
"""

from __future__ import annotations

import argparse
import datetime
import json
import sys

sys.path.insert(0, "/Users/aries/黑金时代/backend")

from sqlalchemy import create_engine, select, text  # noqa: E402
from sqlalchemy.orm import Session  # noqa: E402

from app.core.audit import record_audit  # noqa: E402
from app.core.settings import get_settings  # noqa: E402

# 副作用导入：ORM flush 要对全部 mapper 做表排序，缺任何一个域都会抛
# NoReferencedTableError（如 customer_leads.owner_id → users、converted_order_id → orders）。
import app.domain.attachments  # noqa: F401,E402
import app.domain.foundation  # noqa: F401,E402
import app.domain.imports  # noqa: F401,E402
import app.domain.lists  # noqa: F401,E402
import app.domain.notifications  # noqa: F401,E402
import app.domain.options  # noqa: F401,E402
import app.domain.quality  # noqa: F401,E402
import app.domain.trade  # noqa: F401,E402
import app.domain.users  # noqa: F401,E402
from app.domain.parties import Customer, CustomerLead, OrderCustomerRole  # noqa: E402

ACTOR = "data-cleanup"


def snapshot(session: Session, path: str) -> None:
    payload: dict[str, list[dict]] = {}
    for table in ("customers", "customer_leads", "order_customer_roles"):
        cols = [d[0] for d in session.execute(text(f"select * from {table} limit 0")).cursor.description]
        payload[table] = [
            dict(zip(cols, row)) for row in session.execute(text(f"select * from {table}"))
        ]
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, ensure_ascii=False, indent=2, default=str)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--actor", default=ACTOR)
    args = ap.parse_args()

    engine = create_engine(get_settings().alembic_url)
    session = Session(engine)
    try:
        customers = list(session.scalars(select(Customer).order_by(Customer.id)))
        leads = list(session.scalars(select(CustomerLead).order_by(CustomerLead.id)))
        roles = list(session.scalars(select(OrderCustomerRole)))

        print(f"=== 待删客户 {len(customers)} 条 ===")
        for c in customers:
            print(
                f"  {c.id:>3} {c.customer_no} | {c.display_name} | status={c.status}"
                f" | source={c.source} | note={(c.note or '')[:30]}"
            )
        print(f"=== 待删需求池 {len(leads)} 条 ===")
        cust_no = {c.id: c.customer_no for c in customers}
        for lead in leads:
            print(
                f"  {lead.id:>3} {lead.lead_no} | 客户={cust_no.get(lead.customer_id, lead.customer_id)}"
                f" | {lead.request_type} | {lead.target[:30]}"
            )
        print(f"=== order_customer_roles 引用 {len(roles)} 条 ===")

        if roles:
            print("\n[中止] 订单已挂客户角色，先处理再删。")
            return

        if not args.apply:
            print("\n[dry-run] 未写库。加 --apply 执行。")
            return

        stamp = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
        bak = f"/Users/aries/黑金时代/outputs/wps_import/bak_delete_customers_{stamp}.json"
        snapshot(session, bak)
        print(f"\n快照：{bak}")

        for lead in leads:
            record_audit(
                session,
                action="LEAD_DELETE",
                entity_type="customer_lead",
                entity_id=lead.id,
                actor=args.actor,
                before={"lead_no": lead.lead_no, "customer_id": lead.customer_id, "target": lead.target},
                reason="客户主数据整体重建，需求池连带清除",
            )
            session.delete(lead)
        session.flush()

        for c in customers:
            record_audit(
                session,
                action="CUSTOMER_DELETE",
                entity_type="customer",
                entity_id=c.id,
                actor=args.actor,
                before={
                    "customer_no": c.customer_no,
                    "display_name": c.display_name,
                    "phone": c.phone,
                    "wechat": c.wechat,
                    "qq": c.qq,
                    "source": c.source,
                    "status": c.status,
                },
                reason="客户主数据整体重建（WPS 订单无客户列，归属不可靠）",
            )
            session.delete(c)
        session.flush()
        session.commit()

        left_c = session.execute(text("select count(*) from customers")).scalar()
        left_l = session.execute(text("select count(*) from customer_leads")).scalar()
        print(f"\n[done] customers={left_c} customer_leads={left_l}")
        for key in ("CUSTOMER", "LEAD"):
            row = session.execute(
                text("select sequence_key, prefix, current_value from document_sequences where sequence_key=:k"),
                {"k": key},
            ).first()
            if row:
                print(f"  编号序列保留：{row[0]} 前缀{row[1]} 当前={row[2]}（下次 +1，不复用）")
    finally:
        session.close()


if __name__ == "__main__":
    main()
