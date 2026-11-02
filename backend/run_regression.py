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
    """回归子进程的环境变量：沿用当前环境（含 `.env` 的 DATABASE_URL）。

    历史上这里 `setdefault` 注入一个隔离临时库地址，目的是让回归跑在隔离库上、
    不碰联调库。测试夹具迁到 PostgreSQL 后该做法已无意义——夹具硬性要求
    PostgreSQL 且库名含 test，注入非 PG 地址只会让它直接 exit。
    现在测试库由 `TEST_DATABASE_URL`（其次 `.env` 的 `DATABASE_URL`）决定，
    隔离性由「库名必须含 test + 会话开始 TRUNCATE」保证。
    """
    return os.environ.copy()

# 三档测试体系（何一裁决）：
#   ① unit    —— 纯逻辑、无 DB/HTTP，秒级，改完即跑；
#   ② <业务域> —— 板块测试，改哪个板块只跑哪个（含 platform 跨域基建板块）；
#   ③ all/ci  —— 全量，只在 CI / 发版前跑。
# 横切组与业务域组可重叠（同一文件既属 unit 又属某域），但反查「文件→组」时
# 必须排除横切组，否则会把域归属覆盖成横切组导致跑错范围。
CROSSCUT_GROUPS = {"smoke", "p0", "unit"}

GROUPS = {
    "smoke": [
        "tests/v1/test_main_contract.py",
        "tests/v1/test_api_contract.py",
        "tests/v1/test_request_schema_contract.py",
        "tests/v1/test_money_float_guard.py",
        "tests/v1/test_numbering.py",
        "tests/v1/test_state_machine.py",
    ],
    # 单元档：不碰数据库与 HTTP，实测 106 passed（空闲机约 2.3s，负载下会延长）。
    # 准入标准（后补须先实测）：单文件 < 1s、不依赖 seeded_db/seeded_client/TestClient。
    "unit": [
        "tests/v1/test_money.py",
        "tests/v1/test_money_float_guard.py",
        "tests/v1/test_numbering.py",
        "tests/v1/test_state_machine.py",
        "tests/v1/test_api_contract.py",
        "tests/v1/test_request_schema_contract.py",
        "tests/v1/test_cancellation_model.py",
        "tests/v1/test_orders_common.py",
        "tests/v1/test_finance_attributes.py",
        "tests/v1/test_core_infra_gaps.py",
        "tests/v1/test_notifications_contract.py",
        "tests/v1/test_rebate_current_contract.py",
        "tests/v1/test_product_alias_compat.py",
        "tests/v1/test_main_contract.py",
        "tests/v1/test_coverage_gate.py",
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
        "tests/v1/test_game_types.py",
        "tests/v1/test_game_types_contract.py",
        "tests/v1/test_option_sets_api.py",
        "tests/v1/test_product_alias_compat.py",
    ],
    "accounts": [
        "tests/v1/test_accounts_contract.py",
        "tests/v1/test_account_stock_no.py",
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
        "tests/v1/test_cancellation_model.py",
        "tests/v1/test_orders_common.py",
        "tests/v1/test_orders_guard.py",
        "tests/v1/test_orders_router_guard.py",
        "tests/v1/test_inventory_execution_edit.py",
        "tests/v1/test_order_customer_source_fixtures.py",
        "tests/v1/test_profit_allocation_modes.py",
        "tests/v1/test_unreachable_status_paths.py",
        "tests/v1/test_flow_recycle.py",
        "tests/v1/test_order_status_contract.py",
        "tests/v1/test_flow_sale.py",
        "tests/v1/test_flow_config_driven.py",
        "tests/v1/test_stock_intake_contract.py",
    ],
    "installments": [
        "tests/v1/test_installments_contract.py",
        "tests/v1/test_m2.py",
        "tests/v1/test_m4.py",
        "tests/v1/test_installments_service.py",
        "tests/v1/test_flow_installment.py",
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
        "tests/v1/test_finance_reconciliation_service.py",
        "tests/v1/test_finance_reporting_task5_tail.py",
        "tests/v1/test_finance_transfers_service.py",
        "tests/v1/test_rebate_current_contract.py",
        "tests/v1/test_finance_reversal_service.py",
        "tests/v1/test_finance_idempotency_service.py",
        "tests/v1/test_flow_distribution.py",
    ],
    "parties": [
        "tests/v1/test_parties.py",
        "tests/v1/test_parties_contract.py",
        "tests/v1/test_parties_fields_service.py",
        "tests/v1/test_leads_contract.py",
        "tests/v1/test_parties_policy_guard.py",
        "tests/v1/test_parties_masking.py",
    ],
    "reporting": [
        "tests/v1/test_reporting_contract.py",
        "tests/v1/test_report_export_columns.py",
        "tests/v1/test_reporting_service_gaps.py",
        "tests/v1/test_reporting_r_consistency.py",
    ],
    "policy": [
        "tests/v1/test_m5_policy.py",
        "tests/v1/test_policy_contract.py",
        "tests/v1/test_policy_rule_consumption.py",
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
        "tests/v1/test_attachments_service.py",
        "tests/v1/test_notifications_service.py",
        "tests/v1/test_quality_guard.py",
    ],
    "imports": [
        "tests/v1/test_import_landing.py",
        "tests/v1/test_import_mapping.py",
        "tests/v1/test_imports_contract.py",
        "tests/v1/test_migration.py",
    ],
    # 跨域基建板块：列表列/导出、部署脚本、覆盖率与迁移基线——改动常横跨多域。
    "platform": [
        "tests/v1/test_list_columns.py",
        "tests/v1/test_list_custom_columns.py",
        "tests/v1/test_list_export_csv.py",
        "tests/v1/test_deploy_script_contract.py",
        "tests/v1/test_backup_scripts.py",
        "tests/v1/test_coverage_gate.py",
    ],
    "auth": [
        "tests/v1/test_auth_contract.py",
        "tests/v1/test_main_contract.py",
        "tests/v1/test_backup_scripts.py",
        "tests/v1/test_public_release_security.py",
        "tests/v1/test_ratelimit.py",
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
        if group not in CROSSCUT_GROUPS
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
                selected.update(name for name in GROUPS if name not in CROSSCUT_GROUPS)
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
        "group",
        choices=[*GROUPS, "changed", "all", "ci", "lint"],
        help="回归分组（unit=单元档；业务域名=板块档；ci/all=全量；lint=静态检查）",
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
        paths = all_paths() if args.group in ("all", "ci") else GROUPS[args.group]
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
