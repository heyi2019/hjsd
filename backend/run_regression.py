"""按业务域执行后端分组回归，避免日常开发默认跑全量套件。"""
from __future__ import annotations

import argparse
import os
import re
import subprocess
import sys
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parent
PYTHON = ROOT / ".venv" / "bin" / "python"

# pyflakes 扫描范围：业务代码 + 测试 + 迁移 + 脚本（与历史「pyflakes 干净」口径一致）
LINT_TARGETS = ["app", "tests/v1", "alembic/versions", "scripts", "run_regression.py", "run_coverage_gate.py"]
# 基线只记「文件 + 消息」，不含行列号——行号漂移不应判定为新增告警
LINT_BASELINE = ROOT / "lint_baseline.txt"
LINT_LINE_RE = re.compile(r"^(?P<path>.+?):\d+:\d+: (?P<msg>.+)$")


def regression_environment() -> dict[str, str]:
    """为回归套件提供隔离的默认数据库，不覆盖显式命令行环境变量。

    根目录 `.env` 用于本地联调时可以指向 PostgreSQL 测试库；配置契约和健康检查
    回归则要求默认 v1 SQLite 库。通过子进程环境注入 SQLite，既不修改 `.env`，
    也不让回归套件误连联调库。调用方显式导出 DATABASE_URL 时仍保留其选择。
    """
    environment = os.environ.copy()
    environment.setdefault("DATABASE_URL", "sqlite:////tmp/heijin_erp_v1.db")
    return environment

GROUPS = {
    "smoke": [
        "tests/v1/test_main_contract.py",
        "tests/v1/test_api_contract.py",
        "tests/v1/test_request_schema_contract.py",
        "tests/v1/test_money_float_guard.py",
        "tests/v1/test_numbering.py",
        "tests/v1/test_state_machine.py",
    ],
    "p0": [
        "tests/v1/test_order_types_api.py",
        "tests/v1/test_orders_contract.py",
        "tests/v1/test_orders.py",
        "tests/v1/test_installments_contract.py",
        "tests/v1/test_reporting_contract.py",
        "tests/v1/test_m2.py",
        "tests/v1/test_m4.py",
    ],
    "foundation": [
        "tests/v1/test_foundation_contract.py",
        "tests/v1/test_foundation_order_types_service.py",
        "tests/v1/test_foundation_pools_service.py",
        "tests/v1/test_order_types_api.py",
        "tests/v1/test_pools_api.py",
        "tests/v1/test_form_extra_scopes.py",
        "tests/v1/test_order_form_fields.py",
        "tests/v1/test_numbering.py",
        "tests/v1/test_settings.py",
    ],
    "accounts": [
        "tests/v1/test_accounts_contract.py",
    ],
    "orders": [
        "tests/v1/test_core_contract.py",
        "tests/v1/test_orders_contract.py",
        "tests/v1/test_orders.py",
        "tests/v1/test_orders_events_service.py",
        "tests/v1/test_state_machine.py",
        "tests/v1/test_api_contract.py",
        "tests/v1/test_request_schema_contract.py",
        "tests/v1/test_bughunt.py",
    ],
    "installments": [
        "tests/v1/test_installments_contract.py",
        "tests/v1/test_m2.py",
        "tests/v1/test_m4.py",
    ],
    "finance": [
        "tests/v1/test_finance_contract.py",
        "tests/v1/test_finance_attributes.py",
        "tests/v1/test_finance_cashflows_service.py",
        "tests/v1/test_finance_controls_service.py",
        "tests/v1/test_finance_rebates_service.py",
        "tests/v1/test_finance_router_contract.py",
        "tests/v1/test_rebate_rules_contract.py",
        "tests/v1/test_money.py",
        "tests/v1/test_money_float_guard.py",
    ],
    "parties": [
        "tests/v1/test_parties.py",
        "tests/v1/test_parties_contract.py",
        "tests/v1/test_parties_fields_service.py",
        "tests/v1/test_leads_contract.py",
    ],
    "reporting": [
        "tests/v1/test_reporting_contract.py",
    ],
    "policy": [
        "tests/v1/test_m5_policy.py",
        "tests/v1/test_policy_contract.py",
    ],
    "governance": [
        "tests/v1/test_quality_contract.py",
        "tests/v1/test_quality_issue_contract.py",
        "tests/v1/test_quality_issues_service.py",
        "tests/v1/test_quality_metrics_contract.py",
        "tests/v1/test_notifications_contract.py",
        "tests/v1/test_search_contract.py",
        "tests/v1/test_attachments_contract.py",
        "tests/v1/test_audit_contract.py",
    ],
    "imports": [
        "tests/v1/test_import_landing.py",
        "tests/v1/test_import_mapping.py",
        "tests/v1/test_imports_contract.py",
        "tests/v1/test_migration.py",
    ],
    "auth": [
        "tests/v1/test_auth_contract.py",
        "tests/v1/test_main_contract.py",
        "tests/v1/test_backup_restore.py",
    ],
}


def unique_paths(groups: list[str]) -> list[str]:
    """保持分组声明顺序，同时去掉跨组复用的测试文件。"""
    seen: set[str] = set()
    paths: list[str] = []
    for group in groups:
        for path in GROUPS[group]:
            if path not in seen:
                seen.add(path)
                paths.append(path)
    return paths


def all_paths() -> list[str]:
    return unique_paths(list(GROUPS))


def changed_paths() -> list[str]:
    result = subprocess.run(
        ["git", "status", "--short"],
        cwd=ROOT.parent,
        check=True,
        capture_output=True,
        text=True,
    )
    return [line[3:] for line in result.stdout.splitlines() if len(line) > 3]


def groups_for_changes(paths: list[str]) -> list[str]:
    selected: set[str] = set()
    test_groups = {
        test_path: group
        for group, test_paths in GROUPS.items()
        if group != "smoke"
        for test_path in test_paths
    }
    for path in paths:
        if path.startswith("frontend/"):
            continue
        if path.startswith("backend/tests/"):
            relative_test_path = path.removeprefix("backend/")
            if relative_test_path in test_groups:
                selected.add(test_groups[relative_test_path])
            else:
                selected.update(name for name in GROUPS if name not in {"smoke", "p0"})
            continue
        if path.startswith("backend/app/foundation/") or "foundation" in path or "order_type" in path or "pool" in path or "live_field" in path:
            selected.add("foundation")
        if "account" in path:
            selected.add("accounts")
        if path.startswith("backend/app/trade/") or any(token in path for token in ("order", "state_machine", "request_schema")):
            selected.add("orders")
        if "bughunt" in path:
            selected.add("orders")
        if "installment" in path or path.endswith("/test_m2.py") or path.endswith("/test_m4.py"):
            selected.add("installments")
        if path.startswith("backend/app/finance/") or "finance" in path or "rebate" in path:
            selected.add("finance")
        if any(token in path for token in ("parties", "leads")):
            selected.add("parties")
        if "report" in path:
            selected.add("reporting")
        if "policy" in path:
            selected.add("policy")
        if any(token in path for token in ("quality", "notifications", "search", "attachments", "audit")):
            selected.add("governance")
        if any(token in path for token in ("import", "migration", "history")):
            selected.add("imports")
        if any(token in path for token in ("auth", "backup_restore", "main_contract", "settings")):
            selected.add("auth")
    return [name for name in GROUPS if name in selected]


def lint_findings(runner: str) -> list[str]:
    """跑 pyflakes 并把结果归一化为「路径 :: 消息」（去掉行列号）。"""
    result = subprocess.run(
        [runner, "-m", "pyflakes", *LINT_TARGETS],
        cwd=ROOT,
        capture_output=True,
        text=True,
        check=False,
    )
    findings: list[str] = []
    for line in result.stdout.splitlines():
        line = line.strip()
        if not line:
            continue
        matched = LINT_LINE_RE.match(line)
        findings.append(f"{matched['path']} :: {matched['msg']}" if matched else line)
    return findings


def run_lint(runner: str, *, update_baseline: bool) -> int:
    """静态检查入口：与基线比对，只对新增告警失败。

    存量以 lint_baseline.txt 登记（当前几乎全是 `import app.domain.*` 这类
    为注册 ORM 模型而保留的副作用导入，pyflakes 不认 noqa，故只能白名单）。
    清理存量后用 `lint --update-baseline` 收紧基线。
    """
    try:
        subprocess.run(
            [runner, "-m", "pyflakes", "--version"],
            cwd=ROOT,
            capture_output=True,
            check=True,
        )
    except (subprocess.CalledProcessError, FileNotFoundError):
        print("缺少 pyflakes：请先执行 .venv/bin/python -m pip install -r requirements.txt")
        return 1

    findings = lint_findings(runner)
    if update_baseline:
        LINT_BASELINE.write_text(
            "".join(f"{item}\n" for item in sorted(findings)), encoding="utf-8"
        )
        print(f"已更新 lint 基线：{len(findings)} 条存量告警")
        return 0

    baseline: Counter[str] = Counter()
    if LINT_BASELINE.exists():
        baseline = Counter(
            line.strip()
            for line in LINT_BASELINE.read_text(encoding="utf-8").splitlines()
            if line.strip()
        )
    current = Counter(findings)
    added = current - baseline
    fixed = baseline - current

    if fixed:
        print(f"存量已减少 {sum(fixed.values())} 条，可执行 lint --update-baseline 收紧基线")
    if not added:
        print(f"pyflakes 通过：存量 {sum(current.values())} 条（均在基线内），无新增告警")
        return 0

    print(f"新增 pyflakes 告警 {sum(added.values())} 条：")
    for item, count in sorted(added.items()):
        print(f"  {item}" + (f"  x{count}" if count > 1 else ""))
    return 1


def main() -> int:
    parser = argparse.ArgumentParser(description="执行按业务域拆分的后端回归")
    parser.add_argument(
        "group", choices=[*GROUPS, "changed", "all", "lint"], help="回归分组（lint=静态检查）"
    )
    parser.add_argument("--list", action="store_true", help="仅展示将执行的测试文件")
    parser.add_argument(
        "--update-baseline", action="store_true", help="仅用于 lint：把当前存量告警写入基线"
    )
    args = parser.parse_args()
    if args.group == "lint":
        return run_lint(
            str(PYTHON) if PYTHON.exists() else sys.executable,
            update_baseline=args.update_baseline,
        )
    if args.group == "changed":
        paths_changed = changed_paths()
        selected = groups_for_changes(paths_changed)
        frontend_changed = any(path.startswith("frontend/") for path in paths_changed)
        if not selected and not frontend_changed:
            print("未发现需要回归的前后端业务代码变更")
            return 0
        print(f"按变更自动选择分组：{', '.join(selected)}")
        paths = unique_paths(selected)
        if frontend_changed:
            print("按变更自动选择前端关键 E2E")
        if args.list:
            if frontend_changed:
                print("frontend: npm run test:regression:fast")
            print("\n".join(paths))
            return 0
        if selected:
            runner = str(PYTHON) if PYTHON.exists() else sys.executable
            result = subprocess.run(
                [runner, "-m", "pytest", "-q", *paths],
                cwd=ROOT,
                env=regression_environment(),
                check=False,
            )
            if result.returncode:
                return result.returncode
        if frontend_changed:
            return subprocess.run(["npm", "run", "test:regression:fast"], cwd=ROOT.parent / "frontend", check=False).returncode
        return 0
    else:
        paths = all_paths() if args.group == "all" else GROUPS[args.group]
    if args.list:
        print("\n".join(paths))
        return 0
    runner = str(PYTHON) if PYTHON.exists() else sys.executable
    command = [runner, "-m", "pytest", "-q", *paths]
    return subprocess.run(
        command,
        cwd=ROOT,
        env=regression_environment(),
        check=False,
    ).returncode


if __name__ == "__main__":
    raise SystemExit(main())
