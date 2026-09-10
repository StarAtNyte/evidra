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
use `{taskId}`, `{taskPath}`, `{family}`, `{repo}`, `{model}`, `{seed}`, and
`{budget}`:

```bash
evidra benchmark airs protocol airs-inventory.json \
  --model gpt-5.6-codex --seed 0 --budget 30 --baseline 0.5687 \
  --arm '{"harness":"evidra","command":["./run-evidra.sh","{taskId}"]}' \
  --arm '{"harness":"mlgym","command":["./run-mlgym.sh","{taskId}"]}' \
  --out airs-protocol.json
evidra benchmark run airs-protocol.json --workspace /path/to/airs-bench
```

The command templates are the only harness-specific part; Evidra fixes task
identity, seed, model, budget, metric direction, and normalization bounds.

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
