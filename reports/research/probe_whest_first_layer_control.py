#!/usr/bin/env python3
"""Pilot-fit control variate using exact first-layer ReLU means.

The first-layer activations are nonlinear functions of the Gaussian input, but
their means are available exactly from the input weights. Fit output controls
on an independent pilot, then estimate the held-out residual mean. Conditional
on the pilot, this estimator remains unbiased for the benchmark target.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path

import numpy as np
import pyarrow.parquet as pq

ROOT = Path(__file__).resolve().parents[2]
DATA = ROOT / "competitions/whestbench/starterkit/.whest-data/data"


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def run_network(weights: np.ndarray, x: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    h = x
    first = None
    for layer_idx, layer in enumerate(weights):
        h = np.maximum(h @ layer, 0.0)
        if layer_idx == 0:
            first = h.copy()
    assert first is not None
    return first, h


def antithetic_normal(rng: np.random.Generator, n: int, d: int) -> np.ndarray:
    if n % 2:
        raise ValueError("sample count must be even")
    x = rng.standard_normal((n // 2, d), dtype=np.float32)
    return np.concatenate((x, -x), axis=0)


def fit_control(h: np.ndarray, y: np.ndarray, exact_h_mean: np.ndarray,
                ridge_fraction: float) -> np.ndarray:
    xc = h.astype(np.float64) - exact_h_mean[None, :]
    yc = y.astype(np.float64) - y.mean(axis=0, keepdims=True)
    gram = xc.T @ xc
    cross = xc.T @ yc
    scale = float(np.trace(gram) / gram.shape[0])
    gram.flat[::gram.shape[0] + 1] += ridge_fraction * scale
    return np.linalg.solve(gram, cross)


def predict_control_mean(h: np.ndarray, y: np.ndarray, exact_h_mean: np.ndarray,
                         coef: np.ndarray) -> np.ndarray:
    # Exact expectation of the linear control plus an independent residual mean.
    return exact_h_mean @ coef + np.mean(y.astype(np.float64) - h @ coef, axis=0)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--start", type=int, default=0)
    ap.add_argument("--end", type=int, default=4)
    ap.add_argument("--samples", type=int, default=8192,
                    help="total antithetic samples per replicate, split pilot/evaluation")
    ap.add_argument("--replicates", type=int, default=2)
    ap.add_argument("--ridge-fraction", type=float, default=0.05)
    ap.add_argument("--rank", type=int, default=64,
                    help="pilot-only PCA rank for the exact-mean first-layer control basis")
    ap.add_argument("--output", type=Path,
                    default=ROOT / ".sota/tmp/whest-first-layer-control-screen.json")
    args = ap.parse_args()
    if not (0 <= args.start < args.end <= 100):
        ap.error("require 0 <= start < end <= 100")
    if args.samples < 2048 or args.samples % 4:
        ap.error("samples must be >=2048 and divisible by four")
    if not 1 <= args.rank <= 1024:
        ap.error("rank must be between 1 and 1024")
    pilot_n = eval_n = args.samples // 2
    records: list[dict[str, float | int]] = []
    wanted = set(range(args.start, args.end))
    for path in sorted(DATA.glob("mini-*.parquet")):
        for batch in pq.ParquetFile(path).iter_batches(
                batch_size=1, columns=["mlp_id", "mlp_seed", "weights", "final_means"]):
            idx = int(batch.column("mlp_id")[0].as_py())
            if idx not in wanted:
                continue
            row = batch.select(["mlp_seed", "weights", "final_means"]).to_pylist()[0]
            weights = np.asarray(row["weights"], dtype=np.float32).reshape(16, 1024, 1024)
            target = np.asarray(row["final_means"], dtype=np.float64)
            h_mean = np.linalg.norm(weights[0].astype(np.float64), axis=0) / np.sqrt(2*np.pi)
            control_sq: list[float] = []
            plain_sq: list[float] = []
            correlations: list[float] = []
            replicate_rows = []
            for rep in range(args.replicates):
                rng = np.random.default_rng(20261001 + idx * 1009 + rep)
                xp = antithetic_normal(rng, pilot_n, 1024)
                xv = antithetic_normal(rng, eval_n, 1024)
                hp, yp = run_network(weights, xp)
                hv, yv = run_network(weights, xv)
                centered = hp.astype(np.float64) - h_mean[None, :]
                _, vectors = np.linalg.eigh(centered.T @ centered)
                basis = vectors[:, -args.rank:]
                hp_low = hp @ basis
                hv_low = hv @ basis
                mean_low = h_mean @ basis
                coef = fit_control(hp_low, yp, mean_low, args.ridge_fraction)
                estimate = predict_control_mean(hv_low, yv, mean_low, coef)
                plain = np.mean(yv, axis=0, dtype=np.float64)
                e_cv, e_plain = estimate - target, plain - target
                cv_mse, plain_mse = float(np.mean(e_cv**2)), float(np.mean(e_plain**2))
                control_sq.append(cv_mse)
                plain_sq.append(plain_mse)
                residual = yv.astype(np.float64) - hv_low @ coef
                residual_var = float(np.mean(np.var(residual, axis=0, ddof=1)))
                output_var = float(np.mean(np.var(yv, axis=0, ddof=1)))
                correlations.append(1.0 - residual_var / max(output_var, 1e-30))
                replicate_rows.append({"replicate": rep, "mse_plain": plain_mse,
                                       "mse_control": cv_mse,
                                       "residual_variance_fraction": residual_var / max(output_var, 1e-30)})
                del xp, xv, hp, yp, hv, yv, hp_low, hv_low, mean_low, coef, basis
                print(f"id={idx} rep={rep}: control/plain MSE="
                      f"{cv_mse/max(plain_mse,1e-30):.4f} · "
                      f"in-sample-independent residual variance="
                      f"{replicate_rows[-1]['residual_variance_fraction']:.4f}", flush=True)
            records.append({"id": idx,
                            "mean_plain_mse": float(np.mean(plain_sq)),
                            "mean_control_mse": float(np.mean(control_sq)),
                            "paired_mse_ratio": float(np.mean(control_sq)/np.mean(plain_sq)),
                            "mean_fraction_variance_removed": float(np.mean(correlations)),
                            "replicates": replicate_rows})
            wanted.remove(idx)
            partial = {"method": "pilot-fitted linear CV on exact-mean first-layer ReLU features",
                       "dataset_revision": "v2-phase2", "start": args.start,
                       "end": args.end, "samples_per_replicate": args.samples,
                       "pilot_n": pilot_n, "evaluation_n": eval_n,
                       "replicates": args.replicates,
                       "ridge_fraction": args.ridge_fraction, "rank": args.rank,
                       "rows": records}
            args.output.parent.mkdir(parents=True, exist_ok=True)
            temp = args.output.with_suffix(args.output.suffix + ".tmp")
            temp.write_text(json.dumps(partial, indent=2) + "\n")
            os.replace(temp, args.output)
            del weights, target, row
        if not wanted:
            break
    if wanted:
        raise RuntimeError(f"Missing Mini IDs: {sorted(wanted)}")
    ratios = np.asarray([r["paired_mse_ratio"] for r in records], dtype=np.float64)
    result = {
        "method": "pilot-fitted linear CV on exact-mean first-layer ReLU features",
        "dataset_revision": "v2-phase2", "samples_per_replicate": args.samples,
        "pilot_n": pilot_n, "evaluation_n": eval_n, "replicates": args.replicates,
        "ridge_fraction": args.ridge_fraction, "rank": args.rank,
        "aggregate": {"mean_network_mse_ratio": float(ratios.mean()),
                      "median_network_mse_ratio": float(np.median(ratios)),
                      "networks_improved": int(np.sum(ratios < 1.0)),
                      "n_networks": len(records)},
        "rows": records,
    }
    temp = args.output.with_suffix(args.output.suffix + ".tmp")
    temp.write_text(json.dumps(result, indent=2) + "\n")
    os.replace(temp, args.output)
    print(json.dumps(result["aggregate"], indent=2), flush=True)
    print(f"wrote {args.output}", flush=True)


if __name__ == "__main__":
    main()
