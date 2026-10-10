"""Test whether the Phase-1 weight-only Lyapunov error subspace transfers to P2.

For a captured D8b network, form the closure-gated Jacobian product
    B = (diag(Phi_L) W_L^T) ... (diag(Phi_1) W_1^T)
and measure what fraction of the V30 final residual lies in its top left-singular
subspace. This is a diagnostic only: the target is used only to measure the
projection, never to construct the basis.  The random-subspace control makes the
dimension baseline explicit.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

import numpy as np


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--capture", type=Path, required=True)
    p.add_argument("--weights", type=Path, required=True)
    p.add_argument("--manifest", type=Path, required=True)
    p.add_argument("--network-id", type=int, required=True)
    p.add_argument("--rank", type=int, default=6)
    p.add_argument("--ranks", type=int, nargs="+", default=None,
                   help="optional predeclared exact-subspace rank sweep")
    p.add_argument("--random-trials", type=int, default=256)
    p.add_argument("--approximate", action="store_true",
                   help="also test a matrix-free randomized range finder for deployment feasibility")
    p.add_argument("--oversample", type=int, default=8)
    p.add_argument("--power-iterations", type=int, default=2)
    p.add_argument("--output", type=Path, required=True)
    a = p.parse_args()

    manifest = json.loads(a.manifest.read_text(encoding="utf-8"))
    ids = manifest["corpus_indices"]
    if a.network_id not in ids:
        raise SystemExit(f"network ID {a.network_id} is absent from weight manifest")
    wi = ids.index(a.network_id)
    weights = np.load(a.weights, mmap_mode="r", allow_pickle=False)
    with np.load(a.capture, allow_pickle=False) as z:
        cids = np.asarray(z["indices"], dtype=np.int64)
        if "layer_gate_probs" not in z.files:
            raise SystemExit("capture lacks layer_gate_probs; run extractor with --capture-layer-gates")
        ci = np.flatnonzero(cids == a.network_id)
        if len(ci) != 1:
            raise SystemExit(f"capture contains network ID {a.network_id} {len(ci)} times")
        ci = int(ci[0])
        gates = np.asarray(z["layer_gate_probs"][ci], dtype=np.float64)
        features = np.asarray(z["features"][ci], dtype=np.float64)
        target = np.asarray(z["target"][ci], dtype=np.float64).reshape(-1)
        prediction = np.asarray(z["candidate_prediction"][ci], dtype=np.float64).reshape(-1)
    if gates.shape != weights.shape[1:3] or target.shape != (weights.shape[-1],):
        raise SystemExit(f"shape mismatch: gates={gates.shape}, weights={weights.shape}, target={target.shape}")
    if not 1 <= a.rank <= len(target):
        raise SystemExit("rank must be within the output dimension")

    transport = np.eye(len(target), dtype=np.float64)
    for layer in range(weights.shape[1]):
        w = np.asarray(weights[wi, layer], dtype=np.float64)
        gate = gates[layer]
        jac = gate[:, None] * w.T
        transport = jac @ transport
        scale = np.linalg.norm(transport, ord="fro")
        if not np.isfinite(scale) or scale == 0:
            raise SystemExit(f"transport collapsed or became non-finite at layer {layer}")
        transport /= scale

    u, singular, _ = np.linalg.svd(transport, full_matrices=False)
    basis = u[:, : a.rank]
    residual = target - prediction
    residual_energy = float(residual @ residual)
    if residual_energy <= 0:
        raise SystemExit("residual energy is zero")
    projected = basis.T @ residual
    fraction = float((projected @ projected) / residual_energy)

    # Candidate observable-only correction directions. These do not use the
    # target; target alignment is diagnostic and is never fed back to predict.
    projected_prediction = basis @ (basis.T @ prediction)
    projected_constant = basis @ (basis.T @ np.ones_like(prediction))
    projected_features = basis @ (basis.T @ features)

    def direction_diagnostics(direction: np.ndarray) -> dict[str, float]:
        norm2 = float(direction @ direction)
        cross = float(residual @ direction)
        cosine = cross / np.sqrt(residual_energy * norm2) if norm2 > 0 else 0.0
        return {
            "norm2": norm2,
            "residual_dot": cross,
            "residual_cosine": float(cosine),
            "oracle_alpha": float(cross / norm2) if norm2 > 0 else 0.0,
        }

    rng = np.random.default_rng(20261010 + a.network_id)
    random_fractions = []
    for _ in range(a.random_trials):
        q, _ = np.linalg.qr(rng.standard_normal((len(target), a.rank)))
        v = q.T @ residual
        random_fractions.append(float((v @ v) / residual_energy))
    report = {
        "method": "closure-gated full Jacobian product; top left singular vectors",
        "network_id": a.network_id,
        "rank": a.rank,
        "residual_mse": residual_energy / len(target),
        "lyapunov_subspace_residual_energy_fraction": fraction,
        "projected_prediction_direction": direction_diagnostics(projected_prediction),
        "projected_constant_direction": direction_diagnostics(projected_constant),
        "projected_feature_directions": [direction_diagnostics(projected_features[:, j])
                                         for j in range(features.shape[1])],
        "projected_feature_gram": (projected_features.T @ projected_features).tolist(),
        "projected_feature_residual_cross": (projected_features.T @ residual).tolist(),
        "random_subspace_expected_fraction": a.rank / len(target),
        "random_subspace_empirical_mean": float(np.mean(random_fractions)),
        "random_subspace_empirical_95pct": np.quantile(random_fractions, [0.025, 0.975]).tolist(),
        "top_singular_values": singular[: min(12, len(singular))].tolist(),
        "transport_spectral_gap_s1_s2": float(singular[0] / max(singular[1], np.finfo(float).tiny)),
        "weight_sha256": manifest["weight_sha256"][wi],
        "estimator_prediction_sha256": hashlib.sha256(np.ascontiguousarray(prediction).tobytes()).hexdigest(),
        "warning": "single-network exploratory projection; no corrective coefficients fitted",
    }
    if a.ranks:
        sweep = []
        for rank in a.ranks:
            if not 1 <= rank <= len(target):
                raise SystemExit(f"rank {rank} must be within the output dimension")
            b = u[:, :rank]
            p_res = b.T @ residual
            d = b @ (b.T @ prediction)
            sweep.append({
                "rank": rank,
                "residual_energy_fraction": float((p_res @ p_res) / residual_energy),
                "prediction_direction": direction_diagnostics(d),
            })
        report["rank_sweep"] = sweep
    if a.approximate:
        width = min(len(target), a.rank + a.oversample)

        def apply_b(value: np.ndarray) -> np.ndarray:
            for layer in range(weights.shape[1]):
                w = np.asarray(weights[wi, layer], dtype=np.float64)
                value = gates[layer, :, None] * (w.T @ value)
            return value

        def apply_bt(value: np.ndarray) -> np.ndarray:
            for layer in range(weights.shape[1] - 1, -1, -1):
                w = np.asarray(weights[wi, layer], dtype=np.float64)
                value = w @ (gates[layer, :, None] * value)
            return value

        omega = np.random.default_rng(20261020 + a.network_id).standard_normal((len(target), width))
        q, _ = np.linalg.qr(apply_b(omega), mode="reduced")
        for _ in range(a.power_iterations):
            z, _ = np.linalg.qr(apply_bt(q), mode="reduced")
            q, _ = np.linalg.qr(apply_b(z), mode="reduced")
        reduced = apply_bt(q).T
        uhat, approx_singular, _ = np.linalg.svd(reduced, full_matrices=False)
        approx_basis = q @ uhat[:, : a.rank]
        approx_projected = approx_basis.T @ residual
        approx_prediction_direction = approx_basis @ (approx_basis.T @ prediction)
        overlap = np.linalg.svd(basis.T @ approx_basis, compute_uv=False)
        report["randomized_range_finder"] = {
            "rank": a.rank,
            "oversample": a.oversample,
            "power_iterations": a.power_iterations,
            "residual_energy_fraction": float((approx_projected @ approx_projected) / residual_energy),
            "prediction_direction": direction_diagnostics(approx_prediction_direction),
            "minimum_principal_cosine_vs_exact": float(np.min(overlap)),
            "singular_values": approx_singular[: a.rank].tolist(),
        }
    a.output.parent.mkdir(parents=True, exist_ok=True)
    a.output.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
