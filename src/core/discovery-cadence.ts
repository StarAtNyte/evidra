/** Execution-first discovery cadence, inspired by AI-Scientist-v3's bounded
 * idea/attempt loop. Independently implemented; never changes acceptance gates.
 */
export function discoveryCadence(events: readonly { type: string; createdAt: string }[], runs: readonly { createdAt: string }[]) {
  const decisions = events.filter(e => e.type === "research.decision.audit").sort((a,b) => a.createdAt.localeCompare(b.createdAt));
  const latestRun = runs.reduce((latest, r) => r.createdAt > latest ? r.createdAt : latest, "");
  const idleCycles = decisions.filter(e => e.createdAt > latestRun).length;
  return { idleCycles, guidance: idleCycles >= 2
    ? `\n\nDISCOVERY CADENCE: ${idleCycles} decision cycles have elapsed without a recorded evaluator run. Choose one new, bounded, falsifiable experiment using the strongest available incumbent and measured failure memory. Specify the comparator, evaluation budget, and rejection criterion. If execution is unsafe or unavailable, name the concrete blocker and smallest check that resolves it. Do not repeat literature or provenance reviews without new evidence. Critic vetoes, leakage restrictions, evidence requirements, promotion and submission gates remain binding. A missing run is not a measured failure.`
    : "" };
}

/** Expose the adapter's declared Python runtime without rewriting agent commands. */
export function verificationRuntimeGuidance(evaluatorCommand: readonly string[]): string {
  const executable = evaluatorCommand[0] ?? "";
  if (!/^(?:[A-Za-z]:[\\/]|\/)/.test(executable) || !/^(?:python|python3)(?:\.\d+)*(?:\.exe)?$/i.test(executable.split(/[\\/]/).at(-1) ?? "")) return "";
  return `\n\nVERIFICATION RUNTIME: The configured evaluator declares ${JSON.stringify(executable)} as its Python executable. For local Python import/preflight checks that require the evaluator's packages, use this exact interpreter in the verification argv, or explicitly verify a different runtime before using it. Bare python/python3 may select a system interpreter with different dependencies. An isolated Git worktree does not inherit an untracked virtualenv. Inspect sys.executable and installed package versions using the selected interpreter; do not infer a missing project dependency from an import attempted with another interpreter. A successful import proves only that import check, not lockfile parity, output reproduction, evaluator equivalence, or score improvement. Keep alternate language and intentionally independent verifier commands explicit. Do not run a paid evaluator to diagnose interpreter selection.`;
}

/** A verify-only metric proposal needs an explicit subject or executable check.
 * A prose follow-up with none of these otherwise silently evaluates inherited code.
 */
export function incompleteVerificationProposal(hypothesis: {
  outcomeType?: string; implementationMode?: string;
  implementationSource?: unknown; implementationArtifacts?: readonly unknown[];
  experimentEnvironment?: readonly unknown[]; verificationCommands?: readonly unknown[];
}): string | undefined {
  if (hypothesis.outcomeType !== "metric" || hypothesis.implementationMode !== "verify") return undefined;
  if (hypothesis.implementationSource || hypothesis.implementationArtifacts?.length
    || hypothesis.experimentEnvironment?.length || hypothesis.verificationCommands?.length) return undefined;
  return "Verification-only metric proposal declares no pinned source, implementation artifacts, experiment environment, or verification commands. Materialize the intended test before portfolio execution; inherited code is not evidence for the proposed mechanism.";
}
