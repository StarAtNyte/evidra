# Evidra claim-contradiction repair — 2026-10-01

## Finding

The claim consistency heuristic treated any occurrence of a negation word as
flipping the whole sentence. That produced false contradiction edges for
qualifiers and disclaimers, and caused the ARC campaign to spend cycles on
resolving nonexistent conflicts.

Two persisted examples were reviewed against their actual claim text:

1. `claim_1790706509469_212_01_1` and
   `claim_1790714779840_229_01_3` report the same V29/control result. The latter
   adds that this is not a new locked comparison.
2. `claim_1789409781796_17_02_1` and
   `claim_1789410794149_21_01_2` report identical seed-0 commands and metrics.
   The latter adds that there are no evaluator fields.

Neither pair asserts opposing values for a common factual core.

## Repair

`compareClaims` now marks a contradiction only when opposite polarity applies
to the same normalized factual core. A negation in an additional clause no
longer reverses the sentence's main claim. This also recognizes direct
negations despite simple verb inflection (`reports` versus `does not report`).

`activeContradictionEdges` rechecks persisted contradiction edges against the
current claim text. Historical false positives remain in the append-only audit
trail but are excluded from active conflict counts and retrieval.

Regression tests cover direct negation, both observed qualifier patterns,
active-edge filtering, and claim retirement. Verification:

- `npm run check`: passed.
- `npm test`: 654 passed, 0 failed.
- Current Evidra evidence audit: 3,792 claims, 0 conflicted.
- Direct comparison of both persisted claim pairs: no contradiction relation.
- Active contradiction edges in the durable store: 0.

This repairs evidence triage; it does not establish a WhestBench score gain.
The separate V29 residual probe remains exploratory and source-parity is still
unresolved between its captured estimator SHA (`0eedf1…`) and the archived
estimator SHA (`86d9ca…`).
