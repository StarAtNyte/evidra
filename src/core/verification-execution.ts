import { existsSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";

export interface VerificationExecutionPlan {
  standalone: boolean;
  commands: string[][];
  /** The first declared command is the primary worker for standalone verification. */
  primaryCommand?: string[];
}

/**
 * Non-metric outcomes with explicit verification commands are independent of
 * an adapter's benchmark evaluator. In particular, a harness regression test
 * inside a competition campaign must not accidentally launch the competition
 * scorer as its primary command.
 */
export function planVerificationExecution(input: {
  outcomeType: string;
  verificationCommand?: string[];
  verificationCommands?: string[][];
}): VerificationExecutionPlan {
  const commands = [
    ...(input.verificationCommand?.length ? [input.verificationCommand] : []),
    ...(input.verificationCommands ?? []),
  ];
  const standalone = input.outcomeType !== "metric" && commands.length > 0;
  return {
    standalone,
    commands,
    ...(standalone ? { primaryCommand: commands[0] } : {}),
  };
}

/** Check direct Python verifier entrypoints before launching a costly evaluator.
 * Module/inline and shell commands have no statically known script; do not guess.
 */
export function missingVerificationScripts(cwd: string, commands: readonly string[][]): string[] {
  const reasons: string[] = [];
  const simpleFlags = new Set(["-u", "-B", "-E", "-I", "-s", "-S", "-O", "-OO", "-q"]);
  for (const [index, command] of commands.entries()) {
    if (!/^python(?:\d+(?:\.\d+)*)?(?:\.exe)?$/i.test(basename(command[0] ?? ""))) continue;
    let offset = 1;
    while (simpleFlags.has(command[offset] ?? "")) offset++;
    const script = command[offset];
    if (!script || script.startsWith("-") || !script.endsWith(".py")) continue;
    const path = resolve(cwd, script);
    if (!existsSync(path) || !statSync(path).isFile()) reasons.push(`Verification ${index + 1} Python script is missing or not a regular file: ${script}. Stage it as a checksum-pinned implementation artifact or declared support file before evaluation.`);
  }
  return reasons;
}
