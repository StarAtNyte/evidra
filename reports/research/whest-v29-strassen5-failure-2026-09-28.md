# WhestBench V29 STRASSEN=5 reduced-screen failure

Date: 2026-09-28 UTC  
Purpose: durable diagnosis for the active score-improvement campaign. This is a failed
execution record, not a score comparison, candidate win, or submission recommendation.

## Run identity

- Experiment: `exp_1790567454324_-row-paired-v29-v26-strassen-5-s`
- Run: `exp_1790567454324_-row-paired-v29-v26-strassen-5-s-1790567732351`
- Stage: reduced validation, exact configured route `uv run python evaluate_batched.py --estimator estimator.py --dataset .whest-data --split mini --limit 4`
- Evaluator: WhestBench 0.16.1, persistent subprocess runner, 4 MLPs, 2 worker threads
- Data: `v2-phase2`, SHA-256 `264fa1f416d16a40821fb5e8e94f5d2da4698a201d40da999616225b38b464f1`
- Estimator: V29 source SHA-256 `86d9ca9b28e6fe2b6c74750a0b6ae4bba4c14f742ddc3f5f56bc7fb4ec9d8e27`
- Only estimator override: `V26_STRASSEN=5`; BLAS/OpenMP thread counts were 2
- Limits: 2,199,023,255,552 FLOPs per MLP, 120 s per prediction, 0.4 s residual allowance
- Exit: 1 after 219.005 s; Evidra classified `memory_exhausted`
- Full redacted evidence: `.sota/artifacts/exp_1790567454324_-row-paired-v29-v26-strassen-5-s-1790567732351/`

## Per-row outcome

| Index | MLP | Result | Adjusted score | Final-layer MSE | Failure |
|---:|---|---|---:|---:|---|
| 0 | `logan-fitzgerald` | completed | 6.11435746e-9 | 2.28953976e-8 | — |
| 1 | `william-graves` | failed | 1.12391067 | 1.12391067 | NumPy could not allocate a 375 MiB `(10, 7, 343, 64, 64)` float32 array |
| 2 | `raymond-barnes` | failed | 1.23098218 | 1.23098218 | worker closed stdout after the memory failure |
| 3 | `steven-rice` | completed | 6.67227746e-9 | 2.49845460e-8 | — |

The aggregate adjusted score `0.5887232157` includes two evaluator failure penalties. It is
invalid for candidate comparison, ranking, or promotion. The two successful rows alone also do
not establish a paired improvement.

## Next bounded action

Do not repeat STRASSEN=5 unchanged. Run one fresh-worktree, same-source, same-data-prefix
diagnostic with a lower-memory setting (first test `V26_STRASSEN=4`; if that still allocates
excessively, reduce evaluator worker concurrency where the adapter supports it). Preserve all
per-row results. Any failed row ends this screen as invalid; do not proceed to full-mini or
submission. If the lower-memory route is zero-failure, compare only the identical four rows to
the pinned control before deciding whether to spend on 100-row mini validation.

This outcome is specific to the tested estimator/configuration. Harness-level generalization:
failed-stage metrics remain available as diagnostics but are ineligible for comparisons, and
the research graph must not promote failed-run aggregates into score evidence.
