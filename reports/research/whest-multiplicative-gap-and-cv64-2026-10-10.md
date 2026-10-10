# WhestBench multiplicative gap and V30 feature-CV screen — 2026-10-10

## Decision

Do not package or submit the frozen LightGBM residual correction tested here.
It failed to improve the independent 64-network grouped-CV mean and has no
evidence for the requested multi-fold score gains. Preserve the V30/#335034
incumbent. V32/#335132 and V33/#335136 are already distinct exploratory
submissions; do not resubmit them.

## Why the target requires structural progress

The verified Evidra incumbent is AIcrowd #335034: adjusted score
`5.162197424910759e-9`, raw final-layer MSE `2.1092689479473848e-8`.
The public board snapshot observed 2026-10-10 shows #1 at adjusted
`1.4e-9`, raw MSE `1.36e-8`, and utilization `0.1065`.

Thus the observed ~3.69x adjusted-score gap decomposes into about 1.55x raw
MSE and 2.42x utilization. A compute-only improvement cannot account for the
whole gap; accuracy and cost must both move materially. The leaderboard is a
public score reference, not evidence about the hidden final evaluation.

## Frozen 64-network residual-correction screen

The predeclared four-fold, whole-network-grouped LightGBM configuration was
run unchanged on 64 manifest-aligned independent D8b networks. No Mini targets
were used to fit or choose this screen. Results:

| Quantity | Result |
|---|---:|
| V30 base mean MSE | `2.2098584054429352e-8` |
| CV-corrected mean MSE | `2.2142196969783047e-8` |
| Relative MSE reduction (negative means worse) | `-0.1832%` |
| Networks improved | `28/64` |
| 95% network-bootstrap CI for relative reduction | `[-0.4971%, +0.1182%]` |

This is consistent with no gain and a small regression. It is nowhere near a
2x accuracy improvement; reject this correction family for promotion. The
result does not rule out all learnable corrections, only this frozen feature
set and model configuration.

Artifacts:

- Capture: `.sota/runs/whest-v30-learned-cv64-capture-20261010.npz`
- Capture SHA-256: `951948901211fe7550c3b5e22fba7b269c329b54acf8229d64bfa02fe3cd7dd7`
- CV result: `.sota/runs/whest-v30-learned-cv64-final-20261010.json`
- CV result SHA-256: `2d171ab63a90453c4fe208c5d1ba77a64e0ec2ce98efa52030820c3844d4451a`
- Evaluator: `reports/research/evaluate_whest_v30_feature_lightgbm.py`

## Higher-upside search direction

The published factorized-K3 investigation reports raw MSE around `2.13e-8`
at `0.253` utilization, with most remaining cost in long-lived third-cumulant
sources; dropping the old-source tier sharply harms accuracy. Current leaders
are materially better on both raw error and compute, while their exact method
is not established by public scores. This motivates studying a different
representation or recurrence for long-range non-Gaussian source information,
not assuming the leaders use any particular technique.

Next experiments should first derive a cost/error prediction for alternatives
to per-source transport and the current shared-basis storage, then test the
highest-upside mechanism behind a staged compute gate. Explicitly track raw MSE
and utilization separately. Deprioritize small scalar, feature, or parameter
tweaks unless they are a validated component of a method with multiplicative
potential. Require source identity, contract validation, and zero-failure
full-Mini evaluation before promotion or any claim of improvement.

References:

- [Live public leaderboard](https://www.aicrowd.com/challenges/arc-white-box-estimation-challenge-2026/leaderboards)
- [Factorized K=3 cost anatomy and measured dead ends](https://discourse.aicrowd.com/t/everything-we-tried-a-factorized-k-3-cumulant-propagation-estimator-at-0-25-x-b-where-its-flops-go-and-25-measured-dead-ends-team-504aldo-rank-10/18218/1)
- [Score/utilization mechanics](https://discourse.aicrowd.com/t/phase-2-the-compute-budget-is-not-a-lever-and-the-scoring-rule-is-why-adjusted-mse-x-max-0-1-util/18219)
