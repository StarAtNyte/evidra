import React, { useEffect, useRef, useState } from "react";
import { Box, Static, Text, useApp, useInput } from "ink";
import TextInput from "ink-text-input";
import { dirname, join, relative, resolve } from "node:path";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { ResearchStore } from "../core/store.js";
import { processFailureResult, runProcess, splitCommandLine, type ProcessControl } from "../core/process.js";
import { autonomyPolicy, guardCommand } from "../core/permissions.js";
import { QueueWorker } from "../core/queue-worker.js";
import { classifyProcessFailure, executorFor, parseMetricOutput, prepareExperimentEnvironment, validateRunMetrics } from "../core/executors.js";
import { ensureWorktree } from "../core/worktree.js";
import { auditExperiment, auditExperimentSubtask, externalScoreObservedForExperiment, independentReplicationObserved, refreshAuditWithExternalScore, refreshExperimentAudit, validateEvaluationMatrix } from "../core/validation.js";
import { auditResearchDecision, downgradeUnauditedDecision } from "../core/decision-auditor.js";
import { sha256File } from "../core/evidence.js";
import { captureEnvironment } from "../core/environment.js";
import { compareRuns } from "../core/statistics.js";
import { recoveryDelay, recoveryPlan, recoveryRouteDirective } from "../core/recovery.js";
import { observedGpuHours } from "../core/compute-budget.js";
import { campaignElapsedMinutes, pauseCampaign, readCampaignCheckpoint, resumeCampaign, withCampaignCheckpoint } from "../core/campaign.js";
import { prepareSubmission, validateSubmissionBundle } from "../core/submissions.js";
import { pollSubmissionScore, submitApprovedBundle } from "../core/submission-adapters.js";
import { evaluateSubmissionPolicy } from "../core/submission-policy.js";
import { createBlendCandidate, diversityReport, loadPredictionVector, safePredictionPath, validateBlendCandidate, type PredictionVector } from "../core/ensemble.js";
import { renderReport, writeReport, type ReportKind } from "../core/reports.js";
import { auditData, dataAuditFingerprint } from "../core/data-audit.js";
import { executeResearchTool } from "../core/tools.js";
import { createValidationPolicy, writeValidationPolicy } from "../core/validation-policy.js";
import { retrieveSource, searchResearchSources, sourceClaims, sourceSearchText, sourceIsFresh } from "../core/sources.js";
import { activePhaseGoal, auditPhaseGoalGate, definePhaseGoals, evaluatePhaseGoalEvidence, mergePhaseGoalAudits, PHASE_GOAL_EVENT_TYPES, phaseGoalEventsSince, phaseGoalRecordsSince, phaseGoalSetId, phaseGoalsForMode } from "../core/phase-goals.js";
import { createExperimentManifest, createReplicationManifest, manifestSummary } from "../core/experiment-manifest.js";
import { materializeResearchDecision } from "../core/research-graph.js";
import { loadCompetitionAdapter } from "../competitions/adapters.js";
import { codexLoginStatus, codexResearchModelPool, DEFAULT_CODEX_MODEL, isProviderUsageLimit, listCodexModels, listLocalModels, loginCodex, providerRetryAfterMs, queueCodexMessage, resolveCodexBinary, resolveStartupProvider, runWithLocalFallback, type AgentProvider, type AvailableModel } from "../agents/codex-exec.js";
import { formatResearchDecision, runResearchDirector } from "../agents/research-director.js";
import { boundedPeerBoard, runResearchCritic, runResearchLanes, runResearchSemanticAuditor, type ResearchLaneReport, type ResearchReview, type ResearchSemanticAudit } from "../agents/research-lanes.js";
import { ExperimentManifestSchema, PhaseGoalSchema, RunResultSchema } from "../core/types.js";
import { createToolTraceRecorder, evaluateTrajectory, providerActivityFailureClass, type TrajectoryEvent } from "../core/trajectories.js";
import { recoverUncommittedTraceFiles } from "../core/trajectory-recovery.js";
import { capabilityOutcome, qualityFeedback, routeCapability } from "../core/capability-router.js";
import { allocateNextResearch } from "../core/allocation.js";
import { buildExperienceRecord, capabilityProfile, experienceJsonl, selectCurriculum } from "../core/experience.js";
import { rankExperimentCandidates } from "../core/scheduler.js";
import { evaluateReducedPromotion } from "../core/scheduler.js";
import { validateCompetitionContract } from "../core/competition-contract.js";
import { learnPromotionPolicy, promotionObservations } from "../core/promotion-learning.js";
import { captureProtectedFiles, changedProtectedFiles } from "../core/integrity.js";
import { candidateChangePath } from "../core/hypothesis-path.js";
import { withExecutionHeartbeat } from "../core/execution-heartbeat.js";
import { evaluateValidationAcceptance } from "../core/validation-engine.js";
import { advanceExecutionStage, createExecutionPlan, validateExecutionContract, type ExecutionStage } from "../core/execution-stages.js";
import { runReducedValidation } from "../core/stage-executor.js";
import { renderTimeline } from "../core/timeline.js";
import { latestSourceEntries, researchMemoryContext } from "../core/research-context.js";
import { detectStagnation } from "../core/stagnation.js";
import { applyCriticGate } from "../core/critic-gate.js";
import { applyUnifiedDiff, extractUnifiedDiff } from "../core/experiment-patches.js";
import { recordBaselineEvidence } from "../core/baseline.js";
import { redactSecrets } from "../core/redaction.js";
import { enforceClaimTermination, enforceGoalTermination } from "../core/termination.js";
import { auditClaims, selfDescribingClaimEvidenceIds } from "../core/claim-audit.js";
import { summarizeAgentUsage, summarizeUsage } from "../core/usage.js";
import { parseLiteratureBenchmarkInput, scoreLiteratureBenchmark } from "../core/literature-bench.js";
import { parseAutoResearchBenchEvaluation } from "../core/autoresearch-bench.js";
import { assessResearchDecisionRubric } from "../core/research-rubric.js";
import { assertValidationPolicy, lockValidationPolicy, readValidationPolicyLock, unlockValidationPolicy } from "../core/validation-lock.js";
import { deriveAdaptiveHarnessPolicy } from "../core/adaptive-harness.js";
import { synthesizeLaneReports } from "../core/cross-pollination.js";
import { analyzePredictionRows, parsePredictionRows } from "../core/error-analysis.js";
import { createTransferableMethod } from "../core/method-transfer.js";
import { createAblationPlan } from "../core/ablation.js";
import { buildMlflowRunExports } from "../core/mlflow.js";
import { summarizeForecastAssessments } from "../core/forecast-calibration.js";

type Message = { role: "user" | "assistant" | "system"; text: string; kind?: "message" | "tool" };
type QueuedRequest = { id: string; text: string; dispatched?: boolean };
type WorkbenchMode = "research" | "challenge";
type AutonomyLevel = "safe" | "fast" | "yolo";
type ResearchCampaign = { goal: string; budgetMinutes: number; gpuBudgetHours?: number; stopCondition: string; startedAt: string; status: "setup" | "running" | "paused" | "completed"; pausedAt?: string; pausedDurationMinutes?: number; nextAttemptAt?: string; limitMessage?: string; autoExecuteExperiments?: boolean; currentCycle?: number; currentStep?: string; checkpointedAt?: string };
type LimitPolicy = "auto" | "wait" | "fallback" | "stop";
type ExperimentExecutorKind = "local" | "container" | "modal";
type SessionConfig = { provider: AgentProvider; model: string; reasoningEffort: string; mode: WorkbenchMode; autonomy: AutonomyLevel; limitPolicy: LimitPolicy; fallbackModel: string; experimentExecutor: ExperimentExecutorKind; campaign?: ResearchCampaign; codexThreadId?: string };

function candidateEstimatorPath(payload: unknown): string | undefined {
  const proposedChange = (payload as { proposedChange?: unknown } | null)?.proposedChange;
  return candidateChangePath(proposedChange);
}

function candidateExperimentCommand(adapter: ReturnType<typeof loadCompetitionAdapter>, payload: unknown): string[] {
  const command = adapter.experimentCommand();
  const estimator = candidateEstimatorPath(payload);
  if (!estimator) return command;
  const index = command.indexOf("--estimator");
  if (index >= 0 && command[index + 1]) command[index + 1] = estimator;
  return command;
}

function auditEvidenceStore(store: ResearchStore) {
  const claims = store.claims();
  const sources = store.sources();
  const decisions = store.decisions();
  const runs = store.runs();
  const artifacts = store.artifacts();
  const edges = store.edges().filter((edge) => edge.relation === "contradicts");
  const selfDescribing = selfDescribingClaimEvidenceIds(claims);
  return auditClaims({
    claims: claims.map((claim) => ({ id: claim.id, payload: claim.payload })),
    knownEvidenceIds: new Set([
      ...sources.map((entry) => entry.id), ...decisions.map((entry) => entry.id.toString()),
      ...decisions.map((entry) => `decision_${entry.id}`), ...runs.map((entry) => entry.id),
      ...artifacts.map((entry) => entry.id), ...claims.map((entry) => entry.id), ...selfDescribing,
    ]),
    conflictedClaimIds: new Set(edges.flatMap((edge) => [edge.fromId, edge.toId])),
  });
}

const defaultConfig: SessionConfig = { provider: "codex", model: DEFAULT_CODEX_MODEL, reasoningEffort: "medium", mode: "research", autonomy: "safe", limitPolicy: "auto", fallbackModel: process.env.EVIDRA_FALLBACK_MODEL ?? "auto", experimentExecutor: "local" };
const COMMANDS = [
  ["/help", "Show commands"],
  ["/mode", "Show or switch active mode"],
  ["/research", "Inspect, run, and explain the next research decision"],
  ["/challenge", "Run the active challenge workflow"],
  ["/experiment", "Create or run a reproducible experiment"],
  ["/loop", "Run the autonomous research loop"],
  ["/steer", "Guide the active campaign at its next safe boundary"],
  ["/status", "Show complete workbench state"],
  ["/experience", "Show reusable trajectory experience and curriculum"],
  ["/usage", "Show budget, activity, and campaign usage"],
  ["/sources", "Retrieve and search research sources"],
  ["/evidence", "Audit claim provenance and completion blockers"],
  ["/memory", "Search durable evidence and research memory"],
  ["/data", "Inspect or audit competition data"],
  ["/validation", "Inspect or generate validation policy"],
  ["/agents", "Show research-agent lanes and health"],
  ["/limits", "Choose what happens when provider usage is exhausted"],
  ["/compute", "Show execution and compute health"],
  ["/submission", "Prepare and validate a submission bundle"],
  ["/queue", "Show durable research work queue"],
  ["/sessions", "List saved terminal sessions"],
  ["/resume", "Resume a saved session explicitly"],
  ["/ensemble", "Analyze prediction diversity and blends"],
  ["/report", "Generate portable research reports"],
  ["/timeline", "Show readable autonomous progress"],
  ["/integrity", "Verify durable event history"],
  ["/backup", "Create a durable state backup"],
  ["/doctor", "Diagnose local research dependencies"],
  ["/contract", "Validate workspace and experiment contract"],
  ["/provider", "Select codex or local provider"],
  ["/model", "Select the active model"],
  ["/thinking", "Select model thinking effort"],
  ["/autonomy", "Select safe, fast, or YOLO policy"],
  ["/permissions", "Select what Evidra may do automatically"],
  ["/login", "Authenticate or check provider access"],
  ["/exit", "Quit Evidra"],
] as const;
const LOGO = [
  "███████╗██╗   ██╗██╗██████╗ ██████╗  █████╗",
  "██╔════╝██║   ██║██║██╔══██╗██╔══██╗██╔══██╗",
  "█████╗  ██║   ██║██║██║  ██║██████╔╝███████║",
  "██╔══╝  ╚██╗ ██╔╝██║██║  ██║██╔══██╗██╔══██║",
  "███████╗ ╚████╔╝ ██║██████╔╝██║  ██║██║  ██║",
  "╚══════╝  ╚═══╝  ╚═╝╚═════╝ ╚═╝  ╚═╝╚═╝  ╚═╝",
].join("\n");
const REASONING_LEVELS = ["low", "medium", "high", "xhigh", "max", "ultra"] as const;
const AGENT_ROLES = ["research director", "domain researcher", "method researcher", "data detective", "validation scientist", "model researcher", "ensemble scientist", "reproducibility engineer", "experiment engineer", "critic", "repair agent"] as const;
const SUBCOMMANDS: Record<string, readonly (readonly [string, string])[]> = {
  "/workbench": [["/workbench research", "Enter Research mode"], ["/workbench challenge", "Enter Challenge mode"]],
  "/mode": [["/mode research", "Enter Research mode"], ["/mode challenge", "Enter Challenge mode"]],
  "/experience": [["/experience", "Show capability profile and curriculum"], ["/experience export", "Export admissible experiences as JSONL"]],
  "/autonomy": [["/autonomy safe", "Approval-gated"], ["/autonomy fast", "Run local work automatically"], ["/autonomy yolo", "Run routine work automatically"]],
  "/permissions": [["/permissions safe", "Approval-gated"], ["/permissions fast", "Run local work automatically"], ["/permissions yolo", "Run routine work automatically"]],
  "/loop": [["/loop status", "Show loop state"], ["/loop once", "Run one research cycle"], ["/loop start", "Start autonomous loop"], ["/loop pause", "Pause loop"], ["/loop stop", "Stop loop"]],
  "/steer": [["/steer ", "Guide the active campaign at the next safe boundary"]],
  "/scheduler": [["/scheduler start", "Start scheduling"], ["/scheduler pause", "Pause scheduling"], ["/scheduler drain", "Finish active work only"]],
  "/thinking": REASONING_LEVELS.map((level) => [`/thinking ${level}`, `Thinking effort: ${level}`] as const),
  "/provider": [["/provider codex", "Use authenticated Codex"], ["/provider local", "Use local Ollama"]],
  "/login": [["/login codex", "Sign in with ChatGPT subscription"], ["/login status", "Check Codex authentication"]],
  "/research": [["/research next", "Run the next evidence-gathering cycle"], ["/research status", "Show research state"], ["/research start", "Start autonomous research"], ["/research steer ", "Guide the active campaign at the next safe boundary"], ["/research resume", "Resume the saved campaign"], ["/research pause", "Pause active workers"], ["/research stop", "Stop and save the campaign"]],
  "/challenge": [["/challenge status", "Show challenge state"], ["/challenge start", "Start challenge zero-to-hero flow"], ["/challenge steer ", "Guide the active campaign at the next safe boundary"], ["/challenge resume", "Resume the saved campaign"], ["/challenge pause", "Pause active workers"], ["/challenge stop", "Stop and save the campaign"], ["/challenge inspect", "Inspect rules and evaluator"], ["/challenge audit", "Audit files and duplicate data"], ["/challenge audit accept ", "Accept documented audit findings"], ["/challenge policy", "Generate validation policy"], ["/challenge baseline", "Run the canonical baseline"]],
  "/experiment": [["/experiment list", "List experiment manifests"], ["/experiment propose", "Create an immutable manifest"], ["/experiment run", "Run an isolated experiment"], ["/experiment replicate", "Create an independent replication"], ["/experiment compare", "Compare two runs"], ["/experiment audit", "Audit evidence gates"], ["/experiment gate", "Record leakage/reviewer approval"]],
  "/sources": [["/sources list", "List retrieved sources"], ["/sources add", "Retrieve a URL into the evidence store"], ["/sources discover", "Search scholarly literature"], ["/sources search", "Search retrieved sources"], ["/sources show", "Show a source and excerpt"]],
  "/benchmark": [["/benchmark literature-score ", "Score Evidra literature discovery"], ["/benchmark autoresearch ", "Import official AutoResearchBench evaluation"]],
  "/telemetry": [["/telemetry export", "Export MLflow-compatible run telemetry"]],
  "/evidence": [["/evidence audit", "Audit claim provenance and completion blockers"], ["/evidence analyze", "Analyze prediction errors and worst groups"]],
  "/memory": [["/memory recent", "Show recent evidence"], ["/memory search", "Search evidence and sources"]],
  "/data": [["/data audit", "Audit files and exact duplicates"]],
  "/validation": [["/validation inspect", "Show validation policy"], ["/validation generate", "Generate a versioned policy"], ["/validation lock", "Lock validation policy"], ["/validation unlock", "Unlock with a reason"]],
  "/agents": [["/agents status", "Show agent/provider health"], ["/agents limits", "Show configured limits"]],
  "/limits": [["/limits auto", "Use local fallback, then wait"], ["/limits wait", "Wait for Codex usage to reset"], ["/limits fallback", "Require local fallback"], ["/limits stop", "Stop when Codex is limited"]],
  "/compute": [["/compute status", "Show executor health"], ["/compute local", "Run experiments on this computer"], ["/compute container", "Run in Docker or Podman"], ["/compute modal", "Run experiments on Modal"], ["/compute budget", "Show campaign usage"]],
  "/submission": [["/submission status", "List prepared bundles"], ["/submission prepare", "Build a provenance bundle"], ["/submission validate", "Validate a bundle"], ["/submission approve", "Approve a valid bundle"], ["/submission submit", "Submit an approved bundle"], ["/submission poll", "Poll a configured external score"], ["/submission record", "Record an external score"], ["/submission distribution", "Estimate predictive validation split"]],
  "/queue": [["/queue status", "Show queued and running tasks"], ["/queue recover", "Requeue stale tasks"]],
  "/sessions": [["/sessions", "List recent saved sessions"]],
  "/resume": [["/resume", "Resume the latest saved session"], ["/resume ", "Resume a selected session"]],
  "/ensemble": [["/ensemble candidates", "List prediction artifacts"], ["/ensemble diversity", "Compare prediction diversity"], ["/ensemble propose", "Create an OOF blend candidate"], ["/ensemble validate", "Verify a blend candidate"], ["/ensemble promote", "Promote a validated candidate"], ["/ensemble reject", "Reject a candidate"]],
  "/report": [["/report research", "Write a research report"], ["/report challenge", "Write a challenge report"], ["/report final", "Write a provenance report"]],
  "/timeline": [["/timeline", "Show recent autonomous progress"]],
};

function loadConfig(path: string): SessionConfig {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<SessionConfig>;
    const config = { ...defaultConfig, ...raw } as SessionConfig;
    // A fresh terminal always starts a fresh Evidra session. The provider
    // thread is restored only by an explicit /resume action below.
    config.codexThreadId = undefined;
    // Permissions are intentionally session-scoped. Never inherit fast/YOLO from a prior terminal.
    config.autonomy = defaultConfig.autonomy;
    // Older Evidra sessions used a model name that ChatGPT-account Codex does not accept.
    if (config.provider === "codex" && (config.model === "default" || config.model === "gpt-5.3-codex" || /gpt-6.*astra/i.test(config.model))) config.model = DEFAULT_CODEX_MODEL;
    if (config.provider === "local" && /^(gpt|codex)/i.test(config.model)) config.model = "unconfigured";
    if (!["auto", "wait", "fallback", "stop"].includes(config.limitPolicy)) config.limitPolicy = defaultConfig.limitPolicy;
    if (!config.fallbackModel) config.fallbackModel = defaultConfig.fallbackModel;
    if (!["local", "container", "modal"].includes(config.experimentExecutor)) config.experimentExecutor = defaultConfig.experimentExecutor;
    if (config.campaign?.status === "running") config.campaign = pauseCampaign(config.campaign);
    if (config.mode !== "research" && config.mode !== "challenge") config.mode = defaultConfig.mode;
    if (!["safe", "fast", "yolo"].includes(config.autonomy)) config.autonomy = defaultConfig.autonomy;
    return config;
  }
  catch { return defaultConfig; }
}

function saveConfig(path: string, config: SessionConfig): void {
  mkdirSync(join(path, ".."), { recursive: true });
  const { autonomy: _sessionOnlyPermissions, ...persistent } = config;
  writeFileSync(path, `${JSON.stringify(persistent, null, 2)}\n`);
}

function parseBudgetMinutes(value: string): number | undefined {
  const match = value.trim().match(/^(\d+(?:\.\d+)?)\s*(m|min|minutes?|h|hours?|d|days?)?$/i);
  if (!match) return undefined;
  const amount = Number(match[1]);
  const unit = (match[2] ?? "m").toLowerCase();
  const multiplier = unit.startsWith("h") ? 60 : unit.startsWith("d") ? 1440 : 1;
  const minutes = Math.round(amount * multiplier);
  return Number.isFinite(minutes) && minutes > 0 ? minutes : undefined;
}

function help(): string {
  return [
    "/help                         Show commands",
    "/mode [research|challenge]   Show or switch active mode",
    "/research [next|question]    Configure autonomous research or run one cycle",
    "/challenge [start|status]    Start or inspect the active challenge",
    "/experiment [propose|run]    Create or run a reproducible experiment",
    "/loop [once|start|pause]     Run the autonomous research loop",
    "/status                      Show complete workbench state",
    "/experience [export]       Show or export trajectory experience",
    "/usage                       Show budgets and research activity",
    "/sources [add|discover|search|show] Retrieve or search research sources",
    "/memory [recent|search]      Search durable evidence memory",
    "/data audit                 Audit challenge files and duplicates",
    "/validation [inspect|generate] Show validation policy",
    "/agents                     Show research-agent health",
    "/limits [auto|wait|fallback|stop] Choose provider-limit behavior",
    "/compute [local|container|modal|status] Select the experiment execution target",
    "/doctor                     Diagnose local dependencies",
    "!<shell command>            Run a shell command in the project workspace",
    "/submission [prepare|validate|approve|submit|poll|record] Manage safe bundles and external scores",
    "/queue [status|recover]      Show or recover durable tasks",
    "/sessions                   List saved terminal sessions",
    "/resume [session-id]        Explicitly resume a saved session",
    "/ensemble [candidates|diversity|propose|validate|promote|reject] Analyze prediction artifacts",
    "/report [research|challenge|final] Generate a portable report",
    "/timeline [limit]            Show recent autonomous progress",
    "/integrity                   Verify durable event history",
    "/backup [path]              Create a durable state backup",
    "/provider [codex|local]      Select ChatGPT Codex or local Ollama",
    `/model [name]                Show or select the model (default: ${DEFAULT_CODEX_MODEL})`,
    "/thinking [level]            Select model thinking effort",
    "/login [codex|status]        Authenticate or check provider access",
    "/autonomy [safe|fast|yolo]   Set autonomous execution policy",
    "/permissions                 Select what Evidra may do automatically",
    "/exit                        Quit Evidra",
    "",
    "Anything else is sent to the research director.",
  ].join("\n");
}

function messageLabel(message: Message): string {
  if (message.role === "user" || message.role === "system") return "";
  const firstLine = message.text.split("\n", 1)[0] ?? "";
  if (/^(Usage|Project:|Evidra Workbench|Autonomous loop|Research agents|Executor policy|Data audit|Validation policy|Validation policy generated|Source retrieved|Recent research memory|Zero-to-hero|Phase:)/i.test(firstLine)) return firstLine.replace(/:.*/, "").slice(0, 30).toUpperCase();
  return "";
}

function RichText({ text }: { text: string }): React.JSX.Element {
  const lines = text.split("\n");
  const blocks: React.JSX.Element[] = [];
  let codeLines: string[] = [];
  let inCode = false;
  const flushCode = (): void => {
    if (!codeLines.length) return;
    const captured = codeLines;
    blocks.push(
      <Box key={`code-${blocks.length}`} borderStyle="single" borderColor="cyan" paddingX={1} flexDirection="column" marginTop={1} marginBottom={1}>
        {captured.map((line, index) => {
          const color = line.startsWith("+") && !line.startsWith("+++") ? "green" : line.startsWith("-") && !line.startsWith("---") ? "red" : line.startsWith("@@") ? "cyan" : "white";
          return <Text key={`${index}-${line}`} color={color}>{line || " "}</Text>;
        })}
      </Box>,
    );
    codeLines = [];
  };
  lines.forEach((line, index) => {
    if (line.trimStart().startsWith("```")) {
      if (inCode) flushCode();
      else blocks.push(<Text key={`fence-${index}`} color="cyan">{line}</Text>);
      inCode = !inCode;
      return;
    }
    if (inCode) { codeLines.push(line); return; }
    const diffColor = line.startsWith("+") && !line.startsWith("+++") ? "green" : line.startsWith("-") && !line.startsWith("---") ? "red" : line.startsWith("@@") ? "cyan" : line.startsWith("✓") ? "green" : line.startsWith("✗") ? "red" : line.startsWith("⚠") ? "yellow" : undefined;
    const field = line.match(/^(\s*)([A-Za-z][A-Za-z0-9 _/-]{0,28}:)(.*)$/);
    if (field) {
      blocks.push(<Text key={`line-${index}`}><Text color="cyan">{field[1]}{field[2]}</Text><Text color="white">{field[3]}</Text></Text>);
    } else if (line.trim().endsWith("?")) {
      blocks.push(<Text key={`line-${index}`} color="yellow" bold>{line}</Text>);
    } else if (/^(Autonomous research setup|Step \d+\/\d+)/i.test(line.trim())) {
      blocks.push(<Text key={`line-${index}`} color="magenta" bold>{line}</Text>);
    } else {
      blocks.push(<Text key={`line-${index}`} color={diffColor ?? "white"}>{line || " "}</Text>);
    }
  });
  if (inCode) flushCode();
  return <Box flexDirection="column">{blocks}</Box>;
}

export function App({ root }: { root: string }): React.JSX.Element {
  const { exit } = useApp();
  const configPath = join(root, ".sota", "session.json");
  const [config, setConfig] = useState<SessionConfig>(() => loadConfig(configPath));
  const [messages, setMessages] = useState<Message[]>([
    { role: "system", text: "Evidra Research Director — type /help for commands." },
  ]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [busyFrame, setBusyFrame] = useState(0);
  const [progress, setProgressState] = useState("");
  const progressRef = useRef("");
  const progressLastPaint = useRef(0);
  const progressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [availableModels, setAvailableModels] = useState<AvailableModel[]>([]);
  const [modelLoadError, setModelLoadError] = useState<string | null>(null);
  const [selectedModel, setSelectedModel] = useState<AvailableModel | null>(null);
  const [picker, setPicker] = useState<"provider" | "model" | "reasoning" | "mode" | "permissions" | null>(null);
  const [pickerIndex, setPickerIndex] = useState(0);
  const [firstRun] = useState(() => !existsSync(configPath));
  const [onboardingComplete, setOnboardingComplete] = useState(() => !firstRun);
  const [suggestionIndex, setSuggestionIndex] = useState(0);
  const [setupStep, setSetupStep] = useState<"goal" | "budget" | "stop" | null>(null);
  const [setupDraft, setSetupDraft] = useState<{ goal?: string; budgetMinutes?: number }>({});
  const [inputMount, setInputMount] = useState(0);
  const sessionId = useRef(`session_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
  const messagesRef = useRef<Message[]>(messages);
  const configRef = useRef<SessionConfig>(config);
  const submitRef = useRef<(value: string, fromQueue?: boolean) => Promise<void>>(async () => undefined);
  const pendingRequests = useRef<QueuedRequest[]>([]);
  const [queuedRequests, setQueuedRequests] = useState<QueuedRequest[]>([]);
  const suppressNextSubmit = useRef(false);
  const loopTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const loopBusy = useRef(false);
  const activeProcess = useRef<ProcessControl | null>(null);
  const activeProcesses = useRef(new Set<ProcessControl>());
  const activeSteer = useRef<((message: string) => boolean | Promise<boolean>) | null>(null);
  // Ordinary Codex chat keeps one provider thread for the lifetime of this
  // terminal process. Autonomous research deliberately does not reuse it:
  // the controller supplies its own bounded, durable research context.
  const activeCodexThread = useRef<string | undefined>();
  const interruptedProcess = useRef(false);
  const controllerLeaseId = useRef(`controller_${sessionId.current}`);
  const controllerLeaseHeld = useRef(false);
  const controllerHeartbeat = useRef<ReturnType<typeof setInterval> | null>(null);
  const registerProcess = (control: ProcessControl): void => {
    activeProcesses.current.add(control);
    activeProcess.current = control;
  };
  const persistAgentUsage = (usage: { inputTokens?: number; outputTokens?: number; cachedInputTokens?: number; cacheWriteInputTokens?: number; reasoningOutputTokens?: number } | undefined, provider: string, model: string, role: string): void => {
    const usageStore = new ResearchStore(join(root, ".sota", "database.sqlite"));
    usageStore.appendEvent("research.agent.usage", { role, provider, model, inputTokens: usage?.inputTokens, outputTokens: usage?.outputTokens, cachedInputTokens: usage?.cachedInputTokens, cacheWriteInputTokens: usage?.cacheWriteInputTokens, reasoningOutputTokens: usage?.reasoningOutputTokens, sessionId: sessionId.current });
    usageStore.close();
  };
  const terminateActiveProcesses = (): void => {
    for (const control of activeProcesses.current) control.terminate();
    activeProcess.current?.terminate();
    activeProcess.current = null;
  };
  const pauseActiveProcesses = (): void => {
    for (const control of activeProcesses.current) control.pause();
    activeProcess.current?.pause();
  };
  const resumeActiveProcesses = (): void => {
    for (const control of activeProcesses.current) control.resume();
    activeProcess.current?.resume();
  };
  const setProgress = (value: string): void => {
    progressRef.current = value;
    if (progressTimer.current) clearTimeout(progressTimer.current);
    const paint = (): void => { progressLastPaint.current = Date.now(); setProgressState(progressRef.current); };
    if (!value || Date.now() - progressLastPaint.current >= 120) paint();
    else progressTimer.current = setTimeout(paint, 120);
  };
  const releaseControllerLease = (): void => {
    if (controllerHeartbeat.current) { clearInterval(controllerHeartbeat.current); controllerHeartbeat.current = null; }
    if (!controllerLeaseHeld.current) return;
    const store = new ResearchStore(join(root, ".sota", "database.sqlite"));
    store.releaseControllerLease(controllerLeaseId.current);
    store.close();
    controllerLeaseHeld.current = false;
  };
  const acquireControllerLease = (mode: WorkbenchMode, currentStep: string): boolean => {
    const store = new ResearchStore(join(root, ".sota", "database.sqlite"));
    const result = store.acquireControllerLease(controllerLeaseId.current, process.pid, mode, currentStep);
    store.close();
    if (!result.acquired) {
        append("assistant", `Another Evidra controller is active (pid ${result.lease?.pid ?? "unknown"}, step ${result.lease?.currentStep ?? "unknown"}). Use /${result.lease?.mode ?? mode} status or stop that controller before starting another.`);
      return false;
    }
    controllerLeaseHeld.current = true;
    const recoveredStore = new ResearchStore(join(root, ".sota", "database.sqlite"));
    const recoveredExperiments = recoveredStore.recoverStaleExperiments();
    const recoveredTraces = recoverUncommittedTraceFiles(root, recoveredStore);
    recoveredStore.close();
    if (recoveredExperiments.length) append("assistant", `Recovered ${recoveredExperiments.length} experiment(s) left running by a previous controller; they are available for retry.`);
    if (recoveredTraces) append("assistant", `Recovered ${recoveredTraces} partial Codex trace(s) from a previous controller.`);
    if (!controllerHeartbeat.current) controllerHeartbeat.current = setInterval(() => {
      const heartbeatStore = new ResearchStore(join(root, ".sota", "database.sqlite"));
      heartbeatStore.heartbeatControllerLease(controllerLeaseId.current, configRef.current.mode, progressRef.current || "running");
      heartbeatStore.close();
    }, 10_000);
    return true;
  };
  const updateControllerStep = (step: string): void => {
    if (!controllerLeaseHeld.current) return;
    const store = new ResearchStore(join(root, ".sota", "database.sqlite"));
    store.heartbeatControllerLease(controllerLeaseId.current, configRef.current.mode, step);
    store.close();
  };
  const firstToken = input.split(/\s+/)[0];
  const suggestions: readonly (readonly [string, string])[] = input.startsWith("/ ") ? [] : input.startsWith("/model ")
    ? availableModels
      .filter((model) => model.id.toLowerCase().includes(input.slice("/model ".length).toLowerCase()))
      .slice(0, 12)
      .map((model) => [`/model ${model.id}`, `${model.displayName}${model.isDefault ? " · default" : ""}${model.hidden ? " · hidden" : ""}`] as const)
    : input.includes(" ") && SUBCOMMANDS[firstToken]
      ? SUBCOMMANDS[firstToken].filter(([command]) => command.startsWith(input)).slice(0, 8)
      : input.startsWith("/")
        ? COMMANDS.filter(([command]) => command.startsWith(input)).slice(0, 8)
        : [];
  const activeModel = availableModels.find((model) => model.id === config.model) ?? selectedModel;
  const reasoningChoices = activeModel?.supportedReasoningEfforts?.length ? activeModel.supportedReasoningEfforts : REASONING_LEVELS;
  const providerChoices: readonly AgentProvider[] = ["codex", "local"];
  const modeChoices: readonly WorkbenchMode[] = ["research", "challenge"];
  const permissionChoices: readonly AutonomyLevel[] = ["safe", "fast", "yolo"];

  useEffect(() => {
    if (!busy) { setBusyFrame(0); return undefined; }
    const timer = setInterval(() => setBusyFrame((frame) => (frame + 1) % 4), 450);
    return () => clearInterval(timer);
  }, [busy]);

  useEffect(() => {
    // Do not persist the default config while the first-run provider choice is
    // still open. This keeps an escaped/interrupted setup resumable next time.
    if (!onboardingComplete) return;
    saveConfig(configPath, config);
  }, [config, configPath, onboardingComplete]);

  useEffect(() => {
    if (!firstRun) return;
    append("assistant", "Welcome to Evidra. Before the first conversation, choose how the research director should run. Codex uses your ChatGPT subscription; Local uses an Ollama server on this machine.");
    setPicker("provider");
    setPickerIndex(0);
  }, [firstRun]);

  useEffect(() => {
    if (config.campaign) return;
    const store = new ResearchStore(join(root, ".sota", "database.sqlite"));
    const saved = store.campaign();
    if (saved && typeof saved === "object" && "goal" in saved && "budgetMinutes" in saved) {
      const campaign = saved as ResearchCampaign;
      // Only recover a running campaign when its controller lease is absent or stale.
      // A fresh process must never overwrite a live controller's state.
      const liveController = store.liveControllerLease();
      const recovered = campaign.status === "running" && !liveController ? pauseCampaign(campaign) : campaign;
      if (campaign.status === "running" && !liveController) {
        store.saveCampaign(recovered);
        store.setSchedulerState({ status: "paused", mode: "research", currentStep: "recovered-after-process-exit" });
      }
      store.close();
      setConfig((current) => ({ ...current, campaign: recovered }));
    } else {
      store.close();
    }
  }, [config.campaign, root]);

  useEffect(() => {
    messagesRef.current = messages;
    configRef.current = config;
  }, [config, messages]);

  useEffect(() => {
    const store = new ResearchStore(join(root, ".sota", "database.sqlite"));
    store.startSession(sessionId.current, { pid: process.pid, config, messages });
    store.close();
    return () => {
      if (controllerHeartbeat.current) clearInterval(controllerHeartbeat.current);
      if (controllerLeaseHeld.current) {
        const closingLease = new ResearchStore(join(root, ".sota", "database.sqlite"));
        closingLease.releaseControllerLease(controllerLeaseId.current);
        closingLease.close();
      }
      const closing = new ResearchStore(join(root, ".sota", "database.sqlite"));
      closing.saveSession(sessionId.current, { pid: process.pid, config: configRef.current, messages: messagesRef.current });
      closing.closeSession(sessionId.current, "interrupted");
      closing.close();
    };
  }, []);

  useEffect(() => {
    const store = new ResearchStore(join(root, ".sota", "database.sqlite"));
    store.saveSession(sessionId.current, { pid: process.pid, config, messages });
    store.close();
  }, [config, messages, root]);

  useEffect(() => {
    let active = true;
    const loadModels = async (): Promise<void> => {
      setModelLoadError(null);
      try {
        const models = config.provider === "codex" ? await listCodexModels() : await listLocalModels();
        if (active) {
          setAvailableModels(models);
          setSelectedModel(models.find((model) => model.id === config.model) ?? null);
          if (config.provider === "local" && (!models.some((model) => model.id === config.model) || config.model === "unconfigured")) {
            setConfig((current) => ({ ...current, model: models[0]?.id ?? "unconfigured" }));
          }
        }
      } catch {
        if (active) {
          setAvailableModels([]);
          setModelLoadError(config.provider === "codex"
            ? "Codex models are unavailable. Confirm /login status, then try /model again."
            : "Local models are unavailable. Start Ollama, then try /model again.");
          if (config.provider === "local") setConfig((current) => ({ ...current, model: "unconfigured" }));
        }
      }
    };
    void loadModels();
    return () => { active = false; };
  }, [config.provider]);

  useEffect(() => setSuggestionIndex(0), [input]);
  useEffect(() => () => {
    if (loopTimer.current) clearInterval(loopTimer.current);
    if (progressTimer.current) clearTimeout(progressTimer.current);
    terminateActiveProcesses();
  }, []);

  useInput((value, key) => {
    if (key.ctrl && value === "c") {
      if (input) {
        setInput("");
        setInputMount((current) => current + 1);
        return;
      }
      exit();
      return;
    }
    if (!picker && key.escape && busy && activeProcess.current) {
      interruptedProcess.current = true;
      terminateActiveProcesses();
      append("assistant", "Interrupted · stopping the active process and its child workers.");
      setProgress("Interrupted · stopping...");
      return;
    }
    if (picker) {
      const choices = picker === "provider" ? providerChoices : picker === "model" ? availableModels : picker === "reasoning" ? reasoningChoices : picker === "mode" ? modeChoices : permissionChoices;
      if (key.escape) { setPicker(null); return; }
      if (key.downArrow) { setPickerIndex((current) => (current + 1) % choices.length); return; }
      if (key.upArrow) { setPickerIndex((current) => (current - 1 + choices.length) % choices.length); return; }
      if (key.return && choices.length > 0) {
        if (picker === "provider") {
          const provider = providerChoices[pickerIndex];
          activeCodexThread.current = undefined;
          setConfig((current) => ({
            ...current,
            provider,
            codexThreadId: undefined,
            model: provider === "local"
              ? (current.provider === "local" ? current.model : "qwen3.6:27b")
              : (current.provider === "codex" ? current.model : DEFAULT_CODEX_MODEL),
          }));
          setOnboardingComplete(true);
          setPicker(null);
          if (provider === "codex") {
            append("assistant", "Codex selected. Evidra will verify authentication before each model request. Run /login codex if the route is not connected.");
          } else {
            append("assistant", "Local provider selected. Evidra will use Ollama when it is running and has a compatible model. Use /doctor to verify the local setup.");
          }
        } else if (picker === "model") {
          const chosen = availableModels[pickerIndex];
          setSelectedModel(chosen);
          activeCodexThread.current = undefined;
          setConfig((current) => ({ ...current, model: chosen.id, codexThreadId: undefined }));
          append("assistant", `Model selected: ${chosen.displayName} (${chosen.id})`);
          setPicker("reasoning");
          const chosenEfforts = chosen.supportedReasoningEfforts?.length ? chosen.supportedReasoningEfforts : REASONING_LEVELS;
          setPickerIndex(Math.max(0, chosenEfforts.findIndex((effort) => effort === config.reasoningEffort)));
        } else if (picker === "reasoning") {
          const effort = reasoningChoices[pickerIndex];
          setConfig((current) => ({ ...current, reasoningEffort: effort }));
          append("assistant", `Thinking effort selected: ${effort}`);
          setPicker(null);
        } else if (picker === "mode") {
          const mode = modeChoices[pickerIndex];
          setConfig((current) => ({ ...current, mode }));
          append("assistant", `Mode selected: ${mode}`);
          setPicker(null);
        } else {
          const autonomy = permissionChoices[pickerIndex];
          setConfig((current) => ({ ...current, autonomy }));
          append("assistant", `Permissions selected: ${autonomy}`);
          setPicker(null);
        }
      }
      return;
    }
    if (!suggestions.length) return;
    if (key.tab) {
      setInput(suggestions[suggestionIndex][0]);
      setInputMount((current) => current + 1);
      return;
    }
    if (key.return) {
      suppressNextSubmit.current = true;
      const selected = suggestions[suggestionIndex][0];
      setTimeout(() => {
        suppressNextSubmit.current = false;
        void submitRef.current(selected);
      }, 0);
      return;
    }
    if (key.downArrow) {
      setSuggestionIndex((current) => (current + 1) % suggestions.length);
      return;
    }
    if (key.upArrow) {
      setSuggestionIndex((current) => (current - 1 + suggestions.length) % suggestions.length);
    }
  });

  const append = (role: Message["role"], text: string): void => {
    if (!text.trim()) return;
    setMessages((current) => [...current, { role, text }]);
  };
  const appendTool = (text: string): void => {
    if (!text.trim()) return;
    setMessages((current) => [...current, { role: "system", kind: "tool", text }]);
  };
  const appendError = (error: unknown): void => {
    if (interruptedProcess.current) return;
    append("assistant", error instanceof Error ? error.message : String(error));
  };

  const activeAdapter = () => {
    const store = new ResearchStore(join(root, ".sota", "database.sqlite"));
    const project = store.project();
    store.close();
    return loadCompetitionAdapter(root, project?.competitionId ?? "local-research");
  };

  const requireActiveContract = (): void => {
    const adapter = activeAdapter();
    const report = validateCompetitionContract(adapter.config, adapter.workspacePath(root));
    if (!report.valid) throw new Error(`Invalid ${adapter.config.name} contract. Run /contract for details.\n${report.checks.filter((check) => !check.passed).map((check) => `- ${check.name}: ${check.detail}`).join("\n")}`);
  };

  const ensureActiveProject = (): void => {
    const adapter = activeAdapter();
    mkdirSync(join(root, ".sota"), { recursive: true });
    const store = new ResearchStore(join(root, ".sota", "database.sqlite"));
    if (!store.project()) store.createProject({ id: `evidra-${adapter.id}`, name: adapter.config.name, competitionId: adapter.id, config: adapter.config });
    const knownRoles = new Set(store.agentLanes().map((lane) => lane.role));
    for (const role of AGENT_ROLES) if (!knownRoles.has(role)) store.updateAgentLane({ role, status: "idle", provider: config.provider, model: config.model, task: null });
    store.close();
  };

  const ingestCompetitionSources = async (adapter: ReturnType<typeof activeAdapter>): Promise<string[]> => {
    const urls = adapter.config.researchSources ?? [];
    if (!urls.length) return [];
    const store = new ResearchStore(join(root, ".sota", "database.sqlite"));
    const known = new Map<string, { payload: unknown; createdAt: string }>();
    for (const entry of store.sources()) {
      const url = (entry.payload as { url?: string }).url;
      if (url && !known.has(url)) known.set(url, entry);
    }
    const ingested: string[] = [];
    for (const url of urls) {
      const prior = known.get(url);
      if (prior && sourceIsFresh(prior)) continue;
      setProgress(`Challenge research · retrieving ${new URL(url).hostname}...`);
      try {
        const source = await retrieveSource(url);
        const claims = sourceClaims(source.text);
        store.saveSource({ id: source.id, payload: { ...source, claims } });
        for (const [index, statement] of claims.entries()) {
          const claimId = `${source.id}_claim_${index + 1}`;
          store.saveClaim({ id: claimId, payload: { id: claimId, statement, scope: source.url, confidence: 0.35, sourceType: "literature", sourceId: source.id, status: "active" } });
          store.saveEdge({ id: `edge_${claimId}_${source.id}`, fromId: claimId, toId: source.id, relation: "derived_from", confidence: 0.35, evidenceIds: [claimId] });
        }
        store.appendEvent(prior ? "challenge.source.refreshed" : "challenge.source.ingested", { url, title: source.title, claims: claims.length, previousSource: prior ? (prior.payload as { id?: string }).id : undefined });
        ingested.push(source.title);
      } catch (error) {
        store.appendEvent("challenge.source.failed", { url, error: error instanceof Error ? error.message : String(error) });
      }
    }
    store.close();
    return ingested;
  };

  const persistCampaign = (campaign: ResearchCampaign): void => {
    const store = new ResearchStore(join(root, ".sota", "database.sqlite"));
    store.saveCampaign(campaign);
    store.close();
  };

  const persistCampaignCheckpoint = (campaign: ResearchCampaign, step: "research-lanes" | "experiment-execution" | "cycle-complete", cycle: number): void => {
    const updated = withCampaignCheckpoint(campaign, step, cycle);
    Object.assign(campaign, updated);
    persistCampaign(campaign);
    updateControllerStep(step);
    setConfig((current) => ({ ...current, campaign: current.campaign ? { ...current.campaign, ...campaign } : { ...campaign } }));
  };

  const performResearchObservation = async (): Promise<Record<string, unknown>> => {
    const mode = configRef.current.mode;
    setProgress("Research 1/3 · inspecting repository and challenge state...");
    const status = await runProcess(["git", "status", "--short"], root);
    const files = await runProcess(["rg", "--files", "-g", "!.sota/**", "-g", "!node_modules/**"], root, 60_000);
    const observation: Record<string, unknown> = {
      gitStatus: status.stdout.trim().split("\n").filter(Boolean).slice(0, 40),
      repositoryFiles: files.stdout.trim().split("\n").filter(Boolean).slice(0, 120),
    };
    if (mode === "challenge") {
      const adapter = activeAdapter();
      requireActiveContract();
      await ingestCompetitionSources(adapter);
      const state = new ResearchStore(join(root, ".sota", "database.sqlite"));
      const priorBaseline = state.recentEvents(1000).reverse().find((event) => event.type === "baseline.completed");
      state.close();
      let baseline: { command: string[]; cwd: string; exitCode: number; durationMs: number; stdout: string; stderr: string };
      if (priorBaseline) {
        const payload = priorBaseline.payload as { command?: string[]; cwd?: string; exitCode?: number; durationMs?: number; stdout?: string; stderr?: string };
        baseline = { command: payload.command ?? adapter.baselineCommand(), cwd: payload.cwd ?? adapter.workspacePath(root), exitCode: payload.exitCode ?? 0, durationMs: payload.durationMs ?? 0, stdout: payload.stdout ?? "", stderr: payload.stderr ?? "" };
        setProgress("Research 2/3 · reusing the latest verified baseline...");
      } else {
        setProgress("Research 2/3 · running the canonical baseline evaluator...");
        baseline = await runProcess(
          adapter.baselineCommand(),
          adapter.workspacePath(root),
          adapter.config.evaluatorTimeoutMinutes * 60_000,
          (stream, chunk) => {
            const line = chunk.replace(/\s+/g, " ").trim();
            if (line) setProgress(`Research 2/3 · ${stream}: ${line.slice(-120)}`);
          },
          registerProcess,
        );
        activeProcess.current = null;
        const baselineStore = new ResearchStore(join(root, ".sota", "database.sqlite"));
        const parsed = parseMetricOutput(baseline.stdout, adapter.config.metric.name);
        const metric = parsed.metrics[adapter.config.metric.name] ?? null;
        recordBaselineEvidence(baselineStore, root, baseline, metric, parsed.metrics, parsed.metricsByFold);
        baselineStore.close();
      }
      if (priorBaseline && typeof (priorBaseline.payload as { metric?: unknown }).metric !== "number") {
        const metric = parseMetricOutput(baseline.stdout, adapter.config.metric.name).metrics[adapter.config.metric.name] ?? null;
        const upgradedBaseline = new ResearchStore(join(root, ".sota", "database.sqlite"));
        upgradedBaseline.appendEvent("baseline.completed", { ...(priorBaseline.payload as Record<string, unknown>), metric, upgradedFromLegacyEvent: true });
        upgradedBaseline.close();
      }
      observation.baseline = { exitCode: baseline.exitCode, durationMs: baseline.durationMs, stdout: redactSecrets(baseline.stdout.slice(-4000)), stderr: redactSecrets(baseline.stderr.slice(-4000)) };
    }
    const evidenceStore = new ResearchStore(join(root, ".sota", "database.sqlite"));
    evidenceStore.appendEvent("research.observation", observation);
    evidenceStore.saveClaim({
      id: `claim_observation_${Date.now()}`,
      payload: {
        statement: `Repository inspection and ${mode === "challenge" ? "canonical baseline execution" : "workspace inspection"} completed before the research decision.`,
        scope: "current-workspace",
        confidence: 1,
        sourceType: "observation",
        sourceId: `observation_${Date.now()}`,
        status: "active",
        observation,
      },
    });
    evidenceStore.close();
    return observation;
  };

  const runResearchCycle = async (objective: string, campaign?: ResearchCampaign): Promise<{ text: string; goalStatus: "active" | "blocked" | "met"; decision: "inspect" | "propose" | "run" | "replicate" | "stop" }> => {
    const requestedConfig = configRef.current;
    const startupRoute = await resolveStartupProvider({ provider: requestedConfig.provider, model: requestedConfig.model, cwd: root, limitPolicy: requestedConfig.limitPolicy }, requestedConfig.fallbackModel);
    const config = startupRoute.fallback
      ? { ...requestedConfig, provider: startupRoute.provider, model: startupRoute.model }
      : requestedConfig;
    if (startupRoute.fallback) {
      configRef.current = config;
      setConfig(config);
      setProgress(`Codex unavailable · continuing with local/${startupRoute.model}...`);
    }
    const mode = configRef.current.mode;
    const observation = await performResearchObservation();
    setProgress("Research 3/3 · asking the director to analyze observed evidence and select the next experiment...");
    const store = new ResearchStore(join(root, ".sota", "database.sqlite"));
    const project = store.project();
    const goalSet = phaseGoalSetId(objective, mode);
    const persistedGoals = store.phaseGoals().map((entry) => PhaseGoalSchema.parse(entry.payload));
    if (!phaseGoalsForMode(persistedGoals, mode, goalSet).length) {
      for (const goal of definePhaseGoals(objective, mode)) store.savePhaseGoal({ id: goal.id, phase: goal.phase, status: goal.status, payload: goal });
    }
    const phaseGoal = activePhaseGoal(phaseGoalsForMode(store.phaseGoals().map((entry) => PhaseGoalSchema.parse(entry.payload)), mode, goalSet));
    const recentEvents = store.recentEvents(20);
    const consistencyEvents = store.recentEvents(200);
    const evidenceConflicts = {
      contradictions: store.edges().filter((edge) => edge.relation === "contradicts").length,
      duplicates: consistencyEvents.filter((event) => event.type === "evidence.claim.duplicate_detected").length,
    };
    const researchMemory = researchMemoryContext(store, 30, objective);
    store.appendEvent("research.memory.retrieved", { ...researchMemory.retrieval, context: "tui-research" });
    const harnessChangeHistory = store.harnessChanges().slice(-8).map((change) => ({
      id: change.id,
      protocolFingerprint: change.protocolFingerprint,
      decision: change.decision,
      contract: change.contract,
      outcomes: change.outcomes,
      changedComponents: change.candidateComponents.filter((candidate) => change.baselineComponents.find((baseline) => baseline.path === candidate.path && baseline.checksum !== candidate.checksum)),
    }));
    const peerLaneBoard = boundedPeerBoard(recentEvents);
    const recentTrajectories = store.trajectories(50);
    const latestTrajectoryAt = recentTrajectories[0]?.createdAt;
    const unreconciledTraceRecovery = store.eventsByType("research.trace.recovered", 20).some((event) => !latestTrajectoryAt || event.createdAt > latestTrajectoryAt);
    const recentFailureCount = recentTrajectories.filter((entry) => (entry.quality as { overall?: string }).overall === "FAIL").length;
    const recentQuality = recentTrajectories.slice(0, 20).map((entry) => qualityFeedback(entry.quality));
    const failureClasses = [
      ...store.runs().slice(0, 20).map((entry) => (entry.payload as { failureClass?: unknown }).failureClass).filter((value): value is string => typeof value === "string"),
      ...recentTrajectories.flatMap((entry) => {
        const payload = entry.payload && typeof entry.payload === "object" ? entry.payload as { events?: unknown } : {};
        if (!Array.isArray(payload.events)) return [];
        return payload.events.flatMap((event) => {
          if (!event || typeof event !== "object") return [];
          const eventPayload = (event as { payload?: unknown }).payload;
          if (!eventPayload || typeof eventPayload !== "object") return [];
          const value = eventPayload as { providerActivity?: unknown; activity?: unknown };
          if (value.providerActivity !== true || typeof value.activity !== "string") return [];
          const failure = providerActivityFailureClass(value.activity);
          return failure ? [failure] : [];
        });
      }),
      ...(unreconciledTraceRecovery ? ["controller_crash"] : []),
    ];
    const campaignRemaining = campaign ? Math.max(0, campaign.budgetMinutes - campaignElapsedMinutes(campaign)) : undefined;
    const route = routeCapability({ objective, mode, provider: config.provider, model: config.model, autonomy: config.autonomy, recentFailureCount, failureClasses, recentQuality, recentOutcomes: store.recentEvents(500).filter((event) => event.type === "research.capability_outcome").slice(-12).map((event) => {
      const payload = event.payload as { mode?: unknown; servedProvider?: unknown; servedModel?: unknown; outcome?: unknown; quality?: unknown };
      return { mode: typeof payload.mode === "string" ? payload.mode : undefined, provider: typeof payload.servedProvider === "string" ? payload.servedProvider : undefined, model: typeof payload.servedModel === "string" ? payload.servedModel : undefined, outcome: typeof payload.outcome === "string" ? payload.outcome : undefined, quality: typeof payload.quality === "string" ? payload.quality : undefined };
    }), budgetRemainingMinutes: campaignRemaining, requestedParallel: 3 });
    store.appendEvent("research.capability_route", { route, objective, recentFailureCount, recentQuality, predictedTier: route.tier, servedProvider: config.provider, servedModel: config.model });
    const forecastAssessments = store.eventsByType("research.forecast.assessed")
      .slice(-24)
      .map((event) => event.payload && typeof event.payload === "object" ? (event.payload as { forecast?: { covered?: unknown; calibration?: unknown; normalizedError?: unknown } }).forecast : undefined)
      .filter((forecast): forecast is { covered: boolean; calibration: "underestimated" | "overestimated" | "calibrated"; normalizedError: number } => {
        if (!forecast || typeof forecast.covered !== "boolean" || typeof forecast.calibration !== "string" || typeof forecast.normalizedError !== "number") return false;
        return Number.isFinite(forecast.normalizedError) && ["underestimated", "overestimated", "calibrated"].includes(forecast.calibration);
      });
    const forecastCalibration = summarizeForecastAssessments(forecastAssessments);
    const allocation = allocateNextResearch({ trajectories: store.trajectories(20), phase: phaseGoal?.phase, evidenceConflicts, failureClasses, forecastCalibration });
    store.appendEvent("research.next_allocation", { allocation, objective });
    const adaptiveHarness = deriveAdaptiveHarnessPolicy({
      phase: phaseGoal?.phase,
      quality: recentQuality as Array<{ overall?: string; toolUse?: { verdict?: string }; evidenceConsistency?: { verdict?: string }; errorRecovery?: { verdict?: string }; termination?: { verdict?: string } }>,
      failureClasses,
      evidenceConflicts: evidenceConflicts.contradictions + evidenceConflicts.duplicates,
      budgetRemainingMinutes: campaignRemaining,
      allocationFocus: allocation.focus,
      allocationPriority: allocation.priority,
    });
    store.appendEvent("research.adaptive_harness.policy", { policy: adaptiveHarness, objective });
    const experienceRecords = recentTrajectories.map((entry) => buildExperienceRecord({ trajectoryId: entry.id, payload: entry.payload, quality: entry.quality as ReturnType<typeof evaluateTrajectory> }));
    const experienceMix = selectCurriculum(experienceRecords);
    const curriculumGuidance = experienceMix.map((stage) => `stage ${stage.stage}: ${stage.trajectoryIds.join(", ") || "none"} (${stage.rationale})`).join("; ");
    const researchSources = latestSourceEntries(store.sources(), 12, objective, store).map((entry) => {
      const payload = entry.payload as { title?: string; url?: string; excerpt?: string; claims?: string[]; qualityScore?: number; evidenceClass?: string };
      return { id: entry.id, title: payload.title, url: payload.url, excerpt: payload.excerpt, claims: payload.claims?.slice(0, 8), qualityScore: payload.qualityScore, evidenceClass: payload.evidenceClass };
    });
    store.close();
    const laneStore = new ResearchStore(join(root, ".sota", "database.sqlite"));
    laneStore.updateAgentLane({ role: "research director", status: "running", provider: config.provider, model: config.model, task: objective });
    laneStore.close();
    const adapter = activeAdapter();
    let decision: Awaited<ReturnType<typeof runResearchDirector>>;
    let laneReports: ResearchLaneReport[] = [];
    let crossPollination: ReturnType<typeof synthesizeLaneReports> | undefined;
    let criticReview: ResearchReview | undefined;
    let semanticAudit: ResearchSemanticAudit | undefined;
    const tracePrefix = `research-${Date.now()}`;
    const tracePath = join(root, ".sota", "traces", `${tracePrefix}.jsonl`);
    mkdirSync(dirname(tracePath), { recursive: true });
    const toolTrace = createToolTraceRecorder(tracePrefix, { onEvent: (event) => {
      try { appendFileSync(tracePath, `${JSON.stringify(event)}\n`, "utf8"); } catch { /* Partial trace persistence is best-effort. */ }
    } });
    const recordAgentUsage = (usage: { inputTokens?: number; outputTokens?: number; cachedInputTokens?: number; cacheWriteInputTokens?: number; reasoningOutputTokens?: number } | undefined, provider: string, model: string, role: string): void => {
      const usageStore = new ResearchStore(join(root, ".sota", "database.sqlite"));
      usageStore.appendEvent("research.agent.usage", { role, provider, model, inputTokens: usage?.inputTokens, outputTokens: usage?.outputTokens, cachedInputTokens: usage?.cachedInputTokens, cacheWriteInputTokens: usage?.cacheWriteInputTokens, reasoningOutputTokens: usage?.reasoningOutputTokens });
      usageStore.close();
    };
    try {
      activeSteer.current = null;
      setProgress(`Research 3/4 · route ${route.tier} · ${route.reasoningEffort} reasoning · investigating...`);
      const allocatedObjective = `${objective}\n\nEvidra capability allocation for this cycle:\nFocus: ${allocation.focus}\nPriority: ${allocation.priority}\nStrategy: ${allocation.strategy}\nReasons: ${allocation.reasons.join("; ")}\n\nEvidra experience curriculum guidance:\n${curriculumGuidance || "No prior experience; establish a clean baseline."}`;
      const researchModelPool = config.provider === "codex" && route.parallelLanes > 1
        ? await listCodexModels().then((models) => codexResearchModelPool(config.model, models, Math.min(4, route.parallelLanes), config.reasoningEffort)).catch(() => [{ provider: "codex" as const, model: config.model }])
        : config.provider === "local"
          ? await listLocalModels().then((models) => models.length ? models.map((model) => ({ provider: "local" as const, model: model.id })) : [{ provider: "local" as const, model: config.model }]).catch(() => [{ provider: "local" as const, model: config.model }])
          : [{ provider: "codex" as const, model: config.model }];
      laneReports = await runResearchLanes(allocatedObjective, {
        mode,
        project,
        observation,
        recentEvents,
        researchSources,
        ultimateGoal: objective,
        allocation,
        evidenceConflicts,
        researchMemory,
        peerLaneBoard,
      }, {
        provider: config.provider,
        model: config.model,
        modelPool: researchModelPool,
        fallbackLocalModel: config.fallbackModel,
        limitPolicy: config.limitPolicy,
        reasoningEffort: config.reasoningEffort,
        cwd: root,
        storePath: join(root, ".sota", "database.sqlite"),
        maxParallel: route.parallelLanes,
        autonomy: config.autonomy,
        onProgress: setProgress,
        onProcess: registerProcess,
        isCancelled: () => interruptedProcess.current,
        executeTool: (call) => executeResearchTool(call, {
          root,
          storePath: join(root, ".sota", "database.sqlite"),
          autonomy: config.autonomy,
          competition: adapter.config,
          onProgress: setProgress,
          onProcess: registerProcess,
        }),
        onToolCall: toolTrace.onToolCall,
        onToolResult: toolTrace.onToolResult,
        onActivity: toolTrace.onActivity,
        onAssistant: toolTrace.onAssistant,
        onUsage: recordAgentUsage,
      });
      if (interruptedProcess.current) throw new Error("Interrupted · stopping the active research cycle.");
      setProgress("Research 4/4 · director is cross-pollinating lane findings...");
      crossPollination = synthesizeLaneReports(laneReports);
      // Keep the TUI on the same bounded collaboration protocol as the CLI:
      // fast/YOLO campaigns can send a fresh lane set over contested findings
      // before director synthesis. Safe mode remains single-pass inspection.
      const completedLaneCount = laneReports.filter((lane) => lane.status === "completed").length;
      const shouldPeerReview = config.autonomy !== "safe" && completedLaneCount > 1 && (adaptiveHarness.peerReview || crossPollination.needsAdversarialReview);
      if (shouldPeerReview) {
        setProgress("Research · evidence is contested; independent lanes are peer-reviewing the board...");
        const initialLaneReports = laneReports;
        const peerReports = await runResearchLanes(
          `${allocatedObjective}\n\nPeer-review the supplied lane board. Challenge unsupported agreements, resolve tensions where primary evidence permits, and identify the cheapest discriminating test. Do not repeat workspace inspection unless the board exposes a specific evidence gap.`,
          {
            mode,
            project,
            observation,
            recentEvents,
            researchSources,
            ultimateGoal: objective,
            phaseGoal: phaseGoal ?? null,
            allocation,
            evidenceConflicts,
            researchMemory,
            peerLaneBoard: crossPollination,
            priorLaneReports: initialLaneReports.map((lane) => ({ role: lane.role, summary: lane.summary, findings: lane.findings, uncertainties: lane.uncertainties, evidence: lane.evidence })),
          },
          {
            provider: config.provider,
            model: config.model,
            modelPool: researchModelPool,
            fallbackLocalModel: config.fallbackModel,
            limitPolicy: config.limitPolicy,
            reasoningEffort: config.reasoningEffort,
            cwd: root,
            storePath: join(root, ".sota", "database.sqlite"),
            maxParallel: route.parallelLanes,
            autonomy: config.autonomy,
            laneFocus: "evidence-validation",
            laneRotation: (campaign?.currentCycle ?? 0) + 1,
            onProgress: setProgress,
            onProcess: registerProcess,
            isCancelled: () => interruptedProcess.current,
            onActivity: toolTrace.onActivity,
            onAssistant: toolTrace.onAssistant,
            onUsage: recordAgentUsage,
          },
        );
        laneReports = [...initialLaneReports, ...peerReports.map((lane) => ({ ...lane, role: `${lane.role} peer-review` }))];
        crossPollination = synthesizeLaneReports(laneReports);
        const peerStore = new ResearchStore(join(root, ".sota", "database.sqlite"));
        peerStore.appendEvent("research.peer_review.completed", { initialBoard: synthesizeLaneReports(initialLaneReports), board: crossPollination, reviewers: peerReports.map((lane) => lane.role) });
        peerStore.close();
      }
      decision = await runResearchDirector(allocatedObjective, {
        mode,
        project,
        competition: adapter.config,
        recentEvents,
        observation,
        researchSources,
        ultimateGoal: objective,
        phaseGoal: phaseGoal ?? null,
        allocation,
        evidenceConflicts,
        researchMemory,
        laneReports,
        crossPollination,
        adaptiveHarnessPolicy: adaptiveHarness,
        harnessChangeHistory,
        constraints: { no_submission: true, no_file_edits: true },
      }, {
        provider: config.provider,
        model: config.model,
        modelPool: researchModelPool,
        reasoningEffort: route.reasoningEffort === "high" ? config.reasoningEffort : route.reasoningEffort,
        limitPolicy: config.limitPolicy,
        cwd: root,
        fallbackLocalModel: config.fallbackModel,
        maxToolRounds: adaptiveHarness.maxToolRounds,
        maxToolAttempts: adaptiveHarness.maxToolAttempts,
        onProcess: registerProcess,
        onThread: (threadId) => { activeSteer.current = (message) => queueCodexMessage(threadId, message); },
        executeTool: (call) => executeResearchTool(call, {
          root,
          storePath: join(root, ".sota", "database.sqlite"),
          autonomy: config.autonomy,
          competition: adapter.config,
          onProgress: setProgress,
          onProcess: registerProcess,
        }),
        onToolCall: toolTrace.onToolCall,
        onToolResult: toolTrace.onToolResult,
        onActivity: toolTrace.onActivity,
        onAssistant: toolTrace.onAssistant,
        onUsage: recordAgentUsage,
      }, setProgress);
      if (interruptedProcess.current) throw new Error("Interrupted · stopping the active research cycle.");
      criticReview = await runResearchCritic(objective, decision, laneReports, {
        provider: config.provider,
        model: config.model,
        modelPool: researchModelPool,
        fallbackLocalModel: config.fallbackModel,
        limitPolicy: config.limitPolicy,
        reasoningEffort: config.reasoningEffort,
        cwd: root,
        storePath: join(root, ".sota", "database.sqlite"),
        maxParallel: 1,
        autonomy: config.autonomy,
        executeTool: (call) => executeResearchTool(call, {
          root,
          storePath: join(root, ".sota", "database.sqlite"),
          autonomy: config.autonomy,
          competition: adapter.config,
          onProgress: setProgress,
          onProcess: registerProcess,
        }),
        onProcess: registerProcess,
        isCancelled: () => interruptedProcess.current,
        onProgress: setProgress,
        onActivity: toolTrace.onActivity,
        onAssistant: toolTrace.onAssistant,
        onUsage: recordAgentUsage,
      });
      semanticAudit = await runResearchSemanticAuditor(objective, decision, {
        observation,
        phaseGoal,
        laneReports: laneReports.map((lane) => ({ role: lane.role, summary: lane.summary, findings: lane.findings, uncertainties: lane.uncertainties, evidence: lane.evidence })),
        critic: criticReview,
      }, {
        provider: config.provider,
        model: config.model,
        modelPool: researchModelPool,
        fallbackLocalModel: config.fallbackModel,
        limitPolicy: config.limitPolicy,
        reasoningEffort: config.reasoningEffort,
        cwd: root,
        storePath: join(root, ".sota", "database.sqlite"),
        maxParallel: 1,
        autonomy: config.autonomy,
        executeTool: (call) => executeResearchTool(call, {
          root,
          storePath: join(root, ".sota", "database.sqlite"),
          autonomy: config.autonomy,
          competition: adapter.config,
          onProgress: setProgress,
          onProcess: registerProcess,
        }),
        onProcess: registerProcess,
        isCancelled: () => interruptedProcess.current,
        onProgress: setProgress,
        onActivity: toolTrace.onActivity,
        onAssistant: toolTrace.onAssistant,
        onUsage: recordAgentUsage,
      }, phaseGoal?.completionCriteria.map((description, index) => ({ id: `criterion_${index + 1}`, description })) ?? []);
      if (semanticAudit.verdict !== "pass") {
        decision = { ...decision, decision: "inspect", goalStatus: "active", nextAction: `${decision.nextAction} (semantic audit: ${[...semanticAudit.findings, ...semanticAudit.requiredChecks].join(", ")})` };
        const auditStore = new ResearchStore(join(root, ".sota", "database.sqlite"));
        auditStore.appendEvent("research.semantic_audit.gated", { verdict: semanticAudit.verdict, findings: semanticAudit.findings, requiredChecks: semanticAudit.requiredChecks });
        auditStore.close();
      }
      activeProcess.current = null;
      activeSteer.current = null;
      const completedLane = new ResearchStore(join(root, ".sota", "database.sqlite"));
      completedLane.updateAgentLane({ role: "research director", status: "idle", provider: config.provider, model: config.model, task: null });
      completedLane.close();
    } catch (error) {
      const failedLane = new ResearchStore(join(root, ".sota", "database.sqlite"));
      failedLane.updateAgentLane({ role: "research director", status: "failed", provider: config.provider, model: config.model, task: objective, error: error instanceof Error ? error.message : String(error) });
      failedLane.close();
      throw error;
    }
    const criticGate = applyCriticGate(decision, criticReview);
    const criticBlocks = criticGate.blocked;
    if (criticBlocks) {
      decision = criticGate.decision;
      const criticGateStore = new ResearchStore(join(root, ".sota", "database.sqlite"));
      criticGateStore.appendEvent("research.critic.gate", { verdict: criticReview?.verdict, confidence: criticReview?.confidence, objections: criticReview?.objections, requiredChecks: criticReview?.requiredChecks });
      criticGateStore.close();
    }
    decision = enforceGoalTermination(decision, { currentPhase: phaseGoal?.phase });
    const decisionStore = new ResearchStore(join(root, ".sota", "database.sqlite"));
    const claimAudit = auditEvidenceStore(decisionStore);
    const claimGateBefore = decision;
    decision = enforceClaimTermination(decision, claimAudit);
    if (decision !== claimGateBefore) decisionStore.appendEvent("research.claim_gate.rejected", { ...claimAudit, source: "tui", phase: phaseGoal?.phase ?? null });
    const decisionRubric = assessResearchDecisionRubric(decision, {
      baselineAvailable: Boolean((observation as { baseline?: { exitCode?: unknown } }).baseline?.exitCode === 0),
      sourceCount: researchSources.length,
      sourceQuality: researchSources.length
        ? researchSources.reduce((sum, source) => sum + (typeof source.qualityScore === "number" && Number.isFinite(source.qualityScore) ? source.qualityScore : 0), 0) / researchSources.length
        : 0,
      sourceClaimCoverage: researchSources.length
        ? researchSources.filter((source) => Array.isArray(source.claims) && source.claims.length > 0).length / researchSources.length
        : 0,
      sourceDiversity: Math.min(1, new Set(researchSources.map((source) => source.evidenceClass).filter((value): value is string => Boolean(value))).size / 3),
      evidenceConflicts: evidenceConflicts.contradictions + evidenceConflicts.duplicates,
    });
    decisionStore.appendEvent("research.rubric.assessed", {
      score: decisionRubric.score,
      threshold: decisionRubric.threshold,
      verdict: decisionRubric.verdict,
      criteria: decisionRubric.criteria,
      gaps: decisionRubric.gaps,
      source: "tui",
    });
    const phaseEvents = phaseGoal ? phaseGoalEventsSince(phaseGoal, decisionStore.eventsByTypes([...PHASE_GOAL_EVENT_TYPES])) : [];
    const phaseEvidence = phaseGoal ? {
      mode,
      eventTypes: phaseEvents.map((event) => event.type),
      eventPayloads: phaseEvents.map((event) => ({ type: event.type, payload: event.payload })),
      ...decisionStore.counts(),
      hypotheses: phaseGoalRecordsSince(phaseGoal, decisionStore.hypotheses()),
      experiments: phaseGoalRecordsSince(phaseGoal, decisionStore.experiments()),
      runs: phaseGoalRecordsSince(phaseGoal, decisionStore.runs()),
      artifacts: phaseGoalRecordsSince(phaseGoal, decisionStore.artifacts()),
      candidateHypotheses: decision.hypotheses.length,
      falsifiableHypotheses: decision.hypotheses.filter((hypothesis) => hypothesis.falsificationTest.trim().length > 0).length,
      selectedHypothesisFalsifiable: Boolean(decision.selectedHypothesis && decision.hypotheses.some((hypothesis) => hypothesis.title === decision.selectedHypothesis && hypothesis.falsificationTest.trim().length > 0)),
    } : undefined;
    const phaseGate = phaseGoal && decision.goalStatus === "met" && phaseEvidence
      ? evaluatePhaseGoalEvidence(phaseGoal, phaseEvidence)
      : { met: decision.goalStatus === "met", missing: [] };
    if (phaseGoal && phaseEvidence) {
      const audit = auditPhaseGoalGate(phaseGoal, phaseGate, phaseEvidence.eventTypes);
      decisionStore.recordSubtaskAudit(audit);
      if (decision.goalStatus === "met" && semanticAudit) decisionStore.recordSubtaskAudit(mergePhaseGoalAudits(phaseGoal, audit, semanticAudit.criteria));
    }
    const effectiveDecision = decision.goalStatus === "met" && !phaseGate.met
      ? { ...decision, goalStatus: "active" as const, nextAction: decision.nextAction + " (phase gate missing: " + phaseGate.missing.join(", ") + ")" }
      : decision;
    if (decision.goalStatus === "met" && !phaseGate.met) decisionStore.appendEvent("research.phase_gate.rejected", { phase: phaseGoal?.phase, missing: phaseGate.missing });
    const decisionAudit = auditResearchDecision(effectiveDecision, {
      currentPhase: phaseGoal?.phase,
      durableEventTypes: new Set(decisionStore.eventsByTypes(PHASE_GOAL_EVENT_TYPES as unknown as string[]).map((event) => event.type)),
      phaseAuditComplete: phaseGoal ? decisionStore.latestSubtaskAudit(phaseGoal.id)?.complete : undefined,
    });
    decisionStore.appendEvent("research.decision.audit", { ...decisionAudit, phase: phaseGoal?.phase ?? null, decision: effectiveDecision.decision });
    decision = downgradeUnauditedDecision(effectiveDecision, decisionAudit);
    materializeResearchDecision(decisionStore, decision);
    if (phaseGoal) {
      const now = new Date().toISOString();
      const durableAudit = decisionStore.latestSubtaskAudit(phaseGoal.id);
      const auditedMet = decision.goalStatus === "met" && durableAudit?.complete === true;
      const nextStatus = auditedMet ? "met" : decision.goalStatus === "blocked" ? "blocked" : "active";
      decisionStore.savePhaseGoal({ id: phaseGoal.id, phase: phaseGoal.phase, status: nextStatus, payload: { ...phaseGoal, status: nextStatus, attempts: phaseGoal.attempts + 1, updatedAt: now } });
    }
    if (phaseGoal && decision.goalStatus === "met" && decisionStore.latestSubtaskAudit(phaseGoal.id)?.complete === true) {
      const goals = phaseGoalsForMode(decisionStore.phaseGoals().map((entry) => PhaseGoalSchema.parse(entry.payload)), mode, goalSet);
      const index = goals.findIndex((goal) => goal.id === phaseGoal.id);
      const now = new Date().toISOString();
      if (index >= 0) {
        decisionStore.savePhaseGoal({ id: phaseGoal.id, phase: phaseGoal.phase, status: "met", payload: { ...goals[index], status: "met", updatedAt: now } });
        const next = goals[index + 1];
        if (next) decisionStore.savePhaseGoal({ id: next.id, phase: next.phase, status: "active", payload: { ...next, status: "active", updatedAt: now } });
      }
    }
    decisionStore.close();
    const researchTrajectoryEvents: TrajectoryEvent[] = [
      { id: `research-${Date.now()}-observation`, kind: "process", payload: { status: "completed", observationKeys: Object.keys(observation) } },
      ...toolTrace.events,
      ...(crossPollination ? [{ id: `research-${Date.now()}-cross-pollination`, kind: "process" as const, payload: { status: "completed", laneCount: crossPollination.laneCount, completedCount: crossPollination.completedCount, agreementPairs: crossPollination.agreementPairs, independentEvidenceCount: crossPollination.independentEvidenceCount, needsAdversarialReview: crossPollination.needsAdversarialReview } }] : []),
      ...laneReports.filter((lane) => lane.status === "failed").map((lane, index) => ({ id: `research-${Date.now()}-lane-${index}`, kind: "process" as const, payload: { status: "failed", error: lane.error ?? `${lane.role} failed` } })),
      { id: `research-${Date.now()}-evaluator`, kind: "evaluator", payload: { evidenceConsistent: criticReview?.verdict === "proceed", criticVerdict: criticReview?.verdict ?? "missing" } },
      { id: `research-${Date.now()}-terminal`, kind: "terminal", payload: { status: "completed", goalStatus: decision.goalStatus, goalAttained: decision.goalStatus === "met" || decision.decision === "stop" } },
    ];
    const researchQuality = evaluateTrajectory(researchTrajectoryEvents);
    const routingOutcome = capabilityOutcome({ objective, mode, route, provider: config.provider, model: config.model, quality: researchQuality, parallelLanes: laneReports.length });
    const trajectoryStore = new ResearchStore(join(root, ".sota", "database.sqlite"));
    const trajectoryId = `trajectory_research_${Date.now()}`;
    const trajectoryPayload = { objective, observation, laneReports, crossPollination, criticReview, semanticAudit, decision, tracePath: relative(root, tracePath), routing: { predictedTier: route.tier, tierScores: route.tierScores, provider: config.provider, model: config.model }, events: researchTrajectoryEvents };
    trajectoryStore.saveTrajectory({ id: trajectoryId, payload: trajectoryPayload, quality: researchQuality });
    const experience = buildExperienceRecord({ trajectoryId, payload: trajectoryPayload, quality: researchQuality, routing: { predictedTier: route.tier, tierScores: route.tierScores, provider: config.provider, model: config.model } });
    const priorExperiences = trajectoryStore.trajectories(100).filter((entry) => entry.id !== trajectoryId).map((entry) => buildExperienceRecord({ trajectoryId: entry.id, payload: entry.payload, quality: entry.quality as ReturnType<typeof evaluateTrajectory> }));
    trajectoryStore.appendEvent("research.experience.recorded", { experience, capabilityProfile: capabilityProfile([...priorExperiences, experience]), curriculum: selectCurriculum([...priorExperiences, experience]) });
    const researchGaps = Object.entries(researchQuality).filter(([key, value]) => key !== "overall" && (value as { verdict: string }).verdict !== "PASS").map(([key]) => key);
    trajectoryStore.appendEvent("research.capability_outcome", { ...routingOutcome, objective, predictedTier: route.tier, servedProvider: config.provider, servedModel: config.model, lanes: laneReports.map((lane) => ({ role: lane.role, provider: lane.provider, model: lane.model, status: lane.status })), quality: researchQuality.overall, gaps: researchGaps, laneCount: laneReports.length });
    if (researchQuality.overall !== "PASS") trajectoryStore.appendEvent("trajectory.capability_gaps", { trajectoryType: "research", quality: researchQuality, objective });
    trajectoryStore.close();
    const reviewText = criticReview ? `\n\nCritic: ${criticReview.verdict} · confidence ${criticReview.confidence.toFixed(2)}\n${criticReview.summary}${criticReview.objections.length ? `\nObjections:\n${criticReview.objections.map((item) => `- ${item}`).join("\n")}` : ""}${criticReview.requiredChecks.length ? `\nRequired checks:\n${criticReview.requiredChecks.map((item) => `- ${item}`).join("\n")}` : ""}` : "";
    return { text: formatResearchDecision(effectiveDecision) + reviewText, goalStatus: effectiveDecision.goalStatus, decision: effectiveDecision.decision };
  };

  const proposeLatestExperiment = async (): Promise<{ id: string; text: string } | null> => {
    const adapter = activeAdapter();
    const store = new ResearchStore(join(root, ".sota", "database.sqlite"));
    const experiments = store.experiments();
    const pending = experiments.find((experiment) => String((experiment.payload as { status?: string }).status) === "proposed");
    if (pending) {
      store.close();
      return { id: pending.id, text: `\n\nExisting experiment proposal awaiting approval: ${pending.id}\nNext: /experiment run ${pending.id}` };
    }
    const inFlightOrExhausted = new Set(experiments
      .filter((experiment) => ["proposed", "scheduled", "running", "completed", "failed", "rejected", "invalid"].includes(String((experiment.payload as { status?: string }).status)))
      .map((experiment) => String((experiment.payload as { hypothesisId?: string }).hypothesisId ?? "")));
    const candidates = store.hypotheses().filter((candidate) => !inFlightOrExhausted.has(candidate.id));
    const candidateInputs = candidates.map((candidate) => {
      const payload = candidate.payload as {
        expectedMetricDelta?: { median?: number };
        title?: string;
        mechanism?: string;
        computeCostGpuHours?: number;
        implementationRisk?: "low" | "medium" | "high";
        leakageRisk?: "low" | "medium" | "high";
        informationValue?: number;
        diversityValue?: number;
      };
      const implementationRisk = payload.implementationRisk === "high" ? 1 : payload.implementationRisk === "medium" ? 0.5 : 0.1;
      const leakageRisk = payload.leakageRisk === "high" ? 1 : payload.leakageRisk === "medium" ? 0.5 : 0.1;
      return {
        id: candidate.id,
        title: String(payload.title ?? candidate.id),
        mechanism: typeof payload.mechanism === "string" ? payload.mechanism : "",
        hypothesis: candidate,
        probabilityOfSuccess: payload.implementationRisk === "high" ? 0.35 : payload.implementationRisk === "medium" ? 0.6 : 0.8,
        expectedDelta: payload.expectedMetricDelta?.median ?? 0,
        informationValue: payload.informationValue ?? 0.5,
        diversityValue: payload.diversityValue ?? 0,
        gpuCost: payload.computeCostGpuHours ?? 1,
        llmCost: 1,
        engineeringCost: implementationRisk,
        risk: leakageRisk,
      };
    });
    const priorDirections = experiments.map((experiment) => {
      const hypothesisId = String((experiment.payload as { hypothesisId?: unknown }).hypothesisId ?? "");
      const prior = store.hypotheses().find((candidate) => candidate.id === hypothesisId);
      const payload = prior?.payload as { title?: unknown; mechanism?: unknown } | undefined;
      return { title: typeof payload?.title === "string" ? payload.title : hypothesisId, mechanism: typeof payload?.mechanism === "string" ? payload.mechanism : "" };
    });
    const ranked = rankExperimentCandidates(candidateInputs, priorDirections);
    const hypothesis = ranked[0]?.hypothesis;
    if (!hypothesis) { store.close(); return null; }
    const commit = await runProcess(["git", "rev-parse", "HEAD"], root);
    if (commit.exitCode !== 0) { store.close(); throw new Error(`Cannot create manifest: ${commit.stderr || commit.stdout}`); }
    const id = `exp_${Date.now()}_${hypothesis.id.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 32)}`;
    const manifest = createExperimentManifest({ id, hypothesisId: hypothesis.id, outcomeType: (hypothesis.payload as { outcomeType?: "metric" | "artifact" | "proof" | "behavior" | "system" | "other" }).outcomeType, searchOperator: typeof (hypothesis.payload as { searchOperator?: unknown }).searchOperator === "string" ? (hypothesis.payload as { searchOperator: string }).searchOperator : undefined, gitCommit: commit.stdout.trim(), datasetVersion: adapter.config.datasetRevision, executor: config.experimentExecutor, configPatch: { estimatorPath: candidateEstimatorPath(hypothesis.payload) ?? adapter.config.evaluator.estimatorPath } }, adapter.config);
    store.saveExperiment({ id, payload: { ...manifest, status: "proposed", executionPlan: createExecutionPlan(manifest) } });
    store.appendEvent("experiment.priority.selected", { experimentId: id, hypothesisId: hypothesis.id, priority: ranked[0].priority, novelty: ranked[0].novelty, score: ranked[0] });
    store.close();
    return { id, text: `\n\nExperiment manifest proposed\nPriority: ${ranked[0].priority.toFixed(4)} · novelty ${(ranked[0].novelty * 100).toFixed(0)}% (${ranked[0].numerator.toFixed(4)} value / ${ranked[0].denominator.toFixed(4)} cost)\n${manifestSummary(manifest)}\nNext: /experiment show ${id}` };
  };

  const prepareAutomaticReplication = (parentId: string): { id: string; text: string } | null => {
    const store = new ResearchStore(join(root, ".sota", "database.sqlite"));
    const parent = store.experiments().find((candidate) => candidate.id === parentId);
    if (!parent) { store.close(); return null; }
    const parentManifest = ExperimentManifestSchema.parse(parent.payload);
    if (!parentManifest.acceptance.requireReplication) { store.close(); return null; }
    const manifest = createReplicationManifest(parentManifest, activeAdapter().config);
    store.saveExperiment({ id: manifest.id, payload: { ...manifest, status: "proposed", replicationOf: parentId, automatic: true } });
    store.appendEvent("replication.manifest.created", { parentId, replicationId: manifest.id, automatic: true });
    store.close();
    return { id: manifest.id, text: `\n\nIndependent replication ${manifest.id} prepared for ${parentId}.\n${manifestSummary(manifest)}` };
  };

  const prepareAutomaticAblations = (parentId: string): { ids: string[]; text: string } | null => {
    const store = new ResearchStore(join(root, ".sota", "database.sqlite"));
    const parent = store.experiments().find((candidate) => candidate.id === parentId);
    if (!parent) { store.close(); return null; }
    const parentManifest = ExperimentManifestSchema.safeParse(parent.payload);
    if (!parentManifest.success) { store.close(); return null; }
    const hypothesisId = parentManifest.data.hypothesisId;
    const hypothesis = store.hypotheses().find((candidate) => candidate.id === hypothesisId);
    const payload = hypothesis?.payload && typeof hypothesis.payload === "object" ? hypothesis.payload as { ablationFactors?: unknown } : undefined;
    if (parentManifest.data.searchOperator !== "ablation" || !Array.isArray(payload?.ablationFactors) || payload.ablationFactors.length === 0) {
      store.close();
      return null;
    }
    const plan = createAblationPlan({ hypothesisId, factors: payload.ablationFactors as Parameters<typeof createAblationPlan>[0]["factors"] });
    const ids: string[] = [];
    for (const variant of plan.variants.filter((candidate) => !candidate.control).slice(0, 4)) {
      const id = `abl_${parentId}_${variant.factorId}`.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 96);
      if (!store.experiments().some((candidate) => candidate.id === id)) {
        const manifest = createExperimentManifest({
          id,
          parent: parentId,
          hypothesisId,
          outcomeType: parentManifest.data.outcomeType,
          gitCommit: parentManifest.data.gitCommit,
          datasetVersion: parentManifest.data.datasetVersion,
          splitVersion: parentManifest.data.splitVersion,
          executor: parentManifest.data.resources.executor,
          image: parentManifest.data.resources.image,
          gpu: parentManifest.data.resources.gpu,
          timeoutMinutes: parentManifest.data.resources.timeoutMinutes,
          folds: parentManifest.data.evaluation.folds,
          seeds: parentManifest.data.evaluation.seeds,
          requiredArtifacts: parentManifest.data.evaluation.requiredArtifacts,
          verificationCommand: parentManifest.data.evaluation.verificationCommand,
          verificationCommands: parentManifest.data.evaluation.verificationCommands,
          minimumPrimaryDelta: parentManifest.data.acceptance.minimumPrimaryDelta,
          maximumRegressionShift: parentManifest.data.acceptance.maximumRegressionShift,
          requireReplication: false,
          searchOperator: "ablation",
          configPatch: { ...parentManifest.data.change.configPatch, ...variant.configPatch },
        }, activeAdapter().config);
        store.saveExperiment({ id, payload: { ...manifest, status: "proposed", ablationOf: parentId, ablationFactorId: variant.factorId, ablationLabel: variant.label, executionPlan: createExecutionPlan(manifest) } });
        store.appendEvent("research.ablation.variant.scheduled", { parentId, experimentId: id, factorId: variant.factorId, label: variant.label, plan });
      }
      ids.push(id);
    }
    store.appendEvent("research.ablation.plan", plan);
    store.close();
    return { ids, text: `\n\nAblation plan prepared for ${parentId}: ${ids.join(", ")}` };
  };

  const latestExperimentComparison = (experimentId: string): { direction?: string; evidence?: string; note?: string } | undefined => {
    const store = new ResearchStore(join(root, ".sota", "database.sqlite"));
    const event = store.recentEvents(500).reverse().find((candidate) => candidate.type === "experiment.comparison.completed" && (candidate.payload as { experimentId?: unknown }).experimentId === experimentId);
    store.close();
    return event?.payload && typeof event.payload === "object" ? (event.payload as { comparison?: { direction?: string; evidence?: string; note?: string } }).comparison : undefined;
  };

  const recordTransferableMethodIfReplicated = (experimentId: string): void => {
    const store = new ResearchStore(join(root, ".sota", "database.sqlite"));
    const experiment = store.experiments().find((candidate) => candidate.id === experimentId);
    const replicationOf = experiment?.payload && typeof experiment.payload === "object"
      ? (experiment.payload as { replicationOf?: unknown }).replicationOf
      : undefined;
    if (typeof replicationOf !== "string") { store.close(); return; }
    const parent = store.experiments().find((candidate) => candidate.id === replicationOf);
    const parentManifest = parent ? ExperimentManifestSchema.safeParse(parent.payload) : undefined;
    const comparisonFor = (id: string): { direction?: unknown } | undefined => {
      const event = store.recentEvents(2_000).reverse().find((candidate) => candidate.type === "experiment.comparison.completed" && (candidate.payload as { experimentId?: unknown }).experimentId === id);
      return event?.payload && typeof event.payload === "object" ? (event.payload as { comparison?: { direction?: unknown } }).comparison : undefined;
    };
    const parentComparison = comparisonFor(replicationOf);
    const replicationComparison = comparisonFor(experimentId);
    if (!parentManifest?.success || parentComparison?.direction !== "improved" || replicationComparison?.direction !== "improved") {
      store.close();
      return;
    }
    const alreadyRecorded = store.recentEvents(5_000).some((event) => {
      if (event.type !== "research.method.transferable" || !event.payload || typeof event.payload !== "object") return false;
      const evidenceIds = (event.payload as { evidenceIds?: unknown }).evidenceIds;
      return Array.isArray(evidenceIds) && evidenceIds.includes(replicationOf) && evidenceIds.includes(experimentId);
    });
    if (alreadyRecorded) { store.close(); return; }
    const hypothesis = store.hypotheses().find((candidate) => candidate.id === parentManifest.data.hypothesisId);
    const hypothesisPayload = hypothesis?.payload && typeof hypothesis.payload === "object" ? hypothesis.payload as {
      title?: unknown;
      formulationFamily?: unknown;
      mechanism?: unknown;
      proposedChange?: unknown;
    } : undefined;
    if (!hypothesisPayload) { store.close(); return; }
    const formulationFamily = typeof hypothesisPayload.formulationFamily === "string" ? hypothesisPayload.formulationFamily : "other";
    store.appendEvent("research.method.transferable", createTransferableMethod({
      id: `method_${replicationOf}`,
      sourceCompetition: activeAdapter().id,
      sourceTaskType: activeAdapter().config.taskType,
      title: typeof hypothesisPayload.title === "string" ? hypothesisPayload.title : parentManifest.data.hypothesisId,
      formulationFamily,
      mechanism: typeof hypothesisPayload.mechanism === "string" ? hypothesisPayload.mechanism : "",
      proposedChange: typeof hypothesisPayload.proposedChange === "string" ? hypothesisPayload.proposedChange : "",
      evidenceIds: [replicationOf, experimentId],
      tags: [activeAdapter().config.taskType, formulationFamily],
    }));
    store.close();
  };

    const executeExperiment = async (id: string): Promise<string> => {
      const store = new ResearchStore(join(root, ".sota", "database.sqlite"));
    const entry = store.experiments().find((experiment) => experiment.id === id);
    if (!entry) { store.close(); throw new Error(`Experiment not found: ${id}`); }
    const manifest = ExperimentManifestSchema.parse(entry.payload);
    const validationPolicyPath = join(root, ".sota", "validation-policy.json");
    const validationLockPath = join(root, ".sota", "validation-policy.lock.json");
    if (readValidationPolicyLock(validationLockPath)?.locked) {
      assertValidationPolicy(validationPolicyPath, validationLockPath);
      store.appendEvent("validation.policy.verified", { experimentId: id, lockPath: validationLockPath });
    }
    let executionPlan: ExecutionStage[] = Array.isArray((entry.payload as { executionPlan?: unknown }).executionPlan)
      ? (entry.payload as { executionPlan: ExecutionStage[] }).executionPlan
      : createExecutionPlan(manifest);
    const adapter = activeAdapter();
    requireActiveContract();
    const hypothesis = store.hypotheses().find((candidate) => candidate.id === manifest.hypothesisId);
    const entryPayload = entry.payload as Record<string, unknown>;
    store.saveExperiment({ id, payload: { ...entryPayload, status: "running", executionPlan } });
    store.close();
    try {
    setProgress(`Experiment ${id} · creating isolated worktree...`);
    const worktree = await ensureWorktree(root, root, id);
    const experimentCwd = join(worktree, relative(root, adapter.workspacePath(root)));
    const experimentEnvironment = prepareExperimentEnvironment(manifest, experimentCwd);
    if (config.provider === "codex") {
      setProgress(`Experiment ${id} · experiment engineer implementing the hypothesis...`);
      activeSteer.current = null;
      const engineerResult = await runWithLocalFallback({
        role: "experiment engineer",
        objective: "Implement the selected hypothesis in this isolated worktree. Inspect the existing estimator, make the smallest reproducible change, run relevant tests or smoke checks, and leave the worktree ready for evaluation. Do not touch files outside this worktree and do not submit anything. If the selected provider cannot edit files directly, return ONLY an applicable unified diff whose first line begins with diff --git; otherwise perform the edit and summarize it.",
        context: { manifest, hypothesis: hypothesis?.payload ?? null, worktree: experimentCwd },
      }, { provider: config.provider, model: config.model, cwd: worktree, reasoningEffort: config.reasoningEffort, sandbox: "workspace-write", limitPolicy: config.limitPolicy, onThread: (threadId) => { activeSteer.current = (message) => queueCodexMessage(threadId, message); } }, config.fallbackModel, setProgress, registerProcess);
      const fallbackDiff = extractUnifiedDiff(String(engineerResult.output));
      if (fallbackDiff) await applyUnifiedDiff(worktree, fallbackDiff);
      activeSteer.current = null;
      executionPlan = advanceExecutionStage(executionPlan, "smoke", "completed");
      const smokeStore = new ResearchStore(join(root, ".sota", "database.sqlite"));
      smokeStore.appendEvent("experiment.stage.smoke.completed", { experimentId: id });
      smokeStore.close();
    } else {
      setProgress(`Experiment ${id} · local model proposing a validated patch...`);
      const localEngineer = await runWithLocalFallback({
        role: "experiment engineer",
        objective: "Implement the selected hypothesis in this isolated worktree. You cannot call tools directly. Return ONLY a unified diff whose first line begins with diff --git. The diff must be applicable from the worktree root. Do not return a plan or prose.",
        context: { manifest, hypothesis: hypothesis?.payload ?? null, worktree: experimentCwd },
      }, { provider: "local", model: config.model, cwd: worktree, sandbox: "read-only", limitPolicy: "stop" }, undefined, setProgress, registerProcess);
      const diff = extractUnifiedDiff(String(localEngineer.output));
      if (!diff) throw new Error("Local experiment engineer did not return a valid unified diff.");
      await applyUnifiedDiff(worktree, diff);
      const smokeStore = new ResearchStore(join(root, ".sota", "database.sqlite"));
      smokeStore.appendEvent("experiment.stage.smoke.completed", { experimentId: id, implementation: "local-unified-diff" });
      smokeStore.close();
    }
    const protectedReference = captureProtectedFiles(adapter.workspacePath(root), [adapter.config.evaluator.command]);
    const changedProtected = changedProtectedFiles(protectedReference, experimentCwd);
    if (changedProtected.length) {
      const integrityStore = new ResearchStore(join(root, ".sota", "database.sqlite"));
      integrityStore.appendEvent("experiment.integrity.failed", { experimentId: id, protectedFiles: changedProtected, reason: "evaluator or configuration changed inside the isolated worktree" });
      integrityStore.saveExperiment({ id, payload: { ...entryPayload, status: "invalid", integrityFailure: changedProtected } });
      integrityStore.close();
      throw new Error(`Experiment ${id} rejected: protected evaluator files changed: ${changedProtected.join(", ")}`);
    }
    const command = candidateExperimentCommand(adapter, hypothesis?.payload);
    const candidateEstimator = (manifest.change.configPatch as { estimatorPath?: unknown }).estimatorPath;
    const isCandidateEvaluation = typeof candidateEstimator === "string" && candidateEstimator !== adapter.config.evaluator.estimatorPath;
    const contract = validateExecutionContract(manifest, experimentCwd, command);
    const contractStore = new ResearchStore(join(root, ".sota", "database.sqlite"));
    contractStore.appendEvent(contract.valid ? "experiment.stage.feasibility.completed" : "experiment.stage.feasibility.failed", { experimentId: id, reasons: contract.reasons, command, cwd: experimentCwd });
    if (!contract.valid) contractStore.saveExperiment({ id, payload: { ...entryPayload, status: "failed", executionPlan } });
    contractStore.close();
    executionPlan = advanceExecutionStage(executionPlan, "feasibility", contract.valid ? "completed" : "failed");
    if (!contract.valid) throw new Error(`Experiment feasibility check failed:\n${contract.reasons.map((reason) => `- ${reason}`).join("\n")}`);
    const executor = executorFor(manifest.resources.executor, root);
    const smokeCommand = adapter.config.execution?.smokeCommand;
    if (smokeCommand) {
      setProgress(`Experiment ${id} · running smoke gate...`);
      const smokeManifest = { ...manifest, evaluation: { ...manifest.evaluation, requiredArtifacts: [] } };
      const smokeContract = validateExecutionContract(smokeManifest, experimentCwd, smokeCommand);
      if (!smokeContract.valid) {
        executionPlan = advanceExecutionStage(executionPlan, "smoke", "failed");
        const failedStore = new ResearchStore(join(root, ".sota", "database.sqlite"));
        failedStore.appendEvent("experiment.stage.smoke.failed", { experimentId: id, reasons: smokeContract.reasons, command: smokeCommand });
        failedStore.saveExperiment({ id, payload: { ...entryPayload, status: "failed", executionPlan } });
        failedStore.close();
        throw new Error(`Smoke feasibility check failed:\n${smokeContract.reasons.map((reason) => `- ${reason}`).join("\n")}`);
      }
      const smoke = await withExecutionHeartbeat(
        () => runReducedValidation(executor, manifest, experimentCwd, smokeCommand, adapter.config.metric.name, registerProcess),
        { storePath: join(root, ".sota", "database.sqlite"), experimentId: id, stage: "smoke", executor: manifest.resources.executor },
      );
      activeProcess.current = null;
      executionPlan = advanceExecutionStage(executionPlan, "smoke", smoke.status === "completed" ? "completed" : "failed");
      const smokeStore = new ResearchStore(join(root, ".sota", "database.sqlite"));
      smokeStore.appendEvent(smoke.status === "completed" ? "experiment.stage.smoke.completed" : "experiment.stage.smoke.failed", { experimentId: id, runId: smoke.runId, metric: smoke.metrics[adapter.config.metric.name] ?? null, exitCode: smoke.exitCode, command: smokeCommand });
      if (smoke.status !== "completed") smokeStore.saveExperiment({ id, payload: { ...entryPayload, status: "failed", executionPlan } });
      smokeStore.close();
      if (smoke.status !== "completed") throw new Error(`Smoke validation failed (${smoke.exitCode}): ${smoke.stderr || smoke.stdout}`);
    } else if (config.provider !== "codex") executionPlan = advanceExecutionStage(executionPlan, "smoke", "skipped");
    const reducedCommand = adapter.config.execution?.reducedValidationCommand;
    if (reducedCommand) {
      setProgress(`Experiment ${id} · running reduced validation gate...`);
      const reducedManifest = { ...manifest, evaluation: { ...manifest.evaluation, requiredArtifacts: [] } };
      const reducedContract = validateExecutionContract(reducedManifest, experimentCwd, reducedCommand);
      if (!reducedContract.valid) {
        executionPlan = advanceExecutionStage(executionPlan, "reduced_validation", "failed");
        const failedStore = new ResearchStore(join(root, ".sota", "database.sqlite"));
        failedStore.appendEvent("experiment.stage.reduced_validation.failed", { experimentId: id, reasons: reducedContract.reasons, command: reducedCommand });
        failedStore.saveExperiment({ id, payload: { ...entryPayload, status: "failed", executionPlan } });
        failedStore.close();
        throw new Error(`Reduced validation feasibility check failed:\n${reducedContract.reasons.map((reason) => `- ${reason}`).join("\n")}`);
      }
      const reduced = await withExecutionHeartbeat(
        () => runReducedValidation(executor, manifest, experimentCwd, reducedCommand, adapter.config.metric.name, registerProcess),
        { storePath: join(root, ".sota", "database.sqlite"), experimentId: id, stage: "reduced_validation", executor: manifest.resources.executor },
      );
      activeProcess.current = null;
      executionPlan = advanceExecutionStage(executionPlan, "reduced_validation", reduced.status === "completed" ? "completed" : "failed");
      const reducedStore = new ResearchStore(join(root, ".sota", "database.sqlite"));
      reducedStore.appendEvent(reduced.status === "completed" ? "experiment.stage.reduced_validation.completed" : "experiment.stage.reduced_validation.failed", { experimentId: id, runId: reduced.runId, metric: reduced.metrics[adapter.config.metric.name] ?? null, exitCode: reduced.exitCode, command: reducedCommand });
      if (reduced.status !== "completed") reducedStore.saveExperiment({ id, payload: { ...entryPayload, status: "failed", executionPlan } });
      reducedStore.close();
      if (reduced.status !== "completed") throw new Error(`Reduced validation failed (${reduced.exitCode}): ${reduced.stderr || reduced.stdout}`);
      const promotionPolicy = adapter.config.execution?.reducedPromotion;
      if (promotionPolicy?.enabled) {
        const promotionStore = new ResearchStore(join(root, ".sota", "database.sqlite"));
        const baselineEvent = promotionStore.recentEvents(500).reverse().find((event) => event.type === "baseline.completed");
        const baselinePayload = baselineEvent?.payload as { metric?: unknown; stdout?: string } | undefined;
        const baselineMetric = typeof baselinePayload?.metric === "number" ? baselinePayload.metric : baselinePayload?.stdout ? parseMetricOutput(baselinePayload.stdout, adapter.config.metric.name).metrics[adapter.config.metric.name] : undefined;
        const learned = learnPromotionPolicy(promotionObservations(promotionStore.recentEvents(2_000), adapter.config.metric.direction), promotionPolicy.minimumDelta);
        const gate = evaluateReducedPromotion({ candidateMetric: reduced.metrics[adapter.config.metric.name], baselineMetric, direction: adapter.config.metric.direction, minimumDelta: learned.minimumDelta, tolerance: promotionPolicy.tolerance });
        promotionStore.appendEvent(gate.promote ? "experiment.stage.reduced_validation.promoted" : "experiment.stage.reduced_validation.rejected", { experimentId: id, runId: reduced.runId, ...gate, configuredMinimumDelta: promotionPolicy.minimumDelta, learnedPromotion: learned, baselineMetric, candidateMetric: reduced.metrics[adapter.config.metric.name] ?? null });
        if (!gate.promote) {
          executionPlan = advanceExecutionStage(executionPlan, "full_validation", "skipped");
          promotionStore.saveExperiment({ id, payload: { ...entryPayload, status: "rejected", rejection: gate.reason, executionPlan } });
          promotionStore.close();
          throw new Error(`Reduced validation did not earn full validation: ${gate.reason}`);
        }
        promotionStore.close();
      }
    } else {
      executionPlan = advanceExecutionStage(executionPlan, "reduced_validation", "skipped");
      const skippedStore = new ResearchStore(join(root, ".sota", "database.sqlite"));
      skippedStore.appendEvent("experiment.stage.reduced_validation.skipped", { experimentId: id, reason: "manifest has no generic reduced-data contract" });
      skippedStore.close();
    }
    setProgress(`Experiment ${id} · running ${manifest.resources.executor} executor...`);
    let evaluatorOutput: { stdout: string; stderr: string; exitCode: number } | undefined;
    const verificationOutputs: Array<{ command: string[]; stdout: string; stderr: string; exitCode: number }> = [];
    const recordAttemptStarted = (attemptNumber: number): void => {
      const attemptStore = new ResearchStore(join(root, ".sota", "database.sqlite"));
      attemptStore.appendEvent("run.attempt.started", { experimentId: id, attempt: attemptNumber, command, cwd: experimentCwd, executor: manifest.resources.executor });
      attemptStore.close();
    };
    let attempt = 1;
    recordAttemptStarted(attempt);
    let result = await withExecutionHeartbeat(
      () => executor.run(manifest, experimentCwd, command, registerProcess, adapter.config.metric.name),
      { storePath: join(root, ".sota", "database.sqlite"), experimentId: id, attempt, stage: "full_validation", executor: manifest.resources.executor },
    );
    if (manifest.outcomeType === "metric") result = validateRunMetrics(result, [adapter.config.metric.name]);
    const recoveryEvents: TrajectoryEvent[] = [];
    while (result.status !== "completed") {
      const plan = recoveryPlan(result.failureClass);
      if (!plan.retry || attempt >= plan.maxAttempts) break;
      const delay = recoveryDelay(plan, attempt);
      const retryStore = new ResearchStore(join(root, ".sota", "database.sqlite"));
      retryStore.appendEvent("run.retry.scheduled", { experimentId: id, runId: result.runId, attempt, delaySeconds: delay, failureClass: result.failureClass, action: plan.action });
      retryStore.close();
      recoveryEvents.push({ id: `${result.runId}-recovery-${attempt}`, kind: "recovery", payload: { attempt, failureClass: result.failureClass ?? null, action: plan.action, delaySeconds: delay } });
      setProgress(`Experiment ${id} · retry ${attempt + 1}/${plan.maxAttempts} after ${plan.action}...`);
      await new Promise<void>((resolve) => setTimeout(resolve, delay * 1000));
      attempt += 1;
      recordAttemptStarted(attempt);
      result = await withExecutionHeartbeat(
        () => executor.run(manifest, experimentCwd, command, registerProcess, adapter.config.metric.name),
        { storePath: join(root, ".sota", "database.sqlite"), experimentId: id, attempt, stage: "full_validation", executor: manifest.resources.executor },
      );
      if (manifest.outcomeType === "metric") result = validateRunMetrics(result, [adapter.config.metric.name]);
    }
    if (result.status !== "completed") {
      const route = recoveryRouteDirective(result.failureClass);
      const routeStore = new ResearchStore(join(root, ".sota", "database.sqlite"));
      routeStore.appendEvent("experiment.recovery.route_changed", { experimentId: id, runId: result.runId, attempts: attempt, ...route });
      routeStore.close();
    }
    activeProcess.current = null;
    const evaluatorCommand = isCandidateEvaluation ? command : adapter.config.evaluator.command;
    const sameCommand = evaluatorCommand.length === command.length && evaluatorCommand.every((part, index) => part === command[index]);
    if (result.status === "completed" && !sameCommand) {
      setProgress(`Experiment ${id} · running canonical evaluator...`);
      let evaluated: Awaited<ReturnType<typeof runProcess>>;
      let evaluatorAttempt = 1;
      const evaluatorDeadline = Date.now() + manifest.resources.timeoutMinutes * 60_000;
      while (true) {
        const remainingMs = Math.max(1_000, evaluatorDeadline - Date.now());
        try {
          evaluated = await withExecutionHeartbeat(
            () => runProcess(evaluatorCommand, experimentCwd, remainingMs, undefined, registerProcess, experimentEnvironment),
            { storePath: join(root, ".sota", "database.sqlite"), experimentId: id, attempt: evaluatorAttempt, stage: "evaluator", executor: manifest.resources.executor },
          );
        } catch (error) {
          evaluated = processFailureResult(evaluatorCommand, experimentCwd, error);
        }
        if (evaluated.exitCode === 0) break;
        const failureClass = classifyProcessFailure(evaluated) ?? "unknown";
        const plan = recoveryPlan(failureClass);
        if (!plan.retry || evaluatorAttempt >= plan.maxAttempts) break;
        const delay = recoveryDelay(plan, evaluatorAttempt);
        if (Date.now() + delay * 1_000 + 1_000 > evaluatorDeadline) break;
        const retryStore = new ResearchStore(join(root, ".sota", "database.sqlite"));
        retryStore.appendEvent("run.retry.scheduled", { experimentId: id, stage: "evaluator", attempt: evaluatorAttempt, delaySeconds: delay, failureClass, action: plan.action });
        retryStore.close();
        setProgress(`Evaluator retry ${evaluatorAttempt + 1}/${plan.maxAttempts} after ${plan.action}...`);
        await new Promise<void>((resolve) => setTimeout(resolve, delay * 1000));
        evaluatorAttempt += 1;
      }
      activeProcess.current = null;
      evaluatorOutput = { stdout: evaluated.stdout, stderr: evaluated.stderr, exitCode: evaluated.exitCode };
      const metrics = parseMetricOutput(evaluated.stdout, adapter.config.metric.name);
      result = {
        ...result,
        status: evaluated.exitCode === 0 ? "completed" : "failed",
        exitCode: evaluated.exitCode,
        metrics: { ...result.metrics, ...metrics.metrics },
        metricsByFold: { ...result.metricsByFold, ...metrics.metricsByFold },
        subgroupDeltas: metrics.subgroupDeltas,
        stdout: `${result.stdout ?? ""}\n[EVALUATOR]\n${evaluated.stdout}`,
        stderr: `${result.stderr ?? ""}\n[EVALUATOR]\n${evaluated.stderr}`,
        ...(evaluated.exitCode === 0 ? {} : { failureClass: classifyProcessFailure(evaluated) ?? "unknown" }),
      };
    }
    const verificationCommands = [...(manifest.evaluation.verificationCommand ? [manifest.evaluation.verificationCommand] : []), ...(manifest.evaluation.verificationCommands ?? [])];
    if (result.status === "completed") {
      for (const verificationCommand of verificationCommands) {
        setProgress(`Experiment ${id} · running verification ${verificationOutputs.length + 1}/${verificationCommands.length}...`);
        let checked: Awaited<ReturnType<typeof runProcess>>;
        let verifierAttempt = 1;
        const verifierDeadline = Date.now() + manifest.resources.timeoutMinutes * 60_000;
        while (true) {
          const remainingMs = Math.max(1_000, verifierDeadline - Date.now());
          try {
            checked = await withExecutionHeartbeat(
              () => runProcess(verificationCommand, experimentCwd, remainingMs, undefined, registerProcess, experimentEnvironment),
              { storePath: join(root, ".sota", "database.sqlite"), experimentId: id, attempt: verifierAttempt, stage: "verification", executor: manifest.resources.executor },
            );
          } catch (error) {
            checked = processFailureResult(verificationCommand, experimentCwd, error);
          }
          if (checked.exitCode === 0) break;
          const failureClass = classifyProcessFailure(checked) ?? "unknown";
          const plan = recoveryPlan(failureClass);
          if (!plan.retry || verifierAttempt >= plan.maxAttempts) break;
          const delay = recoveryDelay(plan, verifierAttempt);
          if (Date.now() + delay * 1_000 + 1_000 > verifierDeadline) break;
          const retryStore = new ResearchStore(join(root, ".sota", "database.sqlite"));
          retryStore.appendEvent("run.retry.scheduled", { experimentId: id, stage: "verification", verifierIndex: verificationOutputs.length + 1, attempt: verifierAttempt, delaySeconds: delay, failureClass, action: plan.action });
          retryStore.close();
          setProgress(`Verifier retry ${verifierAttempt + 1}/${plan.maxAttempts} after ${plan.action}...`);
          await new Promise<void>((resolve) => setTimeout(resolve, delay * 1000));
          verifierAttempt += 1;
        }
        activeProcess.current = null;
        verificationOutputs.push({ command: verificationCommand, stdout: checked.stdout, stderr: checked.stderr, exitCode: checked.exitCode });
        const verificationStore = new ResearchStore(join(root, ".sota", "database.sqlite"));
        verificationStore.appendEvent(checked.exitCode === 0 ? "experiment.verification.completed" : "experiment.verification.failed", { experimentId: id, runId: result.runId, verifierIndex: verificationOutputs.length, command: verificationCommand, exitCode: checked.exitCode, stdout: redactSecrets(checked.stdout.slice(-4000)), stderr: redactSecrets(checked.stderr.slice(-4000)) });
        verificationStore.close();
        result = { ...result, status: checked.exitCode === 0 ? "completed" : "failed", exitCode: checked.exitCode, stdout: `${result.stdout ?? ""}\n[VERIFICATION ${verificationOutputs.length}]\n${checked.stdout}`, stderr: `${result.stderr ?? ""}\n[VERIFICATION ${verificationOutputs.length}]\n${checked.stderr}`, ...(checked.exitCode === 0 ? {} : { failureClass: classifyProcessFailure(checked) ?? "unknown" }) };
        if (checked.exitCode !== 0) break;
      }
    }
    if (manifest.outcomeType === "metric") result = validateRunMetrics(result, [adapter.config.metric.name, ...(adapter.config.secondaryMetrics ?? []).map((objective) => objective.name)]);
    executionPlan = advanceExecutionStage(executionPlan, "full_validation", result.status === "completed" ? "completed" : "failed");
    const fullStageStore = new ResearchStore(join(root, ".sota", "database.sqlite"));
    fullStageStore.appendEvent(result.status === "completed" ? "experiment.stage.full_validation.completed" : "experiment.stage.full_validation.failed", { experimentId: id, runId: result.runId, metric: result.metrics[adapter.config.metric.name] ?? null, exitCode: result.exitCode, attempts: attempt });
    fullStageStore.close();
    const artifactDir = join(root, ".sota", "artifacts", result.runId);
    mkdirSync(artifactDir, { recursive: true });
    const persistedResult = { ...result, stdout: redactSecrets(result.stdout ?? ""), stderr: redactSecrets(result.stderr ?? "") };
    const persistedEvaluatorOutput = evaluatorOutput ? { ...evaluatorOutput, stdout: redactSecrets(evaluatorOutput.stdout), stderr: redactSecrets(evaluatorOutput.stderr) } : undefined;
    const persistedVerificationOutputs = verificationOutputs.map((verification) => ({ ...verification, stdout: redactSecrets(verification.stdout), stderr: redactSecrets(verification.stderr) }));
    const stdoutPath = join(artifactDir, "stdout.log");
    const stderrPath = join(artifactDir, "stderr.log");
    const metricsPath = join(artifactDir, "metrics.json");
    const environmentPath = join(artifactDir, "environment.json");
    writeFileSync(stdoutPath, result.stdout ?? "");
    writeFileSync(stderrPath, result.stderr ?? "");
    writeFileSync(metricsPath, `${JSON.stringify(result.metrics, null, 2)}\n`);
    const evaluatorStdoutPath = evaluatorOutput ? join(artifactDir, "evaluator.stdout.log") : undefined;
    const evaluatorStderrPath = evaluatorOutput ? join(artifactDir, "evaluator.stderr.log") : undefined;
    const verificationPaths = persistedVerificationOutputs.map((verification, index) => ({ verification, stdoutPath: join(artifactDir, `verification-${index + 1}.stdout.log`), stderrPath: join(artifactDir, `verification-${index + 1}.stderr.log`) }));
    if (persistedEvaluatorOutput && evaluatorStdoutPath && evaluatorStderrPath) {
      writeFileSync(evaluatorStdoutPath, persistedEvaluatorOutput.stdout);
      writeFileSync(evaluatorStderrPath, persistedEvaluatorOutput.stderr);
    }
    for (const { verification, stdoutPath, stderrPath } of verificationPaths) {
      writeFileSync(stdoutPath, verification.stdout);
      writeFileSync(stderrPath, verification.stderr);
    }
    const environment = await captureEnvironment(root, result.cwd ?? experimentCwd, result.command ?? command, manifest.resources.executor, manifest.resources.gpu);
    writeFileSync(environmentPath, `${JSON.stringify(environment, null, 2)}\n`);
    const recordedResult = {
      ...persistedResult,
      recoveryAttempts: attempt,
      verification: {
        declared: verificationCommands.length,
        executed: verificationOutputs.length,
        passed: verificationOutputs.filter((verification) => verification.exitCode === 0).length,
        failed: verificationOutputs.filter((verification) => verification.exitCode !== 0).length,
        independent: verificationCommands.length >= 2 && verificationCommands.length === new Set(verificationCommands.map((candidate) => JSON.stringify(candidate))).size,
      },
      artifacts: {
        ...result.artifacts,
        "stdout.log": stdoutPath,
        "stderr.log": stderrPath,
        "metrics.json": metricsPath,
        "environment.json": environmentPath,
        ...(evaluatorStdoutPath && evaluatorStderrPath ? { "evaluator.stdout.log": evaluatorStdoutPath, "evaluator.stderr.log": evaluatorStderrPath } : {}),
        ...Object.fromEntries(verificationPaths.flatMap(({ stdoutPath, stderrPath }, index) => [[`verification-${index + 1}.stdout.log`, stdoutPath], [`verification-${index + 1}.stderr.log`, stderrPath]])),
      },
    };
    const resultStore = new ResearchStore(join(root, ".sota", "database.sqlite"));
    resultStore.saveRun({ id: result.runId, experimentId: id, status: recordedResult.status, payload: recordedResult });
    for (const [name, path] of Object.entries(recordedResult.artifacts)) {
      resultStore.saveArtifact({ id: `${result.runId}-${name}`, runId: result.runId, name, path, checksum: sha256File(path) });
    }
    const initialExperimentAudit = auditExperiment(manifest, RunResultSchema.parse(recordedResult), {
      currentCommit: manifest.gitCommit,
      datasetVersion: manifest.datasetVersion,
      splitVersion: manifest.splitVersion,
      metricName: activeAdapter().config.metric.name,
      leakageAuditPassed: resultStore.experimentGates(id).leakageAuditPassed,
      reviewerApproved: resultStore.experimentGates(id).reviewerApproved,
      independentReplicationObserved: independentReplicationObserved(id, resultStore.experiments(), resultStore.runs()),
      externalScoreRequired: manifest.acceptance.requireExternalScore,
      externalScoreObserved: externalScoreObservedForExperiment(id, resultStore.submissions(), result.runId),
      artifactChecksums: Object.fromEntries(Object.entries(recordedResult.artifacts).map(([name, path]) => [name, sha256File(path)])),
    });
    resultStore.recordSubtaskAudit({ ...auditExperimentSubtask(manifest, initialExperimentAudit, [result.runId, ...Object.keys(recordedResult.artifacts)]), experimentId: id, runId: result.runId });
    if (recordedResult.status === "completed") {
      const baselineEvent = resultStore.recentEvents(500).reverse().find((event) => event.type === "baseline.completed");
      const baselinePayload = baselineEvent?.payload as { metric?: unknown; stdout?: string; stderr?: string; durationMs?: number; command?: string[]; cwd?: string } | undefined;
      const baselineMetricName = activeAdapter().config.metric.name;
      const parsedBaseline = baselinePayload?.stdout ? parseMetricOutput(baselinePayload.stdout, baselineMetricName) : { metrics: {} as Record<string, number>, metricsByFold: {} as Record<string, number[]>, subgroupDeltas: [] };
      const baselineMetric = typeof baselinePayload?.metric === "number" && Number.isFinite(baselinePayload.metric)
        ? baselinePayload.metric
        : parsedBaseline.metrics[baselineMetricName];
      if (typeof baselineMetric === "number" && Number.isFinite(baselineMetric)) {
        const baselineRun = {
          runId: `baseline-${baselineEvent?.createdAt ?? "recorded"}`,
          status: "completed" as const,
          exitCode: 0,
          durationSeconds: (baselinePayload?.durationMs ?? 0) / 1000,
          metrics: { [baselineMetricName]: baselineMetric },
          metricsByFold: { [baselineMetricName]: baselinePayload?.stdout ? parsedBaseline.metricsByFold[baselineMetricName] ?? [] : [] },
          subgroupDeltas: parsedBaseline.subgroupDeltas,
          artifacts: {},
          stdout: baselinePayload?.stdout,
          stderr: baselinePayload?.stderr,
          command: baselinePayload?.command,
          cwd: baselinePayload?.cwd,
        };
        const comparison = compareRuns(baselineRun, RunResultSchema.parse(recordedResult), baselineMetricName, activeAdapter().config.metric.direction === "minimize");
        resultStore.appendEvent("experiment.comparison.completed", { experimentId: id, baselineSource: baselineEvent?.createdAt ?? "baseline", comparison });
      } else {
        resultStore.appendEvent("experiment.comparison.insufficient_data", { experimentId: id, reason: "No finite baseline metric was available." });
      }
    }
    resultStore.saveExperiment({ id, payload: { ...entryPayload, status: recordedResult.status === "completed" ? "completed" : "failed", runId: result.runId, worktreePath: experimentCwd, executionPlan } });
    if (recordedResult.status === "completed" && typeof manifest.parent === "string") {
      const parentEntry = resultStore.experiments().find((candidate) => candidate.id === manifest.parent);
      const parentManifest = parentEntry ? ExperimentManifestSchema.safeParse(parentEntry.payload) : undefined;
      const parentRunId = parentEntry && typeof (parentEntry.payload as { runId?: unknown }).runId === "string" ? (parentEntry.payload as { runId: string }).runId : undefined;
      const parentRun = parentRunId ? resultStore.runs().find((candidate) => candidate.id === parentRunId) : undefined;
      if (parentManifest?.success && parentRun) {
        const parentChecksums = Object.fromEntries(resultStore.artifacts(parentRun.id).map((artifact) => [artifact.name, artifact.checksum]));
        const refreshed = refreshExperimentAudit(parentManifest.data, RunResultSchema.parse(parentRun.payload), { currentCommit: parentManifest.data.gitCommit, datasetVersion: parentManifest.data.datasetVersion, splitVersion: parentManifest.data.splitVersion, metricName: activeAdapter().config.metric.name, leakageAuditPassed: resultStore.experimentGates(manifest.parent).leakageAuditPassed, reviewerApproved: resultStore.experimentGates(manifest.parent).reviewerApproved, independentReplicationObserved: true, artifactChecksums: parentChecksums }, [parentRun.id, ...Object.keys(parentChecksums), `replication:${id}`]);
        resultStore.recordSubtaskAudit({ ...refreshed.subtaskAudit, experimentId: manifest.parent, runId: parentRun.id, refreshTrigger: "replication_completed", replicationExperimentId: id });
        resultStore.appendEvent("experiment.audit.refreshed", { experimentId: manifest.parent, runId: parentRun.id, trigger: "replication_completed", replicationExperimentId: id, accepted: refreshed.audit.accepted, subtaskAudit: refreshed.subtaskAudit });
      }
    }
    const trajectoryEvents: TrajectoryEvent[] = [
      { id: `${result.runId}-process`, kind: "process", payload: { status: recordedResult.status, exitCode: recordedResult.exitCode, failureClass: recordedResult.failureClass ?? null } },
      ...recoveryEvents,
      { id: `${result.runId}-evaluator`, kind: "evaluator", payload: { metric: recordedResult.metrics[activeAdapter().config.metric.name] ?? null, evidenceConsistent: recordedResult.status === "completed" } },
      { id: `${result.runId}-terminal`, kind: "terminal", payload: { status: recordedResult.status, goalAttained: recordedResult.status === "completed" && (manifest.outcomeType !== "metric" || recordedResult.metrics[activeAdapter().config.metric.name] !== undefined) } },
    ];
    const quality = evaluateTrajectory(trajectoryEvents);
    const experimentTrajectoryId = `trajectory_${result.runId}`;
    const experimentTrajectoryPayload = { goal: hypothesis?.payload ?? null, events: trajectoryEvents, manifest: entryPayload.manifest ?? null, verification: recordedResult.verification };
    resultStore.saveTrajectory({ id: experimentTrajectoryId, runId: result.runId, experimentId: id, payload: experimentTrajectoryPayload, quality });
    const experimentExperience = buildExperienceRecord({ trajectoryId: experimentTrajectoryId, payload: experimentTrajectoryPayload, quality });
    const priorExperiences = resultStore.trajectories(100).filter((entry) => entry.id !== experimentTrajectoryId).map((entry) => buildExperienceRecord({ trajectoryId: entry.id, payload: entry.payload, quality: entry.quality as ReturnType<typeof evaluateTrajectory> }));
    resultStore.appendEvent("research.experience.recorded", { experience: experimentExperience, capabilityProfile: capabilityProfile([...priorExperiences, experimentExperience]), curriculum: selectCurriculum([...priorExperiences, experimentExperience]), source: "experiment" });
    if (quality.overall !== "PASS") resultStore.appendEvent("trajectory.capability_gaps", { trajectoryId: `trajectory_${result.runId}`, gaps: Object.entries(quality).filter(([key, value]) => key !== "overall" && (value as { verdict: string }).verdict !== "PASS").map(([key, value]) => ({ dimension: key, verdict: (value as { verdict: string }).verdict, evidence: (value as { evidence: string[] }).evidence })) });
    resultStore.close();
    recordTransferableMethodIfReplicated(id);
    const metricName = activeAdapter().config.metric.name;
    return `\n\nExperiment ${id} ${recordedResult.status}\nRun: ${recordedResult.runId}\nExit code: ${recordedResult.exitCode}\nDuration: ${recordedResult.durationSeconds.toFixed(1)}s\nMetric (${metricName}): ${recordedResult.metrics[metricName] ?? "not parsed"}\nArtifacts: ${Object.keys(recordedResult.artifacts).join(", ")}\nFailure: ${recordedResult.failureClass ?? "none"}`;
    } catch (error) {
      activeProcess.current = null;
      activeSteer.current = null;
      const message = error instanceof Error ? error.message : String(error);
      const failedStore = new ResearchStore(join(root, ".sota", "database.sqlite"));
      const current = failedStore.experiments().find((candidate) => candidate.id === id);
      if (current) {
        const payload = current.payload && typeof current.payload === "object" ? current.payload as Record<string, unknown> : {};
        failedStore.saveExperiment({ id, payload: { ...payload, status: "failed", failure: message, failedAt: new Date().toISOString() } });
      }
      failedStore.appendEvent("experiment.failed", { experimentId: id, error: message });
      failedStore.close();
      throw error;
    }
  };

  const runAutonomousCycle = async (campaignOverride?: ResearchCampaign, autoContinue = false): Promise<void> => {
    const mode = configRef.current.mode;
    if (loopBusy.current || busy) return;
    let pendingCampaign = campaignOverride ?? config.campaign;
    if (pendingCampaign?.nextAttemptAt && Date.parse(pendingCampaign.nextAttemptAt) > Date.now()) return;
    // A provider-limit wait is represented as a durable pause. Resume it only
    // once the retry window has elapsed; otherwise the paused interval would
    // count against the campaign budget and the cycle would run with a stale
    // paused campaign object.
    if (pendingCampaign?.status === "paused" && pendingCampaign.nextAttemptAt && Date.parse(pendingCampaign.nextAttemptAt) <= Date.now()) {
      const resumed = { ...resumeCampaign(pendingCampaign), nextAttemptAt: undefined, limitMessage: undefined };
      pendingCampaign = resumed;
      campaignOverride = resumed;
      persistCampaign(resumed);
      configRef.current = { ...configRef.current, campaign: resumed };
      setConfig((current) => ({ ...current, campaign: resumed }));
    }
    ensureActiveProject();
    if (!acquireControllerLease(mode, "research")) return;
    loopBusy.current = true;
    setBusy(true); setProgress("Autonomous loop: choosing the next highest-information decision...");
    const store = new ResearchStore(join(root, ".sota", "database.sqlite"));
    store.requeueStaleTasks();
    store.setSchedulerState({ status: "running", mode, currentStep: "research" });
    const requestedAction = store.controllerLease()?.requestedAction;
    if (requestedAction === "pause" || requestedAction === "stop") {
      const saved = (campaignOverride ?? config.campaign) as ResearchCampaign | undefined;
      if (saved) {
        const updated = { ...saved, status: requestedAction === "stop" ? "completed" as const : "paused" as const };
        store.saveCampaign(updated);
        setConfig((current) => ({ ...current, campaign: updated }));
      }
      store.setSchedulerState({ status: requestedAction === "stop" ? "idle" : "paused", mode, currentStep: `requested-${requestedAction}` });
      store.close();
      releaseControllerLease();
      append("assistant", `Controller request applied: ${requestedAction}.`);
      return;
    }
    const staleExperiment = store.experiments().find((entry) => {
      const payload = entry.payload && typeof entry.payload === "object" ? entry.payload as { status?: unknown; stale?: unknown; recoveryAttempted?: unknown } : {};
      return payload.status === "failed" && payload.stale === true && payload.recoveryAttempted !== true;
    });
    if (staleExperiment) {
      const stalePayload = staleExperiment.payload && typeof staleExperiment.payload === "object" ? staleExperiment.payload as Record<string, unknown> : {};
      store.saveExperiment({ id: staleExperiment.id, payload: { ...stalePayload, status: "scheduled", recoveryAttempted: true, recoveryAttemptedAt: new Date().toISOString() } });
      store.appendEvent("experiment.recovery.scheduled", { experimentId: staleExperiment.id, reason: "controller restart", attempt: Number(stalePayload.recoveryAttempts ?? 0) + 1, policy: "one bounded retry of the immutable manifest" });
      store.close();
      setProgress(`Recovering stale experiment ${staleExperiment.id} (one bounded retry)...`);
      try {
        await executeExperiment(staleExperiment.id);
        const recoveryStore = new ResearchStore(join(root, ".sota", "database.sqlite"));
        const recoveredEntry = recoveryStore.experiments().find((entry) => entry.id === staleExperiment.id);
        const recoveredStatus = recoveredEntry?.payload && typeof recoveredEntry.payload === "object" ? (recoveredEntry.payload as { status?: unknown }).status : undefined;
        recoveryStore.appendEvent(recoveredStatus === "completed" ? "experiment.recovery.completed" : "experiment.recovery.failed", { experimentId: staleExperiment.id, status: recoveredStatus ?? "unknown" });
        if (recoveredStatus !== "completed" && recoveredEntry) {
          const recoveredPayload = recoveredEntry.payload && typeof recoveredEntry.payload === "object" ? recoveredEntry.payload as Record<string, unknown> : {};
          recoveryStore.saveExperiment({ id: staleExperiment.id, payload: { ...recoveredPayload, status: "failed", stale: false, recoveryAttempted: true } });
        }
        recoveryStore.close();
      } catch (error) {
        const recoveryStore = new ResearchStore(join(root, ".sota", "database.sqlite"));
        const recoveredEntry = recoveryStore.experiments().find((entry) => entry.id === staleExperiment.id);
        if (recoveredEntry) {
          const recoveredPayload = recoveredEntry.payload && typeof recoveredEntry.payload === "object" ? recoveredEntry.payload as Record<string, unknown> : {};
          recoveryStore.saveExperiment({ id: staleExperiment.id, payload: { ...recoveredPayload, status: "failed", stale: false, recoveryAttempted: true, recoveryError: error instanceof Error ? error.message : String(error) } });
        }
        recoveryStore.appendEvent("experiment.recovery.failed", { experimentId: staleExperiment.id, error: error instanceof Error ? error.message : String(error) });
        recoveryStore.close();
        append("assistant", `Recovery of stale experiment ${staleExperiment.id} failed; Evidra will replan from the recorded failure.`);
      }
    } else {
      store.close();
    }
    let queueTaskId: string | undefined;
    try {
      const campaign = campaignOverride ?? config.campaign;
      const cycleNumber = campaign?.currentCycle ?? 0;
      if (campaign) persistCampaignCheckpoint(campaign, "research-lanes", cycleNumber);
      if (campaign?.nextAttemptAt) {
        campaign.nextAttemptAt = undefined;
        campaign.limitMessage = undefined;
        persistCampaign(campaign);
        setConfig((current) => ({ ...current, campaign: { ...campaign } }));
      }
      if (campaign) {
        const elapsed = campaignElapsedMinutes(campaign);
        if (elapsed >= campaign.budgetMinutes) {
          campaign.status = "completed";
          persistCampaign(campaign);
          setConfig((current) => ({ ...current, campaign: { ...campaign, status: "completed" } }));
          const stopped = new ResearchStore(join(root, ".sota", "database.sqlite"));
          stopped.setSchedulerState({ status: "idle", mode, currentStep: "budget-exhausted" });
          stopped.close();
          append("assistant", `Autonomous research stopped: budget exhausted (${campaign.budgetMinutes} minutes).`);
          return;
        }
      }
      const objective = campaign
        ? `Work autonomously toward this ultimate research goal: ${campaign.goal}. Stop when this condition is met: ${campaign.stopCondition}. Continue through the active internal phase goal, gathering evidence and running safe local checks as needed.`
        : "Run the next zero-to-hero research cycle: inspect current state, identify the highest-information bottleneck, and propose one falsifiable experiment with explicit validation and replication criteria.";
      queueTaskId = `task_research_${Date.now()}`;
      const queueStore = new ResearchStore(join(root, ".sota", "database.sqlite"));
      queueStore.enqueueTask({ id: queueTaskId, kind: "research.cycle", priority: campaign ? 10 : 5, payload: { objective, campaign: campaign ?? null } });
      let cycle: Awaited<ReturnType<typeof runResearchCycle>> | undefined;
      const worker = new QueueWorker(queueStore, async (task) => {
        const payload = task.payload as { objective?: string; lastError?: unknown };
        const retryContext = typeof payload.lastError === "string" && payload.lastError
          ? `\n\nThis is bounded retry ${task.attempts}. The previous attempt failed with: ${payload.lastError}\nDo not blindly repeat the failed route; inspect the failure evidence and choose a different, lower-risk path if appropriate.`
          : "";
        if (retryContext) queueStore.appendEvent("research.cycle.retrying", { taskId: task.id, attempt: task.attempts, error: payload.lastError });
        cycle = await runResearchCycle(`${payload.objective ?? objective}${retryContext}`, campaign);
        return cycle;
      }, { concurrency: 1, maxAttempts: 3, kinds: ["research.cycle"] });
      await worker.runOnce();
      let queuedResult = queueStore.queueTasks().find((task) => task.id === queueTaskId);
      // runOnce intentionally does not block on delayed jobs. Drain this
      // bounded research task here so configured retries actually happen
      // before the controller declares the cycle blocked.
      while (!cycle && queuedResult?.status === "queued") {
        const retryAt = Date.parse(queuedResult.availableAt);
        const waitMs = Number.isFinite(retryAt) ? Math.max(0, retryAt - Date.now()) : 0;
        if (waitMs > 0) {
          setProgress(`Research retry ${queuedResult.attempts}/3 scheduled...`);
          await new Promise<void>((resolve) => setTimeout(resolve, Math.min(waitMs, 60_000)));
        }
        await worker.runOnce();
        queuedResult = queueStore.queueTasks().find((task) => task.id === queueTaskId);
      }
      await worker.stop();
      queueStore.close();
      if (!cycle) throw new Error(`Research queue task ${queueTaskId} did not produce a cycle (${queuedResult?.status ?? "missing"}).`);
      const update = new ResearchStore(join(root, ".sota", "database.sqlite"));
      update.setSchedulerState({ status: "running", mode, currentStep: "awaiting-next-cycle" });
      const recentDecisions = update.decisions().map((entry) => entry.payload as Awaited<ReturnType<typeof runResearchDirector>>).slice(0, 3);
      const stagnation = detectStagnation(recentDecisions);
      if (stagnation.stagnant && campaign) {
        campaign.status = "paused";
        persistCampaign(campaign);
        update.appendEvent("research.stagnation.detected", { cycles: stagnation.cycles, signature: stagnation.signature, action: "pause_for_review" });
        update.setSchedulerState({ status: "paused", mode, currentStep: "stagnation-review" });
        setConfig((current) => ({ ...current, campaign: { ...campaign } }));
        if (loopTimer.current) { clearInterval(loopTimer.current); loopTimer.current = null; }
        update.close();
        append("assistant", `Autonomous research paused after ${stagnation.cycles} unchanged active decisions. Review the bottleneck, then use /research resume.`);
        return;
      }
      update.close();
      const proposed = mode === "challenge" || campaign?.autoExecuteExperiments === true ? await proposeLatestExperiment() : null;
      if (campaign && proposed) persistCampaignCheckpoint(campaign, "experiment-execution", cycleNumber);
      append("assistant", cycle.text + (proposed?.text ?? ""));
      let approvalRequired = false;
      if (proposed && (mode === "challenge" || campaign?.autoExecuteExperiments === true)) {
        const permissionAllowsExecution = autonomyPolicy(config.autonomy).canRunIsolatedExperiments;
        if (!permissionAllowsExecution) {
          approvalRequired = true;
          append("assistant", `Approval required before autonomous execution. The manifest is ready: ${proposed.id}\nRun /experiment run ${proposed.id} to approve this specific experiment, or switch to /permissions fast/yolo for automatic isolated execution.`);
        } else {
          const experimentText = await executeExperiment(proposed.id);
          append("assistant", experimentText);
          if (/Experiment .* completed/i.test(experimentText)) {
            const comparison = latestExperimentComparison(proposed.id);
            if (comparison?.direction === "improved") {
              const ablations = prepareAutomaticAblations(proposed.id);
              if (ablations) {
                const ablationText = [ablations.text];
                if (permissionAllowsExecution) {
                  for (const ablationId of ablations.ids) ablationText.push(await executeExperiment(ablationId));
                } else {
                  ablationText.push(`Approval required: run /experiment run ${ablations.ids.join(" or ")}`);
                }
                append("assistant", ablationText.join("\n"));
              }
              const replication = prepareAutomaticReplication(proposed.id);
              if (replication) {
                if (!permissionAllowsExecution) append("assistant", `${replication.text}\nApproval required: run /experiment run ${replication.id}`);
                else append("assistant", `${replication.text}\n\n${await executeExperiment(replication.id)}`);
              }
            } else {
              append("assistant", `Replication skipped for ${proposed.id}: ${comparison?.direction ?? "no measured comparison"}${comparison?.note ? ` · ${comparison.note}` : ""}.`);
            }
          }
        }
      }
      if (approvalRequired && campaign) {
        const approvalStore = new ResearchStore(join(root, ".sota", "database.sqlite"));
        approvalStore.setSchedulerState({ status: "running", mode, currentStep: "approval-pending-research-continues" });
        approvalStore.appendEvent("research.autonomy.approval_required", { experimentId: proposed?.id, reason: "safe permission mode", next: `/experiment run ${proposed?.id}`, researchContinues: true });
        approvalStore.close();
        append("assistant", `Approval pending for ${proposed?.id ?? "the proposed experiment"}. Run /experiment run ${proposed?.id ?? "<proposal>"} when ready; research continues on other directions.`);
      }
      if (campaign && campaign.status === "running") {
        persistCampaignCheckpoint(campaign, "cycle-complete", cycleNumber + 1);
      }
      let openFalsificationCount = 0;
      if (campaign && cycle.decision === "stop") {
        const stopCheck = new ResearchStore(join(root, ".sota", "database.sqlite"));
        openFalsificationCount = researchMemoryContext(stopCheck, 30, campaign.goal).falsificationAgenda
          .filter((item) => item.status === "untested" || item.status === "inconclusive").length;
        if (openFalsificationCount > 0) stopCheck.appendEvent("research.stop_policy.continued", { reason: "open falsification agenda", openFalsifications: openFalsificationCount, source: "tui" });
        stopCheck.close();
      }
      if (campaign && !approvalRequired && cycle.decision === "stop" && openFalsificationCount === 0) {
        campaign.status = "completed";
        persistCampaign(campaign);
        setConfig((current) => ({ ...current, campaign: { ...campaign, status: "completed" } }));
        if (loopTimer.current) { clearInterval(loopTimer.current); loopTimer.current = null; }
        const stopped = new ResearchStore(join(root, ".sota", "database.sqlite"));
        stopped.setSchedulerState({ status: "idle", mode: config.mode, currentStep: "campaign-complete" });
        stopped.close();
        append("assistant", "Autonomous research stopping condition accepted by the research director.");
      } else if (campaign && !approvalRequired && cycle.decision === "stop" && openFalsificationCount > 0) {
        append("assistant", `Stopping deferred: ${openFalsificationCount} falsification test(s) remain open. Continuing autonomous research.`);
      } else if (campaign && cycle.goalStatus === "blocked") {
        campaign.status = "paused";
        persistCampaign(campaign);
        setConfig((current) => ({ ...current, campaign: pauseCampaign(campaign) }));
        if (loopTimer.current) { clearInterval(loopTimer.current); loopTimer.current = null; }
        const blocked = new ResearchStore(join(root, ".sota", "database.sqlite"));
        blocked.setSchedulerState({ status: "paused", mode: config.mode, currentStep: "blocked" });
        blocked.close();
        append("assistant", "Autonomous research paused because the current phase is blocked. Resolve the bottleneck, then use /resume.");
      }
      if (campaign?.status === "running" && autoContinue && !loopTimer.current) {
        loopTimer.current = setInterval(() => { void runAutonomousCycle(); }, 60_000);
        append("assistant", "Autonomous research will continue automatically. Use /loop pause or /loop stop to halt it.");
      }
    } catch (error) {
      const campaign = campaignOverride ?? config.campaign;
      if (campaign && isProviderUsageLimit(error) && (config.limitPolicy === "auto" || config.limitPolicy === "wait")) {
        const retryAfterMs = providerRetryAfterMs(error);
        const nextAttemptAt = new Date(Date.now() + retryAfterMs).toISOString();
        const waiting = { ...pauseCampaign(campaign), nextAttemptAt, limitMessage: error instanceof Error ? error.message : String(error) };
        persistCampaign(waiting);
        setConfig((current) => ({ ...current, campaign: waiting }));
        const waitingStore = new ResearchStore(join(root, ".sota", "database.sqlite"));
        waitingStore.setSchedulerState({ status: "paused", mode: config.mode, currentStep: `provider-limit-until-${nextAttemptAt}` });
        waitingStore.appendEvent("research.provider_limit.waiting", { retryAt: nextAttemptAt, retryAfterMs, provider: config.provider });
        waitingStore.close();
        if (!loopTimer.current) loopTimer.current = setInterval(() => { void runAutonomousCycle(); }, 60_000);
        append("assistant", `Provider usage limit reached. Research is paused safely and will retry at ${nextAttemptAt}. The campaign budget remains durable; use /loop stop to cancel waiting.`);
        return;
      }
      if (queueTaskId) { const queueStore = new ResearchStore(join(root, ".sota", "database.sqlite")); queueStore.updateTask(queueTaskId, "failed", { error: error instanceof Error ? error.message : String(error) }); queueStore.close(); }
      const update = new ResearchStore(join(root, ".sota", "database.sqlite"));
      update.setSchedulerState({ status: "paused", mode: config.mode, currentStep: "blocked" });
      update.close();
      append("assistant", error instanceof Error ? error.message : String(error));
      if (loopTimer.current) { clearInterval(loopTimer.current); loopTimer.current = null; }
    } finally {
      const finalCampaign = configRef.current.campaign;
      if (!autoContinue || !finalCampaign || finalCampaign.status !== "running" || !loopTimer.current) releaseControllerLease();
      loopBusy.current = false;
      setBusy(false); setProgress("");
    }
    };

  const submit = async (value: string, fromQueue = false): Promise<void> => {
    if (suppressNextSubmit.current) {
      suppressNextSubmit.current = false;
      return;
    }
    const pastedLines = value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    if (pastedLines.length > 1) {
      setInput("");
      for (const line of pastedLines) await submit(line);
      return;
    }
    const request = value.trim();
    setInput("");
    if (!request) return;
    if (busy && !fromQueue) {
      const dispatched = await activeSteer.current?.(request) ?? false;
      const queued = { id: `queued_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`, text: request, dispatched };
      pendingRequests.current.push(queued);
      setQueuedRequests([...pendingRequests.current]);
      return;
    }
    interruptedProcess.current = false;
    if (!fromQueue) append("user", request);
    if (setupStep) {
      if (request === "/cancel") {
        setSetupStep(null); setSetupDraft({}); append("assistant", "Autonomous research setup cancelled."); return;
      }
      if (setupStep === "goal") {
        setSetupDraft({ goal: request }); setSetupStep("budget");
        append("assistant", "Step 2/3 · What is the maximum budget? Examples: 120m, 4h, 2d. Five minutes is suitable only for a smoke test."); return;
      }
      if (setupStep === "budget") {
        const budgetMinutes = parseBudgetMinutes(request);
        if (!budgetMinutes) { append("assistant", "Please enter a positive budget such as 90m, 4h, or 2d."); return; }
        setSetupDraft((current) => ({ ...current, budgetMinutes })); setSetupStep("stop");
        append("assistant", "Step 3/3 · When should Evidra stop? Describe the success condition, or say ‘when the current research goal is met’."); return;
      }
        const campaign: ResearchCampaign = { goal: setupDraft.goal ?? "Advance the research project", budgetMinutes: setupDraft.budgetMinutes ?? 240, stopCondition: request, startedAt: new Date().toISOString(), status: "running", autoExecuteExperiments: true };
      ensureActiveProject(); persistCampaign(campaign); setConfig((current) => ({ ...current, campaign })); setSetupStep(null); setSetupDraft({});
      append("assistant", `Autonomous research started\n  Goal: ${campaign.goal}\n  Budget: ${campaign.budgetMinutes} minutes\n  Stop: ${campaign.stopCondition}\n\nI will define internal phase goals, inspect evidence, run permitted checks, and continue until the condition or budget is reached.`);
      setBusy(true); setProgress("Starting autonomous research...");
      try {
        await runAutonomousCycle(campaign, true);
      } catch (error) { appendError(error); }
      finally { setBusy(false); setProgress(""); }
      return;
    }
    if (request === "/exit" || request === "/quit") { exit(); return; }
    if (request === "/help") { append("assistant", help()); return; }
    if (request === "/workbench research" || request === "/mode research") {
      setConfig((current) => ({ ...current, mode: "research" }));
      append("assistant", "Research mode active. Natural-language prompts become research questions; challenge execution remains explicit.");
      return;
    }
    if (request === "/workbench challenge" || request === "/mode challenge") {
      setConfig((current) => ({ ...current, mode: "challenge" }));
      append("assistant", `Challenge mode active for ${activeAdapter().config.name}. Experiments and runs are now the primary workflow.`);
      return;
    }
    if (request === "/mode") {
      setPicker("mode");
      setPickerIndex(Math.max(0, modeChoices.indexOf(config.mode)));
      append("assistant", "Select mode with ↑/↓ and Enter. Research gathers evidence; Challenge runs experiments.");
      return;
    }
    if (request === "/mode" || request === "/workbench") {
      const store = new ResearchStore(join(root, ".sota", "database.sqlite"));
      const counts = store.counts();
      const activeGoal = activePhaseGoal(phaseGoalsForMode(store.phaseGoals().map((entry) => PhaseGoalSchema.parse(entry.payload)), config.mode));
      const recent = store.recentEvents(5).map((event) => `${event.type} · ${event.createdAt}`).join("\n") || "No events yet.";
      store.close();
      append("assistant", `Evidra Workbench\nMode: ${config.mode}\nAutonomy: ${config.autonomy}\n\nActive phase goal\n  ${activeGoal?.phase ?? "not initialized"}: ${activeGoal?.title ?? "Run /research to define goals"}\n  status: ${activeGoal?.status ?? "pending"}\n  attempts: ${activeGoal?.attempts ?? 0}\n\nResearch graph\n  hypotheses  ${counts.hypotheses}\n  claims      ${counts.claims}\n  edges       ${counts.edges}\n  sources     ${counts.sources}\n  decisions   ${counts.decisions}\n\nChallenge execution\n  experiments ${counts.experiments}\n  runs        ${counts.runs}\n  artifacts   ${counts.artifacts}\n\nRecent events\n${recent}\n\nUse /mode to switch modes or /permissions to change automation permissions.`);
      return;
    }
    if (request === "/experience" || request.startsWith("/experience ")) {
      const parts = request.split(/\s+/);
      if (parts[1] === "export") {
        const includeReplay = parts.includes("--include-replay");
        const requestedPath = parts.find((part, index) => index > 1 && part !== "--include-replay");
        const output = resolve(root, requestedPath ?? ".sota/experience.jsonl");
        const outputRelative = relative(root, output);
        if (outputRelative.startsWith("..") || outputRelative.startsWith("/") || outputRelative.includes("..")) { append("assistant", "Experience export path must stay inside the project root."); return; }
        const store = new ResearchStore(join(root, ".sota", "database.sqlite"));
        const byId = new Map(store.trajectories(1000).map((entry) => [entry.id, buildExperienceRecord({ trajectoryId: entry.id, payload: entry.payload, quality: entry.quality as ReturnType<typeof evaluateTrajectory> })]));
        for (const event of store.recentEvents(1000).reverse()) {
          if (event.type !== "research.experience.recorded") continue;
          const experience = (event.payload as { experience?: unknown }).experience;
          if (experience && typeof experience === "object" && typeof (experience as { trajectoryId?: unknown }).trajectoryId === "string") byId.set((experience as { trajectoryId: string }).trajectoryId, experience as ReturnType<typeof buildExperienceRecord>);
        }
        const records = [...byId.values()];
        store.close();
        mkdirSync(dirname(output), { recursive: true });
        const content = experienceJsonl(records, includeReplay);
        writeFileSync(output, content);
        append("assistant", `Exported ${content ? content.trimEnd().split("\\n").length : 0} experience record(s)\n  path: ${output}\n  replay failures: ${includeReplay ? "included" : "excluded"}`);
        return;
      }
      const store = new ResearchStore(join(root, ".sota", "database.sqlite"));
      const records = store.trajectories(100).map((entry) => buildExperienceRecord({ trajectoryId: entry.id, payload: entry.payload, quality: entry.quality as ReturnType<typeof evaluateTrajectory> }));
      const profile = capabilityProfile(records);
      const curriculum = selectCurriculum(records);
      store.close();
      append("assistant", `Experience ledger\n  total: ${profile.total}\n  eligible: ${profile.eligible}\n  replay-only: ${records.filter((item) => item.admission === "replay-only").length}\n  quarantined: ${profile.quarantined}\n\nCapability demand\n  C0 ${profile.byTier.C0} · C1 ${profile.byTier.C1} · C2 ${profile.byTier.C2} · C3 ${profile.byTier.C3}\n\nOutcomes\n  success ${profile.byOutcome.success} · partial ${profile.byOutcome.partial} · failure ${profile.byOutcome.failure}\n\nNext curriculum\n${curriculum.map((stage) => `  Stage ${stage.stage}: ${stage.trajectoryIds.join(", ") || "none"}\n    ${stage.rationale}`).join("\n") || "  No experiences recorded yet."}`);
      return;
    }
    if (request === "/thinking" || request.startsWith("/thinking ")) {
      const level = request.split(/\s+/)[1];
      if (!level) append("assistant", `Thinking effort: ${config.reasoningEffort}\nUse /thinking ${reasoningChoices.join(", ")}.`);
      else if (!reasoningChoices.some((value) => value === level)) append("assistant", `Unsupported effort for ${config.model}. Choose: ${reasoningChoices.join(", ")}.`);
      else { setConfig((current) => ({ ...current, reasoningEffort: level })); append("assistant", `Thinking effort selected: ${level}`); }
      return;
    }
    if (request === "/limits" || request.startsWith("/limits ")) {
      const policy = request.split(/\s+/)[1] as LimitPolicy | undefined;
      if (!policy) {
        append("assistant", `Provider limit policy: ${config.limitPolicy}\nFallback model: ${config.fallbackModel}\nUse /limits auto, /limits wait, /limits fallback, or /limits stop.`);
      } else if (!["auto", "wait", "fallback", "stop"].includes(policy)) {
        append("assistant", "Choose auto, wait, fallback, or stop.");
      } else {
        setConfig((current) => ({ ...current, limitPolicy: policy }));
        append("assistant", policy === "auto" ? `Provider limit policy selected: auto (local/${config.fallbackModel}, then wait).` : policy === "fallback" ? `Provider limit policy selected: fallback to local/${config.fallbackModel}.` : `Provider limit policy selected: ${policy}.`);
      }
      return;
    }
    if (request === "/autonomy" || request.startsWith("/autonomy ") || request === "/permissions" || request.startsWith("/permissions ")) {
      const level = request.split(/\s+/)[1] as AutonomyLevel | undefined;
      if (!level) {
        setPicker("permissions");
        setPickerIndex(Math.max(0, permissionChoices.indexOf(config.autonomy)));
        append("assistant", "Select permissions with ↑/↓ and Enter. SAFE requires approval for experiments; FAST runs isolated experiments automatically; YOLO runs the full routine experiment loop. Destructive commands and external submission remain blocked in every mode.");
      }
      else if (!["safe", "fast", "yolo"].includes(level)) append("assistant", "Choose safe, fast, or yolo.");
      else { setConfig((current) => ({ ...current, autonomy: level })); append("assistant", `Permissions selected: ${level}`); }
      return;
    }
    if (request === "/sessions" || request.startsWith("/resume")) {
      const store = new ResearchStore(join(root, ".sota", "database.sqlite"));
      if (request === "/sessions") {
        const sessions = store.sessions(20).filter((session) => session.id !== sessionId.current);
        store.close();
        append("assistant", sessions.length ? `Saved sessions\n${sessions.map((session) => `- ${session.id} · ${session.status} · ${session.startedAt}`).join("\n")}` : "No previous sessions saved yet.");
        return;
      }
      const requestedId = request.split(/\s+/)[1];
      const saved = requestedId ? store.session(requestedId) : store.sessions(20).find((session) => session.id !== sessionId.current && session.status !== "active");
      store.close();
      if (!saved) { append("assistant", "No saved session found. Use /sessions to list resumable sessions."); return; }
      const payload = saved.payload as { config?: Partial<SessionConfig>; messages?: Message[] };
      const resumedMessages = Array.isArray(payload.messages) ? payload.messages : [];
      const resumedConfig = { ...config, ...(payload.config ?? {}), autonomy: config.autonomy } as SessionConfig;
      activeCodexThread.current = resumedConfig.provider === "codex" ? resumedConfig.codexThreadId : undefined;
      setMessages([...resumedMessages, { role: "system", text: `Resumed ${saved.id} · permissions remain ${config.autonomy.toUpperCase()} for this terminal.` }]);
      setConfig(resumedConfig);
      const campaign = resumedConfig.campaign;
      if (campaign) {
        const activeCampaign = { ...campaign, status: "running" } as ResearchCampaign;
        persistCampaign(activeCampaign);
        setConfig((current) => ({ ...current, campaign: activeCampaign }));
        setTimeout(() => { void runAutonomousCycle(activeCampaign, true); }, 0);
      }
      return;
    }
    const steerMatch = request.match(/^\/(?:research|challenge|steer)\s+steer\s+(.+)$/) ?? request.match(/^\/steer\s+(.+)$/);
    if (steerMatch) {
      const store = new ResearchStore(join(root, ".sota", "database.sqlite"));
      const queued = store.enqueueControllerSteer(steerMatch[1]);
      store.close();
      append("assistant", queued ? `Steering instruction queued · will be applied at the next safe cycle boundary (id ${queued.id}).` : "No live campaign controller is running. Start or resume a campaign before steering it.");
      return;
    }
    if (["/challenge pause", "/challenge resume", "/challenge stop", "/challenge status", "/research pause", "/research resume", "/research stop", "/research status"].includes(request)) {
      const action = request.split(/\s+/)[1];
      const lifecycleMode = request.startsWith("/challenge") ? "challenge" : "research";
      const store = new ResearchStore(join(root, ".sota", "database.sqlite"));
      const saved = store.campaign() as ResearchCampaign | undefined;
      if (action === "status") {
        const scheduler = store.schedulerState();
        const lease = store.liveControllerLease();
        store.close();
        append("assistant", saved ? `${lifecycleMode === "challenge" ? "Challenge" : "Research"} campaign\n  status: ${saved.status}\n  goal: ${saved.goal}\n  budget: ${saved.budgetMinutes} minutes\n  autonomous experiments: ${saved.autoExecuteExperiments ? "enabled" : "approval-gated"}\n  scheduler: ${scheduler.status}\n  step: ${scheduler.currentStep ?? "idle"}` : `No ${lifecycleMode} campaign exists. Use /${lifecycleMode} start.`);
        if (lease) append("assistant", `Controller: running · pid ${lease.pid} · step ${lease.currentStep ?? "unknown"}`);
        return;
      }
      if (!saved) { store.close(); append("assistant", `No ${lifecycleMode} campaign exists. Use /${lifecycleMode} start.`); return; }
      if (action === "resume" && saved.status === "completed") {
        store.close();
        append("assistant", `${lifecycleMode === "challenge" ? "Challenge" : "Research"} campaign is completed/stopped. Start a new campaign with /${lifecycleMode} start.`);
        return;
      }
      if (action === "pause") {
        pauseActiveProcesses();
        if (loopTimer.current) { clearInterval(loopTimer.current); loopTimer.current = null; }
        const paused = pauseCampaign(saved);
        store.saveCampaign(paused); store.setSchedulerState({ status: "paused", mode: lifecycleMode, currentStep: "paused" }); store.close();
        releaseControllerLease();
        setConfig((current) => ({ ...current, mode: lifecycleMode, campaign: paused }));
        append("assistant", `${lifecycleMode === "challenge" ? "Challenge" : "Research"} paused. Active workers are paused and the campaign is resumable.`);
        return;
      }
      if (action === "stop") {
        terminateActiveProcesses();
        if (loopTimer.current) { clearInterval(loopTimer.current); loopTimer.current = null; }
        const stopped = { ...saved, status: "completed" as const };
        store.saveCampaign(stopped); store.setSchedulerState({ status: "idle", mode: lifecycleMode, currentStep: "stopped" }); store.close();
        releaseControllerLease();
        setConfig((current) => ({ ...current, mode: lifecycleMode, campaign: stopped }));
        append("assistant", `${lifecycleMode === "challenge" ? "Challenge" : "Research"} stopped. It remains saved for inspection, but will not resume automatically.`);
        return;
      }
      const resumed = { ...resumeCampaign(saved), nextAttemptAt: undefined, limitMessage: undefined };
      store.saveCampaign(resumed); store.setSchedulerState({ status: "running", mode: lifecycleMode, currentStep: "resuming" }); store.close();
      setConfig((current) => ({ ...current, mode: lifecycleMode, campaign: resumed }));
      append("assistant", `${lifecycleMode === "challenge" ? "Challenge" : "Research"} resumed. Evidra will continue from the latest durable phase, evidence, and experiment state.`);
      setTimeout(() => { void runAutonomousCycle(resumed, true); }, 0);
      return;
    }
    if (request === "/pause" || request === "/resume") {
      if (request === "/pause") pauseActiveProcesses();
      if (request === "/resume") resumeActiveProcesses();
      if (request === "/pause" && loopTimer.current) { clearInterval(loopTimer.current); loopTimer.current = null; }
      const store = new ResearchStore(join(root, ".sota", "database.sqlite"));
      store.setSchedulerState({ status: request === "/pause" ? "paused" : "running", mode: config.mode, currentStep: null });
      store.close();
      if (config.campaign) {
        const campaign = { ...config.campaign, status: request === "/pause" ? "paused" : "running" } as ResearchCampaign;
        persistCampaign(campaign);
        setConfig((current) => ({ ...current, campaign }));
        if (request === "/resume" && !loopTimer.current) {
          void runAutonomousCycle(campaign, true);
        }
      }
      append("assistant", request === "/pause" ? "Scheduling paused. Running jobs are unchanged." : "Scheduling resumed.");
      return;
    }
    if (request === "/research start") {
      if (config.campaign?.status === "running") { append("assistant", "An autonomous research campaign is already running. Use /research status or /research pause."); return; }
      setConfig((current) => ({ ...current, mode: "research" }));
      setSetupDraft({}); setSetupStep("goal");
      append("assistant", "Autonomous research setup · Step 1/3\nWhat is the ultimate research goal?\n\nEvidra will implement, test, and evaluate isolated research candidates until your stopping condition or budget is reached. Use /research pause, /research resume, or /research stop at any time.");
      return;
    }
    if (request === "/loop" || request.startsWith("/loop ") || request === "/scheduler" || request.startsWith("/scheduler ")) {
      const [command, action = "status"] = request.split(/\s+/);
      const store = new ResearchStore(join(root, ".sota", "database.sqlite"));
      if (command === "/scheduler") {
        if (!["start", "pause", "drain"].includes(action)) {
          append("assistant", `Scheduler: ${store.schedulerState().status}\nUse /scheduler start, /scheduler pause, or /scheduler drain.`);
        } else {
          const status = action === "start" ? "running" : action === "pause" ? "paused" : "draining";
          store.setSchedulerState({ status, mode: config.mode, currentStep: null });
          append("assistant", `Scheduler ${status}.`);
        }
        store.close();
        return;
      }
      if (action === "status") {
        const state = store.schedulerState();
        append("assistant", `Autonomous loop\n  status: ${state.status}\n  mode: ${state.mode}\n  step: ${state.currentStep ?? "idle"}\n  updated: ${state.updatedAt}\n\nUse /loop once for one cycle, /loop start to arm it, or /loop stop.`);
        store.close();
        return;
      }
      if (["stop", "pause"].includes(action)) {
        const status = action === "stop" ? "idle" : "paused";
        if (loopTimer.current) { clearInterval(loopTimer.current); loopTimer.current = null; }
        store.setSchedulerState({ status, mode: config.mode, currentStep: null });
        if (config.campaign) {
          const campaign = pauseCampaign(config.campaign);
          store.saveCampaign(campaign);
          setConfig((current) => ({ ...current, campaign }));
        }
        store.close();
        append("assistant", `Autonomous loop ${status}.`);
        return;
      }
      if (!["once", "start"].includes(action)) {
        store.close();
        append("assistant", "Use /loop status, /loop once, /loop start, /loop pause, or /loop stop.");
        return;
      }
      store.close();
      await runAutonomousCycle();
      if (action === "start" && !loopTimer.current) {
        loopTimer.current = setInterval(() => { void runAutonomousCycle(); }, 60_000);
        append("assistant", "Autonomous loop started. It will evaluate the next decision every 60 seconds. Use /loop pause or /loop stop to halt it.");
      }
      return;
    }
    if (request === "/hero" || request === "/hero status") {
      const store = new ResearchStore(join(root, ".sota", "database.sqlite"));
      const project = store.project();
      const state = store.schedulerState();
      const counts = store.counts();
      store.close();
      append("assistant", `Zero-to-hero\n  project: ${project?.name ?? "not initialized"}\n  challenge: ${activeAdapter().config.name}\n  loop: ${state.status}\n  hypotheses: ${counts.hypotheses}\n  experiments: ${counts.experiments}\n  runs: ${counts.runs}\n\nUse /hero start to initialize, reproduce the baseline, and generate the first research decision.`);
      return;
    }
    if (request === "/hero stop") {
      const store = new ResearchStore(join(root, ".sota", "database.sqlite"));
      store.setSchedulerState({ status: "idle", mode: "challenge", currentStep: null });
      store.close();
      append("assistant", "Zero-to-hero loop stopped. Evidence and artifacts are preserved.");
      return;
    }
    if (request === "/hero start") {
      setBusy(true); setProgress("Zero-to-hero: initializing the active workspace...");
      try {
        const adapter = activeAdapter();
        requireActiveContract();
        const projectDir = join(root, "competitions", adapter.id);
        mkdirSync(join(projectDir, "experiments"), { recursive: true });
        mkdirSync(join(projectDir, "reports"), { recursive: true });
        mkdirSync(join(projectDir, "submissions"), { recursive: true });
        mkdirSync(join(root, ".sota"), { recursive: true });
        const configFile = join(projectDir, "competition.json");
        if (!existsSync(configFile)) writeFileSync(configFile, `${JSON.stringify(adapter.config, null, 2)}\n`);
        const store = new ResearchStore(join(root, ".sota", "database.sqlite"));
        if (!store.project()) store.createProject({ id: `evidra-${adapter.id}`, name: adapter.config.name, competitionId: adapter.id, config: adapter.config });
        store.setSchedulerState({ status: "running", mode: "challenge", currentStep: "baseline" });
        store.close();
        setConfig((current) => ({ ...current, mode: "challenge" }));
        const baseline = await runProcess(adapter.baselineCommand(), adapter.workspacePath(root), adapter.config.evaluatorTimeoutMinutes * 60_000);
        const baselineStore = new ResearchStore(join(root, ".sota", "database.sqlite"));
        const parsed = parseMetricOutput(baseline.stdout, adapter.config.metric.name);
        const metric = parsed.metrics[adapter.config.metric.name] ?? null;
        recordBaselineEvidence(baselineStore, root, baseline, metric, parsed.metrics, parsed.metricsByFold);
        baselineStore.setSchedulerState({ status: "running", mode: "challenge", currentStep: "research" });
        baselineStore.close();
        setProgress("Zero-to-hero: generating the first falsifiable research decision...");
        appendTool(`Baseline ${baseline.exitCode === 0 ? "completed" : "failed"}.\n${baseline.stdout || baseline.stderr}`);
        const decisionText = (await runResearchCycle("Starting from the verified baseline, identify the first highest-information experiment. Include a falsification test, leakage risks, compute estimate, and replication plan.")).text;
        const proposed = await proposeLatestExperiment();
        append("assistant", decisionText + (proposed?.text ?? ""));
        if (proposed) {
          if (!autonomyPolicy(config.autonomy).canRunIsolatedExperiments) append("assistant", `Approval required before autonomous execution. Run /experiment run ${proposed.id} to approve it.`);
          else append("assistant", await executeExperiment(proposed.id));
        }
        const done = new ResearchStore(join(root, ".sota", "database.sqlite"));
        done.setSchedulerState({ status: "idle", mode: "challenge", currentStep: null });
        done.close();
      } catch (error) {
        append("assistant", error instanceof Error ? error.message : String(error));
      } finally { setBusy(false); setProgress(""); }
      return;
    }
    if (request.startsWith("/provider")) {
      const provider = request.split(/\s+/)[1] as AgentProvider | undefined;
      if (!provider) append("assistant", `Provider: ${config.provider}\nModel: ${config.model}\nUse /provider codex or /provider local.`);
      else if (provider !== "codex" && provider !== "local") append("assistant", "Choose codex or local.");
      else {
        activeCodexThread.current = undefined;
        setConfig((current) => ({
          ...current,
          provider,
          codexThreadId: undefined,
          model: provider === "local"
            ? (current.provider === "local" ? current.model : "qwen3.6:27b")
            : (current.provider === "codex" ? current.model : DEFAULT_CODEX_MODEL),
        }));
        setOnboardingComplete(true);
        append("assistant", `Provider selected: ${provider}`);
      }
      return;
    }
    if (request.startsWith("/model")) {
      const model = request.split(/\s+/)[1];
      if (!model) {
        if (availableModels.length) {
          setPicker("model");
          setPickerIndex(Math.max(0, availableModels.findIndex((entry) => entry.id === config.model)));
          append("assistant", `Choose a ${config.provider} model with ↑/↓ and Enter. Esc cancels.`);
        } else {
          append("assistant", `Provider: ${config.provider}\nModel: ${config.model}\n${modelLoadError ?? "No models loaded yet. Type /model again in a moment."}`);
        }
      }
      else {
        const available = availableModels.find((entry) => entry.id === model);
        if (availableModels.length && !available) {
          append("assistant", `Model '${model}' is not available for ${config.provider}. Use /model to choose from the loaded models.`);
          return;
        }
        activeCodexThread.current = undefined;
        setSelectedModel(available ?? null);
        setConfig((current) => ({ ...current, model, codexThreadId: undefined }));
        append("assistant", `Model selected: ${model}`);
      }
      return;
    }
    if (request === "/login codex" || request === "/login codex device" || request === "/login codex browser") {
      const mode = request.endsWith("browser") ? "browser" : "device";
      setBusy(true); setProgress(mode === "device" ? "Starting device-code login..." : "Opening browser login...");
      const wasRaw = Boolean(process.stdin.isTTY && process.stdin.isRaw);
      try {
        // Ink normally puts stdin in raw mode. Codex needs normal terminal input
        // while its own login UI is running.
        if (wasRaw) process.stdin.setRawMode?.(false);
        process.stdin.resume();
        const status = await loginCodex(mode, registerProcess);
        if (status === 0) {
          activeCodexThread.current = undefined;
          setConfig((current) => ({ ...current, provider: "codex", model: current.provider === "codex" ? current.model : DEFAULT_CODEX_MODEL, codexThreadId: undefined }));
          void listCodexModels()
            .then((models) => { setAvailableModels(models); setModelLoadError(models.length ? null : "Codex returned no selectable models. Check the Codex account, then try /model again."); })
            .catch(() => { setAvailableModels([]); setModelLoadError("Codex login succeeded, but the model list is unavailable. Try /model again."); });
          setOnboardingComplete(true);
          append("assistant", "Codex login completed. Evidra is ready.");
        } else append("assistant", "Codex login did not complete. Setup remains available; run /login codex again when ready.");
      } finally {
        if (wasRaw) process.stdin.setRawMode?.(true);
        setBusy(false); setProgress("");
      }
      return;
    }
    if (request === "/login status") { append("assistant", codexLoginStatus() || "No Codex login status returned."); return; }
    if (request.startsWith("!")) {
      const rawCommand = request.slice(1).trim();
      const command = splitCommandLine(rawCommand);
      if (!rawCommand) { append("assistant", "Usage: !ls -la or !rg -n hypothesis src"); return; }
      const guard = guardCommand(command);
      if (!guard.allowed) { append("assistant", `${guard.reason} Use a reviewed experiment manifest for destructive operations.`); return; }
      setBusy(true); setProgress(`Running !${rawCommand}...`);
      try {
        const result = await runProcess(["sh", "-lc", rawCommand], root, 15 * 60_000, (stream, chunk) => {
          const line = chunk.replace(/\s+/g, " ").trim();
          if (line) setProgress(`${stream}: ${line.slice(-140)}`);
        }, registerProcess);
        const output = [result.stdout.trim(), result.stderr.trim() ? `stderr:\n${result.stderr.trim()}` : ""].filter(Boolean).join("\n");
        appendTool(`Command exited ${result.exitCode} in ${(result.durationMs / 1000).toFixed(1)}s\n$ ${rawCommand}\n${output || "(no output)"}`);
      } catch (error) { appendError(error); }
      finally { activeProcess.current = null; setBusy(false); setProgress(""); }
      return;
    }
    if (request === "/project" || request === "/project status" || request === "/project inspect") {
      const store = new ResearchStore(join(root, ".sota", "database.sqlite"));
      const project = store.project();
      store.close();
      append("assistant", request.endsWith("inspect") ? JSON.stringify(project?.config ?? null, null, 2) : project
        ? `Project: ${project.name}\nWorkspace: ${project.competitionId}`
        : "No project initialized. Use /research to begin, /project init <workspace>, or evidra init <workspace>.");
      return;
    }
    if (request.startsWith("/project init") || request.startsWith("/challenge init")) {
      if (request.startsWith("/challenge init")) setConfig((current) => ({ ...current, mode: "challenge" }));
      const competitionId = request.split(/\s+/)[2] ?? "local-research";
      let adapter;
      try { adapter = loadCompetitionAdapter(root, competitionId); }
      catch (error) { appendError(error); return; }
      const projectDir = join(root, "competitions", adapter.id);
      mkdirSync(join(projectDir, "experiments"), { recursive: true });
      mkdirSync(join(projectDir, "reports"), { recursive: true });
      mkdirSync(join(projectDir, "submissions"), { recursive: true });
      mkdirSync(join(root, ".sota"), { recursive: true });
      const configFile = join(projectDir, "competition.json");
      if (!existsSync(configFile)) writeFileSync(configFile, `${JSON.stringify(adapter.config, null, 2)}\n`);
      const store = new ResearchStore(join(root, ".sota", "database.sqlite"));
      if (!store.project()) store.createProject({ id: `evidra-${adapter.id}`, name: adapter.config.name, competitionId: adapter.id, config: adapter.config });
      store.close();
      append("assistant", `Initialized ${adapter.config.name}. Next: /challenge baseline or /hero start.`);
      return;
    }
    if (request === "/usage") {
      const store = new ResearchStore(join(root, ".sota", "database.sqlite"));
      const counts = store.counts(); const events = store.eventCount(); const state = store.schedulerState(); const campaign = config.campaign; const usage = summarizeUsage(store.runs(), store.experiments()); const gpuUsed = observedGpuHours(store.runAttempts(), store.experiments(), store.hypotheses()); const gpuReserved = store.reservedComputeGpuHours();
      const agentUsage = summarizeAgentUsage(store.eventsByType("research.agent.usage"));
      store.close();
      const elapsed = campaign ? campaignElapsedMinutes(campaign) : 0;
      const executorUsage = Object.entries(usage.byExecutor).map(([executor, bucket]) => `  ${executor}: ${bucket.runs} runs · ${bucket.wallMinutes.toFixed(1)}m · ${bucket.gpuWallHours.toFixed(3)} GPU-h`).join("\n");
      append("assistant", `Usage\n  provider: ${config.provider}\n  model: ${config.model}\n  thinking: ${config.reasoningEffort}\n  scheduler: ${state.status}\n  events: ${events}\n  hypotheses: ${counts.hypotheses} · claims: ${counts.claims} · decisions: ${counts.decisions}\n  experiments: ${counts.experiments} · runs: ${counts.runs} · attempts: ${counts.attempts} · artifacts: ${counts.artifacts}\n  run wall time: ${usage.wallMinutes.toFixed(1)} minutes\n  GPU-tagged wall time: ${usage.gpuWallHours.toFixed(3)} hours\n  GPU reserved: ${gpuReserved.toFixed(3)} hours${executorUsage ? `\n${executorUsage}` : ""}\n${campaign ? `\nCampaign\n  status: ${campaign.status}\n  elapsed: ${elapsed.toFixed(1)} / ${campaign.budgetMinutes} minutes\n  remaining: ${Math.max(0, campaign.budgetMinutes - elapsed).toFixed(1)} minutes\n  GPU committed: ${(gpuUsed + gpuReserved).toFixed(3)} / ${campaign.gpuBudgetHours && campaign.gpuBudgetHours > 0 ? `${campaign.gpuBudgetHours} hours` : "unlimited"}${campaign.gpuBudgetHours && campaign.gpuBudgetHours > 0 ? ` (${Math.max(0, campaign.gpuBudgetHours - gpuUsed - gpuReserved).toFixed(3)} available)` : ""}\n  goal: ${campaign.goal}\n  stop: ${campaign.stopCondition}${campaign.nextAttemptAt ? `\n  provider retry: ${campaign.nextAttemptAt}` : ""}` : "\nNo autonomous campaign configured. Start one with /research."}`);
      append("assistant", `Agent usage\n  calls: ${agentUsage.calls}\n  tokens: ${agentUsage.inputTokens + agentUsage.outputTokens} (${agentUsage.inputTokens} in / ${agentUsage.outputTokens} out)`);
      append("assistant", `Codex accounting\n  cached input: ${agentUsage.cachedInputTokens}\n  cache written: ${agentUsage.cacheWriteInputTokens}\n  reasoning output: ${agentUsage.reasoningOutputTokens}`);
      return;
    }
    if (request === "/telemetry export") {
      const store = new ResearchStore(join(root, ".sota", "database.sqlite"));
      const project = store.project();
      const output = { format: "mlflow", version: 1, project: project?.name ?? "evidra", runs: buildMlflowRunExports(store.runs(), store.experiments(), store.artifacts(), project?.name ?? "evidra") };
      store.close();
      append("assistant", JSON.stringify(output, null, 2));
      return;
    }
    if (request.startsWith("/benchmark literature-score")) {
      const file = request.replace(/^\/benchmark literature-score\s*/, "").trim();
      if (!file) { append("assistant", "Usage: /benchmark literature-score <json-file>"); return; }
      try {
        const parsed: unknown = JSON.parse(readFileSync(resolve(root, file), "utf8"));
        const input = parseLiteratureBenchmarkInput(parsed);
        const report = scoreLiteratureBenchmark(input.tasks, input.observations);
        const store = new ResearchStore(join(root, ".sota", "database.sqlite"));
        store.appendEvent("literature.benchmark.completed", { source: resolve(root, file), report });
        store.close();
        append("assistant", `Literature benchmark · ${report.valid ? "VALID" : "INCOMPLETE"}\nMean score: ${report.meanScore === null ? "n/a" : report.meanScore.toFixed(3)}\nDeep recall: ${report.deepRecall === null ? "n/a" : `${(report.deepRecall * 100).toFixed(1)}%`}\nWide recall: ${report.wideRecall === null ? "n/a" : `${(report.wideRecall * 100).toFixed(1)}%`}\nGrounding: ${report.meanGroundingRate === null ? "n/a" : `${(report.meanGroundingRate * 100).toFixed(1)}%`}\nQuery efficiency: ${report.meanQueryEfficiency === null ? "n/a" : report.meanQueryEfficiency.toFixed(3)}${report.tasks.some((task) => task.reasons.length) ? `\n\n${report.tasks.filter((task) => task.reasons.length).map((task) => `- ${task.taskId}: ${task.reasons.join("; ")}`).join("\n")}` : ""}`);
      } catch (error) { appendError(error); }
      return;
    }
    if (request.startsWith("/benchmark autoresearch")) {
      const file = request.replace(/^\/benchmark autoresearch\s*/, "").trim();
      if (!file) { append("assistant", "Usage: /benchmark autoresearch <evaluation-json>"); return; }
      try {
        const parsed: unknown = JSON.parse(readFileSync(resolve(root, file), "utf8"));
        const report = parseAutoResearchBenchEvaluation(parsed);
        const store = new ResearchStore(join(root, ".sota", "database.sqlite"));
        store.appendEvent("literature.autoresearchbench.completed", { source: resolve(root, file), report });
        store.close();
        append("assistant", `AutoResearchBench · ${report.source.toUpperCase()} · ${report.records} records\n${Object.entries(report.metrics).map(([name, score]) => `${name}: ${score < 1 ? score.toFixed(4) : score.toFixed(2)}`).join("\n")}\n\nImported as diagnostic benchmark evidence; it does not replace workspace evaluator proof.`);
      } catch (error) { appendError(error); }
      return;
    }
    if (request === "/status" || request === "/project status") {
      const store = new ResearchStore(join(root, ".sota", "database.sqlite"));
      const project = store.project();
      const campaign = config.campaign;
      const integrity = store.verifyEventChain();
      const eventCount = store.eventCount();
      const gpuUsed = observedGpuHours(store.runAttempts(), store.experiments(), store.hypotheses()); const gpuReserved = store.reservedComputeGpuHours();
      append("assistant", project ? `Project: ${project.name}\nWorkspace: ${project.competitionId}\nMode: ${config.mode}\nAutonomy: ${config.autonomy}\nEvents: ${eventCount}\nIntegrity: ${integrity.status.toUpperCase()}${integrity.legacy ? ` (${integrity.legacy} legacy)` : ""}${campaign ? `\nCampaign: ${campaign.status}\nGoal: ${campaign.goal}\nBudget: ${campaign.budgetMinutes} minutes\nGPU committed: ${(gpuUsed + gpuReserved).toFixed(3)} / ${campaign.gpuBudgetHours && campaign.gpuBudgetHours > 0 ? `${campaign.gpuBudgetHours} hours` : "unlimited"}${campaign.gpuBudgetHours && campaign.gpuBudgetHours > 0 ? ` (${Math.max(0, campaign.gpuBudgetHours - gpuUsed - gpuReserved).toFixed(3)} available)` : ""}\nStop: ${campaign.stopCondition}${campaign.nextAttemptAt ? `\nProvider retry: ${campaign.nextAttemptAt}` : ""}` : ""}` : "No Evidra project initialized. Start with /research to configure an autonomous campaign.");
      store.close();
      return;
    }
    const challengeSubcommand = request.split(/\s+/)[1] ?? "";
    if (request.startsWith("/challenge ") && (challengeSubcommand === "start" || !["status", "list", "inspect", "audit", "policy", "baseline", "init"].includes(challengeSubcommand))) {
      const challengeUrl = request.match(/https?:\/\/\S+/)?.[0];
      const goal = challengeSubcommand === "start"
        ? "Win the active challenge with a reproducible, generalizing solution"
        : request.replace(/^\/challenge\s+/, "").replace(challengeUrl ?? "", "").replace(/\s+/g, " ").trim() || "Win the active challenge with a reproducible, generalizing solution";
      const nextConfig = { ...configRef.current, mode: "challenge" as const };
      configRef.current = nextConfig;
      setConfig(nextConfig);
      setBusy(true); setProgress("Challenge setup · preparing Evidra research workspace...");
      try {
        ensureActiveProject();
        const adapter = activeAdapter();
        const ingested = await ingestCompetitionSources(adapter);
        if (challengeUrl) {
          const store = new ResearchStore(join(root, ".sota", "database.sqlite"));
          const known = new Set(store.sources().map((entry) => (entry.payload as { url?: string }).url).filter(Boolean));
          store.close();
          if (!known.has(challengeUrl)) {
            setProgress(`Challenge research · retrieving ${new URL(challengeUrl).hostname}...`);
            const source = await retrieveSource(challengeUrl);
            const storeWithLink = new ResearchStore(join(root, ".sota", "database.sqlite"));
            storeWithLink.saveSource({ id: source.id, payload: { ...source, claims: sourceClaims(source.text) } });
            storeWithLink.appendEvent("challenge.link.attached", { url: challengeUrl, title: source.title });
            storeWithLink.close();
          }
        }
        const campaign: ResearchCampaign = { goal, budgetMinutes: 240, stopCondition: "stop when the evaluator-backed score is materially improved and the result survives independent replication", startedAt: new Date().toISOString(), status: "running", autoExecuteExperiments: true };
        persistCampaign(campaign);
        setConfig((current) => ({ ...current, campaign }));
        append("assistant", `Challenge campaign started\n  goal: ${goal}\n  sources ingested: ${ingested.length}\n  mode: challenge\n  execution: baseline → research lanes → critic → isolated implementation → experiment → replication\n  autonomous experiments: enabled (external submission remains approval-gated)`);
        await runAutonomousCycle(campaign, true);
      } catch (error) { appendError(error); }
      finally { setBusy(false); setProgress(""); }
      return;
    }
    if (request === "/challenge" || request === "/challenge status" || request === "/challenge list") {
      setConfig((current) => ({ ...current, mode: "challenge" }));
      const adapter = activeAdapter();
      append("assistant", `Active challenge: ${adapter.config.name}\nID: ${adapter.id}\nMetric: ${adapter.config.metric.name} (${adapter.config.metric.direction})\nUse /challenge inspect or /challenge baseline.`);
      return;
    }
    const auditAcceptance = request.match(/^\/challenge audit accept\s+(.+)$/);
    if (request === "/challenge audit" || auditAcceptance) {
      setConfig((current) => ({ ...current, mode: "challenge" }));
      const adapter = activeAdapter();
      const report = auditData(adapter.workspacePath(root));
      const fingerprint = dataAuditFingerprint(report);
      const store = new ResearchStore(join(root, ".sota", "database.sqlite"));
      store.appendEvent("data.audit.completed", { ...report, fingerprint });
      if (auditAcceptance?.[1]?.trim()) store.appendEvent("data.audit.accepted", { accepted: true, fingerprint, reason: auditAcceptance[1].trim(), findings: { duplicateGroups: report.duplicateGroups.length, distributionShift: report.distributionShift.length, warnings: report.warnings.length } });
      store.saveClaim({ id: `claim_data_audit_${Date.now()}`, payload: { statement: `Data audit scanned ${report.scannedFiles} files and found ${report.duplicateGroups.length} exact duplicate group(s).`, scope: adapter.id, confidence: 1, sourceType: "observation", sourceId: `data_audit_${Date.now()}`, status: "active", report } });
      store.close();
      append("assistant", `Data audit · ${adapter.id}\nScanned: ${report.scannedFiles} files · ${report.totalBytes} bytes\nDuplicate groups: ${report.duplicateGroups.length}\nDistribution shifts: ${report.distributionShift.length}\nSkipped: ${report.skippedFiles.length}\n${report.warnings.length ? `Warnings:\n${report.warnings.map((warning) => `- ${warning}`).join("\n")}` : "No exact-duplicate or audit-limit warnings."}${auditAcceptance ? `\n\nAccepted with reason: ${auditAcceptance[1].trim()}` : ""}`);
      return;
    }
    if (request === "/challenge policy") {
      setConfig((current) => ({ ...current, mode: "challenge" }));
      const adapter = activeAdapter();
      const policy = createValidationPolicy(adapter.config);
      mkdirSync(join(root, ".sota"), { recursive: true });
      const path = join(root, ".sota", "validation-policy.json");
      const checksum = writeValidationPolicy(path, policy);
      const store = new ResearchStore(join(root, ".sota", "database.sqlite"));
      store.appendEvent("validation.policy.created", { path, checksum, policy });
      store.close();
      append("assistant", `Validation policy created\nVersion: ${policy.version}\nSplit: ${policy.primarySplit}\nSeeds: ${policy.seeds.join(", ")}\nMetric: ${policy.metric.name} (${policy.metric.direction})\nChecksum: ${checksum}`);
      return;
    }
    if (request === "/data audit") {
      const adapter = activeAdapter();
      const report = auditData(adapter.workspacePath(root));
      const fingerprint = dataAuditFingerprint(report);
      const store = new ResearchStore(join(root, ".sota", "database.sqlite"));
      store.appendEvent("data.audit.completed", { ...report, fingerprint });
      store.saveClaim({ id: `claim_data_audit_${Date.now()}`, payload: { id: `claim_data_audit_${Date.now()}`, statement: `Data audit scanned ${report.scannedFiles} files and found ${report.duplicateGroups.length} exact duplicate group(s).`, scope: adapter.id, confidence: 1, sourceType: "observation", sourceId: `data_audit_${Date.now()}`, status: "active", report } });
      store.close();
      append("assistant", `Data audit · ${adapter.id}\nScanned: ${report.scannedFiles} files · ${report.totalBytes} bytes\nDuplicate groups: ${report.duplicateGroups.length}\nSkipped: ${report.skippedFiles.length}\n${report.warnings.length ? report.warnings.map((warning) => `- ${warning}`).join("\n") : "No audit warnings."}`);
      return;
    }
    if (request === "/validation inspect" || request === "/validation") {
      const path = join(root, ".sota", "validation-policy.json");
      const lock = readValidationPolicyLock(join(root, ".sota", "validation-policy.lock.json"));
      append("assistant", `${existsSync(path) ? readFileSync(path, "utf8").trim() : "No validation policy generated. Use /validation generate."}\n\nLock: ${lock?.locked ? `locked (${lock.checksum})` : lock ? `unlocked (${lock.unlockReason ?? "no reason"})` : "not locked"}`);
      return;
    }
    if (request === "/validation generate") {
      const adapter = activeAdapter();
      const policyPath = join(root, ".sota", "validation-policy.json");
      const lockPath = join(root, ".sota", "validation-policy.lock.json");
      if (readValidationPolicyLock(lockPath)?.locked) {
        append("assistant", "Validation policy is locked. Use /validation unlock <reason> before regenerating it.");
        return;
      }
      const policy = createValidationPolicy(adapter.config);
      mkdirSync(join(root, ".sota"), { recursive: true });
      const checksum = writeValidationPolicy(policyPath, policy);
      const store = new ResearchStore(join(root, ".sota", "database.sqlite"));
      store.appendEvent("validation.policy.created", { path: policyPath, checksum, policy }); store.close();
      append("assistant", `Validation policy generated\n  version: ${policy.version}\n  split: ${policy.primarySplit}\n  folds: ${policy.folds.join(", ")}\n  seeds: ${policy.seeds.join(", ")}\n  checksum: ${checksum}`);
      return;
    }
    if (request === "/validation lock") {
      const policyPath = join(root, ".sota", "validation-policy.json");
      const lockPath = join(root, ".sota", "validation-policy.lock.json");
      try {
        const record = lockValidationPolicy(policyPath, lockPath);
        const store = new ResearchStore(join(root, ".sota", "database.sqlite"));
        store.appendEvent("validation.policy.locked", record); store.close();
        append("assistant", `Validation policy locked\n  checksum: ${record.checksum}`);
      } catch (error) { appendError(error); }
      return;
    }
    if (request.startsWith("/validation unlock")) {
      const reason = request.slice("/validation unlock".length).trim();
      const policyPath = join(root, ".sota", "validation-policy.json");
      const lockPath = join(root, ".sota", "validation-policy.lock.json");
      try {
        const record = unlockValidationPolicy(policyPath, lockPath, reason);
        const store = new ResearchStore(join(root, ".sota", "database.sqlite"));
        store.appendEvent("validation.policy.unlocked", record); store.close();
        append("assistant", `Validation policy unlocked\n  reason: ${record.unlockReason}`);
      } catch (error) { appendError(error); }
      return;
    }
    if (request === "/challenge baseline") {
      setConfig((current) => ({ ...current, mode: "challenge" }));
      const adapter = activeAdapter();
      requireActiveContract();
      setBusy(true); setProgress(`Running the canonical ${adapter.config.name} baseline...`);
      try {
        const result = await runProcess(adapter.baselineCommand(), adapter.workspacePath(root), adapter.config.evaluatorTimeoutMinutes * 60_000);
        const store = new ResearchStore(join(root, ".sota", "database.sqlite"));
        const parsed = parseMetricOutput(result.stdout, adapter.config.metric.name);
        const metric = parsed.metrics[adapter.config.metric.name] ?? null;
        recordBaselineEvidence(store, root, result, metric, parsed.metrics, parsed.metricsByFold);
        store.close();
        appendTool(`Baseline ${result.exitCode === 0 ? "completed" : "failed"}.\n${result.stdout || result.stderr}`);
      } catch (error) { appendError(error); }
      finally { setBusy(false); setProgress(""); }
      return;
    }
    if (request === "/inspect" || request === "/challenge inspect") {
      if (request === "/challenge inspect") setConfig((current) => ({ ...current, mode: "challenge" }));
      append("assistant", JSON.stringify(activeAdapter().config, null, 2)); return;
    }
    if (request === "/hypotheses" || request.startsWith("/hypotheses ")) {
      const store = new ResearchStore(join(root, ".sota", "database.sqlite"));
      const hypotheses = store.hypotheses();
      store.close();
      const subcommand = request.split(/\s+/)[1];
      if (subcommand === "show") {
        const found = hypotheses.find((entry) => entry.id === request.split(/\s+/)[2]);
        append("assistant", found ? JSON.stringify(found.payload, null, 2) : "Hypothesis not found.");
      } else if (!hypotheses.length) append("assistant", "No hypotheses recorded. Use /research propose or ask a research question.");
      else append("assistant", hypotheses.slice(0, 12).map((entry, index) => {
        const payload = entry.payload as { title?: string; status?: string; mechanism?: string };
        return `${index + 1}. ${entry.id} · ${payload.status ?? "proposed"}\n   ${payload.title ?? "Untitled"}\n   ${payload.mechanism ?? ""}`;
      }).join("\n"));
      return;
    }
    if (request === "/graph" || request.startsWith("/graph ")) {
      const store = new ResearchStore(join(root, ".sota", "database.sqlite"));
      const edges = store.edges();
      store.close();
      append("assistant", edges.length ? edges.slice(0, 20).map((edge) => `${edge.fromId} --${edge.relation}(${edge.confidence.toFixed(2)})--> ${edge.toId}`).join("\n") : "Research graph is empty. Generate a research decision first.");
      return;
    }
    if (request === "/evidence" || request.startsWith("/evidence ")) {
      const store = new ResearchStore(join(root, ".sota", "database.sqlite"));
      const claims = store.claims();
      store.close();
      append("assistant", claims.length ? claims.slice(0, 20).map((claim) => {
        const payload = claim.payload as { statement?: string; confidence?: number; sourceType?: string };
        return `${claim.id} · ${payload.sourceType ?? "unknown"} · confidence ${(payload.confidence ?? 0).toFixed(2)}\n  ${payload.statement ?? ""}`;
      }).join("\n") : "No evidence claims recorded yet.");
      return;
    }
    if (request === "/experiments" || request === "/experiments list") {
      const store = new ResearchStore(join(root, ".sota", "database.sqlite"));
      const experiments = store.experiments();
      store.close();
      append("assistant", experiments.length ? experiments.slice(0, 20).map((entry) => `${entry.id} · ${JSON.stringify(entry.payload)}`).join("\n") : "No experiments recorded.");
      return;
    }
    if (request === "/experiment" || request.startsWith("/experiment ")) {
      const parts = request.split(/\s+/);
      const action = parts[1] ?? "list";
      const store = new ResearchStore(join(root, ".sota", "database.sqlite"));
      if (action === "list") {
        const experiments = store.experiments();
        store.close();
        append("assistant", experiments.length ? experiments.slice(0, 20).map((entry) => `${entry.id} · ${JSON.stringify(entry.payload)}`).join("\n") : "No experiments recorded.");
        return;
      }
      if (action === "show") {
        const experiment = store.experiments().find((entry) => entry.id === parts[2]);
        store.close();
        append("assistant", experiment ? JSON.stringify(experiment.payload, null, 2) : "Experiment not found.");
        return;
      }
      if (action === "audit") {
        const id = parts[2];
        const experiment = store.experiments().find((candidate) => candidate.id === id);
        if (!experiment) { store.close(); append("assistant", `Experiment not found: ${id ?? "(missing id)"}`); return; }
        const payload = experiment.payload as Record<string, unknown>;
        const run = store.runs().find((candidate) => candidate.id === payload.runId || candidate.experimentId === id);
        const artifactChecksums = run ? Object.fromEntries(store.artifacts(run.id).map((artifact) => [artifact.name, artifact.checksum])) : {};
        const storedGates = store.experimentGates(id);
        const replicationObserved = independentReplicationObserved(id, store.experiments(), store.runs());
        const currentCommit = await runProcess(["git", "rev-parse", "HEAD"], root);
        store.close();
        if (!run) { append("assistant", `No run recorded for ${id}. Run the experiment first.`); return; }
        try {
          const manifest = ExperimentManifestSchema.parse(payload);
          const runResult = RunResultSchema.parse(run.payload);
          const adapter = activeAdapter();
          const audit = auditExperiment(manifest, runResult, { currentCommit: currentCommit.stdout.trim(), datasetVersion: adapter.config.datasetRevision, splitVersion: manifest.splitVersion, metricName: adapter.config.metric.name, leakageAuditPassed: storedGates.leakageAuditPassed, reviewerApproved: storedGates.reviewerApproved, independentReplicationObserved: replicationObserved, externalScoreRequired: manifest.acceptance.requireExternalScore, externalScoreObserved: externalScoreObservedForExperiment(id, store.submissions(), run.id), artifactChecksums });
          const subtaskAudit = auditExperimentSubtask(manifest, audit, [run.id, ...Object.keys(artifactChecksums)]);
          const auditStore = new ResearchStore(join(root, ".sota", "database.sqlite"));
          auditStore.recordSubtaskAudit({ ...subtaskAudit, experimentId: id, runId: run.id });
          auditStore.appendEvent("experiment.audit.completed", { experimentId: id, accepted: audit.accepted, subtaskAudit });
          auditStore.close();
          const gateLines = Object.entries(audit.gates).map(([name, passed]) => `  ${passed ? "✓" : "·"} ${name}`).join("\n");
          append("assistant", `Evidence audit · ${id}\nStatus: ${audit.accepted ? "ACCEPTED" : "NOT ACCEPTED"}\n\n${gateLines}${audit.reasons.length ? `\n\nReasons:\n${audit.reasons.map((reason) => `- ${reason}`).join("\n")}` : ""}\n\nCriterion audit: ${subtaskAudit.complete ? "complete" : `blocked (${subtaskAudit.unmetRequired.join(", ")})`}`);
        } catch (error) { appendError(error); }
        return;
      }
      if (action === "gate") {
        const id = parts[2];
        const gate = parts[3];
        const approved = (parts[4] ?? "approve") === "approve";
        if (!id || (gate !== "leakage" && gate !== "review") || !["approve", "clear"].includes(parts[4] ?? "approve")) {
          store.close();
          append("assistant", "Usage: /experiment gate <id> leakage|review approve|clear");
          return;
        }
        if (!store.experiments().some((entry) => entry.id === id)) { store.close(); append("assistant", `Experiment not found: ${id}`); return; }
        store.setExperimentGates(id, gate === "leakage" ? { leakageAuditPassed: approved } : { reviewerApproved: approved });
        const gates = store.experimentGates(id);
        const experimentEntry = store.experiments().find((candidate) => candidate.id === id);
        const runId = experimentEntry && typeof (experimentEntry.payload as { runId?: unknown }).runId === "string" ? (experimentEntry.payload as { runId: string }).runId : undefined;
        const run = runId ? store.runs().find((candidate) => candidate.id === runId) : store.runs().find((candidate) => candidate.experimentId === id);
        if (experimentEntry && run) {
          const manifest = ExperimentManifestSchema.safeParse(experimentEntry.payload);
          const runResult = RunResultSchema.safeParse(run.payload);
          if (manifest.success && runResult.success) {
            const checksums = Object.fromEntries(store.artifacts(run.id).map((artifact) => [artifact.name, artifact.checksum]));
            const audit = auditExperiment(manifest.data, runResult.data, { currentCommit: manifest.data.gitCommit, datasetVersion: manifest.data.datasetVersion, splitVersion: manifest.data.splitVersion, metricName: activeAdapter().config.metric.name, leakageAuditPassed: gates.leakageAuditPassed, reviewerApproved: gates.reviewerApproved, independentReplicationObserved: independentReplicationObserved(id, store.experiments(), store.runs()), externalScoreRequired: manifest.data.acceptance.requireExternalScore, externalScoreObserved: externalScoreObservedForExperiment(id, store.submissions(), run.id), artifactChecksums: checksums });
            const subtaskAudit = auditExperimentSubtask(manifest.data, audit, [run.id, ...Object.keys(checksums)]);
            store.recordSubtaskAudit({ ...subtaskAudit, experimentId: id, runId: run.id });
            store.appendEvent("experiment.audit.refreshed", { experimentId: id, runId: run.id, trigger: "gate_update", accepted: audit.accepted, subtaskAudit });
          }
        }
        store.close();
        append("assistant", `Evidence gate updated · ${id}\n  leakage audit: ${gates.leakageAuditPassed ? "approved" : "pending"}\n  reviewer: ${gates.reviewerApproved ? "approved" : "pending"}`);
        return;
      }
      if (action === "compare") {
        const left = parts[2];
        const right = parts[3];
        const resolveRun = (reference: string | undefined) => {
          if (!reference) return undefined;
          const experiment = store.experiments().find((candidate) => candidate.id === reference);
          return store.runs().find((candidate) => candidate.id === reference || candidate.experimentId === experiment?.id);
        };
        const baseline = resolveRun(left);
        const candidate = resolveRun(right);
        const candidateExperiment = candidate ? store.experiments().find((entry) => entry.id === candidate.experimentId) : undefined;
        const candidateManifest = candidateExperiment ? ExperimentManifestSchema.safeParse(candidateExperiment.payload) : undefined;
        const comparisonCount = Math.max(1, store.experiments().length);
        const candidateHypothesisId = candidateManifest?.success ? candidateManifest.data.hypothesisId : undefined;
        const sequentialLook = candidateHypothesisId === undefined ? undefined : Math.max(1, store.experiments().filter((entry) => (entry.payload as { hypothesisId?: unknown }).hypothesisId === candidateHypothesisId).length);
        store.close();
        if (!baseline || !candidate) { append("assistant", "Usage: /experiment compare <baseline-id> <candidate-id> (experiment or run ids accepted)"); return; }
        try {
          const comparison = compareRuns(RunResultSchema.parse(baseline.payload), RunResultSchema.parse(candidate.payload), activeAdapter().config.metric.name);
          const adapter = activeAdapter();
          const policy = createValidationPolicy(adapter.config);
          const acceptance = evaluateValidationAcceptance({
            baseline: RunResultSchema.parse(baseline.payload),
            candidate: RunResultSchema.parse(candidate.payload),
            metric: adapter.config.metric.name,
            direction: adapter.config.metric.direction,
            minimumDelta: policy.acceptance.minimumDelta,
            maximumRegressionShift: 0,
            requireReplication: policy.acceptance.requireReplication,
            largeGainThreshold: candidateManifest?.success ? candidateManifest.data.acceptance.largeGainThreshold : undefined,
            evaluationCoverage: candidateManifest?.success ? validateEvaluationMatrix(candidateManifest.data, RunResultSchema.parse(candidate.payload), adapter.config.metric.name).valid : true,
            leakageAuditPassed: false,
            reviewerApproved: false,
            comparisonCount,
            sequentialLook,
            requirePermutationTest: true,
            subgroupDeltas: RunResultSchema.parse(candidate.payload).subgroupDeltas,
            requiresSubgroupAnalysis: (adapter.config.validation?.secondarySplits.length ?? 0) > 0,
            subgroupAnalysisObserved: RunResultSchema.parse(candidate.payload).subgroupDeltas.length > 0,
            secondaryMetrics: adapter.config.secondaryMetrics,
          });
          append("assistant", `Run comparison\n  baseline: ${comparison.baselineRunId} · ${comparison.baseline ?? "missing"}\n  candidate: ${comparison.candidateRunId} · ${comparison.candidate ?? "missing"}\n  delta: ${comparison.delta ?? "missing"}\n  result: ${comparison.direction}\n  evidence: ${comparison.evidence}${comparison.probabilityImproved === undefined ? "" : `\n  probability improved: ${(comparison.probabilityImproved * 100).toFixed(1)}%\n  95% CI: [${comparison.confidenceInterval?.[0].toFixed(6)}, ${comparison.confidenceInterval?.[1].toFixed(6)}]`}\n  promotion: ${acceptance.accepted ? "eligible" : "blocked by evidence gates"}\n\n${comparison.note}${acceptance.reasons.length ? `\n\nPromotion gates:\n${acceptance.reasons.map((reason) => `- ${reason}`).join("\n")}` : ""}`);
        } catch (error) { appendError(error); }
        return;
      }
      if (action === "replicate") {
        const parentId = parts[2];
        const parent = store.experiments().find((candidate) => candidate.id === parentId);
        if (!parent) { store.close(); append("assistant", `Experiment not found: ${parentId ?? "(missing id)"}`); return; }
        try {
          const parentManifest = ExperimentManifestSchema.parse(parent.payload);
          const manifest = createReplicationManifest(parentManifest, activeAdapter().config);
          store.saveExperiment({ id: manifest.id, payload: { ...manifest, status: "proposed", replicationOf: parentManifest.id } });
          store.close();
          append("assistant", `Independent replication manifest created\n${manifestSummary(manifest)}\nParent: ${parentManifest.id}\nNext: /experiment run ${manifest.id}`);
        } catch (error) { store.close(); appendError(error); }
        return;
      }
      if (action === "run") {
        const id = parts[2];
        store.close();
        if (!id) { append("assistant", "Usage: /experiment run <id>"); return; }
        setBusy(true);
        try { append("assistant", await executeExperiment(id)); }
        catch (error) { appendError(error); }
        finally { setBusy(false); setProgress(""); }
        return;
      }
      if (action !== "propose") {
        store.close();
        append("assistant", "Use /experiment propose [hypothesis-id] or /experiment show <id>.");
        return;
      }
      const hypotheses = store.hypotheses();
      const hypothesisId = parts[2] ?? hypotheses[0]?.id;
      if (!hypothesisId) {
        store.close();
        append("assistant", "No hypothesis exists. Run /research first.");
        return;
      }
      const commit = await runProcess(["git", "rev-parse", "HEAD"], root);
      if (commit.exitCode !== 0) {
        store.close();
        append("assistant", `Cannot create manifest: ${commit.stderr || commit.stdout}`);
        return;
      }
      const id = `exp_${Date.now()}_${hypothesisId.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 32)}`;
      const adapter = activeAdapter();
      const selectedHypothesis = store.hypotheses().find((candidate) => candidate.id === hypothesisId);
      const outcomeType = selectedHypothesis ? (selectedHypothesis.payload as { outcomeType?: "metric" | "artifact" | "proof" | "behavior" | "system" | "other" }).outcomeType : undefined;
      const manifest = createExperimentManifest({ id, hypothesisId, outcomeType, gitCommit: commit.stdout.trim(), datasetVersion: adapter.config.datasetRevision, executor: config.experimentExecutor }, adapter.config);
      store.saveExperiment({ id, payload: { ...manifest, status: "proposed", executionPlan: createExecutionPlan(manifest) } });
      store.close();
      append("assistant", `Immutable experiment manifest created\n${manifestSummary(manifest)}\n\nNext: /experiment show ${id}`);
      return;
    }
    if (request === "/runs") {
      const store = new ResearchStore(join(root, ".sota", "database.sqlite"));
      const runs = store.runs();
      store.close();
      append("assistant", runs.length ? runs.slice(0, 20).map((run) => `${run.id} · ${run.status} · experiment ${run.experimentId}`).join("\n") : "No runs recorded.");
      return;
    }
    if (request === "/agents" || request === "/agents status" || request === "/agents limits") {
      const codex = codexLoginStatus();
      let local = "unavailable";
      try { const models = await listLocalModels(); local = models.length ? `${models.length} model(s): ${models.map((model) => model.id).join(", ")}` : "connected, no models"; } catch (error) { local = error instanceof Error ? error.message : String(error); }
      const store = new ResearchStore(join(root, ".sota", "database.sqlite"));
      const lanes = store.agentLanes(); store.close();
      append("assistant", `Research agents\n  codex: ${codex || "not authenticated"}\n  local: ${local}\n  concurrency: 1 active director lane\n\n${lanes.length ? lanes.map((lane) => `  ${lane.status === "running" ? "●" : lane.status === "failed" ? "✗" : lane.status === "blocked" ? "!" : "○"} ${lane.role} · ${lane.status} · ${lane.provider}/${lane.model}${lane.task ? `\n    ${lane.task.slice(0, 120)}` : ""}`).join("\n") : "  No lanes initialized; start /research to initialize the project."}`);
      return;
    }
    if (request === "/compute" || request === "/compute status" || request === "/compute budget" || request === "/compute local" || request === "/compute container" || request === "/compute modal") {
      const selectedExecutor = request.split(/\s+/)[1];
      if (selectedExecutor === "local" || selectedExecutor === "container" || selectedExecutor === "modal") {
        setConfig((current) => ({ ...current, experimentExecutor: selectedExecutor }));
        append("assistant", `Experiment execution target selected: ${selectedExecutor}${selectedExecutor === "modal" ? " (Modal credentials are checked when a Modal experiment starts)." : selectedExecutor === "container" ? " (Docker/Podman runtime and image are checked when an experiment starts)." : " (runs stay on this computer)."}`);
        return;
      }
      const campaign = config.campaign;
      const containerRuntimes = await Promise.all(["docker", "podman"].map(async (runtime) => {
        try {
          const result = await runProcess(["which", runtime], root, 5_000);
          return result.exitCode === 0 ? runtime : undefined;
        } catch { return undefined; }
      }));
      const availableContainers = containerRuntimes.filter(Boolean).join(", ") || "none found";
      append("assistant", `Executor policy\n  mode: ${config.mode}\n  autonomy: ${config.autonomy}\n  selected: ${config.experimentExecutor}\n  local: available through process workers\n  container: ${availableContainers}\n  modal: ${process.env.MODAL_TOKEN_ID && process.env.MODAL_TOKEN_SECRET ? "configured" : "not configured"}\n  fallback: local model on Codex usage limits${campaign ? `\n\nCampaign budget\n  elapsed: ${campaignElapsedMinutes(campaign).toFixed(1)} / ${campaign.budgetMinutes} minutes\n  status: ${campaign.status}` : ""}`);
      return;
    }
    if (request === "/doctor") {
      const checks: string[] = [`node ${process.versions.node}`, `cwd ${root}`];
      for (const command of ["git", "uv", "docker", "podman"]) {
        try {
          const result = await runProcess(["which", command], root, 5_000);
          checks.push(`${command}: ${result.exitCode === 0 ? result.stdout.trim() : "not found"}`);
        } catch { checks.push(`${command}: unavailable`); }
      }
      const codexPath = resolveCodexBinary();
      try {
        const result = await runProcess(["which", codexPath], root, 5_000);
        checks.push(`codex: ${result.exitCode === 0 ? result.stdout.trim() : "not found"} (${codexPath})`);
      } catch { checks.push(`codex: unavailable (${codexPath})`); }
      try { await listLocalModels(); checks.push("ollama: reachable"); } catch { checks.push("ollama: unavailable"); }
      checks.push(`modal: ${process.env.MODAL_TOKEN_ID && process.env.MODAL_TOKEN_SECRET ? "configured" : "not configured"}`);
      append("assistant", `Evidra doctor\n${checks.map((check) => `  ${check}`).join("\n")}`);
      return;
    }
    if (request === "/contract" || request === "/validate") {
      const adapter = activeAdapter();
      const report = validateCompetitionContract(adapter.config, adapter.workspacePath(root));
      append("assistant", `Contract · ${adapter.config.name}\n${report.checks.map((check) => `  ${check.passed ? "✓" : "✗"} ${check.name}: ${check.detail}`).join("\n")}`);
      return;
    }
    if (request === "/submission" || request === "/submission status" || request === "/submission distribution" || request.startsWith("/submission prepare") || request.startsWith("/submission validate") || request.startsWith("/submission approve") || request.startsWith("/submission submit") || request.startsWith("/submission poll") || request.startsWith("/submission record")) {
      const parts = request.split(/\s+/);
      const action = parts[1] ?? "status";
      const submissionsRoot = join(root, ".sota", "submissions");
      if (action === "status") {
        const store = new ResearchStore(join(root, ".sota", "database.sqlite"));
        const submissions = store.submissions();
        store.close();
        append("assistant", submissions.length ? `Submission bundles\n${submissions.map((entry) => `- ${entry.status} ${entry.id} · experiment ${entry.experimentId}`).join("\n")}` : "No submission bundles prepared.");
        return;
      }
      if (action === "validate") {
        const target = parts[2];
        if (!target) { append("assistant", "Usage: /submission validate <bundle-id-or-path>"); return; }
        const path = target.startsWith("/") ? target : join(submissionsRoot, target);
        const report = validateSubmissionBundle(path);
        append("assistant", `Submission validation · ${path}\n${report.checks.map((check) => `${check.passed ? "✓" : "✗"} ${check.name} · ${check.detail}`).join("\n")}\n\nStatus: ${report.valid ? "VALID" : "NOT VALID"}`);
        return;
      }
      if (action === "prepare") {
        const experimentId = parts[2];
        if (!experimentId) { append("assistant", "Usage: /submission prepare <experiment-id>"); return; }
        const store = new ResearchStore(join(root, ".sota", "database.sqlite"));
        const experiment = store.experiments().find((entry) => entry.id === experimentId);
        const experimentPayload = experiment?.payload as { runId?: unknown } | undefined;
        const run = typeof experimentPayload?.runId === "string"
          ? store.runs().find((entry) => entry.id === experimentPayload.runId)
          : store.runs().filter((entry) => entry.experimentId === experimentId).at(-1);
        store.close();
        if (!experiment || !run) { append("assistant", `Experiment ${experimentId} must have a recorded run before a bundle can be prepared.`); return; }
        try {
          const bundle = prepareSubmission(root, experimentId, ExperimentManifestSchema.parse(experiment.payload), RunResultSchema.parse(run.payload), activeAdapter().config);
          const recordStore = new ResearchStore(join(root, ".sota", "database.sqlite"));
          recordStore.saveSubmission({ id: bundle.id, experimentId, path: bundle.path, status: "prepared", payload: { competition: activeAdapter().id, runId: run.id } });
          recordStore.close();
          append("assistant", `Submission bundle prepared\n  id: ${bundle.id}\n  path: ${bundle.path}\n  next: /submission validate ${bundle.id}\n\nExternal submission remains approval-gated.`);
        } catch (error) { appendError(error); }
        return;
      }
      if (action === "approve") {
        const bundleId = parts[2];
        if (!bundleId) { append("assistant", "Usage: /submission approve <bundle-id>"); return; }
        const store = new ResearchStore(join(root, ".sota", "database.sqlite"));
        const entry = store.submissions().find((candidate) => candidate.id === bundleId);
        if (!entry) { store.close(); append("assistant", `Submission bundle ${bundleId} is not registered.`); return; }
        const report = validateSubmissionBundle(entry.path);
        if (!report.valid) { store.close(); append("assistant", `Bundle ${bundleId} is not valid; approval was refused.`); return; }
        store.updateSubmissionStatus(bundleId, "approved", { approvedAt: new Date().toISOString(), externalSubmission: "ready" });
        store.close();
        append("assistant", `Submission ${bundleId} approved locally. Run /submission submit ${bundleId} to submit through the configured adapter.`);
        return;
      }
      if (action === "submit") {
        const bundleId = parts[2];
        if (!bundleId) { append("assistant", "Usage: /submission submit <bundle-id>"); return; }
        const store = new ResearchStore(join(root, ".sota", "database.sqlite"));
        const entry = store.submissions().find((candidate) => candidate.id === bundleId);
        if (!entry) { store.close(); append("assistant", `Submission bundle ${bundleId} is not registered.`); return; }
        if (entry.status !== "approved") { store.close(); append("assistant", `Submission ${bundleId} is '${entry.status}'. Run /submission approve first.`); return; }
        const gates = store.experimentGates(entry.experimentId);
        const experimentAudit = store.latestSubtaskAudit(`experiment_audit:${entry.experimentId}`);
        const entryPayload = entry.payload as { runId?: unknown };
        const runForAudit = typeof entryPayload.runId === "string" ? store.runs().find((candidate) => candidate.id === entryPayload.runId) : undefined;
        if (!experimentAudit || experimentAudit.complete !== true || (experimentAudit.payload as { runId?: unknown }).runId !== runForAudit?.id) {
          store.close();
          append("assistant", `Submission blocked: complete /experiment audit ${entry.experimentId} for the current run first.`);
          return;
        }
        if (!gates.leakageAuditPassed) { store.close(); append("assistant", `Submission blocked: leakage audit approval is required. Use /experiment gate ${entry.experimentId} leakage approve.`); return; }
        const optionValue = (name: string): number | undefined => {
          const index = parts.findIndex((part) => part === name);
          const inline = parts.find((part) => part.startsWith(`${name}=`))?.slice(name.length + 1);
          const value = inline ?? (index >= 0 ? parts[index + 1] : undefined);
          if (value === undefined) return undefined;
          const parsed = Number(value);
          return Number.isFinite(parsed) ? parsed : undefined;
        };
        const payload = entry.payload as { informationValue?: unknown; localConfidence?: unknown; isFinalEnsemble?: unknown };
        const policyDecision = evaluateSubmissionPolicy(activeAdapter().config.submissionPolicy, {
          submittedAt: store.submissions().filter((candidate) => candidate.status === "submitted" || candidate.status === "scored").map((candidate) => {
            const candidatePayload = candidate.payload as { receipt?: { submittedAt?: unknown } };
            return typeof candidatePayload.receipt?.submittedAt === "string" ? candidatePayload.receipt.submittedAt : candidate.updatedAt;
          }),
          informationValue: optionValue("--information-value") ?? (typeof payload.informationValue === "number" ? payload.informationValue : undefined),
          localConfidence: optionValue("--local-confidence") ?? (typeof payload.localConfidence === "number" ? payload.localConfidence : undefined),
          leakageFlagged: !gates.leakageAuditPassed,
          isFinalEnsemble: parts.includes("--final") || payload.isFinalEnsemble === true,
        });
        if (!policyDecision.allowed) { store.close(); append("assistant", `Submission policy blocked ${bundleId}: ${policyDecision.reasons.join("; ")}`); return; }
        setBusy(true); setProgress(`Submitting ${bundleId} through the configured adapter...`);
        try {
          const attempt = await submitApprovedBundle(root, entry.path, activeAdapter().config, "Evidra research submission", registerProcess);
          store.updateSubmissionStatus(bundleId, "submitted", { ...(typeof entry.payload === "object" && entry.payload ? entry.payload : {}), receipt: attempt.receipt });
          store.appendEvent("submission.external.submitted", { id: bundleId, platform: attempt.receipt.platform, predictionFile: attempt.receipt.predictionFile, submittedAt: attempt.receipt.submittedAt });
          append("assistant", `Submission ${bundleId} submitted via ${attempt.receipt.platform}\n${attempt.receipt.stdout.trim()}`);
        } catch (error) { appendError(error); }
        finally { activeProcess.current = null; store.close(); setBusy(false); setProgress(""); }
        return;
      }
      if (action === "poll") {
        const bundleId = parts[2];
        if (!bundleId) { append("assistant", "Usage: /submission poll <bundle-id>"); return; }
        const store = new ResearchStore(join(root, ".sota", "database.sqlite"));
        const entry = store.submissions().find((candidate) => candidate.id === bundleId);
        if (!entry) { store.close(); append("assistant", `Submission bundle ${bundleId} is not registered.`); return; }
        if (entry.status !== "submitted" && entry.status !== "scored") { store.close(); append("assistant", `Submission ${bundleId} is '${entry.status}'. Submit it before polling.`); return; }
        setBusy(true); setProgress(`Polling the external score for ${bundleId}...`);
        try {
          const observation = await pollSubmissionScore(root, entry.path, bundleId, activeAdapter().config, registerProcess);
          const recordedAt = observation.observedAt;
          store.updateSubmissionStatus(bundleId, "scored", { ...(typeof entry.payload === "object" && entry.payload ? entry.payload : {}), publicScore: observation.score, platform: observation.platform, recordedAt, scoreObservation: observation });
          store.saveClaim({ id: `claim_external_score_${bundleId}_${Date.now()}`, payload: { statement: `External ${observation.platform} score for ${bundleId}: ${observation.score}`, scope: entry.experimentId, confidence: 1, sourceType: "external_score", sourceId: bundleId, status: "active", score: observation.score, platform: observation.platform, recordedAt } });
          store.appendEvent("submission.score.polled", { id: bundleId, score: observation.score, platform: observation.platform, recordedAt });
          const currentAudit = store.latestSubtaskAudit(`experiment_audit:${entry.experimentId}`);
          if (currentAudit) {
            store.recordSubtaskAudit({ ...refreshAuditWithExternalScore(currentAudit.payload as import("../core/subtask-state.js").SubtaskAudit, `submission:${bundleId}`), refreshTrigger: "external_score", externalScore: observation.score, externalPlatform: observation.platform, externalObservedAt: recordedAt });
            store.appendEvent("experiment.audit.refreshed", { experimentId: entry.experimentId, runId: (currentAudit.payload as { runId?: unknown }).runId ?? null, trigger: "external_score", score: observation.score, platform: observation.platform });
          }
          append("assistant", `Polled ${observation.platform} score ${observation.score} for ${bundleId}.`);
        } catch (error) { appendError(error); }
        finally { activeProcess.current = null; store.close(); setBusy(false); setProgress(""); }
        return;
      }
      if (action === "record") {
        const bundleId = parts[2];
        const score = Number(parts[3]);
        const platform = parts[4] ?? "manual";
        let validationScores: Record<string, number> = {};
        if (parts[5]) {
          try {
            const parsed = JSON.parse(parts[5]) as Record<string, unknown>;
            validationScores = Object.fromEntries(Object.entries(parsed).filter(([, value]) => typeof value === "number" && Number.isFinite(value)) as Array<[string, number]>);
          } catch { append("assistant", "Validation scores must be compact JSON, e.g. {\"group\":0.81,\"temporal\":0.79}"); return; }
        }
        if (!bundleId || !Number.isFinite(score)) { append("assistant", "Usage: /submission record <bundle-id> <public-score> [platform] [split-json]"); return; }
        const store = new ResearchStore(join(root, ".sota", "database.sqlite"));
        const entry = store.submissions().find((candidate) => candidate.id === bundleId);
        if (!entry) { store.close(); append("assistant", `Submission bundle ${bundleId} is not registered.`); return; }
        const report = validateSubmissionBundle(entry.path);
        if (!report.valid) { store.close(); append("assistant", "Bundle is not valid; score was not recorded."); return; }
        const recordedAt = new Date().toISOString();
        store.updateSubmissionStatus(bundleId, "scored", { ...(typeof entry.payload === "object" && entry.payload ? entry.payload : {}), publicScore: score, validationScores, platform, recordedAt });
          store.saveClaim({ id: `claim_external_score_${bundleId}_${Date.now()}`, payload: { statement: `External ${platform} score for ${bundleId}: ${score}`, scope: entry.experimentId, confidence: 1, sourceType: "external_score", sourceId: bundleId, status: "active", score, platform, recordedAt } });
          store.appendEvent("submission.score.recorded", { id: bundleId, score, platform, recordedAt });
          const currentAudit = store.latestSubtaskAudit(`experiment_audit:${entry.experimentId}`);
          if (currentAudit) {
            store.recordSubtaskAudit({ ...refreshAuditWithExternalScore(currentAudit.payload as import("../core/subtask-state.js").SubtaskAudit, `submission:${bundleId}`), refreshTrigger: "external_score", externalPlatform: platform, externalScore: score, externalObservedAt: recordedAt });
            store.appendEvent("experiment.audit.refreshed", { experimentId: entry.experimentId, runId: (currentAudit.payload as { runId?: unknown }).runId ?? null, trigger: "external_score", score, platform });
          }
        store.close();
        append("assistant", `Recorded ${platform} score ${score} for ${bundleId}.`);
        return;
      }
      if (action === "distribution") {
        const store = new ResearchStore(join(root, ".sota", "database.sqlite"));
        const observations = store.submissions()
          .map((entry) => entry.payload as { publicScore?: unknown; validationScores?: unknown })
          .filter((payload) => typeof payload.publicScore === "number" && payload.validationScores && typeof payload.validationScores === "object")
          .map((payload, index) => ({ id: `submission-${index}`, externalScore: payload.publicScore as number, validationScores: payload.validationScores as Record<string, number> }));
        store.close();
        const { estimateDistributionBeliefs } = await import("../core/distribution-beliefs.js");
        append("assistant", JSON.stringify(estimateDistributionBeliefs(observations), null, 2));
        return;
      }
    }
    if (request === "/queue" || request === "/queue status" || request === "/queue recover") {
      const store = new ResearchStore(join(root, ".sota", "database.sqlite"));
      if (request === "/queue recover") {
        const count = store.requeueStaleTasks();
        append("assistant", `Requeued ${count} stale task${count === 1 ? "" : "s"}.`);
      } else {
        const tasks = store.queueTasks();
        append("assistant", tasks.length ? `Research queue\n${tasks.slice(0, 24).map((task) => `${task.status === "running" ? "●" : task.status === "queued" ? "○" : task.status === "completed" ? "✓" : "✗"} ${task.id} · ${task.kind} · priority ${task.priority} · attempts ${task.attempts}`).join("\n")}` : "Research queue is empty.");
      }
      store.close();
      return;
    }
    if (request === "/ensemble" || request === "/ensemble candidates" || request === "/ensemble diversity" || request === "/ensemble propose" || request.startsWith("/ensemble validate") || request.startsWith("/ensemble promote") || request.startsWith("/ensemble reject")) {
      const store = new ResearchStore(join(root, ".sota", "database.sqlite"));
      const ensembleParts = request.split(/\s+/);
      const ensembleAction = ensembleParts[1] ?? "candidates";
      if (["validate", "promote", "reject"].includes(ensembleAction)) {
        const candidateId = ensembleParts[2];
        const candidate = candidateId ? store.ensembleCandidates(100).find((entry) => entry.id === candidateId) : undefined;
        if (!candidate) { store.close(); append("assistant", `Usage: /ensemble ${ensembleAction} <candidate-id>`); return; }
        if (ensembleAction === "validate") {
          const report = validateBlendCandidate(candidate.path, candidate.checksum);
          if (report.valid) store.updateEnsembleCandidateStatus(candidate.id, "validated", { ...(candidate.payload as Record<string, unknown>), validatedAt: new Date().toISOString(), validation: report });
          store.close();
          append("assistant", `Ensemble ${candidate.id} · ${report.valid ? "validated" : `validation failed: ${report.reason}`}`);
          return;
        }
        try {
          const next = ensembleAction === "promote" ? "promoted" : "rejected";
          if (next === "promoted") {
            const report = validateBlendCandidate(candidate.path, candidate.checksum);
            if (!report.valid) throw new Error(`Promotion refused: ${report.reason}`);
          }
          store.updateEnsembleCandidateStatus(candidate.id, next, { ...(candidate.payload as Record<string, unknown>), [`${next}At`]: new Date().toISOString() });
          store.close();
          append("assistant", `Ensemble ${candidate.id} marked ${next}. External submission remains approval-gated.`);
        } catch (error) { store.close(); appendError(error); }
        return;
      }
      const vectors: PredictionVector[] = [];
      for (const artifact of store.artifacts().filter((entry) => /prediction|oof/i.test(entry.name) && safePredictionPath(root, entry.path))) {
        try { vectors.push(loadPredictionVector(artifact.id, artifact.path)); } catch { /* invalid candidates are reported below */ }
      }
      if (request === "/ensemble" || request === "/ensemble candidates") {
        const blends = store.ensembleCandidates(12);
        store.close();
        append("assistant", `${vectors.length ? `Prediction candidates\n${vectors.map((vector) => `- ${vector.id} · ${vector.values.length} values · ${vector.path}`).join("\n")}` : "No valid prediction or OOF artifacts found. Completed runs must record prediction files before ensemble analysis."}${blends.length ? `\n\nBlend candidates\n${blends.map((blend) => `- ${blend.status} ${blend.id} · ${blend.path} · ${blend.checksum}`).join("\n")}` : ""}`);
        return;
      }
      if (vectors.length < 2) { store.close(); append("assistant", "At least two valid prediction artifacts are required for ensemble analysis."); return; }
      const pairs = diversityReport(vectors);
      if (request === "/ensemble diversity") {
        store.close();
        append("assistant", `Prediction diversity\n${pairs.map((pair) => `- ${pair.left} ↔ ${pair.right}\n  correlation: ${pair.correlation.toFixed(4)} · mean disagreement: ${pair.disagreement.toFixed(6)}`).join("\n")}`);
        return;
      }
      const blend = createBlendCandidate(root, vectors);
      store.saveEnsembleCandidate({ id: blend.id, path: blend.path, checksum: blend.checksum, status: blend.status, payload: { ...blend, diversity: pairs } });
      store.appendEvent("ensemble.candidate.created", { id: blend.id, path: blend.path, checksum: blend.checksum, members: blend.members, diversity: pairs });
      store.close();
      append("assistant", `Ensemble candidate created\n  id: ${blend.id}\n  members: ${vectors.length}\n  path: ${blend.path}\n  checksum: ${blend.checksum}\n  status: candidate\n\nEvaluate only on out-of-fold data before promotion.`);
      return;
    }
    if (request === "/report" || request === "/report research" || request === "/report challenge" || request === "/report final" || request === "/export") {
      const requested = request === "/export" ? "final" : (request.split(/\s+/)[1] ?? "research");
      if (!["research", "challenge", "final"].includes(requested)) { append("assistant", "Usage: /report research, /report challenge, or /report final"); return; }
      const kind = requested as ReportKind;
      const store = new ResearchStore(join(root, ".sota", "database.sqlite"));
      const content = renderReport(store, kind);
      const path = writeReport(root, kind, content);
      store.appendEvent("report.generated", { kind, path }); store.close();
      append("assistant", `Report generated\n  type: ${kind}\n  path: ${path}\n  sections: phase goals, evidence, sources, decisions, events${kind === "research" ? "" : ", experiments, runs, artifacts"}`);
      return;
    }
    if (request === "/timeline" || request.startsWith("/timeline ")) {
      const parsedLimit = Number(request.split(/\s+/)[1] ?? "30");
      const limit = Math.max(1, Math.min(200, Number.isFinite(parsedLimit) ? parsedLimit : 30));
      const store = new ResearchStore(join(root, ".sota", "database.sqlite"));
      const timeline = renderTimeline(store.recentEvents(limit), limit);
      store.close();
      append("assistant", `Autonomous timeline\n${timeline}`);
      return;
    }
    if (request === "/integrity" || request === "/integrity events") {
      const store = new ResearchStore(join(root, ".sota", "database.sqlite"));
      const report = store.verifyEventChain();
      store.close();
      const label = report.status === "valid" ? "VALID" : report.status === "legacy" ? "LEGACY (older events are unchained)" : "INVALID";
      append("assistant", `Event integrity · ${label}\n  checked: ${report.checked}\n  legacy events: ${report.legacy}${report.brokenAt ? `\n  broken at event: ${report.brokenAt}` : ""}${report.reason ? `\n  reason: ${report.reason}` : ""}`);
      return;
    }
    if (request === "/backup" || request.startsWith("/backup ")) {
      const requested = request.slice("/backup".length).trim();
      const path = resolve(root, requested || join(".sota", "backups", `database-${new Date().toISOString().replace(/[:.]/g, "-")}.sqlite`));
      const workspacePrefix = root.endsWith("/") ? root : `${root}/`;
      if (path === resolve(join(root, ".sota", "database.sqlite")) || !path.startsWith(workspacePrefix)) { append("assistant", "Backup destination must stay inside the workspace and cannot overwrite the live database."); return; }
      setBusy(true); setProgress("Creating a consistent state backup...");
      try {
        const store = new ResearchStore(join(root, ".sota", "database.sqlite"));
        await store.backup(path);
        store.appendEvent("state.backup.created", { path: relative(root, path) });
        store.close();
        append("assistant", `State backup created\n  ${path}`);
      } catch (error) { appendError(error); }
      finally { setBusy(false); setProgress(""); }
      return;
    }
    if (request === "/sources discover" || request.startsWith("/sources discover ")) {
      const query = request.slice("/sources discover".length).trim();
      if (!query) { append("assistant", "Usage: /sources discover <research question>\nResults are candidates only; retrieve a source with /sources add before it influences the director."); return; }
      setBusy(true); setProgress("Searching scholarly literature...");
      try {
        const results = await searchResearchSources(query, 8);
        append("assistant", results.length ? `Scholarly candidates for: ${query}\n\n${results.map((result, index) => `${index + 1}. ${result.title}\n   ${result.url}${result.venue ? ` · ${result.venue}` : ""}${result.publicationDate ? ` · ${result.publicationDate}` : ""}${result.authors.length ? `\n   authors: ${result.authors.join(", ")}` : ""}${result.abstract ? `\n   ${result.abstract.slice(0, 320)}${result.abstract.length > 320 ? "…" : ""}` : ""}`).join("\n\n")}\n\nRetrieve a candidate with /sources add <url>.` : "No scholarly sources found.");
      } catch (error) { appendError(error); }
      finally { setBusy(false); setProgress(""); }
      return;
    }
    if (request === "/sources" || request === "/sources list" || request.startsWith("/sources search ") || request.startsWith("/sources show ")) {
      const store = new ResearchStore(join(root, ".sota", "database.sqlite"));
      const sources = store.sources();
      const parts = request.split(/\s+/);
      if (parts[1] === "search") {
        const query = request.slice("/sources search ".length).trim().toLowerCase();
        const matches = sources.filter((source) => sourceSearchText(source).includes(query)).slice(0, 20);
        store.close();
        append("assistant", matches.length ? matches.map((source) => `${source.id} · ${String((source.payload as { title?: string }).title ?? "Untitled")}\n  ${(source.payload as { url?: string }).url ?? ""}`).join("\n") : "No matching research sources.");
        return;
      }
      if (parts[1] === "show") {
        const source = sources.find((candidate) => candidate.id === parts[2]);
        store.close();
        append("assistant", source ? JSON.stringify(source.payload, null, 2) : `Source not found: ${parts[2] ?? "(missing id)"}`);
        return;
      }
      store.close();
      append("assistant", sources.length ? sources.map((source) => `${source.id} · ${JSON.stringify(source.payload)}`).join("\n") : "No research sources cached yet.");
      return;
    }
    if (request === "/sources add" || request.startsWith("/sources add ")) {
      const url = request.slice("/sources add".length).trim();
      if (!url) { append("assistant", "Usage: /sources add https://...\nThe source is fetched, hashed, excerpted, and stored before it can influence research."); return; }
      setBusy(true); setProgress("Retrieving and hashing research source...");
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 20_000);
      try {
        const retrieved = await retrieveSource(url, controller.signal);
        const claims = sourceClaims(retrieved.text);
        const store = new ResearchStore(join(root, ".sota", "database.sqlite"));
        store.saveSource({ id: retrieved.id, payload: { ...retrieved, claims } });
        for (const [index, statement] of claims.entries()) {
          const claimId = `${retrieved.id}_claim_${index + 1}`;
          store.saveClaim({ id: claimId, payload: { id: claimId, statement, scope: retrieved.url, confidence: 0.35, sourceType: "literature", sourceId: retrieved.id, status: "active" } });
          store.saveEdge({ id: `edge_${claimId}_${retrieved.id}`, fromId: claimId, toId: retrieved.id, relation: "derived_from", confidence: 0.35, evidenceIds: [claimId] });
        }
        store.appendEvent("research.source.retrieved", { id: retrieved.id, url: retrieved.url, contentHash: retrieved.contentHash, claimCount: claims.length });
        store.close();
        appendTool(`Source retrieved\n  ${retrieved.id}\n  ${retrieved.title}\n  ${retrieved.url}\n  hash: ${retrieved.contentHash}\n  claims: ${claims.length}\n\n${retrieved.excerpt}`);
      } catch (error) {
        append("assistant", error instanceof Error && error.name === "AbortError" ? "Source retrieval timed out after 20 seconds." : error instanceof Error ? error.message : String(error));
      } finally { clearTimeout(timeout); setBusy(false); setProgress(""); }
      return;
    }
    if (request === "/evidence" || request === "/evidence audit") {
      const store = new ResearchStore(join(root, ".sota", "database.sqlite"));
      const report = auditEvidenceStore(store);
      store.close();
      append("assistant", `Claim verification · ${report.publishable ? "PUBLISHABLE" : "BLOCKED"}\nTotal ${report.total} · verified ${report.verified} · provisional ${report.provisional} · literature-only ${report.literatureOnly} · unsupported ${report.unsupported} · conflicted ${report.conflicted}\n\n${report.entries.length ? report.entries.map((entry) => `${entry.status === "verified" ? "✓" : "!"} ${entry.id} · ${entry.reasons.join("; ")}`).join("\n") : "No claims recorded."}`);
      return;
    }
    if (request === "/evidence analyze" || request.startsWith("/evidence analyze ")) {
      const requested = request.slice("/evidence analyze".length).trim();
      if (!requested) { append("assistant", "Usage: /evidence analyze <prediction.json|prediction.jsonl>"); return; }
      const path = resolve(root, requested);
      try {
        const escaped = relative(root, path);
        if (escaped.startsWith("..") || escaped === ".sota" || escaped.startsWith(".sota/")) throw new Error("Prediction artifact must be inside the workspace and outside Evidra state.");
        if (!existsSync(path)) throw new Error(`Prediction artifact does not exist: ${requested}`);
        const text = readFileSync(path, "utf8");
        let parsed: unknown = text;
        try { parsed = JSON.parse(text); } catch { /* JSONL is parsed row-by-row. */ }
        const rows = parsePredictionRows(parsed);
        append("assistant", `Prediction error analysis\n  path: ${relative(root, path)}\n  rows: ${rows.length}\n\n${JSON.stringify(analyzePredictionRows(rows), null, 2)}`);
      } catch (error) { appendError(error); }
      return;
    }
    if (request === "/memory recent" || request === "/memory") {
      const store = new ResearchStore(join(root, ".sota", "database.sqlite"));
      const claims = store.claims().slice(0, 20); const events = store.recentEvents(10); store.close();
      append("assistant", `Recent research memory\n\nClaims\n${claims.length ? claims.map((claim) => `- ${claim.id}: ${String((claim.payload as { statement?: string }).statement ?? "")}`).join("\n") : "- none"}\n\nEvents\n${events.length ? events.map((event) => `- ${event.type} · ${event.createdAt}`).join("\n") : "- none"}`);
      return;
    }
    if (request.startsWith("/memory search ")) {
      const query = request.slice("/memory search ".length).trim();
      const store = new ResearchStore(join(root, ".sota", "database.sqlite"));
      const matches = store.searchMemory(query, 20);
      store.close();
      append("assistant", matches.map((match) => `${match.kind} ${match.id}: ${String((match.payload as { statement?: string; title?: string; url?: string }).statement ?? (match.payload as { title?: string }).title ?? (match.payload as { url?: string }).url ?? "")}`).join("\n") || "No matching research memory.");
      return;
    }
    if (request === "/run" || request.startsWith("/run ") || request === "/shell" || request.startsWith("/shell ")) {
      const rawCommand = request.replace(/^\/(run|shell)\s*/, "");
      const command = splitCommandLine(rawCommand);
      if (!command.length) { append("assistant", "Usage: /run rg -n hypothesis src or /run uv run pytest"); return; }
      const guard = guardCommand(command);
      if (!guard.allowed) { append("assistant", `${guard.reason} Use a reviewed experiment manifest for destructive operations.`); return; }
      setBusy(true); setProgress(`Running ${command.join(" ")}...`);
      try {
        const result = await runProcess(command, root, 15 * 60_000, (stream, chunk) => {
          const line = chunk.replace(/\s+/g, " ").trim();
          if (line) setProgress(`${stream}: ${line.slice(-140)}`);
        }, registerProcess);
        const output = [result.stdout.trim(), result.stderr.trim() ? `stderr:\n${result.stderr.trim()}` : ""].filter(Boolean).join("\n");
        appendTool(`Command exited ${result.exitCode} in ${(result.durationMs / 1000).toFixed(1)}s\n$ ${command.join(" ")}\n${output || "(no output)"}`);
      } catch (error) { appendError(error); }
      finally { activeProcess.current = null; setBusy(false); setProgress(""); }
      return;
    }
    if (["/research status", "/research start", "/research pause", "/research stop"].includes(request)) {
      const action = request.split(/\s+/)[1];
      const store = new ResearchStore(join(root, ".sota", "database.sqlite"));
      if (action === "status") {
        const state = store.schedulerState();
        const goal = activePhaseGoal(phaseGoalsForMode(store.phaseGoals().map((entry) => PhaseGoalSchema.parse(entry.payload)), config.mode));
        const campaign = config.campaign;
        const checkpoint = readCampaignCheckpoint(campaign);
        const counts = store.counts();
        append("assistant", `Research status\n  scheduler: ${state.status}\n  step: ${state.currentStep ?? "idle"}\n  phase: ${goal?.phase ?? "not initialized"}\n  phase goal: ${goal?.title ?? "none"}\n  attempts: ${goal?.attempts ?? 0}\n  decisions: ${counts.decisions} · hypotheses: ${counts.hypotheses} · claims: ${counts.claims}${campaign ? `\n\nCampaign\n  status: ${campaign.status}\n  goal: ${campaign.goal}\n  budget: ${campaign.budgetMinutes} minutes\n  checkpoint: ${checkpoint ? `cycle ${checkpoint.currentCycle} · ${checkpoint.currentStep} · ${checkpoint.checkpointedAt}` : "unavailable or legacy state"}\n  stop: ${campaign.stopCondition}` : "\n\nNo campaign configured. Use /research to start one."}`);
      } else {
        const status = action === "start" ? "running" : action === "pause" ? "paused" : "idle";
        store.setSchedulerState({ status, mode: "research", currentStep: null });
        append("assistant", `Research scheduler ${status}.`);
      }
      store.close();
      return;
    }
    if (request === "/research" || request.startsWith("/research ")) {
      const objective = request.slice("/research".length).trim();
      if (!objective || objective === "start") {
        if (config.campaign?.status === "running") { append("assistant", "An autonomous research campaign is already running. Use /status or /usage to inspect it."); return; }
        setSetupDraft({}); setSetupStep("goal");
        append("assistant", "Autonomous research setup · Step 1/3\nWhat is the ultimate research goal?\n\nEvidra will define internal phase goals and continue until your stopping condition or budget is reached. Type /cancel to stop setup.");
        return;
      }
      if (objective === "next") {
        ensureActiveProject(); setBusy(true); setProgress("Starting empirical research cycle...");
        try { append("assistant", (await runResearchCycle("Inspect the current workspace and choose the highest-information next research action.")).text); }
        catch (error) { appendError(error); }
        finally { setBusy(false); setProgress(""); }
        return;
      }
      setBusy(true); setProgress("Starting empirical research cycle...");
      try {
        ensureActiveProject(); append("assistant", (await runResearchCycle(objective)).text);
      } catch (error) {
        append("assistant", error instanceof Error ? error.message : String(error));
      } finally { setBusy(false); setProgress(""); }
      return;
    }
    if (request.startsWith("/")) { append("assistant", `Unknown command: ${request}\n\n${help()}`); return; }

    activeSteer.current = null;
    setBusy(true); setProgress(`Using ${config.provider}/${config.model}`);
    try {
      const result = await runWithLocalFallback({
        role: "conversation assistant",
        objective: request,
        context: {
          mode: config.mode,
          instruction: "This is ordinary conversation, not a research cycle. Answer directly and concisely. Do not inspect files, run commands, edit code, propose experiments, or claim fresh measurements. If the user wants autonomous research, tell them to use /research.",
        },
      }, { provider: config.provider, model: config.model, cwd: root, threadId: config.provider === "codex" ? (activeCodexThread.current ?? config.codexThreadId) : undefined, reasoningEffort: config.reasoningEffort, sandbox: "read-only", limitPolicy: config.limitPolicy, onUsage: persistAgentUsage, onThread: (threadId) => { activeCodexThread.current = threadId; setConfig((current) => ({ ...current, codexThreadId: threadId })); activeSteer.current = (message) => queueCodexMessage(threadId, message); } }, config.fallbackModel, setProgress, registerProcess);
      if (result.provider !== config.provider) {
        activeCodexThread.current = undefined;
        setConfig((current) => ({ ...current, codexThreadId: undefined }));
        append("assistant", `Provider fallback active: ${result.provider}/${result.model ?? "default"}. The Codex conversation thread was reset so messages cannot silently diverge across providers.`);
      }
      append("assistant", String(result.output));
    } catch (error) {
      append("assistant", error instanceof Error ? error.message : String(error));
    } finally { activeSteer.current = null; setBusy(false); setProgress(""); }
  };
  submitRef.current = submit;

  useEffect(() => {
    if (busy || !pendingRequests.current.length) return;
    const steered = pendingRequests.current.filter((request) => request.dispatched);
    if (steered.length) {
      setMessages((current) => [...current, ...steered.map((request) => ({ role: "user" as const, text: request.text }))]);
    }
    const nextPending = pendingRequests.current.filter((request) => !request.dispatched);
    const next = nextPending.shift();
    pendingRequests.current = nextPending;
    if (next) {
      setQueuedRequests([...pendingRequests.current]);
      setTimeout(() => { void submitRef.current(next.text, true); }, 0);
    } else {
      setQueuedRequests([]);
    }
  }, [busy]);

  return <Box flexDirection="column" padding={1}>
    <Static items={[LOGO]}>
      {(logo) => <Box key="evidra-logo" borderStyle="round" borderColor="cyan" paddingX={2} paddingY={1} flexDirection="column">
        <Text color="cyan" bold>{logo}</Text>
      </Box>}
    </Static>
    <Box paddingX={2}>
      <Text color="gray"><Text color="cyan" bold>EVIDRA WORKBENCH</Text>  │  MODE: <Text color="yellow" bold>{config.mode.toUpperCase()}</Text>  │  THINKING: {config.reasoningEffort}  │  PERMISSIONS: <Text color="yellow" bold>{config.autonomy.toUpperCase()}</Text></Text>
    </Box>
    <Box flexDirection="column" marginTop={1} paddingX={1}>
      {messages.slice(-16).map((message, index) => {
        if (message.role === "assistant" && /^Interrupted\b/i.test(message.text)) {
          const detail = message.text.replace(/^Interrupted\s*[·:-]?\s*/i, "");
          return <Box key={`${index}-${message.text}`} marginBottom={1} paddingX={1}>
            <Text color="red" bold>✕ INTERRUPTED</Text><Text color="red">  {detail || "Active work was stopped."}</Text>
          </Box>;
        }
        if (message.kind === "tool") {
          const [headline, ...details] = message.text.split("\n");
          return <Box key={`${index}-${message.text}`} flexDirection="column" marginBottom={1} paddingLeft={2}>
            <Text color="gray" bold>• {headline}</Text>
            {details.length > 0 && <Box paddingLeft={2}><RichText text={details.map((line) => `└ ${line}`).join("\n")} /></Box>}
          </Box>;
        }
        const errorLike = message.role === "assistant" && /unreachable|not configured|not logged|failed|error|unavailable|refus|interrupted/i.test(message.text);
        const accent = message.role === "user" ? "yellow" : message.role === "system" ? "gray" : errorLike ? "red" : "green";
        const label = messageLabel(message);
        const body = label && message.role === "assistant" ? message.text.split("\n").slice(1).join("\n") : message.text;
        return <Box key={`${index}-${message.text}`} flexDirection="column" marginBottom={1} paddingX={1}>
          <Text color={accent} bold>{message.role === "user" ? "›" : message.role === "assistant" ? "•" : "·"}{label ? ` ${label}` : ""}</Text>
          <RichText text={body} />
        </Box>;
      })}
    </Box>
    {queuedRequests.length > 0 && <Box flexDirection="column" paddingX={1} marginTop={1}>
      <Text color="yellow" bold>• QUEUED · {queuedRequests.length} waiting</Text>
      {queuedRequests.map((queued) => <Text key={queued.id} color="yellow">  ↳ {queued.dispatched ? "steering next boundary · " : "waiting · "}{queued.text}</Text>)}
    </Box>}
    {busy && <Box paddingX={1} marginTop={1}>
      <Text color="magenta" bold>{["⠋", "⠙", "⠹", "⠸"][busyFrame]}  {progress || "Working..."}</Text><Text color="gray">  (esc to interrupt)</Text>
    </Box>}
    {picker && <Box borderStyle="round" borderColor="cyan" paddingX={2} flexDirection="column" marginTop={1}>
      <Text color="cyan" bold>{picker === "provider" ? "Choose a provider" : picker === "model" ? `Select ${config.provider} model` : picker === "reasoning" ? "Select thinking effort" : picker === "mode" ? "Select workbench mode" : "Select permissions"}</Text>
      <Text color="gray">↑/↓ navigate · Enter select · Esc cancel</Text>
      {(picker === "provider" ? providerChoices : picker === "model" ? availableModels : picker === "reasoning" ? reasoningChoices : picker === "mode" ? modeChoices : permissionChoices).slice(Math.max(0, pickerIndex - 5), pickerIndex + 7).map((entry, index) => {
        const actualIndex = Math.max(0, pickerIndex - 5) + index;
        const label = typeof entry === "string"
          ? entry === "codex" ? "Codex · ChatGPT subscription"
            : entry === "local" ? "Local · Ollama on this machine" : entry
          : `${entry.displayName}  ${entry.id}${entry.isDefault ? " · default" : ""}${entry.hidden ? " · hidden" : ""}`;
        return <Text key={typeof entry === "string" ? entry : entry.id} color={actualIndex === pickerIndex ? "yellow" : "white"}>
          {actualIndex === pickerIndex ? "› " : "  "}{label}
        </Text>;
      })}
    </Box>}
    {suggestions.length > 0 && <Box borderStyle="round" borderColor="cyan" flexDirection="column" marginTop={1}>
      <Text color="black" backgroundColor="cyan" bold> SUGGESTIONS </Text>
      {suggestions.map(([command, description], index) => <Box key={command} paddingX={2}>
        <Text color={index === suggestionIndex ? "black" : "gray"} backgroundColor={index === suggestionIndex ? "cyan" : undefined}>
          {index === suggestionIndex ? "› " : "  "}{command.padEnd(26, " ")} {description}
        </Text>
      </Box>)}
    </Box>}
    <Box borderStyle="round" borderColor={busy ? "magenta" : "cyan"} paddingX={1} paddingY={0} marginTop={1}>
      <Text color={busy ? "magenta" : "cyan"} bold>{busy ? "⟳ " : "› "}</Text>
      <TextInput key={inputMount} focus={!picker} showCursor={!picker} value={input} onChange={setInput} onSubmit={submit} placeholder="Talk normally, or type /research for autonomous work..." />
    </Box>
    <Box marginLeft={2} marginTop={0}>
      <Text color="cyan" bold>{config.provider.toUpperCase()}</Text><Text color="gray"> · </Text><Text color="green" bold>{config.model}</Text><Text color="gray"> · </Text><Text color="magenta" bold>THINKING: {config.reasoningEffort.toUpperCase()}</Text><Text color="gray"> · </Text><Text color="blue" bold>MODE: {config.mode.toUpperCase()}</Text><Text color="gray"> · </Text><Text color="yellow" bold>PERMISSIONS: {config.autonomy.toUpperCase()}</Text>
    </Box>
  </Box>;
}
