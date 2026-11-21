"""一次性补齐事件资金流水的订单关联；运行前确认目标数据库。"""
from sqlalchemy import text


def backfill_event_cashflow_order_id(connection) -> None:
    connection.execute(text("""
        UPDATE cashflow AS flow SET order_id = event.order_id
        FROM order_events AS event
        WHERE flow.source_type = 'ORDER_EVENT' AND flow.order_id IS NULL
          AND flow.source_id = event.event_no
    """))
    missing = connection.scalar(text("""
        SELECT count(*) FROM cashflow
        WHERE source_type = 'ORDER_EVENT' AND order_id IS NULL
    """))
    if missing:
        raise RuntimeError(f"{missing} 条事件资金流水无法关联订单，迁移已停止")


if __name__ == "__main__":
    from app.core.database import get_engine

    with get_engine().begin() as connection:
        backfill_event_cashflow_order_id(connection)
    print("事件资金流水订单关联已检查并补齐")
