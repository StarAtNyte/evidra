import { closeSync, existsSync, fstatSync, openSync, readSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { sha256File } from "./evidence.js";
import { MAX_TRACE_BYTES, parsePersistedTrace } from "./trajectories.js";
import type { ResearchStore } from "./store.js";

/** Register crash-surviving traces exactly once for either controller surface. */
export function recoverUncommittedTraceFiles(root: string, store: ResearchStore, maxFiles = 100): number {
  const recoveredTrajectoryPaths = new Set(store.trajectories().flatMap((entry) => {
    const payload = entry.payload && typeof entry.payload === "object" ? entry.payload as { tracePath?: unknown } : {};
    return typeof payload.tracePath === "string" ? [payload.tracePath] : [];
  }));
  const recoveredTraceEvents = new Set(store.eventsByType("research.trace.recovered").flatMap((event) => {
    const payload = event.payload && typeof event.payload === "object" ? event.payload as { path?: unknown; checksum?: unknown } : {};
    return typeof payload.path === "string" && typeof payload.checksum === "string" ? [`${payload.path}:${payload.checksum}`] : [];
  }));
  const traceDirectory = join(root, ".sota", "traces");
  if (!existsSync(traceDirectory)) return 0;
  let recovered = 0;
  for (const name of readdirSync(traceDirectory).filter((entry) => entry.endsWith(".jsonl")).slice(-Math.max(1, Math.min(maxFiles, 500)))) {
    const absolute = join(traceDirectory, name);
    try {
      const path = relative(root, absolute);
      const checksum = sha256File(absolute);
      if (recoveredTrajectoryPaths.has(path) || recoveredTraceEvents.has(`${path}:${checksum}`)) continue;
      const descriptor = openSync(absolute, "r");
      let text: string;
      try {
        const size = fstatSync(descriptor).size;
        const length = Math.min(size, MAX_TRACE_BYTES);
        const buffer = Buffer.alloc(length);
        const bytesRead = readSync(descriptor, buffer, 0, length, 0);
        text = buffer.subarray(0, bytesRead).toString("utf8");
      } finally {
        closeSync(descriptor);
      }
      const parsed = parsePersistedTrace(text);
      if (!parsed.events.length) continue;
      const activityTail = parsed.events.filter((event) => typeof event.payload.activity === "string").slice(-8).map((event) => String(event.payload.activity).slice(0, 240));
      const toolNames = [...new Set(parsed.events.filter((event) => typeof event.payload.tool === "string").map((event) => String(event.payload.tool)).slice(-16))];
      store.appendEvent("research.trace.recovered", { path, checksum, eventCount: parsed.events.length, invalidLines: parsed.invalidLines, truncated: parsed.truncated, firstEvent: parsed.events[0]?.id, lastEvent: parsed.events.at(-1)?.id, ...(activityTail.length ? { activityTail } : {}), ...(toolNames.length ? { toolNames } : {}), reason: "uncommitted cycle trace found during controller startup" });
      recovered += 1;
    } catch { /* A corrupt or unavailable trace must not block controller startup. */ }
  }
  return recovered;
}
