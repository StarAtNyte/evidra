# WhestBench incumbent target-provenance audit — 2026-10-10

## Finding

The current public-score incumbent #335034 / V30 is a useful measured score
reference, but it is **not target-clean under this campaign's explicit rule**
that deployable estimators must not use target-derived signals. Do not describe
it as an integrity-cleared baseline, and do not reuse its fitted residual
coefficients in a target-clean candidate.

## Evidence

- `reports/research/whest-quadratic-residual-cap-screen-2026-10-03.md` says the
  frozen quadratic model was fit on Mini IDs 0–79, including residuals formed
  from reference `targets - predictions`; IDs 80–99 were used as a separate
  public-Mini diagnostic cohort. The report itself says this is not proof of
  hidden-set generalization and the candidate was not promoted.
- `.sota/research/whest-p2-cumulant-k3/harness/confirm_v29_residual.py` computes
  `y_train = targets - predictions` and fits ridge coefficients from that
  residual. The fit uses target labels, not just input weights.
- The retained V30 source identifies its quadratic terminal residual
  calibration as public-Mini fitted; its attribution file also says the
  contribution is an experimental modification whose independent/sealed-split
  performance is not assumed.
- The official-grade report records #335034's adjusted score
  `5.162197424910759e-9` and raw final-layer MSE `2.1092689479473848e-8`.
  Those remain useful as public-score facts, not as evidence of a target-clean
  method or private generalization.

## Decision and scope

Maintain two distinct records:

1. **Score reference:** #335034 / V30, with its public-Mini-fitted residual
   calibration clearly disclosed.
2. **Target-clean local research baseline:** V29, estimator SHA-256
   `86d9ca9b28e6fe2b6c74750a0b6ae4bba4c14f742ddc3f5f56bc7fb4ec9d8e27`,
   with `V26_STRASSEN=4`. The integrity report records 100/100 rows, zero
   failures, adjusted score `5.898624886930093e-9`, and raw MSE
   `2.228543495519375e-8`. Source and coefficient provenance were inspected:
   `V17_NO_CORR` defaults to `1`, disabling `CORR_BETA`, the separately
   calibrated online mean-correction rider. The shipped `LAM` fit relates internal
   propagated cumulant/covariance states; `REF_R` and `BETA` are derived from
   internal state ratios; static term coefficients are exact Wick/Hermite
   coefficients. These do not consume reference target values. Use this V29
   artifact as the target-clean paired local comparator.

This resolves the V30 residual provenance and identifies a separate
target-clean local comparator. It does not establish whether the competition's
formal rules permit fitting on public Mini targets. That rule question must be
answered from the current official rules or organizers. Regardless, this
campaign's stricter target-free deployment constraint excludes the V30-fitted
residual coefficients. No claim is made here that the organizer has ruled on
this specific method.

The data-integrity reports establish checksums and row identity for the public
Mini release, but neither checksum integrity nor a public leaderboard grade
clears candidate-level leakage. No submission or promotion is authorized by
this report.

## Sources

- `reports/research/whest-quadratic-residual-cap-screen-2026-10-03.md`
- `reports/research/whest-external-feedback-and-diagnostics-2026-10-09.md`
- `reports/research/whest-data-audit-repeat-2026-10-10.md`
- `.sota/research/whest-p2-cumulant-k3/harness/confirm_v29_residual.py`
- `.sota/candidates/whest-v30-cubic-residual-strassen8-20261009/ATTRIBUTION.md`
- `reports/research/whest-v29-artifact-integrity-2026-09-30.md`
- `.sota/research/whest-p2-cumulant-k3/estimators/estimator_v29.py`
- `.sota/research/whest-p2-cumulant-k3/docs/claims_evidence.md`
