"""E2E 夹具：创建用于「售出账号」等页面流程的客户（买家）。

为什么需要：库存售出弹窗的「买家」下拉来自 /customers，空库时下拉无选项，
upgrade-integration「页面售出绑定操作人…」会在选买家这一步超时。
foundation 种子与验收种子都不建客户，故此处单独补齐。

仅用于本地 E2E，写入隔离的 heijin_erp_e2e.db（绝不碰生产库）。
幂等：e2e_backend.sh 每次运行都会重建库；若库内已有同名客户则跳过。
"""
from __future__ import annotations

import sys
from pathlib import Path

from sqlalchemy import select

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from app.core.database import Base, get_engine, get_session_factory  # noqa: E402
from app.domain.parties import Customer  # noqa: E402
from app.parties import service as parties_service  # noqa: E402

FIXTURE_CUSTOMERS = [
    {"display_name": "[E2E 夹具] 买家甲", "phone": "13800000001", "source": "E2E"},
    {"display_name": "[E2E 夹具] 买家乙", "phone": "13800000002", "source": "E2E"},
]


def main() -> None:
    Base.metadata.create_all(get_engine())
    session = get_session_factory()()
    try:
        for fixture in FIXTURE_CUSTOMERS:
            name = fixture["display_name"]
            existing = session.scalar(
                select(Customer).where(Customer.display_name == name)
            )
            if existing is not None:
                print(f"[e2e-customers] SKIP：{name} 已存在（id={existing.id}）")
                continue
            customer = parties_service.create_customer(
                session,
                display_name=name,
                phone=fixture["phone"],
                source=fixture["source"],
                actor="admin",
                note="[E2E 夹具] 售出流程用买家",
            )
            print(f"[e2e-customers] 已创建客户：{name}（id={customer.id}）")
        session.commit()
    finally:
        session.close()


if __name__ == "__main__":
    main()
