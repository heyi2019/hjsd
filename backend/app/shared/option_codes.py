"""事务内分配不可重复使用的选项编码。"""
from __future__ import annotations

import hashlib
import re

from sqlalchemy import update
from sqlalchemy.orm import Session

from app.domain.foundation import DocumentSequence
from app.shared.numbering import allocate_number, ensure_sequence


def option_sequence_key(namespace: str) -> str:
    return "OPTION_" + hashlib.sha256(namespace.encode("utf-8")).hexdigest()[:32]


def normalize_option_prefix(prefix: str) -> str:
    prefix = re.sub(r"[^a-z0-9]+", "_", prefix.lower()).strip("_")
    if not prefix:
        raise ValueError("选项编码前缀不能为空")
    return prefix


def sync_option_sequence(session: Session, namespace: str, prefix: str, existing: list[str]) -> tuple[str, str]:
    """让序列至少覆盖当前和已归档的编码，避免重新分配历史值。"""
    prefix = normalize_option_prefix(prefix)
    key = option_sequence_key(namespace)
    ensure_sequence(session, key, "D", 2)
    pattern = re.compile(rf"^{re.escape(prefix)}_(\d+)$")
    highest = max((int(match.group(1)) for value in existing if (match := pattern.fullmatch(value))), default=0)
    session.execute(update(DocumentSequence).where(
        DocumentSequence.sequence_key == key, DocumentSequence.current_value < highest,
    ).values(current_value=highest))
    return key, prefix


def allocate_option_code(session: Session, namespace: str, prefix: str, existing: list[str]) -> str:
    key, prefix = sync_option_sequence(session, namespace, prefix, existing)
    return f"{prefix}_{allocate_number(session, key)[1:]}"
