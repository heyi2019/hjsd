"""关联模块测试：人工指派、候选推荐、缺口统计。

背景：源数据两表无可用关联键，故不做自动关联，只提供人工链路 + 缺口可见。
"""
class TestLinkageGap:
    def test_gap_counts(self, client):
        client.post("/orders", json={
            "date": "2026-10-02", "type": "回收",
            "principal": 1000, "profit": 200, "total": 1200,
        })
        g = client.get("/linkage/gap").json()
        assert g["orders_total"] == 1
        assert g["orders_unlinked"] == 1
        assert g["orders_link_rate"] == 0.0

    def test_gap_after_link(self, client):
        oid = client.post("/orders", json={
            "date": "2026-10-02", "type": "回收",
            "principal": 1000, "profit": 200, "total": 1200,
        }).json()["id"]
        aid = client.post("/accounts", json={
            "recycle_date": "2026-10-02", "principal": 1000,
            "sale_price": 1500, "status": "在库",
        }).json()["id"]
        client.post(f"/linkage/order/{oid}/link", json={"account_id": aid})
        g = client.get("/linkage/gap").json()
        assert g["orders_unlinked"] == 0
        assert g["orders_link_rate"] == 1.0
        assert g["accounts_linked"] == 1


class TestLink:
    def _mk(self, client):
        oid = client.post("/orders", json={
            "date": "2026-10-02", "type": "回收",
            "principal": 1000, "profit": 200, "total": 1200,
        }).json()["id"]
        aid = client.post("/accounts", json={
            "recycle_date": "2026-10-02", "principal": 1000,
            "sale_price": 1500, "status": "在库",
        }).json()["id"]
        return oid, aid

    def test_link_marks_account_sold(self, client):
        oid, aid = self._mk(client)
        r = client.post(f"/linkage/order/{oid}/link", json={"account_id": aid})
        assert r.status_code == 200 and r.json()["changed"] is True
        assert client.get(f"/accounts/{aid}").json()["status"] == "已售"

    def test_unlink_rolls_back(self, client):
        oid, aid = self._mk(client)
        client.post(f"/linkage/order/{oid}/link", json={"account_id": aid})
        client.delete(f"/linkage/order/{oid}/link")
        assert client.get(f"/accounts/{aid}").json()["status"] == "在库", \
            "解除关联后账号状态未回滚"

    def test_relink_releases_previous(self, client):
        """改挂到新账号时，旧账号应回滚为在库。"""
        oid, aid1 = self._mk(client)
        aid2 = client.post("/accounts", json={
            "recycle_date": "2026-10-02", "principal": 1000,
            "sale_price": 1600, "status": "在库",
        }).json()["id"]
        client.post(f"/linkage/order/{oid}/link", json={"account_id": aid1})
        r = client.post(f"/linkage/order/{oid}/link", json={"account_id": aid2})
        assert r.json()["previous_account_id"] == aid1
        assert client.get(f"/accounts/{aid1}").json()["status"] == "在库"
        assert client.get(f"/accounts/{aid2}").json()["status"] == "已售"

    def test_link_same_account_is_noop(self, client):
        oid, aid = self._mk(client)
        client.post(f"/linkage/order/{oid}/link", json={"account_id": aid})
        r = client.post(f"/linkage/order/{oid}/link", json={"account_id": aid})
        assert r.json()["changed"] is False

    def test_non_recycle_does_not_mark_sold(self, client):
        """代挂类无库存实体，不应改账号状态。"""
        oid = client.post("/orders", json={
            "date": "2026-10-02", "type": "代挂",
            "principal": 0, "profit": 300, "total": 9000,
        }).json()["id"]
        aid = client.post("/accounts", json={
            "recycle_date": "2026-10-02", "principal": 100,
            "sale_price": 150, "status": "在库",
        }).json()["id"]
        client.post(f"/linkage/order/{oid}/link", json={"account_id": aid})
        assert client.get(f"/accounts/{aid}").json()["status"] == "在库"

    def test_link_nonexistent_returns_404(self, client):
        oid, aid = self._mk(client)
        assert client.post(f"/linkage/order/{oid}/link",
                           json={"account_id": 99999}).status_code == 404


class TestCandidates:
    def test_exact_match_flagged(self, client):
        oid = client.post("/orders", json={
            "date": "2026-10-02", "type": "回收",
            "principal": 1000, "profit": 200, "total": 1200,
        }).json()["id"]
        client.post("/accounts", json={
            "recycle_date": "2026-10-02", "principal": 1000,
            "sale_price": 1500, "status": "在库",
        })
        cands = client.get(f"/linkage/candidates/{oid}").json()["candidates"]
        assert any(c["exact_match"] for c in cands), \
            "日期+本金完全一致的账号未被标记为精确匹配"

    def test_far_off_account_excluded(self, client):
        """日期超窗的账号不进候选（本金匹配，只有日期能排除它）。"""
        oid = client.post("/orders", json={
            "date": "2026-10-02", "type": "回收",
            "principal": 1000, "profit": 200, "total": 1200,
        }).json()["id"]
        client.post("/accounts", json={
            "recycle_date": "2026-08-01", "principal": 1000,
            "sale_price": 1500, "status": "在库",
        })
        cands = client.get(f"/linkage/candidates/{oid}").json()["candidates"]
        assert len(cands) == 0, f"远早于订单的账号不应进候选，实际 {len(cands)}"

    def test_future_account_excluded(self, client):
        """日期超未来窗口的账号不进候选。

        变异验证暴露：只测「远早于」时，去掉日期**上界**仍能通过，
        因为早于窗口的样本本就靠下界排除。故上下界必须各有独立用例。
        """
        oid = client.post("/orders", json={
            "date": "2026-10-02", "type": "回收",
            "principal": 1000, "profit": 200, "total": 1200,
        }).json()["id"]
        client.post("/accounts", json={
            "recycle_date": "2026-12-25", "principal": 1000,
            "sale_price": 1500, "status": "在库",
        })
        cands = client.get(f"/linkage/candidates/{oid}").json()["candidates"]
        assert len(cands) == 0, f"远晚于订单的账号不应进候选，实际 {len(cands)}"

    def test_principal_out_of_range_excluded(self, client):
        """本金差超 10% 的账号不进候选（日期相同，只有本金能排除它）。"""
        oid = client.post("/orders", json={
            "date": "2026-10-02", "type": "回收",
            "principal": 1000, "profit": 200, "total": 1200,
        }).json()["id"]
        client.post("/accounts", json={
            "recycle_date": "2026-10-02", "principal": 5000,
            "sale_price": 6000, "status": "在库",
        })
        cands = client.get(f"/linkage/candidates/{oid}").json()["candidates"]
        assert len(cands) == 0, f"本金差 5 倍的账号不应进候选，实际 {len(cands)}"

    def test_near_miss_still_offered(self, client):
        """窗口边缘的近似账号应出现，并标记为非精确匹配。"""
        oid = client.post("/orders", json={
            "date": "2026-10-02", "type": "回收",
            "principal": 1000, "profit": 200, "total": 1200,
        }).json()["id"]
        client.post("/accounts", json={
            "recycle_date": "2026-10-04", "principal": 1050,  # +2天 / 本金+5%
            "sale_price": 1500, "status": "在库",
        })
        cands = client.get(f"/linkage/candidates/{oid}").json()["candidates"]
        assert len(cands) == 1, "窗口内近似账号应作为候选给出"
        assert cands[0]["exact_match"] is False, \
            "日期本金并非完全一致，不得标记为精确匹配"

    def test_exact_match_not_false_positive(self, client):
        """仅日期相同、本金不同 => 必须 False。

        断言必须**按账号逐个核对**。变异验证暴露：只断言
        `sum(flags) == 1` 时，把 exact_match 硬编码为 True 也能通过
        （恰好也是 1 个）——那是个假绿灯。必须断言具体那条是 False。
        """
        oid = client.post("/orders", json={
            "date": "2026-10-02", "type": "回收",
            "principal": 1000, "profit": 200, "total": 1200,
        }).json()["id"]
        exact_id = client.post("/accounts", json={
            "recycle_date": "2026-10-02", "principal": 1000,
            "sale_price": 1500, "status": "在库",
        }).json()["id"]
        near_id = client.post("/accounts", json={
            "recycle_date": "2026-10-02", "principal": 1030,  # 日期同、本金异
            "sale_price": 1500, "status": "在库",
        }).json()["id"]
        cands = client.get(f"/linkage/candidates/{oid}").json()["candidates"]
        flags = {c["id"]: c["exact_match"] for c in cands}
        assert len(flags) == 2
        assert flags[exact_id] is True, "日期+本金全同的账号应标记精确匹配"
        assert flags[near_id] is False, \
            "本金不同的账号被误标为精确匹配（exact_match 恒真？)"

    def test_non_recycle_returns_empty(self, client):
        oid = client.post("/orders", json={
            "date": "2026-10-02", "type": "返点",
            "principal": 0, "profit": 100, "total": 0,
        }).json()["id"]
        r = client.get(f"/linkage/candidates/{oid}").json()
        assert r["candidates"] == []
        assert "回收" in r["note"]
