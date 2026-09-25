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
reproducibility checks, task-balanced pass@k diagnostics for stochastic trials,
adaptive retest agendas, AIRS-Bench discovery, and scientific/autoresearch
benchmark contracts.

AIRS-Bench discovery has been tested against the public checkout with 40 valid
task contracts and 0 invalid contracts. This is discovery/protocol evidence,
not an official leaderboard result: full external comparison still requires
declared runnable harness arms, measured baselines, matched budgets, and the
external evaluator.

## Latest repository state

- The Paperclip-inspired campaign organization projection is now durable and shared across the dashboard, CLI, and TUI. `evidra organization --json` and `/organization` expose the mission, active campaign phases, reporting lines, queue ownership, specialist directives, and bounded accountability signals. The projection respects deterministic campaign/mode goal-set identity: foreign phases are not presented as current work, and live work is separately classified as ownerless, unscoped, mis-scoped, or unbudgeted. Mis-scoped work is critical operator attention; ordinary missing ownership or task budgets remain warnings so intentionally scheduler-owned work is not blocked.
- Custom/external roles now have an explicit admission boundary. Built-in roles are approved by their durable contract; dynamic roles appear as `review` and cannot start an external running heartbeat until an operator approves them with `evidra agents approve <role>` or `/agents approve <role>`. Revocation is durable and auditable via `evidra agents revoke <role>`.
- Queue bridges enforce the same boundary: `/tasks/claim` requires a fresh accepted heartbeat for an admitted role, so a worker token alone cannot silently acquire research tickets.
- Pending custom roles now enter the unified approval inbox as `agent-role` items, making the hire/admit decision visible alongside experiment, submission, and recovery gates.
- Autonomous cycles now close the role-training loop: `needs-review` findings become idempotent coaching directives, the applied directive IDs are recorded with the review, and delivery still occurs through the existing safe-boundary handoff lifecycle.
- The approval inbox can execute that role transition directly through `approvals approve agent-role <role>` or `/approvals approve agent-role <role>`; unsupported item kinds remain behind their dedicated gates.
- Role admission now distinguishes `review`, `approved`, and explicit `rejected` states. Rejection is durable, blocks execution, and removes the role from pending approvals until an operator deliberately reopens it.
- Role admission is included in portable bundle control metadata, so moving or backing up a project cannot silently turn an approved external role back into an untracked execution path.
- Portable control metadata also preserves explicit `rejected` versus pending `review`, preventing a declined role from resurfacing as a new hire request after transfer.
- Specialist handoffs now have crash-safe lifecycle recovery: an acknowledged directive is not treated as completed, stale acknowledgements are tied to recipient heartbeat health, `/agents recover` resolves them with an auditable failed outcome, and the autonomous CLI/TUI/lane allocation boundary performs the same bounded recovery before new work is allocated. Retrying requires a changed route and preserves the original failure reason.
- Event-server bearer authentication now supports permission-checked file-backed secrets, uses constant-time comparison, and bounds headers, request bodies, request duration, and keep-alive sockets so external integrations cannot stall the controller indefinitely.
- Local queue workers now treat a rejected claim heartbeat as a fencing event: they abort through the handler signal immediately and persist `queue.lease_lost`, preventing stale workers from continuing after ownership changes.
- Lease-loss events now feed the shared operator-attention projection, so CLI, TUI, and dashboard operators see the ownership failure and its queue-history action without inspecting raw events.
- Queue polling now has a supervisor rejection boundary: transient store/control errors become durable `queue.worker.error` records and shared operator attention instead of unhandled process failures, while subsequent polls can recover.
- Queue execution now refills concurrency at each lane completion rather than waiting for the slowest active lane, improving heterogeneous research throughput without removing the global concurrency bound.
- Queue workers now serialize supervisor drains while active work is running, preventing overlapping stale-recovery scans and making claim/progress accounting deterministic.
- Queue tickets now expose a provider-neutral progress projection—lifecycle state, last activity, idle time, heartbeat age, and stalled detection—shared by CLI JSON, TUI, and dashboard views.
- The attention projection now consumes that progress state, surfacing blocked tasks and stale queue heartbeats as actionable operator alerts instead of treating every running ticket as healthy.
- Queue handlers can now report bounded structured progress (`percent`, `step`, `completed`, `total`) and checkpoints through an optional typed context; legacy two-argument handlers remain compatible and the latest progress survives terminalization.
- The durable store validates the same progress schema for authenticated remote `/tasks/activity` calls, keeping local, Modal, Slurm, and other worker routes interoperable.
- Remote claim, heartbeat, checkpoint, activity, usage, release, and completion responses now include the durable progress snapshot, giving external workers an immediate restart/reconciliation path after every control-plane mutation.
- External worker heartbeats can now declare an optional capacity of 1–64 concurrent tasks. Claim checkout enforces that capacity inside the same SQLite transaction, rejects claim-side escalation, preserves the declaration across heartbeats that omit it, and CLI/dashboard health surfaces active and available slots; workers without a declaration remain backward-compatible and unlimited.
- Queue collaboration is now CLI/TUI-parity: operators can add scoped handoff notes with `evidra queue note` or `/queue note`; notes remain activity/audit context and cannot satisfy evidence or completion contracts.
- The event control plane now exposes bearer-authenticated `POST /tasks/note` for the same operator note action, while deliberately rejecting worker-only authentication so notes cannot be confused with worker authority.
- Remote operator notes accept bounded idempotency keys, acknowledge identical retries without appending duplicate activity, and reject conflicting reuse with a `409`.
- Successful remote claims now include a bounded resume context—task lineage, attempt number, checkpoint metadata, and recent redacted activity—so crash recovery does not require a worker to reconstruct context from the full event log.
- The deterministic orchestration benchmark now guards both capacity-aware checkout and resumable remote context, keeping the new recovery contract measured rather than documentation-only.
- Dashboard queue rows now render the structured progress state, percent, and step instead of exposing those fields only through the API payload.

- Latest pushed state: `origin/master` at the latest handoff commit (verify with `git log`).
- Competition manifests now support typed `researchChannels` for rules,
  discussions, leaderboards, documentation, papers, and repositories. CLI/TUI
  ingestion deduplicates legacy URLs, persists channel kind with source hashes,
  and honors per-channel refresh intervals; channel content remains discovery
  evidence rather than a metric or external-score assertion.
- Claims extracted from non-paper channels now use the dedicated
  `external_source` provenance type. They require a durable source, remain
  discovery-only in claim audits, and follow source lifecycle retirement just
  like literature claims.
- The director now has a bounded `competition.observe` tool that selects a
  configured channel, uses its refresh policy, persists a hashed observation,
  and returns untrusted channel content with typed provenance.
- Direct `source.retrieve` calls now accept the same optional channel kind, so
  standalone research can classify documentation, discussions, leaderboards,
  and repositories without pretending they are papers; cache reuse is kind-aware.
- Durable scored submissions now feed conservative distribution beliefs into
  autonomous allocation. Sparse or high-uncertainty local-to-external alignment
  triggers multi-split validation pressure; a few leaderboard points cannot
  select a split or satisfy a score/evidence gate.
- Submission provenance now retains finite run metrics, and both polled and
  manually recorded external scores recover those metrics automatically for
  distribution-belief updates; operators need not re-enter local scores.
- Metric-parent leave-one-factor-out ablations now require finite comparable
  variant metrics when a control metric is available and persist per-factor
  effects; process exit alone cannot complete metric ablation evidence.
- The TUI now mirrors the CLI ablation lifecycle: it executes every declared
  leave-one-factor-out variant, reads durable run metrics, records factor
  effects, and emits `research.ablation.evidence` only after all variants reach
  terminal state.
- Modal experiment workers now stream stdout/stderr progress while retaining
  bounded 16 MiB copies for structured results, preventing long GPU jobs from
  appearing hung or accumulating unbounded log memory.
- Modal headless controller controls now publish atomically with request IDs and
  durable requested/applied status. Pause survives controller restarts, resume
  clears the pause, and an applied stop cannot be replayed by a restarted
  controller.
- Non-safe research lane teams now use a bounded completion-driven asynchronous
  scheduler: capacity is refilled as lanes finish, later lanes receive the
  compact completed-peer board, and each hand-off is durably recorded. Safe mode
  retains serialized lane execution.
- The literature guidance now records Auto-RecSys's asynchronous execution and
  centralized-memory lessons plus regime-aware retrieval from memory-substrate
  comparisons; README model-policy language matches explicit Astra preservation.
- Memory retrieval now classifies turns as discovery or execution and applies
  different bounded category quotas: broad method/repository discovery is
  favored while forming ideas, while falsification, controls, failures, and
  ablations are favored during execution. The regime and quotas are included in
  the durable retrieval fingerprint; coverage is tested in the core suite.
- Passing experiment trajectories now crystallize into separate, bounded
  execution playbooks with executor/evaluation/verification/artifact metadata,
  environment provenance, source trajectory IDs, and explicit transfer warnings.
  They are retrieved into future research context and reports as procedures,
  never as scientific proof or evaluator authority.
- Bounded source claim extraction now ranks method, result, validation,
  limitation, and quantitative signals with document-position diversity, then
  restores source order while preserving exact excerpts and spans; late-paper
  ablations and failure modes are no longer systematically omitted.
- Execution-playbook derivation now carries a redacted experiment manifest into
  experience records, so generated procedures retain the actual executor,
  dataset/split, fold/seed, metric, and verification contract instead of a
  generic recipe.
- Identified duplicate findings now contribute active conflict pressure only
  when both referenced claim endpoints remain active; anonymous legacy events
  remain conservatively counted.
- Active claim resolution now checks both claim status and linked source
  lifecycle status, protecting legacy databases from reintroducing claims from
  superseded or invalidated literature after restart.
- Duplicate-claim pressure now ignores findings tied to superseded or
  invalidated claims, matching active contradiction accounting across the
  controller, TUI, memory, audits, and reports.
- Conflict pressure now considers only contradictions whose claim endpoints
  remain active; superseded or invalidated source claims stay in history but do
  not distort autonomous allocation, audits, or reports.
- Source refreshes now cascade retirement to claims linked to the superseded
  content hash; stale literature remains auditable as history but is excluded
  from active research memory.
- Literature claim ingestion now retains exact source excerpts and character
  spans alongside each durable claim, in both CLI and TUI paths, while keeping
  the existing string-list source schema compatible.
- Workspace inventory now includes hidden project control files while excluding
  `.git`, `.sota`, and dependency trees, reducing blind spots in evidence
  gathering and implementation review.
- The bounded `git.diff` research tool compares `HEAD`, so agents now see both
  staged and unstaged implementation changes during review and recovery.
- The research tool registry now includes a bounded, read-only `git.diff`
  observation for implementation and recovery review; diff contents remain
  untrusted workspace data and nonzero Git exits are preserved as failures.
- Read-only `shell.exec` now preserves command output while marking nonzero
  exits as failed tool results, ensuring the director replans after failed
  tests, benchmarks, or inspections.
- Controller decision audits now reject duplicate hypothesis titles and
  selections that are absent from the exact typed decision payload, preventing
  ambiguous provider output from driving execution.
- Independent evaluator output now uses the same metric-conflict policy as worker
  output: unresolved conflicting primary values fail the run instead of silently
  overwriting its score, with the conflict retained in run diagnostics.
- Generic auditable-subtask contracts are now persisted in the live CLI/TUI
  phase-gate path as `subtask.audit` events. Required criteria only pass from
  the domain verifier/auditor and every accepted criterion must carry a durable
  evidence ID that resolves to durable events, runs, artifacts, claims, sources,
  hypotheses, or submissions; executor prose is ignored as proof. Historical
  audits are revalidated on read and downgraded when their references no longer
  resolve.
- A controller-owned decision auditor now records `research.decision.audit` and
  downgrades illegal or unaudited director decisions to inspection.
- A fresh read-only provider-backed semantic auditor now checks the decision
  against bounded evidence, grounds anchors, persists success/failure, and
  gates non-pass decisions before execution.
- Lane cross-pollination now uses only controller-grounded source IDs for
  independent-support and evidence-diversity calculations; raw model anchors
  remain visible for inspection but cannot strengthen consensus.
- The semantic auditor independently gathers workspace, Git, and artifact
  evidence through the permission-controlled tool path before its model call.
- Semantic audits now return criterion-level verdicts and grounded evidence;
  missing or failed required criteria force revision.
- Domain and semantic criterion results are merged into one conservative audit;
  phase advancement requires both layers to pass.
- Experiment audit gates now map to criterion-level verifier evidence and are
  persisted by both the CLI and TUI audit commands.
- Promotion and submission now require a complete persisted audit for the exact
  current experiment run; stale or missing audits are blocked.
- Changing leakage/reviewer gates automatically refreshes the persisted audit in
  CLI and TUI flows.
- Replication completion and external evaluator score observations now refresh
  the affected experiment audit with trigger provenance.
- Replication is a required criterion whenever a manifest declares it: only a
  completed run for the exact current linked child manifest satisfies the gate;
  stale child runs and unrelated experiments do not. External evaluator
  requirements can be enabled with `acceptance.requireExternalScore` and are
  derived from durable scored-submission records as `externalScoreObserved`.
- Recording or polling a score now refreshes only that external criterion in the
  persisted audit; all other failed criteria remain failed.
- Prepared submission records persist the exact source run ID, and external
  score evidence is accepted only when it matches that run.
- External-score gates now require a scored submission with a finite observed
  score; submitted/pending or malformed score payloads cannot satisfy them.
- Autonomous validation applies conservative alpha spending to repeated looks at
  the same hypothesis, combining the look number with existing family-wise
  correction and persisting the resulting threshold/alpha in evidence.
- Research context now separates active claims from invalidated/superseded
  `quarantinedClaims`; stale evidence remains auditable and useful as negative
  evidence without being presented as current truth.
- Each bounded memory packet is fingerprinted and recorded as
  `research.memory.retrieved`, making retrieval independently replayable and
  diagnosable.
- Research context now includes a provider/domain-neutral falsification agenda;
  untested hypotheses are prioritized and terminal/failed directions are kept
  visible so autonomous cycles do not repeat unchanged routes.
- The benchmark runner supports bounded alternate routes after same-route
  retries, with route and command provenance in each attempt. The change is
  covered by the benchmark runner test.
- Portfolio scheduling now consumes the falsification agenda: untested directions receive an information-value bonus while rejected directions remain revisit-able only when their measured value warrants it.
- Newly proposed current-cycle hypotheses are treated as untested before durable materialization, and the agenda is packed early so bounded agent context retains the next test.
- External evaluation targets from AutoResearchBench, ResearchClawBench, AutoExperiment/AutoMat, and ScienceAgentBench are mapped to Evidra's literature and scientific-task protocols; no external score is claimed without matched runs.
- Generic acceptance audits now calculate weighted criterion completion for multi-objective artifact/proof/behavior tasks while retaining hard required-criterion gates.
- Scientific task progress now supports weighted stages; final validity still requires every declared stage and verifier to pass.
- Criterion and stage weights are bounded to keep aggregate diagnostics finite even for malformed or adversarial task contracts.
- Research and Challenge hypothesis-phase gates now require the selected direction itself to include a concrete falsification test; a raw hypothesis count can no longer advance the phase.
- Research hypothesis schemas trim and reject blank falsification tests before materialization, keeping the durable graph clean at its input boundary.
- Literature lanes now use bounded deterministic progressive queries for replication, limitations, robustness, and ablation evidence instead of relying on one objective wording.
- Convergence-based stopping now remains active while durable untested or inconclusive falsification directions exist; the agenda therefore influences both scheduling and termination.
- The TUI autonomous loop now applies the same durable open-falsification stop check as the headless CLI, preventing provider-path-dependent premature completion.
- TUI campaigns now also evaluate and persist the full stop policy, including reward history, repeated failures, leakage, remaining budget, and open falsification work.
- Progressive literature search uses one deep primary probe plus shallow complementary probes, avoiding accidental query multiplication while retaining replication and robustness coverage.
- Non-safe research teams now run in bounded parallel waves: later specialists
  receive a compact, evidence-anchored peer board, and each completed-wave
  hand-off is persisted as `research.lane.handoff`; safe mode remains a single
  read-only pass.
- Literature probes are now role-specific for method and model specialists,
  reducing duplicate retrieval work while preserving deterministic progressive
  search and complementary coverage.
- Identical cacheable read-only observations are now coalesced across one lane
  team invocation, including simultaneous calls; cache hits are marked in the
  lane result, while shell execution and failed observations are never reused.
- Failed in-flight observations are explicitly excluded from the lane cache;
  concurrent siblings receive a fresh attempt instead of treating a transient
  failure as durable evidence.
- Peer hand-off serialization now accepts only bounded strings for findings,
  recommendations, tests, evidence anchors, and source IDs, preventing
  malformed lane payloads from expanding or steering later agent context.
- Non-metric hypotheses now require an explicit expected outcome at the schema
  boundary; proof, artifact, behavior, system, and other research cannot pass
  with an implicit zero-valued metric forecast.
- Portfolio scoring now ignores scalar forecasts for non-metric candidates and
  schedules them through explicit information value, novelty, risk, cost, and
  falsification state instead of inventing a comparable task metric.
- Hypotheses now carry up to eight bounded assumptions; those assumptions are
  persisted and included in executable-idea fingerprints, so transfer and
  deduplication cannot silently erase different validity conditions.
- Each assumption is capped at 1,000 characters at the schema boundary, keeping
  transfer conditions auditable and preventing unbounded context growth.
- Hypothesis quality assessment now accepts assumptions as an explicit
  structural signal: proposals without validity assumptions receive a review
  reason, while the score remains advisory rather than treating stated
  assumptions as experimental proof.
- Pre-registered experiment manifests are now immutable at the store boundary:
  lifecycle status updates remain allowed, while protocol mutations are
  rejected and recorded as `experiment.manifest.mutation.rejected`.
- Evidence audits now use the manifest's declared primary metric before any
  live project configuration, preventing post-run objective drift; legacy
  manifests without a metric list retain the compatibility fallback.
- CLI and TUI audits now snapshot external-score evidence before closing the
  read store, preventing valid score gates from querying a closed database.
- Failed-direction memory now retains bounded executor/provider/model/operator
  provenance, so recovery planning can distinguish a changed execution route
  from an unchanged replay while preserving negative results as non-proof.
- Execution, parsing, promotion, comparison, ratcheting, and trajectory
  reporting now use the manifest's registered primary/secondary objectives and
  directions, preventing live configuration changes from altering a run's
  evaluation semantics.
- GitHub Actions now verifies clean-install typechecking, the complete smoke
  suite, and distributable package contents on pushes and pull requests.
- The CI gate also audits runtime dependencies at high severity; the current
  lockfile reports zero production vulnerabilities.
- Decision-derived evidence claims now use the explicit `decision_<id>`
  provenance namespace; reports retain compatibility with legacy numeric
  decision IDs so CLI and report audits classify claims consistently.
- Retrieved source revisions now carry active/superseded/invalidated status;
  replacing a URL marks the prior revision superseded, and literature-based
  transfer adaptations must use a current, claim-bearing source revision.
- Research-context source retrieval excludes superseded and invalidated
  records before ranking, preventing stale literature from re-entering later
  autonomous prompts.
- Latest verified baseline: 399/399 tests passing, TypeScript check passing,
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
- Slurm is now a first-class optional experiment executor: manifests, durable
  campaign runtime fingerprints, CLI/TUI selection, shared-filesystem `sbatch`
  submission, `squeue` polling, `sacct` terminal state, cancellation, bounded
  logs, and failure classification are covered by the same evidence path as
  local, container, and Modal workers.
- A read-only localhost dashboard now projects bounded, secret-redacted
  campaign, phase, agent, experiment, run, integrity, and event state from the
  same SQLite store used by the TUI; it has no mutation endpoints.
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
  deterministically to independent lanes, and exclude Astra from automatic
  diversification while preserving an explicitly selected Astra primary route.
- Codex research timeouts now receive one bounded alternate-route replan while
  campaign budget remains; a second timeout or budget exhaustion pauses the
  campaign with the failure trajectory preserved.
- Phase gates now expose deterministic progress (`completed`, `total`, `ratio`)
  alongside missing checks. This improves long-campaign steering and resume
  visibility while preserving the all-required-evidence completion gate.
- The CLI and TUI evaluate that gate on every cycle, not only after a model
  claims completion, so active phases receive usable progress and missing-check
  signals during autonomous steering.
- Generated research, challenge, and final reports now recompute and display the
  same deterministic phase-gate progress and missing checks, preserving useful
  visibility after the live session ends.
- Long-horizon literature review now records LongHorizon-Harness, AutoLab, and
  AARRI-Bench as design/evaluation inputs: explicit manager state, fresh-context
  execution, independent audit, persistence, and researcher-quality checks.
- Added a provider-neutral AutoLab contract adapter and CLI discovery command;
  the current public checkout normalizes 36 valid task contracts without
  executing Harbor or claiming benchmark performance.

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
