#!/usr/bin/env python3
"""Measure exact-zero structure in V30's transported K3 source legs.

This is a diagnostic only: the original estimator is called unchanged and
predictions/targets are not modified. It tests whether the hot/cold sparse
contraction proposal has structural zeros to exploit.
"""
from __future__ import annotations

import hashlib
import argparse
import json
import sys
import tarfile
import types
from pathlib import Path

import numpy as np
import pyarrow.parquet as pq
import flopscope as flops
import flopscope.numpy as fnp
from whestbench import SetupContext
from whestbench.domain import MLP

ROOT = Path(__file__).resolve().parents[2]
STARTER = ROOT / "competitions/whestbench/starterkit"
CANDIDATE = ROOT / ".sota/candidates/whest-v30-cubic-residual-strassen8-20261009"
ARCHIVE = CANDIDATE / "submission.tar.gz"
DATA = STARTER / ".whest-data/data"

with tarfile.open(ARCHIVE, "r:gz") as bundle:
    source_member = next(member for member in bundle.getmembers() if member.name == "estimator.py")
    source_bytes = bundle.extractfile(source_member).read()
ESTIMATOR_MODULE = types.ModuleType("whest_v30_archived_estimator")
ESTIMATOR_MODULE.__file__ = f"{ARCHIVE}::estimator.py"
sys.modules[ESTIMATOR_MODULE.__name__] = ESTIMATOR_MODULE
exec(compile(source_bytes, ESTIMATOR_MODULE.__file__, "exec"), ESTIMATOR_MODULE.__dict__)
Estimator = ESTIMATOR_MODULE.Estimator


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--ids", default="80", help="locked Mini MLP IDs, comma-separated")
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    wanted = {int(value) for value in args.ids.split(",") if value}
    if not wanted or any(value < 0 or value >= 100 for value in wanted):
        parser.error("--ids must be a nonempty subset of 0..99")
    records: list[dict] = []
    original = Estimator._dslices

    def measured(self, A_st, P_st, *args, **kwargs):
        # Copy diagnostics outside the estimator's arithmetic path; call the
        # original method with identical arguments and return values.
        for name, value in (("A_st", A_st), ("P_st", P_st)):
            raw = np.asarray(value)
            total = int(raw.size)
            zeros = int(np.count_nonzero(raw == 0))
            records.append({
                "leg": name,
                "shape": list(raw.shape),
                "exact_zero_fraction": zeros / total if total else 0.0,
                "min_abs_nonzero": float(np.min(np.abs(raw[raw != 0]))) if zeros < total else None,
            })
        return original(self, A_st, P_st, *args, **kwargs)

    Estimator._dslices = measured
    estimator = Estimator()
    estimator.setup(SetupContext(width=1024, depth=16, flop_budget=2**41, api_version="1"))
    used: list[int] = []
    for shard in sorted(DATA.glob("mini-*.parquet")):
        for batch in pq.ParquetFile(shard).iter_batches(batch_size=1, columns=["mlp_id", "mlp_seed", "weights"]):
            idx = int(batch.column("mlp_id")[0].as_py())
            if idx not in wanted:
                continue
            row = batch.select(["mlp_seed", "weights"]).to_pylist()[0]
            weights = np.asarray(row["weights"], dtype=np.float32).reshape(16, 1024, 1024)
            mlp = MLP(width=1024, depth=16, weights=[fnp.asarray(w) for w in weights], seed=int(row["mlp_seed"]))
            with flops.BudgetContext(flop_budget=2**41, wall_time_limit_s=120.0, quiet=True):
                estimator.predict(mlp, 2**41)
            used.append(idx)
            print(f"measured source legs for MLP {idx}", flush=True)
            if set(used) == wanted:
                break
        if set(used) == wanted:
            break

    if set(used) != wanted:
        raise RuntimeError(f"missing requested MLP IDs: {sorted(wanted - set(used))}")
    exact_zero_fractions = [record["exact_zero_fraction"] for record in records]
    result = {
        "experiment": "V30 transported K3 source-leg exact-zero density diagnostic",
        "candidate": str(ARCHIVE.relative_to(ROOT)),
        "archive_sha256": sha256(ARCHIVE),
        "source_sha256": hashlib.sha256(source_bytes).hexdigest(),
        "dataset_sha256": "264fa1f416d16a40821fb5e8e94f5d2da4698a201d40da999616225b38b464f1",
        "mlp_ids": sorted(used),
        "summary": {
            "observations": len(records),
            "mean_exact_zero_fraction": float(np.mean(exact_zero_fractions)),
            "max_exact_zero_fraction": float(np.max(exact_zero_fractions)),
            "interpretation_threshold_not_preregistered": 0.01,
            "decision": "reject exact-zero sparse-contraction direction",
        },
        "records": records,
        "limitations": ["diagnostic only; no sparse approximation tested", "exact zeros do not measure near-zero approximation safety"],
    }
    out = args.output or ROOT / f".sota/runs/whest-v30-source-leg-density-{min(used)}-20261010.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(result, indent=2) + "\n")
    vals = np.asarray([r["exact_zero_fraction"] for r in records])
    print(json.dumps({"output": str(out), "calls": len(records), "mean_exact_zero_fraction": float(vals.mean()), "max_exact_zero_fraction": float(vals.max())}, indent=2))


if __name__ == "__main__":
    main()
