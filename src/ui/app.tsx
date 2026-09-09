import React, { useEffect, useRef, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import TextInput from "ink-text-input";
import Spinner from "ink-spinner";
import { join, relative } from "node:path";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { ResearchStore } from "../core/store.js";
import { runProcess, splitCommandLine, type ProcessControl } from "../core/process.js";
import { executorFor } from "../core/executors.js";
import { ensureWorktree } from "../core/worktree.js";
import { auditExperiment } from "../core/validation.js";
import { sha256File } from "../core/evidence.js";
import { compareRuns } from "../core/statistics.js";
import { recoveryDelay, recoveryPlan } from "../core/recovery.js";
import { prepareSubmission, validateSubmissionBundle } from "../core/submissions.js";
import { diversityReport, greedyBlend, loadPredictionVector, type PredictionVector } from "../core/ensemble.js";
import { renderReport, writeReport, type ReportKind } from "../core/reports.js";
import { auditData } from "../core/data-audit.js";
import { createValidationPolicy, writeValidationPolicy } from "../core/validation-policy.js";
import { retrieveSource, sourceClaims, sourceSearchText } from "../core/sources.js";
import { activePhaseGoal, definePhaseGoals } from "../core/phase-goals.js";
import { createExperimentManifest, manifestSummary } from "../core/experiment-manifest.js";
import { materializeResearchDecision } from "../core/research-graph.js";
import { whestbenchConfig } from "../competitions/whestbench.js";
import { getCompetitionAdapter } from "../competitions/adapters.js";
import { checkProvider, codexLoginStatus, listCodexModels, listLocalModels, loginCodex, runWithLocalFallback, type AgentProvider, type AvailableModel } from "../agents/codex-exec.js";
import { formatResearchDecision, runResearchDirector } from "../agents/research-director.js";
import { ExperimentManifestSchema, PhaseGoalSchema, RunResultSchema } from "../core/types.js";

type Message = { role: "user" | "assistant" | "system"; text: string };
type WorkbenchMode = "research" | "challenge";
type AutonomyLevel = "safe" | "fast" | "yolo";
type ResearchCampaign = { goal: string; budgetMinutes: number; stopCondition: string; startedAt: string; status: "setup" | "running" | "paused" | "completed" };
type SessionConfig = { provider: AgentProvider; model: string; reasoningEffort: string; mode: WorkbenchMode; autonomy: AutonomyLevel; campaign?: ResearchCampaign };

const defaultConfig: SessionConfig = { provider: "codex", model: "default", reasoningEffort: "medium", mode: "research", autonomy: "safe" };
const COMMANDS = [
  ["/help", "Show commands"],
  ["/mode", "Show or switch active mode"],
  ["/research", "Inspect, run, and explain the next research decision"],
  ["/challenge", "Run the active challenge workflow"],
  ["/experiment", "Create or run a reproducible experiment"],
  ["/loop", "Run the autonomous research loop"],
  ["/status", "Show complete workbench state"],
  ["/usage", "Show budget, activity, and campaign usage"],
  ["/sources", "Retrieve and search research sources"],
  ["/memory", "Search durable evidence and research memory"],
  ["/data", "Inspect or audit competition data"],
  ["/validation", "Inspect or generate validation policy"],
  ["/agents", "Show research-agent lanes and health"],
  ["/compute", "Show execution and compute health"],
  ["/submission", "Prepare and validate a submission bundle"],
  ["/queue", "Show durable research work queue"],
  ["/sessions", "List saved terminal sessions"],
  ["/resume", "Resume a saved session explicitly"],
  ["/ensemble", "Analyze prediction diversity and blends"],
  ["/report", "Generate portable research reports"],
  ["/doctor", "Diagnose local research dependencies"],
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
const AGENT_ROLES = ["research director", "data detective", "validation scientist", "model researcher", "ensemble scientist", "experiment engineer", "critic", "repair agent"] as const;
const SUBCOMMANDS: Record<string, readonly (readonly [string, string])[]> = {
  "/workbench": [["/workbench research", "Enter Research mode"], ["/workbench challenge", "Enter Challenge mode"]],
  "/mode": [["/mode research", "Enter Research mode"], ["/mode challenge", "Enter Challenge mode"]],
  "/autonomy": [["/autonomy safe", "Approval-gated"], ["/autonomy fast", "Run local work automatically"], ["/autonomy yolo", "Run routine work automatically"]],
  "/permissions": [["/permissions safe", "Approval-gated"], ["/permissions fast", "Run local work automatically"], ["/permissions yolo", "Run routine work automatically"]],
  "/loop": [["/loop status", "Show loop state"], ["/loop once", "Run one research cycle"], ["/loop start", "Start autonomous loop"], ["/loop pause", "Pause loop"], ["/loop stop", "Stop loop"]],
  "/scheduler": [["/scheduler start", "Start scheduling"], ["/scheduler pause", "Pause scheduling"], ["/scheduler drain", "Finish active work only"]],
  "/thinking": REASONING_LEVELS.map((level) => [`/thinking ${level}`, `Thinking effort: ${level}`] as const),
  "/provider": [["/provider codex", "Use authenticated Codex"], ["/provider local", "Use local Ollama"]],
  "/login": [["/login codex", "Sign in with ChatGPT subscription"], ["/login status", "Check Codex authentication"]],
  "/research": [["/research next", "Run the next evidence-gathering cycle"], ["/research status", "Show research state"], ["/research start", "Start research scheduling"], ["/research pause", "Pause research scheduling"]],
  "/challenge": [["/challenge status", "Show challenge state"], ["/challenge inspect", "Inspect rules and evaluator"], ["/challenge audit", "Audit files and duplicate data"], ["/challenge policy", "Generate validation policy"], ["/challenge baseline", "Run the canonical baseline"], ["/challenge start", "Start challenge zero-to-hero flow"]],
  "/experiment": [["/experiment list", "List experiment manifests"], ["/experiment propose", "Create an immutable manifest"], ["/experiment run", "Run an isolated experiment"], ["/experiment replicate", "Create an independent replication"], ["/experiment compare", "Compare two runs"], ["/experiment audit", "Audit evidence gates"]],
  "/sources": [["/sources list", "List retrieved sources"], ["/sources add", "Retrieve a URL into the evidence store"], ["/sources search", "Search retrieved sources"], ["/sources show", "Show a source and excerpt"]],
  "/memory": [["/memory recent", "Show recent evidence"], ["/memory search", "Search evidence and sources"]],
  "/data": [["/data audit", "Audit files and exact duplicates"]],
  "/validation": [["/validation inspect", "Show validation policy"], ["/validation generate", "Generate a versioned policy"]],
  "/agents": [["/agents status", "Show agent/provider health"], ["/agents limits", "Show configured limits"]],
  "/compute": [["/compute status", "Show executor health"], ["/compute budget", "Show campaign usage"]],
  "/submission": [["/submission status", "List prepared bundles"], ["/submission prepare", "Build a provenance bundle"], ["/submission validate", "Validate a bundle"]],
  "/queue": [["/queue status", "Show queued and running tasks"], ["/queue recover", "Requeue stale tasks"]],
  "/sessions": [["/sessions", "List recent saved sessions"]],
  "/resume": [["/resume", "Resume the latest saved session"], ["/resume ", "Resume a selected session"]],
  "/ensemble": [["/ensemble candidates", "List prediction artifacts"], ["/ensemble diversity", "Compare prediction diversity"], ["/ensemble propose", "Create an OOF blend candidate"]],
  "/report": [["/report research", "Write a research report"], ["/report challenge", "Write a challenge report"], ["/report final", "Write a provenance report"]],
};

function loadConfig(path: string): SessionConfig {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<SessionConfig>;
    const config = { ...defaultConfig, ...raw } as SessionConfig;
    // Permissions are intentionally session-scoped. Never inherit fast/YOLO from a prior terminal.
    config.autonomy = defaultConfig.autonomy;
    // Older Evidra sessions used a model name that ChatGPT-account Codex does not accept.
    if (config.provider === "codex" && config.model === "gpt-5.3-codex") config.model = "default";
    if (config.provider === "local" && /^(gpt|codex)/i.test(config.model)) config.model = "unconfigured";
    if (config.campaign?.status === "running") config.campaign = { ...config.campaign, status: "paused" };
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
    "/usage                       Show budgets and research activity",
    "/sources [add|search|show]   Retrieve or search research sources",
    "/memory [recent|search]      Search durable evidence memory",
    "/data audit                 Audit challenge files and duplicates",
    "/validation [inspect|generate] Show validation policy",
    "/agents                     Show research-agent health",
    "/compute                    Show execution and budget health",
    "/doctor                     Diagnose local dependencies",
    "/submission [prepare|validate] Build or validate a safe bundle",
    "/queue [status|recover]      Show or recover durable tasks",
    "/sessions                   List saved terminal sessions",
    "/resume [session-id]        Explicitly resume a saved session",
    "/ensemble [candidates|diversity|propose] Analyze prediction artifacts",
    "/report [research|challenge|final] Generate a portable report",
    "/provider [codex|local]      Select ChatGPT Codex or local Ollama",
    "/model [name]                Show or select the model (use default for Codex)",
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
  const [progress, setProgress] = useState("");
  const [availableModels, setAvailableModels] = useState<AvailableModel[]>([]);
  const [selectedModel, setSelectedModel] = useState<AvailableModel | null>(null);
  const [picker, setPicker] = useState<"model" | "reasoning" | "mode" | "permissions" | null>(null);
  const [pickerIndex, setPickerIndex] = useState(0);
  const [suggestionIndex, setSuggestionIndex] = useState(0);
  const [setupStep, setSetupStep] = useState<"goal" | "budget" | "stop" | null>(null);
  const [setupDraft, setSetupDraft] = useState<{ goal?: string; budgetMinutes?: number }>({});
  const [inputMount, setInputMount] = useState(0);
  const sessionId = useRef(`session_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
  const messagesRef = useRef<Message[]>(messages);
  const configRef = useRef<SessionConfig>(config);
  const submitRef = useRef<(value: string) => Promise<void>>(async () => undefined);
  const suppressNextSubmit = useRef(false);
  const loopTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const loopBusy = useRef(false);
  const activeProcess = useRef<ProcessControl | null>(null);
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
  const reasoningChoices = selectedModel?.supportedReasoningEfforts?.length ? selectedModel.supportedReasoningEfforts : REASONING_LEVELS;
  const modeChoices: readonly WorkbenchMode[] = ["research", "challenge"];
  const permissionChoices: readonly AutonomyLevel[] = ["safe", "fast", "yolo"];

  useEffect(() => saveConfig(configPath, config), [config, configPath]);

  useEffect(() => {
    if (config.campaign) return;
    const store = new ResearchStore(join(root, ".sota", "database.sqlite"));
    const saved = store.campaign();
    store.close();
    if (saved && typeof saved === "object" && "goal" in saved && "budgetMinutes" in saved) {
      const campaign = saved as ResearchCampaign;
      // A campaign from a previous process is resumable state, never a live worker.
      setConfig((current) => ({ ...current, campaign: campaign.status === "running" ? { ...campaign, status: "paused" } : campaign }));
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
      try {
        const models = config.provider === "codex" ? await listCodexModels() : await listLocalModels();
        if (active) {
          setAvailableModels(models);
          if (config.provider === "local" && (!models.some((model) => model.id === config.model) || config.model === "unconfigured")) {
            setConfig((current) => ({ ...current, model: models[0]?.id ?? "unconfigured" }));
          }
        }
      } catch {
        if (active) {
          setAvailableModels([]);
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
    activeProcess.current?.terminate();
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
      activeProcess.current.terminate();
      append("assistant", "Interrupted · stopping the active process and its child workers.");
      setProgress("Interrupted · stopping...");
      return;
    }
    if (picker) {
      const choices = picker === "model" ? availableModels : picker === "reasoning" ? reasoningChoices : picker === "mode" ? modeChoices : permissionChoices;
      if (key.escape) { setPicker(null); return; }
      if (key.downArrow) { setPickerIndex((current) => (current + 1) % choices.length); return; }
      if (key.upArrow) { setPickerIndex((current) => (current - 1 + choices.length) % choices.length); return; }
      if (key.return && choices.length > 0) {
        if (picker === "model") {
          const chosen = availableModels[pickerIndex];
          setSelectedModel(chosen);
          setConfig((current) => ({ ...current, model: chosen.id }));
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

  const append = (role: Message["role"], text: string): void => setMessages((current) => [...current, { role, text }]);

  const activeAdapter = () => {
    const store = new ResearchStore(join(root, ".sota", "database.sqlite"));
    const project = store.project();
    store.close();
    return getCompetitionAdapter(project?.competitionId ?? "whestbench");
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

  const persistCampaign = (campaign: ResearchCampaign): void => {
    const store = new ResearchStore(join(root, ".sota", "database.sqlite"));
    store.saveCampaign(campaign);
    store.close();
  };

  const performResearchObservation = async (): Promise<Record<string, unknown>> => {
    setProgress("Research 1/3 · inspecting repository and challenge state...");
    const status = await runProcess(["git", "status", "--short"], root);
    const files = await runProcess(["rg", "--files", "-g", "!.sota/**", "-g", "!node_modules/**"], root, 60_000);
    const observation: Record<string, unknown> = {
      gitStatus: status.stdout.trim().split("\n").filter(Boolean).slice(0, 40),
      repositoryFiles: files.stdout.trim().split("\n").filter(Boolean).slice(0, 120),
    };
    if (config.mode === "challenge") {
      setProgress("Research 2/3 · running the canonical baseline evaluator...");
      const adapter = activeAdapter();
      const baseline = await runProcess(
        adapter.baselineCommand(),
        adapter.workspacePath(root),
        15 * 60_000,
        (stream, chunk) => {
          const line = chunk.replace(/\s+/g, " ").trim();
          if (line) setProgress(`Research 2/3 · ${stream}: ${line.slice(-120)}`);
        },
        (control) => { activeProcess.current = control; },
      );
      activeProcess.current = null;
      observation.baseline = { exitCode: baseline.exitCode, durationMs: baseline.durationMs, stdout: baseline.stdout.slice(-4000), stderr: baseline.stderr.slice(-4000) };
    }
    const evidenceStore = new ResearchStore(join(root, ".sota", "database.sqlite"));
    evidenceStore.appendEvent("research.observation", observation);
    evidenceStore.saveClaim({
      id: `claim_observation_${Date.now()}`,
      payload: {
        statement: `Repository inspection and ${config.mode === "challenge" ? "canonical baseline execution" : "workspace inspection"} completed before the research decision.`,
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

  const runResearchCycle = async (objective: string): Promise<{ text: string; goalStatus: "active" | "blocked" | "met"; decision: "inspect" | "propose" | "run" | "replicate" | "stop" }> => {
    const observation = await performResearchObservation();
    setProgress("Research 3/3 · asking the director to analyze observed evidence and select the next experiment...");
    const store = new ResearchStore(join(root, ".sota", "database.sqlite"));
    const project = store.project();
    if (!store.phaseGoals().length) {
      for (const goal of definePhaseGoals(objective, config.mode)) store.savePhaseGoal({ id: goal.id, phase: goal.phase, status: goal.status, payload: goal });
    }
    const phaseGoal = activePhaseGoal(store.phaseGoals().map((entry) => PhaseGoalSchema.parse(entry.payload)));
    const recentEvents = store.recentEvents(20);
    const researchSources = store.sources().slice(0, 12).map((entry) => {
      const payload = entry.payload as { id?: string; title?: string; url?: string; excerpt?: string; claims?: string[] };
      return { id: entry.id, title: payload.title, url: payload.url, excerpt: payload.excerpt, claims: payload.claims?.slice(0, 8) };
    });
    store.close();
    const laneStore = new ResearchStore(join(root, ".sota", "database.sqlite"));
    laneStore.updateAgentLane({ role: "research director", status: "running", provider: config.provider, model: config.model, task: objective });
    laneStore.close();
    const adapter = activeAdapter();
    let decision: Awaited<ReturnType<typeof runResearchDirector>>;
    try {
      await checkProvider({ provider: config.provider, model: config.model, cwd: root });
      decision = await runResearchDirector(objective, {
        mode: config.mode,
        project,
        competition: adapter.config,
        recentEvents,
        observation,
        researchSources,
        ultimateGoal: objective,
        phaseGoal: phaseGoal ?? null,
        constraints: { no_submission: true, no_file_edits: true },
      }, { provider: config.provider, model: config.model, reasoningEffort: config.reasoningEffort, cwd: root, fallbackLocalModel: "qwen3.6:27b", onProcess: (control) => { activeProcess.current = control; } }, setProgress);
      activeProcess.current = null;
      const completedLane = new ResearchStore(join(root, ".sota", "database.sqlite"));
      completedLane.updateAgentLane({ role: "research director", status: "idle", provider: config.provider, model: config.model, task: null });
      completedLane.close();
    } catch (error) {
      const failedLane = new ResearchStore(join(root, ".sota", "database.sqlite"));
      failedLane.updateAgentLane({ role: "research director", status: "failed", provider: config.provider, model: config.model, task: objective, error: error instanceof Error ? error.message : String(error) });
      failedLane.close();
      throw error;
    }
    const decisionStore = new ResearchStore(join(root, ".sota", "database.sqlite"));
    materializeResearchDecision(decisionStore, decision);
    if (phaseGoal) {
      const now = new Date().toISOString();
      decisionStore.savePhaseGoal({ id: phaseGoal.id, phase: phaseGoal.phase, status: decision.goalStatus === "met" ? "met" : "active", payload: { ...phaseGoal, status: decision.goalStatus === "met" ? "met" : "active", attempts: phaseGoal.attempts + 1, updatedAt: now } });
    }
    if (phaseGoal && decision.goalStatus === "met") {
      const goals = decisionStore.phaseGoals().map((entry) => PhaseGoalSchema.parse(entry.payload));
      const index = goals.findIndex((goal) => goal.id === phaseGoal.id);
      const now = new Date().toISOString();
      if (index >= 0) {
        decisionStore.savePhaseGoal({ id: phaseGoal.id, phase: phaseGoal.phase, status: "met", payload: { ...goals[index], status: "met", updatedAt: now } });
        const next = goals[index + 1];
        if (next) decisionStore.savePhaseGoal({ id: next.id, phase: next.phase, status: "active", payload: { ...next, status: "active", updatedAt: now } });
      }
    }
    decisionStore.close();
    return { text: formatResearchDecision(decision), goalStatus: decision.goalStatus, decision: decision.decision };
  };

  const proposeLatestExperiment = async (): Promise<{ id: string; text: string } | null> => {
    const adapter = activeAdapter();
    const store = new ResearchStore(join(root, ".sota", "database.sqlite"));
    const hypothesis = store.hypotheses()[0];
    if (!hypothesis) { store.close(); return null; }
    const commit = await runProcess(["git", "rev-parse", "HEAD"], root);
    if (commit.exitCode !== 0) { store.close(); throw new Error(`Cannot create manifest: ${commit.stderr || commit.stdout}`); }
    const id = `exp_${Date.now()}_${hypothesis.id.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 32)}`;
    const manifest = createExperimentManifest({ id, hypothesisId: hypothesis.id, gitCommit: commit.stdout.trim(), datasetVersion: adapter.config.datasetRevision }, adapter.config);
    store.saveExperiment({ id, payload: { ...manifest, status: "proposed" } });
    store.close();
    return { id, text: `\n\nExperiment manifest proposed\n${manifestSummary(manifest)}\nNext: /experiment show ${id}` };
  };

  const executeExperiment = async (id: string): Promise<string> => {
    const store = new ResearchStore(join(root, ".sota", "database.sqlite"));
    const entry = store.experiments().find((experiment) => experiment.id === id);
    if (!entry) { store.close(); throw new Error(`Experiment not found: ${id}`); }
    const manifest = ExperimentManifestSchema.parse(entry.payload);
    const adapter = activeAdapter();
    const hypothesis = store.hypotheses().find((candidate) => candidate.id === manifest.hypothesisId);
    const entryPayload = entry.payload as Record<string, unknown>;
    store.saveExperiment({ id, payload: { ...entryPayload, status: "running" } });
    store.close();
    setProgress(`Experiment ${id} · creating isolated worktree...`);
    const worktree = await ensureWorktree(root, root, id);
    const experimentCwd = join(worktree, relative(root, adapter.workspacePath(root)));
    if (config.provider === "codex") {
      setProgress(`Experiment ${id} · experiment engineer implementing the hypothesis...`);
      await runWithLocalFallback({
        role: "experiment engineer",
        objective: "Implement the selected hypothesis in this isolated worktree. Inspect the existing estimator, make the smallest reproducible change, run relevant tests or smoke checks, and leave the worktree ready for evaluation. Do not touch files outside this worktree and do not submit anything.",
        context: { manifest, hypothesis: hypothesis?.payload ?? null, worktree: experimentCwd },
      }, { provider: config.provider, model: config.model, cwd: worktree, reasoningEffort: config.reasoningEffort, sandbox: "workspace-write" }, undefined, setProgress, (control) => { activeProcess.current = control; });
    }
    const command = adapter.experimentCommand();
    setProgress(`Experiment ${id} · running ${manifest.resources.executor} executor...`);
    const executor = executorFor(manifest.resources.executor);
    let result = await executor.run(manifest, experimentCwd, command, (control) => { activeProcess.current = control; });
    let attempt = 1;
    while (result.status !== "completed") {
      const plan = recoveryPlan(result.failureClass);
      if (!plan.retry || attempt >= plan.maxAttempts) break;
      const delay = recoveryDelay(plan, attempt);
      const retryStore = new ResearchStore(join(root, ".sota", "database.sqlite"));
      retryStore.appendEvent("run.retry.scheduled", { experimentId: id, runId: result.runId, attempt, delaySeconds: delay, failureClass: result.failureClass, action: plan.action });
      retryStore.close();
      setProgress(`Experiment ${id} · retry ${attempt + 1}/${plan.maxAttempts} after ${plan.action}...`);
      await new Promise<void>((resolve) => setTimeout(resolve, delay * 1000));
      attempt += 1;
      result = await executor.run(manifest, experimentCwd, command, (control) => { activeProcess.current = control; });
    }
    activeProcess.current = null;
    const artifactDir = join(root, ".sota", "artifacts", result.runId);
    mkdirSync(artifactDir, { recursive: true });
    const stdoutPath = join(artifactDir, "stdout.log");
    const stderrPath = join(artifactDir, "stderr.log");
    const metricsPath = join(artifactDir, "metrics.json");
    const environmentPath = join(artifactDir, "environment.json");
    writeFileSync(stdoutPath, result.stdout ?? "");
    writeFileSync(stderrPath, result.stderr ?? "");
    writeFileSync(metricsPath, `${JSON.stringify(result.metrics, null, 2)}\n`);
    writeFileSync(environmentPath, `${JSON.stringify({
      capturedAt: new Date().toISOString(),
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      cwd: result.cwd,
      command: result.command,
      executor: manifest.resources.executor,
      gpu: manifest.resources.gpu ?? null,
      environment: Object.fromEntries(Object.entries(process.env).filter(([key]) => !/(TOKEN|KEY|SECRET|PASSWORD|COOKIE|AUTH)/i.test(key))),
    }, null, 2)}\n`);
    const recordedResult = {
      ...result,
      recoveryAttempts: attempt,
      artifacts: { "stdout.log": stdoutPath, "stderr.log": stderrPath, "metrics.json": metricsPath, "environment.json": environmentPath },
    };
    const resultStore = new ResearchStore(join(root, ".sota", "database.sqlite"));
    resultStore.saveRun({ id: result.runId, experimentId: id, status: recordedResult.status, payload: recordedResult });
    for (const [name, path] of Object.entries(recordedResult.artifacts)) {
      resultStore.saveArtifact({ id: `${result.runId}-${name}`, runId: result.runId, name, path, checksum: sha256File(path) });
    }
    resultStore.saveExperiment({ id, payload: { ...entryPayload, status: recordedResult.status === "completed" ? "completed" : "failed", runId: result.runId, worktreePath: experimentCwd } });
    resultStore.close();
    return `\n\nExperiment ${id} ${recordedResult.status}\nRun: ${recordedResult.runId}\nExit code: ${recordedResult.exitCode}\nDuration: ${recordedResult.durationSeconds.toFixed(1)}s\nMetric: ${recordedResult.metrics.final_layer_mse ?? "not parsed"}\nArtifacts: ${Object.keys(recordedResult.artifacts).join(", ")}\nFailure: ${recordedResult.failureClass ?? "none"}`;
  };

  const runAutonomousCycle = async (campaignOverride?: ResearchCampaign): Promise<void> => {
    if (loopBusy.current || busy) return;
    ensureActiveProject();
    loopBusy.current = true;
    setBusy(true); setProgress("Autonomous loop: choosing the next highest-information decision...");
    const store = new ResearchStore(join(root, ".sota", "database.sqlite"));
    store.requeueStaleTasks();
    store.setSchedulerState({ status: "running", mode: config.mode, currentStep: "research" });
    store.close();
    let queueTaskId: string | undefined;
    try {
      const campaign = campaignOverride ?? config.campaign;
      if (campaign) {
        const elapsed = (Date.now() - Date.parse(campaign.startedAt)) / 60_000;
        if (elapsed >= campaign.budgetMinutes) {
          campaign.status = "completed";
          persistCampaign(campaign);
          setConfig((current) => ({ ...current, campaign: { ...campaign, status: "completed" } }));
          const stopped = new ResearchStore(join(root, ".sota", "database.sqlite"));
          stopped.setSchedulerState({ status: "idle", mode: config.mode, currentStep: "budget-exhausted" });
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
      queueStore.claimNextTask();
      queueStore.close();
      const cycle = await runResearchCycle(objective);
      const update = new ResearchStore(join(root, ".sota", "database.sqlite"));
      update.setSchedulerState({ status: "running", mode: config.mode, currentStep: "awaiting-next-cycle" });
      update.close();
      const proposed = config.mode === "challenge" ? await proposeLatestExperiment() : null;
      append("assistant", cycle.text + (proposed?.text ?? ""));
      if (proposed && config.mode === "challenge" && config.autonomy === "yolo") append("assistant", await executeExperiment(proposed.id));
      if (queueTaskId) { const queueStore = new ResearchStore(join(root, ".sota", "database.sqlite")); queueStore.updateTask(queueTaskId, "completed", { decision: cycle.decision, goalStatus: cycle.goalStatus }); queueStore.close(); }
      if (campaign && cycle.decision === "stop") {
        campaign.status = "completed";
        persistCampaign(campaign);
        setConfig((current) => ({ ...current, campaign: { ...campaign, status: "completed" } }));
        if (loopTimer.current) { clearInterval(loopTimer.current); loopTimer.current = null; }
        const stopped = new ResearchStore(join(root, ".sota", "database.sqlite"));
        stopped.setSchedulerState({ status: "idle", mode: config.mode, currentStep: "campaign-complete" });
        stopped.close();
        append("assistant", "Autonomous research stopping condition accepted by the research director.");
      } else if (campaign && cycle.goalStatus === "blocked") {
        campaign.status = "paused";
        persistCampaign(campaign);
        setConfig((current) => ({ ...current, campaign: { ...campaign, status: "paused" } }));
        if (loopTimer.current) { clearInterval(loopTimer.current); loopTimer.current = null; }
        const blocked = new ResearchStore(join(root, ".sota", "database.sqlite"));
        blocked.setSchedulerState({ status: "paused", mode: config.mode, currentStep: "blocked" });
        blocked.close();
        append("assistant", "Autonomous research paused because the current phase is blocked. Resolve the bottleneck, then use /resume.");
      }
    } catch (error) {
      if (queueTaskId) { const queueStore = new ResearchStore(join(root, ".sota", "database.sqlite")); queueStore.updateTask(queueTaskId, "failed", { error: error instanceof Error ? error.message : String(error) }); queueStore.close(); }
      const update = new ResearchStore(join(root, ".sota", "database.sqlite"));
      update.setSchedulerState({ status: "paused", mode: config.mode, currentStep: "blocked" });
      update.close();
      append("assistant", error instanceof Error ? error.message : String(error));
      if (loopTimer.current) { clearInterval(loopTimer.current); loopTimer.current = null; }
    } finally {
      loopBusy.current = false;
      setBusy(false); setProgress("");
    }
  };

  const submit = async (value: string): Promise<void> => {
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
    if (!request || busy) return;
    append("user", request);
    if (setupStep) {
      if (request === "/cancel") {
        setSetupStep(null); setSetupDraft({}); append("assistant", "Autonomous research setup cancelled."); return;
      }
      if (setupStep === "goal") {
        setSetupDraft({ goal: request }); setSetupStep("budget");
        append("assistant", "Step 2/3 · What is the maximum budget? Examples: 120m, 4h, 2d"); return;
      }
      if (setupStep === "budget") {
        const budgetMinutes = parseBudgetMinutes(request);
        if (!budgetMinutes) { append("assistant", "Please enter a positive budget such as 90m, 4h, or 2d."); return; }
        setSetupDraft((current) => ({ ...current, budgetMinutes })); setSetupStep("stop");
        append("assistant", "Step 3/3 · When should Evidra stop? Describe the success condition, or say ‘when the current research goal is met’."); return;
      }
      const campaign: ResearchCampaign = { goal: setupDraft.goal ?? "Advance the research project", budgetMinutes: setupDraft.budgetMinutes ?? 60, stopCondition: request, startedAt: new Date().toISOString(), status: "running" };
      ensureActiveProject(); persistCampaign(campaign); setConfig((current) => ({ ...current, campaign })); setSetupStep(null); setSetupDraft({});
      append("assistant", `Autonomous research started\n  Goal: ${campaign.goal}\n  Budget: ${campaign.budgetMinutes} minutes\n  Stop: ${campaign.stopCondition}\n\nI will define internal phase goals, inspect evidence, run permitted checks, and continue until the condition or budget is reached.`);
      setBusy(true); setProgress("Starting autonomous research...");
      try {
        await runAutonomousCycle(campaign);
      } catch (error) { append("assistant", error instanceof Error ? error.message : String(error)); }
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
      const activeGoal = activePhaseGoal(store.phaseGoals().map((entry) => PhaseGoalSchema.parse(entry.payload)));
      const recent = store.recentEvents(5).map((event) => `${event.type} · ${event.createdAt}`).join("\n") || "No events yet.";
      store.close();
      append("assistant", `Evidra Workbench\nMode: ${config.mode}\nAutonomy: ${config.autonomy}\n\nActive phase goal\n  ${activeGoal?.phase ?? "not initialized"}: ${activeGoal?.title ?? "Run /research to define goals"}\n  status: ${activeGoal?.status ?? "pending"}\n  attempts: ${activeGoal?.attempts ?? 0}\n\nResearch graph\n  hypotheses  ${counts.hypotheses}\n  claims      ${counts.claims}\n  edges       ${counts.edges}\n  sources     ${counts.sources}\n  decisions   ${counts.decisions}\n\nChallenge execution\n  experiments ${counts.experiments}\n  runs        ${counts.runs}\n  artifacts   ${counts.artifacts}\n\nRecent events\n${recent}\n\nUse /mode to switch modes or /permissions to change automation permissions.`);
      return;
    }
    if (request === "/thinking" || request.startsWith("/thinking ")) {
      const level = request.split(/\s+/)[1];
      if (!level) append("assistant", `Thinking effort: ${config.reasoningEffort}\nUse /thinking ${reasoningChoices.join(", ")}.`);
      else if (!reasoningChoices.some((value) => value === level)) append("assistant", `Unsupported effort for ${config.model}. Choose: ${reasoningChoices.join(", ")}.`);
      else { setConfig((current) => ({ ...current, reasoningEffort: level })); append("assistant", `Thinking effort selected: ${level}`); }
      return;
    }
    if (request === "/autonomy" || request.startsWith("/autonomy ") || request === "/permissions" || request.startsWith("/permissions ")) {
      const level = request.split(/\s+/)[1] as AutonomyLevel | undefined;
      if (!level) {
        setPicker("permissions");
        setPickerIndex(Math.max(0, permissionChoices.indexOf(config.autonomy)));
        append("assistant", "Select permissions with ↑/↓ and Enter. YOLO allows routine implementation and local execution automatically.");
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
      setMessages([...resumedMessages, { role: "system", text: `Resumed ${saved.id} · permissions remain ${config.autonomy.toUpperCase()} for this terminal.` }]);
      setConfig(resumedConfig);
      const campaign = resumedConfig.campaign;
      if (campaign) {
        const activeCampaign = { ...campaign, status: "running" } as ResearchCampaign;
        persistCampaign(activeCampaign);
        setConfig((current) => ({ ...current, campaign: activeCampaign }));
        setTimeout(() => { void runAutonomousCycle(activeCampaign); }, 0);
      }
      return;
    }
    if (request === "/pause" || request === "/resume") {
      if (request === "/pause") activeProcess.current?.pause();
      if (request === "/resume") activeProcess.current?.resume();
      if (request === "/pause" && loopTimer.current) { clearInterval(loopTimer.current); loopTimer.current = null; }
      const store = new ResearchStore(join(root, ".sota", "database.sqlite"));
      store.setSchedulerState({ status: request === "/pause" ? "paused" : "running", mode: config.mode, currentStep: null });
      store.close();
      if (config.campaign) {
        const campaign = { ...config.campaign, status: request === "/pause" ? "paused" : "running" } as ResearchCampaign;
        persistCampaign(campaign);
        setConfig((current) => ({ ...current, campaign }));
        if (request === "/resume" && !loopTimer.current) {
          void runAutonomousCycle(campaign);
        }
      }
      append("assistant", request === "/pause" ? "Scheduling paused. Running jobs are unchanged." : "Scheduling resumed.");
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
      setBusy(true); setProgress("Zero-to-hero: initializing WhestBench...");
      try {
        const adapter = activeAdapter();
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
        const baseline = await runProcess(adapter.baselineCommand(), adapter.workspacePath(root));
        const baselineStore = new ResearchStore(join(root, ".sota", "database.sqlite"));
        baselineStore.appendEvent("baseline.completed", { exitCode: baseline.exitCode, stdout: baseline.stdout, stderr: baseline.stderr });
        baselineStore.setSchedulerState({ status: "running", mode: "challenge", currentStep: "research" });
        baselineStore.close();
        setProgress("Zero-to-hero: generating the first falsifiable research decision...");
        append("assistant", `Baseline ${baseline.exitCode === 0 ? "completed" : "failed"}.\n${baseline.stdout || baseline.stderr}`);
        const decisionText = (await runResearchCycle("Starting from the verified baseline, identify the first highest-information experiment. Include a falsification test, leakage risks, compute estimate, and replication plan.")).text;
        const proposed = await proposeLatestExperiment();
        append("assistant", decisionText + (proposed?.text ?? ""));
        if (proposed && config.autonomy === "yolo") append("assistant", await executeExperiment(proposed.id));
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
        setConfig((current) => ({
          provider,
          reasoningEffort: current.reasoningEffort,
          mode: current.mode,
          autonomy: current.autonomy,
          model: provider === "local"
            ? (current.provider === "local" ? current.model : "qwen3.6:27b")
            : (current.provider === "codex" ? current.model : "default"),
        }));
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
          append("assistant", `Provider: ${config.provider}\nModel: ${config.model}\nNo models loaded yet. Type /model again in a moment.`);
        }
      }
      else { setConfig((current) => ({ ...current, model })); append("assistant", `Model selected: ${model}`); }
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
        const status = loginCodex(mode);
        append("assistant", status === 0 ? "Codex login completed." : "Codex login did not complete.");
      } finally {
        if (wasRaw) process.stdin.setRawMode?.(true);
        setBusy(false); setProgress("");
      }
      return;
    }
    if (request === "/login status") { append("assistant", codexLoginStatus() || "No Codex login status returned."); return; }
    if (request === "/project" || request === "/project status" || request === "/project inspect") {
      const store = new ResearchStore(join(root, ".sota", "database.sqlite"));
      const project = store.project();
      store.close();
      append("assistant", request.endsWith("inspect") ? JSON.stringify(project?.config ?? null, null, 2) : project
        ? `Project: ${project.name}\nCompetition: ${project.competitionId}`
        : "No project initialized. Use /hero start or evidra init whestbench.");
      return;
    }
    if (request.startsWith("/project init") || request.startsWith("/challenge init")) {
      const competitionId = request.split(/\s+/)[2] ?? "whestbench";
      let adapter;
      try { adapter = getCompetitionAdapter(competitionId); }
      catch (error) { append("assistant", error instanceof Error ? error.message : String(error)); return; }
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
      const counts = store.counts(); const events = store.eventCount(); const state = store.schedulerState(); const campaign = config.campaign;
      store.close();
      const elapsed = campaign ? Math.max(0, (Date.now() - Date.parse(campaign.startedAt)) / 60_000) : 0;
      append("assistant", `Usage\n  provider: ${config.provider}\n  model: ${config.model}\n  thinking: ${config.reasoningEffort}\n  scheduler: ${state.status}\n  events: ${events}\n  hypotheses: ${counts.hypotheses} · claims: ${counts.claims} · decisions: ${counts.decisions}\n  experiments: ${counts.experiments} · runs: ${counts.runs} · artifacts: ${counts.artifacts}\n${campaign ? `\nCampaign\n  status: ${campaign.status}\n  elapsed: ${elapsed.toFixed(1)} / ${campaign.budgetMinutes} minutes\n  remaining: ${Math.max(0, campaign.budgetMinutes - elapsed).toFixed(1)} minutes\n  goal: ${campaign.goal}\n  stop: ${campaign.stopCondition}` : "\nNo autonomous campaign configured. Start one with /research."}`);
      return;
    }
    if (request === "/status" || request === "/project status") {
      const store = new ResearchStore(join(root, ".sota", "database.sqlite"));
      const project = store.project();
      const campaign = config.campaign;
      append("assistant", project ? `Project: ${project.name}\nCompetition: ${project.competitionId}\nMode: ${config.mode}\nAutonomy: ${config.autonomy}\nEvents: ${store.eventCount()}${campaign ? `\nCampaign: ${campaign.status}\nGoal: ${campaign.goal}\nBudget: ${campaign.budgetMinutes} minutes\nStop: ${campaign.stopCondition}` : ""}` : "No Evidra project initialized. Start with /research to configure an autonomous campaign.");
      store.close();
      return;
    }
    if (request === "/challenge" || request === "/challenge status" || request === "/challenge list") {
      const adapter = activeAdapter();
      append("assistant", `Active challenge: ${adapter.config.name}\nID: ${adapter.id}\nMetric: ${adapter.config.metric.name} (${adapter.config.metric.direction})\nUse /challenge inspect or /challenge baseline.`);
      return;
    }
    if (request === "/challenge audit") {
      const adapter = activeAdapter();
      const report = auditData(adapter.workspacePath(root));
      const store = new ResearchStore(join(root, ".sota", "database.sqlite"));
      store.appendEvent("data.audit.completed", report);
      store.saveClaim({ id: `claim_data_audit_${Date.now()}`, payload: { statement: `Data audit scanned ${report.scannedFiles} files and found ${report.duplicateGroups.length} exact duplicate group(s).`, scope: adapter.id, confidence: 1, sourceType: "observation", sourceId: `data_audit_${Date.now()}`, status: "active", report } });
      store.close();
      append("assistant", `Data audit · ${adapter.id}\nScanned: ${report.scannedFiles} files · ${report.totalBytes} bytes\nDuplicate groups: ${report.duplicateGroups.length}\nSkipped: ${report.skippedFiles.length}\n${report.warnings.length ? `Warnings:\n${report.warnings.map((warning) => `- ${warning}`).join("\n")}` : "No exact-duplicate or audit-limit warnings."}`);
      return;
    }
    if (request === "/challenge policy") {
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
      const store = new ResearchStore(join(root, ".sota", "database.sqlite"));
      store.appendEvent("data.audit.completed", report);
      store.saveClaim({ id: `claim_data_audit_${Date.now()}`, payload: { id: `claim_data_audit_${Date.now()}`, statement: `Data audit scanned ${report.scannedFiles} files and found ${report.duplicateGroups.length} exact duplicate group(s).`, scope: adapter.id, confidence: 1, sourceType: "observation", sourceId: `data_audit_${Date.now()}`, status: "active", report } });
      store.close();
      append("assistant", `Data audit · ${adapter.id}\nScanned: ${report.scannedFiles} files · ${report.totalBytes} bytes\nDuplicate groups: ${report.duplicateGroups.length}\nSkipped: ${report.skippedFiles.length}\n${report.warnings.length ? report.warnings.map((warning) => `- ${warning}`).join("\n") : "No audit warnings."}`);
      return;
    }
    if (request === "/validation inspect" || request === "/validation") {
      const path = join(root, ".sota", "validation-policy.json");
      append("assistant", existsSync(path) ? readFileSync(path, "utf8").trim() : "No validation policy is locked. Use /validation generate.");
      return;
    }
    if (request === "/validation generate") {
      const adapter = activeAdapter();
      const policy = createValidationPolicy(adapter.config);
      mkdirSync(join(root, ".sota"), { recursive: true });
      const path = join(root, ".sota", "validation-policy.json");
      const checksum = writeValidationPolicy(path, policy);
      const store = new ResearchStore(join(root, ".sota", "database.sqlite"));
      store.appendEvent("validation.policy.created", { path, checksum, policy }); store.close();
      append("assistant", `Validation policy generated\n  version: ${policy.version}\n  split: ${policy.primarySplit}\n  folds: ${policy.folds.join(", ")}\n  seeds: ${policy.seeds.join(", ")}\n  checksum: ${checksum}`);
      return;
    }
    if (request === "/challenge baseline") {
      const adapter = activeAdapter();
      setBusy(true); setProgress(`Running the canonical ${adapter.config.name} baseline...`);
      try {
        const result = await runProcess(adapter.baselineCommand(), adapter.workspacePath(root));
        const store = new ResearchStore(join(root, ".sota", "database.sqlite"));
        store.appendEvent("baseline.completed", { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr });
        store.close();
        append("assistant", `Baseline ${result.exitCode === 0 ? "completed" : "failed"}.\n${result.stdout || result.stderr}`);
      } catch (error) { append("assistant", error instanceof Error ? error.message : String(error)); }
      finally { setBusy(false); setProgress(""); }
      return;
    }
    if (request === "/inspect" || request === "/challenge inspect") { append("assistant", JSON.stringify(activeAdapter().config, null, 2)); return; }
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
        const currentCommit = await runProcess(["git", "rev-parse", "HEAD"], root);
        store.close();
        if (!run) { append("assistant", `No run recorded for ${id}. Run the experiment first.`); return; }
        try {
          const manifest = ExperimentManifestSchema.parse(payload);
          const runResult = RunResultSchema.parse(run.payload);
          const adapter = activeAdapter();
          const audit = auditExperiment(manifest, runResult, { currentCommit: currentCommit.stdout.trim(), datasetVersion: adapter.config.datasetRevision, splitVersion: manifest.splitVersion });
          const gateLines = Object.entries(audit.gates).map(([name, passed]) => `  ${passed ? "✓" : "·"} ${name}`).join("\n");
          append("assistant", `Evidence audit · ${id}\nStatus: ${audit.accepted ? "ACCEPTED" : "NOT ACCEPTED"}\n\n${gateLines}${audit.reasons.length ? `\n\nReasons:\n${audit.reasons.map((reason) => `- ${reason}`).join("\n")}` : ""}`);
        } catch (error) { append("assistant", error instanceof Error ? error.message : String(error)); }
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
        store.close();
        if (!baseline || !candidate) { append("assistant", "Usage: /experiment compare <baseline-id> <candidate-id> (experiment or run ids accepted)"); return; }
        try {
          const comparison = compareRuns(RunResultSchema.parse(baseline.payload), RunResultSchema.parse(candidate.payload), activeAdapter().config.metric.name);
          append("assistant", `Run comparison\n  baseline: ${comparison.baselineRunId} · ${comparison.baseline ?? "missing"}\n  candidate: ${comparison.candidateRunId} · ${comparison.candidate ?? "missing"}\n  delta: ${comparison.delta ?? "missing"}\n  result: ${comparison.direction}\n  evidence: ${comparison.evidence}${comparison.probabilityImproved === undefined ? "" : `\n  probability improved: ${(comparison.probabilityImproved * 100).toFixed(1)}%\n  95% CI: [${comparison.confidenceInterval?.[0].toFixed(6)}, ${comparison.confidenceInterval?.[1].toFixed(6)}]`}\n\n${comparison.note}`);
        } catch (error) { append("assistant", error instanceof Error ? error.message : String(error)); }
        return;
      }
      if (action === "replicate") {
        const parentId = parts[2];
        const parent = store.experiments().find((candidate) => candidate.id === parentId);
        if (!parent) { store.close(); append("assistant", `Experiment not found: ${parentId ?? "(missing id)"}`); return; }
        try {
          const parentManifest = ExperimentManifestSchema.parse(parent.payload);
          const id = `rep_${Date.now()}_${parentManifest.hypothesisId.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 28)}`;
          const manifest = createExperimentManifest({
            id,
            parent: parentManifest.id,
            hypothesisId: parentManifest.hypothesisId,
            gitCommit: parentManifest.gitCommit,
            datasetVersion: parentManifest.datasetVersion,
            splitVersion: parentManifest.splitVersion,
            configPatch: parentManifest.change.configPatch,
            executor: parentManifest.resources.executor,
            gpu: parentManifest.resources.gpu,
            timeoutMinutes: parentManifest.resources.timeoutMinutes,
            folds: parentManifest.evaluation.folds,
            seeds: [...parentManifest.evaluation.seeds, Date.now() % 100000],
            requiredArtifacts: parentManifest.evaluation.requiredArtifacts,
            minimumPrimaryDelta: parentManifest.acceptance.minimumPrimaryDelta,
            maximumRegressionShift: parentManifest.acceptance.maximumRegressionShift,
            requireReplication: false,
          }, activeAdapter().config);
          store.saveExperiment({ id, payload: { ...manifest, status: "proposed", replicationOf: parentManifest.id } });
          store.close();
          append("assistant", `Independent replication manifest created\n${manifestSummary(manifest)}\nParent: ${parentManifest.id}\nNext: /experiment run ${id}`);
        } catch (error) { store.close(); append("assistant", error instanceof Error ? error.message : String(error)); }
        return;
      }
      if (action === "run") {
        const id = parts[2];
        store.close();
        if (!id) { append("assistant", "Usage: /experiment run <id>"); return; }
        setBusy(true);
        try { append("assistant", await executeExperiment(id)); }
        catch (error) { append("assistant", error instanceof Error ? error.message : String(error)); }
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
      const manifest = createExperimentManifest({ id, hypothesisId, gitCommit: commit.stdout.trim(), datasetVersion: adapter.config.datasetRevision }, adapter.config);
      store.saveExperiment({ id, payload: { ...manifest, status: "proposed" } });
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
    if (request === "/compute" || request === "/compute status" || request === "/compute budget") {
      const campaign = config.campaign;
      append("assistant", `Executor policy\n  mode: ${config.mode}\n  autonomy: ${config.autonomy}\n  local: available through process workers\n  modal: ${process.env.MODAL_TOKEN_ID && process.env.MODAL_TOKEN_SECRET ? "configured" : "not configured"}\n  fallback: local model on Codex usage limits${campaign ? `\n\nCampaign budget\n  elapsed: ${Math.max(0, (Date.now() - Date.parse(campaign.startedAt)) / 60_000).toFixed(1)} / ${campaign.budgetMinutes} minutes\n  status: ${campaign.status}` : ""}`);
      return;
    }
    if (request === "/doctor") {
      const checks: string[] = [`node ${process.versions.node}`, `cwd ${root}`];
      for (const command of ["git", "uv", "codex"]) {
        const result = await runProcess(["sh", "-lc", `command -v ${command}`], root, 5_000);
        checks.push(`${command}: ${result.exitCode === 0 ? result.stdout.trim() : "not found"}`);
      }
      try { await listLocalModels(); checks.push("ollama: reachable"); } catch { checks.push("ollama: unavailable"); }
      checks.push(`modal: ${process.env.MODAL_TOKEN_ID && process.env.MODAL_TOKEN_SECRET ? "configured" : "not configured"}`);
      append("assistant", `Evidra doctor\n${checks.map((check) => `  ${check}`).join("\n")}`);
      return;
    }
    if (request === "/submission" || request === "/submission status" || request.startsWith("/submission prepare") || request.startsWith("/submission validate")) {
      const parts = request.split(/\s+/);
      const action = parts[1] ?? "status";
      const submissionsRoot = join(root, ".sota", "submissions");
      if (action === "status") {
        const bundles = existsSync(submissionsRoot) ? readdirSync(submissionsRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name) : [];
        append("assistant", bundles.length ? `Prepared submission bundles\n${bundles.map((id) => `- ${id}`).join("\n")}` : "No submission bundles prepared.");
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
        const run = store.runs().find((entry) => entry.experimentId === experimentId);
        store.close();
        if (!experiment || !run) { append("assistant", `Experiment ${experimentId} must have a recorded run before a bundle can be prepared.`); return; }
        try {
          const bundle = prepareSubmission(root, experimentId, ExperimentManifestSchema.parse(experiment.payload), RunResultSchema.parse(run.payload), activeAdapter().config);
          append("assistant", `Submission bundle prepared\n  id: ${bundle.id}\n  path: ${bundle.path}\n  next: /submission validate ${bundle.id}\n\nExternal submission remains approval-gated.`);
        } catch (error) { append("assistant", error instanceof Error ? error.message : String(error)); }
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
    if (request === "/ensemble" || request === "/ensemble candidates" || request === "/ensemble diversity" || request === "/ensemble propose") {
      const store = new ResearchStore(join(root, ".sota", "database.sqlite"));
      const vectors: PredictionVector[] = [];
      for (const artifact of store.artifacts().filter((entry) => /prediction|oof/i.test(entry.name))) {
        try { vectors.push(loadPredictionVector(artifact.id, artifact.path)); } catch { /* invalid candidates are reported below */ }
      }
      if (request === "/ensemble" || request === "/ensemble candidates") {
        store.close();
        append("assistant", vectors.length ? `Prediction candidates\n${vectors.map((vector) => `- ${vector.id} · ${vector.values.length} values · ${vector.path}`).join("\n")}` : "No valid prediction or OOF artifacts found. Completed runs must record prediction files before ensemble analysis.");
        return;
      }
      if (vectors.length < 2) { store.close(); append("assistant", "At least two valid prediction artifacts are required for ensemble analysis."); return; }
      const pairs = diversityReport(vectors);
      if (request === "/ensemble diversity") {
        store.close();
        append("assistant", `Prediction diversity\n${pairs.map((pair) => `- ${pair.left} ↔ ${pair.right}\n  correlation: ${pair.correlation.toFixed(4)} · mean disagreement: ${pair.disagreement.toFixed(6)}`).join("\n")}`);
        return;
      }
      const blend = greedyBlend(vectors);
      const blendId = `blend_${Date.now()}`;
      const blendPath = join(root, ".sota", "ensembles", `${blendId}.json`);
      mkdirSync(join(root, ".sota", "ensembles"), { recursive: true });
      writeFileSync(blendPath, `${JSON.stringify({ id: blendId, members: vectors.map((vector) => vector.id), values: blend, createdAt: new Date().toISOString(), status: "candidate" }, null, 2)}\n`);
      store.appendEvent("ensemble.candidate.created", { id: blendId, path: blendPath, members: vectors.map((vector) => vector.id), diversity: pairs });
      store.close();
      append("assistant", `Ensemble candidate created\n  id: ${blendId}\n  members: ${vectors.length}\n  path: ${blendPath}\n  status: candidate\n\nEvaluate only on out-of-fold data before promotion.`);
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
        append("assistant", `Source retrieved\n  ${retrieved.id}\n  ${retrieved.title}\n  ${retrieved.url}\n  hash: ${retrieved.contentHash}\n  claims: ${claims.length}\n\n${retrieved.excerpt}`);
      } catch (error) {
        append("assistant", error instanceof Error && error.name === "AbortError" ? "Source retrieval timed out after 20 seconds." : error instanceof Error ? error.message : String(error));
      } finally { clearTimeout(timeout); setBusy(false); setProgress(""); }
      return;
    }
    if (request === "/memory recent" || request === "/memory") {
      const store = new ResearchStore(join(root, ".sota", "database.sqlite"));
      const claims = store.claims().slice(0, 20); const events = store.recentEvents(10); store.close();
      append("assistant", `Recent research memory\n\nClaims\n${claims.length ? claims.map((claim) => `- ${claim.id}: ${String((claim.payload as { statement?: string }).statement ?? "")}`).join("\n") : "- none"}\n\nEvents\n${events.length ? events.map((event) => `- ${event.type} · ${event.createdAt}`).join("\n") : "- none"}`);
      return;
    }
    if (request.startsWith("/memory search ")) {
      const query = request.slice("/memory search ".length).trim().toLowerCase();
      const store = new ResearchStore(join(root, ".sota", "database.sqlite"));
      const claims = store.claims().filter((claim) => JSON.stringify(claim.payload).toLowerCase().includes(query)).slice(0, 20);
      const hypotheses = store.hypotheses().filter((hypothesis) => JSON.stringify(hypothesis.payload).toLowerCase().includes(query)).slice(0, 20);
      store.close();
      append("assistant", [...claims.map((claim) => `claim ${claim.id}: ${String((claim.payload as { statement?: string }).statement ?? "")}`), ...hypotheses.map((hypothesis) => `hypothesis ${hypothesis.id}: ${String((hypothesis.payload as { title?: string }).title ?? "")}`)].join("\n") || "No matching research memory.");
      return;
    }
    if (request === "/run" || request.startsWith("/run ") || request === "/shell" || request.startsWith("/shell ")) {
      const rawCommand = request.replace(/^\/(run|shell)\s*/, "");
      const command = splitCommandLine(rawCommand);
      const blocked = new Set(["sudo", "rm", "rmdir", "mkfs", "shutdown", "reboot", "poweroff"]);
      if (!command.length) { append("assistant", "Usage: /run rg -n hypothesis src or /run uv run pytest"); return; }
      if (blocked.has(command[0])) { append("assistant", `Refusing dangerous command '${command[0]}'. Use a reviewed experiment manifest for destructive operations.`); return; }
      setBusy(true); setProgress(`Running ${command.join(" ")}...`);
      try {
        const result = await runProcess(command, root, 15 * 60_000, (stream, chunk) => {
          const line = chunk.replace(/\s+/g, " ").trim();
          if (line) setProgress(`${stream}: ${line.slice(-140)}`);
        }, (control) => { activeProcess.current = control; });
        const output = [result.stdout.trim(), result.stderr.trim() ? `stderr:\n${result.stderr.trim()}` : ""].filter(Boolean).join("\n");
        append("assistant", `Command exited ${result.exitCode} in ${(result.durationMs / 1000).toFixed(1)}s\n$ ${command.join(" ")}\n${output || "(no output)"}`);
      } catch (error) { append("assistant", error instanceof Error ? error.message : String(error)); }
      finally { activeProcess.current = null; setBusy(false); setProgress(""); }
      return;
    }
    if (["/research status", "/research start", "/research pause", "/research stop"].includes(request)) {
      const action = request.split(/\s+/)[1];
      const store = new ResearchStore(join(root, ".sota", "database.sqlite"));
      if (action === "status") {
        const state = store.schedulerState();
        const goal = activePhaseGoal(store.phaseGoals().map((entry) => PhaseGoalSchema.parse(entry.payload)));
        const campaign = config.campaign;
        const counts = store.counts();
        append("assistant", `Research status\n  scheduler: ${state.status}\n  step: ${state.currentStep ?? "idle"}\n  phase: ${goal?.phase ?? "not initialized"}\n  phase goal: ${goal?.title ?? "none"}\n  attempts: ${goal?.attempts ?? 0}\n  decisions: ${counts.decisions} · hypotheses: ${counts.hypotheses} · claims: ${counts.claims}${campaign ? `\n\nCampaign\n  status: ${campaign.status}\n  goal: ${campaign.goal}\n  budget: ${campaign.budgetMinutes} minutes\n  stop: ${campaign.stopCondition}` : "\n\nNo campaign configured. Use /research to start one."}`);
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
        catch (error) { append("assistant", error instanceof Error ? error.message : String(error)); }
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

    setBusy(true); setProgress(`Using ${config.provider}/${config.model}`);
    try {
      await checkProvider({ provider: config.provider, model: config.model, cwd: root });
      const result = await runWithLocalFallback({
        role: "conversation assistant",
        objective: request,
        context: {
          mode: config.mode,
          instruction: "This is ordinary conversation, not a research cycle. Answer directly and concisely. Do not inspect files, run commands, edit code, propose experiments, or claim fresh measurements. If the user wants autonomous research, tell them to use /research.",
        },
      }, { provider: config.provider, model: config.model, cwd: root, reasoningEffort: config.reasoningEffort, sandbox: "read-only" }, "qwen3.6:27b", setProgress, (control) => { activeProcess.current = control; });
      append("assistant", String(result.output));
    } catch (error) {
      append("assistant", error instanceof Error ? error.message : String(error));
    } finally { setBusy(false); setProgress(""); }
  };
  submitRef.current = submit;

  return <Box flexDirection="column" padding={1} minHeight={Math.max(24, process.stdout.rows ?? 24)}>
    <Box borderStyle="round" borderColor="cyan" paddingX={2} paddingY={1} flexDirection="column">
      <Text color="cyan" bold>{LOGO}</Text>
      <Text color="gray"><Text color="cyan" bold>EVIDRA WORKBENCH</Text>  │  MODE: <Text color="yellow" bold>{config.mode.toUpperCase()}</Text>  │  PROVIDER: <Text color="cyan">{config.provider}/{config.model}</Text>  │  THINKING: {config.reasoningEffort}  │  PERMISSIONS: <Text color="yellow" bold>{config.autonomy.toUpperCase()}</Text></Text>
    </Box>
    <Box flexDirection="column" flexGrow={messages.length > 1 || busy ? 1 : 0} marginTop={1} paddingX={1}>
      {messages.slice(-16).map((message, index) => {
        const errorLike = message.role === "assistant" && /unreachable|not configured|not logged|failed|error|unavailable|refus|interrupted/i.test(message.text);
        const accent = message.role === "user" ? "yellow" : message.role === "system" ? "gray" : errorLike ? "red" : "green";
        const label = messageLabel(message);
        const body = label && message.role === "assistant" ? message.text.split("\n").slice(1).join("\n") : message.text;
        return <Box key={`${index}-${message.text}`} flexDirection="column" marginBottom={1} paddingX={1} borderStyle="round" borderColor={accent}>
          <Text color={accent} bold>{message.role === "user" ? "›" : message.role === "assistant" ? "◆" : "·"}{label ? ` ${label}` : ""}</Text>
          <RichText text={body} />
        </Box>;
      })}
    </Box>
    {busy && <Box borderStyle="single" borderColor="magenta" paddingX={1} marginTop={1}>
      <Text color="magenta"><Spinner type="dots" />  RUNNING  </Text><Text color="magenta">{progress}</Text>
    </Box>}
    {picker && <Box borderStyle="round" borderColor="cyan" paddingX={2} flexDirection="column" marginTop={1}>
      <Text color="cyan" bold>{picker === "model" ? `Select ${config.provider} model` : picker === "reasoning" ? "Select thinking effort" : picker === "mode" ? "Select workbench mode" : "Select permissions"}</Text>
      <Text color="gray">↑/↓ navigate · Enter select · Esc cancel</Text>
      {(picker === "model" ? availableModels : picker === "reasoning" ? reasoningChoices : picker === "mode" ? modeChoices : permissionChoices).slice(Math.max(0, pickerIndex - 5), pickerIndex + 7).map((entry, index) => {
        const actualIndex = Math.max(0, pickerIndex - 5) + index;
        const label = typeof entry === "string" ? entry : `${entry.displayName}  ${entry.id}${entry.isDefault ? " · default" : ""}${entry.hidden ? " · hidden" : ""}`;
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
