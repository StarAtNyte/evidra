"""Phase-2 transfer probe for the public Phase-1 forward angular-attractor lead.

This is a diagnostic only: targets are used only after the weight-only
attractor is frozen, to measure directional alignment. No fitted correction
is produced.
"""
from __future__ import annotations

import argparse
from pathlib import Path

import numpy as np
import pyarrow.parquet as pq


def cosine(a: np.ndarray, b: np.ndarray) -> float:
    den = float(np.linalg.norm(a) * np.linalg.norm(b))
    return float(np.dot(a, b) / den) if den else 0.0


def angular_orbit(weights: np.ndarray, cycles: int) -> tuple[np.ndarray, float]:
    """Iterate the homogeneous network's layer-cycle map using weights only."""
    width = weights.shape[1]
    state = np.ones(width, dtype=np.float32) / np.sqrt(width)
    previous_cycle = state.copy()
    for cycle in range(cycles):
        for w in weights:
            state = w @ state
            np.maximum(state, 0.0, out=state)
            norm = float(np.linalg.norm(state))
            if not np.isfinite(norm) or norm <= 1e-20:
                raise FloatingPointError(f"angular orbit collapsed at cycle {cycle}")
            state /= norm
        if cycle == cycles - 2:
            previous_cycle = state.copy()
    return state, cosine(previous_cycle, state)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--parquet-dir", type=Path, required=True)
    ap.add_argument("--capture", type=Path, required=True,
                    help="locked V29 capture containing ids, predictions, targets")
    ap.add_argument("--cycles", type=int, default=32)
    ap.add_argument("--start", type=int, default=80)
    ap.add_argument("--end", type=int, default=100)
    args = ap.parse_args()
    if args.cycles < 2 or not 0 <= args.start < args.end <= 100:
        ap.error("need cycles >= 2 and 0 <= start < end <= 100")
    with np.load(args.capture, allow_pickle=False) as data:
        ids = data["ids"].astype(int)
        pred = data["predictions"]
        target = data["targets"]
        indexed = {int(mlp_id): i for i, mlp_id in enumerate(ids)}
    needed = set(range(args.start, args.end))
    seen: set[int] = set()
    scores: list[dict[str, float | int]] = []
    for path in sorted(args.parquet_dir.glob("mini-*.parquet")):
        for batch in pq.ParquetFile(path).iter_batches(batch_size=1,
                columns=["mlp_id", "weights"]):
            mlp_id = int(batch.column("mlp_id")[0].as_py())
            if mlp_id not in needed:
                continue
            if mlp_id not in indexed:
                raise RuntimeError(f"capture does not contain locked id {mlp_id}")
            row = batch.column("weights")[0].as_py()
            weights = np.asarray(row, dtype=np.float32).reshape(16, 1024, 1024)
            orbit, convergence = angular_orbit(weights, args.cycles)
            j = indexed[mlp_id]
            residual = target[j] - pred[j]
            scores.append({
                "id": mlp_id,
                "cos_to_target": cosine(orbit, target[j]),
                "abs_cos_to_residual": abs(cosine(orbit, residual)),
                "signed_residual_projection": cosine(orbit, residual),
                "oracle_residual_energy_fraction": cosine(orbit, residual) ** 2,
                "cycle_cosine": convergence,
            })
            seen.add(mlp_id)
            print(f"id={mlp_id} cycle_cos={convergence:.5f} "
                  f"target_cos={scores[-1]['cos_to_target']:.5f} "
                  f"residual_cos={scores[-1]['signed_residual_projection']:.5f}",
                  flush=True)
            del weights
            if seen == needed:
                break
        if seen == needed:
            break
    if seen != needed:
        raise RuntimeError(f"missing ids: {sorted(needed - seen)}")
    for key in ("cycle_cosine", "cos_to_target", "abs_cos_to_residual",
                "oracle_residual_energy_fraction"):
        vals = np.asarray([float(row[key]) for row in scores])
        print(f"summary {key}: mean={vals.mean():.6g} median={np.median(vals):.6g}")
    print("interpretation: oracle_residual_energy_fraction is not a deployable gain; "
          "the residual coefficient is target-dependent")


if __name__ == "__main__":
    main()
