"""初始化 / 校验 v1 数据库（新手上路一次性动作）。

```bash
python3 scripts/v1_init_db.py              # 迁移到 head 并写入种子
python3 scripts/v1_init_db.py --check      # 只校验种子是否齐备
```

约束：
- 库地址只来自根目录 `.env` 的 `DATABASE_URL`；
- 绝不创建或覆盖 `heijin.db` / `heijin_v2.db`（由 `core.settings` 拦截）。
"""
from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from sqlalchemy import create_engine  # noqa: E402
from sqlalchemy.orm import Session  # noqa: E402

from app.core.settings import get_settings  # noqa: E402
from app.foundation.seeds import seed_is_applied  # noqa: E402


def run_migration() -> int:
    result = subprocess.run(
        [sys.executable, "-m", "alembic", "upgrade", "head"],
        cwd=BACKEND_DIR,
        check=False,
    )
    return result.returncode


def check_seed() -> bool:
    settings = get_settings()
    engine = create_engine(settings.alembic_url)
    try:
        with Session(bind=engine) as session:
            applied = seed_is_applied(session)
            if applied:
                print("[v1] 基础种子已就位（HJ_INVEST / HJ_PROFIT / HS / TH / DG / 默认路由）")
            else:
                print("[v1] 基础种子缺失，请执行 python3 scripts/v1_init_db.py", file=sys.stderr)
            return applied
    finally:
        engine.dispose()


def main() -> int:
    parser = argparse.ArgumentParser(description="宜游轩 ERP v1 数据库初始化")
    parser.add_argument("--check", action="store_true", help="仅校验种子，不执行迁移")
    args = parser.parse_args()

    settings = get_settings()
    print(f"[v1] 目标数据库: {settings.database_url}")
    print(f"[v1] 配置文件: {settings.env_file_path}")

    if not args.check:
        code = run_migration()
        if code != 0:
            print("[v1] 迁移失败", file=sys.stderr)
            return code
    return 0 if check_seed() else 1


if __name__ == "__main__":
    raise SystemExit(main())
