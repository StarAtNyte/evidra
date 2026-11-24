# Weight-only influence closure: paired four-network screen — 2026-10-10

## Decision

Reject the candidate. On the same four locked Mini networks, its raw MSE was
about 4.05x the local control, every paired network regressed, and its measured
FLOP use was marginally higher. Do not run full Mini, promote, package, or
submit this candidate. This is a small screening result, not leaderboard
evidence.

## Paired official-runner comparison

The screen used WhestBench 0.16.1's persistent subprocess runner and the first
four rows (whole networks) of the locked `mini` split. To avoid materializing
all 100 rows on a full filesystem, the four rows were sliced from
`mini-00000-of-00007.parquet` row group 0 into a temporary dataset. The exact
temporary dataset fingerprint reported by both runs was
`34e817c6535d2abbd182fe3a767e7cfd872630d4add0b6dc66686cdceb89119d`.
No target values were used by the estimator or for fitting.

| Measure | Weight-only closure | Local control |
|---|---:|---:|
| Mean final-layer MSE | `5.7441852732154075e-6` | `1.4175950298067619e-6` |
| Mean adjusted score | `5.744185273215408e-7` | `1.417595029806762e-7` |
| Mean FLOPs | `56,820,024,815` | `56,786,552,287` |
| Failed rows | 0/4 | 0/4 |

Every network regressed: candidate/control MSE ratios were approximately
`3.25x`, `4.20x`, `5.41x`, and `3.49x`. Both runs were below the 10% compute
floor, so the adjusted-score ratio matches the raw-MSE ratio. The local control
is the starter-kit-derived `competitions/whestbench/starterkit/estimator.py`
(SHA-256 below), not the V30/#335034 incumbent and not a new AIcrowd grade.
This screen rejects the closure relative to that local control only; it does
not estimate its delta against V30.

## Reproduction artifacts

- Candidate SHA-256: `1bda213aef1bddaf19bf4069804dcaacdb9c6cabd001565587fc1b3c15d82edb`
- Control SHA-256: `8546f1eaa3f3af41a9681c70fd981519e40540fd7371e62faeafcab26d150a2f`
- Candidate result: `.sota/runs/whest-influence-closure-screen-mini0-3-candidate-20261010.json`
  (SHA-256 `1a026650083d2b5d9bdce8994ef2e996c2654afb9e527f5f4746a69bea8df532`)
- Control result: `.sota/runs/whest-influence-closure-screen-mini0-3-control-20261010.json`
  (SHA-256 `126a0ff5f80273175e4440d0aac631adcfc969054c3dd2a9ac34941d122fc51f`)

## Execution failure diagnosis

The original reduced experiment failed before scoring. The complete source
shards are readable, but the local Hugging Face `datasets` builder tried to
materialize all 100 rows before applying the four-row cap. Its traceback ends
with `OSError: [Errno 28] No space left on device` while writing the Arrow
cache; the 96/100 progress was followed by failure on the final shard. The
filesystem had under 0.5 GB free. An in-memory four-row dataset avoided this
unnecessary full-split materialization and scored successfully.

This exposes a harness/evaluator improvement: a local `--limit` screen should
create a temporary prefix dataset before invoking WhestBench, rather than pass
the full dataset and set only `--n-mlps`. The temporary screen path and source
row range must be recorded in the run manifest.
