# Whest V29 source inspection

Date: 2026-09-27 UTC. This is a source/configuration note, not a new score or
evaluator result.

## Inspected artifact

- Durable candidate: `rep_1790352854695_hyp_1790333395111_33_01_eval`.
- Source: `.sota/worktrees/rep_1790352854695_hyp_1790333395111_33_01_eval/competitions/whestbench/starterkit/estimator.py`.
- SHA-256: `f000addc80c8eb57a9c141570909952170bccf0bf1c15549e9443f8bdb68aba2`.
- Registered completed run: 100 MLPs, zero evaluator failures, raw MSE
  `2.228323971564805e-8`, adjusted score `7.463742748512812e-9`.
- The recorded run environment sets `V26_STRASSEN=1`; the source's fallback
  default is 5. Do not treat the run as a comparison of those two settings.

## What the code actually does

This is a deterministic K3-simple factored cumulant-propagation estimator, not
the starter mean-propagation estimator. Its documented components include a
regenerated kappa-4 channel, transported covariance and cumulant state,
per-layer online lambda scaling (`V25_BETA`), and pooled/batched Strassen-Winograd
products. V29 carries a newborn correction and post-ReLU covariance through the
transport family, assembles the pre-activation covariance in block form, and
uses a specialized final-layer path that emits only means.

Relevant configuration includes `V26_STRASSEN`, `V26_STRASSEN_HUB`,
`V26_STRASSEN_NEW`, `V29_CPRE_LEV`, `V26_STRASSEN_MIN`, and `V25_BETA`. These
variables affect different algorithmic or numerical paths; changing several
at once would not identify a cause. The level-6 screen is separately documented
as invalid due to 13/20 allocation/worker failures and must not be repeated or
used as a score.

## Research implications and limits

1. The V29 run is a reference, not an improvement over the verified `332302`
   external score; its local 100-MLP score is worse than that bundle's recorded
   score.
2. A useful next test must name one parameter and state why it should change
   prediction accuracy (not just runtime), pin the exact source hash, data IDs,
   and evaluator, and report per-MLP predictions/metrics plus failures.
3. Fit or select any data-dependent coefficient using a declared calibration
   subset and evaluate the choice on disjoint MLP IDs. Public mini results are
   development evidence only.
4. An invalid or failed run is a rejection, not a score. A candidate still
   needs matched replication and the full persistent 100-MLP gate before it can
   be promoted or submitted.

The implementation comments describe prior exploration but are not independent
verification of those claims. Recheck any parameter behavior against the source
and evaluator before relying on it.
