# V29 residual subspace ceiling on held-out Phase-2 Mini MLPs

Date: 2026-10-01  
Status: diagnostic screen; low-rank output-space correction is a weak route. No candidate or score claim.

## Question

Can a correction to V29's final 1,024-vector be restricted to a small output
subspace and still remove a substantial portion of the residual? This is an
oracle projection diagnostic: the basis may be chosen without targets, but the
reported projection energy uses the true residual and therefore is not a
deployable correction. Actual coefficients would still need a weights-only
predictor.

## Split and method

Used frozen paired V29 feature captures: IDs 0–79 for basis construction and
IDs 80–99 for held-out measurement. The held-out residual is
`r_i = target_i - prediction_i`. Compared:

1. A **shared oracle basis**: right singular vectors of the 80-by-1,024
   training residual matrix. This basis uses training targets, then transfers
   to unseen MLPs.
2. A **per-network weights-only basis**: the leading output-space right
   singular vectors of each held-out MLP's final-layer weight matrix. The
   held-out network's weights select its basis; its target is used only to
   measure the oracle fraction `||P r_i||² / ||r_i||²`.

Reproduction:

```sh
OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=1 \
python reports/research/probe_whest_residual_subspace_ceiling.py \
  --output .sota/tmp/whest-residual-subspace-ceiling.json
```

| Rank | Shared oracle mean capture | Per-network final-weight basis mean capture |
| ---: | ---: | ---: |
| 1 | 0.09% | 0.14% |
| 2 | 0.23% | 0.34% |
| 4 | 0.38% | 0.88% |
| 8 | 0.85% | 1.68% |
| 16 | 1.70% | 3.68% |
| 32 | 3.35% | 7.03% |
| 64 | 6.30% | 13.39% |

Thus the shared target-derived subspace generalizes poorly, while the
weights-only final-layer basis captures more but still only 13.4% at rank 64.
Even an oracle coefficient restricted to that rank-64 basis cannot remove
more than that fraction of squared residual energy on average. The steeply
increasing dimension required for higher capture is a warning under the
challenge FLOP budget. This argues against low-rank final-output correction as
the desired multi-fold improvement route. It does not test richer
layer-propagated influence bases, changes inside the estimator, or
nonlinear/cross-network correction rules.

## Artifact integrity and limitations

- Train capture SHA-256: `6235d4e940916d75c7cb66c140968389d5e3d2fe8f0536199c735293b99d46d0`
- Held-out capture SHA-256: `9457040358acfeda680b53e204c57270e94b153fd16879f64553bf95dd8e00d4`
- The capture metadata says `correction_applied: false` and dataset revision
  `v2-phase2`.
- The existing V29 residual report records that the local source hash differs
  from the historical archive member hash. Therefore these results describe
  the captured local variant, not a byte-verified reproduction of the
  leaderboard archive.
- The shared SVD basis is an oracle because it is learned from training
  residuals; the per-network basis is weights-only, but its projection
  coefficients are oracle. Neither projection fraction is an adjusted-score
  gain or an AIcrowd result.
