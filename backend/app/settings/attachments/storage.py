"""Keep uploaded files tied to the database transaction that owns them."""
from __future__ import annotations

import logging
from pathlib import Path

from sqlalchemy import event
from sqlalchemy.orm import Session, SessionTransaction

_LOGGER = logging.getLogger(__name__)
_PENDING_KEY = "attachment_pending_files"


def _remove(paths: set[Path]) -> None:
    for path in paths:
        try:
            path.unlink(missing_ok=True)
        except OSError:
            _LOGGER.exception("无法清理未提交的附件文件: %s", path)


def track_file(session: Session, path: Path) -> None:
    """Delete on rollback/close; promote nested commits to the parent transaction."""
    pending: dict[SessionTransaction, set[Path]] | None = session.info.get(_PENDING_KEY)
    if pending is None:
        pending = {}
        session.info[_PENDING_KEY] = pending

        def current(db: Session) -> SessionTransaction | None:
            return db.get_nested_transaction() or db.get_transaction()

        def committed(db: Session) -> None:
            transaction = current(db)
            if transaction is None:
                return
            paths = pending.pop(transaction, set())
            if transaction.nested and transaction.parent is not None:
                pending.setdefault(transaction.parent, set()).update(paths)

        def rolled_back(db: Session) -> None:
            transaction = current(db)
            if transaction is not None:
                _remove(pending.pop(transaction, set()))

        def ended(_db: Session, transaction: SessionTransaction) -> None:
            # Session.close() ends an uncommitted transaction without after_rollback.
            _remove(pending.pop(transaction, set()))

        event.listen(session, "after_commit", committed)
        event.listen(session, "after_rollback", rolled_back)
        event.listen(session, "after_transaction_end", ended)

    transaction = session.get_nested_transaction() or session.get_transaction()
    if transaction is None:
        raise RuntimeError("保存附件必须处于数据库事务中")
    pending.setdefault(transaction, set()).add(path)
