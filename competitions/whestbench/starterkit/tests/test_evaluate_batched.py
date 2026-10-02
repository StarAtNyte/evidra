from __future__ import annotations

import json
import hashlib
import subprocess
import sys

import pytest

import evaluate_batched
from evaluate_batched import run_streaming, summarize_report, write_json_atomic


def test_streaming_runner_keeps_json_clean_and_reports_long_work(capsys) -> None:
    code = "import sys,time; print('{\\\"ok\\\":true}', flush=True); time.sleep(.2); print('worker note', file=sys.stderr, flush=True)"
    result = run_streaming([sys.executable, "-c", code], heartbeat_seconds=0.05)
    captured = capsys.readouterr()
    assert result.returncode == 0
    assert json.loads(result.stdout) == {"ok": True}
    assert "worker note" in captured.err
    assert "still running" in captured.err


def test_streaming_runner_times_out_and_terminates_the_child_process() -> None:
    with pytest.raises(TimeoutError, match="wall-clock limit"):
        run_streaming(
            [sys.executable, "-c", "import time; time.sleep(30)"],
            timeout_seconds=0.1,
        )


def test_summary_recomputes_official_multiplier_per_row() -> None:
    report = {
        "whestbench_version": "0.16.1",
        "run_config": {"flop_budget": 1000},
        "results": {
            "per_mlp": [
                {
                    "mlp_index": 0,
                    "mlp_name": "valid",
                    "adjusted_final_layer_score": 0.02,
                    "final_layer_mse": 0.2,
                    "flops_used": 100,
                },
                {
                    "mlp_index": 1,
                    "mlp_name": "failed",
                    "adjusted_final_layer_score": 0.4,
                    "final_layer_mse": 0.4,
                    "flops_used": 50,
                    "error": "worker failed",
                    "time_exhausted": True,
                    "residual_wall_time_s": 0.401,
                },
            ]
        },
    }

    result = summarize_report(report, expected_rows=2)

    assert result["metrics"]["adjusted_final_layer_score"] == pytest.approx(0.21)
    assert result["metrics"]["final_layer_mse"] == pytest.approx(0.3)
    assert result["metrics"]["mean_compute_utilization"] == pytest.approx(0.075)
    assert result["metrics"]["mean_score_multiplier"] == pytest.approx(0.55)
    assert result["n_failed_mlps"] == 1
    assert all(row["score_formula_verified"] for row in result["per_mlp"])
    assert result["per_mlp"][1]["failure_class"] == "estimator_error"
    assert result["per_mlp"][1]["failure_flags"]["time_exhausted"] is True
    assert result["per_mlp"][1]["timing_and_compute_diagnostics"]["residual_wall_time_s"] == 0.401
    assert "time_exhausted" not in result["per_mlp"][1]["timing_and_compute_diagnostics"]


def test_summary_rejects_score_formula_mismatch_and_incomplete_split() -> None:
    report = {
        "run_config": {"flop_budget": 100},
        "results": {
            "per_mlp": [{
                "adjusted_final_layer_score": 0.1,
                "final_layer_mse": 0.5,
                "flops_used": 50,
            }]
        },
    }
    result = summarize_report(report)
    assert result["n_failed_mlps"] == 1
    assert result["per_mlp"][0]["score_formula_verified"] is False
    assert "formula mismatch" in result["per_mlp"][0]["error"]
    timed_out = summarize_report({
        "run_config": {"flop_budget": 100},
        "results": {"per_mlp": [{
            "adjusted_final_layer_score": 0.5,
            "final_layer_mse": 0.5,
            "flops_used": 10,
            "time_exhausted": True,
        }]},
    })
    assert timed_out["per_mlp"][0]["failure_class"] == "time_exhausted"
    assert timed_out["per_mlp"][0]["failure_flags"]["time_exhausted"] is True
    with pytest.raises(ValueError, match="returned 1/2 requested rows"):
        summarize_report(report, expected_rows=2)


def test_atomic_report_persistence_replaces_only_with_complete_json(tmp_path) -> None:
    target = tmp_path / "nested" / "result.json"
    target.parent.mkdir()
    target.write_text("old report", encoding="utf-8")
    write_json_atomic(target, {"complete": True, "rows": [1, 2]})

    assert json.loads(target.read_text(encoding="utf-8")) == {"complete": True, "rows": [1, 2]}
    assert list(target.parent.glob(".*.tmp")) == []


def test_main_invokes_one_persistent_official_runner_for_limited_prefix(tmp_path, monkeypatch, capsys) -> None:
    dataset = tmp_path / "dataset"
    dataset.mkdir()
    (dataset / "metadata.json").write_text(json.dumps({"splits": {"mini": {"n_mlps": 100}}}))
    estimator = tmp_path / "estimator.py"
    estimator.write_text("class Estimator: pass\n", encoding="utf-8")
    output_json = tmp_path / "results" / "verified.json"
    rows = [
        {"mlp_index": index, "adjusted_final_layer_score": 0.01, "final_layer_mse": 0.1, "flops_used": 100}
        for index in range(2)
    ]
    report = {"run_config": {"flop_budget": 1000, "residual_wall_time_limit_s": 1.0}, "results": {"per_mlp": rows}}
    calls = []

    def fake_run(command, **_kwargs):
        calls.append(command)
        return subprocess.CompletedProcess(command, 0, json.dumps(report), "")

    monkeypatch.setattr(sys, "argv", ["evaluate_batched.py", "--dataset", str(dataset), "--estimator", str(estimator), "--limit", "2", "--max-threads", "1", "--residual-wall-time-limit", "1", "--output-json", str(output_json)])
    monkeypatch.setattr(evaluate_batched, "run_streaming", fake_run)

    assert evaluate_batched.main() == 0
    assert len(calls) == 1
    assert calls[0][calls[0].index("--runner") + 1] == "subprocess"
    assert calls[0][calls[0].index("--max-threads") + 1] == "1"
    assert calls[0][calls[0].index("--n-mlps") + 1] == "2"
    assert calls[0][calls[0].index("--residual-wall-time-limit") + 1] == "1.0"
    printed = json.loads(capsys.readouterr().out)
    persisted = json.loads(output_json.read_text(encoding="utf-8"))
    assert printed["n_mlps"] == 2
    assert persisted == printed
    assert persisted["provenance"]["estimator_sha256"] == hashlib.sha256(estimator.read_bytes()).hexdigest()
    assert persisted["provenance"]["command"][persisted["provenance"]["command"].index("--runner") + 1] == "subprocess"
    assert persisted["provenance"]["evaluation_scope"] == "diagnostic_non_scoring_limits"
    assert persisted["provenance"]["residual_wall_time_limit_s"] == 1


def test_main_persists_partial_result_but_returns_failure(tmp_path, monkeypatch, capsys) -> None:
    dataset = tmp_path / "dataset"
    dataset.mkdir()
    (dataset / "metadata.json").write_text(json.dumps({"splits": {"mini": {"n_mlps": 2}}}))
    estimator = tmp_path / "estimator.py"
    estimator.write_text("class Estimator: pass\n", encoding="utf-8")
    output_json = tmp_path / "results" / "partial.json"
    report = {
        "run_config": {"flop_budget": 1000},
        "results": {"per_mlp": [
            {"mlp_index": 0, "adjusted_final_layer_score": 0.01, "final_layer_mse": 0.1, "flops_used": 100},
            {"mlp_index": 1, "adjusted_final_layer_score": 0.2, "final_layer_mse": 0.2, "flops_used": 50, "error": "worker allocation failed"},
        ]},
    }

    def fake_run(command, **_kwargs):
        # Some evaluator versions exit zero while encoding row-level failures
        # and their penalty aggregate in JSON.
        return subprocess.CompletedProcess(command, 0, json.dumps(report), "")

    monkeypatch.setattr(sys, "argv", ["evaluate_batched.py", "--dataset", str(dataset), "--estimator", str(estimator), "--output-json", str(output_json)])
    monkeypatch.setattr(evaluate_batched, "run_streaming", fake_run)

    assert evaluate_batched.main() == 1
    printed = json.loads(capsys.readouterr().out)
    persisted = json.loads(output_json.read_text(encoding="utf-8"))
    assert printed == persisted
    assert persisted["n_failed_mlps"] == 1
    assert persisted["per_mlp"][1]["failure_class"] == "estimator_error"
    assert persisted["metrics"]["adjusted_final_layer_score"] == pytest.approx(0.105)


def test_main_rejects_nonpositive_thread_cap_before_running_whest(monkeypatch) -> None:
    monkeypatch.setattr(sys, "argv", ["evaluate_batched.py", "--max-threads", "0"])
    with pytest.raises(SystemExit) as error:
        evaluate_batched.main()
    assert error.value.code == 2


def test_main_rejects_nonpositive_residual_limit_before_running_whest(monkeypatch) -> None:
    monkeypatch.setattr(sys, "argv", ["evaluate_batched.py", "--residual-wall-time-limit", "0"])
    with pytest.raises(SystemExit) as error:
        evaluate_batched.main()
    assert error.value.code == 2
