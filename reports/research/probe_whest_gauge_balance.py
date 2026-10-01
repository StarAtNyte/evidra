#!/usr/bin/env python3
"""Paired test of function-preserving ReLU gauge balancing for V29.

For each hidden neuron, multiplying its incoming weights by c>0 and dividing
its outgoing weights by c leaves a bias-free ReLU network's function exactly
unchanged.  The experiment tests whether choosing a numerically balanced
representative of that gauge orbit changes V29's approximation error.
"""
from __future__ import annotations

import argparse
import gc
import hashlib
import json
import os
import sys
from pathlib import Path

import numpy as np
import pyarrow.parquet as pq
import flopscope as flops
import flopscope.numpy as fnp
from whestbench.domain import MLP

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / ".sota/research/whest-p2-cumulant-k3/estimators"))
import estimator_v29_chunk6 as estimator_module  # noqa: E402


class Setup:
    seed = 0


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def gauge_balance(weights: np.ndarray, sweeps: int = 4,
                  max_log_scale: float = 3.0) -> tuple[np.ndarray, np.ndarray]:
    """Coordinate-equilibrate adjacent incoming/outgoing neuron norm pairs."""
    transformed = weights.astype(np.float64, copy=True)
    _, _, width = transformed.shape
    log_scales = np.zeros((transformed.shape[0] - 1, width), dtype=np.float64)
    # A single hidden-neuron update changes only its incoming column and its
    # outgoing row. Recompute their Euclidean norms after each full sweep.
    for _ in range(sweeps):
        for layer in range(transformed.shape[0] - 1):
            incoming = np.linalg.norm(transformed[layer], axis=0)
            outgoing = np.linalg.norm(transformed[layer + 1], axis=1)
            delta = 0.5 * (np.log(np.maximum(outgoing, 1e-30))
                           - np.log(np.maximum(incoming, 1e-30)))
            target = np.clip(log_scales[layer] + delta,
                             -max_log_scale, max_log_scale)
            delta = target - log_scales[layer]
            scale = np.exp(delta)
            transformed[layer] *= scale[None, :]
            transformed[layer + 1] /= scale[:, None]
            log_scales[layer] = target
    return transformed.astype(np.float32), log_scales.astype(np.float32)


def forward(weights: np.ndarray, x: np.ndarray) -> np.ndarray:
    h = x
    for layer in weights:
        h = np.maximum(h @ layer, 0.0)
    return h


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--start", type=int, default=0)
    parser.add_argument("--end", type=int, default=8)
    parser.add_argument("--output", type=Path,
                        default=ROOT / ".sota/tmp/whest-gauge-balance-screen.json")
    parser.add_argument("--sweeps", type=int, default=4)
    args = parser.parse_args()
    if not 0 <= args.start < args.end <= 100:
        parser.error("require 0 <= start < end <= 100")

    estimator_path = Path(estimator_module._BASE.__file__).resolve()
    wrapper_path = Path(estimator_module.__file__).resolve()
    estimator = estimator_module.Estimator()
    estimator.setup(Setup())
    wanted = set(range(args.start, args.end))
    records: list[dict[str, float | int]] = []
    data_dir = ROOT / "competitions/whestbench/starterkit/.whest-data/data"
    for path in sorted(data_dir.glob("mini-*.parquet")):
        for batch in pq.ParquetFile(path).iter_batches(
                batch_size=1, columns=["mlp_id", "mlp_seed", "weights", "final_means"]):
            idx = int(batch.column("mlp_id")[0].as_py())
            if idx not in wanted:
                continue
            row = batch.select(["mlp_seed", "weights", "final_means"]).to_pylist()[0]
            seed = int(row["mlp_seed"])
            raw = np.asarray(row["weights"], dtype=np.float32).reshape(16, 1024, 1024)
            target = np.asarray(row["final_means"], dtype=np.float32)
            gauged, log_scales = gauge_balance(raw, sweeps=args.sweeps)
            # Check the exact function-preserving identity independently of the
            # competition target before comparing the two estimator outputs.
            rng = np.random.default_rng(10000 + idx)
            probes = rng.standard_normal((5, 1024), dtype=np.float32)
            f0, f1 = forward(raw, probes), forward(gauged, probes)
            equivariance_error = float(np.max(np.abs(f0 - f1)) /
                                       max(float(np.max(np.abs(f0))), 1e-30))
            if equivariance_error > 2e-5:
                raise RuntimeError(f"ID {idx}: gauge identity failed ({equivariance_error:g})")

            estimates = []
            costs = []
            for current in (raw, gauged):
                mlp = MLP(width=1024, depth=16,
                          weights=[fnp.asarray(w) for w in current], seed=seed)
                with flops.BudgetContext(flop_budget=2**41,
                                         wall_time_limit_s=120.0, quiet=True) as ctx:
                    pred = np.asarray(estimator.predict(mlp, 2**41)[-1], dtype=np.float64)
                estimates.append(pred)
                costs.append(int(ctx.flops_used))
                del mlp, pred
                gc.collect()
            mse0 = float(np.mean((estimates[0] - target) ** 2))
            mse1 = float(np.mean((estimates[1] - target) ** 2))
            records.append({
                "id": idx, "mse_baseline": mse0, "mse_gauge_balanced": mse1,
                "relative_mse_change": (mse1 - mse0) / mse0,
                "cost_baseline": costs[0], "cost_gauge_balanced": costs[1],
                "max_function_equivariance_error": equivariance_error,
                "max_abs_log_gauge": float(np.max(np.abs(log_scales))),
            })
            wanted.remove(idx)
            print(f"ID {idx}: paired MSE change {100*(mse1/mse0-1):+.2f}% · "
                  f"function error {equivariance_error:.2e}", flush=True)
            # Durable progress: a long estimator call must not erase completed rows.
            partial = {
                "experiment": "function-preserving neuron-gauge balancing",
                "dataset_revision": "v2-phase2", "split": "public mini",
                "ids": [int(r["id"]) for r in records], "sweeps": args.sweeps,
                "estimator_sha256": {"base": sha256(estimator_path),
                                     "wrapper": sha256(wrapper_path)},
                "rows": records,
            }
            args.output.parent.mkdir(parents=True, exist_ok=True)
            temp_output = args.output.with_suffix(args.output.suffix + ".tmp")
            temp_output.write_text(json.dumps(partial, indent=2) + "\n")
            os.replace(temp_output, args.output)
            del raw, gauged, target, row
        if not wanted:
            break
    if wanted:
        raise RuntimeError(f"Missing Mini IDs: {sorted(wanted)}")

    ratios = np.asarray([r["mse_gauge_balanced"] / r["mse_baseline"] for r in records])
    result = {
        "experiment": "function-preserving neuron-gauge balancing",
        "dataset_revision": "v2-phase2", "split": "public mini",
        "ids": [int(r["id"]) for r in records], "sweeps": args.sweeps,
        "estimator_sha256": {"base": sha256(estimator_path),
                             "wrapper": sha256(wrapper_path)},
        "aggregate": {
            "pooled_mse_ratio": float(sum(float(r["mse_gauge_balanced"]) for r in records)
                                        / sum(float(r["mse_baseline"]) for r in records)),
            "median_per_mlp_mse_ratio": float(np.median(ratios)),
            "improved_mlps": int(np.sum(ratios < 1.0)), "n_mlps": len(records),
            "max_function_equivariance_error": max(
                float(r["max_function_equivariance_error"]) for r in records),
        },
        "rows": records,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps(result["aggregate"], indent=2), flush=True)
    print(f"wrote {args.output}", flush=True)


if __name__ == "__main__":
    main()
