# Production readiness audit

This is a release audit for the general Evidra harness. Passing an internal
suite establishes the boundaries that suite exercises; it does not establish
external benchmark performance or unattended reliability across all providers.

## Paper alignment

[An Empirical Study of Harness Design for Coding Agents](https://arxiv.org/pdf/2609.20804)
separately studies planning, action interfaces, and context management. Its
staged policy elides older observations before summarizing, preserving the
task preamble and recent turns. The main context benefit is preventing
overflow. Planning and tool-interface gains depend on the model and task;
recoverable elision did not improve accuracy in the reported experiments.
The study explicitly limits transfer beyond its tested models and coding tasks.

For Evidra, the implementation consequences below are engineering hypotheses
to verify, rather than a claim that the paper measured this harness.

| Boundary | Current evidence | Remaining verification |
| --- | --- | --- |
| Persistent planning | Campaign/phase state is durable and injected into director context; current steering and phase state precede bulk observations. | Matched planning ablations on research tasks, including early stopping and redundant verification. |
| Context overflow | `boundResearchContext` budgets serialized JSON, including escaped text, keys, punctuation, and bounded report metadata. Provider prompts use the same compact representation. | Model-specific token headroom and provider-retained transcript growth. The character ceiling covers Evidra's context payload; objective text, schema, instructions, and resumed provider history are additional input. |
| Recent feedback | Latest feedback receives space ahead of older history; shortened tool observations preserve name, success status, trust, and an explicit truncation flag where supplied. Complete original values are not mutated. | Measure evidence loss and valid progress across small and large provider windows. |
| Staged compaction | Deterministic section/observation packing exists. | No independent T0–T4 transcript-policy implementation or matched result is claimed. Provider-owned compaction must be distinguished from Evidra-owned packing before an ablation. |
| Action interfaces | Typed research tools and guarded shell observations exist. The isolated executor owns mutations and evaluators. | A shell-only comparison must hold permissions, workspace checks, diagnostics, and evaluator contracts fixed. |
| Execution substrate | Regressions cover cancellation, graceful zero exits, paused timeouts, resistant descendants, callback errors, spawn errors, output draining, and Unicode byte caps. | Backend-specific cancellation and recovery under live container, Modal, and Slurm workloads. |
| Comparative claims | Task-balanced, matched protocols and conservative claim gates exist. | Real matched external trials and independent repetitions; local regression success is insufficient. |

## Execution contract

`runProcess` resolves after the launcher closes and process-group cleanup has
completed. A timeout returns code 124, explicit interruption returns 130, and
early stopping returns a nonzero result even when a worker's shutdown handler
exits zero. It drains shutdown evidence before returning, resumes a paused group
before termination, and escalates resistant workers. Synchronous registration
or output-callback exceptions reject after cleanup and remove signal listeners.

Captured stdout and stderr each obey a 16 MiB byte ceiling, including the
truncation marker. UTF-8 decoding spans pipe chunks; retained head/tail previews
end on complete code points. The cap preserves startup diagnostics and final
metric lines without changing durable success gates.

Local process groups are a cleanup mechanism, not an isolation boundary.
Subprocesses that deliberately create another session can escape the group;
pipe draining remains bounded, but stronger containment requires the configured
container or remote execution backend.

Timeout durations include termination/drain time. Resistant workers can require
the 1.5-second escalation grace and a further 0.5-second descendant cleanup;
this time remains in the recorded runtime rather than being hidden from budgets.

Early-stopping telemetry retains one progress point and a streak counter rather
than an ever-growing observed curve. Its line buffer is capped at 65,536
characters; an oversized record is discarded through its newline, and resets
patience rather than turning a clipped suffix into a metric. Late or corrected
steps also reset patience; identical latest-step repeats cannot inflate it.
Ordered stream decisions match the batch rule in both metric directions, while
the configured policy/reference are copied at launch. Reference lookup is
binary search over one pre-sorted curve. Numeric telemetry must be finite and
nonblank, and metacharacters in metric names are interpreted literally.

Slurm submissions disable scheduler requeue so retry ownership remains with
Evidra. Accounting must identify the exact allocation, a terminal state, and
the actual status/signal pair; `COMPLETED` alone does not establish success.
Control queries follow the cluster in the submission receipt. Cancellation
callers join one request before accounting is collected. Queue errors and
unconfirmed submission/completion outcomes cannot enter an automatic retry
route. Deadline expiry remains code 124; operator interruption remains 130.
Worker log previews read bounded head/tail bytes and reject symlink paths.

Fake CLI regressions establish these protocol contracts, without establishing
live cluster recovery. Accounting visibility can lag cancellation; an absent
terminal record is reported as unconfirmed and requires reconciliation.
Live allocation fencing across controller restarts and remote pause/resume
remain unverified: the current pause control only pauses a local polling process.

Restart recovery now quarantines stale container, Modal, and Slurm experiments
as blocked with durable `remoteReconciliationRequired` state. A lost heartbeat
does not prove worker termination. Quarantined records cannot be scheduled,
run, or marked complete through normal experiment updates; CLI and TUI replay
paths reject them before execution. Their compute reservations remain held
through terminal-looking updates and reservation reconciliation. Local stale
work retains its bounded retry path. A SIGKILL regression verifies durable
quarantine and reservation retention after reopening SQLite.

This is a conservative restart fence, not completed remote recovery. Backend
terminal-state verification and quarantine release for ambiguous submissions
and other executor types are still required. It prevents replay of the quarantined
experiment; it does not establish that remote workers have stopped or prohibit
all new experiments in an unlimited-budget campaign.

The Slurm route now records `run.remote.submitting` before launch,
`run.remote.submitted` with job/cluster identity before polling, and
`run.remote.terminal` only after exact terminal allocation accounting. All
three share a unique submission ID. Ledger-write failure before launch aborts
submission; failure to persist a receipt triggers cancellation and fails the
run. Both CLI and TUI execution wire this mandatory ledger independently of
best-effort heartbeats.

`evidra experiment reconcile <id>` can release a Slurm restart quarantine
when the event chain is valid and every recorded intent has exactly one
matching receipt and terminal record. Extra, missing, mismatched, and ambiguous
records retain quarantine. Reconciliation releases reserved compute and leaves
the measurement failed/unvalidated with its bounded recovery path available.
It also queries known unresolved allocations after restart using the unique
allocation name. Submission ambiguity, legacy identity gaps, live cluster
verification, and container/Modal reconciliation remain open.

The same allocation-evidence check now protects normal finalization and compute
release, without waiting for a restart. An unconfirmed Slurm ledger blocks
running/scheduled/completed updates; failed, invalid, rejected, cancelled, or
blocked updates retain a reconciliation fence and their original requested
status in `remoteOutcomeStatus`. Direct reservation release and reservation
recovery retain that compute until matching terminal evidence exists and the
quarantine is reconciled. CLI/TUI replay checks consult the ledger even before
a quarantine flag has been materialized. Allocation lookups use an indexed
experiment-specific query, with a compatibility fallback for SQLite JSON1.

Slurm allocations now use a UUID-based job name stored in every lifecycle
record. Both normal accounting and post-restart queries request duplicate
records and match this identity as well as the numeric job ID. A different
allocation reusing the ID cannot provide termination evidence. Multiple
records for the same identity remain unconfirmed.

`experiment reconcile` now queries unresolved, known Slurm receipts on their
recorded cluster, with a fifteen-second budget across query launches (plus
local process cleanup). It records terminal proof idempotently and releases
quarantine only after every intent is covered. Running jobs, query failures,
missing identities, and ambiguous submissions stay fenced. Legacy lifecycle
records without the unique allocation name cannot release quarantine under
the strengthened identity contract. No cancellation or worker relaunch occurs
during this accounting operation. Fake-CLI regressions cover successful and
failed terminal jobs, reused IDs, duplicate identities, empty/nonterminal
accounting, nonzero query exits, absent receipts, legacy records, and timeouts.
Live cluster recovery and container/Modal reconciliation remain unverified.

## Release checks

Container execution sets the declared executable as `--entrypoint`, preserves
the remaining argv verbatim, and disables image health checks. Empty or invalid
commands fail rather than falling back to an image's default startup command.
Images provide dependencies without replacing the registered worker command.
Exact-ID cleanup also removes anonymous image-created volumes with `--volumes`.
A local Docker probe used a temporary image with observable entrypoint and
healthcheck hooks and an inherited anonymous volume: the declared argv ran,
both hooks remained absent, and independent daemon queries confirmed removal
of the container and its anonymous volume. See
[recorded evidence](research/evidence/container-image-contract-2026-10-11.json).
This evidence is specific to local Docker; Podman and crash recovery remain open.

Container runs use a unique name and private controller-side `--cidfile`,
retaining the full ID through explicit cleanup. After the launcher settles,
Evidra force-removes that exact ID and queries all daemon containers to verify
its absence. Timeout/interruption remain 124/130 even through graceful exits;
cleanup time is included in runtime. Missing IDs and failed/nonempty daemon
queries produce an unconfirmed, nonretryable outcome even when the client
exited zero. Name-based removal is best-effort when no receipt exists and
cannot establish termination because submission may still be in flight.
Launch and cleanup use one controller-side client-environment snapshot, so
endpoint overrides such as `DOCKER_HOST` cannot select different daemons.
The controller environment is not passed wholesale through worker `--env`
arguments; explicit experiment metadata remains the worker contract.

Mock regressions cover completion, timeout, interruption, removal/query failure,
and missing receipts. Local Docker 29.8.1 also passed live completion, timeout,
and interruption probes using the preinstalled `postgres:16-alpine` image,
with independent daemon queries confirming each exact container was absent;
see [recorded evidence](research/evidence/container-cleanup-2026-10-11.json).
This does not establish Podman behavior or controller-crash recovery. Durable
container identity/reconciliation and retention of compute for unconfirmed
active container outcomes remain required follow-up work.

The local Ollama route shares one endpoint resolver for discovery, health,
and chat, including base hosts, trailing slashes, proxy prefixes, and legacy
`/api/chat` URLs. Structured schemas are sent as `format`; invalid schema JSON
is rejected before inference. Non-streaming replies require `done: true` and
an absent or `stop` finish reason. Partial, length-limited, error, and non-text
responses cannot establish success. Valid reported prompt/output/cache counts
are attributed even when the completion gate rejects the response. Missing
usage stays unknown. Pre-aborted calls send no request, and callback exceptions
release signal listeners and timers.

These contracts do not establish local tokenizer limits or prevent server-side
input truncation. Explicit model/context metadata, generation headroom, and
provider-owned transcript growth remain part of the next token-budget gate.

Local discovery and model-health probes have a ten-second deadline per request,
including JSON body decoding; shorter caller timeouts are respected. Startup
and fallback selection propagate interruption into these probes. Invalid
inventory/metadata fails health checks, and interruption during fallback is
preserved rather than returned as the original provider exhaustion. Tests
cover servers that stall before headers, during inventory bodies, and during
model-health bodies. A multi-request startup path can consume multiple probe
deadlines; these bounds do not claim one end-to-end startup deadline.

Git and ripgrep (`rg`) are required workspace runtimes in addition to Node.
The installer checks both before downloading; `doctor --json` includes
`requiredTools` and does not report overall readiness when either is missing.
Optional backend probes must remain diagnostic when their CLIs are absent.
CI provisions ripgrep explicitly rather than depending on runner-image contents.

Run against the final source tree:

```sh
npm ci
npm run check
npm test
npm run build
node dist/cli.js benchmark safety --json
npm audit --omit=dev --audit-level=high
git diff --check
```

The package must also be packed and installed with `--omit=dev` in a fresh
directory, then exercised from an independent workspace: `--version`, `--help`,
`init local-research`, `status`, `integrity events --json`, and a SQLite backup.
CI checks Node 22.19.0 and Node 24; a local Node 24 pass does not prove the
minimum-version job passed.

### Verified on 2026-10-11

At commit `6d66564`, Linux with Node 22.19.0 and Node 24.21.0 passed
typechecking, compilation, all 687 regression tests on each runtime, and all
nine local safety probes. The Node 22 checks ran after a clean dependency
installation in an independent source copy. The whitespace check passed, and
the runtime dependency tree had zero audit findings. A fresh
production-only package installation passed version/help, project initialization,
status, event-chain verification (`valid`, one checked event), and SQLite backup
creation. The installed package's backup reopened independently with a valid
event chain. Hosted CI, remote execution, soak behavior, and external performance
are not established by those results.

The first hosted run of that commit exposed a missing ripgrep prerequisite and
a Modal-absent `doctor` crash. The follow-up adds the required-tool preflight,
explicit CI provisioning, and a minimal-PATH diagnostics regression. Preserve
the [failed run](https://github.com/StarAtNyte/evidra/actions/runs/38115532722)
as failure evidence; a local full-suite pass did not prove runner compatibility.

The follow-up tooling fix at `ffc4b7e` passed all 689 tests on both hosted Node
22.19.0 and Node 24 jobs, including production package checks in
[CI run 38115887237](https://github.com/StarAtNyte/evidra/actions/runs/38115887237).
This establishes hosted compatibility for that commit, while the remaining
remote execution and external performance gates stay open.

## Next production gates

1. Audit full provider input growth, including resumed threads, objectives,
   schemas, and role guidance; reserve generation headroom using actual model
   limits without modifying task intent or evaluation contracts.
2. Exercise live cancellation, timeout, and restart recovery for each supported
   executor. Verify remote jobs terminate before retries can overlap them.
3. Run crash/restart and soak campaigns with immutable evaluator contracts,
   record recovery and valid-run rates, and reopen backups independently.
4. Run hosted CI and real matched harness trials before release
   or comparative performance claims.

These gates remain open. This audit does not declare the overall production
goal complete.
