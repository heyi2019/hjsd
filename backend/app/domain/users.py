"""Users and role assignments for the first-class login module."""
from __future__ import annotations

from datetime import date, datetime

from sqlalchemy import (
    Boolean, CheckConstraint, Date, DateTime, ForeignKey, Index, Integer, JSON, String, Text, UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base
from app.domain.base import TimestampMixin


class Team(Base, TimestampMixin):
    __tablename__ = "teams"
    __table_args__ = (UniqueConstraint("code", name="uq_teams_code"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    code: Mapped[str] = mapped_column(String(64), nullable=False)
    name: Mapped[str] = mapped_column(String(128), nullable=False)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)


class User(Base, TimestampMixin):
    __tablename__ = "users"
    __table_args__ = (
        Index("ix_users_handover_user_id", "handover_user_id"),
        UniqueConstraint("username", name="uq_users_username"),
        UniqueConstraint("phone", name="uq_users_phone"),
        CheckConstraint(
            "role IN ('ADMIN', 'OPERATOR', 'FINANCE', 'AUDITOR', 'VIEWER', 'EMPLOYEE')",
            name="role_valid",
        ),
        CheckConstraint(
            "owner_scope IN ('SELF', 'TEAM', 'ALL')",
            name="owner_scope_valid",
        ),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    username: Mapped[str] = mapped_column(String(64), nullable=False)
    display_name: Mapped[str] = mapped_column(String(128), nullable=False)
    password_hash: Mapped[str] = mapped_column(String(256), nullable=False)
    role: Mapped[str] = mapped_column(String(32), nullable=False, default="VIEWER")
    owner_scope: Mapped[str] = mapped_column(String(16), nullable=False, default="SELF")
    pool_ids: Mapped[list] = mapped_column(JSON, nullable=False, default=list)
    team_ids: Mapped[list] = mapped_column(JSON, nullable=False, default=list)
    phone: Mapped[str | None] = mapped_column(String(32), nullable=True)
    hired_on: Mapped[date | None] = mapped_column(Date, nullable=True)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    deactivated_on: Mapped[date | None] = mapped_column(Date, nullable=True)
    handover_user_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    handover_note: Mapped[str | None] = mapped_column(Text, nullable=True)
    must_change_password: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    note: Mapped[str | None] = mapped_column(Text, nullable=True)


class RevokedToken(Base):
    __tablename__ = "revoked_tokens"
    __table_args__ = (
        CheckConstraint("expires_at > 0", name="expires_at_positive"),
    )

    jti: Mapped[str] = mapped_column(String(64), primary_key=True)
    expires_at: Mapped[int] = mapped_column(Integer, nullable=False)


class UserWeChatBinding(Base, TimestampMixin):
    """微信身份与系统账号的绑定关系。

    设计口径（2026-11-05）：
    - 一个账号在同一通道下只能绑一个微信；一个 open_id 也只能绑一个账号。
    - `bound_phone` 记录绑定时校验通过的手机号快照，便于事后追责；
      真正的准入依据始终是 `users.phone`，改手机号必须重新绑定（见 service 层校验）。
    - 通道用 `provider` 区分，mock 与 openplatform 互不干扰，切换通道后旧绑定自然失效。
    """

    __tablename__ = "user_wechat_bindings"
    __table_args__ = (
        UniqueConstraint("provider", "open_id", name="uq_wechat_bindings_provider_openid"),
        UniqueConstraint("user_id", "provider", name="uq_wechat_bindings_user_provider"),
        CheckConstraint(
            "provider IN ('MOCK', 'OPEN_PLATFORM')",
            # 短名：Base.metadata 的命名约定会补成 ck_user_wechat_bindings_provider_valid。
            # 写成带 ck_ 前缀的长名会变成 ck_user_wechat_bindings_ck_wechat_bindings_...（实测踩到）。
            name="provider_valid",
        ),
        Index("ix_wechat_bindings_open_id", "open_id"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    provider: Mapped[str] = mapped_column(String(32), nullable=False)
    open_id: Mapped[str] = mapped_column(String(128), nullable=False)
    union_id: Mapped[str | None] = mapped_column(String(128), nullable=True)
    nickname: Mapped[str | None] = mapped_column(String(128), nullable=True)
    avatar_url: Mapped[str | None] = mapped_column(Text, nullable=True)
    bound_phone: Mapped[str | None] = mapped_column(String(32), nullable=True)
    last_login_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
