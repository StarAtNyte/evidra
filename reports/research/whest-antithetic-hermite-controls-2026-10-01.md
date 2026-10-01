# Hermite controls under antithetic sampling: derivation and first screen

Date: 2026-10-01  
Status: exact unbiased control family; current low-rank pilot has no useful signal. Not a candidate.

## Why use even Hermite terms?

For `X ~ N(0,I)`, the target is `E[f(X)]`. Antithetic Monte Carlo averages
`g(X) = (f(X)+f(-X))/2`. This is an even function, so all odd Gaussian
Hermite components cancel pairwise. In particular, a first-order control
`b^T X` has exactly zero contribution to each antithetic pair and cannot
reduce this estimator's variance.

For a standard Gaussian projection `Z = Q^T X`, with orthonormal columns in
`Q`, degree-two Hermite controls are

`H_ij(Z) = Z_i Z_j - 1[i=j]`, for `i <= j`.

Each has known expectation zero. Consequently, for any coefficients `B`
estimated using an independent pilot,

`mean_eval(g(X) - H(Q^T X) B)`

is unbiased for `E[f(X)]`. We choose `Q` using only the current MLP's
first-layer input-space weight Gramian. This makes the feature count
`r(r+1)/2` instead of `d(d+1)/2`, with no use of target means to choose the
subspace or fit coefficients.

## Pilot measurement

Implementation: `probe_whest_antithetic_hermite2.py`. On public Mini IDs 4–7,
each run used 2,048 pilot pairs and 2,048 held-out pairs, with one replicate
per network. Targets were used only to score the held-out estimates. The
reported ratio compares raw output MSE with plain antithetic Monte Carlo on
the same held-out pairs. This is a small exploratory test; no official
FlopScope accounting or evaluator run was performed.

| Rank of `Q` | Features | Mean MSE ratio | Median MSE ratio | Networks improved | Mean held-out variance ratio |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 8 | 36 | 0.9992 | 1.0089 | 2/4 | about 1.0157 |
| 2 | 3 | 1.0070 | 1.0070 | 1/4 | about 1.0007 |

The apparent pooled gain at rank 8 is not corroborated by lower held-out
variance and is dominated by between-MLP/finite-pair noise. Rank 2 is slightly
worse. This does not support the hypothesis that this first-layer-weight
subspace's low-order even polynomial controls explain appreciable residual
variance. Do not promote either configuration.

Reproduce:

```sh
OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=1 \
python reports/research/probe_whest_antithetic_hermite2.py \
  --start 4 --end 8 --samples 4096 --replicates 1 --rank 8 \
  --ridge-fraction 0.05 --output .sota/tmp/whest-antithetic-hermite2-r8-4-7.json

OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=1 \
python reports/research/probe_whest_antithetic_hermite2.py \
  --start 4 --end 8 --samples 4096 --replicates 1 --rank 2 \
  --ridge-fraction 0.2 --output .sota/tmp/whest-antithetic-hermite2-r2-4-7.json
```

## Next mathematical gate

The full degree-two Gaussian control lives in the symmetric matrix space. Its
optimal coefficients are the second Hermite coefficients of each output,
equivalently contractions of `E[(XX^T-I) g(X)]`. Before trying richer
polynomials or expensive derivative-based directions, measure an oracle
ceiling on V29 residuals: what fraction of residual energy can *any* rank-k
quadratic-Hermite subspace capture? Then test whether a weights-only,
matrix-free subspace captures a meaningful fraction of that ceiling. If the
oracle ceiling is low, stop this family. A high oracle ceiling alone is not a
deployable improvement; the weights-only basis must transfer across whole
MLPs and added operations must fit the evaluator budget.

## Limits

- Public Mini only; IDs 4–7 were exploratory and have been seen in other
  hypothesis screens, so they are not a lockbox.
- One replicate per MLP and only 2,048 evaluation pairs: no significance or
  generalization claim.
- The comparison is raw MSE, not the challenge's adjusted score.
- No candidate bundle, full 100-row validation, or leaderboard submission.
