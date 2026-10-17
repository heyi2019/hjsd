"""强制 TH/DFQ 订单只保存账号文本，不关联库存账号。"""
from __future__ import annotations

import json

from alembic import op
from sqlalchemy import text


revision = "0086_enforce_text_only_order_accounts"
down_revision = "0085_remove_for_sale_account_status"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    current_sql = bind.execute(
        text("SELECT sql FROM sqlite_master WHERE type='table' AND name='orders'")
    ).scalar_one_or_none() or ""
    existing_constraints = {
        name
        for name in (
            "order_account_link_type_valid",
            "order_account_snapshot_type_valid",
        )
        if name in current_sql
    }
    if existing_constraints:
        with op.batch_alter_table("orders") as batch:
            for name in existing_constraints:
                batch.drop_constraint(name, type_="check")

    # 迁移历史脏数据：先把库存账号的可用文本复制到订单快照，再解除库存关联。
    rows = bind.execute(
        text(
            """
            SELECT o.id, o.account_snapshot,
                   a.game_account, a.game_type, a.game_password,
                   a.channel_region, a.bound_phone, a.has_secondary,
                   a.platform, a.note
            FROM orders AS o
            JOIN accounts AS a ON a.id = o.account_id
            WHERE o.order_type IN ('TH', 'DFQ') AND o.account_id IS NOT NULL
            """
        )
    ).mappings().all()
    for row in rows:
        snapshot = row["account_snapshot"]
        if snapshot is None:
            snapshot = json.dumps(
                {
                    key: row[key]
                    for key in (
                        "game_account",
                        "game_type",
                        "game_password",
                        "channel_region",
                        "bound_phone",
                        "has_secondary",
                        "platform",
                        "note",
                    )
                    if row[key] is not None
                },
                ensure_ascii=False,
            )
        bind.execute(
            text(
                "UPDATE orders SET account_snapshot = :snapshot, account_id = NULL "
                "WHERE id = :order_id"
            ),
            {"snapshot": snapshot, "order_id": row["id"]},
        )

    with op.batch_alter_table("orders") as batch:
        batch.create_check_constraint(
            "order_account_link_type_valid",
            "order_type NOT IN ('TH', 'DFQ') OR account_id IS NULL",
        )
        batch.create_check_constraint(
            "order_account_snapshot_type_valid",
            "order_type IN ('TH', 'DFQ') OR account_snapshot IS NULL OR account_snapshot = 'null'",
        )


def downgrade() -> None:
    with op.batch_alter_table("orders") as batch:
        batch.drop_constraint("order_account_snapshot_type_valid", type_="check")
        batch.drop_constraint("order_account_link_type_valid", type_="check")
