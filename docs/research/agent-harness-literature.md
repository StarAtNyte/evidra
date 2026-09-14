# Agent-harness literature translated into Evidra

Evidra should borrow mechanisms, not slogans. The current design is guided by
the following evidence and each item has an implementation consequence.

## Search is the capability

The AIRA MLE-bench study models research agents as search policies over candidate
solutions and reports that operator sets and search policies materially change
success rates. Evidra therefore now has an evidence-aware operator portfolio:
untried directions receive an exploration bonus, repeated directions use an
upper-confidence estimate, cost is penalized, and invalid measurements receive
negative reward. This is the foundation for adding greedy, evolutionary, MCTS,
and bandit policies without changing the experiment contract.

Source: [AI Research Agents for Machine Learning: Search, Exploration, and
Generalization in MLE-bench](https://arxiv.org/abs/2507.02554).

The newer FML-bench results sharpen that design rather than endorsing a single
algorithm: greedy search can be competitive when improvement opportunities are
dense, while tree/evolutionary search is more useful when opportunities are
sparse; an adaptive switch after stagnation outperforms a fixed topology. AutoLab
also finds that persistence—repeatedly benchmarking, editing, and incorporating
empirical feedback—is a stronger predictor of long-horizon success than the
quality of the first attempt. Evidra now treats stagnation as a control signal:
it spends one durable recovery cycle on broader formulation families and an
alternate route before pausing, while retaining a bounded terminal guard.

Sources: [FML-bench](https://arxiv.org/abs/2605.17373) and
[AutoLab](https://arxiv.org/abs/2606.05080).

## Optimize time-to-valid-progress

RE-Bench shows that agent performance changes with total time budget and that
short-budget and long-budget behavior should be evaluated separately. Evidra's
scorecard consequently records median time to first valid evidence instead of
only final metric, and campaigns enforce per-turn deadlines plus resumable
failure state.

Source: [RE-Bench](https://arxiv.org/abs/2411.15114).

## Reliability is part of research quality

MLR-Bench reports frequent fabricated or invalid experimental results from coding
agents. Evidra treats a narrative metric as zero evidence: only a finite metric
from a declared evaluator, with checksummed artifacts, an immutable manifest,
and a durable run record can improve the scorecard.

Source: [MLR-Bench](https://arxiv.org/abs/2505.19955).

## Diversity, cross-pollination, verification

OpenAI's report on its Navier–Stokes effort describes heterogeneous groups,
different problem formulations, communication between groups, cross-pollination
of useful intermediate results, isolation, and formal Lean verification. For
Evidra this maps to role-specific lanes, bounded peer boards, formulation/family
diversity, critic gates, replication, and domain-specific verification adapters.
The report is evidence about one system's described process, not proof that the
reported mathematical result is independently accepted.

Source: [On the Navier–Stokes Millennium Prize Problem](https://openai.com/index/navier-stokes-solution/).

Formal verification is now represented as structured run evidence rather than a
bare successful exit code. Common Lean/Lake, Coq/Rocq, Isabelle, Dafny, Agda,
and SMT solver commands are classified automatically; semantic markers such as
`proved`, `no goals`, or `unsat` are retained, while successful commands with no
recognizable marker remain explicitly provisional. This makes proof-oriented
and solver-oriented research artifacts auditable without making the harness
specific to machine learning.

AlphaEvolve and AI Scientist-v2 suggest two complementary search mechanisms for
the workbench: evaluator-gated evolution of a population of candidate programs,
and progressive tree search with an experiment manager. Evidra should use these
as bounded operators over immutable experiment manifests—not as unconstrained
self-modification. Candidate generation may be creative, but promotion remains
dependent on the declared evaluator, independent replication, artifact
provenance, and retention/holdout gates. This preserves the useful part of
evolutionary and tree search while preventing a search agent from changing the
yardstick or silently discarding failed branches.

Sources: [AlphaEvolve](https://arxiv.org/abs/2506.13131) and
[AI Scientist-v2](https://github.com/SakanaAI/AI-Scientist-v2).

[EvoScientist](https://arxiv.org/abs/2603.08127) makes the memory boundary more
explicit: ideation memory should retain both feasible directions and failed
directions, while experimentation memory should preserve effective execution
strategies. Evidra's durable claims, hypotheses, failure trajectories,
transferable methods, literature sources, and repository leads implement this
separation. The important remaining test is not whether memory grows, but
whether retrieval improves replicated outcomes without increasing stale-route
repetition or context cost.

[CodeEvolve](https://arxiv.org/abs/2510.14150) motivates island-style populations
and inspiration-based crossover. Evidra now emits a deterministic, bounded
island plan from admitted evolutionary/combination/MCTS candidates, including
explicit migration links and crossover proposals. Proposals remain
non-executable until the controller creates a matched experiment manifest, so
the mechanism cannot bypass permissions or evidence gates. It still requires a
matched benchmark arm before it can be claimed better than the current policy.

## Benchmark the harness, not just the model

AIRS-Bench provides task specifications for multiple research-agent frameworks
and public harness comparisons. Evidra's scorecard uses the same arm/task/budget
discipline and separates improvement rate, valid-run rate, recovery, and
reproducibility. It must not claim superiority until it has matched the public
task protocol with comparable seeds and budgets.

Source: [AIRS-Bench](https://github.com/facebookresearch/airs-bench).

## Measure execution alignment, not only completion

Harness-Bench reports that the model and harness must be evaluated as a single
configuration under shared tasks, budgets, timeouts, and validators. Its most
useful diagnostic is execution alignment: plausible reasoning can become
decoupled from tool feedback, workspace state, evidence, or a verifiable output
contract. Evidra therefore treats tool traces, evaluator results, recovery
events, terminal state, and evidence provenance as first-class trajectory data;
the final metric cannot erase a broken or unclosed process trace.

Source: [Harness-Bench](https://arxiv.org/abs/2605.27922).

## Diligence is a research capability

AARRI-Bench finds that current agents often miss subtle details that human
researchers catch, including methodological and ethical requirements. This
supports Evidra's separation between a model's narrative and deterministic
gates: source claims remain low-confidence literature evidence, evaluator output
must be reproducible, conflicts trigger audit/validation, and a campaign cannot
terminate merely because a plausible answer was produced.

Critic objections are execution gates, not advisory prose: a `revise` verdict
now forces the next cycle into inspection until its required checks become
durable evidence. This prevents an agent from satisfying diligence with a
well-written acknowledgement while still running the originally challenged
experiment.

Source: [Act As a Real Researcher: A Suite of Benchmarks Evaluating Frontier
LLMs and Agentic Harnesses in Research Lifecycle](https://arxiv.org/abs/2606.07462).

## Cross-pollination must preserve disagreement

Independent lanes now return through a bounded cross-pollination board before the
director decides. Evidra records overlapping findings, unresolved tensions,
deduplicated recommendations, and source evidence separately. This matters
because agreement is useful for prioritization, while disagreement is often the
signal that a validation or formulation experiment is needed. Hypotheses also
declare a formulation family (`representation`, `data`, `validation`,
`objective`, `model`, `inference`, `ensemble`, `repair`, or `other`) so the
portfolio planner can spend a cycle across genuinely different approaches.

When the board reports contested evidence or insufficient independent support,
fast and yolo campaigns trigger one bounded peer-review round. The lanes receive
the first board and prior findings, challenge them without repeating workspace
tool calls, and return a second board to the director. The round is persisted as
`research.peer_review.completed`; it is not an unbounded recursive debate and it
does not run in safe mode by default.

## Current implementation gaps

The next high-value upgrades are:

1. run equal-budget AIRS-Bench and Harness-Bench-compatible arms across Evidra,
   AIRA-dojo, MLGym, and comparable harnesses;
2. run equal-budget comparisons of greedy, UCB, evolutionary, and MCTS policies
   under the same task and compute budgets.

3. Add an agent-agnostic, stepwise scientific-task suite. SciAgentArena's
roughly 200 interactive tasks and InnovatorBench's ResearchGym both reinforce
that final answers are insufficient: the environment must expose intermediate
verification, asynchronous execution, snapshots, and process-level outcomes.
Evidra already persists these primitives; the remaining work is a reproducible
adapter and matched runs rather than another prompt-only benchmark.

Sources: [SciAgentArena](https://arxiv.org/abs/2606.12736) and
[InnovatorBench](https://arxiv.org/abs/2510.27598).

Paired confidence intervals and task-balanced scores are implemented in the
scorecard, and formal-verification adapters are implemented in run evidence;
their remaining gap is external matched measurement, not a missing runtime
primitive.

Source adaptation is now implemented: `evidra sources adapt <source-id> [objective]`
passes bounded claims and excerpts from a cached source to the director, while
persisting resulting claims as low-confidence literature evidence and linking them
to the source with `derived_from` edges. This keeps paper-derived ideas useful for
search without confusing them with measurements from the active workspace. AIRS-
Bench task discovery is now implemented with `evidra benchmark airs discover`; it
validates all 40 public `rad` and `mlgym` task contracts in the current checkout
and emits a normalized inventory. Execution adapters and matched harness commands
remain explicit because the benchmark fixes model, seed, task, and budget. The
remaining empirical work is to benchmark which adaptation prompts and
verification gates produce the highest rate of successfully replicated ideas.

The early-promotion item is now implemented conservatively: after eight paired
reduced/full outcomes, Evidra learns a threshold from successful full runs;
before that, and whenever evidence is one-sided, it uses the manifest's static
threshold. The learned rule is recorded with each promotion decision and is
never allowed to lower the configured minimum.

The search-policy item is implemented as a stable default portfolio:
`greedy`, `ucb_portfolio`, `evolutionary`, `mcts`, `ablation`, `combination`,
`replication`, and `audit` are explicit bounded operators. They share the same
experiment manifests and reward ledger. The remaining work is a controlled
equal-budget comparison, not an assumption that a named policy is automatically
better.
Every cycle now persists the complete bounded ranking and the budget, failure,
and evidence-conflict context that produced it, so policy evolution can be
audited rather than inferred from the selected operator alone.

Portfolio scheduling now executes a domain-agnostic successive-halving plan:
cheap screen fractions cover the candidate set first, deterministic retain counts
bound later stages, and only valid measured outcomes can be promoted. Screening
is persisted as `experiment.screening.completed`; full validation and replication
are launched only for promoted candidates. Worker-specific reduced commands
still define how a fraction maps to folds, examples, simulation steps, or proof
search.

The competitive claim gate is now implemented: `benchmark compare` uses paired
task-level bootstrap bounds and refuses to call a harness better when coverage
or task diversity is insufficient. This turns the remaining benchmark work into
an empirical comparison rather than a scorecard convention.

Benchmark outcomes now also produce a durable adaptive retest agenda. A failed
comparison is decomposed into reliability, recovery, execution-alignment,
efficiency, search, or coverage interventions, each with a prediction and
acceptance test. The agenda locks task identities, seeds, model, evaluator,
metric direction, and per-arm budget for the next retest; an implementation may
change the harness, but it cannot move the goalposts. This closes the loop
between harness evaluation and harness improvement while preserving the
matched-protocol discipline emphasized by AIRS-Bench and Harness-Bench.

The latest research-agent evaluations also point beyond static leaderboard
scores: dynamic environments test adaptation under changing information, and
research-agent surveys identify claim verification and released execution
artifacts as persistent weaknesses. Evidra therefore treats the adaptive agenda,
raw attempts, checksums, route changes, and independent retests as first-class
benchmark evidence rather than reporting a point score alone.

Final reports now include a deterministic claim-verification matrix. Claims are
classified as `verified`, `provisional`, `literature_only`, `unsupported`, or
`conflicted`; literature-derived claims cannot masquerade as measured results,
and contradiction edges override otherwise positive confidence. A report is
marked publishable only when every included claim has durable non-literature
provenance and no unresolved contradiction.

Phase completion is likewise evidence-gated: promotion now requires both the
leakage/reviewer gates and an accepted validation assessment. A model cannot
advance the campaign by reporting that a candidate is ready without the durable
validation event.

Replication gates are tied to the declared child manifest as well: two
unrelated successful runs cannot satisfy the replication phase. The controller
must observe a successful run for the recorded replication ID.

Data-audit completion follows the same discipline: clean reports pass directly,
while reports containing duplicates, distribution shifts, or warnings require an
explicit recorded acceptance reason before the phase can advance. Acceptance is
bound to a stable fingerprint of the exact findings, so a later audit cannot
inherit approval from an older report.

## Evaluator integrity and specification gaming

DeltaML-Bench reports that ordinary modular ML-agent configurations can exhibit
specification gaming, while its search-based scaffolding avoids it in the
reported configurations. The transferable mechanism is an integrity boundary,
not a prompt warning: the evaluator and its configuration must be immutable
relative to the candidate implementation. Evidra now fingerprints protected
evaluator files before implementation and rejects changed files before running
the candidate. This is complementary to the independent metric verifier and
artifact checks; a valid-looking score is insufficient if the measurement path
was altered.

Source: [DeltaML-Bench](https://arxiv.org/abs/2608.19653).

## General research outcomes

Long-horizon agents need retrieval, not an ever-growing transcript. Evidra's
research memory remains bounded, but when a cycle supplies an objective it now
ranks durable claims and hypotheses by lexical relevance before using recency as
the tie-breaker. This keeps prior leakage findings, failed directions, and
source-derived ideas available without flooding the director context or
silently favoring unrelated recent events. The same bounded relevance retrieval
now ranks cached literature sources supplied to the director.

The decision schema now separates the outcome type from a scalar metric. A
hypothesis may target a proof, artifact, behavior, system property, or another
explicitly described outcome, with `expectedOutcome` carrying the success
criterion. Numeric metric fields remain available and default safely for legacy
competition manifests. This keeps the same researcher/engineer/verifier loop
usable for formal mathematics, scientific computing, and repository
investigations rather than forcing every task into leaderboard terminology.

## Research taste before compute

Research-level benchmarks emphasize that useful agents must make judgment calls
about what question the data can support, how to validate it, and when evidence
is strong enough. Evidra now records a structural hypothesis-quality assessment
before portfolio allocation: mechanism clarity, concrete implementation,
falsification test, evidence attachment, cost validity, implementation risk, and
leakage risk. This is deliberately only a scheduling signal. It cannot promote
a candidate; only evaluator-backed metrics, verification, and replication can
do that. This follows the judgment-heavy framing in [GeneBench-Pro](https://openai.com/index/introducing-genebench-pro/), while keeping Evidra's claims tied to executable evidence.

## Hierarchical rubrics and research-cycle feedback

[PaperBench](https://openai.com/index/paperbench/) evaluates research replication
with hierarchically decomposed, individually gradable tasks rather than a single
impressionistic score. [FrontierScience](https://openai.com/index/frontierscience/)
and [LifeSciBench](https://openai.com/index/introducing-life-sci-bench/) likewise
use expert-grounded criteria for intermediate reasoning, evidence handling, and
operational usefulness. Evidra now applies a deterministic pre-compute rubric to
each director decision: action closure, falsifiability, evidence grounding,
verification contract, formulation diversity, and risk/conflict awareness.
Rubric gaps are durable events and become explicit guidance in the next cycle;
they are never treated as experimental success.

[AARRI-Bench](https://arxiv.org/abs/2606.07462) and recent ideation-diversity
studies reinforce that research agents should be evaluated across a lifecycle,
not only on the final answer. The rubric is therefore attached to the decision
loop while evaluator-backed artifacts, replication, and the competitive scorecard
remain the promotion authority.

## Search-wide statistical discipline

Exploring many hypotheses creates a multiple-comparisons problem: even valid
per-experiment tests will eventually produce a lucky apparent improvement.
Evidra therefore applies a conservative Bonferroni-style family-wise threshold
to promotion evidence using the number of comparable candidates already tested
in the active dataset family. The raw bootstrap probability remains visible,
but a candidate cannot pass promotion merely because it won one uncorrected
comparison. This complements reduced-validation promotion, independent
replication, subgroup checks, and evaluator integrity rather than replacing
them.

The hidden-distribution estimator now reports Fisher-transformed confidence
intervals for split/external-score correlation and ranks splits by a
shrinkage-adjusted lower predictive bound. This makes sparse leaderboard data
useful for prioritization without allowing an extreme correlation from a few
submissions to replace broad validation.

## Newer harness lessons: search depth and automatic evolution

AutoResearchBench separates deep literature retrieval from wide collection and
shows that strong general browsing performance does not imply reliable scientific
search. Evidra should therefore treat literature work as a bounded search
frontier with source coverage, deduplication, and claim-level provenance rather
than one search call followed by a narrative answer. The current source graph
and bounded retrieval are the foundation. The source frontier now reports query
coverage, retrieval coverage, and claim-extraction coverage so the director can
prioritize pending retrieval or weakly grounded sources instead of treating
candidate count as research progress.

The Agentic Harness Engineering work frames harness improvement as an
observability-driven evolution loop: freeze failures, measure them under fixed
budgets, and let later harness versions target the observed failure classes.
Evidra's durable trajectories, capability gaps, critic constraints, and bounded
experience replay now provide that feedback loop without silently treating a
failed rollout as training data or proof.

Evidra now makes the action space explicit as well. Each autonomous cycle
inventories editable source/config components with SHA-256 checksums, maps
observed failure classes to likely intervention components, and persists a
bounded intervention plan with a prediction, falsification condition, and
acceptance rule. A paired outcome can then be classified as confirmed,
partially confirmed, refuted, or unobserved. This is deliberately a planning
and measurement layer: it does not let an agent edit the controller checkout or
declare itself improved without a matched evaluator result.

This also follows the broader harness-substrate framing, which identifies task
state, context selection, tools, memory, observability, failure attribution,
verification, permissions, entropy auditing, and intervention recording as
distinct runtime responsibilities.

Source: [AI Harness Engineering: A Runtime Substrate for Foundation-Model
Software Agents](https://arxiv.org/abs/2605.13357).

Entropy auditing is now part of every recorded execution environment. Evidra
emits a reproducibility fingerprint over stable runtime inputs, records explicit
seed/determinism signals, and reports unpinned CUDA and thread settings as
uncontrolled inputs. These findings are diagnostic rather than a fabricated
guarantee of determinism; repeated runs still need independent validation.

Matched benchmark runs now close the loop operationally: Evidra persists each
scorecard and failure profile, surfaces it in reports, and supplies recent
benchmark feedback to the next research-director cycle. A recurring timeout or
dependency failure is therefore an explicit harness-repair target followed by a
same-protocol remeasurement, not just a lower leaderboard number.

The runtime also treats route quality as potentially non-stationary. Adjacent
provider/model outcome windows are compared only after a complete sample window;
a material drop creates a durable environment-drift event and switches the next
cycle to alternate-route verification, peer review, and replication. This
prevents stale success history from masking provider, model, or execution-host
degradation.

Recent work makes the missing control loop more explicit. [Adaptive Auto-Harness](https://arxiv.org/abs/2606.01770) describes stateful harness evolution with solve-time routing and human-steering hooks; [HarnessDev](https://arxiv.org/abs/2609.01437) studies agents revising their own harnesses from downstream execution feedback; and [Better Harnesses, Smaller Models](https://arxiv.org/abs/2607.08938) maps failure modes to harness adaptations under cost constraints. Evidra now implements the runtime portion of that idea: each cycle derives a bounded policy from trajectory verdicts, failure classes, evidence conflicts, remaining budget, and benchmark intervention priority. The policy can increase tool evidence rounds, require peer review, change recovery posture, preserve replication, or prefer diverse search, and is recorded as durable evidence for later matched evaluation.

This policy is intentionally not allowed to self-award a win. The competitive claim still requires the locked task/model/seed/budget/evaluator protocol and positive task-balanced evidence. The adaptation policy changes the search and verification process; it does not change the yardstick.

Context selection is also a runtime control. Before each director or lane
provider call, Evidra packs the evidence sections under one aggregate character
budget, prioritizes observations and active phase evidence, bounds arrays and
long strings, and records dropped/truncated sections in `contextBudget`. This
prevents long-lived campaigns from turning accumulated memory into uncontrolled
prompt growth while preserving provenance about what the model actually saw.

The same principle now applies below the benchmark layer: recent executor
failure classes are fed directly into the next allocation. An invalid metric or
corrupt artifact prioritizes verifier repair, a missing-data failure prioritizes
the data contract, and resource/provider failures select a recovery route rather
than allowing the director to spend another cycle repeating the same run.

Sources: [AutoResearchBench](https://arxiv.org/abs/2604.25256) and
[Agentic Harness Engineering](https://arxiv.org/abs/2604.25850), [Adaptive Auto-Harness](https://arxiv.org/abs/2606.01770), [HarnessDev](https://arxiv.org/abs/2609.01437), and [Better Harnesses, Smaller Models](https://arxiv.org/abs/2607.08938).
