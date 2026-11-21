#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""宜游轩 ERP 测试目录（模块 / 类型 / 跨模块）—— 单一事实源。

供两套消费者复用，避免编号/归属漂移：
  - run_regression.py    ：按模块、测试类型(UT/IT/E2E)、跨模块筛选执行文件清单。
  - gen_test_case_library.py：生成测试用例库（含所属模块 / 关联模块）。

设计要点：
  - 文件 -> 功能编号 -> 模块字母（A/B/C/D/E/F/SYS），功能编号见《测试元数据台账.csv》的 FEATURE 记录。
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
# 前端测试只有一个根：仓库根 tests/frontend/<unit|module>/<区域>/（2026-11-04 整体迁入）。
# 键统一以仓库根为基准，故前缀是 `tests/frontend/`；判「是不是前端用例」必须用
# is_frontend_test()，不能写 startswith("frontend/")——那样会漏掉全部前端用例，
# 也会把 frontend/e2e/（Playwright，另一套编号）算进来。
# 包外能跑的前提是仓库根有 node_modules（npm workspaces + hoisted），2026-11-04 已落地，
# 并在 vitest.config.ts 里把 root 改成仓库根、放开 server.fs.allow。
FRONTEND_TEST_DIRS = (os.path.join(REPO, "tests", "frontend"),)
# 功能编号与业务承诺合并于一份台账；本模块只取 FEATURE 记录（见 load_registry）。
REGISTRY = os.path.join(REPO, "docs/testing", "测试元数据台账.csv")


def is_frontend_test(relpath: str) -> bool:
    """该路径是否为前端 vitest 用例（仓库根基准的相对路径）。"""
    return relpath.replace("\\", "/").startswith("tests/frontend/")


def is_e2e_test(relpath: str) -> bool:
    """该路径是否为 Playwright 规格（另一套编号，别和 vitest 混算）。"""
    return relpath.replace("\\", "/").startswith("tests/e2e/")


def frontend_test_files() -> list[str]:
    """全部前端 vitest 文件的仓库根相对路径（已排序）。

    只扫 `tests/frontend/` 一棵树，**不扫 `frontend/` 整树**：后者会带进 node_modules，
    也会把 `frontend/e2e/*.spec.ts`（Playwright，另一套编号）算成 vitest 用例。
    扫不到任何文件时直接炸——空集合上的校验恒真，静默归零是这套体系最贵的失败模式。
    """
    out: list[str] = []
    for base in FRONTEND_TEST_DIRS:
        if not os.path.isdir(base):
            continue
        for root, _dirs, files in os.walk(base):
            for fn in files:
                if not fn.endswith((".test.ts", ".test.tsx", ".spec.ts", ".spec.tsx")):
                    continue
                full = os.path.join(root, fn)
                out.append(os.path.relpath(full, REPO).replace(os.sep, "/"))
    assert out, f"扫不到任何前端测试文件：{FRONTEND_TEST_DIRS}（用例库会静默归零）"
    return sorted(out)


RUN_REG = os.path.join(BACKEND, "run_regression.py")

MODULES = ["A", "B", "C", "D", "E", "F", "SYS"]

# ---------------------------------------------------------------------------
# 后端测试文件 -> 功能编号（按真实代码盘点；当前文件逐一映射）
# ---------------------------------------------------------------------------
BACKEND_FILE_TO_FUNC: dict[str, str] = {
    "test_account_delete.py": "B04",
    "test_profit_cashflow_basis.py": "E01",
    "test_account_inventory_age.py": "B05",
    "test_account_stock_no.py": "B04",
    "test_accounts_contract.py": "B04",
    "test_api_contract.py": "SYS07",
    "test_attachments_contract.py": "SYS08",
    "test_attachments_service.py": "SYS08",
    "test_audit_contract.py": "SYS05",
    "test_auth_contract.py": "SYS01",
    "test_auth_users.py": "SYS01",
    "test_auth_teams.py": "SYS01",
    "test_backup_scripts.py": "SYS09",
    "test_cancel_inventory_release.py": "B06",
    "test_cancellation_model.py": "B02",
    "test_cashflow_totals.py": "D02",
    "test_core_contract.py": "SYS07",
    "test_deploy_script_contract.py": "SYS09",
    "test_deposit_remaining.py": "D05",
    "test_finance_attributes.py": "D02",
    "test_finance_cashflows_service.py": "D02",
    "test_finance_cashflows_deposits.py": "D02",
    "test_finance_cashflows_guards.py": "D02",
    "test_finance_api.py": "D01",
    "test_finance_deposits.py": "D01",
    "test_finance_rebates_guards.py": "D01",
    "test_finance_reconciliation.py": "D01",
    "test_finance_controls_service.py": "D03",
    "test_finance_rebates_service.py": "D04",
    "test_finance_reconciliation_service.py": "D03",
    "test_finance_reversal_service.py": "D03",
    "test_cashflow_write_concurrency.py": "D03",
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
    "test_installment_payment_concurrency.py": "B08",
    "test_installment_totals.py": "B08",
    "test_installments_contract.py": "B08",
    "test_installments_create.py": "B08",
    "test_installments_lifecycle.py": "B08",
    "test_installments_overdue.py": "B08",
    "test_installments_api_class.py": "B08",
    "test_installments_service.py": "B08",
    "test_installments_service_write_paths.py": "B08",
    "test_installments_service_defensive.py": "B08",
    "test_inventory_stats.py": "B05",
    "test_inventory_offsale_atomic.py": "B06",
    "test_inventory_offsale_concurrency.py": "B06",
    "test_leads_contract.py": "C01",
    "test_list_columns.py": "F03",
    "test_list_custom_columns.py": "F03",
    "test_list_export_csv.py": "E02",
    "test_list_scope_ui_parity.py": "F03",
    "test_m2.py": "B08",
    "test_import_lifecycle.py": "E03",
    "test_m5_policy.py": "F01",
    "test_policy_allocation.py": "F01",
    "test_policy_versioning.py": "F01",
    "test_main_contract.py": "SYS07",
    "test_migration.py": "SYS13",
    "test_money.py": "SYS02",
    "test_notifications_service.py": "A01",
    "test_overview.py": "A01",
    "test_contract_message_visibility.py": "A01",
    "test_overdue_notifications.py": "A01",
    "test_profit_notifications_settings.py": "A01",
    "test_numbering.py": "SYS03",
    "test_option_sets_api.py": "F04",
    "test_order_customer_source_fixtures.py": "C03",
    "test_order_duplicate_account.py": "B04",
    "test_order_event_cancellable_amount.py": "B03",
    "test_order_execution_edit.py": "B01",
    "test_order_form_fields.py": "F02",
    "test_order_form_fields_router.py": "F02",
    "test_order_form_fields_guards.py": "F02",
    "test_order_status_contract.py": "B02",
    "test_order_types_api.py": "F05",
    "test_orders.py": "B01",
    "test_orders_common.py": "B01",
    "test_orders_flows.py": "B01",
    "test_orders_events.py": "B01",
    "test_orders_roles.py": "B01",
    "test_orders_contract.py": "B01",
    "test_orders_create_validation.py": "B01",
    "test_orders_query_contract.py": "B01",
    "test_orders_account_effects.py": "B01",
    "test_orders_api.py": "B01",
    "test_orders_events_service.py": "B03",
    "test_orders_guard.py": "B02",
    "test_orders_router_guard.py": "B02",
    "test_parties.py": "C01",
    "test_parties_contract.py": "C01",
    "test_parties_customer_lifecycle.py": "C01",
    "test_parties_counterparty_api.py": "C01",
    "test_parties_fields_service.py": "C01",
    "test_parties_masking.py": "C02",
    "test_parties_policy_guard.py": "C01",
    "test_policy_contract.py": "F01",
    "test_policy_rule_consumption.py": "F01",
    "test_pool_balances_batch.py": "D01",
    "test_pools_api.py": "D01",
    "test_product_account_fields.py": "F04",
    "test_profit_allocation_modes.py": "B10",
    "test_public_release_security.py": "SYS01",
    "test_ratelimit.py": "SYS01",
    "test_rebate_current_contract.py": "D04",
    "test_rebate_rules_contract.py": "D04",
    "test_report_export_columns.py": "E02",
    "test_xlsx_sheet_capacity.py": "E02",
    "test_reporting_contract.py": "E01",
    "test_reporting_r_consistency.py": "E01",
    "test_reporting_service.py": "E01",
    "test_request_schema_contract.py": "SYS07",
    "test_settings.py": "SYS06",
    "test_state_machine.py": "SYS04",
    "test_stock_intake_contract.py": "B04",
    "test_studio_cashflow_summary.py": "D05",
    # 金额与财务口径功能测试归属（首字母须与所在区域目录一致）。
    "test_order_financial_date_shift.py": "B03",          # business — 冲销与成交日期联动
    "test_funds_direction_and_deposit.py": "D05",         # finance — 收支方向与押金报表
    "test_profit_r2_accounting.py": "E01",                # reporting — 订单利润与 R2 归类
    "test_data_center_summary.py": "E01",                 # reporting — 数据中心汇总
    "test_inventory_ledger_export.py": "B05",             # business — 库存台账导出
    "test_finance_boundaries.py": "D02",                  # finance — 资金业务边界
    "test_order_detail_labels.py": "B03",                # business — 订单详情派生标签
    "test_operation_operators.py": "B08",                # business — 分期操作人快照
}

# ---------------------------------------------------------------------------
# E2E 规格文件 -> 功能编号
#
# 为什么单列一张表而不复用 `frontend_func_for()`：那张表按**源码路径片段**归类
# （`/orders/` -> B01），而 e2e/ 下的文件名表达的是**验证意图**（`visual.spec.ts`
# 验界面几何、`auth-login.spec.ts` 验认证），两者维度不同，硬塞会全部落到兜底
# SYS12「测试用例库与执行记录」，让报告里的 E2E 分布失去意义。
#
# 归类口径（与《测试规范》一致：按「被测功能」而非「用了什么手段」）：
    #   - 外壳/界面契约类（冒烟、导航叶子、降级不白屏、弹窗对齐、视觉基线、真实接口渲染）
#     统一落 SYS07 —— 这些验证的是前端与 API 的对外契约，不绑定某个业务模块。
#   - 业务写路径按主业务功能归：建单->B01、售出->B06、资金流水->D02。
#   - 认证/角色按 SYS01。
# 未登记的文件落 SYS12，并在生成期可见（不会静默串号）。
# ---------------------------------------------------------------------------
E2E_FILE_TO_FUNC: dict[str, str] = {
    "auth-login.spec.ts": "SYS01",            # 真后端账号密码登录、JWT、越权 401
    "role-switch.spec.ts": "SYS01",           # DEV 态角色切换与导航权限门
    "business-write.spec.ts": "B01",          # 五类业务写入主路径（跨模块，见下）
    "upgrade-integration.spec.ts": "B06",     # 页面售出/退款/分润比例
    "finance-write-ui.spec.ts": "D02",        # 资金流水/划转/返点/分期 UI 写路径
    "inventory-rebate-nest.spec.ts": "D02",   # 返点弹窗内层编辑弹窗（Modal 嵌套 / Esc 路由）
    "other-integration.spec.ts": "D02",       # 划转派生流水、对账核销
    "crud.spec.ts": "SYS07",                  # 真实后端 CRUD 闭环
    "integration.spec.ts": "SYS07",           # 真实接口 -> 页面渲染
    "smoke.spec.ts": "SYS07",                 # 外壳挂载与一级导航可达
    "navigation-leaves.spec.ts": "SYS07",     # 二级 Tab 叶子逐个走查
    "fallback.spec.ts": "SYS07",              # 后端不可达时外壳降级不白屏
    "modal-footer.spec.ts": "SYS07",          # 业务弹窗按钮几何对齐
    "visual.spec.ts": "SYS07",                # 响应式/可视区域/弹窗缩放基线
}

# E2E 的跨模块文件：一个 spec 覆盖多个业务模块时登记，仅影响「关联模块」列。
E2E_CROSS_MODULE: dict[str, set[str]] = {
    # 五类业务写入 + 资金闭环 + 需求池 + 通知 + 报表导出 + 审计 + 数据范围
    "business-write.spec.ts": {"B", "C", "D", "E", "SYS"},
    "finance-write-ui.spec.ts": {"B", "D"},   # 分期收款同时动订单与资金
    "upgrade-integration.spec.ts": {"B", "D"},
    "inventory-rebate-nest.spec.ts": {"B", "D"},  # 库存页上的返点登记
}


# ---------------------------------------------------------------------------
# 跨模块流程文件：显式登记其跨模块归属（可多模块）
# FLOW-001 客户↔订单(C→B)、FLOW-002 订单↔资金(B→D)、FLOW-003 订单↔经营(B→E)、
# FLOW-004 资金↔经营(D→E)、FLOW-005 配置↔业务(F→B)、FLOW-006 认证↔全模块(SYS→A-F)
# 这些文件本身仍是 IT 类型，仅额外标记「跨模块」。
# ---------------------------------------------------------------------------
CROSS_MODULE_FILES: dict[str, set[str]] = {
    "test_flow_sale.py": {"B", "D"},            # 售出：订单状态 + 资金账户余额同源
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


# 前端测试文件 -> 功能编号（当前文件逐一登记，与后端 BACKEND_FILE_TO_FUNC 同构）。
# 只登记**文件名**：搬目录、拆区域都不影响编号，这正是历史 1091 条前端用例零漂移的前提。
FRONTEND_FILE_TO_FUNC: dict[str, str] = {
    "WorkbenchPage.deep.test.tsx":         "A01",
    "WorkbenchPage.test.tsx":              "A01",
    "QuickAccess.test.tsx":                 "A01",
    "Notifications.test.tsx":          "A01",
    "CreateBusinessModal.deep.test.tsx":   "B01",
    "CreateBusinessModal.test.tsx":        "B01",
    "DeliveryInfoSection.test.tsx":        "B01",
    "OrdersPage.actions.test.tsx":         "B01",
    "OrdersPage.test.tsx":                 "B01",
    "helpers.test.ts":                     "B01",
    "businessReminderConfig.test.ts":      "B02",
    "InventoryPanel-helpers.test.ts":      "B04",
    "InventoryPanel.deep.test.tsx":        "B04",
    "InventoryPanel.sale.test.tsx":        "B04",
    "InventoryPanel.write.test.tsx":       "B04",
    "InventoryProfileModal.deep.test.tsx": "B04",
    "OrderDetail.test.tsx":                "B04",
    "StocksApiRoutes.test.ts":             "B04",
    "inventory-logic.test.ts":             "B05",
    "RecoveryFeeSection.test.tsx":         "B06",
    "findCancelable.test.ts":              "B06",
    "sale-plan.test.ts":                   "B06",
    "ThFeeSection.test.tsx":               "B07",
    "consignment-logic.test.ts":           "B07",
    "InstallmentsPanel.test.tsx":          "B08",
    "ConfigurableField.test.tsx":          "B09",
    "formSections.test.tsx":               "B09",
    "CustomerLeadPanel.test.tsx":          "C01",
    "CustomersPage.test.tsx":              "C01",
    "CustomersPage.write.test.tsx":        "C01",
    "FundsPage.deep.test.tsx":             "D01",
    "FundsPage.test.tsx":                  "D01",
    "PoolsPanel.deep.test.tsx":            "D01",
    "RebatesPanel.deep.test.tsx":          "D04",
    "RebatesPanel.test.tsx":               "D04",
    "StudioExpensePanel.test.tsx":         "D05",
    "DataCenterPanel.test.tsx":            "E01",
    "ReportsPage.deep.test.tsx":           "E01",
    "ReportsPage.details.test.tsx":        "E01",
    "ReportsPage.test.tsx":                "E01",
    "ConfigCenterPanel.test.tsx":          "F01",
    "PolicySettingsPanel.test.tsx":        "F01",
    "SettingsPage.deep.test.tsx":          "F01",
    "SettingsPage.test.tsx":               "F01",
    "panels.config.test.tsx":              "F01",
    "panels.routes.test.tsx":              "F01",
    "panels.settings.test.tsx":            "F01",
    "policyConfigSchema.test.ts":          "F01",
    "OrderFormFieldsPanel.test.tsx":       "F02",
    "formScopes.test.ts":                  "F02",
    "ListColumnsPanel.test.tsx":           "F03",
    "listColumns.test.ts":                 "F03",
    "retiredProducts.test.ts":             "F04",
    "OrderTypesPanel.deep.test.tsx":       "F05",
    "OrderTypesPanel.test.tsx":            "F05",
    "antdTheme.test.ts":                   "F05",
    "ChangePasswordPage.test.tsx":         "SYS01",
    "LoginPage.test.tsx":                  "SYS01",
    "TeamsPanel.test.tsx":                 "SYS01",
    "UserCenterPage.test.tsx":             "SYS01",
    "UsersPanel.deep.test.tsx":            "SYS01",
    "UsersPanel.test.tsx":                 "SYS01",
    "session.test.tsx":                    "SYS01",
    "format.test.ts":                      "SYS02",
    "money.test.ts":                       "SYS02",
    "AuditPanel.deep.test.tsx":            "SYS05",
    "AuditPanel.test.tsx":                 "SYS05",
    "AppShell.deep.test.tsx":              "SYS07",
    "AppShell.test.tsx":                   "SYS07",
    "AppShell.user-center.test.tsx":       "SYS07",
    "AppearancePanel.test.tsx":            "F01",
    "BusinessActionModal.test.tsx":        "SYS07",
    "BusinessRegistrationModal.test.tsx":  "SYS07",
    "ErrorBoundary.test.tsx":              "SYS07",
    "ResizableModal.test.tsx":             "SYS07",
    "catalog.orders.test.ts":              "SYS07",
    "catalog.test.ts":                     "SYS07",
    "client.cache.test.ts":                "SYS07",
    "client.test.ts":                      "SYS07",
    "ui.atoms.test.tsx":                   "SYS07",
    "ui.containers.test.tsx":              "SYS07",
    "fixtures.test.ts":                    "SYS10",
    "vite.config.test.ts":                 "SYS10",
    "P0P1Round20261101.test.tsx":          "SYS11",
    "manifest-parity.test.ts":             "SYS12",
    "mock-specifier.test.ts":              "SYS12",
}


def frontend_func_for(relpath: str) -> str:
    """前端 vitest 文件 -> 功能编号。

    按**文件名**查表，不按路径片段：2026-11-04 测试全部迁入
    ``tests/frontend/<unit|module>/<区域>/`` 后，路径里不再有 ``/orders/`` ``/stocks/``
    这类源码域片段，原来的路径匹配会整批落进兜底 SYS12，导致用例编号全线漂移
    （编号键 = 层级|功能编号|文件名|函数名，功能编号一变就是新用例）。
    文件名搬家不变，故按文件名查表是唯一稳定的锚点。未登记文件落 SYS12 并在此可见。
    """
    base = os.path.basename(relpath.replace("\\", "/"))
    return FRONTEND_FILE_TO_FUNC.get(base, "SYS12")


def load_registry() -> dict[str, dict]:
    """读取合并台账中的 FEATURE 记录，返回 {功能编号: {module, name, old}}。

    台账按「记录类型」分 FEATURE / PROMISE 两类共用一张稀疏表；PROMISE 行的
    功能编号为空，必须跳过，否则会写入空 key 并污染 FUNC_TO_MODULE。
    """
    reg: dict[str, dict] = {}
    with open(REGISTRY, encoding="utf-8-sig", newline="") as f:
        for row in csv.DictReader(f):
            code = (row.get("功能编号") or "").strip()
            if not code:
                continue
            reg[code] = {
                "module": (row.get("模块") or "").strip(),
                "name": (row.get("功能名称") or "").strip(),
                "old": (row.get("关联旧编号(BIZ)") or "").strip(),
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
    base = os.path.basename(fname)  # 入参可能是 unit/B/test_x.py，字典键是文件名
    func = BACKEND_FILE_TO_FUNC.get(base, "SYS12")
    primary = module_of_func(func)
    related = {primary}
    if base in CROSS_MODULE_FILES:
        related |= CROSS_MODULE_FILES[base]
    return primary, related


def frontend_file_modules(relpath: str) -> tuple[str, set[str]]:
    func = frontend_func_for(relpath)
    primary = module_of_func(func)
    return primary, {primary}


def e2e_func_for(fname: str) -> str:
    """E2E 规格文件名 -> 功能编号（未登记落 SYS12，生成期可见）。"""
    return E2E_FILE_TO_FUNC.get(fname, "SYS12")


def e2e_file_modules(fname: str) -> tuple[str, set[str]]:
    """E2E 规格文件 -> (主模块, 关联模块集合)。"""
    func = e2e_func_for(fname)
    primary = module_of_func(func)
    related = {primary} | E2E_CROSS_MODULE.get(fname, set())
    return primary, related


# ---------------------------------------------------------------------------
# run_regression.py 的 unit 组（决定 UT 类型）
# ---------------------------------------------------------------------------
def _group_files(group_name: str) -> set[str]:
    text = open(RUN_REG, encoding="utf-8").read()
    m = re.search(r'"%s":\s*\[(.*?)\]' % re.escape(group_name), text, re.S)
    if not m:
        return set()
    prefix = "tests/backend/"
    # 只认真正的路径：旧实现把正则匹配到的任意字符串都当条目，而 GROUPS 上方有一条
    # 注释写着 `-m "not db"`（带引号），于是 `ut` 维度会拼出 `tests/backend/not db` 去跑。
    # 返回「相对 tests/backend 的路径」，与 all_backend_test_files() 同一形态。
    return {x[len(prefix):] for x in re.findall(r'"([^"]+)"', m.group(1)) if x.startswith(prefix)}


UNIT_FILES = _group_files("unit")


def test_type_of_backend_file(fname: str) -> str:
    """文件落在 unit/ 还是 integration/ 目录即为类型；不再靠 GROUPS 里的手工分组反推。

    目录是类型的事实源：GROUPS 的 "unit" 组只收 19 个纯逻辑文件，而 unit/ 目录收
    32 个（含「多数派是快用例、但仍带少量 db 用例」的混层文件）。用 GROUPS 反推
    会让类型判定与实际分层不一致。
    """
    rel = fname.replace("\\", "/")
    if rel.startswith("integration/"):
        return "IT"
    if rel.startswith("unit/"):
        return "UT"
    base = os.path.basename(rel)  # 未分层时的兜底
    return "UT" if base in {os.path.basename(u) for u in UNIT_FILES} else "IT"


# ---------------------------------------------------------------------------
# 筛选接口（供 run_regression.py 调用）
# ---------------------------------------------------------------------------
def all_backend_test_files() -> list[str]:
    """全部后端测试文件，返回**相对 tests/backend 的路径**（如 unit/B/test_orders.py）。

    旧实现指向 ``backend/tests/v1``——那个目录早已删除。后果不是报错，而是
    ``run_regression.py B`` 打印「无匹配后端测试文件」然后 exit 0，业务域维度
    静默失效了很久。递归扫盘 + 非空断言，是这条路径唯一的防线。
    """
    root = os.path.join(REPO, "tests", "backend")
    out: list[str] = []
    for dirpath, _dirs, files in os.walk(root):
        for fn in files:
            if fn.startswith("test_") and fn.endswith(".py"):
                rel = os.path.relpath(os.path.join(dirpath, fn), root).replace(os.sep, "/")
                out.append(rel)
    assert out, f"扫不到任何后端测试文件：{root}"
    return sorted(out)


def module_files(module: str) -> list[str]:
    """某模块的全部后端测试文件（UT + IT；含跨模块归属命中的文件）。"""
    out = []
    for f in all_backend_test_files():
        primary, related = backend_file_modules(f)
        if module in related:
            out.append(f)
    return sorted(out)


def cross_files() -> list[str]:
    """返回 cross 文件的**相对 tests/backend 的路径**（如 integration/business/test_flow_sale.py）。

    CROSS_MODULE_FILES 的键仍是裸文件名（供 backend_file_modules 按 basename 匹配）；
    但 run_regression.py 会把这些返回值拼成 ``tests/backend/<path>``，因此这里必须给出
    真实相对路径——此前返回裸文件名导致整组 pytest 因 ``tests/backend/test_flow_*.py``
    不存在而 exit 1（CI backend-gate 的 cross 分组长期静默失效）。"""
    root = os.path.join(REPO, "tests", "backend")
    resolved: list[str] = []
    for base in sorted(CROSS_MODULE_FILES):
        for dirpath, _dirs, files in os.walk(root):
            if base in files:
                resolved.append(
                    os.path.relpath(os.path.join(dirpath, base), root).replace(os.sep, "/")
                )
    return sorted(resolved)


def type_files(ttype: str) -> list[str]:
    """ttype=ut -> unit 组；it -> 非 unit 后端；e2e -> 当前无常住 E2E（返回空）"""
    files = all_backend_test_files()
    if ttype == "ut":
        return sorted(f for f in files if f.startswith("unit/"))
    if ttype == "it":
        return sorted(f for f in files if f.startswith("integration/"))
    return []  # e2e 预留


def module_type_files(module: str, ttype: str) -> list[str]:
    return sorted(set(module_files(module)) & set(type_files(ttype)))


def frontend_module_files(module: str) -> list[str]:
    """某模块的前端测试文件（相对仓库根的 frontend/src/… 或 tests/frontend/…）。"""
    out = []
    for rel in frontend_test_files():
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
