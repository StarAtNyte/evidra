/** Extract a unified diff from a local engineer response without trusting prose. */
export function extractUnifiedDiff(output: string): string | undefined {
  const fenced = output.match(/```(?:diff|patch)?\s*\n([\s\S]*?)```/i)?.[1]?.trim();
  const text = fenced || output.trim();
  const start = text.indexOf("diff --git ");
  if (start >= 0) return text.slice(start).trim();
  const header = text.search(/^--- (?:a\/|\/dev\/null)/m);
  if (header >= 0 && /^\+\+\+ /m.test(text.slice(header))) return text.slice(header).trim();
  return undefined;
}
