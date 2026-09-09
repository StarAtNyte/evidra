import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

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

  saveDecision(decision: unknown): number {
    const result = this.db.prepare(`INSERT INTO decisions (decision_json, created_at) VALUES (?, ?)`)
      .run(JSON.stringify(decision), new Date().toISOString());
    this.appendEvent("research.decision", decision);
    return Number(result.lastInsertRowid);
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
