/**
 * Validate events arriving from CI, webhooks, cron, or another controller.
 * External events are wake-up signals only: they are deliberately kept in a
 * separate namespace so they cannot satisfy research phase gates or masquerade
 * as observations.
 */
const EXTERNAL_EVENT_TYPE = /^external\.[a-z0-9][a-z0-9._-]{0,119}$/;
const MAX_EXTERNAL_PAYLOAD_BYTES = 32_000;

export function validateExternalEventType(value: string): string {
  const eventType = value.trim();
  if (!EXTERNAL_EVENT_TYPE.test(eventType)) {
    throw new Error("External event types must match external.<source>.<event>, for example external.github.push.");
  }
  return eventType;
}

export function parseExternalEventPayload(raw?: string): Record<string, unknown> {
  if (!raw?.trim()) return {};
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch (error) { throw new Error(`External event payload must be valid JSON: ${error instanceof Error ? error.message : String(error)}`); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("External event payload must be a JSON object.");
  if (Buffer.byteLength(JSON.stringify(parsed), "utf8") > MAX_EXTERNAL_PAYLOAD_BYTES) throw new Error(`External event payload must be at most ${MAX_EXTERNAL_PAYLOAD_BYTES} bytes.`);
  return parsed as Record<string, unknown>;
}

export function externalEventPayload(payload: Record<string, unknown>, source = "cli"): Record<string, unknown> {
  return { source, receivedAt: new Date().toISOString(), payload };
}

export interface ExternalAgentHeartbeat {
  role: string;
  leaseId: string;
  provider: string;
  model: string;
  status: "running" | "idle" | "blocked" | "failed";
  task?: string | null;
  budgetSeconds?: number | null;
}

/** Validate the narrow external-agent health contract before touching leases. */
export function parseExternalAgentHeartbeat(payload: Record<string, unknown>): ExternalAgentHeartbeat {
  const role = typeof payload.role === "string" ? payload.role.trim() : "";
  const leaseId = typeof payload.leaseId === "string" ? payload.leaseId.trim() : "";
  const provider = typeof payload.provider === "string" ? payload.provider.trim() : "";
  const model = typeof payload.model === "string" ? payload.model.trim() : "";
  const status = payload.status;
  if (!role || role.length > 120) throw new Error("External agent heartbeat requires a role of 1–120 characters.");
  if (!leaseId || leaseId.length > 200) throw new Error("External agent heartbeat requires a leaseId of 1–200 characters.");
  if (!provider || provider.length > 120 || !model || model.length > 200) throw new Error("External agent heartbeat requires provider and model.");
  if (!(typeof status === "string" && ["running", "idle", "blocked", "failed"].includes(status))) throw new Error("External agent heartbeat status must be running, idle, blocked, or failed.");
  if (payload.task !== undefined && payload.task !== null && (typeof payload.task !== "string" || payload.task.length > 2_000)) throw new Error("External agent heartbeat task must be at most 2,000 characters.");
  if (payload.budgetSeconds !== undefined && payload.budgetSeconds !== null && (typeof payload.budgetSeconds !== "number" || !Number.isFinite(payload.budgetSeconds) || payload.budgetSeconds <= 0)) throw new Error("External agent heartbeat budgetSeconds must be positive.");
  return { role, leaseId, provider, model, status: status as ExternalAgentHeartbeat["status"], task: typeof payload.task === "string" ? payload.task : null, budgetSeconds: typeof payload.budgetSeconds === "number" ? payload.budgetSeconds : null };
}
