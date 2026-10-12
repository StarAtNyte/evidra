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

- Modal now runs a bounded, interruptible CLI version preflight before recording
  launch intent. Broken/missing clients, interrupted checks and preflight
  timeouts create no allocation ledger or GPU charge. Verified spawn failures
  after a successful probe still use NOT_STARTED evidence; post-launch errors
  remain fenced. Tests cover preflight failures and probe/launch races.

- Process launch errors now preserve OS proof that the runtime client did not start. Modal
  records ordered NOT_STARTED evidence for verified spawn failures, allowing
  reservations to release without pretending a remote call ran. Post-launch
  errors still retain the fence, even if their message/code says ENOENT.
  Tests cover missing and non-executable clients, callback errors and restart.

- Modal ownership checks now use a partial call-ID index and read at most two
  matching receipts. SQLite without JSON1 streams receipts and stops at the
  second match instead of materializing history. Regression tests verify the
  query plan and both paths against unrelated history and aliased ownership.

- Modal call IDs now require one receipt owner across the durable store before
  querying or recording completion, and before releasing a fence. Reused IDs
  across launch intents or experiments retain reservations even if each copied
  ledger appears complete. Recovery and ledger tests cover both aliasing and
  copied terminal proofs. Live Modal recovery/cancellation remain unverified.

- Modal reconciliation now polls recorded call IDs with SDK `get(timeout=0)`
  through a packaged Python helper. Completed valid worker envelopes produce
  idempotent terminal evidence and release quarantine without importing metrics
  or artifacts. Pending, expired, malformed, missing-receipt and failed queries
  stay fenced. Set `EVIDRA_MODAL_PYTHON` to the Python interpreter with Modal
  installed. Tests run the actual helper with a stub SDK; live RPC and remote
  cancellation remain unverified. Temporary SDK installation was not completed.
  Source: https://modal.com/docs/sdk/py/latest/FunctionCall.

- Modal now spawns a call and emits its SDK call ID before waiting for results.
  The controller persists streamed receipts linked to the prelaunch intent;
  new completion evidence must match that call ID. Missing, duplicate or
  mismatched receipts cannot confirm completion. Call cancellation, live SDK
  verification and recovery of submissions lost before receipt remain open.
  API contract: https://modal.com/docs/sdk/py/latest/FunctionCall.

- Modal stdout or stderr capture overflow now returns an explicit failed result
  (65) with no metrics or artifacts. A metric in the retained prefix cannot
  survive discarded later evidence. Python tests cover either stream overflowing
  and exactly-at-limit output remaining valid. Live Modal recovery remains open.

- Modal completion-envelope limits now apply inside the remote worker before
  returning over RPC, as well as in the local entrypoint. Direct worker tests
  reject oversized escaped output and artifacts before transport; valid results
  preserve their worker exit status. Live Modal RPC limits remain unverified.

- Modal bounds aggregate artifact capture at 64 MiB and serialized completion
  envelopes at 7 MiB so terminal evidence fits the controller's retained tail.
  Exceeding either returns a small failed-result envelope (65) with no metrics
  or artifacts, avoiding false success or an unparseable completion. Tests cover
  aggregate exhaustion and JSON escaping/Unicode expansion. Large-artifact
  transport remains unimplemented; oversized results are explicitly rejected.

- Modal artifact collection now walks workspace-relative directory descriptors
  with no-follow opens, rejects special files, reads at most the per-file cap
  plus one byte, and rejects files that change during capture. Python tests
  cover normal, missing, oversized, FIFO, symlink, parent-symlink and mutated
  files. Large-artifact transport remains follow-up work.

- Modal forwards the declared timeout to the Python subprocess worker, which
  enforces a monotonic deadline even after both output pipes close. Each command
  gets a new process group, killed during cleanup on success or failure.
  Timeout exceptions emit no completion envelope and preserve reconciliation
  fences. Tests execute sleeping workers, closed pipes and inherited child
  pipes. Detached sessions, live Modal RPC cancellation and orphan discovery
  remain unverified; process-group cleanup is not full remote termination proof.

- Modal worker output now uses bounded 64 KiB pipe reads instead of blocking
  line reads. Capture is limited before decoding, UTF-8 streaming preserves
  fragmented characters, and invalid bytes become replacement characters.
  Progress frames cannot merge unterminated output with the final envelope.
  Actual Python subprocess tests cover partial lines with saturated stderr,
  capture bounds, fragmented Unicode and invalid bytes; live RPC remains open.

- The actual Modal Python entrypoint now returns client success after emitting
  a valid worker envelope, even for failed workers. RPC errors still propagate;
  signal termination becomes portable exit status 128+signal. Python execution
  tests with a stubbed Modal SDK verify real subprocess and entrypoint behavior;
  they do not certify live Modal RPC termination or orphan cancellation.

- Modal now persists a launch intent before starting the runtime client and
  records synchronous completion evidence only after a successful client exit
  and valid worker envelope. Uncertain failures, timeouts, interruptions and
  missing envelopes retain compute reservations and block replay across restart.
  Legacy completion receipts are local invocation evidence; new launches also
  record SDK call IDs. Discovering and cancelling orphaned Modal calls remains
  unimplemented.

- Modal completion parsing now rejects duplicate envelopes, malformed terminal
  evidence in either order, and noncanonical artifact base64 instead of falling
  back to an earlier success. Ordinary progress logs remain accepted. This does
  not establish remote cancellation or durable allocation identity.

- Modal now requires a successful runtime-client exit and valid worker envelope
  before parsing worker metrics or importing artifacts. Printed success cannot
  overwrite client failure, timeout, or interruption; unconfirmed outcomes keep
  raw output as diagnostics and return nonretryable unknown failure. Tests cover
  graceful-zero termination, missing envelopes, and confirmed worker failures.
  Live Modal call identity verification, remote cancellation and orphan recovery remain
  open gates. No live Ollama server was reachable for runner-overflow trials.

- Local health and every generation now probe the server version and require
  a stable 0.x release at least 0.40.3, conservatively verified against released
  Ollama request/handler source. Unsupported or unknown versions cannot reach
  inference; deadlines, interruption, byte bounds, and proxy routing remain
  enforced. HTTP regressions cover accepted versions, malformed/prerelease/
  old/unknown-major versions, stalled metadata, and cancellation.
  Live runner/proxy conformance, tokenizer budgets, and transcript growth
  remain open gates; self-reported version is not an execution attestation.

- Local chat requests now send `truncate: false` and `shift: false`, following
  Ollama request/handler source pinned at
  `eab97e9f92b9a25c2d52d2cc6c1b1c99bd9fae21`. HTTP regressions preserve the full
  objective/schema and reject context exhaustion without assistant emission;
  generation-error usage is retained when reported. Live runner conformance,
  tokenizer budgeting, and provider
  transcript growth remain open release gates.

- Local calls now request a finite output-token limit (4096 by default), with
  validated environment/adapter overrides from 1 to 65536. Reported output
  above the limit is rejected after usage attribution. Tests cover precedence,
  invalid configuration, bounds, and rejection without assistant emission.
  Input tokenizer budgeting, context/output headroom, live server conformance,
  unknown usage, and provider transcript growth remain open release gates.

- Local Ollama transport now enforces 1 MiB serialized request, 4 MiB decoded
  response/metadata, and 16 KiB error-diagnostic byte limits. Oversized input
  never reaches HTTP; oversized streams are cancelled and error text redacted.
  Regressions cover chunked/compressed bodies, Unicode, JSON escaping, and
  metadata probes. Model token-window budgeting, output headroom, provider
  transcript growth, and inference-budget coverage remain open gates.

- `experiment reconcile <id> --cancel-container` now supports explicit removal
  of unresolved owned Docker workers after controller loss. It persists the
  receipt and cleanup request before the exact-ID RPC, then verifies removal
  and daemon identity before releasing compute. Default reconciliation remains
  read-only. Failure and ownership regressions plus a live SIGKILL/cancellation
  probe cover the boundary; evidence is in
  `docs/research/evidence/container-orphan-cancellation-2026-10-11.json`.
  Podman, live alternate-daemon verification, automatic orphan cancellation,
  cleanup of already reconciled containers, and campaign soaks remain open.

- Docker recovery now matches the daemon ID recorded before launch, exact
  worker identity and ownership label, and stopped state with restart disabled.
  It can recover a missing receipt from the durable worker name, or prove a
  known full ID absent. Queries are read-only and bounded; ambiguous/running
  workers remain fenced. Receipts and proofs are idempotent across observers.
  A live controller SIGKILL probe verified running-worker quarantine followed
  by exited-worker recovery without validating the measurement; evidence is in
  `docs/research/evidence/container-crash-recovery-2026-10-11.json`.
  Podman, live alternate-daemon verification, automatic orphan cancellation,
  and long campaign soak tests remain open release gates.

- Container execution now persists unique launch intent before the runtime
  RPC and records full-ID receipts and verified absence proof. CLI/TUI share
  this mandatory ledger. Unconfirmed cleanup or durability failures keep
  compute reserved and block replay even without a controller restart.
  A SIGKILL regression verifies recovery of the durable worker name; live
  Docker normal-finalization evidence is recorded in
  `docs/research/evidence/container-ledger-2026-10-11.json`.
  Container reconciliation accepts durable cleanup proof; newer Docker intents
  also support daemon-matched recovery queries as described above.

- Slurm recovery now rejects out-of-order lifecycle evidence and malformed
  cluster identities; expanded ledger regressions verify that compute remains
  reserved for these cases. Live Slurm cluster recovery remains an open gate.

- Container execution now bypasses image entrypoints, disables image health
  checks, preserves the declared argv, and rejects implicit default commands.
  Cleanup removes anonymous image-created volumes with the exact container.
  A local Docker image with observable startup hooks verified direct command
  execution, absent hook markers, and container/volume removal; evidence is in
  `docs/research/evidence/container-image-contract-2026-10-11.json`.
  Podman live verification and orphaned-container reconciliation remain open.
- Exact container cleanup at `5a33e02` passed hosted CI on both Node versions,
  including package checks: run 38120074055; 707 local tests passed.

- Container launchers now retain full IDs in private receipt files and await
  exact-ID removal plus daemon-side absence verification. Missing receipts or
  failed/nonempty daemon queries fail conservatively and cannot auto-retry;
  timeout/interruption remain truthful, including cleanup runtime. Mock tests
  cover cleanup failures. Local Docker 29.8.1 probes independently verified
  completion, timeout, and interruption cleanup; recorded evidence is in
  `docs/research/evidence/container-cleanup-2026-10-11.json`. Podman, durable
  container crash recovery, and unconfirmed-outcome compute fencing remain open.
- Slurm live-query protocol at `2d9c20d` passed hosted CI on both Node versions,
  including package checks: run 38119441467; 706 tests passed locally.

- Slurm uses a UUID-based allocation name in lifecycle evidence. Normal and
  post-restart accounting query duplicates and require job-ID/name agreement.
  `experiment reconcile` now queries known unresolved allocations on the
  recorded cluster with a bounded query budget, appends idempotent terminal
  proof, and releases only complete identity-checked evidence. Legacy identity
  gaps, ambiguous receipts, active jobs, and failed queries remain fenced.
  Fake-CLI tests cover reuse, duplicates, terminal failures, absent evidence,
  and timeouts; no live cluster recovery claim is made.
- Active reservation fencing at `1b3b758` passed hosted CI on both Node
  versions, including package checks: run 38118811473; 705 local tests passed.

- Normal Slurm finalization now consults allocation evidence as well as restart
  flags. Unconfirmed outcomes cannot release compute, replay, or claim success;
  failed terminal updates materialize a durable quarantine with the requested
  outcome preserved. Indexed ledger queries avoid loading unrelated allocation
  history. Regressions cover active-controller failure, reservation recovery,
  budget exclusion, database reopen, and release after terminal reconciliation.
- Allocation-ledger work at `749e46c` passed hosted CI on both Node versions,
  including package checks: run 38118505961; all 704 local tests passed.

- Slurm execution now persists unique submission intents before launch,
  accepted allocation/cluster receipts before polling, and exact terminal
  accounting afterward. CLI/TUI wire mandatory ledger persistence. The
  `experiment reconcile <id>` command releases a restart fence only with a
  valid event chain and complete matching evidence for every intent, without
  promoting a measurement. Live post-restart cluster queries, ambiguous
  submissions, and container/Modal reconciliation remain required follow-up.
- Restart quarantine at `d8a3198` passed hosted CI on both Node versions,
  including package checks: run 38118010430; all 701 local tests passed.

- Restart recovery quarantines stale container/Modal/Slurm work instead of
  treating controller loss as a retryable failure. Durable reconciliation flags
  block replay and normal reschedule/completion updates, and retain compute
  reservations across terminal-looking edits and database reopen. A SIGKILL
  regression verifies this fence; local stale retries remain available.
  Backend allocation identity, terminal reconciliation, and verified quarantine
  release remain required follow-up work, not an achieved recovery gate.
- Provider probe hardening at `ed8e32d` passed hosted CI on both Node versions,
  including package checks: run 38117528116; all 700 local tests passed.

- Local provider discovery and model-health probes now retain a bounded
  deadline through headers and JSON body decoding, honor caller interruption,
  and validate inventory/metadata. Startup and fallback selection pass caller
  timeout/signal options through; an interrupted fallback is not converted
  back into a provider-reset wait. HTTP regressions stall headers, inventory
  bodies, and model-health bodies, and verify pre-aborted calls send nothing.
- Local request-contract changes at `efce265` passed hosted CI on both Node
  versions, including package checks: run 38117242384; 699 tests passed locally.

- Local Ollama requests now share endpoint resolution across discovery/health/
  generation, forward structured output schemas, reject partial or truncated
  replies, and report valid inference usage even for rejected completions.
  Pre-aborted requests and callback failures clean up without sending work.
  HTTP regressions cover endpoint paths, schemas, completion evidence, usage,
  cancellation, and listener cleanup. Model-aware input limits and output
  headroom remain open; this does not claim a token-budget guarantee.
- Slurm hardening at `3383977` passed hosted CI on Node 22.19.0 and Node 24,
  including package checks: run 38116795772. All 698 local regressions passed.

- Slurm protocol hardening now uses exact terminal allocation accounting with
  actual exit status/signals, joined cancellation requests, cluster-aware
  control commands, and scheduler requeue disabled. Ambiguous outcomes and
  queue failures cannot trigger automatic retries. Log previews read bounded
  UTF-8 head/tail evidence and reject symlinks. Ten focused tests pass; live
  cluster restart fencing, accounting reconciliation, and remote pause/resume
  remain open. The paper alignment and these limits are recorded in
  `production-readiness.md`.
- Hosted CI at `ffc4b7e` passed all 689 tests on Node 22.19.0 and Node 24,
  including production package checks; see run 38115887237. This closes the
  runner compatibility failures below for that commit.

- Hosted verification of `6d66564` exposed missing `rg` on the runner and an
  optional Modal-profile spawn failure in `doctor`. Git/ripgrep are now explicit
  required tooling, the installer rejects missing ripgrep before downloading,
  CI provisions it, and doctor readiness includes required-tool health while
  absent optional backends remain structured unavailable diagnostics. A
  minimal-PATH CLI regression exercises the failure mode independently of the
  developer machine's installed backends.

- The 2026-10-11 production audit maps the user's harness-design paper to actual
  Evidra boundaries and keeps the remaining gates explicit in
  [`production-readiness.md`](production-readiness.md). Execution now waits for
  process-group cleanup, preserves timeout/interruption/early-stop outcomes
  through graceful zero exits, drains shutdown evidence, and cleans up callback
  failures. Captured Unicode logs obey the byte cap. Context packing accounts
  for serialized JSON and bounded report metadata; current steering, phase
  state, and recent failure/trust metadata survive bulk history. Provider
  prompts use the counted compact representation, and lane directives enter
  packing before provider submission. Early-stopping telemetry now retains a
  bounded line and constant progress state, rejects oversized suffixes and
  nonfinite/blank numbers, and rebuilds patience after stale or corrected steps.
  Its declared policy/reference are immutable launch snapshots, and ordered
  decisions match the batch rule in both directions. The final local tree
  passed 687 tests on both Node 22.19.0 and Node 24.21.0, nine safety probes,
  typechecking/build, and a fresh production-only package install with event
  verification and an independently reopened backup. Full provider token
  budgets, live backend recovery, soak/restart evidence, hosted CI, and matched
  external runs remain open.

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
- Queue drains now fail closed when a worker has no claimable ticket: approval, capability, assignment, dependency, and deadline gates no longer cause an ineligible worker to spin indefinitely; the next supervisor poll can retry after another actor changes the queue state.
- Agent lane wall-clock budgets now emit a durable `agent.lane.budget_exhausted` event at the crossing boundary; the lane is rejected from promotion after that action, its queue ticket fails with preserved partial evidence, and operator attention marks any still-running lane as critical/blocked until recovery.
- Routine restart failures are now visible without a live daemon: expired runner leases make control-plane health blocked and create a critical `routine-stale` attention item, while routines whose latest durable run failed remain warning-level attention until inspected.
- Remote operators can now complete that recovery path with `/routines/:id/recover`; the endpoint is operator-only, atomically reclaims only expired leases, and advertises `routine-recovery` through `/capabilities`.
- Routine stale-recovery events now preserve their actor source (`scheduler`, UI/runtime recovery, or `operator`) instead of attributing every lease repair to a human operator.
- Recurring routines now have a bounded failure circuit breaker: three consecutive failed runs pause the routine, emit `routine.failure_circuit_open`, preserve the streak for audit, and reset it only after an explicit operator resume or a successful run.
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
- The event control plane now exposes bearer-authenticated `POST /tasks/cancel` for remote governance; it cascades through unfinished descendants and leaves worker leases to observe cancellation cooperatively on their next heartbeat.
- Remote operators can now pause/resume global queue dispatch through bearer-authenticated `POST /queue/pause` and `POST /queue/resume`; live tasks remain untouched and worker-only credentials are rejected.
- Queue governance mutations are retry-safe: repeating the same pause/resume state does not append duplicate lifecycle events.
- Remote operators can now reconcile queue state through bearer-authenticated `GET /queue/status`, which redacts claim tokens while returning progress, readiness, usage, recovery alerts, pause state, and integrity status.
- Remote queue and approval projections now apply structured secret redaction to arbitrary task payloads and inbox details, preventing credentials from escaping through otherwise-authenticated read models.
- Remote operators can now consume a bounded cursor-based `GET /activity` feed, with redacted append-only events and integrity status, so external dashboards can reconcile activity incrementally.
- Remote operators can now read a redacted `GET /organization` projection containing campaign identity, agent reporting lines, role controls, external workers, routines, queue control, and integrity state.
- The organization projection now includes bounded pending directive summaries with source actor and scope, making remote steering inspectable before safe-boundary delivery.
- Remote operators can now pause or resume durable routines through authenticated `POST /routines/:id/pause` and `/routines/:id/resume`; active runs remain protected from mid-run mutation.
- Remote operators can now trigger an immediate routine cycle through authenticated `POST /routines/:id/trigger`; repeated or in-flight triggers are coalesced rather than launching concurrent runs.
- Remote operators can now pause, resume, terminate, or revive known agent roles through authenticated role-scoped endpoints; controls are retry-safe, worker credentials are rejected, and termination blocks resume until explicit revival.
- Remote operators can now steer a known specialist with an authenticated role-scoped message; source actor and optional phase scope are preserved, identical pending retries are deduplicated, and no new authority is granted.
- Remote operators can now cancel an unapplied specialist directive through a role-scoped authenticated endpoint; applied directives remain immutable and repeated cancellation is idempotent.
- Remote operators can now inspect bounded per-role directive history, including applied and cancelled steering, through an authenticated redacted endpoint.
- Remote operators can now read one authenticated redacted `/attention` projection combining control-plane health with actionable approvals, recoveries, stalled work, stale workers, and blocked agents; this keeps remote automation aligned with the same intervention semantics as the local dashboard.
- Remote operators can now subscribe to bounded cursor-replay `/activity/stream` SSE; activity is redacted, reconnectable from an event ID, heartbeat-visible, and automatically bounded by a server-side lifetime.
- Remote operators can now inspect one queue task through authenticated redacted `GET /tasks/:id`, including resumable context, progress, readiness, lineage, usage, checkpoint metadata, lifecycle history, and child rollups without exposing claim tokens.
- Remote operators can now inspect one specialist through authenticated redacted `GET /agents/:role`, including the role contract, admission/control state, health, directives, outcomes, provider sessions, and bounded activity.
- Remote operators can now inspect one routine through authenticated redacted `GET /routines/:id`, including schedule state, bounded run history, associated queue work, progress, and readiness.
- The event server now exposes authenticated `GET /capabilities` discovery with protocol version, feature flags, auth schemes, and limits; `GET /health` also reports workspace identity and operational control-plane health alongside event-chain integrity.
- Attention items now have stable state fingerprints and durable operator triage through `/attention/ack` and `/attention/unack`; an acknowledged signal reappears automatically when its underlying state changes.
- Remote operators can now pause or resume one queue task through `/tasks/:id/pause` and `/tasks/:id/resume`; descendant transitions, progress, and actor-attributed audit events preserve per-task governance without a global queue pause.
- Remote operators can now assign or clear queued/failed work through `/tasks/:id/assign`; assignment targets must be admitted roles or known external workers, and durable assignment events retain actor attribution.
- Remote supervisors can now request controller `pause`, `resume`, or `stop` through authenticated `/controller/:action`; requests require a live lease and are consumed at the controller’s existing safe boundary.
- Remote queue status now supports bounded `status`, `assignee`, `kind`, and `limit` filters and returns the applied filter set, keeping remote work views precise and reconcilable.
- Remote operators can now recover failed queue work through `/tasks/:id/recover`; recovery requires a materially different route and note, preserves prior evidence, and rejects duplicate routes.
- Remote operators can now inspect `GET /approvals` and resolve queue-task or external-agent-role gates through authenticated approve/reject endpoints; workers cannot impersonate operators and repeated decisions do not duplicate audit events.
- Remote governance actions accept a bounded `X-Evidra-Actor` label and preserve it in durable action records, making dashboard and controller decisions attributable without exposing credentials.
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

- Modal launch now binds the prepared experiment config to its SHA-256 digest.
  The worker validates a bounded regular-file snapshot and strict metadata,
  folds/seeds, matrix flag, and declared environment before starting commands.
  Missing, altered, malformed, oversized, or symlinked contracts return failed
  completion without measurements. Safe declared variables reach the worker;
  private HOME and experiment metadata remain authoritative. Actual Python
  subprocess regressions verify rejection before command execution; live Modal
  mounting and SDK integration remain separate validation gates.

- Modal upload filtering now preserves leading dots and applies the contract
  exception only at the worktree root. Resolved file targets must also remain
  inside the worktree and pass exclusions; config aliases and special files
  are excluded. A repeatable SDK probe (`scripts/probe-modal-workspace-mount.py`)
  verified the actual Modal 1.6.1 local enumerator in an isolated virtualenv;
  evidence is in `docs/research/evidence/modal-workspace-mount-sdk-2026-10-12.json`.
  This proves local upload selection, not live remote mounting or cancellation.

- The default Modal entrypoint now resolves from the installed package rather
  than the caller's workspace. Explicit custom entrypoints remain unchanged.
  CI exercises the installed executor from an unrelated workspace with a decoy
  worker file. A local SDK probe verifies all shipped CLI flags through Modal
  1.6.1's `run --help`, without launching remote compute; evidence is recorded
  in `docs/research/evidence/modal-installed-entrypoint-sdk-2026-10-12.json`.

- A live Modal 1.6.1 CPU worker completed the bounded smoke experiment, verified
  dataset/split/declared environment/private HOME and source exclusions, returned
  accuracy=1, and restored its declared JSON artifact. The real call receipt
  preceded completion. A separate reopened store deliberately omitted the
  successful client's terminal event; read-only SDK recovery released its
  quarantine without importing any measurements. Evidence and probe source:
  `docs/research/evidence/modal-live-cpu-and-recovery-2026-10-12.json`.
  This is a recovery simulation against a real completed call, not a real
  client-crash/cancellation/GPU/concurrency test; those gates remain open.

- A real Modal CLI SIGKILL after its durable call receipt preserved quarantine
  and rejected measurements; reopening and SDK polling confirmed successful call
  completion without importing measurements. However, live app inspection then
  showed one container still alive. Explicit stop of the probe's own app yielded
  stopped state and zero tasks. Evidence:
  `docs/research/evidence/modal-live-client-crash-2026-10-12.json`.
  **Previously observed Modal compute recovery gap (fixed below):** completed calls alone do not
  prove allocation quiescence after client loss. Retain app/allocation identity
  and require termination proof before releasing compute; do not treat the
  current successful SDK poll as closure of this gate.

- Modal compute recovery now requires SDK-bound app identity, stopped state,
  and zero running containers; call completion alone is insufficient. New
  receipts record app IDs, successful execution verifies allocation teardown
  within a bounded wait, and older terminal records require a separate causal
  allocation proof. Missing/active/mismatched/ambiguous apps retain quarantine
  and compute reservations. SDK inspection is preflighted before launch.
  Actual CPU execution and a real CLI SIGKILL verified the fix: a completed call
  with an active app stayed fenced, then explicit stop of the probe's own app
  enabled read-only recovery with no imported measurements. Evidence:
  `docs/research/evidence/modal-live-allocation-quiescence-2026-10-12.json`.
  This supersedes the compute-release gap above. Pending-call cancellation,
  GPU workloads, concurrency and live nondefault environments remain open.

- Modal workers now enable restricted resource access and single-use containers.
  SDK preflight requires both isolation options before launching remote compute.
  A live CPU probe using the wrapper's SDK context received AuthError for a
  noncreating Queue lookup; the unrestricted control reached the lookup and
  received NotFoundError. Both returned their normal metrics/artifacts and
  stopped with zero containers. Evidence:
  `docs/research/evidence/modal-restricted-resource-access-2026-10-12.json`.
  Other resource types, adversarial subprocess credential recovery and network
  egress remain separate verification gates.

- Modal recovery can now release a verified stopped app with zero containers
  when worker output is expired, malformed, canceled, or unavailable. Such
  records use ALLOCATION_STOPPED / sdk-allocation with sentinel 125 for unknown
  worker outcome; no metrics are imported or worker success inferred. Older
  worker-result records remain immutable and gain only allocation evidence.
  Active/missing/mismatched apps and local process interruption remain fenced.
  A live missing-executable CPU probe failed before emitting an envelope, then
  recovered after reopening its store using the stopped allocation proof:
  `docs/research/evidence/modal-live-allocation-only-recovery-2026-10-12.json`.

- A live pending CPU call was confirmed with SDK get(timeout=0), then canceled
  with terminate_containers=True after an actual local-client SIGKILL. The
  cancellation acknowledgment was followed by another TimeoutError, and
  read-only recovery correctly retained quarantine while the app was active.
  Explicit stop of the probe's owned app enabled stopped/zero-container recovery
  with ALLOCATION_STOPPED and no imported measurements. Evidence:
  `docs/research/evidence/modal-live-pending-cancellation-2026-10-12.json`.
  A user-facing Modal cancellation command, GPU cancellation and concurrent-input
  cancellation remain open; this probe does not establish those capabilities.

- Added `experiment reconcile <id> --cancel-modal`. New default workers name
  their ephemeral app with the unique submission tag. Cancellation requires a
  single recorded app owner, SDK call/app/tag binding, one input and ephemeral
  lifecycle; deployed, shared and older untagged apps are refused. Requests and
  observations are durable, failed SDK diagnostics are bounded/redacted, and
  compute is released only on stopped state with zero containers. Plain
  reconciliation remains read-only. Live CLI evidence:
  `docs/research/evidence/modal-live-cancel-command-2026-10-12.json` and
  `docs/research/evidence/modal-live-cancel-command-pending-2026-10-12.json`.
  The first pending probe retained quarantine on a transient STOPPING state.
  Diagnostics identified that transition; bounded verification now waits through
  it. A fresh live pending-call CLI probe stopped the owned app and released only
  after zero-container proof, with no imported measurements. GPU/concurrent
  cancellation remains unverified.

- `doctor --json` now exposes Modal CLI health, SDK allocation-inspector
  availability, credential configuration and an explicit unverified-authentication
  flag. A selected profile or credential environment no longer masks a broken
  CLI or inspector. Capability checks are bounded and local, matching SDK token
  and OAuth configuration rules without exposing values or contacting Modal.
  Existing local-provider readiness remains independent of optional Modal.

- Two simultaneous live Modal CPU executions shared one controller store with
  distinct tagged apps. Killing the target client and canceling its owned app
  preserved the peer's normal completion, accuracy smoke metric and artifact.
  The first cancellation observation retained quarantine; a retry established
  stopped/zero-container termination. Both durable allocations are confirmed,
  and no peer cleanup was requested or campaign measurements imported. Evidence:
  `docs/research/evidence/modal-live-concurrent-cancellation-2026-10-12.json`.
  This proves isolation between two apps; shared-app inputs and GPU cancellation
  remain unverified.
  Reproduce with `npm run build`, then
  `node scripts/probe-modal-concurrent-cancellation.mjs /absolute/sdk/bin/python /absolute/sdk/bin/modal`.
  This launches two live CPU jobs using configured credentials. It prints and
  retains its state directory, bounds receipt waits, records each cancellation
  attempt and waits for executor callbacks before closing SQLite on failures.
  A `recovery.json` report survives assertion failures and summarizes both
  executor outcomes and durable allocation state without retaining raw client
  output. An unavailable-SDK probe verified nonzero failure and report creation
  without remote execution.

## Immediate next work

Controller backups now stage SQLite output in a private directory (0700),
flush the completed snapshot, set owner-only permissions (0600), then publish
by rename on the destination filesystem. Failure preserves an existing backup
and removes staging files. Live database paths and inode aliases are refused;
the CLI closes its store on backup failures. Focused fault-injection tests
verify these behaviors, and actual live Modal probe state reopened from a
private backup with valid event and allocation evidence.

The default Modal local entrypoint now prints its app identity before spawning
the function call. The controller journals a causal `run.remote.allocated`
event and requires the later call receipt to match that app. Duplicate,
reordered, malformed and mismatched app records fail closed. An app-only
failure retains quarantine and its reservation across database reopening.
This narrows identity loss after entrypoint startup; image/build rejection
before the entrypoint (including the rejected GPU probe) remains unresolved.
App-only recovery is not yet authorized by the reconciliation proof model.
A live two-app CPU probe verified submitting/allocated/submitted ordering and
matching app identities for both jobs; target cancellation preserved peer
completion. Evidence: `docs/research/evidence/modal-live-early-app-receipt-2026-10-12.json`.
Durable call ownership now checks any recorded app allocation against the
single ordered intent and receipt. Contradictory, duplicate, reordered or
malformed records refuse terminal writes, cancellation and budget release,
including after reopening and without SQLite JSON1. Older receipts without
an app allocation remain supported. A NOT_STARTED spawn proof cannot override
a recorded allocation. Recovery still requires a call receipt and stopped-app
proof; the early app record alone never authorizes release.
The tightened durable binding checks passed a fresh live two-app CPU
cancellation probe: the target was reconciled and its peer completed with the
smoke metric and artifact. A consistent SQLite backup taken while the peer was
unresolved reopened independently with valid event integrity and both call/app
bindings preserved; the snapshot retained the peer's unconfirmed state.
Evidence: `docs/research/evidence/modal-live-durable-binding-2026-10-12.json`
and `docs/research/evidence/modal-live-backup-binding-2026-10-12.json`.
This proves snapshot consistency, not controller takeover, full campaign
restoration or artifact backup.
The same restored snapshot subsequently passed stale recovery and read-only
SDK reconciliation of its unresolved peer. One query confirmed stopped-app
termination, cleared quarantine and retained failed experiment status with
zero measurements and no peer cleanup request. Evidence:
`docs/research/evidence/modal-live-backup-recovery-2026-10-12.json`.
This verifies allocation recovery from that backup; full campaign takeover,
artifact restoration and live reservation retention remain unverified.

The bounded live T4 probe (`scripts/probe-modal-gpu.mjs`, SDK Python and CLI
paths as arguments) was rejected because the configured Modal account requires
a payment method for GPU functions. No call receipt or measurements were
produced; quarantine remained. A read-only SDK listing found its uniquely
tagged app STOPPED with zero containers, but name-only observation is not
accepted as durable reconciliation proof. Evidence:
`docs/research/evidence/modal-gpu-submission-rejected-2026-10-12.json`.
GPU execution and cancellation remain unverified; retry requires account GPU
availability. The probe retains its database, events and result on failure.
The actual receipt-less submission database was reopened and audited with both
plain reconciliation and `cancelModal`: each returned released=false, queried=0.
Replacement with scheduled/running/completed status was rejected, quarantine
survived reopen, and no cleanup requests or measurements were recorded. Evidence:
`docs/research/evidence/modal-receiptless-recovery-audit-2026-10-12.json`.
This verifies the retry guard, not successful recovery. No compute reservation
existed in the direct-executor probe, so live budget retention remains untested.

The offline `scripts/probe-modal-worker-isolation.py` probe imports the shipped
worker with Modal 1.6.1 and checks actual SDK registration metadata: restricted
Modal access, single-use containers, no attached secrets and no requested GPU.
It verifies subprocess environment filtering with disposable sentinel values.
Evidence: `docs/research/evidence/modal-worker-isolation-registration-2026-10-12.json`.
Network access is enabled. This adds registration evidence, not server enforcement
or adversarial credential-recovery proof; those isolation gates remain open.

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
