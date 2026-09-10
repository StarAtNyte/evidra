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

## Current implementation gaps

The next high-value upgrades are:

1. run equal-budget AIRS-Bench and Harness-Bench-compatible arms across Evidra,
   AIRA-dojo, MLGym, and comparable harnesses;
2. report paired confidence intervals and task-balanced scores over repeated seeds;
3. add formal-verification adapters for non-ML research artifacts;
4. run equal-budget comparisons of greedy, UCB, evolutionary, and MCTS policies
   under the same task and compute budgets.

Source adaptation is now implemented: `evidra sources adapt <source-id> [objective]`
passes bounded claims and excerpts from a cached source to the director, while
persisting resulting claims as low-confidence literature evidence and linking them
to the source with `derived_from` edges. This keeps paper-derived ideas useful for
search without confusing them with measurements from the active workspace. The
remaining work is to benchmark which adaptation prompts and verification gates
produce the highest rate of successfully replicated ideas.

The early-promotion item is now implemented conservatively: after eight paired
reduced/full outcomes, Evidra learns a threshold from successful full runs;
before that, and whenever evidence is one-sided, it uses the manifest's static
threshold. The learned rule is recorded with each promotion decision and is
never allowed to lower the configured minimum.

The search-policy item is also partially implemented: `greedy`, `ucb_portfolio`,
`evolutionary`, and `mcts` are explicit bounded operators. They share the same
experiment manifests and reward ledger; the remaining work is a controlled
benchmark, not an assumption that a named policy is automatically better.

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
