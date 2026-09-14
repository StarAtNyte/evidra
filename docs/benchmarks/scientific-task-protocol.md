# Stepwise scientific-task protocol

## Suite execution

`benchmark scientific-suite` is serial by default because most contracts use a
shared project workspace. Pass `--parallel N` only when contracts declare
pairwise-disjoint stage `cwd` roots. The runner checks those roots before
starting work: shared or nested roots are automatically serialized, while
independent tasks run concurrently. Each completed task is still checkpointed
atomically, so a crash or interruption cannot turn partial output into a valid
task result.

Evidra can evaluate research agents on intermediate, verifiable progress instead
of judging only a final response. A task is a JSON object with ordered stages;
each stage has a command, required artifacts, verification commands, and files
to snapshot. A stage is valid only when its command, every declared verifier,
and every required artifact succeed.

```json
{
  "id": "replicate-result",
  "title": "Replicate a published result",
  "description": "Reproduce the result and record an independently checked artifact.",
  "stages": [
    {
      "id": "prepare",
      "title": "Prepare data",
      "objective": "Create the locked input manifest.",
      "command": ["python", "prepare.py"],
      "requiredArtifacts": ["inputs.json"],
      "verificationCommands": [["python", "verify_inputs.py"]],
      "snapshotPaths": ["inputs.json"],
      "timeoutMinutes": 10,
      "retries": 1,
      "alternateCommands": [["python", "prepare_fallback.py"]]
    }
  ]
}
```

Run it with:

```bash
evidra benchmark scientific task.json --workspace ./task --out run.json
# Later: reuse verified stages from the saved report
evidra benchmark scientific task.json --workspace ./task --resume run.json --out run-2.json
```

The report contains per-stage exit status, verifier counts, artifact checksums,
snapshot IDs, bounded logs, stage completion, and process quality. Verified
stages from a prior report can be supplied to the library runner as a resume
record; Evidra rechecks their snapshot identity before skipping them. This
makes asynchronous or crash-recovered agents measurable while keeping the task
contract independent of Codex, a particular model, or an ML leaderboard.

For a task-balanced suite, run:

```bash
evidra benchmark scientific-suite ./contracts --workspace ./task --checkpoint-dir ./suite-state --resume-dir ./suite-state --out suite.json
```

The runner writes one report immediately after each completed task. A later
invocation reuses only that task's verified stages, so a controller crash does
not discard completed work or turn the suite into a single opaque score.

The CLI also records a compact `scientific.task.completed` event containing the
same stage statuses, verifier counts, artifact checksums, snapshot IDs, and
route attempts. Full logs remain in the optional report file, while scheduling
and recovery logic can learn from durable evidence without replaying the entire
transcript.

Each stage gets a bounded retry budget. After the primary command fails, declared
alternate commands are attempted in order; if no alternate is available, the
primary route is retried. Every attempt is retained in the report, and a stage
cannot pass unless its final command, verifiers, artifacts, and snapshot all
pass. Stage and verifier commands also pass through Evidra's autonomous safety
guard, so submissions, direct uploads/downloads, dependency installation, and
destructive commands are recorded as permission failures rather than executed.
