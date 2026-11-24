# Evidra ↔ WhestBench score loop

Updated: 2026-09-29. This tracks Evidra harness changes and ARC WhestBench
outcomes as parallel but separately attributed work. Lower adjusted score is
better. Public mini results are development evidence, not leaderboard proof.

## External/local evidence currently available

| AIcrowd submission | External adjusted score | Local evidence | Match quality |
| --- | ---: | --- | --- |
| Current workspace estimator (unsubmitted) | n/a | Full mini: `1.3364594587983445e-7`, 100/100 unique rows, zero failures | Exact current-source control; no submission bundle identity claim |
| 332302 | `7.126664527768703e-9` | Registered 100-MLP mini run: `7.463742748512812e-9`, zero failures | Matched mini pair; one observation |
| 332337 | `5.418168137938331e-9` | Historical full-mini value `5.951463168581024e-9` is cited in prior notes but its matching successful run artifact is not currently available; first-20 replay: `5.956661231748464e-9` | External score verified; historical full-mini value unverified pending artifact recovery |
| 332999 | `5.6487344412033275e-9` | Full mini: `5.898624886930093e-9`, 100/100, zero failures | Exact V29 Strassen-4 source/bundle lineage; one calibration pair, 4.24% local-to-external difference |

`evidra submission distribution` currently reports only two external/local
observations across different split labels (`mini` and `mini_first20_k3_v29`),
so it correctly returns no correlation estimate or recommended split. The two
score pairs above are not enough to claim predictive correlation or calibrate a
leaderboard score. A new candidate should be evaluated on the same full mini
protocol before submission; later distinct candidates are needed to estimate
whether local ranking predicts external ranking.

## Active measurements

- Fresh paired-screen preparation (2026-09-29): two independent Evidra experiment
  runs evaluated the exact V29 source SHA-256
  `86d9ca9b28e6fe2b6c74750a0b6ae4bba4c14f742ddc3f5f56bc7fb4ec9d8e27` with
  `V26_STRASSEN=4` on the same four-row public-mini prefix using the current
  persistent `evaluate_batched.py` adapter. Both completed with 0/4 failed rows,
  adjusted score `6.289937824165659e-9`, and raw MSE
  `2.3714243901906684e-8`; each row stayed below the official
  `2,199,023,255,552` FLOP budget. Run IDs:
  `exp_1790669908992__01_v29-strassen-4-paired-screen-1790670112541` and
  `exp_1790670402345_ed-v29-strassen-configuration-sc-1790670599296`. The
  repeat exactly reproduces the earlier four-row diagnostic, but this is not
  yet a paired comparison against `V26_STRASSEN=1`, a source-new estimator, a
  full-mini candidate, or a leaderboard improvement. Do not promote or submit
  based on this screen.

- The current starter-kit estimator control finished successfully: adjusted
  score `1.3364594587983445e-7`, raw MSE `1.3364594587983448e-6`, 100/100
  unique MLP indices, zero estimator failures, and zero score-formula
  mismatches. The aggregate formula was independently recomputed from all rows.
  WhestBench 0.16.1, persistent subprocess runner, 20m23.7s, artifact
  `.sota/runs/whest-control-2026-09-27.json` (SHA-256
  `dae2dae862481f2405ed6cf5b7a06f4acf1feea6f4de72e08808434f1fa72d4a`). The
  exact estimator SHA-256 is
  `8546f1eaa3f3af41a9681c70fd981519e40540fd7371e62faeafcab26d150a2f`.
  Source inspection identifies it as exact bivariate-Gaussian ReLU covariance
  correction plus empirical per-layer output calibration—not the 504aldo V29
  factorized K3 estimator. Its calibration-data provenance is unresolved, so
  this control is not evidence that public-mini labels were excluded from
  model development. Durable evidence: `observation_whest_control_result_20260927T1246Z`.
- The exact V29 source at `V26_STRASSEN=1` completed the full 100-row public
  mini run with zero failures (details below). It beats the current starter-kit
  control, but is worse than Evidra's existing `V26_STRASSEN=5` submission
  #332337 on its historical full-mini replay and external score. It is rejected;
  do not promote or submit it. Its source reports coefficients fitted on public
  example dumps, so this result is development evidence, not an unbiased holdout.

- The 100-MLP default-configuration replay of the submitted 332337 estimator
  has completed (2026-09-27 10:37:49 UTC start, 3,175 s, official runner exit
  1). It returned 66/100 estimator failures and aggregate adjusted score
  `0.6162774356837685`; this aggregate is invalid and is not a leaderboard
  comparison. Its summary matches the previously persisted level-5 diagnostic
  `.sota/research/whest-k3-v29-level5-persistent-mini.json`, which records 33
  375-MiB allocation failures and 33 subsequent worker closures. This invocation
  did not persist its own full JSON, so its per-row output must not be claimed as
  independently archived. The source hash is
  `86d9ca9b28e6fe2b6c74750a0b6ae4bba4c14f742ddc3f5f56bc7fb4ec9d8e27`.
- While the research campaign continued, a two-row diagnostic changed only
  `V26_STRASSEN` from its source default (5) to 1. It completed with 0/2
  failures and adjusted score `7.320267723797054e-9` (raw MSE
  `2.1881024103720392e-8`). This is only a two-row screen and is worse than the
  registered incumbent; it is not a candidate or submission result. The
  historical full-mini value `5.951463168581024e-9` is attributed to level 5 in
  prior notes, but the corresponding successful 100-row artifact is not present
  in the current workspace. The archived level-5 JSON has 66 failed rows and an
  invalid aggregate; do not use it to validate that value. The verified level-1
  artifact is `7.445228532264807e-9` (100 rows, zero failures), worse than
  332337's external score. Recover the exact level-5 artifact before making a
  local/external calibration claim from it.
- The previous reliability campaign remains preserved as a paused run. A fresh
  12-hour Codex `gpt-6-luna`, medium, fast-autonomy challenge campaign is now
  running, with separate general-harness and estimator tracks plus an
  independent validation lane. Up to ten distinct, locally validated entries
  per day are authorized; the daily quota is an experiment budget, not a reason
  to accept invalid evidence. Failed aggregates remain unusable.
- Submission 332999 is graded and recorded below. No other submission has been
  made in this new campaign yet.

## Measurement instrumentation follow-up

`evaluate_batched.py` now accepts `--output-json` to atomically preserve the
complete per-MLP report, estimator SHA-256, evaluator command, allowlisted
algorithm/thread environment, and exit status. This prevents an interactive
output truncation from discarding the evidence needed to diagnose failures.
Its focused suite passes 7/7 tests. Use this option on the next full run.
The two outcomes above were also recorded in Evidra's durable research graph as
`whest-local-v29-default-full-20260927` (invalid full run) and
`whest-local-v29-strassen1-first2-20260927` (diagnostic-only two-row screen),
so subsequent campaign cycles can distinguish them from external leaderboard
scores.

## Harness change made for the loop

Command adapters now parse a completed score from submission output, including
Whest's `Graded — score 5.4e-9` format and a competition's declared primary
metric label. When present, Evidra stores the bundle as scored, appends an
external-score observation/claim, and refreshes its experiment audit so the
next research cycle receives that outcome. Platforms that grade asynchronously
can continue to use their configured score polling or manual score recording.

At the earlier update, `npm test` passed 602/602 and the governance benchmark
passed 13/13. The evaluator subsequently exited with 66/100 row failures; its
aggregate is invalid and is recorded above. The latest harness validation after
the control-loop fix passed 603/603 Node tests, 7/7 evaluator tests, and
`git diff --check`.

## Parallel harness checks and implementation recovery

On 2026-09-27, the general experiment coordinator gained an implementation
gate: it requires a target-file hash change (or a source-code change when no
entrypoint is declared), and after a missing/invalid implementation attempts
exactly one constrained unified-diff recovery. Patch application is validated
before evaluation; a second failure stops without spending evaluator compute.
The regression checks no-op changes, documentation-only changes, valid source
changes, and the constrained recovery prompt. The full Node suite passes
605/605.

While the official 100-case Whest control runs, independent harness lifecycle
checks also pass: safety 9/9, orchestration 24/24, and governance 13/13. These
are deterministic invariant checks, not evidence that Evidra outperforms
another harness. The current full control remains in progress; its process and
per-case JSON artifact must be checked after exit before recording any score.

## Credential handling

An AIcrowd API key was pasted into conversation. It has not been used or written
to the repository in this work. Rotate it before any future submission; the
Whest CLI accepts `AICROWD_API_KEY` in the process environment, avoiding a
repository credential file.

## Research update: accuracy is the remaining lever

Public Phase 2 reports reviewed on 2026-09-27 sharpen the next experiment
choice. Team 504aldo reports that its V29 K3 chain plateaued near raw MSE
`2.13e-8`; later V22–V29 changes mostly reduced compute, not accuracy. A
separate Phase 2 post reports that the adjusted-score multiplier bottoms at
`0.1`, so reducing compute below that floor cannot improve the score; their
plain and antithetic Monte Carlo, randomized-QMC, and coupled-control-variate
tests did not improve accuracy. Another team reports an exact bivariate ReLU
covariance plus per-layer ridge calibration, but its score (`1.32e-7`) is far
behind Evidra's incumbent, so that method is not a candidate to copy wholesale.

These are participant-reported findings, not independently reproduced
measurements. Together they argue against further compute-only tuning or
unmodified sampling variants. The next useful work is a cheap, leakage-safe
diagnostic aimed at higher-order closure error, then a new estimator change
only if that diagnostic supports it. Sources: [504aldo V29 trajectory and
ablation report](https://discourse.aicrowd.com/t/everything-we-tried-a-factorized-k-3-cumulant-propagation-estimator-at-0-25-x-b-where-its-flops-go-and-25-measured-dead-ends-team-504aldo-rank-10/18218), [Phase 2 compute-floor and negative-results
report](https://discourse.aicrowd.com/t/phase-2-the-compute-budget-is-not-a-lever-and-the-scoring-rule-is-why-adjusted-mse-x-max-0-1-util/18219), [exact covariance and calibration
report](https://discourse.aicrowd.com/t/phase-2-write-up-exact-bivariate-relu-covariance-plus-per-layer-calibration-3x-over-the-kit-baseline-with-negative-results-submission-329951/18214).

### Fresh primary-source read while the control runs

The V29 repository describes a factorized K=3 cumulant chain, with
memoryless fourth-cumulant regeneration and age-gated shared subspaces; its
authors report V16b–V18 as the accuracy gains and V22–V29 as cost reductions
at essentially fixed raw error. Their report says leading entries at that
time had both lower raw error and lower compute, while the representation
behind those results was unknown. Importantly, V29 is NOT the estimator in
our current starter-kit workspace. The live evaluation's estimator hash is
`8546f1eaa3f3af41a9681c70fd981519e40540fd7371e62faeafcab26d150a2f`; its
source header and code identify exact bivariate-Gaussian ReLU covariance
correction plus an empirical per-layer output calibration. That is much
closer to the method in submission #329951, whose authors report `1.32e-7`
on the public leaderboard. The live 100-case control will establish our
actual result for this exact file; historical scores for other bundles must
not be attributed to it without matching artifact hashes. [V29 source repository](https://github.com/504aldo/whest-p2-cumulant-k3), [detailed V29 write-up](https://discourse.aicrowd.com/t/everything-we-tried-a-factorized-k-3-cumulant-propagation-estimator-at-0-25-x-b-where-its-flops-go-and-25-measured-dead-ends-team-504aldo-rank-10/18218), [#329951 method and reported score](https://discourse.aicrowd.com/t/phase-2-write-up-exact-bivariate-relu-covariance-plus-per-layer-calibration-3x-over-the-kit-baseline-with-negative-results-submission-329951/18214).

The discussion also shows why a paper-level idea is not enough: a second team
tested a reported fourth-cumulant/covariance proportionality against a
different tensor object and found the correlation collapsed with depth; the
original author clarified that the two teams had measured different
representations, then reported their pre-activation core law separately.
Thus any transfer needs an exact tensor/object definition and a cheap
measurement on our representation before implementation. This is a useful
general experiment-design lesson: formalize the measured object, not merely
the verbal mechanism, and record when a negative result is representation-
specific. [Discussion and correction](https://discourse.aicrowd.com/t/everything-we-tried-a-factorized-k-3-cumulant-propagation-estimator-at-0-25-x-b-where-its-flops-go-and-25-measured-dead-ends-team-504aldo-rank-10/18218).

## Live-run evidence fed back into Evidra

The autonomous critic repeatedly carried an old evaluator PID from historical
campaign context and consequently treated the live control as unverified. A
fresh direct snapshot is now persisted as
`observation_whest_control_live_20260927T123813Z` (content hash
`716b365e3306f87b2b7a91b205471a05fa45c9db845b3e9351dc9b902662329`). It
records the observed process chain, exact wrapper/evaluator commands, hashes
of the estimator, wrapper, competition configuration, and dataset metadata,
and the explicit limitation that no score exists until exit. A role-specific
directive tells the next validation lane to treat old PIDs as stale, cite the
new source, and distinguish checks now satisfied from post-run checks still
pending. This is a general provenance lesson for long-lived campaigns:
operational state must be timestamped and durably attached to evidence, not
reconstructed from an old narrative. The control was still live at 12:38 UTC;
no metric is inferred here.

## Public mini-shard identity audit

Read Parquet footers for all seven local `mini-*.parquet` shards and streamed
only `mlp_id`, `mlp_name`, and `mlp_seed`. The common schema is consistent;
row counts are 16 per first six shards and 4 in the last, totaling 100.
Identifiers, names, and seeds are each unique, with IDs spanning 0–99. No
`full-*.parquet` split is present in this workspace. This closes within-mini
duplicate identity concerns and is enough to permit a bounded public-mini
experiment; it does not establish cross-split leakage status because the full
split is not locally available, nor does it inspect or hash the large weight
and target tensors. The audit is recorded as
`whest-mini-shard-identity-audit-20260927` in Evidra's durable event store.

## Durable observation provenance fix

Campaign cycle 8 correctly failed closed when its hypothesis cited the audit
event ID, but the graph layer only resolved observations written in the older
`sourceId` form. It did not materialize an observation that carried its stable
identifier as `id`, so the controller paused with “unknown durable research
source.” Evidra now materializes persisted `research.observation` events as
local, content-hashed observation sources and resolves their exact IDs before
hypothesis validation. Unknown IDs remain rejected. A regression test covers
this event-to-source path; `npm test` passes 604/604. The same campaign was
resumed on the rebuilt harness; its next cycle is running. The semantic critic
also correctly rejected comparing public-mini scores directly with a full
leaderboard score, and that comparability guard remains unchanged.

Cycle 9 then exposed a second controller issue: the director selected a
bounded validation action but labeled it with the next phase, causing the
controller to downgrade it to inspection even though the active-phase goal and
separate phase-transition gate remain authoritative. The controller now
normalizes the model-supplied phase label to its active phase and records the
normalization, preserving the proposed action while leaving all phase-goal
completion and transition checks intact. The phase auditor remains strict when
called directly. A regression assertion verifies a valid run is not downgraded
for label drift; the full 604-test suite passes. The already-running controller
loaded the pre-fix build, so a durable steer asks it to use `data_audit` as its
phase and proceed with the bounded paired screen; later campaign cycles will
use the rebuilt normalization logic.

## General campaign-stall correction

The active campaign exposed two generic causes of repeated audit decisions.
First, the autonomous loop audited the repository root instead of the active
task workspace, so unrelated duplicated deployment metadata and unrelated
files polluted challenge leakage review. The loop now audits
`adapter.workspacePath(root)`, matching the explicit audit command and working
for local research or any registered challenge adapter. Second, exact duplicate
claims were treated like contradictions by adaptive allocation, allowing
repeated summaries to keep a campaign in evidence-review mode. Duplicates are
now non-blocking provenance diagnostics; explicit contradiction edges remain
blocking. A regression test exercises 2,591 duplicate records without diverting
allocation, and the full suite passes 606/606.

For this campaign, the scoped audit found no duplicate file groups or tabular
distribution-shift pairs. The generic scanner still cannot inspect the large
Parquet tensor shards or metadata JSON, and the full split is absent. This is
recorded as accepted uncertainty for internal public-mini screening only; it is
not evidence that cross-split leakage or tensor integrity has been ruled out,
and it does not authorize promotion or external submission. After this scoped
audit and explicit caveat were recorded, the durable campaign advanced from
data audit to validation.

## V29 level-1 local result — rejected against incumbent

The exact 504aldo V29 source (SHA256
`86d9ca9b28e6fe2b6c74750a0b6ae4bba4c14f742ddc3f5f56bc7fb4ec9d8e27`) was run
through the official persistent Whest subprocess runner on the same 100-row
public mini split as the current-workspace control, with `V26_STRASSEN=1` and
the same two-thread environment. The candidate exited 0 in 2,362.85 seconds;
all 100 indices were unique, all rows passed, and independent score-formula
recomputation found zero mismatches. Mean adjusted score was `7.445228532e-9`
and mean final-layer MSE `2.228323972e-8`. The output artifact is
`.sota/runs/whest-v29-level1-mini-2026-09-27.json`, SHA256
`a991c726ff44daf553800da3db8ef710d4cd17e2760cb17cd796aeac180d40a9`.

Matched by row index and name against the exact current-workspace control,
V29 had lower adjusted score on all 100 cases. Mean paired improvement was
`1.262007173e-7` with a deterministic paired bootstrap 95% interval of
`[1.229073032e-7, 1.296033523e-7]`; geometric-mean control/candidate ratio
was 17.98. This is only a local win against the current starter-kit file, not
an unbiased generalization estimate or an external leaderboard result. The
same V29 source at `V26_STRASSEN=5` is reported in earlier notes to have scored
`5.951463168581024e-9`, but no matching successful full-mini artifact is
currently present; the only archived level-5 100-row file has 66 failures.
External submission #332337 scored `5.418168137938331e-9`; the verified
level-1 score is `7.445228532e-9`. The
level-1 candidate is rejected. Its planned 100-case replication was deliberately
canceled before completion after reconciling this incumbent evidence; there is
no replication artifact and none is claimed. This exposed a comparison failure
in the research process: beating a weak workspace control was mistakenly
described as candidate progress before comparing against Evidra's best-known
submission. Future promotion decisions must check the strongest known
source/configuration-matched incumbent first, and stop before costly replication
when a candidate is dominated. Promotion and submission remain closed pending
a genuinely stronger, leakage-safe candidate and private credential rotation.

## V29 level-4 full-mini result — valid local improvement, still rejected

On 2026-09-29, the exact same V29 source SHA-256
`86d9ca9b28e6fe2b6c74750a0b6ae4bba4c14f742ddc3f5f56bc7fb4ec9d8e27` was
evaluated with `V26_STRASSEN=4` and the two-thread environment through the
persistent WhestBench 0.16.1 subprocess runner. All 100 public-mini MLP indices
are present and unique; there are zero failed rows and zero score-formula
mismatches. The aggregate independently recomputes to adjusted score
`5.898624886930093e-9`, raw final-layer MSE `2.228543495519375e-8`, and mean
compute utilization `0.26468454784871936`. The run took 3,846.73 seconds.
Full per-MLP diagnostics, command, environment, source/data hashes, and run
metadata are preserved in
`.sota/runs/whest-v29-strassen4-full-2026-09-29.json` (68 KB).

This is a local public-mini result, not a leaderboard result. It improves on
the same-source level-1 local score (`7.445228532e-9`) by about 20.8%, but is
about 8.9% worse than the current best-known external submission #332337
(`5.418168137938331e-9`). Therefore level 4 is not promoted or submitted. Its
four-row screen (`6.289937824165659e-9`) was directionally pessimistic but did
not replace the required full-split result. Next, screen adjacent
`V26_STRASSEN` configurations on the identical four-row prefix; only a screen
that beats both the level-4 result and the incumbent warrants another full
100-row run. Any full-run result must retain exact source/configuration
provenance and independently pass the all-rows, zero-failure, score-formula,
resource, and incumbent-comparison gates before consuming one of the daily
submission slots. Submission credentials pasted into chat are not reused;
rotate them and configure the replacement outside the repository.

Follow-up screens on the same first four mini MLPs, exact source hash, and
persistent runner:

| `V26_STRASSEN` | Threads | Adjusted score | Failures | Decision |
| ---: | ---: | ---: | ---: | --- |
| 3 | 2 | `6.67854954089375e-9` | 0/4 | Reject; worse than level 4 on this prefix |
| 5 | 1 | invalid (`0.5887` includes penalties) | 2/4 | Reject; OOM persists despite one-thread execution |

The level-5 failures are row 1, unable to allocate a 375 MiB float32 array of
shape `(10, 7, 343, 64, 64)`, and row 2, worker closure after that allocation
failure. This repeats the prior level-5 memory failure even after lowering
Whest and BLAS thread caps; its aggregate is invalid, not a score. The level-3
screen is valid only as a four-row diagnostic, not a full-split estimate.
Together with the level-4 100-row result, these screens show a bounded local
tradeoff: level 4 is better than level 3 and level 1 here, while level 5 is
not viable under this local runner. The best known *external* result remains
332337 at `5.418168137938331e-9`; none of these new local measurements beats
it. Reports are in `.sota/runs/whest-v29-strassen3-first4-2026-09-29.json` and
`.sota/runs/whest-v29-strassen5-threads1-first4-2026-09-29.json`.

The evaluator wrapper had hard-coded Whest's `--max-threads=2`, preventing a
controlled low-memory route. It now accepts `--max-threads` (positive integer,
default 2) and records the chosen value in the exact command provenance. The
focused evaluator test suite passes 8/8, including propagation of an explicit
one-thread setting. That retry confirmed this specific level-5 allocation is
not solved by reducing BLAS threads, so do not repeat it unchanged.

## V29 level-5 chunked full-mini result — reject; partial signal only

On 2026-09-29, the unchanged V29 estimator was evaluated with a chunked
Strassen multiplication wrapper (`V29_MAX_BATCH=3`, `V26_STRASSEN=5`) and
one-thread BLAS settings on the full 100-row public mini split. The exact
wrapper SHA-256 is
`09453bc0abc8ce3dcc1858cdc3c71b845d9b851bb641ed9321ef161c0fad4954`; the
unchanged imported estimator SHA-256 remains
`86d9ca9b28e6fe2b6c74750a0b6ae4bba4c14f742ddc3f5f56bc7fb4ec9d8e27`.
The complete run took 5,250.23 seconds. All 100 indices are present and
unique, but four rows failed, so the candidate is invalid and must not be
submitted. Three rows (`10`, `44`, `94`) exceeded Whest's 0.4-second residual
wall-time gate (observed residuals 0.5003s, 0.4356s, and 0.4918s). Row `83`
failed with `Worker closed stdout`, consistent with a worker crash; the cause
has not yet been independently established. The exact command, data hash,
environment, per-row diagnostics, and failure classifications are in
`.sota/runs/whest-v29-strassen5-chunk3-full-2026-09-29.json`.

Whest's all-row penalty aggregate is `0.04005166000075948`; this is not a
useful estimator-quality score because it includes the four failed-row
penalties. The 96 successful rows average `5.649483573782926e-9` adjusted
score and `2.2301955523070422e-8` raw MSE, but this success-only figure is
descriptive only and cannot replace the official all-rows validity gate. It
improves on the previous S4 full-mini score (`5.898624886930093e-9`) among
successful rows, yet remains about 4.3% worse than the known external
submission #332337 (`5.418168137938331e-9`). Therefore this configuration is
rejected for submission. Next work should first isolate the row-83 worker
failure and address residual-time headroom, then run a complete persistent
100-row evaluation and compare against the incumbent before using a daily
submission slot. Do not infer a leaderboard score from this local split.

### Follow-up lifecycle and chunk-size diagnostic

To distinguish an intrinsically bad MLP from a sequence-dependent worker
failure, rows 80–95 were extracted unchanged into a temporary local Whest
dataset and replayed through the same persistent subprocess lifecycle. With
chunk size 3, row 83 (`denise-smith`) passed at `6.0780669083655916e-9` and
0.3412s residual; the shard had one different failure (row 90 at 0.4808s),
with 15/16 rows passing and a success-only diagnostic mean of
`5.6194532994518434e-9`. With chunk size 2, row 83 also passed, but 11/16
shard rows failed the residual-time gate and only five succeeded. These
success-only means are descriptive and invalid for promotion. The isolated
replays show that row 83 is not a deterministic single-case failure and that
chunk size 2 is not a robust remedy; they leave cumulative-state pressure or a
transient worker failure plausible but unproven. Artifacts are
`.sota/runs/whest-v29-strassen5-chunk3-indices80-95-2026-09-29.json` and
`.sota/runs/whest-v29-strassen5-chunk2-indices80-95-2026-09-29.json`.

A subsequent four-row screen of chunk size 4 passed all rows with adjusted
score `6.07695427837896e-9`, raw MSE `2.3713136343417318e-8`, and maximum
residual `0.3307s`; this is essentially tied with the chunk-2/3 four-row
screens and remains only a screening result. Artifact:
`.sota/runs/whest-v29-strassen5-chunk4-first4-2026-09-29.json`. Chunk size 5
also passed the same four rows (`6.078722235371975e-9`, maximum residual
0.3345s), artifact `.sota/runs/whest-v29-strassen5-chunk5-first4-2026-09-29.json`.

Chunk sizes 4 and 5 were then evaluated on the same 16-row tail shard (source
indices 80–95). Both had the same sole failure, row 90 (`rachel-kelley`):
residual 0.4381s for chunk 4 and 0.4375s for chunk 5. Their other 15 rows
passed, with descriptive success-only means `5.615040460808061e-9` and
`5.615182068093521e-9`, respectively. Neither is a valid shard aggregate.
Artifacts are `.sota/runs/whest-v29-strassen5-chunk4-indices80-95-2026-09-29.json`
and `.sota/runs/whest-v29-strassen5-chunk5-indices80-95-2026-09-29.json`.

Chunk size 6 passed all five rows implicated by the full chunk-3 run (source
indices 10, 44, 83, 90, and 94), at adjusted score `5.9756469996545016e-9`
and zero failures. This targeted test suggested chunk size 6 could clear the
known timing outlier and row-83 error in a fresh process, but did not establish
full-split reliability. The artifact is
`.sota/runs/whest-v29-strassen5-chunk6-problem-rows-2026-09-29.json`.

The exact chunk-6-default candidate was then run across the full persistent
100-row mini split. It completed in 4,843.90 seconds with all 100 unique rows
and verified score formulas, but had three failures: row 10 (`randy-murray`,
residual 0.4135s), row 68 (`barbara-walls`, worker stdout closed), and row 79
(`troy-welch`, residual 0.4036s). The all-row adjusted aggregate
`0.02676090132853994` is invalid due to failed-row penalties. The 97 successful
rows have a diagnostic-only mean `5.649758459680765e-9`, still about 4.3%
worse than incumbent #332337 (`5.418168137938331e-9`). Therefore chunk 6 is
rejected for submission; no submission was made. Full provenance and every
row are preserved in
`.sota/runs/whest-v29-strassen5-chunk6-full-2026-09-29.json`.

To test whether these were intrinsic single-MLP failures, rows 10, 68, and 79
were replayed in order in a fresh persistent worker. All three passed with
adjusted mean `5.377538665172508e-9`; row 10 residual was 0.2470s, row 68
0.2621s, row 79 0.2586s. This supports a sequence- or transient-resource
interaction rather than deterministic per-row failure, but does not identify
the mechanism or establish 100-row reliability. Artifact:
`.sota/runs/whest-v29-strassen5-chunk6-failure-rows-2026-09-29.json`.

## General campaign-loop hardening

The live campaign showed that fast autonomy selected the entire specialist
roster even when the host concurrency ceiling was much lower, then repeated
that roster for peer review. Team size now scales with concurrency and
permission tier (safe: one concurrent wave; fast: concurrency plus one; yolo:
up to twice concurrency), while peer review is separately capped at two lanes
in fast mode and three in yolo mode. This preserves diverse exploration without
serially running every role by default.

The critic gate also previously treated every `revise` as a hard veto on any
experiment, causing open validation/provenance checks to keep campaigns in
inspection. A revise now permits only a selected hypothesis with an explicit
falsification test to run as exploratory; completion, acceptance, promotion,
and submission remain gated, and explicit `reject` still vetoes execution.
Unresolved critic checks are carried forward with that distinction. Regression
coverage and the full Node suite pass 606/606. These controller changes are
objective-agnostic; WhestBench remains the live external score test, not their
definition of success.

## Generic evaluator failure contract

The 332337 level-5 replay demonstrated why a failed run's aggregate must never
be treated as a metric: 66/100 rows failed after memory allocation and worker
closure errors, yet the evaluator emitted a numeric aggregate. The adapter
independently verifies row scores and the declared formula, preserves failure
diagnostics, and exits non-zero whenever any row fails. At the generic Evidra
boundary, a non-zero evaluator exit is a failed run, not a candidate score;
failure recovery must preserve that attempt and use a materially changed route
rather than replaying an unchanged manifest. Keep this as a cross-objective
invariant in the run/recovery tests. Task-specific adapters may add richer
per-case checks, but must fail closed on incomplete or invalid results.

## Level-4 calibration submission and CPU-affinity diagnostic — 2026-09-29

The chunk-6 full-split failure rows (10, 68, 79) were rerun pinned to logical
CPU 31 to test the scheduler-contention hypothesis. All three again failed the
0.4-second residual limit, with residuals 0.4843s, 0.5236s, and 0.5366s. This
contrasts with their clean unpinned fresh-process replay (0.2470s, 0.2621s,
0.2586s) and rejects CPU affinity as a reliable mitigation. The pinned run
exited non-zero; its aggregate is invalid. Full diagnostics:
`.sota/runs/whest-v29-strassen5-chunk6-failure-rows-cpu31-2026-09-29.json`.

Using the user's authorization to spend from the ten daily entries, the valid
V29 Strassen-4 local candidate was uploaded as a calibration experiment. The
submission artifact changes only the source defaults for `V26_STRASSEN` and
its CPRE fallback from 5 to 4, matching the configuration used in the prior
full local run; it is standalone and contains only `estimator.py`. Its
SHA-256 is
`f645bd7c2ffdbf84f165f5d7ed29f56ac48ec66c96b68c55a2832bb1290f65a9`.
Whest contract validation, packaging, and package validation all passed. The
corresponding local full-mini result was 100/100 unique rows, zero failures,
formula verified, adjusted score `5.898624886930093e-9` (artifact
`.sota/runs/whest-v29-strassen4-full-2026-09-29.json`).

AIcrowd accepted this calibration submission as **332999** and graded it at
`5.6487344412033275e-9` (status confirmed through the authenticated AIcrowd
submission API). Against the matching local `5.898624886930093e-9`, the
external score is 4.24% lower/better. This is one matched pair only: it gives
an initial calibration residual, not a correlation estimate. The external
score trails incumbent #332337 at `5.418168137938331e-9` by 4.26%, so this
entry did not improve our best leaderboard result. Keep calibration and
incumbent-performance claims separate. The exact score and bundle provenance
are now durable; future candidate selection can account for this observed
local-to-external offset while continuing to require full-split validity.

## Verification-source mismatch found by Evidra's autonomous loop — 2026-09-29

Two autonomous reduced-screen runs were labeled as V29 provenance checks, but
both evaluated the starter estimator in the isolated worktree instead. The
actual estimator SHA-256 was
`8546f1eaa3f3af41a9681c70fd981519e40540fd7371e62faeafcab26d150a2f`; each
returned `1.417595029806762e-7` on four rows. These results are retained as
failed provenance attempts and are invalid for V29 comparison. They do not
change the candidate ranking or the AIcrowd outcome.

The cause was a verification-only manifest with `estimatorPath` but no
checksum-pinned `implementationSource`. It silently meant "reuse whatever
estimator is in the worktree." Evidra now rejects file-backed verification
without a source path and SHA-256, rejects a target mismatch, and seeds the
exact pinned source into the worktree. The TUI also skips code-edit requests in
verification mode and verifies the pinned file before smoke, reduced, full,
and retry evaluations. Generic regression coverage passes with the 646-test
suite. The exact V29-S4 source to use for a controlled replication is
`.sota/candidates/whest-v29-s4-calibration/estimator.py` with SHA-256
`f645bd7c2ffdbf84f165f5d7ed29f56ac48ec66c96b68c55a2832bb1290f65a9`.
Next score action: verify that hash appears in the run's durable source snapshot,
then do the bounded 4-row screen and only then a full 100-row replication.
