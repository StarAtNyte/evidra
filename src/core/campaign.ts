import { createHash } from "node:crypto";

export interface CampaignTimeState {
  startedAt: string;
  status: string;
  pausedAt?: string;
  pausedDurationMinutes?: number;
}

/**
 * The execution settings that must travel with a durable campaign.  Keeping
 * these beside the campaign state means a resumed controller does not
 * silently switch provider, executor, or safety policy because the terminal
 * that launched it is different.
 */
export interface CampaignRuntimeConfig {
  mode: "research" | "challenge";
  provider: "codex" | "local";
  model: string;
  thinking: string;
  lanes: number;
  autonomy: "safe" | "fast" | "yolo";
  limitPolicy: "auto" | "wait" | "fallback" | "stop";
  executor: "local" | "container" | "modal";
}

/** Stable integrity binding for the safety-relevant campaign route. */
export function campaignRuntimeFingerprint(runtime: CampaignRuntimeConfig): string {
  const canonical = JSON.stringify({
    mode: runtime.mode,
    provider: runtime.provider,
    model: runtime.model,
    thinking: runtime.thinking,
    lanes: runtime.lanes,
    autonomy: runtime.autonomy,
    limitPolicy: runtime.limitPolicy,
    executor: runtime.executor,
  });
  return createHash("sha256").update(canonical).digest("hex");
}

export function readCampaignRuntime(value: unknown): CampaignRuntimeConfig | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const runtime = (value as { runtime?: unknown }).runtime;
  if (!runtime || typeof runtime !== "object" || Array.isArray(runtime)) return undefined;
  const candidate = runtime as Record<string, unknown>;
  if (!(["research", "challenge"] as const).includes(candidate.mode as "research" | "challenge")) return undefined;
  if (!( ["codex", "local"] as const).includes(candidate.provider as "codex" | "local")) return undefined;
  if (typeof candidate.model !== "string" || !candidate.model) return undefined;
  if (typeof candidate.thinking !== "string" || !candidate.thinking) return undefined;
  if (typeof candidate.lanes !== "number" || !Number.isInteger(candidate.lanes) || candidate.lanes < 1 || candidate.lanes > 6) return undefined;
  if (!( ["safe", "fast", "yolo"] as const).includes(candidate.autonomy as "safe" | "fast" | "yolo")) return undefined;
  if (!( ["auto", "wait", "fallback", "stop"] as const).includes(candidate.limitPolicy as "auto" | "wait" | "fallback" | "stop")) return undefined;
  if (!( ["local", "container", "modal"] as const).includes(candidate.executor as "local" | "container" | "modal")) return undefined;
  return {
    mode: candidate.mode as CampaignRuntimeConfig["mode"],
    provider: candidate.provider as CampaignRuntimeConfig["provider"],
    model: candidate.model,
    thinking: candidate.thinking,
    lanes: candidate.lanes,
    autonomy: candidate.autonomy as CampaignRuntimeConfig["autonomy"],
    limitPolicy: candidate.limitPolicy as CampaignRuntimeConfig["limitPolicy"],
    executor: candidate.executor as CampaignRuntimeConfig["executor"],
  };
}

/** Wall-clock campaign usage excluding durable paused intervals. */
export function campaignElapsedMinutes(campaign: CampaignTimeState, now = Date.now()): number {
  const started = Date.parse(campaign.startedAt);
  if (!Number.isFinite(started)) return 0;
  const accumulatedPause = Math.max(0, campaign.pausedDurationMinutes ?? 0) * 60_000;
  const activePause = campaign.status === "paused" && campaign.pausedAt
    ? Math.max(0, now - Date.parse(campaign.pausedAt))
    : 0;
  return Math.max(0, (now - started - accumulatedPause - activePause) / 60_000);
}

/** Remaining wall-clock budget for a durable campaign, excluding paused time. */
export function campaignRemainingMs(campaign: CampaignTimeState & { budgetMinutes: number }, now = Date.now()): number {
  if (!Number.isFinite(campaign.budgetMinutes) || campaign.budgetMinutes < 0) return 0;
  return Math.max(0, (campaign.budgetMinutes - campaignElapsedMinutes(campaign, now)) * 60_000);
}

export function pauseCampaign<T extends CampaignTimeState>(campaign: T, now = new Date().toISOString()): T {
  if (campaign.status === "paused") return campaign;
  return { ...campaign, status: "paused", pausedAt: now };
}

export function resumeCampaign<T extends CampaignTimeState>(campaign: T, now = new Date().toISOString()): T {
  if (campaign.status !== "paused" || !campaign.pausedAt) return { ...campaign, status: "running" };
  const pausedMs = Math.max(0, Date.parse(now) - Date.parse(campaign.pausedAt));
  return {
    ...campaign,
    status: "running",
    pausedDurationMinutes: (campaign.pausedDurationMinutes ?? 0) + pausedMs / 60_000,
    pausedAt: undefined,
  };
}
