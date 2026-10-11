import { ResearchStore } from "./store.js";
import { parseSlurmAccounting } from "./executors.js";
import { runProcess } from "./process.js";

/** Read accounting only; never cancel or relaunch an allocation during recovery. */
export async function reconcileSlurmExperiment(storePath: string, cwd: string, experimentId: string, options: { timeoutMs?: number } = {}): Promise<{ released: boolean; queried: number }> {
  const store = new ResearchStore(storePath);
  let queried = 0;
  const duration = Math.max(1, Math.min(15_000, Number.isFinite(options.timeoutMs) ? options.timeoutMs! : 15_000));
  const deadline = Date.now() + duration;
  try {
    if (store.verifyEventChain().status !== "valid") return { released: false, queried };
    const entry = store.experiments().find((item) => item.id === experimentId);
    const payload = entry?.payload as { remoteReconciliationRequired?: unknown; resources?: { executor?: unknown } } | undefined;
    if (payload?.remoteReconciliationRequired !== true || payload.resources?.executor !== "slurm") return { released: false, queried };
    if (store.reconcileRemoteExperiment(experimentId)) return { released: true, queried };
    const records = store.eventsByTypes(["run.remote.submitting", "run.remote.submitted", "run.remote.terminal"])
      .map((event) => ({ type: event.type, payload: event.payload as Record<string, unknown> }))
      .filter((event) => event.payload?.experimentId === experimentId && event.payload.executor === "slurm");
    for (const intent of records.filter((event) => event.type === "run.remote.submitting")) {
      const submissionId = intent.payload.submissionId;
      const allocationName = intent.payload.allocationName;
      if (typeof submissionId !== "string" || !/^[a-f0-9-]{36}$/.test(submissionId) || allocationName !== `evidra-${submissionId}`) continue;
      const receipts = records.filter((event) => event.type === "run.remote.submitted" && event.payload.submissionId === submissionId);
      if (receipts.length !== 1 || records.some((event) => event.type === "run.remote.terminal" && event.payload.submissionId === submissionId)) continue;
      const receipt = receipts[0].payload;
      const jobId = receipt.jobId;
      const cluster = receipt.cluster;
      if (receipt.allocationName !== allocationName || typeof jobId !== "string" || !/^\d+$/.test(jobId) || (cluster !== undefined && (typeof cluster !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(cluster)))) continue;
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      queried += 1;
      try {
        const result = await runProcess(["sacct", ...(typeof cluster === "string" ? ["--clusters", cluster] : []), "--noheader", "--parsable2", "--allocations", "--duplicates", "--starttime", "1970-01-01", "--jobs", jobId, "--format=JobIDRaw,State%40,ExitCode,JobName%80"], cwd, remaining);
        if (result.exitCode === 130) break;
        if (result.exitCode !== 0) continue;
        const accounting = parseSlurmAccounting(result.stdout, jobId, allocationName);
        if (!accounting.terminal) continue;
        store.recordRemoteTerminalEvidence({ experimentId, submissionId, allocationName, jobId, ...(typeof cluster === "string" ? { cluster } : {}), state: accounting.state, exitCode: accounting.exitCode, at: new Date().toISOString() });
      } catch {
        // Missing tools and failed queries leave the durable fence intact.
      }
    }
    return { released: store.reconcileRemoteExperiment(experimentId), queried };
  } finally { store.close(); }
}
