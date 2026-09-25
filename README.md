# Evidra

Evidra is a research and experimentation workbench for people who want an agent to do more than write code.

It turns a research workspace, competition repository, or empirical engineering problem into a durable loop:

    inspect → gather evidence → form hypotheses → implement → run → evaluate → replicate → promote

The model supplies reasoning. Evidra owns the deterministic and auditable parts: workspace inspection, tool permissions, experiment state, process control, artifacts, validation policy, evidence memory, queues, budgets, and recovery.

The workbench is general-purpose. It can be used for ML competitions, data science, scientific experiments, benchmark optimization, algorithm research, reverse engineering, and repository investigations. AIcrowd's ARC White-Box Estimation Challenge (WhestBench) is the first included trial adapter, not the product's scope.

## Start here

Install the latest source build globally with Node.js 22 or newer:

```bash
curl -fsSL https://raw.githubusercontent.com/StarAtNyte/evidra/master/install.sh | sh
```

Or install directly from the public GitHub repository:

```bash
npm install --global https://github.com/StarAtNyte/evidra.git
```

For local development, use the checkout workflow below:

```bash
nvm install 22
nvm use 22
npm install
npm run build
npm link
evidra
```

Inside the TUI, authenticate and choose the Codex route with `/login codex`,
select a model with `/model`, and select reasoning effort with `/thinking`.
Ordinary text is handled as normal conversation. Use `/research start` for an
autonomous research campaign, `/challenge start` for a challenge campaign, or
`!ls` to run an explicit terminal command. Type `/` for live command
suggestions and Tab completion.

The practical user guide is [`docs/user-guide.md`](docs/user-guide.md), and the
complete interactive command catalog is [`docs/command-surface.md`](docs/command-surface.md).
It covers Codex sessions, model routing, permissions, steering and queued
messages, provider-limit recovery, autonomous phase goals, experiments,
Modal/container execution, evidence gates, reports, and external submissions.
For the Codex-specific runtime contract, session lifecycle, interruption and
steering semantics, permission boundaries, provider exhaustion, and unattended
campaign checklist, see [`docs/codex-operations.md`](docs/codex-operations.md).

### See the workflow

The silent product demo shows Evidra taking a contemporary computer-vision question
from an empty workspace through three research steps: orient the evaluation
contract, discover methods and evidence, then run controlled experiments and
replication.

- [Download the complete demo video](assets/demo/evidra-complete-product-demo.mp4)
- [Read the exact three-step screenplay](docs/demo-research-script.md)

## Why Evidra

Most coding agents optimize for one conversation and one code change. Evidra is designed for research programs that continue after the first answer:

- **Evidence before conclusions.** The director can inspect files, search the workspace, read sources, audit data, inspect Git, run safe commands, retrieve literature, and receive results in its next reasoning turn.
- **Literature becomes testable work.** Independent research lanes search OpenAlex and arXiv, retrieve bounded primary sources, cache them, and adapt them into falsifiable hypotheses with explicit low-confidence provenance and source-to-claim graph edges.
- **Falsifiable research.** Decisions contain phases, goals, hypotheses, expected effects, costs, risks, dependencies, and explicit falsification tests.
- **Durable state.** SQLite and an append-only event log preserve projects, claims, sources, hypotheses, decisions, experiments, runs, artifacts, phase goals, agent lanes, sessions, and queue tasks.
- **Regime-aware memory.** Retrieval is routed as discovery or execution: broad literature/repository leads are useful while forming ideas, while active tests, controls, failures, ablations, and falsification work receive priority during execution. The regime and bounded quotas are fingerprinted for replay.
- **Procedural memory.** Passing experiment trajectories can crystallize into separate execution playbooks containing executor, evaluation, verification, artifact, and environment steps. They improve future setup reliability but never count as scientific proof or bypass fresh validation.
- **Typed decision integrity.** Before a research or challenge decision can drive execution, the controller rejects duplicate hypothesis titles and selections that do not exist in that exact decision payload; ambiguous model output is downgraded to inspection and retained in the audit trail.
- **Honest tool outcomes.** Read-only shell observations preserve bounded stdout/stderr, but a nonzero process exit is reported as `ok: false` so the director replans from failed tests instead of treating them as evidence of success.
- **Typed change review.** The director can request a bounded `git.diff` observation for implementation and recovery review; it compares `HEAD` with both staged and unstaged changes, is provenance-traced, and is treated as untrusted workspace data rather than executable instructions.
- **Complete workspace inventory.** Repository inspection includes hidden project control files such as `.github` workflows while excluding `.git`, Evidra state, and dependency trees.
- **Span-level literature provenance.** Retrieved claims retain the exact excerpt and character offsets from the hashed source alongside the claim text, so literature-derived hypotheses can be audited back to source material instead of relying on an untraceable summary.
- **Evidence-ranked extraction.** Bounded paper claims are selected using method/result/validation/limitation signals and position diversity, so important late-paper ablations and failure modes are not lost to first-sentence extraction.
- **Stale-claim quarantine.** Refreshing a source retires claims linked to the superseded content hash; they remain available as historical negative evidence but are excluded from active research memory.
- **Active-conflict accounting.** Contradiction pressure is calculated only from active claim endpoints, so refreshed or invalidated literature cannot keep autonomous allocation permanently stuck in an obsolete conflict state.
- Duplicate-claim pressure follows the same rule: historical duplicate events are retained, but only findings involving active claims influence allocation, audits, and reports.
- When duplicate provenance identifies both claims, both endpoints must still be active before the finding contributes pressure; anonymous legacy events remain conservative.
- Active-claim resolution also checks linked source lifecycle state, so older databases with superseded sources cannot reintroduce stale literature claims after restart.
- **Concurrent lane safety.** The SQLite store uses WAL and a bounded writer wait, so parallel Codex lanes can record observations and traces without turning brief writer contention into lost research evidence.
- **Bounded autonomy.** A campaign has an ultimate goal, internal phase goals, a budget, and a stopping condition. It pauses when genuinely blocked and can resume later.
- **Reproducible execution.** Experiment manifests, Git worktrees, run metadata, metrics, logs, checksums, and environment snapshots make results inspectable.
- **Provider choice.** Use the authenticated Codex CLI with a ChatGPT subscription or a local Ollama model.
- **Human control.** Safe, fast, and YOLO permissions change automation level, while destructive commands and external submissions remain blocked.

## Current maturity

Evidra is an active TypeScript foundation for both normal research and
challenges—not a Kaggle-only runner. The controller primitives are implemented
and tested; domain-specific training, metrics, split strategies, cloud
executors, evaluators, and submission adapters are loaded from the active
workspace or added incrementally. A research goal may be a metric, artifact,
proof, behavior, system property, or another explicitly verifiable outcome.

## Research architecture inspired by frontier research systems

Evidra is designed around a bounded version of the workflow described by [OpenAI in its 2026 Navier–Stokes report](https://openai.com/index/navier-stokes-solution/): independent groups explore different formulations, groups communicate useful intermediate results, promising directions are consolidated, and a separate verification stage checks the final claim. Evidra applies the same pattern to empirical research:

```text
problem variants → independent research lanes → evidence/artifacts
                 → cross-pollination → critic/replication → promotion
```

The deterministic controller remains the source of truth. Agents propose hypotheses, write code in isolated worktrees, and explain evidence; evaluators, checksums, split policies, reviewers, and approval gates decide whether a result is valid. This makes the pattern useful for competitions, engineering investigations, scientific experiments, and other challenge repositories without assuming a theorem prover or a particular model family.

Metric handling is similarly generic: a workspace may expose any named scalar metric (classification, regression, ranking, or a custom evaluator) and may optionally declare `secondaryMetrics` with their own maximize/minimize direction and regression tolerance. The built-in registry covers accuracy, F1, RMSE/MAE, log loss, AUROC, average precision/MAP, NDCG, Spearman, quadratic weighted kappa, IoU, and Dice; unknown metrics remain evaluator-defined. The primary metric decides the headline improvement; secondary objectives act as explicit safety gates, so optimizing one score cannot silently damage another. Non-metric outcomes use declared artifacts and verifier evidence instead of fabricated scores.

Benchmark arms accept the same general contract: `metric` identifies the headline score, optional `requiredMetrics` declares auxiliary metrics that must be emitted for a valid run, and optional `metricGates` declares direction-aware non-regression tolerances for safety, latency, calibration, cost, or other secondary objectives. The runner preserves the complete finite suite for diagnostics and fairness checks while keeping legacy primary-score comparisons compatible. This supports quality, latency, safety, calibration, cost, and other task-specific objectives without hard-coding them into the harness. Arms may also declare `provider` so Codex-vs-local or other route studies retain explicit provenance and cannot be silently paired as identical environments.

Normal benchmark claims reject mixed providers on a matched arm. Intentional route studies use the explicit provider comparison diagnostic, keeping provider choice visible instead of allowing it to masquerade as a harness improvement.
Provider-route claims can also require task-disjoint transfer: the same comparison gate is run on training and held-out task sets, and a route win is rejected unless it survives both.

Provider exhaustion is autonomous by default. The `auto` policy first selects an installed local Qwen/Ollama model, then waits durably for the Codex entitlement reset if no local model is available. Use `/limits auto`, `/limits fallback`, `/limits wait`, or `/limits stop` in the TUI to choose explicitly. The fallback model can be pinned with `EVIDRA_FALLBACK_MODEL`, or per campaign with `--fallback-model qwen3.6:27b`; that choice is stored in the campaign runtime and restored on resume.

The cost-conscious Codex defaults are `gpt-5.6-luna` and medium thinking effort across the CLI, TUI, autonomous research, challenge campaigns, and harness benchmarks. Evidra does not select Astra automatically. An explicitly selected Astra route is preserved in the campaign runtime and remains visible in provenance; users can choose models explicitly with `/model`.

Lane concurrency is adaptive: `safe` runs one independent lane, while `fast` and `yolo` use a bounded asynchronous completion-driven scheduler. Capacity is refilled as specialists finish, and each later lane receives a compact cross-pollination board from completed peers; no mutable workspace or live transcript is shared between lanes. Local Ollama concurrency also respects `OLLAMA_NUM_PARALLEL`; the TUI never interprets YOLO as permission to exhaust a laptop, subscription, or external service.

### Local controller versus Modal controller

Normal operation is a local controller with a selectable experiment target:

```text
local TUI/controller ──► local experiment worker
                     └─► Modal GPU experiment worker
```

Use `/compute local`, `/compute container`, `/compute modal`, or `/compute slurm` before proposing an experiment, or use `evidra experiment propose --executor container`. Container workers use Docker or Podman (auto-detected, or selected with `EVIDRA_CONTAINER_RUNTIME`), mount only the isolated experiment worktree, disable network access by default, and use `EVIDRA_CONTAINER_IMAGE` or the manifest image (default `python:3.11-slim`). Modal workers receive the workspace and declared command, stream prefixed `[evidra-worker:stdout]`/`[evidra-worker:stderr]` progress while running, and return bounded logs plus declared artifacts. Slurm workers submit through `sbatch`, poll `squeue`, collect terminal state through `sacct`, and retain bounded scheduler logs under `.sota/slurm`; the experiment worktree must be visible on shared storage to the compute nodes. The controller evaluates every route through the same local evidence gates.

For unattended operation, `modal_controller.py` runs the Node controller headlessly in Modal and stores durable `.sota` state in a Modal Volume:

```bash
EVIDRA_MODAL_WORKSPACE="$PWD" modal run modal_controller.py::run \
  --goal "maximize robust validation performance" --budget 4h --mode challenge --competition arc-whestbench-2026 --executor local --autonomy fast --lanes 3
```

The Modal controller also accepts `--limit-policy` and `--fallback-model`.
For example, `--limit-policy auto --fallback-model qwen3.6:27b` uses a healthy
local route when one is available in the controller image; the default Modal
policy remains `wait` because the controller image does not include an Ollama
server by default.

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
Autonomous campaigns accept `--gpu-budget <hours>` (zero means unlimited). Before each GPU-backed experiment, Evidra atomically reserves the declared cost against observed usage plus other active reservations; over-budget work is blocked and recorded rather than launched. Reservations are released on terminal outcomes, shown by `/usage`, and retained across crashes until startup recovery resolves the running experiment.

Agent inference can be governed independently of wall-clock and GPU budgets. Set `--agent-token-budget <tokens>` on `evidra research` or `evidra challenge start`; the default `0` is unlimited. Usage is attributed to the durable campaign start boundary, counted across Codex/local routes, and checked before the next agent allocation. When the ceiling is reached, Evidra pauses the campaign with a durable `research.agent_budget.exhausted` event instead of starting another turn, and cancels queued tasks belonging to that campaign so a second controller cannot spend past the hard stop. Each cancellation preserves its reason and timestamp in the task payload and audit log. Use `--role-token-budgets "validation scientist=20000,model researcher=30000"` to prevent one specialist from consuming the whole campaign allowance; exhausted roles are removed from the next lane allocation while the campaign continues with other routes. In the TUI, use `/budget tokens <count>`, `/budget role <role> <count>`, `/budget`, or `/budget tokens 0` to inspect, set, or remove ceilings. These limits are included in the campaign runtime fingerprint and are preserved on resume.

Every executor exposes the same experiment configuration contract to worker code. Evidra writes a redacted JSON document at `.sota/experiment-config.json` and sets `EVIDRA_EXPERIMENT_CONFIG` plus `EVIDRA_EXPERIMENT_ID`; container and Modal workers receive the equivalent `/workspace/.sota/experiment-config.json` path. The document contains the immutable experiment id, dataset/split versions, declared fold/seed matrix, resource route, and `configPatch`, so ablations and research-generated variants are real, reproducible inputs rather than metadata-only labels. Training code may load it in any language without depending on Evidra internals. Dataset and split versions are also available as `EVIDRA_DATASET_VERSION` and `EVIDRA_SPLIT_VERSION`.

Worker processes receive a minimal runtime environment (`PATH`, locale, temporary directories, and hardware/runtime hints) plus a workspace-scoped or ephemeral `HOME`; they cannot inherit the controller user's dotfiles. Controller credentials—including Codex, OpenAI, Modal, competition, GitHub, and arbitrary `*_TOKEN`/`*_KEY`/`*_SECRET` values—are stripped before local or Modal experiment code starts. Credentials are therefore available only to the controller/provider boundary that explicitly needs them, never as ambient inputs to model-generated training code.
For rigorous multi-run evaluation, set `execution.matrixRequired: true` in the competition contract (or `evaluation.matrixRequired: true` in an individual manifest) and emit JSON such as `{"evaluation":{"results":[{"fold":0,"seed":17,"metrics":{"macro_f1":0.81}}]}}`. Evidra checks exact fold×seed coverage and the declared primary metric during evidence audit; legacy single-command workers remain supported when this contract is not requested.

Provider and lane failures are recoverable. Transient network, timeout, stream, malformed-response, and service errors receive bounded retries with backoff; configured Codex-to-local fallback changes route when appropriate; every exhausted lane is recorded as failed evidence so the director can choose a different path instead of silently treating it as success. SDK subprocesses are cancelled on timeout and terminal interruption.

Lane tool failures are also bounded and observable: each transient inspection-tool error is retried once, then preserved in the lane context so the agent can explain the missing observation or choose another route. A failed tool call no longer discards the entire independent lane.

Experiment manifests are immutable measurement identities. After a manifest completes, fails after bounded recovery, or is rejected by an evidence gate, Evidra refuses to replay it; the next attempt must be a new manifest with an explicit changed route or repaired contract.

Every research cycle now has an adversarial critic stage. The critic reviews lane disagreement and the director decision, records objections and required checks, and returns `proceed`, `revise`, or `reject`. An explicitly started autonomous research or challenge campaign can implement and run isolated experiments automatically; external submissions remain approval-gated in every mode.

Critic output is normalized before it becomes a gate: a review that says `proceed` while listing unresolved `requiredChecks`, citing no durable evidence anchor, or citing an anchor absent from the lane/store evidence is downgraded to `revise`, so unsupported approval cannot disappear between cycles.

The controller also records evaluated trajectories for both research cycles and experiments. A deterministic quality pass checks structural closure, goal attainment, tool use, evidence consistency, recovery, and termination. Capability routing assigns each cycle a demand tier (`C0`–`C3`) using task complexity, failure pressure, budget, provider, and autonomy. Recurring deficiencies are converted into the next research allocation—for example, evidence failures prioritize provenance and leakage checks, while recovery failures prioritize reproduction and alternate execution routes. New experiments are selected by expected information per combined GPU, model, engineering, and risk cost rather than simply choosing the newest hypothesis.

Autonomous fast/yolo campaigns also use a bounded best-of-k portfolio. Hypotheses declare formulation families, are ranked by expected value per minute, and are rejected when their conservative, history-adjusted cost estimate cannot fit the remaining campaign budget; each estimate is persisted with its uncertainty and failure inflation rationale. Independent candidates run concurrently only within the executor resource ceiling: local/container execution defaults to one worker, while Modal supports bounded scale-out. Independent lane reports are cross-pollinated into a bounded board of agreements, tensions, recommendations, and source evidence before the director chooses experiments. The board now also emits ranked transfer candidates: recommendations are grouped by independent source role, evidence anchors, and confidence, so the strongest ideas are promoted as falsifiable leads rather than a flat majority vote. Consensus detection ignores generic research vocabulary and requires discriminative shared terms, reducing false agreement between lanes that merely repeat words such as “model,” “data,” or “method.” These mechanisms improve search diversity and information flow; they do not substitute for equal-budget benchmark evidence.

Runtime history is context-aware: local, container, and Modal observations are kept distinct when enough evidence exists, so a slow remote or GPU route does not distort the scheduler’s estimate for a different execution environment. Sparse context history conservatively falls back to the broader operator prior.

Search rewards are now context-aware and cost-aware as well. Autonomous experiment rewards retain provider, model, executor, and phase provenance; repeated local evidence is combined with global history through conservative shrinkage, and the operator rank includes a bounded reward-per-minute bonus. A policy can specialize to a Modal/GPU or validation context without trusting a tiny lucky sample or spending the whole budget on a slow operator.

Harness benchmarking is closed-loop: `benchmark run` records matched outcomes and emits a durable adaptive retest agenda. Losses are classified into reliability, recovery, alignment, efficiency, search, or coverage interventions with falsifiable predictions and acceptance criteria. The next retest preserves task, model, seed, evaluator, metric, and budget, so Evidra is optimized to beat incumbents by improving the harness rather than by changing the comparison.

When a benchmark exposes a credible harness weakness, Evidra materializes one durable `harness.retest` task. A research or challenge campaign can execute that task automatically after the candidate implementation succeeds; operators can inspect the same queue with `evidra queue status` and run a specific task manually:

```bash
evidra benchmark retest harness-retest:<challenger>:<benchmark-revision> \\
  --workspace path/to/candidate-worktree
```

Retests are deliberately harder to satisfy than a repeated smoke run. The stored protocol is revalidated before any process starts, the candidate must contain a real change in the declared harness component(s), and the retest must cover at least two distinct tasks with at least two independent seed repetitions per task. The result records raw trials, component checksums, change-presence status, prediction outcome, scorecards, and comparisons. An unchanged worktree, insufficient independent coverage, or an invalidated protocol is rejected and recorded as evidence rather than counted as a win. This makes harness improvement an empirical loop that generalizes across research domains and challenge adapters.

Evidra also speaks the official [AutoResearchBench](https://github.com/CherYou/AutoResearchBench) evaluation protocol. After running its published inference and evaluator pipeline, import either track’s JSON result with `evidra benchmark autoresearch evaluation.json` (or `/benchmark autoresearch evaluation.json` in the TUI). Deep and wide results are stored as diagnostic evidence with their original metrics and record counts; Evidra does not rewrite those scores into a competing metric or confuse them with proof from the active workspace. The benchmark’s released task bundle is decrypted using its own published script before inference, keeping dataset handling compatible with the upstream protocol.

Literature retrieval combines OpenAlex, arXiv, Crossref, public repository search, and bounded web search. The web route is used for official documentation, challenge discussions, dataset pages, and implementation leads; every result remains untrusted until the source is retrieved, hashed, and claim-extracted into the evidence store.

Codex research lanes, the director, and the critic also use the official SDK's
live web-search/network capability when investigating current literature or
implementation leads. This capability is scoped to autonomous research; it is
not enabled for ordinary conversation. Native web results are still discovery
material and cannot support a hypothesis or completion claim until Evidra
retrieves, hashes, and provenance-links the underlying source.

When a hypothesis adapts a published method, its decision record can include `sourceAdaptation`: the original setting, the concrete difference in the current task, and expected failure modes. This keeps transfer claims falsifiable and makes the next validation specific to the gap between the paper and the workbench.

Run telemetry is exportable with `evidra telemetry export --out mlflow.json` or `/telemetry export` in the TUI. The export contains run status, timing, finite metrics, experiment parameters, failure tags, and checksummed artifact references in an MLflow-shaped JSON envelope. It is local-only and secret-free; connecting it to a tracking server remains an explicit operator action.

Benchmark runs can also enforce retention with `benchmark run --retention previous-report.json`: the same task-balanced, paired evidence gate checks that a harness change did not forget previously solved tasks, and retention requires 100% coverage of the prior report’s arms. This protects against the harness-evolution failure mode described by [EVOHARNESSBENCH](https://arxiv.org/abs/2609.04280), where expanding capabilities can degrade prior competence.

Competitive claims can additionally require task-disjoint transfer with `benchmark run --holdout held-out-report.json`. Evidra rejects overlapping train/holdout tasks and requires a matched challenger win on both partitions. This follows the central lesson of [Rethinking the Evaluation of Harness Evolution](https://arxiv.org/abs/2607.12227): harness search must be separated from final evaluation and compared under matched feedback and inference budgets. The broader benchmark design is compatible with model × harness diagnostics such as [PawBench](https://github.com/agentscope-ai/PawBench) and layered component ablations such as [harness-bench](https://github.com/LamaSu/harness-bench).

The holdout gate also requires protocol parity: model, budget, metric direction, data revision, and runtime fingerprint must match between training and held-out reports. A task-disjoint result with a changed protocol is reported as incomparable rather than accepted as transfer.

Benchmark input may also include a `change` contract with `id`, `componentIds`, predicted delta bounds, prediction, falsification, and acceptance fields. The resulting report records whether the prediction was confirmed, partially confirmed, refuted, or unobserved from the paired evaluator outcome; a polished narrative cannot count as a confirmed harness improvement.

Reports also expose a Pareto frontier over task-balanced score, conservative lower-95% score, and median time to evidence. This keeps fast/reliable/accurate tradeoffs visible instead of forcing every harness into one opaque ranking.

Benchmark arms may declare a `slice` or task family. Scorecards then report slice-balanced performance alongside task-balanced performance, making it harder for a harness to hide a failure on a minority domain behind repeated wins on an easy slice.

Slice regressions are also part of the competitive gate: a positive aggregate lower bound cannot establish a win when any declared slice has a negative paired lower bound. The comparison event records the blocking slices and their bounds for targeted retesting.

The controller also derives an adaptive runtime policy from recent trajectory quality and failure classes. Tool-round limits, retry posture, peer review, critic pressure, replication requirements, and search diversity change within bounded limits when the evidence warrants it; they are persisted as `research.adaptive_harness.policy` events. This makes harness evolution operational rather than a prose recommendation.

Validation also flags unusually large relative gains as scrutiny cases. By default this is at least 25% of the baseline scale, with a 0.05 floor; a manifest may set `acceptance.largeGainThreshold` for a task-specific absolute normalized threshold. Such a result requires independent replication and reviewer approval even when ordinary replication was disabled for a lightweight probe, reducing the chance that leakage or an evaluator mistake is promoted as a breakthrough.

The policy is phase-aware as well as failure-aware: orientation and hypothesis phases use an `exploration` profile, validation/evaluation/replication/promotion use `evidence`, terminal failures use `recovery`, and low remaining budgets use `budget`. Profiles are operational: evidence and recovery profiles boost audit/replication operators, exploration boosts novelty, and budget pressure penalizes expensive arms. This gives the controller bounded specialist policies without allowing unmeasured policy drift.

Prediction artifacts can now be turned into targeted research evidence with `evidra evidence analyze predictions.json` or `/evidence analyze predictions.json` in the TUI. Pass `--baseline baseline.json` (or the tool's optional `baseline` argument) to measure fixed and regressed rows/groups. The typed `prediction.analyze` research tool reports classification confusion, regression residuals, metadata-defined worst slices, binary calibration gaps, and baseline-vs-candidate changes from JSON/JSONL artifacts, so the director can form hypotheses about concrete failure slices rather than optimizing only an aggregate metric.

Validated methods can transfer across projects without becoming unearned folklore. After a parent experiment improves the declared evaluator and an independently created replication improves it again, Evidra records a provenance-linked `research.method.transferable` event. Relevant methods are ranked into the next research context as leads; they never count as evidence for the new task until a fresh experiment verifies them. This gives the harness a compounding search advantage while preserving equal-budget, evaluator-backed comparisons.

Evaluator integrity is a hard gate: before an experiment engineer runs, Evidra fingerprints protected evaluator/configuration files and rejects any isolated worktree that changes them. This prevents specification-gaming results from entering the research ledger while still allowing the declared candidate implementation to change.

Final reports also run a deterministic claim audit: measured, literature-only, provisional, unsupported, and conflicted claims are separated, and a report is not marked publishable when unsupported or contradictory claims remain.

Fold/seed bootstrap replication and independent child-experiment replication are tracked separately. A manifest with `requireReplication` cannot pass promotion from repeated folds alone; the controller must observe a valid run for a distinct replication manifest.

This requirement is enforced by the durable evidence audit: `replicationObserved` is derived from the linked child experiment and its exact current completed run, and is refreshed automatically when replication finishes or an operator reruns the audit. A manifest can additionally set `acceptance.requireExternalScore: true`; the audit then requires a durable scored submission (`externalScoreObserved`) for that experiment. External scores are recorded with platform and timestamp provenance, but never substitute for reproducibility, leakage, review, or evaluator-integrity checks.

When a score is recorded or polled, Evidra refreshes only the external-score criterion in the existing audit and preserves every other unmet gate. Prepared submission bundles carry the exact source run ID, and score evidence must match that run. A leaderboard result therefore cannot accidentally turn an unreproducible, stale, or leaked experiment into an accepted one.

External scores also feed a conservative distribution-belief loop. Submission
provenance bundles retain the finite local run metrics, and polling or recording
a score carries those metrics into the durable observation automatically. The controller
compares scored submissions with their recorded local validation splits, shrinks
correlations under sparse data, and routes the next cycle toward multi-split or
alignment experiments when uncertainty is high. A few leaderboard points never
select a validation split or count as proof by themselves.

Paired statistical comparisons also require complete, matching fold/seed cardinality and at least two paired observations. Evidra refuses to truncate unequal series or treat a single observation as replication; incomplete evidence becomes an explicit `insufficient_data` outcome for the next research decision.

Repeated looks at one hypothesis use conservative alpha spending on top of the campaign's family-wise correction: autonomous validation records the one-based look number and allocates `alpha / (k(k+1))` for look `k`. This reduces false discoveries from repeatedly peeking at promising experiments while preserving the old behavior for integrations that do not declare sequential look metadata.

Benchmark process and efficiency gates are task-balanced too: extra arms on one task cannot outweigh another task when evaluating reliability, alignment, or time use.

The same audit is an execution gate, not just a report decoration. Autonomous research cannot mark a goal complete while durable claims are unsupported, provisional, literature-only, or conflicted. Inspect the gate directly with `evidra evidence audit` (or `--json` for automation); the controller records the rejection and continues from the missing evidence.

Research memory keeps invalidated and superseded claims in a quarantined channel for audit and negative evidence, while excluding them from active claims supplied to autonomous agents. This prevents stale conclusions from silently re-entering a later research cycle without deleting the historical record.

Every bounded memory packet is fingerprinted and recorded as `research.memory.retrieved` with its query and selected claim/hypothesis IDs. The retrieval component is therefore replayable and measurable independently from the model's reasoning quality.

The research context also includes a bounded falsification agenda derived from durable hypotheses and terminal experiments. It prioritizes untested hypotheses, marks already-tested directions, and preserves rejected directions as negative evidence so autonomous cycles choose a changed discriminator instead of repeating the same idea.

The claim-audit rule is shared by the CLI, TUI, and generated reports. Self-describing observations such as lane findings are accepted only when their payload includes durable evidence fields; interactive status and exported provenance reports therefore cannot disagree about the same claim.

Before allocating compute, Evidra also structurally scores each hypothesis for a concrete mechanism, grounded evidence, falsifiability, implementation cost, and leakage risk. This score only prioritizes work; it never counts as an empirical improvement.

Research hypotheses are not restricted to ML metrics: they can declare `metric`, `artifact`, `proof`, `behavior`, `system`, or `other` outcomes and describe non-scalar success with `expectedOutcome`. Competition manifests retain the metric path, while scientific and software investigations use the same durable evidence and verifier machinery without fabricated GPU estimates.

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
- workspace file/search/read, Git status, safe shell, data audit, artifact checksum/JSON audit, source retrieval, validation-policy, and report tools;
- durable queue with retries, stale-task recovery, bounded concurrency, visible queued prompts, and capped priority aging so background work cannot starve indefinitely;
- queue-wide governance pause: `evidra queue pause --reason ...` (or `/queue pause`) stops new local and remote claims without cancelling live work; `queue resume` reopens dispatch and the state survives controller restart;
- per-task suspension: `evidra queue pause-task <id>` (or `/queue pause-task <id>`) cooperatively stops one queued/running ticket and unfinished descendants without consuming retries; `resume-task` returns the coordinator and only its cascade-paused descendants to the claimable pool;
- operator reprioritization: `evidra queue priority <id> <value>` (or `/queue priority <id> <value>`) redirects queued, paused, or failed work without mutating an active claim;
- durable work labels: `evidra queue labels <id> research,gpu` (or `/queue labels ...`) classifies queue tickets for operator triage and dashboard inspection without weakening typed task capabilities;
- label-filtered triage: `evidra queue status --label <label>` (or `/queue status <label>`) narrows the live work view without changing queue state;
- task lifecycle history: `evidra queue history <id>` (or `/queue history <id>`) reconstructs bounded queue events for audit and recovery without exposing unrelated tickets;
- durable task checkpoints: remote workers can POST `/tasks/checkpoint` with their fenced claim token to persist bounded resumable state; checkpoints survive controller restart, preserve the original task input, are hash-audited without logging contents, and stale workers cannot overwrite them;
- checkpoint observability: `evidra queue checkpoint <id>` (or `/queue checkpoint <id>`) reports whether a task can resume, its safe stage/key summary, byte size, hash, and update time without printing checkpoint contents; the read-only dashboard exposes the same redacted metadata;
- durable queue approval gates: enqueue work with `requiresApproval`, then release it with `evidra queue approve <id>` (or `/queue approve`); rejected/pending tasks remain visible but cannot be claimed until explicitly approved;
- unified approval inbox: pending/rejected queue tasks appear alongside experiment, submission, recovery, and external-action approvals in `/approvals` and the dashboard;
- role-hire approvals: custom roles in `review` appear in the same inbox with an actionable `/agents approve <role>` transition, then disappear only after durable admission is recorded;
- inbox actions: custom role hires can also be approved in place with `evidra approvals approve agent-role <role>` or `/approvals approve agent-role <role>`;
- explicit rejection: operators can permanently decline a pending custom role with `evidra approvals reject agent-role <role>` or `/approvals reject agent-role <role>`; rejected roles remain visible as `rejected` but do not repeatedly re-enter the pending inbox;
- portable governance state: role pause, termination, and the full admission state (`review`, `approved`, or `rejected`) are included in redacted bundle metadata so backup/transfer preserves the execution boundary;
- operator attention inbox: `/status`, the TUI status view, and the dashboard consolidate blocked goals, stale workers, failed or dependency-blocked tasks, paused dispatch, and approvals into one bounded, read-only intervention list;
- supervisory delegation signals: when a delegated child fails or is cancelled while its parent remains live, attention points to the parent history so the decomposition or execution route can change deliberately instead of silently repeating a broken branch;
- unified control-plane health: the same read model reports idle/healthy/degraded/blocked campaign state, controller liveness, active work, running/stale agents, and the reason autonomy should continue or stop across CLI, TUI, and dashboard;
- budget-aware control-plane health: queue token/cost utilization is surfaced as an operator warning at 80%, degraded health at the warning boundary, and a blocked campaign at exhaustion; the controller stops new campaign allocation and cancels only matching queued work while preserving live work and recovery state;
- remote claim diagnostics: external workers receive bounded approval blockers when no eligible task can be claimed, making operator-gated queues explainable without exposing unrelated task payloads;
- typed exhausted-queue recovery: authentication, dependency, sandbox, data, resource, timeout, and route failures produce auditable next actions instead of dead-end errors;
- ownership-aware queue checkout: each worker gets a durable identity, only the claimant can heartbeat a task, and stale claims are safely reclaimable;
- goal-aligned queue ancestry: tasks can carry a phase-goal ID and parent-task ID, making autonomous decomposition traceable from mission to work item;
- durable lane tickets: every leased research specialist also owns a `research.lane` queue task with phase lineage, heartbeat, retry ownership, and terminal evidence, so lane work remains visible and recoverable across controller restarts;
- lineage-scoped provider sessions: ordinary cycles reuse a role’s durable context within a goal, while delegated child tasks receive isolated session scopes so sibling transcripts cannot leak into one another’s evidence;
- attributable specialist handoffs: durable directives preserve the sender role, recipient role, scope, delivery state, and cancellation state across restarts, so cross-agent coordination is auditable rather than anonymous prompt text;
- typed agent handoffs: approved roles can use the bounded `agent.handoff` tool in non-safe team modes to send deduplicated, scoped requests into another role's next safe-boundary inbox; communication never grants authority or turns a message into evidence;
- handoff outcomes: a directive first becomes `acknowledged` at safe-boundary delivery, then records a completed, failed, or rejected outcome tied to the original handoff ID and exposed in CLI/TUI/dashboard history, so Evidra never confuses delivery with completed work;
- portable handoff state: sender attribution is included in secret-redacted exports and dashboard metadata, allowing a resumed workspace to preserve the collaboration chain without copying credentials or raw datasets;
- campaign recovery checkpoints: each autonomous boundary records a bounded list of queued, running, or paused task IDs alongside cycle and phase, so restart/resume status identifies the durable work it is recovering;
- stale-ticket recovery: when a specialist heartbeat expires, Evidra closes its queue ticket with the failure and lease metadata instead of leaving phantom running work;
- watchdog approvals: stale specialist and review tickets appear in the operator approval inbox with an explicit changed recovery route, so orphaned work cannot disappear silently;
- dependency safety: prerequisite graphs block out-of-order execution, reject cycles before they can deadlock an autonomous campaign, and expose missing/waiting/failed readiness reasons through the CLI and dashboard;
- durable routines: recurring research or challenge campaigns persist their goal, route, interval, per-run budget, optional `--max-runs` circuit breaker, last result, run history, and runner lease; the native routine daemon polls and executes due work without duplicate controllers;
- safe external wake-ups: `evidra event emit external.<source>.<event>`, `/event emit`, and the authenticated loopback `evidra event serve` endpoint accept bounded, redacted integration payloads, hash-chain them as non-evidence signals, deduplicate webhook retries with durable idempotency keys, and wake matching routines from CI, webhooks, schedulers, or competition monitors;
- external agent heartbeats: authenticated workers can emit `external.agent.heartbeat` with a role, lease, provider, model, and status; Evidra updates durable health only for the owning lease and rejects fresh-lease impersonation, allowing heterogeneous agents to be monitored without granting them controller authority;
- external worker capability health: heartbeat payloads may advertise bounded capabilities; Evidra persists the latest redacted worker/provider/model/capability snapshot and exposes it through the dashboard, so operators can see which remote resources are alive before dispatching work;
- explicit worker liveness: agent and dashboard read models distinguish healthy from stale heartbeat state, so an apparently running but disconnected worker is visible as stale instead of looking dispatch-ready;
- heartbeat-backed dispatch: a fresh worker heartbeat supplies default capabilities for `/tasks/claim` when the worker omits them; failed or stale health is ignored, so an old GPU report cannot authorize new work;
- external queue workers: the authenticated listener also exposes owner-checked `/tasks/claim`, `/tasks/heartbeat`, and `/tasks/complete` endpoints, so outside runtimes can execute durable Evidra tasks while dependencies, retries, and audit events remain controller-owned;
- scoped worker delegation: a live worker can POST `/tasks/delegate` with its parent claim token to create a bounded child task that inherits the parent goal and lineage; the child kind is scope-checked, dependencies are cycle-checked, identical transport retries are idempotent, conflicting IDs are rejected, and the controller still owns approval, budgets, retries, and execution;
- capability-aware dispatch: queue tasks may declare `requiredCapabilities` such as `gpu.cuda`, `modal`, `python`, or `geospatial`; local and external workers advertise capabilities when claiming work, so a task is never handed to a worker that cannot execute it. Tasks without requirements remain backward-compatible and available to every eligible worker;
- durable task assignment: queue work may carry an `assigneeId`; only that worker can atomically claim it, while unassigned work remains available to eligible workers. Assignment survives reopen and is visible in the dashboard;
- task handoff journals: workers append bounded progress, blocker, and handoff notes to their queue ticket; notes are redacted, hash-chained, visible in the dashboard, and available through `evidra queue activity <task-id>` so recovery does not depend on reconstructing the global event stream;
- external usage attribution: BYOA workers can report bounded input/output tokens, provider, model, and optional cost through `/tasks/usage`; `evidra queue usage` aggregates provider-neutral consumption without pretending reported billing is independently verified;
- task budgets: queue tasks may declare `tokenBudget` and/or `costBudgetUsd`; reported usage is exposed as remaining/exhausted state, and crossing a live task's token or USD ceiling durably cancels the claim at the usage boundary so remote workers receive a structured stop response before another turn. Exhausted queued/failed tasks are prevented from being claimed again. Existing tasks without a ceiling remain unlimited;
- operator-set task budgets: `evidra queue budget <id> <tokens|0>` and `evidra queue cost-budget <id> <usd|0>` revise token or USD ceilings on queued or failed work without changing a live claim;
- deadline-aware queue leases: `evidra queue deadline <id> <duration|timestamp|none>` (for example `30m` or `4h`) prevents expired work from being claimed and causes cooperative local workers to abort at the deadline;
- machine-readable usage: `evidra queue usage --json` reports exact queue-wide totals, while the task form includes budget state and bounded recent records;
- durable task cancellation: `evidra queue cancel <id>` (or `/queue cancel`) atomically cancels queued/running work, records the reason, and prevents a late local or external worker completion from resurrecting the ticket;
- hierarchical cancellation: cancelling a coordinator also stops unfinished queued/running descendants, records `cascadedFrom` audit events, and leaves already-completed child evidence intact so delegated work cannot continue after its parent goal is stopped;
- hierarchy-aware queue visibility: CLI, TUI, and dashboard queue views show direct-child totals and completed/unfinished counts, making delegated progress and stuck branches visible without opening every ticket;
- cooperative local cancellation: queue workers poll the durable ticket and propagate cancellation through the handler `AbortSignal`, allowing process-aware handlers to stop without waiting for the full task timeout;
- lease-loss fencing: a local worker aborts immediately when its claim heartbeat is rejected, and records a durable `queue.lease_lost` audit event so a stale process cannot continue side effects after ownership changes;
- lease-loss visibility: the same event appears as critical operator attention in the CLI, TUI, and dashboard with a direct queue-history action;
- queue-supervisor recovery: polling-loop exceptions are contained, journaled as `queue.worker.error`, and surfaced as operator attention while later polls remain available for recovery;
- cooperative remote cancellation: the next authenticated worker heartbeat returns a structured `409` cancellation response, allowing external runtimes to stop promptly instead of discovering cancellation only at completion;
- idempotent external usage: `/tasks/usage` accepts a stable per-turn `idempotencyKey`, so transport retries do not duplicate token or cost accounting;
- conflicting usage-key reuse is rejected and journaled instead of silently accepting a different token/cost payload;
- operator reassignment: `evidra queue assign <task-id> <worker-id>` routes queued or recovered work explicitly; omit the worker ID to return it to the shared pool. Live claims cannot be reassigned underneath a running worker;
- stale assignment recovery: when a leased task times out, Evidra preserves its assignment and places an explicit reassignment item in `/approvals`, preventing a dead worker from silently losing or transferring work;
- scoped worker identity: `--worker-tokens worker-id=secret,...` (or `EVIDRA_WORKER_TOKENS`) gives each external worker its own credential and requires its authenticated header identity to match the claimed task, instead of trusting a shared body-level worker ID;
- file-backed worker secrets: `--worker-tokens-file <path>` (or `EVIDRA_WORKER_TOKENS_FILE`) loads the scoped mapping without placing secrets in the process command line and rejects group/world-readable files; use `chmod 600` for the file;
- file-backed event-server bearer secrets: `--token-file <path>` (or `EVIDRA_EVENT_TOKEN_FILE`) loads the control-plane token without exposing it in process arguments and rejects group/world-readable files; use `chmod 600` for the file;
- bounded event-server connections: the authenticated listener uses constant-time bearer checks plus bounded header, body, request, and keep-alive timeouts, so abandoned or slow clients cannot hold the controller indefinitely;
- admitted worker claims: an external worker must first send a fresh accepted heartbeat for an admitted role before `/tasks/claim` can assign queue work; missing, stale, failed, or unapproved workers receive a structured `worker admission required` response;
- per-worker task scopes: `--worker-scopes worker-id=kind|kind,...` (or `EVIDRA_WORKER_SCOPES`) restricts each authenticated worker to its assigned queue families; workers cannot claim, heartbeat, or complete tasks outside that scope. If omitted, the bridge retains its global `--task-kinds` behavior;
- per-worker capability allowlists: `--worker-capabilities worker-id=capability|capability,...` (or `EVIDRA_WORKER_CAPABILITIES`) constrain what a worker may advertise or claim; heartbeat capabilities must be a subset of the operator-configured allowlist;

External worker loop. For least privilege, start the bridge with
`--task-kinds research.lane` (or another explicit queue family) when the
external runtime should not see every controller task:

```bash
BASE=http://127.0.0.1:4311
AUTH="Authorization: Bearer $EVIDRA_EVENT_TOKEN"
WORKER_ID="agent-17"
WORKER_HEADERS=( -H "X-Evidra-Worker-Id: $WORKER_ID" -H "X-Evidra-Worker-Token: $EVIDRA_WORKER_TOKEN" )
TASK_RESPONSE=$(curl -fsS -H "$AUTH" -H 'content-type: application/json' \
  "${WORKER_HEADERS[@]}" \
  -d '{"workerId":"agent-17","kinds":["research.lane"]}' "$BASE/tasks/claim")
TASK_ID=$(printf '%s' "$TASK_RESPONSE" | jq -r '.task.id')
CLAIM_TOKEN=$(printf '%s' "$TASK_RESPONSE" | jq -r '.task.claimToken')
# Send heartbeats while work runs, then complete with the same worker ID and claim token.
curl -fsS -H "$AUTH" "${WORKER_HEADERS[@]}" -H 'content-type: application/json' \
  -d "{\"workerId\":\"$WORKER_ID\",\"taskId\":\"$TASK_ID\",\"claimToken\":\"$CLAIM_TOKEN\"}" "$BASE/tasks/heartbeat"
# Persist resumable state at safe boundaries; the controller keeps the original input under _task.
curl -fsS -H "$AUTH" "${WORKER_HEADERS[@]}" -H 'content-type: application/json' \
  -d "{\"workerId\":\"$WORKER_ID\",\"taskId\":\"$TASK_ID\",\"claimToken\":\"$CLAIM_TOKEN\",\"checkpoint\":{\"stage\":\"retrieval\",\"artifact\":\"partial.json\"}}" "$BASE/tasks/checkpoint"
# Delegate a bounded child ticket without giving the worker controller authority.
curl -fsS -H "$AUTH" "${WORKER_HEADERS[@]}" -H 'content-type: application/json' \
  -d "{\"workerId\":\"$WORKER_ID\",\"taskId\":\"$TASK_ID\",\"claimToken\":\"$CLAIM_TOKEN\",\"child\":{\"id\":\"followup-001\",\"kind\":\"research.lane\",\"priority\":2,\"payload\":{\"objective\":\"replicate the finding\"},\"requiredCapabilities\":[\"python\"]}}" "$BASE/tasks/delegate"
curl -fsS -H "$AUTH" "${WORKER_HEADERS[@]}" -H 'content-type: application/json' \
  -d "{\"workerId\":\"$WORKER_ID\",\"taskId\":\"$TASK_ID\",\"claimToken\":\"$CLAIM_TOKEN\",\"status\":\"completed\",\"payload\":{\"summary\":\"done\"}}" "$BASE/tasks/complete"
```

For multiple workers, add independent credentials and scopes. A worker with no
matching scope receives `403` for task operations, while the controller still
owns queue state and retry policy:

```bash
evidra event serve --port 4311 --token "$EVIDRA_EVENT_TOKEN" \
  --task-kinds research.lane,research.review \
  --worker-tokens 'lane-1=lane-secret,review-1=review-secret' \
  --worker-scopes 'lane-1=research.lane,review-1=research.review'
```
- routine trigger coalescing: events arriving while a campaign is running become one durable pending wake-up and launch immediately after completion, preventing both lost updates and concurrent duplicate campaigns;
- routine trigger provenance: each wake-up retains the newest triggering event type and timestamp through coalescing and restart, then clears it only after the corresponding run consumes the wake-up;
- trigger context propagation: routine-launched campaigns receive that bounded event context as durable campaign metadata, `research status` reports whether the current run was event-triggered, and the director receives only an explicitly untrusted wake-up signal that can prioritize inspection but can never count as evidence;
- portable research bundles: `evidra export` captures secret-redacted goals, claims, sources, decisions, runs, artifact checksums, routines, specialist sessions, pause controls, directives, and recent events without copying datasets or credentials; the receiving workspace must revalidate before trusting the imported context;
- portable bundle validation: `evidra bundle validate <path>` checks schema, credential redaction, safe workspace-relative artifact paths, and missing-file warnings without importing anything into live evidence;
- portable organization restore: `evidra bundle import <path>` restores only validated custom agent contracts; existing roles are skipped unless `--replace` is supplied, and imported contracts always return to review until explicitly admitted, so a bundle cannot grant execution privileges;
- TUI-first routine authoring: `/routine create` guides the operator through a reusable goal, cadence, and per-run budget while inheriting the selected provider policy;
- unified approval inbox: `/approvals` and the dashboard collect pending experiment approvals, prepared submissions, unresolved external actions, and terminal queue recoveries without bypassing any existing gate;
- individual-agent governance: `/agents pause <role>`, `/agents resume <role>`, `/agents terminate <role>`, and `/agents revive <role>` persist role-level controls; active lanes stop at the next safe boundary while other specialists continue, and terminated roles remain blocked until explicitly revived;
- directed specialist collaboration: `/agents message <role> <message>` queues a durable, auditable operator directive for one role; it is delivered only at a safe tool/model boundary and cannot expand that role's authority;
- specialist inbox inspection: `/agents directives [role]` shows durable handoff history, pending/applied state, timestamps, and exact messages so operator steering is observable rather than silently queued;
- directive lifecycle control: `/agents cancel <id>` withdraws an unapplied specialist handoff with a durable cancellation event; applied directives remain immutable historical context;
- stale handoff recovery: delivered-but-unfinished directives are checked against recipient lane health, surfaced as critical attention, and automatically resolved during the next autonomous allocation boundary; recovery preserves the failure reason and requires a changed route before retry;
- campaign-scoped steering: TUI directives are attached to the active phase goal and only matching lanes consume them; CLI directives remain explicitly global, preventing stale instructions from silently crossing research objectives;
- goal-alignment audit: `/status` and the dashboard verify that running campaigns have an objective and active phase, that live queue work resolves to phase goals, and that leased lanes have assigned work;
- campaign lineage isolation: goal alignment also rejects live work from a different deterministic objective/mode goal set, preventing resumed or concurrent research campaigns from silently sharing queue ownership;
- campaign organization map: mission, phase ownership, reporting lines, active work, specialist directives, and accountability warnings are exposed consistently through the dashboard, `evidra organization`, `/organization`, and machine-readable JSON;
- durable goal rollups: the organization projection derives completed-phase count, progress ratio, blocked/active/met state, active phase, and three-stage progress from phase-goal records, keeping operational activity separate from scientific completion;
- truthful organization work rollups: each phase and the campaign totals distinguish queued, active, blocked, completed, and failed/cancelled tasks, so operators can tell whether to wait, recover, or allocate new work;
- alignment-safe work totals: unscoped tasks are excluded from “aligned” campaign totals and reported separately, preventing ownerless or scheduler-only work from making scientific progress look larger than it is;
- organization-level cost rollups: phase and campaign views aggregate immutable queue input/output tokens and USD usage, allowing operators to compare progress against budget without reconstructing raw activity events;
- budget utilization rollups: the same organization view reports declared token/USD ceilings and utilization percentages, while tasks without a declared ceiling remain explicitly unbudgeted instead of being treated as unlimited evidence of health;
- budget attention gates: campaign utilization above 80% creates a warning and utilization at or above 100% creates a critical operator item, giving autonomous allocation a visible stop/review boundary instead of a passive counter;
- budget enforcement at allocation: when durable queue token/USD utilization reaches 100%, the autonomous controller pauses before the next agent turn, cancels only queued campaign tasks, records the reason, and preserves a resumable checkpoint;
- durable workspace identity: every SQLite control plane receives a stable non-secret `ws_…` identity, exposed by status and the dashboard and carried in portable metadata, making workspace boundaries explicit without leaking filesystem paths or credentials;
- workspace-bound external workers: authenticated remote heartbeats must present the matching workspace identity; mismatched or stale workers cannot refresh a different project’s leases, while local event tooling remains compatible with older heartbeat payloads;
- HTTP heartbeat isolation: every event-server heartbeat must prove the current workspace identity after authentication, including bearer-authenticated deployments; scoped worker credentials remain an additional lease-owner boundary;
- campaign-run isolation: every newly created cycle, lane, and review ticket carries the durable campaign start identity; organization usage, budgets, and hard-stop cancellation stay scoped to the active run, while live work from another run remains visible as foreign rather than silently counted;
- legacy-run quarantine: live queue tasks without a campaign identity are surfaced as legacy work and excluded from a newly identified campaign’s progress, usage, and budget totals, preventing pre-upgrade state from contaminating current decisions;
- run-scoped phase plans: every new campaign receives its own durable phase-goal set, so repeating an objective starts a fresh scientific plan instead of inheriting completed phases; legacy campaigns retain their original goal-set identity for safe resume;
- durable campaign history: the live campaign snapshot can be replaced without losing prior run summaries; inspect retained runs with `evidra research history` or `/research history`, including status, mode, objective, and plan identity;
- targeted campaign resume: continue a retained paused run with `evidra research --resume-run <startedAt>` (or the equivalent challenge flag); completed runs are immutable and active campaigns cannot be overwritten by historical resume;
- TUI campaign selection: `/research history` and `/challenge history` list retained runs, while `/research resume <startedAt>` and `/challenge resume <startedAt>` resume a selected run with the same safety checks;
- lineage-safe delegation: remote child tasks inherit their parent campaign identity and cannot declare a different run, so delegated work remains cancellable, budget-accountable, and auditable through the same campaign boundary;
- role-scoped runtime skills: custom contracts may use `--skills provenance.md,replication.md` to inject only selected `.evidra/skills/*.md` guidance into that role’s lane; omitted means all skills, and the scope is persisted, portable, revisioned, and bounded like tool permissions;
- work accountability: live work is classified as ownerless, unscoped, mis-scoped, or unbudgeted; foreign-phase work is treated as critical operator attention without silently being counted as current-campaign progress;
- atomic research-lane leases with heartbeats, duplicate-specialist protection, and restart-time stale-lane recovery;
- in-wave lane watchdog: long provider turns are supervised continuously, so expired specialist leases, tickets, and delivered handoffs are fenced and surfaced before the next campaign allocation boundary;
- explicit agent organization: director, specialist, validation, execution, critic, auditor, and repair roles have durable reporting lines, authority boundaries, and responsibility contracts visible in the dashboard and injected into lane prompts; external workers with custom roles are surfaced in the same organization view with an explicit `reviewRequired` default contract;
- revisioned role governance: `evidra agents contract-history <role>` exposes custom contract revisions, while `evidra agents contract-rollback <role> <revision>` restores an earlier definition as a new auditable revision without changing admission privileges;
- reporting-line integrity: custom role contracts reject self-reference and multi-role hierarchy cycles at the durable boundary, preventing ambiguous delegation graphs from entering a campaign;
- contract-aware organization projection: restored contracts and operator controls remain visible as `unstarted` roles before a worker heartbeat exists, so imported organizations are auditable immediately after restore;
- closed-loop role training: autonomous cycles evaluate durable lane evidence, materialize bounded coaching directives for roles needing review, deliver them at safe boundaries, and use idempotent directive storage so repeated cycles cannot flood a specialist with duplicate coaching;
- explicit role admission: built-in roles are approved by contract, while custom/external roles remain in `review` until an operator runs `evidra agents approve <role>` (or `/agents approve <role>`; role names may contain spaces); rejected external execution is recorded with a durable reason, and admission can be revoked without deleting the role’s history;
- contract-driven lane hiring: once an operator approves a custom role contract, autonomous research cycles discover it and place it in the bounded specialist portfolio alongside built-in lanes; unadmitted or rejected roles are skipped and recorded rather than silently executed;
- authority-aware custom lanes: custom role authority continues to apply at the tool boundary—investigators remain observation-only, while explicitly contracted execute/repair roles can use the matching execution tools without inheriting director privileges;
- least-privilege role tools: custom contracts may declare a bounded tool allowlist, persisted through revisions and portable bundles; even an admitted role cannot call an adapter outside its explicit scope;
- role playbooks: every role has a compact, domain-neutral operating checklist covering what to inspect, what to record, and what must be verified before handoff; playbooks guide behavior but never override deterministic controller gates;
- playbook telemetry: lanes return bounded pass/partial/blocked statuses for their assigned checklist steps with observation references; these statuses measure process quality and are never promoted to scientific evidence by themselves;
- review-driven intervention: blocked playbook adherence or process failures downgrade a role from trusted to coach, emit a durable `research.agent.reviewed` intervention record, and change subsequent lane allocation/coaching;
- review history: `/agents reviews` and the dashboard expose bounded, durable review snapshots and interventions across restarts, so role coaching is inspectable rather than hidden in raw event storage;
- durable work activity: specialist starts, tool progress, safe-boundary handoffs, completions, and failures are journaled against their queue ticket; `/agents activity` and the dashboard make recovery context visible across controller restarts;
- work-item cost attribution: director, critic, and specialist token usage carries the cycle ticket, phase goal, and parent ticket, so `/usage` and the dashboard show which durable work consumed inference budget rather than only which model was called;
- hierarchical queue lineage: parent-task chains are resolved with bounded depth, surfaced in queue/dashboard views, and treated as a goal-alignment blocker when live work points to a missing parent or contains a cycle;
- governed agent termination: operators can terminate a specialist until explicit revival; allocation and heartbeats reject terminated roles, running lanes stop at a safe boundary, and the terminal state survives controller restarts and portable export;
- attributed tool audit: every research-tool success or failure records the invoking actor (`controller` or specialist role) and autonomy level in the durable event chain, making delegated actions reviewable after the turn ends;
- governed project adapters: `.evidra/tools.json` extends the typed research registry with argv-only domain tools; explicit role grants, bounded execution, manifest fingerprints, automatic manifest-drift quarantine, output hashes, injection-signal quarantine, lifecycle controls, approval-inbox review, health probes, and portable redacted state keep extensions accountable without forking Evidra;
- explainable dispatch plans: every lane wave records candidate roles, paused roles, budget-exhausted roles, concurrency, execution mode, goal, and parent task; inspect the latest decision with `evidra agents dispatch` or `/agents dispatch`;
- unified budget ledger: campaign token usage is filtered by campaign boundary, attributed by role/provider/model, and classified as healthy, warning, exhausted, or unlimited across the CLI, TUI, and dashboard; aggregate and per-role ceilings prevent specialist starvation or runaway spend;
- resumable specialist sessions: Codex lane thread IDs are persisted per role, campaign goal, provider, and model; matching lanes resume their provider context while route changes and scopes invalidate reuse;
- revisioned research plans: structural phase-plan changes receive fingerprints and durable revisions; `/research plan history`, the CLI, and dashboard expose what changed without confusing ordinary progress updates with plan edits;
- enforceable delegation boundaries: specialist identity follows every lane tool call; read-only evidence tools are shared safely, while controller-owned actions such as report and validation-policy generation are rejected at the tool boundary and recorded as permission events;
- role performance reviews: durable lane reports are scored for completion, evidence density, confidence, and process quality with bounded recency weighting; a role cannot become trusted from self-reported process quality without at least one durable evidence anchor per assignment; recency-aware role memory feeds the next research context without promoting history to evidence, and reviews never pretend to attribute the final task metric to one agent;
- bounded coaching allocation: roles with sufficient `needs-review` evidence are deliberately scheduled for a controlled follow-up attempt, receive a bounded evidence-discipline coaching signal in their next prompt, while trusted roles continue to rotate and resource ceilings remain authoritative;
- private role memory: each specialist receives a small, explicitly historical projection of its own prior findings, uncertainties, and failed directions across cycles; this improves continuity without promoting old reports to current evidence or universal consensus;
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
- headless research and challenge campaigns that execute selected hypotheses through the same isolated runner as the TUI, with optional `--executor local|container|modal|slurm` routing;
- Codex-backed experiment-engineer implementation in the isolated worktree before evaluation, with failed hypotheses retained as evidence instead of being blindly retried;
- durable headless research trajectories with structural, goal, evidence, recovery, and termination quality signals feeding future allocation;
- unattended experiment runs also record the same quality-scored process/evaluator/recovery trajectory used by the interactive workbench;
- capability routing learns from prior trajectory quality: failed or warning-heavy cycles raise verification pressure, bound lane fan-out, and persist predicted tier versus served provider/model and observed outcome;
- bounded research teams are focus-aware and cycle-rotated: a measured evidence or recovery gap keeps its specialist first, while the remaining seats rotate across independent data, method, model, ensemble, domain, and reproducibility perspectives;
- optional per-lane wall-clock budgets are persisted with the campaign route, enforced before another specialist turn, and recorded with usage calls so scaling agents cannot silently consume the whole campaign budget;
- non-safe teams communicate through bounded parallel waves: later specialists receive a compact peer board with exact evidence anchors, while each wave hand-off is persisted for replay and audit; safe mode remains a single read-only pass;
- peer review is an empirically budgeted resource: Evidra records whether a review produced actionable disagreement or required checks, retains collaboration while history is sparse, and suppresses repeated no-value reviews unless hard evidence pressure forces them;
- autonomous experiment worktrees receive a language-agnostic code-health check before evaluation; severe test deletion or extreme untested growth is rejected, while smaller maintainability drift remains visible as evidence;
- code-health evidence is cumulative across the recent edit history, so repeated individually-small regressions can eventually trigger a repair gate;
- validation uses a best-so-far ratchet: an experiment must beat the original baseline and every previously accepted result compatible with its dataset and split contract;
- every research cycle now emits a durable experience record: validated trajectory events, scene/goal/outcome metadata, independent quality verdicts, C0-C3 demand scores, admission status, capability-gap profile, and a three-stage curriculum for subsequent cycles;
- Codex-native commands, searches, file changes, plans, and reasoning milestones are captured as bounded, secret-redacted process events in the durable trajectory, so the provider's real work remains auditable after the TUI closes;
- native Codex command, file-change, and tool failures now enter deterministic trajectory error-recovery scoring, preventing failed provider work from being mistaken for a clean successful cycle;
- tool trajectories retain bounded per-call latency and distinguish controlled permission denials from genuine execution failures, making efficiency and tool reliability visible to routing and replay;
- interrupted or crashed turns close in-flight tool calls with explicit aborted results, preserving causal structure and making partial work resumable instead of silently quarantining the entire cycle;
- native Codex failures are classified into the generic recovery vocabulary and fed into the next cycle's allocation policy, so timeout, rate-limit, auth, and dependency failures trigger targeted route changes;
- typed research-tool failures use that same vocabulary, so repeated retrieval, shell, artifact, or workspace failures also trigger targeted recovery rather than repeating an unhealthy route;
- director turns retrieve a bounded, objective-aware tool catalog with an always-on inspection core; catalog pruning reduces context noise without changing the controller's complete permission registry;
- retrospective experience replay selects a bounded deterministic coreset that favors difficult outcomes while diversifying task, domain, capability tier, and observed gap signatures;
- context packing applies per-section ceilings so oversized observations or tool output cannot evict the active phase goal, allocation, or evidence-conflict state from a provider turn;
- protected context sections also reserve bounded space for one another under emergency-small budgets, preventing a single large high-priority payload from starving the rest of the controller state;
- append-only tool feedback and recent-event histories retain their newest entries first during truncation, so the next decision sees current execution results rather than stale context;
- context-budget accounting includes its own audit metadata, so the serialized provider envelope stays within the configured maximum rather than exceeding it after reporting truncation;
- every newly generated phase or experiment audit carries a deterministic fingerprint of its verified criterion state; writes and restart-time reads reject stale or tampered state while legacy audits remain readable;
- director turns receive a compact controller-owned verified-state projection showing satisfied criteria, durable evidence IDs, blockers, and the audit fingerprint; it is derived from audits and cannot be authored by the provider;
- before every director replan after a tool batch, that verified-state projection is refreshed from durable controller state, preventing stale phase progress from persisting across long tool loops;
- the director refresh boundary is integration-tested: provider output cannot replace the projection, and the next request receives the controller's newly observed audit fingerprint;
- runtime tool results are normalized at the provider/controller boundary: malformed names, status fields, trust labels, and warning payloads become explicit controller failures instead of contaminating evidence or silently weakening provenance;
- project-local runtime guidance: an optional bounded `EVIDRA.md` or `.evidra/instructions.md` is injected as hashed operator context for research lanes and directors, explicitly separated from evidence and unable to override deterministic gates;
- role-specific skills: `.evidra/roles/<role>.md` adds bounded, hashed instructions to one specialist’s prompt (for example `validation-scientist.md`) without changing permissions, validation gates, or evidence status;
- shared skill library: `.evidra/skills/*.md` is loaded in deterministic filename order for every research role, bounded and hash-recorded as operator guidance so reusable procedures can compound without becoming evidence or bypassing controller gates;
- explicit agent evaluation: `evidra agents evaluate` or `/agents evaluate` scores observed role trajectories and persists bounded preserve/coach/observe interventions; add `--apply` or use `/agents evaluate apply` to turn coach findings into deduplicated, durable role directives delivered at the next safe boundary; add `--json` for integrations;
- safe role recovery: `evidra agents restart <role>` or `/agents restart <role>` resets failed, blocked, or idle roles for a future allocation while refusing to mutate a live worker;
- heartbeat-aware recovery: `evidra agents recover` or `/agents recover` reclaims only lease-backed lanes and specialist tickets whose heartbeats expired, records an auditable recovery event, and directs non-reclaimable telemetry-only lanes to inspection instead of silently reviving them;
- the same typed failure pressure is applied to capability routing in both the CLI and TUI, increasing verification demand and constraining fan-out consistently across interfaces;
- retryable research-lane transport and timeout failures select an untried configured provider/model route before repeating a route, while single-route setups retain bounded retries and preserve the original failure as evidence;
- director synthesis receives the same route pool and applies the same bounded untried-route recovery, avoiding a full-cycle replay on a failed model;
- the adversarial critic receives the same pool and retries on an untried route before returning a revise-only failure result;
- matched harness benchmark changes are persisted as provenance records containing component snapshots, forecasts, protocol identity, measured outcomes, and a conservative retain/revert/branch decision;
- recent harness-change records are retrieved into future CLI/TUI research context as historical guidance, never as current-task evidence;
- one-shot `evidra research` receives the same history, so harness learning is not limited to autonomous campaigns;
- generated reports expose the bounded harness-evolution decision history, changed components, protocol identity, and measured outcomes;
- fast and YOLO TUI campaigns can run a bounded fresh-lane peer-review pass over contested findings before director synthesis; safe mode stays single-pass and read-only;
- TUI and CLI now grade literature evidence with the same quality, claim-coverage, and provenance-diversity signals;
- paper-derived adaptations require retrieved source claims before they can enter the durable research graph;
- claim audits also resolve provenance against controller-owned source records, so relabeling a literature source as an observation cannot promote it into verified workspace evidence;
- source retrieval resolves literal and DNS-backed hosts before fetching and rejects private, loopback, link-local, mapped-IPv4, carrier-grade NAT, and other reserved ranges to keep autonomous web research outside internal networks;
- source ingestion streams response bodies through a hard byte cap, including responses without `content-length`, so untrusted research endpoints cannot exhaust controller memory;
- DNS resolution for source retrieval is bounded independently of fetch timeouts, keeping malformed or hostile research URLs from hanging an autonomous controller before network I/O begins;
- evaluator parsing retains distinct metric values and rejects completed runs with an unresolved primary-metric conflict, while permitting explicitly step-indexed learning curves;
- metric-conflict diagnostics are persisted on every run attempt, so retries, crash recovery, and post-hoc reports retain the exact evaluator-integrity failure;
- CLI help/version output and Codex client identification are resolved from shipped package metadata, preventing release/version drift when the package version changes;
- controller restart recovery checks the latest durable worker heartbeat before quarantining a running experiment, preventing duplicate recovery while a local, container, or Modal worker is still alive;
- execution heartbeat scopes emit an immediate liveness event before periodic updates, closing the short startup window in which a healthy worker could appear stale;
- TUI trajectories preserve the synthesized cross-pollination board and its evidence/agreement metrics for replay and audit;
- Escape cancellation is wired through TUI critic, lane, and director processes, so interruption stops the active provider work;
- CLI trajectories preserve the synthesized cross-pollination board for the same replay and audit parity as the TUI;
- headless Research and Challenge phase goals initialize independently, even when the other mode already has durable goals;
- phase goals are also isolated by a deterministic ultimate-objective identity, preventing separate campaigns from sharing progress accidentally;
- phase gates count only evidence created within the active objective boundary, so historical runs and artifacts cannot satisfy a new campaign;
- TUI phase gates read complete durable event families rather than the bounded visible timeline, preserving correctness in long campaigns;
- the safety benchmark reports the effective SAFE/FAST/YOLO capability contract, including the hard external-submission veto;
- generated reports display phase objective-set identities, keeping multiple research objectives distinguishable in one project;
- failed hypotheses cannot silently consume budget on an unchanged route: retries must change the executor, provider, model, or search operator, while the failed attempt remains immutable evidence;
- suppressed duplicate or unchanged retries emit a durable scheduling event with the route and reason, so the next research cycle can replan from an explicit controller decision;
- autonomous campaigns persist phase-level checkpoints (cycle start, lanes, director, critic, execution, and terminal/completion) into campaign state, scheduler state, and the controller lease for reliable restart and status reporting;
- checkpoint ownership is process-bound, and CLI/TUI status views expose the saved cycle, phase, and timestamp so stale controllers cannot overwrite live progress;
- checkpoint metadata is validated against a fixed phase contract with nonnegative cycles and valid timestamps; malformed or legacy metadata is reported as unavailable rather than trusted;
- resume uses that checkpoint contract: interrupted phases rerun their current cycle, while a completed cycle advances exactly once, preventing skipped or duplicated campaign cycles;
- the TUI applies the same checkpoint validator as the CLI, so status views cannot present malformed progress metadata as trustworthy state;
- resume explicitly records and reports invalid saved checkpoints before returning to a safe cycle boundary, preserving operator visibility instead of silently discarding progress metadata;
- the interactive TUI now writes the same research, execution, and cycle-complete checkpoints as the CLI, keeping Codex campaigns resumable regardless of entry point;
- TUI checkpoint updates mutate the live campaign state before later persistence, so pause, approval, budget, and completion writes cannot erase resume metadata;
- CLI and TUI now share one validated checkpoint constructor, preventing their durable campaign metadata formats from drifting;
- local research lanes can use a bounded heterogeneous Ollama pool: installed local models are discovered at campaign start, assigned deterministically across independent roles, and the actual model used by every lane is recorded for replay and routing analysis;
- independently replicated methods are also distilled into ranked, provenance-linked playbook leads with explicit transfer failure modes; playbooks guide new research but never count as current-workspace proof;
- failed, invalid, rejected, and blocked experiment directions are retained as ranked negative experience, so future cycles must change the route instead of repeating an unchanged failure;
- experiment proposals receive an explainable novelty score against prior directions, reducing redundant hypothesis families while preserving probability-of-success, information-value, risk, and compute-cost ranking;
- ensemble proposals are durable, checksummed candidate artifacts with member-file checksums, provenance, and explicit candidate/validated/promoted/rejected status; source mutation blocks validation, and creating a blend never silently promotes or submits it;
- local-model experiment implementation through bounded unified-diff proposals, checked and applied only inside the experiment worktree;
- Modal execution mounts the exact isolated experiment worktree and accepts either Modal CLI profiles or environment credentials;
- Docker/Podman execution mounts only the exact isolated experiment worktree, uses a network-disabled container, and keeps the same artifact, metric, retry, and evidence gates;
- Codex-backed experiment engineers honor the configured entitlement policy: they switch to an installed local fallback in `auto`/`fallback` mode, or wait durably when `wait` is selected, instead of silently abandoning an authorized campaign;
- shell and autonomy safety guards.
- a deterministic six-lifecycle safety boundary benchmark (`evidra benchmark safety`) covering configuration, capability extension, runtime, persistence, action control, and recovery;
- a deterministic orchestration benchmark (`evidra benchmark orchestration`) covering duplicate lane prevention, lease ownership, queue ownership, dependency ordering, starvation prevention, deadline expiry, cancellation races, hierarchical cancellation, stale recovery, per-lane budget accounting, completion-proof enforcement, delegated-child completion gates, approval gates, queue-wide and hierarchical pause governance, priority and label control, and live budget stops;
- optional queue completion contracts: declare `requiredPayloadKeys`, `requiredEvidenceRefs`, `requiredActivityKinds`, and optionally `requireChildCompletion: true` in a task payload so workers must produce verifiable proof and finish delegated children before a task can become completed; rejected completions are auditable, retried within the task ceiling, and converted into recoverable failures rather than stranded leases;
- operators can attach or clear those contracts on queued/failed work with `evidra queue contract <id> '<json>'` (or `/queue contract`), preserving the change as a durable audit event;
- queue insertion is idempotent by task ID: duplicate scheduling requests cannot silently replace work and are recorded as duplicate enqueue attempts;
- terminal queue records retain the original task specification under `_task` and worker output under `completion`, keeping objectives and proof contracts inspectable after execution;
- authenticated external workers receive structured missing-proof details on rejected `/tasks/complete` calls, making remote contract repair actionable instead of opaque;
- external completion responses include authoritative `currentStatus`, allowing workers to reconcile a lost response without duplicating terminal work;
- external completion requests accept an optional `idempotencyKey`; safe retries of an acknowledged terminal transition return success without creating a second transition;
- external workers can voluntarily yield a live lease through `/tasks/release`; the task is requeued without a failure penalty and receives a fresh fencing token;
- queue claims carry unique fencing tokens; remote workers must present the token for heartbeat/completion, preventing a stale process with a reused worker ID from mutating a reclaimed task, while operator projections keep tokens secret;
- the same fencing token protects remote activity and usage reports, preventing stale workers from adding misleading progress or charging recovered work;
- a deterministic agent-governance benchmark (`evidra benchmark governance`) covering role-contract completeness, explicit custom-role admission and rejection, tool authority boundaries, pause/resume controls, scoped handoff isolation, durable handoff auditability, and recovery approval boundaries;
- durable external-action intents that reserve submissions before invocation, refuse restart-time replay, and require explicit `evidra submission reconcile <bundle> --status submitted|not-submitted` after an ambiguous crash;
- integrity-bound campaign runtime policy: resume verifies provider, model, thinking effort, lanes, autonomy, usage-limit policy, and executor before continuing;
- deterministic injection-signal warnings on untrusted workspace, web, repository, and source observations, retained in director context and trajectory traces without rewriting evidence;
- empirical-Bernstein search allocation with variance-aware uncertainty and hard remaining-budget checks;
- deterministic hierarchical research-decision rubrics for action closure, falsifiability, evidence, verification, diversity, and risk, with gaps fed into the next cycle;
- matched benchmark-arm validation requiring task, seed, model, reasoning-effort, and budget parity before a competitive claim.
- post-replication validation reassessment: a parent experiment’s replication gate is reopened only after a valid improved child (and required ablations) is observed; unrelated or merely successful runs cannot satisfy it;
- executable matched-arm benchmark protocols that capture raw process evidence before scoring harnesses.
- paired, task-balanced benchmark comparisons that refuse a win claim without positive lower-bound evidence and sufficient coverage.
- benchmark coverage counts the full union of declared arms, so unmatched task/seed/model/budget arms cannot be hidden by scoring only the intersection;
- direct scorecard comparisons independently recheck data revision, runtime fingerprint, baseline, direction, and normalization-bound parity before pairing outcomes;
- an arm with an explicitly requested reproducibility check must pass that check, and both harnesses must expose the same check status before their metrics can support a win;
- domain-agnostic successive-halving schedules that allocate cheap screens before expensive validation.
- optional normalized multi-objective Pareto promotion for quality/speed/safety suites, while preserving scalar promotion compatibility.
- reduced-validation screening carries the full declared metric suite into Pareto promotion, so secondary objectives affect actual autonomous candidate selection rather than only post-hoc auditing.
- autonomous portfolio execution that screens candidates in a first pass and promotes survivors into full validation and replication.
- explicit leave-one-factor-out ablation plans for composite hypotheses, with bounded autonomous variant execution and independent evidence per factor;
- checksum-locked validation policies with auditable unlock reasons and pre-experiment mutation checks.
- bounded scholarly-source discovery that returns candidates separately from trusted, hashed source retrieval.
- SAFE research can retrieve and hash read-only literature evidence; workspace edits, policy changes, reports, and external actions remain permission-gated.

### Experience-driven improvement

Evidra treats an autonomous run as reusable research experience rather than disposable chat
history. A structurally complete trajectory becomes a candidate experience; recoverable failures
remain replay-only; ambiguous or malformed traces are quarantined. The workbench aggregates these
records into a capability profile and recommends a curriculum that starts with bounded examples,
expands across observed tasks and outcomes, and then introduces higher-demand or recovery-heavy
trajectories. Each selected trajectory is now materialized into a bounded replay lesson containing
its objective, acceptance condition, outcome, evidence, and capability gaps; opaque trajectory IDs
are never presented as if they were usable experience. This is inspired by routing-harness research such as NeoHorse-1, but remains
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
- running autonomous campaigns accept steering without starting a second controller: use `/steer <instruction>`, `/research steer <instruction>`, or `/challenge steer <instruction>`; the instruction is durably recorded and applied at the next safe cycle boundary;
- opaque local requests are processed FIFO after the active request completes;
- Ctrl+C clears non-empty input and exits only when input is empty;
- Tab, arrows, and Enter operate command/model/provider selectors.

Autonomous research is presented as a three-stage loop:

1. **Orient** — inspect the workspace, question, data contract, and validation surface.
2. **Discover** — retrieve evidence, form competing hypotheses, and choose the highest-information next action.
3. **Validate** — run controlled checks, audit evidence, replicate promising signals, and decide whether the stopping rule is met.

The controller may use more detailed internal phase goals underneath those three stages, but live progress always reports `1/3`, `2/3`, and `3/3`. Run `/research examples` for contemporary AI/CV starter briefs, or `/research plan` to inspect the active detailed phase graph.

Useful commands:

    /help                 Show commands and shortcuts
    /status               Show project, graph, queue, and execution state
    /timeline             Show a readable autonomous execution timeline
    /integrity            Verify the durable event history for tampering/corruption
    /backup [path]        Create a consistent durable state backup
    /usage                Show durable activity, experiment time, and agent tokens
    evidra agents         Inspect agent organization and role-health reviews
    evidra agents --json  Export machine-readable agent health for automation
    /budget tokens <n>    Set the campaign agent-token ceiling (`0` = unlimited)
    /research             Start or run an evidence-gathering cycle
    /research start       Start a fully autonomous research campaign
    /research examples    Show contemporary starter briefs with metrics and stop rules
    /research examples --json
                          Export starter briefs for an external runner
    /research plan        Show the three high-level steps and internal phase goals
    /research plan --json Export the stages and current phase progress as JSON
    /research plan history Show structural phase-plan revisions
    /research pause       Pause workers and preserve the campaign
    /research resume      Resume the saved research campaign
    /research stop        Stop the campaign without deleting evidence
    /research steer ...   Guide the next safe research cycle
    /loop                 Run or control the autonomous loop
    /workbench            Select Research or Challenge mode

The controller also exposes a read-only local browser view:

```bash
evidra dashboard --port 4310
```

Open `http://127.0.0.1:4310`. The dashboard polls the same durable SQLite
state and event log as the TUI, shows campaign/phases/agents/runs/events, and
does not expose mutation endpoints.
    /provider             Select Codex or local provider
    /model                Select an available provider model
    /fallback             Select the local model used after Codex exhaustion
    /thinking             Select reasoning effort
    /permissions          Select safe, fast, or YOLO automation
    /sources              Retrieve/search durable research sources
    /sources channels     Show typed discussion and leaderboard insights
    /sources frontier     Inspect deduplicated literature-search coverage
    /evidence audit       Audit claim provenance and completion blockers
    /memory               Search durable evidence and research memory
    /experience           Inspect the capability profile and next curriculum
    /experience export    Export admissible trajectories as JSONL for replay or analysis
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
    /challenge steer ...  Guide the next safe challenge cycle
    /agents               Show agent lanes and health
    /tools                Show built-in and project research adapters
    /tools health         Probe enabled zero-argument adapters
    evidra tools          Inspect or control adapter lifecycle
    /compute              Show executor and budget health
    /queue                Show durable tasks and recover stale work
    /submission           Prepare, validate, approve, submit, or poll a bundle
    /submission distribution  Estimate which local split tracks external scores
    /report               Generate a portable report
    /sessions             List saved sessions
    /resume               Resume a saved session explicitly
    /doctor               Diagnose dependencies and provider access
    evidra doctor --json  Export machine-readable provider/backend diagnostics, including `ready`
    /exit                 Leave the current session

Explicit shell escapes are available for operator-directed work:

    !ls -la
    !git status --short

Experience can also be exported headlessly:

    evidra experience status
    evidra experience export --output .sota/experience.jsonl
    evidra experience export --include-replay --output reports/replay-experience.jsonl

Candidate experiences are exported by default. `--include-replay` adds recoverable failures;
quarantined or structurally ambiguous trajectories are always excluded.
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

Research is not restricted to competition repositories. If the active workspace exposes a valid evaluator, Evidra records its baseline; otherwise it continues with repository inspection, source retrieval, hypotheses, experiments, and declared artifact or proof validation. Challenge mode remains evaluator-strict.

Continue a paused or interrupted headless campaign explicitly with `--resume`:

    evidra research --resume --provider codex --limit-policy fallback

The same lifecycle can be controlled without starting a second controller:

    evidra research status
    evidra research pause
    evidra research resume
    evidra research stop

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

The command checks the selected provider before starting repository inspection or baseline execution. Under `auto` or `fallback`, the default Codex path can change to a healthy configured local model after recognized usage-limit, network, or route-availability failures; authentication and model-configuration errors remain explicit instead of silently starting an unconfigured run.

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
        "reducedValidationCommand": ["python", "run_experiment.py", "--folds", "1", "--epochs", "1"],
        "reducedPromotion": {
          "enabled": true,
          "minimumDelta": 0.01,
          "tolerance": 0.005
        }
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

When `reducedPromotion.enabled` is true, the reduced run becomes an early compute gate. Evidra
compares its declared metric against the latest durable baseline, correctly handling maximize and
minimize metrics, then skips full validation when the improvement is below the configured threshold.
`tolerance` protects against noisy cheap splits. If no finite baseline exists, the candidate is
preserved for full validation; a missing candidate metric is rejected.

For long-running training or search workers, an experiment may also declare an evidence-safe
learning-curve stop policy in `resources.earlyStopping`:

```json
{
  "enabled": true,
  "metric": "validation_score",
  "direction": "maximize",
  "warmupSteps": 100,
  "patience": 3,
  "minimumImprovement": 0.002,
  "reference": [
    { "step": 100, "metric": 0.41 },
    { "step": 200, "metric": 0.55 },
    { "step": 400, "metric": 0.66 }
  ]
}
```

Workers can emit JSON progress lines such as `{"step": 200, "validation_score": 0.51}`.
Evidra stops only after persistent underperformance against the comparable reference curve;
one noisy observation cannot discard a run. The result is recorded as `early_stopped`, preserving
the progress log and the reason for the decision. A missing reference curve disables the policy,
so an uncalibrated controller never stops work merely because a model guessed poorly.

## State and provenance

Durable controller state lives under .sota:

    .sota/
    ├── database.sqlite          # canonical relational state
    ├── validation-policy.json   # versioned validation policy
    ├── artifacts/               # logs, metrics, and environment snapshots
    ├── reports/                 # generated research/challenge/final reports
    └── worktrees/               # isolated experiment worktrees

The event log records observations, tool calls, source retrieval, queue claims, phase-goal updates, experiment runs, artifacts, and generated reports. Generated summaries never replace primary logs, metrics, or source hashes.

Generated Markdown and JSONL reports under `reports/` are intentionally ignored by Git: they remain available for local inspection and are referenced by durable events, but cannot accidentally appear as source modifications during a later autonomous cycle.

Evidence claims are validated at the SQLite boundary. Every claim requires a statement, scope, confidence, source type, source identifier, and lifecycle status; literature claims are rejected unless their source was retrieved and stored. Additional provenance such as excerpts, findings, reports, and artifact references is retained alongside the validated core.

Source discovery is provenance-aware but deliberately not gullible. Scholarly works, official references, implementation repositories, and generic discovery pages receive separate evidence classes and conservative routing scores. Deep searches use a small diversity bonus to avoid filling the frontier with one provider's near-duplicates; retrieval, extracted claims, and independent evaluation are still required before a source can support a conclusion. Retrieved text is untrusted content, and instruction-like sentences are excluded from durable claim extraction.

The store also performs a conservative consistency pass: exact duplicates are recorded for review, and only strongly overlapping statements with explicit negation receive a `contradicts` graph edge. These findings never invalidate or promote a claim automatically; inspect them with `/graph` or the generated report.

Unresolved evidence conflicts feed back into autonomous allocation: the next research cycle prioritizes source review and independent falsification before spending compute on another hypothesis.

Long campaigns also receive a bounded durable-memory snapshot on every cycle. It contains recent claims, hypotheses, and contradiction edges independently of the short event window, so research does not forget earlier evidence after a restart or many experiments.

The memory snapshot also includes validated cross-competition methods. These records retain the source task, formulation family, mechanism, proposed change, and both experiment IDs that established replication, so a new challenge can reuse a mechanism without losing the audit trail.

Autonomous campaigns include a stagnation guard: three identical unresolved active decisions first trigger one durable diversification cycle that widens formulation families and changes the execution/search route. If the same decision remains unchanged after that recovery cycle, Evidra pauses for review and persists the decision signature. A new hypothesis, execution, replication, phase transition, or explicit resume can continue the work; Evidra does not silently spend the remaining budget repeating the same blocked action.

Composite metric hypotheses use leave-one-factor-out ablations with a measured
control/variant comparison. Ablation evidence is incomplete when a successful
process emits no finite comparable metric, and each factor effect is retained
for audit. Non-metric hypotheses remain governed by their declared artifact,
proof, behavior, or system outcome contract.

Campaigns also have an evidence-based stop policy. If the configured stop condition names convergence, plateau, expected gain, or repeated failure, Evidra evaluates durable search rewards rather than model prose: low gain requires a minimum sample window, repeated failures pause for a route change, and unresolved leakage pauses the campaign for review. Every assessment and trigger is stored as `research.stop_policy.assessed` / `research.stop_policy.triggered`, so stopping is inspectable and resumable. Generic campaigns continue exploring until the director, phase gates, or budget provide a separate terminal signal.

Phase advancement is evidence-gated. A model cannot advance orientation, baseline, auditing, validation, implementation, evaluation, replication, or promotion by returning `goalStatus: met` alone; the controller checks the corresponding durable events and gates. Challenge mode requires a parsed primary evaluator baseline, general research mode requires a durable reference observation, and evaluation requires a finite primary experiment metric. Otherwise Evidra records `research.phase_gate.rejected` and keeps the phase active.

Each phase gate is evaluated on every controller cycle and exposes a deterministic progress breakdown (`completed`, `total`, and `ratio`) in rejection events and durable controller state. This is a steering signal for long-running campaigns, not a relaxed completion rule: a phase advances only when all required checks pass. Progress is calculated from controller-verifiable evidence, so model prose cannot make a partially completed phase appear complete.

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
    
For Kaggle, Evidra performs a read-only `competitions files` access preflight
before the approved upload. This checks authentication and competition access
without giving credentials to agents. Score polling defaults to Kaggle's
`competitions submissions --csv` output, including its public-score column, so
no custom polling command is required.

Other platforms can use an argv-based command adapter. Supported placeholders are `{bundle}`, `{file}`, `{competition}`, and `{message}`; Evidra does not invoke a shell for adapter arguments:

    "submission": {
      "platform": "command",
      "submitCommand": ["./scripts/submit", "--file", "{file}", "--message", "{message}"],
      "scoreCommand": ["./scripts/score", "--submission", "{submission}"]
    }

`scoreCommand` is an optional generic read-only polling adapter. It runs inside the project root and accepts `{bundle}`, `{file}`, `{competition}`, and `{submission}` placeholders. Emit JSON such as `{ "publicScore": 0.812 }` or a line such as `score: 0.812`; Evidra validates that the result is finite, redacts captured output, stores the observation as evidence, and marks the bundle scored. Use `/submission poll <bundle-id>` or `evidra submission poll <bundle-id>`. Platforms without a polling API can continue using `/submission record` after a manual leaderboard observation.

Platforms with an HTTP API can use the provider-neutral adapter. The prediction
file is uploaded as multipart form data, and score polling substitutes
`{submission}` in the configured URL. Credentials are referenced by an
environment-variable name and are never stored in the project or sent to an
agent:

    "submission": {
      "platform": "http",
      "submitUrl": "https://challenge.example/api/submissions",
      "scoreUrl": "https://challenge.example/api/submissions/{submission}",
      "authEnv": "CHALLENGE_API_TOKEN",
      "fileField": "file",
      "predictionFile": "submission.csv"
    }

HTTP endpoints must use HTTPS; localhost HTTP is allowed for local adapters and
tests. Responses are bounded, parsed for a submission identifier or finite
 score, redacted, and recorded through the same approval and external-action
ledger as command/Kaggle submissions. Score polling retries transient GET and
network failures at most twice with backoff; submission POSTs are intentionally
single-attempt because a timeout cannot prove that the remote service rejected
the submission. HTTP response bodies are streamed through a 32 KiB cap before
parsing, preventing an untrusted endpoint from causing unbounded memory use.

## Provider architecture

The provider is an implementation detail behind the same research protocol:

- **Codex:** the installed official codex CLI, authenticated ChatGPT/Codex account, JSON event output, persisted threads, and thread queue support. Read-only turns automatically recover once from host bwrap/network-namespace failures in a disposable isolated copy; workspace-write experiment turns never use that fallback.
- Multi-lane Codex research uses the same bounded authenticated model pool in
  both the headless CLI and interactive TUI: your selected model remains
  primary, alternatives are discovered from the authenticated account,
  filtered by reasoning capability, and assigned deterministically. Costly
  Astra models are excluded from automatic diversification by default but can
  still be selected explicitly; an explicit Astra selection is never silently
  rewritten to the Luna default.
- **Local:** Ollama's local chat endpoint and the selected installed model.

Competition manifests may additionally declare typed `researchChannels` such as
`rules`, `discussion`, `leaderboard`, `documentation`, `paper`, or `repository`.
The autonomous loop ingests these through the same SSRF-safe retrieval path as
literature, records the channel kind and content hash, and applies channel-specific
refresh intervals. Channel content is discovery evidence only: it cannot masquerade
as a locally measured metric or an externally verified submission score.
The director can request a configured channel directly with the bounded
`competition.observe` tool; it uses the same durable cache and provenance rules.

Evidra never extracts subscription tokens or implements unofficial ChatGPT API calls. Provider availability is checked before work begins, and local fallback is used only for configured `auto`/`fallback` policies when a local model is available and the Codex failure is classified as safely route-changeable.

## Development

    npm install
    npm run check       # TypeScript type-check only
    npm run build       # Compile dist/
    npm test            # Build and run the core smoke suite
    npm run dev         # Run the CLI from TypeScript

The test suite covers durable state reopen, fresh/resumable sessions, generic manifests, autonomy guards, queue concurrency/retry behavior, research tool execution and audit events, the director tool loop, statistics, ensembles, provenance, and detached process interruption.

## Roadmap

The current implementation already includes items 1–6: versioned validation and metrics,
data/leakage audits, a typed worker protocol with heartbeats and artifact checks, reduced
screening and cost-aware scheduling, persistent lane state with independent critics, and
OOF/prediction analysis with ensemble candidates. The remaining research-lab layers are:

1. richer platform-specific leaderboard/discussion adapters on top of the
   provider-neutral typed research-channel layer. The current layer already
   extracts bounded leaderboard rows, discussion topics, and metric/leakage/
   split/seed/replication signals from untrusted channel text; inspect them in
   the TUI with `/sources channels`;
2. additional remote executor backends such as Kubernetes, RunPod, and Vast.ai (Slurm is now supported);
3. deeper dashboard visualizations and remote controls; the read-only local
   dashboard is now available with `evidra dashboard`.

These are separate from the core TUI so Evidra remains useful for non-Kaggle research and can be operated entirely from a terminal.

For a reproducible end-to-end harness trial, see [the Karpathy Autoresearch recipe](docs/benchmarks/karpathy-autoresearch.md). A standard checkout is detected by `evidra init autoresearch`, so the generic manifest, GPU worker, metric parser, evidence artifacts, and autonomous experiment loop can be exercised without a benchmark-specific agent path. The same controller and evidence contracts are used for scientific, software, algorithmic, and competition workflows.

The first real AIRS-Bench task trial is recorded in [the AIRS-Bench harness report](docs/benchmarks/airs-bench.md). It reproduces a SICK task baseline through Evidra and records structured-agent failure as resumable evidence when a deliberately small local model cannot complete the decision contract.

Evidra also discovers the public [AutoLab](https://github.com/autolabhq/autolab) long-horizon optimization contracts with `evidra benchmark autolab discover ./autolab --out autolab-inventory.json`. The adapter preserves task metrics, directions, baseline/reference anchors, resources, and timeouts for later matched Harbor runs; discovery is not a leaderboard result. See [AutoLab integration](docs/benchmarks/autolab.md).

Evidra's competitiveness target and equal-budget comparison protocol are documented in [Harness competitiveness](docs/benchmarks/harness-scorecard.md). A harness is not considered better because it produces more narrative output: it must produce valid, reproducible evaluator-backed improvements and recover from failures.

The separate [Autoresearch Bench](https://www.autoresearch-bench.com/) is an external evaluation: agents work in isolated workspaces, may receive public feedback from a grader, and are scored on held-out private results. Evidra's submission adapters and durable public-score observations are the integration boundary for that benchmark; a local smoke run must never be presented as an official Autoresearch Bench score.

For agent-agnostic scientific evaluation, `evidra benchmark scientific task.json` runs an ordered task contract with intermediate verifiers, required artifact checksums, snapshot boundaries, bounded logs, and resumable stage state. `evidra benchmark scientific-suite contracts/ --checkpoint-dir suite-state/` runs a stable, task-balanced directory of contracts and checkpoints each task immediately for crash-safe resume via `--resume-dir suite-state/`. Independent contracts can be accelerated with `--parallel 4`; Evidra automatically serializes tasks whose declared workspaces overlap, preserving evidence isolation. It reports per-task validity, mean stage score, process quality, and resumable task results. See the [stepwise scientific-task protocol](docs/benchmarks/scientific-task-protocol.md).

The research evaluation surface is designed to align with current scientific-agent benchmarks: `evidra benchmark literature-score` distinguishes deep target discovery from wide constrained collection, while scientific task contracts retain executable artifacts, intermediate verifier results, cost, and resume state. See the [literature evaluation map](docs/research/literature-synthesis-2026-09.md#external-evaluation-targets). These integrations provide protocols, not automatic claims of benchmark leadership; matched external runs are still required.

Headless operators can inspect the same bounded competition-channel observations with
`evidra sources channels`, filter by kind with `evidra sources channels discussion`,
or consume a machine-readable snapshot with `evidra sources channels --json`.
Leaderboard rows, discussion topics, and extracted signals are explicitly marked as
untrusted discovery evidence; they never satisfy a local metric, replication, or
external-score gate by themselves.

Scientific stages and generic acceptance criteria may declare relative weights for progress diagnostics. Weights help compare partial multi-stage work and prioritize important evidence, but they never turn a failed required criterion or verifier into a passing result.

Run `evidra benchmark safety` to execute Evidra's local lifecycle safety regression suite. It must pass before treating a harness change as benchmarkable; `--json` emits the machine-readable probe report for CI. This is an internal boundary regression suite, not an external HarnessRisk score.

Durable events are now hash-chained. `evidra integrity events` (or `--json` for CI) verifies event payloads and
ordering after restarts or recovery. Stores created by older Evidra versions are reported as
`LEGACY` until their historical prefix is replaced; newly appended events remain verifiable.

Use `evidra backup [workspace-relative-path]` or `/backup [path]` before risky maintenance,
environment changes, or long campaigns. The backup is created through SQLite's consistent
backup API while the live controller remains open, and can be reopened as an independent
Evidra store for recovery verification.
Autonomous research and challenge starts also create a timestamped controller-start backup
after the integrity check and before lease acquisition.

## Contribution

Evidra is currently maintained as a private research project. Contributions should preserve the central invariants: deterministic state over conversational state, bounded autonomy, explicit provenance, isolated experiments, and no credential exposure to agents.
