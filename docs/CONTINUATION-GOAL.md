# Evidra continuation goal

This file is the handoff brief for continuing Evidra development from another
Codex account or terminal session.

## Objective

Make Evidra a state-of-the-art, general-purpose research and experimentation
harness. It must support empirical challenges, ML competitions, scientific
research, software/algorithm experiments, benchmark optimization, and
non-metric investigations. The harness should improve the probability of useful,
reproducible discoveries—not merely produce better prose or code completion.

## Non-negotiable design principles

- The controller owns durable state, permissions, execution, evaluation,
  provenance, recovery, budgets, and stopping decisions.
- Agents propose hypotheses, implementations, critiques, and research leads;
  narrative agreement is never treated as measured evidence.
- Every claim must distinguish workspace evidence, external literature, and
  assumptions. Literature-derived methods are leads until freshly tested.
- Research and challenge modes share the same general objective/evidence
  contract; neither may silently change the evaluator or goalposts.
- Metrics are generic: primary, secondary, multi-objective, latency, cost,
  safety, calibration, artifact, behavior, proof, and custom evaluator outcomes
  must be representable.
- Autonomous execution is bounded by permissions, provider/model usage, time,
  compute, concurrency, retries, isolation, and explicit stopping conditions.
- Failed routes remain immutable evidence. Transient failures may retry; after
  bounded retries the next route must materially change and be recorded.
- A harness win requires matched task/model/seed/effort/budget/evaluator
  evidence, task-balanced analysis, uncertainty, and independent replication or
  an explicitly appropriate proof gate.
- Preserve useful intermediate artifacts, logs, commands, checksums, and
  recovery history while bounding context and output size.

## Current implementation snapshot

The TypeScript CLI/TUI, durable SQLite/event state, Codex/local provider routes,
research/challenge campaigns, phase goals, tool loop, permissions, local/
container/Modal execution, recovery, literature/source graph, lane research,
critics, cross-pollination, adaptive search allocation, validation, reports,
submission boundaries, scientific task contracts, safety probes, and harness
scorecard are implemented in `src/`.

Benchmark support currently includes generic metric suites, secondary gates,
task-balanced paired comparisons, bootstrap lower bounds, Pareto diagnostics,
provider and held-out comparisons, component ablations/failure evidence,
reproducibility checks, adaptive retest agendas, AIRS-Bench discovery, and
scientific/autoresearch benchmark contracts.

AIRS-Bench discovery has been tested against the public checkout with 40 valid
task contracts and 0 invalid contracts. This is discovery/protocol evidence,
not an official leaderboard result: full external comparison still requires
declared runnable harness arms, measured baselines, matched budgets, and the
external evaluator.

## Latest repository state

- Latest pushed commit: `46f7e72`.
- The benchmark runner supports bounded alternate routes after same-route
  retries, with route and command provenance in each attempt. The change is
  covered by the benchmark runner test.
- Latest verified baseline: 314/314 tests passing, TypeScript check passing,
  build passing, and a clean worktree.
- Benchmark report command argv is now redacted alongside process output, with
  coverage for primary, alternate, and reproducibility routes.
- Baseline and scientific-task attempt evidence now applies the same command and
  output redaction boundary before persistence.
- Structured store payloads now recognize command-shaped argv arrays globally,
  preventing separate-argument credentials from leaking through event or run
  attempt persistence.
- External benchmark arms now pass through one schema-first parser before a run
  or retest replay; malformed protocols cannot reach workers.

## Immediate next work

1. Add/maintain real matched external benchmark adapters and run actual trials
   when runnable harness commands and credentials are available; never fabricate
   comparative scores.
2. Continue auditing all agent/controller boundaries for durable recovery,
   cancellation, provider exhaustion, isolation, secret redaction, and restart
   correctness.
3. Improve general objective handling and external evaluator adapters without
   introducing competition-specific assumptions into the core.
4. For every harness change, add a focused regression test, run `npm run check`,
   `npm test`, `npm run build`, inspect `git diff --check`, then commit and push.

## Useful commands

```bash
npm run check
npm test
npm run build
node dist/cli.js benchmark safety --json
node dist/cli.js benchmark airs discover <airs-bench-checkout> --family all
git status --short
```

When resuming, read this file plus `README.md`,
`docs/research/agent-harness-literature.md`, and the current git history before
making changes. Treat the current worktree and tests as authoritative; do not
assume that a documented feature is fully proven until its runtime path is
verified.
