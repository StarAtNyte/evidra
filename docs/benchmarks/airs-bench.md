# AIRS-Bench harness trial

This is Evidra's first local trial against a real AIRS-Bench task. It uses the
official [AIRS-Bench](https://github.com/facebookresearch/airs-bench) SICK
textual-classification task and keeps the task's preparation and evaluation
scripts unchanged.

## Reproduced task

- Task: `TextualClassificationSickAccuracy`
- Dataset: `RobZamp/sick`
- Test examples: 4,906
- Metric: Accuracy, maximize
- Prepared data: 4,439 train / 495 validation / 4,906 test
- Environment: NVIDIA RTX 4090 host; Python 3.13 system ML packages; pinned
  `datasets==3.6.0` for AIRS data preparation

The majority-label baseline scored:

```text
Accuracy = 0.5686913982878108
```

Evidra reproduced this score through the generic path:

```text
competition contract → baseline command → evaluator → metric parser
→ checksummed baseline artifacts → durable SQLite events
```

The baseline run produced six durable initialization/evidence events and a
checksummed baseline artifact set. This is a local task result, not an AIRS
leaderboard submission or a claim of SOTA.

## Autonomous-loop trial

A two-minute Challenge campaign was then run against the same prepared task
with `llama3.2:1b`, one research lane, local execution, and `fast` autonomy.
The baseline and workspace observation completed. The model could not return
the required structured research decision after the bounded retries, so no
experiment was executed and no score improvement was claimed.

Evidra recorded this as durable failure evidence:

- `research.agent.failed`
- a closed failed trajectory with quality evaluation
- paused campaign state with resume metadata
- controller lease release

This is an intentional harness result: model-format failure is separated from
benchmark/task failure and remains resumable with a stronger provider or model.

## Reproduction outline

Evidra can ingest the official checkout directly and normalize both the
research-agent (`rad`) and MLGym-converted (`mlgym`) task contracts:

```bash
evidra benchmark airs discover /path/to/airs-bench --family all \
  --out airs-inventory.json
```

The importer validates the public task files, extracts metric direction and
task-level normalization bounds where available, and reports invalid contracts
with a non-zero exit code. It does not execute or modify the benchmark; the
inventory is the input for a later matched protocol whose agent commands,
model, seed, and budget are explicitly declared.

Generate that matched protocol with explicit command templates. Templates may
use `{taskId}`, `{task}`, `{taskPath}`, `{family}`, `{repo}`, `{metadataPath}`,
`{descriptionPath}`, `{preparePath}`, `{evaluatePath}`,
`{evaluatePreparePath}`, `{metric}`, `{direction}`, `{model}`, `{seed}`, and
`{budget}`. This lets a real adapter receive the task contract and invoke the
official preparation/evaluation scripts without duplicating task-discovery
logic:

For a heterogeneous suite, supply a measured baseline per task. A single
`--baseline` is retained only as an explicit fallback for homogeneous or
partial trials; it is not silently copied across tasks when a baseline map is
provided.

```bash
cat > airs-baselines.json <<'JSON'
{
  "rad/TextualClassificationSickAccuracy": 0.5686913983,
  "rad/TextualSimilaritySickSpearmanCorrelation": 0.423
}
JSON

evidra benchmark airs protocol airs-inventory.json \
  --model gpt-5.6-luna --seed 0 --budget 30 --baseline-map airs-baselines.json \
  --arm '{"harness":"evidra","command":["./run-evidra.sh","{taskId}"]}' \
  --arm '{"harness":"mlgym","command":["./run-mlgym.sh","{taskId}"]}' \
  --out airs-protocol.json
evidra benchmark run airs-protocol.json --workspace /path/to/airs-bench --parallel 4
```

The command templates are the only harness-specific part; Evidra fixes task
identity, seed, model, budget, metric direction, and normalization bounds. At
least two distinct harnesses are required so the generated file cannot be
mistaken for comparative evidence when it contains only a single system.

Every arm also receives the same adapter environment contract:
`EVIDRA_BENCHMARK_TASK`, `EVIDRA_BENCHMARK_ARM`, `EVIDRA_BENCHMARK_MODEL`,
`EVIDRA_BENCHMARK_SEED`, `EVIDRA_BENCHMARK_BUDGET_MINUTES`,
`EVIDRA_BENCHMARK_METRIC`, `EVIDRA_BENCHMARK_DIRECTION`,
`EVIDRA_BENCHMARK_TASK_METADATA`, and `EVIDRA_BENCHMARK_PROTOCOL`. This is
useful for adapters that prefer environment configuration over argv, and makes
the same contract usable by local, container, and remote workers.

For a real task, the built-in lifecycle adapter runs the official scripts around
an agent command. The agent receives `EVIDRA_AIRS_AGENT_DATA_DIR` and
`EVIDRA_AIRS_AGENT_LOG_DIR`; it must write the task's expected submission into
the log directory. The evaluator's metric is emitted as normalized JSON for
the generic benchmark runner:

```bash
evidra benchmark airs execute airsbench/tasks/rad/TextualClassificationSickAccuracy \
  --global-data /path/to/airs-bench/datasets/datasets_download_location \
  --agent "python3 /path/to/my-agent.py" --metric Accuracy \
  --workspace .sota/airs-sick-agent
```

With an authenticated Codex account, the agent stage can instead use Evidra's
embedded Codex SDK route. It receives the same isolated workspace and is
required to write the task submission before the official evaluator runs:

```bash
evidra benchmark airs execute airsbench/tasks/rad/TextualClassificationSickAccuracy \
  --global-data /path/to/airs-bench/datasets/datasets_download_location \
  --codex --model gpt-5.6-luna --effort medium \
  --workspace .sota/airs-sick-codex
```

The adapter is intentionally task-agnostic; custom AIRS task layouts can
override the three script paths with `--prepare`, `--evaluate-prepare`, and
`--evaluate`.

The adapter was exercised against the locally prepared SICK task on
2026-09-16. All four stages completed, and the official evaluator returned
`Accuracy = 0.5686913982878108` for the existing majority-label submission.
This confirms the real preparation → agent mount → evaluator preparation →
official evaluation path; it is a baseline reproduction, not a claim of agent
quality or leaderboard performance.

On the same task, the embedded Codex route was then run with `gpt-5.6-luna`,
medium reasoning effort, and a ten-minute total agent budget. The run completed
all lifecycle stages and the unchanged official evaluator returned:

```text
Accuracy = 0.8065633917651854
Absolute improvement over majority baseline = +0.2378719934773746
```

This is the first valid end-to-end agent result in the workbench. It is a
single local run, so it is evidence that the harness can execute and improve a
real task—not evidence of leaderboard SOTA. Repeated seeds, task-balanced
comparisons, and a held-out suite are still required.

A second run with the same model, effort, budget, task, and evaluator but seed
`1` returned `Accuracy = 0.7702812882185079`. Across the two seeds the mean is
`0.7884223399918466`, the worst run is `0.7702812882185079`, and both runs beat
the majority baseline. This is initial reproducibility evidence; it is not yet
a multi-task or leaderboard comparison.

The same generic lifecycle was exercised on the task-disjoint
`MathQuestionAnsweringSVAMPAccuracy` task. Its public data was prepared through
the official task script, a deterministic majority-answer agent produced the
required `Answer` submission, and the unchanged evaluator returned
`Accuracy = 0.07333333333333333`. This is a second-task adapter baseline; no
Codex SVAMP score is counted because the safe Codex probe was stopped after it
attempted to inspect paths outside its worker boundary.

A bounded embedded-Codex probe was also attempted with `gpt-5.6-luna` at
medium effort. Codex authenticated and entered the isolated workspace, but
repeatedly inspected the working directory without producing the required
submission. Evidra now supervises three fresh bounded phases—inspect/plan,
implement, and verify—within one total deadline, and treats an empty or missing
submission as an immediate `agent`-stage failure. It does not spend evaluator
time on an invalid run. This is useful negative evidence for improving the
task prompt and agent progress watchdog, not a benchmark score.

Experiment-engineer prompts explicitly permit local evaluator artifacts such as
`submission.csv`; the external-submission boundary remains disabled. This keeps
the research safety rule from accidentally preventing a legitimate local
experiment deliverable.

The shared provider prompt also gives experiment engineers an execution-first
instruction: they summarize only after producing and verifying the required
artifact. Conversational research turns retain the concise-answer behavior.

The embedded AIRS route supervises Codex in three bounded phases—inspect/plan,
implement, and verify—with a controller artifact check between phases. The
default phase budget is 25% / 60% / 15% of the total agent deadline, so planning
cannot consume the complete run. If a phase produces no artifact, the next
fresh phase receives an explicit strategy-switch instruction. As soon as any
phase produces a non-empty artifact, the controller hands it to the official
evaluator; evaluator validity, not the agent's prose, is authoritative.

Before the agent stage, the adapter initializes the disposable task workspace
as a local Git repository when necessary. This is required by Codex's file
change tool and does not touch the user's checkout or turn the temporary
repository into benchmark evidence.

The workspace is seeded with an empty `log/submission.csv` and a placeholder
`PLAN.md`, then committed. Seeding is non-destructive when a workspace is
resumed, so partial plans and artifacts survive a controller or provider
restart. The seed makes the workspace structurally usable by providers that
require a Git `HEAD`, but Evidra only accepts a non-empty submission as
complete. The embedded AIRS prompt directs Codex to use shell or Python file
creation because provider patch tools are not portable across disposable worker
paths.

Embedded AIRS Codex runs use the provider's `workspace-write` sandbox inside
their disposable workspace (network remains disabled), plus a repeated-command watchdog: three identical
shell commands in succession terminate the agent stage with an explicit stuck
diagnostic, allowing the outer retry/route policy to recover instead of
silently consuming the entire experiment budget. The watchdog is opt-in in
the general Codex provider and enabled for autonomous AIRS runs.

AIRS workers also stop after three consecutive failed shell commands, even
when the commands are different; the next supervised phase then receives an
explicit strategy-switch prompt.

```bash
git clone https://github.com/facebookresearch/airs-bench.git
cd airs-bench
# prepare the task's pinned raw dataset with datasets==3.6.0
# create a project-local competition.json for the selected task
evidra init airs-sick
evidra validate
evidra baseline
```

Full AIRS-Bench scoring still requires running the agent-facing task workflow
for each task and aggregating its normalized score, valid-submission rate, and
Elo-style statistics. The inventory removes hand-written task discovery; the
next step is an explicit adapter for each agent harness command surface.

## Runner protocol validation

On 2026-09-16, the generated inventory was expanded into an 80-arm matched
protocol: two routes (`evidra` and `reference`) across the 40 discovered task
contracts. The generic runner executed all 80 arms, parsed each task-specific
metric, produced a report, and scored 40 valid paired comparisons with 100%
paired coverage. It preserved the fixed task, seed, model, effort, budget,
direction, baseline, and protocol fingerprint in the report.

This was a deterministic runner probe: each command emitted a known metric
suite rather than training an agent or downloading every task dataset. Its
result validates protocol expansion, isolation-aware scheduling, metric
parsing, normalization, scoring, and report persistence. It must not be read as
evidence that Evidra beats another research harness. A genuine comparison
requires replacing both command templates with runnable agent adapters and
using measured per-task baselines under the same budget.
