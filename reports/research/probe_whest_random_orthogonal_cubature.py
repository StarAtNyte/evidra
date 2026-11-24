#!/usr/bin/env python3
"""Test a cheap antithetic orthogonal spherical rule against the V29 baseline.

The method uses only current-network weights and a deterministic seed derived
from that network. Ground-truth targets are consulted only after predictions
are fixed, for diagnostic scoring. The support is +/- one random orthonormal
basis (2*n points), with the exact Gaussian radial factor for bias-free
homogeneous ReLU networks.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
from pathlib import Path

import numpy as np
import pyarrow.parquet as pq

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_CAPTURE = ROOT / ".sota/tmp/v29-final-features-confirm-80-99.npz"
DEFAULT_DATA = ROOT / "competitions/whestbench/starterkit/.whest-data/data"


def chi_mean(n: int) -> float:
    return math.sqrt(2.0) * math.exp(
        math.lgamma((n + 1.0) / 2.0) - math.lgamma(n / 2.0)
    )


def predict(weights: np.ndarray, seed: int) -> np.ndarray:
    depth, width, _ = weights.shape
    rng = np.random.default_rng(seed)
    raw = rng.standard_normal((width, width), dtype=np.float32)
    q, _ = np.linalg.qr(raw)
    # Samples are row vectors +/- q.T; this is a 2-design with exact
    # antipodal pairing, not a claim of high-strength cubature.
    state = np.concatenate((q.T, -q.T), axis=0).astype(np.float32, copy=False)
    for w in weights:
        state = state @ w
        np.maximum(state, 0.0, out=state)
    return (state.mean(axis=0, dtype=np.float64) * chi_mean(width)).astype(np.float32)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--capture", type=Path, default=DEFAULT_CAPTURE)
    ap.add_argument("--parquet-dir", type=Path, default=DEFAULT_DATA)
    ap.add_argument("--start", type=int, default=80)
    ap.add_argument("--end", type=int, default=100)
    ap.add_argument("--output", type=Path)
    args = ap.parse_args()
    if not 0 <= args.start < args.end <= 100:
        ap.error("require 0 <= start < end <= 100")

    with np.load(args.capture, allow_pickle=False) as z:
        ids = z["ids"].astype(int)
        seeds = z["seeds"].astype(np.uint64)
        base = z["predictions"].astype(np.float64)
        truth = z["targets"].astype(np.float64)
    index = {int(v): i for i, v in enumerate(ids)}
    seed_by_id = {int(mlp_id): int(seeds[i]) for i, mlp_id in enumerate(ids)}
    requested = set(range(args.start, args.end))
    records: list[dict[str, float | int]] = []
    base_errors: list[np.ndarray] = []
    correction_directions: list[np.ndarray] = []
    for path in sorted(args.parquet_dir.glob("mini-*.parquet")):
        for batch in pq.ParquetFile(path).iter_batches(
            batch_size=1, columns=["mlp_id", "weights"]
        ):
            mlp_id = int(batch.column("mlp_id")[0].as_py())
            if mlp_id not in requested:
                continue
            if mlp_id not in index:
                raise ValueError(f"capture lacks requested ID {mlp_id}")
            seed = seed_by_id[mlp_id]
            raw = batch.column("weights")[0].as_py()
            w = np.asarray(raw, dtype=np.float32).reshape(16, 1024, 1024)
            cub = predict(w, seed ^ 0x6A09E667F3BCC909)
            i = index[mlp_id]
            err_base = truth[i] - base[i]
            err_cub = truth[i] - cub.astype(np.float64)
            base_errors.append(err_base)
            correction_directions.append(cub.astype(np.float64) - base[i])
            records.append({
                "id": mlp_id,
                "base_mse": float(np.mean(err_base * err_base)),
                "cubature_mse": float(np.mean(err_cub * err_cub)),
                "residual_correlation": float(np.corrcoef(err_base, err_cub)[0, 1]),
                "base_to_cubature_mse_ratio": float(np.mean(err_base * err_base) /
                                                      max(np.mean(err_cub * err_cub), 1e-30)),
            })
            print(f"id={mlp_id} base={records[-1]['base_mse']:.6g} "
                  f"cubature={records[-1]['cubature_mse']:.6g} "
                  f"corr={records[-1]['residual_correlation']:.4f}", flush=True)
            del w, raw, cub
            if len(records) == len(requested):
                break
        if len(records) == len(requested):
            break
    if {int(r["id"]) for r in records} != requested:
        raise RuntimeError("missing requested rows")

    eb = np.concatenate(base_errors)
    dc = np.concatenate(correction_directions)
    beta_oracle = float(np.dot(eb, dc) / max(float(np.dot(dc, dc)), 1e-30))
    oracle_blend_mse = float(np.mean((eb - beta_oracle * dc) ** 2))

    result = {
        "experiment": "random orthogonal antipodal spherical 2-design",
        "scope": "diagnostic only; no candidate coefficient fit",
        "ids": sorted(requested),
        "capture_sha256": hashlib.sha256(args.capture.read_bytes()).hexdigest(),
        "rows": records,
        "mean_base_mse": float(np.mean([r["base_mse"] for r in records])),
        "mean_cubature_mse": float(np.mean([r["cubature_mse"] for r in records])),
        "mean_residual_correlation": float(np.mean([r["residual_correlation"] for r in records])),
        "oracle_blend_beta_on_diagnostic_ids": beta_oracle,
        "oracle_blend_mse_on_diagnostic_ids": oracle_blend_mse,
        "oracle_blend_is_not_deployable": True,
        "radial_factor": chi_mean(1024),
    }
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps({k: result[k] for k in (
        "experiment", "mean_base_mse", "mean_cubature_mse",
        "mean_residual_correlation", "oracle_blend_beta_on_diagnostic_ids",
        "oracle_blend_mse_on_diagnostic_ids", "radial_factor")}, indent=2))


if __name__ == "__main__":
    main()
