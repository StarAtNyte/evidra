import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { existsSync, realpathSync } from "node:fs";
import { isSensitiveWorkspacePath } from "./redaction.js";

export type AutonomyLevel = "safe" | "fast" | "yolo";

export interface CommandGuard {
  allowed: boolean;
  reason?: string;
}

const blockedCommands = new Set(["sudo", "rm", "rmdir", "mkfs", "shutdown", "reboot", "poweroff", "dd"]);

/** Resolve transparent launcher wrappers before applying autonomous guards. */
function unwrapCommand(command: string[]): string[] {
  let current = [...command];
  for (let depth = 0; depth < 4; depth += 1) {
    const executable = basename(current[0] ?? "").toLowerCase();
    if (executable === "env") {
      let index = 1;
      while (index < current.length) {
        const argument = current[index] ?? "";
        if (argument === "-i" || argument === "--ignore-environment") { index += 1; continue; }
        if (argument === "-u" || argument === "--unset") { index += 2; continue; }
        if (argument.startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=/.test(argument)) { index += 1; continue; }
        break;
      }
      current = current.slice(index);
      continue;
    }
    if (executable === "busybox" || executable === "command" || executable === "exec" || executable === "nohup" || executable === "nice" || executable === "stdbuf") {
      const index = current.findIndex((argument, position) => position > 0 && !argument.startsWith("-"));
      if (index > 0) { current = current.slice(index); continue; }
    }
    if (executable === "timeout") {
      const index = current.findIndex((argument, position) => position > 0 && !argument.startsWith("-") && !/^\d/.test(argument));
      if (index > 0) { current = current.slice(index); continue; }
    }
    break;
  }
  return current;
}

/** Hard safety boundary applied even when the user selects YOLO. */
export function guardCommand(command: string[]): CommandGuard {
  const normalized = unwrapCommand(command);
  const executable = basename(normalized[0] ?? "").toLowerCase();
  const joined = command.join(" ").toLowerCase();
  if (!executable) return { allowed: false, reason: "No command was supplied." };
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
function autonomousGitSubcommand(command: string[]): string | undefined {
  const valued = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--config-env", "--super-prefix"]);
  const flags = new Set(["--no-pager", "--paginate", "-p", "-P", "--bare", "--no-optional-locks", "--no-replace-objects", "--literal-pathspecs", "--glob-pathspecs", "--noglob-pathspecs", "--icase-pathspecs", "--version", "-v", "--help", "-h"]);
  for (let index = 1; index < command.length; index += 1) {
    const argument = command[index];
    if (!argument.startsWith("-")) return argument.toLowerCase();
    if (["--version", "-v", "--help", "-h"].includes(argument)) return argument;
    if (valued.has(argument)) { if (!command[index + 1]) return undefined; index += 1; continue; }
    if ([...valued].some((option) => argument.startsWith(`${option}=`)) || /^-[Cc].+/.test(argument)) continue;
    if (!flags.has(argument)) return undefined;
  }
  return undefined;
}

export function guardAutonomousCommand(command: string[]): CommandGuard {
  const base = guardCommand(command);
  if (!base.allowed) return base;
  const normalized = unwrapCommand(command);
  const executable = basename(normalized[0] ?? "").toLowerCase();
  const joined = command.join(" ").toLowerCase();
  const gitSubcommand = executable === "git" ? autonomousGitSubcommand(normalized) : undefined;
  if (executable === "git" && gitSubcommand === undefined) return { allowed: false, reason: "Refusing autonomous Git commands with unrecognized global options or no subcommand." };
  if (gitSubcommand === "push" || /\bgit\s+push\b/.test(joined) || /\bgh\s+(pr|issue)\s+(create|edit)\b/.test(joined)) {
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
 * Keep autonomous inspection and experiment commands inside the selected
 * workspace. The process CWD alone is insufficient because tools such as
 * `git -C`, `rg`, and `find` accept independent paths.
 */
export function guardWorkspaceCommand(command: string[], root: string): CommandGuard {
  let rootPath: string;
  try { rootPath = realpathSync(root); } catch { return { allowed: false, reason: "Workspace root is unavailable." }; }
  const executable = basename(command[0] ?? "").toLowerCase();
  const pathArguments = new Set<number>();
  const optionPaths: string[] = [];
  if (executable === "git") {
    for (let index = 1; index < command.length - 1; index += 1) if (command[index] === "-C" || command[index] === "--work-tree") pathArguments.add(index + 1);
    for (const argument of command.slice(1)) {
      if (argument.startsWith("-C") && argument.length > 2) optionPaths.push(argument.slice(2));
      for (const option of ["--git-dir=", "--work-tree="]) if (argument.startsWith(option)) optionPaths.push(argument.slice(option.length));
    }
  }
  if (["ls", "rg", "grep", "find", "sed", "head", "tail", "cat", "du", "file", "wc", "awk", "sha256sum", "shasum", "md5sum"].includes(executable)) {
    for (let index = 1; index < command.length; index += 1) {
      const value = command[index] ?? "";
      if (!value.startsWith("-")) pathArguments.add(index);
      for (const option of ["--file=", "--ignore-file=", "--exclude-from=", "--files0-from=", "--magic-file="]) if (value.startsWith(option)) optionPaths.push(value.slice(option.length));
      if (["rg", "grep", "sed"].includes(executable) && value.startsWith("-f") && value.length > 2) optionPaths.push(value.slice(2));
    }
  }
  for (const value of [...pathArguments].map((index) => command[index] ?? "").concat(optionPaths)) {
    if (!value || /^https?:\/\//i.test(value)) continue;
    if (value.split(/[\\/]+/).includes("..")) return { allowed: false, reason: `Refusing workspace escape path '${value}'.` };
    const target = resolve(rootPath, value);
    const targetRelative = relative(rootPath, target);
    if (targetRelative.startsWith("..") || isAbsolute(targetRelative)) return { allowed: false, reason: `Refusing path outside the workspace: '${value}'.` };
    if (isSensitiveWorkspacePath(targetRelative)) return { allowed: false, reason: `Refusing sensitive workspace path: '${value}'.` };
    let ancestor = target;
    while (!existsSync(ancestor) && dirname(ancestor) !== ancestor) ancestor = dirname(ancestor);
    try {
      const physicalRelative = relative(rootPath, realpathSync(ancestor));
      if (physicalRelative === ".." || physicalRelative.startsWith("../") || physicalRelative.startsWith("..\\") || isAbsolute(physicalRelative)) return { allowed: false, reason: `Refusing path that resolves outside the workspace: '${value}'.` };
      if (isSensitiveWorkspacePath(physicalRelative)) return { allowed: false, reason: `Refusing path resolving to sensitive workspace data: '${value}'.` };
    } catch { return { allowed: false, reason: `Unable to verify workspace path: '${value}'.` }; }
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
  if (executable === "rg") {
    for (const argument of command.slice(1)) {
      if (argument === "--") break;
      if (["--pre", "--hostname-bin"].some((option) => argument === option || argument.startsWith(`${option}=`))) return { allowed: false, reason: "SAFE mode refuses ripgrep options that execute external programs." };
    }
  }
  const readOnly = new Set(["true", "pwd", "ls", "find", "rg", "grep", "head", "tail", "sed", "wc", "du", "file", "which", "sha256sum", "shasum", "md5sum"]);
  if (executable === "git") {
    const allowed = new Set(["status", "rev-parse", "log", "diff", "show", "ls-files", "branch"]);
    if (!allowed.has(command[1]?.toLowerCase() ?? "")) return { allowed: false, reason: "SAFE mode only permits read-only Git inspection commands." };
    const joined = command.slice(2).join(" ").toLowerCase();
    if (/(^|\s)(--output|-o)(\s|=|$)/.test(joined) || /(^|\s)(--exec|--ext-diff|--textconv)(\s|=|$)/.test(joined)) {
      return { allowed: false, reason: "Read-only Git inspection refuses output, external-diff, and command-execution options." };
    }
    if (command[1].toLowerCase() === "branch" && /(^|\s)(-d|-D|-m|-M|-c|-C|--delete|--move|--copy|--edit-description)(\s|$)/.test(joined)) {
      return { allowed: false, reason: "Read-only Git inspection refuses branch mutation options." };
    }
    if (command[1].toLowerCase() === "branch" && command.slice(2).some((argument) => !argument.startsWith("-"))) {
      return { allowed: false, reason: "Read-only Git inspection refuses branch-creation positional arguments." };
    }
    return { allowed: true };
  }
  if (["node", "nodejs", "python", "python3"].includes(executable)) {
    const flagIndex = command.findIndex((argument, index) => index > 0 && (argument === "-e" || argument === "-c"));
    if (flagIndex < 0 || !command[flagIndex + 1]) return { allowed: false, reason: "Autonomous research shell only permits explicit read-only interpreter probes." };
    const code = command.slice(flagIndex + 1).join(" ");
    if (/[>|]|\b(?:require|import|eval|function|binding|fetch|http|https|net|fs|os|child|writeFile|appendFile|unlink|rmdir|mkdir|rename|copyFile|truncate|exec|spawn|fork|system|subprocess)\b|open\s*\([^)]*['\"][wa+]/i.test(code)) {
      return { allowed: false, reason: "Autonomous research shell refuses interpreter code that can write files, spawn processes, or mutate the workspace." };
    }
    return { allowed: true };
  }
  if (!readOnly.has(executable)) return { allowed: false, reason: `SAFE mode does not permit '${executable}' for autonomous shell work.` };
  const joined = command.join(" ").toLowerCase();
  if (executable === "find" && /(^|\s)-(exec|execdir|ok|okdir|delete|fprint|fprint0|fprintf|fls)(\s|$)/.test(joined)) return { allowed: false, reason: "SAFE mode refuses find actions that execute programs, delete files, or write output files." };
  if (executable === "sed" && command.some((argument) => argument === "-i" || argument.startsWith("-i"))) return { allowed: false, reason: "SAFE mode refuses in-place sed edits." };
  if (executable === "sed") {
    const options = command.slice(1, command.includes("--") ? command.indexOf("--") : undefined);
    if (!options.includes("--sandbox")) return { allowed: false, reason: "SAFE sed inspection requires --sandbox to disable read/write/execute commands." };
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
