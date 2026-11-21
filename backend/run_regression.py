"""按业务域 / 模块 / 测试类型执行后端分组回归，避免日常开发默认跑全量套件。

三种执行维度（详见 docs/testing/测试规范.md）：
  - 业务域分组（历史）：orders/finance/customer_center/field_definitions/... 保留可用。
  - 模块分组：module A-F/SYS  —— 一个模块的全部后端(UT+IT) + 前端测试。
  - 测试类型：type ut/it/e2e  —— 单元 / 集成 / 端到端。
  - 跨模块：cross            —— FLOW-* 跨模块流程测试（B↔D 等）。
维度可组合：module B --type ut  => 业务中心全部单元测试。

CI（backend-gate）默认按 main-ci-cd 注入的变更路径选测；命中核心/共享路径
自动降级全量，无业务变更走 smoke + unit 冒烟兜底，详见 docs/testing/测试规范.md。
"""
from __future__ import annotations

import argparse
import os
import re
import subprocess
import sys
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parent
REPO = ROOT.parent
PYTHON = ROOT / ".venv" / "bin" / "python"

# 模块/类型/跨模块筛选统一走共享目录（单一事实源）
sys.path.insert(0, str(REPO / "tests" / "config"))
from catalog import (  # noqa: E402
    MODULES,
    cross_files,
    frontend_module_files,
    module_files,
    module_type_files,
    type_files,
)

# pyflakes 扫描范围：业务代码 + 测试 + 唯一活动迁移 + 脚本。
LINT_TARGETS = ["app", "../tests/backend", "alembic/squashed_versions", "scripts", "run_regression.py"]
# 基线只记「文件 + 消息」，不含行列号——行号漂移不应判定为新增告警
LINT_BASELINE = ROOT / "lint_baseline.txt"
LINT_LINE_RE = re.compile(r"^(?P<path>.+?):\d+:\d+: (?P<msg>.+)$")


def _pytest_arg(path: str) -> str:
    """GROUPS 里存仓库相对路径（与 git status 同形），pytest 以 backend 为 cwd 运行，
    故补 ../ 前缀。nodeid 不受影响：rootdir 是仓库根（pytest.ini 在根），
    归一化后仍是 tests/backend/<file>.py::<func>。"""
    return path if path.startswith("../") else f"../{path}"


def run_frontend_files(relpaths: list[str]) -> int:
    """用 vitest 运行指定前端测试文件，并把结果写入测试结果库。

    relpaths 形如 frontend/src/...，转换为前端目录下的 src/... 传给 vitest。

    两个曾踩过的坑：
      1. 旧实现用 `npm run test:fast -- <files>`（即 `--project=fast`），而 fast 项目
         只覆盖 `scripts/test-layers.mjs` 的清单 —— 不属于 fast 的模块文件会被 vitest
         直接过滤掉，表现为「跑了但一条没执行」却仍以 0 退出（假绿）。故这里不指定
         project，让 vitest 按文件自行匹配所属项目。
      2. vitest 结果原本无处可去（执行记录器是 pytest 插件），前端用例在报告里永远
         「未执行」。这里统一走 JSON reporter，再交给 record_frontend_results.py 落库。
    """
    if not relpaths:
        return 0
    fe_root = REPO / "frontend"
    files = [p[len("frontend/"):] for p in relpaths]
    print(f"[frontend] 运行 {len(files)} 个模块相关前端测试文件：")
    for f in files:
        print(f"  - {f}")
    json_out = fe_root / "node_modules" / ".cache" / "vitest-module.json"
    json_out.parent.mkdir(parents=True, exist_ok=True)
    cmd = ["npx", "vitest", "run", "--reporter=json", f"--outputFile={json_out}", *files]
    try:
        r = subprocess.run(cmd, cwd=fe_root, check=False)
    except FileNotFoundError:
        print("[frontend] 未检测到 npx，跳过前端模块测试（仅列出文件）")
        return 0
    record_frontend(json_out)
    return r.returncode


def run_frontend_full() -> int:
    """前端全量（fast / quick / react / react-deep 四档）+ 写入测试结果库。"""
    fe_root = REPO / "frontend"
    json_out = fe_root / "node_modules" / ".cache" / "vitest-full.json"
    json_out.parent.mkdir(parents=True, exist_ok=True)
    print("[frontend] 运行前端全量：fast / quick / react / react-deep")
    try:
        r = subprocess.run(
            ["npx", "vitest", "run", "--reporter=json", f"--outputFile={json_out}"],
            cwd=fe_root, check=False,
        )
    except FileNotFoundError:
        print("[frontend] 未检测到 npx，跳过前端全量")
        return 0
    record_frontend(json_out)
    return r.returncode


def record_frontend(json_out: Path) -> None:
    """把 vitest JSON 报告写入测试结果库（失败只提示，不影响回归结论）。"""
    script = ROOT / "scripts" / "record_frontend_results.py"
    if not json_out.exists() or not script.exists():
        return
    runner = str(PYTHON) if PYTHON.exists() else sys.executable
    try:
        subprocess.run([runner, str(script), "--json", str(json_out)], cwd=ROOT, check=False)
    except Exception as exc:  # noqa: BLE001 - 记录失败不应把绿的回归判红
        print(f"[frontend] 执行结果未写入结果库：{exc}")


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
#   ③ all/ci  —— 全量，发版收口 / 手动 full_suite / 结构性变更降级时用。
# 横切组与业务域组可重叠（同一文件既属 unit 又属某域），但反查「文件→组」时
# 必须排除横切组，否则会把域归属覆盖成横切组导致跑错范围。
CROSSCUT_GROUPS = {"smoke", "p0", "unit"}

GROUPS = {
    "smoke": [
        "tests/backend/unit/system/test_main_contract.py",
        "tests/backend/unit/system/test_api_contract.py",
        "tests/backend/unit/system/test_request_schema_contract.py",
        "tests/backend/unit/system/test_money.py",
        "tests/backend/integration/system/test_numbering.py",
        "tests/backend/unit/system/test_state_machine.py",
    ],
    # 单元档：不碰数据库与 HTTP，实测 106 passed（空闲机约 2.3s，负载下会延长）。
    # 准入标准（后补须先实测）：单文件 < 1s、不依赖 seeded_db/seeded_client/TestClient。
    "unit": [
        "tests/backend/unit/system/test_money.py",
        "tests/backend/integration/system/test_numbering.py",
        "tests/backend/unit/system/test_state_machine.py",
        "tests/backend/unit/system/test_api_contract.py",
        "tests/backend/unit/system/test_request_schema_contract.py",
        "tests/backend/unit/business/test_cancellation_model.py",
        "tests/backend/unit/business/test_orders_common.py",
        "tests/backend/unit/finance/test_finance_attributes.py",
        "tests/backend/unit/finance/test_rebate_current_contract.py",
        "tests/backend/unit/settings/test_product_alias_compat.py",
        "tests/backend/unit/system/test_main_contract.py",
        # 列表列「界面↔注册表」守卫：纯静态读前端源码，无 DB/HTTP，0.04s。
        # 曾长期游离在所有分组之外 —— 前端把报表视图拆成 ./reports/*.tsx 后它指错文件、
        # 7 条 RPT_* 一直红着却没人发现，证明「不在分组里的守卫等于没有守卫」。
        "tests/backend/unit/settings/test_list_scope_ui_parity.py",
        # 承诺归属守卫：静态解析当前后端测试文件的 docstring，无 DB/HTTP，0.4s。
        # 它守的是「每个测试文件都能说清自己在保护哪条承诺」，以及清单证据不指向
        # 不存在的文件——没有它，新增测试就是加一个没人知道在测什么的文件。
        "tests/backend/unit/system/test_promise_declaration.py",
        # 快通道守卫：静态核对 db 标记是否仍由夹具依赖派生、自建连接的文件是否显式声明。
        # 它守的是「pytest -m "not db" 里不会偷偷连库」，无 DB/HTTP，< 0.1s。
        "tests/backend/unit/system/test_db_channel.py",
        # 分组覆盖守卫：断言磁盘上每个 test_*.py 都登记在本表的某个组内。
        # 它守的是「新增测试文件必须进白名单」——曾有一批 13 个文件 68 个用例
        # 因未登记而从未进过 CI，且不报错、不告警。
        "tests/backend/unit/system/test_group_coverage.py",
        # 结构一致性守卫：扫盘核对文件数、区域归属与分层归属是否与 tests/manifest.json 一致。
        # 它守的是「搬目录后扫描范围仍指向旧路径」——失败表现是结果为空而非报错，
        # 用例会整批从用例库与报告里消失。纯静态，< 0.1s。
        "tests/backend/unit/system/test_manifest_parity.py",
        "tests/backend/unit/finance/test_finance_boundaries.py",
        "tests/backend/unit/business/test_order_detail_labels.py",
        "tests/backend/unit/business/test_operation_operators.py",
    ],
    "p0": [
        "tests/backend/integration/settings/test_order_types_api.py",
        "tests/backend/integration/business/test_orders_contract.py",
        "tests/backend/integration/business/test_orders_create_validation.py",
        "tests/backend/integration/business/test_orders_query_contract.py",
        "tests/backend/integration/business/test_orders_account_effects.py",
        "tests/backend/integration/business/test_orders_api.py",
        "tests/backend/integration/business/test_orders.py",
        "tests/backend/integration/business/test_orders_flows.py",
        "tests/backend/integration/business/test_orders_events.py",
        "tests/backend/integration/business/test_orders_roles.py",
        "tests/backend/integration/business/test_installments_contract.py",
        "tests/backend/integration/business/test_installments_create.py",
        "tests/backend/integration/business/test_installments_lifecycle.py",
        "tests/backend/integration/business/test_installments_overdue.py",
        "tests/backend/integration/business/test_installments_api_class.py",
        "tests/backend/integration/operations/test_reporting_contract.py",
        "tests/backend/integration/business/test_m2.py",
    ],
    "foundation": [
        "tests/backend/integration/settings/test_foundation_contract.py",
        "tests/backend/integration/settings/test_foundation_order_types_service.py",
        "tests/backend/integration/system/test_foundation_pools_service.py",
        "tests/backend/integration/settings/test_order_types_api.py",
        "tests/backend/integration/finance/test_pools_api.py",
        "tests/backend/integration/settings/test_form_extra_scopes.py",
        "tests/backend/integration/settings/test_order_form_fields.py",
        "tests/backend/integration/settings/test_order_form_fields_router.py",
        "tests/backend/integration/settings/test_order_form_fields_guards.py",
        "tests/backend/integration/system/test_numbering.py",
        "tests/backend/unit/system/test_settings.py",
        "tests/backend/integration/settings/test_game_types.py",
        "tests/backend/integration/settings/test_game_types_contract.py",
        "tests/backend/integration/settings/test_option_sets_api.py",
        "tests/backend/unit/settings/test_product_alias_compat.py",
    ],
    "accounts": [
        "tests/backend/integration/business/test_accounts_contract.py",
        "tests/backend/integration/business/test_account_stock_no.py",
        "tests/backend/unit/business/test_account_inventory_age.py",
        "tests/backend/integration/business/test_inventory_stats.py",
        "tests/backend/integration/business/test_account_delete.py",
    ],
    "orders": [
        "tests/backend/integration/business/test_orders_contract.py",
        "tests/backend/integration/business/test_orders_create_validation.py",
        "tests/backend/integration/business/test_orders_query_contract.py",
        "tests/backend/integration/business/test_orders_account_effects.py",
        "tests/backend/integration/business/test_orders_api.py",
        "tests/backend/integration/business/test_orders.py",
        "tests/backend/integration/business/test_orders_flows.py",
        "tests/backend/integration/business/test_orders_events.py",
        "tests/backend/integration/business/test_orders_roles.py",
        "tests/backend/unit/business/test_orders_events_service.py",
        "tests/backend/unit/system/test_state_machine.py",
        "tests/backend/unit/system/test_api_contract.py",
        "tests/backend/unit/system/test_request_schema_contract.py",
        "tests/backend/unit/business/test_cancellation_model.py",
        "tests/backend/unit/business/test_orders_common.py",
        "tests/backend/integration/business/test_orders_guard.py",
        "tests/backend/integration/business/test_orders_router_guard.py",
        "tests/backend/integration/business/test_order_execution_edit.py",
        "tests/backend/integration/customer/test_order_customer_source_fixtures.py",
        "tests/backend/integration/business/test_profit_allocation_modes.py",
        "tests/backend/integration/business/test_flow_recycle.py",
        "tests/backend/unit/business/test_order_status_contract.py",
        "tests/backend/integration/business/test_flow_sale.py",
        "tests/backend/integration/business/test_flow_config_driven.py",
        "tests/backend/integration/business/test_stock_intake_contract.py",
        "tests/backend/integration/business/test_cancel_inventory_release.py",
        "tests/backend/integration/business/test_inventory_offsale_atomic.py",
        "tests/backend/integration/business/test_inventory_offsale_concurrency.py",
        "tests/backend/integration/business/test_order_duplicate_account.py",
        "tests/backend/integration/business/test_order_event_cancellable_amount.py",
        # 2026-11-12 金额链路
        "tests/backend/integration/business/test_order_financial_date_shift.py",
        "tests/backend/unit/business/test_order_detail_labels.py",
        "tests/backend/unit/business/test_operation_operators.py",
    ],
    "installments": [
        "tests/backend/integration/business/test_installment_payment_concurrency.py",
        "tests/backend/integration/business/test_installments_contract.py",
        "tests/backend/integration/business/test_installments_create.py",
        "tests/backend/integration/business/test_installments_lifecycle.py",
        "tests/backend/integration/business/test_installments_overdue.py",
        "tests/backend/integration/business/test_installments_api_class.py",
        "tests/backend/integration/business/test_m2.py",
        "tests/backend/integration/business/test_installments_service.py",
        "tests/backend/integration/business/test_installments_service_write_paths.py",
        "tests/backend/integration/business/test_installments_service_defensive.py",
        "tests/backend/integration/business/test_flow_installment.py",
        "tests/backend/integration/business/test_installment_remaining.py",
        "tests/backend/integration/business/test_installment_totals.py",
    ],
    "finance": [
        "tests/backend/integration/finance/test_finance_api.py",
        "tests/backend/integration/finance/test_finance_deposits.py",
        "tests/backend/integration/finance/test_finance_rebates_guards.py",
        "tests/backend/integration/finance/test_finance_reconciliation.py",
        "tests/backend/unit/finance/test_finance_attributes.py",
        "tests/backend/integration/finance/test_finance_cashflows_service.py",
        "tests/backend/integration/finance/test_finance_cashflows_deposits.py",
        "tests/backend/integration/finance/test_finance_cashflows_guards.py",
        "tests/backend/integration/finance/test_deposit_remaining.py",
        "tests/backend/integration/finance/test_finance_controls_service.py",
        "tests/backend/integration/finance/test_finance_rebates_service.py",
        "tests/backend/integration/finance/test_finance_router_contract.py",
        "tests/backend/unit/finance/test_rebate_rules_contract.py",
        "tests/backend/unit/system/test_money.py",
        "tests/backend/integration/finance/test_finance_reconciliation_service.py",
        "tests/backend/integration/finance/test_finance_transfers_service.py",
        "tests/backend/unit/finance/test_rebate_current_contract.py",
        "tests/backend/integration/finance/test_finance_reversal_service.py",
        "tests/backend/integration/business/test_flow_distribution.py",
        "tests/backend/integration/finance/test_cashflow_totals.py",
        "tests/backend/integration/finance/test_cashflow_write_concurrency.py",
        "tests/backend/integration/finance/test_pool_balances_batch.py",
        "tests/backend/integration/finance/test_studio_cashflow_summary.py",
        # 2026-11-12 金额链路/裁决批次（资金两方向、金额大类口径）
        "tests/backend/integration/finance/test_funds_direction_and_deposit.py",
        "tests/backend/unit/finance/test_finance_boundaries.py",
    ],
    "parties": [
        "tests/backend/integration/customer/test_parties.py",
        "tests/backend/integration/customer/test_parties_contract.py",
        "tests/backend/integration/customer/test_parties_customer_lifecycle.py",
        "tests/backend/integration/customer/test_parties_counterparty_api.py",
        "tests/backend/integration/customer/test_parties_fields_service.py",
        "tests/backend/integration/customer/test_leads_contract.py",
        "tests/backend/integration/customer/test_parties_policy_guard.py",
        "tests/backend/unit/customer/test_parties_masking.py",
    ],
    "reporting": [
        "tests/backend/integration/operations/test_reporting_contract.py",
        "tests/backend/unit/operations/test_report_export_columns.py",
        "tests/backend/unit/operations/test_xlsx_sheet_capacity.py",
        "tests/backend/integration/operations/test_reporting_service.py",
        "tests/backend/integration/operations/test_reporting_r_consistency.py",
        "tests/backend/integration/operations/test_profit_cashflow_basis.py",
        "tests/backend/integration/operations/test_profit_r2_accounting.py",
        "tests/backend/integration/operations/test_data_center_summary.py",
    ],
    "profit-allocation": [
        "tests/backend/integration/settings/test_policy_allocation.py",
    ],
    "governance": [
        "tests/backend/integration/system/test_attachments_contract.py",
        "tests/backend/integration/system/test_audit_contract.py",
        "tests/backend/integration/system/test_attachments_service.py",
        "tests/backend/integration/workbench/test_contract_message_visibility.py",
        "tests/backend/integration/workbench/test_notifications_service.py",
        "tests/backend/integration/workbench/test_overdue_notifications.py",
        "tests/backend/integration/workbench/test_profit_notifications_settings.py",
    ],
    "migration": [
        "tests/backend/integration/system/test_migration.py",
    ],
    # 跨域基建板块：列表列/导出、部署脚本、覆盖率与迁移基线——改动常横跨多域。
    "platform": [
        "tests/backend/unit/system/test_core_contract.py",
        "tests/backend/integration/settings/test_list_columns.py",
        "tests/backend/integration/settings/test_list_custom_columns.py",
        "tests/backend/integration/operations/test_list_export_csv.py",
        "tests/backend/unit/system/test_deploy_script_contract.py",
        "tests/backend/unit/system/test_backup_scripts.py",
        "tests/backend/integration/business/test_inventory_ledger_export.py",
    ],
    "auth": [
        "tests/backend/integration/system/test_auth_contract.py",
        "tests/backend/integration/system/test_auth_users.py",
        "tests/backend/integration/system/test_auth_teams.py",
        "tests/backend/unit/system/test_main_contract.py",
        "tests/backend/unit/system/test_backup_scripts.py",
        "tests/backend/unit/system/test_public_release_security.py",
        "tests/backend/integration/system/test_ratelimit.py",
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


def _groups_for_source_path(path: str) -> set[str]:
    """源码路径 → 业务域组。规则与历史 groups_for_changes 完全一致，抽出来供
    选测与「结构性变更」判定共用，避免两份 token 规则各自漂移。"""
    selected: set[str] = set()
    if path.startswith("backend/app/settings/field_definitions/") or "foundation" in path \
        or "order_type" in path or "pool" in path or "live_field" in path:
        selected.add("foundation")
    if "account" in path:
        selected.add("accounts")
    if path.startswith("backend/app/trade/") or any(
        t in path for t in ("business/", "order", "state_machine", "request_schema")
    ):
        selected.add("orders")
    if "installment" in path or path.endswith("/test_m2.py"):
        selected.add("installments")
    if path.startswith("backend/app/funds/") or "finance" in path or "rebate" in path:
        selected.add("finance")
    if any(t in path for t in ("customers", "parties", "leads")):
        selected.add("parties")
    if "report" in path:
        selected.add("reporting")
    if "profit-allocation" in path:
        selected.add("profit-allocation")
    if any(t in path for t in ("notifications", "attachments", "audit")):
        selected.add("governance")
    if any(t in path for t in ("migration", "history")):
        selected.add("migration")
    if any(t in path for t in ("auth", "backup_restore", "main_contract", "settings")):
        selected.add("auth")
    return selected


# 核心 / 共享 / 配置 / 测试基建 / 跨模块取数口：启发式选测不许碰，一律降级全量。
STRUCTURAL_PREFIXES = (
    "backend/app/core/", "backend/app/domain/", "backend/app/main.py",
    "backend/app/config", "backend/app/settings", "backend/app/db",
    "backend/requirements", "backend/alembic/", "backend/run_regression.py",
    "tests/config/catalog.py", "backend/scripts/promise_catalog.py",
    "conftest.py", "pytest.ini", "tests/conftest.py", "tests/backend/conftest.py",
    "backend/app/business/amounts.py", "backend/app/operations/",
    "backend/app/funds/installments/", "backend/app/funds/profit_allocation/",
)
# 自动发版只改版本常量，不影响测试范围；本地 changed 遇到它也不该触发全量。
NON_STRUCTURAL_FILES = {"VERSION"}


def is_structural_change(paths: list[str]) -> bool:
    """看不懂的后端改动一律降级全量：核心路径直接命中，或 backend/ 下路径
    未被任何业务域 token 命中（说明规则没覆盖，不能靠猜压缩范围）。"""
    for path in paths:
        if path.startswith("frontend/") or path.startswith("tests/backend/"):
            continue
        if path in NON_STRUCTURAL_FILES:
            continue
        if any(path.startswith(x) for x in STRUCTURAL_PREFIXES):
            return True
        if path.startswith("backend/") and not _groups_for_source_path(path):
            return True
    return False


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
        if path.startswith("tests/backend/"):
            if path in test_groups:
                selected.add(test_groups[path])
            else:
                # 旧行为是「退化成跑全部非横切组」——多跑，不报错，于是 GROUPS 里
                # 写错/漏写的路径永远不会被发现（搬目录时 141 条路径全变，靠这条
                # 退化分支会「看起来一切正常」）。宁可响亮失败。
                raise SystemExit(
                    f"[changed] 测试文件 {path} 不在 GROUPS 任何组内。\n"
                    "把它登记进对应域组后再跑；本次不再退化成跑全量。"
                )
            continue
        selected |= _groups_for_source_path(path)
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
        if matched:
            # cwd 是 backend，pyflakes 对 ../tests/backend 会输出带 ../ 的路径；
            # 基线统一用仓库相对路径，故在此归一化。
            clean = matched["path"]
            if clean.startswith("../"):
                clean = clean[3:]
            findings.append(f"{clean} :: {matched['msg']}")
        else:
            findings.append(line)
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
    parser = argparse.ArgumentParser(
        description="执行按业务域 / 模块 / 测试类型 / 跨模块拆分的后端回归"
    )
    parser.add_argument(
        "group",
        choices=[*GROUPS, "changed", "all", "ci", "lint", "cross", "fe", *MODULES, "ut", "it", "e2e"],
        help="回归分组：业务域名=板块档；A-F/SYS=模块档；ut/it/e2e=类型档；"
             "cross=跨模块流程；ci/all=全量；fe=前端全量(四档)；lint=静态检查；"
             "changed=按 git 变更或 --changed-paths 选组",
    )
    parser.add_argument("--type", choices=["ut", "it", "e2e"],
                        help="与模块档组合：仅跑该模块的某类型（如 B --type ut）")
    parser.add_argument("--backend-only", action="store_true",
                        help="模块档只跑后端，不跑前端 vitest")
    parser.add_argument("--list", action="store_true", help="仅展示将执行的测试文件")
    parser.add_argument(
        "--update-baseline", action="store_true", help="仅用于 lint：把当前存量告警写入基线"
    )
    parser.add_argument(
        "--changed-paths", default="",
        help="逗号分隔的变更路径（CI 由 main-ci-cd 注入原始 push 范围）；"
             "缺省时回退 git status --short（本地开发）",
    )
    parser.add_argument(
        "--parallel", action="store_true",
        help="后端 pytest 走 pytest-xdist 多 worker 并行（每个 worker 自动建独立库）。"
             "conftest 已保证默认串行行为不变；仅 -n 时生效，约快 40%。",
    )
    args = parser.parse_args()
    pytest_parallel_args = ["-n", "4", "--dist=loadfile"] if args.parallel else []
    if args.group == "lint":
        return run_lint(
            str(PYTHON) if PYTHON.exists() else sys.executable,
            update_baseline=args.update_baseline,
        )
    if args.group == "fe":
        if args.list:
            print("# 前端全量（fast / quick / react / react-deep）")
            return 0
        return run_frontend_full()
    if args.group == "changed":
        if args.changed_paths:
            paths_changed = [x.strip() for x in args.changed_paths.split(",") if x.strip()]
            source = "--changed-paths 注入"
        else:
            paths_changed = changed_paths()
            source = "git status --short"
        frontend_changed = any(x.startswith("frontend/") for x in paths_changed)
        if is_structural_change(paths_changed):
            # 启发式选测看不懂的改动一律全量，绝不靠猜压缩范围。
            selected: list[str] = []
            paths = all_paths()
            label = f"ci（结构性变更降级全量；来源={source}）"
        else:
            selected = groups_for_changes(paths_changed)
            if not selected:
                # 静默跳过等于没有门禁：无业务变更 / 仅前端变更时跑秒级冒烟 + 资产守卫。
                selected = ["smoke", "unit"]
            else:
                # 横切守卫（分组覆盖 / 承诺归属 / 清单一致性）秒级，每轮都带上，
                # 保证选测不会让测试资产漂移无人发现。
                selected = ["smoke", "unit", *selected]
            paths = unique_paths(selected)
            label = f"changed（{', '.join(selected)}；来源={source}）"
        print(f"按变更自动选择：{label}")
        if args.list:
            if frontend_changed and not args.backend_only:
                print("frontend: npm run check + npm run test:fast")
            print("\n".join(paths))
            return 0
        runner = str(PYTHON) if PYTHON.exists() else sys.executable
        print(f"=== 执行 {label}：{len(paths)} 个后端文件 ===")
        result = subprocess.run(
            [runner, "-m", "pytest", "-q", *pytest_parallel_args, *[_pytest_arg(x) for x in paths]],
            cwd=ROOT,
            env=regression_environment(),
            check=False,
        )
        if result.returncode:
            return result.returncode
        if frontend_changed and not args.backend_only:
            fe_root = ROOT.parent / "frontend"
            check_result = subprocess.run(["npm", "run", "check"], cwd=fe_root, check=False)
            if check_result.returncode:
                return check_result.returncode
            return subprocess.run(["npm", "run", "test:fast"], cwd=fe_root, check=False).returncode
        return 0
    fe_paths: list[str] = []
    if args.group == "cross":
        paths = [f"tests/backend/{f}" for f in cross_files()]
        label = "跨模块流程(FLOW-*)"
    elif args.group in MODULES:
        module = args.group
        if args.type:
            paths = [f"tests/backend/{f}" for f in module_type_files(module, args.type)]
            label = f"模块 {module} / 类型 {args.type}"
            if not args.backend_only and args.type in ("it", "e2e"):
                fe_paths = frontend_module_files(module)
        else:
            paths = [f"tests/backend/{f}" for f in module_files(module)]
            label = f"模块 {module}（后端 UT+IT）"
            if not args.backend_only:
                fe_paths = frontend_module_files(module)
    elif args.group in ("ut", "it", "e2e"):
        ttype = args.group
        if ttype == "e2e":
            paths = []
            label = "E2E（当前无常住 E2E 套件）"
            print(f"[{label}] 无匹配测试文件")
            return 0
        paths = [f"tests/backend/{f}" for f in type_files(ttype)]
        label = f"类型 {ttype}"
    else:
        paths = all_paths() if args.group in ("all", "ci") else GROUPS[args.group]
        label = args.group
    if args.list:
        print(f"# {label}")
        print("\n".join(paths))
        if fe_paths:
            for f in fe_paths:
                print(f)
        return 0
    if not paths:
        print(f"[{label}] 无匹配后端测试文件")
        return 0
    runner = str(PYTHON) if PYTHON.exists() else sys.executable
    print(f"=== 执行 {label}：{len(paths)} 个后端文件 ===")
    result = subprocess.run(
        [runner, "-m", "pytest", "-q", *pytest_parallel_args, *[_pytest_arg(x) for x in paths]],
        cwd=ROOT,
        env=regression_environment(),
        check=False,
    )
    rc = result.returncode
    # 模块档：后端跑完后（如有）再跑前端模块测试（best-effort）
    if fe_paths:
        frc = run_frontend_files(fe_paths)
        rc = rc or frc
    return rc


if __name__ == "__main__":
    raise SystemExit(main())
