"""E2E 夹具：补齐 DEV 态 X-Dev-User 映射所需的 operator/finance/auditor/viewer 真实用户行。

为什么需要：后端 app/core/security.py 在 DEV 态把 operator->id=2、finance->id=3、
auditor->id=4、viewer->id=5 硬编码为「假 CurrentUser」用于鉴权旁路；但 PATCH /users/2、
GET /pools（按 owner_scope 过滤）等接口仍查询**真实 DB 用户行**。若 e2e 库只有 admin(id=1)，
则 user id=2 不存在，相关联调用例会 422/404。本脚本按 DEV 映射顺序补齐这 4 个用户（id 2..5），
使 e2e 联调能跑通数据范围/权限相关用例。

仅用于本地 E2E，写入隔离的 heijin_erp_e2e.db（绝不碰生产库 heijin_erp_v1.db）。
幂等：用户已存在则跳过。
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
from app.domain.users import User  # noqa: E402

# (username, role, display_name) —— id 由插入顺序决定：create_admin 已建 admin=1，以下依次为 2..5，
# 与 app/core/security.py 的 DEV 用户映射严格一致。
DEV_USERS = [
    ("operator", "OPERATOR", "业务经办人"),
    ("finance", "FINANCE", "财务"),
    ("auditor", "AUDITOR", "审核人"),
    ("viewer", "VIEWER", "经营查看人"),
]


def main() -> None:
    password = os.environ.get("ERP_E2E_USER_PASSWORD", "12345678")
    Base.metadata.create_all(get_engine())
    session = get_session_factory()()
    try:
        for username, role, display_name in DEV_USERS:
            existing = session.scalar(select(User).where(User.username == username))
            if existing is None:
                session.add(
                    User(
                        username=username,
                        display_name=display_name,
                        role=role,
                        owner_scope="ALL",
                        password_hash=hash_password(password),
                    )
                )
                print(f"[e2e-users] 已创建：{username}({role})")
            else:
                print(f"[e2e-users] SKIP：{username} 已存在")
        session.commit()
    finally:
        session.close()


if __name__ == "__main__":
    main()
