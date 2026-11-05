"""按 WPS「订单登记及利润」K2 记录备注建客户档案。

K2：2026/11/02 00:19 打赏 700.00 / 利润 66.00，备注 w428843（客户标识）。

默认 dry-run，--apply 落库；幂等：同名客户已存在则跳过并打印既有编号。
"""
from __future__ import annotations

import sys

from app.core.database import get_session_factory
from app.core.numbering import peek_number
from app.domain.enums import SequenceKey
from app.domain.parties import Customer
from app.parties.customers import create_customer

DISPLAY_NAME = "w428843"
WECHAT = "w428843"
SOURCE = "WPS订单备注"
NOTE = "来自 WPS「订单登记及利润」2026/11/02 打赏记录备注 w428843"
ACTOR = "wps-import"


def main() -> int:
    apply = "--apply" in sys.argv
    factory = get_session_factory()
    with factory() as session:
        existing = (
            session.query(Customer)
            .filter(Customer.display_name == DISPLAY_NAME)
            .one_or_none()
        )
        if existing is not None:
            print(f"已存在：{existing.customer_no} {existing.display_name} status={existing.status}")
            return 0

        next_no = peek_number(session, SequenceKey.CUSTOMER)
        print(f"待建客户：{next_no} / {DISPLAY_NAME} / wechat={WECHAT} / source={SOURCE}")
        if not apply:
            print("dry-run，未写入；加 --apply 执行")
            return 0

        customer = create_customer(
            session,
            display_name=DISPLAY_NAME,
            actor=ACTOR,
            wechat=WECHAT,
            source=SOURCE,
            owner_id=1,
            note=NOTE,
        )
        session.commit()
        print(f"已创建：{customer.customer_no} id={customer.id} {customer.display_name} status={customer.status}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
