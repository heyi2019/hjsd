"""PG 逻辑备份：逐表导出 JSON（无 pg_dump 时的兜底）。"""
import json
from datetime import datetime
from pathlib import Path

from sqlalchemy import create_engine, inspect, text

import sys

sys.path.insert(0, "/Users/aries/黑金时代/backend")
from app.core.settings import get_settings  # noqa: E402

OUT = Path("/Users/aries/黑金时代/backups")
OUT.mkdir(parents=True, exist_ok=True)
stamp = datetime.now().strftime("%Y%m%d-%H%M%S")

engine = create_engine(get_settings().alembic_url)
insp = inspect(engine)
dump = {}
counts = {}
with engine.connect() as conn:
    for table in insp.get_table_names():
        if table.startswith("sqlite_") or table == "alembic_version":
            continue
        rows = conn.execute(text(f'SELECT * FROM "{table}"')).mappings().all()
        if not rows:
            continue
        dump[table] = [dict(r) for r in rows]
        counts[table] = len(rows)

path = OUT / f"pg_backup_{stamp}.json"
path.write_text(json.dumps(dump, ensure_ascii=False, default=str))
print("备份文件:", path, round(path.stat().st_size / 1024, 1), "KB")
for t, n in sorted(counts.items(), key=lambda x: -x[1]):
    print(f"  {t:28s} {n:5d}")
