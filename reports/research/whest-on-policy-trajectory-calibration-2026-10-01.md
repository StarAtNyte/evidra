# WhestBench: on-policy trajectory correction pilot

Date: 2026-10-01  
Status: negative pilot; not a candidate estimator  
Campaign steering note: instruction 246

## Question

Can fitting the existing per-layer mean-correction features on the estimator's own
free-running trajectory improve the final-layer metric, rather than fitting against
teacher-forced intermediate states?

This was motivated by trajectory-calibrated/DAgger-style moment correction described in
public Phase 1 work. It is distinct in intent from the existing `CORR_BETA` table, but it
uses the same correction mechanism. Existing evidence already warns that local mean
corrections can hurt; this pilot checks whether an on-policy fit changes that conclusion.

## Derivation and why this can fail

Write the estimated layer transition as `x[l+1] = F_l(x[l]) + r[l]`, where `r[l]` is
the local closure error. A small perturbation at layer `l` reaches the final output through
the downstream Jacobian:

```
e[L] ~= sum_l J[L <- l+1] r[l]
```

Therefore minimizing each layer's local residual independently is not the same objective as
minimizing final-layer MSE. It ignores both downstream amplification/attenuation and
cross-layer interference. An on-policy feature fit may better represent the visited states,
but it still needs to optimize a final-output-weighted loss to address this mismatch.

## Protocol

- Data: public mini rows 80–83 from
  `.sota/tmp/whest-mini-rows-80-83/data/mini-00000-of-00001.parquet`.
- SHA-256: `2f45258245e356ed1774ca0e903810b2535d0d5743989c6d1737648ca8be3110`.
- Train only on MLP IDs 80 and 81; evaluate untouched IDs 82 and 83.
- Base: existing `lean_k3_aug.lean_k3_predict`, float32 CPU, 1 torch thread.
- Features: the existing 13 per-neuron mean-correction features, fit separately per layer.
- Fit: standardized ridge regression (`lambda=1e-2`) against each layer's local mean
  residual, then apply all fitted corrections online through the rollout.
- One correction round was evaluated. A second round was stopped immediately after the
  first training row regressed sharply; it is not part of the result.

## Results

| MLP ID | Split | Baseline final MSE | One correction round | Ratio |
|---:|---|---:|---:|---:|
| 80 | train | 3.781372e-8 | 5.859617e-8 | 1.55x |
| 81 | train | 2.642799e-8 | 4.888629e-8 | 1.85x |
| 82 | held out | 3.191428e-8 | 7.174227e-8 | 2.25x |
| 83 | held out | 3.525879e-8 | 1.040917e-7 | 2.95x |

Held-out mean MSE rose from `3.358654e-8` to `8.792200e-8` (`2.618x`). The training
rows also regressed (mean ratio `1.67x`), so this is not merely a generalization gap. The
candidate is rejected; no estimator source or submission bundle was changed.

## Interpretation and limits

The result is consistent with the objective mismatch in the derivation: independently
fitting layer-local residuals can cause harmful compounded changes in the final output.
This is a four-row pilot with only two training MLPs, so it does **not** establish that every
trajectory-calibrated method fails. In particular, it did not fit a final-output-weighted
loss or use a downstream Jacobian/adjoint. It does establish that this straightforward
13-feature, per-layer local-ridge variant is not worth scaling.

## Next discriminating test

Only revisit learned mean correction through a distinct algorithm: approximate or compute
the downstream sensitivity `J[L <- l+1]`, use it to project local defects into final-output
space, and fit against final-layer residuals. Begin with a small sensitivity parity test and
an untouched mini split; abandon the idea if the Jacobian approximation is inaccurate or the
held-out final MSE fails to improve. A separately testable idea is whether a third-cumulant
term predicts *accumulated* drift even when a one-step local correction does not; treat that
as a new hypothesis, not as validation of this pilot.

## Reproduction caveat

The one-off driver ran from `/tmp/whest_dagger_probe.py` and is not checked into this
repository. The numerical output above was captured directly from that run; the exact data
shard is retained under ignored `.sota/tmp`. Promote a portable reproduction script only if
this line of work is reopened.
