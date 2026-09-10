import { basename } from "node:path";

export type AutonomyLevel = "safe" | "fast" | "yolo";

export interface CommandGuard {
  allowed: boolean;
  reason?: string;
}

const blockedCommands = new Set(["sudo", "rm", "rmdir", "mkfs", "shutdown", "reboot", "poweroff", "dd"]);

/** Hard safety boundary applied even when the user selects YOLO. */
export function guardCommand(command: string[]): CommandGuard {
  const executable = basename(command[0] ?? "").toLowerCase();
  const joined = command.join(" ").toLowerCase();
  if (!executable) return { allowed: false, reason: "No command was supplied." };
  // Resolve common command-wrapper forms before applying the hard deny list.
  // This keeps `env rm ...` and `busybox rm ...` from bypassing the boundary.
  if (executable === "env" || executable === "busybox") {
    const nestedIndex = command.findIndex((argument, index) => index > 0 && !argument.startsWith("-"));
    if (nestedIndex > 0) return guardCommand(command.slice(nestedIndex));
  }
  if (blockedCommands.has(executable)) return { allowed: false, reason: `Refusing dangerous command '${executable}'.` };
  if (joined.includes("git reset --hard") || joined.includes("git clean -fd") || joined.includes("git clean -xdf")) {
    return { allowed: false, reason: "Refusing destructive Git cleanup." };
  }
  if (joined.includes("curl ") && /\|\s*(sh|bash|zsh)(\s|$)/.test(joined)) {
    return { allowed: false, reason: "Refusing remote-script execution." };
  }
  if (["sh", "bash", "zsh", "fish", "node", "python", "python3", "perl", "ruby"].includes(executable) && command.includes("-c") && /\b(rm|rmdir|mkfs|shutdown|reboot|poweroff|dd|unlink|remove|writeFile|truncate)\b/i.test(joined)) {
    return { allowed: false, reason: "Refusing destructive code passed through a command wrapper." };
  }
  return { allowed: true };
}

/**
 * Additional boundary for model-requested shell work in SAFE mode. Explicit
 * user `!` commands use guardCommand only because they are user-authorized;
 * autonomous tools must be restricted by executable and arguments.
 */
export function guardReadOnlyInspection(command: string[]): CommandGuard {
  const executable = basename(command[0] ?? "").toLowerCase();
  const readOnly = new Set(["pwd", "ls", "find", "rg", "grep", "head", "tail", "sed", "awk", "wc", "du", "file", "which"]);
  if (executable === "git") {
    const allowed = new Set(["status", "rev-parse", "log", "diff", "show", "ls-files", "branch"]);
    if (!allowed.has(command[1]?.toLowerCase() ?? "")) return { allowed: false, reason: "SAFE mode only permits read-only Git inspection commands." };
    return { allowed: true };
  }
  if (!readOnly.has(executable)) return { allowed: false, reason: `SAFE mode does not permit '${executable}' for autonomous shell work.` };
  const joined = command.join(" ").toLowerCase();
  if (executable === "find" && /(^|\s)-(exec|execdir|delete)(\s|$)/.test(joined)) return { allowed: false, reason: "SAFE mode refuses find actions that can execute or delete files." };
  if (executable === "sed" && command.some((argument) => argument === "-i" || argument.startsWith("-i"))) return { allowed: false, reason: "SAFE mode refuses in-place sed edits." };
  if (executable === "awk" && /\bsystem\s*\(/.test(joined)) return { allowed: false, reason: "SAFE mode refuses awk system calls." };
  return { allowed: true };
}

export function autonomyPolicy(level: AutonomyLevel): {
  canInspect: boolean;
  canRunIsolatedExperiments: boolean;
  canSubmitExternally: false;
} {
  return {
    canInspect: true,
    canRunIsolatedExperiments: level !== "safe",
    canSubmitExternally: false,
  };
}
