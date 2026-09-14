# Stepwise scientific-task protocol

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
      "timeoutMinutes": 10
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
