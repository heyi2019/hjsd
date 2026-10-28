#!/usr/bin/env python3
"""后端 GET 接口 SQL 条数 / 耗时探针（只读巡检工具）。

用途（2026-10-28 N+1 收口时引入）：
- 在真实库的临时副本上跑全部 GET 接口，统计每接口单次请求的 SQL 条数、
  同构去重数与耗时中位数；「重复条数」高 = 循环内查询（N+1）指纹。
- 用于：改查询逻辑前取基线、改完复测对比、巡检新增接口有没有 N+1。

用法（需 backend venv，APP_ENV 自动置 development 走 X-Dev-User 直通）：
    ./.venv/bin/python scripts/perf_probe.py                    # 打印 Top30
    ./.venv/bin/python scripts/perf_probe.py --out base.json    # 同时存 JSON 供前后对比
    ./.venv/bin/python scripts/perf_probe.py --db other.db      # 指定库（相对 backend/ 或绝对路径）

说明：
- 全程只读业务数据：每次运行先把库拷到临时目录，接口请求只落副本；
- SQL 计数挂 Engine 级 before_cursor_execute，过滤 PRAGMA/事务控制语句；
- 部分接口要求必填查询参数（search / order-form-fields / impact-preview 等），
  未带参会得 422，属探针假象而非服务缺陷；路径参数用各表最新一条真实 id 代入。
"""
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import sqlite3
import statistics
import sys
import tempfile
import time
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parents[1]

NOISE_PREFIXES = ("PRAGMA", "BEGIN", "COMMIT", "ROLLBACK", "SAVEPOINT", "RELEASE", "SELECT 1")
COUNTED_HEADS = ("SELECT", "INSERT", "UPDATE", "DELETE")

# 路径参数 -> 示例值来源（各表取一条真实 id；表不存在时回退 1）
_ID_SOURCES = {
    "order_id": "select id from orders order by id desc limit 1",
    "customer_id": "select id from customers order by id desc limit 1",
    "counterparty_id": "select id from counterparties order by id desc limit 1",
    "account_id": "select id from stocks order by id desc limit 1",
    "installment_id": "select id from installments order by id desc limit 1",
    "rebate_id": "select id from rebate_records order by id desc limit 1",
    "issue_id": "select id from quality_issues order by id desc limit 1",
    "pool_id": "select id from pools order by id limit 1",
    "lead_id": "select id from customer_leads order by id desc limit 1",
    "batch_id": "select id from import_batches order by id desc limit 1",
    "order_type_id": "select id from order_types order by id limit 1",
    "definition_id": "select id from policy_definitions order by id limit 1",
    "attachment_id": "select id from attachments order by id desc limit 1",
    "code": "select code from order_types order by id limit 1",
}


def _sample_ids(work_db: Path) -> dict[str, str]:
    conn = sqlite3.connect(work_db)
    try:
        ids: dict[str, str] = {}
        for key, sql in _ID_SOURCES.items():
            try:
                row = conn.execute(sql).fetchone()
            except sqlite3.Error:
                row = None
            ids[key] = str(row[0]) if row else "1"
        ids["report_name"] = "monthly-pnl"
        return ids
    finally:
        conn.close()


def _normalize(statement: str) -> str:
    return re.sub(r"\s+", " ", statement.strip())


def main() -> int:
    parser = argparse.ArgumentParser(description="GET 接口 SQL 条数/耗时探针（只读）")
    parser.add_argument("--db", default="data/heijin_erp_v1.db", help="源库路径（相对 backend/ 或绝对路径）")
    parser.add_argument("--out", default=None, help="结果 JSON 输出路径（可选）")
    parser.add_argument("--repeat", type=int, default=3, help="每接口正式测量次数（取中位）")
    parser.add_argument("--warmup", type=int, default=1, help="每接口预热次数（不计入统计）")
    parser.add_argument("--top", type=int, default=30, help="终端打印前 N 行")
    parser.add_argument("--page-size", type=int, default=20, help="列表接口分页大小")
    args = parser.parse_args()
    if args.repeat < 1 or args.warmup < 0:
        parser.error("--repeat 必须 >= 1，--warmup 必须 >= 0")

    source_db = Path(args.db)
    if not source_db.is_absolute():
        source_db = BACKEND_DIR / source_db
    if not source_db.exists():
        print(f"源库不存在: {source_db}", file=sys.stderr)
        return 2

    os.environ.setdefault("APP_ENV", "development")
    os.environ.setdefault("LOG_LEVEL", "WARNING")

    sys.path.insert(0, str(BACKEND_DIR))
    from fastapi.testclient import TestClient
    from sqlalchemy import event

    from app.api_v1 import create_app
    from app.core.database import get_engine

    with tempfile.TemporaryDirectory(prefix="erp_perf_probe_") as tmp:
        work_db = Path(tmp) / "probe.db"
        shutil.copy2(source_db, work_db)
        os.environ["DATABASE_URL"] = f"sqlite:///{work_db}"

        app = create_app()
        engine = get_engine()
        counter = {"sql": 0, "stmts": []}

        @event.listens_for(engine, "before_cursor_execute")
        def _count(conn, cursor, statement, parameters, context, executemany):  # noqa: ANN001
            stripped = statement.lstrip()
            if not stripped or stripped.upper().startswith(NOISE_PREFIXES):
                return
            if stripped.split(None, 1)[0].upper() not in COUNTED_HEADS:
                return
            counter["sql"] += 1
            counter["stmts"].append(_normalize(statement))

        ids = _sample_ids(work_db)
        rows: list[dict[str, object]] = []
        with TestClient(app, headers={"X-Dev-User": "admin"}) as client:
            routes = sorted(
                {
                    path
                    for r in app.routes
                    if "GET" in (getattr(r, "methods", None) or set())
                    and (path := getattr(r, "path", "")).startswith("/api/v1")
                }
            )
            for path in routes:
                url = path
                for name in re.findall(r"\{(\w+)\}", path):
                    url = url.replace("{" + name + "}", ids.get(name, "1"))
                url = f"{url}?page=1&page_size={args.page_size}&limit={args.page_size}"

                times: list[float] = []
                sql_count = distinct = status = size = 0
                for i in range(args.warmup + args.repeat):
                    counter["sql"] = 0
                    counter["stmts"] = []
                    started = time.perf_counter()
                    try:
                        resp = client.get(url)
                        status, size = resp.status_code, len(resp.content)
                    except Exception:  # noqa: BLE001 探针对异常接口继续跑
                        status, size = -1, 0
                    elapsed_ms = (time.perf_counter() - started) * 1000
                    if i >= args.warmup:
                        times.append(elapsed_ms)
                        sql_count = counter["sql"]
                        distinct = len(set(counter["stmts"]))
                rows.append(
                    {
                        "path": path,
                        "status": status,
                        "sql": sql_count,
                        "distinct": distinct,
                        "dup": sql_count - distinct,
                        "ms": round(statistics.median(times), 2) if times else 0.0,
                        "bytes": size,
                    }
                )

    rows.sort(key=lambda r: (-int(r["sql"]), -float(r["ms"])))
    if args.out:
        out_path = Path(args.out)
        if not out_path.is_absolute():
            out_path = BACKEND_DIR / out_path
        out_path.write_text(json.dumps(rows, ensure_ascii=False, indent=2), encoding="utf-8")

    ok = sum(1 for r in rows if r["status"] == 200)
    print(f"\n共探测 {len(rows)} 个 GET 接口，200 成功 {ok} 个；源库 {source_db}\n")
    print(f"{'SQL':>5} {'去重':>5} {'重复':>5} {'ms':>8} {'KB':>8}  status  path")
    for r in rows[: args.top]:
        print(
            f"{r['sql']:5d} {r['distinct']:5d} {r['dup']:5d} {r['ms']:8.2f} {r['bytes'] / 1024:8.1f}"
            f"  {r['status']:6d}  {r['path']}"
        )
    if args.out:
        print(f"\nJSON 已写入 {out_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
