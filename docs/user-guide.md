# Evidra user guide

Evidra is a Codex-first terminal workbench for long-running research and
challenge programs. It keeps ordinary conversation lightweight, and only
starts inspection, source retrieval, coding, experiments, evaluation, or
submission workflows when you explicitly invoke them.

The important distinction is:

```text
normal text       → conversational Codex turn
/research         → autonomous evidence and experiment loop
/challenge        → autonomous challenge loop
!command          → explicit terminal command
```

## 1. Install and start

Evidra requires Node.js 22.19 or newer. With `nvm`:

```bash
nvm install 22
nvm use 22
npm install
npm run build
npm link
evidra
```

On a fresh machine, the first-run flow should verify the available provider
before starting work. Codex authentication is managed by the Codex CLI:

```bash
codex login
codex login status
```

Inside Evidra, use `/login codex` to check or complete the Codex route. Login
runs asynchronously, so the TUI remains responsive while the Codex device or
browser flow is active; interrupting the process terminates the login child.
A local
route is available when Ollama is installed and has a model. Evidra does not
pretend that a provider is connected: unavailable routes are shown as
unavailable and no model request is started.

If Codex is installed outside `PATH`, set `EVIDRA_CODEX_BIN` to the executable
path. Evidra uses that same binary for login, model discovery, steering, and
SDK-backed turns; `/doctor` reports the resolved binary as well.

## 2. The Codex-first TUI

The full-screen interface uses a compact Codex-style transcript:

```text
·  Evidra Research Director — type /help for commands.

›  hi
•  Hi! How can I help?

›  /research start
•  Autonomous research setup · Step 1/3
```

Normal conversation does not inspect the repository or launch an experiment.
The input bar accepts pasted multiline text, `/` commands, and `!` shell
commands. Command suggestions filter as each character is typed; Tab accepts a
suggestion and moves the cursor to the end of the completed command.

While work is active, Evidra displays concise progress for reasoning summaries,
plans, source searches, MCP tools, file changes, commands, tool failures, and
experiments. Raw provider event IDs and credential-bearing arguments are never
shown in the transcript. Escape stops
the active process and its child workers, records an interruption, and leaves
the campaign resumable. Ctrl-C clears non-empty input; with an empty input it
interrupts or exits according to the current state.

## 3. Provider, model, and thinking effort

Select these interactively instead of memorizing configuration variables:

```text
/provider       Choose Codex or local Ollama
/login codex    Authenticate/check Codex
/model          Open the available model picker
/model <name>   Select a model directly
/thinking       Select reasoning effort
```

The default route is Codex with `gpt-5.6-luna` and medium thinking effort. The
available model list is refreshed after login. Evidra explicitly selects Luna
after provider or login transitions so a server-side account default cannot
silently select a different model. Model and provider changes invalidate the
active chat thread to prevent context crossing routes.
The thinking-effort picker is derived from the selected model's supported
efforts when Codex provides that capability, and an unavailable model ID is
rejected before a turn starts.

If model discovery fails, `/model` reports whether the Codex route or local
Ollama route is unavailable and gives the next corrective action; it does not
display raw provider protocol output or start a request against an unknown
model.
Authentication checks are asynchronous, so an unavailable Codex installation
does not block the TUI while it waits for a subprocess timeout. Normal turns
perform that check once at the provider boundary rather than duplicating it in
the UI layer.

An ordinary terminal session reuses one Codex thread so conversation context
and steering are preserved. A new terminal starts a fresh chat. Saved sessions
remain available, but restoration is explicit:

```text
/sessions
/resume
/resume <session-id>
```

Session-scoped permissions and active threads do not leak into a new terminal.
Project state, campaign state, evidence, artifacts, and event history are
durable and can be resumed.

## 4. Permissions and provider exhaustion

Permission policy is selected per terminal session:

```text
/permissions safe    Approval-gated execution and external actions
/permissions fast    Automatically run routine local work
/permissions yolo    Maximum bounded automation; external actions still gate
```

Safe mode is the default. YOLO does not bypass evaluator integrity, worktree
isolation, credential stripping, budgets, artifact checks, or external
submission approval.

Codex usage exhaustion is also explicit and durable:

```text
/limits auto         Use local fallback, then wait for Codex reset
/limits fallback     Require local fallback
/limits wait         Pause and continue after the entitlement resets
/limits stop         Stop when Codex becomes unavailable
```

Retries are bounded. Transient provider, timeout, stream, and tool failures
retry with backoff; exhausted routes are recorded and the director can choose
another route. A campaign's remaining time and compute budget remain hard
limits, even when the provider reset window is long.
If an ordinary Codex chat turn falls back to local Ollama, Evidra announces the
route change and resets the Codex conversation thread so later messages do not
resume context that omitted the fallback response.

## 5. Research mode

Start research with a goal, not an open-ended chat request:

```text
/research start
```

The setup asks for the ultimate goal, stopping condition, and budget. Evidra
then derives internal phase goals automatically. A campaign progresses through
orientation, evidence, hypotheses, implementation, validation, replication,
and promotion as appropriate for the task. It continues until a verifiable
goal is met, the stopping condition is satisfied, the budget is exhausted, or
it is genuinely blocked.

The director can inspect files, search the workspace, inspect Git, audit data,
retrieve primary sources, read challenge discussions, run commands, write code
in an isolated worktree, execute an evaluator, analyze artifacts, and use the
results in its next reasoning turn. It records hypotheses with mechanisms,
tests, expected outcomes, costs, risks, dependencies, and falsification rules.
Research-director, independent-lane, and critic turns use the Codex SDK's
structured-output schemas, so phase, decision, report, review, hypothesis, and
tool-call fields are constrained at the model boundary before Evidra applies
its own durable schemas and evidence gates.

Codex-native activity is also copied into the cycle trajectory as bounded
`process` events. Commands, searches, file changes, plans, and reasoning
milestones remain available for audit and later harness adaptation after the
TUI closes. The activity is compact and secret-redacted; raw provider protocol
events, credentials, and unbounded tool payloads are not persisted.
Native command, file-change, and tool failures are also included in the
trajectory's deterministic recovery score, so a cycle cannot look clean merely
because the failed action came from Codex rather than Evidra's typed tool loop.

Independent lanes explore different formulations and roles. Their evidence is
cross-pollinated through a bounded board, while shared citations are not
counted as independent corroboration. A critic and replication gate review
promising decisions before promotion.

Useful controls:

```text
/research status     Show phase goal, blockers, and evidence
/research pause      Pause workers and preserve state
/research resume     Continue the saved campaign
/research steer ...  Send guidance at the next safe tool boundary
/research stop       Stop scheduling without deleting artifacts
/loop start          Run repeated autonomous cycles
/loop pause          Pause repeated scheduling
/loop stop           Stop the loop safely
```

Steering is separate from queueing. While Evidra owns a tool loop, a new user
message can be delivered at the next safe boundary and influence the active
turn. If the provider is inside an opaque subprocess, the message remains at
the bottom as queued until the provider exposes a boundary; Evidra never starts
a concurrent second agent for the same campaign. The Codex queue request itself
is asynchronous and timeout-bounded, so steering cannot freeze the TUI.

## 6. Challenge mode

Challenge mode changes the active workbench mode automatically:

```text
/challenge start
/challenge https://example.com/competition
```

The challenge workflow discovers the rules, data, evaluator, metric, split
policy, discussions, forums, leaderboard information, and submission contract
when those sources are accessible. Dynamic sources are refreshed during
observation cycles and retained with timestamps and hashes.

The zero-to-hero path is autonomous:

```text
/hero start
/challenge inspect
/challenge audit
/challenge baseline
```

It audits the workspace, reproduces the canonical baseline, proposes a
validation policy, generates hypotheses, implements candidates in isolated
worktrees, runs the evaluator, compares metrics and slices, schedules
replication, and prepares—but does not silently send—external submissions.

Pause and resume are first-class for challenges as well as research:

```text
/challenge status
/challenge pause
/challenge resume
/challenge steer try a cheaper validation route first
/challenge stop
```

The initial WhestBench adapter is only a trial adapter. The contract is generic
enough for ML, data science, algorithmic, scientific, software, and other
challenge workspaces.

## 7. Experiments and execution

Experiments are immutable measurement identities. A candidate is proposed with
a hypothesis, code change, dataset/split versions, metrics, folds/seeds,
resources, and expected outcome. Evidra executes it in a dedicated worktree
and records logs, artifacts, checksums, environment metadata, and failure
classification.

Choose where the worker runs:

```text
/compute local       Local process
/compute container   Isolated Docker/Podman worker
/compute modal       Modal worker for heavy CPU/GPU work
/compute status       Provider and executor health
/usage               Model, wall-time, GPU, and campaign usage
```

Workers receive a redacted experiment contract through
`EVIDRA_EXPERIMENT_CONFIG` and `EVIDRA_EXPERIMENT_ID`. Controller credentials
are removed from worker environments. Container workers mount only the
isolated worktree and disable network access by default. Modal workers use the
same artifact, metric, retry, and evidence gates.

The controller can also run headlessly in Modal for unattended campaigns. That
mode has no interactive approval channel, so external actions must be reviewed
from a trusted local session.

## 8. Evidence, validation, and submissions

Evidra separates observations, claims, hypotheses, decisions, experiments,
runs, and promoted results. Source claims retain URL, retrieval time, content
hash, provenance class, and source-to-claim edges. Retrieved text is untrusted
until it is checked and extracted into the evidence graph.

Validation gates include data leakage checks, protected evaluator fingerprints,
exact fold/seed coverage where declared, secondary metric non-regression,
replication, code health, artifact checksums, task-balanced comparison, and
claim-audit status. Unsupported or conflicted claims cannot complete an
autonomous goal.

External submission is deliberately separate:

```text
/submission prepare <experiment>
/submission validate <bundle>
/submission approve <bundle>
/submission submit <bundle>
/submission poll <bundle>
/submission reconcile <bundle> --status submitted|not-submitted
```

An ambiguous crash creates a durable external-action intent and refuses
restart-time replay until the operator reconciles it.

## 9. Research memory and reports

The durable SQLite store and append-only event log preserve state across
restarts. Inspect it through the TUI or CLI:

```text
/status                 Project and campaign summary
/workbench               Graph, goals, budgets, and active work
/sources                 Cached source frontier
/memory recent           Recent evidence and decisions
/evidence audit          Claim completion blockers
/queue status            Queued, running, stale, and failed tasks
/report research        Research graph report
/report challenge       Challenge progress report
/report final           Provenance and model-card report
/telemetry export        Secret-free MLflow-shaped run telemetry
```

Generated reports include provenance coverage, claims, metrics, artifacts,
runtime, failure classes, and the quality/reliability/time frontier. Reports
are diagnostic evidence; they do not replace an evaluator or replication.
Codex usage telemetry preserves input, output, cached-input, and
reasoning-output token counts so model and thinking-effort comparisons include
context reuse and reasoning cost. The CLI and TUI use the same durable usage
aggregator, so their totals cannot drift as provider fields evolve.

## 10. Safety and operational rules

Evidra is autonomous inside explicit boundaries:

- normal text never silently becomes a research campaign;
- every campaign has a goal, phase goals, stopping condition, and budget;
- retries and concurrency are bounded by policy and available resources;
- experiments run in isolated worktrees and cannot mutate the controller
  checkout;
- evaluator/configuration integrity is checked before execution;
- credentials are redacted from logs, argv, progress, and worker environments;
- external submissions require explicit approval;
- interrupted, failed, blocked, and abandoned work remains resumable evidence;
- no result is promoted from narrative alone.

For the complete command catalog and lower-level contracts, see
[`command-surface.md`](command-surface.md). For the architecture and project
handoff state, see [`CONTINUATION-GOAL.md`](CONTINUATION-GOAL.md).
