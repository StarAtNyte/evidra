# Cross-family scalar blend against V30 — D8b screen (2026-10-10)

## Result

Reject a pooled scalar blend of the captured starter-derived control with V30.
On 64 D8b networks, four-fold network-disjoint fitting produced a mean raw-MSE
ratio of `1.0000411` versus V30 alone: a `0.0041%` regression, with 33/64
networks improving. This branch offers no evidence for a multiplicative jump.

## Frozen calculation

For each held-out fold, fit one scalar on the other network IDs:

`p_blend = p_V30 + alpha * (p_control - p_V30)`

The control branch is the `base_prediction` stored with the V30 feature
capture. Alpha was fit only on the other three folds; targets for a held-out
network were not used to select its coefficient. The split seed was
`20261010`, with four folds assigned at the network level.

| Measure | Result |
|---|---:|
| Networks | 64 |
| V30 mean raw MSE | `2.2098584054429352e-8` |
| Cross-fitted blend mean raw MSE | `2.2099491221904268e-8` |
| Blend / V30 | `1.0000410509` |
| Relative reduction | `-0.004105%` |
| Networks improved | `33 / 64` |
| Fold-fitted alpha | `-0.0722, -0.0430, -0.0011, -0.0613` |

The scalar varies by fold and remains small; this is consistent with the
branches carrying almost the same error direction, not useful complementarity.
Do not add this branch or tune alpha on these held-out results. A materially
different auxiliary estimator would need a measured residual-correlation and
cost advantage before an ensemble screen is justified.

## Provenance and limits

- Capture: `.sota/runs/whest-v30-learned-cv64-capture-20261010.npz`
- Capture SHA-256: `951948901211fe7550c3b5e22fba7b269c329b54acf8229d64bfa02fe3cd7dd7`
- The capture contains 64 D8b network IDs, V30 predictions, control predictions,
  targets, and V30-derived features. It is a diagnostic dataset, not the
  leaderboard's hidden evaluation set.
- This is a cross-fitted public-data screen only. It does not change the
  submitted artifact or establish an AIcrowd score.
