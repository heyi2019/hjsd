"""API 层回归测试：CRUD、订单联动、级联删除、筛选。

重点锁死 2026-10-03 的两个行为约定：
- total=principal+profit 的伪校验已移除，代挂类必须能下单
- 删除订单必须级联清理联动流水并回滚账号状态
"""
class TestOrderTotalSemantics:
    """total 是成交总额(gross)，不等于本金+利润，不得拦截。"""

    def test_daigua_order_not_rejected(self, client):
        """代挂型：本金0/利润429/total13888，89 单里 24 单属此类。"""
        r = client.post("/orders", json={
            "date": "2026-07-14", "type": "代挂",
            "principal": 0, "profit": 429, "total": 13888,
        })
        assert r.status_code == 201, f"代挂单被拦截: {r.text}"

    def test_rebate_order_zero_total(self, client):
        """返点型：total 可为 0。"""
        r = client.post("/orders", json={
            "date": "2026-08-25", "type": "返点",
            "principal": 0, "profit": 470, "total": 0,
        })
        assert r.status_code == 201, f"返点单被拦截: {r.text}"

    def test_recycle_partial_principal(self, client):
        """回收型：差值含第三方分成（本金3736/利润800/total4200）。"""
        r = client.post("/orders", json={
            "date": "2026-07-25", "type": "回收",
            "principal": 3736, "profit": 800, "total": 4200,
        })
        assert r.status_code == 201, f"回收单被拦截: {r.text}"

    def test_negative_principal_rejected(self, client):
        """负值本金应被拦截（资金方向应由 type 表达）。"""
        r = client.post("/orders", json={
            "date": "2026-07-25", "type": "回收",
            "principal": -500, "profit": 10, "total": 0,
        })
        assert r.status_code == 422


class TestOrderCascade:
    """订单 → 账号状态联动 + 流水级联。"""

    def _mk_account(self, client):
        r = client.post("/accounts", json={
            "recycle_date": "2026-10-01", "principal": 1000,
            "sale_price": 1500, "account_info": "测试账号", "status": "在库",
        })
        return r.json()["id"]

    def test_sell_marks_account_sold(self, client):
        aid = self._mk_account(client)
        r = client.post("/orders", json={
            "date": "2026-10-02", "type": "回收",
            "principal": 1000, "profit": 200, "total": 1200, "account_id": aid,
        })
        assert r.status_code == 201
        assert client.get(f"/accounts/{aid}").json()["status"] == "已售", \
            "卖出订单未联动账号状态为已售"

    def test_order_generates_cashflow(self, client):
        r = client.post("/orders", json={
            "date": "2026-10-02", "type": "回收",
            "principal": 1000, "profit": 200, "total": 1200,
        })
        oid = r.json()["id"]
        cfs = [x for x in client.get("/cashflow").json() if x["order_id"] == oid]
        assert len(cfs) == 2, f"应生成本金+利润 2 条流水，实际 {len(cfs)}"
        assert all(x["source"] == "order" for x in cfs), "联动流水须标记 source=order"

    def test_delete_cascades_cashflow(self, client):
        """删订单必须级联清理流水。

        注意断言写法：SQLite 默认不启用外键约束，ORM 只会把 order_id 置 NULL、
        行仍留存。所以不能只查 `order_id == oid`（永远查不到 → 假绿灯），
        必须查全表剩余行数 + 确认没有 order 源流水残留。
        """
        before = len(client.get("/cashflow").json())
        r = client.post("/orders", json={
            "date": "2026-10-02", "type": "回收",
            "principal": 1000, "profit": 200, "total": 1200,
        })
        oid = r.json()["id"]
        assert len(client.get("/cashflow").json()) == before + 2

        assert client.delete(f"/orders/{oid}").status_code == 204
        after = client.get("/cashflow").json()
        assert len(after) == before, \
            f"订单删除后流水应归零，实际残留 {len(after) - before} 条"
        assert not [x for x in after if x["source"] == "order"], \
            "残留 order 来源的孤儿流水"

    def test_delete_keeps_manual_cashflow(self, client):
        """删订单不得误删手工记账 —— 这是加 source 标记的根本目的。"""
        manual_id = client.post("/cashflow", json={
            "date": "2026-10-01", "category": "房租/日用",
            "direction": "支出", "amount": 5000,
        }).json()["id"]
        ro = client.post("/orders", json={
            "date": "2026-10-02", "type": "回收",
            "principal": 1000, "profit": 200, "total": 1200,
        })
        client.delete(f"/orders/{ro.json()['id']}")
        assert client.get(f"/cashflow/{manual_id}").status_code == 200, \
            "手工记账被订单删除连带清掉了"

    def test_delete_rolls_back_account(self, client):
        aid = self._mk_account(client)
        r = client.post("/orders", json={
            "date": "2026-10-02", "type": "回收",
            "principal": 1000, "profit": 200, "total": 1200, "account_id": aid,
        })
        client.delete(f"/orders/{r.json()['id']}")
        assert client.get(f"/accounts/{aid}").json()["status"] == "在库", \
            "订单删除后账号状态未回滚为在库"

    def test_delete_refuses_linked_account(self, client):
        aid = self._mk_account(client)
        client.post("/orders", json={
            "date": "2026-10-02", "type": "回收",
            "principal": 1000, "profit": 200, "total": 1200, "account_id": aid,
        })
        assert client.delete(f"/accounts/{aid}").status_code == 400, \
            "被订单引用的账号不应允许删除"


class TestCashflowFilters:
    def test_filter_by_year_month(self, client):
        """SQLite 无 year()/month() 函数，此用例守卫 strftime 写法。

        断言必须用**跨年**数据：若只用同一年不同月，年份过滤失效也能通过
        （变异验证已证实：去掉 year 过滤，用例仍绿）。
        """
        client.post("/cashflow", json={
            "date": "2026-09-15", "category": "运营", "direction": "支出", "amount": 100,
        })
        client.post("/cashflow", json={
            "date": "2026-08-15", "category": "运营", "direction": "支出", "amount": 200,
        })
        client.post("/cashflow", json={
            "date": "2025-09-15", "category": "运营", "direction": "支出", "amount": 400,
        })

        sep = client.get("/cashflow?year=2026&month=9").json()
        assert len(sep) == 1, f"应只命中 2026-09 一条，实际 {len(sep)} 条"
        assert float(sep[0]["amount"]) == 100

        assert len(client.get("/cashflow?year=2025&month=9").json()) == 1, \
            "年份过滤失效：2025-09 的记录被混进 2026 结果"

    def test_filter_by_category(self, client):
        client.post("/cashflow", json={
            "date": "2026-09-15", "category": "房租/日用", "direction": "支出", "amount": 100,
        })
        client.post("/cashflow", json={
            "date": "2026-09-15", "category": "运营", "direction": "支出", "amount": 200,
        })
        assert len(client.get("/cashflow?category=房租/日用").json()) == 1

    def test_delete_refuses_linked_cashflow(self, client):
        r = client.post("/orders", json={
            "date": "2026-10-02", "type": "回收",
            "principal": 100, "profit": 20, "total": 120,
        })
        oid = r.json()["id"]
        cf_id = [x for x in client.get("/cashflow").json() if x["order_id"] == oid][0]["id"]
        assert client.delete(f"/cashflow/{cf_id}").status_code == 400, \
            "订单联动生成的流水不应允许单独删除"

    def test_manual_cashflow_defaults_to_manual(self, client):
        r = client.post("/cashflow", json={
            "date": "2026-10-01", "category": "运营", "direction": "支出", "amount": 100,
        })
        assert r.json()["source"] == "manual"

    def test_manual_cashflow_cannot_fake_order_source(self, client):
        """禁止手工构造 order 来源 —— 否则删订单时会误删用户手记的账。"""
        r = client.post("/cashflow", json={
            "date": "2026-10-01", "category": "运营", "direction": "支出",
            "amount": 100, "source": "order",
        })
        assert r.status_code == 422, "手工记账不应允许 source=order"

    def test_manual_cashflow_cannot_set_order_id(self, client):
        """禁止手工记账自挂 order_id（订单流水只能由订单联动生成）。"""
        ro = client.post("/orders", json={
            "date": "2026-10-02", "type": "回收",
            "principal": 100, "profit": 20, "total": 120,
        })
        r = client.post("/cashflow", json={
            "date": "2026-10-01", "category": "运营", "direction": "支出",
            "amount": 100, "order_id": ro.json()["id"],
        })
        assert r.status_code == 422, "手工记账不应允许指定 order_id"


class TestAccountFilters:
    def test_keyword_search(self, client):
        client.post("/accounts", json={
            "recycle_date": "2026-10-01", "principal": 1,
            "account_info": "绝版皮肤xyz", "status": "在库",
        })
        client.post("/accounts", json={
            "recycle_date": "2026-10-02", "principal": 1,
            "account_info": "普普通通", "status": "在库",
        })
        assert len(client.get("/accounts?keyword=绝版").json()) == 1

    def test_filter_by_status(self, client):
        client.post("/accounts", json={
            "recycle_date": "2026-10-01", "principal": 1,
            "account_info": "A", "status": "在库",
        })
        client.post("/accounts", json={
            "recycle_date": "2026-10-02", "principal": 1,
            "account_info": "B", "status": "已售",
        })
        assert len(client.get("/accounts?status=已售").json()) == 1


class TestReports:
    def test_monthly_profit_table(self, client):
        """按月利润表 + 累计。"""
        client.post("/orders", json={
            "date": "2026-07-03", "type": "回收",
            "principal": 0, "profit": 1000, "total": 1000,
        })
        client.post("/cashflow", json={
            "date": "2026-07-10", "category": "房租/日用",
            "direction": "支出", "amount": 400,
        })
        client.post("/orders", json={
            "date": "2026-08-03", "type": "回收",
            "principal": 0, "profit": 600, "total": 600,
        })
        rows = client.get("/reports/monthly-profit/table").json()["rows"]
        m = {r["month"]: r for r in rows}
        assert m["2026-07"]["net_profit"] == 600.0      # 1000 - 400
        assert m["2026-08"]["net_profit"] == 600.0      # 600 - 0
        assert m["2026-08"]["cumulative"] == 1200.0

    def test_wallet_endpoint(self, client):
        w = client.get("/reports/wallet").json()
        assert "principal_wallet" in w and "profit_wallet" in w

    def test_inventory_counts_in_stock_only(self, client):
        client.post("/accounts", json={
            "recycle_date": "2026-10-01", "principal": 1000,
            "sale_price": 1500, "status": "在库",
        })
        client.post("/accounts", json={
            "recycle_date": "2026-10-02", "principal": 999,
            "sale_price": 1200, "status": "已售",
        })
        inv = client.get("/reports/inventory").json()
        assert inv["in_stock_count"] == 1
        assert float(inv["occupied_principal"]) == 1000.0
        assert float(inv["expected_profit"]) == 500.0
