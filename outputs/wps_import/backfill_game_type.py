"""把库存账号的 game_type 统一回填为「王者荣耀」。

背景：89 个库存账号 game_type 全为 NULL（WPS 导入时未带该字段），
       字典 game_type_options 中「王者荣耀」为默认项（is_default=True）。

用法：
  python3 backfill_game_type.py            # dry-run
  python3 backfill_game_type.py --apply    # 写库（幂等：仅更新 NULL/空 的行）
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "backend"))

from sqlalchemy import text  # noqa: E402

from app.core.audit import record_audit  # noqa: E402
from app.core.database import get_session_factory  # noqa: E402
from app.core.settings import get_settings  # noqa: E402

OUT_DIR = Path(__file__).resolve().parent
TARGET = "王者荣耀"
ACTOR = "wps-import"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--game-type", default=TARGET)
    args = ap.parse_args()

    factory = get_session_factory(get_settings().alembic_url)
    session = factory()
    try:
        name = args.game_type
        valid = session.execute(
            text("select name, is_default from game_type_options where is_active = true order by sort_order")
        ).all()
        names = [r[0] for r in valid]
        if name not in names:
            raise SystemExit(f"游戏类型「{name}」不在字典可用项中：{names}")

        rows = session.execute(
            text(
                "select id, stock_no, game_account, game_type from stocks "
                "where game_type is null or trim(game_type) = '' order by stock_no"
            )
        ).all()
        total = session.execute(text("select count(*) from stocks")).scalar()
        print(f"字典可用：{names}（默认：{[r[0] for r in valid if r[1]]}）")
        print(f"库存共 {total} 个，待回填 {len(rows)} 个 → 「{name}」")
        for r in rows[:5]:
            print(f"  {r.stock_no} {r.game_account} {r.game_type!r}")
        if len(rows) > 5:
            print(f"  …… 共 {len(rows)} 个")

        if not rows:
            print("\n无需回填，退出。")
            return
        if not args.apply:
            print("\ndry-run，未写库。加 --apply 执行。")
            return

        bak = OUT_DIR / f"bak_game_type_{datetime.now():%Y%m%d-%H%M%S}.json"
        bak.write_text(
            json.dumps([{"id": r.id, "stock_no": r.stock_no, "game_type": r.game_type} for r in rows],
                       ensure_ascii=False, indent=1),
            encoding="utf-8",
        )
        print(f"\n快照已存 {bak.name}")

        for r in rows:
            session.execute(text("update stocks set game_type=:g where id=:i"), {"g": name, "i": r.id})
            record_audit(
                session,
                action="ACCOUNT_UPDATE",
                entity_type="stock",
                entity_id=r.stock_no,
                actor=ACTOR,
                before={"game_type": r.game_type},
                after={"game_type": name},
                reason="WPS 导入未带游戏类型，按默认项统一回填",
            )
        session.commit()
        print(f"已提交：{len(rows)} 个库存账号 game_type = {name}")
    finally:
        session.close()


if __name__ == "__main__":
    main()
