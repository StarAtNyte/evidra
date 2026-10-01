#!/usr/bin/env python3
"""Materialize the frozen research-only terminal residual fit as a Whest estimator."""
from __future__ import annotations

import argparse
import ast
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / ".sota/research/whest-p2-cumulant-k3/estimators/estimator_v29.py"


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("manifest", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()

    manifest_path = args.manifest.resolve()
    manifest = json.loads(manifest_path.read_text())
    source = SOURCE.read_text()
    actual_hash = hashlib.sha256(SOURCE.read_bytes()).hexdigest()
    if manifest.get("source_sha256") != actual_hash:
        raise SystemExit("frozen coefficients were fit against a different V29 source")
    beta = manifest.get("coefficients")
    if len(beta) != 16 or any(len(row) != 13 for row in beta):
        raise SystemExit("expected a (16, 13) correction matrix")
    if any(float(value) != 0.0 for layer, row in enumerate(beta) if layer != 15 for value in row):
        raise SystemExit("candidate must contain only the directly fitted terminal-layer correction")
    if not any(float(value) != 0.0 for value in beta[15]):
        raise SystemExit("terminal correction is empty")

    tree = ast.parse(source)
    assignments = [node for node in tree.body if isinstance(node, ast.Assign)
                   and any(isinstance(target, ast.Name) and target.id == "CORR_BETA"
                           for target in node.targets)]
    if len(assignments) != 1:
        raise SystemExit(f"expected one top-level CORR_BETA assignment, found {len(assignments)}")
    assignment = assignments[0]
    lines = source.splitlines(keepends=True)
    start, end = assignment.lineno - 1, assignment.end_lineno
    rendered = "CORR_BETA = " + json.dumps(beta, separators=(",", ":")) + "\n"
    lines[start:end] = [rendered]
    candidate = "".join(lines)
    gate = 'NO_CORR = _os.environ.get("V17_NO_CORR", "1") == "1"'
    if candidate.count(gate) != 1:
        raise SystemExit("could not locate unique correction kill-switch")
    candidate = candidate.replace(gate, "NO_CORR = False  # frozen terminal residual candidate", 1)
    levels_gate = 'STRASSEN_LEVELS = int(_os.environ.get("V26_STRASSEN", "5"))'
    if candidate.count(levels_gate) != 1:
        raise SystemExit("could not locate unique Strassen depth control")
    candidate = candidate.replace(levels_gate,
                                  "STRASSEN_LEVELS = 4  # bounded-memory official-runner setting", 1)
    fuse_gate = 'STRASSEN_FUSE_P = int(_os.environ.get("V28_STRASSEN_FUSE_P", "343"))'
    if candidate.count(fuse_gate) != 1:
        raise SystemExit("could not locate unique fused-leaf memory tuning knob")
    # The default batched leaf allocation failed in the isolated 8 GiB-style
    # runner on this host. Lowering the fuse threshold bounds peak allocation;
    # this remains fully FlopScope-metered and uses the estimator's own path.
    candidate = candidate.replace(fuse_gate, "STRASSEN_FUSE_P = 32  # bounded-memory official-runner setting", 1)
    old_comment = "# Online mean-correction coefficients, (depth, n_features) = (16, 13); ridge-fitted\n# offline (lam=1e-3) on the teacher-forced trajectory of 5 public v2-phase2 MLPs"
    new_comment = "# Frozen terminal residual correction; ridge-fit on public mini MLP IDs 0-15.\n# Only layer 15 is active; its 13 existing V29 statistics predict additive output error."
    if candidate.count(old_comment) != 1:
        raise SystemExit("could not locate original correction provenance comment")
    candidate = candidate.replace(old_comment, new_comment, 1)
    ast.parse(candidate)

    out = args.output.resolve()
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(candidate)
    print(json.dumps({
        "output": str(out),
        "source_sha256": actual_hash,
        "manifest": str(manifest_path),
        "fit_ids": manifest.get("train_ids"),
        "held_out_ids": manifest.get("validation_ids"),
        "candidate_sha256": hashlib.sha256(candidate.encode()).hexdigest(),
        "correction_layers": [i for i, row in enumerate(beta)
                              if any(float(value) != 0.0 for value in row)],
    }, indent=2))


if __name__ == "__main__":
    main()
