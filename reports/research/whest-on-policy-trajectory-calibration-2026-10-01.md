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

### Trust-region damping screen (scale 0.5; exposed development block)

The full-depth fit suggested limiting the update magnitude. Scaling every fitted coefficient
by `0.5` reduced the pooled regression on the already exposed IDs 88–91 to a small gain:
pooled MSE ratio `0.997816` (0.218% reduction), mean per-row ratio `0.998329` (0.167%
mean reduction). Ratios were `0.974862`, `1.040587`, `0.997739`, and `0.980128`; the worst
row still regressed 4.1%, but much less than the undamped 13.8%. Cost remained the same
44.7M extra FLOPs. This is a promising *screening signal*, not confirmatory evidence: scale
0.5 was selected after seeing IDs 88–91. The checked-in probe now supports reusing frozen
coefficients and applying a trust-region scale. A separate run is evaluating the frozen
0.5-scaled coefficients on IDs 76–79; do not submit unless that independent block and a full
official mini evaluation also support the gain.

### Frozen damping check on a second block (completed; negative)

Without refitting or retuning, the 0.5-scaled coefficients were evaluated on IDs 76–79.
All four regressed: ratios `1.06789`, `1.03388`, `1.01013`, and `1.00247`; mean ratio
`1.02859` and pooled MSE ratio `1.03053` (3.05% worse). This rejects the damping variant as
non-generalizing. Do not submit it. The contrast with IDs 88–91 confirms that selecting the
scale on a four-row block can create a misleading tiny positive; the next hypothesis instead
targets the terminal objective directly and avoids compounding 16 local corrections.

### Direct terminal-layer ridge (completed; negative)

To remove objective mismatch rather than merely damp it, fit only V29's final-layer additive
correction from the exact baseline terminal features to the final-layer residual; all earlier
layer corrections are zero. This makes the learned delta directly additive to the metric
output, instead of asking a chain of local corrections to improve it indirectly. With four
training MLPs (IDs 84–87), ridge `1e-2`, and disjoint IDs 64–67 for validation, ratios were
`1.05212`, `0.98543`, `1.02815`, and `1.07795`; mean ratio `1.03591`, pooled MSE ratio
`1.03877` (3.88% regression). Reject this small-sample terminal fit too. Its coefficient
norm was `0.193`; added cost was the same 44.7M FLOPs. Next test whether broader calibration
data stabilizes this direct terminal objective before rejecting the formulation itself.

### Broader terminal fit (16 training MLPs; small positive four-row screen)

To test the small-sample explanation, the same terminal-only ridge (`1e-2`) was fit on IDs
0–15 and frozen on disjoint IDs 16–19. All 16 training trajectories were used only to fit
the one final-layer correction. Validation ratios were `1.00460`, `0.99793`, `0.99110`,
and `0.99719`: three of four improved. Mean ratio was `0.997705`; pooled ratio was
`0.997249`, a 0.275% held-out MSE reduction. Added cost stayed at 44.7M FLOPs (`~0.000020 ×
B`). This is the first positive exact-V29 held-out signal in this line, but it is small and
only four rows; it is not yet evidence for an external-score improvement or a submission.
The next gate is a frozen evaluation on disjoint public mini IDs 20–99, followed by exact
package parity and adjusted-score calculation if the broad block remains positive.

### Frozen 20-row follow-up (small positive; uncertainty remains)

The same coefficient matrix was scored without refitting on IDs 20–39. Fourteen of 20 rows
improved; pooled final-MSE ratio was `0.997912` (0.209% reduction), and mean per-row ratio
was `0.997626` (0.237% mean reduction). The worst regression was 3.32%; no rows failed.
Every row's measured FLOP count was 587,307,467,247 versus 587,262,770,671 baseline. A
paired row bootstrap (20,000 resamples, seed `20261001`) put the pooled relative-reduction
95% interval at `[-0.273%, +0.618%]`, with 82.6% of resamples positive. This was encouraging
but not yet separated from zero, so the coefficients were kept frozen for IDs 40–99.

### Frozen broad confirmation (IDs 16–99; small but consistent positive)

The final locked block, IDs 40–99, was scored without refitting or selecting coefficients;
it took 4,235.8 seconds. Across all disjoint held-out IDs 16–99 (84 MLPs), 61 improved.
Pooled final-MSE ratio was `0.997848`, a `0.2152%` reduction; the mean per-row ratio was
`0.997731`. A paired bootstrap over MLP rows (50,000 resamples, seed `20261001`) gives a
95% interval of `0.0345%` to `0.3794%` MSE reduction, with 98.98% of resamples positive.
The mean measured FLOP overhead was `0.00761%` (44,696,576 extra FLOPs per MLP), so this
candidate improves the observed quality-cost tradeoff on this fixed public mini set. This is
a small incremental result—not a claim of a `1e-9` score, a leaderboard gain, or proof of
generalization beyond this benchmark distribution.

This is now strong enough to justify the next step rather than discard the idea: materialize
the frozen terminal correction as a candidate, verify exact compatibility with the official
submission contract, and run the official mini evaluator with the exact score formula and
resource limits. Preserve V29 as the fallback and submit only if package-level parity passes
and the official adjusted score improves. Keep the coefficients and evaluation set frozen;
any further fitting or tuning requires a new untouched split.

### Submission-runtime gate and bounded-memory candidate

The first isolated-runner smoke with V29's default Strassen depth/fusion settings failed to
allocate a 375 MiB workspace; the next repeated-call smoke also ended with `WORKER_EOF`.
This is a candidate packaging/runtime blocker, not evidence about the learned residual. A
rules-compliant bounded-memory configuration (Strassen depth 4, fused-leaf threshold 32)
passed `whest validate` and four consecutive official subprocess predictions with zero
budget, wall-time, or residual-time failures. Their mean measured wall time was 28.2 s and
mean adjusted score was `6.28756e-9`; these first four MLPs overlap the fit IDs, so this is
only a runtime smoke and not a generalization estimate.

The frozen IDs 16–19 check was repeated with those exact depth/fusion settings. Three of
four improved; pooled MSE ratio was `0.997272` (0.273% reduction), compared with `0.997249`
under the original kernel setting. Per-row ratios also closely matched, supporting the
bounded-memory path as a faithful implementation of the residual candidate on this block.
A frozen IDs 20–39 check using the same settings is in progress. Do not submit until that
completes, and keep the original V29 artifact as fallback.
