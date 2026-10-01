#!/usr/bin/env python3
"""Exploratory K=2 / V29 output-blend diagnostic on public Phase-2 Mini.

The scalar blend coefficient is fit on complete training MLPs only, then frozen
for complete test MLPs. This is a research probe, not a submission estimator.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path

import numpy as np
import pyarrow.parquet as pq
import flopscope as flops
import flopscope.numpy as fnp
from whestbench import SetupContext
from whestbench.domain import MLP


ROOT = Path(__file__).resolve().parents[2]
STARTER = ROOT / "competitions/whestbench/starterkit"
sys.path.insert(0, str(STARTER))
from estimator import Estimator as K2Estimator  # noqa: E402


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def parse_ids(value: str) -> list[int]:
    ids = sorted({int(part) for part in value.split(",") if part.strip()})
    if not ids or any(i < 0 or i >= 100 for i in ids):
        raise argparse.ArgumentTypeError("IDs must be a nonempty comma-separated subset of 0..99")
    return ids


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--train-ids", type=parse_ids, default=parse_ids("0,1,2,3"))
    parser.add_argument("--test-ids", type=parse_ids, default=parse_ids("4,5,6,7,8,9,10,11,12,13,14,15"))
    parser.add_argument("--capture", type=Path, default=ROOT / ".sota/tmp/v29-final-features-train-0-79.npz")
    parser.add_argument("--output", type=Path, default=ROOT / ".sota/tmp/whest-cross-order-k2-screen.json")
    args = parser.parse_args()
    if set(args.train_ids) & set(args.test_ids):
        parser.error("training and test MLP IDs must be disjoint")

    with np.load(args.capture, allow_pickle=False) as cap:
        capture_ids = cap["ids"].astype(int)
        positions = {int(i): j for j, i in enumerate(capture_ids)}
        missing = sorted(set(args.train_ids + args.test_ids) - positions.keys())
        if missing:
            parser.error(f"V29 capture is missing IDs: {missing}")
        v29 = cap["predictions"].copy()
        target = cap["targets"].copy()
        v29_flops = cap["flops"].copy()

    fit_num = fit_den = 0.0

    data_dir = STARTER / ".whest-data/data"
    wanted = set(args.train_ids + args.test_ids)
    predictions: dict[int, np.ndarray] = {}
    costs: dict[int, int] = {}
    estimator = K2Estimator()
    estimator.setup(SetupContext(width=1024, depth=16, flop_budget=2**41, api_version="1"))
    for shard in sorted(data_dir.glob("mini-*.parquet")):
        for batch in pq.ParquetFile(shard).iter_batches(
            batch_size=1, columns=["mlp_id", "mlp_seed", "weights"]
        ):
            idx = int(batch.column("mlp_id")[0].as_py())
            if idx not in wanted:
                continue
            row = batch.select(["mlp_seed", "weights"]).to_pylist()[0]
            weights = np.asarray(row["weights"], dtype=np.float32).reshape(16, 1024, 1024)
            mlp = MLP(width=1024, depth=16,
                      weights=[fnp.asarray(w) for w in weights], seed=int(row["mlp_seed"]))
            with flops.BudgetContext(flop_budget=2**41, wall_time_limit_s=120.0,
                                    quiet=True) as ctx:
                predictions[idx] = np.asarray(estimator.predict(mlp, 2**41)[-1], dtype=np.float32)
            costs[idx] = int(ctx.flops_used)
            wanted.remove(idx)
            print(f"K2 evaluated id={idx} · FLOPs={costs[idx]}", flush=True)
            if not wanted:
                break
        if not wanted:
            break
    if wanted:
        raise RuntimeError(f"dataset is missing MLP IDs: {sorted(wanted)}")

    for idx in args.train_ids:
        j = positions[idx]
        d = predictions[idx].astype(np.float64) - v29[j].astype(np.float64)
        e = target[j].astype(np.float64) - v29[j].astype(np.float64)
        fit_num += float(np.sum(d * e))
        fit_den += float(np.sum(d * d))
    alpha = fit_num / fit_den if fit_den > 0 else 0.0

    rows = []
    for idx in args.test_ids:
        j = positions[idx]
        y = target[j].astype(np.float64)
        base = v29[j].astype(np.float64)
        k2 = predictions[idx].astype(np.float64)
        base_mse = float(np.mean((base - y) ** 2))
        blend_mse = float(np.mean((base + alpha * (k2 - base) - y) ** 2))
        rows.append({"id": idx, "v29_mse": base_mse, "blend_mse": blend_mse,
                     "mse_ratio": blend_mse / base_mse, "k2_flops": costs[idx],
                     "v29_flops": int(v29_flops[j])})

    result = {
        "experiment": "frozen scalar blend: V29 + alpha*(starter K2 - V29)",
        "dataset": "v2-phase2 public mini",
        "train_ids": args.train_ids,
        "test_ids": args.test_ids,
        "alpha_fit_on_train_only": alpha,
        "test_rows": rows,
        "pooled_test_mse_ratio": sum(r["blend_mse"] for r in rows) / sum(r["v29_mse"] for r in rows),
        "test_wins": sum(r["mse_ratio"] < 1 for r in rows),
        "mean_k2_flops": float(np.mean([r["k2_flops"] for r in rows])),
        "mean_v29_flops": float(np.mean([r["v29_flops"] for r in rows])),
        "output": str(args.output),
        "capture_sha256": sha256(args.capture),
        "k2_source_sha256": sha256(STARTER / "estimator.py"),
        "v29_source_sha256": "0eedf1ac107db931c855d693e2556c088e396744517ccd00287e6178099be5ce",
        "limitations": ["small public-Mini pilot", "in-process probe, not package parity",
                        "local V29 source differs from the historical submitted archive",
                        "starter K2 includes its embedded calibration", "not a submission result"],
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps({k: result[k] for k in (
        "alpha_fit_on_train_only", "pooled_test_mse_ratio", "test_wins",
        "mean_k2_flops", "mean_v29_flops", "output")}, indent=2))


if __name__ == "__main__":
    main()
