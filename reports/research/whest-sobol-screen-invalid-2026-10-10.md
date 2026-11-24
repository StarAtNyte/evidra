# Scrambled-input quadrature screen — invalid run (2026-10-10)

## Outcome

Do not interpret this as an estimator score or a leaderboard comparison. The
four-network reduced validation failed on all four MLPs before prediction:
the estimator attempted indexed assignment into an immutable Flopscope array.
The run is invalid and cannot establish whether the underlying idea improves
or regresses accuracy.

The emitted `1.0590112805366516` is an aggregate failure penalty with
`n_failed_mlps=4` and `mean_compute_utilization=0`; it is not candidate MSE.

## Implementation audit

- Experiment: `exp_1791633431678_mbled-sobol-antithetic-input-int`
- Candidate SHA-256: `3c8cde5a257bc69513eb5d0e3fb77a5c091beeebec4a9cc13f80bdbe309180f`
- Evaluator: WhestBench `0.16.1`, persistent subprocess runner, four-row Mini
  prefix, candidate command `uv run python evaluate_batched.py --estimator
  estimator.py --dataset .whest-data --split mini --limit 4`
- Failure: `flopscope arrays are immutable`; `_scrambled_sobol_normals` writes
  `points[i] = ...` instead of building rows functionally.
- Artifact: `.sota/artifacts/exp_1791633431678_mbled-sobol-antithetic-input-int-1791633647511/`

Separate from the runtime error, the implementation is not a standard
high-dimensional Sobol construction: it repeats a one-dimensional
van-der-Corput sequence across coordinates with independent digital shifts.
Thus even a mechanical immutability fix would not validate the stated
high-dimensional Sobol hypothesis. No full run or submission is justified by
this artifact. Any future QMC route needs a correct multidimensional sequence,
a frozen candidate/control manifest, and comparison with the exact archived
V30 estimator on paired networks before consuming more compute.
