"""清理前端联调遗留的测试主数据（团队 / 合作方 / 用户），不动业务单据。

识别依据：编码或名称里含 TEST / 测试 / 全页面 / 重复验证 / 格式 等联调标记。

用法：
    python cleanup_test_master.py            # dry-run
    python cleanup_test_master.py --apply    # 写库
"""

from __future__ import annotations

import argparse
import sys

sys.path.insert(0, "/Users/aries/黑金时代/backend")

from sqlalchemy import create_engine, select, text  # noqa: E402
from sqlalchemy.orm import Session  # noqa: E402

from app.auth import service as auth_service  # noqa: E402
from app.core.settings import get_settings  # noqa: E402
from app.domain.parties import Counterparty  # noqa: E402
from app.domain.users import Team, User  # noqa: E402
from app.parties import counterparties as cp_service  # noqa: E402

ACTOR = "data-cleanup"

TEST_TEAM_CODES = {"TEAM_TEST_20261101", "前端测试团队-20261101"}
TEST_CP_NOS = {"CP0002", "CP0003", "CP0004"}
TEST_USERNAMES = {"user_test_20261101"}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true")
    args = ap.parse_args()

    engine = create_engine(get_settings().alembic_url)
    session = Session(engine)
    try:
        teams = [t for t in session.scalars(select(Team).order_by(Team.id)) if t.code in TEST_TEAM_CODES]
        cps = [c for c in session.scalars(select(Counterparty).order_by(Counterparty.id)) if c.counterparty_no in TEST_CP_NOS]
        users = [u for u in session.scalars(select(User).order_by(User.id)) if u.username in TEST_USERNAMES]

        print("=== 待停用团队 ===")
        for t in teams:
            print(f"  {t.id} {t.code} | {t.name} | is_active={t.is_active}")
        print("=== 待停用合作方 ===")
        for c in cps:
            print(f"  {c.counterparty_no} {c.display_name} | status={c.status}")
        print("=== 待停用用户 ===")
        for u in users:
            print(f"  {u.id} {u.username} | {u.display_name} | is_active={u.is_active}")

        print()
        print("=== 保留不动（需人工判断）===")
        for c in session.scalars(select(Counterparty).order_by(Counterparty.id)):
            if c.counterparty_no not in TEST_CP_NOS:
                print(f"  {c.counterparty_no} {c.display_name} | type={c.type} source={c.source}")

        if not args.apply:
            print("\ndry-run 结束。加 --apply 才写库。")
            return

        for t in teams:
            if t.is_active:
                auth_service.update_team(session, t.id, changes={"is_active": False}, actor=ACTOR)
                print(f"团队已停用 {t.code}")
        for c in cps:
            if c.status != "DISABLED":
                cp_service.set_counterparty_status(session, c.id, False, actor=ACTOR)
                print(f"合作方已停用 {c.counterparty_no}")
        for u in users:
            if u.is_active:
                auth_service.update_user(session, u.id, changes={"is_active": False}, actor=ACTOR)
                print(f"用户已停用 {u.username}")
        session.commit()
        print("\n提交完成。")
    except Exception:
        session.rollback()
        raise
    finally:
        session.close()


if __name__ == "__main__":
    main()
