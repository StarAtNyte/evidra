# V29 final-layer residual correction probe — 2026-10-01

## Status

Promising research result; **not yet implemented in the submission estimator,
not a full-Mini evaluator result, and not an AIcrowd grade**. The probe uses
the public `v2-phase2` Mini data only. No claim about the sealed leaderboard
split follows from these measurements.

## Hypothesis and method

V29's final-layer prediction error has a small, reusable component predictable
from the 13 final-layer statistics already computed by V29. A ridge model over
the raw features plus all upper-triangle pairwise products can estimate this
residual on one set of MLPs and generalize to unseen MLPs.

Capture applied no correction (`V17_NO_CORR=1`) and preserved the existing
V29 prediction. Features, prediction, and target were captured for each MLP.
Training IDs were fixed at 0–79. Locked confirmation IDs were fixed at 80–99.
All folds grouped by complete MLP; neurons from one MLP never crossed a fold.
Nested 5-fold grouped CV selected degree 2 and ridge alpha 10 in every outer
fold. The frozen model was fit on IDs 0–79 and evaluated once on IDs 80–99.

## Results

| Evaluation | V29 baseline mean MSE | Corrected mean MSE | Relative change | Improved MLPs |
| --- | ---: | ---: | ---: | ---: |
| Nested grouped CV, 80 MLPs | 2.22094e-8 | 2.20178e-8 | −0.863% pooled (−0.878% mean per-MLP) | 62/80 |
| Locked confirmation, 20 MLPs | 2.25835e-8 | 2.23300e-8 | −1.123% pooled (−1.102% mean per-MLP) | 18/20 |

Bootstrap 95% CI for mean per-MLP relative change: **CV −1.170% to −0.579%**;
confirmation **−1.426% to −0.746%**. These intervals describe only the public
Mini MLP samples and do not include evaluator, implementation, or hidden-split
uncertainty.

Overlapping IDs 40–79 were captured in two independent processes. Features,
predictions, and targets matched bit-for-bit. FlopScope's count differed for
ID 40 only (5.7305e11 versus 5.6833e11); the discrepancy occurred in the
capture whose first processed row was ID 40. Treat this as a counter
warm-up/accounting anomaly until reproduced or explained. It does not affect
the captured prediction arrays, but cost parity must be rechecked with the
official evaluator.

## Reproduction

Run from the repository root using the frozen WhestBench starter-kit venv.

```sh
EVIDRA_CAPTURE_FINAL_FEATURES=1 V17_NO_CORR=1 V26_STRASSEN=5 V26_STRASSEN_HUB=4 \
V29_CPRE_LEV=4 V28_STRASSEN_SB=5 V28_STRASSEN_FIRST=5 \
OPENBLAS_NUM_THREADS=2 OMP_NUM_THREADS=2 MKL_NUM_THREADS=2 \
competitions/whestbench/starterkit/.venv/bin/python \
  .sota/research/whest-p2-cumulant-k3/harness/capture_v29_features.py \
  --start-index 0 --end-index 80 \
  --output .sota/tmp/v29-final-features-train-0-79.npz

OPENBLAS_NUM_THREADS=2 OMP_NUM_THREADS=2 MKL_NUM_THREADS=2 \
competitions/whestbench/starterkit/.venv/bin/python \
  .sota/research/whest-p2-cumulant-k3/harness/validate_v29_residual.py \
  .sota/tmp/v29-final-features-train-0-79.npz \
  --output .sota/tmp/v29-final-residual-grouped-cv.json

EVIDRA_CAPTURE_FINAL_FEATURES=1 V17_NO_CORR=1 V26_STRASSEN=5 V26_STRASSEN_HUB=4 \
V29_CPRE_LEV=4 V28_STRASSEN_SB=5 V28_STRASSEN_FIRST=5 \
OPENBLAS_NUM_THREADS=2 OMP_NUM_THREADS=2 MKL_NUM_THREADS=2 \
competitions/whestbench/starterkit/.venv/bin/python \
  .sota/research/whest-p2-cumulant-k3/harness/capture_v29_features.py \
  --start-index 80 --end-index 100 \
  --output .sota/tmp/v29-final-features-confirm-80-99.npz

competitions/whestbench/starterkit/.venv/bin/python \
  .sota/research/whest-p2-cumulant-k3/harness/confirm_v29_residual.py \
  .sota/tmp/v29-final-features-train-0-79.npz \
  .sota/tmp/v29-final-features-confirm-80-99.npz \
  --output .sota/tmp/v29-final-residual-confirm-80-99.json
```

## Integrity pins

- Base estimator source path: `.sota/research/whest-p2-cumulant-k3/estimators/estimator_v29.py`
- Base V29 source SHA-256: `0eedf1ac107db931c855d693e2556c088e396744517ccd00287e6178099be5ce`
- Frozen confirmation-fit model path: `.sota/tmp/v29-final-residual-confirm-80-99.model.npz`
- Frozen model SHA-256: `309081cc51810e9ac763de4f7923dc0cce85b643dce44dd50eb6e7bf4948c56f` (3,780 bytes; 104 standardized degree-2 features)
- These are pinned implementation inputs, not a generated candidate/control pair. After porting the correction in an isolated worktree, record the candidate and uncorrected-control hashes before any evaluator run; then lock identical evaluator/input settings and score rows 0–99, analyzing IDs 80–99 as the untouched confirmation set.
- V29 chunk-6 wrapper SHA-256: `fb6d749b1a3a0da951735a43b0bdb871333add42b5745884fdee43f9e0bd807f`
- Capture script SHA-256: `277d297f6382620ed025714911a17569fcba127411bca610ed43ff7e00838713`
- Grouped-CV script SHA-256: `abe86e08d19aaa821a67d50b45a40eccce59d4ff353d91b6dcfd01ec7fc516e8`
- Confirmation script SHA-256: `6c6223bdf47f4cb6895b6101f9d20f4ebaff5238dd8a32ad0b21365bacb5597a`
- Train capture SHA-256: `6235d4e940916d75c7cb66c140968389d5e3d2fe8f0536199c735293b99d46d0`
- Confirmation capture SHA-256: `9457040358acfeda680b53e204c57270e94b153fd16879f64553bf95dd8e00d4`
- Grouped-CV result SHA-256: `d22a4e00afcd91b6d9598221821db13079a79f95b28eb73ded05c94b418978a8`
- Confirmation result SHA-256: `f74c73a7e209085f97a2b0623519582f7d516fe185f50e4acd0b1fb1badb0972`

**Important source-identity caveat:** this probe used the local research source
hash `0eedf1ac107db931c855d693e2556c088e396744517ccd00287e6178099be5ce`.
The separate historical archive-integrity report records an estimator member
hash of `86d9ca9b28e6fe2b6c74750a0b6ae4bba4c14f742ddc3f5f56bc7fb4ec9d8e27`.
These are not byte-identical. The non-capture behavioral equivalence and exact
run provenance have not yet been established; therefore the reported CV and
confirmation gains are preliminary evidence for this local source variant,
not yet evidence for the historical AIcrowd V29 archive.

Input identity is tracked in `whest-candidate-input-lock-2026-09-30.md`
(dataset revision `v2-phase2`, Mini IDs 0–99). The installed Evidra global
CLI did not expose campaign budget extension; the workspace `dist/cli.js`
was used to extend/resume the durable Evidra campaign, and the manual probe
is being submitted to that campaign for evidence registration and review.
Evidra tool event `108145` subsequently recorded a fresh successful checksum
pass (exit code 0, 4.252 s); its complete output matches the metadata and all
seven shard pins in the lock. This closes the current local input-lock check;
do not repeat the full-shard hash pass unless an input changes.

An additional current-state check with the frozen starter-kit environment
reported WhestBench `0.16.1`, FlopScope `0.12.1`, NumPy `2.2.6`, PyArrow
`24.0.0`; seven Mini shards; 100 rows; IDs exactly 0–99; and 100 unique IDs
and seeds (exit code 0). Together with event `108145` and the complete lock,
this verifies the current local dataset/runtime contract for a public-Mini
screen. It does not resolve the separate estimator source-identity caveat.

## Next gates

1. Register this hypothesis, configuration, both reports, and artifacts in
   Evidra's durable graph; preserve the source and metric separation.
2. Port the frozen correction into an isolated candidate without changing
   other V29 behavior; add unit and parity tests.
3. Run the canonical 100-row public Mini evaluator with zero failures and
   verify final MSE, adjusted-score formula, FLOPs, and runtime against the
   incumbent. Reject if the adjusted score does not improve with safe margin.
4. Only then consider a submission; compare its actual external grade with
   submission 332337 (5.418168137938331e-9).
