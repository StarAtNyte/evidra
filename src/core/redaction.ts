/** Remove common credentials before command/tool output reaches an agent or audit event. */
export function redactSecrets(value: string): string {
  return value
    .replace(/\b(?:sk|rk|ak)-[A-Za-z0-9_-]{16,}\b/g, "[REDACTED_TOKEN]")
    .replace(/\b(?:ghp|github_pat)_[A-Za-z0-9_]{16,}\b/g, "[REDACTED_TOKEN]")
    .replace(/\b(?:xox[baprs])-[A-Za-z0-9-]{16,}\b/g, "[REDACTED_TOKEN]")
    .replace(/((?:api[_-]?key|token|secret|password|authorization)\s*[:=]\s*)([^\s,;]+)/gi, "$1[REDACTED]");
}

const SENSITIVE_COMMAND_FLAG = /^(?:--?|\/)?(?:api[-_]?key|token|secret|password|passwd|authorization|auth|credential)(?:=|$)/i;

/** Redact values passed as separate or inline sensitive command arguments. */
export function redactCommand(command: string[]): string[] {
  let redactNext = false;
  return command.map((part) => {
    if (redactNext) {
      redactNext = false;
      return "[REDACTED_ARGUMENT]";
    }
    if (SENSITIVE_COMMAND_FLAG.test(part)) {
      const equals = part.indexOf("=");
      if (equals >= 0) return `${part.slice(0, equals + 1)}[REDACTED_ARGUMENT]`;
      redactNext = true;
    }
    return redactSecrets(part);
  });
}

export function redactStructured<T>(value: T): T {
  if (typeof value === "string") return redactSecrets(value) as T;
  if (Array.isArray(value)) return value.map((entry) => redactStructured(entry)) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, entry]) => {
      // Command-shaped fields are argv, not ordinary string arrays. Redact
      // separate sensitive arguments such as ["--token", "value"] as well
      // as inline forms, while keeping other structured data intact.
      if (/commands?$/i.test(key) && Array.isArray(entry)) {
        if (entry.every((part) => typeof part === "string")) return [key, redactCommand(entry as string[])];
        if (entry.every((part) => Array.isArray(part) && part.every((item) => typeof item === "string"))) return [key, (entry as string[][]).map((command) => redactCommand(command))];
      }
      return [key, redactStructured(entry)];
    })) as T;
  }
  return value;
}

export function isSensitiveWorkspacePath(relativePath: string): boolean {
  const normalized = relativePath.replace(/\\/g, "/");
  return normalized.split("/").some((part) =>
    part === ".env" || part.startsWith(".env.") ||
    /^(?:credentials(?:\..*)?|secrets?(?:\..*)?|id_rsa(?:\..*)?|.*\.(?:pem|key|p12|pfx))$/i.test(part));
}
