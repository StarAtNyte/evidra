# WhestBench public-mini content audit — 2026-09-29

## Scope

This audit checks the actual row identity and compact summary fields in the locally cached AIcrowd public dataset release `aicrowd/arc-whestbench-public-2026@v2-phase2`, split `mini`. It is a development-data integrity check; it does not inspect or infer hidden evaluation data and does not establish leaderboard generalization.

The dataset README describes `mini` as 100 development MLPs and says it is disjoint from the separate 1,000-row `full` split. The local checkout contains the seven mini Parquet shards (about 8.1 GiB total), not the full split. Their SHA-256 values and byte-level upstream LFS parity are recorded in [whest-mini-shard-hashes-2026-09-29.json](./whest-mini-shard-hashes-2026-09-29.json); the evaluator lock records the metadata and shard digests.

## Inspection performed

Using the pinned starter-kit environment (`uv run --frozen`) and PyArrow Parquet metadata/column projection, I inspected all seven shard footers and read only `mlp_id`, `mlp_name`, `mlp_seed`, and `avg_variance`. Large nested `element` payloads and target arrays were deliberately not loaded for this identity audit.

Reproduction from `competitions/whestbench/starterkit`:

```sh
uv run --frozen python -c 'import pyarrow.parquet as pq, pathlib; files=sorted(pathlib.Path(".whest-data/data").glob("*.parquet")); rows=[]
for p in files: rows.extend(pq.read_table(p, columns=["mlp_id","mlp_name","mlp_seed","avg_variance"]).to_pylist())
ids=[r["mlp_id"] for r in rows]; names=[r["mlp_name"] for r in rows]; seeds=[r["mlp_seed"] for r in rows]
print(len(rows), len(set(ids)), len(set(names)), len(set(seeds)), {k:sum(r[k] is None for r in rows) for k in rows[0]})'
```

Observed shard row counts were `16, 16, 16, 16, 16, 16, 4` (100 total), each in one Parquet row group. The compact-field result was:

| Check | Result |
| --- | ---: |
| Rows | 100 |
| `mlp_id` | 100 unique, contiguous integers 0–99 |
| `mlp_name` | 100 unique |
| `mlp_seed` | 100 unique |
| Nulls in inspected columns | 0 |
| `avg_variance` | 100 present; observed range 0.0526051180948319–0.09901120384159512 |

The first and last rows had IDs 0 and 99 respectively. This matches the expected 100-row mini contract and supports stable row-key capture for paired local comparisons.

## Interpretation and limits

- This resolves the narrow audit gap “the 100 mini rows and their identity fields were never content-inspected.”
- Combined with the separate SHA/LFS report, the inspected content is tied to the pinned public release and local shard bytes.
- It does **not** establish that public `mini` is statistically representative of the hidden competition evaluation, prove cross-split seed disjointness locally (the full split is not downloaded), or clear all possible leakage risks.
- It does **not** authorize a candidate submission. Candidate source pin, exact evaluator/runtime hashes, all 100 successful evaluator rows, recomputed score formulas, and an independent aggregate check remain separate gates.
- Read-only; no source candidate, dataset, evaluator, or validation policy was changed.
