#!/usr/bin/env python3
"""Small sequential fit-on-corrected-prefix pilot for ARC WhestBench Phase 2.

Example (from repository root):
  python reports/research/probe_whest_sequential_dagger.py --data PATH/mini.parquet

Fits only the requested training IDs, then scores disjoint validation IDs. This is a
diagnostic pilot, not a submission or a full-split evaluation.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
import time
from pathlib import Path

import numpy as np
import pyarrow.parquet as pq
import torch

ROOT = Path(__file__).resolve().parents[2]
LEAN = ROOT / ".sota/research/whest-p2-cumulant-k3/lean"
sys.path[:0] = [
    str(ROOT / ".sota/tmp/whest-pydeps"),
    str(ROOT / ".sota/vendor/mlp_cumulant_propagation/src"),
    str(LEAN),
]
import lean_k3_aug as chain  # noqa: E402


def fit_layer(features: np.ndarray, residual: np.ndarray, ridge: float) -> np.ndarray:
    """Standardized ridge with an unpenalized intercept folded into the constant feature."""
    x = features.reshape(-1, features.shape[-1]).astype(np.float64)
    y = residual.reshape(-1).astype(np.float64)
    mean = x.mean(axis=0)
    scale = x.std(axis=0)
    scale[scale < 1e-12] = 1.0
    z = (x - mean) / scale
    design = np.column_stack((z, np.ones(len(z))))
    penalty = np.eye(design.shape[1]) * ridge
    penalty[-1, -1] = 0.0
    coef = np.linalg.solve(design.T @ design + penalty, design.T @ y)
    beta = np.zeros(x.shape[1], dtype=np.float64)
    beta[:] = coef[:-1] / scale
    beta[0] += coef[-1] - mean @ beta  # feature 0 is identically one
    return beta


def predict(weights: np.ndarray, beta: np.ndarray | None, statics):
    kw = {} if beta is None else {"mean_corr": torch.as_tensor(beta, dtype=torch.float32)}
    pred, feats, _ = chain.lean_k3_predict(
        weights, statics=statics, dtype=torch.float32, collect_feats=True, **kw
    )
    return pred.numpy().astype(np.float64), feats.numpy().astype(np.float64)


def final_mse(pred: np.ndarray, target: np.ndarray) -> float:
    return float(np.mean((pred[-1] - target[-1]) ** 2))


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", type=Path, required=True, help="public mini parquet containing IDs 80–83")
    ap.add_argument("--train-ids", type=int, nargs="+", default=[80, 81])
    ap.add_argument("--validation-ids", type=int, nargs="+", default=[82, 83])
    ap.add_argument("--fit-layers", type=int, default=3,
                    help="number of layers to fit sequentially (1..network depth)")
    ap.add_argument("--ridge", type=float, default=1e-2)
    ap.add_argument("--fit-only", action="store_true",
                    help="fit and save coefficients without rerunning baseline/corrected scoring")
    args = ap.parse_args()
    torch.set_num_threads(1)
    torch.set_grad_enabled(False)

    data_path = args.data.resolve()
    raw = pq.read_table(data_path).sort_by("mlp_id").to_pylist()
    rows = {
        int(r["mlp_id"]): (np.asarray(r["weights"], dtype=np.float32),
                           np.asarray(r["all_layer_means"], dtype=np.float32))
        for r in raw
    }
    needed = set(args.train_ids + args.validation_ids)
    if not needed.issubset(rows):
        raise SystemExit(f"missing requested IDs: {sorted(needed - rows.keys())}")
    if set(args.train_ids) & set(args.validation_ids):
        raise SystemExit("train and validation IDs must be disjoint")
    first_weights = rows[args.train_ids[0]][0]
    depth, width = first_weights.shape[:2]
    if args.fit_layers < 1 or args.fit_layers > depth:
        raise SystemExit(f"fit-layers must be in [1, {depth}] for this network")
    statics = chain.build_static_coefs(width)
    beta = np.zeros((depth, 13), dtype=np.float64)
    start = time.time()

    # True sequential DAgger structure: at step l, roll each train net through the
    # already-fitted prefix beta[:l], gather fresh features at l, fit only beta[l].
    fit_log = []
    for layer in range(args.fit_layers):
        xs, ys = [], []
        for mid in args.train_ids:
            weights, target = rows[mid]
            pred, feats = predict(weights[:layer + 1], beta[:layer + 1], statics)
            xs.append(feats[layer])
            ys.append(target[layer].astype(np.float64) - pred[layer])
        beta[layer] = fit_layer(np.stack(xs), np.stack(ys), args.ridge)
        fit_log.append({"layer": layer, "train_ids": args.train_ids,
                        "residual_rmse_after_fit": float(np.sqrt(np.mean(np.square(
                            np.concatenate(ys) - np.concatenate(xs).reshape(-1, 13) @ beta[layer]
                        ))))})
        print(f"fit layer={layer} on corrected prefix; coefficient_norm={np.linalg.norm(beta[layer]):.4g}",
              flush=True)

    results = []
    if not args.fit_only:
        for split, ids in (("train", args.train_ids), ("validation", args.validation_ids)):
            for mid in ids:
                weights, target = rows[mid]
                base, _ = predict(weights, None, statics)
                corrected, _ = predict(weights, beta, statics)
                row = {"split": split, "mlp_id": mid,
                       "baseline_final_mse": final_mse(base, target),
                       "sequential_prefix_final_mse": final_mse(corrected, target)}
                row["ratio"] = row["sequential_prefix_final_mse"] / row["baseline_final_mse"]
                results.append(row)
                print(json.dumps(row), flush=True)
    val = [r for r in results if r["split"] == "validation"]
    report = {
        "method": "sequential layerwise fit on rollouts with prior fitted prefix applied",
        "objective": "local mean residual per layer; final-layer MSE is held-out diagnostic",
        "data_path": str(data_path),
        "data_sha256": hashlib.sha256(data_path.read_bytes()).hexdigest(),
        "train_ids": args.train_ids, "validation_ids": args.validation_ids,
        "fit_layers": args.fit_layers, "ridge": args.ridge,
        "fit_log": fit_log, "per_mlp": results,
        "validation_mean_ratio": (float(np.mean([r["ratio"] for r in val])) if val else None),
        "coefficients": beta.tolist(),
        "elapsed_sec": time.time() - start,
    }
    print(json.dumps(report, indent=2), flush=True)
    out = ROOT / ".sota/tmp/whest_sequential_dagger_pilot.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(report, indent=2) + "\n")


if __name__ == "__main__":
    main()
