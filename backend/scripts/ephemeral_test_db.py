"""Run a command with a uniquely owned disposable PostgreSQL test database."""
from __future__ import annotations

import os
import re
import secrets
import signal
import subprocess
import sys
import time
from pathlib import Path

import psycopg
from dotenv import dotenv_values
from psycopg import sql
from sqlalchemy.engine import make_url

ROOT = Path(__file__).resolve().parents[2]
MARKER = "heijin-ephemeral-test-db-v1"
RETENTION_SECONDS = 24 * 60 * 60


def make_database_name(kind: str) -> str:
    if kind not in {"test", "e2e"}:
        raise ValueError("invalid database kind")
    return f"heijin_tmp_{kind}_{int(time.time())}_{secrets.token_hex(6)}"


def validate_owned_database(name: str, kind: str) -> bool:
    return kind in {"test", "e2e"} and bool(re.fullmatch(
        rf"heijin_tmp_{kind}_[0-9]{{10}}_[0-9a-f]{{12}}", name
    ))


def should_retain(kind: str, returncode: int) -> bool:
    return kind == "e2e" and returncode != 0


def database_urls(kind: str, env: dict[str, str]) -> tuple[str, str]:
    config = {**dotenv_values(ROOT / ".env"), **env}
    dev_raw = config.get("DATABASE_URL")
    raw = config.get("TEST_DATABASE_URL") if kind == "test" else (
        config.get("E2E_DATABASE_URL") or dev_raw
    )
    if not raw:
        raise ValueError("未配置测试数据库地址")
    base = make_url(raw)
    if base.get_backend_name() != "postgresql" or base.host not in {"127.0.0.1", "localhost", "::1"}:
        raise ValueError("临时测试库仅允许本机 PostgreSQL")
    if kind == "test":
        name = (base.database or "").lower()
        if "test" not in name or any(x in name for x in ("dev", "release", "prod", "live")):
            raise ValueError("TEST_DATABASE_URL 不是安全的测试库")
        if dev_raw:
            dev = make_url(dev_raw)
            local_hosts = {"localhost", "127.0.0.1", "::1"}
            same_host = base.host == dev.host or (base.host in local_hosts and dev.host in local_hosts)
            same_database = same_host and (base.port or 5432, base.database) == (dev.port or 5432, dev.database)
            if same_database and config.get("GITHUB_ACTIONS") != "true":
                raise ValueError("测试库与开发库相同")
    elif config.get("E2E_DATABASE_URL"):
        name = (base.database or "").lower()
        if "e2e" not in name or any(x in name for x in ("dev", "release", "prod", "live", "test")):
            raise ValueError("E2E_DATABASE_URL 不是安全的 E2E 库")
    admin = base.set(drivername="postgresql", database="postgres")
    generated = base.set(database=make_database_name(kind))
    return admin.render_as_string(hide_password=False), generated.render_as_string(hide_password=False)


def cleanup_expired_e2e(conn: psycopg.Connection) -> None:
    with conn.cursor() as cur:
        cur.execute("SELECT oid, datname, shobj_description(oid, 'pg_database') FROM pg_database WHERE datname LIKE 'heijin_tmp_e2e_%'")
        for _, name, comment in cur.fetchall():
            if not validate_owned_database(name, "e2e") or comment != MARKER:
                continue
            created = int(name.split("_")[-2])
            if time.time() - created < RETENTION_SECONDS:
                continue
            cur.execute("SELECT 1 FROM pg_stat_activity WHERE datname = %s LIMIT 1", (name,))
            if not cur.fetchone():
                cur.execute(sql.SQL("DROP DATABASE {} ").format(sql.Identifier(name)))


def run(kind: str, command: list[str]) -> int:
    admin_url, target_url = database_urls(kind, dict(os.environ))
    name = make_url(target_url).database
    if not name or not validate_owned_database(name, kind):
        raise ValueError("拒绝创建不安全的临时数据库")
    with psycopg.connect(admin_url, autocommit=True, connect_timeout=10) as conn:
        if kind == "e2e":
            cleanup_expired_e2e(conn)
        with conn.cursor() as cur:
            cur.execute(sql.SQL("CREATE DATABASE {}").format(sql.Identifier(name)))
            try:
                cur.execute(sql.SQL("COMMENT ON DATABASE {} IS {}").format(sql.Identifier(name), sql.Literal(MARKER)))
            except Exception:
                cur.execute(sql.SQL("DROP DATABASE {}").format(sql.Identifier(name)))
                raise
        env = dict(os.environ)
        env["TEST_DATABASE_URL" if kind == "test" else "E2E_DATABASE_URL"] = target_url
        if kind == "e2e":
            env["HEIJIN_EPHEMERAL_E2E"] = "1"
        print(f"临时 {kind} 库：{name}", flush=True)
        rc = 1
        child = None
        previous = {}
        try:
            child = subprocess.Popen(command, env=env)
            def forward(sig, _frame):
                if child and child.poll() is None:
                    child.send_signal(sig)
            for sig in (signal.SIGINT, signal.SIGTERM):
                previous[sig] = signal.signal(sig, forward)
            rc = child.wait()
        finally:
            for sig, handler in previous.items():
                signal.signal(sig, handler)
            if should_retain(kind, rc):
                print(f"E2E 失败，保留 {name} 供排查；至少 24 小时后在下次 E2E 启动时清理。", flush=True)
            else:
                with conn.cursor() as cur:
                    # xdist workers append _gwN to this unpredictable, per-run name.
                    cur.execute("SELECT datname FROM pg_database WHERE datname LIKE %s", (name + "\\_gw%",))
                    worker_names = [row[0] for row in cur.fetchall() if re.fullmatch(re.escape(name) + r"_gw[0-9]+", row[0])]
                    for db in [*worker_names, name]:
                        cur.execute("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = %s AND pid <> pg_backend_pid()", (db,))
                        cur.execute(sql.SQL("DROP DATABASE IF EXISTS {}").format(sql.Identifier(db)))
                print(f"临时 {kind} 库已清理：{name}", flush=True)
        return rc if rc >= 0 else 128 - rc


if __name__ == "__main__":
    if len(sys.argv) < 4 or sys.argv[1] not in {"test", "e2e"} or sys.argv[2] != "--":
        raise SystemExit("用法: ephemeral_test_db.py test|e2e -- command [args...]")
    raise SystemExit(run(sys.argv[1], sys.argv[3:]))
