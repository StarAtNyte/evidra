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

- Latest pushed state: `origin/master` at commit `515e3c0` (verify with `git log`).
- Generic auditable-subtask contracts are now persisted in the live CLI/TUI
  phase-gate path as `subtask.audit` events. Required criteria only pass from
  the domain verifier/auditor; executor prose is ignored as proof.
- A controller-owned decision auditor now records `research.decision.audit` and
  downgrades illegal or unaudited director decisions to inspection.
- A fresh read-only provider-backed semantic auditor now checks the decision
  against bounded evidence, grounds anchors, persists success/failure, and
  gates non-pass decisions before execution.
- The benchmark runner supports bounded alternate routes after same-route
  retries, with route and command provenance in each attempt. The change is
  covered by the benchmark runner test.
- Latest verified baseline: 379/379 tests passing, TypeScript check passing,
  and build passing. The worktree is clean; generated reports remain excluded
  from source changes.
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
- Codex usage now preserves input, output, cached-input, cache-write, and
  reasoning-output token counts through agent results, durable usage events,
  CLI/TUI summaries, and regression coverage.
- The Codex adapter now resolves the legacy `default` sentinel to the explicit
  Evidra Luna model at the provider boundary, so account-side defaults cannot
  silently change the configured route.

### Current empirical evidence

- On AIRS-Bench SICK, two matched local Codex runs using `gpt-5.6-luna`, medium
  effort, and ten minutes each scored `0.8065633918` and `0.7702812882` against
  the same official evaluator; the majority baseline was `0.5686913983`.
- The generic AIRS lifecycle also prepared and evaluated the task-disjoint
  SVAMP task with a valid majority baseline of `0.0733333333`.
- AIRS Codex workers remain on `workspace-write` with network disabled. A
  temporary full-access experiment was stopped after it demonstrated that
  unrelated host paths could be inspected; it is not an accepted design.
- AIRS workspace seeding is non-destructive. Lifecycle results expose
  `resumed`, `initialArtifactBytes`, and `finalArtifactBytes`, and a failed
  partial workspace is covered by a resume regression test.
- Embedded AIRS Codex receives a local `TASK.md` brief and workspace-relative
  `TASK.md`/`data`/`log` context; absolute benchmark task paths are not sent to
  the provider. The worker remains `workspace-write` with network disabled.
- The next evidence gate is a valid Codex SVAMP run or another task-disjoint
  task, followed by matched multi-task harness comparison. Do not call the
  current SICK improvement SOTA.
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
- Multi-lane Codex research uses the same bounded, primary-first heterogeneous
  model pool in the CLI and TUI. Alternatives are discovered from the
  authenticated provider, filtered by the requested reasoning capability, and
  assigned deterministically; Astra is excluded from automatic diversification
  under the current cost policy while remaining directly selectable.
- A retryable lane transport or timeout failure now selects the first untried
  route in that pool before repeating a route. Single-route configurations keep
  bounded same-route retries, while every route change remains visible in the
  activity stream and the failed observation remains durable evidence.
- The director synthesis turn receives the same pool and applies the same
  untried-route recovery, so a provider failure after lane collection cannot
  force the whole cycle to replay on the original model.
- The adversarial critic also receives the route pool and retries on an
  untried route before degrading to a revise-only review, keeping verification
  available during transient provider failures.
- Matched harness benchmark changes are now durable SQLite records containing
  the forecast contract, before/after component checksums, protocol fingerprint,
  measured comparison outcomes, and a conservative retain/revert/branch or
  unobserved decision for future harness evolution.
- Recent harness-change records are now fed back into both CLI and TUI research
  context as historical guidance, explicitly separated from current-task
  evidence so prior harness outcomes can guide the next intervention without
  becoming an unearned task result.
- The same history is included in one-shot `evidra research` decisions, closing
  the memory boundary for non-campaign research as well.
- Generated research/challenge/final reports now expose the bounded evolution
  decision history, changed components, protocol identity, and measured
  outcomes without requiring direct database inspection.
- The TUI now matches the CLI's bounded peer-review protocol: fast/YOLO
  campaigns can send a fresh lane set over contested findings before director
  synthesis, while safe mode remains a single-pass inspection path.
- TUI research rubrics now use the same source-quality, claim-coverage, and
  evidence-diversity signals as CLI campaigns, preventing interface-dependent
  evidence grading.
- Literature adaptations now require every cited durable source to contain
  extracted claims; a retrieved URL with no claim evidence cannot ground an
  executable adaptation.
- TUI trajectories now persist the synthesized cross-pollination board and its
  evidence/agreement metrics, so later replay and audits retain exactly what
  the director saw rather than only the raw lane reports.
- TUI Escape cancellation now covers the independent critic stage as well as
  lanes and director turns, terminating its provider process instead of merely
  updating the visual status.
- CLI trajectories now persist the synthesized cross-pollination board too,
  keeping replay and audit parity between autonomous and interactive research.
- Headless phase-goal initialization is now mode-scoped, so an existing
  research goal set cannot suppress challenge goals (or the reverse).
- Phase goals now carry a deterministic objective-set identity; separate
  campaigns in the same mode cannot inherit another campaign's active phase
  or completion evidence, while legacy unscoped goals remain readable.
- Phase-gate event and record counts are now bounded by the active goal-set
  creation boundary, preventing historical hypotheses, runs, or artifacts from
  satisfying a new campaign's phase criteria.
- TUI phase gates now read the complete durable phase-event families instead of
  the last 500 timeline events, so long campaigns cannot lose valid evidence
  merely because the UI history window rolled over.
- The safety benchmark now reports the effective SAFE/FAST/YOLO capability
  contract alongside command probes, making it explicit that YOLO enables
  isolated experiments but never autonomous external submission.
- Generated reports now display each phase goal's objective-set identity, making
  multi-objective project histories auditable without inspecting SQLite.
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
- Crash pressure is now reconciled against the latest committed trajectory,
  preventing historical recovery events from biasing every future cycle.
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
- Read-only Git inspection now also rejects branch-creation positional
  arguments, closing a mutation path that was not covered by flag checks.
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
  input, output, cached-input, cache-write, and reasoning-output totals while rejecting
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
- CLI and TUI now share one bounded, checksum-aware Codex trace-recovery helper;
  orphaned traces are registered once at startup and malformed artifacts cannot
  prevent either controller from opening.
- Trace bounding is enforced at the recorder append boundary for every event
  type, not only native activity, so long Codex turns cannot grow in-memory or
  persisted traces without limit.
- Bounded traces now reserve a final `traceTruncated` marker, making dropped
  tail evidence explicit to recovery and trajectory-quality evaluation instead
  of silently presenting an incomplete trace as complete.
- Trajectory validation now turns that marker into an explicit recoverable
  structural issue, preventing truncated Codex prefixes from being treated as
  complete evidence by routing or learning components.
- Completion claims now require at least one durable evidence claim; a Codex
  `met`/`stop` response with no persisted provenance is forced back to
  inspection rather than silently ending a campaign.
- Codex and local provider turns now persist bounded, redacted assistant
  messages alongside tool activity, improving replay and failure attribution
  without treating generated prose as workspace evidence.
- Persisted trace parsing and startup recovery now cap input bytes as well as
  event count, use bounded file-prefix reads, and record byte truncation
  explicitly to protect long campaigns from oversized or corrupt artifacts.
- The parser computes an UTF-8-safe bounded prefix without duplicating an
  oversized trace into a full temporary buffer, preserving the intended memory
  bound under corrupt-input conditions.
- Codex usage normalization now retains the SDK's cache-write token count,
  keeping long-session cost and prompt-cache diagnostics complete.
- Cache-write usage now flows through durable agent-usage events, aggregate
  summaries, CLI status, and TUI usage output instead of stopping at parsing.
- TUI-started research cycles now record the same provider usage events as the
  CLI for lanes, director, and critic, restoring cross-interface accounting
  parity.
- Ordinary TUI conversation turns now use the same durable usage callback, so
  `/usage` includes Codex and local chat consumption rather than only
  autonomous research calls.
- Research Codex routes now opt into the installed SDK's live web-search and
  network capabilities for lanes, director, and critic turns; ordinary chat
  remains unchanged, and retrieved material still enters Evidra only through
  its provenance/evidence gates.
- Codex provider turns and entitlement-reset waits now accept one interrupt
  signal, so cancellation remains effective after a usage-limit error instead
  of leaving a controller asleep until the retry delay ends.
- The reset-wait primitive is directly tested for immediate abort, normal
  completion, and already-aborted signals.
- Persisted-trace parser limits now fall back safely when callers provide
  non-finite event or byte bounds, preventing malformed recovery parameters
  from disabling the parser's safety ceiling.
- Research lane concurrency now accounts for configured local fallback routes
  before launch, preventing simultaneous Codex-exhaustion fallbacks from
  overloading a single Ollama service.
- Codex operations and user documentation now describe research-only native
  web search, durable source grounding, assistant trace capture, and complete
  cache-write usage telemetry.
- Codex streamed turns now require the SDK's `turn.completed` event in addition
  to a non-empty assistant message; a disconnected partial stream is rejected
  and remains eligible for recovery rather than becoming a valid decision.
- The Codex adapter now supports injected authentication/client dependencies
  for deterministic stream-contract tests, covering both completed and partial
  provider turns without requiring live credentials.
- The same stream-contract coverage verifies research web-search/network
  settings reach the SDK thread boundary rather than existing only in controller
  configuration.
- Codex research threads now pass both the SDK's `webSearchMode` and its
  compatibility `webSearchEnabled` flag. This keeps live web retrieval active
  across installed Codex CLI versions; ordinary conversation leaves both flags
  unset.
- Codex model discovery now handles an app-server process that exits before
  JSON-RPC requests are written, converting stdin transport failures into a
  bounded actionable error instead of an unhandled TUI exception.
- Newly created Codex threads are tagged `evidra-chat`, `evidra-research`, or
  `evidra-experiment` according to their controller route, preserving route
  identity in Codex session telemetry and recovery diagnostics.
- Codex MCP tool progress now recognizes nested SDK `error.message` failures
  as failed activity, preventing provider tool errors from being rendered or
  scored as successful completions.
- Codex model discovery flushes a final JSON-RPC response even when the
  app-server omits its trailing newline, avoiding a false timeout on valid
  model-list responses.
- Active Codex turns now use the same fallback eligibility policy as startup:
  `auto` and `fallback` can change route after classified quota/network
  failures, while `wait`, `stop`, and account-model configuration errors stay
  explicit and do not silently switch providers.
- Codex reset-delay parsing now understands `retry-after`, `try again in`, and
  `available in` provider hints in addition to `retry` and `reset`, while
  retaining the bounded 24-hour maximum.
- The director’s nested Codex response schema is now strict-compatible:
  hypothesis, source-adaptation, ablation-factor, and tool-argument objects
  declare closed properties; nullable tool fields are removed before controller
  validation. A real Codex run verified the previous HTTP 400 schema failure is
  gone.
- Codex capacity/overload responses are classified as usage-limit failures,
  enabling the configured wait or route-fallback policy instead of opaque
  campaign termination.
- Strict Codex director responses may encode local optional fields as `null`;
  the controller now removes those sentinels for optional hypothesis/source
  fields while preserving meaningful nullable fields, preventing valid provider
  decisions from being rejected after a completed turn.
- Sandbox launcher failures such as bwrap loopback/network-namespace errors
  are now classified as `sandbox` rather than `unknown`, with explicit repair
  or alternate-executor guidance for the next controller cycle.
- Read-only Codex turns now make one safe recovery attempt when the host cannot
  create its bwrap namespace: they start a fresh provider thread in a disposable
  isolated workspace with full-access provider sandboxing, preserving the real
  checkout and never applying the fallback to workspace-write engineers.
- Codex campaigns with multiple lanes now discover a bounded pool of authenticated
  models, keep the configured model as the primary route, assign alternatives
  deterministically to independent lanes, and exclude Astra from that automatic
  pool unless a future policy explicitly opts in.
- Codex research timeouts now receive one bounded alternate-route replan while
  campaign budget remains; a second timeout or budget exhaustion pauses the
  campaign with the failure trajectory preserved.

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
