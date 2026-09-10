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

## Current implementation gaps

The next high-value upgrades are:

1. connect `rankSearchArms` to campaign allocation and persist arm rewards;
2. add explicit formulation families and cross-lane synthesis records;
3. add task adapters for formal verification and non-ML research artifacts;
4. run equal-budget AIRS-Bench arms across Evidra, AIRA-dojo, and MLGym;
5. report confidence intervals over repeated seeds instead of single-run wins.
