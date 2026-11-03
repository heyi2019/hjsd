"""按 WPS 订单表实际出现的业务人员，在 ERP 中建立对应身份。

默认 dry-run，加 --apply 才写库。

口径：
- 何一（老板）→ ADMIN，pool_ids 全量，owner_scope=SELF（is_admin 已覆盖全量数据）
- 小周 / 凯文 / 吉祥（一线回收 + 售卖）→ OPERATOR，pool_ids 全量
- 统一初始密码，首登强制修改（service 自带 must_change_password=True）

幂等：按 username 判重，已存在则跳过，不覆盖。
"""
from __future__ import annotations

import sys
from pathlib import Path

BACKEND = Path("/Users/aries/黑金时代/backend")
sys.path.insert(0, str(BACKEND))

from sqlalchemy import create_engine, select, text  # noqa: E402
from sqlalchemy.orm import Session  # noqa: E402

from app.auth import service as auth_service  # noqa: E402
from app.core.settings import get_settings  # noqa: E402
from app.domain.users import User  # noqa: E402

INIT_PASSWORD = "Hj@2026init"

# username, display_name, role, 备注
PEOPLE = [
    ("heyi", "何一", "ADMIN", "WPS 历史数据导入：本人（老板），ADMIN 全量权限"),
    ("xiaozhou", "小周", "OPERATOR", "WPS 历史数据导入：回收 17 单 / 售卖 15 单"),
    ("kaiwen", "凯文", "OPERATOR", "WPS 历史数据导入：回收 11 单 / 售卖 10 单"),
    ("jixiang", "吉祥", "OPERATOR", "WPS 历史数据导入：回收 3 单 / 售卖 2 单"),
]

POOL_IDS = [1, 2]  # HJ_INVEST(1) / HJ_PROFIT(2)


def main(apply: bool) -> None:
    settings = get_settings()
    engine = create_engine(settings.alembic_url)
    session = Session(engine)

    print(f"目标库方言: {settings.alembic_url.split('://')[0]}")
    print(f"模式: {'APPLY 写库' if apply else 'DRY-RUN 只预览'}")
    print()

    existing = {
        u.username: u for u in session.scalars(select(User)).all()
    }
    print(f"现有账号 {len(existing)} 个: {sorted(existing)}")
    print()

    created, skipped = [], []
    for username, display_name, role, note in PEOPLE:
        if username in existing:
            skipped.append(username)
            print(f"  跳过 {username:10s} 已存在（id={existing[username].id}）")
            continue
        # 重名检查：display_name 也避免重复
        dup = [u for u in existing.values() if u.display_name == display_name]
        if dup:
            skipped.append(username)
            print(f"  跳过 {username:10s} 显示名「{display_name}」已被 id={dup[0].id} 占用")
            continue
        print(f"  建人 {username:10s} {display_name:4s} {role:9s} pool_ids={POOL_IDS}")
        if apply:
            user = auth_service.create_user(
                session,
                username=username,
                display_name=display_name,
                password=INIT_PASSWORD,
                role=role,
                owner_scope="SELF",
                pool_ids=POOL_IDS,
                team_ids=[],
                phone=None,
                note=note,
                actor="三三",
            )
            created.append((user.id, username, display_name, role))
        else:
            created.append((None, username, display_name, role))

    if apply:
        session.commit()
        print()
        print("已提交。新建：")
        for uid, un, dn, role in created:
            print(f"  id={uid}  {un:10s} {dn:4s} {role}")
    else:
        print()
        print("（dry-run 未写库，加 --apply 执行）")

    print()
    print("=== 建后全量账号 ===")
    for u in session.scalars(select(User).order_by(User.id)).all():
        print(
            f"  id={u.id:<3} {u.username:20s} {u.display_name:8s} {u.role:9s} "
            f"{u.owner_scope:5s} pools={u.pool_ids} active={u.is_active}"
        )
    session.close()


if __name__ == "__main__":
    main("--apply" in sys.argv)
