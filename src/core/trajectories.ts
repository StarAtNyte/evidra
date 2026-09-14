import type { ResearchToolCall, ResearchToolResult } from "./tools.js";
import { redactStructured } from "./redaction.js";

export type TrajectoryEventKind =
  | "user"
  | "assistant"
  | "tool_call"
  | "tool_result"
  | "process"
  | "evaluator"
  | "recovery"
  | "terminal";

export type QualityVerdict = "PASS" | "WARN" | "FAIL" | "NOT_EVALUATED";

export interface TrajectoryEvent {
  id: string;
  kind: TrajectoryEventKind;
  at?: string;
  payload: Record<string, unknown>;
  callId?: string;
}

export interface ToolTraceRecorder {
  events: TrajectoryEvent[];
  onToolCall: (source: string, call: ResearchToolCall) => string;
  onToolResult: (source: string, callId: string, result: ResearchToolResult) => void;
}

/** Capture interleaved tool activity without retaining provider protocol noise or credentials. */
export function createToolTraceRecorder(prefix = "research"): ToolTraceRecorder {
  const events: TrajectoryEvent[] = [];
  let sequence = 0;
  return {
    events,
    onToolCall: (source, call) => {
      const callId = `${prefix}-tool-${++sequence}`;
      events.push({ id: `${callId}-call`, kind: "tool_call", callId, at: new Date().toISOString(), payload: redactStructured({ tool: call.name, arguments: call.arguments ?? {}, source }) });
      return callId;
    },
    onToolResult: (source, callId, result) => {
      events.push({ id: `${callId}-result`, kind: "tool_result", callId, at: new Date().toISOString(), payload: redactStructured({ tool: result.name, ok: result.ok, output: result.output, error: result.error, source }) });
    },
  };
}

export interface TrajectoryStructure {
  status: "complete" | "recoverable" | "quarantined";
  issues: string[];
}

export interface QualityDimension {
  verdict: QualityVerdict;
  coverage: "observed" | "partial" | "missing";
  evidence: string[];
}

export interface TrajectoryQuality {
  structural: QualityDimension;
  goalAttainment: QualityDimension;
  instructionAdherence: QualityDimension;
  toolUse: QualityDimension;
  executionAlignment: QualityDimension;
  evidenceConsistency: QualityDimension;
  errorRecovery: QualityDimension;
  termination: QualityDimension;
  safetyControl: QualityDimension;
  overall: QualityVerdict;
}

const dimension = (verdict: QualityVerdict, coverage: QualityDimension["coverage"], ...evidence: string[]): QualityDimension => ({ verdict, coverage, evidence });

/**
 * Validate the event stream before semantic quality is considered. This is
 * deliberately deterministic: malformed or ambiguous traces must not become
 * positive training/routing feedback merely because a judge found a plausible
 * final answer.
 */
export function validateTrajectoryStructure(events: TrajectoryEvent[]): TrajectoryStructure {
  const issues: string[] = [];
  const quarantined: string[] = [];
  const eventIds = new Set<string>();
  const callIndexes = new Map<string, number>();
  const resultCallIds = new Set<string>();
  let terminalIndex = -1;

  events.forEach((event, index) => {
    if (!event.id) issues.push(`event ${index} has no id`);
    else if (eventIds.has(event.id)) quarantined.push(`duplicate event id '${event.id}'`);
    else eventIds.add(event.id);
    if (event.kind === "terminal") {
      if (terminalIndex >= 0) quarantined.push("trajectory has multiple terminal events");
      else terminalIndex = index;
    }
    if (terminalIndex >= 0 && index > terminalIndex) quarantined.push("events occur after terminal state");
    if (event.kind === "tool_call") {
      if (!event.callId) quarantined.push(`tool call '${event.id || index}' has no call id`);
      else if (callIndexes.has(event.callId)) quarantined.push(`duplicate tool call id '${event.callId}'`);
      else callIndexes.set(event.callId, index);
    }
    if (event.kind === "tool_result") {
      if (!event.callId) quarantined.push(`tool result '${event.id || index}' has no call id`);
      else if (resultCallIds.has(event.callId)) quarantined.push(`duplicate tool result for '${event.callId}'`);
      else resultCallIds.add(event.callId);
      const callIndex = event.callId ? callIndexes.get(event.callId) : undefined;
      if (callIndex === undefined) quarantined.push(`tool result '${event.callId ?? (event.id || index)}' has no matching call`);
      else if (callIndex >= index) quarantined.push(`tool result '${event.callId}' precedes its call`);
    }
  });

  for (const callId of callIndexes.keys()) {
    if (!resultCallIds.has(callId)) quarantined.push(`tool call '${callId}' has no matching result`);
  }
  if (terminalIndex < 0) issues.push("trajectory has no terminal event");
  if (quarantined.length) return { status: "quarantined", issues: [...issues, ...quarantined] };
  if (issues.length) return { status: "recoverable", issues };
  return { status: "complete", issues: [] };
}

/**
 * Deterministic first-pass trajectory evaluation. Model judges may enrich this
 * later, but they must not overwrite facts established by this evaluator.
 */
export function evaluateTrajectory(events: TrajectoryEvent[]): TrajectoryQuality {
  const structure = validateTrajectoryStructure(events);
  const calls = events.filter((event) => event.kind === "tool_call");
  const results = new Set(events.filter((event) => event.kind === "tool_result").map((event) => event.callId).filter(Boolean));
  const unresolved = calls.filter((event) => !event.callId || !results.has(event.callId));
  const terminals = events.filter((event) => event.kind === "terminal");
  const processEvents = events.filter((event) => event.kind === "process");
  const evaluatorEvents = events.filter((event) => event.kind === "evaluator");
  const failures = events.filter((event) => event.payload.error || event.payload.status === "failed");
  const recoveries = events.filter((event) => event.kind === "recovery");
  const completed = events.some((event) => event.kind === "terminal" && event.payload.status === "completed");
  const goalMet = events.some((event) => event.payload.goalAttained === true || event.payload.goalStatus === "met");
  const instructionFailure = events.some((event) => event.payload.instructionAdherence === false);
  const evidenceFailure = events.some((event) => event.payload.evidenceConsistent === false);
  const alignmentFailure = events.some((event) => event.payload.executionAlignment === false);
  const alignmentObserved = events.some((event) => event.payload.executionAlignment === true);
  const safetySignals = events.filter((event) => ["permissionChecked", "permissionDenied", "permissionApproved", "permissionBypassed", "safetyViolation", "externalAction"].some((key) => key in event.payload));
  const safetyViolation = events.some((event) => event.payload.safetyViolation === true || event.payload.permissionBypassed === true || event.payload.externalAction === true && event.payload.permissionApproved !== true);
  const blockedActions = events.filter((event) => event.payload.permissionDenied === true).length;

  const structural = structure.status === "quarantined"
    ? dimension("FAIL", "observed", ...structure.issues)
    : structure.status === "recoverable"
      ? dimension("WARN", "partial", ...structure.issues)
      : dimension("PASS", "observed", `event stream is causally closed (${events.length} events)`);
  const goalAttainment = goalMet
    ? dimension("PASS", "observed", "trajectory records explicit goal attainment")
    : completed
      ? dimension("WARN", "partial", "execution completed without an explicit goal-attainment verdict")
      : dimension("NOT_EVALUATED", "missing", "no terminal success or goal verdict recorded");
  const instructionAdherence = instructionFailure
    ? dimension("FAIL", "observed", "trajectory records an instruction-adherence failure")
    : dimension("NOT_EVALUATED", "missing", "no explicit instruction-adherence verdict recorded");
  const toolUse = calls.length === 0
    ? dimension("NOT_EVALUATED", "missing", "no tool calls in trajectory")
    : unresolved.length
      ? dimension("FAIL", "observed", "at least one tool call was not closed")
      : dimension("PASS", "observed", `${calls.length} tool call(s) closed with results`);
  const executionAlignment = calls.length === 0
    ? dimension("PASS", "observed", "no tool-feedback boundary was required")
    : alignmentFailure
    ? dimension("FAIL", "observed", "the trajectory records a decision that was not aligned with available tool feedback")
    : alignmentObserved
      ? dimension("PASS", "observed", "the controller recorded alignment between tool feedback and the next action")
      : dimension("NOT_EVALUATED", "missing", "no explicit tool-feedback alignment verdict recorded");
  const evidenceConsistency = evidenceFailure
    ? dimension("FAIL", "observed", "trajectory records inconsistent evidence")
    : evaluatorEvents.length
      ? dimension("PASS", "observed", "evaluator event recorded")
      : dimension("NOT_EVALUATED", "missing", "no evaluator evidence recorded");
  const errorRecovery = failures.length === 0
    ? dimension("PASS", "observed", "no execution failures recorded")
    : recoveries.length >= failures.length
      ? dimension("PASS", "observed", `${recoveries.length} recovery event(s) for ${failures.length} failure(s)`)
      : dimension("WARN", "partial", `${failures.length - recoveries.length} failure(s) lacked recovery`);
  const termination = terminals.length === 0
    ? dimension("FAIL", "missing", "trajectory has no terminal event")
    : terminals.length > 1
      ? dimension("FAIL", "observed", "trajectory has multiple terminal events")
      : dimension("PASS", "observed", "trajectory has one terminal event");
  const safetyControl = safetySignals.length === 0
    ? dimension("NOT_EVALUATED", "missing", "no lifecycle permission or external-action signal recorded")
    : safetyViolation
      ? dimension("FAIL", "observed", "an unauthorized or bypassed external action was recorded")
      : blockedActions > 0
        ? dimension("PASS", "observed", `${blockedActions} action(s) were blocked by the permission boundary`)
        : dimension("PASS", "observed", "permission boundary was observed without an unauthorized action");

  const dimensions = [structural, goalAttainment, instructionAdherence, toolUse, executionAlignment, evidenceConsistency, errorRecovery, termination, ...(safetyControl.verdict === "NOT_EVALUATED" ? [] : [safetyControl])];
  const overall: QualityVerdict = dimensions.some((item) => item.verdict === "FAIL")
    ? "FAIL"
    : dimensions.some((item) => item.verdict === "WARN" || item.verdict === "NOT_EVALUATED")
      ? "WARN"
      : "PASS";
  return { structural, goalAttainment, instructionAdherence, toolUse, executionAlignment, evidenceConsistency, errorRecovery, termination, safetyControl, overall };
}

export function capabilityGaps(quality: TrajectoryQuality): string[] {
  return Object.entries(quality)
    .filter(([key, value]) => key !== "overall" && ["FAIL", "WARN"].includes((value as QualityDimension).verdict))
    .map(([key, value]) => `${key}: ${(value as QualityDimension).evidence.join("; ")}`);
}
