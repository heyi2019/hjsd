"""按业务域 / 模块 / 测试类型执行后端分组回归，避免日常开发默认跑全量套件。

三种执行维度（详见 docs/testing/模块与跨模块测试集规范.md）：
  - 业务域分组（历史）：orders/finance/parties/foundation/... 保留可用。
  - 模块分组：module A-F/SYS  —— 一个模块的全部后端(UT+IT) + 前端测试。
  - 测试类型：type ut/it/e2e  —— 单元 / 集成 / 端到端。
  - 跨模块：cross            —— FLOW-* 跨模块流程测试（B↔D 等）。
维度可组合：module B --type ut  => 业务中心全部单元测试。
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
sys.path.insert(0, str(ROOT / "scripts"))
from test_catalog import (  # noqa: E402
    MODULES,
    cross_files,
    frontend_module_files,
    module_files,
    module_type_files,
    type_files,
)

# pyflakes 扫描范围：业务代码 + 测试 + 迁移 + 脚本（与历史「pyflakes 干净」口径一致）
LINT_TARGETS = ["app", "tests/v1", "alembic/versions", "scripts", "run_regression.py", "run_coverage_gate.py"]
# 基线只记「文件 + 消息」，不含行列号——行号漂移不应判定为新增告警
LINT_BASELINE = ROOT / "lint_baseline.txt"
LINT_LINE_RE = re.compile(r"^(?P<path>.+?):\d+:\d+: (?P<msg>.+)$")


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
        # 列表列「界面↔注册表」守卫：纯静态读前端源码，无 DB/HTTP，0.04s。
        # 曾长期游离在所有分组之外 —— 前端把报表视图拆成 ./reports/*.tsx 后它指错文件、
        # 7 条 RPT_* 一直红着却没人发现，证明「不在分组里的守卫等于没有守卫」。
        "tests/v1/test_list_scope_ui_parity.py",
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
    parser = argparse.ArgumentParser(
        description="执行按业务域 / 模块 / 测试类型 / 跨模块拆分的后端回归"
    )
    parser.add_argument(
        "group",
        choices=[*GROUPS, "changed", "all", "ci", "lint", "cross", "fe", *MODULES, "ut", "it", "e2e"],
        help="回归分组：业务域名=板块档；A-F/SYS=模块档；ut/it/e2e=类型档；"
             "cross=跨模块流程；ci/all=全量；fe=前端全量(四档)；lint=静态检查；changed=按 git 变更选组",
    )
    parser.add_argument("--type", choices=["ut", "it", "e2e"],
                        help="与模块档组合：仅跑该模块的某类型（如 B --type ut）")
    parser.add_argument("--backend-only", action="store_true",
                        help="模块档只跑后端，不跑前端 vitest")
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
    if args.group == "fe":
        if args.list:
            print("# 前端全量（fast / quick / react / react-deep）")
            return 0
        return run_frontend_full()
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
    fe_paths: list[str] = []
    if args.group == "cross":
        paths = [f"tests/v1/{f}" for f in cross_files()]
        label = "跨模块流程(FLOW-*)"
    elif args.group in MODULES:
        module = args.group
        if args.type:
            paths = [f"tests/v1/{f}" for f in module_type_files(module, args.type)]
            label = f"模块 {module} / 类型 {args.type}"
            if not args.backend_only and args.type in ("it", "e2e"):
                fe_paths = frontend_module_files(module)
        else:
            paths = [f"tests/v1/{f}" for f in module_files(module)]
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
        paths = [f"tests/v1/{f}" for f in type_files(ttype)]
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
        [runner, "-m", "pytest", "-q", *paths],
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
