# Real-world pilots — 2026-09-15

These pilots test Evidra on one real research task and one real computational
challenge. They are diagnostic runs, not a claim of superiority or an external
submission.

## Research pilot

- Task: investigate whether multi-agent cross-pollination and adaptive search
  improve reproducibility and transfer in autonomous scientific research.
- Route: Codex, `gpt-5.6-luna`, medium effort, two lanes, safe autonomy.
- State: isolated temporary state under `/tmp/evidra-real-research-workspace`.
- Evidence: 27 claims from two retrieved sources, with valid event-chain
  integrity. The critic rejected publication because the run produced no
  falsifiable hypothesis and no executable mechanism-discriminating check.
- Result: research capability demonstrated; research completion not
  demonstrated. The report correctly records `Publishable: no`.

## Challenge pilot

- Task: ARC White-Box Estimation Challenge 2026, pinned `v2-phase2` mini split.
- Baseline: `examples/02_mean_propagation.py` completed locally; final-layer
  MSE was `0.000300` at 100,000 samples.
- Candidate route: `examples/03_covariance_propagation.py` loaded the 6.3 GB
  dataset but exceeded the five-minute bounded run without emitting a metric.
- Second route: `examples/04_shipped_weights.py` was interrupted during dataset
  materialization and emitted no metric.
- External submission: none.
- Result: a real baseline and two real failure traces exist; no candidate win
  or cross-task transfer claim is justified.

## Harness changes prompted by the pilots

1. Provider context now defaults to 48,000 characters, while durable state
   remains unbounded and `EVIDRA_CONTEXT_MAX_CHARS` can raise the prompt limit.
2. Agent-turn timeouts reserve time for lanes, director, and critic together,
   preventing short campaigns from multiplying one timeout across stages.
3. A campaign that reaches its deadline before a new turn is marked completed,
   persisted, and reported as a durable checkpoint.

The next proving run should use a small, real research contract with an
executable verifier and a challenge evaluator configured with a cheap screen
before full dataset materialization. Transfer is still unproven until both
tasks produce independently verified outcomes under matched budgets.
