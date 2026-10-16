"""Rebuild tables so foreign keys carry the ORM naming-convention names.

背景：ECS 生产库早期迁移（0001–0005）用 `op.create_table` 建表，未套用
`NAMING_CONVENTION`，外键落到磁盘是**未命名**的；而 ORM 经约定生成命名外键
（`fk_<table>_<col>`），导致 `alembic check` 报 FK 命名漂移。SQLite 不存储外键名、
完整性照常生效（功能性无害），但为消除漂移、对齐 dev/prod 两环境，统一重建。

实现（每张表）：从真实 ORM 元数据编译 CREATE TABLE（命名约束正确）→ 把表头名改为
`_new_<t>` → 建临时表 → 拷贝数据 → 删旧表 → 改名 → 重建命名索引。依赖 env.py 已覆盖的
`PRAGMA foreign_keys=OFF`（批量重建父表需关闭 FK 强制）。

为何不用 batch_alter_table：2.0.35 反射未命名 FK 为 name=None，`drop_constraint(name)`
按名删找不到；只 `create_foreign_key` 会生成重复 FK。故走整表重建路径。
"""
from alembic import op
from sqlalchemy import text
from sqlalchemy.schema import CreateTable

from app.core.database import Base  # noqa: F401  注册全部 v1 表
from app.domain import foundation, history, parties, trade, users  # noqa: F401

revision = "0009_rename_fks_to_named"
down_revision = "0008_integrity_constraints"
branch_labels = None
depends_on = None

# 需重建的表（alembic check 在 2.0.35 下报 FK 命名漂移的表）
TABLES = [
    "cashflow",
    "deposits",
    "import_batches",
    "import_rows",
    "installment_schedules",
    "installments",
    "order_events",
    "order_profit_allocations",
    "orders",
    "policy_versions",
    "rebate_records",
    "rebate_settlements",
]


def _rebuild(bind, tname: str) -> None:
    orm_t = Base.metadata.tables[tname]
    ddl = str(CreateTable(orm_t).compile(dialect=bind.dialect))
    # 0009 位于 0015 之前；当前 ORM 已包含后来新增的分期服务费字段。
    # 只在迁移当时的真实字段集合上重建，避免把未来字段提前写进临时表，
    # 随后 0015 再次 add_column 时发生重复列错误。
    source_columns = [row[1] for row in bind.execute(text(f"PRAGMA table_info({tname})"))]
    if tname == "installments":
        ddl = ddl.replace("\tservice_fee NUMERIC(18, 2) NOT NULL, \n", "")
        ddl = ddl.replace("\tper_period_service_fee NUMERIC(18, 2) NOT NULL, \n", "")
        ddl = ddl.replace(" AND service_fee >= 0 AND per_period_service_fee >= 0", "")
        if "waived_amount" not in source_columns:
            ddl = ddl.replace("\twaived_amount NUMERIC(18, 2) NOT NULL, \n", "")
            ddl = ddl.replace(" AND waived_amount >= 0", "")
    if tname == "installment_schedules" and "waived_amount" not in source_columns:
        ddl = ddl.replace("\twaived_amount NUMERIC(18, 2) NOT NULL, \n", "")
        ddl = ddl.replace(" AND waived_amount >= 0", "")
        ddl = ddl.replace(
            "\tCONSTRAINT ck_installment_schedules_settled_amount_within_due CHECK (received_amount + waived_amount <= due_amount), \n",
            "",
        )
    # deposit_no 在 0021 才正式移除；即使当前 ORM 已经去掉它，
    # 0009 仍必须把历史字段带过重建，否则 0021 无法完成正式删除。
    if tname == "deposits" and "deposit_no" in source_columns:
        ddl = ddl.replace(
            "CREATE TABLE deposits (",
            "CREATE TABLE deposits (\n\tdeposit_no VARCHAR(32) NOT NULL,",
            1,
        )
        ddl = ddl.replace(
            "CONSTRAINT pk_deposits PRIMARY KEY (id),",
            "CONSTRAINT pk_deposits PRIMARY KEY (id),\n\tCONSTRAINT uq_deposits_no UNIQUE (deposit_no),",
            1,
        )
    # 押金损失字段直到 0042 才加入；0009 仍处于历史字段重建阶段，不能提前把
    # 当前 ORM 的新列带进来，否则 0042 会重复添加。
    if tname == "deposits" and "lost_amount" not in source_columns:
        ddl = ddl.replace("\tlost_amount NUMERIC(18, 2) NOT NULL, \n", "")
        ddl = ddl.replace("\tlost_on DATE, \n", "")
        ddl = ddl.replace("'LOST', ", "")
        ddl = ddl.replace(" AND lost_amount >= 0", "")
        ddl = ddl.replace(
            "\tCONSTRAINT ck_deposits_released_amount_within_paid CHECK (returned_amount + lost_amount <= paid_amount), \n",
            "",
        )
    # rebate_group_no 在 0022 才统一命名为 rebate_no；0009 必须保留旧列，
    # 避免当前 ORM 重命名后在历史重建阶段提前丢失数据。
    if tname == "rebate_records" and "rebate_group_no" in source_columns:
        ddl = ddl.replace("rebate_no", "rebate_group_no")
    # link_status 的封闭校验分别在 0061 才正式加入；0009 位于该迁移之前，
    # 不能在历史重建阶段提前创建，否则后续迁移会重复添加同名约束。
    if tname == "orders":
        ddl = ddl.replace(
            "\tCONSTRAINT ck_orders_order_link_status_valid CHECK (link_status IN ('LINKED', 'UNLINKED', 'ORPHAN', 'UNLINKED_TRANSFER')), \n",
            "",
        )
    if tname == "rebate_records":
        ddl = ddl.replace(
            "\tCONSTRAINT ck_rebate_records_rebate_link_status_valid CHECK (link_status IN ('LINKED', 'UNLINKED', 'ORPHAN', 'UNLINKED_TRANSFER')), \n",
            "",
        )
    # reversal_of_id 属于 0040 才新增的返点结算字段；0009 使用当前 ORM
    # 编译 DDL，但历史表此时还没有该列，必须把未来字段及其自引用约束移除。
    if tname == "rebate_settlements" and "reversal_of_id" not in source_columns:
        ddl = ddl.replace("\treversal_of_id INTEGER, \n", "")
        ddl = ddl.replace(
            "\tCONSTRAINT uq_rebate_settlements_reversal UNIQUE (reversal_of_id), \n",
            "",
        )
        ddl = ddl.replace(
            "\tCONSTRAINT fk_rebate_settlements_reversal_of_id FOREIGN KEY(reversal_of_id) REFERENCES rebate_settlements (id) ON DELETE RESTRICT\n",
            "",
        )
        ddl = ddl.replace(", \n)", "\n)")
    ddl = ddl.replace(f"CREATE TABLE {tname} (", f"CREATE TABLE _new_{tname} (", 1)
    bind.execute(text(f"DROP TABLE IF EXISTS _new_{tname}"))
    bind.execute(text(ddl))
    cols = [c.name for c in orm_t.columns if c.name in source_columns]
    if tname == "deposits" and "deposit_no" in source_columns:
        cols.insert(0, "deposit_no")
    if tname == "rebate_records" and "rebate_group_no" in source_columns:
        cols = ["rebate_group_no" if column == "rebate_no" else column for column in cols]
    col_sql = ", ".join(cols)
    bind.execute(
        text(f"INSERT INTO _new_{tname} ({col_sql}) SELECT {col_sql} FROM {tname}")
    )
    bind.execute(text(f"DROP TABLE {tname}"))
    bind.execute(text(f"ALTER TABLE _new_{tname} RENAME TO {tname}"))
    # 在最终表名上重建命名索引（含唯一），IF NOT EXISTS 幂等。
    # 必须放 RENAME 之后：旧表（及其同名索引）已删除，避免
    # `CREATE INDEX IF NOT EXISTS` 因全局同名索引已存在而静默跳过、随后被 DROP 旧表带走。
    for idx in orm_t.indexes:
        if (
            tname == "rebate_settlements"
            and "reversal_of_id" not in source_columns
            and any(column.name == "reversal_of_id" for column in idx.columns)
        ):
            continue
        uniq = "UNIQUE " if idx.unique else ""
        cexpr = ", ".join(c.name for c in idx.columns)
        bind.execute(
            text(f"CREATE {uniq}INDEX IF NOT EXISTS {idx.name} ON {tname} ({cexpr})")
        )


def upgrade() -> None:
    bind = op.get_bind()
    # 防御：确保环境已关闭 FK 强制（env.py 已覆盖；此处再确认）
    bind.execute(text("PRAGMA foreign_keys=OFF"))
    # 整批重建 12 张表，使其外键/索引对齐 ORM 命名约定。
    # 不做“是否需要重建”的预判断：SQLite 反射经 PRAGMA 返回的外键名为 NULL，
    # 与磁盘 CREATE TABLE 文本是否含命名约束无关，预判断会漏判（policy_versions 即此例）。
    # 重建是幂等的：重跑产生相同 DDL + 数据零丢失。
    for tname in TABLES:
        _rebuild(bind, tname)


def downgrade() -> None:
    # 命名外键→未命名属可接受的回退形态（drift 回到 0008 状态）；
    # 因重建是不可逆的结构变换，downgrade 不强制复原，仅保留版本回退能力。
    # 如需完全还原 0008，应从备份恢复。
    pass
