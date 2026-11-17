# Training receipts in campaign lessons

A failed controller run may contain completed training. Retrying it as an
interrupted fit wastes compute when validation or numerical checks rejected the
result. Campaign lesson generation now carries explicit training receipt fields
alongside the existing run status and accepted evaluator metrics.

`evidra lessons distil` reads a run payload's `trainingReceipt`, or its `fit`
receipt when the first field is absent. Only known boolean fields, nonnegative
integer counters, and finite validation losses enter the lesson. Unknown text and
metric claims in a receipt are ignored. Runs without these receipts retain their
existing behavior; this change does not discover external checkpoint files.

The lesson preserves flags such as `validation_improved=false`,
`held_block_optimization=false`, and `rk4_complete=false`. It does not infer a
scientific score from them, change a run's status, bypass any gate, or independently
verify a checkpoint. Source references remain attached so the next research turn
can inspect the underlying evidence before proposing another fit.

Regression coverage includes complete training rejected by validation, completed
update counts with failed numerical checks, incomplete counters, malformed fields,
and failed runs containing unaccepted score placeholders. The live application to
the Virtual Embryo training receipts verified that these facts reached the actual
research-director guidance loader. Improved future scores remain unproven.
