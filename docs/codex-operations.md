# Codex operations guide

Evidra is Codex-first: Codex supplies the reasoning and implementation
capability, while Evidra owns the long-running research state, permissions,
experiments, evidence, and recovery. This document describes the operational
contract so a campaign can be run for minutes or days without relying on the
terminal transcript as state.

## Runtime model

There are three distinct Codex uses:

1. **Conversation** — ordinary text is a normal Codex chat turn. It does not
   inspect the repository or start research.
2. **Research roles** — `/research start` creates bounded director, lane, and
   critic turns. These receive controller-owned context and structured output;
   they do not edit the active workspace.
3. **Experiment engineer** — after the controller selects a hypothesis, Codex
   works in a disposable Git worktree with `workspace-write`, then Evidra runs
   the evaluator and decides whether the result is evidence.

The controller never accepts a model's prose as proof. A result must pass the
declared evaluator, artifact and integrity checks, validation policy, and any
replication or reviewer gates.

Director structured output also caps each reasoning round at eight tool calls,
matching the local decision schema before Evidra executes anything. This keeps
provider-side tool fan-out bounded as well as controller-side execution.

Long-running context retrieval is hybrid: durable claims and hypotheses are
ranked using the SQLite FTS index when available, then deterministic lexical
overlap remains as a compatibility fallback. This keeps relevant old memory
available after migrations while giving exact multi-term findings priority.
The same ranking is now applied to the deduplicated literature sources passed
into autonomous director turns, not only to the interactive memory command.

```text
user prompt
  -> Codex turn
  -> typed decision / tool request
  -> Evidra permission boundary
  -> isolated worktree or executor
  -> evaluator and evidence audit
  -> durable event, checkpoint, and next decision
```

## First-run setup

Use Node 22 and the official Codex CLI authentication flow:

```bash
nvm install 22
nvm use 22
npm install
npm run build
npm link
codex login
evidra
```

Inside the TUI:

```text
/login codex      Check or complete Codex authentication
/provider         Select Codex or local Ollama
/model            Discover and select an available model
/thinking         Select the model's supported reasoning effort
/doctor           Diagnose executable, authentication, and executor setup
```

Evidra uses the resolved Codex executable consistently for login, model
discovery, steering, and turns. Set `EVIDRA_CODEX_BIN` when `codex` is not on
`PATH`. Authentication is checked asynchronously and is never faked: an
unavailable provider produces an actionable error without emitting provider
gibberish or starting a phantom progress loop.

The default Codex route is `gpt-5.6-luna` with medium effort. The model picker
shows discovered models, and direct selection rejects an unavailable model
before a request begins. Changing provider or model starts a fresh provider
thread so context cannot silently cross routes.

## Sessions, interruption, and steering

Every terminal starts a fresh interactive session. Evidra saves the session,
campaign, queue, and evidence state under `.sota`; restoration is explicit:

```text
/sessions
/resume
/resume <session-id>
```

Escape cancels the active process group, including child workers, records an
interruption, and leaves the campaign resumable. Ctrl-C clears non-empty input;
with an empty input it interrupts active work or exits the TUI.

The input queue follows Codex-style steering:

- A message submitted during an Evidra-owned tool loop is delivered at the next
  safe tool boundary.
- A message submitted while Codex is inside an opaque subprocess remains in the
  bottom queue until a boundary is available.
- It is never executed concurrently by a second agent for the same campaign.

Queued messages stay visibly below the transcript. They are not inserted into
the conversation until accepted by the active turn, and their state survives a
controller restart.

## Autonomy and permissions

```text
/permissions safe    Inspect and plan; require approval for execution
/permissions fast    Run bounded isolated local work automatically
/permissions yolo    Maximize bounded automation
```

Permission level is terminal-session scoped and resets to `safe` in a new
terminal. YOLO does not mean unrestricted shell access. The following remain
hard boundaries in every mode:

- destructive commands and destructive Git cleanup;
- workspace escape paths and symlink-based escape;
- evaluator/configuration tampering;
- ambient credentials in workers;
- unapproved external submissions, uploads, GitHub changes, and deployments;
- experiment budget, timeout, concurrency, and artifact contracts.

Codex research roles use read-only access. The engineer receives write access
only to its isolated worktree. Local/container/Modal workers receive a minimal
environment and no controller tokens, API keys, or user dotfiles.

## Long-running campaigns

Start a campaign with an explicit goal and stopping condition:

```text
/research start
/challenge start
/loop start
```

Evidra derives phase goals for orientation, evidence, hypotheses,
implementation, validation, replication, and promotion. It continues until a
verifiable goal is met, the stopping condition or budget is reached, or the
campaign is genuinely blocked.

Each major phase writes a validated checkpoint containing campaign id, cycle,
phase, timestamp, and scheduler state. On resume, an interrupted phase repeats
its current cycle; only `cycle-complete` advances to the next cycle. CLI and TUI
use the same checkpoint validator and constructor.

The SQLite state store uses WAL plus a bounded writer wait. This matters when
multiple Codex research lanes retrieve sources, record tool traces, or update
their lane status at the same time: brief writer contention is absorbed, while
a genuinely unavailable store still surfaces as an error.

```text
/research status
/research pause
/research resume
/research stop
/challenge status
/usage
/workbench
```

Pause stops new scheduling while preserving running state and artifacts. Stop
requests a safe shutdown and preserves the same evidence. A dead controller is
recovered through the durable lease; stale workers are finalized as failures
instead of remaining permanently `running`.

The budget is checked at the cycle boundary before dynamic-source ingestion,
workspace inspection, baseline execution, or another Codex turn. Resuming an
already-expired campaign therefore records a terminal budget checkpoint instead
of spending work after the deadline.

Terminal checkpoints also set the durable scheduler to `idle`; status cannot
report a completed campaign as still running merely because the checkpoint was
written after the campaign transition.

## Usage exhaustion and recovery

Codex subscription limits are finite. Select the desired behavior explicitly:

```text
/limits auto       Prefer local fallback, otherwise wait for reset
/limits fallback   Switch to an installed local model
/limits wait       Pause until Codex becomes available again
/limits stop       Stop on exhaustion
```

Provider, timeout, stream, authentication, dependency, and tool failures use
bounded retries with backoff. After retry exhaustion, Evidra records the
failure and suppresses an unchanged retry route. The next attempt must change
an appropriate route dimension such as executor, provider, model, or search
operator. This prevents an autonomous campaign from burning its budget by
repeating the same failed request.

When a Codex entitlement reset is required, the campaign is durably paused and
the wait interval is excluded from its research-time budget. Retry guards use
that pause-aware clock as well, so a long provider wait cannot consume the
active campaign budget merely because calendar time elapsed.

The interactive TUI follows the same policy: `auto` and `wait` schedule a
durable paused retry, `fallback` requires the local route, and `stop` leaves the
campaign stopped instead of silently converting the limit into a wait.
The CLI polls the durable controller directive during long reset waits, so a
stop request interrupts the wait within a few seconds rather than waiting for
the provider window to expire.

Native Codex activity is normalized into concise progress and bounded,
secret-redacted trajectory events. Raw protocol ids, credentials, and
unbounded payloads are not shown in the TUI or stored in research context.
During an autonomous cycle, the same bounded events are also appended to a
cycle JSONL trace under `.sota/traces/` as they occur. If the controller crashes
before the final trajectory is committed, the partial tool/command history is
still available for restart diagnosis without trusting raw provider output. On
the next controller start, Evidra validates and checksums uncommitted traces,
then records their recovery metadata as durable evidence; traces already linked
to a completed trajectory are not duplicated. The CLI and TUI perform the same
startup recovery, so changing interfaces cannot hide an interrupted Codex
cycle. Recovery metadata includes only a bounded redacted activity tail and
tool-name summary, allowing the next decision to understand the failure
surface without importing an unbounded transcript.
Recovered traces also add controller-crash pressure to the next allocation,
which prioritizes reproduction and an alternate route before new expensive
exploration.

## Production checklist

Before trusting an unattended campaign, verify:

```text
/doctor
/compute status
/usage
/project inspect
/validation inspect
```

Then confirm that the project declares an evaluator, metric or verifier,
dataset/split versions, required artifacts, resource budget, and submission
policy. Run a cheap baseline and smoke experiment before enabling `fast` or
`yolo`. For Modal, keep Codex authentication on the trusted controller side;
use a dedicated Modal Secret for API-key-backed remote work and never copy a
local ChatGPT login into a worker.

The reliable claim is the measured, reproducible claim: inspect run logs,
checksums, evaluator output, validation slices, and replication evidence before
promoting or submitting anything.
