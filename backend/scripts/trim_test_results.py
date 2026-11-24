#!/usr/bin/env python3
"""测试执行历史裁剪器（docs/testing/测试结果库/results.jsonl）。

为什么需要它
------------
`results.jsonl` 是**追加式**执行历史：每次 pytest 结束按 run_id 追加一批行，历史不覆盖。
好处是可追责，坏处是只增不减——开发期每跑一次单文件、单域，也会留下一个 run。
2026-11-04 实测：14.6 MB / 39732 行 / 102 个 run，两天涨到这个量级，其中 22 个全量 run
占了 13 MB。再往下涨，`make_test_report.py` 每次都要全量解析，报告生成变慢。

裁剪判据（不是"删旧的"，是"留有用的"）
------------------------------------
历史的用处只有两个：① 报告取"每条用例最近一次记录"；② 看趋势（某天全量是否退步）。
故保留集由三条规则并集而成，**核心是第一条**：

1. **覆盖保持**：从新到旧扫描 run，只要它含有「尚未被更新 run 覆盖的用例」就保留。
   这保证裁剪后每条用例的最近一次记录都还在，报告的通过/失败状态不变。
   （`case_no` 为空的老记录按 `nodeid` 计，因为编号是后补的。）
2. **最近 N 个 run**（默认 10）：纯粹为看趋势，哪怕对覆盖没有贡献。
3. **每个通道最后一个 run**：后端 / `-fe`（前端 vitest）/ `-e2e`。三条通道共用一个文件，
   但前端与 E2E 的 run 很稀疏（实测两天各 4 次），只按"最近 N 个"裁会把它们整体清空，
   报告立刻出现上千条"未执行"。这是 2026-11-04 第一次裁剪时踩到的坑。

中间那些单文件调试 run 除了占地方没有信息量，归档即可。

安全边界
--------
1. **先归档再替换**：被移除的行按原顺序 `gzip` 到 `docs/archive/test-results/local/`，压缩成功才动原文件。遇同名归档时停止。
2. **原子替换**：写 `results.jsonl.tmp` 后 `os.replace`，中途崩溃不会留下半截文件。
3. **逐行校验**：保留集行数与预算一致、每行都能 `json.loads`、行序与原文一致，任一不符即 abort。
4. 任何异常都不改动原文件。

用法
----
    python3 backend/scripts/trim_test_results.py --dry-run   # 只看计划，不动文件
    python3 backend/scripts/trim_test_results.py            # 默认：最近 25 个 run + 每日首末全量
    python3 backend/scripts/trim_test_results.py --keep-runs 40

不传 `--results` 时用仓库默认路径；脚本可被 pre-commit / 人工随时调用，幂等（已裁剪过则无操作）。
"""

from __future__ import annotations

import argparse
import gzip
import json
import os
import sys
from datetime import datetime
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
DEFAULT_RESULTS = REPO / "docs" / "testing" / "测试结果库" / "results.jsonl"
DEFAULT_ARCHIVE_DIR = REPO / "docs" / "archive" / "test-results" / "local"


def iter_records(path: Path):
    """按文件顺序产出 (行序号, 原始行, 解析后的 dict)；空行跳过。解析失败直接抛错。"""
    with path.open(encoding="utf-8") as fh:
        for lineno, raw in enumerate(fh):
            if not raw.strip():
                continue
            yield lineno, raw, json.loads(raw)


def _case_key(rec: dict) -> str:
    """记录归属键：优先用例编号（写记录时已解析），缺失时退回 nodeid。

    编号是 `case_index.json` 后补的，早期记录的 case_no 可能为空，只按编号比会漏掉这些用例。
    """
    return rec.get("case_no") or rec.get("nodeid") or ""


def _channel(run_id: str) -> str:
    """run_id 尾段即通道：后端写进程 pid，前端写 `fe`，E2E 写 `e2e`。"""
    tail = run_id.rsplit("-", 1)[-1] if run_id else ""
    return tail if tail in ("fe", "e2e") else "be"


def plan_keep(records, keep_recent: int) -> tuple[set[str], list[str], dict]:
    """返回 (保留 run 集合, 按出现顺序的 run 列表, 诊断信息)。"""
    order: list[str] = []
    counts: dict[str, int] = {}
    keys_of: dict[str, set[str]] = {}
    for _, _, rec in records:
        run_id = rec.get("run_id") or ""
        if run_id not in counts:
            counts[run_id] = 0
            keys_of[run_id] = set()
            order.append(run_id)
        counts[run_id] += 1
        keys_of[run_id].add(_case_key(rec))

    keep: set[str] = set()

    # 规则 1：覆盖保持（从新到旧，能带来新用例的 run 才留）
    covered: set[str] = set()
    for run_id in reversed(order):
        if keys_of[run_id] - covered:
            keep.add(run_id)
            covered |= keys_of[run_id]

    # 规则 2：最近 N 个（趋势用）
    if keep_recent > 0:
        keep |= set(order[-keep_recent:])

    # 规则 3：每个通道最后一个 run
    latest_by_channel: dict[str, str] = {}
    for run_id in order:
        latest_by_channel[_channel(run_id)] = run_id
    keep |= set(latest_by_channel.values())

    diag = {
        "channels": {c: counts[r] for c, r in latest_by_channel.items()},
        "covered_keys": len(covered),
        "all_keys": len(set().union(*keys_of.values())) if keys_of else 0,
    }
    return keep, order, diag


def trim(path: Path, archive_dir: Path, keep_recent: int, dry_run: bool) -> dict:
    if not path.exists():
        raise SystemExit(f"[trim] 结果文件不存在：{path}")

    before_bytes = path.stat().st_size
    records = list(iter_records(path))
    if not records:
        raise SystemExit(f"[trim] 结果文件为空：{path}")

    keep, order, diag = plan_keep(records, keep_recent)
    kept_lines: list[str] = []
    dropped_lines: list[str] = []
    kept_runs: list[str] = []
    dropped_runs: set[str] = set()
    for _, raw, rec in records:
        run_id = rec.get("run_id") or ""
        if run_id in keep:
            kept_lines.append(raw if raw.endswith("\n") else raw + "\n")
            if run_id not in kept_runs:
                kept_runs.append(run_id)
        else:
            dropped_lines.append(raw if raw.endswith("\n") else raw + "\n")
            dropped_runs.add(run_id)

    summary = {
        "runs_before": len(order),
        "runs_after": len(kept_runs),
        "lines_before": len(records),
        "lines_after": len(kept_lines),
        "bytes_before": before_bytes,
        "bytes_after_est": sum(len(x.encode()) for x in kept_lines),
        "dropped_runs": [r for r in order if r in dropped_runs],
        "archive": None,
        "diag": diag,
    }

    if not dropped_lines:
        summary["note"] = "无需裁剪（保留集已覆盖全部记录）"
        return summary

    # 断言：保留 + 移除 = 原始行数，且保留集内 run 都属于 keep
    if len(kept_lines) + len(dropped_lines) != len(records):
        raise SystemExit("[trim] abort：行数守恒校验失败")
    for line in kept_lines:
        json.loads(line)  # 保留集必须逐行可解析

    if dry_run:
        summary["note"] = "dry-run：未改动文件"
        return summary

    archive_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    archive_path = archive_dir / f"执行记录_{stamp}（历史留存）.jsonl.gz"
    try:
        with gzip.open(archive_path, "xt", encoding="utf-8") as fh:
            fh.writelines(dropped_lines)
    except FileExistsError as exc:
        raise SystemExit(f"[trim] 已有同名归档 {archive_path}，保留原执行记录。") from exc
    if not archive_path.exists() or archive_path.stat().st_size == 0:
        raise SystemExit("[trim] abort：归档失败，未改动原文件")

    tmp = path.with_name(path.name + ".tmp")
    with tmp.open("w", encoding="utf-8") as fh:
        fh.writelines(kept_lines)
    # 再校验一次落盘结果，再原子替换
    with tmp.open(encoding="utf-8") as fh:
        realized = sum(1 for line in fh if line.strip())
    if realized != len(kept_lines):
        tmp.unlink(missing_ok=True)
        raise SystemExit(f"[trim] abort：临时文件行数 {realized} != 预期 {len(kept_lines)}")
    os.replace(tmp, path)

    summary["archive"] = str(archive_path.relative_to(REPO) if archive_path.is_relative_to(REPO) else archive_path)
    summary["bytes_after"] = path.stat().st_size
    return summary


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="裁剪 results.jsonl 执行历史（先归档后替换）")
    ap.add_argument("--results", type=Path, default=DEFAULT_RESULTS)
    ap.add_argument("--archive-dir", type=Path, default=DEFAULT_ARCHIVE_DIR)
    ap.add_argument("--keep-runs", type=int, default=10, help="额外保留最近 N 个 run（趋势用，默认 10）")
    ap.add_argument("--dry-run", action="store_true", help="只打印计划，不改动文件")
    args = ap.parse_args(argv)

    s = trim(args.results, args.archive_dir, args.keep_runs, args.dry_run)
    mb = lambda n: f"{n / 1e6:.2f} MB"  # noqa: E731
    print(f"[trim] run 数 {s['runs_before']} -> {s['runs_after']}")
    print(f"[trim] 行数 {s['lines_before']} -> {s['lines_after']}")
    after = s.get("bytes_after", s["bytes_after_est"])
    print(f"[trim] 体积 {mb(s['bytes_before'])} -> {mb(after)}")
    d = s.get("diag") or {}
    if d:
        print(f"[trim] 用例键覆盖 {d['covered_keys']}/{d['all_keys']}，通道 {d['channels']}")
    if s["dropped_runs"]:
        print(f"[trim] 移除 run {len(s['dropped_runs'])} 个")
    if s["archive"]:
        print(f"[trim] 归档 {s['archive']}")
    if s.get("note"):
        print(f"[trim] {s['note']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
