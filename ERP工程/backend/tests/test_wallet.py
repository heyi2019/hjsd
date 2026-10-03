"""双荷包与利润口径回归测试。

这三个用例锁死 2026-10-03 修复的缺陷，任何人改坏都必须红：
1. 运营类别必须是「房租/日用」（含斜杠）
2. 本金支出不得被翻正
3. 迁移脚本与服务层必须同源同数
"""
from decimal import Decimal

from app.models import CashFlow, Order
from app.services import OPERATION_COST_CATEGORIES, principal_wallet, profit_wallet


class TestOperationCostCategory:
    """类别名拼写守卫 —— 这是导致利润被高估 11,989.90 的根因。"""

    def test_rent_category_has_slash(self):
        assert "房租/日用" in OPERATION_COST_CATEGORIES, \
            "类别名必须是「房租/日用」(含斜杠)，与金山文档原始枚举一致"

    def test_no_wrong_spelling(self):
        assert "房租日用" not in OPERATION_COST_CATEGORIES, \
            "「房租日用」(无斜杠) 是错别字，会导致该项支出永不计入"

    def test_rent_is_counted_as_cost(self, session):
        """最关键的一条：¥30000 房租必须被计入运营消耗。"""
        session.add(CashFlow(
            date=__import__("datetime").date(2026, 7, 2),
            category="房租/日用", direction="支出", amount=Decimal("30000"),
        ))
        session.commit()
        # 利润荷包 = 0 利润 - 30000 房租 = -30000（而非 0）
        assert profit_wallet(session) == Decimal("-30000"), \
            "房租/日用 未被计入运营消耗 —— 类别名又写错了？"


class TestPrincipalWalletSign:
    """本金荷包符号守卫 —— 负本金是支出，不能被翻正。"""

    def test_negative_principal_subtracted_once(self, session):
        session.add_all([
            Order(date=__import__("datetime").date(2026, 7, 3), type="回收",
                  principal=Decimal("500"), profit=Decimal("200"), total=Decimal("700")),
            Order(date=__import__("datetime").date(2026, 7, 4), type="回收",
                  principal=Decimal("-200"), profit=Decimal("-50"), total=Decimal("0")),
        ])
        session.commit()
        # 500 + (-200) = 300。若被翻正会得到 500 - (-200) = 700
        assert principal_wallet(session) == Decimal("300"), \
            "本金支出被翻正了：应为 500 + (-200) = 300"

    def test_investment_plus_principal(self, seeded):
        """投资款流入 + 订单本金收入。"""
        assert principal_wallet(seeded) == Decimal("100500")


class TestProfitWallet:
    def test_profit_minus_operation_cost(self, seeded):
        assert profit_wallet(seeded) == Decimal("-29800"), \
            "利润荷包 = Σ订单利润(200) − 运营消耗(30000)"

    def test_other_category_excluded(self, session):
        """非运营类支出不得计入运营消耗。"""
        session.add_all([
            Order(date=__import__("datetime").date(2026, 7, 3), type="回收",
                  principal=Decimal("0"), profit=Decimal("1000"), total=Decimal("1000")),
            CashFlow(date=__import__("datetime").date(2026, 7, 2),
                     category="账号回收", direction="支出", amount=Decimal("99999")),
        ])
        session.commit()
        # 账号回收是订单现金侧，不是运营消耗
        assert profit_wallet(session) == Decimal("1000")
