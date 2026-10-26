"""E2E 夹具：创建「干净」的 IN_STOCK 账户（RECOVERY / PICKUP / CONSIGNMENT 各一）。

为什么单独建：business-write 的真实写入联调用例（五类业务写入、自营分期出售、逾期返点提醒）
要求账户处于 IN_STOCK 且**未被事件消耗**。scripts/seed_batch_acceptance_orders.py 会为这些账户
挂 BUY/SELL 事件，把它们从 IN_STOCK 转成 SOLD/INSTALLMENT，反而把用例需要的 IN_STOCK 账户吃掉了。
故此处单独补一组 pristine 账户（game_account 带 [E2E 夹具] 标记，与验收种子账户互不干扰）。

仅用于本地 E2E，写入隔离的 heijin_erp_e2e.db（绝不碰生产库）。
幂等：e2e_backend.sh 每次运行都会 rm 旧库重建，故此处不强制去重；若库已含同名账户则跳过以防重复。
"""
from __future__ import annotations

import sys
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from app.accounts import service as accounts_service  # noqa: E402
from app.core.database import Base, get_engine, get_session_factory  # noqa: E402

# (inventory_type, business_mode) —— 与验收种子一致且经其验证合法。
# 每组建多个：business-write 中部分用例会为账户挂 BUY 事件（把账户转出 IN_STOCK），
# 而另一些用例要求 IN_STOCK 且未消耗的账户，故预留足够库存，避免被「吃掉」后无账户可用。
FIXTURE_ACCOUNTS = [
    ("RECOVERY", "SELF"),
    ("PICKUP", "DISTRIBUTION"),
    ("CONSIGNMENT", "DISTRIBUTION"),
]
FIXTURE_PER_TYPE = 5


def main() -> None:
    Base.metadata.create_all(get_engine())
    session = get_session_factory()()
    try:
        for inventory_type, business_mode in FIXTURE_ACCOUNTS:
            for i in range(1, FIXTURE_PER_TYPE + 1):
                game_account = f"[E2E 夹具] {inventory_type}-IN_STOCK-{i}"
                try:
                    accounts_service.create_account(
                        session,
                        game_account=game_account,
                        game_type="王者荣耀",
                        platform="E2E 夹具平台",
                        business_mode=business_mode,
                        inventory_type=inventory_type,
                        actor="admin",
                        note=f"[E2E 夹具] {inventory_type} 在库账户 #{i}",
                    )
                    print(f"[e2e-accounts] 已创建 IN_STOCK 账户：{game_account}")
                except Exception as exc:  # 库已含同名账户（非 rebuild 场景）则跳过
                    session.rollback()
                    print(f"[e2e-accounts] SKIP：{game_account}（{exc}）")
        session.commit()
    finally:
        session.close()


if __name__ == "__main__":
    main()
