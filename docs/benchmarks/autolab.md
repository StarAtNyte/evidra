# AutoLab integration

[AutoLab](https://github.com/autolabhq/autolab) is a useful external target for
Evidra because it evaluates persistent optimization across system, CUDA, model,
and puzzle tasks rather than one-shot answers. Its public task contracts declare
the objective metric, direction, baseline/reference anchors, resource limits,
and timeouts.

Evidra can inspect those contracts without installing Harbor or executing a
benchmark task:

```bash
git clone https://github.com/autolabhq/autolab.git
evidra benchmark autolab discover ./autolab --out autolab-inventory.json
```

The normalized inventory contains one record per `tasks/*` directory. A task is
valid only when its `task.toml` and `instruction.md` exist, its optimization
metric and direction are understood, and its baseline score is declared. The
adapter preserves reference scores as task metadata; it does not treat the
reference implementation as an Evidra result.

The inventory is a protocol boundary, not an automatic leaderboard submission.
AutoLab runs through Harbor and may require CPU-specific, L40S, or H100
resources. A fair comparison still needs matched harness arms, the same model,
reasoning effort, task revision, time budget, and evaluator. Harbor output must
be translated into Evidra trial records before `benchmark compare` can make a
claim. Discovery of the current public checkout produced 36 valid task
contracts; that is contract-validation evidence, not solving evidence.

This integration is intentionally general: the normalized contract can describe
any lower-is-better or higher-is-better metric and records resources without
assuming that the task is an ML competition.
