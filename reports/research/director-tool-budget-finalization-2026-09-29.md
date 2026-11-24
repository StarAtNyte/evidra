# Research director tool-budget finalization

**Observed:** 2026-09-29 UTC  
**Scope:** Current dirty Evidra checkout; focused controller behavior, not a production release certification.

## Failure addressed

When a director used its full `maxToolRounds` and requested another tool, the controller immediately returned a generic `inspect` decision. That discarded the opportunity to synthesize already-collected observations and often deferred an actionable decision to another campaign cycle.

## Change

After the configured tool-round limit, `runResearchDirector` now grants exactly one provider turn with `availableTools: []` and a finalization-only instruction. Existing observations and steering remain in context. If the provider asks for tools again, Evidra returns a conservative active `inspect` result without executing them. The configured tool-round cap is unchanged; the extra turn cannot execute tools.

## Verification

- `npm test`: **645 passed, 0 failed**.
- Regression fixture where one tool executes, a second is denied by the cap, and the finalizer proposes a next step based on retained evidence.
- Adversarial fixture where the finalizer requests another tool; verifies zero execution, one exhaustion event, and an active conservative result.
- `npm run check`: passed.
- `git diff --check`: passed.

## Remaining validation

This is a focused regression check, not an independent hosted-CI result or a full campaign reliability certification. The two long-running campaigns were started before this change; they have been asked to pause at safe boundaries so they can resume from durable checkpoints on the updated controller.
