#!/usr/bin/env python3
"""Research-only sequential correction fit on the exact V29 estimator source.

The module is instrumented in memory only: no estimator source is edited. Before fitting,
run --verify-only to assert that the capture/early-stop instrumentation leaves full-depth
uncorrected predictions exactly equal to pristine V29.

Example (use the Workbench starter-kit venv):
  .venv/bin/python reports/research/probe_v29_sequential_dagger.py --data mini.parquet --verify-only
"""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import os
import sys
import time
from pathlib import Path

import numpy as np
import pyarrow.parquet as pq

ROOT = Path(__file__).resolve().parents[2]
V29_PATH = ROOT / ".sota/research/whest-p2-cumulant-k3/estimators/estimator_v29.py"
sys.path.insert(0, str(V29_PATH.parent))
import estimator_v29 as pristine  # noqa: E402
import flopscope as flops  # noqa: E402
import flopscope.numpy as fnp  # noqa: E402
from whestbench.domain import MLP  # noqa: E402


class Setup:
    seed = 0


def load_instrumented():
    """Capture every layer and stop after a requested layer via in-memory source edits."""
    src = V29_PATH.read_text()
    future = "from __future__ import annotations"
    if src.count(future) != 1:
        raise RuntimeError("could not locate the unique future-import anchor")
    src = src.replace(future, future + "\nimport numpy as np", 1)
    replacements = [
        ("last and riders and _os.environ.get(\"EVIDRA_CAPTURE_FINAL_FEATURES\") == \"1\"",
         "riders and _os.environ.get(\"EVIDRA_CAPTURE_FINAL_FEATURES\") == \"1\""),
        ("CAPTURED_FINAL_FEATURES = []  # research-only; populated only when explicitly requested",
         "CAPTURED_FINAL_FEATURES = []  # research-only\nSTOP_AFTER_LAYER = None"),
        ("CAPTURED_FINAL_FEATURES.append((feats, pk1v))",
         "CAPTURED_FINAL_FEATURES.append((li, np.asarray(feats).copy(), np.asarray(pk1v).copy()))"),
        ("            rows.append(mu)\n\n        return fnp.stack(rows, axis=0)",
         "            rows.append(mu)\n            if STOP_AFTER_LAYER is not None and li >= STOP_AFTER_LAYER:\n                break\n\n        return fnp.stack(rows, axis=0)"),
    ]
    for old, new in replacements:
        count = src.count(old)
        if count != 1:
            raise RuntimeError(f"instrumentation anchor expected once, found {count}: {old[:80]!r}")
        src = src.replace(old, new, 1)
    spec = importlib.util.spec_from_file_location("evidra_v29_instrumented", V29_PATH)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = mod
    exec(compile(src, str(V29_PATH) + "[instrumented-in-memory]", "exec"), mod.__dict__)
    mod.STOP_AFTER_LAYER = None
    mod.NO_CORR = True
    mod.CORR_BETA = np.zeros((16, 13), dtype=np.float32).tolist()
    os.environ["EVIDRA_CAPTURE_FINAL_FEATURES"] = "1"
    return mod


def load_rows(data_paths: list[Path], ids: set[int]):
    rows = {}
    for data in data_paths:
        pf = pq.ParquetFile(data)
        for batch in pf.iter_batches(batch_size=1,
                                     columns=["mlp_id", "mlp_seed", "weights", "all_layer_means", "final_means"]):
            mid = int(batch.column("mlp_id")[0].as_py())
            if mid not in ids or mid in rows:
                continue
            row = batch.to_pylist()[0]
            weights = np.asarray(row["weights"], dtype=np.float32).reshape(16, 1024, 1024)
            targets = np.asarray(row["all_layer_means"], dtype=np.float32).reshape(16, 1024)
            rows[mid] = (weights, targets, int(row["mlp_seed"]))
            if ids.issubset(rows):
                break
        if ids.issubset(rows):
            break
    missing = ids - rows.keys()
    if missing:
        raise RuntimeError(f"data missing requested IDs {sorted(missing)}")
    return rows


def make_mlp(weights: np.ndarray, seed: int):
    return MLP(width=1024, depth=16,
               weights=[fnp.asarray(w, dtype=fnp.float32) for w in weights], seed=seed)


def run(module, weights, seed, beta, stop_after=None, capture=False):
    module.CORR_BETA = np.asarray(beta, dtype=np.float32).tolist()
    module.NO_CORR = not bool(np.any(beta))
    if hasattr(module, "STOP_AFTER_LAYER"):
        module.STOP_AFTER_LAYER = stop_after
    if capture:
        module.CAPTURED_FINAL_FEATURES.clear()
    est = module.Estimator()
    est.setup(Setup())
    with flops.BudgetContext(flop_budget=2**41, wall_time_limit_s=1200.0, quiet=True) as ctx:
        pred = np.asarray(est.predict(make_mlp(weights, seed), 2**41), dtype=np.float64)
    features = list(module.CAPTURED_FINAL_FEATURES) if capture else []
    return pred, features, int(ctx.flops_used)


def fit_layer(features, residual, ridge):
    x = np.concatenate(features, axis=0).reshape(-1, features[0].shape[-1]).astype(np.float64)
    y = np.concatenate(residual, axis=0).reshape(-1).astype(np.float64)
    mean, scale = x.mean(0), x.std(0)
    scale[scale < 1e-12] = 1.0
    z = (x - mean) / scale
    a = np.column_stack((z, np.ones(len(z))))
    reg = np.eye(a.shape[1]) * ridge
    reg[-1, -1] = 0.0
    coef = np.linalg.solve(a.T @ a + reg, a.T @ y)
    beta = coef[:-1] / scale
    beta[0] += coef[-1] - mean @ beta  # first feature is the all-ones intercept
    return beta


def mse(pred, truth):
    return float(np.mean((pred[-1] - truth[-1]) ** 2))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", type=Path, required=True, nargs="+")
    ap.add_argument("--train-ids", type=int, nargs="+", default=[84, 85, 86, 87])
    ap.add_argument("--validation-ids", type=int, nargs="+", default=[96, 97, 98, 99])
    ap.add_argument("--fit-layers", type=int, default=4)
    ap.add_argument("--ridge", type=float, default=1e-2)
    ap.add_argument("--reuse-coefficients", type=Path,
                    help="load frozen coefficients from a prior JSON run manifest instead of fitting")
    ap.add_argument("--scale", type=float, default=1.0,
                    help="multiply all frozen correction coefficients by this trust-region scale")
    ap.add_argument("--output", type=Path,
                    help="manifest output path (default: ignored .sota/tmp location)")
    ap.add_argument("--validation-only", action="store_true",
                    help="score only validation IDs; useful for frozen-coefficient screens")
    ap.add_argument("--verify-only", action="store_true")
    args = ap.parse_args()
    if set(args.train_ids) & set(args.validation_ids):
        raise SystemExit("train and validation IDs must be disjoint")
    data_paths = [p.resolve() for p in args.data]
    rows = load_rows(data_paths, set(args.train_ids + args.validation_ids))
    module = load_instrumented()

    if args.verify_only:
        mid = args.validation_ids[0]
        w, _, seed = rows[mid]
        p0, _, f0 = run(pristine, w, seed, np.zeros((16, 13)), capture=False)
        p1, captured, f1 = run(module, w, seed, np.zeros((16, 13)), capture=True)
        print(json.dumps({"verify_only": True, "mlp_id": mid,
                          "exact_array_equal": bool(np.array_equal(p0, p1)),
                          "max_abs_difference": float(np.max(np.abs(p0 - p1))),
                          "pristine_flops": f0, "instrumented_flops": f1,
                          "captured_layers": len(captured)}, indent=2))
        if not np.array_equal(p0, p1) or len(captured) != 16:
            raise SystemExit("instrumentation parity failed")
        return

    if not 1 <= args.fit_layers <= 16:
        raise SystemExit("fit-layers must be in [1,16]")
    beta = np.zeros((16, 13), dtype=np.float64)
    layer_log = []
    started = time.time()
    if args.reuse_coefficients:
        if not 0.0 <= args.scale <= 1.0:
            raise SystemExit("trust-region scale must be in [0,1]")
        prior = json.loads(args.reuse_coefficients.read_text())
        beta = np.asarray(prior["coefficients"], dtype=np.float64)
        if beta.shape != (16, 13):
            raise SystemExit(f"expected coefficient shape (16,13), got {beta.shape}")
        beta *= args.scale
        layer_log = prior.get("layer_log", [])
    else:
        for layer in range(args.fit_layers):
            xs, residuals = [], []
            for mid in args.train_ids:
                w, truth, seed = rows[mid]
                pred, captures, _ = run(module, w, seed, beta, stop_after=layer, capture=True)
                hit = [entry for entry in captures if entry[0] == layer]
                if len(hit) != 1:
                    raise RuntimeError(f"ID {mid}, layer {layer}: expected one feature row; got {len(hit)}")
                _, x, raw_mu = hit[0]
                xs.append(np.asarray(x).reshape(1, 1024, 13))
                residuals.append((truth[layer] - np.asarray(raw_mu).reshape(1024))[None, :])
            beta[layer] = fit_layer(xs, residuals, args.ridge)
            layer_log.append({"layer": layer, "coefficient_norm": float(np.linalg.norm(beta[layer]))})
            print(f"fit V29 layer={layer} · coefficient_norm={np.linalg.norm(beta[layer]):.4g}", flush=True)

    results = []
    evaluation_splits = (("validation", args.validation_ids),) if args.validation_only else (
        ("train", args.train_ids), ("validation", args.validation_ids))
    for split, ids in evaluation_splits:
        for mid in ids:
            w, truth, seed = rows[mid]
            base, _, base_flops = run(pristine, w, seed, np.zeros((16, 13)))
            corrected, _, corr_flops = run(module, w, seed, beta)
            entry = {"split": split, "mlp_id": mid, "baseline_mse": mse(base, truth),
                     "corrected_mse": mse(corrected, truth), "ratio": mse(corrected, truth) / mse(base, truth),
                     "baseline_flops": base_flops, "corrected_flops": corr_flops}
            results.append(entry)
            print(json.dumps(entry), flush=True)
    val = [r for r in results if r["split"] == "validation"]
    report = {"method": "sequential fit on exact V29 rolled prefixes; correction features captured in-memory",
              "source_sha256": hashlib.sha256(V29_PATH.read_bytes()).hexdigest(),
              "data_sha256": {str(p): hashlib.sha256(p.read_bytes()).hexdigest() for p in data_paths},
              "train_ids": args.train_ids, "validation_ids": args.validation_ids,
              "fit_layers": args.fit_layers, "ridge": args.ridge,
              "coefficient_scale": args.scale if args.reuse_coefficients else 1.0,
              "reused_from": str(args.reuse_coefficients) if args.reuse_coefficients else None,
              "layer_log": layer_log, "per_mlp": results,
              "validation_mean_ratio": float(np.mean([r["ratio"] for r in val])),
              "coefficients": beta.tolist(), "elapsed_sec": time.time() - started}
    out = args.output or ROOT / ".sota/tmp/whest_v29_sequential_dagger.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report, indent=2), flush=True)


if __name__ == "__main__":
    main()
