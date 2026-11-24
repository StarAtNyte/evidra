# WhestBench evaluator parity and integrity note

Date: 2026-09-27 UTC. Scope: bounded development evidence for ARC WhestBench
Phase 2; this is not a hidden-split or leaderboard-improvement claim.

## Fixed-input parity

Both commands evaluated the same starter-kit mean-propagation estimator on the
first four rows of the public `v2-phase2` `mini` split, using a persistent
`whest run --runner subprocess` worker, `V26_STRASSEN=5`, and BLAS/OMP thread
limits of 2. One path was direct `uv run whest run ... --n-mlps 4`; the other
was `uv run python evaluate_batched.py ... --limit 4`.

| MLP | Adjusted score, both paths | Raw MSE, both paths | Failed |
| --- | ---: | ---: | --- |
| logan-fitzgerald | 2.0463718101382256e-5 | 2.0463718101382256e-4 | no |
| william-graves | 2.491719205863774e-5 | 2.491719205863774e-4 | no |
| raymond-barnes | 2.545529860071838e-5 | 2.545529860071838e-4 | no |
| steven-rice | 2.5671551702544094e-5 | 2.5671551702544093e-4 | no |

Both paths returned aggregate adjusted score `2.412694011582062e-5`, raw MSE
`2.412694011582062e-4`, and 0/4 failures. The Evidra wrapper independently
verified the official score formula on all four rows. This proves parity only
for this estimator, environment, configuration, and prefix—not for a full split
or a candidate-vs-baseline improvement.

## Bounded data and feature/target check

PyArrow projected only identity columns from all seven local Parquet shards:
100 rows, identical schemas, 100 unique `mlp_id`, `mlp_name`, and `mlp_seed`,
with IDs spanning 0–99. The multi-gigabyte weight and target tensor columns were
not decoded in this check. Inspection of the installed WhestBench 0.16.1
`domain.MLP.from_row` and `subprocess_worker` confirms estimator input consists
of the weights, seed, name, and shape; `all_layer_means` and `final_means` are
not sent to `predict()`. Those target columns are present in public data for
scoring and must not be used as estimator inputs for the rows being validated.

The generic auditor has a 50 MiB inspection cap and skips the seven large
Parquet files. The bounded inspection does not verify upstream data hashes,
all tensor contents, or hidden-split distribution. The unresolved portion was
explicitly accepted to continue experiments on public mini only; it is not
leakage clearance for promotion.

## External score reference and gate

AIcrowd public submission 332337 is recorded in Evidra as the incumbent at
adjusted `5.418168137938331e-9`; the supplied 2026-09-27 leaderboard lists a
public best of `1.9481866772240242e-9`. This supersedes the stale historical
`7.126664527768703e-9` reference. V29 is not a new candidate merely because it
was previously graded. A new candidate requires matched MLPs, all per-row
failure/tail telemetry, independent replication, and a full 100-row persistent
run with zero failures and improvement over 332337. No submission is authorized
from the API key pasted into chat; use a newly rotated, securely configured key
after the local gate passes.

## Harness note and next experiment

`src/core/validation-engine.ts` integrity gates require successful baseline and
candidate runs and reject reported evaluator or verifier failures. Relevant
regressions are exercised in `tests/core-smoke.mjs` around the test named
“validation acceptance requires replicated evidence and safety gates”. The
latest repository suite passed 596/596 tests.

Next: test one accuracy-changing estimator hypothesis (not a compute-only V29
knob) on identical MLP inputs, then replicate it. Keep generic Evidra reliability
work separately measured from this competition-specific outcome.
