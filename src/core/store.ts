import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

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

export class ResearchStore {
  private readonly db: Database.Database;

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
        created_at TEXT NOT NULL
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
      CREATE TABLE IF NOT EXISTS artifacts (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        name TEXT NOT NULL,
        path TEXT NOT NULL,
        checksum TEXT NOT NULL,
        created_at TEXT NOT NULL
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
    `);
  }

  close(): void {
    this.db.close();
  }

  createProject(project: { id: string; name: string; competitionId: string; config: unknown }): void {
    this.db.prepare(`
      INSERT INTO projects (id, name, competition_id, config_json, created_at)
      VALUES (@id, @name, @competitionId, @configJson, @createdAt)
    `).run({
      id: project.id,
      name: project.name,
      competitionId: project.competitionId,
      configJson: JSON.stringify(project.config),
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
    this.db.prepare(`
      INSERT INTO events (type, payload_json, created_at) VALUES (?, ?, ?)
    `).run(type, JSON.stringify(payload), new Date().toISOString());
  }

  eventCount(): number {
    return (this.db.prepare("SELECT COUNT(*) AS count FROM events").get() as { count: number }).count;
  }

  recentEvents(limit = 20): Array<{ type: string; payload: unknown; createdAt: string }> {
    const rows = this.db.prepare("SELECT type, payload_json, created_at FROM events ORDER BY id DESC LIMIT ?").all(limit) as Array<{ type: string; payload_json: string; created_at: string }>;
    return rows.reverse().map((row) => ({ type: row.type, payload: JSON.parse(row.payload_json), createdAt: row.created_at }));
  }

  saveExperiment(experiment: { id: string; payload: unknown }): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO experiments (id, payload_json, created_at)
      VALUES (?, ?, ?)
    `).run(experiment.id, JSON.stringify(experiment.payload), new Date().toISOString());
    this.appendEvent("experiment.created", experiment.payload);
  }

  saveHypothesis(hypothesis: { id: string; payload: unknown }): void {
    this.db.prepare(`INSERT OR REPLACE INTO hypotheses (id, payload_json, created_at) VALUES (?, ?, ?)`)
      .run(hypothesis.id, JSON.stringify(hypothesis.payload), new Date().toISOString());
    this.appendEvent("hypothesis.created", hypothesis.payload);
  }

  saveRun(run: { id: string; experimentId: string; status: string; payload: unknown }): void {
    const now = new Date().toISOString();
    this.db.prepare(`INSERT OR REPLACE INTO runs (id, experiment_id, status, payload_json, created_at, updated_at) VALUES (?, ?, ?, ?, COALESCE((SELECT created_at FROM runs WHERE id = ?), ?), ?)`)
      .run(run.id, run.experimentId, run.status, JSON.stringify(run.payload), run.id, now, now);
    this.appendEvent(`run.${run.status}`, { id: run.id, experimentId: run.experimentId, payload: run.payload });
  }

  saveArtifact(artifact: { id: string; runId: string; name: string; path: string; checksum: string }): void {
    this.db.prepare(`INSERT OR REPLACE INTO artifacts (id, run_id, name, path, checksum, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(artifact.id, artifact.runId, artifact.name, artifact.path, artifact.checksum, new Date().toISOString());
    this.appendEvent("artifact.created", artifact);
  }

  savePhaseGoal(goal: { id: string; phase: string; status: string; payload: unknown }): void {
    const now = new Date().toISOString();
    this.db.prepare(`INSERT OR REPLACE INTO phase_goals (id, phase, status, payload_json, created_at, updated_at) VALUES (?, ?, ?, ?, COALESCE((SELECT created_at FROM phase_goals WHERE id = ?), ?), ?)`)
      .run(goal.id, goal.phase, goal.status, JSON.stringify(goal.payload), goal.id, now, now);
    this.appendEvent("phase_goal.updated", goal.payload);
  }

  saveCampaign(campaign: unknown): void {
    const updatedAt = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO research_campaigns (id, payload_json, updated_at) VALUES (1, ?, ?)
      ON CONFLICT(id) DO UPDATE SET payload_json = excluded.payload_json, updated_at = excluded.updated_at
    `).run(JSON.stringify(campaign), updatedAt);
    this.appendEvent("research.campaign.updated", campaign);
  }

  campaign(): unknown | undefined {
    const row = this.db.prepare("SELECT payload_json FROM research_campaigns WHERE id = 1").get() as { payload_json: string } | undefined;
    return row ? JSON.parse(row.payload_json) : undefined;
  }

  updateAgentLane(lane: { role: string; status: "idle" | "running" | "blocked" | "failed"; provider: string; model: string; task?: string | null; error?: string | null }): void {
    const updatedAt = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO agent_lanes (role, status, provider, model, task, error, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(role) DO UPDATE SET status = excluded.status, provider = excluded.provider, model = excluded.model, task = excluded.task, error = excluded.error, updated_at = excluded.updated_at
    `).run(lane.role, lane.status, lane.provider, lane.model, lane.task ?? null, lane.error ?? null, updatedAt);
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
    `).run(task.id, task.kind, task.priority, JSON.stringify(task.payload), task.availableAt ?? now, now);
    this.appendEvent("queue.enqueued", task);
  }

  queueTasks(status?: QueueTaskStatus): QueuedTask[] {
    const rows = (status
      ? this.db.prepare("SELECT * FROM work_queue WHERE status = ? ORDER BY priority DESC, available_at ASC").all(status)
      : this.db.prepare("SELECT * FROM work_queue ORDER BY updated_at DESC").all()) as Array<{ id: string; kind: string; priority: number; status: string; payload_json: string; attempts: number; available_at: string; claimed_at: string | null; updated_at: string }>;
    return rows.map((row) => ({ id: row.id, kind: row.kind, priority: row.priority, status: row.status, payload: JSON.parse(row.payload_json), attempts: row.attempts, availableAt: row.available_at, claimedAt: row.claimed_at, updatedAt: row.updated_at }));
  }

  claimNextTask(): QueuedTask | undefined {
    const now = new Date().toISOString();
    const transaction = this.db.transaction(() => {
      const row = this.db.prepare("SELECT id FROM work_queue WHERE status = 'queued' AND available_at <= ? ORDER BY priority DESC, available_at ASC LIMIT 1").get(now) as { id: string } | undefined;
      if (!row) return undefined;
      this.db.prepare("UPDATE work_queue SET status = 'running', attempts = attempts + 1, claimed_at = ?, updated_at = ? WHERE id = ? AND status = 'queued'").run(now, now, row.id);
      return this.queueTasks().find((task) => task.id === row.id);
    });
    const task = transaction();
    if (task) this.appendEvent("queue.claimed", { id: task.id, kind: task.kind, attempts: task.attempts });
    return task;
  }

  updateTask(id: string, status: QueueTaskStatus, payload?: unknown): void {
    const now = new Date().toISOString();
    this.db.prepare("UPDATE work_queue SET status = ?, payload_json = COALESCE(?, payload_json), updated_at = ? WHERE id = ?").run(status, payload === undefined ? null : JSON.stringify(payload), now, id);
    this.appendEvent(`queue.${status}`, { id, payload });
  }

  retryTask(id: string, payload: unknown, availableAt: string): void {
    const now = new Date().toISOString();
    this.db.prepare("UPDATE work_queue SET status = 'queued', payload_json = ?, available_at = ?, claimed_at = NULL, updated_at = ? WHERE id = ?").run(JSON.stringify(payload), availableAt, now, id);
    this.appendEvent("queue.retry_scheduled", { id, availableAt, payload });
  }

  requeueStaleTasks(maxAgeMs = 15 * 60_000): number {
    const cutoff = new Date(Date.now() - maxAgeMs).toISOString();
    const result = this.db.prepare("UPDATE work_queue SET status = 'queued', claimed_at = NULL, updated_at = ? WHERE status = 'running' AND updated_at < ?").run(new Date().toISOString(), cutoff);
    if (result.changes) this.appendEvent("queue.stale_requeued", { count: result.changes, cutoff });
    return result.changes;
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
    this.db.prepare("INSERT OR REPLACE INTO sessions (id, status, payload_json, started_at, ended_at, updated_at) VALUES (?, 'active', ?, ?, NULL, ?)").run(id, JSON.stringify(payload), now, now);
    this.appendEvent("session.started", { id });
  }

  saveSession(id: string, payload: unknown): void {
    const now = new Date().toISOString();
    this.db.prepare("UPDATE sessions SET payload_json = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(payload), now, id);
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
    this.appendEvent("experiment.gates.updated", { experimentId, ...gates, updatedAt });
  }

  experimentGates(experimentId: string): { leakageAuditPassed: boolean; reviewerApproved: boolean; notes: string; updatedAt: string } {
    const row = this.db.prepare("SELECT leakage_audit_passed, reviewer_approved, notes, updated_at FROM experiment_gates WHERE experiment_id = ?").get(experimentId) as { leakage_audit_passed: number; reviewer_approved: number; notes: string; updated_at: string } | undefined;
    return row
      ? { leakageAuditPassed: row.leakage_audit_passed === 1, reviewerApproved: row.reviewer_approved === 1, notes: row.notes, updatedAt: row.updated_at }
      : { leakageAuditPassed: false, reviewerApproved: false, notes: "", updatedAt: new Date(0).toISOString() };
  }

  saveDecision(decision: unknown): number {
    const result = this.db.prepare(`INSERT INTO decisions (decision_json, created_at) VALUES (?, ?)`)
      .run(JSON.stringify(decision), new Date().toISOString());
    this.appendEvent("research.decision", decision);
    return Number(result.lastInsertRowid);
  }

  decisions(): Array<{ id: number; payload: unknown; createdAt: string }> {
    const rows = this.db.prepare("SELECT id, decision_json, created_at FROM decisions ORDER BY id DESC").all() as Array<{ id: number; decision_json: string; created_at: string }>;
    return rows.map((row) => ({ id: row.id, payload: JSON.parse(row.decision_json), createdAt: row.created_at }));
  }

  saveClaim(claim: { id: string; payload: unknown }): void {
    this.db.prepare(`INSERT OR REPLACE INTO evidence_claims (id, payload_json, created_at) VALUES (?, ?, ?)`)
      .run(claim.id, JSON.stringify(claim.payload), new Date().toISOString());
    this.appendEvent("evidence.claim.created", claim.payload);
  }

  saveEdge(edge: { id: string; fromId: string; toId: string; relation: string; confidence: number; evidenceIds: string[] }): void {
    this.db.prepare(`INSERT OR REPLACE INTO research_edges (id, from_id, to_id, relation, confidence, evidence_ids_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(edge.id, edge.fromId, edge.toId, edge.relation, edge.confidence, JSON.stringify(edge.evidenceIds), new Date().toISOString());
    this.appendEvent("research.edge.created", edge);
  }

  saveSource(source: { id: string; payload: unknown }): void {
    this.db.prepare(`INSERT OR REPLACE INTO research_sources (id, payload_json, created_at) VALUES (?, ?, ?)`)
      .run(source.id, JSON.stringify(source.payload), new Date().toISOString());
    this.appendEvent("research.source.created", source.payload);
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

  counts(): { hypotheses: number; experiments: number; runs: number; artifacts: number; decisions: number; claims: number; edges: number; sources: number } {
    const count = (table: string): number => (this.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count;
    return { hypotheses: count("hypotheses"), experiments: count("experiments"), runs: count("runs"), artifacts: count("artifacts"), decisions: count("decisions"), claims: count("evidence_claims"), edges: count("research_edges"), sources: count("research_sources") };
  }

  experiments(): Array<{ id: string; payload: unknown; createdAt: string }> {
    const rows = this.db.prepare("SELECT id, payload_json, created_at FROM experiments ORDER BY created_at DESC").all() as Array<{ id: string; payload_json: string; created_at: string }>;
    return rows.map((row) => ({ id: row.id, payload: JSON.parse(row.payload_json), createdAt: row.created_at }));
  }

  runs(): Array<{ id: string; experimentId: string; status: string; payload: unknown; updatedAt: string }> {
    const rows = this.db.prepare("SELECT id, experiment_id, status, payload_json, updated_at FROM runs ORDER BY updated_at DESC").all() as Array<{ id: string; experiment_id: string; status: string; payload_json: string; updated_at: string }>;
    return rows.map((row) => ({ id: row.id, experimentId: row.experiment_id, status: row.status, payload: JSON.parse(row.payload_json), updatedAt: row.updated_at }));
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
