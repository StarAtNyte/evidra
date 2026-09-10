/** Remove common credentials before command/tool output reaches an agent or audit event. */
export function redactSecrets(value: string): string {
  return value
    .replace(/\b(?:sk|rk|ak)-[A-Za-z0-9_-]{16,}\b/g, "[REDACTED_TOKEN]")
    .replace(/\b(?:ghp|github_pat)_[A-Za-z0-9_]{16,}\b/g, "[REDACTED_TOKEN]")
    .replace(/\b(?:xox[baprs])-[A-Za-z0-9-]{16,}\b/g, "[REDACTED_TOKEN]")
    .replace(/((?:api[_-]?key|token|secret|password|authorization)\s*[:=]\s*)([^\s,;]+)/gi, "$1[REDACTED]");
}

export function isSensitiveWorkspacePath(relativePath: string): boolean {
  const normalized = relativePath.replace(/\\/g, "/");
  return normalized.split("/").some((part) =>
    part === ".env" || part.startsWith(".env.") ||
    /^(?:credentials(?:\..*)?|secrets?(?:\..*)?|id_rsa(?:\..*)?|.*\.(?:pem|key|p12|pfx))$/i.test(part));
}
