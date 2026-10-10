# Learned terminal closure screen on the public D8b corpus — 2026-10-10

## Motivation

The public Phase-2 corpus provides many more independent networks than our
16-network pilot: each D8b network has N=1e8 Monte Carlo marginal moments and a
terminal mean target. This permits a real whole-network holdout for learned
closures, rather than fitting a neuron-wise regressor on a handful of MLPs.
The dataset card specifies 14,048 width-1024/depth-16 He-init networks and the
weight-generation seed recipe; the downloaded four initial shards cover 512
network IDs. Source: [D8b corpus card](https://huggingface.co/datasets/keenanpepper/arc-whestbench-p2-d8b-corpus-14k).

## First gate: independent-sum univariate closure

For each network, regenerate weights byte-for-byte from its corpus index. Use
the corpus's previous-layer (layer 14) marginal moments as an offline oracle,
form independent-sum estimates of the final preactivation mean and cumulants
through order four, apply Gaussian ReLU closure, then fit a LightGBM correction
on five target-free standardized features. The split is by complete network:
384 train and 128 held-out networks, seed `20261010`.

On held-out networks, pooled MSE falls from `3.6629e-5` to `2.5342e-5`, a
**30.8% reduction**, and all 128 networks improve (network-bootstrap 95% CI
for mean per-network reduction: 29.3–31.6%). This is a stable learnable signal
for correcting the independent-sum approximation, but its corrected MSE is
still roughly three orders of magnitude worse than V30. The independent-sum
assumption omits cross-neuron covariance and cannot itself approach the
competition frontier.

Reproduction:

- `reports/research/build_whest_d8b_weight_bank.py` regenerates selected weights
  and validates identity by SHA-256.
- `reports/research/probe_whest_learned_univariate_closure.py` computes the
  whole-network split, trains the model, and writes the result and model.
- Four public shards and the cache are in ignored `.sota/data/` / `.sota/runs/`
  artifacts. The exact 512-network result is
  `.sota/runs/whest-learned-univariate-closure-512-20261010.json`.

## Transfer attempt against V30 and rejection

Applied the learned function to the five captured V30 feature rows whose
network IDs were in the model's held-out set (`96, 112, 128, 144, 208`). The
feature semantics are not sufficiently invariant between the independent-sum
teacher-forced inputs and V30's propagated cumulant state: learned-corrected
MSE was 300–444x V30's MSE on those networks. The Gaussian base alone was
already 8–11x worse than V30. This is a clear negative transfer result. Do not
package, promote, or submit this closure or apply it as a V30 residual correction.

## Next experiment

Train the residual learner on features captured from the actual frozen V30
estimator, with entire networks assigned to grouped folds. This avoids the
feature-distribution mismatch above. A hash-verified 64-network bank has been
created and the persistent V30 capture is in progress; checkpoints are written
after each network to `.sota/runs/whest-v30-learned-cv64-capture-20261010.npz`.
The exact process status must be checked before resuming or restarting it. The
experiment is only a candidate screen: any gain still needs a fresh network
holdout and full 100-row official local validation before considering an
AIcrowd submission.
