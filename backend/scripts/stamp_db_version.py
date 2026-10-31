"""部署时把当前发布版本戳记进 db_version 审计表。

决策：数据库版本「随推送版本来」——等于发布/推送的 app 版本号（如 1.0.1），
每次发版由本脚本写一条审计记录（app_version + alembic_revision + applied_at），
可追溯「哪个发布版本动了库、落到哪个 schema 态」。不再使用独立迁移风格计数器。

用法（部署流程在 `alembic upgrade head` 之后调用）：
    python scripts/stamp_db_version.py                 # 版本/ revision 自动探测
    python scripts/stamp_db_version.py --version 1.0.2 --notes "hotfix"
    APP_VERSION=1.0.2 python scripts/stamp_db_version.py

- app_version 优先级：--version > 环境变量 APP_VERSION > app/version.py 的 __version__
- alembic_revision 优先级：--revision > 当前 alembic_version 表记录
审计表每次调用追加一行（保留部署历史），「当前 DB 版本」取 applied_at 最大的一行。
"""

from __future__ import annotations

import argparse
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

# 让脚本在「任意调用目录」（本地直跑 / 容器内 / docker compose run）都能 import app 包。
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from sqlalchemy import create_engine, text

from app.core.settings import get_settings  # noqa: E402
from app.version import __version__ as CODE_VERSION  # noqa: E402

_DDL = """
CREATE TABLE IF NOT EXISTS db_version (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    app_version       VARCHAR(32)  NOT NULL,
    alembic_revision  VARCHAR(64)  NOT NULL,
    applied_at        DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    notes             TEXT
)
"""


def _resolve_app_version(arg: str | None) -> str:
    if arg:
        return arg
    if os.environ.get("APP_VERSION"):
        return os.environ["APP_VERSION"]
    return CODE_VERSION


def _resolve_revision(engine, arg: str | None) -> str:
    if arg:
        return arg
    with engine.connect() as conn:
        row = conn.execute(text("SELECT version_num FROM alembic_version LIMIT 1")).fetchone()
    if row:
        return row[0]
    return "unknown"


def main() -> int:
    parser = argparse.ArgumentParser(description="戳记数据库版本到 db_version 审计表")
    parser.add_argument("--version", help="发布版本号，缺省取 APP_VERSION / app.version.__version__")
    parser.add_argument("--revision", help="alembic revision，缺省取 alembic_version 表当前值")
    parser.add_argument("--notes", default=None, help="备注（可选）")
    args = parser.parse_args()

    settings = get_settings()
    engine = create_engine(settings.sqlalchemy_url)

    # 防御性建表：正常部署顺序下已由迁移 0003 建好，此处兜底避免脚本前置依赖过强。
    with engine.begin() as conn:
        conn.execute(text(_DDL))

    app_version = _resolve_app_version(args.version)
    alembic_revision = _resolve_revision(engine, args.revision)
    applied_at = datetime.now(timezone.utc).replace(microsecond=0)

    with engine.begin() as conn:
        conn.execute(
            text(
                "INSERT INTO db_version (app_version, alembic_revision, applied_at, notes) "
                "VALUES (:v, :r, :t, :n)"
            ),
            {"v": app_version, "r": alembic_revision, "t": applied_at, "n": args.notes},
        )
        row = conn.execute(
            text("SELECT id, app_version, alembic_revision, applied_at FROM db_version ORDER BY id DESC LIMIT 1")
        ).fetchone()

    print(
        f"✓ db_version 已戳记：id={row[0]} app_version={row[1]} "
        f"alembic_revision={row[2]} applied_at={row[3]}"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
