# Hot/cold estimator transfer note — 2026-10-10

## Source and transferable claims

Marius Binner's public Phase-1 write-up, *A Provably Near-Optimal
Spherical-Cubature Estimator for Mean Activations of Deep Random ReLU Networks
under a FLOP Budget*, describes a width-256/depth-32 cubature estimator. Its
hot/cold path uses a pilot to estimate each neuron's ReLU firing rate, propagates
high-fire columns densely, and handles rarely firing columns through an exact
sparse contraction once the observed degree is below a measured break-even
threshold. It also compensates for dropped columns rather than silently
discarding their mean contribution. The author reports the sparse path saves
about 14% of instrumented FLOPs while costing about 4.5% of FLOPs itself, on that
specific sampling-state estimator.

Source: [AIcrowd forum post and attached PDF](https://discourse.aicrowd.com/t/phase-1-skibidi-toilet-solution-writeup/18166).
The downloaded PDF and extracted text are retained under `.sota/tmp/` for
analysis. The forum reply reports a 6% multiplier reduction on a fresh 100-net
holdout with similar final MSE; that result is not a Phase-2 result.

## Transfer assessment for Evidra's current estimator

The current V29/V30 estimator propagates factorized cumulant sources and uses
dense batched matrix products; it does not carry a large population of sampled
activation rows. Therefore Binner's pilot-based column pruning is not a direct
port. Any proposed analogue must identify sparse structure in the actual
factorized source-leg products, preserve the cumulant update (or quantify its
approximation error), and include the cost of detecting sparsity and
compensating dropped contributions. A neuron having low marginal firing
probability alone is not sufficient evidence that its cross-neuron cumulant
contribution is negligible.

The useful next step is a FLOP-attribution and mechanism study, not an
implementation by analogy: identify whether post-ReLU/source-leg matrices are
actually sparse at any layer; compare density and exact sparse-kernel break-even
under the evaluator's operation accounting; then run a paired ablation against
the frozen incumbent with independent MLP IDs. Reject if sparse bookkeeping or
the lost cross-cumulant terms erase the savings or worsen the final MSE.

This direction is separate from the active Strassen-depth experiment. No
submission or candidate promotion follows from this literature result alone.
## Random orthogonal cubature transfer test — 2026-10-10

Tested the cheapest transferable piece of the published Kerdock/MUB cubature
family: one independently seeded orthonormal basis per MLP, both signs of each
of its 1,024 directions (2,048 antipodal points), and the exact Gaussian radial
factor `E[chi_1024] = 31.992188454829048`. The basis seed is derived from the
MLP's public seed; only weights and that seed generate predictions. Targets are
read after prediction solely for evaluation. This is a spherical 2-design, not
the full 5-design, and is not represented as equivalent to the published
method.

On untouched Mini IDs 80–99, against the paired local V29 prediction capture:

| Quantity | Result |
|---|---:|
| V29 mean per-MLP final-layer MSE | `2.25835e-8` |
| One-basis cubature mean per-MLP final-layer MSE | `2.02747e-5` |
| Mean within-MLP error correlation | `0.02747` |
| Oracle blend coefficient (fit on these diagnostic targets) | `1.1489e-4` |
| Oracle-blended MSE on these same diagnostic IDs | `2.25833e-8` |

The oracle coefficient improves by only `0.0012%` and is not deployable. This
low-strength rule is decisively rejected as either a standalone estimator or a
practical residual branch. The result does not falsify the full high-strength
MUB design or more structured point selection; it does show that merely adding
a cheap random orthogonal basis does not recover its high-degree accuracy.

Reproduction: `reports/research/probe_whest_random_orthogonal_cubature.py`.
Result: `.sota/runs/whest-random-orthogonal-cubature-80-99-20261010.json`.
Paired base capture SHA-256: `9457040358acfeda680b53e204c57270e94b153fd16879f64553bf95dd8e00d4`.
The candidate package evaluated by the base capture was the V30 cubic source
SHA-256 `89395749c6a1a3b1cc12ff230a770c85d0bdb26f2f68d85023dfab12bd27920315`.
