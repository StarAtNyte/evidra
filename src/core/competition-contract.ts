import { existsSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import type { CompetitionConfig } from "./types.js";

export interface CompetitionContractCheck {
  name: string;
  passed: boolean;
  detail: string;
}

export interface CompetitionContractReport {
  valid: boolean;
  checks: CompetitionContractCheck[];
}

/** Validate cheap, deterministic contract errors before spending compute. */
export function validateCompetitionContract(config: CompetitionConfig, workspacePath: string): CompetitionContractReport {
  const checks: CompetitionContractCheck[] = [];
  const workspace = resolve(workspacePath);
  const add = (name: string, passed: boolean, detail: string): void => { checks.push({ name, passed, detail }); };
  let workspaceDirectory = false;
  try { workspaceDirectory = existsSync(workspace) && statSync(workspace).isDirectory(); } catch { workspaceDirectory = false; }
  add("workspace", workspaceDirectory, workspaceDirectory ? workspace : `workspace does not exist: ${workspace}`);
  add("metric", Boolean(config.metric.name.trim()), config.metric.name.trim() ? `${config.metric.name} (${config.metric.direction})` : "metric name is empty");
  add("timeout", Number.isFinite(config.evaluatorTimeoutMinutes) && config.evaluatorTimeoutMinutes > 0, `${config.evaluatorTimeoutMinutes} minutes`);
  const commandCheck = (name: string, command: string[] | undefined): void => {
    const valid = Boolean(command?.length && command.every((part) => typeof part === "string" && part.trim().length > 0));
    add(name, valid, valid ? command!.join(" ") : "command is empty or contains a blank argument");
  };
  commandCheck("evaluator command", config.evaluator.command);
  commandCheck("baseline command", config.baselineCommand ?? config.evaluator.command);
  commandCheck("experiment command", config.experimentCommand ?? config.evaluator.command);
  if (!config.evaluator.estimatorPath.trim()) add("estimator path", true, "not declared");
  else {
    const estimator = resolve(workspace, config.evaluator.estimatorPath);
    const estimatorRelative = relative(workspace, estimator);
    const inside = !isAbsolute(estimatorRelative) && !estimatorRelative.startsWith("..");
    let present = false;
    try { present = inside && existsSync(estimator) && statSync(estimator).isFile(); } catch { present = false; }
    add("estimator path", present, present ? estimatorRelative : `missing or outside workspace: ${config.evaluator.estimatorPath}`);
  }
  return { valid: checks.every((check) => check.passed), checks };
}
