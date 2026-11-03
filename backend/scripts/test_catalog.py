#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""宜游轩 ERP 测试目录（模块 / 类型 / 跨模块）—— 单一事实源。

供两套消费者复用，避免编号/归属漂移：
  - run_regression.py    ：按模块、测试类型(UT/IT/E2E)、跨模块筛选执行文件清单。
  - gen_test_case_library.py：生成测试用例库（含所属模块 / 关联模块）。

设计要点：
  - 文件 -> 功能编号 -> 模块字母（A/B/C/D/E/F/SYS），功能编号见《功能编号注册表.csv》。
  - 测试类型：落在 run_regression.py 的 `unit` 组的后端文件 = UT，其余后端 = IT；
    前端 vitest = IT；E2E 为独立层（当前无常住 E2E，预留）。
  - 跨模块用例：FLOW-* 流程文件显式登记，可同时关联多个业务模块（同一用例多模块归属）。
  - 跨模块不是第四种层级：FLOW 文件仍是 IT/E2E 类型，仅额外打「跨模块」标记。
"""
from __future__ import annotations

import csv
import os
import re

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))  # /Users/aries/黑金时代
BACKEND = os.path.join(REPO, "backend")
FRONTEND = os.path.join(REPO, "frontend")
REGISTRY = os.path.join(REPO, "docs/testing", "功能编号注册表.csv")
RUN_REG = os.path.join(BACKEND, "run_regression.py")

MODULES = ["A", "B", "C", "D", "E", "F", "SYS"]

# ---------------------------------------------------------------------------
# 后端测试文件 -> 功能编号（按真实代码盘点；110 个文件逐一映射）
# ---------------------------------------------------------------------------
BACKEND_FILE_TO_FUNC: dict[str, str] = {
    "test_account_inventory_age.py": "B05",
    "test_account_stock_no.py": "B04",
    "test_accounts_contract.py": "B04",
    "test_api_contract.py": "SYS07",
    "test_attachments_contract.py": "SYS08",
    "test_attachments_service.py": "SYS08",
    "test_audit_contract.py": "SYS05",
    "test_auth_contract.py": "SYS01",
    "test_backup_scripts.py": "SYS09",
    "test_bughunt.py": "B01",
    "test_cancel_inventory_release.py": "B06",
    "test_cancellation_model.py": "B02",
    "test_cashflow_totals.py": "D02",
    "test_core_contract.py": "SYS07",
    "test_core_infra_gaps.py": "SYS10",
    "test_coverage_gate.py": "SYS11",
    "test_deploy_script_contract.py": "SYS09",
    "test_deposit_remaining.py": "B08",
    "test_execution_cancellable_amount.py": "B08",
    "test_execution_finance_summary.py": "B10",
    "test_finance_attributes.py": "D02",
    "test_finance_cashflows_service.py": "D02",
    "test_finance_contract.py": "D01",
    "test_finance_controls_service.py": "D03",
    "test_finance_idempotency_service.py": "D02",
    "test_finance_rebates_service.py": "D04",
    "test_finance_reconciliation_service.py": "D03",
    "test_finance_reporting_task5_tail.py": "D05",
    "test_finance_reversal_service.py": "D03",
    "test_finance_router_contract.py": "D02",
    "test_finance_transfers_service.py": "D01",
    "test_flow_config_driven.py": "B09",
    "test_flow_distribution.py": "B07",
    "test_flow_installment.py": "B08",
    "test_flow_recycle.py": "B06",
    "test_flow_sale.py": "B06",
    "test_form_extra_scopes.py": "F02",
    "test_foundation_contract.py": "F05",
    "test_foundation_order_types_service.py": "F05",
    "test_foundation_pools_service.py": "SYS06",
    "test_game_types.py": "F04",
    "test_game_types_contract.py": "F04",
    "test_import_landing.py": "E03",
    "test_import_mapping.py": "E03",
    "test_imports_contract.py": "E03",
    "test_installment_remaining.py": "B08",
    "test_installment_totals.py": "B08",
    "test_installments_contract.py": "B08",
    "test_installments_service.py": "B08",
    "test_inventory_execution_edit.py": "B04",
    "test_inventory_stats.py": "B05",
    "test_leads_contract.py": "C01",
    "test_list_columns.py": "F03",
    "test_list_custom_columns.py": "F03",
    "test_list_export_csv.py": "E02",
    "test_list_scope_ui_parity.py": "F03",
    "test_m2.py": "B08",
    "test_m4.py": "E01",
    "test_m5_policy.py": "F01",
    "test_main_contract.py": "SYS07",
    "test_migration.py": "SYS13",
    "test_money.py": "SYS02",
    "test_money_float_guard.py": "SYS02",
    "test_notifications_contract.py": "SYS08",
    "test_notifications_service.py": "SYS08",
    "test_numbering.py": "SYS03",
    "test_option_sets_api.py": "F04",
    "test_order_customer_source_fixtures.py": "C03",
    "test_order_duplicate_account.py": "B04",
    "test_order_event_cancellable_amount.py": "B03",
    "test_order_form_fields.py": "F02",
    "test_order_status_contract.py": "B02",
    "test_order_types_api.py": "F05",
    "test_orders.py": "B01",
    "test_orders_common.py": "B01",
    "test_orders_contract.py": "B01",
    "test_orders_events_service.py": "B03",
    "test_orders_guard.py": "B02",
    "test_orders_router_guard.py": "B02",
    "test_parties.py": "C01",
    "test_parties_contract.py": "C01",
    "test_parties_fields_service.py": "C01",
    "test_parties_masking.py": "C02",
    "test_parties_policy_guard.py": "C01",
    "test_policy_contract.py": "F01",
    "test_policy_rule_consumption.py": "F01",
    "test_pool_balances_batch.py": "D01",
    "test_pools_api.py": "D01",
    "test_product_alias_compat.py": "F04",
    "test_profit_allocation_modes.py": "B10",
    "test_public_release_security.py": "SYS01",
    "test_quality_contract.py": "SYS08",
    "test_quality_guard.py": "SYS08",
    "test_quality_issue_contract.py": "SYS08",
    "test_quality_issues_service.py": "SYS08",
    "test_quality_metrics_contract.py": "SYS08",
    "test_ratelimit.py": "SYS01",
    "test_rebate_current_contract.py": "D04",
    "test_rebate_rules_contract.py": "D04",
    "test_report_export_columns.py": "E02",
    "test_reporting_contract.py": "E01",
    "test_reporting_r_consistency.py": "E01",
    "test_reporting_service_gaps.py": "E01",
    "test_request_schema_contract.py": "SYS07",
    "test_search_contract.py": "SYS08",
    "test_settings.py": "SYS06",
    "test_state_machine.py": "SYS04",
    "test_stock_intake_contract.py": "B04",
    "test_studio_cashflow_summary.py": "D05",
    "test_unreachable_status_paths.py": "B02",
}

# ---------------------------------------------------------------------------
# 跨模块流程文件：显式登记其跨模块归属（可多模块）
# FLOW-001 客户↔订单(C→B)、FLOW-002 订单↔资金(B→D)、FLOW-003 订单↔经营(B→E)、
# FLOW-004 资金↔经营(D→E)、FLOW-005 配置↔业务(F→B)、FLOW-006 认证↔全模块(SYS→A-F)
# 这些文件本身仍是 IT 类型，仅额外标记「跨模块」。
# ---------------------------------------------------------------------------
CROSS_MODULE_FILES: dict[str, set[str]] = {
    "test_flow_sale.py": {"B", "D"},            # 售出：订单状态 + 资金池余额同源
    "test_flow_distribution.py": {"B", "D"},    # 分销结算：订单 + 资金
    "test_flow_installment.py": {"B", "D"},     # 分期回款：订单 + 资金
    "test_flow_recycle.py": {"B", "D"},         # 回收售出：库存 + 资金
    "test_flow_config_driven.py": {"B", "F"},   # 配置驱动建单：设置 + 业务
}
CROSS_FLOW_LABEL = {
    "test_flow_sale.py": "FLOW-002",
    "test_flow_distribution.py": "FLOW-002",
    "test_flow_installment.py": "FLOW-002",
    "test_flow_recycle.py": "FLOW-002",
    "test_flow_config_driven.py": "FLOW-005",
}


def frontend_func_for(relpath: str) -> str:
    p = relpath.replace("\\", "/")
    rules = [
        ("/auth/", "SYS01"), ("/users/", "SYS01"),
        ("/attachments/", "SYS08"), ("/audit/", "SYS05"),
        ("/notifications/", "SYS08"), ("/search/", "SYS08"),
        ("/quality/", "SYS08"), ("/customers/", "C01"),
        ("/imports/", "E03"), ("/installments/", "B08"),
        ("/rebates/", "D04"), ("/policy/", "F01"),
        ("/reporting/", "E01"),
        ("/stocks/consignment-logic", "B07"), ("/stocks/inventory-export", "E02"),
        ("/stocks/sale-plan", "B06"), ("/stocks/findCancelable", "B06"),
        ("/stocks/inventory-logic", "B05"), ("/stocks/", "B04"),
        ("/pools/StudioExpensePanel", "D05"), ("/pools/", "D01"),
        ("/orders/recovery/", "B06"), ("/orders/th/", "B07"),
        ("/orders/ConfigurableField", "B09"), ("/orders/formSections", "B09"),
        ("/orders/", "B01"),
        ("/field-definitions/panels/ListColumnsPanel", "F03"),
        ("/field-definitions/panels/OrderFormFieldsPanel", "F02"),
        ("/field-definitions/panels/OrderTypesPanel", "F05"),
        ("/field-definitions/panels/PoolsPanel", "D01"),
        ("/field-definitions/formScopes", "F02"), ("/field-definitions/", "F01"),
        ("/shared/lib/money", "SYS02"), ("/shared/lib/format", "SYS02"),
        ("/shared/lib/listColumns", "F03"), ("/shared/lib/retiredProducts", "F04"),
        ("/shared/state/session", "SYS01"), ("/shared/state/antdTheme", "F05"),
        ("/shared/api/", "SYS07"), ("/shared/ui/", "SYS07"), ("/shared/", "SYS07"),
        ("/regression/", "SYS11"), ("/test/fixtures", "SYS10"),
        ("/vite.config.test", "SYS10"),
        ("/app/DashboardPage", "A01"), ("/app/AppearancePanel", "SYS07"),
        ("/app/businessReminderConfig", "B02"), ("/app/AppShell", "SYS07"),
    ]
    for frag, code in rules:
        if frag in p:
            return code
    return "SYS12"


def load_registry() -> dict[str, dict]:
    reg: dict[str, dict] = {}
    with open(REGISTRY, encoding="utf-8-sig") as f:
        for row in csv.DictReader(f):
            code = row["功能编号"].strip()
            reg[code] = {
                "module": row["模块"].strip(),
                "name": row["功能名称"].strip(),
                "old": row.get("关联旧编号(BIZ)", "").strip(),
            }
    return reg


REGISTRY_DATA = load_registry()
FUNC_TO_MODULE = {code: meta["module"] for code, meta in REGISTRY_DATA.items()}


def module_of_func(func: str) -> str:
    return FUNC_TO_MODULE.get(func, "SYS")


# ---------------------------------------------------------------------------
# 文件 -> 模块（主归属 + 关联模块）
# ---------------------------------------------------------------------------
def backend_file_modules(fname: str) -> tuple[str, set[str]]:
    """返回 (主模块, 关联模块集合)。跨模块文件主模块取功能编号模块，关联模块含 FLOW 跨度。"""
    func = BACKEND_FILE_TO_FUNC.get(fname, "SYS12")
    primary = module_of_func(func)
    related = {primary}
    if fname in CROSS_MODULE_FILES:
        related |= CROSS_MODULE_FILES[fname]
    return primary, related


def frontend_file_modules(relpath: str) -> tuple[str, set[str]]:
    func = frontend_func_for(relpath)
    primary = module_of_func(func)
    return primary, {primary}


# ---------------------------------------------------------------------------
# run_regression.py 的 unit 组（决定 UT 类型）
# ---------------------------------------------------------------------------
def _group_files(group_name: str) -> set[str]:
    text = open(RUN_REG, encoding="utf-8").read()
    m = re.search(r'"%s":\s*\[(.*?)\]' % re.escape(group_name), text, re.S)
    if not m:
        return set()
    return {os.path.basename(x) for x in re.findall(r'"([^"]+)"', m.group(1))}


UNIT_FILES = _group_files("unit")


def test_type_of_backend_file(fname: str) -> str:
    return "UT" if fname in UNIT_FILES else "IT"


# ---------------------------------------------------------------------------
# 筛选接口（供 run_regression.py 调用）
# ---------------------------------------------------------------------------
def all_backend_test_files() -> list[str]:
    d = os.path.join(BACKEND, "tests", "v1")
    return sorted(f for f in os.listdir(d) if f.startswith("test_") and f.endswith(".py"))


def module_files(module: str) -> list[str]:
    """某模块的全部后端测试文件（UT + IT；含跨模块归属命中的文件）。"""
    out = []
    for f in all_backend_test_files():
        primary, related = backend_file_modules(f)
        if module in related:
            out.append(f)
    return sorted(out)


def cross_files() -> list[str]:
    return sorted(CROSS_MODULE_FILES)


def type_files(ttype: str) -> list[str]:
    """ttype=ut -> unit 组；it -> 非 unit 后端；e2e -> 当前无常住 E2E（返回空）"""
    if ttype == "ut":
        return sorted(UNIT_FILES)
    if ttype == "it":
        return sorted(set(all_backend_test_files()) - UNIT_FILES)
    return []  # e2e 预留


def module_type_files(module: str, ttype: str) -> list[str]:
    return sorted(set(module_files(module)) & set(type_files(ttype)))


def frontend_module_files(module: str) -> list[str]:
    """某模块的前端测试文件（相对仓库根 frontend/...）。"""
    out = []
    src = os.path.join(FRONTEND, "src")
    for root, _dirs, files in os.walk(src):
        for fn in files:
            if not fn.endswith((".test.ts", ".test.tsx", ".spec.ts", ".spec.tsx")):
                continue
            rel = "frontend/" + os.path.relpath(os.path.join(root, fn), FRONTEND)
            prim, _ = frontend_file_modules(rel)
            if prim == module:
                out.append(rel)
    return sorted(out)


def module_summary() -> dict[str, int]:
    return {m: len(module_files(m)) for m in MODULES}


if __name__ == "__main__":
    import json
    print(json.dumps({"modules": module_summary(),
                      "cross": cross_files(),
                      "ut_count": len(type_files("ut")),
                      "it_count": len(type_files("it"))}, ensure_ascii=False, indent=2))
