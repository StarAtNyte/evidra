# WhestBench pre-activation closure recheck — 2026-09-30

## Decision

Keep the pre-activation covariance closure as a research candidate, but do not port or
submit it yet. The corrected leave-one-MLP-out probe reproduces a strong depth-wise
fit and is stable on eight public training examples. Its final MSE is not yet compared
against the current best packaged estimator on those same examples, so this does not
establish a score improvement or support a leaderboard claim.

## Protocol

- Data: public Phase 2 Mini training IDs 0–7 only, extracted from the hash-verified
  `v2-phase2` Mini shards. Holdout IDs 80–99 and any private evaluator data were not used.
- Model: the local augmented cumulant propagation implementation, with the historical
  `c+no31+feedc+usec+prefit` configuration.
- Split: for each scored MLP, fit both recurrence coefficients and pre-activation
  lambda coefficients using the other seven MLPs; replay those means on the held-out MLP.
- Local command (repo root):

  ```bash
  PYTHONPATH="$PWD/.sota/vendor/mlp_cumulant_propagation/src" \
  WH_BENCH_DUMP_PATTERN="$PWD/.sota/tmp/whest-dumps-pilot/mlp_{:04d}.npz" \
  LEAN_THREADS=16 \
  .sota/tmp/whest-venv/bin/python \
  .sota/research/whest-p2-cumulant-k3/lean/g_regen_probe.py \
  0,1,2,3,4,5,6,7 xregen:c+no31+feedc+usec+prefit
  ```

## Results

The per-layer through-origin R² for the pre-activation off-diagonal core fit began
between 0.479 and 0.524, rose above 0.90 around layers 4–5, and reached 0.984–0.989
at the final fitted layer. Per-MLP held-out final-layer MSEs were:

| Mini ID | Final MSE |
| ---: | ---: |
| 0 | 2.7182e-8 |
| 1 | 3.4698e-8 |
| 2 | 3.1944e-8 |
| 3 | 2.8870e-8 |
| 4 | 2.6379e-8 |
| 5 | 2.6925e-8 |
| 6 | 2.5392e-8 |
| 7 | 2.4498e-8 |
| **Mean** | **2.8236e-8** |

The earlier probe implementation produced a declining R² because it omitted the
post-layer fitted recurrence from the reference trajectory. A first attempt to use the
correct recurrence also stopped after scoring ID 0 because of a reporting-only
`UnboundLocalError`; no workspace or competition data was changed by that failed run.
The probe was corrected and the full leave-one-out run above completed. Its ignored
experimental script is local under `.sota/research/` and is intentionally not part of
the public CLI.

## Interpretation / next gate

The historical table in the research notes is not numerically reproduced at several
middle/deep layers on today's pinned public examples. The fit trend is reproduced, but
the coefficient differences make direct reuse of the old table unjustified. Before
porting, run the current best V29 artifact through the same eight Mini IDs and compare
paired per-MLP errors and evaluator FLOP cost. Then test a frozen, training-only fitted
table against V29 on the full public Mini split; preserve the locked official validation
path, and spend a submission only if the paired local gate shows a robust improvement.

## Date correction

Phase 2 submissions close **October 17, 2026 at 23:59**. The algorithmic-contribution
write-up is due October 24; that is a write-up deadline after the evaluator closes, not
the submission deadline.
