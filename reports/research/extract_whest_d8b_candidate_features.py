"""Research-only: capture V30 deploy-time features on independent D8b MLPs.

Run with the WhestBench starterkit's Python 3.10 environment. The input NPZ
contains one regenerated MLP's weights and its independent corpus target.
This does not alter candidate sources or use any public Mini labels.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import os
import tempfile
import time
from pathlib import Path

import numpy as np

import flopscope as flops
import flopscope.numpy as fnp
from whestbench import MLP, SetupContext


ROOT = Path(__file__).resolve().parents[2]
DEFAULT_CANDIDATE = (
    ROOT / ".sota/candidates/whest-v30-cubic-residual-strassen8-20261009/estimator.py"
)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--weights", type=Path, required=True, help="(N,16,1024,1024) .npy mmap")
    parser.add_argument("--manifest", type=Path, required=True, help="weight-bank manifest; enforces target-ID alignment")
    parser.add_argument("--targets", type=Path, required=True, help="D8b shard NPZ with final_mean")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--candidate", type=Path, default=DEFAULT_CANDIDATE)
    parser.add_argument("--start", type=int, default=0)
    parser.add_argument("--count", type=int, default=1)
    parser.add_argument(
        "--checkpoint-every",
        type=int,
        default=1,
        help="atomically persist completed network rows at this interval (default: every row)",
    )
    args = parser.parse_args()

    os.environ["EVIDRA_CAPTURE_FINAL_FEATURES"] = "1"
    spec = importlib.util.spec_from_file_location("evidra_v30_probe", args.candidate)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot import candidate: {args.candidate}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)

    weight_bank = np.load(args.weights, mmap_mode="r", allow_pickle=False)
    with np.load(args.targets, allow_pickle=False) as data:
        targets = np.asarray(data["final_mean"], dtype=np.float64)
        indices = np.asarray(data["idx"], dtype=np.int64)
    if args.start < 0 or args.count < 1 or args.checkpoint_every < 1 or args.start + args.count > len(indices):
        raise ValueError("requested D8b interval is outside the pinned target shard")
    if weight_bank.shape[0] < args.start + args.count:
        raise ValueError("weight bank does not cover requested D8b interval")
    manifest = json.loads(args.manifest.read_text(encoding="utf-8"))
    bank_indices = manifest.get("corpus_indices")
    bank_hashes = manifest.get("weight_sha256")
    if bank_indices is None or bank_hashes is None:
        raise ValueError("weight manifest must contain corpus_indices and weight_sha256")
    selected_indices = indices[args.start : args.start + args.count].tolist()
    if bank_indices[args.start : args.start + args.count] != selected_indices:
        raise ValueError(
            "weight-bank corpus IDs do not match target IDs: "
            f"{bank_indices[args.start : args.start + args.count]} != {selected_indices}"
        )
    if len(bank_hashes) < args.start + args.count:
        raise ValueError("weight manifest does not cover requested D8b interval")
    estimator = module.Estimator()
    estimator.setup(
        SetupContext(
            width=1024,
            depth=16,
            flop_budget=2**41,
            api_version="1.0",
            submission_dir=str(args.candidate.parent),
            seed=0,
        )
    )
    all_features, all_base, all_targets, all_candidate, elapsed_rows, completed_indices = [], [], [], [], [], []
    if args.output.exists():
        with np.load(args.output, allow_pickle=False) as saved:
            completed_indices = np.asarray(saved["indices"], dtype=np.int64).tolist()
            all_features = [row for row in np.asarray(saved["features"], dtype=np.float64)]
            all_base = [row for row in np.asarray(saved["base_prediction"], dtype=np.float64)]
            all_targets = [row for row in np.asarray(saved["target"], dtype=np.float64)]
            all_candidate = [row for row in np.asarray(saved["candidate_prediction"], dtype=np.float64)]
            elapsed_rows = np.asarray(saved["elapsed_s"], dtype=np.float64).tolist()
        requested_ids = set(indices[args.start : args.start + args.count].tolist())
        if len(set(completed_indices)) != len(completed_indices) or not set(completed_indices).issubset(requested_ids):
            raise ValueError("existing checkpoint has duplicate or out-of-range corpus IDs")
        lengths = {len(completed_indices), len(all_features), len(all_base), len(all_targets),
                   len(all_candidate), len(elapsed_rows)}
        if len(lengths) != 1:
            raise ValueError("existing checkpoint arrays have inconsistent row counts")
        print(f"resuming {len(completed_indices)}/{args.count} saved networks", flush=True)

    def save_checkpoint() -> None:
        if not all_features:
            return
        args.output.parent.mkdir(parents=True, exist_ok=True)
        fd, temporary = tempfile.mkstemp(prefix=f".{args.output.name}.", suffix=".tmp", dir=args.output.parent)
        try:
            with os.fdopen(fd, "wb") as stream:
                np.savez_compressed(
                    stream,
                    indices=np.asarray(completed_indices, dtype=np.int64),
                    features=np.stack(all_features),
                    base_prediction=np.stack(all_base),
                    candidate_prediction=np.stack(all_candidate),
                    target=np.stack(all_targets),
                    elapsed_s=np.asarray(elapsed_rows, dtype=np.float64),
                )
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, args.output)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)

    for offset in range(args.start, args.start + args.count):
        seed = int(indices[offset])
        if seed in completed_indices:
            continue
        weight_hash = hashlib.sha256(
            memoryview(np.ascontiguousarray(weight_bank[offset])).cast("B")
        ).hexdigest()
        if weight_hash != bank_hashes[offset]:
            raise ValueError(f"weight hash mismatch at corpus row {offset} (idx={seed})")
        weights = [fnp.asarray(w, dtype=fnp.float32) for w in weight_bank[offset]]
        mlp = MLP(width=1024, depth=16, weights=weights, seed=seed)
        module.CAPTURED_FINAL_FEATURES.clear()
        t0 = time.monotonic()
        with flops.BudgetContext(flop_budget=2**41, wall_time_limit_s=120.0, quiet=True):
            prediction = estimator.predict(mlp, 2**41)
        elapsed_rows.append(time.monotonic() - t0)
        captured = module.CAPTURED_FINAL_FEATURES
        if len(captured) != 1:
            raise RuntimeError(f"row {offset}: expected one feature capture; got {len(captured)}")
        features, base_prediction = captured[0]
        y = targets[offset].reshape(-1)
        pred = np.asarray(prediction, dtype=np.float64).reshape(-1)[-1024:]
        all_features.append(np.asarray(features, dtype=np.float64))
        all_base.append(np.asarray(base_prediction, dtype=np.float64).reshape(-1))
        all_targets.append(y)
        all_candidate.append(pred)
        completed_indices.append(seed)
        if len(all_features) % args.checkpoint_every == 0 or offset + 1 == args.start + args.count:
            save_checkpoint()
            print(
                f"checkpointed {len(all_features)}/{args.count} networks; "
                f"latest_elapsed={elapsed_rows[-1]:.1f}s; output={args.output}",
                flush=True,
            )

    all_features = np.stack(all_features)
    all_base = np.stack(all_base)
    all_targets = np.stack(all_targets)
    all_candidate = np.stack(all_candidate)
    base_mse = np.mean((all_base - all_targets) ** 2, axis=1)
    candidate_mse = np.mean((all_candidate - all_targets) ** 2, axis=1)
    print(
        f"saved {len(all_targets)} networks; feature_shape={all_features.shape}; "
        f"base_mse_mean={base_mse.mean():.9g}; candidate_mse_mean={candidate_mse.mean():.9g}; "
        f"capture={args.output}"
    )


if __name__ == "__main__":
    main()
