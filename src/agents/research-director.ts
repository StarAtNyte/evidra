import { ResearchDecisionSchema, type AgentResult, type ResearchDecision, type AgentTask } from "../core/types.js";
import { runWithLocalFallback, type AgentProvider } from "./codex-exec.js";
import type { ProcessControl } from "../core/process.js";

function extractJson(output: unknown): unknown {
  const text = String(output).trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  try { return JSON.parse(text); } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(text.slice(start, end + 1));
    throw new Error("Research director did not return JSON.");
  }
}

export interface ResearchDirectorOptions {
  provider: AgentProvider;
  model: string;
  reasoningEffort?: string;
  cwd: string;
  fallbackLocalModel?: string;
  onProcess?: (control: ProcessControl) => void;
}

export async function runResearchDirector(
  objective: string,
  context: Record<string, unknown>,
  options: ResearchDirectorOptions,
  onProgress?: (message: string) => void,
): Promise<ResearchDecision> {
  const task: AgentTask = {
    role: "research director",
    objective,
    context,
  };
  const contract = `Return ONLY valid JSON matching this exact shape:
{
  "phase": "orientation|baseline|data_audit|validation|hypothesis|implementation|evaluation|replication|promotion",
  "goalStatus": "active|blocked|met",
  "decision": "inspect|propose|run|replicate|stop",
  "bottleneck": "the current limiting factor",
  "rationale": "evidence-based reasoning",
  "hypotheses": [{
    "title": "short name",
    "mechanism": "why it should work",
    "evidence": ["observed evidence or explicitly empty"],
    "proposedChange": "one concrete code or experiment change",
    "falsificationTest": "what result would disprove it",
    "expectedMetricDelta": {"low": 0, "median": 0, "high": 0},
    "computeCostGpuHours": 0,
    "implementationRisk": "low|medium|high",
    "leakageRisk": "low|medium|high",
    "dependencies": ["baseline or experiment ids"]
  }],
  "selectedHypothesis": "hypothesis title or null",
  "nextAction": "the next deterministic action"
}

Rules: propose no more than five hypotheses; never invent measurements; distinguish observations from assumptions; prioritize information gain per compute-hour; every hypothesis must be falsifiable. Before returning JSON, inspect the workspace and run the relevant read-only commands, tests, audits, or baseline evaluator needed to answer the objective. Treat command output and retrieved research sources as observations and cite the command, source URL, or artifact in evidence. Separate literature claims from evidence measured in this workspace. Prefer the host-observation object supplied in context when your own sandbox cannot execute; never claim that a repository or evaluator is missing when the supplied observation proves it exists. Do not edit challenge files, submit externally, or fabricate a result. If the ultimate stopping condition is not yet evidenced, keep goalStatus active even when an internal phase is met; use decision stop only when the campaign-level condition is satisfied.`;
  const result: AgentResult = await runWithLocalFallback({ ...task, objective: `${objective}\n\n${contract}` }, options, options.fallbackLocalModel, onProgress, options.onProcess);
  const parsed = ResearchDecisionSchema.safeParse(extractJson(result.output));
  if (!parsed.success) throw new Error(`Research director returned invalid decision: ${parsed.error.issues.map((issue) => issue.path.join(".") + " " + issue.message).join("; ")}`);
  return parsed.data;
}

export function formatResearchDecision(decision: ResearchDecision): string {
  const hypotheses = decision.hypotheses.length
    ? decision.hypotheses.map((hypothesis, index) => `${index + 1}. ${hypothesis.title}\n   Mechanism: ${hypothesis.mechanism}\n   Test: ${hypothesis.falsificationTest}\n   Expected delta: ${hypothesis.expectedMetricDelta.low} / ${hypothesis.expectedMetricDelta.median} / ${hypothesis.expectedMetricDelta.high}\n   Cost: ${hypothesis.computeCostGpuHours} GPU-hours · Risk: ${hypothesis.implementationRisk} · Leakage: ${hypothesis.leakageRisk}`).join("\n")
    : "No hypotheses proposed.";
  return `Phase: ${decision.phase} · Goal: ${decision.goalStatus}\nDecision: ${decision.decision}\nBottleneck: ${decision.bottleneck}\n\n${decision.rationale}\n\nHypotheses:\n${hypotheses}\n\nNext action: ${decision.nextAction}`;
}
