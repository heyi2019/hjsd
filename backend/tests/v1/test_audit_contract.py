"""audit 审计查询契约测试（BAS-05-03）。

既有测试只验证了审计留痕本身；本文件补查询端点的六个过滤维度
（对象类型/对象 ID/动作/操作人/起止日期）与分页，以及动作枚举端点。

注：`seed_foundation` 自身也会写入审计日志，因此断言一律走「按本用例专属
actor / entity_id 过滤后命中」而不是总数相等。
"""
from __future__ import annotations

from datetime import date

from sqlalchemy import select

from app.core.audit import record_audit
from app.domain.enums import AuditAction
from app.domain.foundation import AuditLog

TODAY = date.today()  # occurred_at 由 server_default now() 写入，必须用真实当天
MARK = "AUDIT-CONTRACT"  # 本文件专属标记，避免与种子审计混淆


def _audit(seeded_db, *, action, actor, entity_id, entity_type="order"):
    record_audit(
        seeded_db,
        action=action,
        entity_type=entity_type,
        entity_id=entity_id,
        actor=actor,
        after={"mark": MARK},
    )
    seeded_db.flush()


class TestAuditLogApi:
    def test_request_id_is_propagated_to_audit_and_response_header(
        self, seeded_client, seeded_db, headers
    ):
        request_id = "audit-trace-20261017"
        response = seeded_client.post(
            "/api/v1/pools",
            json={"code": "TRACE_POOL", "name": "审计追踪池"},
            headers={**headers, "X-Request-ID": request_id},
        )
        assert response.status_code == 201, response.text
        assert response.headers["x-request-id"] == request_id

        log = seeded_db.scalar(
            select(AuditLog)
            .where(
                AuditLog.action == AuditAction.POOL_CREATE.value,
                AuditLog.request_id == request_id,
            )
            .order_by(AuditLog.id.desc())
        )
        assert log is not None

        listed = seeded_client.get(
            "/api/v1/audit-logs",
            params={"entity_type": "Pool", "entity_id": log.entity_id},
            headers=headers,
        )
        assert listed.status_code == 200, listed.text
        assert listed.json()["items"][0]["request_id"] == request_id

    def test_query_filters_and_pagination(self, seeded_client, seeded_db, headers):
        _audit(
            seeded_db, action=AuditAction.ORDER_CREATE, actor="alice",
            entity_id=990001,
        )
        _audit(
            seeded_db, action=AuditAction.EVENT_POST, actor="bob",
            entity_id=990002,
        )
        # 另一实体类型：用于证明 entity_type 过滤真的生效（而非返回全量）
        _audit(
            seeded_db, action=AuditAction.EVENT_POST, actor="carol",
            entity_id=990003, entity_type="ledger_probe",
        )

        # 动作过滤（action 入参统一转大写）
        by_action = seeded_client.get(
            "/api/v1/audit-logs", params={"action": "event_post"}, headers=headers
        )
        assert by_action.status_code == 200, by_action.text
        assert "990002" in [item["entity_id"] for item in by_action.json()["items"]]
        assert "990001" not in [item["entity_id"] for item in by_action.json()["items"]]

        # 对象类型 → 只回 order 实体，ledger_probe 必须被排除
        by_type = seeded_client.get(
            "/api/v1/audit-logs", params={"entity_type": "order"}, headers=headers
        )
        ids = [item["entity_id"] for item in by_type.json()["items"]]
        assert "990001" in ids and "990002" in ids
        assert "990003" not in ids

        # 对象 ID + 操作人（entity_id 是整型入参，字符串列按 SQLite 亲和性比较）
        by_entity = seeded_client.get(
            "/api/v1/audit-logs", params={"entity_id": 990001}, headers=headers
        )
        assert [item["actor"] for item in by_entity.json()["items"]] == ["alice"]
        by_actor = seeded_client.get(
            "/api/v1/audit-logs", params={"actor": "bob"}, headers=headers
        )
        assert [item["action"] for item in by_actor.json()["items"]] == [
            AuditAction.EVENT_POST.value
        ]

        # 时间范围（种子与本用例日志都在今天）
        windowed = seeded_client.get(
            "/api/v1/audit-logs",
            params={"from": TODAY.isoformat(), "to": TODAY.isoformat()},
            headers=headers,
        )
        assert windowed.status_code == 200, windowed.text
        assert windowed.json()["total"] >= 2
        # 分页：limit=1 时只回一条，offset=1 起换下一批
        first_page = seeded_client.get(
            "/api/v1/audit-logs",
            params={"actor": "bob", "limit": 1, "offset": 0},
            headers=headers,
        )
        assert len(first_page.json()["items"]) == 1
        second_page = seeded_client.get(
            "/api/v1/audit-logs",
            params={"actor": "bob", "limit": 1, "offset": 1},
            headers=headers,
        )
        assert second_page.json()["items"] == []

    def test_actions_endpoint_lists_enum(self, seeded_client, headers):
        response = seeded_client.get("/api/v1/audit-logs/actions", headers=headers)
        assert response.status_code == 200, response.text
        assert AuditAction.ORDER_CREATE.value in response.json()["items"]

    def test_entity_id_accepts_business_numbers(self, seeded_client, seeded_db, headers):
        _audit(
            seeded_db,
            action=AuditAction.ORDER_CREATE,
            actor="numbered-order",
            entity_id="HS0094",
        )
        response = seeded_client.get(
            "/api/v1/audit-logs", params={"entity_id": "HS0094"}, headers=headers
        )
        assert response.status_code == 200, response.text
        assert [row["actor"] for row in response.json()["items"]] == ["numbered-order"]
