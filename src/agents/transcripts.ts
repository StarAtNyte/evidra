import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { redactSecrets } from "../core/redaction.js";

/** Full, append-only record of one provider turn: the exact prompt, every raw
 * provider event (tool calls, tool results, messages) and the outcome.
 * Competitions that audit autonomous runs need the trajectory and prompts
 * verbatim, which the bounded research traces deliberately do not keep. */
export interface TranscriptWriter {
  event(value: unknown): void;
  end(outcome: { ok: true; output: unknown } | { ok: false; error: string }): void;
  readonly path: string;
}

/** Writes nothing unless EVIDRA_TRANSCRIPT_DIR is set; the CLI sets it beside controller state. */
export function openTranscript(meta: { role: string; provider: string; model: string; cwd: string; sandbox?: string; prompt: string }): TranscriptWriter | undefined {
  const root = process.env.EVIDRA_TRANSCRIPT_DIR?.trim();
  if (!root) return undefined;
  const now = new Date();
  const day = now.toISOString().slice(0, 10);
  const directory = join(root, day);
  const slug = (value: string): string => value.replace(/[^a-zA-Z0-9_.-]+/g, "-").slice(0, 60);
  const path = join(directory, `${now.toISOString().replace(/[:.]/g, "-")}-${slug(meta.role)}-${slug(meta.provider)}-${process.pid}.jsonl`);
  let broken = false;
  const write = (record: Record<string, unknown>): void => {
    if (broken) return;
    try {
      appendFileSync(path, `${redactSecrets(JSON.stringify({ ts: new Date().toISOString(), ...record }))}\n`, { mode: 0o600 });
    } catch {
      broken = true; // evidence capture must never take down the research turn itself
    }
  };
  try { mkdirSync(directory, { recursive: true, mode: 0o700 }); } catch { broken = true; }
  write({ type: "turn.start", ...meta });
  return {
    path,
    event: (value) => write({ type: "provider.event", event: value }),
    end: (outcome) => write({ type: "turn.end", ...outcome }),
  };
}
