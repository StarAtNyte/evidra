# V30 / AIcrowd #335034 local artifact identity — 2026-10-10

## Verified local lineage

The contemporaneous external-feedback report identifies AIcrowd **#335034** as
the grouped-CV cubic-residual, Strassen-leaf-8 V30 estimator and records its
official adjusted score as `5.162197424910759e-9`.

The retained V30 archive is:

- Path: `.sota/candidates/whest-v30-cubic-residual-strassen8-20261009/submission.tar.gz`
- Archive SHA-256: `b0748971e91a43fbcbce29ec6b2969177ff588d24e408e221d8cc9dd640d2832`
- `estimator.py` member SHA-256: `89395749c6a1b3cc12ff230a770c85d0bdb26f2f68d85023dfab12bd27920315`

The loose working `estimator.py` currently hashes to
`e8cb7403d0b3fd37117a3a9f9f1a59d5aef630b65d35b9303f5adcf9c288871d`. A byte
diff against the archived member shows only an opt-in
`EVIDRA_CAPTURE_LAYER_GATES` diagnostic append; it is inactive in ordinary
inference. Experiments that need the exact local V30 bytes should import the
archived estimator member or verify this stated diagnostic-only delta before
using the loose file.

## Evidence boundary

The public AIcrowd detail page for #335034 confirms the graded submission and
shows `estimator.py` among its files, but does not expose a downloadable source
URL or server-side SHA-256 in the public page payload. Therefore the mapping
from #335034 to this retained archive is established by the local submission
lineage record plus byte-level local archive inspection, not by an independent
cryptographic receipt from AIcrowd. Keep this caveat explicit in any audit;
the local V30 source/bundle pair itself is fully hashed and reproducible.

Sources:

- [AIcrowd #335034](https://www.aicrowd.com/challenges/arc-white-box-estimation-challenge-2026/submissions/335034)
- `reports/research/whest-external-feedback-and-diagnostics-2026-10-09.md`

## Use in comparisons

This is sufficient to identify the retained V30 local control package for
paired local tests, while preserving the limitation above. It does not make
V30 a new candidate: any V30-identical evaluation is a baseline replay, not an
improvement or a submission. For promotion, require the candidate to differ by
a pinned source hash, pass the locked full-100 evaluator with zero failures,
and improve the official external grade.
