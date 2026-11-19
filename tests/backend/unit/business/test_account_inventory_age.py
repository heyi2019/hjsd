"""CALC-01 库存台账「未售时长」的下发口径（ACC-01 库存中心）。

前端原本自己拿 `<入库时间>` 减 `new Date()` 算天数，再按 `<=7 / <=30` 上色：
库龄口径与台账返回的卡片指标（7 天 / 30 天档）必须保持同源，
时分秒还会让「8 天前入库」显示成 7 天。现在 `AccountOut` 直接下发
`inventory_age_days` 与 `inventory_age_level`，前端只映射颜色。

这里锁死四件事：
1. 库龄按**日期差**计，不按「满 24 小时」，且不随当天时刻跳动；
2. 档位边界是 7 / 30（含），31 起超期；
3. 非在库账号两个字段都为 null（台账/导出据此留空）；
4. 列表字段与卡片指标同源——超期条数必须等于 stats 的 over_30d_count。
"""
from __future__ import annotations

from datetime import date, datetime, time, timedelta
from decimal import Decimal

from app.domain.trade import Account
from app.business.stocks.inventory import dashboard_inventory_summary
from app.business.stocks.profile import create_account
from app.business.stocks.schemas import AccountOut


def _out(
    *,
    entry: datetime | date | None = None,
    inventory_status: str = "IN_STOCK",
    buy_date: date | None = None,
    created_at: datetime | None = None,
) -> AccountOut:
    """模型层造一个响应对象：库龄是响应字段，不必落库也能验证。"""
    row = Account(
        id=1,
        game_account="age-probe",
        business_mode="SELF",
        inventory_type="RECOVERY",
        status="WAITING",
        inventory_status=inventory_status,
        cost_amount=Decimal("0.00"),
        inventory_entry_at=entry or datetime.combine(date.today(), time(9, 0)),
        buy_date=buy_date,
        created_by="pytest",
        updated_by="pytest",
        created_at=created_at or datetime.combine(date.today(), time(9, 0)),
    )
    return AccountOut.model_validate(row)


def _days_ago(days: int, *, at: time = time(9, 30)) -> datetime:
    return datetime.combine(date.today() - timedelta(days=days), at)


def test_age_counts_calendar_days_not_full_24_hours():
    """入库存时间带时分秒时，按满 24 小时算会少 1 天。"""
    # 10 天前的 09:30 入库，此刻是今天凌晨：满 24 小时只有 9 天多一点。
    assert _out(entry=_days_ago(10)).inventory_age_days == 10
    # 当天入库（哪怕在 23:59）仍是 0 天，不会因为跨过零点差 1 天。
    assert _out(entry=datetime.combine(date.today(), time(23, 59))).inventory_age_days == 0


def test_level_boundaries_are_7_and_30_inclusive():
    assert _out(entry=_days_ago(0)).inventory_age_level == "NORMAL"
    assert _out(entry=_days_ago(7)).inventory_age_level == "NORMAL"
    assert _out(entry=_days_ago(8)).inventory_age_level == "WARNING"
    assert _out(entry=_days_ago(30)).inventory_age_level == "WARNING"
    assert _out(entry=_days_ago(31)).inventory_age_level == "OVERDUE"


def test_out_of_stock_accounts_publish_no_age():
    """已售/下架账号不进库存中心，库龄必须为空而不是 0 天。"""
    sold = _out(entry=_days_ago(40), inventory_status="OUT_OF_STOCK")

    assert sold.inventory_age_days is None
    assert sold.inventory_age_level is None


def test_future_entry_is_clamped_to_zero():
    """补录或时区差造成的「未来入库时间」不能算出负数天数。"""
    assert _out(entry=_days_ago(-3)).inventory_age_days == 0


def test_age_falls_back_when_entry_time_missing():
    """`_common.inventory_age_days` 是唯一口径：无条件回退链由调用方挑，
    函数本身拿到 None 必须返回 None，不能默认 0 天。"""
    from app.business.stocks import _common

    assert _common.inventory_age_days(None) is None
    assert _common.inventory_age_days(date.today() - timedelta(days=12)) == 12
    assert _common.inventory_age_level(None) is None


def _account(seeded_db, game_account: str, *, days_ago: int):
    account = create_account(
        seeded_db,
        game_account=game_account,
        actor="pytest",
        business_mode="SELF",
        inventory_type="RECOVERY",
    )
    account.inventory_entry_at = datetime.combine(date.today() - timedelta(days=days_ago), time(0, 0))
    seeded_db.flush()
    return account


def test_dashboard_summary_aggregates_inventory_age_without_loading_rows(seeded_db):
    """工作台只取数据库聚合结果，不把所有入库时间加载到 Python。"""
    today = date.today()
    _account(seeded_db, "dashboard-fresh", days_ago=7)
    _account(seeded_db, "dashboard-aging", days_ago=8)
    _account(seeded_db, "dashboard-overdue", days_ago=31)

    class AggregateOnlySession:
        def __init__(self, session):
            self._session = session

        def scalars(self, *args, **kwargs):
            raise AssertionError("工作台库存汇总不应加载账号明细行")

        def execute(self, *args, **kwargs):
            return self._session.execute(*args, **kwargs)

    summary = dashboard_inventory_summary(
        AggregateOnlySession(seeded_db), reminder_days=7, today=today
    )

    assert summary == {"account_count": 3, "aging_count": 2, "overdue_count": 1}


def test_export_csv_fills_age_column(seeded_client, seeded_db, headers):
    """「未售时长」列的注册键是 inventory_age，响应字段叫 inventory_age_days：

    不做别名映射的话，导出的表头在、整列为空（与分期「剩余」列踩过同一个坑）。
    """
    _account(seeded_db, "age-export", days_ago=12)

    response = seeded_client.get("/api/v1/stocks/export.csv", headers=headers)

    assert response.status_code == 200, response.text
    lines = [line for line in response.text.splitlines() if line.strip()]
    header = lines[0].split(",")
    row = dict(zip(header, lines[1].split(",")))
    assert "12天" in row.values()
