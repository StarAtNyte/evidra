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
Durable allocation fencing across controller restarts and remote pause/resume
remain open: the current pause control only pauses a local polling process.

## Release checks

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
