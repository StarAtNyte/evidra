# Execution-first discovery cadence

Reference inspected: SakanaAI/AI-Scientist-v3 commit
2b8aa39285c35aaca3b0e06dd121061ef8a2d854, especially
src/investigation/campaign_loop.py and docs/usage.md.
Upstream separates idea generation from bounded implementation/evaluation attempts
and supports periodic context pruning. This change is an independent implementation
of execution-first guidance; no upstream source code is copied.

Evidra now counts decision audits since the latest recorded evaluator run within
the current campaign. After two such cycles, all research roles receive a directive
to select one bounded falsifiable experiment, specify its comparator, evaluation
budget and rejection criterion, or identify a concrete execution blocker. Recorded
runs reset the pressure even when they fail: a failed execution is information,
not a reason to demand an identical retry. Missing runs are never scored as losses.

The directive does not bypass the critic, data restrictions, acceptance, promotion,
submission, or completion checks. It does not guarantee shorter campaigns; that
requires matched live evaluation. Full event history remains durable. Context pruning
and automatic review skipping are not implemented by this change.

Validation: tests/discovery-cadence.mjs covers the trigger, run reset and irrelevant
history. Campaign-scoped filtering is performed by the existing recordsForCampaign
helper before computing the directive.

## Complete implementation staging

The first live campaign exposed a separate execution bottleneck: a complete
multi-module incumbent required ten pinned files, exceeding the eight-artifact
limit. Provider schema, local validation and staging now share a 64-artifact
limit. Existing SHA-256 checks, workspace confinement, duplicate destination
checks, 64 MiB per-file and 128 MiB aggregate limits remain enforced. The
regression test stages ten files and rejects oversized lists at both validation
and execution boundaries. This fixes capacity, not automatic dependency discovery;
the agent must still declare every required source and runtime asset.

## Verification runtime guidance

The second campaign used bare system Python for local import verification,
while its configured evaluator used an absolute virtualenv interpreter. Both
failed verification attempts lacked anndata in that selected system runtime.
Research roles now receive the exact absolute Python executable declared by the
evaluator, with instructions to verify interpreter/package identity before
inferring a missing dependency. This is guidance, not a command rewrite or
proof of lockfile parity. Non-Python evaluators and bare executable declarations
receive no inferred runtime. Tests cover paths with spaces, Windows paths,
non-Python executables and missing declarations. Live recovery benefit remains
unproven until a new autonomous run succeeds.

## Verification script feasibility

Repeated competition experiments evaluated successfully, then failed because a
Python verifier entrypoint was absent in the isolated worktree. Before executing
the primary command, the controller now checks statically identifiable direct
Python verification scripts. Missing scripts fail the existing feasibility gate
with a staging diagnostic. Inline, module and shell commands are not guessed.
This does not execute verifiers early or relax any acceptance gate. The challenge
adapter explicitly declares its preflight script and pinned control manifest as
support files. A real disposable worktree check stages those support files and
all twelve control artifacts, then runs the preflight with the project interpreter.

## Materialized verification proposals

Automatic portfolio selection excludes a verify-only metric hypothesis that supplies
none of a pinned implementation source, implementation artifacts, an experiment
environment, or verification commands. This also applies to the director-selected
fallback. The controller records `research.portfolio.candidate_deferred` with the
missing execution contract. Modify-mode hypotheses still enter implementation;
explicit source replications and executable verification checks remain eligible.
This is a readiness check, not proof that an environment setting affects its board
or that a candidate improves a matched control.

Recovered trace receipts remain audit evidence, but are no longer automatically
classified as `controller_crash` for allocation. Startup discovery of an older
uncommitted trace does not supply an exception, failed command, or failure time.
Observed run failures and trajectory/tool failures continue to drive recovery.
