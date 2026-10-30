"""coverage gate 的基线读取契约。"""
from __future__ import annotations

import json

import pytest

import run_coverage_gate


def test_load_gates_reads_all_business_domains():
    gates = run_coverage_gate.load_gates()

    assert gates == {
        "app/foundation": 2,
        "app/core": 4,
        "app/reporting": 22,
        "app/finance": 43,
    }


def test_load_gates_rejects_incomplete_baseline(tmp_path, monkeypatch):
    baseline = tmp_path / "coverage_baseline.json"
    baseline.write_text(json.dumps({"packages": {}}), encoding="utf-8")
    monkeypatch.setattr(run_coverage_gate, "BASELINE_JSON", baseline)

    with pytest.raises(RuntimeError, match="app/foundation.max_missing"):
        run_coverage_gate.load_gates()
