# WhestBench run-failure triage — 2026-10-10

## Finding

There are no recent WhestBench evaluator failures requiring an alternate-runner
replay. The durable event database contains 26 `run.failed` events; the latest
is `2026-10-01T09:50:03.574Z` (event 136129). There are zero `run.failed`
events after that timestamp. Do not describe the October 10 provider failures
as failed estimator runs.

## Classified historical evaluator failure

The latest evaluator failure was a four-MLP exploratory
`uence-conditioned-moment-closure` worktree run, not the current V29 comparator
or a new candidate:

- Run: `exp_1790847912462_uence-conditioned-moment-closure-1790848203437`
- Date: 2026-10-01
- Command: `uv run python evaluate_batched.py --estimator estimator.py --dataset .whest-data --split mini --limit 4`
- Evaluator: WhestBench 0.16.1, subprocess runner, 2 threads
- Result: 2 of 4 MLPs raised in `predict`; run exit code 1; metric ineligible
- Durable failure class: `memory_exhausted`
- Stdout explicitly says two MLPs raised and recommends `--debug` for
  tracebacks; the aggregate score is invalid and must not be used.

This is an old, rejected exploratory estimator failure with an explicit
resource classification. Replaying it with a different runner is not necessary
to select a new target-free method and would not establish the current
candidate's reliability.

## Distinct provider/quota failures

On October 10, recent `queue.failed` / `research.lane.failed` events report
`Codex usage limit reached. Retrying in 15 minute(s).` for validation and
reproducibility agents. These are provider-capacity failures before the agent
produces a report; they have no estimator command, candidate hash, evaluator
row, or WhestBench result. Evidra subsequently resumed the campaign with Codex.
They must be classified as provider exhaustion, not runner isolation or
competition-model failure.

## Decision

Close the alternate-runner replay objection for current experiment selection.
Keep the classified historical `memory_exhausted` run as negative evidence for
that old model only. The active search can proceed using the locked validation
policy and the separately verified target-clean V29 comparator; every new
candidate still needs its own candidate/control identity checks, zero-failure
paired run, and promotion gates.

## Reproduction queries

```sql
SELECT MAX(created_at), COUNT(*) FROM events WHERE type = 'run.failed';
SELECT id, created_at, payload_json FROM events
WHERE type = 'run.failed' ORDER BY id DESC LIMIT 1;
SELECT id, created_at, type, payload_json FROM events
WHERE type IN ('queue.failed', 'research.lane.failed')
  AND created_at >= '2026-10-10T09:00:00'
ORDER BY id DESC;
```

Related artifact:
`.sota/artifacts/exp_1790847912462_uence-conditioned-moment-closure-1790848203437/metrics.json`.
