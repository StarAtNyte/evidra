# WhestBench external feedback and diagnostics — 2026-10-09

## External grades

All three submissions are graded by AIcrowd:

| Submission | Candidate | Adjusted score | Final-layer MSE | Result |
|---|---|---:|---:|---|
| [#335033](https://www.aicrowd.com/challenges/arc-white-box-estimation-challenge-2026/submissions/335033) | V29 quadratic residual, Strassen leaf 8 | 5.1780693024321044e-9 | 2.1158282876854172e-8 | improves on prior 5.418168137938331e-9 |
| [#335034](https://www.aicrowd.com/challenges/arc-white-box-estimation-challenge-2026/submissions/335034) | grouped-CV cubic residual, Strassen leaf 8 | **5.162197424910759e-9** | **2.1092689479473848e-8** | current best; ~4.7% below prior best |
| [#335038](https://www.aicrowd.com/challenges/arc-white-box-estimation-challenge-2026/submissions/335038) | V29 quadratic residual, original Strassen leaf | 5.374978874452923e-9 | 2.116087799208799e-8 | no meaningful improvement |

These are official grades, not private-test generalization evidence. Current public leaderboard leaders are around 1.5–1.6e-9 adjusted, leaving roughly a 3.2× score gap from #335034. [Leaderboard](https://www.aicrowd.com/challenges/arc-white-box-estimation-challenge-2026/leaderboards)

## Local experiments

- On held-out Mini row 80, cubic/leaf-8 produced adjusted score 5.295430799361225e-9, raw MSE 2.0484995033598352e-8, 568453907695 FLOPs, 0.25850 utilization, 43.25 s, zero failures. The quadratic/leaf-8 control on the same row scored 5.328629387289628e-9 (raw 2.0613907025790468e-8), so cubic was ~0.62% better on this single MLP.
- A 20-row run on IDs 80–99 was **invalid as an aggregate**: the local persistent subprocess reported six `WORKER_EOF` cases (subset offsets 2, 5, 8, 11, 14, 17; IDs 82, 85, 88, 91, 94, 97). The large aggregate MSE must not be treated as a candidate score. ID 82 succeeds when evaluated alone (score 4.4711763329081555e-9), so the failure is associated with repeated-worker/resource behavior, not a deterministic single-network exception.
- `gc.collect()` and clearing Flopscope einsum caches between predictions did not remove the repeated-worker EOF pattern. Resetting the estimator's scratch pools made a diagnostic prediction exceed three minutes and was stopped; do not use that variant.
- Raising the local `RLIMIT_AS` for diagnosis avoided address-space-only exits, but one repeated-worker run exceeded 8 GiB resident memory and was stopped. Such a run is not evidence of compliance with the challenge memory limit. Keep the external AIcrowd grade as the authoritative score and resolve local/remote resource parity before claiming full-100 local validation.
- A public Phase-1 K3+rank-13 Tucker-K4/Richardson estimator passed the contract smoke test but transferred poorly to this Phase-2 geometry on held-out row 80: raw/adjusted MSE 0.7529261112213135 at 2110601207486 FLOPs (95.98% utilization). Reject this direct transfer.
- Grouped 5-fold CV over training MLP IDs 0–79 found network-context-only ridge calibration best at -0.3115% mean relative residual MSE (54/80 MLPs improved). Adding local cubic terms plus interactions with network mean/std features reached -0.8488% (61/80), still below the existing local cubic-only CV result (~-1.07%). Reject both contextual variants unless a new paired evaluation changes that conclusion.
- A Strassen-level-6 configuration exceeded 8 GiB RSS on its second MLP; reject under current constraints. One-row output was identical because the first call is capped by the estimator's first-call level setting.

## Evidra campaign follow-up

The durable campaign paused at cycle 204 after two repeated `replication / inspect / explicit-no-new-evidence` signatures. Its event stream says `pause_for_review`; this was not evidence that the stated 1920-minute or 150M-token budget was exhausted. The new official grades and diagnostics above are evidence to resume the same campaign with a changed next action. Preserve the campaign's separate harness/challenge tracks and do not report the failed local aggregate as a score.

## Artifacts

- `.sota/runs/whest-v30-cubic-diagnostic-80-threads1-20261009.json`
- `.sota/runs/whest-v29-quadratic-strassen8-diagnostic-80-threads1-20261009.json`
- `.sota/runs/whest-v30-cubic-holdout-80-99-threads1-20261009.json` (invalid aggregate; six worker exits)
- `.sota/runs/whest-v30-cubic-isolated-row82-threads1-20261009.json`
- `.sota/runs/whest-v30-cubic-gccollect-80-83-threads1-20261009.json` (diagnostic only)
- `.sota/runs/whest-v30-cubic-clearcache-80-84-threads1-20261009.json` (diagnostic only)
- `.sota/runs/whest-v30-cubic-strassen6-row80-threads1-20261009.json`
- `.sota/runs/arc-tucker-k4-phase2-row80-20261009.json`
- `.sota/runs/v29-contextual-residual-cv-20261009.json`
- `.sota/runs/v29-contextual-cubic-cv-20261009.json`

## Degree-4 residual extension and external test

An all-monomial degree-4 ridge extension was screened over the same frozen 13
V29 final-layer features, with 5 folds grouped by complete MLP (training IDs
0–79). The selected ridge alpha was 10,000. It reduced mean per-network CV
residual MSE by 1.186% (68/80 MLPs improved), versus 1.074% (66/80) for the
degree-3 fit. On the 20-row confirmation cohort, degree 4 reduced the base
residual MSE by 1.402% (19/20 improved). Direct paired comparison to degree 3
was only 10/20 wins; mean relative difference was -0.0199 percentage points,
with a 95% network-bootstrap interval [-0.1125, +0.0702] percentage points.
This is a weak, uncertain edge, not evidence of a meaningful gain.

The candidate was ported into the Whest estimator and passed `whest validate`
(expected smoke output shape 2x4). One held-out official-runner check on row 80
completed with zero failures: adjusted score 5.301955109635173e-9, raw MSE
2.050683001186826e-8, utilization 0.2585458. That single row is slightly worse
than the degree-3 row-80 diagnostic (5.295430799361225e-9). No full-100 local
evaluation has been completed for this candidate, so report the CV/confirmation
comparison and one-row run separately, not as a mini leaderboard score.

An exploratory external test was nevertheless authorized because the candidate
is distinct and slots are available: AIcrowd submission [#335048](https://www.aicrowd.com/challenges/arc-white-box-estimation-challenge-2026/submissions/335048),
bundle `.sota/candidates/whest-v31-degree4-residual-strassen8-20261009/submission.tar.gz`,
estimator SHA-256 `7da3510a1ac048e41930a28b50e17de08eeefa6268befab204ee22fdfbed314c`.
Its grade is pending at the time of writing; keep #335034 as the incumbent until
the external result arrives. Reproduction artifacts:

- `.sota/runs/whest-residual-degree4-cv-20261009.json`
- `.sota/runs/whest-v31-degree4-row80-20261009.json`
- `.sota/tmp/whest_degree4_residual_cv.py`
- `.sota/tmp/build_degree4_candidate.py`

## Additional exploratory external checks — 2026-10-10

- AIcrowd submission [#335049](https://www.aicrowd.com/challenges/arc-white-box-estimation-challenge-2026/submissions/335049)
  was submitted from the distinct degree-2 grouped-CV residual-fit package
  `.sota/candidates/whest-v29-poly2-residual-strassen8-20261009/submission.tar.gz`.
  Estimator SHA-256: `ae0c21bbf595369716c4f952f9e685de4ca7dcf2a9337e27e5dcea16ab3054f0`;
  archive SHA-256: `eedd841e897a761a59930d04b9fac0865547e8a5cfc42794b2c24cb9e35c32e2`.
  The official package validator passed. The local two-row run on held-out IDs 80–81
  was **invalid**: both worker runs failed with `MemoryError` under the host's 8 GiB
  virtual-address limit. Its aggregate score is not meaningful. The submission was
  intentionally marked exploratory to request the remote evaluator result, not as a
  promoted candidate. Grade pending.
- Submission [#335048](https://www.aicrowd.com/challenges/arc-white-box-estimation-challenge-2026/submissions/335048)
  (degree-4 residual extension, described above) remained pending when #335049 was
  sent. #335034 remains the incumbent official score until either result is graded.
- Failed local depth-7 Strassen diagnostics are not submission candidates: the
  repeated-run configurations exceeded the local evaluator's address-space/memory
  limits. The external report's leaf-8 result motivates future controlled depth
  tuning, but does not establish that an all-paths depth-7 estimator is safe.

## Controlled Strassen-depth screen — 2026-10-10

The cubic V30 estimator was run on held-out Mini IDs 80–89 with core Strassen
level 6, keeping hub/shared-basis depths at 5, a first-call cap of 4, and a
12-GiB address-space diagnostic limit while monitoring resident memory. This
screen had 1 residual-cap failure (ID 86 at 0.40134 s) and is invalid as an
aggregate. On the six IDs that also completed in the earlier cubic control, the
paired adjusted-score ratio averaged 0.9658 (median 0.9799), which is a
promising cost-only lead, not a validated cohort result. Sampled RSS peaked near
7.9 GiB.

A single-row ID-86 follow-up with fusion threshold 171 and first-call level 6
completed at 0.39282 s (score 4.85292e-9) versus the cubic control's
5.15464e-9 on that row. However, repeating IDs 80–89 with fusion threshold 171
and the original first-call level 4 produced four residual-cap failures (IDs
81–84, 0.408–0.427 s). That aggregate is also invalid. Do not submit or promote
the L6 configuration based on these runs. A warm-up-first-call-level-6 variant
is only a hypothesis and requires a short gated test, then a zero-failure
10–20-row paired cohort and full-100 verification before any submission.

Artifacts:

- `.sota/runs/whest-v30-core6-rows80-81-vms12gb-20261010.json` (2 rows, zero failures)
- `.sota/runs/whest-v30-core6-rows80-89-vms12gb-20261010.json` (invalid; 1 failure)
- `.sota/runs/whest-v30-core6-fuse171-row86-20261010.json` (one row, zero failures)
- `.sota/runs/whest-v30-core6-fuse171-rows80-89-vms12gb-20261010.json` (invalid; 4 failures)

### First-call level-6 follow-up — 2026-10-10

The gated IDs 80–84 test with `V28_STRASSEN_FIRST=6` and fusion threshold 171
also failed: IDs 80 and 81 exceeded the 0.4 s residual cap (0.4313 s and
0.4054 s); IDs 82–84 passed at 0.3839–0.3927 s. The run's aggregate score
(`0.333955`) is invalid because it includes two failed rows and must not be
compared with candidate scores. First-call level 6 therefore does not remove
the residual-tail failures; no L6 variant is eligible for submission. The
worker took about 7 minutes for this five-row diagnostic and peaked around
7.9 GiB RSS, further weakening its practical resource margin.

Artifact: `.sota/runs/whest-v30-core6-fuse171-first6-rows80-84-vms12gb-20261010.json`.
The source and bundle remain the original V30 candidate (estimator SHA-256
`89395749c6a1a3b1cc12ff230a770c85d0bdb26f2f68d85023dfab12bd27920315`,
bundle SHA-256 `b0748971e91a43fbcbce29ec6b2969177ff588d24e408e221d8cc9dd640d2832`);
only runtime environment settings differed. This was diagnostic-only, not a
new submission artifact.

### Official grades — 2026-10-10

Both exploratory uploads have now graded successfully on all 50 public MLPs:

| Submission | Public adjusted score | Raw final-layer MSE | Failed MLPs | Verdict |
|---|---:|---:|---:|---|
| [#335048](https://www.aicrowd.com/challenges/arc-white-box-estimation-challenge-2026/submissions/335048) | `5.181e-9` | `2.108e-8` | 0 | Valid, but does not beat #335034 (`5.162197424910759e-9`) |
| [#335049](https://www.aicrowd.com/challenges/arc-white-box-estimation-challenge-2026/submissions/335049) | `5.178e-9` | `2.116e-8` | 0 | Valid, but does not beat #335034 |

Thus #335034 remains the public-score incumbent. #335048's slightly lower raw
MSE is outweighed by its compute multiplier; #335049 is worse on both. These
official pages confirm successful 50/50 public grading only; neither is
evidence about the sealed private split.

## Exploratory attributed-fit submission — 2026-10-10

At the user's explicit request to use available daily submission capacity for
new local variants, the distinct attributed degree-2 residual-fit package was
submitted as AIcrowd **#335124**. It passed `whest validate-package`; archive
SHA-256 `4738380fb3de5945828be4459afae965bc54b887eb59481fa8e8169e4ba74a59`,
estimator SHA-256
`9ea3fc0ac0c21f154b1ea6fd2f1457cb9be951dc54a574bd8925d2d331a23335`.
At upload time, grading was still pending. This is explicitly exploratory:
its local held-out row-80 result was `5.490789e-9`, worse than the incumbent,
so it is not promoted absent a better official public grade.

The other recent archives were not resubmitted: V29 polynomial-2, V31
degree-4, and V30 cubic/Strassen-8 match already submitted packages/results
(#335049, #335048, and #335034 respectively). Resubmitting would spend slots
on duplicate artifacts rather than test a new hypothesis.

## New research lead: target-side contraction for signed frame weights

The AIcrowd forum's Phase-1 technique census reports a potentially large but
not-yet-deployable oracle result: target-aware reweighting of 129 MUB basis
endpoints removed 95.64% of pooled error; held-output cross-fitting retained
81.82% of that oracle gain. However, the tested lawful analytic-proxy direction
had cosine only 0.018 with the oracle direction. This is evidence for
investigating observable-to-signed-weight transfer, not evidence that a
deployable rule exists. The report also notes a deterministic angular-attractor
direction correlated with the true final mean. Source:
[AIcrowd forum technique census, replies 8–14](https://discourse.aicrowd.com/t/a-technique-census-of-phase-1-what-the-mathematics-is-doing-what-walls-it-hit-and-whats-still-open/18157/8).

The live objective is exceptionally demanding: because adjusted score is
multiplied by `max(0.1, utilization)`, the requested `0.68e-9` requires raw MSE
at or below `6.8e-9` even at the 0.1 utilization floor. The leaderboard
snapshot currently places the best public score near `1.4e-9` adjusted.

Next falsifiable local test: using only allowed training MLPs, fit a frozen
mapping from deploy-time, label-free per-network features to signed basis
weights; evaluate on wholly held-out MLP IDs and compare paired raw MSE and
adjusted score against equal weights. Keep the oracle reweighting strictly as
an unattainable ceiling. Do not package a candidate unless its held-out effect
replicates, zero-failure resource gates pass, and full-100 validation is clean.

## Leaderboard snapshot — 2026-10-10

The live public leaderboard currently shows J2W at adjusted `1.4e-9`, raw
`1.36e-8`, compute utilization `0.1065`; Marius Binner is at adjusted
`1.6e-9`, raw `1.14e-8`, utilization `0.1438`. The incumbent #335034 at
`5.1622e-9` is about 3.7x worse than the current leader and ~7.6x above the
user's aspirational `0.68e-9` target. This quantifies the remaining gap; it is
not evidence that the target is reachable.

## Independent-corpus correction probe — 2026-10-10

The next accuracy experiment is a network-disjoint residual correction using the
public `keenanpepper/arc-whestbench-p2-d8b-corpus-14k` corpus, not another
repackaging of the Mini-trained V29/V30/V31 candidates. The corpus shard has
independently seeded 16x1024 MLP weights and N=1e8 final-activation targets.
The first regenerated weight hash matches the corresponding public training
record. Only weights, deploy-time V30 features/predictions, and independent
targets are used; no public Mini held-out labels enter fitting.

The prior feature extractor kept all rows in memory and wrote only after the
whole batch, so interrupting a long candidate prediction discarded completed
rows. It now atomically checkpoints after every MLP. The first rerun produced
three per-network checkpoints, but inspection caught an index mismatch: this
shard contains corpus IDs 0, 16, 32, ... while the initial regenerated bank used
consecutive seeds. Only ID 0 was aligned; the three-row capture is invalid and
must not be fitted or scored. The extractor now requires a manifest mapping
every weight row to its corpus ID and verifies each row hash against that
manifest before prediction. The generator now supports explicit index stride
and offset. The mismatched capture remains quarantined for audit. A corrected
16-network bank now covers IDs `0,16,...,240`; its first weight hash exactly
matches the known corpus record (`2fe17c4a...61a27c`). Extraction of IDs 16–240
is running with per-row atomic checkpoints. The whole-network grouped-CV fitter
is implemented in
`reports/research/fit_whest_d8b_residual_correction.py`; scripts pass Python
byte-compilation. Any fitted correction remains experimental until paired
held-out-network, official-resource Mini validation is clean.

Higher-upside follow-up if this terminal correction is weak: Phase-1's technique
census describes a model-assisted mid-network control using a layer-9 analytical
reference discrepancy and a frozen per-network response to the final layer. It
reported 17.6% final-MSE reduction on its Phase-1 panel, but this is not Phase-2
evidence and the geometry differs. Test transfer only on the independent D8b
networks with whole-MLP splits and a fixed response map; do not import Phase-1
coefficients or infer a Phase-2 gain from the write-up. Source: [AIcrowd
technique census, post-cutoff update](https://discourse.aicrowd.com/t/a-technique-census-of-phase-1-what-the-mathematics-is-doing-what-walls-it-hit-and-whats-still-open/18157/8).

The existing unique attributed degree-2 artifact is already external submission
#335124, and its one-row held-out Mini result (5.490789e-9) is worse than the
incumbent. The recent V29 polynomial-2, V31 degree-4, and V30 cubic packages are
already represented by #335049, #335048, and #335034. They were not re-uploaded.

Source: [live AIcrowd leaderboard](https://www.aicrowd.com/challenges/arc-white-box-estimation-challenge-2026/leaderboards), viewed 2026-10-10.

## Additional local candidate rejection — 2026-10-10

The distinct attributed degree-2 candidate passed the archive validator and a
one-row run under the 8-GiB subprocess address-space limit, but row 80 scored
`5.490789e-9` (raw `2.059624e-8`, utilization `0.2667`, residual `0.2641 s`).
This is worse than the incumbent even on that single row. It has already been
uploaded as an exploratory test (#335124), but is not eligible for promotion or
re-upload. Artifact:
`.sota/runs/whest-v29-attributed-row80-official-memory-20261010.json`.
# 2026-10-10 — D8b residual transfer probe

The corrected public-D8b weight bank was generated using the corpus IDs as
seeds, with manifest IDs and per-network weight hashes checked before capture.
The first attempted extraction used consecutive seeds and is quarantined; its
rows are not used below.

The first corrected capture process stopped after seven of the intended fifteen
networks. Its atomic checkpoint was resumed; the capture has since reached ten
of fifteen. The initial screen, run before that resume, combined the seven
captured networks with the separately captured ID 0 network, so grouped-by-
network four-fold CV had only eight networks. The selected degree-3 ridge
correction (alpha 10,000)
changed mean relative MSE by approximately **−0.051%**, with **4/8 networks
improving** and a 95% network-bootstrap interval spanning both signs. This is
not evidence of a robust gain and did not meet the preregistered expansion rule.

At the user's direction, a distinctly new V32 was nevertheless submitted as an
explicit **exploratory transfer test**, not as a promoted candidate. It embeds
the D8b-only fitted model into V30 and passed `whest validate` and
`whest validate-package`. AIcrowd assigned submission **#335132**; grading was
still pending at the time of this note. Submission page:
https://www.aicrowd.com/challenges/arc-white-box-estimation-challenge-2026/submissions/335132

The next decision is based on the official grade against incumbent #335034
(adjusted `5.162197424910759e-9`): retain V30 as incumbent unless #335132
improves the score with zero failures. Regardless of that result, do not claim
D8b transfer validation from this eight-network pilot. Finish the remaining
correctly aligned D8b captures and repeat grouped CV on a materially larger,
predeclared network set before spending another slot on this correction family.

## D8b residual screen against the actual incumbent — 2026-10-10

Completed the correctly aligned 15-network D8b capture (IDs 16 through 240 in
steps of 16), and combined it with the separate ID 0 capture for 16 networks.
Each weight-bank row was checked against both its corpus ID and SHA-256
manifest before prediction. Whole-network four-fold CV now evaluates the
candidate replacement against the existing V30 corrected predictions, not
against the uncorrected base.

The best of nine polynomial-ridge configurations (degree 2, alpha 100) is
**+0.495% relative MSE vs V30**, with only 7/16 networks improving and a
network-bootstrap 95% interval of `[-0.196%, +1.209%]`. The same model is
`−0.526%` vs the uncorrected base. This is direct evidence that the D8b residual
model recovers a small part of the existing correction but does not improve on
V30; keep the family rejected for promotion. AIcrowd #335132 remains a
user-authorized exploratory transfer submission, and its eventual grade is a
separate check, not evidence that the 16-network CV passed.

The capture enabled a targeted test of whether closure error concentrates in
a weight-derived Lyapunov subspace under Phase 2's width-1024, depth-16 setting;
see the result below.

## Final 16-network D8b fit: exploratory submission — 2026-10-10

At the user's direction, packaged the final grouped-CV fit as V33, distinct
from the earlier eight-network V32 package. The package passed
`whest validate-package` (WhestBench 0.16.1); estimator SHA-256
`120623f4ac36cfce368b2bae584a7994e78de67cf3a99b2a308912a3bed8018c`,
archive SHA-256
`781c5e249d8f9652fc9c3d39e2c91700afcfdc00f62c10352b80fc1fe3b1b3c7`.
AIcrowd accepted it as [submission #335136](https://www.aicrowd.com/challenges/arc-white-box-estimation-challenge-2026/submissions/335136)
with `Successfully enqueued 1 Job`; status was `submitted` (grade pending)
after the 10-minute watcher. This is explicitly an exploratory test, not a
promotion: the local whole-network CV was +0.495% relative MSE against V30.
Keep #335034 as incumbent unless the official grade beats it with zero failed
MLPs. No other distinct, unsubmitted candidate was found in the current
candidate inventory; the other packaged variants are duplicates of earlier
submissions or lack stronger evidence.

## Phase-2 Lyapunov-subspace transfer and correction screen — 2026-10-10

Using the manifest-verified independent D8b corpus networks at IDs 0, 16, ...,
240 (16 whole networks), captured V30's closure gate probabilities and formed
the full product of gated Jacobians. For every network, the exact top-six
left-singular subspace captured more final residual energy than 64 random
six-dimensional subspaces: mean **4.96%** (median 4.30%) versus random mean
**0.568%**, an 8.7x ratio. A randomized matrix-free range finder
(oversampling 8, two power iterations) approximated the subspace with median
minimum principal cosine 0.962 (minimum 0.861); its mean projected residual
energy was 5.25%. This supports transfer of the geometric concentration and
shows a deployable low-rank approximation is computationally plausible.

The target-free correction direction `d = U Uᵀ prediction` did not transfer
strongly enough. Fitting one scalar shrinkage on the other 15 networks in each
fold yielded only **0.103% mean leave-one-network-out MSE reduction** (11/16
networks improved; network-bootstrap 95% interval `[-0.377%, +0.535%]`). The
randomized subspace version was similarly weak at 0.090%. A nested ridge model
predicting per-network shrinkage from target-free feature summaries regressed
by 0.659% on average. Thus the subspace is real but the current observable does
not identify its residual coordinates; no candidate was built or submitted.

Reproduce with `reports/research/probe_whest_lyapunov_subspace.py`; capture
artifact `.sota/data/whest-d8b-probe/capture-lyapunov-id000-240-full.npz`,
weight manifest `.sota/data/whest-d8b-probe/weights-idx16-stride16.manifest.json`,
and per-network JSONs `.sota/runs/whest-lyapunov-full-id*-20261010.json`.
Next work should derive an observable for the signed coefficients inside this
subspace, not spend more compute tuning the scalar projection shrinkage.

## Projected-feature ridge follow-up — 2026-10-10

Tested whether the 13 target-free V30 final-feature directions, projected into
the rank-6 closure-gated Lyapunov subspace, jointly identify its residual
coordinates. The test uses only saved per-network Gram matrices and feature /
residual cross-products; each held-out network is excluded from the fit, and
ridge strength is selected by an inner leave-one-network-out loop. The inputs
are the manifest-verified D8b IDs `0, 16, ..., 240` (16 whole networks).

Nested grouped LOO yields **+0.0348% mean relative MSE reduction**, with 11/16
networks improving. A 100,000-draw network bootstrap gives a 95% interval of
`[-0.277%, +0.306%]` and only 60.9% positive resamples. The median gain is
larger (+0.291%) because a few networks regress by 0.76–1.32%. This remains
statistically indistinguishable from no gain and far below a useful score move;
reject it for candidate promotion or submission. Reproduce with
`reports/research/evaluate_whest_lyapunov_feature_ridge.py`; result:
`.sota/runs/whest-lyapunov-feature-ridge-nested-loo-20261010.json`.

### Research implication: decouple the scored terminal objective

An independent public-forensics post reports that strong Phase-1 estimators
often had very poor intermediate-layer estimates but much better scored-layer
MSE, including one estimator with about a 113x L30-to-L31 error drop. This is
evidence that the scored terminal layer can behave differently from errors
measured along the propagated trajectory; it is not an explanation of the
method and must not be treated as a reusable technique by itself. Source:
[AIcrowd public-submission analysis](https://discourse.aicrowd.com/t/current-top-9-notes-on-phase-1-board-score-variance-the-truth-energy-ladder-and-four-corrections-to-published-figures/18164).

The first terminal-only correction trials in this repository were small and
mostly weak, and the earlier V29 terminal-ridge submission lost externally on
the compute multiplier. Therefore the actionable question is not “fit another
small output ridge,” but whether a separately derived terminal estimator can
compute the final-layer mean directly from target-free input/weight structure,
without paying for a full hidden-layer output trajectory. Any such approach
must be tested against the frozen current incumbent with the official score,
full-Mini zero-failure gate, and external grade; the forensic observation alone
does not justify a candidate.
