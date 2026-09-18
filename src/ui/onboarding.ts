/** Setup controls remain usable, but unfinished setup cannot dispatch work. */
export function requiresProviderSetup(complete: boolean, request: string): boolean {
  if (complete) return false;
  const command = request.trim().split(/\s+/, 1)[0];
  return !new Set(["/login", "/logout", "/provider", "/fallback", "/limits", "/help", "/exit", "/quit", "/doctor", "/status", "/usage"]).has(command ?? "");
}
