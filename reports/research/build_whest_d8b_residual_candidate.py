"""Build a V30 variant with a D8b-only, network-grouped residual model.

Call only after the grouped-CV screen passes its predeclared expansion rule.
This creates source files but does not upload or promote the candidate.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import re
import shutil
import zlib
from pathlib import Path

import numpy as np


ROOT = Path(__file__).resolve().parents[2]
DEFAULT_SOURCE = ROOT / ".sota/candidates/whest-v30-cubic-residual-strassen8-20261009/estimator.py"


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", type=Path, required=True)
    parser.add_argument("--source", type=Path, default=DEFAULT_SOURCE)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()

    model_data = np.load(args.model, allow_pickle=False)
    mean = np.asarray(model_data["mean"], dtype=np.float64)
    scale = np.asarray(model_data["scale"], dtype=np.float64)
    coef = np.asarray(model_data["coef"], dtype=np.float64)
    y_mean = float(model_data["y_mean"])
    if mean.shape != (559,) or scale.shape != (559,) or coef.shape != (559,):
        raise SystemExit("D8b residual model must be padded to V30's degree-3 design width (559)")
    if not np.isfinite(mean).all() or not np.isfinite(scale).all() or not np.isfinite(coef).all():
        raise SystemExit("model contains non-finite values")
    if np.any(scale <= 0) or not np.isfinite(y_mean):
        raise SystemExit("invalid model scales/intercept")

    model = {"mean": mean.tolist(), "scale": scale.tolist(),
             "y_mean": y_mean, "coef": coef.tolist()}
    encoded = base64.urlsafe_b64encode(
        zlib.compress(json.dumps(model, separators=(",", ":")).encode("utf-8"), 9)
    ).decode("ascii")
    source = args.source.read_text(encoding="utf-8")
    source, n = re.subn(r'_RESIDUAL_MODEL_B64 = "[^"]*"',
                        f'_RESIDUAL_MODEL_B64 = "{encoded}"', source, count=1)
    if n != 1:
        raise SystemExit("could not locate exactly one embedded residual model")

    args.output.mkdir(parents=True, exist_ok=False)
    estimator_path = args.output / "estimator.py"
    estimator_path.write_text(source, encoding="utf-8")
    for name in ("LICENSE", "ATTRIBUTION.md"):
        original = args.source.parent / name
        if original.exists():
            shutil.copyfile(original, args.output / name)
    digest = hashlib.sha256(estimator_path.read_bytes()).hexdigest()
    manifest = {
        "candidate": "v30 plus independent D8b grouped-CV residual correction",
        "source_sha256": hashlib.sha256(args.source.read_bytes()).hexdigest(),
        "model_sha256": hashlib.sha256(args.model.read_bytes()).hexdigest(),
        "estimator_sha256": digest,
        "training_ids": "public independent D8b corpus only; see CV report",
        "status": "exploratory; not externally validated or promoted",
    }
    (args.output / "research-provenance.json").write_text(
        json.dumps(manifest, indent=2) + "\n", encoding="utf-8"
    )
    compile(source, str(estimator_path), "exec")
    print(json.dumps({"output": str(args.output), "estimator_sha256": digest,
                      "selected_degree": int(model_data["degree"]),
                      "alpha": float(model_data["alpha"])}, indent=2))


if __name__ == "__main__":
    main()
