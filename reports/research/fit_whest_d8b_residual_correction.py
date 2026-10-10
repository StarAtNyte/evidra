"""Grouped-by-network CV for a V30 terminal-feature residual correction.

Training targets come only from the independent D8b corpus. The fixed CV unit
is an entire MLP, never an individual neuron, to prevent within-network leakage.
This is a research screen; a positive result still requires official Mini
holdout and resource validation before packaging.
"""

from __future__ import annotations

import argparse
import itertools
import json
from pathlib import Path

import numpy as np


def polynomial_design(x: np.ndarray, degree: int) -> tuple[np.ndarray, list[tuple[int, ...]]]:
    blocks = [x]
    specs: list[tuple[int, ...]] = [(i,) for i in range(x.shape[1])]
    for order in range(2, degree + 1):
        combos = list(itertools.combinations_with_replacement(range(x.shape[1]), order))
        blocks.append(np.column_stack([np.prod(x[:, combo], axis=1) for combo in combos]))
        specs.extend(combos)
    return np.column_stack(blocks), specs


def network_mse(y: np.ndarray, delta: np.ndarray) -> np.ndarray:
    return np.mean((y - delta) ** 2, axis=1)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--capture", type=Path, required=True)
    parser.add_argument("--single-capture", type=Path, help="optional legacy one-row capture to prepend")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--folds", type=int, default=4)
    parser.add_argument("--degrees", type=int, nargs="+", default=[1, 2, 3])
    parser.add_argument("--alphas", type=float, nargs="+", default=[100.0, 1000.0, 10000.0])
    args = parser.parse_args()
    if args.folds < 2 or any(d < 1 or d > 4 for d in args.degrees):
        raise SystemExit("folds must be >=2; degrees must lie in [1,4]")

    blocks = []
    if args.single_capture:
        with np.load(args.single_capture, allow_pickle=False) as z:
            blocks.append({
                "indices": np.asarray([z["seed"]], dtype=np.int64),
                "features": z["features"][None, ...],
                "base_prediction": z["base_prediction"][None, ...],
                "target": z["target"][None, ...],
            })
    with np.load(args.capture, allow_pickle=False) as z:
        blocks.append({k: np.asarray(z[k]) for k in ("indices", "features", "base_prediction", "target")})
    ids = np.concatenate([b["indices"] for b in blocks]).astype(np.int64)
    x_net = np.concatenate([b["features"] for b in blocks]).astype(np.float64)
    base = np.concatenate([b["base_prediction"] for b in blocks]).astype(np.float64)
    target = np.concatenate([b["target"] for b in blocks]).astype(np.float64)
    if len(np.unique(ids)) != len(ids) or x_net.ndim != 3 or x_net.shape[1:] != (1024, 13):
        raise SystemExit("duplicate IDs or unexpected feature tensor shape")
    if base.shape != target.shape or base.shape != x_net.shape[:2]:
        raise SystemExit("base/target arrays do not align with per-neuron features")

    n = len(ids)
    if n < args.folds * 2:
        raise SystemExit(f"need at least {args.folds * 2} whole networks; found {n}")
    residual = target - base
    order = np.random.default_rng(20261010).permutation(n)
    fold_of = np.empty(n, dtype=np.int64)
    fold_of[order] = np.arange(n) % args.folds
    bootstrap_rng = np.random.default_rng(20261011)
    results = []
    best_model = None
    for degree in args.degrees:
        design_rows, terms = polynomial_design(x_net.reshape(-1, 13), degree)
        p = design_rows.shape[1]
        design_net = design_rows.reshape(n, 1024, p)
        for alpha in args.alphas:
            per_network = np.zeros(n, dtype=np.float64)
            gains = np.zeros(n, dtype=np.float64)
            for fold in range(args.folds):
                train_mask = fold_of != fold
                valid_mask = ~train_mask
                a = design_net[train_mask].reshape(-1, p)
                b = design_net[valid_mask].reshape(-1, p)
                y = residual[train_mask].reshape(-1)
                mu = a.mean(axis=0)
                scale = a.std(axis=0)
                scale[scale < 1e-10] = 1.0
                a = (a - mu) / scale
                b = (b - mu) / scale
                y_mean = float(y.mean())
                gram = a.T @ a
                coef = np.linalg.solve(gram + alpha * np.eye(p), a.T @ (y - y_mean))
                delta = (b @ coef + y_mean).reshape(int(valid_mask.sum()), 1024)
                baseline_loss = network_mse(target[valid_mask], base[valid_mask])
                corrected_loss = network_mse(target[valid_mask], base[valid_mask] + delta)
                per_network[valid_mask] = corrected_loss
                gains[valid_mask] = corrected_loss / baseline_loss - 1.0
            result = {
                "degree": degree,
                "alpha": alpha,
                "feature_count": p,
                "mean_relative_mse_change": float(gains.mean()),
                "median_relative_mse_change": float(np.median(gains)),
                "improved_networks": int(np.sum(gains < 0)),
                "n_networks": n,
                "bootstrap_95pct_ci_mean_relative_mse_change": np.quantile(
                    np.mean(gains[bootstrap_rng.integers(0, n, size=(10000, n))], axis=1),
                    [0.025, 0.975],
                ).tolist(),
                "per_network_relative_mse_change": gains.tolist(),
                "per_network_corrected_mse": per_network.tolist(),
            }
            results.append(result)
            if best_model is None or result["mean_relative_mse_change"] < best_model["score"]:
                # Fit the selected configuration on all independent networks.
                all_x = design_net.reshape(-1, p)
                all_y = residual.reshape(-1)
                mu = all_x.mean(axis=0)
                scale = all_x.std(axis=0)
                scale[scale < 1e-10] = 1.0
                normalized = (all_x - mu) / scale
                y_mean = float(all_y.mean())
                coef = np.linalg.solve(
                    normalized.T @ normalized + alpha * np.eye(p),
                    normalized.T @ (all_y - y_mean),
                )
                best_model = {"score": result["mean_relative_mse_change"], "degree": degree,
                              "alpha": alpha, "mu": mu, "scale": scale,
                              "y_mean": y_mean, "coef": coef, "terms": terms}
        print(f"finished degree {degree}; networks={n}; folds={args.folds}", flush=True)

    args.output.parent.mkdir(parents=True, exist_ok=True)
    report = {
        "method": "V30 13-feature polynomial ridge correction; whole-network grouped CV",
        "data_source": "independent public D8b corpus; no Whest Mini targets used in fitting",
        "network_ids": ids.tolist(),
        "fold_of_network": fold_of.tolist(),
        "folds": args.folds,
        "degrees": args.degrees,
        "alphas": args.alphas,
        "results": results,
        "selected": {k: best_model[k] for k in ("degree", "alpha", "score")},
        "screen_rule": "expand to a fresh D8b shard only if selected mean relative MSE change <= -0.01 and at least 62.5% of networks improve; this pilot never justifies submission",
        "warning": "small network count and N=1e8 label noise; exploratory CV, not submission evidence",
    }
    args.output.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    # V30's runtime unconditionally materializes the degree-3 design (559 cols).
    # Pad a lower-degree winner with zero coefficients so its deployed function
    # remains exactly the selected lower-degree model.
    full_width = sum(1 for _ in itertools.chain.from_iterable(
        itertools.combinations_with_replacement(range(13), order) for order in range(1, 4)
    ))
    model_mean = np.zeros(full_width, dtype=np.float64)
    model_scale = np.ones(full_width, dtype=np.float64)
    model_coef = np.zeros(full_width, dtype=np.float64)
    used = len(best_model["mu"])
    model_mean[:used] = best_model["mu"]
    model_scale[:used] = best_model["scale"]
    model_coef[:used] = best_model["coef"]
    np.savez_compressed(args.output.with_suffix(".model.npz"),
                        degree=np.asarray(best_model["degree"]), alpha=np.asarray(best_model["alpha"]),
                        mean=model_mean, scale=model_scale,
                        y_mean=np.asarray(best_model["y_mean"]), coef=model_coef)
    print(json.dumps(report["selected"], indent=2), flush=True)


if __name__ == "__main__":
    main()
