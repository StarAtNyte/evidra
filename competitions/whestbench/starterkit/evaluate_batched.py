"""Run WhestBench's persistent subprocess runner and add Evidra's formula audit.

Despite the historical filename, this adapter intentionally does not shard a
split into fresh processes. Whest estimators may preserve state between MLPs;
resetting them per row changes the grader's lifecycle and can hide cumulative
memory, warm-up, or recovery failures. ``--limit`` is a diagnostic prefix but
still uses one persistent official runner for that prefix.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import re
import selectors
import signal
import subprocess
import sys
import time
from pathlib import Path


SCORE = "adjusted_final_layer_score"
RAW_MSE = "final_layer_mse"


def run_streaming(
    command: list[str],
    heartbeat_seconds: float = 30.0,
    timeout_seconds: float | None = 4 * 60 * 60,
) -> subprocess.CompletedProcess[str]:
    """Keep long official evaluations observable without modifying their JSON stdout."""
    if timeout_seconds is not None and timeout_seconds <= 0:
        raise ValueError("timeout_seconds must be positive or None")
    started = time.monotonic()
    stdout = bytearray()
    process = subprocess.Popen(
        command,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        start_new_session=(os.name == "posix"),
    )
    assert process.stdout is not None and process.stderr is not None
    selector = selectors.DefaultSelector()
    selector.register(process.stdout, selectors.EVENT_READ, "stdout")
    selector.register(process.stderr, selectors.EVENT_READ, "stderr")
    next_heartbeat = started + max(0.1, heartbeat_seconds)
    completed = False
    try:
        while selector.get_map() or process.poll() is None:
            now = time.monotonic()
            if timeout_seconds is not None and now - started >= timeout_seconds:
                raise TimeoutError(f"official evaluator exceeded its {timeout_seconds:g}s wall-clock limit")
            events = selector.select(timeout=min(1.0, max(0.0, next_heartbeat - now))) if selector.get_map() else []
            for key, _ in events:
                chunk = key.fileobj.read1(64 * 1024)
                if not chunk:
                    selector.unregister(key.fileobj)
                    key.fileobj.close()
                elif key.data == "stdout":
                    stdout.extend(chunk)
                else:
                    sys.stderr.buffer.write(chunk)
                    sys.stderr.buffer.flush()
            now = time.monotonic()
            if now >= next_heartbeat and process.poll() is None:
                elapsed = int(now - started)
                print(
                    f"Whest evaluation still running · {elapsed // 60}m {elapsed % 60:02d}s elapsed · "
                    "official per-MLP results will be summarized when the persistent run completes.",
                    file=sys.stderr,
                    flush=True,
                )
                next_heartbeat = now + max(0.1, heartbeat_seconds)
        returncode = process.wait()
        completed = True
        return subprocess.CompletedProcess(command, returncode, stdout.decode(errors="replace"), "")
    finally:
        selector.close()
        if not completed:
            # The official runner may own a persistent worker. Interrupting or
            # timing out this adapter must not leave that child behind.
            try:
                if os.name == "posix":
                    os.killpg(process.pid, signal.SIGTERM)
                elif process.poll() is None:
                    process.terminate()
            except ProcessLookupError:
                pass
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                try:
                    if os.name == "posix":
                        os.killpg(process.pid, signal.SIGKILL)
                    else:
                        process.kill()
                except ProcessLookupError:
                    pass
                process.wait()
            if os.name == "posix":
                # The group leader can exit before a worker that ignores TERM;
                # reap any remaining descendants after the grace period too.
                try:
                    os.killpg(process.pid, 0)
                    os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass


def summarize_report(report: dict, expected_rows: int | None = None) -> dict:
    """Normalize Whest JSON and independently verify every adjusted score."""
    run = report.get("results")
    config = report.get("run_config")
    if not isinstance(run, dict) or not isinstance(config, dict):
        raise ValueError("official Whest JSON is missing results or run_config")
    rows = run.get("per_mlp")
    budget = int(config.get("flop_budget", 0))
    if not isinstance(rows, list) or not rows or budget <= 0:
        raise ValueError("official Whest JSON has no per-MLP rows or a non-positive FLOP budget")
    if expected_rows is not None and len(rows) != expected_rows:
        raise ValueError(f"official evaluator returned {len(rows)}/{expected_rows} requested rows")

    adjusted: list[float] = []
    raw_mse: list[float] = []
    utilization: list[float] = []
    multipliers: list[float] = []
    normalized_rows: list[dict] = []
    for index, row in enumerate(rows):
        if not isinstance(row, dict):
            raise ValueError(f"official evaluator row {index} is not an object")
        score = float(row[SCORE])
        mse = float(row[RAW_MSE])
        flops_used = int(row.get("flops_used", 0))
        if flops_used < 0:
            raise ValueError(f"official evaluator row {index} has negative flops_used")
        measured_utilization = flops_used / budget
        failed = bool(
            row.get("error")
            or any(row.get(key) for key in (
                "budget_exhausted", "time_exhausted", "residual_wall_time_exhausted",
                "combined_budget_exhausted",
            ))
        )
        multiplier = 1.0 if failed else max(0.1, measured_utilization)
        expected_score = mse * multiplier
        formula_matches = math.isclose(score, expected_score, rel_tol=1e-9, abs_tol=1e-18)
        if not formula_matches:
            failed = True
            row_error = f"score formula mismatch: reported={score:.17g}, recomputed={expected_score:.17g}"
        else:
            row_error = row.get("error")
        if failed and not row_error:
            row_error = "official Whest evaluator marked this MLP as failed"
        adjusted.append(score)
        raw_mse.append(mse)
        utilization.append(measured_utilization)
        multipliers.append(multiplier)
        normalized_rows.append({
            "index": int(row.get("mlp_index", index)),
            "name": str(row.get("mlp_name", f"row-{index}")),
            SCORE: score,
            RAW_MSE: mse,
            "flops_used": flops_used,
            "flop_budget": budget,
            "compute_utilization": measured_utilization,
            "timing_and_compute_diagnostics": {
                key: value
                for key, value in row.items()
                if re.search(r"time|duration|wall|effective_compute", key, re.IGNORECASE)
                and isinstance(value, (int, float))
                and not isinstance(value, bool)
                and math.isfinite(float(value))
            },
            "score_formula_verified": formula_matches,
            "failed": failed,
            "failure_flags": {
                key: bool(row.get(key))
                for key in (
                    "budget_exhausted", "time_exhausted", "residual_wall_time_exhausted",
                    "combined_budget_exhausted",
                )
            },
            "failure_class": (
                "estimator_error" if row.get("error") else
                "time_exhausted" if row.get("time_exhausted") else
                "budget_exhausted" if row.get("budget_exhausted") else
                "residual_wall_time_exhausted" if row.get("residual_wall_time_exhausted") else
                "combined_budget_exhausted" if row.get("combined_budget_exhausted") else
                "unknown_failure" if failed else None
            ),
            **({"error": str(row_error)} if row_error else {}),
        })

    return {
        "metrics": {
            SCORE: sum(adjusted) / len(adjusted),
            RAW_MSE: sum(raw_mse) / len(raw_mse),
            "mean_compute_utilization": sum(utilization) / len(utilization),
            "mean_score_multiplier": sum(multipliers) / len(multipliers),
        },
        "n_mlps": len(rows),
        "n_failed_mlps": sum(row["failed"] for row in normalized_rows),
        "per_mlp": normalized_rows,
        "whest_local_reference": {
            "whestbench_version": report.get("whestbench_version"),
            "runner": "subprocess",
            "instance_scope": "one persistent estimator worker for this local split",
            "platform_worker_assignment": "not reproduced; AIcrowd grade is the external outcome",
            "run_config": config,
            "run_meta": report.get("run_meta"),
        },
    }


def write_json_atomic(path: Path, payload: dict) -> None:
    """Persist complete evaluator evidence without leaving a partial JSON file."""
    path = path.resolve()
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    try:
        with temporary.open("w", encoding="utf-8") as handle:
            json.dump(payload, handle, separators=(",", ":"), allow_nan=False)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        try:
            temporary.unlink(missing_ok=True)
        except OSError:
            pass


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dataset", default=".whest-data")
    parser.add_argument("--estimator", default="estimator.py")
    parser.add_argument("--split", default="mini")
    parser.add_argument("--limit", type=int, help="evaluate a prefix in one persistent official runner")
    parser.add_argument("--max-threads", type=int, default=2, help="cap Whest BLAS threads (default: 2; lower this to reduce memory pressure)")
    parser.add_argument("--residual-wall-time-limit", type=float, default=0.4, help="per-MLP residual-time cap in seconds (0.4 is the Phase 2 scoring limit; other values are diagnostic only)")
    parser.add_argument("--timeout-seconds", type=float, default=4 * 60 * 60, help="hard wall-clock limit for the complete persistent evaluation (default: 4 hours)")
    parser.add_argument("--output-json", type=Path, help="atomically persist the complete verified per-MLP report at this path")
    args = parser.parse_args()

    if args.max_threads < 1:
        parser.error("--max-threads must be a positive integer")
    if not math.isfinite(args.residual_wall_time_limit) or args.residual_wall_time_limit <= 0:
        parser.error("--residual-wall-time-limit must be a positive finite number")

    dataset = Path(args.dataset).resolve()
    metadata_path = dataset / "metadata.json"
    try:
        metadata = json.loads(metadata_path.read_text())
        split_info = metadata.get("splits", {}).get(args.split)
        if not isinstance(split_info, dict):
            raise ValueError(f"split {args.split!r} is not declared in {metadata_path}")
        expected = int(split_info["n_mlps"])
        if args.limit is not None:
            if args.limit < 1:
                raise ValueError("--limit must be a positive integer")
            expected = min(expected, args.limit)
    except (OSError, json.JSONDecodeError, KeyError, TypeError, ValueError) as error:
        print(f"Invalid Whest dataset metadata: {error}", file=sys.stderr)
        return 2

    command = [
        "uv", "run", "whest", "run",
        "--estimator", args.estimator,
        "--dataset", str(dataset),
        "--split", args.split,
        "--runner", "subprocess",
        "--max-threads", str(args.max_threads),
        "--residual-wall-time-limit", str(args.residual_wall_time_limit),
        "--n-mlps", str(expected),
        "--format", "json",
        "--detail", "full",
    ]
    try:
        result = run_streaming(command, timeout_seconds=args.timeout_seconds)
    except TimeoutError as error:
        print(f"Whest evaluation timed out: {error}", file=sys.stderr)
        return 124
    try:
        report = json.loads(result.stdout)
        summary = summarize_report(report, expected_rows=expected)
    except (json.JSONDecodeError, ValueError, KeyError, TypeError) as error:
        print(f"Could not verify official Whest output: {error}", file=sys.stderr)
        if result.stdout:
            print(result.stdout[-4000:], file=sys.stderr)
        return result.returncode or 2

    estimator_path = Path(args.estimator).resolve()
    try:
        estimator_sha256 = hashlib.sha256(estimator_path.read_bytes()).hexdigest()
    except OSError as error:
        print(f"Could not hash estimator source {estimator_path}: {error}", file=sys.stderr)
        return 2
    reproducibility_environment = {
        name: os.environ.get(name)
        for name in (
            "V26_STRASSEN", "V26_STRASSEN_HUB", "V26_STRASSEN_NEW", "V29_CPRE_LEV",
            "V28_STRASSEN_SB", "V26_STRASSEN_MIN", "V28_STRASSEN_FIRST",
            "V28_STRASSEN_FUSE_P", "V25_BETA", "OMP_NUM_THREADS",
            "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS", "NUMEXPR_NUM_THREADS",
        )
    }
    summary["provenance"] = {
        "estimator_path": str(estimator_path),
        "estimator_sha256": estimator_sha256,
        "command": command,
        "evaluation_scope": "phase2_scoring_limits" if math.isclose(args.residual_wall_time_limit, 0.4) else "diagnostic_non_scoring_limits",
        "residual_wall_time_limit_s": args.residual_wall_time_limit,
        "environment": reproducibility_environment,
        "exit_code": result.returncode,
    }
    if args.output_json:
        try:
            write_json_atomic(args.output_json, summary)
        except (OSError, ValueError) as error:
            print(f"Could not persist evaluator report to {args.output_json}: {error}", file=sys.stderr)
            return 2
    print(json.dumps(summary, separators=(",", ":")))
    # Non-zero on evaluator errors even if this Whest release encoded failures
    # in JSON while returning success; Evidra must never promote a failed run.
    return 1 if result.returncode != 0 or summary["n_failed_mlps"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
