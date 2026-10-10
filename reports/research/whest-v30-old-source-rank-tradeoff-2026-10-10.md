# V30 old-source rank trade-off screen — 2026-10-10

## Question

Can the nested old-source shared-basis ranks be reduced to lower adjusted score
without damaging the V30 estimator's accuracy? The tested override was
`V21_R_OLD=256`, `V24_R_OLD2=128`, against defaults 384 and 224.

## Paired result

WhestBench 0.16.1, persistent subprocess runner, same two locked public Mini
networks (IDs 80–81), dataset SHA-256
`faebae2b7ecc57a3a0687f863094235ce2d3d3d457bd1c564ee74a5ddd29fa4b`, one
BLAS thread, same archived V30 source. Both runs had zero failures.

| Old-source ranks | Mean raw MSE | Mean adjusted score | Mean FLOPs | Relative to defaults |
|---|---:|---:|---:|---:|
| Defaults 384 / 224 | `1.91280e-8` | `4.81513e-9` | `552.43B` | reference |
| Reduced 256 / 128 | `2.61421e-8` | `5.54385e-9` | `466.49B` | FLOPs −15.6%, raw MSE +36.6%, adjusted score +15.1% |
| Reduced 192 / 96 | `4.01398e-8` | `7.93815e-9` | `434.85B` | FLOPs −21.3%, raw MSE +109.9%, adjusted score +64.9% |

Both individual rows regressed in adjusted score: ID 80 from `5.29543e-9` to
`5.68079e-9`; ID 81 from `4.33483e-9` to `5.40690e-9`. (The mean raw-MSE
increase is 36.6%; individual row increases were 26.4% and 48.5%.) The older
20-row artifact also reproduced the two default rows exactly, supporting the
pairing.

The more aggressive 192/96 point also regressed on both networks (adjusted
scores `8.2259e-9` and `7.6504e-9`). It still used 19.8% of budget, so rank
truncation did not approach the 10% floor before its accuracy cost dominated.

## Decision

Reject this rank reduction. The measured compute savings do not pay for the
accuracy loss, even though both candidates remain above the 10% compute floor.
Do not package or submit it. This two-network screen does not rule out a
different, accuracy-preserving compression of old-source interactions, but
simple rank truncation is not a path to the requested multiplicative gains.

## Artifacts

- Default: `.sota/runs/whest-v30-default-ranks-rows80-81-20261010.json`
- Reduced: `.sota/runs/whest-v30-rank256-rank128-rows80-81-20261010.json`
- Aggressive reduced: `.sota/runs/whest-v30-rank192-rank96-rows80-81-20261010.json`
- Candidate archive: `.sota/candidates/whest-v30-cubic-residual-strassen8-20261009/submission.tar.gz`
- Source SHA-256: `89395749c6a1b3cc12ff230a770c85d0bdb26f2f68d85023dfab12bd27920315`
