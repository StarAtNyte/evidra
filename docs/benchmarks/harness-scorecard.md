# Harness competitiveness protocol

Evidra's default objective is to beat the incumbent under the same task, model,
time, and compute budget. Compatibility with another harness is not a win.

The comparison protocol uses the same task arm for every harness and records:

- valid-run rate: a candidate must have a durable evaluator run and finite metric;
- improvement rate: the candidate must beat that arm's baseline in the declared direction;
- mean metric delta and median time to first valid evidence;
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
evidra benchmark validate trials.json
evidra benchmark score trials.json
evidra benchmark score trials.json --json
evidra benchmark compare trials.json evidra incumbent
evidra benchmark export --out evidra-trials.json
```

`benchmark validate` is the required preflight for a competitive claim. Each
trial must declare a task arm, seed, model, and budget; every harness must be
present on every matched arm, with the same metric direction. Historical trial
exports can still be scored for diagnostics, but incomplete or mismatched files
are explicitly marked rather than treated as evidence that Evidra won.

`benchmark run` accepts `{ "arms": [...] }` with one command per harness arm.
Each arm declares the same protocol metadata plus a bounded command, working
directory, metric name, and baseline. Evidra executes the commands with their
declared time budgets, parses the declared metric, and writes raw process
evidence alongside the scorecards. The runner does not claim reproducibility;
independent repeats must be declared as separate matched arms.

`benchmark compare` is the claim gate. It pairs the challenger and incumbent on
the exact task, arm, seed, model, and budget, drops invalid evaluator outcomes,
aggregates paired deltas by task, and computes a deterministic bootstrap lower
95% bound. A win is reported only with at least two tasks, positive lower bound,
and at least 80% valid paired coverage. Otherwise the result is explicitly
`NOT PROVEN`; a higher point score alone is not sufficient.

The input is either a JSON array or `{ "trials": [...] }`, with one record per
fixed task/seed arm and fields for baseline, candidate metric, validity,
duration, recovery, and reproducibility.

Invalid runs and unverified model claims score zero improvement. This prevents a
harness from winning by producing persuasive text without a measured artifact.
When optional trajectory fields are present, process quality and alignment also
affect the competitive score; older trial files remain readable and fall back to
their evaluator-backed fields.

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
