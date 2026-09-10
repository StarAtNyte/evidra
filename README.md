# Evidra

Evidra is a local-first research and experimentation workbench for people who want an agent to do more than write code.

It turns a research workspace, competition repository, or empirical engineering problem into a durable loop:

    inspect → gather evidence → form hypotheses → implement → run → evaluate → replicate → promote

The model supplies reasoning. Evidra owns the deterministic and auditable parts: workspace inspection, tool permissions, experiment state, process control, artifacts, validation policy, evidence memory, queues, budgets, and recovery.

The workbench is general-purpose. It can be used for ML competitions, data science, scientific experiments, benchmark optimization, algorithm research, reverse engineering, and repository investigations. AIcrowd's ARC White-Box Estimation Challenge (WhestBench) is the first included trial adapter, not the product's scope.

## Why Evidra

Most coding agents optimize for one conversation and one code change. Evidra is designed for research programs that continue after the first answer:

- **Evidence before conclusions.** The director can inspect files, search the workspace, read sources, audit data, inspect Git, run safe commands, retrieve literature, and receive results in its next reasoning turn.
- **Falsifiable research.** Decisions contain phases, goals, hypotheses, expected effects, costs, risks, dependencies, and explicit falsification tests.
- **Durable state.** SQLite and an append-only event log preserve projects, claims, sources, hypotheses, decisions, experiments, runs, artifacts, phase goals, agent lanes, sessions, and queue tasks.
- **Bounded autonomy.** A campaign has an ultimate goal, internal phase goals, a budget, and a stopping condition. It pauses when genuinely blocked and can resume later.
- **Reproducible execution.** Experiment manifests, Git worktrees, run metadata, metrics, logs, checksums, and environment snapshots make results inspectable.
- **Provider choice.** Use the authenticated Codex CLI with a ChatGPT subscription or a local Ollama model.
- **Human control.** Safe, fast, and YOLO permissions change automation level, while destructive commands and external submissions remain blocked.

## Current maturity

Evidra is an active TypeScript foundation, not a claim that every competition-specific worker or cloud adapter already exists. The controller primitives are implemented and tested; competition-specific training, metrics, split strategies, cloud executors, and submission adapters are loaded from the active workspace or added incrementally.

## Research architecture inspired by frontier research systems

Evidra is designed around a bounded version of the workflow described by [OpenAI in its 2026 Navier–Stokes report](https://openai.com/index/navier-stokes-solution/): independent groups explore different formulations, groups communicate useful intermediate results, promising directions are consolidated, and a separate verification stage checks the final claim. Evidra applies the same pattern to empirical research:

```text
problem variants → independent research lanes → evidence/artifacts
                 → cross-pollination → critic/replication → promotion
```

The deterministic controller remains the source of truth. Agents propose hypotheses, write code in isolated worktrees, and explain evidence; evaluators, checksums, split policies, reviewers, and approval gates decide whether a result is valid. This makes the pattern useful for competitions, engineering investigations, scientific experiments, and other challenge repositories without assuming a theorem prover or a particular model family.

Provider exhaustion is an explicit runtime policy. In the TUI use `/limits fallback` to select an installed local Qwen/Ollama model automatically, `/limits wait` to resume after the Codex entitlement resets, or `/limits stop` to halt the active request. The fallback model can be pinned with `EVIDRA_FALLBACK_MODEL`.

Lane concurrency is adaptive: `safe` runs one independent lane, `fast` permits a small parallel set, and `yolo` uses the largest bounded set supported by the host and provider. Local Ollama concurrency also respects `OLLAMA_NUM_PARALLEL`; the TUI never interprets YOLO as permission to exhaust a laptop, subscription, or external service.

### Local controller versus Modal controller

Normal operation is a local controller with a selectable experiment target:

```text
local TUI/controller ──► local experiment worker
                     └─► Modal GPU experiment worker
```

Use `/compute local`, `/compute container`, or `/compute modal` before proposing an experiment, or use `evidra experiment propose --executor container`. Container workers use Docker or Podman (auto-detected, or selected with `EVIDRA_CONTAINER_RUNTIME`), mount only the isolated experiment worktree, disable network access by default, and use `EVIDRA_CONTAINER_IMAGE` or the manifest image (default `python:3.11-slim`). Modal workers receive the workspace and declared command, return logs and declared artifacts, and are evaluated by the same local evidence gates.

For unattended operation, `modal_controller.py` runs the Node controller headlessly in Modal and stores durable `.sota` state in a Modal Volume:

```bash
EVIDRA_MODAL_WORKSPACE="$PWD" modal run modal_controller.py::run \
  --goal "maximize robust validation performance" --budget 4h --mode challenge --competition arc-whestbench-2026 --executor local --autonomy fast --lanes 3
```

The headless controller is controllable without attaching a second interactive agent. Its
state is durable in the shared Modal Volume, and controls take effect at the next safe
research-cycle boundary:

```bash
modal run modal_controller.py::run --action status
modal run modal_controller.py::run --action pause
modal run modal_controller.py::run --action resume
modal run modal_controller.py::run --action stop
```

The same controls are available locally through `evidra controller status`, `pause`, `resume`,
and `stop` (with `EVIDRA_MODAL_CONTROLLER_ENTRYPOINT` available for a non-default entrypoint).

For remote Codex access, create a Modal Secret containing `CODEX_API_KEY` and set its name before launching:

```bash
export EVIDRA_MODAL_CODEX_SECRET=evidra-codex
EVIDRA_MODAL_WORKSPACE="$PWD" modal run modal_controller.py::run --goal "..." --budget 4h
```

If the Modal controller should launch separate Modal experiment workers, create a second Modal Secret containing `MODAL_TOKEN_ID` and `MODAL_TOKEN_SECRET`, then set `EVIDRA_MODAL_AUTH_SECRET` to its name. The controller checkpoints its SQLite state volume during long runs and commits the final state before exit.

This headless mode has no interactive TUI or implicit approval channel. Inspect or approve external actions from a trusted local session after attaching to the persisted state. A local ChatGPT subscription login is intentionally not copied into Modal.

The controller initializes the requested competition in the durable Modal state volume on first start. `--executor local` runs experiments inside the controller container; `--executor modal` routes them to a separate Modal worker and requires the Modal CLI/runtime in the image.

Provider and lane failures are recoverable. Transient network, timeout, stream, malformed-response, and service errors receive bounded retries with backoff; configured Codex-to-local fallback changes route when appropriate; every exhausted lane is recorded as failed evidence so the director can choose a different path instead of silently treating it as success. SDK subprocesses are cancelled on timeout and terminal interruption.

Every research cycle now has an adversarial critic stage. The critic reviews lane disagreement and the director decision, records objections and required checks, and returns `proceed`, `revise`, or `reject`. An explicitly started autonomous research or challenge campaign can implement and run isolated experiments automatically; external submissions remain approval-gated in every mode.

The controller also records evaluated trajectories for both research cycles and experiments. A deterministic quality pass checks structural closure, goal attainment, tool use, evidence consistency, recovery, and termination. Capability routing assigns each cycle a demand tier (`C0`–`C3`) using task complexity, failure pressure, budget, provider, and autonomy. Recurring deficiencies are converted into the next research allocation—for example, evidence failures prioritize provenance and leakage checks, while recovery failures prioritize reproduction and alternate execution routes. New experiments are selected by expected information per combined GPU, model, engineering, and risk cost rather than simply choosing the newest hypothesis.

Implemented today:

- Ink-based interactive TUI with Codex-style transcript output;
- Codex authentication/model selection and local Ollama model selection;
- thinking-effort, workbench-mode, and permission selectors;
- fresh terminal sessions with explicit saved-session resume;
- durable SQLite state and append-only events;
- complete promotion-gate snapshots on every leakage/reviewer approval change;
- generic project-local competition manifests;
- manifest-driven artifact contracts (`execution.requiredArtifacts`), with no ML-specific artifact assumptions for general research;
- autonomous campaigns and internal phase goals;
- independent durable phase machines for Research and Challenge campaigns in the same project;
- bounded research-director tool loop;
- workspace file/search/read, Git status, safe shell, data audit, source retrieval, validation-policy, and report tools;
- durable queue with retries, stale-task recovery, bounded concurrency, and visible queued prompts;
- detached process groups so Escape stops child workers as well as the parent;
- experiment manifests, isolated worktrees, local/Modal executor boundaries, artifact capture, retries, and failure classification;
- failure finalization that prevents started experiments from remaining indefinitely in `running` state;
- startup recovery that marks experiments abandoned by a dead controller as retryable failures while preserving their worktrees;
- source hashes, extracted claims, research graph edges, evidence reports, statistical comparison helpers, and ensemble utilities;
- bounded HTML, text, and common PDF research-source extraction with explicit fallback when a PDF encoding cannot be decoded;
- freshness-aware refresh of dynamic competition sources such as discussions and leaderboards on challenge observation cycles;
- URL-deduplicated active research context, while retaining every historical source version for auditability;
- multi-split validation acceptance, durable leakage/reviewer gates, and conservative external-score split-belief modeling;
- automatic baseline-to-candidate comparison events after successful challenge evaluations;
- replication scheduling gated on an observed improvement rather than mere process completion;
- headless research and challenge campaigns that execute selected hypotheses through the same isolated runner as the TUI, with optional `--executor local|container|modal` routing;
- Codex-backed experiment-engineer implementation in the isolated worktree before evaluation, with failed hypotheses retained as evidence instead of being blindly retried;
- durable headless research trajectories with structural, goal, evidence, recovery, and termination quality signals feeding future allocation;
- unattended experiment runs also record the same quality-scored process/evaluator/recovery trajectory used by the interactive workbench;
- capability routing learns from prior trajectory quality: failed or warning-heavy cycles raise verification pressure, bound lane fan-out, and persist predicted tier versus served provider/model and observed outcome;
- every research cycle now emits a durable experience record: validated trajectory events, scene/goal/outcome metadata, independent quality verdicts, C0-C3 demand scores, admission status, capability-gap profile, and a three-stage curriculum for subsequent cycles;
- local research lanes can use a bounded heterogeneous Ollama pool: installed local models are discovered at campaign start, assigned deterministically across independent roles, and the actual model used by every lane is recorded for replay and routing analysis;
- experiment proposals receive an explainable novelty score against prior directions, reducing redundant hypothesis families while preserving probability-of-success, information-value, risk, and compute-cost ranking;
- ensemble proposals are durable, checksummed candidate artifacts with member-file checksums, provenance, and explicit candidate/validated/promoted/rejected status; source mutation blocks validation, and creating a blend never silently promotes or submits it;
- local-model experiment implementation through bounded unified-diff proposals, checked and applied only inside the experiment worktree;
- Modal execution mounts the exact isolated experiment worktree and accepts either Modal CLI profiles or environment credentials;
- Docker/Podman execution mounts only the exact isolated experiment worktree, uses a network-disabled container, and keeps the same artifact, metric, retry, and evidence gates;
- Codex-backed experiment engineers honor entitlement reset windows with bounded retry/wait behavior instead of silently abandoning an authorized campaign;
- shell and autonomy safety guards.

### Experience-driven improvement

Evidra treats an autonomous run as reusable research experience rather than disposable chat
history. A structurally complete trajectory becomes a candidate experience; recoverable failures
remain replay-only; ambiguous or malformed traces are quarantined. The workbench aggregates these
records into a capability profile and recommends a curriculum that starts with bounded examples,
expands across observed tasks and outcomes, and then introduces higher-demand or recovery-heavy
trajectories. This is inspired by routing-harness research such as NeoHorse-1, but remains
model- and domain-agnostic: it works for scientific research, software experiments, and challenge
workflows without requiring model fine-tuning.

## Quick start

Requirements:

- Node.js version 22.19.0 or newer;
- Git and ripgrep;
- either an authenticated Codex CLI or a local Ollama installation.

Install from a checkout:

    git clone https://github.com/StarAtNyte/evidra.git
    cd evidra
    nvm use 22
    npm install
    npm run build
    npm link

Initialize a general workspace:

    cd /path/to/your/workspace
    evidra init local-research
    evidra

Initialize a project-local competition manifest:

    evidra init my-competition
    evidra

Inside the TUI, select a provider and model:

    /provider
    /login codex
    /model
    /thinking
    /permissions

Codex authentication is delegated to the official Codex CLI. Evidra does not read or copy authentication tokens:

    codex login
    codex login status

For local inference:

    ollama serve
    ollama pull qwen3.6:27b

The TUI checks provider access before making a model request. If no provider is available, ordinary conversation still works as a UI session; research execution reports the provider blocker instead of displaying fabricated progress or protocol gibberish.

## Interactive workbench

Run evidra with no arguments. The interface is designed for long-running terminal work:

- normal text is conversational and does not start autonomous research;
- › marks user input and • marks Evidra output;
- tool activity is shown as compact event lines rather than transcript cards;
- active work shows progress and (esc to interrupt);
- interruption appears as a red ✕ INTERRUPTED event;
- prompts added while a request is active stay in a bottom queue rail;
- Codex prompts are steered through its persisted thread queue at the next supported boundary;
- opaque local requests are processed FIFO after the active request completes;
- Ctrl+C clears non-empty input and exits only when input is empty;
- Tab, arrows, and Enter operate command/model/provider selectors.

Useful commands:

    /help                 Show commands and shortcuts
    /status               Show project, graph, queue, and execution state
    /timeline             Show a readable autonomous execution timeline
    /usage                Show durable activity and counts
    /research             Start or run an evidence-gathering cycle
    /research start       Start a fully autonomous research campaign
    /research pause       Pause workers and preserve the campaign
    /research resume      Resume the saved research campaign
    /research stop        Stop the campaign without deleting evidence
    /loop                 Run or control the autonomous loop
    /workbench            Select Research or Challenge mode
    /provider             Select Codex or local provider
    /model                Select an available provider model
    /thinking             Select reasoning effort
    /permissions          Select safe, fast, or YOLO automation
    /sources              Retrieve/search durable research sources
    /memory               Search durable evidence and research memory
    /data                 Audit workspace data
    /validation           Inspect or generate validation policy
    /experiment           Create or run reproducible experiments
    /ensemble             Inspect diversity or create a durable blend candidate
    /ensemble validate    Verify a candidate checksum and schema
    /ensemble promote     Promote only a validated local candidate
    /ensemble reject      Reject a candidate permanently
    /experiment gate      Record leakage or reviewer approval
    /challenge start      Start a fully autonomous challenge campaign
    /challenge pause      Pause challenge workers
    /challenge resume     Resume the saved challenge campaign
    /challenge stop       Stop the challenge campaign safely
    /agents               Show agent lanes and health
    /compute              Show executor and budget health
    /queue                Show durable tasks and recover stale work
    /submission           Prepare, validate, approve, submit, or poll a bundle
    /submission distribution  Estimate which local split tracks external scores
    /report               Generate a portable report
    /sessions             List saved sessions
    /resume               Resume a saved session explicitly
    /doctor               Diagnose dependencies and provider access
    /exit                 Leave the current session

Explicit shell escapes are available for operator-directed work:

    !ls -la
    !git status --short
    !python -m pytest -q

Shell execution passes through Evidra's command guard. YOLO does not override the hard block on destructive cleanup, privilege escalation, remote-script execution, or external submission.

## Autonomous research

Use /research when you want Evidra to conduct research rather than answer a question conversationally. Setup asks for:

1. the ultimate goal;
2. the available time or compute budget;
3. the stopping condition.

Evidra creates internal phase goals such as orientation, baseline, data audit, validation, hypothesis, implementation, evaluation, replication, and promotion. Each cycle:

1. records a workspace observation;
2. loads the active phase goal and relevant durable memory;
3. asks the research director for a structured decision;
4. lets the director request typed tools when evidence is missing;
5. executes those tools through the permission boundary;
6. feeds bounded tool results into the next reasoning turn;
7. materializes the decision, hypotheses, claims, and graph edges;
8. asks an experiment engineer to implement the selected change in an isolated worktree;
9. runs, evaluates, retries, records artifacts, and independently replicates promising results;
10. pauses on a blocker, stops on the campaign condition, or continues until budget exhaustion.

`/research start` and `/challenge start` explicitly authorize this complete local loop. They resume from durable evidence after a terminal restart. Use `/research pause|resume|stop` or `/challenge pause|resume|stop` to control it. External submission is never performed automatically.

The director is limited to a bounded number of tool rounds per cycle. Every tool success and failure is recorded as a bounded event. The controller, not an LLM message, is the source of truth for campaign state, queue status, process ownership, and stopping behavior.

From the shell:

    evidra research \
      --goal "Improve robust performance with reproducible evidence" \
      --budget 4h \
      --stop "stop after a replicated improvement or when evidence is inconclusive"

Continue a paused or interrupted headless campaign explicitly with `--resume`:

    evidra research --resume --provider codex --limit-policy fallback

Headless research acquires a durable controller lease and heartbeats it while running. A
second controller for the same project is refused instead of competing for SQLite state;
an interrupted process leaves the campaign resumable and its stale lease recoverable.
Paused intervals are recorded separately and do not consume the campaign’s active budget.

The same autonomous loop can run as a challenge campaign:

    evidra challenge start --goal "win the active challenge" --budget 4h --limit-policy fallback

If the process is interrupted, continue it with:

    evidra challenge resume

Use a local model directly when Codex is unavailable:

    evidra research \
      --provider local \
      --model qwen3.6:27b \
      --thinking high \
      --budget 90m

Inspect a long-running campaign without reading raw event payloads:

    evidra timeline --limit 40

The command checks the selected provider before starting repository inspection or baseline execution. The default Codex path can fall back to the configured local model only for recognized usage-limit failures; authentication and configuration errors are reported instead of silently starting an unconfigured run.

## General workspace manifests

Evidra does not require a fixed competition name. A project can provide competition.json at its root or under competitions/<id>/competition.json:

    {
      "id": "my-research",
      "name": "My Research Problem",
      "taskType": "classification",
      "datasetRevision": "data-v1",
      "metric": { "name": "macro_f1", "direction": "maximize" },
      "evaluator": {
        "command": ["python", "evaluate.py"],
        "estimatorPath": "src/train.py"
      },
      "workspacePath": ".",
      "baselineCommand": ["python", "baseline.py"],
      "experimentCommand": ["python", "run_experiment.py"],
      "execution": {
        "smokeCommand": ["python", "run_experiment.py", "--smoke"],
        "reducedValidationCommand": ["python", "run_experiment.py", "--folds", "1", "--epochs", "1"]
      },
      "submission": { "platform": "manual" },
      "submissionPolicy": {
        "minimumInformationValue": 0.2,
        "minimumLocalConfidence": 0.8,
        "reserveForFinalEnsemble": 3,
        "minimumHoursBetweenSubmissions": 8,
        "totalLimit": 10,
        "dailyLimit": 2
      }
    }

The manifest is intentionally small. Dataset manifests, split registries, metrics, worker protocols, and platform adapters belong in the workspace instead of being hardcoded into Evidra. Paths are checked to remain inside the project root.

## State and provenance

Durable controller state lives under .sota:

    .sota/
    ├── database.sqlite          # canonical relational state
    ├── validation-policy.json   # versioned validation policy
    ├── artifacts/               # logs, metrics, and environment snapshots
    ├── reports/                 # generated research/challenge/final reports
    └── worktrees/               # isolated experiment worktrees

The event log records observations, tool calls, source retrieval, queue claims, phase-goal updates, experiment runs, artifacts, and generated reports. Generated summaries never replace primary logs, metrics, or source hashes.

Evidence claims are validated at the SQLite boundary. Every claim requires a statement, scope, confidence, source type, source identifier, and lifecycle status; literature claims are rejected unless their source was retrieved and stored. Additional provenance such as excerpts, findings, reports, and artifact references is retained alongside the validated core.

The store also performs a conservative consistency pass: exact duplicates are recorded for review, and only strongly overlapping statements with explicit negation receive a `contradicts` graph edge. These findings never invalidate or promote a claim automatically; inspect them with `/graph` or the generated report.

Unresolved evidence conflicts feed back into autonomous allocation: the next research cycle prioritizes source review and independent falsification before spending compute on another hypothesis.

Long campaigns also receive a bounded durable-memory snapshot on every cycle. It contains recent claims, hypotheses, and contradiction edges independently of the short event window, so research does not forget earlier evidence after a restart or many experiments.

Autonomous campaigns include a stagnation guard: three identical unresolved active decisions pause the campaign for review and persist the decision signature. A new hypothesis, execution, replication, phase transition, or explicit resume can continue the work; Evidra does not silently spend the remaining budget repeating the same blocked action.

Phase advancement is evidence-gated. A model cannot advance orientation, baseline, auditing, validation, implementation, evaluation, replication, or promotion by returning `goalStatus: met` alone; the controller checks the corresponding durable events and gates. Challenge mode requires a parsed primary evaluator baseline, general research mode requires a durable reference observation, and evaluation requires a finite primary experiment metric. Otherwise Evidra records `research.phase_gate.rejected` and keeps the phase active.

## Experiments and permissions

Experiment execution is intended to be isolated and reproducible:

1. a hypothesis becomes an immutable experiment manifest;
2. Evidra records its parent commit, dataset revision, split version, resources, evaluation requirements, and acceptance criteria;
3. a dedicated Git worktree is created;
4. implementation and checks run in that worktree;
5. stdout, stderr, metrics, environment metadata, and checksums are saved;
6. failed runs are classified and may be retried according to policy;
7. accepted work can be reviewed and promoted separately;
8. an approved bundle can be submitted through a configured adapter.

| Level | Default behavior |
| --- | --- |
| safe | Inspect and gather evidence automatically; experiments require approval. |
| fast | Run permitted isolated experiments automatically. |
| yolo | Run the routine isolated workflow automatically while hard safety blocks remain active. |

External submissions, destructive commands, secret access, and unrestricted execution are not enabled by selecting YOLO.

Submission is always explicit and approval-gated. After preparing, validating, and approving a bundle, use `/submission submit <bundle-id>` or `evidra submission submit <bundle-id>`. Manual upload is the default. Kaggle can be configured without exposing credentials to agents:

When a manifest declares `submissionPolicy`, Evidra also enforces its external budget before the adapter runs. The CLI accepts `--information-value`, `--local-confidence`, and `--final`; the TUI accepts the equivalent flags on `/submission submit`. Failed policy checks do not consume a submission slot, and every successful adapter receipt remains durable in the event log.

    "submission": {
      "platform": "kaggle",
      "competition": "my-competition",
      "predictionFile": "submission.csv"
    }

Other platforms can use an argv-based command adapter. Supported placeholders are `{bundle}`, `{file}`, `{competition}`, and `{message}`; Evidra does not invoke a shell for adapter arguments:

    "submission": {
      "platform": "command",
      "submitCommand": ["./scripts/submit", "--file", "{file}", "--message", "{message}"],
      "scoreCommand": ["./scripts/score", "--submission", "{submission}"]
    }

`scoreCommand` is an optional generic read-only polling adapter. It runs inside the project root and accepts `{bundle}`, `{file}`, `{competition}`, and `{submission}` placeholders. Emit JSON such as `{ "publicScore": 0.812 }` or a line such as `score: 0.812`; Evidra validates that the result is finite, redacts captured output, stores the observation as evidence, and marks the bundle scored. Use `/submission poll <bundle-id>` or `evidra submission poll <bundle-id>`. Platforms without a polling API can continue using `/submission record` after a manual leaderboard observation.

## Provider architecture

The provider is an implementation detail behind the same research protocol:

- **Codex:** the installed official codex CLI, authenticated ChatGPT/Codex account, JSON event output, persisted threads, and thread queue support.
- **Local:** Ollama's local chat endpoint and the selected installed model.

Evidra never extracts subscription tokens or implements unofficial ChatGPT API calls. Provider availability is checked before work begins, and local fallback is used only for configured usage-limit cases where a local model is available.

## Development

    npm install
    npm run check       # TypeScript type-check only
    npm run build       # Compile dist/
    npm test            # Build and run the core smoke suite
    npm run dev         # Run the CLI from TypeScript

The test suite covers durable state reopen, fresh/resumable sessions, generic manifests, autonomy guards, queue concurrency/retry behavior, research tool execution and audit events, the director tool loop, statistics, ensembles, provenance, and detached process interruption.

## Roadmap

The next research-lab layers are:

1. versioned split and metric registries with constrained evaluator subprocesses;
2. richer leakage, duplicate, shift, and subgroup audits;
3. Python worker protocol with heartbeats, expected-artifact validation, and environment hashes;
4. successive-halving scheduling and compute-normalized hypothesis prioritization;
5. persistent role agents and independent review lanes;
6. OOF prediction storage, error correlation, calibration, and ensemble search;
7. richer first-party HTTP submission adapters and leaderboard integrations;
8. Slurm and additional remote executor backends;
9. a local browser dashboard on top of the same event/state model.

These are separate from the core TUI so Evidra remains useful for non-Kaggle research and can be operated entirely from a terminal.

## Contribution

Evidra is currently maintained as a private research project. Contributions should preserve the central invariants: deterministic state over conversational state, bounded autonomy, explicit provenance, isolated experiments, and no credential exposure to agents.
