#!/usr/bin/env python3
"""覆盖率闸门：锁定四域后端行覆盖率，防回归。

按版本化 coverage_baseline.json 保护四个业务域的当前覆盖率：
- 基线记录当前已验证的缺失行数。
- 后续提交只要缺失行数增加，门禁即失败；缺失行数减少时可显式更新基线收紧门禁。
- 基线随代码演进显式更新，避免把旧版本的 100% 目标误当成当前代码事实。

为什么不用 coverage 自带的 fail_under：
fail_under 是全局单阈值，无法表达按业务域保存基线、只拦截回归的规则。
故解析 `coverage json` 按包聚合后逐包与版本化基线比较。

用法：
    python3 run_coverage_gate.py            # 跑全量 tests/v1 + 校验闸门（CI/收口用）
    python3 run_coverage_gate.py --report   # 只打印当前覆盖率，不失败（本地巡检用）

与既有纪律一致：
- 全量基线（纳入全部 touching 测试），避免孤立假缺口（foundation Task #5 教训）。
- 使用当前解释器环境（.venv 内须已装 coverage）。
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path

BACKEND = Path(__file__).resolve().parent
PY = sys.executable  # 与当前解释器同环境（应在 .venv 内）

# 四域闸门阈值：包前缀 -> 允许的最大缺失行数
GATES = {
    "app/foundation": 0,
    "app/core": 0,
    "app/reporting": 0,
    "app/finance": 7,
}

FULL_SUITE = ["tests/v1"]
COV_JSON = BACKEND / "coverage.json"
BASELINE_JSON = BACKEND / "coverage_baseline.json"


def load_gates() -> dict[str, int]:
    """读取版本化覆盖率基线，返回每个业务域允许的最大缺失行数。"""
    if not BASELINE_JSON.exists():
        raise RuntimeError(f"缺少覆盖率基线文件：{BASELINE_JSON}")
    data = json.loads(BASELINE_JSON.read_text(encoding="utf-8"))
    packages = data.get("packages")
    if not isinstance(packages, dict):
        raise RuntimeError("覆盖率基线格式错误：缺少 packages 对象")
    gates: dict[str, int] = {}
    for package in GATES:
        item = packages.get(package)
        if not isinstance(item, dict) or not isinstance(item.get("max_missing"), int):
            raise RuntimeError(f"覆盖率基线格式错误：缺少 {package}.max_missing")
        gates[package] = item["max_missing"]
    return gates


def _run(cmd: list[str]) -> None:
    print("+ " + " ".join(cmd), flush=True)
    # 不注入 DATABASE_URL：测试夹具强制要求 PostgreSQL 且库名必须含 test
    # （见 tests/v1/conftest.py::_test_database_url），注入 SQLite 会让整套测试
    # 在 collect 期直接 exit。库地址由 .env（本地）或 CI 环境变量指定。
    subprocess.run(cmd, cwd=BACKEND, env=os.environ.copy(), check=True)


def collect_coverage() -> Path:
    """跑全量测试并生成 coverage.json，返回 json 路径。"""
    for f in (BACKEND / ".coverage", COV_JSON):
        if f.exists():
            f.unlink()
    _run([PY, "-m", "coverage", "run", "-m", "pytest", *FULL_SUITE, "-q"])
    _run([PY, "-m", "coverage", "json", "-o", str(COV_JSON)])
    return COV_JSON


def aggregate(cov_json: Path) -> dict[str, dict[str, int]]:
    """按包前缀聚合语句数与缺失行数。"""
    data = json.loads(cov_json.read_text(encoding="utf-8"))
    agg: dict[str, dict[str, int]] = {
        pkg: {"statements": 0, "missing": 0} for pkg in GATES
    }
    for path, info in data.get("files", {}).items():
        summary = info.get("summary", {})
        num = summary.get("num_statements", 0)
        miss = summary.get("missing_lines", 0)
        for pkg in GATES:
            if path == pkg or path.startswith(pkg + "/"):
                agg[pkg]["statements"] += num
                agg[pkg]["missing"] += miss
                break
    return agg


def main() -> int:
    ap = argparse.ArgumentParser(description="四域后端覆盖率闸门")
    ap.add_argument(
        "--report",
        action="store_true",
        help="只打印覆盖率，不失败（本地巡检）",
    )
    args = ap.parse_args()

    cov_json = collect_coverage()
    agg = aggregate(cov_json)
    gates = load_gates()

    print("\n覆盖率闸门结果：")
    print(f"{'包':<22}{'语句':>8}{'缺失':>8}{'覆盖':>10}{'上限':>8}  结论")
    all_ok = True
    for pkg, max_missing in gates.items():
        st = agg[pkg]["statements"]
        mi = agg[pkg]["missing"]
        pct = (st - mi) / st * 100 if st else 100.0
        passed = mi <= max_missing
        all_ok = all_ok and passed
        flag = "PASS" if passed else "FAIL"
        print(f"{pkg:<22}{st:>8}{mi:>8}{pct:>9.1f}%{max_missing:>8}  {flag}")

    if args.report:
        return 0
    if not all_ok:
        print(
            "\n❌ 覆盖率闸门未通过：存在域跌破允许缺失上限，请补测试或核查不可达标注。",
            file=sys.stderr,
        )
        return 1
    print("\n✅ 覆盖率闸门通过：四域均未出现相对基线的新增缺失行。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
