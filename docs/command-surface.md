# Evidra Workbench command surface

The TUI is the primary interface. Every command is available after typing `/`; commands are discoverable through live filtering and Tab completion. Natural-language input remains available for research questions and is routed according to the active mode.

## Session and mode

```text
/help                         Show the command catalog
/workbench                    Show the graph, budgets, agents, and active work
/workbench research           Enter Research mode
/workbench challenge          Enter Challenge mode
/mode                         Show the active mode
/mode research                Switch to Research mode
/mode challenge               Switch to Challenge mode
/pause                        Pause autonomous scheduling
/resume                       Resume autonomous scheduling
/autonomy                     Show autonomy policy
/autonomy safe                Require approval for promotion and paid compute
/autonomy fast                Auto-run local work after deterministic gates
/autonomy yolo                Auto-run routine work; retain external-action gates
/loop status                  Show autonomous loop state
/loop once                    Run one complete research decision cycle
/loop start                   Start repeated research cycles in this session
/loop pause                   Pause the loop and preserve state
/loop stop                    Stop scheduling; preserve all evidence
/scheduler start              Start experiment scheduling
/scheduler pause              Pause new work
/scheduler drain              Finish running work, start nothing new
/compute slurm                Route experiments through shared-storage Slurm
/hero status                  Show zero-to-hero progress
/hero start                   Initialize, reproduce baseline, and generate first decision
/hero stop                    Stop the zero-to-hero loop without deleting artifacts
/goals                        Show the durable goal tree and phase progress
/event emit <type> [json]     Emit a safe external event and wake matching routines
/exit                         Exit the TUI
```

Permission level is session-scoped and resets to `safe` when a new terminal session starts. Project state, evidence, and campaign metadata remain durable.

Research mode emphasizes sources, claims, ideas, hypotheses, and decisions. Challenge mode emphasizes a competition’s rules, data, validation, experiments, runs, compute, and submissions.

An explicit autonomous campaign owns the full local loop: research lanes, implementation in an isolated worktree, evaluation, retries, and replication. It can be controlled or recovered without losing durable state:

`--lanes` is the maximum number of specialists running concurrently. In `fast`
and `yolo`, Evidra may schedule the bounded role pool in multiple waves so
later specialists can challenge earlier findings; the hand-offs are durable
`research.lane.handoff` events. `safe` remains a single read-only specialist
pass.

Every specialist wave acquires a durable role lease before starting. The lane
heartbeat is refreshed while the provider is working, so a second controller
cannot duplicate a live role. If a process disappears, the next research wave
marks only expired leases as blocked and can recover them; live lanes remain
untouched. Queue tasks use the same ownership rule: a worker can heartbeat only
the task it claimed. Queue records also preserve optional goal and parent-task
links, so recovery and dashboard inspection retain the reason a job exists.
Tasks may also declare prerequisites; the scheduler leaves them queued until
all dependency IDs have completed, and treats missing dependencies as blocked.
Cycles are rejected when a task is enqueued, so a malformed decomposition
cannot silently consume campaign time.

Inspect dependency readiness directly:

```text
evidra queue status             Human-readable ownership and blocking reasons
evidra queue status --json      Machine-readable readiness for automation
evidra queue recover <id> --route <route>
                                Resume one failed task after declaring a changed route
```

Queued work reports `missing`, `waiting`, or `failed` prerequisites. This makes
the scheduler explainable to an operator and gives recovery controllers a
stable reason instead of treating every unclaimed task as ready.

When a task exhausts its bounded retries, the queue records a typed recovery
action instead of only a terminal error. Actions include reauthentication,
repair, refreshing data, reducing resources, using an alternate executor, or
changing route. `queue status --json` returns these actions under `recoveries`.
An operator can act on a terminal task explicitly with `queue recover`; this
resets only that task's bounded attempt counter and preserves the prior route
and reason in its payload and event history.

For recurring work, define a durable routine. A routine stores the goal,
provider route, autonomy policy, campaign budget, interval, last result, and a
runner lease. It can be driven by cron or another scheduler without launching
duplicate campaigns:

```text
evidra routine create --name nightly-literature --goal "find and test robust improvements" --every 1d --budget 4h --max-runs 14
evidra routine create --name recovery-review --goal "audit the latest recovery" --on-event research.agent_budget.exhausted
evidra routine list --json
evidra routine history <routine-id>
evidra routine run <routine-id> [--force]
evidra routine daemon           Poll and execute due routines continuously
evidra routine pause <routine-id>
evidra routine resume <routine-id>
evidra routine recover
```

`routine run` executes the same research controller used by the TUI and
advances the next run only after the child campaign exits. Manual runs use
`--force` (the TUI does this automatically); `routine daemon`
provides the native heartbeat loop; it polls due routines sequentially and
recovers expired runner leases. Expired leases are recoverable, so a machine
restart does not strand a routine.
Use `--max-runs N` to pause a routine after N completed runs; omit it (or use
`--max-runs 0`) for an unlimited routine. Reaching the cap emits
`routine.max_runs_reached` and requires an explicit resume or configuration
configuration change before more work can run. Change it with
`evidra routine max-runs <routine-id> <count>` or `/routine max-runs <id> <count>`.

If a matching event arrives while a routine is already running, Evidra records
one coalesced pending trigger and schedules the follow-up immediately after the
current run. It never starts concurrent runs for the same routine.

External integrations can wake a routine without writing directly to Evidra's
database. Only the `external.<source>.<event>` namespace is accepted, and the
payload is stored as a redacted wake-up signal rather than research evidence:

```text
evidra event emit external.github.push --payload '{"branch":"main"}' --idempotency-key push-123
/event emit external.ci.completed {"run":"1234","status":"success"}
evidra event serve --port 4311 --token "$EVIDRA_EVENT_TOKEN"
# Restrict an external worker bridge to one queue family:
evidra event serve --port 4311 --token "$EVIDRA_EVENT_TOKEN" --task-kinds research.lane
# Optional per-worker credentials:
evidra event serve --port 4311 --token "$EVIDRA_EVENT_TOKEN" --task-kinds research.lane \
  --worker-tokens 'agent-17=replace-with-a-secret'
```

Use `--worker-scopes` (or `EVIDRA_WORKER_SCOPES`) to apply queue-family
least-privilege per worker. The mapping format is
`worker-id=kind|kind,worker-id=kind`; unset scopes preserve the global bridge
behavior. A scoped worker cannot claim, heartbeat, or complete a task outside
its assigned kinds.

```bash
evidra event serve --port 4311 --token "$EVIDRA_EVENT_TOKEN" \
  --task-kinds research.lane,research.review \
  --worker-tokens 'lane-1=lane-secret,review-1=review-secret' \
  --worker-scopes 'lane-1=research.lane,review-1=research.review'
```

`event serve` accepts `POST /events` with `{ "type": "external.ci.completed",
"payload": { ... }, "source": "ci", "idempotencyKey": "run-123" }`. It binds
to loopback by default; a non-loopback bind requires a bearer token
(`Authorization: Bearer ...`). The `Idempotency-Key` header is also accepted;
retries with the same key and event type are acknowledged without appending a
second event or waking a routine again. `GET /health` reports event-chain
integrity for liveness checks.

External workers may also report liveness through the authenticated endpoint:

```json
{"type":"external.agent.heartbeat","payload":{"role":"model researcher","leaseId":"worker-17","provider":"claude","model":"sonnet","status":"running","task":"inspect methods"},"source":"agent-bridge"}
```

Evidra accepts only the owning lease, records accepted/rejected heartbeat events,
and never grants the external worker controller or submission authority.

Authenticated external workers may also participate in the durable queue:

```text
POST /tasks/claim     {"workerId":"agent-17","kinds":["research.lane"]}
POST /tasks/heartbeat {"workerId":"agent-17","taskId":"task-123"}
POST /tasks/complete  {"workerId":"agent-17","taskId":"task-123","status":"completed","payload":{"summary":"..."}}
```

Claim, heartbeat, and completion all enforce the queue owner. A stale or foreign
worker receives a conflict response and cannot overwrite another worker’s task.
For scoped identity, configure `--worker-tokens 'agent-17=secret'` (or
`EVIDRA_WORKER_TOKENS`). Task calls must include `X-Evidra-Worker-Id`,
`X-Evidra-Worker-Token`, and the same `workerId` in the JSON body.

Configure a routine with `--on-event external.github.push` (or the equivalent
TUI routine flow). The event is hash-chained, wakes matching active routines,
and remains visible in the event timeline for audit and replay.

For long campaigns, bound each specialist independently:

```text
evidra research --lane-budget 20m --lanes 4 --budget 4h
evidra challenge start --lane-budget 30m --lanes 3
```

The lane budget is a wall-clock cap for one leased specialist, not a claim
about provider billing. Evidra records elapsed usage and calls, stops the lane
before another provider turn after exhaustion, and preserves its partial
evidence for recovery or a different route.

```text
/research start               Start autonomous research setup
/research pause               Pause active research workers
/research resume              Resume the saved research campaign
/research stop                Stop the research campaign safely
/research status              Show research campaign state
/challenge start              Start autonomous challenge work
/challenge pause              Pause active challenge workers
/challenge resume             Resume the saved challenge campaign
/challenge stop               Stop the challenge campaign safely
/challenge status             Show challenge campaign state

/benchmark literature-score <file>  Score deep/wide literature discovery and grounding
/benchmark autoresearch <file>     Import official AutoResearchBench deep/wide evaluation JSON
/benchmark scientific <file>      Run a stepwise scientific-task contract with verifiers
/telemetry export                  Export durable runs as secret-free MLflow-shaped JSON

The same command is available in the full-screen TUI through `/` completion.
Its JSON input is schema-validated before any benchmark result is persisted.

Literature benchmark reports are durable and are supplied to later autonomous
research cycles as diagnostic allocation evidence; they do not count as
workspace experiment proof.

Research lanes can also use an internal `web.search` tool for official
documentation, challenge discussions, dataset pages, and implementation leads.
Search results are candidates only; `source.retrieve` must fetch and checksum a
page before literature-derived claims can cite it.
```

These commands never authorize external submission. A stopped or interrupted campaign is saved and must be explicitly resumed.

Plain text is ordinary conversation and is handled by the selected provider without repository inspection or experiment execution. Use `/research` or an autonomous loop when you want Evidra to inspect evidence and act.

Research agents also have a bounded `artifact.audit` tool. It accepts up to 64
workspace-relative paths, rejects symlinks and non-regular files, checks file
size and SHA-256 integrity, and parses JSON artifacts when applicable. A valid
audit is an observation; it does not replace an evaluator or independent
replication.

## Project and challenge

```text
/project init <competition>   Initialize a project
/project status               Show project and challenge state
/project inspect              Show the active manifest
/challenge list                List configured challenges
/challenge init <id>          Initialize a challenge adapter
/challenge inspect            Show rules, metric, data, and evaluator
/challenge baseline           Run or inspect the canonical baseline
/challenge reset              Rebuild challenge metadata (never delete artifacts)
```

The initial adapter is `whestbench`. Future adapters include Kaggle, AIcrowd, manual, and local-only challenges.

## Research

```text
/research                     Ask for the highest-information next decision
/research next                Same as /research
/research status              Show active questions and unresolved edges
/research plan [--json]       Show or export the three-stage plan and phase progress
/research plan --history      Show structural phase-plan revisions
/research examples [--json]   Show or export contemporary starter briefs
/research start               Start autonomous research scheduling
/research pause               Pause only the research scheduler
/research stop                Stop scheduling and preserve state
/research propose <question>  Generate validated hypotheses
/research policy              Show route-scoped operator rankings, rewards/minute, cost, and failure rates
/research explain <id>        Explain why a hypothesis or experiment matters
/research compare <a> <b>    Compare two research directions
/research adapt <source>     Convert a source technique into a challenge hypothesis
```

## Sources and knowledge

```text
/sources                      List cached research sources
/benchmark score <file>       Score comparable harness trials from JSON
/benchmark run <protocol>     Execute matched harness arms and score them (`--parallel N` enables bounded concurrency)
/benchmark orchestration      Verify worker ownership, lease recovery, and lane budgets locally
/benchmark governance         Verify role boundaries, pause controls, and scoped handoffs locally
/benchmark compare <file> <challenger> <incumbent>
                              Require paired, task-balanced evidence for a win claim
/benchmark airs discover <repo>
                              Import and validate AIRS-Bench task contracts
/benchmark airs protocol <inventory>
                              Generate matched AIRS arms from harness templates
/benchmark export             Export durable Evidra runs as benchmark JSON
/sources discover <query>     Search scholarly literature for candidates
/sources frontier             Show deduplicated discovery and retrieval coverage
/sources search <query>       Search approved research sources
/sources add <url>            Cache a source for later retrieval
/sources show <id>            Show source metadata and extracted claims
/sources claims <id>         Show claims extracted from a source
/sources adapt <id>           Create an adaptation record for this challenge
/memory search <query>        Search prior claims, decisions, and experiment notes
/memory recent               Show recent evidence and decisions
/approvals                    Show the operator approval inbox
/guidance                     Inspect loaded project runtime guidance and hash
```

Project-local operator guidance can be placed in `EVIDRA.md` or
`.evidra/instructions.md`. Evidra bounds and hashes these files before adding
them to director and lane context. They are guidance, not evidence, and cannot
override permissions, validation, provenance, or approval gates.

Source retrieval records URL, retrieval time, content hash, license, claims, and the difference between the source setting and the current challenge.

## Hypotheses and research graph

```text
/hypotheses                   List hypotheses by priority/status
/hypotheses show <id>         Show mechanism, evidence, dependencies, and tests
/hypotheses rank              Recalculate cost-aware priority
/hypotheses approve <id>      Approve an implementation
/hypotheses reject <id>       Reject with a recorded reason
/hypotheses replicate <id>    Schedule an independent replication
/graph                        Show the active research graph
/graph edges <id>             Show supports/contradicts/dependency edges
```

## Agents

```text
/agents                       Show agent lanes and health
/agents list                  List roles and active threads
/agents logs <role>           Show role activity
/agents evaluate              Evaluate role trajectories and generate coaching interventions
/agents evaluate apply        Apply coach interventions as durable role directives
/agents cancel <id>           Cancel a pending directive before delivery
/agents message <role> <msg> Send a directed instruction
/agents restart <role>       Restart a disposable or stale lane
/agents limits                Show concurrency and model limits
/agents pause <role>          Pause a role at its next safe boundary
/agents resume <role>         Resume a paused role
/agents terminate <role>      Terminate a role until explicitly revived
/agents revive <role>         Revive a terminated role
/agents message <role> -- <msg> Queue a directive for one role's next safe boundary
/agents directives [role]     Inspect specialist handoffs and whether they were applied
/agents reviews              Show durable role review and intervention history
/agents activity [role]      Show recent durable specialist work activity
/agents sessions             Show resumable provider sessions by role and scope
/agents cancel <run>         Cancel a running agent task
```

TUI directives sent while a campaign is active are automatically scoped to its current
phase goal. Directives sent through the headless CLI are global by design; the inbox shows
the scope so this distinction is never implicit.

Roles are director, domain researcher, method researcher, data detective, validation scientist, model researcher, ensemble scientist, reproducibility engineer, experiment engineer, critic, and repair agent.

## Data and validation

```text
/data inspect                 Inspect manifests and schema
/data manifest                Create or refresh a hashed dataset manifest
/data audit                   Run the data-quality audit
/data duplicates              Find exact and near duplicates
/data shift                   Run train/test or domain-shift diagnostics
/data leakage                 Run the leakage auditor
/data report                  Show the latest data report

/validation inspect           Show the current split policy
/validation generate         Generate a versioned split
/validation lock              Freeze the policy checksum before experiments
/validation unlock <reason>   Unlock only with an auditable reason
/validation compare <a> <b> Compare split strategies
/validation lock              Lock the primary validation policy
/validation unlock            Unlock only with an approval record
/validation reveal-holdout    Reveal the untouched holdout (approval required)
```

## Experiments and runs

```text
/experiments                   List experiments by state
/experiment show <id>         Show manifest, parent, hypothesis, and evidence
/experiment propose <hyp>     Create an immutable experiment manifest
/experiment review <id>       Run an independent code/validity review
/experiment smoke <id>        Run tests and a cheap smoke job
/experiment run <id>          Schedule or run the experiment
/experiment replicate <id>   Create a fresh-seed replication
/experiment compare <a> <b>  Compare results and slices
/experiment audit <id>       Run evidence and leakage gates
/experiment promote <id>     Promote only if all gates pass
/experiment reject <id>      Record a rejection without deleting artifacts

/runs                         List active and recent runs
/run show <id>                Show logs, metrics, artifacts, and failure class
/run logs <id>                Stream or inspect worker logs
/run cancel <id>              Cancel a run safely
/run retry <id>               Retry according to failure policy
```

## Compute and autonomy

```text
/compute status               Show local GPU/CPU and Modal health
/compute budget               Show GPU-hour, monetary, LLM, and submission budgets
/compute policy               Show executor and concurrency policy
/compute local                Select local execution
/compute modal                Select Modal execution
/compute cancel <run>         Cancel a remote run
/queue                        Show scheduler queue and priorities
/scheduler start              Start scheduling
/scheduler pause              Pause scheduling
/scheduler drain              Finish running jobs without starting new ones
```

## Evidence, metrics, and ensembles

```text
/evidence                     Show accepted evidence
/evidence show <id>           Show claim provenance and supporting runs
/evidence invalidate <id>    Invalidate contaminated or superseded evidence
/metrics <run>                Show metrics by fold, seed, and subgroup
/metrics recompute <run>     Recompute metrics independently
/metrics compare <a> <b>     Show deltas and uncertainty

/ensemble candidates          List OOF prediction artifacts
/ensemble diversity           Show error and prediction correlations
/ensemble propose             Propose a diversity-aware blend
/ensemble evaluate <id>      Evaluate only on OOF predictions
/ensemble promote <id>       Promote a validated blend
```

## Submissions and reports

```text
/submission prepare <exp>    Build a reproducible submission bundle
/submission validate <id>    Run schema, checksum, and rule checks
/submission approve <id>     Approve an external submission
/submission submit <id>      Submit through the configured adapter
/submission record <id> <s> Record an external score with provenance
/submission status            Show limits and submitted questions

/report daily                 Generate a daily research report
/report research              Generate the research graph report
/report challenge             Generate the challenge progress report
/report final                 Generate final provenance and model card
/export                       Export a portable research bundle
/bundle validate <path>       Validate a bundle without importing evidence
```

## Providers and configuration

```text
/provider                     Show provider health and fallback policy
/provider codex               Use authenticated Codex
/provider local               Use Ollama/local model
/fallback [model]             Choose the installed local fallback model
/model                        Open the live model picker
/thinking                     Open the model-specific thinking picker
/login codex                  Authenticate Codex by device code
/login status                 Show authentication status without exposing tokens
/config                       Show effective configuration
/config validate              Validate project configuration
/doctor                      Diagnose Node, Python, uv, Ollama, Codex, and Modal
/doctor --json               Export machine-readable diagnostics for automation
```

Provider limits are part of scheduling. The default `auto` policy uses the configured local model when Codex reaches a usage/rate limit; if no local model is available, it waits durably for the provider reset window. `wait`, `fallback`, and `stop` remain explicit alternatives. Provider switches are recorded on the run and never change the experiment identity.

## Design rules

1. Read-only inspection commands never invoke an agent.
2. Research commands may create hypotheses and claims, but never silently edit challenge code.
3. Challenge execution always produces a manifest, run record, logs, and artifacts.
4. Promotion, paid compute, credential use, holdout reveal, and external submission are policy-gated.
5. No command deletes research artifacts; invalidation is a state transition.
6. Every mutating command appends an event and can be replayed after a crash.
