"""Create or update the initial administrator.

Usage: ADMIN_PASSWORD='a-strong-password' python scripts/create_admin.py
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from sqlalchemy import select  # noqa: E402

from app.core.database import Base, get_engine, get_session_factory  # noqa: E402
from app.core.security import hash_password  # noqa: E402
from app.domain import foundation, parties, quality, trade, users  # noqa: E402,F401
from app.domain.users import User  # noqa: E402


def main() -> None:
    password = os.environ.get("ADMIN_PASSWORD")
    if not password:
        raise SystemExit("请设置 ADMIN_PASSWORD 环境变量（至少 8 位）")
    Base.metadata.create_all(get_engine())
    session = get_session_factory()()
    try:
        user = session.scalar(select(User).where(User.username == "admin"))
        if user is None:
            user = User(username="admin", display_name="系统管理员", role="ADMIN", owner_scope="ALL", password_hash=hash_password(password))
            session.add(user)
        else:
            user.password_hash = hash_password(password)
            user.is_active = True
            user.role = "ADMIN"
        session.commit()
        print("管理员账号已就绪：admin")
    finally:
        session.close()


if __name__ == "__main__":
    main()
