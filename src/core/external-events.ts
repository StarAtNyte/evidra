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
