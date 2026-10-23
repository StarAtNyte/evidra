# Harness2 techniques for Evidra

Reviewed upstream https://github.com/google-research/harness2 at commit `1cfe254e8d25b15f37048c3730134686abe60335` on 2026-10-19. Upstream is Apache-2.0. This review and the associated TypeScript changes are independent implementations; no upstream source was copied.

## Applicable mechanisms

- Task-level Propose–Probe–Compose: compare actual executions of edited harnesses on the same task before composing another harness. Evidra already has checksummed component inventories, intervention contracts, benchmark comparison and retest tasks. Proposal count alone is not progress.
- Persistent experience: upstream retains the adopted harness tree and an evidence-supported cue/lesson. Evidra already retains experiment manifests, artifacts and campaign lessons. Memory should point back to exact run IDs and source checksums so a future agent can inspect the complete record rather than trusting a summary.
- Contrastive attribution: upstream `harness2/core/prompts.py::experience` asks for each edit's execution difference, including rejected candidates, and warns that adoption alone does not establish an edit's contribution. Multiple simultaneous edits and a single rollout are confounded. Unsupported lessons can be omitted.

## Implemented now

`campaign-lessons.ts` now preserves recent losing and failed variants alongside winners, with exact run IDs and available primary source references from their experiment manifests. Failed runs do not become scientific score losses, even if their partial metrics contain a large value. A failed-only campaign still retains useful execution evidence. Component maxima are labelled as candidates for a fresh combination experiment, rather than implying that their effects compose automatically.

The CLI supplies source references and run IDs. `tests/contrastive-lessons.mjs` checks failure-only histories, rejection/selection bias and the combination boundary. The existing integration test verifies that campaign lessons still reach subsequent project guidance.

## Remaining differences and boundaries

This is not the full Harness2 recursion scheduler. It does not autonomously combine code patches, spawn a new agent team, or replace Evidra's controller. Exact source references support inspection, not causal attribution. A biological proxy improvement is not an official leaderboard improvement, and harness benchmark performance is not biological task evidence.

Next valuable evaluation: compare the current and contrastive-memory harnesses on identical bounded discovery tasks, with the same model, evaluator, budget and seeds, measuring valid executed experiments, repeated failure rate and final task performance. Until that comparison exists, improved discovery efficiency remains unproven.
