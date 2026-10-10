#!/usr/bin/env python3
"""Grouped leave-one-network-out screen for Lyapunov projected features.

The JSON inputs contain target-independent projected feature Gram matrices and
feature/residual cross-products. Targets are used only in this offline grouped
CV diagnostic. No per-neuron coefficient can leak across a held-out network.
"""

from __future__ import annotations

import argparse
import glob
import json
from pathlib import Path

import numpy as np


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--pattern", default=".sota/runs/whest-lyapunov-full-id*-20261010.json")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--seed", type=int, default=20261010)
    parser.add_argument("--bootstrap", type=int, default=100_000)
    args = parser.parse_args()

    paths = sorted(glob.glob(args.pattern))
    rows = [json.loads(Path(path).read_text(encoding="utf-8")) for path in paths]
    if len(rows) < 8:
        raise SystemExit(f"need at least 8 independent networks, found {len(rows)}")
    ids = [int(row["network_id"]) for row in rows]
    if len(ids) != len(set(ids)):
        raise SystemExit("duplicate network IDs in grouped CV inputs")

    grams = np.asarray([row["projected_feature_gram"] for row in rows], dtype=np.float64)
    crosses = np.asarray([row["projected_feature_residual_cross"] for row in rows], dtype=np.float64)
    residual_ss = np.asarray([row["residual_mse"] for row in rows], dtype=np.float64) * 1024
    if grams.ndim != 3 or grams.shape[1] != grams.shape[2] or crosses.shape != grams.shape[:2]:
        raise SystemExit("inconsistent sufficient-statistic shapes")

    lambdas = np.logspace(-6, 3, 40)

    def fit(train: list[int], ridge: float) -> np.ndarray:
        gram = grams[train].sum(axis=0)
        cross = crosses[train].sum(axis=0)
        diagonal = np.maximum(np.diag(gram), np.finfo(np.float64).tiny)
        return np.linalg.solve(gram + ridge * np.diag(diagonal), cross)

    def relative_mse_reduction(i: int, coefficient: np.ndarray) -> float:
        delta_ss = 2 * coefficient @ crosses[i] - coefficient @ grams[i] @ coefficient
        return float(delta_ss / residual_ss[i])

    heldout_gains: list[float] = []
    selected_lambdas: list[float] = []
    for heldout in range(len(rows)):
        outer_train = [i for i in range(len(rows)) if i != heldout]
        inner_scores = []
        for ridge in lambdas:
            fold_gains = []
            for inner_valid in outer_train:
                inner_train = [i for i in outer_train if i != inner_valid]
                fold_gains.append(relative_mse_reduction(inner_valid, fit(inner_train, float(ridge))))
            inner_scores.append(float(np.mean(fold_gains)))
        ridge = float(lambdas[int(np.argmax(inner_scores))])
        selected_lambdas.append(ridge)
        heldout_gains.append(relative_mse_reduction(heldout, fit(outer_train, ridge)))

    gains = np.asarray(heldout_gains)
    rng = np.random.default_rng(args.seed)
    draws = rng.integers(0, len(gains), size=(args.bootstrap, len(gains)))
    bootstrap_means = gains[draws].mean(axis=1)
    output = {
        "method": "nested grouped leave-one-network-out ridge on 13 Lyapunov-projected features",
        "input_files": paths,
        "network_ids": ids,
        "network_count": len(rows),
        "feature_count": int(grams.shape[1]),
        "ridge_grid": [float(x) for x in lambdas],
        "selected_ridge_by_outer_fold": selected_lambdas,
        "relative_mse_reduction_by_network": gains.tolist(),
        "mean_relative_mse_reduction": float(gains.mean()),
        "median_relative_mse_reduction": float(np.median(gains)),
        "positive_networks": int(np.sum(gains > 0)),
        "bootstrap": {
            "seed": args.seed,
            "draws": args.bootstrap,
            "mean_95pct_interval": np.quantile(bootstrap_means, [0.025, 0.975]).tolist(),
            "fraction_positive": float(np.mean(bootstrap_means > 0)),
        },
        "decision": "reject for candidate promotion; grouped-CV gain is too small and uncertain",
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(output, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(output, indent=2))


if __name__ == "__main__":
    main()
