# WhestBench quadratic residual calibration: paired and cap screen

Date: 2026-10-03  
Status: diagnostic only; do not submit or promote.

## Question

Does the frozen quadratic terminal residual correction improve the V29 estimator
on untouched Mini rows, and can a shallower Strassen setting make it reliable
under the Phase 2 400 ms residual-time cap?

## Locked inputs and artifacts

- Dataset: Mini rows 86–99; dataset SHA-256
  `264fa1f416d16a40821fb5e8e94f5d2da4698a201d40da999616225b38b464f1`;
  seed protocol 3.0.
- Candidate source SHA-256:
  `a6bf5c3056f5566c2a963d13e067d2d044154719cdac98617c970906e05375d6`.
- V29 control source SHA-256:
  `09453bc0abc8ce3dcc1858cdc3c71b845d9b851bb641ed9321ef161c0fad4954`.
- Candidate quadratic model was fit on Mini IDs 0–79; IDs 86–99 were not
  included in that fit. This is a public-Mini development diagnostic, not proof
  of hidden-grading generalization.
- Candidate residual-cap-1.0 result SHA-256:
  `85dcd9e8691db4e74398956ef5fb4b46df3605a91012a844cd906dbd69baf7f1`.
- Control residual-cap-1.0 result SHA-256:
  `950050c1f27737fa6d47132917cb5c2d2e0b723a8f7d3a2fd14e6575803fb12d`.
- Candidate L5 residual-cap-0.4 result SHA-256:
  `91f6191b44750d14a0a043431d83fac484a33e5c6b1772cd2c74d7404c894f5d`.
- Candidate L4 residual-cap-0.4 result SHA-256:
  `669cecb7f556696e6cd5c18e8a4b5ecb8b42ab66b5e837ca0cf9d522bc40c88d`.
- Candidate batch-8, residual-cap-0.4 result on IDs 86–99 SHA-256:
  `6d23b6fc7b991e8ab77d8613294dc8a1a3b2121a029893f242ac83bbc30db5ddf`.
- Candidate batch-8, residual-cap-0.4 result on IDs 80–99 SHA-256:
  `5df16b569058d09e78dfc19b5473a26e9b4b2598cbe2c4dd9f86c88216ad84f8`.

All runs used the same persistent WhestBench subprocess runner, MLP identities,
seed protocol, BLAS thread limits, and estimator settings except for the stated
Strassen level and residual-time limit. The 1.0-second cap is diagnostic only;
the official cap is 0.4 seconds.

## Results

At the diagnostic 1.0-second cap with batch size 2, candidate and control both
completed all 14 rows. A paired join by MLP name showed 14/14 lower candidate
adjusted scores. The candidate mean adjusted score was `5.959081024377141e-9`
versus `6.036225641879745e-9` for control, a 1.28% paired mean reduction. Mean
raw MSE was `2.2971306000231706e-8` versus `2.3270526585049212e-8` (1.29%
lower). This is diagnostic only; cap 1.0 is not submission-valid.

At the official 0.4-second cap:

| Candidate setting | Rows completed under cap | Residual-time failures | Decision |
|---|---:|---:|---|
| Strassen L5 | 10/14 | 4/14 (Mini IDs 96–99) | Reject; aggregate invalid |
| Strassen L4 | 13/14 | 1/14 (Mini ID 96) | Reject; aggregate invalid |
| Strassen L5, batch size 8 | 14/14 (IDs 86–99) | 0/14 | Cap screen passes; continue holdout check |
| Strassen L5, batch size 8 | 20/20 (IDs 80–99) | 0/20 | Holdout check passes; candidate still not promotable |

The L5 official-cap aggregate (`0.25975859596827383`) and L4 aggregate
(`0.05317020980580152`) are invalid because failed MLPs receive fallback/zero
predictions. Neither number is an estimator score. L4 lowers timing enough to
save three rows but still lacks a reliable margin, and it changes FLOP cost and
adjusted score. Do not compare its aggregate against the diagnostic-cap mean.

At batch size 8, all 20 held-out IDs (80–99) completed under the official cap.
Against the existing full-Mini V29 batch-8 control, the candidate scored
`5.776693226047384e-9` adjusted and `2.2328926974068964e-8` raw, compared with
`5.832455846242325e-9` and `2.2581923175835072e-8` for control: reductions of
0.9561% adjusted and 1.1203% raw, with 18/20 per-MLP adjusted wins. Maximum
candidate residual time was 0.37196 s. A paired MLP bootstrap (100,000
resamples, seed `20261003`) gives a 95% interval of 0.3812–1.4016% adjusted
reduction and 0.7802–1.4353% raw reduction. This is encouraging but not an
independent lockbox: IDs 80–99 are disjoint from coefficient fitting on 0–79,
yet they were already used in previous exploratory probes. Nor does the result
beat the external incumbent's adjusted score.

Official Phase 2 guidance describes 400 ms per MLP as a hard cap and says an
over-cap MLP is scored against zero predictions. See the
[allowed-code and runtime rules](https://github.com/AIcrowd/whest-starterkit/blob/main/docs/concepts/allowed-code.md).

## Decision and next experiment

Do not submit either L5 or L4. The batch-8 quadratic candidate passes the
20-row official-cap holdout check and has a small paired public-Mini signal,
but it still does not beat the external incumbent, has not been validated for
all 100 MLPs with zero failures, and has no external grade. The held-out rows
are not pristine after prior exploratory use. Keep it as a diagnostic branch,
not a promoted estimator. Its calibration data provenance and local-to-hidden
transfer remain separate questions.

Next, use Evidra to investigate a weights-only correction based on the
influence-conditioned moment-closure proposal
(`reports/research/whest-influence-conditioned-estimator-proposal-2026-10-01.md`):
measure whether deployable, weight-derived directions capture signed V29
residual energy on an evaluation cohort not used to choose the method; only
prototype conditional integration if the preregistered oracle/basis thresholds
pass. In parallel, seek a terminal estimator with raw MSE at or below
`1e-8` and compute utilization at or below `0.1`, because the scoring floor
makes either condition alone insufficient for a `1e-9` score. Preserve V29 as
the rollback baseline. Require a full 100-row, zero-failure run under the
official cap, a paired improvement over the exact incumbent artifact, and an
AIcrowd grade before claiming leaderboard progress.
