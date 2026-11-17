# Architecture-aware exploration

Evidra previously assigned greater novelty to hypotheses without evidence and
always placed the director's preferred candidate first. The existing plateau
directive could request a different method while execution still favored another
local refinement.

Hypotheses may now declare `architectureChange`, with baseline and proposed
representation, prediction mechanism, learning objective and generalization
assumption. Missing designs have unknown novelty, not a bonus for missing
citations. The comparison normalizes formatting and scalar values. These are
self-reported design contrasts, not a semantic novelty detector or proof of an
implemented architecture.

When the existing comparable-run progress assessment requests a pivot, the
portfolio reserves its first slot for one feasible candidate differing on at least
two declared axes. Remaining slots use ordinary preference/ranking. With no such
candidate, selection falls back normally and records the missing exploration
choice. Budget, readiness, critic, execution, validation, promotion and submission
checks remain in place. Partial screens and missing metrics do not independently
trigger the full-evaluation plateau detector.

The director's task contract asks for competing models and a discriminating
prediction. Project-specific initial prompts remain in versioned project files;
the actual loader must expose them without truncation. Earlier transcripts are
never rewritten. A live design cycle can test whether the agent produces useful
alternatives, but cannot establish improved research efficiency or task scores.

The implementation independently adapts the separation of investigation,
ablations and final evaluation described by
[AI Scientist v3](https://github.com/SakanaAI/AI-Scientist-v3), and the emphasis on
contrastive probes and evidence-supported retained lessons in
[Harness2](https://github.com/google-research/harness2). No upstream source is copied.

Validation: TypeScript build; 749 core tests; 19 focused tests including architecture
contrasts, plateau allocation, scalar/label changes, budget constraints, nullable
provider schema, prior portfolio behavior and discovery cadence. Discovery gains
still require a matched live comparison.

## First live design cycle

The first cycle repeatedly requested whole-source prefixes that the context budget
truncated; a caller wrapper also advertised tools it denied. That cycle ended on
provider quota, not a scientific outcome. Tool selection now deduplicates builtin
names and supports a task-specific capability list used by both advertising and
dispatch. A mock-provider integration test verifies a disallowed request never
reaches the executor. Four boundary tests and all749 core tests pass after this
repair. The second bounded cycle returned two complete model proposals and selected
a developmental state-transition programme. Proposals remain unimplemented until
measurement assumptions, solver identifiability and sample-splitting contracts are
audited, and neither a proposal nor a successful harness test is a scientific gain.

Python test discovery correction (2026-10-21): the Trial69 implementation's structural guard rejected source growth despite nine executed local checks, because `tools/test_t1_state.py` was classified as production source. `snapshotCodeHealth` now recognizes Python's standard `test_*.py` basename outside a dedicated tests directory. Dedicated regressions cover root/nested discovery, near-name exclusions, deletion failure, and continued failure on substantial source growth with no tests. This changes structural accounting only; execution and semantic coverage remain separate evidence. The original rejection is retained. Reassessment of its original before/after file set reports +3167 source lines, +190 test lines, no deletion/TODO growth, and pass. Independently checked 47 immutable input hashes plus the evaluator and vendor tree; this does not establish model efficacy.

The supervisor stopped an early copied Trial69 revision before its GPU task started. The final engineer revision also isolates abundance annotation-association feature selection from public reference expression. Subsequent evaluation must use the final pinned revision and exact source68 control, retain the administrative stop, and aggregate GPU time across controls, confirmations, and actual inference.
