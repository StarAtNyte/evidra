# WhestBench Strassen-6 persistent screen — 2026-09-27

Status: rejected; invalid aggregate due to evaluator failures.

## Protocol

- Dataset: local public `v2-phase2` `mini`, fixed prefix of 20 MLPs.
- Runner: WhestBench 0.16.1 official persistent subprocess runner through
  `evaluate_batched.py`.
- Estimator: the modified K3 V29-family source in the recorded experiment
  worktree; SHA-256 `f000addc80c8eb57a9c141570909952170bccf0bf1c15549e9443f8bdb68aba2`.
- Settings: `V26_STRASSEN=6`, `V26_STRASSEN_HUB=6`, and CPU/BLAS thread limits
  of 2. No source-code edits were made for this screen.

## Result

- 20 MLPs attempted; 13 failed during prediction.
- The wrapper printed aggregate adjusted score `0.6041560790725091`, but this
  is invalid and must not be used for comparison because failures were included
  as large penalties.
- A successful MLP reported adjusted score `6.114357457613759e-9`, raw MSE
  `2.289539757782677e-8`, and compute utilization `0.26705618178630175`.
- The first reported failure was an allocation error for a 375 MiB temporary
  array with shape `(10, 7, 343, 64, 64)`; later rows included worker stdout
  closures. This is consistent with memory pressure from the higher level, but
  does not by itself prove the failure mechanism for every affected row.

## Decision

Reject Strassen-6 for this evaluator environment. Do not promote or submit it.
Return to a previously zero-failure level and investigate any new compute/accuracy
trade-off with a small persistent screen before scaling. Preserve per-row failure
flags; never compare the aggregate from a run with failures.
