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

All runs used the same persistent WhestBench subprocess runner, MLP identities,
seed protocol, BLAS thread limits, and estimator settings except for the stated
Strassen level and residual-time limit. The 1.0-second cap is diagnostic only;
the official cap is 0.4 seconds.

## Results

At the diagnostic 1.0-second cap, candidate and control both completed all 14
rows. A paired join by MLP name showed 14/14 lower candidate adjusted scores.
The candidate mean adjusted score was `5.959081024377141e-9` versus
`6.036225641879745e-9` for control, a 1.28% paired mean reduction. Mean raw MSE
was `2.2971306000231706e-8` versus `2.3270526585049212e-8` (1.29% lower).
This small, selected 14-row public-Mini diagnostic is not a full-Mini result.

At the official 0.4-second cap:

| Candidate setting | Rows completed under cap | Residual-time failures | Decision |
|---|---:|---:|---|
| Strassen L5 | 10/14 | 4/14 (Mini IDs 96–99) | Reject; aggregate invalid |
| Strassen L4 | 13/14 | 1/14 (Mini ID 96) | Reject; aggregate invalid |

The L5 official-cap aggregate (`0.25975859596827383`) and L4 aggregate
(`0.05317020980580152`) are invalid because failed MLPs receive fallback/zero
predictions. Neither number is an estimator score. L4 lowers timing enough to
save three rows but still lacks a reliable margin, and it changes FLOP cost and
adjusted score. Do not compare its aggregate against the diagnostic-cap mean.

Official Phase 2 guidance describes 400 ms per MLP as a hard cap and says an
over-cap MLP is scored against zero predictions. See the
[allowed-code and runtime rules](https://github.com/AIcrowd/whest-starterkit/blob/main/docs/concepts/allowed-code.md).

## Decision and next experiment

Do not submit either L5 or L4. Do not promote the 1.28% public-Mini gain. The
candidate has not passed the reliability gate, has not been validated across
all 100 Mini MLPs, and has no external grade. Its calibration data provenance
and the local-to-hidden transfer remain separate questions.

Next, stop spending time on cap-edge terminal regressors. Use Evidra to
investigate a weights-only correction based on the influence-conditioned
moment-closure proposal (`reports/research/whest-influence-conditioned-estimator-proposal-2026-10-01.md`):
first measure whether deployable, weight-derived directions capture signed
V29 residual energy on disjoint MLP groups; only prototype conditional
integration if the preregistered oracle/basis thresholds pass. Preserve V29 as
the rollback baseline. Require a full 100-row, zero-failure run under the
official cap, a paired improvement over the exact incumbent artifact, and an
AIcrowd grade before claiming progress toward `1e-9`.
