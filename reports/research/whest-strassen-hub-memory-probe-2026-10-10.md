# Strassen hub-memory probe — 2026-10-10

## Decision

Reject the existing V30 Strassen level-7 configuration. Setting
`V29_MAX_BATCH=1` does not bound the high-order hub contraction's batch axis;
the test still failed before producing a prediction. This is a resource failure,
not a score measurement, and the variant is not eligible for submission.

## Reproduction

From `competitions/whestbench/starterkit`, with the frozen V30 estimator and
Mini dataset:

```sh
V26_STRASSEN=7 V26_STRASSEN_HUB=7 V28_STRASSEN_SB=7 \
V29_CPRE_LEV=7 V28_STRASSEN_FIRST=7 V29_MAX_BATCH=1 \
OPENBLAS_NUM_THREADS=2 OMP_NUM_THREADS=2 MKL_NUM_THREADS=2 \
uv run whest run \
  --estimator ../../../.sota/candidates/whest-v30-cubic-residual-strassen8-20261009/estimator.py \
  --dataset .whest-data --split mini --n-mlps 1 --runner subprocess \
  --max-threads 2 --detail full --format json
```

The first Mini MLP (`logan-fitzgerald`, index 0) failed with `PREDICT_ERROR`
while allocating a 689 MiB array of shape `(6, 7, 16807, 16, 16)`. The traceback
lands in `_Strassen.hub` → `_combos` through `_hub2`; the `V29_MAX_BATCH`
wrapper only patches `_Strassen.mm`, so it does not constrain this allocation.
The resulting zero-fill MSE (`0.9434763`) and adjusted score are failure
fallbacks and must not be compared with estimator scores.

Prior two-row level-7 probes independently failed on the second network with
98.5 MiB and 525 MiB allocation errors. Together these observations reject the
unmodified level-7 route under current memory limits. Any follow-up must be a
new source variant that explicitly chunks the hub's summed source axis, verifies
prediction parity against V30, and passes the official residual-time and
memory constraints. Chunking may add reduction overhead, so it is not assumed
to improve adjusted score until measured.

## Score context

The public discussion documents the score as `final_layer_mse × max(0.1,
compute_utilization)`. Once below the 10% floor, reduced compute alone has no
benefit; improving accuracy is necessary. See the [scoring-mechanics
discussion](https://discourse.aicrowd.com/t/phase-2-the-compute-budget-is-not-a-lever-and-the-scoring-rule-is-why-adjusted-mse-x-max-0-1-util/18219).

The incumbent remains V30 / AIcrowd #335034 at adjusted `5.162197424910759e-9`.
The public board's leading raw MSE is around `1.36e-8`, so the remaining path
requires real accuracy improvement as well as safe compute efficiency. The
[leaderboard](https://www.aicrowd.com/challenges/arc-white-box-estimation-challenge-2026/leaderboards)
is mutable; record a dated snapshot before making score claims.
