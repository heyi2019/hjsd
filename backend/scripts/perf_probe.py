#!/usr/bin/env python3
"""后端 GET 接口 SQL 条数 / 耗时探针（只读巡检工具，PostgreSQL 版）。

用途（2026-10-28 N+1 收口时引入）：
- 在真实库的临时副本上跑全部 GET 接口，统计每接口单次请求的 SQL 条数、
  同构去重数与耗时中位数；「重复条数」高 = 循环内查询（N+1）指纹。
- 用于：改查询逻辑前取基线、改完复测对比、巡检新增接口有没有 N+1。

2026-11-03 重写为 PG（原 SQLite 版已下线）：
- 源库经 pg_dump 还原到临时 PG 库；探针只读写副本；跑完 DROP 临时库。
- 源库只做 pg_dump（只读），绝不写入/删除源库（dev/test/e2e 一律不碰）。
- dump/restore 一律走容器 heijin-db-1（宿主机无 PG 客户端）。

用法（需 backend venv，APP_ENV 自动置 development 走 X-Dev-User 直通）：
    ./.venv/bin/python scripts/perf_probe.py                         # 默认源=dev 沙盒，打印 Top30
    ./.venv/bin/python scripts/perf_probe.py --out base.json         # 同时存 JSON 供前后对比
    ./.venv/bin/python scripts/perf_probe.py --source-url postgresql+psycopg://erp_app:***@127.0.0.1:5433/heijin_erp_dev
        # 示例：显式指定源库（只读 dump），把库名换成有数据的目标库；dev 沙盒业务表全空时默认跑只用于工具自检。

安全红线：
- 只 CREATE/DROP 前缀为 `heijin_erp_perf_probe_` 的临时库；DROP 前硬性校验前缀。
- 源库名来自 --source-url / DATABASE_URL；容器侧只对其做 pg_dump。
- 部分接口要求必填查询参数（search / order-form-fields / impact-preview 等），
  未带参会得 422，属探针假象而非服务缺陷；路径参数用各表最新一条真实 id 代入。
"""
from __future__ import annotations

import argparse
import json
import os
import re
import statistics
import subprocess
import sys
import time
from pathlib import Path

from sqlalchemy import text

BACKEND_DIR = Path(__file__).resolve().parents[1]

# 容器与凭据（与仓库根 .env 一致；优先读环境变量，回退默认值）。
CONTAINER = os.environ.get("ERP_PG_CONTAINER", "heijin-db-1")
PGUSER = os.environ.get("ERP_PG_USER", "erp_app")

# PG 的噪声前缀：事务控制 + 会话级 SET/SHOW/DISCARD/RESET（psycopg 建连会发），
# 以及 `SELECT 1` 心跳；这些不计为业务 SQL。
NOISE_PREFIXES = (
    "BEGIN", "COMMIT", "ROLLBACK", "SAVEPOINT", "RELEASE", "SELECT 1",
    "SET ", "SHOW ", "DISCARD ", "RESET ", "VALUES", "COPY ",
)
COUNTED_HEADS = ("SELECT", "INSERT", "UPDATE", "DELETE")

# 路径参数 -> 示例值来源（各表取一条真实 id；表不存在时回退 1）。
_ID_SOURCES = {
    "order_id": "select id from orders order by id desc limit 1",
    "customer_id": "select id from customers order by id desc limit 1",
    "counterparty_id": "select id from counterparties order by id desc limit 1",
    "account_id": "select id from stocks order by id desc limit 1",
    "installment_id": "select id from installments order by id desc limit 1",
    "rebate_id": "select id from rebate_records order by id desc limit 1",
    "pool_id": "select id from pools order by id limit 1",
    "lead_id": "select id from customer_leads order by id desc limit 1",
    "order_type_id": "select id from order_types order by id limit 1",
    "definition_id": "select id from policy_definitions order by id limit 1",
    "attachment_id": "select id from attachments order by id desc limit 1",
    "code": "select code from order_types order by id limit 1",
}


def _normalize(statement: str) -> str:
    return re.sub(r"\s+", " ", statement.strip())


def _docker_psql(*sql: str) -> None:
    """在容器内以 erp_app 执行 DDL/DCL（CREATE/DROP DATABASE 必须在 postgres 库执行）。"""
    subprocess.run(
        ["docker", "exec", CONTAINER, "psql", "-U", PGUSER, "-d", "postgres", "-c", " ".join(sql)],
        check=True,
    )


def _sample_ids(engine) -> dict[str, str]:
    """用 SQLAlchemy 从（临时）PG 库读各表一条真实 id；表不存在/空则回退 1。"""
    ids: dict[str, str] = {}
    with engine.connect() as conn:
        for key, sql in _ID_SOURCES.items():
            try:
                row = conn.execute(text(sql)).fetchone()
            except Exception:  # noqa: BLE001 某些表可能不存在，忽略
                row = None
            ids[key] = str(row[0]) if row else "1"
    ids["report_name"] = "monthly-pnl"
    return ids


def main() -> int:
    parser = argparse.ArgumentParser(description="GET 接口 SQL 条数/耗时探针（只读，PostgreSQL）")
    parser.add_argument(
        "--source-url",
        default=os.environ.get("DATABASE_URL"),
        help="源 PG 连接串（默认取环境变量 DATABASE_URL=dev 沙盒）。只读 pg_dump，不写源库。",
    )
    parser.add_argument("--out", default=None, help="结果 JSON 输出路径（可选）")
    parser.add_argument("--repeat", type=int, default=3, help="每接口正式测量次数（取中位）")
    parser.add_argument("--warmup", type=int, default=1, help="每接口预热次数（不计入统计）")
    parser.add_argument("--top", type=int, default=30, help="终端打印前 N 行")
    parser.add_argument("--page-size", type=int, default=20, help="列表接口分页大小")
    args = parser.parse_args()
    if args.repeat < 1 or args.warmup < 0:
        parser.error("--repeat 必须 >= 1，--warmup 必须 >= 0")

    if not args.source_url or not args.source_url.startswith("postgresql"):
        print("源库必须是 PostgreSQL（--source-url 或 DATABASE_URL 以 postgresql 开头）", file=sys.stderr)
        return 2

    from sqlalchemy.engine.url import make_url

    src = make_url(args.source_url)
    source_dbname = src.database
    temp_dbname = f"heijin_erp_perf_probe_{os.getpid()}_{int(time.time())}"

    os.environ.setdefault("APP_ENV", "development")
    os.environ.setdefault("LOG_LEVEL", "WARNING")
    # 探针只连临时库：把 DATABASE_URL 指向临时库，再导入 app（避免 get_engine 缓存源库）。
    os.environ["DATABASE_URL"] = (
        f"postgresql+psycopg://{src.username or PGUSER}"
        f"{(':' + src.password) if src.password else ''}"
        f"@{src.host or '127.0.0.1'}:{src.port or 5432}/{temp_dbname}"
    )

    sys.path.insert(0, str(BACKEND_DIR))
    from fastapi.testclient import TestClient
    from sqlalchemy import event

    from app.api_v1 import create_app
    from app.core.database import get_engine

    # 1) 建临时库（与源库同版本，空库）
    _docker_psql(f"CREATE DATABASE {temp_dbname} OWNER {PGUSER};")
    # 2) 源库只读 dump → 临时库（--no-owner 避免还原出不属于 erp_app 的对象）
    dump = subprocess.run(
        ["docker", "exec", CONTAINER, "pg_dump", "-U", PGUSER, "-d", source_dbname,
         "--no-owner", "--no-privileges", "--no-comments"],
        capture_output=True, text=True, check=True,
    )
    subprocess.run(
        ["docker", "exec", "-i", CONTAINER, "psql", "-U", PGUSER, "-d", temp_dbname],
        input=dump.stdout, text=True, check=True,
    )

    try:
        app = create_app()
        engine = get_engine()
        counter = {"sql": 0, "stmts": []}

        @event.listens_for(engine, "before_cursor_execute")
        # 事件回调签名由 SQLAlchemy 固定（位置传参），未使用的参数以下划线前缀标明。
        def _count(_conn, _cursor, statement, _parameters, _context, _executemany):
            stripped = statement.lstrip()
            if not stripped or stripped.upper().startswith(NOISE_PREFIXES):
                return
            if stripped.split(None, 1)[0].upper() not in COUNTED_HEADS:
                return
            counter["sql"] += 1
            counter["stmts"].append(_normalize(statement))

        ids = _sample_ids(engine)
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
    finally:
        # 3) 无论探针是否异常，都 DROP 临时库（前缀硬性校验，拒绝误删其它库）。
        assert temp_dbname.startswith("heijin_erp_perf_probe_"), f"拒绝 DROP 非临时库: {temp_dbname}"
        _docker_psql(f"DROP DATABASE {temp_dbname} WITH (FORCE);")

    rows.sort(key=lambda r: (-int(r["sql"]), -float(r["ms"])))
    if args.out:
        out_path = Path(args.out)
        if not out_path.is_absolute():
            out_path = BACKEND_DIR / out_path
        out_path.write_text(json.dumps(rows, ensure_ascii=False, indent=2), encoding="utf-8")

    ok = sum(1 for r in rows if r["status"] == 200)
    print(f"\n共探测 {len(rows)} 个 GET 接口，200 成功 {ok} 个；源库 {source_dbname} → 临时库 {temp_dbname}（已 DROP）\n")
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
