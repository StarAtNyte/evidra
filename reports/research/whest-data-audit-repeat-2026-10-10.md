# WhestBench Mini data-integrity recheck — 2026-10-10

## Result

Read-only SHA-256 verification was repeated against the pinned release manifest
`reports/research/whest-mini-shard-hashes-2026-09-29.json` from
`competitions/whestbench/starterkit/.whest-data`. `metadata.json` and all seven
`mini-00000-of-00007.parquet` through `mini-00006-of-00007.parquet` shards
matched their recorded digests (`sha256sum -c`: eight `OK` results). The local
shard files total 6.6 GiB. The manifest records that these hashes and byte sizes
match Hugging Face LFS metadata for `aicrowd/arc-whestbench-public-2026`, pinned
revision `v2-phase2`.

The prior content audit in
`reports/research/whest-data-content-audit-2026-09-29.md` inspected the compact
identity fields across all 100 Mini rows: IDs, names, and seeds were unique,
with no nulls in the inspected columns. These checks establish integrity and
identity for the public development split; they do not establish that Mini is
representative of hidden evaluation data.

## Leakage boundary

The verified estimator contract supplies network weights and scores predictions
against reference means outside the estimator. Local reference targets are for
evaluation only. This checksum/identity audit does not itself prove absence of
all target leakage; each candidate still requires source review confirming
`predict()` derives outputs from the supplied MLP weights and does not read
targets, evaluation files, or network resources. D8b-derived training data, if
used in an offline-fitted artifact, remains a separate provenance and rules
review item.

## Reproduction

From the starter-kit `.whest-data` directory:

```sh
jq -r '"\(.metadata.sha256)  \(.metadata.path)", (.shards[] | "\(.sha256)  \(.path)")' \
  /home/at-office/Projects/Nitiz/Evidra/reports/research/whest-mini-shard-hashes-2026-09-29.json \
  | sha256sum -c
```

This audit changes no dataset, estimator, or validation policy.
