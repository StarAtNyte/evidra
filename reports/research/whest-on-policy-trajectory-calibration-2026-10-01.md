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
uses the same correction mechanism. Methodological correction: the pilot below fit every
layer simultaneously on the **uncorrected baseline trajectory**. It was not proper
sequential DAgger, where layer `l` is fit after rolling through already-fitted corrections
for layers `0…l−1`. The negative result applies only to the simultaneous-fit variant.

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
  residual from the uncorrected baseline rollout; then apply all fitted corrections online
  simultaneously. This is a baseline-trajectory batch fit, **not sequential DAgger**.
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
trajectory-calibrated method fails. It was not sequential DAgger, did not fit a
final-output-weighted loss, and did not use a downstream Jacobian/adjoint. It establishes
that this straightforward simultaneous 13-feature, per-layer local-ridge variant is not
worth scaling; sequential fit-on-corrected-prefix remains untested.

## Next discriminating test

### Sequential DAgger follow-up (completed)

A second experiment now implements the actual sequential fit-on-corrected-prefix procedure
in [`probe_whest_sequential_dagger.py`](probe_whest_sequential_dagger.py). For each layer
`l`, it rolls the training MLPs through already-fitted corrections `0…l−1`, refits features
at `l`, and fits only that layer's coefficients. It trained on public mini IDs 84–87 and
evaluated the frozen full-depth (16-layer) correction on fresh IDs 92–95. Data shard SHA-256:
`6eb84bd50068e8dcb0d8a6a609f2c4f90177d6228229ccb0793b656d7458fd59`.

| MLP ID | Split | Baseline final MSE | Sequential correction | Ratio |
|---:|---|---:|---:|---:|
| 92 | held out | 3.981347e-8 | 3.217782e-8 | 0.8082 |
| 93 | held out | 3.407854e-8 | 2.924411e-8 | 0.8581 |
| 94 | held out | 2.877577e-8 | 2.629709e-8 | 0.9139 |
| 95 | held out | 4.350339e-8 | 3.490877e-8 | 0.8024 |

All four held-out rows improved. Mean per-MLP ratio is `0.84566` (15.4% mean relative
reduction); ratio of pooled held-out MSEs is `0.8390` (16.1% reduction). Train IDs 84–87
also improved, but are not evidence of generalization. A smaller three-layer sequential
pilot on IDs 80–81 / 82–83 was effectively flat on validation (mean ratio `1.0043`), so the
observed gain appears to need the deeper correction path, but this is not yet established.

This is a promising *research signal*, not an estimator result: only four held-out MLPs,
public labels were used for fitting, and this was measured with the research `lean_k3_aug`
chain rather than the official bundled evaluator / exact V29 source. A direct baseline check
on the same ID 92 confirms the mismatch is material: V29 scored `2.479036e-8` final MSE at
`0.2671 × B`, while `lean_k3_aug` scored `3.981347e-8`. Thus these coefficients cannot be
transferred to V29 as-is, and the ~15% research-chain gain says nothing yet about the
incumbent submission. Cost and adjusted score for the corrected chain were not measured. Do
not submit or claim this as a challenge score.

### Next gate

Reproduce sequential fitting on the exact V29 estimator path, rather than transplanting
coefficients from `lean_k3_aug`. First instrument the V29 feature path in a research-only
wrapper and verify instrumentation leaves outputs bit-identical; then evaluate frozen V29-fit
coefficients on a larger untouched block and the full 100-row public mini split with zero
failures, recording per-row MSE, FLOPs, and the official adjusted-score formula. Do not
retune on those evaluation rows. Only after these checks consider integrating the correction
into a candidate and submission bundle. A separate final-objective sensitivity fit and
third-cumulant accumulated-drift model remain distinct future hypotheses.

## Reproduction caveat

The simultaneous-fit pilot used a one-off driver in `/tmp/whest_dagger_probe.py`, which is not
checked in. The sequential follow-up is reproducible with the checked-in script and the exact
public mini shard retained in the ignored `.sota` worktree data. The script outputs per-MLP
metrics and saves its run manifest under ignored `.sota/tmp`.

### Exact-V29 shallow pilot (completed; negative)

The V29 instrumentation was checked against pristine source before fitting: predictions were
bit-identical (`array_equal`, maximum absolute difference `0.0`). Feature capture adds
44,270,592 measured FLOPs on ID 96 (about `0.000020 × B`); this verifies the measurement
wrapper, not a submission artifact.

An important parity check on the same ID 92 found that the research `lean_k3_aug` chain is
not a proxy for V29: its baseline MSE was `3.981347e-8`, versus V29's `2.479036e-8` (V29 cost
`0.267056 × B`). The earlier 15% lean-chain gain therefore cannot be attributed to or
transferred to the incumbent.

The first exact-V29 fit trained sequentially on IDs 84–87 but corrected only layers 0–3,
using ridge `1e-2`; IDs 96–99 were its validation block. Per-row held-out ratios were
`0.999858`, `1.000533`, `1.007967`, and `1.006284`. Pooled held-out MSE increased from
`2.2490075e-8` to `2.2574202e-8` (ratio `1.003741`, a 0.37% regression); mean per-row ratio
was `1.003660`. The measured quality change is negative. Reject this four-layer variant and
do not spend a submission on it. This does not test the full-depth sequential method that
produced the research-chain signal; a separate 16-layer V29 fit is the next discriminating
test.

Reproduce with `probe_v29_sequential_dagger.py`; its coefficients and run manifest are
written to ignored `.sota/tmp/whest_v29_sequential_dagger.json`. Source SHA-256 was
`0eedf1ac107db931c855d693e2556c088e396744517ccd00287e6178099be5ce`. IDs 96–99 are now
development data for this investigation, not an untouched validation set.

### Exact-V29 full-depth sequential pilot (completed; negative pooled result)

To test whether the lean-chain improvement depended on depth, all 16 V29 layers were fit
sequentially on IDs 84–87 (ridge `1e-2`) and evaluated, with frozen coefficients, on IDs
88–91. The feature-capture wrapper remained in-memory only. All four training rows improved
(ratios `0.9755`, `0.9634`, `0.9744`, `0.9700`), but held-out results were mixed:

| MLP ID | Baseline final MSE | Full-depth correction | Ratio |
|---:|---:|---:|---:|
| 88 | 2.465903e-8 | 2.407335e-8 | 0.97625 |
| 89 | 2.220641e-8 | 2.526555e-8 | 1.13776 |
| 90 | 2.957062e-8 | 2.998261e-8 | 1.01393 |
| 91 | 2.156773e-8 | 2.119129e-8 | 0.98255 |

Mean per-row ratio was `1.02762`; pooled held-out MSE ratio was `1.02560`, a 2.56%
regression. Each prediction cost 587,307,467,247 FLOPs versus 587,262,770,671 for V29
baseline, an increase of 44,696,576 FLOPs (`~0.000020 × B`). This is a negative result, not
a submission candidate. The gain on two of four held-out rows is a hint that a conservative
trust-region/damping step may be worth screening, but the undamped correction is rejected.
The validation IDs are now development data for this method and cannot serve as fresh
confirmation. The run took 2,412.5 seconds; metrics and coefficients are in the ignored
`.sota/tmp/whest_v29_sequential_dagger.json` manifest.
