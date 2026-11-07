"""订单夹具矩阵：HS/TH/DG × 各状态 × 关联/未关联账号，附事件/流水/返点/客户/分期/分润。

供 E2E 库、dev 沙盒库、以及后端测试 `seeded_orders_db` 夹具复用，做到「任何情况」的订单
数据都有覆盖，不再依赖测试跑剩的残留。全程幂等守卫（按稳定 order_no 跳过已存在整单），
可重复执行（keep / --reset 均安全）。

关键约束（对齐 ORM CHECK）：
  - 账号段用 90000+，远离 top-up 的 20000/20100/20200 段，绝不撞号；
  - DG 为零本金（ZERO），不建买入事件/流水；DG 无分期（走统一 SELL）；
  - 三种业务各自客户角色白名单：HS=SELLER/BUYER/(分期)INSTALLMENT_CUSTOMER、
    TH=BUYER、DG=CONSIGNOR；
  - 流水方向/性质必须合法：OUT↔BUSINESS_OUT、IN↔BUSINESS_IN；
  - owner_id / 分润 user_id 取真实 admin/employee 自增 id（不硬编码 1001/1002）。
"""
from __future__ import annotations

from app.domain import users


def seed_order_matrix(db, actor: str = "e2e") -> None:
    """幂等播种全覆盖订单矩阵到给定会话。

    `actor` 仅作审计/日志标记，目前不影响写库内容。
    """
    from datetime import date, timedelta
    from decimal import Decimal

    from app.domain.foundation import Pool
    from app.domain.parties import Customer, OrderCustomerRole
    from app.domain.trade_models.account import Account
    from app.domain.trade_models.cashflow import Cashflow, OrderProfitAllocation
    from app.domain.trade_models.deposit_rebate import RebateRecord
    from app.domain.trade_models.installment import Installment, InstallmentSchedule
    from app.domain.trade_models.order import Order, OrderEvent
    from app.domain.enums import (
        CashflowStatus,
        CustomerRole,
        Direction,
        EventType,
        InstallmentContractType,
        InstallmentStatus,
        Portion,
        RebateStatus,
        RebateType,
        ScheduleStatus,
    )

    invest_pool = db.query(Pool).filter(Pool.code == "HJ_INVEST").first()
    profit_pool = db.query(Pool).filter(Pool.code == "HJ_PROFIT").first()

    admin = db.query(users.User).filter(users.User.username == "admin").first()
    employee = db.query(users.User).filter(users.User.username == "employee").first()
    # 自洽保障：dev / 测试库未必有 employee（E2E 库由 _seed_real_* 建好，这里幂等跳过）；
    # 缺失时按 username 创建占位用户，避免硬编码 1001/1002 触发外键违例。
    if admin is None:
        admin = users.User(
            username="admin", display_name="管理员", password_hash="seed-not-real",
            role="ADMIN", owner_scope="ALL", pool_ids=[], team_ids=[], is_active=True,
        )
        db.add(admin)
    if employee is None:
        # 用 OPERATOR 而非 EMPLOYEE：dev/test 等经 alembic 迁移的库，role 约束可能未含 EMPLOYEE，
        # 而 OPERATOR 在 create_all（E2E）与 alembic（dev/test）两端均合法。
        employee = users.User(
            username="employee", display_name="员工", password_hash="seed-not-real",
            role="OPERATOR", owner_scope="SELF", pool_ids=[], team_ids=[], is_active=True,
        )
        db.add(employee)
    db.flush()
    admin_id = admin.id
    employee_id = employee.id

    # 种子客户（CUS9001/9002/9003）；空库守卫已建，兜底再确保 3 个。
    customers = db.query(Customer).order_by(Customer.id).all()
    if len(customers) < 3:
        for i, name in enumerate(["测试买家甲", "测试买家乙", "测试买家丙"], start=1):
            if db.query(Customer).filter(Customer.customer_no == f"CUS{9000 + i}").first() is None:
                db.add(Customer(
                    customer_no=f"CUS{9000 + i}",
                    display_name=name,
                    phone=f"138{80000000 + i}",
                    owner_id=1,
                    note="E2E 夹具",
                ))
        db.flush()
        customers = db.query(Customer).order_by(Customer.id).all()
    buyer_c, seller_c, consignor_c = customers[0], customers[1], customers[2]

    # (order_type, business_mode, inventory_type, status, linked)
    # 状态：ACTIVE / INSTALLMENT / COMPLETED / CANCELLED
    # DG 无分期（DG 走统一 SELL），故 DG 只含 ACTIVE/COMPLETED/CANCELLED。
    MATRIX = [
        ("HS", "SELF", "RECOVERY", "ACTIVE", True),
        ("HS", "SELF", "RECOVERY", "ACTIVE", False),
        ("HS", "SELF", "RECOVERY", "INSTALLMENT", True),
        ("HS", "SELF", "RECOVERY", "INSTALLMENT", False),
        ("HS", "SELF", "RECOVERY", "COMPLETED", True),
        ("HS", "SELF", "RECOVERY", "COMPLETED", False),
        ("HS", "SELF", "RECOVERY", "CANCELLED", True),
        ("HS", "SELF", "RECOVERY", "CANCELLED", False),
        ("TH", "DISTRIBUTION", "PICKUP", "ACTIVE", True),
        ("TH", "DISTRIBUTION", "PICKUP", "ACTIVE", False),
        ("TH", "DISTRIBUTION", "PICKUP", "INSTALLMENT", True),
        ("TH", "DISTRIBUTION", "PICKUP", "INSTALLMENT", False),
        ("TH", "DISTRIBUTION", "PICKUP", "COMPLETED", True),
        ("TH", "DISTRIBUTION", "PICKUP", "COMPLETED", False),
        ("TH", "DISTRIBUTION", "PICKUP", "CANCELLED", True),
        ("TH", "DISTRIBUTION", "PICKUP", "CANCELLED", False),
        ("DG", "DISTRIBUTION", "CONSIGNMENT", "ACTIVE", True),
        ("DG", "DISTRIBUTION", "CONSIGNMENT", "ACTIVE", False),
        ("DG", "DISTRIBUTION", "CONSIGNMENT", "COMPLETED", True),
        ("DG", "DISTRIBUTION", "CONSIGNMENT", "COMPLETED", False),
        ("DG", "DISTRIBUTION", "CONSIGNMENT", "CANCELLED", True),
        ("DG", "DISTRIBUTION", "CONSIGNMENT", "CANCELLED", False),
    ]

    base_date = date(2026, 9, 1)
    acct_seq = 90000  # 订单专用账号段，远离 top-up 段，避免撞号

    for idx, (otype, biz_mode, inv_type, status, linked) in enumerate(MATRIX):
        order_no = f"E2E-{otype}-{status}-{'L' if linked else 'U'}-{idx + 1:02d}"
        if db.query(Order).filter(Order.order_no == order_no).first() is not None:
            continue  # 幂等：整单（含子表）已存在则跳过

        trade_date = base_date + timedelta(days=idx)
        link_status = "LINKED" if linked else "UNLINKED"

        # 关联账号（专用段）：按订单状态映射账号生命周期状态。
        account_id = None
        if linked:
            acct_seq += 1
            stock_no = f"KU_{acct_seq}"
            if db.query(Account).filter(Account.stock_no == stock_no).first() is None:
                if status == "COMPLETED":
                    a_status, i_status = "SOLD", "OUT_OF_STOCK"
                elif status == "CANCELLED":
                    a_status, i_status = "VOID", "OUT_OF_STOCK"
                else:  # ACTIVE / INSTALLMENT
                    a_status, i_status = "WAITING", "IN_STOCK"
                db.add(Account(
                    stock_no=stock_no,
                    game_account=f"e2e_order_{stock_no}",
                    camp_account=f"e2e_camp_{stock_no}",
                    game_password="e2e-pwd",
                    channel_region="官服",
                    bound_phone="13800000000",
                    has_secondary=False,
                    wallet_realname="E2E",
                    business_mode=biz_mode,
                    inventory_type=inv_type,
                    status=a_status,
                    inventory_status=i_status,
                    game_type="王者荣耀",
                    cost_amount=0,
                ))
                db.flush()
            account_id = db.query(Account.id).filter(Account.stock_no == stock_no).scalar()

        order = Order(
            order_no=order_no,
            order_type=otype,
            trade_date=trade_date,
            status=status,
            link_status=link_status,
            owner_id=admin_id,
            account_id=account_id,
            account_snapshot=None,
            commission_mode=None,
            commission_payer=None,
            note=f"E2E 夹具订单 {otype}/{status}/{'关联' if linked else '未关联'}",
        )

        db.add(order)
        db.flush()

        # 客户角色（按业务类型白名单）
        role_spec = {
            "HS": [CustomerRole.SELLER.value, CustomerRole.BUYER.value]
            + ([CustomerRole.INSTALLMENT_CUSTOMER.value] if status == "INSTALLMENT" else []),
            "TH": [CustomerRole.BUYER.value],
            "DG": [CustomerRole.CONSIGNOR.value],
        }
        cust_for_role = {
            CustomerRole.SELLER.value: seller_c,
            CustomerRole.BUYER.value: buyer_c,
            CustomerRole.INSTALLMENT_CUSTOMER.value: buyer_c,
            CustomerRole.CONSIGNOR.value: consignor_c,
        }
        for role in role_spec[otype]:
            cust = cust_for_role[role]
            if db.query(OrderCustomerRole).filter(
                OrderCustomerRole.order_id == order.id,
                OrderCustomerRole.customer_id == cust.id,
                OrderCustomerRole.role == role,
            ).first() is None:
                db.add(OrderCustomerRole(
                    order_id=order.id, customer_id=cust.id, role=role))

        sell_date = trade_date + timedelta(days=7)

        # 买入（HS/TH 有本金；DG 零本金不建买入）
        if otype in ("HS", "TH"):
            ev_buy = OrderEvent(
                event_no=f"EV-{order_no}-BUY",
                order_id=order.id,
                event_type=EventType.BUY.value,
                amount=Decimal("800"),
                portion=Portion.GROSS.value,
                occurred_on=trade_date,
                pool_id=invest_pool.id,
                operator_user_ids=[admin_id],
                is_posted=True,
                posted_at=None,
            )
            db.add(ev_buy)
            db.flush()
            db.add(Cashflow(
                flow_no=f"CF-{order_no}-B",
                pool_id=invest_pool.id,
                occurred_on=trade_date,
                category="PURCHASE",
                direction=Direction.OUT.value,
                amount=Decimal("800"),
                status=CashflowStatus.APPROVED.value,
                order_id=order.id,
                order_event_id=ev_buy.id,
            ))

        # 售出（ACTIVE 视为未售不建卖出；DG 仅 COMPLETED 建卖出，无 INSTALLMENT）
        if status in ("COMPLETED", "INSTALLMENT"):
            sell_cat = "SERVICE" if otype == "DG" else "SALE"
            ev_sell = OrderEvent(
                event_no=f"EV-{order_no}-SELL",
                order_id=order.id,
                event_type=EventType.SELL.value,
                amount=Decimal("2000"),
                portion=Portion.GROSS.value,
                occurred_on=sell_date,
                pool_id=profit_pool.id,
                operator_user_ids=[admin_id],
                is_posted=True,
                posted_at=None,
            )
            db.add(ev_sell)
            db.flush()
            db.add(Cashflow(
                flow_no=f"CF-{order_no}-S",
                pool_id=profit_pool.id,
                occurred_on=sell_date,
                category=sell_cat,
                direction=Direction.IN.value,
                amount=Decimal("2000"),
                status=CashflowStatus.APPROVED.value,
                order_id=order.id,
                order_event_id=ev_sell.id,
            ))

        # 取消（CANCELLED 建取消事件，不派生流水）
        if status == "CANCELLED":
            db.add(OrderEvent(
                event_no=f"EV-{order_no}-CANCEL",
                order_id=order.id,
                event_type=EventType.CANCEL.value,
                amount=Decimal("0"),
                portion=Portion.GROSS.value,
                occurred_on=trade_date + timedelta(days=3),
                pool_id=None,
                operator_user_ids=[admin_id],
                is_posted=False,
                posted_at=None,
            ))

        # 分期（仅 HS/TH 的 INSTALLMENT）
        if otype in ("HS", "TH") and status == "INSTALLMENT":
            contract = (
                InstallmentContractType.STOCK_SALE.value if otype == "HS"
                else InstallmentContractType.PICKUP_SALE.value)
            inst = Installment(
                inst_no=f"INST-{order_no}",
                order_id=order.id,
                contract_type=contract,
                principal=Decimal("12000"),
                down_payment=Decimal("2000"),
                service_fee=Decimal("500"),
                periods=10,
                per_period=Decimal("1000"),
                per_period_service_fee=Decimal("50"),
                paid_amount=Decimal("5000"),
                waived_amount=Decimal("0"),
                bad_debt_amount=Decimal("0"),
                status=InstallmentStatus.ACTIVE.value,
                first_due_on=trade_date + timedelta(days=30),
            )
            db.add(inst)
            db.flush()
            for p in range(1, 11):
                due = trade_date + timedelta(days=30 * p)
                received = Decimal("1000") if p <= 5 else Decimal("0")
                sch_status = (
                    ScheduleStatus.PAID.value if p <= 5
                    else ScheduleStatus.PENDING.value)
                db.add(InstallmentSchedule(
                    installment_id=inst.id,
                    period_no=p,
                    due_on=due,
                    service_fee_rate=Decimal("5"),
                    due_amount=Decimal("1000"),
                    received_amount=received,
                    waived_amount=Decimal("0"),
                    received_on=due if p <= 5 else None,
                    status=sch_status,
                ))

        # 返点（HS/TH 的售出/分期单挂卖出侧返点）
        if otype in ("HS", "TH") and status in ("COMPLETED", "INSTALLMENT"):
            db.add(RebateRecord(
                rebate_no=f"RB-{order_no}",
                source_order_id=order.id,
                rebate_type=RebateType.SELL.value,
                rate=Decimal("5"),
                base_amount=Decimal("2000"),
                link_status="LINKED",
                status=RebateStatus.OPEN.value,
                collected_on=sell_date,
            ))

        # 分润（售出/分期单：OWNER 60% / SALES 40%）
        if status in ("COMPLETED", "INSTALLMENT"):
            db.add(OrderProfitAllocation(
                order_id=order.id,
                allocation_type="PROFIT",
                user_id=admin_id,
                role="OWNER",
                allocation_rate=Decimal("60"),
                allocation_amount=Decimal("600"),
            ))
            db.add(OrderProfitAllocation(
                order_id=order.id,
                allocation_type="PROFIT",
                user_id=employee_id,
                role="SALES",
                allocation_rate=Decimal("40"),
                allocation_amount=Decimal("400"),
            ))

        db.flush()
