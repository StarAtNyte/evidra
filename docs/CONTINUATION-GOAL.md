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

- Latest pushed commit: `2a51aa2`.
- The benchmark runner supports bounded alternate routes after same-route
  retries, with route and command provenance in each attempt. The change is
  covered by the benchmark runner test.
- Latest verified baseline: 342/342 tests passing, TypeScript check passing,
  and build passing. The worktree has six intentionally untracked pilot reports
  under `reports/`; do not confuse those generated artifacts with source edits.
- Autonomous campaign defaults are four hours; explicit `90m`, `4h`, and `2d`
  budgets remain supported. Model stages can use up to thirty minutes when the
  remaining campaign budget permits, and provider reset recovery can wait up to
  24 hours while paused campaign time is excluded.
- The default Codex research-turn timeout and campaign-adaptive ceiling are now
  30 minutes; the remaining campaign budget remains the hard upper bound. Lane
  agreement scoring discounts findings backed only by the same artifact, so
  shared citations cannot masquerade as independent corroboration.
- Local provider requests now enforce the same configured turn timeout and clean
  up abort/signal handlers; a hanging Ollama endpoint cannot stall a campaign
  indefinitely.
- Ordinary Codex chat now resumes one provider thread for the lifetime of the
  terminal session, preserving native conversation context and steering. Each
  autonomous research turn remains isolated and receives only controller-owned,
  bounded context.
- Codex stream events are normalized into concise TUI progress updates for
  reasoning, searches, file changes, commands, and assistant output; raw
  protocol event IDs are never shown to the user.
- Live Codex progress is redacted before display, including inline and
  separate-argument credential forms.
- Codex steering and login-status probes are bounded to five seconds, so a
  broken Codex transport cannot freeze the TUI input loop.
- Codex nested `turn.failed.error.message` diagnostics are preserved, allowing
  the existing retry, usage-limit, and fallback classifiers to route failures
  correctly instead of receiving a generic error.
- Codex app-server model responses are normalized before reaching the TUI;
  object-form reasoning efforts are converted to unique string choices for
  reliable `/model` and thinking selection.
- Provider/model changes clear the active Codex thread, preventing stale
  conversation context from crossing routes or model selections.
- Codex provider switches and successful Codex login now explicitly select
  `gpt-5.6-luna` instead of inheriting a server-side default model; login also
  refreshes the available model list immediately for `/model` selection.
- Codex login runs asynchronously with an interruptible child process, so
  device/browser authentication cannot freeze the TUI; this is covered by an
  integration-style regression test.
- Codex item events now expose concise progress for MCP tools, todo plans,
  command completion, file changes, reasoning summaries, and item failures;
  the normalized adapter is covered by regression tests.
- Codex usage now preserves input, output, cached-input, and
  reasoning-output token counts through agent results, durable usage events,
  CLI/TUI summaries, and regression coverage.
- The Codex adapter now resolves the legacy `default` sentinel to the explicit
  Evidra Luna model at the provider boundary, so account-side defaults cannot
  silently change the configured route.
- TUI model discovery failures now distinguish unavailable Codex versus local
  routes and provide actionable recovery text instead of a misleading loading
  message or raw provider protocol output.
- Codex executable resolution is centralized across SDK turns, login, model
  discovery, and steering via `EVIDRA_CODEX_BIN`, with unsafe newline-bearing
  values rejected and regression coverage added.
- TUI thinking choices now derive from the active Codex model capabilities,
  and direct `/model <id>` selection rejects IDs absent from the discovered
  provider model list before execution.
- Codex authentication probes for model discovery and turn startup are now
  asynchronous, preventing an unavailable Codex installation from blocking
  the TUI event loop; the configured executable path is used and covered by a
  regression test.
- CLI and TUI doctor diagnostics now resolve and report the same configured
  Codex executable used by login, model discovery, steering, and SDK turns.
- Codex activity rendering now preserves failed command and file-change status
  instead of labeling failed provider items as successful completions.
- Codex command activity now includes an exit code only when the provider
  supplies one, keeping failure output concise; regression coverage remains
  green at 349/349.
- Codex-native activity is now persisted as bounded, secret-redacted `process`
  events in research trajectories. Commands, searches, file changes, plans,
  and reasoning milestones therefore remain auditable and available to later
  experience/replay logic after the interactive session closes.
- Native Codex command, file-change, and tool failures now feed deterministic
  trajectory error-recovery scoring, so provider-originated failures influence
  capability gaps and future routing instead of being treated as clean cycles.
- Native Codex failures are classified into the generic recovery vocabulary and
  included in the next cycle's allocation policy. Timeout, rate-limit, auth,
  dependency, and unknown failures now provide targeted route pressure.
- The CLI and TUI now pass the same typed failure pressure into capability
  routing, making verification demand and lane fan-out consistent across
  interfaces instead of dropping provider recovery evidence in the TUI path.
- Autonomous hypothesis scheduling now suppresses unchanged retries after a
  failed run. A retry must change executor, provider, model, or search operator;
  the failed attempt remains immutable evidence for recovery planning.
- Suppressed duplicate/unchanged scheduling now emits durable controller
  evidence containing the hypothesis, route, and reason, allowing the next
  director cycle to replan explicitly rather than silently stall.
- Autonomous campaigns now persist phase-level checkpoints for cycle start,
  lanes, director, critic, execution, and terminal/completion. Campaign state,
  scheduler state, and the controller lease share the checkpoint step for
  restart/status recovery.
- Checkpoint heartbeats are process-bound, and CLI/TUI status output exposes the
  saved cycle, phase, and timestamp, preventing stale controllers from
  overwriting live progress.
- Checkpoint metadata now has a validated phase/cycle/timestamp contract;
  malformed or legacy fields are treated as unavailable rather than trusted,
  while legacy campaigns remain resumable.
- Resume now derives the next cycle from the validated checkpoint: interrupted
  phases rerun the current cycle, and only `cycle-complete` advances it, avoiding
  skipped or duplicated autonomous cycles.
- TUI status now shares the CLI checkpoint validator, so malformed progress
  metadata is consistently reported as unavailable across interfaces.
- Resume now explicitly records and reports invalid saved checkpoint metadata
  before restarting from a safe cycle boundary, preserving operator visibility.
- The interactive TUI now persists the same research, execution, and
  cycle-complete checkpoints as the CLI, keeping Codex campaigns resumable from
  either interface.
- TUI checkpoint updates now mutate live campaign state before later writes, so
  pause, approval, budget, and completion transitions cannot erase resume
  metadata.
- CLI and TUI now share one validated checkpoint constructor, preventing their
  durable campaign metadata formats from drifting.
- The SQLite store now enables WAL plus a bounded five-second writer wait, and
  has a regression test covering concurrent lane-style event writers. This
  prevents transient database-lock contention from dropping parallel Codex
  observations.
- Campaigns now enforce the wall-clock budget at the cycle boundary before
  source ingestion, workspace inspection, baseline execution, or another
  Codex turn. An expired resumed campaign records a terminal budget checkpoint
  without starting new work.
- Terminal campaign checkpoints now set scheduler state to `idle` rather than
  incorrectly reporting a completed campaign as `running`.
- Outer Codex retry guards now use pause-aware campaign elapsed time. Provider
  entitlement reset waits no longer consume active research budget through a
  raw wall-clock comparison.
- The TUI provider-limit path now matches the CLI: `auto`/`wait` durably pause
  and resume at the retry time, while `fallback` and `stop` are honored rather
  than silently waiting.
- CLI provider-reset waits now poll controller directives in bounded slices;
  a stop request interrupts a long Codex entitlement wait and records a
  terminal scheduler state immediately.
- Autonomous CLI and TUI cycles now append bounded, redacted tool/provider
  activity to `.sota/traces/*.jsonl` as it happens, preserving partial Codex
  provenance when a controller crashes before its final trajectory commit.
- Controller startup now validates and checksums uncommitted trace files,
  records `research.trace.recovered` evidence, and avoids duplicating traces
  already linked to a committed trajectory.
- The TUI now performs the same partial-trace recovery as the CLI, preserving
  Codex provenance consistently when autonomous work is restarted from either
  interface.
- Recovered trace evidence now includes a bounded redacted activity tail and
  recent tool-name summary, so the next Codex decision can use crash context
  without loading an unbounded raw transcript.
- Recovered traces now feed `controller_crash` pressure into CLI/TUI allocation
  and capability routing, prioritizing controlled reproduction before new
  expensive exploration.
- The Codex director's provider output schema now caps each turn at eight tool
  calls, matching the local decision schema before any tool is executed.
- Director tool caching now distinguishes safe inspection from cacheability;
  `shell.exec` observations are never reused across rounds because fast/YOLO
  commands may see changing state.
- Research-tool shell execution is now read-only across safe/fast/YOLO, with
  bounded harmless interpreter probes retained for inspection. Workspace edits
  remain limited to the isolated experiment engineer path.
- Read-only shell guards now reject Git output/mutation/external-diff options
  and interpreter imports/indirection, covering common write and subprocess
  bypasses in autonomous Codex research tools.
- Codex sandbox resolution now prevents `EVIDRA_CODEX_SANDBOX` from elevating
  research lanes or critics above their explicit `read-only` request, while
  still allowing a tighter setting for permissive engineer routes.
- Autonomous memory context now uses hybrid FTS-plus-lexical retrieval for
  durable claims and hypotheses, so the existing SQLite index influences Codex
  research context instead of being used only by the interactive memory search.
- The autonomous CLI and TUI now apply that hybrid retrieval to deduplicated
  literature sources as well, keeping source context and durable memory on one
  retrieval path.
- Codex structured-output schemas now cover the research director, independent
  research lanes, and critic, so every research-role response is constrained
  before durable parsing and evidence gates.
- Normal Codex chat no longer performs a duplicate UI-level auth preflight;
  the provider boundary performs the single asynchronous check before the turn,
  reducing startup latency without allowing unauthenticated execution.
- Codex steering through `codex queue` is now asynchronous and timeout-bounded,
  preserving a responsive TUI while retaining durable queue fallback when
  native delivery fails.
- Ordinary-chat provider fallback now announces the route change and clears
  the Codex thread, preventing later Codex turns from resuming context that
  omitted the fallback response.
- Codex research-director turns now pass a structured-output schema through
  the SDK before Evidra's own Zod/evidence gates, reducing malformed decision
  responses while preserving controller authority.
- Codex agent usage aggregation is now shared by the CLI and TUI, preserving
  input, output, cached-input, and reasoning-output totals while rejecting
  malformed or negative counters.
- Codex thread restoration is explicit: a new terminal starts a fresh Evidra
  chat, while `/resume <session-id>` restores the saved Codex thread and
  transcript. Provider/model changes invalidate the active chat thread.
- Source discovery now persists provenance classes and conservative quality
  scores, backfills metadata for historical events, diversity-reranks providers,
  and rejects instruction-like retrieved sentences before durable claim
  extraction. These scores route evidence; retrieval and evaluator checks still
  determine whether claims are publishable.
- Generated reports now include source-frontier coverage, provenance-class
  counts, claim coverage, and mean routing quality. The lifecycle safety
  benchmark currently passes all 9/9 probes.
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
- Research lanes now return bounded discriminating tests; cross-pollination
  persists them and keeps adversarial review active when uncertainty has no
  concrete resolution test.
- Harness comparison now has a non-mutating `benchmark run --dry-run`
  preflight that prints the protocol fingerprint and resolved arms before any
  external harness is launched.

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
