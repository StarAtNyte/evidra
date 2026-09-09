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

  saveDecision(decision: unknown): void {
    this.db.prepare(`INSERT INTO decisions (decision_json, created_at) VALUES (?, ?)`)
      .run(JSON.stringify(decision), new Date().toISOString());
    this.appendEvent("research.decision", decision);
  }

  counts(): { hypotheses: number; experiments: number; runs: number; artifacts: number; decisions: number } {
    const count = (table: string): number => (this.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count;
    return { hypotheses: count("hypotheses"), experiments: count("experiments"), runs: count("runs"), artifacts: count("artifacts"), decisions: count("decisions") };
  }
}
