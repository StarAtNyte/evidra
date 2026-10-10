# Independent D8b residual correction — interim look only (2026-10-10)

## Status

This is an early look at the first 16 networks of a predeclared 64-network
capture. It is **not** the final screen, not a fresh holdout, not a Mini score,
and not a submission result. Do not tune the model or promote a candidate from
this interim read. The remaining capture must complete before the registered
64-network grouped-CV decision is made.

## Frozen comparison

The test asks whether LightGBM can predict per-neuron residuals from 13
deployment-time features emitted by the pinned V30 estimator on independent
D8b networks. Folds are grouped by complete network. The script and parameters
were fixed before reading this interim result: four folds, 160 trees,
learning-rate 0.035, 15 leaves, max depth 6, minimum child samples 384,
L2 regularization 8, seed 20261012. No public Mini labels are used for fitting.

The complete 64-network feature/target capture is still being produced at
`.sota/runs/whest-v30-learned-cv64-capture-20261010.npz` with atomic per-network
checkpoints. The first 16 preselected corpus IDs were:

`1520, 850, 1616, 560, 1922, 707, 913, 1826, 706, 195, 1888, 1043, 482, 1299, 289, 1218`.

## Interim result

| Measure | Result |
|---|---:|
| V30 baseline mean per-network final MSE | `2.1208974732117476e-8` |
| Residual-corrected mean per-network final MSE | `2.1324785138005736e-8` |
| Mean relative MSE reduction | `−0.5542%` |
| Networks improved | `7/16` |
| Network bootstrap 95% interval for reduction | `[−1.3253%, +0.2289%]` |

The early point estimate is negative and the interval spans zero. This weakens
the hypothesis but does not replace the predeclared full-64 result. The
interim file is `.sota/runs/whest-v30-learned-cv64-interim16-20261010.json`
(SHA-256 `b8ab1c4a7cacbaaf5750266d76bd79c961ad6ff5b03314d6f9e7d3a17686a3f5`);
the evaluator is
`reports/research/evaluate_whest_v30_feature_lightgbm.py` (SHA-256
`161d64f239e62251a7a34af11f61ed3573562ce89da4bb7762640e3dfd332e9e`).

## Gate

Finish all 64 manifest-verified networks, run the same frozen four-fold
network-grouped evaluation once, and preserve the exact full result. Reject if
there is no positive mean improvement, the network-level uncertainty remains
large, or any capture row fails. Even a positive result only earns a fresh
independent validation; it does not authorize a submission by itself.
