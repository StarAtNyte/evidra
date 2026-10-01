#!/usr/bin/env python3
"""Pilot-fitted second Gaussian-Hermite controls for antithetic WhestBench MC.

Antithetic averaging removes every odd Hermite component. This probes even,
degree-two Hermite controls in a first-layer-weight-derived input subspace.
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path

import numpy as np
import pyarrow.parquet as pq

ROOT = Path(__file__).resolve().parents[2]
DATA = ROOT / "competitions/whestbench/starterkit/.whest-data/data"


def pairs(rng: np.random.Generator, n: int, d: int) -> np.ndarray:
    return rng.standard_normal((n, d), dtype=np.float32)


def forward(weights: np.ndarray, x: np.ndarray) -> np.ndarray:
    h = x
    for w in weights:
        h = np.maximum(h @ w, 0.0)
    return h


def hermite2(x: np.ndarray, basis: np.ndarray) -> np.ndarray:
    z = x @ basis
    r = z.shape[1]
    ii, jj = np.triu_indices(r)
    values = z[:, ii] * z[:, jj]
    values[:, ii == jj] -= 1.0
    return values


def fit_beta(phi: np.ndarray, y: np.ndarray, ridge_fraction: float) -> np.ndarray:
    p = phi.astype(np.float64)
    yc = y.astype(np.float64) - np.mean(y, axis=0, keepdims=True)
    scale = np.sqrt(np.maximum(np.mean(p*p, axis=0), 1e-20))
    ps = p / scale
    gram = ps.T @ ps
    cross = ps.T @ yc
    lam = ridge_fraction * float(np.trace(gram)) / gram.shape[0]
    gram.flat[::gram.shape[0]+1] += lam
    return np.linalg.solve(gram, cross) / scale[:, None]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--start", type=int, default=4)
    ap.add_argument("--end", type=int, default=8)
    ap.add_argument("--samples", type=int, default=8192,
                    help="number of Gaussian pairs; half pilot, half evaluation")
    ap.add_argument("--replicates", type=int, default=2)
    ap.add_argument("--rank", type=int, default=16)
    ap.add_argument("--ridge-fraction", type=float, default=0.05)
    ap.add_argument("--output", type=Path,
                    default=ROOT / ".sota/tmp/whest-antithetic-hermite2.json")
    a = ap.parse_args()
    if not 0 <= a.start < a.end <= 100:
        ap.error("require 0 <= start < end <= 100")
    if a.samples < 1024 or a.samples % 2:
        ap.error("samples must be even and >=1024")
    if not 1 <= a.rank <= 1024:
        ap.error("rank must be between 1 and 1024")

    n = a.samples // 2
    wanted = set(range(a.start, a.end))
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
            # W has input-by-neuron layout; left singular vectors span input space.
            gram = weights[0].astype(np.float64) @ weights[0].astype(np.float64).T
            _, vec = np.linalg.eigh(gram)
            basis = vec[:, -a.rank:]
            rep_rows, mses0, mses1 = [], [], []
            for rep in range(a.replicates):
                rng = np.random.default_rng(20261011 + idx*1031 + rep)
                xp = pairs(rng, n, 1024)
                xv = pairs(rng, n, 1024)
                yp = 0.5*(forward(weights, xp) + forward(weights, -xp))
                yv = 0.5*(forward(weights, xv) + forward(weights, -xv))
                pp = hermite2(xp, basis)
                pv = hermite2(xv, basis)
                beta = fit_beta(pp, yp, a.ridge_fraction)
                estimate = np.mean(yv.astype(np.float64) - pv @ beta, axis=0)
                plain = np.mean(yv, axis=0, dtype=np.float64)
                mse0 = float(np.mean((plain-target)**2))
                mse1 = float(np.mean((estimate-target)**2))
                var_ratio = float(np.mean(np.var(yv-pv@beta, axis=0, ddof=1)) /
                                   max(np.mean(np.var(yv, axis=0, ddof=1)), 1e-30))
                mses0.append(mse0); mses1.append(mse1)
                rep_rows.append({"replicate": rep, "mse_plain": mse0,
                                 "mse_control": mse1, "variance_ratio": var_ratio})
                print(f"id={idx} rep={rep}: CV/MC MSE={mse1/max(mse0,1e-30):.4f} · "
                      f"variance ratio={var_ratio:.4f}", flush=True)
            records.append({"id": idx, "paired_mse_ratio": float(np.mean(mses1)/np.mean(mses0)),
                            "replicates": rep_rows})
            wanted.remove(idx)
            partial = {"method": "pilot-fitted degree-2 Gaussian Hermite controls in W0 input subspace",
                       "dataset_revision": "v2-phase2", "start": a.start, "end": a.end,
                       "gaussian_pairs_per_replicate": a.samples, "pilot_pairs": n,
                       "evaluation_pairs": n, "rank": a.rank,
                       "ridge_fraction": a.ridge_fraction, "rows": records}
            a.output.parent.mkdir(parents=True, exist_ok=True)
            tmp = a.output.with_suffix(a.output.suffix+".tmp")
            tmp.write_text(json.dumps(partial, indent=2)+"\n"); os.replace(tmp, a.output)
            del row, weights, target, gram, vec
        if not wanted:
            break
    if wanted:
        raise RuntimeError(f"Missing Mini IDs {sorted(wanted)}")
    ratios = np.asarray([r["paired_mse_ratio"] for r in records])
    result = {"method": "pilot-fitted degree-2 Gaussian Hermite controls in W0 input subspace",
              "dataset_revision": "v2-phase2", "gaussian_pairs_per_replicate": a.samples,
              "pilot_pairs": n, "evaluation_pairs": n, "replicates": a.replicates,
              "rank": a.rank, "ridge_fraction": a.ridge_fraction,
              "aggregate": {"mean_network_mse_ratio": float(ratios.mean()),
                            "median_network_mse_ratio": float(np.median(ratios)),
                            "networks_improved": int(np.sum(ratios < 1.0)),
                            "n_networks": len(records)}, "rows": records}
    tmp = a.output.with_suffix(a.output.suffix+".tmp")
    tmp.write_text(json.dumps(result, indent=2)+"\n"); os.replace(tmp, a.output)
    print(json.dumps(result["aggregate"], indent=2), flush=True)
    print(f"wrote {a.output}", flush=True)


if __name__ == "__main__":
    main()
