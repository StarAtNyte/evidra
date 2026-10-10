"""Generate a V30 variant with a weight-derived Lyapunov low-rank correction.

The coefficient is fitted on the independent D8b corpus and supplied explicitly.
This generator does not access labels or choose the coefficient.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_SOURCE = ROOT / ".sota/candidates/whest-v30-cubic-residual-strassen8-20261009/estimator.py"

HELPER = '''
LYAPUNOV_RANK = 6
LYAPUNOV_OVERSAMPLE = 8
LYAPUNOV_POWER_ITERATIONS = 2


def _lyapunov_prediction_projection(weights, gates, prediction, seed):
    """Approximate top-left subspace of the closure-gated Jacobian product."""
    n = prediction.shape[0]
    width = LYAPUNOV_RANK + LYAPUNOV_OVERSAMPLE
    rng = fnp.random.default_rng(int(seed) ^ 20261020)
    omega = fnp.asarray(rng.standard_normal((n, width)), dtype=fnp.float32)

    def apply_b(value):
        for layer, weight in enumerate(weights):
            value = gates[layer][:, None] * (weight.T @ value)
        return value

    def apply_bt(value):
        for layer in range(len(weights) - 1, -1, -1):
            value = weights[layer] @ (gates[layer][:, None] * value)
        return value

    q, _ = fnp.linalg.qr(apply_b(omega))
    for _ in range(LYAPUNOV_POWER_ITERATIONS):
        z, _ = fnp.linalg.qr(apply_bt(q))
        q, _ = fnp.linalg.qr(apply_b(z))
    btq = apply_bt(q)
    gram = btq.T @ btq
    gram = (gram + gram.T) * 0.5
    _, eigvec = fnp.linalg.eigh(gram)
    basis = q @ eigvec[:, -LYAPUNOV_RANK:]
    return basis @ (basis.T @ prediction)


'''


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--alpha", type=float, required=True)
    parser.add_argument("--source", type=Path, default=DEFAULT_SOURCE)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--training-capture", type=Path, required=True)
    parser.add_argument("--cv-result", type=Path, required=True)
    args = parser.parse_args()

    src = args.source.read_text(encoding="utf-8")
    class_marker = "class Estimator(BaseEstimator):"
    rows_marker = "        rows = []\n"
    gate_marker = "            Phi = flops.stats.norm.cdf(alpha).astype(f32)\n"
    return_marker = "        return fnp.stack(rows, axis=0)\n"
    for marker in (class_marker, rows_marker, gate_marker, return_marker):
        if src.count(marker) != 1:
            raise SystemExit(f"expected exactly one source marker: {marker.strip()}")

    src = src.replace(class_marker, HELPER + class_marker, 1)
    src = src.replace(rows_marker, rows_marker +
                      "        lyapunov_gates = [] if n == 1024 and L == 16 else None\n", 1)
    src = src.replace(gate_marker, gate_marker +
                      "            if lyapunov_gates is not None:\n"
                      "                lyapunov_gates.append(Phi)\n", 1)
    src = src.replace(return_marker,
                      "        predictions = fnp.stack(rows, axis=0)\n"
                      "        if lyapunov_gates is not None:\n"
                      "            direction = _lyapunov_prediction_projection(\n"
                      "                mlp.weights, lyapunov_gates, predictions[-1], mlp.seed\n"
                      "            )\n"
                      f"            fnp.add(predictions[-1], direction * ({args.alpha:.17g}), out=predictions[-1])\n"
                      "        return predictions\n", 1)

    out = args.output_dir
    out.mkdir(parents=True, exist_ok=True)
    estimator = out / "estimator.py"
    estimator.write_text(src, encoding="utf-8")
    for name in ("LICENSE", "ATTRIBUTION.md"):
        source_sidecar = args.source.parent / name
        if source_sidecar.exists():
            shutil.copy2(source_sidecar, out / name)
    provenance = {
        "candidate": "V30 plus rank-6 closure-gated Lyapunov projection shrinkage",
        "alpha": args.alpha,
        "rank": 6,
        "oversample": 8,
        "power_iterations": 2,
        "source_sha256": sha(args.source.read_bytes()),
        "estimator_sha256": sha(estimator.read_bytes()),
        "training_capture": str(args.training_capture),
        "training_capture_sha256": sha(args.training_capture.read_bytes()),
        "cv_result": str(args.cv_result),
        "cv_result_sha256": sha(args.cv_result.read_bytes()),
        "status": "research candidate; not validated or submitted",
    }
    (out / "research-provenance.json").write_text(json.dumps(provenance, indent=2) + "\n")
    print(json.dumps({"estimator": str(estimator), "provenance": provenance}, indent=2))


if __name__ == "__main__":
    main()
