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
