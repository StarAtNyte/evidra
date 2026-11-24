# WhestBench method frontier notes

Date: 2026-09-30. This is external-literature triage, not a local result.
The public Mini set is not a hidden leaderboard set; no transfer claim follows
from a Mini measurement.

## Current local anchor

Our strongest known local score is the V29 factorized K=3 / regenerated-K4
estimator, adjusted `5.418168137938331e-9` on AIcrowd submission `332337`.
The 2026-09-30 mixed Strassen-depth candidate (`global 5 / hub 4 / C_pre 4 /
shared-basis 5`) failed one row on its full 100-row public Mini evaluation,
so it has no valid aggregate score. The failure was at row 79 with residual
time `0.52808 s`; the closest passing row was `0.39763 s` against a `0.4 s`
cap. A hub-3 20-row screen also failed row 10 and its 19 successful rows
averaged `5.93227e-9` versus `5.89914e-9` for matched level-4 controls (0/19
wins). Neither candidate is eligible for submission.

Batch-size-8 chunking made the C_pre-4/hub-4 arm valid on the full 100-row
Mini split: adjusted `5.75791e-9`, raw `2.22854e-8`, zero failures, maximum
residual `0.36708 s`. Predictions match the level-4 control to numerical noise;
the 2.39% paired score improvement is cost-only. It does not beat Evidra's
best graded score (about `5.42e-9`), so this is a validated optimization, not a
leaderboard promotion. The detailed artifact and row audit are in
`whest-cpre-hub-depth-screen-2026-09-30.md`.

## Public evidence reviewed

1. The 504aldo V29 write-up reports that its K3 + memoryless-K4 accuracy
   plateaued around raw MSE `2.13e-8`; most later improvements reduced compute,
   not raw error. It estimates the frontier leaders then had raw `1.7–2.0e-8`
   at `0.145–0.16 × B`, implying an accuracy mechanism beyond that closure.
   Its failure catalog explicitly warns that sampling variants are far worse
   as standalone estimators and can at best be a low-cost sidecar. [Forum
   write-up](https://discourse.aicrowd.com/t/everything-we-tried-a-factorized-k-3-cumulant-propagation-estimator-at-0-25-x-b-where-its-flops-go-and-25-measured-dead-ends-team-504aldo-rank-10/18218)
2. A separate submission reports a fixed 0.75 gain-covariance / 0.25
   whitened-antithetic-MC blend: local adjusted MSE `3.044e-7` versus
   `4.050e-7` baseline, with branch residual correlation `0.0382`. That supports
   error-complementarity as a general design principle on its measured cohort,
   but its absolute accuracy is roughly two orders of magnitude worse than our
   V29 path; directly adding that branch is not a plausible next leaderboard
   candidate without a much cheaper, high-value residual estimator. [Forum
   summary](https://discourse.aicrowd.com/t/phase-2-write-up-complementary-errors-beat-either-branch-a-fixed-0-75-0-25-covariance-whitened-antithetic-mc-blend-submission-328274/18200)
3. In discussion under the V29 write-up, another implementation reported that
   the off-diagonal K4-core ≈ scalar × covariance relationship degraded sharply
   with depth in its *different* representation (through-origin R² about 0.12
   at layers 8–14, 0.045 at the last layer). This does not falsify the V29
   approximation; it does show that the closure is representation-dependent
   and deserves a direct measurement in the V29 representation before more
   fitted correction is attempted.

## Proposed next research test (not yet run)

Use the official loader and a small fixed set of public Mini MLPs to capture
the V29 chain's available K4-core / covariance observables layer by layer.
Measure through-origin and intercept fits against both pre- and post-ReLU
covariance, plus shuffled-covariance and diagonal-only negative controls. Keep
the existing estimator outputs and FLOP instrumentation unchanged. If the
predictor has stable out-of-network explanatory value under leave-one-MLP-out
validation, implement one low-rank residual basis or one extra basis observable
as a new estimator arm. Otherwise record a negative and do not spend a full
100-row run. No post-hoc fit to the public Mini ground truth may ship.

This test targets the likely gap between the V29 accuracy plateau and leading
scores: richer fourth-cumulant structure at nearly the same compute, rather
than another Strassen-only cost adjustment. Exact contraction cost, residual
wall-time margin, score formula, and candidate-source hashes remain mandatory
gates.
