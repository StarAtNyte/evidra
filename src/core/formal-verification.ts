export type VerifierKind = "generic" | "lean" | "coq" | "isabelle" | "dafny" | "smt" | "agda";
export type VerifierEvidence = "passed" | "failed" | "passed_without_semantic_marker";

export interface FormalVerificationResult {
  kind: VerifierKind;
  evidence: VerifierEvidence;
  semanticMarker?: string;
  summary: string;
}

const executable = (command: string[]): string => {
  const candidate = command.find((part) => !part.startsWith("-")) ?? "";
  return candidate.split(/[\\/]/).pop()?.toLowerCase() ?? "";
};

/** Identify common proof-checking and constraint-solving command surfaces. */
export function verifierKind(command: string[]): VerifierKind {
  const name = executable(command);
  if (name === "lean" || name === "lake" || name.endsWith(".lean")) return "lean";
  if (["coqc", "coqtop", "rocq", "rocqtop"].includes(name) || name.endsWith(".v")) return "coq";
  if (name === "isabelle") return "isabelle";
  if (name === "dafny") return "dafny";
  if (["z3", "cvc4", "cvc5", "verit", "yices", "boolector"].includes(name)) return "smt";
  if (name === "agda" || name.endsWith(".agda")) return "agda";
  return "generic";
}

/**
 * Convert a verifier process into auditable evidence. Exit status is the hard
 * result; semantic markers make successful proof/solver output distinguishable
 * from a command that merely returned zero without explaining its result.
 */
export function classifyVerifier(command: string[], exitCode: number, stdout: string, stderr: string): FormalVerificationResult {
  const kind = verifierKind(command);
  if (exitCode !== 0) return { kind, evidence: "failed", summary: `${kind} verifier exited with ${exitCode}` };
  const output = `${stdout}\n${stderr}`;
  const marker = kind === "smt"
    ? output.match(/\b(unsat|sat|unknown|valid|invalid)\b/i)?.[1]
    : output.match(/\b(proved|theorem|no goals|verified|success|finished)\b/i)?.[1];
  if (kind === "generic") return { kind, evidence: "passed", summary: "generic verifier exited successfully" };
  if (marker) return { kind, evidence: "passed", semanticMarker: marker.toLowerCase(), summary: `${kind} verifier passed with semantic marker '${marker.toLowerCase()}'` };
  return { kind, evidence: "passed_without_semantic_marker", summary: `${kind} verifier exited successfully without a recognized semantic marker` };
}
