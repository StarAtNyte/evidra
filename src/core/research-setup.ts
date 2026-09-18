export type ResearchSetupStep = "goal" | "budget" | "stop";
export type ResearchSetupInputAction = "cancel" | "repeat" | "answer";

/** Keep command input from being consumed as an answer during guided setup. */
export function classifyResearchSetupInput(step: ResearchSetupStep, input: string): ResearchSetupInputAction {
  const value = input.trim();
  if (value === "/cancel") return "cancel";
  if (value.startsWith("/")) return "repeat";
  // Referencing the step here makes the contract explicit for callers and
  // prevents future setup questions from silently sharing command semantics.
  void step;
  return "answer";
}
