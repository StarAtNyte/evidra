export type AutonomyLevel = "safe" | "fast" | "yolo";

export interface CommandGuard {
  allowed: boolean;
  reason?: string;
}

const blockedCommands = new Set(["sudo", "rm", "rmdir", "mkfs", "shutdown", "reboot", "poweroff", "dd"]);

/** Hard safety boundary applied even when the user selects YOLO. */
export function guardCommand(command: string[]): CommandGuard {
  const executable = command[0]?.toLowerCase() ?? "";
  const joined = command.join(" ").toLowerCase();
  if (!executable) return { allowed: false, reason: "No command was supplied." };
  if (blockedCommands.has(executable)) return { allowed: false, reason: `Refusing dangerous command '${executable}'.` };
  if (joined.includes("git reset --hard") || joined.includes("git clean -fd") || joined.includes("git clean -xdf")) {
    return { allowed: false, reason: "Refusing destructive Git cleanup." };
  }
  if (joined.includes("curl ") && /\|\s*(sh|bash|zsh)(\s|$)/.test(joined)) {
    return { allowed: false, reason: "Refusing remote-script execution." };
  }
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
