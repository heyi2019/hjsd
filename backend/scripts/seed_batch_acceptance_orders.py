"""创建一批覆盖全链路的本地验收订单。

这不是生产初始化脚本，只用于本地联调。所有订单都带有 [批量验收] 标记，
重复执行时会安全退出，不会重复污染本地经营数据。
"""
from __future__ import annotations

from datetime import date
from decimal import Decimal

from sqlalchemy import select

from app.stocks import service as stocks_service
from app.core.database import get_session_factory
from app.domain.enums import EventType, InstallmentContractType, RebateType
from app.domain.trade import Order
from app.finance import rebates as rebates_service
from app.installments import service as installments_service
from app.orders import service as orders_service


ACTOR = "admin"
TODAY = date(2026, 10, 18)
PAST = date(2026, 10, 17)
MARKER = "[批量验收]"


def account(session, tag: str, *, mode: str, inventory_type: str):
    return stocks_service.create_account(
        session,
        game_account=f"BATCH-{tag}-20261018",
        game_type="王者荣耀",
        platform="批量验收平台",
        business_mode=mode,
        inventory_type=inventory_type,
        actor=ACTOR,
        note=f"{MARKER} 账号 {tag}",
    )


def order(session, order_type: str, tag: str, *, account_id: int | None = None, snapshot: dict | None = None):
    return orders_service.create_order(
        session,
        order_type=order_type,
        trade_date=TODAY,
        actor=ACTOR,
        account_id=account_id,
        account_snapshot=snapshot,
        note=f"{MARKER} {tag}",
    )


def event(session, item, event_type: str, amount: str):
    return orders_service.post_event(
        session,
        item.id,
        event_type=event_type,
        amount=Decimal(amount),
        occurred_on=TODAY,
        actor=ACTOR,
        portion="GROSS" if item.order_type == "DG" else "PRINCIPAL",
        note=f"{MARKER} {event_type}",
    )[0]


def contract(session, item, contract_type: str, *, first_due_on: date):
    return installments_service.create_installment(
        session,
        order_id=item.id,
        contract_type=contract_type,
        principal=Decimal("1000"),
        down_payment=Decimal("0"),
        periods=1,
        per_period=Decimal("1000"),
        first_due_on=first_due_on,
        actor=ACTOR,
        note=f"{MARKER} {contract_type}",
    )


def complete_contract(session, item):
    installments_service.pay(
        session,
        item.id,
        amount=Decimal("1000"),
        paid_on=TODAY,
        period_no=1,
        actor=ACTOR,
        note=f"{MARKER} 已结清",
    )
    installments_service.deliver(
        session,
        item.id,
        delivery_mode="CUSTOMER_SELF",
        delivered_on=TODAY,
        note=f"{MARKER} 交付凭证",
        actor=ACTOR,
    )


def full_sale(session, order_type: str, tag: str, account_id: int):
    item = order(session, order_type, tag, account_id=account_id)
    event(session, item, EventType.SELL.value, "1500")
    return item


def main() -> None:
    session = get_session_factory()()
    try:
        existing = session.scalar(
            select(Order.id).where(Order.note.like(f"{MARKER}%")).limit(1)
        )
        if existing is not None:
            print(f"SKIP: 已存在批量验收订单，首条订单 ID={existing}")
            return

        created: list[Order] = []
        overdue_contracts = []

        # HS：采购、全款出售、分期完成，以及两组逾期回收后的全款/分期出售。
        hs1 = account(session, "HS01", mode="SELF", inventory_type="RECOVERY")
        h1_buy = order(session, "HS", "HS01-采购", account_id=hs1.id)
        event(session, h1_buy, EventType.BUY.value, "800")
        created.append(h1_buy)
        created.append(full_sale(session, "HS", "HS01-全款出售", hs1.id))

        hs2 = account(session, "HS02", mode="SELF", inventory_type="RECOVERY")
        h2_buy = order(session, "HS", "HS02-采购", account_id=hs2.id)
        event(session, h2_buy, EventType.BUY.value, "850")
        h2_sale = order(session, "HS", "HS02-分期出售-完成", account_id=hs2.id)
        h2_inst = contract(session, h2_sale, InstallmentContractType.STOCK_SALE.value, first_due_on=TODAY)
        complete_contract(session, h2_inst)
        created.extend([h2_buy, h2_sale])

        hs3 = account(session, "HS03", mode="SELF", inventory_type="RECOVERY")
        h3_buy = order(session, "HS", "HS03-采购", account_id=hs3.id)
        event(session, h3_buy, EventType.BUY.value, "900")
        h3_sale = order(session, "HS", "HS03-分期出售-逾期回收", account_id=hs3.id)
        h3_inst = contract(session, h3_sale, InstallmentContractType.STOCK_SALE.value, first_due_on=PAST)
        overdue_contracts.append(h3_inst)
        created.extend([h3_buy, h3_sale])

        hs4 = account(session, "HS04", mode="SELF", inventory_type="RECOVERY")
        h4_buy = order(session, "HS", "HS04-采购", account_id=hs4.id)
        event(session, h4_buy, EventType.BUY.value, "920")
        h4_sale = order(session, "HS", "HS04-分期出售-逾期回收", account_id=hs4.id)
        h4_inst = contract(session, h4_sale, InstallmentContractType.STOCK_SALE.value, first_due_on=PAST)
        overdue_contracts.append(h4_inst)
        created.extend([h4_buy, h4_sale])

        # TH：提号采购、PICKUP_SALE 分期的完成、逾期回收和再次出售。
        th1 = account(session, "TH01", mode="DISTRIBUTION", inventory_type="PICKUP")
        t1_buy = order(session, "TH", "TH01-提号", account_id=th1.id)
        event(session, t1_buy, EventType.BUY.value, "700")
        t1_sale = order(session, "TH", "TH01-分期出售-完成", account_id=th1.id)
        t1_inst = contract(session, t1_sale, InstallmentContractType.PICKUP_SALE.value, first_due_on=TODAY)
        complete_contract(session, t1_inst)
        created.extend([t1_buy, t1_sale])

        th2 = account(session, "TH02", mode="DISTRIBUTION", inventory_type="PICKUP")
        t2_buy = order(session, "TH", "TH02-提号", account_id=th2.id)
        event(session, t2_buy, EventType.BUY.value, "720")
        t2_sale = order(session, "TH", "TH02-分期出售-逾期回收", account_id=th2.id)
        t2_inst = contract(session, t2_sale, InstallmentContractType.PICKUP_SALE.value, first_due_on=PAST)
        overdue_contracts.append(t2_inst)
        created.extend([t2_buy, t2_sale])

        th3 = account(session, "TH03", mode="DISTRIBUTION", inventory_type="PICKUP")
        t3_sale = order(session, "TH", "TH03-分期出售-进行中", account_id=th3.id)
        contract(session, t3_sale, InstallmentContractType.PICKUP_SALE.value, first_due_on=TODAY)
        created.append(t3_sale)

        th4 = account(session, "TH04", mode="DISTRIBUTION", inventory_type="PICKUP")
        t4_sale = order(session, "TH", "TH04-分期出售-逾期未回收", account_id=th4.id)
        t4_inst = contract(session, t4_sale, InstallmentContractType.PICKUP_SALE.value, first_due_on=PAST)
        overdue_contracts.append(t4_inst)
        created.append(t4_sale)

        # DG：全款出售、CONSIGNMENT_SALE 分期，以及回收后的全款/分期出售。
        dg1 = account(session, "DG01", mode="DISTRIBUTION", inventory_type="CONSIGNMENT")
        d1_sale = full_sale(session, "DG", "DG01-全款出售", dg1.id)
        created.append(d1_sale)

        dg2 = account(session, "DG02", mode="DISTRIBUTION", inventory_type="CONSIGNMENT")
        d2_sale = order(session, "DG", "DG02-分期出售-进行中", account_id=dg2.id)
        contract(session, d2_sale, InstallmentContractType.CONSIGNMENT_SALE.value, first_due_on=TODAY)
        created.append(d2_sale)

        dg3 = account(session, "DG03", mode="DISTRIBUTION", inventory_type="CONSIGNMENT")
        d3_sale = order(session, "DG", "DG03-分期出售-完成", account_id=dg3.id)
        d3_inst = contract(session, d3_sale, InstallmentContractType.CONSIGNMENT_SALE.value, first_due_on=TODAY)
        complete_contract(session, d3_inst)
        created.append(d3_sale)

        dg4 = account(session, "DG04", mode="DISTRIBUTION", inventory_type="CONSIGNMENT")
        d4_sale = order(session, "DG", "DG04-分期出售-逾期回收", account_id=dg4.id)
        d4_inst = contract(session, d4_sale, InstallmentContractType.CONSIGNMENT_SALE.value, first_due_on=PAST)
        overdue_contracts.append(d4_inst)
        created.append(d4_sale)

        dg5 = account(session, "DG05", mode="DISTRIBUTION", inventory_type="CONSIGNMENT")
        d5_sale = order(session, "DG", "DG05-分期出售-逾期回收", account_id=dg5.id)
        d5_inst = contract(session, d5_sale, InstallmentContractType.CONSIGNMENT_SALE.value, first_due_on=PAST)
        overdue_contracts.append(d5_inst)
        created.append(d5_sale)

        # DFQ：快照建单、分期收款完成，以及逾期回收后转为可出售库存。
        f1 = order(
            session,
            "DFQ",
            "DFQ01-分期进行中",
            snapshot={"game_account": "BATCH-DFQ01-20261018", "game_type": "王者荣耀", "purchase_price": "800"},
        )
        contract(session, f1, InstallmentContractType.ADVANCE_PURCHASE.value, first_due_on=TODAY)
        event(session, f1, EventType.BUY.value, "800")
        created.append(f1)

        f2 = order(
            session,
            "DFQ",
            "DFQ02-分期完成",
            snapshot={"game_account": "BATCH-DFQ02-20261018", "game_type": "王者荣耀", "purchase_price": "820"},
        )
        f2_inst = contract(session, f2, InstallmentContractType.ADVANCE_PURCHASE.value, first_due_on=TODAY)
        event(session, f2, EventType.BUY.value, "820")
        complete_contract(session, f2_inst)
        created.append(f2)

        f3 = order(
            session,
            "DFQ",
            "DFQ03-逾期回收",
            snapshot={"game_account": "BATCH-DFQ03-20261018", "game_type": "王者荣耀", "purchase_price": "830"},
        )
        f3_inst = contract(session, f3, InstallmentContractType.ADVANCE_PURCHASE.value, first_due_on=PAST)
        event(session, f3, EventType.BUY.value, "830")
        overdue_contracts.append(f3_inst)
        created.append(f3)

        f4 = order(
            session,
            "DFQ",
            "DFQ04-逾期回收",
            snapshot={"game_account": "BATCH-DFQ04-20261018", "game_type": "王者荣耀", "purchase_price": "840"},
        )
        f4_inst = contract(session, f4, InstallmentContractType.ADVANCE_PURCHASE.value, first_due_on=PAST)
        event(session, f4, EventType.BUY.value, "840")
        overdue_contracts.append(f4_inst)
        created.append(f4)

        # 统一按规则标记逾期，再登记回收；只处理本批次的合约。
        installments_service.mark_overdue(session, as_of=TODAY, actor=ACTOR)
        for item in overdue_contracts:
            installments_service.recover_account(
                session,
                item.id,
                occurred_on=TODAY,
                actor=ACTOR,
                note=f"{MARKER} 逾期回收",
            )

        # 回收后的出售：HS/DG 全款出售，HS 分期出售；自动生成 RESELL 处置。
        created.append(full_sale(session, "HS", "HS03-回收后全款出售", hs3.id))
        created.append(full_sale(session, "DG", "DG04-回收后全款出售", dg4.id))

        h4_resale = order(session, "HS", "HS04-回收后分期出售", account_id=hs4.id)
        contract(session, h4_resale, InstallmentContractType.STOCK_SALE.value, first_due_on=TODAY)
        created.append(h4_resale)

        t2_resale = order(session, "TH", "TH02-回收后分期出售", account_id=th2.id)
        t2_resale_inst = contract(session, t2_resale, InstallmentContractType.PICKUP_SALE.value, first_due_on=TODAY)
        complete_contract(session, t2_resale_inst)
        created.append(t2_resale)

        d5_resale = order(session, "DG", "DG05-回收后分期出售", account_id=dg5.id)
        contract(session, d5_resale, InstallmentContractType.CONSIGNMENT_SALE.value, first_due_on=TODAY)
        created.append(d5_resale)

        # DFQ 回收后的库存出售，覆盖全款与分期两种出口。
        f3_account_id = session.scalar(select(Order.account_id).where(Order.id == f3.id))
        f4_account_id = session.scalar(select(Order.account_id).where(Order.id == f4.id))
        created.append(full_sale(session, "HS", "DFQ03-回收后全款出售", f3_account_id))
        f4_resale = order(session, "HS", "DFQ04-回收后分期出售", account_id=f4_account_id)
        contract(session, f4_resale, InstallmentContractType.STOCK_SALE.value, first_due_on=TODAY)
        created.append(f4_resale)

        # 买入返点 + 卖出返点，并完成一笔结算，验证返点资金流。
        buy_rebate = rebates_service.create_rebate(
            session,
            source_order_id=h1_buy.id,
            rebate_type=RebateType.BUY.value,
            base_amount=Decimal("100"),
            rate=Decimal("10"),
            collected_on=TODAY,
            expected_on=TODAY,
            channel="批量验收渠道",
            actor=ACTOR,
            note=f"{MARKER} 买入返点",
        )
        rebates_service.settle_rebate(
            session,
            buy_rebate.id,
            gross_amount=Decimal("100"),
            settled_on=TODAY,
            pool_id=2,
            actor=ACTOR,
            note=f"{MARKER} 买入返点到账",
        )
        sell_rebate = rebates_service.create_rebate(
            session,
            source_order_id=d1_sale.id,
            rebate_type=RebateType.SELL.value,
            base_amount=Decimal("120"),
            rate=Decimal("10"),
            collected_on=TODAY,
            expected_on=TODAY,
            channel="批量验收渠道",
            actor=ACTOR,
            note=f"{MARKER} 卖出返点",
        )
        rebates_service.settle_rebate(
            session,
            sell_rebate.id,
            gross_amount=Decimal("120"),
            settled_on=TODAY,
            pool_id=2,
            actor=ACTOR,
            note=f"{MARKER} 卖出返点到账",
        )

        if len(created) != 30:
            raise RuntimeError(f"批量验收订单数量错误：期望 30，实际 {len(created)}")
        session.commit()
        print(f"OK: 已创建 {len(created)} 笔批量验收订单")
        print("订单号：" + ",".join(item.order_no for item in created))
        print("逾期回收合约：" + ",".join(item.inst_no for item in overdue_contracts))
    except Exception:
        session.rollback()
        raise
    finally:
        session.close()


if __name__ == "__main__":
    main()
