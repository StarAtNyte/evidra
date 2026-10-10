#!/usr/bin/env python3
"""Whole-network CV for a nonlinear terminal residual on frozen V30 features."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import lightgbm as lgb
import numpy as np


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--capture", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--folds", type=int, default=4)
    parser.add_argument("--seed", type=int, default=20261012)
    parser.add_argument("--trees", type=int, default=160)
    args = parser.parse_args()
    if args.folds < 2:
        raise SystemExit("folds must be >=2")

    with np.load(args.capture, allow_pickle=False) as data:
        ids = np.asarray(data["indices"], dtype=np.int64)
        x = np.asarray(data["features"], dtype=np.float32)
        base = np.asarray(data["candidate_prediction"], dtype=np.float64)
        target = np.asarray(data["target"], dtype=np.float64)
    if len(np.unique(ids)) != len(ids) or x.shape != (len(ids), 1024, 13):
        raise SystemExit("duplicate network IDs or unexpected V30 feature shape")
    if base.shape != target.shape or base.shape != (len(ids), 1024):
        raise SystemExit("prediction and target arrays do not align")
    if len(ids) < args.folds * 4:
        raise SystemExit("too few networks for grouped folds")

    rng = np.random.default_rng(args.seed)
    order = rng.permutation(len(ids))
    fold_of = np.empty(len(ids), dtype=np.int64)
    fold_of[order] = np.arange(len(ids)) % args.folds
    corrected = base.copy()
    fold_summaries = []
    for fold in range(args.folds):
        valid = fold_of == fold
        train = ~valid
        model = lgb.LGBMRegressor(
            objective="regression_l2", n_estimators=args.trees,
            learning_rate=0.035, num_leaves=15, max_depth=6,
            min_child_samples=384, reg_lambda=8.0,
            verbosity=-1, n_jobs=4, random_state=args.seed + fold,
        )
        model.fit(x[train].reshape(-1, 13), (target[train] - base[train]).reshape(-1))
        delta = model.predict(x[valid].reshape(-1, 13)).reshape(int(valid.sum()), 1024)
        corrected[valid] += delta
        fold_summaries.append({"fold": fold, "train_networks": int(train.sum()),
                               "validation_networks": int(valid.sum())})
        print(f"finished fold {fold + 1}/{args.folds}", flush=True)

    base_mse = np.mean((base - target) ** 2, axis=1)
    corrected_mse = np.mean((corrected - target) ** 2, axis=1)
    gains = (base_mse - corrected_mse) / base_mse
    bootstrap_rng = np.random.default_rng(args.seed + 1)
    draws = bootstrap_rng.integers(0, len(ids), size=(100_000, len(ids)))
    bootstrap_means = gains[draws].mean(axis=1)
    report = {
        "method": "LightGBM residual correction on frozen V30 13-feature outputs",
        "capture": str(args.capture),
        "network_ids": ids.tolist(),
        "fold_of_network": fold_of.tolist(),
        "folds": fold_summaries,
        "model": {"trees": args.trees, "learning_rate": 0.035, "num_leaves": 15,
                  "max_depth": 6, "min_child_samples": 384, "reg_lambda": 8.0},
        "baseline_mean_mse": float(base_mse.mean()),
        "corrected_mean_mse": float(corrected_mse.mean()),
        "mean_relative_mse_reduction": float(gains.mean()),
        "median_relative_mse_reduction": float(np.median(gains)),
        "improved_networks": int(np.sum(gains > 0)),
        "network_count": int(len(ids)),
        "bootstrap_seed": args.seed + 1,
        "bootstrap_draws": 100_000,
        "bootstrap_95pct_ci_mean_relative_reduction": np.quantile(bootstrap_means, [0.025, 0.975]).tolist(),
        "relative_mse_reduction_by_network": gains.tolist(),
        "decision": "screen only; do not submit without a separate fresh holdout and full official Mini validation",
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({k: v for k, v in report.items()
                      if k not in ("network_ids", "fold_of_network", "relative_mse_reduction_by_network")},
                     indent=2))


if __name__ == "__main__":
    main()
