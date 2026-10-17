"""按业务域执行后端分组回归，避免日常开发默认跑全量套件。"""
from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
PYTHON = ROOT / ".venv" / "bin" / "python"

GROUPS = {
    "p0": [
        "tests/v1/test_order_types_api.py",
        "tests/v1/test_orders_contract.py",
        "tests/v1/test_orders.py",
        "tests/v1/test_installments_contract.py",
        "tests/v1/test_reporting_contract.py",
        "tests/v1/test_m2.py",
        "tests/v1/test_m4.py",
    ],
    "finance": [
        "tests/v1/test_finance_contract.py",
        "tests/v1/test_finance_attributes.py",
        "tests/v1/test_finance_cashflows_service.py",
        "tests/v1/test_finance_controls_service.py",
        "tests/v1/test_finance_rebates_service.py",
        "tests/v1/test_period_lock_contract.py",
        "tests/v1/test_pool_accounts_contract.py",
        "tests/v1/test_rebate_rules_contract.py",
    ],
    "governance": [
        "tests/v1/test_quality_contract.py",
        "tests/v1/test_notifications_contract.py",
        "tests/v1/test_search_contract.py",
        "tests/v1/test_attachments_contract.py",
        "tests/v1/test_audit_contract.py",
    ],
}


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
    for path in paths:
        if path.startswith("frontend/"):
            continue
        if path.startswith("backend/app/finance/") or "finance" in path or "pool_account" in path:
            selected.add("finance")
        if any(token in path for token in ("orders", "installments", "reporting", "foundation", "accounts")):
            selected.add("p0")
        if any(token in path for token in ("quality", "notifications", "search", "attachments", "audit")):
            selected.add("governance")
        if path.startswith("backend/tests/") and not selected:
            selected.update(GROUPS)
    return [name for name in GROUPS if name in selected]


def main() -> int:
    parser = argparse.ArgumentParser(description="执行按业务域拆分的后端回归")
    parser.add_argument("group", choices=[*GROUPS, "changed", "all"], help="回归分组")
    parser.add_argument("--list", action="store_true", help="仅展示将执行的测试文件")
    args = parser.parse_args()
    if args.group == "changed":
        paths_changed = changed_paths()
        selected = groups_for_changes(paths_changed)
        frontend_changed = any(path.startswith("frontend/") for path in paths_changed)
        if not selected and not frontend_changed:
            print("未发现需要回归的前后端业务代码变更")
            return 0
        print(f"按变更自动选择分组：{', '.join(selected)}")
        paths = [path for name in selected for path in GROUPS[name]]
        if frontend_changed:
            print("按变更自动选择前端关键 E2E")
        if args.list:
            if frontend_changed:
                print("frontend: npm run test:regression:fast")
            print("\n".join(paths))
            return 0
        if selected:
            runner = str(PYTHON) if PYTHON.exists() else sys.executable
            result = subprocess.run([runner, "-m", "pytest", "-q", *paths], cwd=ROOT, check=False)
            if result.returncode:
                return result.returncode
        if frontend_changed:
            return subprocess.run(["npm", "run", "test:regression:fast"], cwd=ROOT.parent / "frontend", check=False).returncode
        return 0
    else:
        paths = [path for group in GROUPS.values() for path in group] if args.group == "all" else GROUPS[args.group]
    if args.list:
        print("\n".join(paths))
        return 0
    runner = str(PYTHON) if PYTHON.exists() else sys.executable
    command = [runner, "-m", "pytest", "-q", *paths]
    return subprocess.run(command, cwd=ROOT, check=False).returncode


if __name__ == "__main__":
    raise SystemExit(main())
