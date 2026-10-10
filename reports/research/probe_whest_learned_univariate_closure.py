#!/usr/bin/env python3
"""Screen a learned terminal ReLU closure on the public D8b corpus.

This first gate uses the corpus's previous-layer marginal moments as an oracle
to isolate whether target-free, independent-sum cumulant features contain a
learnable correction signal at the terminal layer. Entire MLPs, never neurons,
are assigned to train or validation. Passing this gate is necessary, not
sufficient: deployment must replace oracle hidden moments with estimator state.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
from pathlib import Path

import numpy as np
import torch
from lightgbm import LGBMRegressor
from scipy.special import ndtr


def make_features(idx: int, raw: np.ndarray, seed0: int = 770000) -> tuple[np.ndarray, np.ndarray, str]:
    """Return standardized independent-sum features and an analytic Gaussian mean."""
    generator = torch.Generator(device="cpu").manual_seed(seed0 + idx)
    weights = torch.randn((16, 1024, 1024), generator=generator, dtype=torch.float32)
    weights.mul_(math.sqrt(2.0 / 1024.0))
    weight_hash = hashlib.sha256(weights.numpy().tobytes()).hexdigest()
    w = weights[-1].numpy().astype(np.float64, copy=False)

    m1, m2, m3, m4 = (raw[k].astype(np.float64, copy=False) for k in range(4))
    k2 = np.maximum(m2 - m1 * m1, 0.0)
    k3 = m3 - 3.0 * m2 * m1 + 2.0 * m1**3
    k4 = m4 - 4.0 * m3 * m1 - 3.0 * m2**2 + 12.0 * m2 * m1**2 - 6.0 * m1**4

    mu = w.T @ m1
    var = (w * w).T @ k2
    kap3 = (w**3).T @ k3
    kap4 = (w**4).T @ k4
    sigma = np.sqrt(np.maximum(var, 1e-14))
    z = mu / sigma
    skew = kap3 / sigma**3
    excess = kap4 / sigma**4
    phi = np.exp(-0.5 * np.clip(z, -40, 40) ** 2) / math.sqrt(2.0 * math.pi)
    gaussian_relu = sigma * (phi + z * ndtr(z))
    features = np.stack((z, skew, excess, np.log(sigma), gaussian_relu / sigma), axis=1)
    return features.astype(np.float32), gaussian_relu, weight_hash


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--data-dir", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--seed", type=int, default=20261010)
    parser.add_argument("--holdout-fraction", type=float, default=0.25)
    args = parser.parse_args()

    records = []
    for path in sorted(args.data_dir.glob("shard*.npz")):
        with np.load(path, allow_pickle=False) as data:
            indices = np.asarray(data["idx"], dtype=np.int64)
            moments = np.asarray(data["moments"], dtype=np.float32)
            targets = np.asarray(data["final_mean"], dtype=np.float64)
        for row, idx in enumerate(indices):
            records.append((int(idx), moments[row, :, 14, :], targets[row]))
    if len(records) < 64:
        raise SystemExit(f"need >=64 complete MLPs, found {len(records)}")

    records.sort(key=lambda row: row[0])
    ids = np.asarray([row[0] for row in records], dtype=np.int64)
    rng = np.random.default_rng(args.seed)
    order = rng.permutation(len(ids))
    n_holdout = max(16, int(round(len(ids) * args.holdout_fraction)))
    holdout_rows = set(order[:n_holdout].tolist())

    cache_path = args.output.with_suffix(".features.npz")
    target = np.concatenate([row[2] for row in records])
    if cache_path.exists():
        with np.load(cache_path, allow_pickle=False) as cache:
            if not np.array_equal(cache["indices"], ids):
                raise SystemExit("feature cache network IDs do not match the loaded shards")
            x = np.asarray(cache["features"], dtype=np.float32)
            y = np.asarray(cache["normalized_residual"], dtype=np.float32)
            base = np.asarray(cache["gaussian_base"], dtype=np.float64)
            hash_rows = np.asarray(cache["weight_sha256"]).astype(str).tolist()
    else:
        x_rows, y_rows, base_rows, hash_rows = [], [], [], []
        for row, (idx, raw, net_target) in enumerate(records):
            feats, gaussian_base, weight_hash = make_features(idx, raw)
            x_rows.append(feats)
            y_rows.append((net_target - gaussian_base) / np.maximum(np.abs(gaussian_base), 0.15))
            base_rows.append(gaussian_base)
            hash_rows.append(weight_hash)
            if (row + 1) % 32 == 0:
                print(f"features {row + 1}/{len(records)}", flush=True)
        x = np.concatenate(x_rows)
        y = np.concatenate(y_rows)
        base = np.concatenate(base_rows)
        cache_path.parent.mkdir(parents=True, exist_ok=True)
        np.savez_compressed(cache_path, indices=ids, features=x, normalized_residual=y,
                            gaussian_base=base, weight_sha256=np.asarray(hash_rows))

    row_ids = np.repeat(np.arange(len(ids)), 1024)
    train_mask = ~np.isin(row_ids, np.fromiter(holdout_rows, dtype=np.int64))
    valid_mask = ~train_mask

    model = LGBMRegressor(
        objective="regression_l2", n_estimators=240, learning_rate=0.035,
        num_leaves=15, max_depth=6, min_child_samples=512,
        reg_lambda=8.0, verbosity=-1, n_jobs=4, random_state=args.seed,
    )
    model.fit(x[train_mask], y[train_mask])
    model_path = args.output.with_suffix(".lgbm.txt")
    model.booster_.save_model(str(model_path))
    corrected = base.copy()
    corrected[valid_mask] += model.predict(x[valid_mask]) * np.maximum(np.abs(base[valid_mask]), 0.15)

    def mse(values: np.ndarray) -> float:
        return float(np.mean((values[valid_mask] - target[valid_mask]) ** 2))

    valid_networks = np.unique(row_ids[valid_mask])
    per_network = []
    for net in valid_networks:
        mask = row_ids[valid_mask] == net
        base_mse = float(np.mean((base[valid_mask][mask] - target[valid_mask][mask]) ** 2))
        model_mse = float(np.mean((corrected[valid_mask][mask] - target[valid_mask][mask]) ** 2))
        per_network.append({"idx": int(ids[net]), "base_mse": base_mse,
                            "corrected_mse": model_mse,
                            "relative_reduction": (base_mse - model_mse) / base_mse})

    result = {
        "method": "LightGBM correction to independent-sum Gaussian terminal ReLU closure",
        "feature_definition": ["mu_z/sigma_z", "standardized_kappa3", "standardized_kappa4",
                               "log_sigma_z", "gaussian_relu_mean/sigma_z"],
        "corpus": "keenanpepper/arc-whestbench-p2-d8b-corpus-14k",
        "available_downloaded_shards": sorted(path.name for path in args.data_dir.glob("shard*.npz")),
        "network_count": int(len(ids)),
        "train_network_count": int(np.sum(~np.isin(np.arange(len(ids)), list(holdout_rows)))),
        "holdout_network_count": int(len(valid_networks)),
        "holdout_indices": [int(ids[i]) for i in valid_networks],
        "train_network_indices": [int(ids[i]) for i in range(len(ids)) if i not in holdout_rows],
        "seed": args.seed,
        "base_holdout_mse": mse(base),
        "corrected_holdout_mse": mse(corrected),
        "pooled_relative_mse_reduction": (mse(base) - mse(corrected)) / mse(base),
        "network_win_count": int(sum(x["relative_reduction"] > 0 for x in per_network)),
        "per_network": per_network,
        "model_file": str(model_path),
        "weight_sha256_by_network": {str(int(idx)): digest for idx, digest in zip(ids, hash_rows)},
        "warning": "oracle previous-layer marginal moments; diagnostic only, not a deployable estimator",
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({k: v for k, v in result.items() if k not in ("per_network", "weight_sha256_by_network",
                                                                   "train_network_indices")}, indent=2))


if __name__ == "__main__":
    main()
