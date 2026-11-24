#!/usr/bin/env python3
"""Select browser specs for changed sources and specs, or all for shared inputs."""
from __future__ import annotations

import os
from pathlib import Path, PurePosixPath

ROOT = Path(__file__).resolve().parents[2]
SHARED = {
    "frontend/playwright.config.ts",
    "scripts/ops/test-e2e.sh",
    "scripts/ops/e2e_test_scope.py",
    "backend/scripts/e2e_backend.sh",
    "backend/scripts/e2e_db.py",
    "backend/scripts/ephemeral_test_db.py",
    "backend/requirements.lock.txt",
    "backend/requirements-dev.lock.txt",
    "package.json",
    "package-lock.json",
    "frontend/package.json",
    "frontend/index.html",
    "frontend/vite.config.ts",
    "frontend/src/main.tsx",
    "backend/app/api.py",
    "backend/app/main.py",
}

# 这些入口被多个业务页面共用；无法仅凭路径确定受影响的浏览器流程。
SHARED_PREFIXES = (
    "patches/",
    "frontend/src/app/",
    "frontend/src/shared/",
    "backend/app/core/",
    "backend/app/domain/",
    "backend/app/shared/",
)

# 从关键业务源码选择现有的真实前后端联动规格。
ORDER_SPECS = ("tests/e2e/cross/business-write.spec.ts", "tests/e2e/cross/orders-lifecycle.spec.ts")
FINANCE_SPECS = ("tests/e2e/cross/finance-write-ui.spec.ts", "tests/e2e/finance/other-integration.spec.ts")
AUTH_SPECS = ("tests/e2e/system/auth-login.spec.ts", "tests/e2e/system/role-switch.spec.ts")
SOURCE_PREFIXES = (
    ("frontend/src/business/orders/", ORDER_SPECS),
    ("frontend/src/business/shared/operations/", ORDER_SPECS),
    ("frontend/src/business/shared/order-create/", ORDER_SPECS),
    ("frontend/src/business/shared/order_detail/", ORDER_SPECS),
    ("backend/app/business/orders/", ORDER_SPECS),
    ("backend/app/business/shared/operations/", ORDER_SPECS),
    ("frontend/src/finance/", FINANCE_SPECS),
    ("backend/app/finance/", FINANCE_SPECS),
    ("frontend/src/settings/auth/", AUTH_SPECS),
    ("backend/app/settings/auth/", AUTH_SPECS),
    ("backend/app/settings/users/", AUTH_SPECS),
)
SOURCE_FILES = {"frontend/src/business/OrdersPage.tsx": ORDER_SPECS}


def select(paths: list[str], full: bool) -> tuple[str, list[str]]:
    if full:
        return "all", []
    selected: list[str] = []
    for path in paths:
        parts = PurePosixPath(path).parts
        if not path or path.startswith("/") or ".." in parts or any(ch in path for ch in "\r\n\x00"):
            return "all", []
        if path in SHARED or path.startswith(SHARED_PREFIXES):
            return "all", []
        if path.startswith("tests/e2e/"):
            if not path.endswith(".spec.ts"):
                return "all", []
            specs = (path,)
        else:
            specs = SOURCE_FILES.get(path) or next(
                (specs for prefix, specs in SOURCE_PREFIXES if path.startswith(prefix)), ()
            )
        for spec in specs:
            if not (ROOT / spec).is_file():
                return "all", []
            if spec not in selected:
                selected.append(spec)
    return ("selected", selected) if selected else ("none", [])


def main() -> None:
    raw = os.environ.get("E2E_CHANGED_PATHS", "")
    mode, paths = select(raw.split(",") if raw else [], os.environ.get("E2E_FULL_SUITE", "false").lower() != "false")
    print(f"e2e_mode={mode}")
    print(f"e2e_paths={','.join(paths)}")


if __name__ == "__main__":
    main()
