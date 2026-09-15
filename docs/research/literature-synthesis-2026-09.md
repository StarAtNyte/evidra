# Evidence for a General Autonomous Research Harness

## Executive conclusion

Evidra should be a deterministic research operating system around interchangeable
reasoning providers. The model should propose, implement, and explain; the harness
should own state, execution, measurement, provenance, recovery, and stopping. The
literature consistently supports this separation, but does not justify treating
multi-agent consensus or generated prose as evidence.

The highest-value transferable design is a closed loop:

```text
observe → formulate → predict → implement → execute → verify → compare → remember
                                  ↑                                      ↓
                                  └────── diversify / repair / replicate ─┘
```

## Primary evidence and implications

| Evidence | What it demonstrates | Evidra implication |
| --- | --- | --- |
| [Agentic Harness Engineering (AHE)](https://arxiv.org/abs/2604.25850) | Harness evolution benefits from component-level observability, compressed experience observability, and edit-level predictions checked against later outcomes. | Keep every harness change tied to a component, forecast, matched benchmark, and post-change result. Do not optimize only prompts. |
| [The AI Scientist](https://arxiv.org/abs/2408.06292) | A repeatable loop can generate ideas, write code, run experiments, visualize results, draft reports, and apply review. | Add report-generation and reviewer stages after evidence is complete; never let the report become the source of truth. |
| [Darwin Gödel Machine](https://arxiv.org/abs/2505.22954) | An archive of diverse self-modifying agents and benchmark validation supports open-ended improvement. | Preserve an immutable archive of harness versions and branch descendants; promote only matched, reproducible improvements. |
| [Voyager](https://arxiv.org/abs/2305.16291) | Automatic curricula, executable skill libraries, environment feedback, and error-driven iteration compound capability. | Store reusable verified procedures/skills separately from claims, retrieve them by task, and require fresh validation in a new workspace. |
| [MLE-bench](https://arxiv.org/abs/2410.07095) | Real ML engineering performance needs end-to-end competition tasks and resource-aware evaluation, not just coding tests. | Benchmark the complete research loop: valid run rate, robust outcome, cost, recovery, and coverage under equal budgets. |
| [Automated Statistical Model Discovery](https://arxiv.org/abs/2402.17879) | Box’s Loop alternates model proposal and domain critique in an open-ended model-discovery process. | Keep domain/formulation critics independent from implementation agents and require falsification tests. |
| [OpenAI’s Navier–Stokes report](https://openai.com/index/navier-stokes-solution/) | The reported system used diverse problem formulations, groups of agents, tool access, cross-pollination, and formal verification; scale was useful only alongside isolation and checking. | Generalize formulation portfolios and cross-pollination, but make all consensus provisional and route final claims through deterministic verifiers or independent replications. |

## Design rules extracted from the evidence

### 1. Optimize the harness as an experimental object

Each change to Evidra itself needs a manifest containing:

- changed component paths and checksums;
- a falsifiable prediction;
- a fixed benchmark task/seed/model/effort/budget contract;
- the observed outcome, cost, and failure profile;
- a decision to retain, revert, or branch.

This is stronger than “the new prompt felt better.” It also prevents benchmark
overfitting: a harness change must be evaluated on held-out tasks and, where
possible, a second provider/model family.

### 2. Separate exploration from proof

Agent groups should explore different formulations and communicate bounded
intermediate findings. Their reports are search priors, not evidence. Evidence is
an artifact, a replayable command result, a trusted source, a verifier result, or an
independent run whose identity is durable and whose inputs are unchanged.

### 3. Treat outcomes as a typed objective, not a scalar assumption

Challenges may optimize one or many metrics; research may seek an artifact, proof,
behavioral property, system reliability, or a Pareto trade-off. A scalar score can
be a gate, but it must not be invented for non-scalar work. Every objective needs an
explicit evaluator contract and a stopping condition.

### 4. Use adaptive resource allocation, not maximum fan-out

Parallel agents are useful when they create independent information. They are
counterproductive when they duplicate context, compete for one local model, or
consume a usage budget without changing the decision. Allocate lanes and compute
from observed value, uncertainty, cost, and diversity; retain a small reserved
budget for replication and final verification.

### 5. Make recovery a change of experiment, not a blind retry

Transient infrastructure errors may be retried with bounded backoff. Contract,
leakage, invalid-metric, and repeated code failures should create a repaired or
alternate child route. The failed run remains immutable and must not influence a
promotion claim as if it succeeded.

### 6. Build a skill and experience library with provenance

Reusable procedures should record their source run, environment, scope, and known
failure modes. Retrieval should propose a starting point, never silently transfer
validity from one challenge or research domain to another.

## Current Evidra coverage

The implementation already contains the main architecture implied by these rules:

- durable SQLite state, event history, manifests, artifacts, and isolated worktrees;
- research and challenge phase machines with typed metric and non-metric evidence;
- multi-agent lanes, bounded cross-pollination, critics, source retrieval, and
  experience replay;
- local, container, and Modal execution with provider fallback and recovery;
- matched harness benchmarks, component-change checks, and trajectory quality;
- multi-objective validation, subgroup protection, replication, and statistical gates;
- an extensible evaluator parser plus built-in accuracy, F1, regression, ranking,
  overlap, and ordinal-agreement metrics.

The remaining frontier is empirical: run matched harness trials on held-out tasks,
measure whether each mechanism improves valid evidence per unit cost, and retain
only changes that survive replication. This document is a design input, not proof
that Evidra beats another harness.

## Implementation backlog derived from the synthesis

1. Add a durable harness-change record with component checksums, forecasts, and
   matched evaluation identity.
2. ~~Add a verified skill/procedure registry separate from claims and raw experience.~~
   Implemented as provenance-linked, schema-validated playbook leads derived only
   from independently replicated methods; each playbook carries transfer failure
   modes and remains a lead until freshly tested.
3. ~~Add Pareto and constraint-based objective handling for mixed metric/artifact/
   verifier campaigns.
   Implemented for normalized metric suites and non-metric objective values;
   incomparable survivors are retained through Pareto promotion.~~
4. Add held-out cross-provider harness evaluation to the benchmark runner.
5. ~~Generate a final research report from immutable evidence with explicit
   uncertainty, failed directions, and reproduction commands.
   Implemented through the durable report and claim-audit pipeline; the remaining
   empirical work is to validate report usefulness on held-out campaigns.~~

## Sources

The links above point to the original papers or publisher material. Claims are
paraphrased; no generated agent summary is treated as primary evidence.
