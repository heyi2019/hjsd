#!/usr/bin/env python3
"""Select changed browser specs, or all specs when their shared setup changes."""
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
}


def select(paths: list[str], full: bool) -> tuple[str, list[str]]:
    if full:
        return "all", []
    selected: list[str] = []
    for path in paths:
        parts = PurePosixPath(path).parts
        if not path or path.startswith("/") or ".." in parts or any(ch in path for ch in "\r\n\x00"):
            return "all", []
        if path in SHARED:
            return "all", []
        if not path.startswith("tests/e2e/"):
            continue
        if not path.endswith(".spec.ts") or not (ROOT / path).is_file():
            return "all", []
        if path not in selected:
            selected.append(path)
    return ("selected", selected) if selected else ("none", [])


def main() -> None:
    raw = os.environ.get("E2E_CHANGED_PATHS", "")
    mode, paths = select(raw.split(",") if raw else [], os.environ.get("E2E_FULL_SUITE", "false").lower() != "false")
    print(f"e2e_mode={mode}")
    print(f"e2e_paths={','.join(paths)}")


if __name__ == "__main__":
    main()
