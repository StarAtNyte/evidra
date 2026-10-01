# WhestBench algorithm direction: gauge-orbit estimation

Date: 2026-10-01  
Status: research hypothesis; paired public-Mini screen in progress. No leaderboard
or submission claim.

## The symmetry we can exploit

For a bias-free ReLU MLP, every hidden neuron admits an exact positive-rescaling
symmetry. If hidden activation `h_l` is reparameterized as

```text
h'_l = h_l D_l,       D_l = diag(exp(g_l)),
W'_l = D_(l-1)^(-1) W_l D_l,
```

with `D_0 = I` and `D_L = I`, the represented function is unchanged because
`ReLU(a c) = c ReLU(a)` for `c > 0`. Therefore its expected activations are
identical too. This is a gauge freedom: many weight tensors encode the same
function.

An approximate estimator need not be invariant to this symmetry. Truncated
cumulant propagation, finite-rank factorizations, clipping, and floating-point
conditioning can produce different answers for different representatives of
the same function. That gives us a new algorithmic degree of freedom without
using labels or training a cross-network predictor: choose a representative
that makes the estimator's approximation state better conditioned.

## First candidate: neuronwise norm equilibration

For each hidden neuron, compare the norm of its incoming column with the norm
of its outgoing row. Rescale the neuron's gauge to equalize them, coordinate
descent style, while clipping log-scales to a fixed range. This is a
weights-only, deterministic transformation; its cost is negligible beside one
V29 pass. The estimator is then run once on the transformed weights.

The larger research family is **gauge-orbit estimation**:

1. Define a cheap weight-only conditioning objective from the actual quantities
   approximated by the chosen estimator (e.g. transported K3/K4 factor norms,
   discarded-tail bounds, and layerwise condition numbers).
2. Optimize hidden-unit log-scales under exact function-preserving gauge
   transformations to minimize that objective.
3. Evaluate the estimator in the selected gauge; optionally average a tiny
   number of diverse gauge representatives only if measured error reduction
   beats the score's compute multiplier.

This is not ordinary weight normalization: the goal is not to standardize
training, but to exploit representation dependence of a fixed approximation
algorithm while preserving the exact target function.

## Preregistered gates

The first screen compares raw V29 against four-sweep incoming/outgoing norm
equilibration on the same public Mini MLP IDs. Before scoring, five random
inputs verify function equivalence. The screen records per-MLP paired MSE,
FLOPs, and maximum function discrepancy. The initial 8-network screen is
exploratory; it cannot select a production method. Continue only if a larger,
predeclared paired set shows a reproducible MSE gain with no evaluator failures
and acceptable adjusted score. Otherwise reject the heuristic and retain the
symmetry insight as a tested negative result.

The full search must separately test whether a weights-only objective can
select gauge parameters across networks. Any objective or scale schedule is
frozen before the confirmation IDs are evaluated. Targets may score a
candidate, but must never choose its gauge.

## Initial screen

A paired screen on public Mini IDs 0–3 reduced pooled final-layer MSE by
`1.63%`; all four networks improved. The median per-network MSE ratio was
`0.98896`. The function-equivalence discrepancy was at most `1.31e-6`
relative. Compute was unchanged on three networks and 4.8% lower on one, so
there is no established compute advantage. This four-network screen is
exploratory and far too small to establish a real effect. A separate
confirmation is required before changing the estimator.

Reproduction command:

```sh
OPENBLAS_NUM_THREADS=2 OMP_NUM_THREADS=2 MKL_NUM_THREADS=2 \
  competitions/whestbench/starterkit/.venv/bin/python \
  reports/research/probe_whest_gauge_balance.py \
  --start 0 --end 4 --output .sota/tmp/whest-gauge-balance-screen-0-3.json
```

## Paired confirmation

The frozen four-sweep rule was evaluated on the separate public Mini IDs 4–19
(16 complete MLPs). It reduced pooled raw final-layer MSE by `0.948%`; 12/16
networks improved. The mean per-MLP log MSE ratio was `−0.00968`; a paired
bootstrap over MLPs gave a 95% ratio interval of `[0.9815, 0.9997]`. Mean
adjusted score, using each run's observed FLOPs and the `2**41` budget, improved
by `1.27%`; 12/16 networks improved. Mean compute utilization was essentially
unchanged (`0.2536` → `0.2528`). The maximum function-equivalence error over the
16 networks was `1.58e-6` relative.

This is evidence for a small effect on this local public-Mini slice, not a
5–6× method, not a full-Mini evaluation, and not an AIcrowd grade. The
confirmation has only 16 networks, and the source-identity caveat below still
applies. Do not submit based on this screen.

```sh
OPENBLAS_NUM_THREADS=2 OMP_NUM_THREADS=2 MKL_NUM_THREADS=2 \
  competitions/whestbench/starterkit/.venv/bin/python \
  reports/research/probe_whest_gauge_balance.py \
  --start 4 --end 20 --output .sota/tmp/whest-gauge-balance-confirm-4-19.json
```

## Why this direction is worth testing

The ARC community's Phase-1 analysis reports a large target-aware oracle for
reweighting a family of deterministic estimator outputs, but poor alignment of
the tested lawful observables with the needed coefficients. Gauge selection
asks a different question: can exact symmetries create a family of equivalent
parameterizations whose approximation errors vary in a predictable way from
the weights alone? A positive answer would turn hidden parameterization
freedom into an estimator design variable; a negative answer is cheap and
decisive. It does not assume that Phase-1 numerical results transfer to
Phase 2.

## References

- ARC Phase-1 technique census, open questions O6/O8/O10:
  https://discourse.aicrowd.com/t/a-technique-census-of-phase-1-what-the-mathematics-is-doing-what-walls-it-hit-and-whats-still-open/18157
- Trim_qewas method-class ceilings and limits of target-unobservable
  per-instance corrections:
  https://discourse.aicrowd.com/t/write-up-submission-326725-measuring-the-ceiling-of-a-method-class-how-we-closed-54-families-of-estimators-without-building-them/18182
