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
 * Additional hard boundary for model-requested shell work in any autonomy
 * mode. External state changes must go through Evidra's approval-gated
 * submission and controller paths, never through an arbitrary shell command.
 */
export function guardAutonomousCommand(command: string[]): CommandGuard {
  const base = guardCommand(command);
  if (!base.allowed) return base;
  const executable = basename(command[0] ?? "").toLowerCase();
  const joined = command.join(" ").toLowerCase();
  if (/\bgit\s+push\b/.test(joined) || /\bgh\s+(pr|issue)\s+(create|edit)\b/.test(joined)) {
    return { allowed: false, reason: "Refusing autonomous external GitHub or repository changes; use an explicit operator command." };
  }
  if ((executable === "kaggle" || executable === "aicrowd" || executable === "whest") && /\b(submit|upload|publish|push)\b/.test(joined)) {
    return { allowed: false, reason: "Refusing autonomous competition submission or upload; use the approval-gated submission workflow." };
  }
  if (["npm", "pnpm", "yarn", "pip", "pip3", "uv", "conda", "apt", "apt-get", "brew"].includes(executable) && /\b(install|add|sync|update|upgrade)\b/.test(joined)) {
    return { allowed: false, reason: "Refusing autonomous dependency installation; approve it explicitly or bake dependencies into the experiment image." };
  }
  if ((executable === "curl" || executable === "wget") && !/(^|\s)(-I|--head|--spider|--method\s+head)(\s|$)/.test(joined)) {
    return { allowed: false, reason: "Refusing autonomous direct downloads; use the bounded source/data acquisition workflow." };
  }
  if ((executable === "curl" || executable === "wget") && /(--data(?:-raw|-binary)?|--upload-file|\s-[xt]\s*post\b|\s--method\s+post\b)/.test(joined)) {
    return { allowed: false, reason: "Refusing autonomous HTTP upload or POST; use an approval-gated adapter." };
  }
  if (executable === "modal" && /\b(deploy|serve|run)\b/.test(joined)) {
    return { allowed: false, reason: "Refusing autonomous Modal deployment or job launch; use the configured executor boundary." };
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
