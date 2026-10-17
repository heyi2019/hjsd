"""返点记录必须关联来源订单。"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "0082_require_rebate_order"
down_revision = "0081_attachments"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    unlinked_count = bind.execute(
        sa.text("SELECT COUNT(*) FROM rebate_records WHERE source_order_id IS NULL")
    ).scalar_one()
    if unlinked_count:
        raise RuntimeError(
            "rebate_records 仍有未关联订单的返点记录，未执行收紧；"
            "请先按标准订单导入并人工归集后再迁移"
        )

    with op.batch_alter_table("rebate_records") as batch:
        batch.drop_constraint("fk_rebate_records_source_order_id", type_="foreignkey")
        batch.alter_column(
            "source_order_id",
            existing_type=sa.Integer(),
            existing_nullable=True,
            nullable=False,
        )
        batch.create_foreign_key(
            "fk_rebate_records_source_order_id",
            "orders",
            ["source_order_id"],
            ["id"],
            ondelete="RESTRICT",
        )


def downgrade() -> None:
    with op.batch_alter_table("rebate_records") as batch:
        batch.drop_constraint("fk_rebate_records_source_order_id", type_="foreignkey")
        batch.alter_column(
            "source_order_id",
            existing_type=sa.Integer(),
            existing_nullable=False,
            nullable=True,
        )
        batch.create_foreign_key(
            "fk_rebate_records_source_order_id",
            "orders",
            ["source_order_id"],
            ["id"],
            ondelete="SET NULL",
        )
