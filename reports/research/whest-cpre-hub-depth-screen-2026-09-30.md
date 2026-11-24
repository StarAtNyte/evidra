# WhestBench K3 compute-depth screen

Date: 2026-09-30. Dataset: locked `v2-phase2` `mini`; official persistent
subprocess runner; estimator source remains the MIT-licensed V29 chunk-6
implementation (`fb6d749b1a3a0da951735a43b0bdb871333add42b5745884fdee43f9e0bd807f`).
The only changed factors are Strassen depths; this is not a new algorithmic
accuracy claim or hidden-split evidence.

## Motivation and hypothesis

The verified V29 level-4 full-mini result is `5.898624886930093e-9`, zero
failures. The level-5 full-mini trial was invalid because of residual-time and
worker failures. Hypothesis: reduce the expensive `C_pre` and hub families to
depth 4 while retaining level 5 elsewhere to lower effective compute, preserve
predictions closely, and stay below the residual-time ceiling.

## Measurements

| Artifact | Configuration | Rows | Failures | Adjusted score | Paired comparison |
| --- | --- | ---: | ---: | ---: | --- |
| `.sota/runs/whest-v29-cpre4-first4-2026-09-30.json` | global 5, hub 5, C_pre 4, shared-basis 5 | 4 | 0 | `6.076910888908693e-9` | 4-row screen only; not promotion evidence |
| `.sota/runs/whest-v29-cpre4-prefix20-2026-09-30.json` | global 5, hub 5, C_pre 4, shared-basis 5 | 20 | 1 | **invalid** | 19 successful rows all beat control; row 10 failed residual time at `0.40887 s` |
| `.sota/runs/whest-v29-cpre4-hub4-prefix12-2026-09-30.json` | global 5, hub 4, C_pre 4, shared-basis 5 | 12 | 0 | `5.960862105355316e-9` | matched level-4 mean `6.092495094003602e-9`; 12/12 rows improve; `−2.16%`; max residual `0.39504 s` |
| `.sota/runs/whest-v29-cpre4-hub4-prefix20-2026-09-30.json` | global 5, hub 4, C_pre 4, shared-basis 5 | 20 | 0 | `5.7743790119512165e-9` | matched level-4 mean `5.905970240873672e-9`; 20/20 rows improve; `−2.228%`; max residual `0.39531 s` |
| `.sota/runs/whest-v29-cpre4-hub4-fullmini-2026-09-30.json` | global 5, hub 4, C_pre 4, shared-basis 5 | 100 | **1** | **invalid** | row 79 (`troy-welch`) exceeded residual cap at `0.52808 s`; 99 successful rows are diagnostics only, not an aggregate score |
| `.sota/runs/whest-v29-cpre4-hub3-prefix20-2026-09-30.json` | global 5, hub 3, C_pre 4, shared-basis 5 | 20 | **1** | **invalid** | row 10 (`randy-murray`) exceeded residual cap at `0.42559 s`; 19 passing rows averaged `5.932273921837099e-9` versus `5.899139135362524e-9` matched level-4 control, with 0/19 wins |
| `.sota/runs/whest-v29-cpre4-hub4-batch8-fullmini-2026-09-30.json` | global 5, hub 4, C_pre 4, shared-basis 5, batch 8 | 100 | 0 | `5.757911360377335e-9` | 100/100 paired wins vs level-4 control; raw predictions match to `1.65e-15`; max residual `0.36708 s` |
| `.sota/runs/whest-v29-default-batch8-prefix12-2026-09-30.json` | default depth-5 families, batch 8 | 12 | 0 | `5.835599637914616e-9` | row 10 residual `0.37639 s` vs `0.41353 s` on chunk-6 (old row failed); 11/12 adjusted-score wins vs chunk-6 |

The failed 20-row aggregate is quarantined; its successful-row mean is not a
score. It identifies a narrow residual-time failure mode on `randy-murray`
(index 10), consistent with the prior level-5 observation. Reducing hub depth
to 4 passed that case. The full-mini run then failed on `troy-welch` (index 79)
at `0.52808 s`, so its official aggregate is also invalid. On the 99 successful
rows only, the diagnostic matched means are `5.7741081063802515e-9` candidate
and `5.911529313270201e-9` level-4 control, with all 99 candidate rows lower;
do not report this as a score. The largest residual among passing rows was
`0.39763 s`, leaving just `2.37 ms` margin. This route is too fragile for
promotion and needs lower residual cost before a valid full run. A hub-3
20-row screen failed on the same `randy-murray` row and its successful rows
lost to the matched level-4 control (0/19). The failure is not monotonic in
hub depth; do not infer that lowering the depth fixes residual timing. Hub 3
is rejected and should not receive a full-mini run.

The batch-8 full-mini run is valid: zero failed rows, verified score formula on
all 100 rows, aggregate `5.757911360377335e-9`, and maximum residual `0.36708
s` (32.9 ms below the cap). Its raw MSE `2.2285433338709027e-8` matches the
level-4 control `2.228543495519375e-8` to numerical noise; the adjusted-score
gain over the control (`5.898624886930093e-9`) is cost-only, 2.39% overall,
with 100/100 paired row wins. It does not beat our best graded score of about
`5.42e-9`, so do not submit this C_pre-4/hub-4 arm. The worker reached about
6.7 GB RSS and 8.06 GB virtual size under the local 8-GiB address-space limit;
no memory-limit failure occurred, but memory headroom is finite.

## Current gate

A same-configuration first-20 run passed with 20/20 verified scores and no
failures, but the full-mini run failed one row. Promotion/submission still
requires a full 100-row zero-failure run, independent confirmation, and
improvement over the external incumbent (Evidra submission `332337`,
`5.418168137938331e-9`) and latest observed public leader (submission `332669`,
`1.76e-9`; [AIcrowd receipt](https://www.aicrowd.com/challenges/arc-white-box-estimation-challenge-2026/submissions/332669));
public-mini gains alone do not imply leaderboard gains.
