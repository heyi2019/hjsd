"""coverage gate 的基线读取契约。"""
from __future__ import annotations

import json

import pytest

import run_coverage_gate


def test_load_gates_reads_all_business_domains():
    """四域上限必须与 coverage_baseline.json 一致。

    这里刻意硬编码具体数字：放宽上限（把 missing 改大）必须同时改这条用例，
    否则「悄悄调低门禁」会一次通过。收紧（数字变小）同样要显式改这里。
    """
    gates = run_coverage_gate.load_gates()

    assert gates == {
        "app/foundation": 1,
        "app/core": 0,
        "app/reporting": 22,
        "app/finance": 41,
    }


def test_load_gates_rejects_incomplete_baseline(tmp_path, monkeypatch):
    baseline = tmp_path / "coverage_baseline.json"
    baseline.write_text(json.dumps({"packages": {}}), encoding="utf-8")
    monkeypatch.setattr(run_coverage_gate, "BASELINE_JSON", baseline)

    with pytest.raises(RuntimeError, match="app/foundation.max_missing"):
        run_coverage_gate.load_gates()
