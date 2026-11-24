#!/usr/bin/env python3
"""Quadratic first-layer control with exact Gaussian/ReLU feature moments."""
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

import numpy as np
import pyarrow.parquet as pq

ROOT = Path(__file__).resolve().parents[2]
DATA = ROOT / "competitions/whestbench/starterkit/.whest-data/data"
sys.path.insert(0, str(Path(__file__).resolve().parent))
from probe_whest_first_layer_control import antithetic_normal, run_network  # noqa: E402


def exact_first_layer_moments(w0: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Exact E[h] and Cov(h) for h=ReLU(X W0), X~N(0,I)."""
    w = w0.astype(np.float64)
    gram = w.T @ w
    norms = np.sqrt(np.maximum(np.diag(gram), 1e-30))
    rho = np.clip(gram / np.maximum(norms[:, None] * norms[None, :], 1e-30), -1.0, 1.0)
    angle = np.arccos(rho)
    second = (norms[:, None] * norms[None, :] / (2.0 * np.pi)) * (
        np.sqrt(np.maximum(1.0 - rho * rho, 0.0)) + (np.pi - angle) * rho)
    mean = norms / np.sqrt(2.0 * np.pi)
    cov = second - np.outer(mean, mean)
    cov = 0.5 * (cov + cov.T)
    return mean, cov


def make_features(h: np.ndarray, mean: np.ndarray, basis: np.ndarray,
                  i: np.ndarray, j: np.ndarray) -> np.ndarray:
    z = (h.astype(np.float64) - mean[None, :]) @ basis
    return np.concatenate((z, z[:, i] * z[:, j]), axis=1)


def fit(h: np.ndarray, y: np.ndarray, mean_h: np.ndarray,
        mean_f: np.ndarray, ridge_fraction: float) -> tuple[np.ndarray, np.ndarray]:
    x = h.astype(np.float64) - mean_f[None, :]
    target = y.astype(np.float64) - y.mean(axis=0, keepdims=True)
    scale = np.sqrt(np.maximum(np.mean(x * x, axis=0), 1e-20))
    xs = x / scale[None, :]
    gram = xs.T @ xs
    cross = xs.T @ target
    reg = ridge_fraction * (float(np.trace(gram)) / gram.shape[0])
    gram.flat[::gram.shape[0] + 1] += reg
    coef = np.linalg.solve(gram, cross) / scale[:, None]
    return coef, mean_f


def control_estimate(features: np.ndarray, y: np.ndarray, mean_f: np.ndarray,
                     coef: np.ndarray) -> np.ndarray:
    return mean_f @ coef + np.mean(y.astype(np.float64) - features @ coef, axis=0)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--start", type=int, default=0)
    ap.add_argument("--end", type=int, default=4)
    ap.add_argument("--samples", type=int, default=8192)
    ap.add_argument("--replicates", type=int, default=2)
    ap.add_argument("--rank", type=int, default=16)
    ap.add_argument("--ridge-fraction", type=float, default=0.01)
    ap.add_argument("--output", type=Path,
                    default=ROOT / ".sota/tmp/whest-first-layer-quadratic-screen.json")
    args = ap.parse_args()
    if not 0 <= args.start < args.end <= 100:
        ap.error("require 0 <= start < end <= 100")
    if args.samples < 2048 or args.samples % 4:
        ap.error("samples must be >=2048 and divisible by four")
    if not 1 <= args.rank <= 64:
        ap.error("rank must be between 1 and 64")
    pilot_n = eval_n = args.samples // 2
    wanted = set(range(args.start, args.end))
    records = []
    for path in sorted(DATA.glob("mini-*.parquet")):
        for batch in pq.ParquetFile(path).iter_batches(
                batch_size=1, columns=["mlp_id", "weights", "final_means"]):
            idx = int(batch.column("mlp_id")[0].as_py())
            if idx not in wanted:
                continue
            row = batch.select(["weights", "final_means"]).to_pylist()[0]
            weights = np.asarray(row["weights"], dtype=np.float32).reshape(16, 1024, 1024)
            target = np.asarray(row["final_means"], dtype=np.float64)
            h_mean, h_cov = exact_first_layer_moments(weights[0])
            eigval, eigvec = np.linalg.eigh(h_cov)
            basis = eigvec[:, -args.rank:]
            cov_z = basis.T @ h_cov @ basis
            ii, jj = np.triu_indices(args.rank)
            mean_f = np.concatenate((np.zeros(args.rank), cov_z[ii, jj]))
            plain_mse, cv_mse, residual_fracs = [], [], []
            reps = []
            for rep in range(args.replicates):
                rng = np.random.default_rng(20261003 + idx * 1013 + rep)
                xp = antithetic_normal(rng, pilot_n, 1024)
                xv = antithetic_normal(rng, eval_n, 1024)
                hp, yp = run_network(weights, xp)
                hv, yv = run_network(weights, xv)
                fp = make_features(hp, h_mean, basis, ii, jj)
                fv = make_features(hv, h_mean, basis, ii, jj)
                coef, _ = fit(fp, yp, None, mean_f, args.ridge_fraction)
                estimate = control_estimate(fv, yv, mean_f, coef)
                plain = np.mean(yv, axis=0, dtype=np.float64)
                e_cv, e_plain = estimate - target, plain - target
                cv, mc = float(np.mean(e_cv**2)), float(np.mean(e_plain**2))
                residual = yv.astype(np.float64) - fv @ coef
                fraction = float(np.mean(np.var(residual, axis=0, ddof=1)) /
                                  max(np.mean(np.var(yv, axis=0, ddof=1)), 1e-30))
                cv_mse.append(cv); plain_mse.append(mc); residual_fracs.append(fraction)
                reps.append({"replicate": rep, "mse_plain": mc, "mse_control": cv,
                             "residual_variance_fraction": fraction})
                print(f"id={idx} rep={rep}: CV/MC MSE={cv/max(mc,1e-30):.4f} · "
                      f"residual variance fraction={fraction:.4f}", flush=True)
                del xp, xv, hp, yp, hv, yv, fp, fv, coef
            rec = {"id": idx, "mean_plain_mse": float(np.mean(plain_mse)),
                   "mean_control_mse": float(np.mean(cv_mse)),
                   "paired_mse_ratio": float(np.mean(cv_mse)/np.mean(plain_mse)),
                   "mean_residual_variance_fraction": float(np.mean(residual_fracs)),
                   "replicates": reps}
            records.append(rec); wanted.remove(idx)
            partial = {"method": "exact-moment quadratic control on first-layer ReLU features",
                       "dataset_revision": "v2-phase2", "samples": args.samples,
                       "pilot_n": pilot_n, "evaluation_n": eval_n,
                       "replicates": args.replicates, "rank": args.rank,
                       "ridge_fraction": args.ridge_fraction, "rows": records}
            args.output.parent.mkdir(parents=True, exist_ok=True)
            tmp = args.output.with_suffix(args.output.suffix + ".tmp")
            tmp.write_text(json.dumps(partial, indent=2) + "\n"); os.replace(tmp, args.output)
            del weights, target, h_cov, h_mean, row
        if not wanted:
            break
    if wanted:
        raise RuntimeError(f"Missing IDs {sorted(wanted)}")
    ratios = np.asarray([r["paired_mse_ratio"] for r in records])
    result = {"method": "exact-moment quadratic control on first-layer ReLU features",
              "dataset_revision": "v2-phase2", "samples": args.samples,
              "pilot_n": pilot_n, "evaluation_n": eval_n,
              "replicates": args.replicates, "rank": args.rank,
              "ridge_fraction": args.ridge_fraction,
              "aggregate": {"mean_network_mse_ratio": float(ratios.mean()),
                            "median_network_mse_ratio": float(np.median(ratios)),
                            "networks_improved": int(np.sum(ratios < 1.0)),
                            "n_networks": len(records)}, "rows": records}
    tmp = args.output.with_suffix(args.output.suffix + ".tmp")
    tmp.write_text(json.dumps(result, indent=2) + "\n"); os.replace(tmp, args.output)
    print(json.dumps(result["aggregate"], indent=2), flush=True)
    print(f"wrote {args.output}", flush=True)


if __name__ == "__main__":
    main()
