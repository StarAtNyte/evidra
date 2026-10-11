import { ResearchStore } from "./store.js";
import { parseSlurmAccounting } from "./executors.js";
import { runProcess } from "./process.js";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

export interface RemoteReconciliationOptions { timeoutMs?: number; cancelContainer?: boolean }

/** Recovery is read-only unless container cancellation is explicitly requested. */
export async function reconcileRemoteExperiment(storePath: string, cwd: string, experimentId: string, options: RemoteReconciliationOptions = {}): Promise<{ released: boolean; queried: number }> {
  const store = new ResearchStore(storePath);
  let executor: unknown;
  try {
    const entry = store.experiments().find((item) => item.id === experimentId);
    executor = (entry?.payload as { resources?: { executor?: unknown } } | undefined)?.resources?.executor;
  } finally { store.close(); }
  if (executor === "container") return reconcileContainerExperiment(storePath, cwd, experimentId, options);
  if (options.cancelContainer) throw new Error("Container cancellation requires a quarantined container experiment.");
  if (executor === "modal") return reconcileModalExperiment(storePath, cwd, experimentId, options);
  return reconcileSlurmExperiment(storePath, cwd, experimentId, options);
}

/** Poll only recorded Modal calls; pending/errors/expired outputs stay fenced. */
export async function reconcileModalExperiment(storePath: string, cwd: string, experimentId: string, options: { timeoutMs?: number } = {}): Promise<{ released: boolean; queried: number }> {
  const store = new ResearchStore(storePath);
  let queried = 0;
  const deadline = Date.now() + Math.max(1, Math.min(15_000, Number.isFinite(options.timeoutMs) ? options.timeoutMs! : 15_000));
  try {
    if (store.verifyEventChain().status !== "valid") return { released: false, queried };
    const entry = store.experiments().find((item) => item.id === experimentId);
    const payload = entry?.payload as { remoteReconciliationRequired?: unknown; resources?: { executor?: unknown } } | undefined;
    if (payload?.remoteReconciliationRequired !== true || payload.resources?.executor !== "modal") return { released: false, queried };
    if (store.reconcileRemoteExperiment(experimentId)) return { released: true, queried };
    const records = store.eventsByTypes(["run.remote.submitting", "run.remote.submitted", "run.remote.terminal"])
      .map((event) => ({ type: event.type, payload: event.payload as Record<string, unknown> }))
      .filter((event) => event.payload?.experimentId === experimentId && event.payload.executor === "modal");
    for (const intent of records.filter((event) => event.type === "run.remote.submitting")) {
      const { submissionId, allocationName, protocol } = intent.payload;
      if (protocol !== "modal-call-v1" || typeof submissionId !== "string" || !/^[a-f0-9-]{36}$/.test(submissionId) || allocationName !== `evidra-${submissionId}`) continue;
      if (records.filter((record) => record.type === "run.remote.submitting" && record.payload.submissionId === submissionId).length !== 1 || records.some((record) => record.type === "run.remote.terminal" && record.payload.submissionId === submissionId)) continue;
      const receipts = records.filter((event) => event.type === "run.remote.submitted" && event.payload.submissionId === submissionId);
      if (receipts.length !== 1 || records.indexOf(intent) >= records.indexOf(receipts[0])) continue;
      const receipt = receipts[0].payload;
      const callId = receipt.callId;
      if (receipt.phase !== "submitted" || intent.payload.phase !== "submitting" || receipt.protocol !== protocol || receipt.allocationName !== allocationName || typeof callId !== "string" || !/^fc-[A-Za-z0-9]{1,128}$/.test(callId)) continue;
      if (!store.modalCallOwnershipConfirmed(experimentId, submissionId, callId)) continue;
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      queried += 1;
      try {
        const result = await runProcess([process.env.EVIDRA_MODAL_PYTHON ?? "python3", fileURLToPath(new URL("../../modal_reconcile.py", import.meta.url)), callId], cwd, remaining);
        if (result.exitCode === 130) break;
        if (result.exitCode !== 0 || Buffer.byteLength(result.stdout) > 4096) continue;
        const proof = JSON.parse(result.stdout) as { callId?: unknown; state?: unknown; exitCode?: unknown };
        if (proof.callId !== callId || proof.state !== "COMPLETED" || !Number.isInteger(proof.exitCode) || Number(proof.exitCode) < 0 || Number(proof.exitCode) > 255) continue;
        store.recordModalTerminalEvidence({ experimentId, submissionId, allocationName, callId, state: "COMPLETED", exitCode: Number(proof.exitCode), completionEvidence: "sdk-result", at: new Date().toISOString() });
      } catch { /* Failed SDK queries cannot establish remote termination. */ }
    }
    return { released: store.reconcileRemoteExperiment(experimentId), queried };
  } finally { store.close(); }
}

export async function reconcileContainerExperiment(storePath: string, cwd: string, experimentId: string, options: RemoteReconciliationOptions = {}): Promise<{ released: boolean; queried: number }> {
  const store = new ResearchStore(storePath);
  const environment = { ...process.env };
  const duration = Math.max(1, Math.min(15_000, Number.isFinite(options.timeoutMs) ? options.timeoutMs! : 15_000));
  const deadline = Date.now() + duration;
  let queried = 0;
  const query = async (argv: string[]) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return undefined;
    queried += 1;
    try { return await runProcess(argv, cwd, remaining, undefined, undefined, environment); }
    catch { return undefined; }
  };
  try {
    if (store.verifyEventChain().status !== "valid") return { released: false, queried };
    const entry = store.experiments().find((item) => item.id === experimentId);
    const payload = entry?.payload as { remoteReconciliationRequired?: unknown; resources?: { executor?: unknown } } | undefined;
    if (payload?.remoteReconciliationRequired !== true || payload.resources?.executor !== "container") return { released: false, queried };
    if (store.reconcileRemoteExperiment(experimentId)) return { released: true, queried };
    const records = store.eventsByTypes(["run.remote.submitting", "run.remote.submitted", "run.remote.terminal"])
      .map((event) => ({ type: event.type, payload: event.payload as Record<string, unknown> }))
      .filter((event) => event.payload?.experimentId === experimentId && event.payload.executor === "container");
    for (const intent of records.filter((event) => event.type === "run.remote.submitting")) {
      const { submissionId, allocationName, daemonId } = intent.payload;
      if (intent.payload.runtime !== "docker" || typeof daemonId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9:-]{15,127}$/.test(daemonId) || typeof submissionId !== "string" || !/^[a-f0-9-]{36}$/.test(submissionId) || allocationName !== `evidra-${submissionId}` || intent.payload.phase !== "submitting") continue;
      if (records.filter((record) => record.type === "run.remote.submitting" && record.payload.submissionId === submissionId).length !== 1 || records.some((record) => record.type === "run.remote.terminal" && record.payload.submissionId === submissionId)) continue;
      const receipts = records.filter((record) => record.type === "run.remote.submitted" && record.payload.submissionId === submissionId);
      if (receipts.length > 1) continue;
      const receipt = receipts[0]?.payload;
      if (receipt && (receipt.runtime !== "docker" || receipt.daemonId !== daemonId || receipt.allocationName !== allocationName || receipt.phase !== "submitted" || typeof receipt.containerId !== "string" || !/^[a-f0-9]{64}$/.test(receipt.containerId) || records.indexOf(receipts[0]) <= records.indexOf(intent))) continue;
      const before = await query(["docker", "info", "--format", "{{.ID}}"]);
      if (before?.exitCode === 130) break;
      if (before?.exitCode !== 0 || before.stdout.trim() !== daemonId) continue;
      const inspected = await query(["docker", "inspect", "--type", "container", "--format", "[{{json .Id}},{{json .Name}},{{json .Config.Labels}},{{json .State}},{{json .HostConfig.RestartPolicy.Name}}]", String(receipt?.containerId ?? allocationName)]);
      if (inspected?.exitCode === 130) break;
      let containerId: string | undefined;
      let state: "EXITED" | "REMOVED" | undefined;
      let exitCode = 0;
      if (inspected?.exitCode === 0) {
        try {
          const value: unknown = JSON.parse(inspected.stdout);
          if (!Array.isArray(value) || value.length !== 5) continue;
          const [id, name, labels, status, restart] = value;
          if (typeof id !== "string" || !/^[a-f0-9]{64}$/.test(id) || name !== `/${allocationName}` || labels?.["org.evidra.allocation"] !== allocationName || receipt && id !== receipt.containerId) continue;
          if (options.cancelContainer) {
            const event = { experimentId, submissionId, allocationName: String(allocationName), runtime: "docker" as const, daemonId, containerId: id, at: new Date().toISOString() };
            // Persist the exact receipt before requesting daemon-side removal.
            if (!store.recordContainerReceiptEvidence({ ...event, recovered: !receipt })) continue;
            const current = await query(["docker", "info", "--format", "{{.ID}}"]);
            if (current?.exitCode === 130) break;
            if (current?.exitCode !== 0 || current.stdout.trim() !== daemonId) continue;
            const requestId = randomUUID();
            store.appendEvent("run.remote.cleanup.requested", { ...event, requestId, command: ["docker", "rm", "--force", "--volumes", id] });
            const removed = await query(["docker", "rm", "--force", "--volumes", id]);
            if (removed?.exitCode === 130) break;
            const absent = await query(["docker", "ps", "--all", "--no-trunc", "--filter", `id=${id}`, "--format", "{{.ID}}"]);
            if (absent?.exitCode === 130) break;
            const verifiedAbsent = absent?.exitCode === 0 && !absent.stdout.trim();
            store.appendEvent("run.remote.cleanup.observed", { ...event, at: new Date().toISOString(), requestId, exitCode: removed?.exitCode ?? null, verifiedAbsent });
            if (removed?.exitCode !== 0 || !verifiedAbsent) continue;
            containerId = id; state = "REMOVED";
          } else {
            // A stopped snapshot is insufficient if automatic restart is enabled.
            if (restart !== "no" || status?.Status !== "exited" || status.Running !== false || status.Restarting !== false || status.Paused !== false || status.Pid !== 0 || !Number.isInteger(status.ExitCode) || status.ExitCode < 0 || status.ExitCode > 255) continue;
            containerId = id; state = "EXITED"; exitCode = status.ExitCode;
          }
        } catch { continue; }
      } else if (receipt) {
        const absent = await query(["docker", "ps", "--all", "--no-trunc", "--filter", `id=${receipt.containerId}`, "--format", "{{.ID}}"]);
        if (absent?.exitCode === 130) break;
        if (absent?.exitCode === 0 && !absent.stdout.trim()) { containerId = String(receipt.containerId); state = "REMOVED"; }
      }
      if (!containerId || !state) continue;
      const after = await query(["docker", "info", "--format", "{{.ID}}"]);
      if (after?.exitCode === 130) break;
      if (after?.exitCode !== 0 || after.stdout.trim() !== daemonId) continue;
      const event = { experimentId, submissionId, allocationName: String(allocationName), runtime: "docker" as const, daemonId, containerId, at: new Date().toISOString() };
      if (!receipt && !store.recordContainerReceiptEvidence({ ...event, recovered: true })) continue;
      store.recordContainerTerminalEvidence({ ...event, state, exitCode });
    }
    return { released: store.reconcileRemoteExperiment(experimentId), queried };
  } finally { store.close(); }
}

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
