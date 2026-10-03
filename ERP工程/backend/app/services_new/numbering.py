"""业务编号生成器 —— PRD §2.1.1。

规则：
- 所有编号统一为「前缀 + 纯顺序号」，**不含日期**
- 顺序号为全局递增，不按天重置
- 创建后**永不可改**（V19），全局唯一
- 数据库自增 id 仅作内部外键，不对外暴露

格式：
    订单      HJ0001         HJ + 4 位
    事件      HJ0001-BUY     订单号 + 事件码
    账号      HJACC001       HJACC + 3 位（现有 36 条）
    分期      HJINS001       HJINS + 3 位（现有 4 条）
    流水      HJF0001        HJF + 4 位（现有 196 条，3 位会溢出）
    划转      HJT0001        HJT + 4 位
"""
from __future__ import annotations

from sqlalchemy.orm import Session

#: 编号宽度。统一 4 位（上限 9999）——流水已有 196 条，3 位会溢出。
#: 超出上限时抛错而非静默进位，避免出现 HJF1000 这类断号。
WIDTH = 4


def _next_seq(db: Session, column, prefix: str, width: int) -> str:
    """取同前缀下已有最大序号 +1。首次调用返回 0001。

    必须显式 autoflush：SessionLocalV2 关了 autoflush，
    同事务内刚 add/flush 的行不会被后续 query 看到，
    会导致每次都返回同一个序号（撞号）。
    """
    db.flush()
    rows = db.query(column).filter(column.like(f"{prefix}%")).all()
    best = 0
    for (val,) in rows:
        if not val or not val.startswith(prefix):
            continue
        tail = val[len(prefix):]
        if tail.isdigit():
            best = max(best, int(tail))
    nxt = best + 1
    if nxt >= 10 ** width:
        raise ValueError(
            f"{prefix} 序号已用满（上限 {10 ** width - 1}），需扩位。禁止静默进位。"
        )
    return str(nxt).zfill(width)


def gen_order_no(db: Session) -> str:
    """订单号：HJ + 4 位全局序号。"""
    return "HJ" + _next_seq(db, _col_order_no(), "HJ", WIDTH)


def gen_event_no(order_no: str, event_type: str) -> str:
    """事件号：订单号 + 事件码。"""
    return f"{order_no}-{event_type}"


def gen_account_no(db: Session) -> str:
    """账号编号：HJACC + 3 位全局序号。"""
    return "HJACC" + _next_seq(db, _col_account_no(), "HJACC", WIDTH)


def gen_inst_no(db: Session) -> str:
    """分期编号：HJINS + 3 位全局序号。"""
    return "HJINS" + _next_seq(db, _col_inst_no(), "HJINS", WIDTH)


def gen_flow_no(db: Session) -> str:
    """流水号：HJF + 3 位全局序号。"""
    return "HJF" + _next_seq(db, _col_flow_no(), "HJF", WIDTH)


def gen_transfer_id(db: Session) -> str:
    """划转对ID：HJT + 3 位全局序号。成对流水共享。"""
    return "HJT" + _next_seq(db, _col_flow_no(), "HJT", WIDTH)


# --- 列引用（惰性导入，避免与 models 形成加载期循环） ---

def _col_order_no():
    from app.models_new.entities import Order
    return Order.order_no


def _col_account_no():
    from app.models_new.entities import Account
    return Account.account_no


def _col_inst_no():
    from app.models_new.entities import Installment
    return Installment.inst_no


def _col_flow_no():
    from app.models_new.entities import CashFlow
    return CashFlow.flow_no
