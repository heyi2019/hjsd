#!/usr/bin/env python3
"""PII / 密钥静态扫描守卫。

设计目标
--------
1. **只拦新增**：以 `security/pii_allowlist.txt`（`路径 :: 规则名` 归一化，不含行号，抗漂移）
   作为已接受清单，只有清单外的命中才判红，避免历史数据把门禁永久卡死。
2. **输出脱敏**：任何命中只报「文件 + 行号 + 规则名 + 条数」，**绝不回显原始值**，
   防止 CI 日志/终端再次扩散 PII。
3. **零依赖**：仅用标准库，CI 与本地行为一致。

用法
----
    python scripts/scan_pii.py                  # 门禁模式：仅报清单外命中，有则 exit 1
    python scripts/scan_pii.py --all            # 审计模式：连清单内命中一起报（exit 0）
    python scripts/scan_pii.py --update-allowlist  # 把当前全部命中写入清单（需人工复核 diff）

口径说明
--------
`rawdata/原始数据/*.json` 是 v1 迁移的可复现源数据（`scripts/land_raw_import.py` 直接读取，
文档要求「重新导出覆盖后重跑迁移」），属于既定业务资产，已在清单中显式登记。
`game_password` 明文存储是 owner 既定裁决，不在本扫描器批评范围，故不计入密码类规则。
"""
from __future__ import annotations

import argparse
import re
import subprocess
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[2]
ALLOWLIST = PROJECT_ROOT / "security" / "pii_allowlist.txt"

# 只扫文本类后缀，避免对二进制/大文件做无意义正则
TEXT_SUFFIXES = {
    ".py", ".ts", ".tsx", ".js", ".jsx", ".json", ".md", ".yml", ".yaml",
    ".sh", ".txt", ".sql", ".toml", ".cfg", ".ini", ".html", ".css", ".csv",
}
SKIP_DIR_PARTS = {"node_modules", ".venv", "venv", "dist", "build", "__pycache__", ".git"}
MAX_BYTES = 2 * 1024 * 1024

# 规则名 → 正则。命名会写进清单，改动需同步清单。
RULES: dict[str, re.Pattern[str]] = {
    # 中国大陆手机号：前后不能再接数字，降低长数字串误报
    "phone": re.compile(r"(?<!\d)1[3-9]\d{9}(?!\d)"),
    # 18 位身份证（末位可为 X）
    "id_card": re.compile(r"(?<![0-9A-Za-z])\d{17}[\dXx](?![0-9A-Za-z])"),
    # 16~19 位银行卡号（62 开头）
    "bank_card": re.compile(r"(?<!\d)62\d{14,17}(?!\d)"),
    # 常见云厂商/平台密钥特征
    "secret_key": re.compile(
        r"(sk-[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,})"
    ),
    # 私钥文件头
    "private_key": re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----"),
    # 邮箱（弱 PII，单独归一类便于分档）
    "email": re.compile(r"(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}(?![A-Za-z0-9.-])"),
}


def tracked_files() -> list[Path]:
    """候选文件 = 已跟踪文件 + 未跟踪但未被 .gitignore 排除的新文件。

    必须并入未跟踪文件：`git ls-files` 只列已跟踪项，而"新文件引入 PII"
    恰是最需要拦住的场景（未提交前本地就该发现）。`--exclude-standard`
    会尊重 .gitignore，因此 node_modules/.venv 等不会被拉进来。
    """
    def _list(extra: list[str]) -> list[str]:
        out = subprocess.run(
            ["git", "ls-files", "-z", *extra], cwd=PROJECT_ROOT, capture_output=True, check=True
        ).stdout.decode("utf-8")
        return [rel for rel in out.split("\0") if rel]

    rels = _list([]) + _list(["--others", "--exclude-standard"])
    files = []
    for rel in dict.fromkeys(rels):  # 去重且保序
        p = PROJECT_ROOT / rel
        if not p.is_file():
            continue
        if any(part in SKIP_DIR_PARTS for part in Path(rel).parts):
            continue
        if p.suffix.lower() not in TEXT_SUFFIXES:
            continue
        try:
            if p.stat().st_size > MAX_BYTES:
                continue
        except OSError:
            continue
        files.append(p)
    return files


def find_hits(files: list[Path]) -> list[tuple[str, int, str, int]]:
    """返回 (相对路径, 行号, 规则名, 条数)；不保留原始值，避免二次扩散。"""
    hits: list[tuple[str, int, str, int]] = []
    for p in files:
        rel = p.relative_to(PROJECT_ROOT).as_posix()
        try:
            text = p.read_text(encoding="utf-8", errors="ignore")
        except OSError:
            continue
        for lineno, line in enumerate(text.splitlines(), start=1):
            for rule, pattern in RULES.items():
                n = len(pattern.findall(line))
                if n:
                    hits.append((rel, lineno, rule, n))
    return hits


def load_allowlist() -> set[str]:
    """清单格式：`<相对路径> :: <规则名>`；`#` 开头为注释。"""
    if not ALLOWLIST.exists():
        return set()
    keys = set()
    for raw in ALLOWLIST.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        keys.add(line)
    return keys


def key_of(rel: str, rule: str) -> str:
    return f"{rel} :: {rule}"


def stale_entries(allow: set[str]) -> list[str]:
    """清单里指向已不存在路径的条目——文件被重命名/删除后留下的死条目。

    只提示不阻断：死条目不会掩盖真实命中，但会误导后来者以为"那里还有数据"。
    """
    stale = []
    for key in allow:
        rel = key.split(" :: ", 1)[0]
        if not (PROJECT_ROOT / rel).exists():
            stale.append(key)
    return sorted(stale)


def write_allowlist(hits: list[tuple[str, int, str, int]]) -> int:
    """按「路径 :: 规则」去重写入，保留原注释与既有条目顺序。"""
    existing_lines: list[str] = []
    if ALLOWLIST.exists():
        existing_lines = ALLOWLIST.read_text(encoding="utf-8").splitlines()
    have = {ln.strip() for ln in existing_lines if ln.strip() and not ln.strip().startswith("#")}
    added = 0
    for rel, _lineno, rule, _n in hits:
        k = key_of(rel, rule)
        if k not in have:
            existing_lines.append(k)
            have.add(k)
            added += 1
    ALLOWLIST.parent.mkdir(parents=True, exist_ok=True)
    ALLOWLIST.write_text("\n".join(existing_lines) + "\n", encoding="utf-8")
    return added


def main() -> int:
    ap = argparse.ArgumentParser(description="PII / 密钥静态扫描守卫")
    ap.add_argument("--all", action="store_true", help="审计模式：连清单内命中一起报")
    ap.add_argument(
        "--update-allowlist", action="store_true", help="把当前全部命中登记进清单（需人工复核）"
    )
    args = ap.parse_args()

    files = tracked_files()
    hits = find_hits(files)
    allow = load_allowlist()

    if args.update_allowlist:
        added = write_allowlist(hits)
        print(f"已登记 {added} 条新增白名单条目 → {ALLOWLIST.relative_to(PROJECT_ROOT)}")
        print("请人工复核 diff：只应包含业务上确属必要的数据文件。")
        return 0

    # 同一「路径 :: 规则」的多行命中合并计数，输出稳定
    grouped: dict[tuple[str, str], list[int]] = {}
    for rel, lineno, rule, n in hits:
        grouped.setdefault((rel, rule), []).append(lineno)

    outside = {k: v for k, v in grouped.items() if key_of(*k) not in allow}

    if args.all:
        print(f"审计模式：扫描 {len(files)} 个文本文件，命中 {len(grouped)} 组")
        for (rel, rule), linenos in sorted(grouped.items()):
            mark = "清单内" if key_of(rel, rule) in allow else "清单外"
            print(f"  [{mark}] {rel} :: {rule} → {len(linenos)} 行（首行 {linenos[0]}）")
        return 0

    if outside:
        print(f"PII 扫描失败：清单外命中 {len(outside)} 组（共 {len(files)} 个文件被扫描）")
        for (rel, rule), linenos in sorted(outside.items()):
            print(f"  {rel}:{linenos[0]} :: {rule} → {len(linenos)} 行")
        print(
            "\n处置：确属业务必要数据 → 用 --update-allowlist 登记并在 diff 中说明理由；"
            "\n      误报 → 调整 security/pii_allowlist.txt 或收紧规则；"
            "\n      真泄露 → 移除该文件并评估是否需要清理 git 历史。"
        )
        return 1

    print(
        f"PII 扫描通过：扫描 {len(files)} 个文件，"
        f"清单内 {len(grouped)} 组，无清单外命中"
    )
    stale = stale_entries(allow)
    if stale:
        print(f"提示：白名单有 {len(stale)} 条指向已不存在的路径，建议清理（不阻断）")
        for s in stale:
            print(f"  - {s}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
