/** Transport byte limits are memory bounds, not model token estimates. */
export const LOCAL_REQUEST_MAX_BYTES = 1024 * 1024;
export const LOCAL_RESPONSE_MAX_BYTES = 4 * 1024 * 1024;
export const LOCAL_ERROR_MAX_BYTES = 16 * 1024;

/** Count decoded stream bytes, including when Content-Length is absent or compressed. */
export async function boundedLocalResponseText(response: Response, limit = LOCAL_RESPONSE_MAX_BYTES): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let complete = false;
  try {
    const declared = response.headers.get("content-length");
    if (declared && /^\d+$/.test(declared) && Number(declared) > limit) throw new Error(`Local Ollama response exceeds the ${limit}-byte limit.`);
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) { complete = true; break; }
      bytes += chunk.value.byteLength;
      if (bytes > limit) throw new Error(`Local Ollama response exceeds the ${limit}-byte limit.`);
      chunks.push(chunk.value);
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, bytes));
  } finally {
    if (!complete) { try { await reader.cancel(); } catch { /* Preserve the original failure. */ } }
    reader.releaseLock();
  }
}
