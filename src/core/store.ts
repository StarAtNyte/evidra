import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { EvidenceClaimSchema } from "./types.js";
import { compareClaims } from "./claim-consistency.js";
import { redactCommand, redactStructured } from "./redaction.js";
import { canonicalSourceUrl } from "./sources.js";
import { subtaskAuditFingerprint } from "./subtask-state.js";
import { queueRecoveryAction } from "./queue-recovery.js";
import { isBuiltInAgentRole } from "./agent-organization.js";
import { sha256File } from "./evidence.js";
import { isSensitiveWorkspacePath } from "./redaction.js";

function safeJson(value: unknown): string {
  return JSON.stringify(redactStructured(value));
}

const IMMUTABLE_MANIFEST_FIELDS = [
  "schemaVersion", "id", "parent", "parentHypothesisIds", "hypothesisId",
  "outcomeType", "gitCommit", "datasetVersion", "splitVersion", "change",
  "resources", "evaluation", "acceptance", "searchOperator", "createdAt",
] as const;

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => [key, canonicalValue(entry)]));
}

function preserveQueuePayload(previous: unknown, update: unknown): unknown {
  if (update === undefined) return previous;
  const previousObject = previous && typeof previous === "object" && !Array.isArray(previous) ? previous as Record<string, unknown> : {};
  const original = previousObject._task && typeof previousObject._task === "object" && !Array.isArray(previousObject._task)
    ? previousObject._task
    : previousObject;
  if (update && typeof update === "object" && !Array.isArray(update)) {
    return { ...previousObject, ...(update as Record<string, unknown>), _task: original, completion: update };
  }
  return { ...previousObject, _task: original, completion: update };
}

/** Return the pre-registered portion of a persisted experiment, if present. */
function registeredManifest(payload: unknown): Record<string, unknown> | null {
  if (!payload || typeof payload !== "object") return null;
  const candidate = payload as Record<string, unknown>;
  if (typeof candidate.schemaVersion !== "number" || !candidate.change || !candidate.resources || !candidate.evaluation || !candidate.acceptance) return null;
  return Object.fromEntries(IMMUTABLE_MANIFEST_FIELDS
    .filter((field) => field in candidate)
    .map((field) => [field, candidate[field]]));
}

function phasePlanProjection(payload: unknown): Record<string, unknown> {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return {};
  const value = payload as Record<string, unknown>;
  return Object.fromEntries(["id", "goalSetId", "phase", "title", "objective", "completionCriteria"]
    .filter((field) => field in value)
    .map((field) => [field, value[field]]));
}

function phasePlanFingerprint(payload: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonicalValue(phasePlanProjection(payload)))).digest("hex").slice(0, 20);
}

export type QueueTaskStatus = "queued" | "running" | "paused" | "completed" | "failed" | "cancelled";
export type QueueApprovalStatus = "none" | "pending" | "approved" | "rejected";
export interface QueuedTask {
  id: string;
  kind: string;
  priority: number;
  status: string;
  payload: unknown;
  attempts: number;
  availableAt: string;
  claimedAt: string | null;
  claimToken: string | null;
  ownerId: string | null;
  assigneeId: string | null;
  tokenBudget: number | null;
  costBudgetUsd: number | null;
  approvalStatus: QueueApprovalStatus;
  approvalReason: string | null;
  deadlineAt: string | null;
  goalId: string | null;
  parentTaskId: string | null;
  dependsOn: string[];
  requiredCapabilities: string[];
  labels: string[];
  updatedAt: string;
}

/** Optional, provider-neutral proof requirements for a queue task. */
export interface QueueCompletionContract {
  requiredPayloadKeys?: string[];
  requiredEvidenceRefs?: string[];
  requiredActivityKinds?: QueueActivityKind[];
  requireChildCompletion?: boolean;
}

/** Effective scheduler priority, including the same bounded waiting boost used by claimNextTask. */
export function queueEffectivePriority(task: Pick<QueuedTask, "priority" | "availableAt">, now = Date.now()): number {
  const availableAt = Date.parse(task.availableAt);
  const ageHours = Number.isFinite(availableAt) ? Math.max(0, (now - availableAt) / 3_600_000) : 0;
  return Math.round((task.priority + Math.min(3, ageHours)) * 1000) / 1000;
}

function normalizeQueueTokenBudget(value: number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const normalized = Math.floor(value);
  if (!Number.isFinite(normalized) || normalized <= 0 || normalized > 100_000_000_000) throw new Error("Queue task tokenBudget must be a positive bounded integer.");
  return normalized;
}

function normalizeQueueCostBudget(value: number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const normalized = Number(value);
  if (!Number.isFinite(normalized) || normalized <= 0 || normalized > 1_000_000_000) throw new Error("Queue task costBudgetUsd must be a positive bounded number.");
  return Math.round(normalized * 1_000_000) / 1_000_000;
}

function normalizeQueueDeadline(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new Error("Queue task deadline must be a valid ISO timestamp.");
  return new Date(timestamp).toISOString();
}

function normalizeQueueCapabilities(value: string[] | null | undefined): string[] {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value) || value.length > 32 || value.some((entry) => typeof entry !== "string" || !/^[a-zA-Z0-9_.:-]{1,120}$/.test(entry.trim()))) {
    throw new Error("Queue requiredCapabilities must be an array of at most 32 simple capability names.");
  }
  return [...new Set(value.map((entry) => entry.trim().toLowerCase()))].sort();
}

function normalizeQueueLabels(value: string[] | null | undefined): string[] {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value) || value.length > 24 || value.some((entry) => typeof entry !== "string" || !/^[a-zA-Z0-9_.:-]{1,64}$/.test(entry.trim()))) {
    throw new Error("Queue labels must be an array of at most 24 simple names.");
  }
  return [...new Set(value.map((entry) => entry.trim().toLowerCase()))].sort();
}

export interface QueuedTaskLineage {
  taskIds: string[];
  goalIds: string[];
  missingParentIds: string[];
  cycle: boolean;
  truncated: boolean;
}
export interface QueueChildSummary {
  total: number;
  unfinished: number;
  queued: number;
  running: number;
  paused: number;
  completed: number;
  failed: number;
  cancelled: number;
}
export type QueueActivityKind = "started" | "progress" | "blocked" | "comment" | "handoff" | "completed" | "failed";
const QUEUE_ACTIVITY_KINDS: QueueActivityKind[] = ["started", "progress", "blocked", "comment", "handoff", "completed", "failed"];

function validateQueueCompletionContract(payload: unknown): void {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return;
  const raw = (payload as Record<string, unknown>).completionContract;
  if (raw === undefined) return;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Queue completionContract must be an object.");
  const value = raw as Record<string, unknown>;
  for (const [field, max, limit] of [["requiredPayloadKeys", 32, 120], ["requiredEvidenceRefs", 64, 240]] as const) {
    if (value[field] === undefined) continue;
    if (!Array.isArray(value[field]) || value[field].length > max || value[field].some((entry) => typeof entry !== "string" || entry.trim().length === 0 || entry.length > limit)) {
      throw new Error(`Queue completionContract.${field} must be a bounded array of non-empty strings.`);
    }
  }
  if (value.requiredActivityKinds !== undefined && (!Array.isArray(value.requiredActivityKinds) || value.requiredActivityKinds.length > 16 || value.requiredActivityKinds.some((entry) => !QUEUE_ACTIVITY_KINDS.includes(entry as QueueActivityKind)))) {
    throw new Error("Queue completionContract.requiredActivityKinds contains an unsupported activity kind.");
  }
  if (value.requireChildCompletion !== undefined && typeof value.requireChildCompletion !== "boolean") {
    throw new Error("Queue completionContract.requireChildCompletion must be a boolean.");
  }
}

export interface QueueActivity {
  taskId: string;
  actorId: string;
  kind: QueueActivityKind;
  message: string;
  metadata: unknown;
  createdAt: string;
}
export interface QueueWorkProduct {
  id: string;
  taskId: string;
  actorId: string;
  name: string;
  path: string;
  checksum: string;
  metadata: unknown;
  verification: "unverified" | "verified" | "missing" | "mismatch";
  createdAt: string;
}

export type QueueProgressState = "queued" | "active" | "blocked" | "stalled" | "completed" | "failed" | "cancelled" | "paused";
export interface QueueProgressDetails {
  percent: number | null;
  step: string | null;
  completed: number | null;
  total: number | null;
}
export interface QueueProgress {
  state: QueueProgressState;
  lastActivityAt: string | null;
  lastActivityKind: QueueActivityKind | null;
  lastActivityMessage: string | null;
  idleSeconds: number | null;
  heartbeatAgeSeconds: number | null;
  stalled: boolean;
  details: QueueProgressDetails;
}

export function normalizeQueueProgressDetails(input: unknown): QueueProgressDetails | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const value = input as Record<string, unknown>;
  if (!["percent", "step", "completed", "total"].some((key) => value[key] !== undefined)) return undefined;
  const percent = value.percent === undefined ? null : typeof value.percent === "number" && Number.isFinite(value.percent) && value.percent >= 0 && value.percent <= 1 ? value.percent : undefined;
  const step = value.step === undefined ? null : typeof value.step === "string" && value.step.trim() && value.step.length <= 160 ? value.step.trim().slice(0, 160) : undefined;
  const completed = value.completed === undefined ? null : Number.isInteger(value.completed) && (value.completed as number) >= 0 ? value.completed as number : undefined;
  const total = value.total === undefined ? null : Number.isInteger(value.total) && (value.total as number) > 0 ? value.total as number : undefined;
  if (percent === undefined || step === undefined || completed === undefined || total === undefined) return undefined;
  if (completed !== null && total !== null && completed > total) return undefined;
  return { percent, step, completed, total };
}
export interface QueueHistoryEntry {
  type: string;
  payload: unknown;
  createdAt: string;
}
export interface QueueCheckpointSummary {
  present: boolean;
  bytes: number;
  hash: string | null;
  updatedAt: string | null;
  keys: string[];
  stage: string | null;
}
export interface QueueResumeContext {
  taskId: string;
  attempt: number;
  lineage: QueuedTaskLineage;
  checkpoint: QueueCheckpointSummary;
  recentActivity: QueueActivity[];
  workProducts: QueueWorkProduct[];
  updatedAt: string;
}
export interface QueueUsage {
  taskId: string;
  actorId: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
  provider: string | null;
  model: string | null;
  createdAt: string;
}
export interface AttentionAcknowledgement {
  itemId: string;
  fingerprint: string;
  actorId: string;
  note: string | null;
  acknowledgedAt: string;
}

export type RoutineStatus = "active" | "paused" | "running" | "failed";
export type RoutineCatchUpPolicy = "coalesce" | "replay";
export const MAX_ROUTINE_PENDING_TRIGGERS = 8;
export interface RoutineTriggerContext {
  eventType: string;
  eventCreatedAt: string;
}
export interface ResearchRoutine {
  id: string;
  name: string;
  mode: "research" | "challenge";
  goal: string;
  budgetMinutes: number;
  intervalSeconds: number;
  stopCondition: string;
  provider: "codex" | "local";
  model: string;
  thinking: string;
  autonomy: "safe" | "fast" | "yolo";
  limitPolicy: "auto" | "wait" | "fallback" | "stop";
  executor: "local" | "container" | "modal" | "slurm";
  lanes: number;
  /** Null means the routine may run until explicitly paused or its goal stops it. */
  maxRuns: number | null;
  triggerEvent?: string | null;
  lastTriggerAt?: string | null;
  /** Coalesced wake-up waiting for the current run to finish. */
  pendingTriggers?: number;
  /** The newest durable event that caused or is waiting to cause a run. */
  pendingTriggerEvent?: RoutineTriggerContext | null;
  /** Whether missed wakeups collapse into one run or replay up to the bounded cap. */
  catchUpPolicy?: RoutineCatchUpPolicy;
  /** Replay wakeups dropped after the bounded pending cap; retained for audit. */
  droppedTriggers?: number;
  status: RoutineStatus;
  nextRunAt: string;
  lastRunAt: string | null;
  lastResult: "completed" | "failed" | null;
  lastError: string | null;
  runCount: number;
  /** Consecutive failed runs; the circuit breaker pauses after three. */
  failureStreak?: number;
  leaseId: string | null;
  leaseExpiresAt: string | null;
  createdAt: string;
  updatedAt: string;
}
export interface ResearchRoutineRun {
  id: string;
  routineId: string;
  ownerId: string;
  status: "running" | "completed" | "failed" | "abandoned";
  startedAt: string;
  finishedAt: string | null;
  exitCode: number | null;
  error: string | null;
}

/** Return the durable delay currently protecting a failed routine from a retry storm. */
export function routineRetryDelaySeconds(routine: Pick<ResearchRoutine, "lastResult" | "lastRunAt" | "nextRunAt">): number | null {
  if (routine.lastResult !== "failed" || !routine.lastRunAt) return null;
  const delay = Math.round((Date.parse(routine.nextRunAt) - Date.parse(routine.lastRunAt)) / 1000);
  return Number.isFinite(delay) && delay >= 0 ? delay : null;
}

function validateRoutine(routine: Pick<ResearchRoutine, "name" | "goal" | "mode" | "budgetMinutes" | "intervalSeconds" | "provider" | "model" | "thinking" | "autonomy" | "limitPolicy" | "executor" | "lanes" | "maxRuns" | "triggerEvent" | "catchUpPolicy">): void {
  if (!routine.name.trim()) throw new Error("Routine name must not be empty.");
  if (!routine.goal.trim()) throw new Error("Routine goal must not be empty.");
  if (!Number.isFinite(routine.budgetMinutes) || routine.budgetMinutes <= 0) throw new Error("Routine budget must be positive.");
  if (!Number.isFinite(routine.intervalSeconds) || routine.intervalSeconds < 60) throw new Error("Routine interval must be at least 1 minute.");
  if (!["research", "challenge"].includes(routine.mode)) throw new Error("Routine mode must be 'research' or 'challenge'.");
  if (!["codex", "local"].includes(routine.provider)) throw new Error("Routine provider must be 'codex' or 'local'.");
  if (!routine.model.trim()) throw new Error("Routine model must not be empty.");
  if (!routine.thinking.trim()) throw new Error("Routine thinking effort must not be empty.");
  if (!["safe", "fast", "yolo"].includes(routine.autonomy)) throw new Error("Routine autonomy must be safe, fast, or yolo.");
  if (!["auto", "wait", "fallback", "stop"].includes(routine.limitPolicy)) throw new Error("Routine limit policy must be auto, wait, fallback, or stop.");
  if (!["local", "container", "modal", "slurm"].includes(routine.executor)) throw new Error("Routine executor must be local, container, modal, or slurm.");
  if (!Number.isInteger(routine.lanes) || routine.lanes < 1 || routine.lanes > 6) throw new Error("Routine lanes must be an integer from 1 to 6.");
  if (routine.maxRuns !== null && (!Number.isInteger(routine.maxRuns) || routine.maxRuns < 1)) throw new Error("Routine maxRuns must be null or a positive integer.");
  if (routine.triggerEvent !== undefined && routine.triggerEvent !== null && !/^[a-zA-Z0-9_.:-]{1,120}$/.test(routine.triggerEvent)) throw new Error("Routine trigger event must be a simple event type such as research.agent_budget.exhausted.");
  if (routine.triggerEvent?.startsWith("routine.")) throw new Error("Routine triggers cannot subscribe to routine lifecycle events; this would permit self-triggering loops.");
  if (routine.catchUpPolicy !== undefined && !["coalesce", "replay"].includes(routine.catchUpPolicy)) throw new Error("Routine catch-up policy must be 'coalesce' or 'replay'.");
}

export type ControllerAction = "pause" | "resume" | "stop";
export interface ControllerSteer {
  id: number;
  message: string;
  createdAt: string;
  appliedAt: string | null;
}
export interface AgentDirective {
  id: number;
  /** The role or operator that authored the handoff. */
  sourceRole: string | null;
  role: string;
  message: string;
  /** Null means an operator-wide directive; otherwise it is limited to one phase/goal scope. */
  scopeKey: string | null;
  createdAt: string;
  appliedAt: string | null;
  cancelledAt: string | null;
}
export interface PersistedAgentRoleContract {
  role: string;
  parentRole: string | null;
  responsibility: string;
  authority: "coordinate" | "investigate" | "validate" | "execute" | "repair";
  reviewRequired: boolean;
  playbook: string[];
  /** Optional least-privilege tool scope; omitted means authority defaults apply. */
  toolAllowlist?: string[];
  /** Optional project-skill scope; omitted means all discovered shared skills apply. */
  skillAllowlist?: string[];
  updatedAt: string;
}
export type AgentDirectiveOutcomeStatus = "acknowledged" | "completed" | "failed" | "rejected";
export interface AgentDirectiveOutcome {
  directiveId: number;
  role: string;
  status: AgentDirectiveOutcomeStatus;
  message: string;
  createdAt: string;
}
export type AgentActivityKind = "started" | "progress" | "blocked" | "handoff" | "completed" | "failed";
export interface AgentActivity {
  role: string;
  taskId: string | null;
  kind: AgentActivityKind;
  message: string;
  metadata: unknown;
  createdAt: string;
}
export interface AgentSession {
  role: string;
  scopeKey: string;
  provider: string;
  model: string;
  threadId: string;
  taskId: string | null;
  updatedAt: string;
}
export interface ControllerLease {
  controllerId: string;
  pid: number;
  mode: string;
  currentStep: string | null;
  status: "running" | "released" | "stale";
  requestedAction: ControllerAction | null;
  startedAt: string;
  heartbeatAt: string;
  updatedAt: string;
}

export interface ExternalWorkerHealth {
  workerId: string;
  workspaceId: string | null;
  role: string;
  provider: string;
  model: string;
  status: "running" | "idle" | "blocked" | "failed";
  admission: "approved" | "review" | "rejected";
  capabilities: string[];
  capacity: number | null;
  activeTasks: number;
  availableSlots: number | null;
  task: string | null;
  lastHeartbeatAt: string;
  health: "healthy" | "stale";
  updatedAt: string;
}

export type ExternalActionStatus = "in_flight" | "completed" | "unknown" | "retryable";
export interface ExternalActionIntent {
  id: string;
  kind: string;
  fingerprint: string;
  status: ExternalActionStatus;
  payload: unknown;
  createdAt: string;
  updatedAt: string;
}

export interface RunAttempt {
  id: string;
  experimentId: string;
  runId: string | null;
  attempt: number;
  stage: string;
  status: string;
  exitCode: number | null;
  failureClass: string | null;
  durationSeconds: number | null;
  metric: number | null;
  metrics: Record<string, number>;
  metricConflicts?: Array<{ name: string; values: number[] }>;
  command: string[];
  cwd: string;
  executor: string;
  createdAt: string;
  updatedAt: string;
}

export interface HarnessChangeRecord {
  id: string;
  contract: unknown;
  baselineComponents: Array<{ path: string; checksum: string }>;
  candidateComponents: Array<{ path: string; checksum: string }>;
  protocolFingerprint: string;
  outcomes: unknown[];
  decision: "retain" | "revert" | "branch" | "unobserved";
  createdAt: string;
  updatedAt: string;
}

export class ResearchStore {
  private readonly db: Database.Database;
  private memoryFtsAvailable = false;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    // Research lanes, tool traces, and controller heartbeats may use separate
    // store instances at the same time. WAL improves reader/writer overlap,
    // but SQLite still needs a bounded wait when another writer owns the
    // commit lock; without this, healthy parallel lanes can fail with a
    // misleading `database is locked` error.
    this.db.pragma("busy_timeout = 5000");
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        competition_id TEXT NOT NULL,
        config_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS workspace_identity (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        workspace_id TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        previous_hash TEXT,
        event_hash TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_events_type_id ON events(type, id);
      CREATE TABLE IF NOT EXISTS compute_reservations (
        experiment_id TEXT PRIMARY KEY,
        requested_gpu_hours REAL NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS event_chain_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        head_hash TEXT,
        event_count INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS hypotheses (
        id TEXT PRIMARY KEY,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS experiments (
        id TEXT PRIMARY KEY,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        experiment_id TEXT NOT NULL,
        status TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS run_attempts (
        id TEXT PRIMARY KEY,
        experiment_id TEXT NOT NULL,
        run_id TEXT,
        attempt INTEGER NOT NULL,
        stage TEXT NOT NULL,
        status TEXT NOT NULL,
        exit_code INTEGER,
        failure_class TEXT,
        duration_seconds REAL,
        metric REAL,
        metrics_json TEXT NOT NULL DEFAULT '{}',
        metric_conflicts_json TEXT NOT NULL DEFAULT '[]',
        command_json TEXT NOT NULL,
        cwd TEXT NOT NULL,
        executor TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS harness_changes (
        id TEXT PRIMARY KEY,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS artifacts (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        name TEXT NOT NULL,
        path TEXT NOT NULL,
        checksum TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS ensemble_candidates (
        id TEXT PRIMARY KEY,
        path TEXT NOT NULL,
        checksum TEXT NOT NULL,
        status TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS decisions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        decision_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS evidence_claims (
        id TEXT PRIMARY KEY,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS research_edges (
        id TEXT PRIMARY KEY,
        from_id TEXT NOT NULL,
        to_id TEXT NOT NULL,
        relation TEXT NOT NULL,
        confidence REAL NOT NULL,
        evidence_ids_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS research_sources (
        id TEXT PRIMARY KEY,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS scheduler_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        status TEXT NOT NULL,
        mode TEXT NOT NULL,
        current_step TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS experiment_gates (
        experiment_id TEXT PRIMARY KEY,
        leakage_audit_passed INTEGER NOT NULL DEFAULT 0,
        reviewer_approved INTEGER NOT NULL DEFAULT 0,
        notes TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS phase_goals (
        id TEXT PRIMARY KEY,
        phase TEXT NOT NULL,
        status TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS research_campaigns (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        payload_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS research_routines (
        id TEXT PRIMARY KEY,
        payload_json TEXT NOT NULL,
        status TEXT NOT NULL,
        next_run_at TEXT NOT NULL,
        lease_id TEXT,
        lease_expires_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS research_routine_runs (
        id TEXT PRIMARY KEY,
        routine_id TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        status TEXT NOT NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        exit_code INTEGER,
        error TEXT
      );
      CREATE TABLE IF NOT EXISTS agent_lanes (
        role TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        task TEXT,
        error TEXT,
        heartbeat_at TEXT,
        lease_id TEXT,
        started_at TEXT,
        budget_seconds REAL,
        used_seconds REAL NOT NULL DEFAULT 0,
        usage_calls INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS external_workers (
        worker_id TEXT PRIMARY KEY,
        workspace_id TEXT,
        role TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        status TEXT NOT NULL,
        capabilities_json TEXT NOT NULL DEFAULT '[]',
        capacity INTEGER,
        task TEXT,
        last_heartbeat_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS agent_controls (
        role TEXT PRIMARY KEY,
        paused INTEGER NOT NULL DEFAULT 0,
        terminated INTEGER NOT NULL DEFAULT 0,
        admitted INTEGER NOT NULL DEFAULT 0,
        admission_status TEXT NOT NULL DEFAULT 'review',
        contract_json TEXT,
        reason TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS queue_control (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        paused INTEGER NOT NULL DEFAULT 0,
        reason TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS attention_acknowledgements (
        item_id TEXT PRIMARY KEY,
        fingerprint TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        note TEXT,
        acknowledged_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS agent_sessions (
        role TEXT NOT NULL,
        scope_key TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        task_id TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (role, scope_key)
      );
      CREATE TABLE IF NOT EXISTS submissions (
        id TEXT PRIMARY KEY,
        experiment_id TEXT NOT NULL,
        path TEXT NOT NULL,
        status TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS work_queue (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        priority REAL NOT NULL,
        status TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        available_at TEXT NOT NULL,
        claimed_at TEXT,
        claim_token TEXT,
        owner_id TEXT,
        goal_id TEXT,
        parent_task_id TEXT,
        assignee_id TEXT,
        required_capabilities_json TEXT NOT NULL DEFAULT '[]',
        token_budget REAL,
        cost_budget_usd REAL,
        approval_status TEXT NOT NULL DEFAULT 'none',
        approval_reason TEXT,
        deadline_at TEXT,
        depends_on_json TEXT NOT NULL DEFAULT '[]',
        labels_json TEXT NOT NULL DEFAULT '[]',
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS controller_leases (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        controller_id TEXT NOT NULL,
        pid INTEGER NOT NULL,
        mode TEXT NOT NULL,
        current_step TEXT,
        status TEXT NOT NULL,
        requested_action TEXT,
        started_at TEXT NOT NULL,
        heartbeat_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS controller_steers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        message TEXT NOT NULL,
        created_at TEXT NOT NULL,
        applied_at TEXT
      );
      CREATE TABLE IF NOT EXISTS agent_directives (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_role TEXT,
        role TEXT NOT NULL,
        message TEXT NOT NULL,
        scope_key TEXT,
        created_at TEXT NOT NULL,
        applied_at TEXT,
        cancelled_at TEXT
      );
      CREATE TABLE IF NOT EXISTS external_action_intents (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        status TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS external_event_keys (
        event_type TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        event_id INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (event_type, idempotency_key)
      );
      CREATE TABLE IF NOT EXISTS trajectories (
        id TEXT PRIMARY KEY,
        run_id TEXT,
        experiment_id TEXT,
        payload_json TEXT NOT NULL,
        quality_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    this.db.prepare("INSERT OR IGNORE INTO workspace_identity (id, workspace_id, created_at) VALUES (1, ?, ?)").run(`ws_${randomUUID()}`, new Date().toISOString());
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_experiments_created_at ON experiments(created_at);
      CREATE INDEX IF NOT EXISTS idx_runs_updated_at ON runs(updated_at);
      CREATE INDEX IF NOT EXISTS idx_runs_experiment_id ON runs(experiment_id);
      CREATE INDEX IF NOT EXISTS idx_trajectories_updated_at ON trajectories(updated_at);
      CREATE INDEX IF NOT EXISTS idx_attempts_experiment_id ON run_attempts(experiment_id);
      CREATE INDEX IF NOT EXISTS idx_harness_changes_updated_at ON harness_changes(updated_at);
      CREATE INDEX IF NOT EXISTS idx_research_routines_due ON research_routines(status, next_run_at);
      CREATE INDEX IF NOT EXISTS idx_research_routine_runs_routine ON research_routine_runs(routine_id, started_at);
    `);
    // Existing stores predate event integrity. Keep them readable and mark their
    // history as legacy; all newly appended events are chained and verifiable.
    for (const column of ["previous_hash", "event_hash"]) {
      try { this.db.exec(`ALTER TABLE events ADD COLUMN ${column} TEXT`); } catch { /* already migrated */ }
    }
    try { this.db.exec("ALTER TABLE run_attempts ADD COLUMN metrics_json TEXT NOT NULL DEFAULT '{}'"); } catch { /* already migrated */ }
    try { this.db.exec("ALTER TABLE run_attempts ADD COLUMN metric_conflicts_json TEXT NOT NULL DEFAULT '[]'"); } catch { /* already migrated */ }
    try { this.db.exec("ALTER TABLE agent_lanes ADD COLUMN heartbeat_at TEXT"); } catch { /* already migrated */ }
    try { this.db.exec("ALTER TABLE external_workers ADD COLUMN workspace_id TEXT"); } catch { /* already migrated */ }
    try { this.db.exec("ALTER TABLE external_workers ADD COLUMN capacity INTEGER"); } catch { /* already migrated */ }
    try { this.db.exec("ALTER TABLE agent_lanes ADD COLUMN lease_id TEXT"); } catch { /* already migrated */ }
    try { this.db.exec("ALTER TABLE work_queue ADD COLUMN owner_id TEXT"); } catch { /* already migrated */ }
    try { this.db.exec("ALTER TABLE work_queue ADD COLUMN claim_token TEXT"); } catch { /* already migrated */ }
    try { this.db.exec("ALTER TABLE work_queue ADD COLUMN goal_id TEXT"); } catch { /* already migrated */ }
    try { this.db.exec("ALTER TABLE work_queue ADD COLUMN parent_task_id TEXT"); } catch { /* already migrated */ }
    try { this.db.exec("ALTER TABLE work_queue ADD COLUMN assignee_id TEXT"); } catch { /* already migrated */ }
    try { this.db.exec("ALTER TABLE work_queue ADD COLUMN token_budget REAL"); } catch { /* already migrated */ }
    try { this.db.exec("ALTER TABLE work_queue ADD COLUMN cost_budget_usd REAL"); } catch { /* already migrated */ }
    try { this.db.exec("ALTER TABLE work_queue ADD COLUMN approval_status TEXT NOT NULL DEFAULT 'none'"); } catch { /* already migrated */ }
    try { this.db.exec("ALTER TABLE work_queue ADD COLUMN approval_reason TEXT"); } catch { /* already migrated */ }
    try { this.db.exec("ALTER TABLE work_queue ADD COLUMN deadline_at TEXT"); } catch { /* already migrated */ }
    try { this.db.exec("ALTER TABLE work_queue ADD COLUMN depends_on_json TEXT NOT NULL DEFAULT '[]'"); } catch { /* already migrated */ }
    try { this.db.exec("ALTER TABLE work_queue ADD COLUMN required_capabilities_json TEXT NOT NULL DEFAULT '[]'"); } catch { /* already migrated */ }
    try { this.db.exec("ALTER TABLE work_queue ADD COLUMN labels_json TEXT NOT NULL DEFAULT '[]'"); } catch { /* already migrated */ }
    try { this.db.exec("ALTER TABLE agent_lanes ADD COLUMN started_at TEXT"); } catch { /* already migrated */ }
    try { this.db.exec("ALTER TABLE agent_lanes ADD COLUMN budget_seconds REAL"); } catch { /* already migrated */ }
    try { this.db.exec("ALTER TABLE agent_lanes ADD COLUMN used_seconds REAL NOT NULL DEFAULT 0"); } catch { /* already migrated */ }
    try { this.db.exec("ALTER TABLE agent_lanes ADD COLUMN usage_calls INTEGER NOT NULL DEFAULT 0"); } catch { /* already migrated */ }
    try { this.db.exec("ALTER TABLE agent_directives ADD COLUMN scope_key TEXT"); } catch { /* already migrated */ }
    try { this.db.exec("ALTER TABLE agent_directives ADD COLUMN cancelled_at TEXT"); } catch { /* already migrated */ }
    try { this.db.exec("ALTER TABLE agent_directives ADD COLUMN source_role TEXT"); } catch { /* already migrated */ }
    try { this.db.exec("ALTER TABLE agent_controls ADD COLUMN terminated INTEGER NOT NULL DEFAULT 0"); } catch { /* already migrated */ }
    try { this.db.exec("ALTER TABLE agent_controls ADD COLUMN admitted INTEGER NOT NULL DEFAULT 0"); } catch { /* already migrated */ }
    try { this.db.exec("ALTER TABLE agent_controls ADD COLUMN admission_status TEXT NOT NULL DEFAULT 'review'"); } catch { /* already migrated */ }
    try { this.db.exec("ALTER TABLE agent_controls ADD COLUMN contract_json TEXT"); } catch { /* already migrated */ }
    this.db.prepare(`
      INSERT OR IGNORE INTO event_chain_state (id, head_hash, event_count)
      VALUES (1, (SELECT event_hash FROM events ORDER BY id DESC LIMIT 1), (SELECT COUNT(*) FROM events))
    `).run();
    try {
      this.db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(kind UNINDEXED, item_id UNINDEXED, content, created_at UNINDEXED)");
      this.memoryFtsAvailable = true;
      const indexed = (this.db.prepare("SELECT COUNT(*) AS count FROM memory_fts").get() as { count: number }).count;
      if (indexed === 0) {
        const insert = this.db.prepare("INSERT INTO memory_fts (kind, item_id, content, created_at) VALUES (?, ?, ?, ?)");
        const backfill = this.db.transaction(() => {
          for (const row of this.db.prepare("SELECT id, payload_json, created_at FROM evidence_claims").all() as Array<{ id: string; payload_json: string; created_at: string }>) insert.run("claim", row.id, row.payload_json, row.created_at);
          for (const row of this.db.prepare("SELECT id, payload_json, created_at FROM hypotheses").all() as Array<{ id: string; payload_json: string; created_at: string }>) insert.run("hypothesis", row.id, row.payload_json, row.created_at);
          for (const row of this.db.prepare("SELECT id, payload_json, created_at FROM research_sources").all() as Array<{ id: string; payload_json: string; created_at: string }>) insert.run("source", row.id, row.payload_json, row.created_at);
        });
        backfill();
      }
    } catch {
      // Some SQLite builds omit FTS5; searchMemory retains a deterministic LIKE fallback.
      this.memoryFtsAvailable = false;
    }
  }

  close(): void {
    this.db.close();
  }

  /** Stable, non-secret identity for this durable workspace/control plane. */
  workspaceId(): string {
    const row = this.db.prepare("SELECT workspace_id AS workspaceId FROM workspace_identity WHERE id = 1").get() as { workspaceId: string } | undefined;
    if (!row?.workspaceId) throw new Error("Workspace identity is missing from the control plane.");
    return row.workspaceId;
  }

  /** Create a consistent SQLite backup while keeping the live store open. */
  async backup(destination: string): Promise<void> {
    mkdirSync(dirname(destination), { recursive: true });
    await this.db.backup(destination);
  }

  createProject(project: { id: string; name: string; competitionId: string; config: unknown }): void {
    this.db.prepare(`
      INSERT INTO projects (id, name, competition_id, config_json, created_at)
      VALUES (@id, @name, @competitionId, @configJson, @createdAt)
    `).run({
      id: project.id,
      name: project.name,
      competitionId: project.competitionId,
      configJson: safeJson(project.config),
      createdAt: new Date().toISOString(),
    });
    this.appendEvent("project.created", project);
  }

  project(): { id: string; name: string; competitionId: string; config: unknown } | undefined {
    const row = this.db.prepare("SELECT * FROM projects ORDER BY created_at DESC LIMIT 1").get() as {
      id: string; name: string; competition_id: string; config_json: string;
    } | undefined;
    if (!row) return undefined;
    return { id: row.id, name: row.name, competitionId: row.competition_id, config: JSON.parse(row.config_json) };
  }

  private appendEventRow(type: string, payload: unknown, createdAt = new Date().toISOString()): { eventId: number; createdAt: string } {
    const safePayload = redactStructured(payload);
    const payloadJson = JSON.stringify(safePayload);
    const previousHash = (this.db.prepare("SELECT event_hash AS eventHash FROM events ORDER BY id DESC LIMIT 1").get() as { eventHash: string | null } | undefined)?.eventHash ?? null;
    const eventHash = createHash("sha256").update(`${type}\0${payloadJson}\0${createdAt}\0${previousHash ?? ""}`).digest("hex");
    const result = this.db.prepare("INSERT INTO events (type, payload_json, created_at, previous_hash, event_hash) VALUES (?, ?, ?, ?, ?)").run(type, payloadJson, createdAt, previousHash, eventHash);
    this.db.prepare("UPDATE event_chain_state SET head_hash = ?, event_count = event_count + 1 WHERE id = 1").run(eventHash);
    return { eventId: Number(result.lastInsertRowid), createdAt };
  }

  appendEvent(type: string, payload: unknown): void {
    this.db.transaction(() => { this.appendEventRow(type, payload); })();
  }

  /** Append an external wake-up exactly once for a (type, idempotency key) pair. */
  appendExternalEvent(type: string, payload: unknown, idempotencyKey: string): { accepted: boolean; createdAt: string | null } {
    const key = idempotencyKey.trim();
    if (!key) throw new Error("External event idempotency key must not be empty.");
    if (key.length > 256) throw new Error("External event idempotency key must be at most 256 characters.");
    return this.db.transaction(() => {
      const existing = this.db.prepare("SELECT created_at AS createdAt FROM external_event_keys WHERE event_type = ? AND idempotency_key = ?").get(type, key) as { createdAt: string } | undefined;
      if (existing) return { accepted: false, createdAt: existing.createdAt };
      const event = this.appendEventRow(type, payload);
      this.db.prepare("INSERT INTO external_event_keys (event_type, idempotency_key, event_id, created_at) VALUES (?, ?, ?, ?)").run(type, key, event.eventId, event.createdAt);
      return { accepted: true, createdAt: event.createdAt };
    })();
  }

  verifyEventChain(): { status: "valid" | "legacy" | "invalid"; checked: number; legacy: number; brokenAt?: number; reason?: string } {
    const rows = this.db.prepare("SELECT id, type, payload_json, created_at, previous_hash, event_hash FROM events ORDER BY id ASC").all() as Array<{ id: number; type: string; payload_json: string; created_at: string; previous_hash: string | null; event_hash: string | null }>;
    const anchor = this.db.prepare("SELECT head_hash AS headHash, event_count AS eventCount FROM event_chain_state WHERE id = 1").get() as { headHash: string | null; eventCount: number } | undefined;
    if (anchor && anchor.eventCount !== rows.length) return { status: "invalid", checked: rows.length, legacy: rows.filter((row) => !row.event_hash).length, reason: "event count differs from the integrity anchor" };
    const lastHash = rows.at(-1)?.event_hash ?? null;
    if (anchor && anchor.headHash !== lastHash) return { status: "invalid", checked: rows.length, legacy: rows.filter((row) => !row.event_hash).length, reason: "event-chain head differs from the integrity anchor" };
    let previousHash: string | null = null;
    let legacy = 0;
    for (const row of rows) {
      if (!row.event_hash) {
        legacy += 1;
        previousHash = null;
        continue;
      }
      if (row.previous_hash !== previousHash && !(legacy > 0 && previousHash === null && row.previous_hash === null)) {
        return { status: "invalid", checked: rows.length, legacy, brokenAt: row.id, reason: "previous hash does not match the preceding event" };
      }
      const expected: string = createHash("sha256").update(`${row.type}\0${row.payload_json}\0${row.created_at}\0${row.previous_hash ?? ""}`).digest("hex");
      if (expected !== row.event_hash) {
        return { status: "invalid", checked: rows.length, legacy, brokenAt: row.id, reason: "event payload or metadata was modified" };
      }
      previousHash = row.event_hash;
    }
    return { status: legacy > 0 ? "legacy" : "valid", checked: rows.length, legacy };
  }

  eventCount(): number {
    return (this.db.prepare("SELECT COUNT(*) AS count FROM events").get() as { count: number }).count;
  }

  /** Read a bounded, append-only activity page for remote operators. */
  eventFeed(afterId = 0, limit = 100): Array<{ id: number; type: string; payload: unknown; createdAt: string; eventHash?: string | null }> {
    const cursor = Number.isInteger(afterId) && afterId >= 0 ? afterId : 0;
    const pageSize = Number.isInteger(limit) ? Math.max(1, Math.min(200, limit)) : 100;
    const rows = this.db.prepare("SELECT id, type, payload_json, created_at, event_hash FROM events WHERE id > ? ORDER BY id ASC LIMIT ?").all(cursor, pageSize) as Array<{ id: number; type: string; payload_json: string; created_at: string; event_hash: string | null }>;
    return rows.map((row) => ({ id: row.id, type: row.type, payload: JSON.parse(row.payload_json), createdAt: row.created_at, eventHash: row.event_hash }));
  }

  recentEvents(limit = 20): Array<{ type: string; payload: unknown; createdAt: string; eventHash?: string | null }> {
    const rows = this.db.prepare("SELECT type, payload_json, created_at, event_hash FROM events ORDER BY id DESC LIMIT ?").all(limit) as Array<{ type: string; payload_json: string; created_at: string; event_hash: string | null }>;
    return rows.reverse().map((row) => ({ type: row.type, payload: JSON.parse(row.payload_json), createdAt: row.created_at, eventHash: row.event_hash }));
  }

  /**
   * Read the durable history for one event family. This is intentionally
   * separate from recentEvents(): bounded UI timelines must not be used for
   * correctness decisions such as validation ratchets or recovery.
   */
  eventsByType(type: string, limit?: number): Array<{ type: string; payload: unknown; createdAt: string; eventHash?: string | null }> {
    const rows = limit === undefined
      ? this.db.prepare("SELECT type, payload_json, created_at, event_hash FROM events WHERE type = ? ORDER BY id ASC").all(type)
      : this.db.prepare("SELECT type, payload_json, created_at, event_hash FROM events WHERE type = ? ORDER BY id DESC LIMIT ?").all(type, Math.max(1, Math.floor(limit))).reverse();
    return (rows as Array<{ type: string; payload_json: string; created_at: string; event_hash: string | null }>).map((row) => ({ type: row.type, payload: JSON.parse(row.payload_json), createdAt: row.created_at, eventHash: row.event_hash }));
  }

  /** Record a bounded, durable work-item update for cross-agent recovery and handoff. */
  recordAgentActivity(input: { role: string; taskId?: string | null; kind: AgentActivityKind; message: string; metadata?: unknown }): void {
    const role = input.role.trim().slice(0, 160);
    const message = input.message.trim().slice(0, 2_000);
    if (!role || !message) return;
    this.appendEvent("agent.activity", {
      role,
      taskId: input.taskId?.trim().slice(0, 200) || null,
      kind: input.kind,
      message,
      ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
    });
  }

  /** Read recent work-item updates without exposing the raw event stream to callers. */
  agentActivities(options: { role?: string; taskId?: string; limit?: number } = {}): AgentActivity[] {
    const limit = Math.max(1, Math.min(128, Math.floor(options.limit ?? 32)));
    return this.eventsByType("agent.activity", limit).flatMap((event) => {
      const payload = event.payload && typeof event.payload === "object" ? event.payload as Record<string, unknown> : {};
      const role = typeof payload.role === "string" ? payload.role : "";
      const taskId = typeof payload.taskId === "string" ? payload.taskId : null;
      const kind = payload.kind;
      const message = typeof payload.message === "string" ? payload.message : "";
      if (!role || !message || !["started", "progress", "blocked", "handoff", "completed", "failed"].includes(String(kind))) return [];
      if (options.role && role !== options.role) return [];
      if (options.taskId && taskId !== options.taskId) return [];
      return [{ role, taskId, kind: kind as AgentActivityKind, message, metadata: payload.metadata ?? null, createdAt: event.createdAt }];
    });
  }

  /** Return a provider thread only when it belongs to the exact role/scope/route. */
  agentSession(role: string, scopeKey: string, provider: string, model: string): AgentSession | undefined {
    const row = this.db.prepare("SELECT role, scope_key, provider, model, thread_id, task_id, updated_at FROM agent_sessions WHERE role = ? AND scope_key = ? AND provider = ? AND model = ?").get(role, scopeKey, provider, model) as { role: string; scope_key: string; provider: string; model: string; thread_id: string; task_id: string | null; updated_at: string } | undefined;
    return row ? { role: row.role, scopeKey: row.scope_key, provider: row.provider, model: row.model, threadId: row.thread_id, taskId: row.task_id, updatedAt: row.updated_at } : undefined;
  }

  /** Persist a resumable provider thread without allowing it to cross campaign scopes. */
  saveAgentSession(input: { role: string; scopeKey: string; provider: string; model: string; threadId: string; taskId?: string | null }): void {
    const role = input.role.trim().slice(0, 160);
    const scopeKey = input.scopeKey.trim().slice(0, 240);
    const provider = input.provider.trim().slice(0, 80);
    const model = input.model.trim().slice(0, 160);
    const threadId = input.threadId.trim().slice(0, 240);
    if (!role || !scopeKey || !provider || !model || !threadId) return;
    const now = new Date().toISOString();
    this.db.prepare("INSERT INTO agent_sessions (role, scope_key, provider, model, thread_id, task_id, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(role, scope_key) DO UPDATE SET provider = excluded.provider, model = excluded.model, thread_id = excluded.thread_id, task_id = excluded.task_id, updated_at = excluded.updated_at").run(role, scopeKey, provider, model, threadId, input.taskId?.trim().slice(0, 200) || null, now);
    this.appendEvent("agent.session.saved", { role, scopeKey, provider, model, taskId: input.taskId ?? null });
  }

  /** Invalidate a provider thread after an explicit route/session failure. */
  clearAgentSession(role: string, scopeKey: string, reason = "session invalidated"): boolean {
    const result = this.db.prepare("DELETE FROM agent_sessions WHERE role = ? AND scope_key = ?").run(role, scopeKey);
    if (result.changes) this.appendEvent("agent.session.cleared", { role, scopeKey, reason });
    return result.changes === 1;
  }

  agentSessions(limit = 32): AgentSession[] {
    const rows = this.db.prepare("SELECT role, scope_key, provider, model, thread_id, task_id, updated_at FROM agent_sessions ORDER BY updated_at DESC LIMIT ?").all(Math.max(1, Math.min(128, Math.floor(limit)))) as Array<{ role: string; scope_key: string; provider: string; model: string; thread_id: string; task_id: string | null; updated_at: string }>;
    return rows.map((row) => ({ role: row.role, scopeKey: row.scope_key, provider: row.provider, model: row.model, threadId: row.thread_id, taskId: row.task_id, updatedAt: row.updated_at }));
  }

  /** Read structured subtask audits from the complete event history. */
  subtaskAudits(subtaskId?: string): Array<{ subtaskId: string; complete: boolean; status: string; payload: unknown; createdAt: string }> {
    return this.eventsByType("subtask.audit").flatMap((event) => {
      const payload = event.payload as { subtaskId?: unknown; complete?: unknown; status?: unknown; criteria?: unknown };
      if (typeof payload.subtaskId !== "string" || (subtaskId !== undefined && payload.subtaskId !== subtaskId)) return [];
      const hasFingerprintState = Array.isArray(payload.criteria) && Array.isArray((payload as { unmetRequired?: unknown }).unmetRequired) && typeof payload.complete === "boolean";
      const fingerprintValid = typeof (payload as { stateFingerprint?: unknown }).stateFingerprint !== "string"
        || (hasFingerprintState && (payload as { stateFingerprint: string }).stateFingerprint === subtaskAuditFingerprint(payload as Parameters<typeof subtaskAuditFingerprint>[0]));
      const grounded = fingerprintValid && Array.isArray(payload.criteria) && payload.criteria.every((criterion) => {
        if (!criterion || typeof criterion !== "object") return false;
        const value = criterion as { satisfied?: unknown; evidenceIds?: unknown };
        if (value.satisfied !== true) return true;
        return Array.isArray(value.evidenceIds) && value.evidenceIds.length > 0
          && value.evidenceIds.every((reference) => typeof reference === "string" && this.evidenceReferenceExists(reference));
      });
      const complete = payload.complete === true && grounded;
      return [{ subtaskId: payload.subtaskId, complete, status: complete ? "completed" : "blocked", payload: event.payload, createdAt: event.createdAt }];
    });
  }

  latestSubtaskAudit(subtaskId: string): { subtaskId: string; complete: boolean; status: string; payload: unknown; createdAt: string } | undefined {
    return this.subtaskAudits(subtaskId).at(-1);
  }

  eventsByTypes(types: string[]): Array<{ type: string; payload: unknown; createdAt: string; eventHash?: string | null }> {
    const uniqueTypes = [...new Set(types.filter((type) => type.trim()))];
    if (!uniqueTypes.length) return [];
    const placeholders = uniqueTypes.map(() => "?").join(", ");
    const rows = this.db.prepare(`SELECT type, payload_json, created_at, event_hash FROM events WHERE type IN (${placeholders}) ORDER BY id ASC`).all(...uniqueTypes) as Array<{ type: string; payload_json: string; created_at: string; event_hash: string | null }>;
    return rows.map((row) => ({ type: row.type, payload: JSON.parse(row.payload_json), createdAt: row.created_at, eventHash: row.event_hash }));
  }

  /** Atomically reserve remaining campaign GPU budget for one worker. */
  reserveComputeBudget(input: { experimentId: string; budgetGpuHours: number; usedGpuHours: number; requestedGpuHours: number; gpu?: string }): { allowed: boolean; reservedGpuHours: number; remainingGpuHours: number; reason: string } {
    const requested = Math.max(0, Number.isFinite(input.requestedGpuHours) ? input.requestedGpuHours : 0);
    const budget = Math.max(0, Number.isFinite(input.budgetGpuHours) ? input.budgetGpuHours : 0);
    const used = Math.max(0, Number.isFinite(input.usedGpuHours) ? input.usedGpuHours : 0);
    if (!input.gpu || requested === 0 || budget === 0) return { allowed: true, reservedGpuHours: 0, remainingGpuHours: Math.max(0, budget - used), reason: "no bounded GPU reservation is required" };
    const now = new Date().toISOString();
    const result = this.db.transaction(() => {
      const active = (this.db.prepare("SELECT COALESCE(SUM(requested_gpu_hours), 0) AS hours FROM compute_reservations WHERE status = 'reserved'").get() as { hours: number }).hours;
      const existing = this.db.prepare("SELECT status, requested_gpu_hours FROM compute_reservations WHERE experiment_id = ?").get(input.experimentId) as { status: string; requested_gpu_hours: number } | undefined;
      if (existing?.status === "reserved") return { allowed: true, reservedGpuHours: active, remainingGpuHours: Math.max(0, budget - used - active), reason: "GPU budget was already reserved for this experiment" };
      const remaining = Math.max(0, budget - used - active);
      if (requested > remaining + 1e-9) return { allowed: false, reservedGpuHours: active, remainingGpuHours: remaining, reason: `requested ${requested} GPU-hours exceeds the ${remaining} GPU-hours available after active reservations` };
      this.db.prepare("INSERT OR REPLACE INTO compute_reservations (experiment_id, requested_gpu_hours, status, created_at, updated_at) VALUES (?, ?, 'reserved', COALESCE((SELECT created_at FROM compute_reservations WHERE experiment_id = ?), ?), ?)").run(input.experimentId, requested, input.experimentId, now, now);
      return { allowed: true, reservedGpuHours: active + requested, remainingGpuHours: Math.max(0, remaining - requested), reason: "GPU budget atomically reserved" };
    })() as { allowed: boolean; reservedGpuHours: number; remainingGpuHours: number; reason: string };
    this.appendEvent(result.allowed ? "compute.budget.reserved" : "compute.budget.rejected", { experimentId: input.experimentId, requestedGpuHours: requested, ...result });
    return result;
  }

  releaseComputeReservation(experimentId: string, reason = "experiment terminal"): boolean {
    const now = new Date().toISOString();
    const result = this.db.prepare("UPDATE compute_reservations SET status = 'released', updated_at = ? WHERE experiment_id = ? AND status = 'reserved'").run(now, experimentId);
    if (result.changes === 1) this.appendEvent("compute.budget.released", { experimentId, reason });
    return result.changes === 1;
  }

  reservedComputeGpuHours(): number {
    return (this.db.prepare("SELECT COALESCE(SUM(requested_gpu_hours), 0) AS hours FROM compute_reservations WHERE status = 'reserved'").get() as { hours: number }).hours;
  }

  saveExperiment(experiment: { id: string; payload: unknown }): void {
    const existing = this.db.prepare("SELECT payload_json FROM experiments WHERE id = ?").get(experiment.id) as { payload_json: string } | undefined;
    const now = new Date().toISOString();
    const safePayload = redactStructured(experiment.payload);
    if (existing) {
      const previousManifest = registeredManifest(JSON.parse(existing.payload_json));
      const nextManifest = registeredManifest(safePayload);
      if (previousManifest && nextManifest && JSON.stringify(canonicalValue(previousManifest)) !== JSON.stringify(canonicalValue(nextManifest))) {
        this.appendEvent("experiment.manifest.mutation.rejected", { id: experiment.id, reason: "pre-registered manifest is immutable", fields: IMMUTABLE_MANIFEST_FIELDS.filter((field) => JSON.stringify(canonicalValue(previousManifest[field])) !== JSON.stringify(canonicalValue(nextManifest[field]))) });
        throw new Error(`Experiment ${experiment.id} has an immutable pre-registered manifest; create a new experiment for protocol changes.`);
      }
    }
    this.db.prepare(`
      INSERT INTO experiments (id, payload_json, created_at)
      VALUES (?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET payload_json = excluded.payload_json
    `).run(experiment.id, JSON.stringify(safePayload), now);
    const status = (safePayload as { status?: unknown }).status;
    if (["completed", "failed", "invalid", "rejected", "cancelled", "blocked"].includes(String(status))) this.releaseComputeReservation(experiment.id, `experiment status ${String(status)}`);
    this.appendEvent(existing ? "experiment.updated" : "experiment.created", { id: experiment.id, payload: safePayload });
  }

  saveHypothesis(hypothesis: { id: string; payload: unknown }): void {
    const createdAt = new Date().toISOString();
    const payload = safeJson(hypothesis.payload);
    this.db.prepare(`INSERT OR REPLACE INTO hypotheses (id, payload_json, created_at) VALUES (?, ?, ?)`).run(hypothesis.id, payload, createdAt);
    this.indexMemory("hypothesis", hypothesis.id, payload, createdAt);
    this.appendEvent("hypothesis.created", hypothesis.payload);
  }

  saveRun(run: { id: string; experimentId: string; status: string; payload: unknown }): void {
    const now = new Date().toISOString();
    this.db.prepare(`INSERT OR REPLACE INTO runs (id, experiment_id, status, payload_json, created_at, updated_at) VALUES (?, ?, ?, ?, COALESCE((SELECT created_at FROM runs WHERE id = ?), ?), ?)`)
      .run(run.id, run.experimentId, run.status, safeJson(run.payload), run.id, now, now);
    this.appendEvent(`run.${run.status}`, { id: run.id, experimentId: run.experimentId, payload: run.payload });
  }

  recordRunAttempt(attempt: {
    id: string;
    experimentId: string;
    runId?: string | null;
    attempt: number;
    stage: string;
    status: string;
    exitCode?: number | null;
    failureClass?: string | null;
    durationSeconds?: number | null;
    metric?: number | null;
    metrics?: Record<string, number>;
    metricConflicts?: Array<{ name: string; values: number[] }>;
    command: string[];
    cwd: string;
    executor: string;
  }): void {
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO run_attempts (id, experiment_id, run_id, attempt, stage, status, exit_code, failure_class, duration_seconds, metric, metrics_json, metric_conflicts_json, command_json, cwd, executor, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET run_id = excluded.run_id, status = excluded.status, exit_code = excluded.exit_code,
        failure_class = excluded.failure_class, duration_seconds = excluded.duration_seconds, metric = excluded.metric,
        metrics_json = excluded.metrics_json, metric_conflicts_json = excluded.metric_conflicts_json, command_json = excluded.command_json, cwd = excluded.cwd, executor = excluded.executor, updated_at = excluded.updated_at
    `).run(attempt.id, attempt.experimentId, attempt.runId ?? null, attempt.attempt, attempt.stage, attempt.status, attempt.exitCode ?? null, attempt.failureClass ?? null, attempt.durationSeconds ?? null, attempt.metric ?? null, safeJson(attempt.metrics ?? {}), safeJson(attempt.metricConflicts ?? []), safeJson(redactCommand(attempt.command)), attempt.cwd, attempt.executor, now, now);
  }

  runAttempts(experimentId?: string): RunAttempt[] {
    const query = experimentId
      ? this.db.prepare("SELECT * FROM run_attempts WHERE experiment_id = ? ORDER BY attempt ASC, created_at ASC")
      : this.db.prepare("SELECT * FROM run_attempts ORDER BY created_at ASC");
    const rows = (query.all(...(experimentId ? [experimentId] : [])) as Array<Record<string, unknown>>);
    return rows.map((row) => ({
      id: String(row.id), experimentId: String(row.experiment_id), runId: row.run_id === null ? null : String(row.run_id), attempt: Number(row.attempt), stage: String(row.stage), status: String(row.status),
      exitCode: row.exit_code === null ? null : Number(row.exit_code), failureClass: row.failure_class === null ? null : String(row.failure_class), durationSeconds: row.duration_seconds === null ? null : Number(row.duration_seconds), metric: row.metric === null ? null : Number(row.metric), metrics: row.metrics_json ? JSON.parse(String(row.metrics_json)) as Record<string, number> : {},
      metricConflicts: row.metric_conflicts_json ? JSON.parse(String(row.metric_conflicts_json)) as Array<{ name: string; values: number[] }> : [], command: JSON.parse(String(row.command_json)) as string[], cwd: String(row.cwd), executor: String(row.executor), createdAt: String(row.created_at), updatedAt: String(row.updated_at),
    }));
  }

  /** Persist a harness evolution record independently of transient benchmark output files. */
  saveHarnessChange(change: Omit<HarnessChangeRecord, "createdAt" | "updatedAt">): void {
    const now = new Date().toISOString();
    const payload = {
      id: change.id,
      contract: change.contract,
      baselineComponents: change.baselineComponents,
      candidateComponents: change.candidateComponents,
      protocolFingerprint: change.protocolFingerprint,
      outcomes: change.outcomes,
      decision: change.decision,
    };
    this.db.prepare(`
      INSERT INTO harness_changes (id, payload_json, created_at, updated_at)
      VALUES (?, ?, COALESCE((SELECT created_at FROM harness_changes WHERE id = ?), ?), ?)
      ON CONFLICT(id) DO UPDATE SET payload_json = excluded.payload_json, updated_at = excluded.updated_at
    `).run(change.id, safeJson(payload), change.id, now, now);
    this.appendEvent("harness.change.recorded", payload);
  }

  harnessChanges(): HarnessChangeRecord[] {
    const rows = this.db.prepare("SELECT payload_json, created_at, updated_at FROM harness_changes ORDER BY updated_at ASC").all() as Array<{ payload_json: string; created_at: string; updated_at: string }>;
    return rows.flatMap((row) => {
      try {
        const payload = JSON.parse(row.payload_json) as Omit<HarnessChangeRecord, "createdAt" | "updatedAt">;
        if (!payload || typeof payload !== "object" || typeof payload.id !== "string" || !Array.isArray(payload.baselineComponents) || !Array.isArray(payload.candidateComponents) || typeof payload.protocolFingerprint !== "string" || !Array.isArray(payload.outcomes) || !["retain", "revert", "branch", "unobserved"].includes(payload.decision)) return [];
        return [{ ...payload, decision: payload.decision as HarnessChangeRecord["decision"], createdAt: row.created_at, updatedAt: row.updated_at }];
      } catch { return []; }
    });
  }

  saveArtifact(artifact: { id: string; runId: string; name: string; path: string; checksum: string }): void {
    this.db.prepare(`INSERT OR REPLACE INTO artifacts (id, run_id, name, path, checksum, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(artifact.id, artifact.runId, artifact.name, artifact.path, artifact.checksum, new Date().toISOString());
    this.appendEvent("artifact.created", artifact);
  }

  saveEnsembleCandidate(candidate: { id: string; path: string; checksum: string; status: string; payload: unknown }): void {
    const now = new Date().toISOString();
    this.db.prepare(`INSERT OR REPLACE INTO ensemble_candidates (id, path, checksum, status, payload_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, COALESCE((SELECT created_at FROM ensemble_candidates WHERE id = ?), ?), ?)`).run(candidate.id, candidate.path, candidate.checksum, candidate.status, safeJson(candidate.payload), candidate.id, now, now);
    this.appendEvent("ensemble.candidate.recorded", { id: candidate.id, path: candidate.path, checksum: candidate.checksum, status: candidate.status });
  }

  updateEnsembleCandidateStatus(id: string, status: "candidate" | "validated" | "promoted" | "rejected", payload?: unknown): boolean {
    const current = this.db.prepare("SELECT status, payload_json FROM ensemble_candidates WHERE id = ?").get(id) as { status: string; payload_json: string } | undefined;
    if (!current) return false;
    const allowed: Record<string, string[]> = { candidate: ["validated", "rejected"], validated: ["promoted", "rejected"], promoted: [], rejected: [] };
    if (!allowed[current.status]?.includes(status)) throw new Error(`Invalid ensemble transition ${current.status} -> ${status}.`);
    const now = new Date().toISOString();
    const basePayload = payload ?? JSON.parse(current.payload_json);
    const nextPayload = basePayload && typeof basePayload === "object" && !Array.isArray(basePayload) ? { ...(basePayload as Record<string, unknown>), status } : { status, value: basePayload };
    this.db.prepare("UPDATE ensemble_candidates SET status = ?, payload_json = ?, updated_at = ? WHERE id = ?").run(status, safeJson(nextPayload), now, id);
    this.appendEvent("ensemble.candidate.status", { id, from: current.status, status, payload: nextPayload });
    return true;
  }

  ensembleCandidates(limit = 100): Array<{ id: string; path: string; checksum: string; status: string; payload: unknown; createdAt: string; updatedAt: string }> {
    const rows = this.db.prepare("SELECT id, path, checksum, status, payload_json, created_at, updated_at FROM ensemble_candidates ORDER BY updated_at DESC LIMIT ?").all(Math.max(1, Math.min(limit, 1000))) as Array<{ id: string; path: string; checksum: string; status: string; payload_json: string; created_at: string; updated_at: string }>;
    return rows.map((row) => ({ id: row.id, path: row.path, checksum: row.checksum, status: row.status, payload: JSON.parse(row.payload_json), createdAt: row.created_at, updatedAt: row.updated_at }));
  }

  savePhaseGoal(goal: { id: string; phase: string; status: string; payload: unknown }): void {
    const now = new Date().toISOString();
    const existing = this.db.prepare("SELECT payload_json FROM phase_goals WHERE id = ?").get(goal.id) as { payload_json: string } | undefined;
    const previousFingerprint = existing ? phasePlanFingerprint(JSON.parse(existing.payload_json)) : undefined;
    const nextFingerprint = phasePlanFingerprint(goal.payload);
    this.db.prepare(
      `INSERT OR REPLACE INTO phase_goals (id, phase, status, payload_json, created_at, updated_at) VALUES (?, ?, ?, ?, COALESCE((SELECT created_at FROM phase_goals WHERE id = ?), ?), ?)`,
    )
      .run(goal.id, goal.phase, goal.status, safeJson(goal.payload), goal.id, now, now);
    if (previousFingerprint && previousFingerprint !== nextFingerprint) {
      const revision = this.eventsByType("phase_goal.revised").filter((event) => (event.payload as { goalId?: unknown }).goalId === goal.id).length + 1;
      this.appendEvent("phase_goal.revised", { goalId: goal.id, phase: goal.phase, revision, previousFingerprint, fingerprint: nextFingerprint, plan: phasePlanProjection(goal.payload) });
    }
    this.appendEvent("phase_goal.updated", goal.payload);
  }

  /** Resolve an audit reference against durable controller-owned evidence. */
  evidenceReferenceExists(reference: string): boolean {
    const id = reference.trim();
    if (!id) return false;
    if (this.eventsByType(id, 1).length > 0) return true;
    const prefixed = id.match(/^(event|run|artifact|claim|source|hypothesis|submission):(.+)$/);
    const value = prefixed?.[2] ?? id;
    const references = [...new Set([id, value])];
    if (prefixed?.[1] === "event") return this.eventsByType(value, 1).length > 0;
    if (prefixed?.[1] === "run" || !prefixed) {
      if (references.some((reference) => this.db.prepare("SELECT 1 FROM runs WHERE id = ? LIMIT 1").get(reference))) return true;
    }
    if (prefixed?.[1] === "artifact" || !prefixed) {
      if (references.some((reference) => this.db.prepare("SELECT 1 FROM artifacts WHERE id = ? OR path = ? OR name = ? OR checksum = ? LIMIT 1").get(reference, reference, reference, reference))) return true;
    }
    if (prefixed?.[1] === "claim" || !prefixed) {
      if (references.some((reference) => this.db.prepare("SELECT 1 FROM evidence_claims WHERE id = ? LIMIT 1").get(reference))) return true;
    }
    if (prefixed?.[1] === "source" || !prefixed) {
      if (references.some((reference) => this.db.prepare("SELECT 1 FROM research_sources WHERE id = ? LIMIT 1").get(reference))) return true;
    }
    if (prefixed?.[1] === "hypothesis" || !prefixed) {
      if (references.some((reference) => this.db.prepare("SELECT 1 FROM hypotheses WHERE id = ? LIMIT 1").get(reference))) return true;
    }
    if (prefixed?.[1] === "submission" || !prefixed) {
      if (references.some((reference) => this.db.prepare("SELECT 1 FROM submissions WHERE id = ? LIMIT 1").get(reference))) return true;
    }
    return id === "subtask.audit:complete" && this.eventsByType("subtask.audit", 1).some((event) => (event.payload as { complete?: unknown }).complete === true);
  }

  /** Persist the controller's structured subtask audit as first-class evidence. */
  recordSubtaskAudit(audit: unknown): void {
    if (audit && typeof audit === "object" && !Array.isArray(audit)) {
      const payload = audit as { criteria?: unknown; stateFingerprint?: unknown };
      if (typeof payload.stateFingerprint === "string" && (!Array.isArray(payload.criteria) || !Array.isArray((audit as { unmetRequired?: unknown }).unmetRequired) || typeof (audit as { complete?: unknown }).complete !== "boolean" || payload.stateFingerprint !== subtaskAuditFingerprint(audit as Parameters<typeof subtaskAuditFingerprint>[0]))) throw new Error("Subtask audit state fingerprint does not match its criteria.");
      if (Array.isArray(payload.criteria)) {
        const missing = payload.criteria.flatMap((criterion) => {
          if (!criterion || typeof criterion !== "object") return [];
          const value = criterion as { satisfied?: unknown; evidenceIds?: unknown };
          if (value.satisfied !== true || !Array.isArray(value.evidenceIds)) return [];
          return value.evidenceIds.filter((reference): reference is string => typeof reference === "string" && !this.evidenceReferenceExists(reference));
        });
        if (missing.length) throw new Error(`Subtask audit references unavailable evidence: ${[...new Set(missing)].join(", ")}`);
      }
    }
    this.appendEvent("subtask.audit", audit);
  }

  saveCampaign(campaign: unknown): void {
    const updatedAt = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO research_campaigns (id, payload_json, updated_at) VALUES (1, ?, ?)
      ON CONFLICT(id) DO UPDATE SET payload_json = excluded.payload_json, updated_at = excluded.updated_at
    `).run(safeJson(campaign), updatedAt);
    this.appendEvent("research.campaign.updated", campaign);
  }

  campaign(): unknown | undefined {
    const row = this.db.prepare("SELECT payload_json FROM research_campaigns WHERE id = 1").get() as { payload_json: string } | undefined;
    return row ? JSON.parse(row.payload_json) : undefined;
  }

  /**
   * Reconstruct one bounded summary per campaign run from the immutable
   * campaign-update stream. The singleton snapshot remains the live control
   * surface; this projection makes older runs discoverable after a new run
   * replaces that snapshot.
   */
  campaignHistory(limit = 32): Array<{ startedAt: string; status: string; campaign: Record<string, unknown>; updatedAt: string }> {
    const latest = new Map<string, { startedAt: string; status: string; campaign: Record<string, unknown>; updatedAt: string }>();
    for (const event of this.eventsByType("research.campaign.updated")) {
      if (!event.payload || typeof event.payload !== "object" || Array.isArray(event.payload)) continue;
      const campaign = event.payload as Record<string, unknown>;
      if (typeof campaign.startedAt !== "string" || !campaign.startedAt.trim()) continue;
      latest.set(campaign.startedAt, {
        startedAt: campaign.startedAt,
        status: typeof campaign.status === "string" ? campaign.status : "unknown",
        campaign,
        updatedAt: event.createdAt,
      });
    }
    return [...latest.values()]
      .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
      .slice(0, Math.max(1, Math.min(128, Math.floor(limit))));
  }

  saveTrajectory(trajectory: { id: string; runId?: string | null; experimentId?: string | null; payload: unknown; quality: unknown }): void {
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO trajectories (id, run_id, experiment_id, payload_json, quality_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, COALESCE((SELECT created_at FROM trajectories WHERE id = ?), ?), ?)
      ON CONFLICT(id) DO UPDATE SET run_id = excluded.run_id, experiment_id = excluded.experiment_id,
        payload_json = excluded.payload_json, quality_json = excluded.quality_json, updated_at = excluded.updated_at
    `).run(trajectory.id, trajectory.runId ?? null, trajectory.experimentId ?? null, safeJson(trajectory.payload), safeJson(trajectory.quality), trajectory.id, now, now);
    this.appendEvent("trajectory.recorded", { id: trajectory.id, runId: trajectory.runId, experimentId: trajectory.experimentId });
  }

  trajectories(limit = 100): Array<{ id: string; runId: string | null; experimentId: string | null; payload: unknown; quality: unknown; createdAt: string; updatedAt: string }> {
    const rows = this.db.prepare("SELECT id, run_id, experiment_id, payload_json, quality_json, created_at, updated_at FROM trajectories ORDER BY updated_at DESC LIMIT ?").all(Math.max(1, Math.min(limit, 1000))) as Array<{ id: string; run_id: string | null; experiment_id: string | null; payload_json: string; quality_json: string; created_at: string; updated_at: string }>;
    return rows.map((row) => ({ id: row.id, runId: row.run_id, experimentId: row.experiment_id, payload: JSON.parse(row.payload_json), quality: JSON.parse(row.quality_json), createdAt: row.created_at, updatedAt: row.updated_at }));
  }

  /** Complete trajectory history for durable learning/export paths. */
  trajectoryHistory(): Array<{ id: string; runId: string | null; experimentId: string | null; payload: unknown; quality: unknown; createdAt: string; updatedAt: string }> {
    const rows = this.db.prepare("SELECT id, run_id, experiment_id, payload_json, quality_json, created_at, updated_at FROM trajectories ORDER BY updated_at ASC").all() as Array<{ id: string; run_id: string | null; experiment_id: string | null; payload_json: string; quality_json: string; created_at: string; updated_at: string }>;
    return rows.map((row) => ({ id: row.id, runId: row.run_id, experimentId: row.experiment_id, payload: JSON.parse(row.payload_json), quality: JSON.parse(row.quality_json), createdAt: row.created_at, updatedAt: row.updated_at }));
  }

  private readControllerLease(): ControllerLease | undefined {
    const row = this.db.prepare("SELECT controller_id, pid, mode, current_step, status, requested_action, started_at, heartbeat_at, updated_at FROM controller_leases WHERE id = 1").get() as {
      controller_id: string; pid: number; mode: string; current_step: string | null; status: ControllerLease["status"];
      requested_action: ControllerAction | null; started_at: string; heartbeat_at: string; updated_at: string;
    } | undefined;
    return row ? {
      controllerId: row.controller_id, pid: row.pid, mode: row.mode, currentStep: row.current_step,
      status: row.status, requestedAction: row.requested_action, startedAt: row.started_at,
      heartbeatAt: row.heartbeat_at, updatedAt: row.updated_at,
    } : undefined;
  }

  private pidAlive(pid: number): boolean {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try { process.kill(pid, 0); return true; } catch { return false; }
  }

  controllerLease(): ControllerLease | undefined { return this.readControllerLease(); }

  liveControllerLease(staleAfterMs = 30_000): ControllerLease | undefined {
    const lease = this.readControllerLease();
    if (!lease || lease.status !== "running") return undefined;
    const fresh = Date.now() - Date.parse(lease.heartbeatAt) <= staleAfterMs;
    return fresh && this.pidAlive(lease.pid) ? lease : undefined;
  }

  acquireControllerLease(controllerId: string, pid: number, mode: string, currentStep: string | null = null, staleAfterMs = 30_000): { acquired: boolean; lease?: ControllerLease } {
    const now = new Date().toISOString();
    const transaction = this.db.transaction(() => {
      const existing = this.readControllerLease();
      if (existing && existing.controllerId !== controllerId && existing.status === "running") {
        const fresh = Date.now() - Date.parse(existing.heartbeatAt) <= staleAfterMs;
        if (fresh && this.pidAlive(existing.pid)) return { acquired: false, lease: existing };
        this.appendEvent("controller.lease.stale", existing);
      }
      this.db.prepare(`
        INSERT INTO controller_leases (id, controller_id, pid, mode, current_step, status, requested_action, started_at, heartbeat_at, updated_at)
        VALUES (1, ?, ?, ?, ?, 'running', NULL, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET controller_id = excluded.controller_id, pid = excluded.pid, mode = excluded.mode,
          current_step = excluded.current_step, status = 'running', requested_action = NULL, started_at = excluded.started_at,
          heartbeat_at = excluded.heartbeat_at, updated_at = excluded.updated_at
      `).run(controllerId, pid, mode, currentStep, now, now, now);
      this.appendEvent("controller.lease.acquired", { controllerId, pid, mode, currentStep });
      return { acquired: true, lease: this.readControllerLease() };
    });
    return transaction() as { acquired: boolean; lease?: ControllerLease };
  }

  heartbeatControllerLease(controllerId: string, mode: string, currentStep: string | null = null): boolean {
    const now = new Date().toISOString();
    const result = this.db.prepare("UPDATE controller_leases SET mode = ?, current_step = ?, heartbeat_at = ?, updated_at = ? WHERE id = 1 AND controller_id = ? AND status = 'running'").run(mode, currentStep, now, now, controllerId);
    return result.changes === 1;
  }

  requestControllerAction(action: ControllerAction, actorId = "operator"): ControllerLease | undefined {
    const now = new Date().toISOString();
    const current = this.readControllerLease();
    if (!current || current.status !== "running") return undefined;
    if (current.requestedAction === action) return current;
    this.db.prepare("UPDATE controller_leases SET requested_action = ?, updated_at = ? WHERE id = 1 AND status = 'running'").run(action, now);
    const lease = this.readControllerLease();
    if (lease?.status === "running") this.appendEvent("controller.action.requested", { action, controllerId: lease.controllerId, pid: lease.pid, actorId: actorId.trim().slice(0, 200) || "operator" });
    return lease;
  }

  enqueueControllerSteer(message: string): ControllerSteer | undefined {
    const normalized = message.trim();
    if (!normalized) return undefined;
    const lease = this.liveControllerLease();
    if (!lease) return undefined;
    const createdAt = new Date().toISOString();
    const result = this.db.prepare("INSERT INTO controller_steers (message, created_at) VALUES (?, ?)").run(normalized, createdAt);
    this.appendEvent("controller.steer.queued", { id: Number(result.lastInsertRowid), controllerId: lease.controllerId, message: normalized });
    return { id: Number(result.lastInsertRowid), message: normalized, createdAt, appliedAt: null };
  }

  consumeControllerSteers(limit = 8): ControllerSteer[] {
    const now = new Date().toISOString();
    const transaction = this.db.transaction(() => {
      const rows = this.db.prepare("SELECT id, message, created_at, applied_at FROM controller_steers WHERE applied_at IS NULL ORDER BY id ASC LIMIT ?").all(Math.max(1, Math.min(32, limit))) as Array<{ id: number; message: string; created_at: string; applied_at: string | null }>;
      if (!rows.length) return [];
      const mark = this.db.prepare("UPDATE controller_steers SET applied_at = ? WHERE id = ? AND applied_at IS NULL");
      const consumed: ControllerSteer[] = [];
      for (const row of rows) {
        if (mark.run(now, row.id).changes !== 1) continue;
        consumed.push({ id: row.id, message: row.message, createdAt: row.created_at, appliedAt: now });
      }
      return consumed;
    });
    const consumed = transaction() as ControllerSteer[];
    if (consumed.length) this.appendEvent("controller.steer.applied", { ids: consumed.map((item) => item.id), messages: consumed.map((item) => item.message) });
    return consumed;
  }

  enqueueAgentDirective(role: string, message: string, scopeKey: string | null = null, sourceRole: string | null = null): AgentDirective {
    const normalizedRole = role.trim();
    const normalizedMessage = message.trim();
    if (!normalizedRole || !normalizedMessage) throw new Error("Agent role and directive message are required.");
    const createdAt = new Date().toISOString();
    const normalizedScope = scopeKey?.trim() || null;
    const normalizedSource = sourceRole?.trim().slice(0, 120) || null;
    const result = this.db.prepare("INSERT INTO agent_directives (source_role, role, message, scope_key, created_at, applied_at) VALUES (?, ?, ?, ?, ?, NULL)").run(normalizedSource, normalizedRole, normalizedMessage.slice(0, 4_000), normalizedScope, createdAt);
    const directive = { id: Number(result.lastInsertRowid), sourceRole: normalizedSource, role: normalizedRole, message: normalizedMessage.slice(0, 4_000), scopeKey: normalizedScope, createdAt, appliedAt: null, cancelledAt: null } satisfies AgentDirective;
    this.appendEvent("agent.directive.queued", directive);
    return directive;
  }

  /** Queue a directive only when the same role-scoped handoff is not already pending. */
  enqueueAgentDirectiveOnce(role: string, message: string, scopeKey: string | null = null, sourceRole: string | null = null): AgentDirective {
    const normalizedRole = role.trim();
    const normalizedMessage = message.trim().slice(0, 4_000);
    const normalizedScope = scopeKey?.trim() || null;
    const normalizedSource = sourceRole?.trim().slice(0, 120) || null;
    const existing = this.db.prepare("SELECT id, source_role, role, message, scope_key, created_at, applied_at, cancelled_at FROM agent_directives WHERE source_role IS ? AND role = ? AND message = ? AND scope_key IS ? AND applied_at IS NULL AND cancelled_at IS NULL ORDER BY id ASC LIMIT 1").get(normalizedSource, normalizedRole, normalizedMessage, normalizedScope) as { id: number; source_role: string | null; role: string; message: string; scope_key: string | null; created_at: string; applied_at: string | null; cancelled_at: string | null } | undefined;
    return existing
      ? { id: existing.id, sourceRole: existing.source_role, role: existing.role, message: existing.message, scopeKey: existing.scope_key, createdAt: existing.created_at, appliedAt: existing.applied_at, cancelledAt: existing.cancelled_at }
      : this.enqueueAgentDirective(normalizedRole, normalizedMessage, normalizedScope, normalizedSource);
  }

  consumeAgentDirectives(role: string, limit = 4, scopeKey: string | null = null): AgentDirective[] {
    const now = new Date().toISOString();
    const normalizedScope = scopeKey?.trim() || null;
    const transaction = this.db.transaction(() => {
      const rows = this.db.prepare("SELECT id, source_role, role, message, scope_key, created_at, applied_at, cancelled_at FROM agent_directives WHERE role = ? AND applied_at IS NULL AND cancelled_at IS NULL AND (scope_key IS NULL OR scope_key = ?) ORDER BY id ASC LIMIT ?").all(role, normalizedScope, Math.max(1, Math.min(16, limit))) as Array<{ id: number; source_role: string | null; role: string; message: string; scope_key: string | null; created_at: string; applied_at: string | null; cancelled_at: string | null }>;
      const mark = this.db.prepare("UPDATE agent_directives SET applied_at = ? WHERE id = ? AND applied_at IS NULL");
      return rows.flatMap((row) => mark.run(now, row.id).changes === 1 ? [{ id: row.id, sourceRole: row.source_role, role: row.role, message: row.message, scopeKey: row.scope_key, createdAt: row.created_at, appliedAt: now, cancelledAt: row.cancelled_at }] : []);
    })() as AgentDirective[];
    if (transaction.length) {
      this.appendEvent("agent.directive.applied", { role, scopeKey: normalizedScope, ids: transaction.map((item) => item.id) });
      for (const directive of transaction) this.recordAgentDirectiveOutcome(directive.id, role, "acknowledged", "Delivered at a safe agent boundary.");
    }
    return transaction;
  }

  /** Record what the receiving role did with an applied handoff. */
  recordAgentDirectiveOutcome(directiveId: number, role: string, status: AgentDirectiveOutcomeStatus, message: string): void {
    if (!Number.isInteger(directiveId) || directiveId <= 0) throw new Error("Directive id must be a positive integer.");
    const normalizedRole = role.trim().slice(0, 120);
    const normalizedMessage = message.trim().slice(0, 1_000);
    if (!normalizedRole || !normalizedMessage) throw new Error("Directive outcome requires a role and message.");
    const directive = this.db.prepare("SELECT role, applied_at, cancelled_at FROM agent_directives WHERE id = ?").get(directiveId) as { role: string; applied_at: string | null; cancelled_at: string | null } | undefined;
    if (!directive) throw new Error(`Directive #${directiveId} does not exist.`);
    if (directive.role !== normalizedRole) throw new Error(`Directive #${directiveId} belongs to '${directive.role}', not '${normalizedRole}'.`);
    if (!directive.applied_at) throw new Error(`Directive #${directiveId} has not been applied at a safe boundary.`);
    if (directive.cancelled_at) throw new Error(`Directive #${directiveId} was cancelled and cannot receive an outcome.`);
    const existing = this.agentDirectiveOutcomes(256).find((outcome) => outcome.directiveId === directiveId);
    if (existing) {
      if (existing.role === normalizedRole && existing.status === status && existing.message === normalizedMessage) return;
      if (existing.status !== "acknowledged" || status === "acknowledged") throw new Error(`Directive #${directiveId} already has a terminal ${existing.status} outcome.`);
    }
    this.appendEvent("agent.directive.outcome", { directiveId, role: normalizedRole, status, message: normalizedMessage });
  }

  agentDirectiveOutcomes(limit = 64): AgentDirectiveOutcome[] {
    const latest = new Map<number, AgentDirectiveOutcome>();
    for (const event of this.eventsByType("agent.directive.outcome", Math.max(1, Math.min(256, limit * 2)))) {
      const payload = event.payload && typeof event.payload === "object" ? event.payload as Record<string, unknown> : {};
      if (!Number.isInteger(payload.directiveId) || typeof payload.role !== "string" || typeof payload.status !== "string" || !["acknowledged", "completed", "failed", "rejected"].includes(payload.status) || typeof payload.message !== "string") continue;
      latest.set(payload.directiveId as number, { directiveId: payload.directiveId as number, role: payload.role, status: payload.status as AgentDirectiveOutcomeStatus, message: payload.message, createdAt: event.createdAt });
    }
    return [...latest.values()].sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt)).slice(0, Math.max(1, Math.min(256, limit)));
  }

  /** Find delivered handoffs that no longer have a healthy recipient lease. */
  staleAgentDirectives(maxAgeMs = 300_000, now = Date.now()): Array<{ directive: AgentDirective; outcome: AgentDirectiveOutcome; reason: string }> {
    const outcomes = new Map(this.agentDirectiveOutcomes(256).map((outcome) => [outcome.directiveId, outcome]));
    const lanes = new Map(this.agentLanes().map((lane) => [lane.role, lane]));
    return this.agentDirectives(undefined, 256).flatMap((directive) => {
      const outcome = outcomes.get(directive.id);
      if (!outcome || outcome.status !== "acknowledged") return [];
      const ageMs = now - Date.parse(outcome.createdAt);
      if (!Number.isFinite(ageMs) || ageMs < Math.max(1, maxAgeMs)) return [];
      const lane = lanes.get(directive.role);
      const heartbeat = lane?.heartbeatAt ? Date.parse(lane.heartbeatAt) : Number.NaN;
      const healthy = lane?.status === "running" && Number.isFinite(heartbeat) && now - heartbeat <= 120_000;
      if (healthy) return [];
      const reason = !lane ? "recipient lane is not present" : lane.status !== "running" ? `recipient lane is ${lane.status}` : "recipient heartbeat is stale";
      return [{ directive, outcome, reason }];
    });
  }

  /** Resolve stale delivered handoffs as failed recovery records; callers can enqueue a changed route. */
  recoverStaleAgentDirectives(maxAgeMs = 300_000, now = Date.now()): number[] {
    const stale = this.staleAgentDirectives(maxAgeMs, now);
    for (const entry of stale) {
      this.recordAgentDirectiveOutcome(entry.directive.id, entry.directive.role, "failed", `Recovered stale handoff: ${entry.reason}. Enqueue a changed route before retrying.`);
    }
    if (stale.length) this.appendEvent("agent.directive.recovery.completed", { directiveIds: stale.map((entry) => entry.directive.id), source: "operator" });
    return stale.map((entry) => entry.directive.id);
  }

  pendingAgentDirectives(role?: string, scopeKey?: string | null): AgentDirective[] {
    return this.agentDirectives(role).filter((directive) => directive.appliedAt === null && directive.cancelledAt === null && (scopeKey === undefined || directive.scopeKey === null || directive.scopeKey === (scopeKey?.trim() || null)));
  }

  cancelAgentDirective(id: number, reason = "operator cancelled directive"): boolean {
    const cancelledAt = new Date().toISOString();
    const result = this.db.prepare("UPDATE agent_directives SET cancelled_at = ? WHERE id = ? AND applied_at IS NULL AND cancelled_at IS NULL").run(cancelledAt, id);
    if (result.changes !== 1) return false;
    this.appendEvent("agent.directive.cancelled", { id, reason: reason.trim().slice(0, 400) || "operator cancelled directive", cancelledAt });
    return true;
  }

  /** Read the durable specialist inbox, including already-applied handoffs. */
  agentDirectives(role?: string, limit = 32): AgentDirective[] {
    const rows = (role
      ? this.db.prepare("SELECT id, source_role, role, message, scope_key, created_at, applied_at, cancelled_at FROM agent_directives WHERE role = ? ORDER BY id DESC LIMIT ?").all(role, Math.max(1, Math.min(128, limit)))
      : this.db.prepare("SELECT id, source_role, role, message, scope_key, created_at, applied_at, cancelled_at FROM agent_directives ORDER BY id DESC LIMIT ?").all(Math.max(1, Math.min(128, limit)))) as Array<{ id: number; source_role: string | null; role: string; message: string; scope_key: string | null; created_at: string; applied_at: string | null; cancelled_at: string | null }>;
    return rows.map((row) => ({ id: row.id, sourceRole: row.source_role, role: row.role, message: row.message, scopeKey: row.scope_key, createdAt: row.created_at, appliedAt: row.applied_at, cancelledAt: row.cancelled_at })).reverse();
  }

  releaseControllerLease(controllerId: string, status: "released" | "stale" = "released"): boolean {
    const now = new Date().toISOString();
    const result = this.db.prepare("UPDATE controller_leases SET status = ?, requested_action = NULL, updated_at = ? WHERE id = 1 AND controller_id = ? AND status = 'running'").run(status, now, controllerId);
    if (result.changes === 1) this.appendEvent(`controller.lease.${status}`, { controllerId });
    return result.changes === 1;
  }

  updateAgentLane(lane: { role: string; status: "idle" | "running" | "blocked" | "failed"; provider: string; model: string; task?: string | null; error?: string | null; leaseId?: string | null; budgetSeconds?: number | null }): void {
    const updatedAt = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO agent_lanes (role, status, provider, model, task, error, heartbeat_at, lease_id, started_at, budget_seconds, used_seconds, usage_calls, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?)
      ON CONFLICT(role) DO UPDATE SET status = excluded.status, provider = excluded.provider, model = excluded.model, task = excluded.task, error = excluded.error, heartbeat_at = excluded.heartbeat_at, lease_id = COALESCE(excluded.lease_id, agent_lanes.lease_id), started_at = COALESCE(agent_lanes.started_at, excluded.started_at), budget_seconds = COALESCE(excluded.budget_seconds, agent_lanes.budget_seconds), updated_at = excluded.updated_at
    `).run(lane.role, lane.status, lane.provider, lane.model, lane.task ?? null, lane.error ?? null, lane.status === "running" ? updatedAt : null, lane.leaseId ?? null, lane.status === "running" ? updatedAt : null, lane.budgetSeconds ?? null, updatedAt);
  }

  /** Persist operator control separately from transient worker status. */
  setAgentPause(role: string, paused: boolean, reason = "operator request"): boolean {
    const normalized = role.trim();
    if (!normalized) throw new Error("Agent role is required.");
    if (this.agentPause(normalized)?.paused === paused) return false;
    const now = new Date().toISOString();
    this.db.prepare(`INSERT INTO agent_controls (role, paused, reason, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(role) DO UPDATE SET paused = excluded.paused, reason = excluded.reason, updated_at = excluded.updated_at`).run(normalized, paused ? 1 : 0, paused ? reason.slice(0, 500) : null, now);
    this.appendEvent(paused ? "agent.pause.requested" : "agent.pause.cleared", { role: normalized, reason: paused ? reason.slice(0, 500) : undefined });
    return true;
  }

  queueControl(): { paused: boolean; reason: string | null; updatedAt: string } {
    const row = this.db.prepare("SELECT paused, reason, updated_at FROM queue_control WHERE id = 1").get() as { paused: number; reason: string | null; updated_at: string } | undefined;
    return row
      ? { paused: row.paused === 1, reason: row.reason, updatedAt: row.updated_at }
      : { paused: false, reason: null, updatedAt: new Date(0).toISOString() };
  }

  setQueuePaused(paused: boolean, reason = "operator request"): { paused: boolean; reason: string | null; updatedAt: string } {
    const normalizedReason = paused ? reason.trim().slice(0, 500) || "operator request" : null;
    const current = this.queueControl();
    if (current.paused === paused && current.reason === normalizedReason) return current;
    const updatedAt = new Date().toISOString();
    this.db.prepare("INSERT INTO queue_control (id, paused, reason, updated_at) VALUES (1, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET paused = excluded.paused, reason = excluded.reason, updated_at = excluded.updated_at").run(paused ? 1 : 0, normalizedReason, updatedAt);
    this.appendEvent(paused ? "queue.paused" : "queue.resumed", { reason: normalizedReason });
    return { paused, reason: normalizedReason, updatedAt };
  }

  attentionAcknowledgement(itemId: string): AttentionAcknowledgement | undefined {
    const normalized = itemId.trim().slice(0, 240);
    if (!normalized) return undefined;
    const row = this.db.prepare("SELECT item_id, fingerprint, actor_id, note, acknowledged_at FROM attention_acknowledgements WHERE item_id = ?").get(normalized) as { item_id: string; fingerprint: string; actor_id: string; note: string | null; acknowledged_at: string } | undefined;
    return row ? { itemId: row.item_id, fingerprint: row.fingerprint, actorId: row.actor_id, note: row.note, acknowledgedAt: row.acknowledged_at } : undefined;
  }

  attentionAcknowledgements(limit = 128): AttentionAcknowledgement[] {
    const rows = this.db.prepare("SELECT item_id, fingerprint, actor_id, note, acknowledged_at FROM attention_acknowledgements ORDER BY acknowledged_at DESC LIMIT ?").all(Math.max(1, Math.min(256, Math.floor(limit)))) as Array<{ item_id: string; fingerprint: string; actor_id: string; note: string | null; acknowledged_at: string }>;
    return rows.map((row) => ({ itemId: row.item_id, fingerprint: row.fingerprint, actorId: row.actor_id, note: row.note, acknowledgedAt: row.acknowledged_at }));
  }

  acknowledgeAttention(itemId: string, fingerprint: string, actorId: string, note?: string | null): { changed: boolean; acknowledgement: AttentionAcknowledgement } {
    const normalizedItem = itemId.trim().slice(0, 240);
    const normalizedFingerprint = fingerprint.trim().slice(0, 128);
    const normalizedActor = actorId.trim().slice(0, 200) || "operator";
    const normalizedNote = note?.trim().slice(0, 500) || null;
    if (!normalizedItem || !normalizedFingerprint) throw new Error("Attention acknowledgement requires an item id and fingerprint.");
    const current = this.attentionAcknowledgement(normalizedItem);
    const now = new Date().toISOString();
    const changed = !current || current.fingerprint !== normalizedFingerprint || current.note !== normalizedNote || current.actorId !== normalizedActor;
    if (changed) {
      this.db.prepare("INSERT INTO attention_acknowledgements (item_id, fingerprint, actor_id, note, acknowledged_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(item_id) DO UPDATE SET fingerprint = excluded.fingerprint, actor_id = excluded.actor_id, note = excluded.note, acknowledged_at = excluded.acknowledged_at").run(normalizedItem, normalizedFingerprint, normalizedActor, normalizedNote, now);
      this.appendEvent("operator.attention.acknowledged", { itemId: normalizedItem, fingerprint: normalizedFingerprint, actorId: normalizedActor, note: normalizedNote });
    }
    return { changed, acknowledgement: this.attentionAcknowledgement(normalizedItem) as AttentionAcknowledgement };
  }

  clearAttentionAcknowledgement(itemId: string, actorId = "operator"): boolean {
    const normalized = itemId.trim().slice(0, 240);
    if (!normalized) return false;
    const changed = this.db.prepare("DELETE FROM attention_acknowledgements WHERE item_id = ?").run(normalized).changes === 1;
    if (changed) this.appendEvent("operator.attention.unacknowledged", { itemId: normalized, actorId: actorId.trim().slice(0, 200) || "operator" });
    return changed;
  }

  /** Suspend one queue ticket and unfinished descendants without counting retries. */
  pauseTask(id: string, reason = "operator paused task", actorId = "operator"): boolean {
    const normalizedReason = reason.trim().slice(0, 500) || "operator paused task";
    const now = new Date().toISOString();
    const candidateIds = [id, ...this.taskDescendantIds(id)];
    const paused: Array<{ id: string; kind: string; status: QueueTaskStatus; ownerId: string | null; parentTaskId: string | null }> = [];
    const rootPaused = this.db.transaction(() => {
      const root = this.db.prepare("SELECT status FROM work_queue WHERE id = ?").get(id) as { status: QueueTaskStatus } | undefined;
      if (!root || !["queued", "running"].includes(root.status)) return false;
      for (const candidateId of candidateIds) {
        const current = this.db.prepare("SELECT status, kind, owner_id, parent_task_id FROM work_queue WHERE id = ?").get(candidateId) as { status: QueueTaskStatus; kind: string; owner_id: string | null; parent_task_id: string | null } | undefined;
        if (!current || !["queued", "running"].includes(current.status)) continue;
        const result = this.db.prepare("UPDATE work_queue SET status = 'paused', claimed_at = NULL, claim_token = NULL, owner_id = NULL, updated_at = ? WHERE id = ? AND status IN ('queued', 'running')").run(now, candidateId);
        if (result.changes === 1) paused.push({ id: candidateId, kind: current.kind, status: current.status, ownerId: current.owner_id, parentTaskId: current.parent_task_id });
      }
      return paused.some((entry) => entry.id === id);
    })();
    if (!rootPaused) return false;
    for (const entry of paused) {
      this.appendEvent("queue.task.paused", { id: entry.id, kind: entry.kind, priorStatus: entry.status, priorOwnerId: entry.ownerId, parentTaskId: entry.parentTaskId, reason: normalizedReason, actorId: actorId.trim().slice(0, 200) || "operator", pausedAt: now, ...(entry.id === id ? {} : { cascadedFrom: id }) });
    }
    return true;
  }

  /** Resume a suspended ticket and descendants paused by that ticket. */
  resumeTask(id: string, actorId = "operator"): boolean {
    const now = new Date().toISOString();
    const latestPauses = new Map<string, Record<string, unknown>>();
    for (const event of this.eventsByType("queue.task.paused")) {
      const payload = event.payload && typeof event.payload === "object" ? event.payload as Record<string, unknown> : {};
      if (typeof payload.id === "string") latestPauses.set(payload.id, payload);
    }
    const candidateIds = [id, ...this.taskDescendantIds(id)];
    const resumed: string[] = [];
    const rootResumed = this.db.transaction(() => {
      const root = this.db.prepare("SELECT status FROM work_queue WHERE id = ?").get(id) as { status: QueueTaskStatus } | undefined;
      if (!root || root.status !== "paused") return false;
      for (const candidateId of candidateIds) {
        const current = this.db.prepare("SELECT status FROM work_queue WHERE id = ?").get(candidateId) as { status: QueueTaskStatus } | undefined;
        if (!current || current.status !== "paused" || (candidateId !== id && latestPauses.get(candidateId)?.cascadedFrom !== id)) continue;
        const result = this.db.prepare("UPDATE work_queue SET status = 'queued', available_at = ?, updated_at = ? WHERE id = ? AND status = 'paused'").run(now, now, candidateId);
        if (result.changes === 1) resumed.push(candidateId);
      }
      return resumed.includes(id);
    })();
    if (!rootResumed) return false;
    for (const resumedId of resumed) this.appendEvent("queue.task.resumed", { id: resumedId, actorId: actorId.trim().slice(0, 200) || "operator", resumedAt: now, ...(resumedId === id ? {} : { cascadedFrom: id }) });
    return true;
  }

  /** Permanently block a role until an explicit revive/restart action. */
  setAgentTermination(role: string, terminated: boolean, reason = "operator request"): boolean {
    const normalized = role.trim();
    if (!normalized) throw new Error("Agent role is required.");
    if (this.agentPause(normalized)?.terminated === terminated) return false;
    const now = new Date().toISOString();
    this.db.prepare(`INSERT INTO agent_controls (role, paused, terminated, reason, updated_at) VALUES (?, 0, ?, ?, ?) ON CONFLICT(role) DO UPDATE SET terminated = excluded.terminated, paused = CASE WHEN excluded.terminated = 1 THEN 0 ELSE agent_controls.paused END, reason = excluded.reason, updated_at = excluded.updated_at`).run(normalized, terminated ? 1 : 0, terminated ? reason.slice(0, 500) : null, now);
    this.appendEvent(terminated ? "agent.termination.requested" : "agent.termination.cleared", { role: normalized, reason: terminated ? reason.slice(0, 500) : undefined });
    return true;
  }

  /** Built-in roles are trusted by default; custom/external roles need explicit admission. */
  agentRoleAdmissionStatus(role: string): "approved" | "review" | "rejected" {
    const normalized = role.trim();
    if (!normalized || isBuiltInAgentRole(normalized)) return "approved";
    const row = this.db.prepare("SELECT admitted, admission_status FROM agent_controls WHERE role = ?").get(normalized) as { admitted: number; admission_status: string } | undefined;
    if (row?.admitted === 1) return "approved";
    return row?.admission_status === "rejected" ? "rejected" : "review";
  }

  agentRoleAdmitted(role: string): boolean {
    return this.agentRoleAdmissionStatus(role) === "approved";
  }

  agentRoleContract(role: string): PersistedAgentRoleContract | undefined {
    const normalized = role.trim();
    if (!normalized) return undefined;
    const row = this.db.prepare("SELECT contract_json, updated_at FROM agent_controls WHERE role = ?").get(normalized) as { contract_json: string | null; updated_at: string } | undefined;
    if (!row?.contract_json) return undefined;
    try {
      const parsed = JSON.parse(row.contract_json) as Partial<PersistedAgentRoleContract>;
      if (parsed.role !== normalized || typeof parsed.responsibility !== "string" || !["coordinate", "investigate", "validate", "execute", "repair"].includes(String(parsed.authority)) || !Array.isArray(parsed.playbook)) return undefined;
      return {
        role: normalized,
        parentRole: typeof parsed.parentRole === "string" && parsed.parentRole.trim() ? parsed.parentRole.trim() : null,
        responsibility: parsed.responsibility,
        authority: parsed.authority as PersistedAgentRoleContract["authority"],
        reviewRequired: parsed.reviewRequired !== false,
        playbook: parsed.playbook.filter((step): step is string => typeof step === "string" && Boolean(step.trim())).map((step) => step.trim()).slice(0, 16),
        ...(Array.isArray(parsed.toolAllowlist) ? { toolAllowlist: [...new Set(parsed.toolAllowlist.filter((tool): tool is string => typeof tool === "string" && /^[a-zA-Z0-9_.:-]{1,120}$/.test(tool.trim())).map((tool) => tool.trim().toLowerCase()))].slice(0, 32) } : {}),
        ...(Array.isArray(parsed.skillAllowlist) ? { skillAllowlist: [...new Set(parsed.skillAllowlist.filter((skill): skill is string => typeof skill === "string" && /^[a-zA-Z0-9_.-]{1,120}\.md$/i.test(skill.trim())).map((skill) => skill.trim()))].slice(0, 32) } : {}),
        updatedAt: row.updated_at,
      };
    } catch {
      return undefined;
    }
  }

  agentRoleContracts(limit = 128): PersistedAgentRoleContract[] {
    const rows = this.db.prepare("SELECT role FROM agent_controls WHERE contract_json IS NOT NULL ORDER BY role ASC LIMIT ?").all(Math.max(1, Math.min(256, Math.floor(limit)))) as Array<{ role: string }>;
    return rows.flatMap((row) => {
      const contract = this.agentRoleContract(row.role);
      return contract ? [contract] : [];
    });
  }

  agentRoleContractHistory(role: string, limit = 32): Array<{ revision: number; contract: PersistedAgentRoleContract; createdAt: string }> {
    const normalized = role.trim();
    if (!normalized) return [];
    const events = this.eventsByType("agent.role.contract.updated", Math.max(1, Math.min(256, Math.floor(limit) * 4)));
    return events.flatMap((event) => {
      const payload = event.payload && typeof event.payload === "object" ? event.payload as Record<string, unknown> : {};
      if (payload.role !== normalized || !payload.contract || typeof payload.contract !== "object" || Array.isArray(payload.contract)) return [];
      const raw = payload.contract as Partial<PersistedAgentRoleContract>;
      if (raw.role !== normalized || typeof raw.responsibility !== "string" || !["coordinate", "investigate", "validate", "execute", "repair"].includes(String(raw.authority)) || !Array.isArray(raw.playbook)) return [];
      const contract: PersistedAgentRoleContract = {
        role: normalized,
        parentRole: typeof raw.parentRole === "string" && raw.parentRole.trim() ? raw.parentRole.trim() : null,
        responsibility: raw.responsibility,
        authority: raw.authority as PersistedAgentRoleContract["authority"],
        reviewRequired: raw.reviewRequired !== false,
        playbook: raw.playbook.filter((step): step is string => typeof step === "string" && Boolean(step.trim())).map((step) => step.trim()).slice(0, 16),
        ...(Array.isArray(raw.toolAllowlist) ? { toolAllowlist: [...new Set(raw.toolAllowlist.filter((tool): tool is string => typeof tool === "string" && /^[a-zA-Z0-9_.:-]{1,120}$/.test(tool.trim())).map((tool) => tool.trim().toLowerCase()))].slice(0, 32) } : {}),
        ...(Array.isArray(raw.skillAllowlist) ? { skillAllowlist: [...new Set(raw.skillAllowlist.filter((skill): skill is string => typeof skill === "string" && /^[a-zA-Z0-9_.-]{1,120}\.md$/i.test(skill.trim())).map((skill) => skill.trim()))].slice(0, 32) } : {}),
        updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : event.createdAt,
      };
      return [{ revision: 0, contract, createdAt: event.createdAt }];
    }).reverse().slice(0, Math.max(1, Math.min(128, Math.floor(limit)))).map((entry, index) => ({ ...entry, revision: index + 1 }));
  }

  restoreAgentRoleContract(role: string, revision: number, reason = "operator contract rollback"): PersistedAgentRoleContract {
    if (!Number.isInteger(revision) || revision < 1) throw new Error("Contract revision must be a positive integer.");
    const target = this.agentRoleContractHistory(role, Math.max(revision, 32)).find((entry) => entry.revision === revision);
    if (!target) throw new Error(`No contract revision ${revision} exists for '${role}'.`);
    const { updatedAt: _updatedAt, ...contractInput } = target.contract;
    const restored = this.setAgentRoleContract(contractInput, `${reason}; restored revision ${revision}`);
    this.appendEvent("agent.role.contract.rollback", { role: role.trim(), restoredRevision: revision, contract: restored, reason });
    return restored;
  }

  /** Persist the operating contract for a custom role; built-ins remain code-defined. */
  setAgentRoleContract(input: Omit<PersistedAgentRoleContract, "updatedAt">, reason = "operator contract update"): PersistedAgentRoleContract {
    const role = input.role.trim().slice(0, 160);
    const parentRole = input.parentRole?.trim().slice(0, 160) || null;
    const responsibility = input.responsibility.trim().slice(0, 1_000);
    const authority = input.authority;
    const playbook = [...new Set(input.playbook.map((step) => step.trim().slice(0, 300)).filter(Boolean))].slice(0, 16);
    const toolAllowlist = input.toolAllowlist === undefined ? undefined : [...new Set(input.toolAllowlist.map((tool) => tool.trim().toLowerCase()).filter((tool) => /^[a-z0-9_.:-]{1,120}$/.test(tool)))].slice(0, 32);
    const skillAllowlist = input.skillAllowlist === undefined ? undefined : [...new Set(input.skillAllowlist.map((skill) => skill.trim()).filter((skill) => /^[a-z0-9_.-]{1,120}\.md$/i.test(skill)))].slice(0, 32);
    if (!role || !responsibility || !["coordinate", "investigate", "validate", "execute", "repair"].includes(authority) || !playbook.length) throw new Error("Custom role contracts require a role, responsibility, supported authority, and at least one playbook step.");
    if (input.toolAllowlist !== undefined && (!toolAllowlist?.length || toolAllowlist.length !== input.toolAllowlist.length || input.toolAllowlist.length > 32)) throw new Error("Custom role tool allowlists must contain 1–32 unique simple tool names.");
    if (input.skillAllowlist !== undefined && (!skillAllowlist?.length || skillAllowlist.length !== input.skillAllowlist.length || input.skillAllowlist.length > 32)) throw new Error("Custom role skill allowlists must contain 1–32 .md skill filenames.");
    if (isBuiltInAgentRole(role)) throw new Error(`Built-in role '${role}' is defined by the Evidra contract and cannot be overwritten.`);
    if (parentRole === role) throw new Error("A role cannot report to itself.");
    const visited = new Set<string>([role]);
    let ancestor = parentRole;
    while (ancestor) {
      if (visited.has(ancestor)) throw new Error(`Role contract reporting line contains a cycle at '${ancestor}'.`);
      visited.add(ancestor);
      ancestor = this.agentRoleContract(ancestor)?.parentRole ?? null;
    }
    const updatedAt = new Date().toISOString();
    const contract: PersistedAgentRoleContract = { role, parentRole, responsibility, authority, reviewRequired: input.reviewRequired !== false, playbook, ...(toolAllowlist ? { toolAllowlist } : {}), ...(skillAllowlist ? { skillAllowlist } : {}), updatedAt };
    this.db.prepare(`INSERT INTO agent_controls (role, paused, terminated, admitted, admission_status, contract_json, reason, updated_at) VALUES (?, 0, 0, 0, 'review', ?, ?, ?) ON CONFLICT(role) DO UPDATE SET contract_json = excluded.contract_json, reason = excluded.reason, updated_at = excluded.updated_at`).run(role, JSON.stringify(contract), reason.trim().slice(0, 500) || "operator contract update", updatedAt);
    this.appendEvent("agent.role.contract.updated", { role, contract, reason: reason.trim().slice(0, 500) || "operator contract update" });
    return contract;
  }

  setAgentRoleAdmission(role: string, admitted: boolean, reason = "operator request"): boolean {
    const normalized = role.trim();
    if (!normalized) throw new Error("Agent role is required.");
    if (isBuiltInAgentRole(normalized)) throw new Error(`Built-in role '${normalized}' is approved by contract; use pause or terminate to control it.`);
    if (this.agentRoleAdmissionStatus(normalized) === "approved" && admitted) return false;
    const now = new Date().toISOString();
    this.db.prepare(`INSERT INTO agent_controls (role, paused, terminated, admitted, admission_status, reason, updated_at) VALUES (?, 0, 0, ?, ?, ?, ?) ON CONFLICT(role) DO UPDATE SET admitted = excluded.admitted, admission_status = excluded.admission_status, reason = excluded.reason, updated_at = excluded.updated_at`).run(normalized, admitted ? 1 : 0, admitted ? "approved" : "review", reason.slice(0, 500), now);
    this.appendEvent(admitted ? "agent.role.admitted" : "agent.role.admission.revoked", { role: normalized, reason: reason.slice(0, 500) });
    return true;
  }

  rejectAgentRoleAdmission(role: string, reason = "operator rejected role"): boolean {
    const normalized = role.trim();
    if (!normalized) throw new Error("Agent role is required.");
    if (isBuiltInAgentRole(normalized)) throw new Error(`Built-in role '${normalized}' is approved by contract; use pause or terminate to control it.`);
    if (this.agentRoleAdmissionStatus(normalized) === "rejected") return false;
    const now = new Date().toISOString();
    this.db.prepare(`INSERT INTO agent_controls (role, paused, terminated, admitted, admission_status, reason, updated_at) VALUES (?, 0, 0, 0, 'rejected', ?, ?) ON CONFLICT(role) DO UPDATE SET admitted = 0, admission_status = 'rejected', reason = excluded.reason, updated_at = excluded.updated_at`).run(normalized, reason.slice(0, 500), now);
    this.appendEvent("agent.role.admission.rejected", { role: normalized, reason: reason.slice(0, 500) });
    return true;
  }

  /** Accept a heartbeat from an authenticated external worker without allowing lease takeover. */
  recordExternalAgentHeartbeat(input: { workspaceId?: string; role: string; leaseId: string; provider: string; model: string; status: "running" | "idle" | "blocked" | "failed"; task?: string | null; budgetSeconds?: number | null; capacity?: number | null; capabilities?: string[] }): { accepted: boolean; reason?: string } {
    if (input.workspaceId && input.workspaceId !== this.workspaceId()) {
      const reason = "worker heartbeat belongs to a different Evidra workspace";
      this.appendEvent("agent.external_heartbeat.rejected", { role: input.role, leaseId: input.leaseId, reason });
      return { accepted: false, reason };
    }
    if (input.status === "running" && !this.agentRoleAdmitted(input.role)) {
      const reason = `role '${input.role}' requires explicit operator admission before external execution`;
      this.appendEvent("agent.external_heartbeat.rejected", { role: input.role, leaseId: input.leaseId, reason });
      return { accepted: false, reason };
    }
    const existing = this.db.prepare("SELECT status, lease_id, heartbeat_at FROM agent_lanes WHERE role = ?").get(input.role) as { status: string; lease_id: string | null; heartbeat_at: string | null } | undefined;
    if (existing?.status === "running" && existing.lease_id && existing.lease_id !== input.leaseId && existing.heartbeat_at && Date.now() - Date.parse(existing.heartbeat_at) <= 60_000) {
      const reason = `lane is leased by ${existing.lease_id}`;
      this.appendEvent("agent.external_heartbeat.rejected", { role: input.role, leaseId: input.leaseId, reason });
      return { accepted: false, reason };
    }
    if (input.status === "running") {
      const acquired = this.acquireAgentLane({ role: input.role, leaseId: input.leaseId, provider: input.provider, model: input.model, task: input.task, budgetSeconds: input.budgetSeconds });
      if (!acquired.acquired) return { accepted: false, reason: acquired.reason };
    } else {
      if (existing?.status === "running" && existing.lease_id === input.leaseId) {
        this.releaseAgentLane(input.role, input.leaseId, input.status, input.status === "failed" ? (input.task ?? "external worker reported failure") : undefined);
      } else {
        this.updateAgentLane({ role: input.role, status: input.status, provider: input.provider, model: input.model, task: input.task ?? null, error: input.status === "failed" ? (input.task ?? "external worker reported failure") : null, budgetSeconds: input.budgetSeconds });
      }
    }
    const now = new Date().toISOString();
    const capabilities = [...new Set((input.capabilities ?? []).map((capability) => capability.trim().toLowerCase()))].sort();
    this.db.prepare(`
      INSERT INTO external_workers (worker_id, workspace_id, role, provider, model, status, capabilities_json, capacity, task, last_heartbeat_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(worker_id) DO UPDATE SET role = excluded.role, provider = excluded.provider, model = excluded.model,
        workspace_id = excluded.workspace_id,
        status = excluded.status, capabilities_json = excluded.capabilities_json, capacity = COALESCE(excluded.capacity, external_workers.capacity), task = excluded.task,
        last_heartbeat_at = excluded.last_heartbeat_at, updated_at = excluded.updated_at
    `).run(input.leaseId, input.workspaceId ?? this.workspaceId(), input.role, input.provider, input.model, input.status, safeJson(capabilities), input.capacity ?? null, input.task ?? null, now, now);
    this.appendEvent("agent.external_heartbeat.accepted", { role: input.role, leaseId: input.leaseId, provider: input.provider, model: input.model, status: input.status });
    return { accepted: true };
  }

  externalWorkers(limit = 64): ExternalWorkerHealth[] {
    const bounded = Math.max(1, Math.min(256, Math.floor(limit)));
    const rows = this.db.prepare("SELECT worker_id, workspace_id, role, provider, model, status, capabilities_json, capacity, task, last_heartbeat_at, updated_at FROM external_workers ORDER BY last_heartbeat_at DESC LIMIT ?").all(bounded) as Array<{ worker_id: string; workspace_id: string | null; role: string; provider: string; model: string; status: string; capabilities_json: string; capacity: number | null; task: string | null; last_heartbeat_at: string; updated_at: string }>;
    return rows.map((row) => {
      const activeTasks = Number((this.db.prepare("SELECT COUNT(*) AS count FROM work_queue WHERE owner_id = ? AND status = 'running'").get(row.worker_id) as { count: number }).count);
      return { workerId: row.worker_id, workspaceId: row.workspace_id, role: row.role, provider: row.provider, model: row.model, status: row.status as ExternalWorkerHealth["status"], admission: this.agentRoleAdmissionStatus(row.role), capabilities: JSON.parse(row.capabilities_json || "[]") as string[], capacity: row.capacity === null ? null : Math.max(1, Math.min(64, Math.floor(row.capacity))), activeTasks, availableSlots: row.capacity === null ? null : Math.max(0, Math.floor(row.capacity) - activeTasks), task: row.task, lastHeartbeatAt: row.last_heartbeat_at, health: Number.isFinite(Date.parse(row.last_heartbeat_at)) && Date.now() - Date.parse(row.last_heartbeat_at) <= 120_000 ? "healthy" as const : "stale" as const, updatedAt: row.updated_at };
    });
  }

  /** Return a fresh worker's atomic dispatch budget for remote queue checkout. */
  externalWorkerDispatchCapacity(workerId: string, maxAgeMs = 120_000): { limit: number | null; active: number; available: number | null; fresh: boolean } {
    const row = this.db.prepare("SELECT capacity, last_heartbeat_at, status FROM external_workers WHERE worker_id = ?").get(workerId) as { capacity: number | null; last_heartbeat_at: string; status: string } | undefined;
    const fresh = Boolean(row && ["running", "idle"].includes(row.status) && Number.isFinite(Date.parse(row.last_heartbeat_at)) && Date.now() - Date.parse(row.last_heartbeat_at) <= Math.max(1_000, maxAgeMs));
    const active = Number((this.db.prepare("SELECT COUNT(*) AS count FROM work_queue WHERE owner_id = ? AND status = 'running'").get(workerId) as { count: number }).count);
    const limit = fresh && row?.capacity !== null && row?.capacity !== undefined ? Math.max(1, Math.min(64, Math.floor(row.capacity))) : null;
    return { limit, active, available: limit === null ? null : Math.max(0, limit - active), fresh };
  }

  /** Use only a fresh heartbeat when a remote worker omits capabilities at claim time. */
  externalWorkerCapabilities(workerId: string, maxAgeMs = 120_000): string[] | undefined {
    const row = this.db.prepare("SELECT capabilities_json, last_heartbeat_at, status FROM external_workers WHERE worker_id = ?").get(workerId) as { capabilities_json: string; last_heartbeat_at: string; status: string } | undefined;
    if (!row || !["running", "idle"].includes(row.status) || !Number.isFinite(Date.parse(row.last_heartbeat_at)) || Date.now() - Date.parse(row.last_heartbeat_at) > Math.max(1_000, maxAgeMs)) return undefined;
    return JSON.parse(row.capabilities_json || "[]") as string[];
  }

  /** Queue execution requires a fresh heartbeat tied to an admitted role. */
  externalWorkerAdmission(workerId: string, maxAgeMs = 120_000): { allowed: boolean; role?: string; reason?: string } {
    const row = this.db.prepare("SELECT role, status, last_heartbeat_at FROM external_workers WHERE worker_id = ?").get(workerId) as { role: string; status: string; last_heartbeat_at: string } | undefined;
    if (!row) return { allowed: false, reason: "worker has no accepted heartbeat" };
    if (!['running', 'idle'].includes(row.status)) return { allowed: false, role: row.role, reason: `worker heartbeat status is ${row.status}` };
    if (!Number.isFinite(Date.parse(row.last_heartbeat_at)) || Date.now() - Date.parse(row.last_heartbeat_at) > Math.max(1_000, maxAgeMs)) return { allowed: false, role: row.role, reason: "worker heartbeat is stale" };
    if (!this.agentRoleAdmitted(row.role)) return { allowed: false, role: row.role, reason: `role '${row.role}' is not admitted` };
    return { allowed: true, role: row.role };
  }

  agentPause(role: string): { role: string; paused: boolean; terminated: boolean; admitted: boolean; admissionStatus: "approved" | "review" | "rejected"; reason: string | null; updatedAt: string } | undefined {
    const row = this.db.prepare("SELECT role, paused, terminated, admitted, admission_status, reason, updated_at FROM agent_controls WHERE role = ?").get(role) as { role: string; paused: number; terminated: number; admitted: number; admission_status: string; reason: string | null; updated_at: string } | undefined;
    return row ? { role: row.role, paused: row.paused === 1, terminated: row.terminated === 1, admitted: row.admitted === 1, admissionStatus: row.admitted === 1 ? "approved" : row.admission_status === "rejected" ? "rejected" : "review", reason: row.reason, updatedAt: row.updated_at } : undefined;
  }

  agentPauses(): Array<{ role: string; paused: boolean; terminated: boolean; admitted: boolean; admissionStatus: "approved" | "review" | "rejected"; reason: string | null; updatedAt: string }> {
    const rows = this.db.prepare("SELECT role, paused, terminated, admitted, admission_status, reason, updated_at FROM agent_controls ORDER BY role ASC").all() as Array<{ role: string; paused: number; terminated: number; admitted: number; admission_status: string; reason: string | null; updated_at: string }>;
    return rows.map((row) => ({ role: row.role, paused: row.paused === 1, terminated: row.terminated === 1, admitted: row.admitted === 1, admissionStatus: row.admitted === 1 ? "approved" : row.admission_status === "rejected" ? "rejected" : "review", reason: row.reason, updatedAt: row.updated_at }));
  }

  /** Atomically assign a lane to one worker. A live lease prevents duplicate specialist work. */
  acquireAgentLane(input: { role: string; leaseId: string; provider: string; model: string; task?: string | null; budgetSeconds?: number | null; staleAfterMs?: number }): { acquired: boolean; leaseId?: string; reason?: string } {
    if (!this.agentRoleAdmitted(input.role)) {
      const reason = `role '${input.role}' requires explicit operator admission before execution`;
      this.appendEvent("agent.lane.rejected", { role: input.role, leaseId: input.leaseId, reason });
      return { acquired: false, reason };
    }
    const now = new Date().toISOString();
    const staleAfterMs = Math.max(1_000, input.staleAfterMs ?? 60_000);
    const result = this.db.transaction(() => {
      const existing = this.db.prepare("SELECT status, lease_id, heartbeat_at FROM agent_lanes WHERE role = ?").get(input.role) as { status: string; lease_id: string | null; heartbeat_at: string | null } | undefined;
      const control = this.db.prepare("SELECT paused, terminated, reason FROM agent_controls WHERE role = ?").get(input.role) as { paused: number; terminated: number; reason: string | null } | undefined;
      if (control?.terminated === 1) return { acquired: false, reason: `lane is terminated by operator${control.reason ? `: ${control.reason}` : ""}` };
      if (control?.paused === 1) return { acquired: false, reason: `lane is paused by operator${control.reason ? `: ${control.reason}` : ""}` };
      if (existing?.status === "running" && existing.lease_id && existing.lease_id !== input.leaseId && existing.heartbeat_at && Date.now() - Date.parse(existing.heartbeat_at) <= staleAfterMs) {
        return { acquired: false, reason: `lane is leased by ${existing.lease_id}` };
      }
      this.db.prepare(`
        INSERT INTO agent_lanes (role, status, provider, model, task, error, heartbeat_at, lease_id, started_at, budget_seconds, used_seconds, usage_calls, updated_at) VALUES (?, 'running', ?, ?, ?, NULL, ?, ?, ?, ?, 0, 0, ?)
        ON CONFLICT(role) DO UPDATE SET status = 'running', provider = excluded.provider, model = excluded.model, task = excluded.task, error = NULL, heartbeat_at = excluded.heartbeat_at, lease_id = excluded.lease_id, started_at = excluded.started_at, budget_seconds = excluded.budget_seconds, used_seconds = 0, usage_calls = 0, updated_at = excluded.updated_at
      `).run(input.role, input.provider, input.model, input.task ?? null, now, input.leaseId, now, input.budgetSeconds ?? null, now);
      return { acquired: true, leaseId: input.leaseId };
    })() as { acquired: boolean; leaseId?: string; reason?: string };
    this.appendEvent(result.acquired ? "agent.lane.acquired" : "agent.lane.busy", { role: input.role, leaseId: input.leaseId, reason: result.reason });
    return result;
  }

  /** Refresh only the holder's lease; stale workers cannot resurrect a replaced lane. */
  heartbeatAgentLane(role: string, leaseId: string): boolean {
    if (!this.agentRoleAdmitted(role)) {
      this.appendEvent("agent.lane.heartbeat_rejected", { role, leaseId, reason: "role admission revoked" });
      return false;
    }
    const now = new Date().toISOString();
    const result = this.db.prepare("UPDATE agent_lanes SET heartbeat_at = ?, updated_at = ? WHERE role = ? AND status = 'running' AND lease_id = ? AND NOT EXISTS (SELECT 1 FROM agent_controls WHERE role = ? AND terminated = 1)").run(now, now, role, leaseId, role);
    return result.changes === 1;
  }

  /** Return the remaining wall-clock budget for a leased lane, if bounded. */
  agentLaneBudget(role: string, leaseId: string): { bounded: boolean; usedSeconds: number; budgetSeconds: number | null; remainingSeconds: number | null; usageCalls: number } | undefined {
    const row = this.db.prepare("SELECT budget_seconds, used_seconds, usage_calls FROM agent_lanes WHERE role = ? AND lease_id = ? AND status = 'running'").get(role, leaseId) as { budget_seconds: number | null; used_seconds: number; usage_calls: number } | undefined;
    if (!row) return undefined;
    const budget = row.budget_seconds === null ? null : Math.max(0, Number(row.budget_seconds));
    const used = Math.max(0, Number(row.used_seconds) || 0);
    return { bounded: budget !== null, usedSeconds: used, budgetSeconds: budget, remainingSeconds: budget === null ? null : Math.max(0, budget - used), usageCalls: Number(row.usage_calls) || 0 };
  }

  /** Record one provider/tool turn against the owning lane's budget. */
  recordAgentLaneUsage(role: string, leaseId: string, durationSeconds: number): boolean {
    const seconds = Math.max(0, Number.isFinite(durationSeconds) ? durationSeconds : 0);
    const now = new Date().toISOString();
    const result = this.db.transaction(() => {
      const current = this.db.prepare("SELECT budget_seconds, used_seconds FROM agent_lanes WHERE role = ? AND lease_id = ? AND status = 'running'").get(role, leaseId) as { budget_seconds: number | null; used_seconds: number } | undefined;
      if (!current) return { changed: false, exhausted: false, usedSeconds: 0, budgetSeconds: null };
      const usedSeconds = Math.max(0, Number(current.used_seconds) || 0) + seconds;
      const budgetSeconds = current.budget_seconds === null ? null : Math.max(0, Number(current.budget_seconds));
      const updated = this.db.prepare("UPDATE agent_lanes SET used_seconds = ?, usage_calls = usage_calls + 1, updated_at = ? WHERE role = ? AND lease_id = ? AND status = 'running'").run(usedSeconds, now, role, leaseId);
      return { changed: updated.changes === 1, exhausted: budgetSeconds !== null && Number(current.used_seconds) < budgetSeconds && usedSeconds >= budgetSeconds, usedSeconds, budgetSeconds };
    })();
    if (result.changed) {
      this.appendEvent("agent.lane.usage", { role, leaseId, durationSeconds: seconds, usedSeconds: result.usedSeconds, budgetSeconds: result.budgetSeconds });
      if (result.exhausted) this.appendEvent("agent.lane.budget_exhausted", { role, leaseId, usedSeconds: result.usedSeconds, budgetSeconds: result.budgetSeconds, action: "stop_at_next_safe_boundary" });
    }
    return result.changed;
  }

  releaseAgentLane(role: string, leaseId: string, status: "idle" | "blocked" | "failed" = "idle", error?: string): boolean {
    const now = new Date().toISOString();
    const result = this.db.prepare("UPDATE agent_lanes SET status = ?, error = ?, heartbeat_at = NULL, lease_id = NULL, updated_at = ? WHERE role = ? AND lease_id = ?").run(status, error ?? null, now, role, leaseId);
    if (result.changes === 1) this.appendEvent("agent.lane.released", { role, leaseId, status, error });
    return result.changes === 1;
  }

  staleAgentLanes(staleAfterMs = 60_000): string[] {
    const cutoff = Date.now() - Math.max(1_000, staleAfterMs);
    // Only lease-backed lanes participate in automatic stale recovery. Older
    // controller roles still use updateAgentLane() as status telemetry and do
    // not yet own a worker lease, so they must not be reclaimed here.
    const rows = this.db.prepare("SELECT role, lease_id, heartbeat_at FROM agent_lanes WHERE status = 'running' AND lease_id IS NOT NULL").all() as Array<{ role: string; lease_id: string | null; heartbeat_at: string | null }>;
    const stale = rows.filter((row) => !row.heartbeat_at || Date.parse(row.heartbeat_at) < cutoff);
    for (const row of stale) {
      this.db.prepare("UPDATE agent_lanes SET status = 'blocked', error = ?, heartbeat_at = NULL, lease_id = NULL, updated_at = ? WHERE role = ? AND status = 'running'").run("lane heartbeat expired; recovery required", new Date().toISOString(), row.role);
      this.appendEvent("agent.lane.stale", { role: row.role, leaseId: row.lease_id });
    }
    return stale.map((row) => row.role);
  }

  /** Close orphaned specialist/review tickets after their owning worker stops heartbeating. */
  staleLaneTickets(staleAfterMs = 60_000): string[] {
    const cutoff = Date.now() - Math.max(1_000, staleAfterMs);
    const rows = this.db.prepare("SELECT id, kind, payload_json, claimed_at FROM work_queue WHERE kind IN ('research.lane', 'research.review') AND status = 'running'").all() as Array<{ id: string; kind: string; payload_json: string; claimed_at: string | null }>;
    const stale = rows.filter((row) => !row.claimed_at || Date.parse(row.claimed_at) < cutoff);
    const now = new Date().toISOString();
    for (const row of stale) {
      let payload: Record<string, unknown> = {};
      try { payload = JSON.parse(row.payload_json) as Record<string, unknown>; } catch { /* preserve a bounded recovery record */ }
      const label = row.kind === "research.review" ? "review" : "lane";
      const error = `${label} ticket heartbeat expired; controller recovery required`;
      this.db.prepare("UPDATE work_queue SET status = 'failed', payload_json = ?, claim_token = NULL, owner_id = NULL, updated_at = ? WHERE id = ? AND status = 'running'")
        .run(safeJson({ ...payload, stale: true, error, recoveredAt: now }), now, row.id);
      this.appendEvent(`queue.${label}.stale`, { id: row.id, role: payload.role, ownerId: payload.ownerId, leaseId: payload.leaseId, error });
    }
    return stale.map((row) => row.id);
  }

  saveSubmission(submission: { id: string; experimentId: string; path: string; status: "prepared" | "approved" | "rejected" | "submitted" | "scored"; payload?: unknown }): void {
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO submissions (id, experiment_id, path, status, payload_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET path = excluded.path, status = excluded.status, payload_json = excluded.payload_json, updated_at = excluded.updated_at
    `).run(submission.id, submission.experimentId, submission.path, submission.status, safeJson(submission.payload ?? {}), now, now);
    this.appendEvent("submission.updated", { id: submission.id, experimentId: submission.experimentId, path: submission.path, status: submission.status });
  }

  updateSubmissionStatus(id: string, status: "prepared" | "approved" | "rejected" | "submitted" | "scored", payload?: unknown): boolean {
    const result = this.db.prepare("UPDATE submissions SET status = ?, payload_json = COALESCE(?, payload_json), updated_at = ? WHERE id = ?")
      .run(status, payload === undefined ? null : safeJson(payload), new Date().toISOString(), id);
    if (result.changes) this.appendEvent("submission.updated", { id, status, payload });
    return result.changes === 1;
  }

  submissions(): Array<{ id: string; experimentId: string; path: string; status: string; payload: unknown; createdAt: string; updatedAt: string }> {
    const rows = this.db.prepare("SELECT * FROM submissions ORDER BY created_at DESC").all() as Array<{ id: string; experiment_id: string; path: string; status: string; payload_json: string; created_at: string; updated_at: string }>;
    return rows.map((row) => ({ id: row.id, experimentId: row.experiment_id, path: row.path, status: row.status, payload: JSON.parse(row.payload_json), createdAt: row.created_at, updatedAt: row.updated_at }));
  }

  externalAction(id: string): ExternalActionIntent | undefined {
    const row = this.db.prepare("SELECT id, kind, fingerprint, status, payload_json, created_at, updated_at FROM external_action_intents WHERE id = ?").get(id) as { id: string; kind: string; fingerprint: string; status: ExternalActionStatus; payload_json: string; created_at: string; updated_at: string } | undefined;
    return row ? { id: row.id, kind: row.kind, fingerprint: row.fingerprint, status: row.status, payload: JSON.parse(row.payload_json), createdAt: row.created_at, updatedAt: row.updated_at } : undefined;
  }

  externalActions(status?: ExternalActionStatus): ExternalActionIntent[] {
    const rows = (status
      ? this.db.prepare("SELECT id, kind, fingerprint, status, payload_json, created_at, updated_at FROM external_action_intents WHERE status = ? ORDER BY updated_at DESC").all(status)
      : this.db.prepare("SELECT id, kind, fingerprint, status, payload_json, created_at, updated_at FROM external_action_intents ORDER BY updated_at DESC").all()) as Array<{ id: string; kind: string; fingerprint: string; status: ExternalActionStatus; payload_json: string; created_at: string; updated_at: string }>;
    return rows.map((row) => ({ id: row.id, kind: row.kind, fingerprint: row.fingerprint, status: row.status, payload: JSON.parse(row.payload_json), createdAt: row.created_at, updatedAt: row.updated_at }));
  }

  /**
   * Atomically reserve an external action before invoking an outside system.
   * An in-flight action is intentionally not replayable: a crash may have
   * happened after the remote system accepted it but before Evidra persisted
   * the receipt.
   */
  beginExternalAction(input: { id: string; kind: string; fingerprint: string; payload?: unknown }): ExternalActionIntent {
    const now = new Date().toISOString();
    const transaction = this.db.transaction(() => {
      const existing = this.externalAction(input.id);
      if (existing) {
        if (existing.fingerprint !== input.fingerprint) throw new Error(`External action ${input.id} has a different fingerprint; refusing replay.`);
        if (existing.status === "retryable") {
          this.db.prepare("UPDATE external_action_intents SET status = 'in_flight', updated_at = ? WHERE id = ? AND status = 'retryable'").run(now, input.id);
          return this.externalAction(input.id) as ExternalActionIntent;
        }
        return existing;
      }
      this.db.prepare("INSERT INTO external_action_intents (id, kind, fingerprint, status, payload_json, created_at, updated_at) VALUES (?, ?, ?, 'in_flight', ?, ?, ?)")
        .run(input.id, input.kind, input.fingerprint, safeJson(input.payload ?? {}), now, now);
      return this.externalAction(input.id) as ExternalActionIntent;
    });
    const intent = transaction() as ExternalActionIntent;
    if (intent.status === "in_flight" && intent.createdAt === now) this.appendEvent("external.action.reserved", { id: intent.id, kind: intent.kind, fingerprint: intent.fingerprint });
    return intent;
  }

  completeExternalAction(id: string, payload?: unknown): boolean {
    const now = new Date().toISOString();
    const result = this.db.prepare("UPDATE external_action_intents SET status = 'completed', payload_json = COALESCE(?, payload_json), updated_at = ? WHERE id = ? AND status = 'in_flight'")
      .run(payload === undefined ? null : safeJson(payload), now, id);
    if (result.changes === 1) this.appendEvent("external.action.completed", { id, payload });
    return result.changes === 1;
  }

  markExternalActionUnknown(id: string, payload?: unknown): boolean {
    const now = new Date().toISOString();
    const result = this.db.prepare("UPDATE external_action_intents SET status = 'unknown', payload_json = COALESCE(?, payload_json), updated_at = ? WHERE id = ? AND status = 'in_flight'")
      .run(payload === undefined ? null : safeJson(payload), now, id);
    if (result.changes === 1) this.appendEvent("external.action.unknown", { id, payload });
    return result.changes === 1;
  }

  reconcileExternalAction(id: string, status: "completed" | "retryable", payload?: unknown): boolean {
    const now = new Date().toISOString();
    const result = this.db.prepare("UPDATE external_action_intents SET status = ?, payload_json = COALESCE(?, payload_json), updated_at = ? WHERE id = ? AND status IN ('unknown', 'in_flight')")
      .run(status, payload === undefined ? null : safeJson(payload), now, id);
    if (result.changes === 1) this.appendEvent("external.action.reconciled", { id, status, payload });
    return result.changes === 1;
  }

  agentLanes(): Array<{ role: string; status: string; provider: string; model: string; task: string | null; error: string | null; heartbeatAt: string | null; leaseId: string | null; startedAt: string | null; budgetSeconds: number | null; usedSeconds: number; usageCalls: number; updatedAt: string }> {
    const rows = this.db.prepare("SELECT role, status, provider, model, task, error, heartbeat_at, lease_id, started_at, budget_seconds, used_seconds, usage_calls, updated_at FROM agent_lanes ORDER BY role ASC").all() as Array<{ role: string; status: string; provider: string; model: string; task: string | null; error: string | null; heartbeat_at: string | null; lease_id: string | null; started_at: string | null; budget_seconds: number | null; used_seconds: number; usage_calls: number; updated_at: string }>;
    return rows.map((row) => ({ role: row.role, status: row.status, provider: row.provider, model: row.model, task: row.task, error: row.error, heartbeatAt: row.heartbeat_at, leaseId: row.lease_id, startedAt: row.started_at, budgetSeconds: row.budget_seconds, usedSeconds: row.used_seconds, usageCalls: row.usage_calls, updatedAt: row.updated_at }));
  }

  private dependencyCycle(taskId: string, dependencies: string[]): string[] | undefined {
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const dependenciesFor = (id: string): string[] => {
      if (id === taskId) return dependencies;
      const row = this.db.prepare("SELECT depends_on_json FROM work_queue WHERE id = ?").get(id) as { depends_on_json: string } | undefined;
      if (!row) return [];
      try {
        const parsed = JSON.parse(row.depends_on_json || "[]");
        return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : [];
      } catch { return []; }
    };
    const visit = (id: string, path: string[]): string[] | undefined => {
      if (visiting.has(id)) return [...path, id];
      if (visited.has(id)) return undefined;
      visiting.add(id);
      for (const dependency of dependenciesFor(id)) {
        const cycle = visit(dependency, [...path, id]);
        if (cycle) return cycle;
      }
      visiting.delete(id);
      visited.add(id);
      return undefined;
    };
    return visit(taskId, []);
  }

  enqueueTask(task: { id: string; kind: string; priority: number; payload: unknown; availableAt?: string; assigneeId?: string | null; tokenBudget?: number | null; costBudgetUsd?: number | null; requiresApproval?: boolean; approvalReason?: string | null; deadlineAt?: string | null; goalId?: string | null; parentTaskId?: string | null; dependsOn?: string[]; requiredCapabilities?: string[] | null; labels?: string[] | null }): boolean {
    const now = new Date().toISOString();
    validateQueueCompletionContract(task.payload);
    const dependsOn = [...new Set((task.dependsOn ?? []).filter((id) => id.trim()))];
    const tokenBudget = normalizeQueueTokenBudget(task.tokenBudget);
    const costBudgetUsd = normalizeQueueCostBudget(task.costBudgetUsd);
    const approvalStatus: QueueApprovalStatus = task.requiresApproval ? "pending" : "none";
    const approvalReason = task.requiresApproval ? (task.approvalReason?.trim().slice(0, 500) || "operator approval required") : null;
    const deadlineAt = normalizeQueueDeadline(task.deadlineAt);
    const requiredCapabilities = normalizeQueueCapabilities(task.requiredCapabilities);
    const labels = normalizeQueueLabels(task.labels);
    const cycle = this.dependencyCycle(task.id, dependsOn);
    if (cycle) throw new Error(`Queue task '${task.id}' creates a dependency cycle: ${cycle.join(" -> ")}`);
    const result = this.db.prepare(`
      INSERT OR IGNORE INTO work_queue (id, kind, priority, status, payload_json, attempts, available_at, claimed_at, owner_id, assignee_id, required_capabilities_json, token_budget, cost_budget_usd, approval_status, approval_reason, deadline_at, goal_id, parent_task_id, depends_on_json, labels_json, updated_at)
      VALUES (?, ?, ?, 'queued', ?, 0, ?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(task.id, task.kind, task.priority, safeJson(task.payload), task.availableAt ?? now, task.assigneeId ?? null, safeJson(requiredCapabilities), tokenBudget, costBudgetUsd, approvalStatus, approvalReason, deadlineAt, task.goalId ?? null, task.parentTaskId ?? null, safeJson(dependsOn), safeJson(labels), now);
    if (result.changes !== 1) {
      this.appendEvent("queue.enqueue.duplicate", { id: task.id, kind: task.kind, ignored: true });
      return false;
    }
    this.appendEvent("queue.enqueued", task);
    return true;
  }

  private routineFromRow(row: { id: string; payload_json: string; status: string; next_run_at: string; lease_id: string | null; lease_expires_at: string | null; created_at: string; updated_at: string }): ResearchRoutine {
    const payload = JSON.parse(row.payload_json) as Omit<ResearchRoutine, "id" | "status" | "nextRunAt" | "leaseId" | "leaseExpiresAt" | "createdAt" | "updatedAt">;
    return { ...payload, catchUpPolicy: payload.catchUpPolicy === "replay" ? "replay" : "coalesce", droppedTriggers: Math.max(0, Number(payload.droppedTriggers) || 0), maxRuns: Number.isInteger(payload.maxRuns) && (payload.maxRuns as number) > 0 ? payload.maxRuns as number : null, failureStreak: Math.max(0, Number(payload.failureStreak) || 0), pendingTriggers: Math.min(MAX_ROUTINE_PENDING_TRIGGERS, Math.max(0, Number(payload.pendingTriggers) || 0)), id: row.id, status: row.status as RoutineStatus, nextRunAt: row.next_run_at, leaseId: row.lease_id, leaseExpiresAt: row.lease_expires_at, createdAt: row.created_at, updatedAt: row.updated_at };
  }

  routines(): ResearchRoutine[] {
    const rows = this.db.prepare("SELECT * FROM research_routines ORDER BY status ASC, next_run_at ASC, created_at ASC").all() as Array<{ id: string; payload_json: string; status: string; next_run_at: string; lease_id: string | null; lease_expires_at: string | null; created_at: string; updated_at: string }>;
    return rows.map((row) => this.routineFromRow(row));
  }

  routine(id: string): ResearchRoutine | undefined {
    const row = this.db.prepare("SELECT * FROM research_routines WHERE id = ?").get(id) as { id: string; payload_json: string; status: string; next_run_at: string; lease_id: string | null; lease_expires_at: string | null; created_at: string; updated_at: string } | undefined;
    return row ? this.routineFromRow(row) : undefined;
  }

  routineRuns(routineId?: string): ResearchRoutineRun[] {
    const rows = (routineId
      ? this.db.prepare("SELECT * FROM research_routine_runs WHERE routine_id = ? ORDER BY started_at DESC").all(routineId)
      : this.db.prepare("SELECT * FROM research_routine_runs ORDER BY started_at DESC").all()) as Array<{ id: string; routine_id: string; owner_id: string; status: string; started_at: string; finished_at: string | null; exit_code: number | null; error: string | null }>;
    return rows.map((row) => ({ id: row.id, routineId: row.routine_id, ownerId: row.owner_id, status: row.status as ResearchRoutineRun["status"], startedAt: row.started_at, finishedAt: row.finished_at, exitCode: row.exit_code, error: row.error }));
  }

  saveRoutine(routine: ResearchRoutine): void {
    validateRoutine(routine);
    const updatedAt = new Date().toISOString();
    const payload = {
      name: routine.name, mode: routine.mode, goal: routine.goal, budgetMinutes: routine.budgetMinutes,
      intervalSeconds: routine.intervalSeconds, stopCondition: routine.stopCondition, provider: routine.provider,
      model: routine.model, thinking: routine.thinking, autonomy: routine.autonomy, limitPolicy: routine.limitPolicy,
      executor: routine.executor, lanes: routine.lanes, maxRuns: routine.maxRuns ?? null, triggerEvent: routine.triggerEvent ?? null, lastTriggerAt: routine.lastTriggerAt ?? null, lastRunAt: routine.lastRunAt, lastResult: routine.lastResult,
      lastError: routine.lastError, runCount: routine.runCount, failureStreak: Math.max(0, Math.floor(routine.failureStreak ?? 0)), pendingTriggers: Math.max(0, Math.min(MAX_ROUTINE_PENDING_TRIGGERS, routine.pendingTriggers ?? 0)), pendingTriggerEvent: routine.pendingTriggerEvent ?? null, catchUpPolicy: routine.catchUpPolicy === "replay" ? "replay" : "coalesce", droppedTriggers: Math.max(0, Math.floor(routine.droppedTriggers ?? 0)),
    };
    this.db.prepare(`
      INSERT INTO research_routines (id, payload_json, status, next_run_at, lease_id, lease_expires_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET payload_json = excluded.payload_json, status = excluded.status,
        next_run_at = excluded.next_run_at, lease_id = excluded.lease_id, lease_expires_at = excluded.lease_expires_at,
        updated_at = excluded.updated_at
    `).run(routine.id, safeJson(payload), routine.status, routine.nextRunAt, routine.leaseId, routine.leaseExpiresAt, routine.createdAt, updatedAt);
  }

  createRoutine(input: Omit<ResearchRoutine, "id" | "status" | "nextRunAt" | "lastRunAt" | "lastResult" | "lastError" | "runCount" | "leaseId" | "leaseExpiresAt" | "createdAt" | "updatedAt"> & { id?: string; nextRunAt?: string }): ResearchRoutine {
    const now = new Date().toISOString();
    const routine: ResearchRoutine = {
      ...input,
      id: input.id ?? `routine_${randomUUID()}`,
      status: "active",
      nextRunAt: input.nextRunAt ?? now,
      lastRunAt: null,
      lastResult: null,
      lastError: null,
      runCount: 0,
      failureStreak: 0,
      maxRuns: input.maxRuns ?? null,
      pendingTriggers: 0,
      pendingTriggerEvent: null,
      catchUpPolicy: input.catchUpPolicy === "replay" ? "replay" : "coalesce",
      droppedTriggers: 0,
      triggerEvent: input.triggerEvent ?? null,
      lastTriggerAt: input.triggerEvent ? now : null,
      leaseId: null,
      leaseExpiresAt: null,
      createdAt: now,
      updatedAt: now,
    };
    this.saveRoutine(routine);
    this.appendEvent("routine.created", { id: routine.id, name: routine.name, mode: routine.mode, intervalSeconds: routine.intervalSeconds, triggerEvent: routine.triggerEvent ?? null });
    return routine;
  }

  /** Wake active routines from a newer matching event without duplicating triggers. */
  triggerRoutines(eventType: string, eventCreatedAt: string): string[] {
    const triggered: string[] = [];
    for (const routine of this.routines()) {
      if (!["active", "running"].includes(routine.status) || routine.triggerEvent !== eventType) continue;
      if (routine.lastTriggerAt && Date.parse(routine.lastTriggerAt) >= Date.parse(eventCreatedAt)) continue;
      const now = new Date().toISOString();
      const queued = routine.status === "running";
      const requestedPending = queued && routine.catchUpPolicy === "replay" ? (routine.pendingTriggers ?? 0) + 1 : 0;
      const dropped = requestedPending > MAX_ROUTINE_PENDING_TRIGGERS ? requestedPending - MAX_ROUTINE_PENDING_TRIGGERS : 0;
      const pendingTriggers = queued ? routine.catchUpPolicy === "replay" ? Math.min(MAX_ROUTINE_PENDING_TRIGGERS, requestedPending) : 1 : routine.pendingTriggers ?? 0;
      const updated: ResearchRoutine = { ...routine, nextRunAt: queued ? routine.nextRunAt : now, lastTriggerAt: eventCreatedAt, pendingTriggers, droppedTriggers: (routine.droppedTriggers ?? 0) + dropped, pendingTriggerEvent: { eventType, eventCreatedAt }, updatedAt: now };
      this.saveRoutine(updated);
      this.appendEvent(queued ? "routine.trigger_queued" : "routine.triggered", { id: routine.id, eventType, eventCreatedAt, coalesced: queued, droppedWakeups: dropped });
      triggered.push(routine.id);
    }
    return triggered;
  }

  /** Request an immediate run without bypassing routine leasing or coalescing. */
  triggerRoutineNow(id: string, eventType = "operator.routine.triggered"): { routine: ResearchRoutine; changed: boolean } {
    const current = this.routine(id);
    if (!current) throw new Error(`Unknown routine '${id}'.`);
    if (current.status === "paused") throw new Error(`Routine '${id}' is paused; resume it before triggering.`);
    const now = new Date().toISOString();
    if (current.status === "running" && current.catchUpPolicy !== "replay" && (current.pendingTriggers ?? 0) > 0) return { routine: current, changed: false };
    if (current.status === "active" && current.pendingTriggerEvent?.eventType === eventType && Date.parse(current.nextRunAt) <= Date.now()) return { routine: current, changed: false };
    const queued = current.status === "running";
    const requestedPending = queued && current.catchUpPolicy === "replay" ? (current.pendingTriggers ?? 0) + 1 : 0;
    const dropped = requestedPending > MAX_ROUTINE_PENDING_TRIGGERS ? requestedPending - MAX_ROUTINE_PENDING_TRIGGERS : 0;
    const pendingTriggers = queued ? current.catchUpPolicy === "replay" ? Math.min(MAX_ROUTINE_PENDING_TRIGGERS, requestedPending) : 1 : current.pendingTriggers ?? 0;
    const updated: ResearchRoutine = { ...current, nextRunAt: queued ? current.nextRunAt : now, lastTriggerAt: now, pendingTriggers, droppedTriggers: (current.droppedTriggers ?? 0) + dropped, pendingTriggerEvent: { eventType, eventCreatedAt: now }, updatedAt: now };
    this.saveRoutine(updated);
    this.appendEvent(queued ? "routine.trigger_queued" : "routine.triggered", { id, eventType, eventCreatedAt: now, coalesced: queued, droppedWakeups: dropped, source: "operator" });
    return { routine: this.routine(id) ?? updated, changed: true };
  }

  claimRoutine(id: string, ownerId: string, leaseMs = 7 * 24 * 60 * 60_000, now = new Date(), force = false): ResearchRoutine | undefined {
    let exhausted = false;
    const claimed = this.db.transaction(() => {
      const row = this.db.prepare("SELECT * FROM research_routines WHERE id = ?").get(id) as { id: string; payload_json: string; status: string; next_run_at: string; lease_id: string | null; lease_expires_at: string | null; created_at: string; updated_at: string } | undefined;
      if (!row) return undefined;
      const due = force || Date.parse(row.next_run_at) <= now.getTime();
      const leaseExpired = !row.lease_expires_at || Date.parse(row.lease_expires_at) <= now.getTime();
      if (!due || (row.status !== "active" && !(row.status === "running" && leaseExpired))) return undefined;
      let payload: Record<string, unknown> = {};
      try { payload = JSON.parse(row.payload_json) as Record<string, unknown>; } catch { /* preserve ordinary claim behavior; validation will surface corruption */ }
      const maxRuns = typeof payload.maxRuns === "number" && Number.isInteger(payload.maxRuns) && payload.maxRuns > 0 ? payload.maxRuns : null;
      const runCount = typeof payload.runCount === "number" && Number.isInteger(payload.runCount) ? payload.runCount : 0;
      if (maxRuns !== null && runCount >= maxRuns) {
        exhausted = true;
        const exhaustedPayload = { ...payload, lastError: `routine run cap reached (${maxRuns})` };
        this.db.prepare("UPDATE research_routines SET status = 'paused', payload_json = ?, lease_id = NULL, lease_expires_at = NULL, updated_at = ? WHERE id = ?").run(safeJson(exhaustedPayload), now.toISOString(), id);
        return undefined;
      }
      const expires = new Date(now.getTime() + leaseMs).toISOString();
      this.db.prepare("UPDATE research_routines SET status = 'running', lease_id = ?, lease_expires_at = ?, updated_at = ? WHERE id = ?").run(ownerId, expires, now.toISOString(), id);
      this.db.prepare("INSERT INTO research_routine_runs (id, routine_id, owner_id, status, started_at, finished_at, exit_code, error) VALUES (?, ?, ?, 'running', ?, NULL, NULL, NULL)").run(randomUUID(), id, ownerId, now.toISOString());
      return this.routine(id);
    })();
    if (exhausted) this.appendEvent("routine.max_runs_reached", { id, ownerId });
    if (claimed) this.appendEvent("routine.claimed", { id, ownerId, leaseExpiresAt: claimed.leaseExpiresAt, forced: force });
    return claimed;
  }

  finishRoutine(id: string, ownerId: string, result: "completed" | "failed", error?: string, exitCode?: number): ResearchRoutine {
    const current = this.routine(id);
    if (!current) throw new Error(`Unknown routine '${id}'.`);
    if (current.status !== "running" || current.leaseId !== ownerId) throw new Error(`Routine '${id}' is not owned by this runner.`);
    const now = new Date();
    const failureStreak = result === "failed" ? (current.failureStreak ?? 0) + 1 : 0;
    const circuitBroken = failureStreak >= 3;
    const pendingTrigger = !circuitBroken && (current.pendingTriggers ?? 0) > 0;
    // Back off failed routines so a provider or executor outage cannot turn a
    // recurring campaign into a tight retry loop. Successful coalesced wakeups
    // remain immediate; failures retain the wakeup but defer it with a bounded
    // exponential delay. The circuit breaker still pauses after three misses.
    const retryDelaySeconds = result === "failed"
      ? Math.min(current.intervalSeconds * (2 ** failureStreak), 60 * 60)
      : current.intervalSeconds;
    const nextRunAt = pendingTrigger ? now.toISOString() : new Date(now.getTime() + retryDelaySeconds * 1000).toISOString();
    this.db.prepare("UPDATE research_routine_runs SET status = ?, finished_at = ?, exit_code = ?, error = ? WHERE id = (SELECT id FROM research_routine_runs WHERE routine_id = ? AND owner_id = ? AND status = 'running' ORDER BY started_at DESC LIMIT 1)").run(result, now.toISOString(), exitCode ?? (result === "completed" ? 0 : 1), error ?? null, id, ownerId);
    const remainingTriggers = pendingTrigger && current.catchUpPolicy === "replay" ? Math.max(0, (current.pendingTriggers ?? 0) - 1) : pendingTrigger ? 0 : circuitBroken ? 0 : current.pendingTriggers ?? 0;
    const updated: ResearchRoutine = { ...current, status: circuitBroken ? "paused" : "active", nextRunAt, pendingTriggers: remainingTriggers, pendingTriggerEvent: pendingTrigger ? current.pendingTriggerEvent : null, lastRunAt: now.toISOString(), lastResult: result, lastError: error ?? null, runCount: current.runCount + 1, failureStreak, leaseId: null, leaseExpiresAt: null, updatedAt: now.toISOString() };
    this.saveRoutine(updated);
    this.appendEvent(`routine.${result}`, { id, runCount: updated.runCount, nextRunAt, retryDelaySeconds, pendingTrigger, failureStreak, circuitBroken, error: error ?? null });
    if (circuitBroken) this.appendEvent("routine.failure_circuit_open", { id, failureStreak, threshold: 3, action: "paused_until_operator_resume" });
    return this.routine(id) ?? updated;
  }

  setRoutineStatus(id: string, status: Exclude<RoutineStatus, "running">): ResearchRoutine {
    const current = this.routine(id);
    if (!current) throw new Error(`Unknown routine '${id}'.`);
    if (current.status === "running") throw new Error(`Routine '${id}' is running; interrupt its campaign before changing routine state.`);
    if (current.status === status) return current;
    const updated: ResearchRoutine = { ...current, status, failureStreak: status === "active" ? 0 : current.failureStreak ?? 0, leaseId: null, leaseExpiresAt: null, updatedAt: new Date().toISOString() };
    this.saveRoutine(updated);
    this.appendEvent(`routine.${status}`, { id });
    return this.routine(id) ?? updated;
  }

  setRoutineMaxRuns(id: string, maxRuns: number | null): ResearchRoutine {
    const current = this.routine(id);
    if (!current) throw new Error(`Unknown routine '${id}'.`);
    if (current.status === "running") throw new Error(`Routine '${id}' is running; change its limit after the current run finishes.`);
    if (maxRuns !== null && (!Number.isInteger(maxRuns) || maxRuns < 1)) throw new Error("Routine maxRuns must be null or a positive integer.");
    const updated: ResearchRoutine = { ...current, maxRuns, lastError: null, updatedAt: new Date().toISOString() };
    this.saveRoutine(updated);
    this.appendEvent("routine.max_runs_updated", { id, maxRuns });
    return this.routine(id) ?? updated;
  }

  setRoutineCatchUpPolicy(id: string, catchUpPolicy: RoutineCatchUpPolicy): ResearchRoutine {
    if (catchUpPolicy !== "coalesce" && catchUpPolicy !== "replay") throw new Error("Routine catch-up policy must be 'coalesce' or 'replay'.");
    const current = this.routine(id);
    if (!current) throw new Error(`Unknown routine '${id}'.`);
    if (current.status === "running") throw new Error(`Routine '${id}' is running; change its catch-up policy after the current run finishes.`);
    const pendingTriggers = catchUpPolicy === "coalesce" && (current.pendingTriggers ?? 0) > 0 ? 1 : current.pendingTriggers ?? 0;
    const updated: ResearchRoutine = { ...current, catchUpPolicy, pendingTriggers, updatedAt: new Date().toISOString() };
    this.saveRoutine(updated);
    this.appendEvent("routine.catch_up_policy_updated", { id, from: current.catchUpPolicy ?? "coalesce", to: catchUpPolicy, pendingTriggers });
    return this.routine(id) ?? updated;
  }

  recoverStaleRoutines(now = new Date(), source = "scheduler"): string[] {
    const rows = this.db.prepare("SELECT id FROM research_routines WHERE status = 'running' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?").all(now.toISOString()) as Array<{ id: string }>;
    return rows.flatMap((row) => this.recoverStaleRoutine(row.id, now, source) ? [row.id] : []);
  }

  /** Reclaim exactly one expired routine lease for a remote or local operator. */
  recoverStaleRoutine(id: string, now = new Date(), source = "operator"): ResearchRoutine | undefined {
    const timestamp = now.toISOString();
    const recovered = this.db.transaction(() => {
      const row = this.db.prepare("SELECT status, lease_expires_at FROM research_routines WHERE id = ?").get(id) as { status: string; lease_expires_at: string | null } | undefined;
      if (!row || row.status !== "running" || !row.lease_expires_at || Date.parse(row.lease_expires_at) > now.getTime()) return false;
      const result = this.db.prepare("UPDATE research_routines SET status = 'active', lease_id = NULL, lease_expires_at = NULL, updated_at = ? WHERE id = ? AND status = 'running' AND lease_expires_at <= ?").run(timestamp, id, timestamp);
      if (result.changes !== 1) return false;
      this.db.prepare("UPDATE research_routine_runs SET status = 'abandoned', finished_at = ?, exit_code = NULL, error = ? WHERE id = (SELECT id FROM research_routine_runs WHERE routine_id = ? AND status = 'running' ORDER BY started_at DESC LIMIT 1)").run(timestamp, "runner lease expired", id);
      return true;
    })();
    if (!recovered) return undefined;
    this.appendEvent("routine.stale_recovered", { id, source: source.trim().slice(0, 80) || "recovery" });
    return this.routine(id);
  }

  queueTasks(status?: QueueTaskStatus): QueuedTask[] {
    const now = new Date().toISOString();
    const rows = (status === "queued"
      ? this.db.prepare("SELECT * FROM work_queue WHERE status = ? ORDER BY (priority + MIN(3.0, MAX(0.0, (julianday(?) - julianday(available_at)) * 24.0))) DESC, available_at ASC").all(status, now)
      : status
      ? this.db.prepare("SELECT * FROM work_queue WHERE status = ? ORDER BY priority DESC, available_at ASC").all(status)
      : this.db.prepare("SELECT * FROM work_queue ORDER BY updated_at DESC").all()) as Array<{ id: string; kind: string; priority: number; status: string; payload_json: string; attempts: number; available_at: string; claimed_at: string | null; claim_token: string | null; owner_id: string | null; assignee_id: string | null; required_capabilities_json: string; token_budget: number | null; cost_budget_usd: number | null; approval_status: string; approval_reason: string | null; deadline_at: string | null; goal_id: string | null; parent_task_id: string | null; depends_on_json: string; labels_json: string; updated_at: string }>;
    return rows.map((row) => ({ id: row.id, kind: row.kind, priority: row.priority, status: row.status, payload: JSON.parse(row.payload_json), attempts: row.attempts, availableAt: row.available_at, claimedAt: row.claimed_at, claimToken: row.claim_token, ownerId: row.owner_id, assigneeId: row.assignee_id, requiredCapabilities: JSON.parse(row.required_capabilities_json || "[]") as string[], labels: JSON.parse(row.labels_json || "[]") as string[], tokenBudget: row.token_budget === null ? null : Math.max(0, Number(row.token_budget)), costBudgetUsd: row.cost_budget_usd === null ? null : Math.max(0, Number(row.cost_budget_usd)), approvalStatus: ["none", "pending", "approved", "rejected"].includes(row.approval_status) ? row.approval_status as QueueApprovalStatus : "pending", approvalReason: row.approval_reason, deadlineAt: row.deadline_at, goalId: row.goal_id, parentTaskId: row.parent_task_id, dependsOn: JSON.parse(row.depends_on_json || "[]") as string[], updatedAt: row.updated_at }));
  }

  /** Resolve a bounded parent-task chain for audit, display, and recovery. */
  taskLineage(id: string, maxDepth = 32): QueuedTaskLineage | undefined {
    const tasks = new Map(this.queueTasks().map((task) => [task.id, task]));
    if (!tasks.has(id)) return undefined;
    const taskIds: string[] = [];
    const goalIds: string[] = [];
    const missingParentIds: string[] = [];
    const visited = new Set<string>();
    let currentId: string | null = id;
    let cycle = false;
    let truncated = false;
    for (let depth = 0; currentId !== null; depth += 1) {
      if (depth >= Math.max(1, Math.floor(maxDepth))) { truncated = true; break; }
      if (visited.has(currentId)) { cycle = true; break; }
      visited.add(currentId);
      const task = tasks.get(currentId);
      if (!task) { missingParentIds.push(currentId); break; }
      taskIds.push(task.id);
      if (task.goalId !== null && !goalIds.includes(task.goalId)) goalIds.push(task.goalId);
      if (task.parentTaskId === null) break;
      if (!tasks.has(task.parentTaskId)) { missingParentIds.push(task.parentTaskId); break; }
      currentId = task.parentTaskId;
    }
    return { taskIds, goalIds, missingParentIds, cycle, truncated };
  }

  /** Return bounded descendants for hierarchical cancellation and supervision. */
  private taskDescendantIds(id: string, maxNodes = 4096): string[] {
    const children = new Map<string, string[]>();
    for (const task of this.queueTasks()) {
      if (!task.parentTaskId) continue;
      const siblings = children.get(task.parentTaskId) ?? [];
      siblings.push(task.id);
      children.set(task.parentTaskId, siblings);
    }
    const descendants: string[] = [];
    const pending = [...(children.get(id) ?? [])];
    const visited = new Set<string>([id]);
    while (pending.length && descendants.length < Math.max(1, Math.floor(maxNodes))) {
      const child = pending.shift() as string;
      if (visited.has(child)) continue;
      visited.add(child);
      descendants.push(child);
      pending.push(...(children.get(child) ?? []));
    }
    return descendants;
  }

  /** Return a bounded status roll-up for direct delegated children. */
  queueChildSummary(id: string): QueueChildSummary | undefined {
    const tasks = this.queueTasks();
    if (!tasks.some((task) => task.id === id)) return undefined;
    const summary: QueueChildSummary = { total: 0, unfinished: 0, queued: 0, running: 0, paused: 0, completed: 0, failed: 0, cancelled: 0 };
    for (const task of tasks) {
      if (task.parentTaskId !== id) continue;
      summary.total += 1;
      if (task.status in summary && typeof summary[task.status as keyof QueueChildSummary] === "number") summary[task.status as keyof QueueChildSummary] += 1;
    }
    summary.unfinished = summary.total - summary.completed - summary.failed - summary.cancelled;
    return summary;
  }

  private taskDependenciesReady(id: string): boolean {
    return this.taskReadiness(id)?.ready === true;
  }

  private taskDeadlineReady(id: string, now = Date.now()): boolean {
    const row = this.db.prepare("SELECT deadline_at FROM work_queue WHERE id = ?").get(id) as { deadline_at: string | null } | undefined;
    if (!row?.deadline_at) return Boolean(row);
    const deadline = Date.parse(row.deadline_at);
    return Number.isFinite(deadline) && deadline > now;
  }

  private taskDeadlineExpired(id: string, now = Date.now()): boolean {
    const row = this.db.prepare("SELECT deadline_at FROM work_queue WHERE id = ?").get(id) as { deadline_at: string | null } | undefined;
    if (!row?.deadline_at) return false;
    const deadline = Date.parse(row.deadline_at);
    return Number.isFinite(deadline) && deadline <= now;
  }

  /** Explain why a queued task can or cannot be checked out. */
  taskReadiness(id: string): { ready: boolean; missing: string[]; pending: string[]; failed: string[] } | undefined {
    const row = this.db.prepare("SELECT depends_on_json FROM work_queue WHERE id = ?").get(id) as { depends_on_json: string } | undefined;
    if (!row) return undefined;
    let dependencies: unknown;
    try { dependencies = JSON.parse(row.depends_on_json || "[]"); } catch { return { ready: false, missing: [], pending: [], failed: ["invalid dependency metadata"] }; }
    if (!Array.isArray(dependencies)) return { ready: false, missing: [], pending: [], failed: ["invalid dependency metadata"] };
    const missing: string[] = [];
    const pending: string[] = [];
    const failed: string[] = [];
    for (const dependency of dependencies.filter((entry): entry is string => typeof entry === "string")) {
      const status = this.db.prepare("SELECT status FROM work_queue WHERE id = ?").get(dependency) as { status: string } | undefined;
      if (!status) missing.push(dependency);
      else if (status.status === "completed") continue;
      else if (["failed", "cancelled"].includes(status.status)) failed.push(dependency);
      else pending.push(dependency);
    }
    return { ready: missing.length === 0 && pending.length === 0 && failed.length === 0, missing, pending, failed };
  }

  claimNextTask(kinds?: string[], ownerId?: string, workerCapabilities?: string[], workerCapacity?: number | null): QueuedTask | undefined {
    if (this.queueControl().paused) return undefined;
    this.expireDeadlineTasks();
    const now = new Date().toISOString();
    const transaction = this.db.transaction(() => {
      const control = this.db.prepare("SELECT paused FROM queue_control WHERE id = 1").get() as { paused: number } | undefined;
      if (control?.paused === 1) return undefined;
      if (ownerId && workerCapacity !== null && workerCapacity !== undefined) {
        const active = (this.db.prepare("SELECT COUNT(*) AS count FROM work_queue WHERE owner_id = ? AND status = 'running'").get(ownerId) as { count: number }).count;
        if (active >= workerCapacity) return undefined;
      }
      // Preserve explicit priority while giving long-waiting work a bounded
      // boost. One point per hour, capped at three, prevents a steady stream
      // of newer high-priority tickets from starving durable background work.
      const order = "(priority + MIN(3.0, MAX(0.0, (julianday(?) - julianday(available_at)) * 24.0))) DESC, available_at ASC";
      const assignment = ownerId ? " AND (assignee_id IS NULL OR assignee_id = ?)" : " AND assignee_id IS NULL";
      const query = kinds?.length
        ? `SELECT id FROM work_queue WHERE status = 'queued' AND approval_status IN ('none', 'approved') AND available_at <= ?${assignment} AND kind IN (${kinds.map(() => "?").join(",")}) ORDER BY ${order} LIMIT 1`
        : `SELECT id FROM work_queue WHERE status = 'queued' AND approval_status IN ('none', 'approved') AND available_at <= ?${assignment} ORDER BY ${order} LIMIT 1`;
      const params = ownerId ? (kinds?.length ? [now, ownerId, ...kinds, now] : [now, ownerId, now]) : (kinds?.length ? [now, ...kinds, now] : [now, now]);
      const rows = this.db.prepare(query.replace("LIMIT 1", "")).all(...params) as Array<{ id: string }>;
      const capabilities = new Set(normalizeQueueCapabilities(workerCapabilities));
      const row = rows.find((candidate) => {
        const task = this.queueTasks().find((entry) => entry.id === candidate.id);
        return Boolean(task && task.requiredCapabilities.every((capability) => capabilities.has(capability)) && this.taskDependenciesReady(candidate.id) && this.taskDeadlineReady(candidate.id, Date.parse(now)) && this.queueUsageState(candidate.id)?.exhausted !== true);
      });
      if (!row) return undefined;
      const claimToken = randomUUID();
      this.db.prepare("UPDATE work_queue SET status = 'running', attempts = attempts + 1, claimed_at = ?, claim_token = ?, owner_id = ?, updated_at = ? WHERE id = ? AND status = 'queued'").run(now, claimToken, ownerId ?? null, now, row.id);
      return this.queueTasks().find((task) => task.id === row.id);
    });
    const task = transaction();
    if (task) this.appendEvent("queue.claimed", { id: task.id, kind: task.kind, attempts: task.attempts, ownerId: task.ownerId });
    return task;
  }

  /** Atomically claim one known task, preserving queue ownership across controllers. */
  claimTask(id: string, kinds?: string[], ownerId?: string, workerCapabilities?: string[], workerCapacity?: number | null): QueuedTask | undefined {
    if (this.queueControl().paused) return undefined;
    this.expireDeadlineTasks();
    const now = new Date().toISOString();
    const transaction = this.db.transaction(() => {
      const control = this.db.prepare("SELECT paused FROM queue_control WHERE id = 1").get() as { paused: number } | undefined;
      if (control?.paused === 1) return undefined;
      if (ownerId && workerCapacity !== null && workerCapacity !== undefined) {
        const active = (this.db.prepare("SELECT COUNT(*) AS count FROM work_queue WHERE owner_id = ? AND status = 'running'").get(ownerId) as { count: number }).count;
        if (active >= workerCapacity) return undefined;
      }
      const kindClause = kinds?.length ? ` AND kind IN (${kinds.map(() => "?").join(",")})` : "";
      const assignmentClause = ownerId ? " AND (assignee_id IS NULL OR assignee_id = ?)" : " AND assignee_id IS NULL";
      if (this.queueUsageState(id)?.exhausted === true) return undefined;
      if (!this.taskDeadlineReady(id, Date.parse(now))) return undefined;
      if (!this.taskDependenciesReady(id)) return undefined;
      const task = this.queueTasks().find((entry) => entry.id === id);
      const capabilities = new Set(normalizeQueueCapabilities(workerCapabilities));
      if (!task || !task.requiredCapabilities.every((capability) => capabilities.has(capability))) return undefined;
      const claimToken = randomUUID();
      const result = this.db.prepare(`UPDATE work_queue SET status = 'running', attempts = attempts + 1, claimed_at = ?, claim_token = ?, owner_id = ?, updated_at = ? WHERE id = ? AND status = 'queued' AND approval_status IN ('none', 'approved') AND available_at <= ?${assignmentClause}${kindClause}`)
        .run(now, claimToken, ownerId ?? null, now, id, now, ...(ownerId ? [ownerId] : []), ...(kinds ?? []));
      if (result.changes !== 1) return undefined;
      return this.queueTasks().find((task) => task.id === id);
    });
    const task = transaction();
    if (task) this.appendEvent("queue.claimed", { id: task.id, kind: task.kind, attempts: task.attempts, ownerId: task.ownerId });
    return task;
  }

  updateTask(id: string, status: QueueTaskStatus, payload?: unknown): void {
    if (status === "completed") {
      const audit = this.taskCompletionAudit(id, payload);
      if (!audit.valid) {
        this.appendEvent("queue.completion.rejected", { id, missing: audit.missing, source: "updateTask" });
        throw new Error(`Queue completion proof rejected for '${id}': ${audit.missing.join(", ")}`);
      }
    }
    const current = this.queueTasks().find((task) => task.id === id);
    const now = new Date().toISOString();
    this.db.prepare("UPDATE work_queue SET status = ?, payload_json = COALESCE(?, payload_json), owner_id = CASE WHEN ? IN ('completed', 'failed', 'cancelled') THEN NULL ELSE owner_id END, claim_token = CASE WHEN ? IN ('completed', 'failed', 'cancelled') THEN NULL ELSE claim_token END, updated_at = ? WHERE id = ?").run(status, payload === undefined ? null : safeJson(status === "completed" ? preserveQueuePayload(current?.payload, payload) : payload), status, status, now, id);
    this.appendEvent(`queue.${status}`, { id, payload });
  }

  /** Assign or unassign queued work without changing its live claim owner. */
  assignTask(id: string, assigneeId: string | null, actorId = "operator"): boolean {
    const normalized = assigneeId?.trim() || null;
    const now = new Date().toISOString();
    const result = this.db.prepare("UPDATE work_queue SET assignee_id = ?, updated_at = ? WHERE id = ? AND status IN ('queued', 'failed')").run(normalized, now, id);
    if (result.changes !== 1) return false;
    this.appendEvent("queue.assigned", { id, assigneeId: normalized, actorId: actorId.trim().slice(0, 200) || "operator" });
    return true;
  }

  /** Change scheduling priority only for work that is not currently running. */
  setTaskPriority(id: string, priority: number): boolean {
    const normalized = Number(priority);
    if (!Number.isFinite(normalized) || normalized < -1_000_000 || normalized > 1_000_000) throw new Error("Queue task priority must be a finite number between -1,000,000 and 1,000,000.");
    const current = this.db.prepare("SELECT status, priority FROM work_queue WHERE id = ?").get(id) as { status: QueueTaskStatus; priority: number } | undefined;
    if (!current || !["queued", "paused", "failed"].includes(current.status)) return false;
    const now = new Date().toISOString();
    const result = this.db.prepare("UPDATE work_queue SET priority = ?, updated_at = ? WHERE id = ? AND status IN ('queued', 'paused', 'failed')").run(normalized, now, id);
    if (result.changes !== 1) return false;
    this.appendEvent("queue.priority.updated", { id, from: current.priority, priority: normalized, status: current.status });
    return true;
  }

  /** Replace labels only for work that is not currently running. */
  setTaskLabels(id: string, labels: string[] | null): boolean {
    const normalized = normalizeQueueLabels(labels ?? []);
    const current = this.db.prepare("SELECT status FROM work_queue WHERE id = ?").get(id) as { status: QueueTaskStatus } | undefined;
    if (!current || !["queued", "paused", "failed"].includes(current.status)) return false;
    const now = new Date().toISOString();
    const result = this.db.prepare("UPDATE work_queue SET labels_json = ?, updated_at = ? WHERE id = ? AND status IN ('queued', 'paused', 'failed')").run(safeJson(normalized), now, id);
    if (result.changes !== 1) return false;
    this.appendEvent("queue.labels.updated", { id, labels: normalized, status: current.status });
    return true;
  }

  /** Set or clear a task token ceiling without mutating a live claim. */
  setTaskTokenBudget(id: string, tokenBudget: number | null): boolean {
    const normalizedBudget = normalizeQueueTokenBudget(tokenBudget);
    const current = this.db.prepare("SELECT status, token_budget FROM work_queue WHERE id = ?").get(id) as { status: QueueTaskStatus; token_budget: number | null } | undefined;
    if (!current || !["queued", "failed"].includes(current.status)) return false;
    const now = new Date().toISOString();
    const result = this.db.prepare("UPDATE work_queue SET token_budget = ?, updated_at = ? WHERE id = ? AND status IN ('queued', 'failed')").run(normalizedBudget, now, id);
    if (result.changes !== 1) return false;
    this.appendEvent("queue.budget.updated", { id, priorBudget: current.token_budget, tokenBudget: normalizedBudget, status: current.status });
    return true;
  }

  /** Set or clear a task USD ceiling without mutating a live claim. */
  setTaskCostBudget(id: string, costBudgetUsd: number | null): boolean {
    const normalizedBudget = normalizeQueueCostBudget(costBudgetUsd);
    const current = this.db.prepare("SELECT status, cost_budget_usd FROM work_queue WHERE id = ?").get(id) as { status: QueueTaskStatus; cost_budget_usd: number | null } | undefined;
    if (!current || !["queued", "failed"].includes(current.status)) return false;
    const now = new Date().toISOString();
    const result = this.db.prepare("UPDATE work_queue SET cost_budget_usd = ?, updated_at = ? WHERE id = ? AND status IN ('queued', 'failed')").run(normalizedBudget, now, id);
    if (result.changes !== 1) return false;
    this.appendEvent("queue.cost_budget.updated", { id, priorBudgetUsd: current.cost_budget_usd, costBudgetUsd: normalizedBudget, status: current.status });
    return true;
  }

  /** Approve, reject, or reset a queue task before checkout. */
  setTaskApproval(id: string, status: QueueApprovalStatus, reason?: string | null, actorId = "operator"): boolean {
    if (!["none", "pending", "approved", "rejected"].includes(status)) throw new Error("Queue approval status must be none, pending, approved, or rejected.");
    const current = this.db.prepare("SELECT status, approval_status, approval_reason FROM work_queue WHERE id = ?").get(id) as { status: QueueTaskStatus; approval_status: string; approval_reason: string | null } | undefined;
    if (!current || !["queued", "failed"].includes(current.status)) return false;
    const normalizedReason = status === "none" ? null : reason?.trim().slice(0, 500) || (status === "approved" ? "approved by operator" : status === "rejected" ? "rejected by operator" : "operator approval required");
    if (current.approval_status === status && current.approval_reason === normalizedReason) return false;
    const now = new Date().toISOString();
    const result = this.db.prepare("UPDATE work_queue SET approval_status = ?, approval_reason = ?, updated_at = ? WHERE id = ? AND status IN ('queued', 'failed')").run(status, normalizedReason, now, id);
    if (result.changes !== 1) return false;
    this.appendEvent("queue.approval.updated", { id, from: current.approval_status, status, reason: normalizedReason, actorId: actorId.trim().slice(0, 200) || "operator" });
    return true;
  }

  /** Set or clear a wall-clock deadline without mutating a live claim. */
  setTaskDeadline(id: string, deadlineAt: string | null): boolean {
    const normalizedDeadline = normalizeQueueDeadline(deadlineAt);
    const current = this.db.prepare("SELECT status, deadline_at FROM work_queue WHERE id = ?").get(id) as { status: QueueTaskStatus; deadline_at: string | null } | undefined;
    if (!current || !["queued", "failed"].includes(current.status)) return false;
    const now = new Date().toISOString();
    const result = this.db.prepare("UPDATE work_queue SET deadline_at = ?, updated_at = ? WHERE id = ? AND status IN ('queued', 'failed')").run(normalizedDeadline, now, id);
    if (result.changes !== 1) return false;
    this.appendEvent("queue.deadline.updated", { id, priorDeadlineAt: current.deadline_at, deadlineAt: normalizedDeadline, status: current.status });
    return true;
  }

  /** Attach, replace, or clear proof requirements before a task is claimed. */
  setTaskCompletionContract(id: string, contract: QueueCompletionContract | null): boolean {
    const current = this.queueTasks().find((task) => task.id === id);
    if (!current || !["queued", "failed"].includes(current.status)) return false;
    const payload = current.payload && typeof current.payload === "object" && !Array.isArray(current.payload)
      ? { ...(current.payload as Record<string, unknown>) }
      : {};
    if (contract === null) delete payload.completionContract;
    else payload.completionContract = contract;
    validateQueueCompletionContract(payload);
    const now = new Date().toISOString();
    const result = this.db.prepare("UPDATE work_queue SET payload_json = ?, updated_at = ? WHERE id = ? AND status IN ('queued', 'failed')").run(safeJson(payload), now, id);
    if (result.changes !== 1) return false;
    this.appendEvent("queue.completion_contract.updated", { id, contract });
    return true;
  }

  /** Record bounded, redacted progress that travels with a queue ticket. */
  recordQueueActivity(input: { taskId: string; actorId: string; kind: QueueActivityKind; message: string; metadata?: unknown; claimToken?: string }): boolean {
    const taskId = input.taskId.trim().slice(0, 200);
    const actorId = input.actorId.trim().slice(0, 200);
    const message = redactStructured(input.message.trim().slice(0, 2_000));
    if (!taskId || !actorId || !message || !["started", "progress", "blocked", "comment", "handoff", "completed", "failed"].includes(input.kind)) return false;
    let metadata = input.metadata;
    if (metadata && typeof metadata === "object" && !Array.isArray(metadata) && Object.prototype.hasOwnProperty.call(metadata, "progress")) {
      const details = normalizeQueueProgressDetails((metadata as Record<string, unknown>).progress);
      if (!details) return false;
      metadata = { ...(metadata as Record<string, unknown>), progress: details };
    }
    const task = this.db.prepare("SELECT id FROM work_queue WHERE id = ?").get(taskId) as { id: string } | undefined;
    if (!task) return false;
    if (input.claimToken) {
      const claim = this.db.prepare("SELECT status, owner_id, claim_token FROM work_queue WHERE id = ?").get(taskId) as { status: string; owner_id: string | null; claim_token: string | null } | undefined;
      if (!claim || claim.status !== "running" || claim.owner_id !== actorId || claim.claim_token !== input.claimToken) return false;
    }
    this.appendEvent("queue.activity", { taskId, actorId, kind: input.kind, message, ...(metadata === undefined ? {} : { metadata }) });
    return true;
  }

  /** Attach a checksummed, workspace-relative work product to a live task. */
  recordQueueWorkProduct(input: { taskId: string; actorId: string; name: string; path: string; checksum: string; metadata?: unknown; claimToken?: string }): QueueWorkProduct | undefined {
    const taskId = input.taskId.trim().slice(0, 200);
    const actorId = input.actorId.trim().slice(0, 200);
    const name = input.name.trim().slice(0, 200);
    const path = input.path.trim().slice(0, 500);
    const checksum = input.checksum.trim();
    const pathParts = path.split(/[\\/]+/);
    if (!taskId || !actorId || !name || !path || path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path) || pathParts.includes("..") || !/^sha256:[a-f0-9]{64}$/.test(checksum)) return undefined;
    const task = this.db.prepare("SELECT id FROM work_queue WHERE id = ?").get(taskId) as { id: string } | undefined;
    if (!task) return undefined;
    if (input.claimToken) {
      const claim = this.db.prepare("SELECT status, owner_id, claim_token FROM work_queue WHERE id = ?").get(taskId) as { status: string; owner_id: string | null; claim_token: string | null } | undefined;
      if (!claim || claim.status !== "running" || claim.owner_id !== actorId || claim.claim_token !== input.claimToken) return undefined;
    }
    const product: QueueWorkProduct = { id: `product-${randomUUID()}`, taskId, actorId, name, path, checksum, metadata: input.metadata === undefined ? null : redactStructured(input.metadata), verification: "unverified", createdAt: new Date().toISOString() };
    this.appendEvent("queue.work_product", product);
    return product;
  }

  queueWorkProducts(taskId?: string, limit = 32): QueueWorkProduct[] {
    const boundedLimit = Math.max(1, Math.min(128, Math.floor(limit)));
    const verification = new Map(this.eventsByType("queue.work_product.verified", 2_048).flatMap((event) => {
      const payload = event.payload && typeof event.payload === "object" && !Array.isArray(event.payload) ? event.payload as Record<string, unknown> : {};
      return typeof payload.productId === "string" && (payload.verification === "verified" || payload.verification === "missing" || payload.verification === "mismatch") ? [[payload.productId, payload.verification] as const] : [];
    }));
    return this.eventsByType("queue.work_product", 2_048).flatMap((event) => {
      const payload = event.payload && typeof event.payload === "object" && !Array.isArray(event.payload) ? event.payload as Record<string, unknown> : {};
      if (taskId && payload.taskId !== taskId) return [];
      if (typeof payload.id !== "string" || typeof payload.taskId !== "string" || typeof payload.actorId !== "string" || typeof payload.name !== "string" || typeof payload.path !== "string" || typeof payload.checksum !== "string" || !/^sha256:[a-f0-9]{64}$/.test(payload.checksum)) return [];
      return [{ id: payload.id, taskId: payload.taskId, actorId: payload.actorId, name: payload.name, path: payload.path, checksum: payload.checksum, metadata: payload.metadata ?? null, verification: verification.get(payload.id) ?? "unverified", createdAt: event.createdAt } satisfies QueueWorkProduct];
    }).slice(-boundedLimit);
  }

  /** Verify a product against the controller-visible workspace without promoting it to evidence. */
  verifyQueueWorkProduct(root: string, productId: string): QueueWorkProduct | undefined {
    const product = this.queueWorkProducts().find((entry) => entry.id === productId);
    if (!product) return undefined;
    const rootPath = resolve(root);
    const candidate = resolve(rootPath, product.path);
    const relativePath = relative(rootPath, candidate);
    let status: QueueWorkProduct["verification"] = "missing";
    let observedChecksum: string | null = null;
    if (!relativePath.startsWith("..") && !isSensitiveWorkspacePath(relativePath)) {
      try {
        observedChecksum = sha256File(candidate);
        status = observedChecksum === product.checksum ? "verified" : "mismatch";
      } catch {
        status = "missing";
      }
    }
    this.appendEvent("queue.work_product.verified", { productId, taskId: product.taskId, verification: status, expectedChecksum: product.checksum, observedChecksum });
    return { ...product, verification: status };
  }

  /** Record an operator handoff note with retry-safe transport semantics. */
  recordQueueOperatorNote(input: { taskId: string; message: string; idempotencyKey?: string; actorId?: string }): { recorded: boolean; idempotent: boolean; conflict?: boolean } {
    const taskId = input.taskId.trim().slice(0, 200);
    const message = input.message.trim().slice(0, 2_000);
    const idempotencyKey = input.idempotencyKey?.trim().slice(0, 200) || undefined;
    const actorId = input.actorId?.trim().slice(0, 200) || "operator";
    if (!taskId || !message || (input.idempotencyKey !== undefined && (!idempotencyKey || input.idempotencyKey.length > 200))) return { recorded: false, idempotent: false };
    if (!this.queueTasks().some((task) => task.id === taskId)) return { recorded: false, idempotent: false };
    if (idempotencyKey) {
      const prior = this.eventsByType("queue.activity").find((event) => {
        const payload = event.payload && typeof event.payload === "object" && !Array.isArray(event.payload) ? event.payload as Record<string, unknown> : {};
        const metadata = payload.metadata && typeof payload.metadata === "object" && !Array.isArray(payload.metadata) ? payload.metadata as Record<string, unknown> : {};
        return payload.taskId === taskId && payload.actorId === actorId && payload.kind === "handoff" && metadata.idempotencyKey === idempotencyKey;
      });
      if (prior) {
        const priorPayload = prior.payload && typeof prior.payload === "object" && !Array.isArray(prior.payload) ? prior.payload as Record<string, unknown> : {};
        return priorPayload.message === message ? { recorded: true, idempotent: true } : { recorded: false, idempotent: false, conflict: true };
      }
    }
    const recorded = this.recordQueueActivity({ taskId, actorId, kind: "handoff", message, ...(idempotencyKey ? { metadata: { idempotencyKey } } : {}) });
    return { recorded, idempotent: false };
  }

  queueActivities(taskId?: string, limit = 32): QueueActivity[] {
    const boundedLimit = Math.max(1, Math.min(128, Math.floor(limit)));
    let rows: Array<{ payload_json: string; created_at: string }>;
    try {
      rows = taskId
        ? this.db.prepare("SELECT payload_json, created_at FROM events WHERE type = 'queue.activity' AND json_extract(payload_json, '$.taskId') = ? ORDER BY id DESC LIMIT ?").all(taskId, boundedLimit) as Array<{ payload_json: string; created_at: string }>
        : this.db.prepare("SELECT payload_json, created_at FROM events WHERE type = 'queue.activity' ORDER BY id DESC LIMIT ?").all(boundedLimit) as Array<{ payload_json: string; created_at: string }>;
    } catch {
      // Older SQLite builds may lack JSON1; retain correctness with the
      // bounded event-family fallback rather than making activity unavailable.
      const events = this.eventsByType("queue.activity");
      rows = events.slice(taskId ? 0 : Math.max(0, events.length - boundedLimit)).filter((event) => !taskId || (event.payload && typeof event.payload === "object" && (event.payload as Record<string, unknown>).taskId === taskId)).slice(-boundedLimit).reverse().map((event) => ({ payload_json: JSON.stringify(event.payload), created_at: event.createdAt }));
    }
    return rows.reverse().flatMap((row) => {
      let raw: unknown;
      try { raw = JSON.parse(row.payload_json); } catch { return []; }
      const payload = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
      const id = typeof payload.taskId === "string" ? payload.taskId : "";
      const actorId = typeof payload.actorId === "string" ? payload.actorId : "";
      const kind = payload.kind;
      const message = typeof payload.message === "string" ? payload.message : "";
      if (!id || !actorId || !message || !["started", "progress", "blocked", "comment", "handoff", "completed", "failed"].includes(String(kind)) || (taskId && id !== taskId)) return [];
      return [{ taskId: id, actorId, kind: kind as QueueActivityKind, message, metadata: payload.metadata ?? null, createdAt: row.created_at }];
    });
  }

  /** Build a bounded, provider-neutral progress signal for operator surfaces. */
  queueProgress(taskId: string, now = Date.now(), staleAfterMs = 15 * 60_000): QueueProgress | undefined {
    const task = this.queueTasks().find((entry) => entry.id === taskId);
    if (!task) return undefined;
    const activities = this.queueActivities(taskId, 32);
    const latest = activities.at(-1);
    const progressActivity = activities.slice().reverse().find((entry) => {
      const metadata = entry.metadata && typeof entry.metadata === "object" && !Array.isArray(entry.metadata) ? entry.metadata as Record<string, unknown> : {};
      return metadata.progress && typeof metadata.progress === "object" && !Array.isArray(metadata.progress);
    });
    const progressMetadata = progressActivity?.metadata && typeof progressActivity.metadata === "object" && !Array.isArray(progressActivity.metadata)
      ? (progressActivity.metadata as Record<string, unknown>).progress
      : undefined;
    const details = normalizeQueueProgressDetails(progressMetadata) ?? { percent: null, step: null, completed: null, total: null };
    const lastActivityAt = latest?.createdAt ?? null;
    const lastActivityMs = lastActivityAt ? Date.parse(lastActivityAt) : Number.NaN;
    const heartbeatMs = task.claimedAt ? Date.parse(task.claimedAt) : Number.NaN;
    const heartbeatAgeSeconds = Number.isFinite(heartbeatMs) ? Math.max(0, Math.floor((now - heartbeatMs) / 1_000)) : null;
    const idleSeconds = Number.isFinite(lastActivityMs) ? Math.max(0, Math.floor((now - lastActivityMs) / 1_000)) : null;
    const stalled = task.status === "running" && (!Number.isFinite(heartbeatMs) || now - heartbeatMs > Math.max(1_000, staleAfterMs));
    const state: QueueProgressState = task.status === "completed" ? "completed"
      : task.status === "failed" ? "failed"
        : task.status === "cancelled" ? "cancelled"
          : task.status === "paused" ? "paused"
            : task.status === "queued" ? "queued"
              : stalled ? "stalled"
                : latest?.kind === "blocked" ? "blocked"
                  : "active";
    return { state, lastActivityAt, lastActivityKind: latest?.kind ?? null, lastActivityMessage: latest?.message ?? null, idleSeconds, heartbeatAgeSeconds, stalled, details };
  }

  /** Return the bounded lifecycle stream for one queue ticket, not just worker notes. */
  queueHistory(taskId: string, limit = 64): QueueHistoryEntry[] {
    const id = taskId.trim();
    if (!id) return [];
    const boundedLimit = Math.max(1, Math.min(128, Math.floor(limit)));
    const rows = this.db.prepare("SELECT type, payload_json, created_at FROM events WHERE type LIKE 'queue.%' ORDER BY id DESC LIMIT 2048").all() as Array<{ type: string; payload_json: string; created_at: string }>;
    const matching: QueueHistoryEntry[] = [];
    for (const row of rows) {
      let payload: unknown;
      try { payload = JSON.parse(row.payload_json); } catch { continue; }
      const record = payload && typeof payload === "object" && !Array.isArray(payload) ? payload as Record<string, unknown> : {};
      if (record.id !== id && record.taskId !== id) continue;
      matching.push({ type: row.type, payload: redactStructured(payload), createdAt: row.created_at });
      if (matching.length >= boundedLimit) break;
    }
    return matching.reverse();
  }

  /** Return redacted checkpoint metadata without exposing resumable contents. */
  queueCheckpoint(id: string): QueueCheckpointSummary | undefined {
    const task = this.queueTasks().find((entry) => entry.id === id);
    if (!task) return undefined;
    const payload = task.payload && typeof task.payload === "object" && !Array.isArray(task.payload)
      ? task.payload as Record<string, unknown>
      : {};
    const checkpoint = payload.checkpoint;
    if (checkpoint === undefined) return { present: false, bytes: 0, hash: null, updatedAt: null, keys: [], stage: null };
    const encoded = JSON.stringify(checkpoint) ?? "";
    const checkpointEvent = this.queueHistory(id, 128).filter((entry) => entry.type === "queue.checkpoint").at(-1);
    const eventPayload = checkpointEvent?.payload && typeof checkpointEvent.payload === "object" ? checkpointEvent.payload as Record<string, unknown> : {};
    const keys = checkpoint && typeof checkpoint === "object" && !Array.isArray(checkpoint)
      ? Object.keys(checkpoint as Record<string, unknown>).slice(0, 32)
      : [];
    const stage = checkpoint && typeof checkpoint === "object" && !Array.isArray(checkpoint) && typeof (checkpoint as Record<string, unknown>).stage === "string"
      ? String((checkpoint as Record<string, unknown>).stage).slice(0, 160)
      : null;
    return {
      present: true,
      bytes: typeof eventPayload.bytes === "number" ? eventPayload.bytes : Buffer.byteLength(encoded, "utf8"),
      hash: typeof eventPayload.checkpointHash === "string" ? eventPayload.checkpointHash : createHash("sha256").update(encoded).digest("hex").slice(0, 20),
      updatedAt: checkpointEvent?.createdAt ?? task.updatedAt,
      keys,
      stage,
    };
  }

  /** Build bounded, secret-safe context for a worker reclaiming a task. */
  queueResumeContext(id: string, activityLimit = 8): QueueResumeContext | undefined {
    const task = this.queueTasks().find((entry) => entry.id === id);
    if (!task) return undefined;
    return {
      taskId: task.id,
      attempt: task.attempts,
      lineage: this.taskLineage(task.id) ?? { taskIds: [task.id], goalIds: [], missingParentIds: [], cycle: false, truncated: false },
      checkpoint: this.queueCheckpoint(task.id) ?? { present: false, bytes: 0, hash: null, updatedAt: null, keys: [], stage: null },
      recentActivity: this.queueActivities(task.id, Math.max(1, Math.min(16, Math.floor(activityLimit)))),
      workProducts: this.queueWorkProducts(task.id, Math.max(1, Math.min(16, Math.floor(activityLimit)))),
      updatedAt: task.updatedAt,
    };
  }

  /**
   * Check whether a worker supplied the proof promised by a task's contract.
   * Tasks without a contract remain backward compatible and accept completion.
   */
  taskCompletionAudit(id: string, completionPayload: unknown): { valid: boolean; missing: string[]; contract?: QueueCompletionContract } {
    const task = this.queueTasks().find((entry) => entry.id === id);
    const raw = task?.payload && typeof task.payload === "object" && !Array.isArray(task.payload)
      ? (task.payload as Record<string, unknown>).completionContract
      : undefined;
    if (raw === undefined) return { valid: true, missing: [] };
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { valid: false, missing: ["valid completionContract"] };
    const value = raw as Record<string, unknown>;
    const requiredPayloadKeys = Array.isArray(value.requiredPayloadKeys)
      ? value.requiredPayloadKeys.filter((key): key is string => typeof key === "string" && key.length > 0 && key.length <= 120).slice(0, 32)
      : [];
    const requiredEvidenceRefs = Array.isArray(value.requiredEvidenceRefs)
      ? value.requiredEvidenceRefs.filter((ref): ref is string => typeof ref === "string" && ref.trim().length > 0 && ref.length <= 240).slice(0, 64)
      : [];
    const requiredActivityKinds = Array.isArray(value.requiredActivityKinds)
      ? value.requiredActivityKinds.filter((kind): kind is QueueActivityKind => typeof kind === "string" && QUEUE_ACTIVITY_KINDS.includes(kind as QueueActivityKind)).slice(0, 16)
      : [];
    const requireChildCompletion = value.requireChildCompletion === true;
    const contract: QueueCompletionContract = { requiredPayloadKeys, requiredEvidenceRefs, requiredActivityKinds, ...(requireChildCompletion ? { requireChildCompletion: true } : {}) };
    const payloadObject = completionPayload && typeof completionPayload === "object" && !Array.isArray(completionPayload)
      ? completionPayload as Record<string, unknown>
      : {};
    const missing: string[] = [];
    for (const key of requiredPayloadKeys) {
      if (!(key in payloadObject) || payloadObject[key] === undefined || payloadObject[key] === null) missing.push(`payload:${key}`);
    }
    for (const reference of requiredEvidenceRefs) {
      if (!this.evidenceReferenceExists(reference)) missing.push(`evidence:${reference}`);
    }
    const activities = this.queueActivities(id, 128);
    for (const kind of requiredActivityKinds) {
      if (!activities.some((activity) => activity.kind === kind)) missing.push(`activity:${kind}`);
    }
    if (requireChildCompletion) {
      const children = this.queueTasks().filter((entry) => entry.parentTaskId === id);
      if (!children.length) missing.push("children:at-least-one");
      for (const child of children) if (child.status !== "completed") missing.push(`child:${child.id}:${child.status}`);
    }
    return { valid: missing.length === 0, missing, contract };
  }

  /** Record bounded provider-neutral usage reported by a queue worker. */
  recordQueueUsage(input: { taskId: string; actorId: string; inputTokens?: number; outputTokens?: number; costUsd?: number | null; provider?: string | null; model?: string | null; idempotencyKey?: string | null; claimToken?: string }): boolean {
    const taskId = input.taskId.trim().slice(0, 200);
    const actorId = input.actorId.trim().slice(0, 200);
    const inputTokens = Number.isFinite(input.inputTokens) ? Math.floor(input.inputTokens ?? 0) : -1;
    const outputTokens = Number.isFinite(input.outputTokens) ? Math.floor(input.outputTokens ?? 0) : -1;
    const costUsd = input.costUsd === null || input.costUsd === undefined ? null : Number(input.costUsd);
    const provider = input.provider?.trim().slice(0, 80) || null;
    const model = input.model?.trim().slice(0, 160) || null;
    const idempotencyKey = input.idempotencyKey?.trim().slice(0, 200) || null;
    if (!taskId || !actorId || inputTokens < 0 || outputTokens < 0 || inputTokens > 100_000_000 || outputTokens > 100_000_000 || (costUsd !== null && (!Number.isFinite(costUsd) || costUsd < 0 || costUsd > 1_000_000)) || (input.idempotencyKey !== undefined && !idempotencyKey)) return false;
    const task = this.db.prepare("SELECT id FROM work_queue WHERE id = ?").get(taskId) as { id: string } | undefined;
    if (!task) return false;
    if (input.claimToken) {
      const claim = this.db.prepare("SELECT status, owner_id, claim_token FROM work_queue WHERE id = ?").get(taskId) as { status: string; owner_id: string | null; claim_token: string | null } | undefined;
      if (!claim || claim.status !== "running" || claim.owner_id !== actorId || claim.claim_token !== input.claimToken) return false;
    }
    if (this.taskDeadlineExpired(taskId)) {
      this.cancelTask(taskId, "task wall-clock deadline exceeded", "deadline");
      return false;
    }
    if (idempotencyKey) {
      try {
        const existing = this.db.prepare("SELECT payload_json FROM events WHERE type = 'queue.usage' AND json_extract(payload_json, '$.taskId') = ? AND json_extract(payload_json, '$.idempotencyKey') = ? LIMIT 1").get(taskId, idempotencyKey) as { payload_json: string } | undefined;
        if (existing) {
          let payload: Record<string, unknown> = {};
          try { payload = JSON.parse(existing.payload_json) as Record<string, unknown>; } catch { /* fall through to conflict */ }
          const same = payload.actorId === actorId && payload.inputTokens === inputTokens && payload.outputTokens === outputTokens && (payload.costUsd ?? null) === costUsd && (payload.provider ?? null) === provider && (payload.model ?? null) === model;
          if (!same) this.appendEvent("queue.usage.idempotency_conflict", { taskId, actorId, idempotencyKey });
          return same;
        }
      } catch {
        const existing = this.eventsByType("queue.usage").find((event) => event.payload && typeof event.payload === "object" && (event.payload as Record<string, unknown>).taskId === taskId && (event.payload as Record<string, unknown>).idempotencyKey === idempotencyKey);
        if (existing) {
          const payload = existing.payload as Record<string, unknown>;
          const same = payload.actorId === actorId && payload.inputTokens === inputTokens && payload.outputTokens === outputTokens && (payload.costUsd ?? null) === costUsd && (payload.provider ?? null) === provider && (payload.model ?? null) === model;
          if (!same) this.appendEvent("queue.usage.idempotency_conflict", { taskId, actorId, idempotencyKey });
          return same;
        }
      }
    }
    this.appendEvent("queue.usage", { taskId, actorId, inputTokens, outputTokens, ...(costUsd === null ? {} : { costUsd }), ...(provider === null ? {} : { provider }), ...(model === null ? {} : { model }), ...(idempotencyKey === null ? {} : { idempotencyKey }) });
    // Task budgets are live safety boundaries, not merely claim-time hints.
    // Cancel an active lease as soon as the immutable usage ledger crosses a
    // token or USD ceiling;
    // the worker's next heartbeat/usage request then receives the durable
    // cancellation and can stop before doing another model turn.
    const usageState = this.queueUsageState(taskId);
    const currentStatus = this.db.prepare("SELECT status FROM work_queue WHERE id = ?").get(taskId) as { status: string } | undefined;
    if (usageState?.exhausted && currentStatus?.status === "running") {
      this.cancelTask(taskId, "task token or USD budget exhausted", "budget");
    }
    return true;
  }

  queueUsage(taskId?: string, limit = 128): QueueUsage[] {
    const boundedLimit = Math.max(1, Math.min(512, Math.floor(limit)));
    let rows: Array<{ payload_json: string; created_at: string }>;
    try {
      rows = taskId
        ? this.db.prepare("SELECT payload_json, created_at FROM events WHERE type = 'queue.usage' AND json_extract(payload_json, '$.taskId') = ? ORDER BY id DESC LIMIT ?").all(taskId, boundedLimit) as Array<{ payload_json: string; created_at: string }>
        : this.db.prepare("SELECT payload_json, created_at FROM events WHERE type = 'queue.usage' ORDER BY id DESC LIMIT ?").all(boundedLimit) as Array<{ payload_json: string; created_at: string }>;
    } catch {
      const events = this.eventsByType("queue.usage");
      rows = events.slice(taskId ? 0 : Math.max(0, events.length - boundedLimit)).filter((event) => !taskId || (event.payload && typeof event.payload === "object" && (event.payload as Record<string, unknown>).taskId === taskId)).slice(-boundedLimit).reverse().map((event) => ({ payload_json: JSON.stringify(event.payload), created_at: event.createdAt }));
    }
    return rows.reverse().flatMap((row) => {
      let raw: unknown;
      try { raw = JSON.parse(row.payload_json); } catch { return []; }
      const payload = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
      const id = typeof payload.taskId === "string" ? payload.taskId : "";
      const actorId = typeof payload.actorId === "string" ? payload.actorId : "";
      const inputTokens = Number(payload.inputTokens);
      const outputTokens = Number(payload.outputTokens);
      const costUsd = payload.costUsd === undefined ? null : Number(payload.costUsd);
      const provider = typeof payload.provider === "string" ? payload.provider : null;
      const model = typeof payload.model === "string" ? payload.model : null;
      if (!id || !actorId || !Number.isInteger(inputTokens) || inputTokens < 0 || !Number.isInteger(outputTokens) || outputTokens < 0 || (costUsd !== null && !Number.isFinite(costUsd)) || (taskId && taskId !== id)) return [];
      return [{ taskId: id, actorId, inputTokens, outputTokens, costUsd, provider, model, createdAt: row.created_at }];
    });
  }

  /** Aggregate the complete immutable usage ledger; display history remains bounded separately. */
  queueUsageTotals(taskId?: string): { inputTokens: number; outputTokens: number; costUsd: number } | undefined {
    const normalizedTaskId = taskId?.trim().slice(0, 200);
    if (taskId !== undefined && !normalizedTaskId) return undefined;
    try {
      const query = normalizedTaskId ? `
        SELECT
          COALESCE(SUM(CAST(json_extract(payload_json, '$.inputTokens') AS INTEGER)), 0) AS input_tokens,
          COALESCE(SUM(CAST(json_extract(payload_json, '$.outputTokens') AS INTEGER)), 0) AS output_tokens,
          COALESCE(SUM(CAST(json_extract(payload_json, '$.costUsd') AS REAL)), 0) AS cost_usd
        FROM events
        WHERE type = 'queue.usage' AND json_extract(payload_json, '$.taskId') = ?
      ` : `
        SELECT
          COALESCE(SUM(CAST(json_extract(payload_json, '$.inputTokens') AS INTEGER)), 0) AS input_tokens,
          COALESCE(SUM(CAST(json_extract(payload_json, '$.outputTokens') AS INTEGER)), 0) AS output_tokens,
          COALESCE(SUM(CAST(json_extract(payload_json, '$.costUsd') AS REAL)), 0) AS cost_usd
        FROM events
        WHERE type = 'queue.usage'
      `;
      const row = (normalizedTaskId ? this.db.prepare(query).get(normalizedTaskId) : this.db.prepare(query).get()) as { input_tokens: number; output_tokens: number; cost_usd: number };
      return { inputTokens: Math.max(0, Number(row.input_tokens) || 0), outputTokens: Math.max(0, Number(row.output_tokens) || 0), costUsd: Math.max(0, Number(row.cost_usd) || 0) };
    } catch {
      const totals = this.eventsByType("queue.usage").reduce((current, event) => {
        const payload = event.payload && typeof event.payload === "object" ? event.payload as Record<string, unknown> : {};
        if (normalizedTaskId && payload.taskId !== normalizedTaskId) return current;
        const inputTokens = Number.isInteger(payload.inputTokens) && Number(payload.inputTokens) >= 0 ? Number(payload.inputTokens) : 0;
        const outputTokens = Number.isInteger(payload.outputTokens) && Number(payload.outputTokens) >= 0 ? Number(payload.outputTokens) : 0;
        const costUsd = typeof payload.costUsd === "number" && Number.isFinite(payload.costUsd) && payload.costUsd >= 0 ? payload.costUsd : 0;
        return { inputTokens: current.inputTokens + inputTokens, outputTokens: current.outputTokens + outputTokens, costUsd: current.costUsd + costUsd };
      }, { inputTokens: 0, outputTokens: 0, costUsd: 0 });
      return totals;
    }
  }

  queueUsageState(taskId: string): { usedTokens: number; budgetTokens: number | null; remainingTokens: number | null; usedCostUsd: number; budgetCostUsd: number | null; remainingCostUsd: number | null; exhausted: boolean } | undefined {
    const task = this.queueTasks().find((entry) => entry.id === taskId);
    if (!task) return undefined;
    const totals = this.queueUsageTotals(taskId);
    const usedTokens = (totals?.inputTokens ?? 0) + (totals?.outputTokens ?? 0);
    const budgetTokens = task.tokenBudget;
    const budgetCostUsd = task.costBudgetUsd;
    const usedCostUsd = totals?.costUsd ?? 0;
    const exhausted = (budgetTokens !== null && usedTokens >= budgetTokens) || (budgetCostUsd !== null && usedCostUsd >= budgetCostUsd);
    return { usedTokens, budgetTokens, remainingTokens: budgetTokens === null ? null : Math.max(0, budgetTokens - usedTokens), usedCostUsd, budgetCostUsd, remainingCostUsd: budgetCostUsd === null ? null : Math.max(0, budgetCostUsd - usedCostUsd), exhausted };
  }

  /** Refresh a live claim so stale-task recovery cannot duplicate a healthy worker. */
  heartbeatTask(id: string, ownerId?: string, claimToken?: string): boolean {
    if (this.taskDeadlineExpired(id)) {
      this.cancelTask(id, "task wall-clock deadline exceeded", "deadline");
      return false;
    }
    const now = new Date().toISOString();
    const result = claimToken
      ? this.db.prepare("UPDATE work_queue SET claimed_at = ?, updated_at = ? WHERE id = ? AND status = 'running' AND owner_id = ? AND claim_token = ?").run(now, now, id, ownerId ?? null, claimToken)
      : this.db.prepare("UPDATE work_queue SET claimed_at = ?, updated_at = ? WHERE id = ? AND status = 'running' AND (owner_id = ? OR (? IS NULL AND owner_id IS NULL))").run(now, now, id, ownerId ?? null, ownerId ?? null);
    return result.changes === 1;
  }

  /** Persist bounded resumable state for the current claim without completing it. */
  checkpointClaimedTask(id: string, ownerId: string, checkpoint: unknown, claimToken?: string): boolean {
    const current = this.queueTasks().find((task) => task.id === id);
    if (!current || current.status !== "running" || current.ownerId !== ownerId) return false;
    const encoded = JSON.stringify(checkpoint);
    if (encoded === undefined || encoded.length > 1_000_000) throw new Error("Queue task checkpoint must be at most 1 MiB.");
    const previous = current.payload && typeof current.payload === "object" && !Array.isArray(current.payload) ? current.payload as Record<string, unknown> : {};
    const original = previous._task && typeof previous._task === "object" && !Array.isArray(previous._task) ? previous._task : previous;
    const nextPayload = { ...previous, _task: original, checkpoint };
    const now = new Date().toISOString();
    const result = claimToken
      ? this.db.prepare("UPDATE work_queue SET payload_json = ?, updated_at = ? WHERE id = ? AND status = 'running' AND owner_id = ? AND claim_token = ?").run(safeJson(nextPayload), now, id, ownerId, claimToken)
      : this.db.prepare("UPDATE work_queue SET payload_json = ?, updated_at = ? WHERE id = ? AND status = 'running' AND owner_id = ?").run(safeJson(nextPayload), now, id, ownerId);
    if (result.changes !== 1) return false;
    this.appendEvent("queue.checkpoint", { id, ownerId, bytes: encoded.length, checkpointHash: createHash("sha256").update(encoded).digest("hex").slice(0, 20) });
    return true;
  }

  /** Complete a queue task only when the caller still owns its live claim. */
  completeClaimedTask(id: string, ownerId: string, status: Extract<QueueTaskStatus, "completed" | "failed" | "cancelled">, payload?: unknown, idempotencyKey?: string, claimToken?: string): boolean {
    if (this.taskDeadlineExpired(id)) {
      this.cancelTask(id, "task wall-clock deadline exceeded", "deadline");
      return false;
    }
    if (status === "completed") {
      const audit = this.taskCompletionAudit(id, payload);
      if (!audit.valid) {
        this.appendEvent("queue.completion.rejected", { id, ownerId, missing: audit.missing });
        this.recordQueueActivity({ taskId: id, actorId: ownerId, kind: "blocked", message: `Completion rejected; missing proof: ${audit.missing.join(", ")}` });
        return false;
      }
    }
    const current = this.queueTasks().find((task) => task.id === id);
    const now = new Date().toISOString();
    const result = claimToken
      ? this.db.prepare("UPDATE work_queue SET status = ?, payload_json = COALESCE(?, payload_json), claimed_at = NULL, claim_token = NULL, owner_id = NULL, updated_at = ? WHERE id = ? AND status = 'running' AND owner_id = ? AND claim_token = ?").run(status, payload === undefined ? null : safeJson(preserveQueuePayload(current?.payload, payload)), now, id, ownerId, claimToken)
      : this.db.prepare("UPDATE work_queue SET status = ?, payload_json = COALESCE(?, payload_json), claimed_at = NULL, claim_token = NULL, owner_id = NULL, updated_at = ? WHERE id = ? AND status = 'running' AND owner_id = ?").run(status, payload === undefined ? null : safeJson(preserveQueuePayload(current?.payload, payload)), now, id, ownerId);
    if (result.changes !== 1) return false;
    const normalizedKey = idempotencyKey?.trim().slice(0, 200) || undefined;
    this.appendEvent(`queue.${status}`, { id, ownerId, payload, ...(normalizedKey ? { idempotencyKey: normalizedKey } : {}) });
    return true;
  }

  /** Requeue only the live claim that reported the failure; an operator cancellation wins races. */
  retryClaimedTask(id: string, ownerId: string, payload: unknown, availableAt: string, claimToken?: string): boolean {
    if (this.taskDeadlineExpired(id)) {
      this.cancelTask(id, "task wall-clock deadline exceeded", "deadline");
      return false;
    }
    const now = new Date().toISOString();
    const result = claimToken
      ? this.db.prepare("UPDATE work_queue SET status = 'queued', payload_json = ?, available_at = ?, claimed_at = NULL, claim_token = NULL, owner_id = NULL, updated_at = ? WHERE id = ? AND status = 'running' AND owner_id = ? AND claim_token = ?").run(safeJson(payload), availableAt, now, id, ownerId, claimToken)
      : this.db.prepare("UPDATE work_queue SET status = 'queued', payload_json = ?, available_at = ?, claimed_at = NULL, claim_token = NULL, owner_id = NULL, updated_at = ? WHERE id = ? AND status = 'running' AND owner_id = ?").run(safeJson(payload), availableAt, now, id, ownerId);
    if (result.changes !== 1) return false;
    this.appendEvent("queue.retry_scheduled", { id, availableAt, payload });
    return true;
  }

  /** Voluntarily yield a live claim without counting it as a failed attempt. */
  releaseClaimedTask(id: string, ownerId: string, availableAt = new Date().toISOString(), claimToken?: string, reason = "worker released task"): boolean {
    const timestamp = new Date(Date.parse(availableAt));
    if (!Number.isFinite(timestamp.getTime())) throw new Error("Released task availability must be a valid ISO timestamp.");
    const now = new Date().toISOString();
    const result = claimToken
      ? this.db.prepare("UPDATE work_queue SET status = 'queued', available_at = ?, claimed_at = NULL, claim_token = NULL, owner_id = NULL, updated_at = ? WHERE id = ? AND status = 'running' AND owner_id = ? AND claim_token = ?").run(timestamp.toISOString(), now, id, ownerId, claimToken)
      : this.db.prepare("UPDATE work_queue SET status = 'queued', available_at = ?, claimed_at = NULL, claim_token = NULL, owner_id = NULL, updated_at = ? WHERE id = ? AND status = 'running' AND owner_id = ?").run(timestamp.toISOString(), now, id, ownerId);
    if (result.changes !== 1) return false;
    this.appendEvent("queue.released", { id, ownerId, availableAt: timestamp.toISOString(), reason: reason.trim().slice(0, 400) || "worker released task" });
    return true;
  }

  /** Backward-compatible controller retry for callers that already own queue state. */
  retryTask(id: string, payload: unknown, availableAt: string): void {
    const now = new Date().toISOString();
    this.db.prepare("UPDATE work_queue SET status = 'queued', payload_json = ?, available_at = ?, claimed_at = NULL, claim_token = NULL, owner_id = NULL, updated_at = ? WHERE id = ?").run(safeJson(payload), availableAt, now, id);
    this.appendEvent("queue.retry_scheduled", { id, availableAt, payload });
  }

  /** Cancel queued or running work durably; late worker completion cannot overwrite it. */
  cancelTask(id: string, reason = "operator cancelled task", source = "operator"): boolean {
    const normalizedReason = reason.trim().slice(0, 400) || "operator cancelled task";
    const now = new Date().toISOString();
    const candidateIds = [id, ...this.taskDescendantIds(id)];
    const cancelled: Array<{ id: string; kind: string; status: QueueTaskStatus; ownerId: string | null; parentTaskId: string | null }> = [];
    const parentCancelled = this.db.transaction(() => {
      const root = this.db.prepare("SELECT status FROM work_queue WHERE id = ?").get(id) as { status: QueueTaskStatus } | undefined;
      if (!root || !["queued", "running"].includes(root.status)) return false;
      for (const candidateId of candidateIds) {
        const current = this.db.prepare("SELECT status, kind, owner_id, parent_task_id, payload_json FROM work_queue WHERE id = ?").get(candidateId) as { status: QueueTaskStatus; kind: string; owner_id: string | null; parent_task_id: string | null; payload_json: string } | undefined;
        if (!current || !["queued", "running"].includes(current.status)) continue;
        let payload: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(current.payload_json);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) payload = parsed as Record<string, unknown>;
    } catch { /* preserve cancellation even when an old payload is malformed */ }
        const cancellation = { reason: normalizedReason, cancelledAt: now, ...(candidateId === id ? {} : { parentCancellation: id }) };
        const result = this.db.prepare("UPDATE work_queue SET status = 'cancelled', payload_json = ?, claimed_at = NULL, claim_token = NULL, owner_id = NULL, updated_at = ? WHERE id = ? AND status IN ('queued', 'running')").run(safeJson({ ...payload, cancellation }), now, candidateId);
        if (result.changes === 1) cancelled.push({ id: candidateId, kind: current.kind, status: current.status, ownerId: current.owner_id, parentTaskId: current.parent_task_id });
      }
      return cancelled.some((entry) => entry.id === id);
    })();
    if (!parentCancelled) return false;
    for (const entry of cancelled) {
      this.appendEvent("queue.cancelled", { id: entry.id, kind: entry.kind, priorStatus: entry.status, priorOwnerId: entry.ownerId, parentTaskId: entry.parentTaskId, reason: normalizedReason, cancelledAt: now, source: source.trim().slice(0, 80) || "operator", ...(entry.id === id ? {} : { cascadedFrom: id }) });
    }
    return true;
  }

  /** Materialize expired queued/running deadlines so restart recovery cannot strand them. */
  expireDeadlineTasks(now = new Date()): string[] {
    const rows = this.db.prepare("SELECT id FROM work_queue WHERE status IN ('queued', 'running') AND deadline_at IS NOT NULL AND deadline_at <= ?").all(now.toISOString()) as Array<{ id: string }>;
    const expired: string[] = [];
    for (const row of rows) {
      if (!this.cancelTask(row.id, "task wall-clock deadline exceeded", "deadline")) continue;
      expired.push(row.id);
    }
    return expired;
  }

  /** Cancel queued work belonging to a campaign that hit its hard token ceiling. */
  cancelQueuedTasksForCampaign(campaignStartedAt: string, reason = "campaign agent-token budget exhausted"): string[] {
    const startedAt = campaignStartedAt.trim();
    if (!startedAt) throw new Error("A campaign start timestamp is required to cancel queued work.");
    const now = new Date().toISOString();
    const cancelled: string[] = [];
    const rows = this.db.prepare("SELECT id, kind, payload_json FROM work_queue WHERE status = 'queued'").all() as Array<{ id: string; kind: string; payload_json: string }>;
    for (const row of rows) {
      let payload: Record<string, unknown>;
      try {
        const parsed = JSON.parse(row.payload_json);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
        payload = parsed as Record<string, unknown>;
      } catch {
        continue;
      }
      const campaign = payload.campaign && typeof payload.campaign === "object" && !Array.isArray(payload.campaign)
        ? payload.campaign as Record<string, unknown>
        : undefined;
      const taskStartedAt = typeof payload.campaignStartedAt === "string"
        ? payload.campaignStartedAt
        : typeof campaign?.startedAt === "string" ? campaign.startedAt : undefined;
      if (taskStartedAt !== startedAt) continue;
      const cancellation = { reason: reason.trim().slice(0, 240) || "campaign budget exhausted", cancelledAt: now };
      const nextPayload = { ...payload, cancellation };
      const result = this.db.prepare("UPDATE work_queue SET status = 'cancelled', payload_json = ?, claimed_at = NULL, claim_token = NULL, owner_id = NULL, updated_at = ? WHERE id = ? AND status = 'queued'").run(safeJson(nextPayload), now, row.id);
      if (result.changes !== 1) continue;
      cancelled.push(row.id);
      this.appendEvent("queue.cancelled", { id: row.id, kind: row.kind, reason: cancellation.reason, source: "campaign-budget" });
    }
    return cancelled;
  }

  /** Resume one exhausted task only after an operator declares a changed route. */
  recoverFailedTask(id: string, route: string, note = "operator-selected recovery route"): QueuedTask {
    const normalizedRoute = route.trim().slice(0, 120);
    if (!normalizedRoute) throw new Error("A changed recovery route is required.");
    const current = this.queueTasks().find((task) => task.id === id);
    if (!current) throw new Error(`Unknown queue task '${id}'.`);
    if (current.status !== "failed") throw new Error(`Queue task '${id}' is ${current.status}; only failed tasks can be recovered.`);
    const payload = current.payload && typeof current.payload === "object" && !Array.isArray(current.payload) ? current.payload as Record<string, unknown> : {};
    const previousRecovery = payload.recovery && typeof payload.recovery === "object" ? payload.recovery as Record<string, unknown> : undefined;
    if (previousRecovery?.route === normalizedRoute) throw new Error(`Queue task '${id}' must use a materially different recovery route.`);
    const history = Array.isArray(payload.recoveryHistory) ? payload.recoveryHistory.slice(-7) : [];
    const recovery = { route: normalizedRoute, note: note.trim().slice(0, 400) || "operator-selected recovery route", recoveredAt: new Date().toISOString(), priorAttempts: current.attempts };
    const nextPayload = { ...payload, recoveryHistory: [...history, recovery], recovery };
    const now = new Date().toISOString();
    this.db.prepare("UPDATE work_queue SET status = 'queued', attempts = 0, payload_json = ?, available_at = ?, claimed_at = NULL, claim_token = NULL, owner_id = NULL, updated_at = ? WHERE id = ? AND status = 'failed'").run(safeJson(nextPayload), now, now, id);
    this.appendEvent("queue.recovery_scheduled", { taskId: id, ...recovery });
    return this.queueTasks().find((task) => task.id === id) ?? { ...current, status: "queued", attempts: 0, payload: nextPayload, availableAt: now, claimedAt: null, ownerId: null, updatedAt: now };
  }

  requeueStaleTasks(maxAgeMs = 15 * 60_000, maxAttempts = 3): number {
    this.expireDeadlineTasks();
    const cutoff = new Date(Date.now() - maxAgeMs).toISOString();
    const limit = Math.max(1, Math.floor(maxAttempts));
    const now = new Date().toISOString();
    const exhaustedRecovery: Array<{ taskId: string; kind: string; attempts: number; recovery: ReturnType<typeof queueRecoveryAction> }> = [];
    const result = this.db.transaction(() => {
      const staleRows = this.db.prepare("SELECT id, kind, owner_id, assignee_id FROM work_queue WHERE status = 'running' AND updated_at < ? AND attempts < ?").all(cutoff, limit) as Array<{ id: string; kind: string; owner_id: string | null; assignee_id: string | null }>;
      const requeued = this.db.prepare("UPDATE work_queue SET status = 'queued', claimed_at = NULL, claim_token = NULL, owner_id = NULL, updated_at = ? WHERE status = 'running' AND updated_at < ? AND attempts < ?").run(now, cutoff, limit).changes;
      const exhaustedRows = this.db.prepare("SELECT id, kind, payload_json, attempts FROM work_queue WHERE status = 'running' AND updated_at < ? AND attempts >= ?").all(cutoff, limit) as Array<{ id: string; kind: string; payload_json: string; attempts: number }>;
      for (const row of exhaustedRows) {
        let payload: Record<string, unknown> = {};
        try {
          const parsed = JSON.parse(row.payload_json);
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) payload = parsed as Record<string, unknown>;
        } catch { /* Preserve the queue record even if an older payload was malformed. */ }
        const recovery = queueRecoveryAction(new Error("stale task timeout exceeded bounded attempts"));
        exhaustedRecovery.push({ taskId: row.id, kind: row.kind, attempts: row.attempts, recovery });
        this.db.prepare("UPDATE work_queue SET status = 'failed', payload_json = ?, claimed_at = NULL, claim_token = NULL, owner_id = NULL, updated_at = ? WHERE id = ?").run(safeJson({ ...payload, error: "stale task exceeded bounded attempts", attempts: row.attempts, failedAt: now, recovery }), now, row.id);
      }
      const exhausted = exhaustedRows.length;
      return { requeued, exhausted, staleRows };
    })();
    if (result.requeued) this.appendEvent("queue.stale_requeued", { count: result.requeued, cutoff, maxAttempts: limit });
    for (const row of result.staleRows) this.appendEvent("queue.task.stale_requeued", { taskId: row.id, kind: row.kind, priorOwnerId: row.owner_id, assigneeId: row.assignee_id, cutoff, maxAttempts: limit, requiresReassignment: Boolean(row.assignee_id) });
    if (result.exhausted) this.appendEvent("queue.stale_failed", { count: result.exhausted, cutoff, maxAttempts: limit, reason: "stale task exceeded bounded attempts" });
    for (const entry of exhaustedRecovery) this.appendEvent("queue.recovery_required", { taskId: entry.taskId, kind: entry.kind, attempts: entry.attempts, error: "stale task exceeded bounded attempts", ...entry.recovery });
    return result.requeued;
  }

  startSession(id: string, payload: unknown): void {
    const now = new Date().toISOString();
    const active = this.db.prepare("SELECT payload_json FROM sessions WHERE status = 'active'").all() as Array<{ payload_json: string }>;
    for (const row of active) {
      try {
        const previous = JSON.parse(row.payload_json) as { pid?: number };
        if (previous.pid && previous.pid !== process.pid) process.kill(previous.pid, "SIGTERM");
      } catch { /* an old session may contain a partial payload */ }
    }
    this.db.prepare("UPDATE sessions SET status = 'interrupted', ended_at = ?, updated_at = ? WHERE status = 'active'").run(now, now);
    this.db.prepare("INSERT OR REPLACE INTO sessions (id, status, payload_json, started_at, ended_at, updated_at) VALUES (?, 'active', ?, ?, NULL, ?)").run(id, safeJson(payload), now, now);
    this.appendEvent("session.started", { id });
  }

  saveSession(id: string, payload: unknown): void {
    const now = new Date().toISOString();
    this.db.prepare("UPDATE sessions SET payload_json = ?, updated_at = ? WHERE id = ?").run(safeJson(payload), now, id);
  }

  closeSession(id: string, status: "completed" | "interrupted" = "completed"): void {
    const now = new Date().toISOString();
    this.db.prepare("UPDATE sessions SET status = ?, ended_at = ?, updated_at = ? WHERE id = ?").run(status, now, now, id);
    this.appendEvent(`session.${status}`, { id });
  }

  session(id: string): { id: string; status: string; payload: unknown; startedAt: string; endedAt: string | null; updatedAt: string } | undefined {
    const row = this.db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as { id: string; status: string; payload_json: string; started_at: string; ended_at: string | null; updated_at: string } | undefined;
    return row ? { id: row.id, status: row.status, payload: JSON.parse(row.payload_json), startedAt: row.started_at, endedAt: row.ended_at, updatedAt: row.updated_at } : undefined;
  }

  sessions(limit = 20): Array<{ id: string; status: string; payload: unknown; startedAt: string; endedAt: string | null; updatedAt: string }> {
    const rows = this.db.prepare("SELECT * FROM sessions ORDER BY started_at DESC LIMIT ?").all(limit) as Array<{ id: string; status: string; payload_json: string; started_at: string; ended_at: string | null; updated_at: string }>;
    return rows.map((row) => ({ id: row.id, status: row.status, payload: JSON.parse(row.payload_json), startedAt: row.started_at, endedAt: row.ended_at, updatedAt: row.updated_at }));
  }

  phaseGoals(): Array<{ id: string; phase: string; status: string; payload: unknown; updatedAt: string }> {
    const rows = this.db.prepare("SELECT id, phase, status, payload_json, updated_at FROM phase_goals ORDER BY rowid ASC").all() as Array<{ id: string; phase: string; status: string; payload_json: string; updated_at: string }>;
    return rows.map((row) => ({ id: row.id, phase: row.phase, status: row.status, payload: JSON.parse(row.payload_json), updatedAt: row.updated_at }));
  }

  phaseGoalRevisions(goalId?: string, limit = 32): Array<{ goalId: string; phase: string | null; revision: number; fingerprint: string; previousFingerprint: string; plan: unknown; createdAt: string }> {
    return this.eventsByType("phase_goal.revised", Math.max(1, Math.min(128, Math.floor(limit)))).flatMap((event) => {
      const payload = event.payload && typeof event.payload === "object" ? event.payload as Record<string, unknown> : {};
      if (goalId && payload.goalId !== goalId) return [];
      if (typeof payload.goalId !== "string" || typeof payload.fingerprint !== "string" || typeof payload.previousFingerprint !== "string") return [];
      return [{ goalId: payload.goalId, phase: typeof payload.phase === "string" ? payload.phase : null, revision: typeof payload.revision === "number" ? payload.revision : 0, fingerprint: payload.fingerprint, previousFingerprint: payload.previousFingerprint, plan: payload.plan ?? null, createdAt: event.createdAt }];
    });
  }

  setExperimentGates(experimentId: string, gates: { leakageAuditPassed?: boolean; reviewerApproved?: boolean; notes?: string }): void {
    const current = this.experimentGates(experimentId);
    const updatedAt = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO experiment_gates (experiment_id, leakage_audit_passed, reviewer_approved, notes, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(experiment_id) DO UPDATE SET leakage_audit_passed = excluded.leakage_audit_passed, reviewer_approved = excluded.reviewer_approved, notes = excluded.notes, updated_at = excluded.updated_at
    `).run(experimentId, (gates.leakageAuditPassed ?? current.leakageAuditPassed) ? 1 : 0, (gates.reviewerApproved ?? current.reviewerApproved) ? 1 : 0, gates.notes ?? current.notes, updatedAt);
    const snapshot = this.experimentGates(experimentId);
    this.appendEvent("experiment.gates.updated", { experimentId, leakageAuditPassed: snapshot.leakageAuditPassed, reviewerApproved: snapshot.reviewerApproved, notes: snapshot.notes, updatedAt });
  }

  experimentGates(experimentId: string): { leakageAuditPassed: boolean; reviewerApproved: boolean; notes: string; updatedAt: string } {
    const row = this.db.prepare("SELECT leakage_audit_passed, reviewer_approved, notes, updated_at FROM experiment_gates WHERE experiment_id = ?").get(experimentId) as { leakage_audit_passed: number; reviewer_approved: number; notes: string; updated_at: string } | undefined;
    return row
      ? { leakageAuditPassed: row.leakage_audit_passed === 1, reviewerApproved: row.reviewer_approved === 1, notes: row.notes, updatedAt: row.updated_at }
      : { leakageAuditPassed: false, reviewerApproved: false, notes: "", updatedAt: new Date(0).toISOString() };
  }

  saveDecision(decision: unknown): number {
    const result = this.db.prepare(`INSERT INTO decisions (decision_json, created_at) VALUES (?, ?)`)
      .run(safeJson(decision), new Date().toISOString());
    this.appendEvent("research.decision", decision);
    return Number(result.lastInsertRowid);
  }

  decisions(): Array<{ id: number; payload: unknown; createdAt: string }> {
    const rows = this.db.prepare("SELECT id, decision_json, created_at FROM decisions ORDER BY id DESC").all() as Array<{ id: number; decision_json: string; created_at: string }>;
    return rows.map((row) => ({ id: row.id, payload: JSON.parse(row.decision_json), createdAt: row.created_at }));
  }

  saveClaim(claim: { id: string; payload: unknown }): void {
    const createdAt = new Date().toISOString();
    const candidate = claim.payload && typeof claim.payload === "object" && !Array.isArray(claim.payload)
      ? { ...(claim.payload as Record<string, unknown>), id: claim.id }
      : claim.payload;
    const parsed = EvidenceClaimSchema.safeParse(candidate);
    if (!parsed.success) {
      throw new Error(`Invalid evidence claim ${claim.id}: ${parsed.error.issues.map((issue) => `${issue.path.join(".")} ${issue.message}`).join("; ")}`);
    }
    if (parsed.data.sourceType === "literature" || parsed.data.sourceType === "external_source") {
      const source = this.db.prepare("SELECT 1 AS present FROM research_sources WHERE id = ?").get(parsed.data.sourceId) as { present: number } | undefined;
      if (!source) throw new Error(`External source claim ${claim.id} references missing source ${parsed.data.sourceId}.`);
    }
    const safeCandidate = redactStructured(candidate);
    const durablePayload = safeJson(safeCandidate);
    const existing = this.claims().filter((entry) => entry.id !== claim.id).map((entry) => {
      const value = entry.payload as { statement?: unknown; sourceType?: unknown; confidence?: unknown };
      return typeof value.statement === "string" && typeof value.sourceType === "string" && typeof value.confidence === "number"
        ? { id: entry.id, statement: value.statement, sourceType: value.sourceType, confidence: value.confidence }
        : undefined;
    }).filter((entry): entry is { id: string; statement: string; sourceType: string; confidence: number } => Boolean(entry));
    for (const prior of existing) {
      const relation = compareClaims({ id: claim.id, statement: parsed.data.statement, sourceType: parsed.data.sourceType, confidence: parsed.data.confidence }, prior);
      if (!relation) continue;
      if (relation.relation === "duplicate") {
        this.appendEvent("evidence.claim.duplicate_detected", { claimId: claim.id, duplicateOf: prior.id, confidence: relation.confidence, reviewRequired: true });
        continue;
      }
      const [fromId, toId] = [claim.id, prior.id].sort();
      const edgeId = `edge_claim_contradiction_${createHash("sha256").update(`${fromId}:${toId}`).digest("hex").slice(0, 20)}`;
      this.saveEdge({ id: edgeId, fromId, toId, relation: "contradicts", confidence: relation.confidence, evidenceIds: [claim.id, prior.id] });
      this.appendEvent("evidence.claim.contradiction_detected", { claimId: claim.id, contradicts: prior.id, confidence: relation.confidence, reviewRequired: true });
    }
    this.db.prepare(`INSERT OR REPLACE INTO evidence_claims (id, payload_json, created_at) VALUES (?, ?, ?)`).run(claim.id, durablePayload, createdAt);
    this.indexMemory("claim", claim.id, durablePayload, createdAt);
    this.appendEvent("evidence.claim.created", safeCandidate);
  }

  private indexMemory(kind: "claim" | "hypothesis" | "source", id: string, content: string, createdAt: string): void {
    if (!this.memoryFtsAvailable) return;
    this.db.prepare("DELETE FROM memory_fts WHERE kind = ? AND item_id = ?").run(kind, id);
    this.db.prepare("INSERT INTO memory_fts (kind, item_id, content, created_at) VALUES (?, ?, ?, ?)").run(kind, id, content, createdAt);
  }

  saveEdge(edge: { id: string; fromId: string; toId: string; relation: string; confidence: number; evidenceIds: string[] }): void {
    this.db.prepare(`INSERT OR REPLACE INTO research_edges (id, from_id, to_id, relation, confidence, evidence_ids_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(edge.id, edge.fromId, edge.toId, edge.relation, edge.confidence, safeJson(edge.evidenceIds), new Date().toISOString());
    this.appendEvent("research.edge.created", edge);
  }

  saveSource(source: { id: string; payload: unknown }): void {
    const createdAt = new Date().toISOString();
    const normalizedSource = source.payload && typeof source.payload === "object" && !Array.isArray(source.payload)
      ? { ...(source.payload as Record<string, unknown>), status: ["active", "superseded", "invalidated"].includes(String((source.payload as Record<string, unknown>).status)) ? (source.payload as Record<string, unknown>).status : "active" }
      : source.payload;
    const payload = safeJson(normalizedSource);
    const sourceUrl = normalizedSource && typeof normalizedSource === "object" && !Array.isArray(normalizedSource) && typeof (normalizedSource as { url?: unknown }).url === "string"
      ? (normalizedSource as { url: string }).url
      : undefined;
    const prior = sourceUrl
      ? this.sources().find((entry) => entry.id !== source.id && typeof (entry.payload as { url?: unknown }).url === "string" && canonicalSourceUrl((entry.payload as { url: string }).url) === canonicalSourceUrl(sourceUrl))
      : undefined;
    const retireClaims = (sourceId: string, status: "superseded" | "invalidated"): void => {
      const retired: string[] = [];
      for (const claim of this.claims()) {
        const claimPayload = claim.payload && typeof claim.payload === "object" && !Array.isArray(claim.payload) ? claim.payload as Record<string, unknown> : undefined;
        if (claimPayload?.sourceId !== sourceId || claimPayload.status === status || claimPayload.status === "invalidated") continue;
        const updated = { ...claimPayload, status };
        const serialized = safeJson(updated);
        this.db.prepare("UPDATE evidence_claims SET payload_json = ? WHERE id = ?").run(serialized, claim.id);
        this.indexMemory("claim", claim.id, serialized, claim.createdAt);
        retired.push(claim.id);
      }
      if (retired.length) this.appendEvent("research.claims.retired", { sourceId, status, claimIds: retired });
    };
    if (prior) {
      const priorPayload = prior.payload && typeof prior.payload === "object" && !Array.isArray(prior.payload)
        ? { ...(prior.payload as Record<string, unknown>), status: "superseded" }
        : prior.payload;
      this.db.prepare("UPDATE research_sources SET payload_json = ? WHERE id = ?").run(safeJson(priorPayload), prior.id);
      this.indexMemory("source", prior.id, safeJson(priorPayload), prior.createdAt);
      this.appendEvent("research.source.superseded", { sourceId: prior.id, supersededBy: source.id });
      retireClaims(prior.id, "superseded");
    }
    this.db.prepare(`INSERT OR REPLACE INTO research_sources (id, payload_json, created_at) VALUES (?, ?, ?)`).run(source.id, payload, createdAt);
    this.indexMemory("source", source.id, payload, createdAt);
    this.appendEvent("research.source.created", normalizedSource);
    if (normalizedSource && typeof normalizedSource === "object" && !Array.isArray(normalizedSource) && (normalizedSource as { status?: unknown }).status === "invalidated") retireClaims(source.id, "invalidated");
    if (prior) this.saveEdge({ id: `edge_${source.id}_${prior.id}_supersedes`, fromId: source.id, toId: prior.id, relation: "supersedes", confidence: 1, evidenceIds: [] });
  }

  hypotheses(): Array<{ id: string; payload: unknown; createdAt: string }> {
    const rows = this.db.prepare("SELECT id, payload_json, created_at FROM hypotheses ORDER BY created_at DESC").all() as Array<{ id: string; payload_json: string; created_at: string }>;
    return rows.map((row) => ({ id: row.id, payload: JSON.parse(row.payload_json), createdAt: row.created_at }));
  }

  edges(): Array<{ id: string; fromId: string; toId: string; relation: string; confidence: number; evidenceIds: string[]; createdAt: string }> {
    const rows = this.db.prepare("SELECT * FROM research_edges ORDER BY created_at DESC").all() as Array<{ id: string; from_id: string; to_id: string; relation: string; confidence: number; evidence_ids_json: string; created_at: string }>;
    return rows.map((row) => ({ id: row.id, fromId: row.from_id, toId: row.to_id, relation: row.relation, confidence: row.confidence, evidenceIds: JSON.parse(row.evidence_ids_json) as string[], createdAt: row.created_at }));
  }

  claims(): Array<{ id: string; payload: unknown; createdAt: string }> {
    const rows = this.db.prepare("SELECT id, payload_json, created_at FROM evidence_claims ORDER BY created_at DESC").all() as Array<{ id: string; payload_json: string; created_at: string }>;
    return rows.map((row) => ({ id: row.id, payload: JSON.parse(row.payload_json), createdAt: row.created_at }));
  }

  /** Database-backed keyword retrieval for durable research memory. */
  searchMemory(query: string, limit = 20): Array<{ kind: "claim" | "hypothesis" | "source"; id: string; payload: unknown; createdAt: string }> {
    const terms = query.toLowerCase().trim().split(/\s+/).filter(Boolean).map((term) => term.replace(/[\\%_]/g, "\\$&"));
    if (!terms.length) return [];
    if (this.memoryFtsAvailable) {
      try {
        const ftsQuery = terms.map((term) => `"${term.replace(/"/g, '""')}"`).join(" AND ");
        const rows = this.db.prepare("SELECT kind, item_id, content, created_at FROM memory_fts WHERE memory_fts MATCH ? ORDER BY created_at DESC LIMIT ?").all(ftsQuery, Math.max(1, Math.min(limit, 200))) as Array<{ kind: "claim" | "hypothesis" | "source"; item_id: string; content: string; created_at: string }>;
        return rows.map((row) => ({ kind: row.kind, id: row.item_id, payload: JSON.parse(row.content), createdAt: row.created_at }));
      } catch {
        // Malformed FTS syntax falls back to the portable LIKE implementation below.
      }
    }
    const where = terms.map(() => "lower(payload_json) LIKE ? ESCAPE '\\'").join(" AND ");
    const parameters = terms.map((term) => `%${term}%`);
    const collect = (table: "evidence_claims" | "hypotheses" | "research_sources", kind: "claim" | "hypothesis" | "source") => {
      const rows = this.db.prepare(`SELECT id, payload_json, created_at FROM ${table} WHERE ${where} ORDER BY created_at DESC LIMIT ?`).all(...parameters, Math.max(1, Math.min(limit, 200))) as Array<{ id: string; payload_json: string; created_at: string }>;
      return rows.map((row) => ({ kind, id: row.id, payload: JSON.parse(row.payload_json), createdAt: row.created_at }));
    };
    return [...collect("evidence_claims", "claim"), ...collect("hypotheses", "hypothesis"), ...collect("research_sources", "source")]
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt)).slice(0, Math.max(1, Math.min(limit, 200)));
  }

  counts(): { hypotheses: number; experiments: number; runs: number; attempts: number; artifacts: number; trajectories: number; decisions: number; claims: number; edges: number; sources: number } {
    const count = (table: string): number => (this.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count;
    return { hypotheses: count("hypotheses"), experiments: count("experiments"), runs: count("runs"), attempts: count("run_attempts"), artifacts: count("artifacts"), trajectories: count("trajectories"), decisions: count("decisions"), claims: count("evidence_claims"), edges: count("research_edges"), sources: count("research_sources") };
  }

  experiments(): Array<{ id: string; payload: unknown; createdAt: string }> {
    const rows = this.db.prepare("SELECT id, payload_json, created_at FROM experiments ORDER BY created_at DESC").all() as Array<{ id: string; payload_json: string; created_at: string }>;
    return rows.map((row) => ({ id: row.id, payload: JSON.parse(row.payload_json), createdAt: row.created_at }));
  }

  /** Mark experiments left running by a dead controller as failed and retryable. */
  recoverStaleExperiments(staleAfterMs = 30_000): string[] {
    const recovered: string[] = [];
    const cutoff = Math.max(0, staleAfterMs);
    const freshHeartbeats = new Map<string, string>();
    for (const event of this.eventsByType("run.heartbeat")) {
      const payload = event.payload && typeof event.payload === "object" ? event.payload as { experimentId?: unknown; heartbeatAt?: unknown } : {};
      if (typeof payload.experimentId !== "string") continue;
      const heartbeatAt = typeof payload.heartbeatAt === "string" ? payload.heartbeatAt : event.createdAt;
      const previous = freshHeartbeats.get(payload.experimentId);
      if (!previous || Date.parse(heartbeatAt) > Date.parse(previous)) freshHeartbeats.set(payload.experimentId, heartbeatAt);
    }
    const now = Date.now();
    for (const experiment of this.experiments()) {
      const payload = experiment.payload && typeof experiment.payload === "object" ? experiment.payload as Record<string, unknown> : {};
      if (payload.status !== "running") continue;
      const heartbeatAt = freshHeartbeats.get(experiment.id);
      if (heartbeatAt) {
        const age = now - Date.parse(heartbeatAt);
        if (Number.isFinite(age) && age >= 0 && age <= cutoff) continue;
      }
      const updated = { ...payload, status: "failed", failure: "Controller exited before experiment finalization.", recoveredAt: new Date().toISOString(), stale: true, recoveryAttempted: false };
      this.saveExperiment({ id: experiment.id, payload: updated });
      this.appendEvent("experiment.stale.recovered", { experimentId: experiment.id, previousStatus: "running" });
      recovered.push(experiment.id);
    }
    this.reconcileComputeReservations();
    return recovered;
  }

  /** Release reservations whose experiment was never persisted or is terminal. */
  reconcileComputeReservations(): string[] {
    const terminal = new Set(["completed", "failed", "invalid", "rejected", "cancelled", "blocked"]);
    const experiments = new Map(this.experiments().map((experiment) => {
      const payload = experiment.payload && typeof experiment.payload === "object" ? experiment.payload as { status?: unknown } : {};
      return [experiment.id, String(payload.status ?? "")] as const;
    }));
    const rows = this.db.prepare("SELECT experiment_id FROM compute_reservations WHERE status = 'reserved'").all() as Array<{ experiment_id: string }>;
    const released: string[] = [];
    for (const row of rows) {
      if (experiments.has(row.experiment_id) && !terminal.has(experiments.get(row.experiment_id) ?? "")) continue;
      if (this.releaseComputeReservation(row.experiment_id, experiments.has(row.experiment_id) ? "terminal experiment reconciliation" : "orphaned reservation reconciliation")) released.push(row.experiment_id);
    }
    return released;
  }

  runs(): Array<{ id: string; experimentId: string; status: string; payload: unknown; createdAt: string; updatedAt: string }> {
    const rows = this.db.prepare("SELECT id, experiment_id, status, payload_json, created_at, updated_at FROM runs ORDER BY updated_at DESC").all() as Array<{ id: string; experiment_id: string; status: string; payload_json: string; created_at: string; updated_at: string }>;
    return rows.map((row) => ({ id: row.id, experimentId: row.experiment_id, status: row.status, payload: JSON.parse(row.payload_json), createdAt: row.created_at, updatedAt: row.updated_at }));
  }

  artifacts(runId?: string): Array<{ id: string; runId: string; name: string; path: string; checksum: string; createdAt: string }> {
    const rows = (runId
      ? this.db.prepare("SELECT * FROM artifacts WHERE run_id = ? ORDER BY created_at DESC").all(runId)
      : this.db.prepare("SELECT * FROM artifacts ORDER BY created_at DESC").all()) as Array<{ id: string; run_id: string; name: string; path: string; checksum: string; created_at: string }>;
    return rows.map((row) => ({ id: row.id, runId: row.run_id, name: row.name, path: row.path, checksum: row.checksum, createdAt: row.created_at }));
  }

  sources(): Array<{ id: string; payload: unknown; createdAt: string }> {
    const rows = this.db.prepare("SELECT id, payload_json, created_at FROM research_sources ORDER BY created_at DESC").all() as Array<{ id: string; payload_json: string; created_at: string }>;
    return rows.map((row) => ({ id: row.id, payload: JSON.parse(row.payload_json), createdAt: row.created_at }));
  }

  schedulerState(): { status: "idle" | "running" | "paused" | "draining"; mode: string; currentStep: string | null; updatedAt: string } {
    const row = this.db.prepare("SELECT status, mode, current_step, updated_at FROM scheduler_state WHERE id = 1").get() as {
      status: "idle" | "running" | "paused" | "draining"; mode: string; current_step: string | null; updated_at: string;
    } | undefined;
    return row
      ? { status: row.status, mode: row.mode, currentStep: row.current_step, updatedAt: row.updated_at }
      : { status: "idle", mode: "research", currentStep: null, updatedAt: new Date(0).toISOString() };
  }

  setSchedulerState(state: { status: "idle" | "running" | "paused" | "draining"; mode: string; currentStep?: string | null }): void {
    const updatedAt = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO scheduler_state (id, status, mode, current_step, updated_at) VALUES (1, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET status = excluded.status, mode = excluded.mode, current_step = excluded.current_step, updated_at = excluded.updated_at
    `).run(state.status, state.mode, state.currentStep ?? null, updatedAt);
    this.appendEvent(`scheduler.${state.status}`, { ...state, updatedAt });
  }
}
