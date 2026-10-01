# WhestBench algorithm proposal: influence-conditioned moment closure

Date: 2026-10-01  
Status: proposed research direction; no score claim and no candidate implementation yet.

## Why a new family is needed

V29's K3 plus regenerated-K4 family is an unusually strong baseline, but its
own ablation record places it on an accuracy plateau. More rank, precision,
Strassen tuning, or a generic residual regressor is unlikely to create a
5–6x reduction in adjusted score. The next algorithm should target the
structure of the *remaining error*, not optimize the already-strong transport
kernel.

Phase-1 community analysis reports that a six-dimensional, weights-computable
Lyapunov subspace captured 68% of a final estimator error, and separately
reports contracting forward angular dynamics with a weight-computable
periodic attractor. These are leads from 256-wide, 32-layer networks, not
evidence that either transfers to Phase 2's 1024-wide, 16-layer networks.
The distinction is central: subspace capture is an oracle diagnostic; a usable
estimator must predict the *signed correction* using only the current MLP's
weights.

### Phase-2 falsification: the raw angular attractor is not the correction

Before proposing a more elaborate method, we tested the simplest forward-side
transfer: iterate the 16-layer ReLU map as a periodic angular dynamical system,
starting from the normalized all-ones vector, and use its converged final
direction as a proxy for the V29 residual direction. The attractor was computed
from weights only. The evaluator target was read only after the direction was
fixed, to score alignment on the untouched public Mini IDs 80–99.

Across those 20 MLPs, the final-cycle cosine averaged `0.9967`, so the periodic
orbit was numerically stable under this initialization. But its cosine with
the V29 residual averaged only `0.0313` in absolute value (median `0.0234`),
and the one-dimensional oracle residual energy fraction averaged `0.001665`
(0.1665%; median 0.0551%). This is too small to justify a correction branch;
the high cosine to the target mean (mean 0.3286) is not informative because
target means are positive vectors. This falsifies only the *raw attractor
direction* as a Phase-2 residual estimator. It does not falsify a richer
Lyapunov/tangent Gramian basis or the conditional-integration proposal below.

Reproduction script: `reports/research/probe_whest_angular_attractor.py`.
Command and baseline capture:

```sh
OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=1 \
  competitions/whestbench/starterkit/.venv/bin/python \
  reports/research/probe_whest_angular_attractor.py \
  --parquet-dir competitions/whestbench/starterkit/.whest-data/data \
  --capture .sota/tmp/v29-final-features-confirm-80-99.npz \
  --cycles 8 --start 80 --end 100
```

The paired baseline capture SHA-256 is
`9457040358acfeda680b53e204c57270e94b153fd16879f64553bf95dd8e00d4`.
This remains a local public-Mini diagnostic, not an Evidra-promoted aggregate
or an AIcrowd grade.

## Proposed method: Influence-Conditioned Moment Closure (ICMC)

The key idea is to replace a global, uniform cumulant budget with a small
weight-derived set of directions where uncertainty most affects the final
activation means. Integrate those directions more accurately; analytically
average the orthogonal bulk with the existing moment chain.

For a network with Gaussian input `x`, split `x = U z + V e`, where `U` is a
small orthonormal influence basis and `V` spans its orthogonal complement.
Conditioned on `z`, first-layer preactivations remain Gaussian with a shifted
mean and a covariance induced by `V e`. Propagate conditional moments through
the ReLU layers, then integrate over `z` with a small deterministic cubature
rule. The basis must be computed from weights and the current analytic state,
never from evaluator targets.

### Constructing the basis without target leakage

At each layer, form a smoothed gate derivative from the current preactivation
mean and variance, `D_l = diag(P(a_l > 0))`. Approximate the network tangent
map from input to layer `l` by `J_l = D_l W_l^T ... D_1 W_1^T`, using matrix-free
products. Define a positive-semidefinite influence operator over input space

`G = sum_l omega_l J_l^T diag(q_l) J_l`,

where `q_l` weights each neuron's contribution to propagated final-mean
uncertainty. Estimate its leading `k` eigenvectors with a deterministic
block-Krylov/Lanczos iteration (`k` initially 2, 4, 6, 8). This is a proposed
surrogate for the reported Lyapunov directions, not an assertion that it
reconstructs them. A second candidate basis comes from the contracting
angular map `s -> normalize((W_l^T s)_+)`, initialized from the analytic mean
direction and iterated to its periodic orbit. Compare both bases before
combining them.

### Conditional propagation and score-aware cost

For each cubature node `z_i`, initialize conditional first-layer means and
covariances exactly under the Gaussian decomposition. Then run a *reduced*
moment propagation: keep exact mean/variance and selected low-rank cross-moment
terms aligned with `U`; use the V29 closure only for the orthogonal bulk.
Integrate node predictions with fixed, symmetric, positive-weight rules. The
rule is deterministic and weights-only; no target-derived node selection or
coefficient fitting is permitted in the submission.

The challenge's adjusted metric is raw MSE times `max(0.1, FLOPs / budget)`.
Therefore every ICMC branch must be priced end-to-end: cubature nodes,
conditional propagation, basis construction, and memory. Allocate a strict
fraction of the existing V29 budget to the correction and retain a fallback
that always emits the valid V29 estimate before the evaluator deadline. The
first implementation should target less than 5% added FLOPs and a conservative
residual-time margin; if that cannot yield accuracy, stop rather than consume
the submission's reliability margin.

## Why this could help (and what could kill it)

Conditioning can turn a difficult high-dimensional expectation into a smooth,
low-dimensional integral if the network's finite-width error is concentrated
along a few influential directions. Unlike fitting a residual from other
networks, ICMC uses the current network's own weights to choose where to
integrate. Unlike plain MC, it preserves the analytic estimator for the large
orthogonal complement. This is the potentially novel combination: a
weights-only influence geometry plus conditional analytic marginalization.

It may fail for at least four reasons: Phase-1's six-dimensional phenomenon
may not transfer; the proposed tangent Gramian may not align with the actual
error subspace; conditional closure may reintroduce errors as large as those
removed; or the per-node analytic work may cost more than the correction is
worth under the score formula. Each is directly measurable.

## Preregistered experiment sequence

1. **Oracle transfer check, no code path changes.** On public Phase-2 Mini
   MLPs, capture paired V29 predictions and targets. Build candidate bases
   using only weights. After bases are frozen, use targets solely to measure
   (a) the best rank-k projection of the V29 residual (oracle upper bound),
   (b) projection energy captured by each weights-only basis, and (c) stability
   over independent MLP groups. Keep train/diagnostic/lockbox IDs disjoint.
2. **Basis-only deployability check.** Test whether weight-only invariants
   (eigenvalues, layer overlap, periodic-orbit convergence, and basis
   alignment) predict the *direction and signed coefficient* of the useful
   residual out of network. Group all folds by MLP; no neuron-level split.
3. **Tiny conditional prototype.** Only if steps 1–2 pass, implement `k=2`
   and a small symmetric cubature rule in an isolated source copy. Compare
   against paired V29 on a predeclared set of 8 MLPs, exact same evaluator,
   budgets, seeds, BLAS limits, and persistent-worker policy.
4. **Locked confirmation.** Freeze code and coefficients before evaluating
   untouched MLP IDs. Run the official 100-Mini evaluator, require zero
   failures, and report paired raw/adjusted deltas, confidence intervals,
   FLOPs, residual time, memory, and source/data hashes. A local win is not an
   AIcrowd result; only a submitted external grade can establish leaderboard
   improvement.

### Stop/go thresholds

- Stop if the Phase-2 oracle projection captures less than 25% of residual
  energy at `k <= 8`; this would falsify the premise behind the chosen low-rank
  route for this baseline.
- Stop if the weights-only basis captures less than 25% of that oracle
  projection's energy or signed correction does not transfer across MLPs.
- Continue to implementation only if an 8-MLP paired screen improves raw MSE
  by at least 10% with less than 5% additional FLOPs and no reliability
  failures. This is a research gate, not a promise of leaderboard gain.
- Do not call a result “5–6x” unless the adjusted score itself improves by
  that factor against an exactly identified, valid incumbent on a paired
  held-out evaluation, then is confirmed by AIcrowd.

## Harness execution note

The last autonomous experiment did not test an estimator: its isolated
worktree ran system Python 3.13 and failed with `No module named whestbench`.
The current reduced screen also defaults to the first four rows of the full
Mini dataset rather than an experiment-specific locked subset. Until both are
fixed, candidate scores from that route must be rejected. Direct local
diagnostics using the starter-kit `.venv` are useful for research but are not
Evidra-run evidence unless the campaign records their commands, inputs,
artifacts, and hashes.

## References

- ARC community technique census, including the Phase-1 O10 subspace question
  and angular-attractor observation:
  https://discourse.aicrowd.com/t/a-technique-census-of-phase-1-what-the-mathematics-is-doing-what-walls-it-hit-and-whats-still-open/18157
- V29 K3/K4 method and measured dead ends:
  https://discourse.aicrowd.com/t/everything-we-tried-a-factorized-k-3-cumulant-propagation-estimator-at-0-25-x-b-where-its-flops-go-and-25-measured-dead-ends-team-504aldo-rank-10/18218
- Phase-2 public data/runtime contract:
  https://huggingface.co/datasets/aicrowd/arc-whestbench-public-2026/blob/v2-phase2/README.md
