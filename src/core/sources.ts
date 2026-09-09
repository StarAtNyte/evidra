import { createHash } from "node:crypto";
import { ResearchSourceSchema, type ResearchSource } from "./types.js";

export interface RetrievedSource extends ResearchSource {
  contentType: string;
  text: string;
  excerpt: string;
}

const MAX_BYTES = 2 * 1024 * 1024;

function sourceId(url: string, contentHash: string): string {
  return `src_${createHash("sha256").update(`${url}\n${contentHash}`).digest("hex").slice(0, 20)}`;
}

function stripMarkup(input: string): string {
  return input
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&#x27;|&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, " ")
    .trim();
}

export async function retrieveSource(url: string, signal?: AbortSignal): Promise<RetrievedSource> {
  const parsed = new URL(url);
  if (!/^https?:$/.test(parsed.protocol)) throw new Error("Only http and https research sources are supported.");
  const response = await fetch(parsed, { redirect: "follow", signal, headers: { "user-agent": "Evidra/0.1 research-workbench" } });
  if (!response.ok) throw new Error(`Source retrieval failed (${response.status} ${response.statusText}).`);
  const contentType = response.headers.get("content-type") ?? "application/octet-stream";
  const length = Number(response.headers.get("content-length") ?? 0);
  if (length > MAX_BYTES) throw new Error(`Source is larger than the ${MAX_BYTES} byte retrieval limit.`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_BYTES) throw new Error(`Source is larger than the ${MAX_BYTES} byte retrieval limit.`);
  const contentHash = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  const raw = new TextDecoder().decode(bytes);
  const text = contentType.includes("html") ? stripMarkup(raw) : raw.replace(/\s+/g, " ").trim();
  const titleMatch = raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = stripMarkup(titleMatch?.[1] ?? parsed.hostname ?? url).slice(0, 300) || url;
  const source = ResearchSourceSchema.parse({
    id: sourceId(url, contentHash),
    title,
    url: response.url || url,
    retrievedAt: new Date().toISOString(),
    contentHash,
    license: response.headers.get("x-license") ?? undefined,
    claims: [],
  });
  return { ...source, contentType, text, excerpt: text.slice(0, 1200) };
}

export function sourceClaims(text: string, limit = 12): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length >= 50 && sentence.length <= 500)
    .filter((sentence) => /\b(show|find|improv|decreas|increas|result|method|dataset|model|validation|leak|error|accuracy|score)\b/i.test(sentence))
    .slice(0, limit);
}

export function sourceSearchText(source: { payload: unknown }): string {
  const payload = source.payload as { title?: string; url?: string; excerpt?: string; text?: string; claims?: string[] };
  return [payload.title, payload.url, payload.excerpt, payload.text, ...(payload.claims ?? [])].filter(Boolean).join(" ").toLowerCase();
}
