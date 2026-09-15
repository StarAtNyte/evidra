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

- Latest pushed commit: `8dc6dea`.
- The benchmark runner supports bounded alternate routes after same-route
  retries, with route and command provenance in each attempt. The change is
  covered by the benchmark runner test.
- Latest verified baseline: 326/326 tests passing, TypeScript check passing,
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
- The arm parser also enforces cross-field normalization ordering, unique metric
  gates, and non-blank command parts before execution.
- A provider-neutral HTTP submission/score adapter supports multipart uploads,
  `{submission}` score URLs, environment-referenced bearer credentials, HTTPS
  enforcement, bounded responses, and redacted durable receipts.
- Benchmark worker spawn failures now become structured attempts and can recover
  through declared alternate routes instead of aborting the whole protocol.
- HTTP score polling retries bounded transient reads, while HTTP submission POST
  requests remain single-attempt to prevent duplicate external actions.
- HTTP response bodies are now read through a bounded 32 KiB stream before
  parsing, with oversized-response coverage.
- Direct harness comparisons now include reasoning effort in pairing identity
  and fair-pair checks, preventing high/medium-effort routes from being treated
  as matched evidence.
- Held-out protocol parity also checks reasoning effort, and literature
  benchmark input rejects duplicate task observations instead of silently
  overwriting them.
- Built-in AUROC now uses average ranks for tied scores, avoiding input-order
  bias in the generic metric layer.
- Paired bootstrap and permutation statistics now reject non-finite metric
  values and invalid sample counts instead of emitting misleading evidence.
- Direct fair-pair comparisons require complete task, arm, seed, model, and
  budget metadata, even when callers bypass the external trial parser.
- Benchmark arms and trials can carry an evaluator fingerprint; protocol
  fingerprints, direct pairing, and held-out parity now reject evaluator drift.
- The Kaggle adapter now performs a read-only access/authentication preflight
  before approved upload and defaults score polling to `competitions submissions
  --csv`, including public-score parsing.
- Binary log-loss, AUROC, and average-precision evaluators now reject
  non-binary target labels rather than silently coercing malformed outputs.
- The local safety benchmark currently passes all 9/9 lifecycle probes.
- Kaggle score polling now uses a bounded quote-aware CSV parser, so commas in
  descriptions or other quoted fields cannot shift the public-score column.
- Submission polling resolves the provider submission ID from the persisted
  receipt, with a bundle-ID fallback for legacy records.
- Added `src/core/replay-simulator.ts`, a validated offline replay-world
  primitive inspired by Dream-RSI: alternate branch order, bounded stopping,
  and batching can be scored from recorded outcomes without executing workers.
- Documented the Dream-RSI and Discovery Foundation Models design translation in
  `docs/research/literature-synthesis-2026-09.md`; replay results remain leads
  until a fresh online rollout and held-out validation.
- Replay outcomes support explicit evaluator utility for non-metric research
  goals (artifact, proof, behavior, system, or other), while retaining legacy
  metric scores; the simulator never invents a scalar outcome.
- Replay worlds now preserve maximize/minimize direction for legacy metrics and
  normalize it to higher-is-better utility internally.
- The autonomous controller now ranks bounded breadth/depth/low-cost policies
  over durable experience trajectories and injects the ranking as advisory
  allocation context; replay never replaces fresh evaluator evidence.
- Experiment trajectories now retain normalized primary evaluator utility and
  measured duration for replay diagnostics; non-metric research still requires
  an explicit evaluator-provided utility.
- Replay nodes now preserve optional normalized multi-objective vectors and
  report Pareto-front coverage without inventing a weighted scalar.
- Replay expansion now removes terminal leaves from the frontier, preserving
  access to unexplored sibling branches during bounded policy simulation.
- Transferable methods now use domain-neutral `sourceContext` provenance;
  legacy `sourceCompetition` records remain readable, so research methods are
  not forced through a competition-shaped memory schema.
- Transferable methods/playbooks now preserve explicit source assumptions,
  failure signals, and a fresh transfer-test procedure; retrieval remains a
  hypothesis lead rather than evidence of universal applicability.
- Transfer-memory retrieval now scores objective, task-family, and provenance
  context fit and exposes matched/missing signals; low-fit methods remain
  visible as weak leads instead of being auto-applied.

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
