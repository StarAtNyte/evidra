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
    const taskAbortController = new AbortController();
    const abortFromWorker = (): void => taskAbortController.abort();
    this.abortController.signal.addEventListener("abort", abortFromWorker, { once: true });
    const heartbeat = setInterval(() => { this.store.heartbeatTask(task.id, this.workerId, task.claimToken ?? undefined); }, this.heartbeatMs);
    const cancellationPoll = setInterval(() => {
      const current = this.store.queueTasks().find((entry) => entry.id === task.id);
      if (current?.deadlineAt && Date.parse(current.deadlineAt) <= Date.now()) this.store.cancelTask(task.id, "task wall-clock deadline exceeded", "deadline");
      if (!current || current.status === "cancelled" || current.status !== "running" || current.ownerId !== this.workerId) taskAbortController.abort();
    }, this.heartbeatMs);
    const activity = (kind: "started" | "progress" | "blocked" | "handoff" | "completed" | "failed", message: string, metadata?: unknown): boolean => this.store.recordQueueActivity({ taskId: task.id, actorId: this.workerId, kind, message, metadata, claimToken: task.claimToken ?? undefined });
    activity("started", `Started ${task.kind} attempt ${task.attempts}`);
    try {
      const result = await this.handler(task, taskAbortController.signal);
      const completionPayload = { result };
      if (this.store.completeClaimedTask(task.id, this.workerId, "completed", completionPayload, undefined, task.claimToken ?? undefined)) {
        this.store.recordQueueActivity({ taskId: task.id, actorId: this.workerId, kind: "completed", message: "Task completed" });
      } else {
        // A completion contract can reject an otherwise successful handler.
        // Do not leave the ticket owned and running until stale recovery: give
        // it another bounded attempt, or make the proof failure recoverable.
        const current = this.store.queueTasks().find((entry) => entry.id === task.id);
        const audit = this.store.taskCompletionAudit(task.id, completionPayload);
        if (current?.status === "running" && current.ownerId === this.workerId && !audit.valid) {
          const message = `Completion proof missing: ${audit.missing.join(", ")}`;
          if (task.attempts < this.maxAttempts) {
            const delay = Math.max(0, this.retryDelayMs(task, new Error(message)));
            const retried = this.store.retryClaimedTask(task.id, this.workerId, { ...(typeof task.payload === "object" && task.payload ? task.payload : {}), lastError: message }, new Date(Date.now() + delay).toISOString(), task.claimToken ?? undefined);
            if (retried) this.store.recordQueueActivity({ taskId: task.id, actorId: this.workerId, kind: "progress", message: `Retry scheduled after rejected completion: ${message}`, metadata: { delayMs: delay, missing: audit.missing } });
          } else {
            const recovery = queueRecoveryAction(new Error(message));
            if (this.store.completeClaimedTask(task.id, this.workerId, "failed", { ...(typeof task.payload === "object" && task.payload ? task.payload : {}), error: message, attempts: task.attempts, recovery }, undefined, task.claimToken ?? undefined)) {
              this.store.recordQueueActivity({ taskId: task.id, actorId: this.workerId, kind: "failed", message, metadata: recovery });
              this.store.appendEvent("queue.recovery_required", { taskId: task.id, kind: task.kind, attempts: task.attempts, error: message, ...recovery });
            }
          }
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const current = this.store.queueTasks().find((entry) => entry.id === task.id);
      if (current?.status === "cancelled") {
        this.store.recordQueueActivity({ taskId: task.id, actorId: this.workerId, kind: "blocked", message: `Cancellation observed: ${message}` });
      } else if (this.stopping || this.abortController.signal.aborted) {
        if (this.store.completeClaimedTask(task.id, this.workerId, "cancelled", { error: error instanceof Error ? error.message : String(error) }, undefined, task.claimToken ?? undefined)) {
          this.store.recordQueueActivity({ taskId: task.id, actorId: this.workerId, kind: "blocked", message: `Task cancelled: ${message}` });
        }
      } else if (task.attempts < this.maxAttempts) {
        const delay = Math.max(0, this.retryDelayMs(task, error));
        const retried = this.store.retryClaimedTask(task.id, this.workerId, { ...(typeof task.payload === "object" && task.payload ? task.payload : {}), lastError: error instanceof Error ? error.message : String(error) }, new Date(Date.now() + delay).toISOString(), task.claimToken ?? undefined);
        if (retried) this.store.recordQueueActivity({ taskId: task.id, actorId: this.workerId, kind: "progress", message: `Retry scheduled after failure: ${message}`, metadata: { delayMs: delay } });
      } else {
        const recovery = queueRecoveryAction(error);
        const payload = task.payload && typeof task.payload === "object" && !Array.isArray(task.payload) ? task.payload as Record<string, unknown> : {};
        if (this.store.completeClaimedTask(task.id, this.workerId, "failed", { ...payload, error: message, attempts: task.attempts, recovery }, undefined, task.claimToken ?? undefined)) {
          this.store.recordQueueActivity({ taskId: task.id, actorId: this.workerId, kind: "failed", message: `Task failed: ${message}`, metadata: recovery });
          this.store.appendEvent("queue.recovery_required", { taskId: task.id, kind: task.kind, attempts: task.attempts, error: message, ...recovery });
        }
      }
    } finally {
      clearInterval(heartbeat);
      clearInterval(cancellationPoll);
      this.abortController.signal.removeEventListener("abort", abortFromWorker);
    }
  }
}
