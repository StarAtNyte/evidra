import { z } from "zod";
import { cpus, totalmem } from "node:os";
import { ResearchStore } from "../core/store.js";
import type { AgentProvider, ExecAgentOptions } from "./codex-exec.js";
import { isProviderUsageLimit, isRetryableAgentError, resolveLocalFallbackModel, runWithLocalFallback } from "./codex-exec.js";
import type { ProcessControl } from "../core/process.js";
import type { AutonomyLevel } from "../core/permissions.js";

export const RESEARCH_LANE_ROLES = [
  "data detective",
  "validation scientist",
  "model researcher",
] as const;

export type ResearchLaneRole = typeof RESEARCH_LANE_ROLES[number];

export const ResearchLaneReportSchema = z.object({
  role: z.string().min(1),
  summary: z.string().min(1),
  findings: z.array(z.string()).max(12),
  recommendations: z.array(z.string()).max(8),
  uncertainties: z.array(z.string()).max(8),
  evidence: z.array(z.string()).max(12),
  confidence: z.number().min(0).max(1),
});

export type ResearchLaneReport = z.infer<typeof ResearchLaneReportSchema> & {
  status: "completed" | "failed";
  error?: string;
};

export interface ResearchLanesOptions {
  provider: AgentProvider;
  model: string;
  fallbackLocalModel?: string;
  limitPolicy?: ExecAgentOptions["limitPolicy"];
  reasoningEffort?: string;
  cwd: string;
  storePath: string;
  maxParallel?: number;
  autonomy?: AutonomyLevel;
  onProgress?: (message: string) => void;
  onProcess?: (control: ProcessControl) => void;
}

/**
 * Select a conservative lane count from user intent and host/provider
 * capacity. This is deliberately bounded: more agents are not automatically
 * more useful when they contend for one Ollama process or one subscription.
 */
export function researchLaneConcurrency(options: { autonomy?: AutonomyLevel; provider: AgentProvider; requested?: number } ): number {
  const cpuCount = Math.max(1, cpus().length);
  const memoryGiB = totalmem() / (1024 ** 3);
  const autonomy = options.autonomy ?? "safe";
  const hostCeiling = memoryGiB < 8 || cpuCount < 4 ? 1 : memoryGiB < 16 || cpuCount < 8 ? 2 : 4;
  const localCeiling = options.provider === "local" ? Math.max(1, Number.parseInt(process.env.OLLAMA_NUM_PARALLEL ?? "1", 10) || 1) : 6;
  const moodCeiling = autonomy === "safe" ? 1 : autonomy === "fast" ? 2 : 4;
  return Math.max(1, Math.min(options.requested ?? moodCeiling, hostCeiling, localCeiling, moodCeiling));
}

function parseJson(output: unknown): unknown {
  const text = String(output).trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  try { return JSON.parse(text); } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(text.slice(start, end + 1));
    throw new Error("Lane did not return a JSON report.");
  }
}

function lanePrompt(role: ResearchLaneRole, objective: string): string {
  const focus = role === "data detective"
    ? "Inspect data provenance, duplicates, leakage, distributions, hidden groups, and train/test shift."
    : role === "validation scientist"
      ? "Inspect evaluation design, split validity, metric reliability, uncertainty, and replication requirements."
      : "Inspect the implementation and research space, identify promising general methods, and propose falsifiable experiments.";
  return `${focus}\n\nObjective: ${objective}\n\n` +
    "You are an independent Evidra research lane. Use the supplied workspace and evidence context; run only read-only inspection when tools are available. Do not edit files, submit anything, or claim measurements you did not observe. Return ONLY JSON with this shape: " +
    '{"role":"...","summary":"...","findings":["..."],"recommendations":["..."],"uncertainties":["..."],"evidence":["command, artifact, or source supporting each important statement"],"confidence":0.0}. ' +
    "Recommendations must be testable and should state what would falsify them. Treat other lanes as unknown; the director will cross-pollinate reports later.";
}

function saveLaneEvent(storePath: string, role: string, report: ResearchLaneReport): void {
  const store = new ResearchStore(storePath);
  store.appendEvent(report.status === "completed" ? "research.lane.completed" : "research.lane.failed", { role, report });
  if (report.status === "completed") {
    const claimId = `claim_lane_${Date.now()}_${role.replace(/[^a-z0-9]+/gi, "-")}`;
    store.saveClaim({
      id: claimId,
      payload: {
        id: claimId,
        statement: `[${role}] ${report.summary}`,
        scope: "research lane report",
        confidence: report.confidence,
        sourceType: "observation",
        sourceId: `lane_${role}`,
        status: "active",
        findings: report.findings,
        evidence: report.evidence,
      },
    });
  }
  store.close();
}

async function runLane(role: ResearchLaneRole, objective: string, context: Record<string, unknown>, options: ResearchLanesOptions): Promise<ResearchLaneReport> {
  const store = new ResearchStore(options.storePath);
  store.updateAgentLane({ role, status: "running", provider: options.provider, model: options.model, task: objective, error: null });
  store.close();
  options.onProgress?.(`Research lane · ${role} · investigating...`);
  try {
    let provider = options.provider;
    let model = options.model;
    let parsed: z.infer<typeof ResearchLaneReportSchema> | undefined;
    let lastError: unknown;
    for (let attempt = 1; attempt <= 3 && !parsed; attempt += 1) {
      try {
        const result = await runWithLocalFallback({ role, objective: lanePrompt(role, objective), context }, {
          provider,
          model,
          limitPolicy: options.limitPolicy,
          reasoningEffort: options.reasoningEffort,
          cwd: options.cwd,
          sandbox: "read-only",
        }, provider === "codex" ? options.fallbackLocalModel : undefined, options.onProgress, options.onProcess);
        parsed = ResearchLaneReportSchema.parse(parseJson(result.output));
      } catch (error) {
        lastError = error;
        if (!isRetryableAgentError(error) || attempt === 3 || (isProviderUsageLimit(error) && options.limitPolicy === "wait")) throw error;
        if (attempt === 1 && provider === "codex" && options.fallbackLocalModel && options.limitPolicy === "fallback" && !isProviderUsageLimit(error)) {
          model = await resolveLocalFallbackModel(options.fallbackLocalModel);
          provider = "local";
          options.onProgress?.(`Research lane · ${role} · changing route to local/${model}...`);
        } else {
          const delayMs = attempt * 1_000;
          options.onProgress?.(`Research lane · ${role} · retry ${attempt}/2 in ${delayMs / 1000}s...`);
          await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
        }
      }
    }
    if (!parsed) throw lastError instanceof Error ? lastError : new Error("Lane did not produce a validated report.");
    const report: ResearchLaneReport = { ...parsed, role, status: "completed" };
    saveLaneEvent(options.storePath, role, report);
    const completed = new ResearchStore(options.storePath);
    completed.updateAgentLane({ role, status: "idle", provider: options.provider, model: options.model, task: null, error: null });
    completed.close();
    return report;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const report: ResearchLaneReport = { role, summary: "Lane failed before producing a validated report.", findings: [], recommendations: [], uncertainties: [message], evidence: [], confidence: 0, status: "failed", error: message };
    saveLaneEvent(options.storePath, role, report);
    const failed = new ResearchStore(options.storePath);
    failed.updateAgentLane({ role, status: "failed", provider: options.provider, model: options.model, task: objective, error: message });
    failed.close();
    return report;
  }
}

/** Run independent research lanes with an explicit concurrency bound. */
export async function runResearchLanes(objective: string, context: Record<string, unknown>, options: ResearchLanesOptions): Promise<ResearchLaneReport[]> {
  const concurrency = researchLaneConcurrency({ autonomy: options.autonomy, provider: options.provider, requested: options.maxParallel });
  const roles = RESEARCH_LANE_ROLES.slice(0, Math.max(1, Math.min(concurrency, RESEARCH_LANE_ROLES.length)));
  const reports: ResearchLaneReport[] = [];
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < roles.length) {
      const role = roles[next++];
      reports.push(await runLane(role, objective, context, options));
    }
  };
  await Promise.all(Array.from({ length: Math.min(roles.length, concurrency) }, () => worker()));
  return roles.map((role) => reports.find((report) => report.role === role)!).filter(Boolean);
}
