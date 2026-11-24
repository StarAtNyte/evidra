# WhestBench candidate input lock

Timestamp: 2026-09-30 (local workspace date)

This note records the read-only integrity checks for the public Phase 2 mini dataset and the evaluator environment. It is an input lock, not a candidate result and not evidence of hidden-split performance.

## Dataset identity

- Dataset: `aicrowd/arc-whestbench-public-2026`, revision `v2-phase2`.
- Local root: `competitions/whestbench/starterkit/.whest-data/`.
- Upstream Hugging Face LFS metadata was previously verified against local shard hashes and sizes; this pass independently recomputed all local hashes.
- `metadata.json`: `264fa1f416d16a40821fb5e8e94f5d2da4698a201d40da999616225b38b464f1`.
- `mini-00000-of-00007.parquet`: `7da858bc60616456e7b55a545a91288c1edba612b556be2e6eae3d86df48639c`.
- `mini-00001-of-00007.parquet`: `9c65a4c4c878623032d62ca3dbb1c88fc88e724f84fdbdc9d7b77904fa100e1d`.
- `mini-00002-of-00007.parquet`: `f0fe736bdfddf2ebbb9d0e0df7bf68d0938abaaadcc34eeff143bbb26123387c`.
- `mini-00003-of-00007.parquet`: `7c987422c2ad849ff9bce073483d8c10152635398e2c528899af6944d5e0d110`.
- `mini-00004-of-00007.parquet`: `fedf0d67479eb7b8743c0d7caa5a4e3c2359e18560c3834f5dbda3232f735541`.
- `mini-00005-of-00007.parquet`: `6eb84bd50068e8dcb0d8a6a609f2c4f90177d6228229ccb0793b656d7458fd59`.
- `mini-00006-of-00007.parquet`: `481bf94b30d81c005181891c9f4dbe540a1eec00dc24ec2da5f5fb45c3973254`.
- Data inspection with the frozen environment returned 100 rows, 100 unique IDs, 100 unique seeds, IDs 0–99.
- Provisional development split: IDs 0–79 train, 80–99 holdout. Keep holdout out of proposal selection; use it only for candidate comparison/confirmation under the competition rules. Mini remains public development data, not a proxy for the hidden leaderboard split.
- Canonical full dataset remains un-downloaded and unused for training. Do not spend its disk/network cost until a candidate merits an independent validation pass.

## Evaluator lock

- WhestBench `0.16.1`; FlopScope `0.12.1`; NumPy `2.2.6` (queried from the starter-kit frozen `uv` environment).
- `pyproject.toml` SHA-256: `0ecda2f3a887156e2887e8b159e878b812f5c939ef35ef6083c29a395bb42916`.
- `uv.lock` SHA-256: `d813be288f55717e1088ee321f1c310b1c966c46a461ff411878123268e620d6`.
- `evaluate_batched.py` SHA-256: `2a1b4f156d192a7d4d6813dd699a83d1b521b92d5756a5dd7f16a570fa165320`.
- Frozen execution: `uv run --frozen` from `competitions/whestbench/starterkit/`.

## Decision guardrails

1. Stop repeating data/evaluator inventory unless one of these pinned hashes or environment identities changes.
2. Require candidate source hash, complete bundle hash, command/configuration, per-row outcomes, failures, raw metric, utilization, and derived competition score before considering any submission.
3. Compare against the best known external result (`332337`, `5.418168137938331e-9`) and retain all local and external results separately; never infer external improvement from mini alone.
4. The operator authorizes up to 10 submissions per day. This is a maximum, not a target; do not submit a candidate that fails local validation or has no credible improvement rationale.
