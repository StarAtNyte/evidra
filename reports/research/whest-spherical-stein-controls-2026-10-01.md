# Spherical Stein controls for WhestBench: derivation and pilot

Date: 2026-10-01  
Status: mathematically valid control family; empirically too weak in current form. No submission candidate.

## Derivation

The Phase-2 input is `X ~ N(0, I_d)`. Write `X = R U`, where `U` is uniform on
the unit sphere and independent of `R = ||X||`. A zero-bias ReLU network is
positively homogeneous of degree one, so `f(RU) = R f(U)` and

`E[f(X)] = E[R] E[f(U)]`,

where `E[R] = sqrt(2) Gamma((d+1)/2) / Gamma(d/2)`.

For a first-layer neuron, let `h_j(U) = (w_j^T U)_+`. Its square is
continuously differentiable across the ReLU kink. The spherical
Laplace–Beltrami operator gives, away from the measure-zero kink,

`Delta_S h_j(U)^2 = 2 ||w_j||^2 1[w_j^T U > 0] - 2 d h_j(U)^2`.

Rotational symmetry yields `P(w_j^T U > 0) = 1/2` and
`E[h_j(U)^2] = ||w_j||^2/(2d)`, hence `E[Delta_S h_j^2] = 0` exactly.
Therefore, for any coefficient vector `beta` chosen independently of the
evaluation directions,

`E[R f(U) - beta^T Delta_S h(U)^2] = E[f(X)]`.

This is an unbiased control-variate estimator. Coefficients can be fit on
independent pilot directions and evaluated on held-out directions without
target leakage. The identity is exact, but it does not guarantee that these
particular controls correlate with the estimator's error.

## Experiment

Implementation: `probe_whest_spherical_stein.py`. Each replicate used 4,096
pilot and 4,096 held-out antithetic sphere directions per MLP. PCA and ridge
coefficients used pilot samples only; public Mini `final_means` were used only
to score the already-frozen held-out estimate. The measure is raw final-output
MSE versus plain Monte Carlo on the same held-out directions—not the official
adjusted score, not a full evaluator run, and not a leaderboard grade.

| Public Mini IDs | Control rank | Mean per-network MSE ratio | Networks improved | Mean variance removed |
| --- | ---: | ---: | ---: | ---: |
| 0–3 | 64 | 0.9887 | 3/4 | about 1.0% |
| 4–7 | 16 | 1.0044 | 1/4 | about 0.3% |

The rank-64 result is a small exploratory signal on four networks with only two
replicates; individual replicate ratios cross 1.0. The rank-16 result is flat
to harmful on the disjoint four. These samples are far too small to establish
transfer. Added feature evaluation and fitting also cost compute, which has
not been accounted for in FlopScope. Reject this form as a submission change.

Reproduce from repository root:

```sh
python reports/research/probe_whest_spherical_stein.py \
  --start 0 --end 4 --samples 8192 --replicates 2 --rank 64 \
  --ridge-fraction 0.05 --output .sota/tmp/whest-spherical-stein-r64-0-3.json

python reports/research/probe_whest_spherical_stein.py \
  --start 4 --end 8 --samples 8192 --replicates 2 --rank 16 \
  --ridge-fraction 0.05 --output .sota/tmp/whest-spherical-stein-r16-4-7.json
```

## Mathematical next step, not yet tested

The Laplacian features are functions of first-layer gates, but their relation
to final-output error is indirect. A different control family follows from
the Gaussian score identity. For any integrable scalar output `f_k`,

`E[X f_k(X)] = E[grad f_k(X)]`.

Thus a pilot-fitted linear control `b_k^T X` has known expectation zero, and
`mean(f_k(X) - b_k^T X)` remains unbiased on independent evaluation samples.
The optimal coefficient is the first Hermite coefficient of the output,
`b*_k = Cov(X, f_k(X))`; estimate it from pilot data, then shrink/project it
onto a small, weights-only subspace to avoid fitting 1,024 noisy coordinates.
Candidate subspaces include leading input-space directions of a matrix-free
weight/tangent Gramian. This is related to, but not the same as, regressing on
the nonlinear first-layer activations. It should be tested as a separate
preregistered experiment with disjoint MLP groups and full FLOP accounting.

A much larger result would require the chosen subspace to explain substantial
V29 residual variance. Set an oracle upper-bound test first: measure residual
energy captured by the best rank-k projection, then measure how much the
weights-only subspace captures. If the oracle ceiling is low, stop before
implementing an expensive estimator. No multi-fold improvement is implied by
the derivation or these pilot results.

## Integrity and limitations

- Dataset: public `v2-phase2` Mini, IDs 0–7.
- Pilot/evaluation directions are independently sampled within each replicate.
- IDs are exploratory, not a locked confirmation set; multiple ranks/families
  have been tried, so these are not confirmatory statistics.
- No official 100-row run, adjusted score, cost parity, or AIcrowd submission
  was produced.
- Results are local estimator research and should enter Evidra's durable graph
  only with this caveat and artifact hashes attached.
