import { ResearchStore, type QueuedTask } from "./store.js";
import { queueRecoveryAction } from "./queue-recovery.js";
import { randomUUID } from "node:crypto";

export interface QueueWorkerOptions {
  concurrency?: number;
  maxAttempts?: number;
  staleAfterMs?: number;
  heartbeatMs?: number;
  retryDelayMs?: (task: QueuedTask, error: unknown) => number;
  pollIntervalMs?: number;
  kinds?: string[];
  workerId?: string;
}

export type QueueHandler = (task: QueuedTask, signal: AbortSignal) => Promise<unknown>;

/** Durable, bounded queue execution for research cycles and worker jobs. */
export class QueueWorker {
  private readonly concurrency: number;
  private readonly maxAttempts: number;
  private readonly staleAfterMs: number;
  private readonly heartbeatMs: number;
  private readonly pollIntervalMs: number;
  private readonly retryDelayMs: (task: QueuedTask, error: unknown) => number;
  private readonly kinds?: string[];
  private readonly workerId: string;
  private readonly active = new Set<Promise<void>>();
  private readonly abortController = new AbortController();
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopping = false;

  constructor(private readonly store: ResearchStore, private readonly handler: QueueHandler, options: QueueWorkerOptions = {}) {
    this.concurrency = Math.max(1, Math.floor(options.concurrency ?? 1));
    this.maxAttempts = Math.max(1, Math.floor(options.maxAttempts ?? 3));
    this.staleAfterMs = Math.max(1_000, options.staleAfterMs ?? 15 * 60_000);
    this.heartbeatMs = Math.max(250, Math.min(options.heartbeatMs ?? Math.floor(this.staleAfterMs / 3), this.staleAfterMs - 1));
    this.pollIntervalMs = Math.max(50, options.pollIntervalMs ?? 1_000);
    this.retryDelayMs = options.retryDelayMs ?? ((task) => Math.min(60_000, 1_000 * 2 ** Math.max(0, task.attempts - 1)));
    this.kinds = options.kinds?.length ? [...options.kinds] : undefined;
    this.workerId = options.workerId?.trim() || `queue-worker-${randomUUID()}`;
  }

  async runOnce(): Promise<void> {
    if (this.stopping) return;
    do {
      this.store.requeueStaleTasks(this.staleAfterMs, this.maxAttempts);
      while (!this.stopping && this.active.size < this.concurrency) {
        const task = this.store.claimNextTask(this.kinds, this.workerId);
        if (!task) break;
        const job = this.execute(task);
        this.active.add(job);
        void job.finally(() => this.active.delete(job));
      }
      if (this.active.size) await Promise.all([...this.active]);
      const available = this.store.queueTasks("queued").some((task) => Date.parse(task.availableAt) <= Date.now());
      if (!available) break;
    } while (!this.stopping);
  }

  start(): void {
    if (this.timer || this.stopping) return;
    void this.runOnce();
    this.timer = setInterval(() => { void this.runOnce(); }, this.pollIntervalMs);
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.abortController.abort();
    if (this.active.size) await Promise.allSettled([...this.active]);
  }

  private async execute(task: QueuedTask): Promise<void> {
    const heartbeat = setInterval(() => { this.store.heartbeatTask(task.id, this.workerId); }, this.heartbeatMs);
    this.store.recordQueueActivity({ taskId: task.id, actorId: this.workerId, kind: "started", message: `Started ${task.kind} attempt ${task.attempts}` });
    try {
      const result = await this.handler(task, this.abortController.signal);
      this.store.updateTask(task.id, "completed", { result });
      this.store.recordQueueActivity({ taskId: task.id, actorId: this.workerId, kind: "completed", message: "Task completed" });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (this.stopping || this.abortController.signal.aborted) {
        this.store.updateTask(task.id, "cancelled", { error: error instanceof Error ? error.message : String(error) });
        this.store.recordQueueActivity({ taskId: task.id, actorId: this.workerId, kind: "blocked", message: `Task cancelled: ${message}` });
      } else if (task.attempts < this.maxAttempts) {
        const delay = Math.max(0, this.retryDelayMs(task, error));
        this.store.retryTask(task.id, { ...(typeof task.payload === "object" && task.payload ? task.payload : {}), lastError: error instanceof Error ? error.message : String(error) }, new Date(Date.now() + delay).toISOString());
        this.store.recordQueueActivity({ taskId: task.id, actorId: this.workerId, kind: "progress", message: `Retry scheduled after failure: ${message}`, metadata: { delayMs: delay } });
      } else {
        const recovery = queueRecoveryAction(error);
        const payload = task.payload && typeof task.payload === "object" && !Array.isArray(task.payload) ? task.payload as Record<string, unknown> : {};
        this.store.updateTask(task.id, "failed", { ...payload, error: message, attempts: task.attempts, recovery });
        this.store.recordQueueActivity({ taskId: task.id, actorId: this.workerId, kind: "failed", message: `Task failed: ${message}`, metadata: recovery });
        this.store.appendEvent("queue.recovery_required", { taskId: task.id, kind: task.kind, attempts: task.attempts, error: message, ...recovery });
      }
    } finally {
      clearInterval(heartbeat);
    }
  }
}
