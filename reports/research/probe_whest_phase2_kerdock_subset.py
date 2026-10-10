#!/usr/bin/env python3
"""Screen a small, seed-selected Kerdock/MUB subset on Phase-2 Mini networks.

This is a research-only quadrature probe, not a submission estimator. It uses
only current MLP weights and the public MLP seed to select bases. Mini targets
are consulted only after predictions are frozen, for paired diagnostics and a
network-disjoint residual-blend screen.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import time
from pathlib import Path

import numpy as np
import pyarrow.parquet as pq

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_CAPTURE = ROOT / ".sota/tmp/v29-final-features-confirm-80-99.npz"
DEFAULT_DATA = ROOT / "competitions/whestbench/starterkit/.whest-data/data"
FIELD = 512  # GF(2^9), modulus x^9 + x + 1 (0x203)
WIDTH = 1024


def gf_mul(a: int, b: int) -> int:
    out = 0
    while b:
        if b & 1:
            out ^= a
        b >>= 1
        carry = a & 0x100
        a = (a << 1) & 0x1FF
        if carry:
            a ^= 0x03
    return out


def gf_square(a: int) -> int:
    return gf_mul(a, a)


def gf_pow(a: int, exponent: int) -> int:
    out = 1
    while exponent:
        if exponent & 1:
            out = gf_mul(out, a)
        a = gf_square(a)
        exponent >>= 1
    return out


def gf_trace(a: int) -> int:
    out = a
    term = a
    for _ in range(1, 9):
        term = gf_square(term)
        out ^= term
    if out not in (0, 1):
        raise ValueError(f"GF(512) trace escaped GF(2): {out}")
    return out


def chirp(u: int) -> np.ndarray:
    """A binary Kerdock chirp indexed by GF(512), on GF(512) x GF(2)."""
    coords = np.arange(WIDTH, dtype=np.int32)
    x = coords & 0x1FF
    xn = coords >> 9
    ux = np.fromiter((gf_mul(u, int(v)) for v in x), dtype=np.int32, count=WIDTH)
    quadratic = np.zeros(WIDTH, dtype=np.int32)
    for j in range(1, 5):
        term = np.fromiter(
            (gf_pow(int(v), (1 << j) + 1) for v in ux),
            dtype=np.int32,
            count=WIDTH,
        )
        quadratic ^= term
    trace_ux = np.fromiter((gf_trace(int(v)) for v in ux), dtype=np.int32, count=WIDTH)
    bits = np.fromiter(
        (gf_trace(int(v)) for v in quadratic), dtype=np.int32, count=WIDTH
    ) ^ (xn * trace_ux)
    return (1 - 2 * bits).astype(np.float32)


def walsh() -> np.ndarray:
    idx = np.arange(WIDTH, dtype=np.int32)
    parity = np.fromiter((int(v).bit_count() & 1 for v in idx), dtype=np.int8)
    return (1 - 2 * parity[np.bitwise_and(idx[:, None], idx[None, :])]).astype(np.float32)


def chi_mean(width: int) -> float:
    return math.sqrt(2.0) * math.exp(
        math.lgamma((width + 1.0) / 2.0) - math.lgamma(width / 2.0)
    )


def predict(weights: np.ndarray, mlp_seed: int, n_bases: int) -> tuple[np.ndarray, list[int]]:
    rng = np.random.default_rng(int(mlp_seed) ^ 0xA4093822299F31D0)
    selected = sorted(int(v) for v in rng.choice(FIELD, n_bases, replace=False))
    h = walsh()
    blocks = []
    for u in selected:
        b = h * chirp(u)[None, :]
        blocks.extend((b, -b))
    points = np.concatenate(blocks, axis=0)
    points *= np.float32(chi_mean(WIDTH) / math.sqrt(WIDTH))
    state = points
    for w in weights:
        state = np.maximum(state @ w, 0.0)
    return state.mean(axis=0, dtype=np.float64).astype(np.float32), selected


def load_rows(parquet_dir: Path, wanted: set[int]):
    found = {}
    for path in sorted(parquet_dir.glob("mini-*.parquet")):
        pf = pq.ParquetFile(path)
        for batch in pf.iter_batches(batch_size=1, columns=["mlp_id", "weights"]):
            mlp_id = int(batch.column("mlp_id")[0].as_py())
            if mlp_id not in wanted:
                continue
            raw = batch.column("weights")[0].as_py()
            found[mlp_id] = np.asarray(raw, dtype=np.float32).reshape(16, WIDTH, WIDTH)
            if found.keys() >= wanted:
                return found
    if found.keys() != wanted:
        raise RuntimeError(f"missing requested Mini IDs: {sorted(wanted - found.keys())}")
    return found


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--capture", type=Path, default=DEFAULT_CAPTURE)
    ap.add_argument("--parquet-dir", type=Path, default=DEFAULT_DATA)
    ap.add_argument("--start", type=int, default=80)
    ap.add_argument("--end", type=int, default=84)
    ap.add_argument("--bases", type=int, default=4)
    ap.add_argument("--output", type=Path, required=True)
    args = ap.parse_args()
    if not (0 <= args.start < args.end <= 100 and 1 <= args.bases <= FIELD):
        ap.error("need 0 <= start < end <= 100 and 1 <= bases <= 512")

    with np.load(args.capture, allow_pickle=False) as z:
        ids = np.asarray(z["ids"], dtype=np.int64)
        seeds = np.asarray(z["seeds"], dtype=np.uint64)
        base = np.asarray(z["predictions"], dtype=np.float64)
        truth = np.asarray(z["targets"], dtype=np.float64)
    at = {int(v): i for i, v in enumerate(ids)}
    requested = set(range(args.start, args.end))
    if not requested.issubset(at):
        raise ValueError("capture does not cover requested IDs")
    weights = load_rows(args.parquet_dir, requested)
    records = []
    predictions = {}
    start_all = time.perf_counter()
    for mlp_id in sorted(requested):
        i = at[mlp_id]
        start = time.perf_counter()
        pred, selected = predict(weights[mlp_id], int(seeds[i]), args.bases)
        elapsed = time.perf_counter() - start
        predictions[mlp_id] = pred.astype(np.float64)
        e_base = truth[i] - base[i]
        e_quad = truth[i] - predictions[mlp_id]
        records.append({
            "id": mlp_id,
            "bases": selected,
            "base_mse": float(np.mean(e_base * e_base)),
            "quadrature_mse": float(np.mean(e_quad * e_quad)),
            "error_correlation": float(np.corrcoef(e_base, e_quad)[0, 1]),
            "seconds": elapsed,
        })
        print(json.dumps(records[-1]), flush=True)
        del weights[mlp_id]

    cut = args.start + (args.end - args.start) // 2
    train_ids = sorted(i for i in requested if i < cut)
    test_ids = sorted(i for i in requested if i >= cut)
    if not train_ids or not test_ids:
        raise ValueError("need at least one training and one held-out network")
    train_base_error = np.concatenate([truth[at[i]] - base[at[i]] for i in train_ids])
    train_delta = np.concatenate([predictions[i] - base[at[i]] for i in train_ids])
    alpha = float(np.dot(train_base_error, train_delta) /
                  max(float(np.dot(train_delta, train_delta)), 1e-30))
    held_base = np.concatenate([truth[at[i]] - base[at[i]] for i in test_ids])
    held_delta = np.concatenate([predictions[i] - base[at[i]] for i in test_ids])
    out = {
        "experiment": "seed-selected partial Kerdock/MUB antipodal quadrature",
        "status": "research screen; no submission candidate",
        "ids": sorted(requested),
        "n_bases": args.bases,
        "rows_per_network": 2 * args.bases * WIDTH,
        "estimated_dense_forward_flops_per_network": int(4 * args.bases * WIDTH * WIDTH * WIDTH * 16),
        "heldout_ids": test_ids,
        "training_ids": train_ids,
        "training_fitted_blend_alpha": alpha,
        "heldout_base_mse": float(np.mean(held_base * held_base)),
        "heldout_blended_mse": float(np.mean((held_base - alpha * held_delta) ** 2)),
        "mean_base_mse": float(np.mean([r["base_mse"] for r in records])),
        "mean_quadrature_mse": float(np.mean([r["quadrature_mse"] for r in records])),
        "elapsed_total_s": time.perf_counter() - start_all,
        "capture_sha256": hashlib.sha256(args.capture.read_bytes()).hexdigest(),
        "rows": records,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(out, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({k: out[k] for k in (
        "n_bases", "rows_per_network", "estimated_dense_forward_flops_per_network",
        "training_fitted_blend_alpha", "heldout_base_mse", "heldout_blended_mse",
        "mean_quadrature_mse", "elapsed_total_s")}, indent=2))


if __name__ == "__main__":
    main()
