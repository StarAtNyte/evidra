# Harness production verification — 2026-09-30

This report records verified reliability work in the current dirty checkout. It
is not a release certification or a comparison claiming Evidra beats another
harness.

## Production bug fixed

`auditExperiment` exposed `replicationObserved` and `externalScoreObserved` as
gates, but the final acceptance reason list did not reject either false value.
An experiment configured to require replication or an external grade could
therefore have been reported accepted while the required evidence was absent.

The audit now rejects those cases explicitly. File-backed verification audits
also require a syntactically valid implementation-source path and SHA-256 pin;
the gate is named `implementationSourcePinDeclared` to avoid claiming that the
audit itself rehashed the executed source. Execution-time seeding still performs
the byte-level checksum verification.

Regression coverage verifies that:

- a missing required external grade rejects the experiment, and observing the
  grade allows the gate to pass;
- a missing required replication rejects the experiment;
- a historical file-backed verification run without a source pin is rejected;
- a correctly shaped source pin satisfies the declaration gate.

The old unpinned 4-row ARC run is now blocked by this audit gate as well as its
other missing evidence gates. Its metric is not valid score feedback.

## Verification results

- `npm run check`: passed.
- `npm test`: 653 tests passed, 0 failed (re-run 2026-09-30).
- `npm audit --omit=dev --audit-level=high`: 0 vulnerabilities.
- `node dist/cli.js doctor --json`: `ready: true`; Codex authentication and the configured Modal CLI profile are available. Ollama API is unavailable, and optional Podman/Slurm executables are absent; those are environment capabilities, not blockers for the configured Codex/local execution route.
- Fresh npm tarball install under Node 22.19.0: `--version`, `init
  local-research`, and `status` succeeded; the initialized event chain reported
  `Integrity VALID`.
- Deterministic current-checkout boundary benchmarks: safety 9/9, orchestration
  24/24, governance 13/13; each reported score 1.0 and zero failed probes.
- `git diff --check`: passed.

## No-progress recovery follow-up

Campaign review found consecutive active `inspect` decisions that explicitly
reported the same observation/no new evidence but paraphrased their hypotheses
and next actions, evading exact-text stagnation detection. The stagnation guard
now detects two consecutive same-phase inspect decisions with an explicit
no-new-evidence signal and routes them through the existing diversify-then-pause
recovery. Ordinary exploratory inspections and phase transitions remain
unaffected in regression cases.

- `npm run check`: passed.
- `npm test`: **654 passed, 0 failed** after the change.
- Full production readiness remains unverified; this is one bounded autonomy
  reliability fix, not a release certification.

The CI workflow now tests Node 22.19.0 and Node 24.x, installs the packed
production artifact, and exercises the first-project initialization/status
path in a fresh temporary workspace for each runtime.

## Node 24 follow-up

- On Node 24.14.0, `npm run check` passed.
- A full-suite attempt against the shared checkout failed because its
  `better-sqlite3` native addon was compiled for Node 22 (`NODE_MODULE_VERSION
  127` rather than Node 24's `137`). This was a runtime-artifact mismatch, not a
  clean-install result; the shared addon was left untouched while the campaign
  controller was live.
- A fresh packed-artifact install under Node 24.14.0 rebuilt the native addon,
  then passed `evidra --version`, `evidra init local-research`, and `evidra
  status` with event-chain integrity `VALID`.
- The full Node 24 regression suite is delegated to the new clean-install CI
  matrix lane and is not claimed as locally passed here.

## Operator steering: explicit evidence paths in specialist lanes

The specialist lane runner previously consumed an operator directive at a
tool boundary and added its text to the model prompt, but did not schedule a
workspace read for a file path named in that directive. Because specialist
lanes use a bounded controller-owned prefetch rather than an open-ended tool
loop, the model could be told to inspect a report that it had never received.

The lane runner now extracts workspace-relative file paths from each received
directive with the existing strict path parser, deduplicates them against
already scheduled reads, and executes bounded `workspace.read` calls at the
next tool boundary. Hidden, absolute, and traversal paths remain rejected.
A regression test queues an explicit report path and verifies that the
controller actually reads the file before the lane proceeds.

- `npm run check`: passed after the change.
- Focused regression test: passed.
- Full `npm test`: **653 passed, 0 failed** after the change.
- `git diff --check`: passed.

## Scope and remaining proof

These checks establish regression and lifecycle behavior for the tested cases;
they do not prove full production readiness, matched harness superiority, or
that Evidra improves scientific outcomes. Those require clean release testing,
recovery/provider-exhaustion drills, and matched multi-task external benchmark
trials with model, seed, effort, evaluator, and budget held constant.
