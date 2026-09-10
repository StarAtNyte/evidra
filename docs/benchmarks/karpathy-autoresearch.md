# Karpathy Autoresearch harness trial

Evidra can run the [karpathy/autoresearch](https://github.com/karpathy/autoresearch)
loop through the generic competition-manifest interface. The repository is a useful
closed-loop harness test because it has a fixed wall-clock training budget, one
editable training file, and a machine-readable scalar metric (`val_bpb`, minimized).

This is a harness integration recipe, not a claim that a reduced smoke run is
comparable with the canonical benchmark configuration.

## 1. Prepare the benchmark

```bash
git clone https://github.com/karpathy/autoresearch.git
cd autoresearch
uv sync
uv run prepare.py
```

The canonical project requires a single NVIDIA GPU. For a shared GPU or a quick
integration test, reduce the model/batch settings in `train.py` and keep the
training budget explicit in the recorded campaign metadata.

## 2. Initialize Evidra

Evidra detects the standard checkout automatically. From the benchmark
repository, run:

```bash
evidra init autoresearch
```

This detects `train.py` and `prepare.py`, uses `val_bpb` as the minimized
metric, and runs `uv run train.py` for baseline and experiment evaluation.

If the checkout is customized, add `competition.json` in the benchmark
repository to override the detected defaults:

```json
{
  "id": "autoresearch",
  "name": "Karpathy Autoresearch",
  "taskType": "llm_training",
  "datasetRevision": "climbmix-pinned",
  "metric": { "name": "val_bpb", "direction": "minimize" },
  "evaluator": {
    "command": ["uv", "run", "train.py"],
    "estimatorPath": "train.py"
  },
  "workspacePath": ".",
  "baselineCommand": ["uv", "run", "train.py"],
  "experimentCommand": ["uv", "run", "train.py"],
  "researchSources": [],
  "evaluatorTimeoutMinutes": 10,
  "validation": {
    "primarySplit": "pinned-validation-shard",
    "folds": [0],
    "seeds": [0]
  }
}
```

## 3. Run the Evidra trial

From the benchmark repository, with Evidra installed:

```bash
evidra baseline
evidra status
evidra
```

Then use `/research` or `/challenge` to let Evidra inspect the workspace, form a
falsifiable training hypothesis, create an isolated experiment, run the evaluator,
and retain or reject the candidate using the declared metric direction.

The first integration gate is not leaderboard improvement. It is durable evidence:

- the command exits successfully;
- `val_bpb` is parsed from the worker output;
- stdout, stderr, metrics, and provenance are checksummed;
- the timeline records the baseline;
- a failed or OOM run is classified as evidence rather than treated as progress.

### Verified smoke result

The reduced configuration was verified through the Evidra CLI on an NVIDIA RTX 4090:

```text
contract: valid
worker: completed (45.0 s training budget)
metric: val_bpb = 1.267521
durable state: .sota/database.sqlite (11 events)
```

This confirms the generic contract, GPU worker, metric parser, baseline recorder, and
durable state path together. It is an integration smoke result, not a leaderboard claim;
run the canonical configuration before comparing results across machines.

## Other autoresearch-style evaluations

Karpathy's repository is the best local executor test. [Autoresearch Bench](https://www.autoresearch-bench.com/)
is a separate externally graded benchmark covering optimization, model training,
inference, and scientific machine learning; it should be integrated later through a
submission/evaluation adapter rather than confused with the local worker contract.
