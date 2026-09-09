# 2026 Agentic Kaggle Playbook

## Executive conclusion

The 2026 public evidence does not support building Evidra as an unconstrained swarm that repeatedly asks an LLM to “try something better.” The strongest agent-assisted competition workflows look like small research organizations:

```text
competition profiler
        ↓
researcher / worker lanes
        ↓
cheap executable test
        ↓
exact verifier and independent critic
        ↓
promotion ledger
        ↓
next targeted experiment
```

The durable advantage is not the number of agents. It is the quality of the feedback loop: every candidate is runnable, scored, compared against a baseline, checked for hidden failure modes, and either promoted or rejected with an explanation.

For Evidra, this means the central product should be a **research operating system** with five strict separations:

1. The model proposes; deterministic code evaluates.
2. Exploration is parallel; promotion is serialized.
3. Every change is a hypothesis, not an untracked edit.
4. Local validation and external feedback are separate evidence sources.
5. “YOLO” means no human confirmation at routine gates—not no gates.

## What the 2026 competition evidence shows

### 1. Supervisor-worker decomposition beats a flat swarm

The 2026 NeuroGolf write-ups describe a supervisor/worker system operating over 400 independent tasks. Supervisors grouped tasks, seeded workers with task-specific assets and prompts, monitored health, and validated candidates before promoting them. One report describes roughly 50 worker sessions across five supervisors; another emphasizes retrieval of structurally similar models, reusable optimization recipes, and preservation of successful and failed transformations.

The transferable pattern is not “launch 50 agents.” It is **bounded parallelism over independent research units**, with a supervisor responsible for context, triage, and promotion. Evidra should therefore model a research lane explicitly:

```text
lane = { hypothesis, worktree, worker, evaluator, verifier, ledger }
```

The director should never ask all agents to edit the same branch. Each lane receives one hypothesis, one parent commit, one budget, and one completion condition.

Sources: [NeuroGolf 26th-place write-up](https://www.kaggle.com/c/neurogolf-2026/writeups/neurogolf-26th-place-solution-writeup), [NeuroGolf 78th-place campaign](https://www.kaggle.com/competitions/neurogolf-2026/writeups/78th-place-a-week-long-autonomous-agent-campaign).

### 2. Exact validators are more valuable than more reasoning

The NeuroGolf agent workflows used mechanical validation and promotion thresholds. The 26th-place report says candidates were checked for correctness and overfitting before promotion; the 36th-place report describes 400 independently validated ONNX programs and a local gate that passed all 400 tasks structurally before submission.

This is directly applicable to WhestBench. Evidra must distinguish:

- code ran;
- output exists;
- output is structurally valid;
- metric was recomputed independently;
- the comparison is fair;
- no leakage or test contamination was detected;
- the improvement replicated;
- the candidate is safe to promote.

A high LLM confidence score must never substitute for a failed evidence gate.

Source: [NeuroGolf 36th-place guarded agent workflow](https://www.kaggle.com/c/neurogolf-2026/writeups/neurogolf-as-program-synthesis-a-guarded-agent-lo).

### 3. Winners still use simple, domain-specific solutions

The 2026 Maze Crawler winner explicitly describes a heuristic solution: scored BFS, a resource/economy policy, and a combat tiebreak strategy—without learning or a search tree. The 2026 Orbit Wars winner deliberately used a simple observation/action space and scaled self-play reinforcement learning to a large training budget, while using fully agentic software development.

The implication for Evidra is important: the research director must be able to select “simplify the representation” or “change the objective” as a first-class hypothesis. It must not default to larger models, more hyperparameters, or more agents.

The competition profiler should ask:

- Is this primarily a representation problem?
- Is the evaluator exploitable or merely misunderstood?
- Is a heuristic stronger than a learned policy?
- Is the bottleneck data, objective design, inference budget, or search?
- Which part of the pipeline actually controls the score?

Sources: [Maze Crawler first-place solution](https://www.kaggle.com/c/maze-crawler/writeups/maze-crawler-1st-place-preliminary-solution-wr), [Orbit Wars first-place solution](https://www.kaggle.com/c/orbit-wars/writeups/1st-place-solution-scaling-reinforcement-learnin).

### 4. Competition research begins with probing, not speculation

The 2026 AI Agent Security winner reports surveying the relevant literature, forming hypotheses about the hidden guardrail, and then using private leaderboard probes to identify the reliable scoring route. The final improvement was a targeted adaptation of GCG that removed a wasted second hop after successful tool calls.

The lesson is not to overfit a leaderboard. It is to design submissions as experiments. Every external score must answer a declared question, such as:

```text
Does source-holdout performance predict the hidden test distribution better than random group CV?
```

Evidra should reject submissions whose stated purpose is only “see if it scores higher.” A submission is valuable when it discriminates between competing beliefs about the test distribution or scoring function.

Source: [AI Agent Security first-place solution](https://www.kaggle.com/competitions/ai-agent-security-multi-step-tool-attacks/writeups/1st-place-solution).

### 5. Trace design and representation can matter more than model size

The 2026 NVIDIA Nemotron reasoning challenge winner describes deciding what the model should memorize through synthetic traces and what it should compute inside the trace. That is a form of task decomposition and data/trace design, not simple model shopping.

For general ML competitions, Evidra should represent transformations as explicit components—data view, target construction, loss, sampler, augmentation, training recipe, inference, post-processing, and ensemble. Agents should be asked to improve one component at a time and to justify why the component is causal for the metric.

Source: [NVIDIA Nemotron Model Reasoning Challenge first-place solution](https://www.kaggle.com/competitions/nvidia-nemotron-model-reasoning-challenge/writeups/1st-place-solution).

### 6. Diversity is an objective, not a side effect

The 2026 Autonomous Agent Prediction write-up is explicitly diversity-first ensembling. This matches the general pattern in strong competition solutions: the final winner is often a portfolio of models or views whose errors are complementary, not the single model with the best isolated validation score.

Evidra should track out-of-fold prediction artifacts as first-class objects and score candidates on:

- standalone metric;
- fold and seed stability;
- error correlation with the current champion;
- subgroup complementarity;
- calibration;
- additional compute and operational risk.

An experiment with a slightly lower score but genuinely orthogonal errors may be more valuable than a small improvement from another correlated model.

Source: [Diversity-First Ensembling for a Self-Driving Kaggle Agent](https://www.kaggle.com/competitions/autonomous-agent-prediction-beta/writeups/rank51-solution).

## What research-agent systems add

The 2026 competition reports show practice. Research systems explain which mechanisms are worth implementing.

### MLE-STAR: search, targeted refinement, and checking

Google’s MLE-STAR reports three ideas that should be core Evidra behavior:

1. Use web search to retrieve relevant modern model and pipeline choices.
2. Identify the code block with the largest contribution through ablation.
3. Refine that block repeatedly instead of rewriting the entire solution.

It also adds debugging, data leakage, and data-usage checkers. The published evaluation reports medals in 63% of MLE-Bench-Lite competitions, but this is a benchmark result, not a guarantee for arbitrary live competitions. The architectural lesson is stronger than the exact number: **targeted refinement plus verifiers outperforms blind whole-pipeline rewriting**.

Source: [Google Research: MLE-STAR](https://research.google/blog/mle-star-a-state-of-the-art-machine-learning-engineering-agents/).

### R&D-Agent: research and development are separate loops

R&D-Agent uses a Researcher to generate ideas from performance feedback and a Developer to refine executable code, with parallel exploration traces that can merge. Evidra should adopt this split:

- Researcher: proposes hypotheses and predicts mechanisms.
- Engineer: implements exactly one accepted hypothesis.
- Critic: reviews the diff and experimental validity.
- Evaluator: runs deterministic metrics.
- Director: chooses the next branch from evidence.

The director should not directly write code while deciding strategy.

Source: [R&D-Agent paper](https://arxiv.org/abs/2505.14738).

### Search policies need deliberate operators

Research on AI research agents for MLE-Bench formalizes agents as search policies over candidate solutions. Greedy, MCTS, and evolutionary policies behave differently depending on the available mutation operators and evaluation methodology; the strongest reported pairing improved medal success on MLE-Bench Lite from 39.6% to 47.7%.

Evidra should begin with a practical operator library rather than a large generic swarm:

- representation mutation;
- data split mutation;
- feature or modality addition;
- loss/objective mutation;
- training recipe mutation;
- inference/post-processing mutation;
- ensemble mutation;
- repair mutation;
- replication mutation.

Every operator must declare expected cost, risk, and required evidence.

Source: [AI Research Agents for Machine Learning](https://arxiv.org/abs/2507.02554).

### AutoKaggle: phase gates and unit tests

AutoKaggle separates background understanding, preliminary EDA, data cleaning, deep EDA, feature engineering, and model/validation/prediction. Its ablations report large completion improvements from tools and unit tests, and performance degrades when iterative debugging is removed.

Evidra should use the same phase discipline, but make the phases persistent and resumable. A competition cannot enter expensive model search until the data manifest, baseline, split policy, and evaluator pass their gates.

Source: [AutoKaggle](https://arxiv.org/abs/2410.20424).

## The Evidra architecture we should build

### Research controller

The controller owns the state machine and budgets. It is the only component allowed to promote experiments, mutate the active baseline, or spend external compute.

```text
DISCOVER
  → AUDIT
  → BASELINE
  → HYPOTHESIZE
  → SCREEN
  → IMPLEMENT
  → REVIEW
  → SMOKE
  → RUN
  → EVALUATE
  → REPLICATE
  → ACCEPT | REJECT | INVALID
```

### Research lanes

Use a small number of persistent lanes rather than a free-form swarm:

| Lane | Responsibility | Main output |
|---|---|---|
| Director | choose the next high-value question | decision + ranked hypotheses |
| Data detective | data quality, shift, duplicate, leakage | audit findings |
| Validation scientist | split design and uncertainty | locked split version |
| Model researcher | methods and adaptations | hypothesis |
| Experiment engineer | isolated implementation | commit + manifest |
| Critic | independent review | approval or invalidation |
| Ensemble scientist | OOF diversity and blend | ensemble candidate |

### Knowledge retrieval

Research retrieval should ingest competition rules, official docs, papers, repositories, and prior solution write-ups. It must store the URL, retrieval date, source hash, license, extracted claims, and the competition differences that make a technique transferable or not.

The retrieval prompt must ask for adaptation, not copying:

```text
What did the source optimize?
What assumptions made it work?
Which assumptions differ in this competition?
What is the cheapest falsification experiment?
What leakage or licensing risks exist?
```

### Early evaluation and cost prediction

Before a full run, Evidra should execute:

1. syntax/import check;
2. unit tests;
3. tiny data smoke run;
4. one-fold reduced-data run;
5. early metric checkpoint;
6. full one-seed run;
7. multi-seed replication.

The director should learn which early metrics predict final success. This is one of the highest-return additions for local and Modal budgets.

### Promotion ledger

Every candidate needs a machine-readable verdict:

```json
{
  "candidate": "exp_0042",
  "verdict": "accepted|rejected|invalid|replicate",
  "primary_delta": 0.0021,
  "confidence": 0.94,
  "worst_slice_delta": -0.0004,
  "independent_recompute": true,
  "leakage_status": "passed",
  "reason": "Improves three locked folds and survives a fresh seed."
}
```

The ledger is more important than the conversational transcript.

## 2026-informed research loop for WhestBench

For ARC White-Box Estimation, the first serious campaign should be:

1. Reproduce one valid baseline and record its exact score, runtime, environment, predictions, and hashes.
2. Inspect the evaluator and dataset contract before proposing model changes.
3. Build a split/data audit: duplicate structures, group relationships, target distribution, and train/test mismatch.
4. Create three representation hypotheses, not three random model variants.
5. Run cheap screening on a fixed mini split.
6. Have a critic independently inspect every apparent gain.
7. Promote only candidates whose improvement survives a fresh seed or complementary split.
8. Store prediction artifacts so diversity can be measured later.
9. Use external feedback only as a declared distribution hypothesis test.
10. Keep a reserved budget for replication and final diverse models.

The director’s first question should therefore be “what is the current uncertainty?” rather than “what model should we try next?”

## YOLO mode, correctly defined

Evidra can support a fully autonomous mode, but it needs levels:

| Mode | Automatic | Human approval required |
|---|---|---|
| Safe | analysis, smoke tests, local runs | code promotion, paid compute, submissions |
| Fast | local implementation and promotion after gates | external compute, submissions |
| YOLO | all routine code, local/Modal runs, replication | only submissions, secret access, destructive actions |
| Unrestricted | not supported | — |

YOLO should remove waiting, not remove reproducibility. It should still keep worktrees, immutable manifests, timeouts, resource budgets, evidence gates, and rollback points.

## Build order for Evidra

### Next implementation tranche

1. Competition project manifest and schema validation.
2. Dataset manifest and deterministic hash registry.
3. Split registry with locked versions.
4. Baseline run protocol producing metrics and predictions.
5. Experiment manifest and local worker protocol.
6. Independent metric recomputation and leakage checks.
7. Research lane scheduler with cost-aware priority.
8. Research retrieval cache and adaptation records.
9. OOF prediction store and diversity-first ensemble lab.
10. Modal executor and failure recovery.
11. Kaggle/manual submission adapters and submission-question ledger.
12. YOLO policy configuration and terminal dashboard.

This order follows the 2026 evidence: make the evaluator and memory reliable before increasing agent count.

## Evidence limits

Public 2026 write-ups demonstrate that agents can be useful in competition workflows, but they do not establish that generic autonomous agents consistently beat top human Kaggle teams. Several sources are self-reported write-ups, some competitions are game-like or program-synthesis tasks rather than conventional supervised ML, and leaderboard performance is not equivalent to reproducible research quality. Evidra should therefore track verified local evidence, external scores, and source claims as separate evidence classes.

The appropriate ambition is not “copy a winner.” It is to build a system that can discover which parts of a winning workflow transfer to the current competition, test those assumptions cheaply, and preserve the result for the next campaign.

## OpenAI’s 2026 mathematical-research workflow

OpenAI’s September 2026 account of its Navier–Stokes effort provides a useful research-system case study, but its claims should be treated as an OpenAI-reported result pending independent mathematical review. OpenAI says the system produced both an analytical proof and a Lean formalization, and explicitly says it does not intend to claim the Millennium Prize. The important lesson for Evidra is the workflow, not the headline.

### 1. Variant decomposition

OpenAI split each Millennium problem into variants that would imply a proof or a disproof. Different groups received different variants. This creates a portfolio of mutually informative research directions rather than asking every agent the same question.

For Evidra, every campaign should begin with a **hypothesis matrix**:

```text
question: what explains the current score ceiling?
variant A: representation is missing
variant B: validation is misleading
variant C: evaluator/data contract is misunderstood
variant D: model capacity is limiting
variant E: inference/ensemble is limiting
```

The director allocates small budgets across variants, then reallocates toward variants that produce verified progress.

### 2. Easier precursor problems

OpenAI reports that nearly 100 agents worked for about 50 hours on a related Euler regularity problem. After seeing that result, it shifted resources to Navier–Stokes and supplied the earlier resolution as context. This is a **ladder of increasingly difficult problems**, not a single giant attempt.

For Evidra, the analogue is:

1. evaluator sanity task;
2. tiny-data baseline;
3. one-fold reproduction;
4. simplified ablation;
5. full experiment;
6. replication under a new seed or split;
7. external validation.

The result of a precursor experiment must be packaged as a reusable research artifact, not pasted into an agent transcript.

### 3. Cross-pollination after independent exploration

OpenAI says it first encouraged diverse groups to explore independently, then used Codex to consolidate the most useful insights across groups. This avoids premature consensus while still allowing recombination.

Evidra should implement a two-stage merge:

```text
independent lanes → evidence normalization → critic comparison → merge proposal → fresh implementation lane
```

The merge agent must see evidence and artifacts from each branch, not just summaries. It should be forbidden from merging incompatible changes without an explicit ablation plan.

### 4. Continuous model and context upgrades

OpenAI reports updating agents to a further-trained internal model during the effort and shifting agents away from less promising problems after the Euler result. This is an **adaptive resource allocator**.

Evidra should support model substitution without changing experiment identity:

- the hypothesis and manifest remain stable;
- the agent runtime/model is recorded as execution metadata;
- a change in model creates a new attempt, not a rewritten history;
- the controller can move from Codex to local Qwen when limits are reached;
- stronger models are reserved for synthesis, repair, and promotion decisions.

### 5. Formal verification is the strongest kind of critic

OpenAI reports 17 additional hours of Lean formalization and verification after the Navier–Stokes resolution. In its 2026 scientific-collaborator report, OpenAI describes the same principle more generally: language models propose arguments while external formal systems detect gaps and force explicit steps.

For ML research, Lean is not the universal verifier, but the principle transfers directly:

- Python evaluator independently recomputes metrics;
- dataset checks verify sample identity and provenance;
- leakage checker inspects train/test boundaries;
- statistical tests verify claimed improvements;
- reproducibility runner rebuilds the candidate in a fresh worktree;
- a separate critic reviews the causal interpretation.

The agent should never be allowed to certify its own result without an independent checker.

### 6. Human steering remains part of the loop

OpenAI’s First Proof report says human researchers suggested retry strategies, asked for clarification after expert feedback, and used fresh ChatGPT conversations for verification, formatting, and style. OpenAI’s research-acceleration report also says researchers still set priorities, judge results, and decide whether to scale, pause, or deploy.

This argues against pretending that a “fully autonomous” research tool has no human role. Evidra’s YOLO mode should automate routine execution while preserving explicit decision points for problem selection, budget changes, external publication/submission, secrets, and surprising results.

Sources: [OpenAI on the Navier–Stokes problem](https://openai.com/index/navier-stokes-solution/), [OpenAI Research acceleration](https://openai.com/index/research-acceleration-view-inside-openai/), [OpenAI First Proof submissions](https://openai.com/index/first-proof-submissions/), [OpenAI AI as a Scientific Collaborator](https://cdn.openai.com/pdf/f4b4a5da-b2de-418d-9fcd-6b293e9dc157/oai_ai-as-a-scientific-collaborator_jan-2026.pdf).

## The `/workbench` product direction

Evidra should become the command-line identity, while **Workbench** is the operating mode and architecture:

```text
Evidra Workbench
├── Problem map       competition, data, rules, evaluator
├── Research map      questions, variants, hypotheses, sources
├── Experiment map    worktrees, manifests, runs, artifacts
├── Evidence map      metrics, slices, leakage, replications
├── Resource map      Codex, local models, GPU, Modal, budgets
└── Decision map      promote, reject, replicate, stop, submit
```

The central innovation should be a **research graph with executable edges**. A node is an observation, hypothesis, source, experiment, result, or decision. An edge records not only that two nodes are related, but what action can be executed next and what evidence would change the edge’s confidence.

Example:

```text
Observation: mean_propagation fails on high-variance items
    └─ supports → Hypothesis: preserve per-block covariance
          └─ executable edge → exp_0003
                ├─ verifies → metric report
                ├─ contradicted by → leakage audit
                └─ requires → fresh-seed replication
```

This is more useful than a chat history because it lets the director ask: “Which unresolved edge has the highest expected information per GPU-hour?”

## Implementation consequence

The next code tranche should add:

1. research variants and lane allocation;
2. source/claim/adaptation records;
3. precursor experiment chains;
4. cross-lane evidence normalization;
5. fresh-context critic jobs;
6. promotion and rollback ledger;
7. model/runtime substitution records;
8. verifier plugins for metrics, leakage, reproducibility, and statistical claims;
9. resource-aware scheduling across Codex, Qwen, local GPU, and Modal;
10. a `/workbench` dashboard showing the graph, not just the last chat response.

OpenAI’s reported result used extreme scale—on the order of 10,000 concurrent agents, millions of messages, and massive inference compute. Evidra should not imitate that scale on a workstation. It should imitate the control logic: diversity first, precursor results, targeted cross-pollination, adaptive allocation, and independent verification.

## Sources

- Kaggle, [NeuroGolf 26th-place solution](https://www.kaggle.com/c/neurogolf-2026/writeups/neurogolf-26th-place-solution-writeup).
- Kaggle, [NeuroGolf guarded agent workflow](https://www.kaggle.com/c/neurogolf-2026/writeups/neurogolf-as-program-synthesis-a-guarded-agent-lo).
- Kaggle, [NeuroGolf 78th-place autonomous campaign](https://www.kaggle.com/competitions/neurogolf-2026/writeups/78th-place-a-week-long-autonomous-agent-campaign).
- Kaggle, [Maze Crawler first-place solution](https://www.kaggle.com/c/maze-crawler/writeups/maze-crawler-1st-place-preliminary-solution-wr).
- Kaggle, [Orbit Wars first-place solution](https://www.kaggle.com/c/orbit-wars/writeups/1st-place-solution-scaling-reinforcement-learnin).
- Kaggle, [NVIDIA Nemotron Model Reasoning Challenge first-place solution](https://www.kaggle.com/competitions/nvidia-nemotron-model-reasoning-challenge/writeups/1st-place-solution).
- Kaggle, [AI Agent Security first-place solution](https://www.kaggle.com/competitions/ai-agent-security-multi-step-tool-attacks/writeups/1st-place-solution).
- Kaggle, [Diversity-First Ensembling for a Self-Driving Kaggle Agent](https://www.kaggle.com/competitions/autonomous-agent-prediction-beta/writeups/rank51-solution).
- Yoon and Nam, [MLE-STAR](https://research.google/blog/mle-star-a-state-of-the-art-machine-learning-engineering-agents/).
- Yang et al., [R&D-Agent](https://arxiv.org/abs/2505.14738).
- Toledo et al., [AI Research Agents for Machine Learning](https://arxiv.org/abs/2507.02554).
- Li et al., [AutoKaggle](https://arxiv.org/abs/2410.20424).
- Chan et al., [MLE-bench](https://openai.com/index/mle-bench/).
- OpenAI, [On the Navier–Stokes Millennium Prize Problem](https://openai.com/index/navier-stokes-solution/).
- OpenAI, [Research acceleration: The view inside OpenAI](https://openai.com/index/research-acceleration-view-inside-openai/).
- OpenAI, [Our First Proof submissions](https://openai.com/index/first-proof-submissions/).
- OpenAI, [AI as a Scientific Collaborator](https://cdn.openai.com/pdf/f4b4a5da-b2de-418d-9fcd-6b293e9dc157/oai_ai-as-a-scientific-collaborator_jan-2026.pdf).
