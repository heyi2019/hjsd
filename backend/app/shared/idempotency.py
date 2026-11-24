"""请求幂等：数据库唯一约束串行化重复提交。"""
from __future__ import annotations

import hashlib
import json
import re

from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.orm import Session

from app.core.errors import Conflict, ErrorCode, Validation
from app.domain.foundation import IdempotencyRecord


def reserve_idempotency(
    db: Session, *, user_id: int, scope: str, key: str | None, payload: BaseModel,
) -> tuple[IdempotencyRecord | None, dict | None]:
    if key is None:
        return None, None
    if not re.fullmatch(r"[!-~]{1,128}", key):
        raise Validation("Idempotency-Key 必须为 1 至 128 个可见 ASCII 字符")
    body = json.dumps(
        payload.model_dump(mode="json"), sort_keys=True, separators=(",", ":"), ensure_ascii=False,
    )
    digest = hashlib.sha256(body.encode("utf-8")).hexdigest()
    inserted = db.execute(
        insert(IdempotencyRecord).values(user_id=user_id, scope=scope, key=key, payload_hash=digest)
        .on_conflict_do_nothing(index_elements=["user_id", "scope", "key"])
        .returning(IdempotencyRecord)
    ).scalar_one_or_none()
    if inserted is not None:
        return inserted, None
    record = db.scalars(
        select(IdempotencyRecord).where(
            IdempotencyRecord.user_id == user_id,
            IdempotencyRecord.scope == scope,
            IdempotencyRecord.key == key,
        )
    ).one()
    if record.payload_hash != digest:
        raise Conflict("同一 Idempotency-Key 不能用于不同的请求内容", code=ErrorCode.IDEMPOTENCY_KEY_CONFLICT)
    if record.response is None:
        raise RuntimeError("幂等记录缺少成功响应")
    return None, record.response


def complete_idempotency(record: IdempotencyRecord | None, response: BaseModel) -> None:
    if record is not None:
        record.response = response.model_dump(mode="json")
