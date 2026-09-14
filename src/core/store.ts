import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createHash } from "node:crypto";
import { EvidenceClaimSchema } from "./types.js";
import { compareClaims } from "./claim-consistency.js";
import { redactStructured } from "./redaction.js";

function safeJson(value: unknown): string {
  return JSON.stringify(redactStructured(value));
}

export type QueueTaskStatus = "queued" | "running" | "completed" | "failed" | "cancelled";
export interface QueuedTask {
  id: string;
  kind: string;
  priority: number;
  status: string;
  payload: unknown;
  attempts: number;
  availableAt: string;
  claimedAt: string | null;
  updatedAt: string;
}

export type ControllerAction = "pause" | "resume" | "stop";
export interface ControllerSteer {
  id: number;
  message: string;
  createdAt: string;
  appliedAt: string | null;
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
  command: string[];
  cwd: string;
  executor: string;
  createdAt: string;
  updatedAt: string;
}

export class ResearchStore {
  private readonly db: Database.Database;
  private memoryFtsAvailable = false;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        competition_id TEXT NOT NULL,
        config_json TEXT NOT NULL,
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
        command_json TEXT NOT NULL,
        cwd TEXT NOT NULL,
        executor TEXT NOT NULL,
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
      CREATE TABLE IF NOT EXISTS agent_lanes (
        role TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        task TEXT,
        error TEXT,
        updated_at TEXT NOT NULL
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
      CREATE TABLE IF NOT EXISTS external_action_intents (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        status TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
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
    // Existing stores predate event integrity. Keep them readable and mark their
    // history as legacy; all newly appended events are chained and verifiable.
    for (const column of ["previous_hash", "event_hash"]) {
      try { this.db.exec(`ALTER TABLE events ADD COLUMN ${column} TEXT`); } catch { /* already migrated */ }
    }
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

  appendEvent(type: string, payload: unknown): void {
    this.db.transaction(() => {
      const safePayload = redactStructured(payload);
      const payloadJson = JSON.stringify(safePayload);
      const createdAt = new Date().toISOString();
      const previousHash = (this.db.prepare("SELECT event_hash AS eventHash FROM events ORDER BY id DESC LIMIT 1").get() as { eventHash: string | null } | undefined)?.eventHash ?? null;
      const eventHash = createHash("sha256").update(`${type}\0${payloadJson}\0${createdAt}\0${previousHash ?? ""}`).digest("hex");
      this.db.prepare(`
        INSERT INTO events (type, payload_json, created_at, previous_hash, event_hash) VALUES (?, ?, ?, ?, ?)
      `).run(type, payloadJson, createdAt, previousHash, eventHash);
      this.db.prepare("UPDATE event_chain_state SET head_hash = ?, event_count = event_count + 1 WHERE id = 1").run(eventHash);
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

  eventsByTypes(types: string[]): Array<{ type: string; payload: unknown; createdAt: string; eventHash?: string | null }> {
    const uniqueTypes = [...new Set(types.filter((type) => type.trim()))];
    if (!uniqueTypes.length) return [];
    const placeholders = uniqueTypes.map(() => "?").join(", ");
    const rows = this.db.prepare(`SELECT type, payload_json, created_at, event_hash FROM events WHERE type IN (${placeholders}) ORDER BY id ASC`).all(...uniqueTypes) as Array<{ type: string; payload_json: string; created_at: string; event_hash: string | null }>;
    return rows.map((row) => ({ type: row.type, payload: JSON.parse(row.payload_json), createdAt: row.created_at, eventHash: row.event_hash }));
  }

  saveExperiment(experiment: { id: string; payload: unknown }): void {
    const existing = this.db.prepare("SELECT 1 AS present FROM experiments WHERE id = ?").get(experiment.id) as { present: number } | undefined;
    const now = new Date().toISOString();
    const safePayload = redactStructured(experiment.payload);
    this.db.prepare(`
      INSERT INTO experiments (id, payload_json, created_at)
      VALUES (?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET payload_json = excluded.payload_json
    `).run(experiment.id, JSON.stringify(safePayload), now);
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
    command: string[];
    cwd: string;
    executor: string;
  }): void {
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO run_attempts (id, experiment_id, run_id, attempt, stage, status, exit_code, failure_class, duration_seconds, metric, command_json, cwd, executor, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET run_id = excluded.run_id, status = excluded.status, exit_code = excluded.exit_code,
        failure_class = excluded.failure_class, duration_seconds = excluded.duration_seconds, metric = excluded.metric,
        command_json = excluded.command_json, cwd = excluded.cwd, executor = excluded.executor, updated_at = excluded.updated_at
    `).run(attempt.id, attempt.experimentId, attempt.runId ?? null, attempt.attempt, attempt.stage, attempt.status, attempt.exitCode ?? null, attempt.failureClass ?? null, attempt.durationSeconds ?? null, attempt.metric ?? null, safeJson(attempt.command), attempt.cwd, attempt.executor, now, now);
  }

  runAttempts(experimentId?: string): RunAttempt[] {
    const query = experimentId
      ? this.db.prepare("SELECT * FROM run_attempts WHERE experiment_id = ? ORDER BY attempt ASC, created_at ASC")
      : this.db.prepare("SELECT * FROM run_attempts ORDER BY created_at ASC");
    const rows = (query.all(...(experimentId ? [experimentId] : [])) as Array<Record<string, unknown>>);
    return rows.map((row) => ({
      id: String(row.id), experimentId: String(row.experiment_id), runId: row.run_id === null ? null : String(row.run_id), attempt: Number(row.attempt), stage: String(row.stage), status: String(row.status),
      exitCode: row.exit_code === null ? null : Number(row.exit_code), failureClass: row.failure_class === null ? null : String(row.failure_class), durationSeconds: row.duration_seconds === null ? null : Number(row.duration_seconds), metric: row.metric === null ? null : Number(row.metric),
      command: JSON.parse(String(row.command_json)) as string[], cwd: String(row.cwd), executor: String(row.executor), createdAt: String(row.created_at), updatedAt: String(row.updated_at),
    }));
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
    this.db.prepare(`INSERT OR REPLACE INTO phase_goals (id, phase, status, payload_json, created_at, updated_at) VALUES (?, ?, ?, ?, COALESCE((SELECT created_at FROM phase_goals WHERE id = ?), ?), ?)`)
      .run(goal.id, goal.phase, goal.status, safeJson(goal.payload), goal.id, now, now);
    this.appendEvent("phase_goal.updated", goal.payload);
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

  requestControllerAction(action: ControllerAction): ControllerLease | undefined {
    const now = new Date().toISOString();
    this.db.prepare("UPDATE controller_leases SET requested_action = ?, updated_at = ? WHERE id = 1 AND status = 'running'").run(action, now);
    const lease = this.readControllerLease();
    if (lease?.status === "running") this.appendEvent("controller.action.requested", { action, controllerId: lease.controllerId, pid: lease.pid });
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

  releaseControllerLease(controllerId: string, status: "released" | "stale" = "released"): boolean {
    const now = new Date().toISOString();
    const result = this.db.prepare("UPDATE controller_leases SET status = ?, requested_action = NULL, updated_at = ? WHERE id = 1 AND controller_id = ? AND status = 'running'").run(status, now, controllerId);
    if (result.changes === 1) this.appendEvent(`controller.lease.${status}`, { controllerId });
    return result.changes === 1;
  }

  updateAgentLane(lane: { role: string; status: "idle" | "running" | "blocked" | "failed"; provider: string; model: string; task?: string | null; error?: string | null }): void {
    const updatedAt = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO agent_lanes (role, status, provider, model, task, error, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(role) DO UPDATE SET status = excluded.status, provider = excluded.provider, model = excluded.model, task = excluded.task, error = excluded.error, updated_at = excluded.updated_at
    `).run(lane.role, lane.status, lane.provider, lane.model, lane.task ?? null, lane.error ?? null, updatedAt);
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

  agentLanes(): Array<{ role: string; status: string; provider: string; model: string; task: string | null; error: string | null; updatedAt: string }> {
    const rows = this.db.prepare("SELECT role, status, provider, model, task, error, updated_at FROM agent_lanes ORDER BY role ASC").all() as Array<{ role: string; status: string; provider: string; model: string; task: string | null; error: string | null; updated_at: string }>;
    return rows.map((row) => ({ role: row.role, status: row.status, provider: row.provider, model: row.model, task: row.task, error: row.error, updatedAt: row.updated_at }));
  }

  enqueueTask(task: { id: string; kind: string; priority: number; payload: unknown; availableAt?: string }): void {
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT OR IGNORE INTO work_queue (id, kind, priority, status, payload_json, attempts, available_at, claimed_at, updated_at)
      VALUES (?, ?, ?, 'queued', ?, 0, ?, NULL, ?)
    `).run(task.id, task.kind, task.priority, safeJson(task.payload), task.availableAt ?? now, now);
    this.appendEvent("queue.enqueued", task);
  }

  queueTasks(status?: QueueTaskStatus): QueuedTask[] {
    const rows = (status
      ? this.db.prepare("SELECT * FROM work_queue WHERE status = ? ORDER BY priority DESC, available_at ASC").all(status)
      : this.db.prepare("SELECT * FROM work_queue ORDER BY updated_at DESC").all()) as Array<{ id: string; kind: string; priority: number; status: string; payload_json: string; attempts: number; available_at: string; claimed_at: string | null; updated_at: string }>;
    return rows.map((row) => ({ id: row.id, kind: row.kind, priority: row.priority, status: row.status, payload: JSON.parse(row.payload_json), attempts: row.attempts, availableAt: row.available_at, claimedAt: row.claimed_at, updatedAt: row.updated_at }));
  }

  claimNextTask(kinds?: string[]): QueuedTask | undefined {
    const now = new Date().toISOString();
    const transaction = this.db.transaction(() => {
      const query = kinds?.length
        ? `SELECT id FROM work_queue WHERE status = 'queued' AND available_at <= ? AND kind IN (${kinds.map(() => "?").join(",")}) ORDER BY priority DESC, available_at ASC LIMIT 1`
        : "SELECT id FROM work_queue WHERE status = 'queued' AND available_at <= ? ORDER BY priority DESC, available_at ASC LIMIT 1";
      const row = (kinds?.length ? this.db.prepare(query).get(now, ...kinds) : this.db.prepare(query).get(now)) as { id: string } | undefined;
      if (!row) return undefined;
      this.db.prepare("UPDATE work_queue SET status = 'running', attempts = attempts + 1, claimed_at = ?, updated_at = ? WHERE id = ? AND status = 'queued'").run(now, now, row.id);
      return this.queueTasks().find((task) => task.id === row.id);
    });
    const task = transaction();
    if (task) this.appendEvent("queue.claimed", { id: task.id, kind: task.kind, attempts: task.attempts });
    return task;
  }

  /** Atomically claim one known task, preserving queue ownership across controllers. */
  claimTask(id: string, kinds?: string[]): QueuedTask | undefined {
    const now = new Date().toISOString();
    const transaction = this.db.transaction(() => {
      const kindClause = kinds?.length ? ` AND kind IN (${kinds.map(() => "?").join(",")})` : "";
      const result = this.db.prepare(`UPDATE work_queue SET status = 'running', attempts = attempts + 1, claimed_at = ?, updated_at = ? WHERE id = ? AND status = 'queued' AND available_at <= ?${kindClause}`)
        .run(now, now, id, now, ...(kinds ?? []));
      if (result.changes !== 1) return undefined;
      return this.queueTasks().find((task) => task.id === id);
    });
    const task = transaction();
    if (task) this.appendEvent("queue.claimed", { id: task.id, kind: task.kind, attempts: task.attempts });
    return task;
  }

  updateTask(id: string, status: QueueTaskStatus, payload?: unknown): void {
    const now = new Date().toISOString();
    this.db.prepare("UPDATE work_queue SET status = ?, payload_json = COALESCE(?, payload_json), updated_at = ? WHERE id = ?").run(status, payload === undefined ? null : safeJson(payload), now, id);
    this.appendEvent(`queue.${status}`, { id, payload });
  }

  /** Refresh a live claim so stale-task recovery cannot duplicate a healthy worker. */
  heartbeatTask(id: string): boolean {
    const now = new Date().toISOString();
    const result = this.db.prepare("UPDATE work_queue SET claimed_at = ?, updated_at = ? WHERE id = ? AND status = 'running'").run(now, now, id);
    return result.changes === 1;
  }

  retryTask(id: string, payload: unknown, availableAt: string): void {
    const now = new Date().toISOString();
    this.db.prepare("UPDATE work_queue SET status = 'queued', payload_json = ?, available_at = ?, claimed_at = NULL, updated_at = ? WHERE id = ?").run(safeJson(payload), availableAt, now, id);
    this.appendEvent("queue.retry_scheduled", { id, availableAt, payload });
  }

  requeueStaleTasks(maxAgeMs = 15 * 60_000, maxAttempts = 3): number {
    const cutoff = new Date(Date.now() - maxAgeMs).toISOString();
    const limit = Math.max(1, Math.floor(maxAttempts));
    const now = new Date().toISOString();
    const result = this.db.transaction(() => {
      const requeued = this.db.prepare("UPDATE work_queue SET status = 'queued', claimed_at = NULL, updated_at = ? WHERE status = 'running' AND updated_at < ? AND attempts < ?").run(now, cutoff, limit).changes;
      const exhaustedRows = this.db.prepare("SELECT id, payload_json, attempts FROM work_queue WHERE status = 'running' AND updated_at < ? AND attempts >= ?").all(cutoff, limit) as Array<{ id: string; payload_json: string; attempts: number }>;
      for (const row of exhaustedRows) {
        let payload: Record<string, unknown> = {};
        try {
          const parsed = JSON.parse(row.payload_json);
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) payload = parsed as Record<string, unknown>;
        } catch { /* Preserve the queue record even if an older payload was malformed. */ }
        this.db.prepare("UPDATE work_queue SET status = 'failed', payload_json = ?, claimed_at = NULL, updated_at = ? WHERE id = ?").run(safeJson({ ...payload, error: "stale task exceeded bounded attempts", attempts: row.attempts, failedAt: now }), now, row.id);
      }
      const exhausted = exhaustedRows.length;
      return { requeued, exhausted };
    })();
    if (result.requeued) this.appendEvent("queue.stale_requeued", { count: result.requeued, cutoff, maxAttempts: limit });
    if (result.exhausted) this.appendEvent("queue.stale_failed", { count: result.exhausted, cutoff, maxAttempts: limit, reason: "stale task exceeded bounded attempts" });
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
    if (parsed.data.sourceType === "literature") {
      const source = this.db.prepare("SELECT 1 AS present FROM research_sources WHERE id = ?").get(parsed.data.sourceId) as { present: number } | undefined;
      if (!source) throw new Error(`Literature claim ${claim.id} references missing source ${parsed.data.sourceId}.`);
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
    const payload = safeJson(source.payload);
    const sourceUrl = source.payload && typeof source.payload === "object" && !Array.isArray(source.payload) && typeof (source.payload as { url?: unknown }).url === "string"
      ? (source.payload as { url: string }).url
      : undefined;
    const prior = sourceUrl
      ? this.sources().find((entry) => entry.id !== source.id && (entry.payload as { url?: unknown }).url === sourceUrl)
      : undefined;
    this.db.prepare(`INSERT OR REPLACE INTO research_sources (id, payload_json, created_at) VALUES (?, ?, ?)`).run(source.id, payload, createdAt);
    this.indexMemory("source", source.id, payload, createdAt);
    this.appendEvent("research.source.created", source.payload);
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
  recoverStaleExperiments(): string[] {
    const recovered: string[] = [];
    for (const experiment of this.experiments()) {
      const payload = experiment.payload && typeof experiment.payload === "object" ? experiment.payload as Record<string, unknown> : {};
      if (payload.status !== "running") continue;
      const updated = { ...payload, status: "failed", failure: "Controller exited before experiment finalization.", recoveredAt: new Date().toISOString(), stale: true, recoveryAttempted: false };
      this.saveExperiment({ id: experiment.id, payload: updated });
      this.appendEvent("experiment.stale.recovered", { experimentId: experiment.id, previousStatus: "running" });
      recovered.push(experiment.id);
    }
    return recovered;
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
