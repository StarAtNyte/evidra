#!/usr/bin/env python3
"""Measure shared-residual oracle ceiling vs per-network weight-only output bases.

Residual-derived bases use IDs 0-79 only; all reported transfer metrics are on
the disjoint 80-99 holdout. Per-network bases use that network's final weights
only. Targets are used solely for residual diagnostics, never to choose those
weight-derived bases.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

import numpy as np
import pyarrow.parquet as pq

ROOT = Path(__file__).resolve().parents[2]
DATA = ROOT / "competitions/whestbench/starterkit/.whest-data/data"


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def load_capture(path: Path) -> dict[str, np.ndarray]:
    z = np.load(path)
    return {k: z[k] for k in z.files}


def energy_fraction(residual: np.ndarray, basis: np.ndarray, rank: int) -> float:
    q = basis[:, :rank]
    projected = residual @ q @ q.T
    return float(np.sum(projected.astype(np.float64)**2) /
                 max(float(np.sum(residual.astype(np.float64)**2)), 1e-30))


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--train", type=Path,
                    default=ROOT / ".sota/tmp/v29-final-features-train-0-79.npz")
    ap.add_argument("--test", type=Path,
                    default=ROOT / ".sota/tmp/v29-final-features-confirm-80-99.npz")
    ap.add_argument("--output", type=Path,
                    default=ROOT / ".sota/tmp/whest-residual-subspace-ceiling.json")
    ap.add_argument("--ranks", type=int, nargs="+", default=[1, 2, 4, 8, 16, 32, 64])
    a = ap.parse_args()
    tr, te = load_capture(a.train), load_capture(a.test)
    if not np.array_equal(tr["ids"], np.arange(80)):
        raise ValueError("train capture must contain exactly IDs 0..79")
    if not np.array_equal(te["ids"], np.arange(80, 100)):
        raise ValueError("test capture must contain exactly IDs 80..99")
    r_train = (tr["targets"] - tr["predictions"]).astype(np.float64)
    r_test = (te["targets"] - te["predictions"]).astype(np.float64)

    # Shared oracle basis is learned using training residuals only.
    _, singular, vt = np.linalg.svd(r_train, full_matrices=False)
    shared_q = vt.T

    # Per-network basis from the final affine map, using weights only.
    ids_needed = set(map(int, te["ids"]))
    weight_bases: dict[int, np.ndarray] = {}
    for path in sorted(DATA.glob("mini-*.parquet")):
        for batch in pq.ParquetFile(path).iter_batches(
                batch_size=1, columns=["mlp_id", "weights"]):
            idx = int(batch.column("mlp_id")[0].as_py())
            if idx not in ids_needed:
                continue
            raw = batch.column("weights")[0].as_py()
            w = np.asarray(raw, dtype=np.float64).reshape(16, 1024, 1024)
            # x @ W maps input coordinates to output coordinates W.T @ x.
            _, _, vt_w = np.linalg.svd(w[-1], full_matrices=False)
            weight_bases[idx] = vt_w.T
            ids_needed.remove(idx)
            del w, raw
        if not ids_needed:
            break
    if ids_needed:
        raise RuntimeError(f"Missing Mini weight rows: {sorted(ids_needed)}")

    by_id = {int(idx): i for i, idx in enumerate(te["ids"])}
    rows = []
    for rank in a.ranks:
        if not 1 <= rank <= 1024:
            raise ValueError(f"invalid rank {rank}")
        shared = [energy_fraction(r, shared_q, rank) for r in r_test]
        weight = [energy_fraction(r_test[by_id[idx]], weight_bases[idx], rank)
                  for idx in sorted(weight_bases)]
        rows.append({"rank": rank,
                     "shared_residual_oracle_mean_fraction": float(np.mean(shared)),
                     "shared_residual_oracle_median_fraction": float(np.median(shared)),
                     "weight_only_final_layer_mean_fraction": float(np.mean(weight)),
                     "weight_only_final_layer_median_fraction": float(np.median(weight))})
    result = {
        "experiment": "held-out V29 residual subspace ceiling",
        "dataset_revision": "v2-phase2 Mini",
        "train_ids": [0, 79], "test_ids": [80, 99],
        "train_capture_sha256": sha256(a.train), "test_capture_sha256": sha256(a.test),
        "train_capture_metadata": str(tr["metadata"].item()),
        "test_capture_metadata": str(te["metadata"].item()),
        "source_identity_caveat": "Capture report notes local V29 source hash differs from historical archive member hash; this is a diagnostic on the captured local variant, not a verified archive reproduction.",
        "train_residual_singular_values_first_10": singular[:10].tolist(),
        "rank_results": rows,
        "interpretation": "Shared-residual basis is an oracle upper bound learned from training targets; final-layer SVD bases use held-out weights only. Projection energy is diagnostic, not an achievable score gain; estimating signed coefficients remains a separate requirement.",
    }
    a.output.parent.mkdir(parents=True, exist_ok=True)
    a.output.write_text(json.dumps(result, indent=2)+"\n")
    print(json.dumps({"rank_results": rows,
                      "capture_hashes": [result["train_capture_sha256"], result["test_capture_sha256"]]}, indent=2))
    print(f"wrote {a.output}")


if __name__ == "__main__":
    main()
