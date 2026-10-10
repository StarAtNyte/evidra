# V30 K3 source-leg sparsity screen — 2026-10-10

## Decision

Reject the hot/cold sparse-contraction direction as a route to a large gain in
the current V30 estimator. The transported `A_st` and `P_st` K3 source legs are
effectively dense, so exact sparse kernels have no structure to exploit. This
does not test or justify dropping near-zero terms; any approximate threshold
would need a separate paired accuracy experiment and is not recommended from
this result.

## Locked diagnostic

- Candidate archive: `.sota/candidates/whest-v30-cubic-residual-strassen8-20261009/submission.tar.gz`
- Archive SHA-256: `b0748971e91a43fbcbce29ec6b2969177ff588d24e408e221d8cc9dd640d2832`
- Archived `estimator.py` SHA-256: `89395749c6a1b3cc12ff230a770c85d0bdb26f2f68d85023dfab12bd27920315`
- Public Mini data fingerprint: `264fa1f416d16a40821fb5e8e94f5d2da4698a201d40da999616225b38b464f1`
- MLP ID: `80`
- Diagnostic hook: records exact-zero fractions at each unchanged `_dslices`
  call, then invokes the original method with unchanged arguments.
- Result artifact: `.sota/runs/whest-v30-source-leg-density-80-20261010.json`

Across 30 `A_st`/`P_st` observations (15 calls, both legs), mean exact-zero
density was `3.3833e-8`; the maximum was `3.1789e-7`. Most observed stacks had
no exact zeros. Against a 1% structural-sparsity screen (a post-measurement
interpretation threshold, not preregistered), exact-zero density is lower by
more than six orders of magnitude.

## Interpretation and limits

This is a structural-zero screen on one pinned MLP, not a score comparison,
not a sparse-kernel benchmark, and not evidence that numerically small entries
can safely be discarded. It is sufficient to stop pursuing exact-zero sparse
contractions: the source tensors are dense after transport. Do not implement
hot/cold pruning based only on marginal firing probabilities; source terms
participate in cross-neuron contractions and their cumulative error is
unmeasured.

Reproduction: `OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=1 MKL_NUM_THREADS=1`
`competitions/whestbench/starterkit/.venv/bin/python`
`reports/research/probe_whest_source_leg_density.py`.
