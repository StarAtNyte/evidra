#!/usr/bin/env python3
"""Spherical-Laplacian control variates for homogeneous ReLU networks.

For h_j(u)=ReLU(w_j^T u) on S^(d-1), c_j=Delta_S(h_j^2) has exactly
zero spherical mean. Pilot-fitted linear combinations of these controls
therefore give an unbiased, target-independent correction on a held-out set.
"""
from __future__ import annotations

import argparse
import json
import math
import os
from pathlib import Path

import numpy as np
import pyarrow.parquet as pq

ROOT = Path(__file__).resolve().parents[2]
DATA = ROOT / "competitions/whestbench/starterkit/.whest-data/data"


def sphere_directions(rng: np.random.Generator, n: int, d: int) -> np.ndarray:
    if n % 2:
        raise ValueError("n must be even for antithetic pairs")
    x = rng.standard_normal((n // 2, d), dtype=np.float32)
    x = np.concatenate((x, -x), axis=0)
    return x / np.maximum(np.linalg.norm(x, axis=1, keepdims=True), 1e-30)


def evaluate(weights: np.ndarray, u: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    pre = u @ weights[0]
    h1 = np.maximum(pre, 0.0)
    h = h1
    for w in weights[1:]:
        h = np.maximum(h @ w, 0.0)
    return pre, h1, h


def stein_controls(pre: np.ndarray, h1: np.ndarray,
                   w0_norm2: np.ndarray, d: int) -> np.ndarray:
    # Exact Laplace-Beltrami identity for p=2:
    # Delta_S ReLU(w.u)^2 = 2||w||² 1[w.u>0] - 2d ReLU(w.u)^2.
    return 2.0 * w0_norm2[None, :] * (pre > 0.0) - 2.0 * d * h1 * h1


def fit_beta(c: np.ndarray, y: np.ndarray, rank: int,
             ridge_fraction: float) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    # Pilot-only whitening/PCA; every resulting control remains exact-mean-zero.
    c64 = c.astype(np.float64)
    cmean = np.zeros(c.shape[1], dtype=np.float64)
    centered = c64 - c64.mean(axis=0, keepdims=True)
    cov = centered.T @ centered
    _, vec = np.linalg.eigh(cov)
    basis = vec[:, -rank:]
    z = c64 @ basis
    scale = np.sqrt(np.maximum(np.mean((z-z.mean(axis=0))**2, axis=0), 1e-20))
    zs = z / scale[None, :]
    yc = y.astype(np.float64) - np.mean(y, axis=0, keepdims=True)
    gram = zs.T @ zs
    cross = zs.T @ yc
    reg = ridge_fraction * float(np.trace(gram)) / gram.shape[0]
    gram.flat[::gram.shape[0]+1] += reg
    beta_scaled = np.linalg.solve(gram, cross)
    # z = controls @ basis; return coefficients in original control coordinates.
    beta = basis @ (beta_scaled / scale[:, None])
    return beta, basis, scale


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--start", type=int, default=0)
    ap.add_argument("--end", type=int, default=4)
    ap.add_argument("--samples", type=int, default=8192,
                    help="total spherical directions per replicate; split pilot/eval")
    ap.add_argument("--replicates", type=int, default=2)
    ap.add_argument("--rank", type=int, default=64)
    ap.add_argument("--ridge-fraction", type=float, default=0.05)
    ap.add_argument("--output", type=Path,
                    default=ROOT / ".sota/tmp/whest-spherical-stein-screen.json")
    args = ap.parse_args()
    if not 0 <= args.start < args.end <= 100:
        ap.error("require 0 <= start < end <= 100")
    if args.samples < 2048 or args.samples % 4:
        ap.error("samples must be >=2048 and divisible by four")
    if not 1 <= args.rank <= 1024:
        ap.error("rank must be between 1 and 1024")

    n = args.samples // 2
    d = 1024
    # E||N(0,I_d)||, evaluated stably in log space.
    radius_mean = math.sqrt(2.0) * math.exp(
        math.lgamma((d + 1.0) / 2.0) - math.lgamma(d / 2.0))
    wanted = set(range(args.start, args.end))
    records = []
    for path in sorted(DATA.glob("mini-*.parquet")):
        for batch in pq.ParquetFile(path).iter_batches(
                batch_size=1, columns=["mlp_id", "weights", "final_means"]):
            idx = int(batch.column("mlp_id")[0].as_py())
            if idx not in wanted:
                continue
            row = batch.select(["weights", "final_means"]).to_pylist()[0]
            weights = np.asarray(row["weights"], dtype=np.float32).reshape(16, d, d)
            target = np.asarray(row["final_means"], dtype=np.float64)
            wnorm2 = np.sum(weights[0].astype(np.float64)**2, axis=0)
            mse_base, mse_cv, removed = [], [], []
            reps = []
            for rep in range(args.replicates):
                rng = np.random.default_rng(20261007 + idx * 1031 + rep)
                up = sphere_directions(rng, n, d)
                uv = sphere_directions(rng, n, d)
                prep, hp, yp = evaluate(weights, up)
                prev, hv, yv = evaluate(weights, uv)
                cp = stein_controls(prep, hp, wnorm2, d)
                cv = stein_controls(prev, hv, wnorm2, d)
                beta, basis, scale = fit_beta(cp, yp * radius_mean,
                                              args.rank, args.ridge_fraction)
                estimate = np.mean(yv * radius_mean - cv @ beta, axis=0,
                                   dtype=np.float64)
                plain = np.mean(yv * radius_mean, axis=0, dtype=np.float64)
                base_error, cv_error = plain-target, estimate-target
                base_mse, cv_mse = float(np.mean(base_error**2)), float(np.mean(cv_error**2))
                residual_var = float(np.mean(np.var(yv*radius_mean-cv@beta, axis=0, ddof=1)))
                raw_var = float(np.mean(np.var(yv*radius_mean, axis=0, ddof=1)))
                frac = residual_var / max(raw_var, 1e-30)
                mse_base.append(base_mse); mse_cv.append(cv_mse); removed.append(1-frac)
                reps.append({"replicate": rep, "mse_plain": base_mse,
                             "mse_control": cv_mse,
                             "residual_variance_fraction": frac})
                print(f"id={idx} rep={rep}: CV/MC MSE={cv_mse/max(base_mse,1e-30):.4f} · "
                      f"variance removed={1-frac:.4f}", flush=True)
                del up, uv, prep, hp, yp, prev, hv, yv, cp, cv, beta, basis, scale
            rec = {"id": idx, "mean_plain_mse": float(np.mean(mse_base)),
                   "mean_control_mse": float(np.mean(mse_cv)),
                   "paired_mse_ratio": float(np.mean(mse_cv)/np.mean(mse_base)),
                   "mean_variance_removed": float(np.mean(removed)), "replicates": reps}
            records.append(rec); wanted.remove(idx)
            partial = {"method": "pilot-fitted spherical Laplacian controls of first-layer ReLU²",
                       "dataset_revision": "v2-phase2", "samples": args.samples,
                       "pilot_n": n, "evaluation_n": n, "replicates": args.replicates,
                       "radius_mean": radius_mean, "rank": args.rank,
                       "ridge_fraction": args.ridge_fraction, "rows": records}
            args.output.parent.mkdir(parents=True, exist_ok=True)
            tmp = args.output.with_suffix(args.output.suffix + ".tmp")
            tmp.write_text(json.dumps(partial, indent=2)+"\n"); os.replace(tmp, args.output)
            del weights, target, row
        if not wanted:
            break
    if wanted:
        raise RuntimeError(f"Missing IDs: {sorted(wanted)}")
    ratios = np.asarray([r["paired_mse_ratio"] for r in records])
    result = {"method": "pilot-fitted spherical Laplacian controls of first-layer ReLU²",
              "dataset_revision": "v2-phase2", "samples": args.samples,
              "pilot_n": n, "evaluation_n": n, "replicates": args.replicates,
              "radius_mean": radius_mean, "rank": args.rank,
              "ridge_fraction": args.ridge_fraction,
              "aggregate": {"mean_network_mse_ratio": float(ratios.mean()),
                            "median_network_mse_ratio": float(np.median(ratios)),
                            "networks_improved": int(np.sum(ratios < 1.0)),
                            "n_networks": len(records)}, "rows": records}
    tmp = args.output.with_suffix(args.output.suffix + ".tmp")
    tmp.write_text(json.dumps(result, indent=2)+"\n"); os.replace(tmp, args.output)
    print(json.dumps(result["aggregate"], indent=2), flush=True)
    print(f"wrote {args.output}", flush=True)


if __name__ == "__main__":
    main()
