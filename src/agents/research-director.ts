import { ResearchDecisionSchema, type AgentResult, type ResearchDecision, type AgentTask } from "../core/types.js";
import { isProviderUsageLimit, isRetryableAgentError, runWithLocalFallback, type AgentProvider } from "./codex-exec.js";
import type { ProcessControl } from "../core/process.js";
import { RESEARCH_TOOLS, type ResearchToolCall, type ResearchToolResult } from "../core/tools.js";

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
  timeoutMs?: number;
  cwd: string;
  fallbackLocalModel?: string;
  limitPolicy?: "wait" | "fallback" | "stop";
  onProcess?: (control: ProcessControl) => void;
  onThread?: (threadId: string) => void;
  executeTool?: (call: ResearchToolCall) => Promise<ResearchToolResult>;
  onToolCall?: (source: string, call: ResearchToolCall) => string;
  onToolResult?: (source: string, callId: string, result: ResearchToolResult) => void;
  maxToolRounds?: number;
  maxToolAttempts?: number;
}

function isRetryableResearchToolFailure(result: ResearchToolResult): boolean {
  const text = result.error ?? "";
  return /network|unreachable|timed out|timeout|temporarily|connection|econnreset|ePIPE|rate limit|quota|429|502|503|504|worker|busy|try again/i.test(text);
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
  const maxToolRounds = Math.max(0, Math.min(options.maxToolRounds ?? 6, 8));
  const maxToolAttempts = Math.max(1, Math.min(options.maxToolAttempts ?? 3, 3));
  const contract = `Return ONLY valid JSON matching this exact shape:
{
  "phase": "orientation|baseline|data_audit|validation|hypothesis|implementation|evaluation|replication|promotion",
  "goalStatus": "active|blocked|met",
  "decision": "inspect|propose|run|replicate|stop",
  "bottleneck": "the current limiting factor",
  "rationale": "evidence-based reasoning",
  "hypotheses": [{
    "title": "short name",
    "formulationFamily": "representation|data|validation|objective|model|inference|ensemble|repair|other",
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
  "searchOperator": "greedy|ucb_portfolio|ablation|combination|replication|audit",
  "nextAction": "the next deterministic action",
  "toolCalls": [{"name": "workspace.files", "arguments": {}}]
}

Rules: propose no more than five hypotheses; assign each a distinct formulationFamily when possible; never invent measurements; distinguish observations from assumptions; prioritize information gain per compute-hour; every hypothesis must be falsifiable. Before returning JSON, inspect the workspace and run the relevant read-only commands, tests, audits, or baseline evaluator needed to answer the objective. Treat command output and retrieved research sources as observations and cite the command, source URL, or artifact in evidence. Separate literature claims from evidence measured in this workspace. Prefer the host-observation object supplied in context when your own sandbox cannot execute; never claim that a repository or evaluator is missing when the supplied observation proves it exists. Research agents must not edit challenge files or submit externally. When evidence supports an experiment, choose decision run and a concrete selectedHypothesis: the Evidra controller, not this research turn, will create the durable experiment, apply the change in an isolated worktree, and run the declared evaluator under the selected permission policy. Never claim that controller execution happened unless the context contains an Evidra experiment/run record. If the ultimate stopping condition is not yet evidenced, keep goalStatus active even when an internal phase is met; use decision stop only when the campaign-level condition is satisfied. If tools are available, request them with toolCalls instead of pretending to have inspected the workspace. Request only the smallest useful set and use returned toolResults as observations. Return an empty toolCalls array when you have enough evidence.`;
  let workingContext: Record<string, unknown> = {
    ...context,
    availableTools: options.executeTool ? RESEARCH_TOOLS : [],
  };
  for (let round = 0; round <= maxToolRounds; round += 1) {
    let parsed: ReturnType<typeof ResearchDecisionSchema.safeParse> | undefined;
    let lastError: unknown;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        const result: AgentResult = await runWithLocalFallback({
          ...task,
          context: workingContext,
          objective: `${objective}\n\n${contract}`,
        }, options, options.fallbackLocalModel, onProgress, options.onProcess);
        parsed = ResearchDecisionSchema.safeParse(extractJson(result.output));
        if (parsed.success) break;
        throw new Error(`Research director returned invalid decision: ${parsed.error.issues.map((issue) => issue.path.join(".") + " " + issue.message).join("; ")}`);
      } catch (error) {
        lastError = error;
        if (!isRetryableAgentError(error) || attempt === 3 || (isProviderUsageLimit(error) && options.limitPolicy === "wait")) throw error;
        const delayMs = attempt * 1_000;
        onProgress?.(`Director retry ${attempt}/2 in ${delayMs / 1000}s...`);
        await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
      }
    }
    if (!parsed || !parsed.success) throw lastError instanceof Error ? lastError : new Error("Research director did not return a valid decision.");
    const decision = parsed.data;
    if (!decision.toolCalls.length || !options.executeTool) return { ...decision, toolCalls: [] };
    if (round === maxToolRounds) throw new Error(`Research director exceeded the ${maxToolRounds}-round tool limit.`);
    const results: ResearchToolResult[] = [];
    for (const call of decision.toolCalls) {
      onProgress?.(`Research tool · ${call.name}`);
      const callId = options.onToolCall?.("director", call) ?? `director-${call.name}-${results.length + 1}`;
      let result: ResearchToolResult | undefined;
      for (let attempt = 1; attempt <= maxToolAttempts; attempt += 1) {
        try {
          result = await options.executeTool(call);
        } catch (error) {
          result = {
            name: call.name,
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          };
        }
        if (result.ok || !isRetryableResearchToolFailure(result) || attempt === maxToolAttempts) break;
        const delayMs = attempt * 500;
        onProgress?.(`Tool ${call.name} failed transiently; retrying ${attempt}/${maxToolAttempts - 1} in ${delayMs}ms...`);
        await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
      }
      if (!result) throw new Error(`Research tool ${call.name} returned no result.`);
      options.onToolResult?.("director", callId, result);
      if (!result.ok) onProgress?.(`Tool ${call.name} failed; the director will replan from this evidence.`);
      results.push(result);
    }
    workingContext = {
      ...workingContext,
      toolResults: [
        ...((workingContext.toolResults as ResearchToolResult[] | undefined) ?? []),
        ...results,
      ],
      lastDecision: { ...decision, toolCalls: [] },
      toolInstruction: "Use the tool results above. Request another tool only if it is necessary; otherwise return the final decision with toolCalls: [].",
    };
  }
  throw new Error("Research director stopped without a final decision.");
}

export function formatResearchDecision(decision: ResearchDecision): string {
  const hypotheses = decision.hypotheses.length
    ? decision.hypotheses.map((hypothesis, index) => `${index + 1}. ${hypothesis.title}\n   Mechanism: ${hypothesis.mechanism}\n   Test: ${hypothesis.falsificationTest}\n   Expected delta: ${hypothesis.expectedMetricDelta.low} / ${hypothesis.expectedMetricDelta.median} / ${hypothesis.expectedMetricDelta.high}\n   Cost: ${hypothesis.computeCostGpuHours} GPU-hours · Risk: ${hypothesis.implementationRisk} · Leakage: ${hypothesis.leakageRisk}`).join("\n")
    : "No hypotheses proposed.";
  return `Phase: ${decision.phase} · Goal: ${decision.goalStatus}\nDecision: ${decision.decision}\nBottleneck: ${decision.bottleneck}\n\n${decision.rationale}\n\nHypotheses:\n${hypotheses}\n\nNext action: ${decision.nextAction}`;
}
