"""auth.service：登录账号、团队及密码变更的业务写入整合入口。

路由只负责鉴权、参数接收和响应映射；用户/团队写入与审计在本 Service 内完成，
由请求边界统一提交，避免出现业务已写入但审计遗漏的分裂事务。

实现已拆至 `settings/users/`（users / teams / _validation）；本文件保留整合出口，
调用方无需改动。
"""
from __future__ import annotations

from app.settings.users.teams import create_team, update_team
from app.settings.users.users import (
    change_password,
    change_username,
    create_user,
    reset_password,
    revoke_token,
    update_user,
)

__all__ = [
    "change_password",
    "change_username",
    "create_team",
    "create_user",
    "revoke_token",
    "reset_password",
    "update_team",
    "update_user",
]
