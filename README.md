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

Implemented today:

- Ink-based interactive TUI with Codex-style transcript output;
- Codex authentication/model selection and local Ollama model selection;
- thinking-effort, workbench-mode, and permission selectors;
- fresh terminal sessions with explicit saved-session resume;
- durable SQLite state and append-only events;
- generic project-local competition manifests;
- autonomous campaigns and internal phase goals;
- bounded research-director tool loop;
- workspace file/search/read, Git status, safe shell, data audit, source retrieval, validation-policy, and report tools;
- durable queue with retries, stale-task recovery, bounded concurrency, and visible queued prompts;
- detached process groups so Escape stops child workers as well as the parent;
- experiment manifests, isolated worktrees, local/Modal executor boundaries, artifact capture, retries, and failure classification;
- source hashes, extracted claims, research graph edges, evidence reports, statistical comparison helpers, and ensemble utilities;
- shell and autonomy safety guards.

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
    /usage                Show durable activity and counts
    /research             Start or run an evidence-gathering cycle
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
    /agents               Show agent lanes and health
    /compute              Show executor and budget health
    /queue                Show durable tasks and recover stale work
    /submission           Prepare or validate a submission bundle
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
8. proposes or runs the next isolated experiment according to the selected permission level;
9. pauses on a blocker, stops on the campaign condition, or continues until budget exhaustion.

The director is limited to a bounded number of tool rounds per cycle. Every tool success and failure is recorded as a bounded event. The controller, not an LLM message, is the source of truth for campaign state, queue status, process ownership, and stopping behavior.

From the shell:

    evidra research \
      --goal "Improve robust performance with reproducible evidence" \
      --budget 4h \
      --stop "stop after a replicated improvement or when evidence is inconclusive"

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
      "experimentCommand": ["python", "run_experiment.py"]
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

## Experiments and permissions

Experiment execution is intended to be isolated and reproducible:

1. a hypothesis becomes an immutable experiment manifest;
2. Evidra records its parent commit, dataset revision, split version, resources, evaluation requirements, and acceptance criteria;
3. a dedicated Git worktree is created;
4. implementation and checks run in that worktree;
5. stdout, stderr, metrics, environment metadata, and checksums are saved;
6. failed runs are classified and may be retried according to policy;
7. accepted work can be reviewed and promoted separately.

| Level | Default behavior |
| --- | --- |
| safe | Inspect and gather evidence automatically; experiments require approval. |
| fast | Run permitted isolated experiments automatically. |
| yolo | Run the routine isolated workflow automatically while hard safety blocks remain active. |

External submissions, destructive commands, secret access, and unrestricted execution are not enabled by selecting YOLO.

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
7. Kaggle, HTTP, and manual submission adapters with approval gates;
8. optional Modal, container, Slurm, and remote executor backends;
9. a local browser dashboard on top of the same event/state model.

These are separate from the core TUI so Evidra remains useful for non-Kaggle research and can be operated entirely from a terminal.

## Contribution

Evidra is currently maintained as a private research project. Contributions should preserve the central invariants: deterministic state over conversational state, bounded autonomy, explicit provenance, isolated experiments, and no credential exposure to agents.
