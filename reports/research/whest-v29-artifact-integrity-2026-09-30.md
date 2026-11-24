# WhestBench V29 artifact integrity check

Checked 2026-09-30 against the current workspace files. This is an artifact
audit, not a new evaluator run or a claim about the hidden split.

## Verified full-mini artifacts

| Setting | Rows | Failures | Adjusted score | Raw MSE | Estimator SHA-256 |
| --- | ---: | ---: | ---: | ---: | --- |
| `V26_STRASSEN=1` | 100 | 0 | `7.445228532264807e-9` | `2.228323971564805e-8` | `86d9ca9b28e6fe2b6c74750a0b6ae4bba4c14f742ddc3f5f56bc7fb4ec9d8e27` |
| `V26_STRASSEN=4` | 100 | 0 | `5.898624886930093e-9` | `2.228543495519375e-8` | `86d9ca9b28e6fe2b6c74750a0b6ae4bba4c14f742ddc3f5f56bc7fb4ec9d8e27` |

For the level-1 file, all 100 `final_layer_mse * compute_utilization`
calculations exactly match the stored per-row adjusted score. It contains 100
unique row indices, zero failed rows, and 100 `score_formula_verified` flags.
The stored aggregate is exactly the arithmetic mean of those per-row scores.
The estimator file and the estimator inside
`.sota/research/k3-v29-submission.tar.gz` both hash to the SHA-256 shown above.
The run records identify WhestBench 0.16.1, the persistent subprocess runner,
and `V26_STRASSEN=1` or `4`, respectively. The level-1 record's dataset
fingerprint is recorded as
`264fa1f416d16a40821fb5e8e94f5d2da4698a201d40da999616225b38b464f1`; this
check did not independently rehash the dataset directory.

Run artifact SHA-256 values:

- Level 1, `.sota/runs/whest-v29-level1-mini-2026-09-27.json`:
  `a991c726ff44daf553800da3db8ef710d4cd17e2760cb17cd796aeac180d40a9`.
- Level 4, `.sota/runs/whest-v29-strassen4-full-2026-09-29.json`:
  `ca1ba671130ef762a694e91745238e854854a402f07383388da1319cba0da574`.

## Historical level-5 discrepancy

The value `5.951463168581024e-9` appears in older prose as a successful
level-5 full-mini result. No JSON artifact under `.sota` currently contains
that successful 100-row result. The only archived level-5 100-row file,
`.sota/research/whest-k3-v29-level5-persistent-mini.json`, has 66 failed rows
and an invalid aggregate of `0.6162774356837685`. It does not validate the
prose value. Keep `5.951463168581024e-9` quarantined as unverified until its
exact successful artifact, estimator hash, environment, and zero-failure row
set are recovered.

## Implication

The verified level-1 and level-4 results are local public-mini measurements;
neither beats the best known external score, AIcrowd submission `332337` at
`5.418168137938331e-9`. Do not submit either setting unchanged. The level-5
prose value must not be used as local calibration evidence without its source
artifact.
