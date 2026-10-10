# Phase-2 partial Kerdock/MUB cubature screen — 2026-10-10

## Motivation and transfer boundary

The archived Phase-1 Kerdock/MUB work reports a useful multifidelity gain on
width-256/depth-32 networks, but its complete 5-design does not scale to
Phase 2. The number of points grows as approximately `d^2`; dense propagation
cost grows as `points * d^2 * depth`. Scaling from `d=256, depth=32` to
`d=1024, depth=16` therefore multiplies the dominant work by about
`16 * 16 * (15/31) = 124x`. Applied to the archived Phase-1 mean effective
compute of `174.8B`, this is roughly `21.6T` FLOPs, or `9.8x` the Phase-2
`2^41` budget. Full-design transfer is not viable.

The falsifiable salvage question was narrower: do a few Phase-2 Kerdock bases
provide a useful low-cost correction direction to the existing analytic
baseline?

## Construction check

Generalized the binary chirp construction to `GF(2^9)` using the irreducible
polynomial `x^9 + x + 1`, with field coordinates `GF(512) x GF(2)`. Checks
passed for all 512 nonzero field elements (`a^511 = 1`), the absolute trace
mapped into `{0,1}`, and all pairwise Walsh spectra among nine test chirps had
constant absolute value `sqrt(1024)=32`. This validates the sampled-basis
construction, not a complete 1024-dimensional 5-design.

## Frozen experiment

- Four distinct MUB/Kerdock bases were selected per network from its public
  seed; the rule used both signs of all 1,024 directions per basis.
- The prediction used only the network weights and seed. Targets were read
  after predictions were fixed.
- IDs 80–89 fit one scalar blend coefficient; IDs 90–99 were held out by
  whole network.
- Baseline predictions, targets, and FLOPs came from
  `.sota/tmp/v29-final-features-confirm-80-99.npz` (SHA-256
  `9457040358acfeda680b53e204c57270e94b153fd16879f64553bf95dd8e00d4`). Its
  metadata says Phase-2 Mini, correction disabled; this is a local baseline
  capture, not an external grade or a cryptographic receipt for the submitted
  artifact.
- Candidate script SHA-256:
  `bc0bc74fd0cb54b85738be0fecb39a938e0e5f4b4701e386232a0e32788a9b39`.
- Result SHA-256:
  `02799662743cccb92cf3b18fdb5dea81638ac83defe8d6c55f4b57f1109d4888`.

## Result

The train-fitted coefficient was `0.003874`. On held-out IDs 90–99, baseline
raw MSE was `2.35437e-8`; the blended raw MSE was `2.34526e-8`, a reduction of
only `0.387%`. The four-basis quadrature by itself had mean MSE `5.07461e-6`,
about 225x the baseline's 20-network MSE (`2.25835e-8`).

The added dense-forward estimate is `274.88B` FLOPs per network, `12.5%` of the
Phase-2 budget. On the same captured IDs the baseline averages `25.86%`
utilization, so the rough combined utilization would be `38.36%`; the measured
0.387% raw-MSE gain cannot pay for that compute. This candidate is rejected.
The exact official FlopScope runner was not used for this standalone NumPy
probe, so the dense cost is an arithmetic estimate, not an official score.

## Decision and next move

Do not submit or integrate this partial-cubature blend. This closes the
four-basis random-subset variant, not every structured cubature or
control-variate design. A larger subset costs more while the observed blend
signal is already tiny; prioritize a fundamentally different correction to
V30's raw error, and require a promising paired result before spending more
time on this family.

Reproduce with:

```sh
OPENBLAS_NUM_THREADS=4 OMP_NUM_THREADS=4 MKL_NUM_THREADS=4 \
  competitions/whestbench/starterkit/.venv/bin/python \
  reports/research/probe_whest_phase2_kerdock_subset.py \
  --start 80 --end 100 --bases 4 \
  --output .sota/runs/whest-phase2-kerdock-4basis-rows80-99-20261010.json
```
