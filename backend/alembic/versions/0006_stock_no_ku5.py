"""0006 库存编号改版：KU_ + 五位顺序号（2026-10-28 用户裁决）。

口径：
- 格式由 `KU` + 4 位（KU0001…）改为 `KU_` + 5 位（KU_00001…）；
- 存量账号全量重刷：按 accounts.id 升序重编为 KU_00001…（与原 KU0001… 发放顺序一致）；
- STOCK_NO 序列 prefix='KU_'、padding=5，current_value 不变（继续顺延）；
- 纯数据变更，无表结构改动；老格式编号与新格式前缀不同，重刷无唯一键冲突。

downgrade 按同一 id 序重刷回 KU + 4 位（仅可还原重刷时刻的号段，
之后新发的 KU_00xxx 号无法无损回转，属预期有损回滚）。
"""
from __future__ import annotations

from alembic import op
from sqlalchemy import text

revision = "0006"
down_revision = "0005"
branch_labels = None
depends_on = None

_RENUMBER_TO_KU5 = (
    "UPDATE accounts SET stock_no = 'KU_' || printf('%05d', "
    "(SELECT COUNT(*) FROM accounts AS prev WHERE prev.id <= accounts.id))"
)
_RENUMBER_TO_KU4 = (
    "UPDATE accounts SET stock_no = 'KU' || printf('%04d', "
    "(SELECT COUNT(*) FROM accounts AS prev WHERE prev.id <= accounts.id))"
)


def _renumber(sql: str) -> None:
    """按 id 升序整表重刷 stock_no（同语句内自关联计数，天然逐行唯一）。"""
    op.execute(text(sql))


def upgrade() -> None:
    _renumber(_RENUMBER_TO_KU5)
    op.execute(
        text(
            "UPDATE document_sequences SET prefix = 'KU_', padding = 5, "
            "current_value = (SELECT COUNT(*) FROM accounts), "
            "updated_at = CURRENT_TIMESTAMP WHERE sequence_key = 'STOCK_NO'"
        )
    )


def downgrade() -> None:
    _renumber(_RENUMBER_TO_KU4)
    op.execute(
        text(
            "UPDATE document_sequences SET prefix = 'KU', padding = 4, "
            "updated_at = CURRENT_TIMESTAMP WHERE sequence_key = 'STOCK_NO'"
        )
    )
