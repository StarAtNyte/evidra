# Harness competitiveness protocol

Evidra's default objective is to beat the incumbent under the same task, model,
time, and compute budget. Compatibility with another harness is not a win.

The comparison protocol uses the same task arm for every harness and records:

- valid-run rate: a candidate must have a durable evaluator run and finite metric;
- improvement rate: the candidate must beat that arm's baseline in the declared direction;
- mean metric delta and median time to first valid evidence (captured from the
  evaluator stream when a finite declared metric appears, with total runtime as
  a backward-compatible fallback);
- time efficiency: the fraction of the declared wall-clock budget remaining
  after a valid evaluator outcome;
- recovery rate after a failed tool, worker, or provider route;
- reproducibility rate across an independent seed or replication;
- process quality and execution-alignment rates when trajectory evidence is available;
- a bounded competitive score that weights improvement most heavily, then valid
  evidence, reproducibility, and recovery.

Scores are aggregated by task before ranking harnesses, so repeated trials on one
easy task cannot outweigh failures on other tasks. The scorecard also reports a
deterministic bootstrap `competitiveScoreLower95` over task means; benchmark
claims should use that conservative bound when comparing close systems.

The same protocol is available from the CLI:

```bash
evidra benchmark run protocol.json --out benchmark-run.json
# use an external checkout, such as an AIRS-Bench repository:
evidra benchmark run airs-protocol.json --workspace /path/to/airs-bench
# optionally select one incumbent; otherwise Evidra is compared with every other arm
evidra benchmark run protocol.json --challenger evidra --incumbent incumbent
evidra benchmark validate trials.json
evidra benchmark score trials.json
evidra benchmark score trials.json --json
evidra benchmark compare trials.json evidra incumbent
evidra benchmark export --out evidra-trials.json
```

`benchmark validate` is the required preflight for a competitive claim. Each
trial must declare a task arm, seed, model, reasoning effort, and budget; every harness must be
present on every matched arm, with the same metric direction and baseline
metric. Historical trial
exports can still be scored for diagnostics, but incomplete or mismatched files
are explicitly marked rather than treated as evidence that Evidra won.

`benchmark run` accepts `{ "arms": [...] }` with one command per harness arm. By
default it treats `evidra` as the challenger and compares it against every other
harness present in the matched protocol. The command exits non-zero unless every
comparison passes the conservative win gate. This makes competitiveness the
default behavior of the executable harness path, while still refusing to call a
single-task, incomplete, invalid, or unreplicated result a win. Use
`--challenger` and `--incumbent` for explicit labels.
Every generated benchmark report also includes a `protocolFingerprint`. It is a
SHA-256 identity over the fairness-critical task, arm, seed, model, reasoning
effort, budget, data/runtime revision, direction, baseline, bounds, and metric
fields. Harness-specific commands are deliberately excluded, so different
implementations can share one contract while later reports can still prove
that the comparison protocol was unchanged.
Each arm declares the same protocol metadata plus a bounded command, working
directory, metric name, and baseline. Evidra executes the commands with their
declared time budgets, parses the declared metric, and writes raw process
evidence—including bounded, redacted stdout/stderr and metric data for every
attempt—alongside the scorecards. The runner does not claim reproducibility;
independent repeats must be declared as separate matched arms.

An arm may optionally declare `policy` (for example `greedy`, `ucb_portfolio`,
`evolutionary`, or `mcts`). The label is copied into the durable trial without
changing harness identity or fairness keys, allowing policy comparisons to be
reported explicitly while retaining the same task/seed/model/reasoning-effort/budget gates.
When at least two policy labels are present, `benchmark run` also emits policy
scorecards and all pairwise policy comparisons using the same conservative
task-balanced gates.

Parallel arms are serialized automatically when their resolved working
directories overlap. Parallel execution is retained only for genuinely
separate workspaces, preventing concurrent harnesses from contaminating one
another through shared files, caches, or generated artifacts.

Trials may also declare `dataRevision` and `runtimeFingerprint`. When either is
present, every harness on the matched arm must agree; a hidden dataset or
runtime mismatch invalidates the protocol instead of becoming a silent source
of advantage. `benchmark export` carries the experiment dataset revision and,
when available, the checksummed environment fingerprint into these fields.

An arm may declare `retries` from 0 to 3. Retries share the arm's total time
budget, and a later successful attempt is recorded as `recovered: true`; total
elapsed time includes failed attempts. An arm may additionally declare up to
three `alternateCommands`. After same-route retries are exhausted, Evidra tries
each alternate route at most once within the same budget. Every attempt records
its route and exact command, so recovery is measurable and cannot silently
become an unbounded blind retry.

An arm may also declare `reproducibilityCommand` and an optional
`reproducibilityTolerance`. The command receives the remaining arm budget and
must independently emit the same metric within tolerance; only then does the
runner set `reproducible: true`. Without that explicit check, reproducibility
remains unclaimed.

`benchmark compare` is the claim gate. It pairs the challenger and incumbent on
the exact task, arm, seed, model, and budget, drops invalid evaluator outcomes,
aggregates paired deltas by task, and computes a deterministic bootstrap lower
95% bound. A win is reported only with at least two tasks, positive lower bound,
at least 80% valid paired coverage, no material paired process-quality
regression, and no material time-efficiency regression when budget metadata is
available. Otherwise the result is
explicitly `NOT PROVEN`; a higher point score alone is not sufficient.

The input is either a JSON array or `{ "trials": [...] }`, with one record per
fixed task/seed arm and fields for baseline, candidate metric, validity,
duration, recovery, and reproducibility.

Trials may also include a sorted `componentIds` array. When every challenger
trial declares the same manifest, `benchmark run` emits layered component
ablations: each variant must remove exactly one component from the full
challenger manifest, and its result is evaluated with the same paired protocol
and win gates. This attributes a measured change to a harness component
without replacing the main competitive comparison.

Benchmark reports also emit `componentFailureEvidence`: per-component sample
counts, failure rates, failure classes, and failure lift relative to the suite.
This is an observability signal for selecting the next ablation or repair; it is
explicitly correlational and cannot establish causality without matched removal
or addition evidence.

For suites with task-level reference bounds, a trial may also declare
`taskWorstMetric` and `taskBestMetric`. Evidra then uses the bounded normalized
outcome when scoring instead of treating every positive delta as equally good;
this makes results across heterogeneous tasks more meaningful. If bounds are
absent, the legacy evaluator-backed improvement rule is retained. Bounds are
part of the matched task arm: validation rejects files where harnesses disagree
or provide non-finite/equal bounds. Duplicate trials for the same harness and
task/arm/seed/model/budget identity are also rejected rather than silently
overwriting one another.

Invalid runs and unverified model claims score zero improvement. This prevents a
harness from winning by producing persuasive text without a measured artifact.
Valid runs also receive a bounded time-efficiency contribution when their trial
declares a budget. This rewards faster valid progress without inventing provider
tokens, dollar prices, or GPU billing rates; missing cost metadata remains
visible as unavailable rather than silently estimated.
When optional trajectory fields are present, process quality and alignment also
affect the competitive score; older trial files remain readable and fall back to
their evaluator-backed fields.

Failed benchmark attempts are also classified from bounded process output using
the same failure vocabulary as experiment recovery (`cuda_oom`, `timeout`,
`dependency`, `data_missing`, `auth`, `rate_limit`, `disk`, `invalid_metric`,
and `unknown`). Attempt details retain the classification, while each harness
scorecard exposes a `failureProfile` counter. This makes benchmark results useful
for harness evolution: a lower score is not just a loss, but a concrete route to
repair and retest.

## Initial AIRS-Bench trial

On the official AIRS-Bench SICK Accuracy task, Evidra reproduced the majority
baseline at `0.5686913983`. Its first fully durable train-only candidate run
scored `0.5260905014`, a valid regression of `-0.0426008969`. The result is
retained as failure evidence; it is not presented as a win.

AIRS-Bench publishes comparable results for One-Shot, Greedy, MLGym, and
AIRA-dojo arms. Evidra should be entered as another arm with the same model,
seed count, task files, and budget before making a leaderboard claim.

## What Evidra must beat

The competitive target is not only final task score. Existing research-agent
harnesses demonstrate useful capabilities that Evidra must match and improve:

- AIRA-dojo: scalable parallel solver runs, search policies, isolated execution,
  and large-run analysis;
- MLGym: standardized research environments, multiple agents, configurable
  budgets, and trajectory inspection;
- AIRS-Bench's published harness arms: a common task suite and public score
  comparison.

Evidra's intended advantage is the closed evidence loop: durable hypotheses,
typed tools, isolated mutations, evaluator-backed metrics, failure-aware route
changes, replication gates, and resumable campaigns. Those features count only
when they improve the equal-budget scorecard.

References: [AIRS-Bench](https://github.com/facebookresearch/airs-bench),
[AIRA-dojo](https://github.com/facebookresearch/aira-dojo), and
[MLGym](https://github.com/facebookresearch/MLGym).
