import React, { useEffect, useRef, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import TextInput from "ink-text-input";
import Spinner from "ink-spinner";
import { join } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { ResearchStore } from "../core/store.js";
import { runProcess, splitCommandLine } from "../core/process.js";
import { executorFor } from "../core/executors.js";
import { ensureWorktree } from "../core/worktree.js";
import { createExperimentManifest, manifestSummary } from "../core/experiment-manifest.js";
import { materializeResearchDecision } from "../core/research-graph.js";
import { whestbenchConfig } from "../competitions/whestbench.js";
import { checkProvider, codexLoginStatus, listCodexModels, listLocalModels, loginCodex, runWithLocalFallback, type AgentProvider, type AvailableModel } from "../agents/codex-exec.js";
import { formatResearchDecision, runResearchDirector } from "../agents/research-director.js";
import { ExperimentManifestSchema } from "../core/types.js";

type Message = { role: "user" | "assistant" | "system"; text: string };
type WorkbenchMode = "research" | "challenge";
type AutonomyLevel = "safe" | "fast" | "yolo";
type SessionConfig = { provider: AgentProvider; model: string; reasoningEffort: string; mode: WorkbenchMode; autonomy: AutonomyLevel };

const defaultConfig: SessionConfig = { provider: "codex", model: "default", reasoningEffort: "medium", mode: "research", autonomy: "safe" };
const COMMANDS = [
  ["/help", "Show commands"],
  ["/mode", "Show or switch active mode"],
  ["/research", "Inspect, run, and explain the next research decision"],
  ["/challenge", "Run the active challenge workflow"],
  ["/experiment", "Create or run a reproducible experiment"],
  ["/loop", "Run the autonomous research loop"],
  ["/status", "Show complete workbench state"],
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
  "/challenge": [["/challenge status", "Show challenge state"], ["/challenge inspect", "Inspect rules and evaluator"], ["/challenge baseline", "Run the canonical baseline"], ["/challenge start", "Start challenge zero-to-hero flow"]],
  "/experiment": [["/experiment list", "List experiment manifests"], ["/experiment propose", "Create an immutable manifest"], ["/experiment run", "Run an isolated experiment"]],
};

function loadConfig(path: string): SessionConfig {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<SessionConfig>;
    const config = { ...defaultConfig, ...raw } as SessionConfig;
    // Older Evidra sessions used a model name that ChatGPT-account Codex does not accept.
    if (config.provider === "codex" && config.model === "gpt-5.3-codex") config.model = "default";
    if (config.mode !== "research" && config.mode !== "challenge") config.mode = defaultConfig.mode;
    if (!["safe", "fast", "yolo"].includes(config.autonomy)) config.autonomy = defaultConfig.autonomy;
    return config;
  }
  catch { return defaultConfig; }
}

function saveConfig(path: string, config: SessionConfig): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
}

function help(): string {
  return [
    "/help                         Show commands",
    "/mode [research|challenge]   Show or switch active mode",
    "/research [question]         Inspect, run, and explain research automatically",
    "/challenge [start|status]    Start or inspect the active challenge",
    "/experiment [propose|run]    Create or run a reproducible experiment",
    "/loop [once|start|pause]     Run the autonomous research loop",
    "/status                      Show complete workbench state",
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
  const [inputMount, setInputMount] = useState(0);
  const submitRef = useRef<(value: string) => Promise<void>>(async () => undefined);
  const loopTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const loopBusy = useRef(false);
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
    let active = true;
    const loadModels = async (): Promise<void> => {
      try {
        const models = config.provider === "codex" ? await listCodexModels() : await listLocalModels();
        if (active) setAvailableModels(models);
      } catch {
        if (active) setAvailableModels([]);
      }
    };
    void loadModels();
    return () => { active = false; };
  }, [config.provider]);

  useEffect(() => setSuggestionIndex(0), [input]);
  useEffect(() => () => {
    if (loopTimer.current) clearInterval(loopTimer.current);
  }, []);

  useInput((value, key) => {
    if (key.ctrl && value === "c") exit();
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
      void submitRef.current(suggestions[suggestionIndex][0]);
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
      const baseline = await runProcess(
        ["uv", "run", "python", "estimator.py", "--baseline", "mean_propagation"],
        join(root, "competitions", "whestbench", "starterkit"),
        15 * 60_000,
        (stream, chunk) => {
          const line = chunk.replace(/\s+/g, " ").trim();
          if (line) setProgress(`Research 2/3 · ${stream}: ${line.slice(-120)}`);
        },
      );
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

  const runResearchCycle = async (objective: string): Promise<string> => {
    const observation = await performResearchObservation();
    setProgress("Research 3/3 · asking the director to analyze observed evidence and select the next experiment...");
    const store = new ResearchStore(join(root, ".sota", "database.sqlite"));
    const project = store.project();
    const recentEvents = store.recentEvents(20);
    store.close();
    await checkProvider({ provider: config.provider, model: config.model, cwd: root });
    const decision = await runResearchDirector(objective, {
      mode: config.mode,
      project,
      competition: whestbenchConfig,
      recentEvents,
      observation,
      constraints: { no_submission: true, no_file_edits: true },
    }, { provider: config.provider, model: config.model, reasoningEffort: config.reasoningEffort, cwd: root, fallbackLocalModel: "qwen3.6:27b" }, setProgress);
    const decisionStore = new ResearchStore(join(root, ".sota", "database.sqlite"));
    materializeResearchDecision(decisionStore, decision);
    decisionStore.close();
    return formatResearchDecision(decision);
  };

  const proposeLatestExperiment = async (): Promise<{ id: string; text: string } | null> => {
    const store = new ResearchStore(join(root, ".sota", "database.sqlite"));
    const hypothesis = store.hypotheses()[0];
    if (!hypothesis) { store.close(); return null; }
    const commit = await runProcess(["git", "rev-parse", "HEAD"], root);
    if (commit.exitCode !== 0) { store.close(); throw new Error(`Cannot create manifest: ${commit.stderr || commit.stdout}`); }
    const id = `exp_${Date.now()}_${hypothesis.id.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 32)}`;
    const manifest = createExperimentManifest({ id, hypothesisId: hypothesis.id, gitCommit: commit.stdout.trim(), datasetVersion: whestbenchConfig.datasetRevision }, whestbenchConfig);
    store.saveExperiment({ id, payload: { ...manifest, status: "proposed" } });
    store.close();
    return { id, text: `\n\nExperiment manifest proposed\n${manifestSummary(manifest)}\nNext: /experiment show ${id}` };
  };

  const executeExperiment = async (id: string): Promise<string> => {
    const store = new ResearchStore(join(root, ".sota", "database.sqlite"));
    const entry = store.experiments().find((experiment) => experiment.id === id);
    if (!entry) { store.close(); throw new Error(`Experiment not found: ${id}`); }
    const manifest = ExperimentManifestSchema.parse(entry.payload);
    const hypothesis = store.hypotheses().find((candidate) => candidate.id === manifest.hypothesisId);
    const entryPayload = entry.payload as Record<string, unknown>;
    store.saveExperiment({ id, payload: { ...entryPayload, status: "running" } });
    store.close();
    setProgress(`Experiment ${id} · creating isolated worktree...`);
    const worktree = await ensureWorktree(root, root, id);
    const experimentCwd = join(worktree, "competitions", "whestbench", "starterkit");
    if (config.provider === "codex") {
      setProgress(`Experiment ${id} · experiment engineer implementing the hypothesis...`);
      await runWithLocalFallback({
        role: "experiment engineer",
        objective: "Implement the selected hypothesis in this isolated worktree. Inspect the existing estimator, make the smallest reproducible change, run relevant tests or smoke checks, and leave the worktree ready for evaluation. Do not touch files outside this worktree and do not submit anything.",
        context: { manifest, hypothesis: hypothesis?.payload ?? null, worktree: experimentCwd },
      }, { provider: config.provider, model: config.model, cwd: worktree, reasoningEffort: config.reasoningEffort, sandbox: "workspace-write" }, undefined, setProgress);
    }
    const command = ["uv", "run", "python", "estimator.py", "--baseline", "mean_propagation"];
    setProgress(`Experiment ${id} · running ${manifest.resources.executor} executor...`);
    const result = await executorFor(manifest.resources.executor).run(manifest, experimentCwd, command);
    const resultStore = new ResearchStore(join(root, ".sota", "database.sqlite"));
    resultStore.saveRun({ id: result.runId, experimentId: id, status: result.status, payload: result });
    resultStore.saveExperiment({ id, payload: { ...entryPayload, status: result.status === "completed" ? "completed" : "failed", runId: result.runId, worktreePath: experimentCwd } });
    resultStore.close();
    return `\n\nExperiment ${id} ${result.status}\nRun: ${result.runId}\nExit code: ${result.exitCode}\nDuration: ${result.durationSeconds.toFixed(1)}s\nFailure: ${result.failureClass ?? "none"}`;
  };

  const runAutonomousCycle = async (): Promise<void> => {
    if (loopBusy.current || busy) return;
    loopBusy.current = true;
    setBusy(true); setProgress("Autonomous loop: choosing the next highest-information decision...");
    const store = new ResearchStore(join(root, ".sota", "database.sqlite"));
    store.setSchedulerState({ status: "running", mode: config.mode, currentStep: "research" });
    store.close();
    try {
      const result = await runResearchCycle("Run the next zero-to-hero research cycle: inspect current state, identify the highest-information bottleneck, and propose one falsifiable experiment with explicit validation and replication criteria.");
      const update = new ResearchStore(join(root, ".sota", "database.sqlite"));
      update.setSchedulerState({ status: "running", mode: config.mode, currentStep: "awaiting-next-cycle" });
      update.close();
      const proposed = config.mode === "challenge" ? await proposeLatestExperiment() : null;
      append("assistant", result + (proposed?.text ?? ""));
      if (proposed && config.mode === "challenge" && config.autonomy === "yolo") append("assistant", await executeExperiment(proposed.id));
    } catch (error) {
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
    if (request === "/exit" || request === "/quit") { exit(); return; }
    if (request === "/help") { append("assistant", help()); return; }
    if (/^(hi|hello|hey|yo|ping)$/i.test(request)) {
      append("assistant", `Ready. Research mode is active with ${config.provider}/${config.model}. Use /research to begin an empirical cycle or /mode to switch to Challenge.`);
      return;
    }
    if (request === "/workbench research" || request === "/mode research") {
      setConfig((current) => ({ ...current, mode: "research" }));
      append("assistant", "Research mode active. Natural-language prompts become research questions; challenge execution remains explicit.");
      return;
    }
    if (request === "/workbench challenge" || request === "/mode challenge") {
      setConfig((current) => ({ ...current, mode: "challenge" }));
      append("assistant", `Challenge mode active for ${whestbenchConfig.name}. Experiments and runs are now the primary workflow.`);
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
      const recent = store.recentEvents(5).map((event) => `${event.type} · ${event.createdAt}`).join("\n") || "No events yet.";
      store.close();
      append("assistant", `Evidra Workbench\nMode: ${config.mode}\nAutonomy: ${config.autonomy}\n\nResearch graph\n  hypotheses  ${counts.hypotheses}\n  claims      ${counts.claims}\n  edges       ${counts.edges}\n  sources     ${counts.sources}\n  decisions   ${counts.decisions}\n\nChallenge execution\n  experiments ${counts.experiments}\n  runs        ${counts.runs}\n  artifacts   ${counts.artifacts}\n\nRecent events\n${recent}\n\nUse /mode to switch modes or /permissions to change automation permissions.`);
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
    if (request === "/pause" || request === "/resume") {
      const store = new ResearchStore(join(root, ".sota", "database.sqlite"));
      store.setSchedulerState({ status: request === "/pause" ? "paused" : "running", mode: config.mode, currentStep: null });
      store.close();
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
      append("assistant", `Zero-to-hero\n  project: ${project?.name ?? "not initialized"}\n  challenge: ${whestbenchConfig.name}\n  loop: ${state.status}\n  hypotheses: ${counts.hypotheses}\n  experiments: ${counts.experiments}\n  runs: ${counts.runs}\n\nUse /hero start to initialize, reproduce the baseline, and generate the first research decision.`);
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
        mkdirSync(join(root, "competitions", "whestbench", "experiments"), { recursive: true });
        mkdirSync(join(root, "competitions", "whestbench", "reports"), { recursive: true });
        mkdirSync(join(root, "competitions", "whestbench", "submissions"), { recursive: true });
        mkdirSync(join(root, ".sota"), { recursive: true });
        const configFile = join(root, "competitions", "whestbench", "competition.json");
        if (!existsSync(configFile)) writeFileSync(configFile, `${JSON.stringify(whestbenchConfig, null, 2)}\n`);
        const store = new ResearchStore(join(root, ".sota", "database.sqlite"));
        if (!store.project()) store.createProject({ id: "evidra-whestbench", name: whestbenchConfig.name, competitionId: whestbenchConfig.id, config: whestbenchConfig });
        store.setSchedulerState({ status: "running", mode: "challenge", currentStep: "baseline" });
        store.close();
        setConfig((current) => ({ ...current, mode: "challenge" }));
        const baseline = await runProcess(["uv", "run", "python", "estimator.py", "--baseline", "mean_propagation"], join(root, "competitions", "whestbench", "starterkit"));
        const baselineStore = new ResearchStore(join(root, ".sota", "database.sqlite"));
        baselineStore.appendEvent("baseline.completed", { exitCode: baseline.exitCode, stdout: baseline.stdout, stderr: baseline.stderr });
        baselineStore.setSchedulerState({ status: "running", mode: "challenge", currentStep: "research" });
        baselineStore.close();
        setProgress("Zero-to-hero: generating the first falsifiable research decision...");
        append("assistant", `Baseline ${baseline.exitCode === 0 ? "completed" : "failed"}.\n${baseline.stdout || baseline.stderr}`);
        const decisionText = await runResearchCycle("Starting from the verified baseline, identify the first highest-information experiment for WhestBench. Include a falsification test, leakage risks, compute estimate, and replication plan.");
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
    if (request === "/project init whestbench" || request === "/challenge init whestbench") {
      mkdirSync(join(root, "competitions", "whestbench", "experiments"), { recursive: true });
      mkdirSync(join(root, "competitions", "whestbench", "reports"), { recursive: true });
      mkdirSync(join(root, "competitions", "whestbench", "submissions"), { recursive: true });
      mkdirSync(join(root, ".sota"), { recursive: true });
      const configFile = join(root, "competitions", "whestbench", "competition.json");
      if (!existsSync(configFile)) writeFileSync(configFile, `${JSON.stringify(whestbenchConfig, null, 2)}\n`);
      const store = new ResearchStore(join(root, ".sota", "database.sqlite"));
      if (!store.project()) store.createProject({ id: "evidra-whestbench", name: whestbenchConfig.name, competitionId: whestbenchConfig.id, config: whestbenchConfig });
      store.close();
      append("assistant", `Initialized ${whestbenchConfig.name}. Next: /challenge baseline or /hero start.`);
      return;
    }
    if (request === "/status" || request === "/project status") {
      const store = new ResearchStore(join(root, ".sota", "database.sqlite"));
      const project = store.project();
      append("assistant", project ? `Project: ${project.name}\nCompetition: ${project.competitionId}\nMode: ${config.mode}\nAutonomy: ${config.autonomy}\nEvents: ${store.eventCount()}` : "No Evidra project initialized.");
      store.close();
      return;
    }
    if (request === "/challenge" || request === "/challenge status" || request === "/challenge list") {
      append("assistant", `Active challenge: ${whestbenchConfig.name}\nID: ${whestbenchConfig.id}\nMetric: ${whestbenchConfig.metric.name} (${whestbenchConfig.metric.direction})\nUse /challenge inspect or /challenge baseline.`);
      return;
    }
    if (request === "/challenge baseline") {
      setBusy(true); setProgress("Running the canonical WhestBench baseline...");
      try {
        const result = await runProcess(["uv", "run", "python", "estimator.py", "--baseline", "mean_propagation"], join(root, "competitions", "whestbench", "starterkit"));
        const store = new ResearchStore(join(root, ".sota", "database.sqlite"));
        store.appendEvent("baseline.completed", { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr });
        store.close();
        append("assistant", `Baseline ${result.exitCode === 0 ? "completed" : "failed"}.\n${result.stdout || result.stderr}`);
      } catch (error) { append("assistant", error instanceof Error ? error.message : String(error)); }
      finally { setBusy(false); setProgress(""); }
      return;
    }
    if (request === "/inspect" || request === "/challenge inspect") { append("assistant", JSON.stringify(whestbenchConfig, null, 2)); return; }
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
      const manifest = createExperimentManifest({ id, hypothesisId, gitCommit: commit.stdout.trim(), datasetVersion: whestbenchConfig.datasetRevision }, whestbenchConfig);
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
    if (request === "/compute") {
      append("assistant", `Executor policy\n  mode: ${config.mode}\n  autonomy: ${config.autonomy}\n  local: available through process workers\n  modal: configured on demand via Modal credentials\n  fallback: local Qwen when Codex usage limits are reached`);
      return;
    }
    if (request === "/sources") {
      const store = new ResearchStore(join(root, ".sota", "database.sqlite"));
      const sources = store.sources();
      store.close();
      append("assistant", sources.length ? sources.map((source) => `${source.id} · ${JSON.stringify(source.payload)}`).join("\n") : "No research sources cached yet.");
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
        });
        const output = [result.stdout.trim(), result.stderr.trim() ? `stderr:\n${result.stderr.trim()}` : ""].filter(Boolean).join("\n");
        append("assistant", `Command exited ${result.exitCode} in ${(result.durationMs / 1000).toFixed(1)}s\n$ ${command.join(" ")}\n${output || "(no output)"}`);
      } catch (error) { append("assistant", error instanceof Error ? error.message : String(error)); }
      finally { setBusy(false); setProgress(""); }
      return;
    }
    if (["/research status", "/research start", "/research pause", "/research stop"].includes(request)) {
      const action = request.split(/\s+/)[1];
      const store = new ResearchStore(join(root, ".sota", "database.sqlite"));
      if (action === "status") {
        const state = store.schedulerState();
        append("assistant", `Research scheduler: ${state.status}\nCurrent step: ${state.currentStep ?? "idle"}`);
      } else {
        const status = action === "start" ? "running" : action === "pause" ? "paused" : "idle";
        store.setSchedulerState({ status, mode: "research", currentStep: null });
        append("assistant", `Research scheduler ${status}.`);
      }
      store.close();
      return;
    }
    if (request === "/research" || request.startsWith("/research ")) {
      const objective = request.slice("/research".length).trim() || "Inspect the current baseline and propose the highest-information next experiment.";
      setBusy(true); setProgress("Starting empirical research cycle...");
      try {
        append("assistant", await runResearchCycle(objective));
      } catch (error) {
        append("assistant", error instanceof Error ? error.message : String(error));
      } finally { setBusy(false); setProgress(""); }
      return;
    }
    if (request.startsWith("/")) { append("assistant", `Unknown command: ${request}\n\n${help()}`); return; }

    setBusy(true); setProgress(`Using ${config.provider}/${config.model}`);
    try {
      await checkProvider({ provider: config.provider, model: config.model, cwd: root });
      if (config.mode === "research") {
        append("assistant", await runResearchCycle(request));
      } else {
        const result = await runWithLocalFallback({ role: "challenge scientist", objective: request, context: { mode: config.mode, competition: whestbenchConfig } }, { provider: config.provider, model: config.model, cwd: root, reasoningEffort: config.reasoningEffort }, "qwen3.6:27b", setProgress);
        append("assistant", String(result.output));
      }
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
      {messages.slice(-16).map((message, index) => <Box key={`${index}-${message.text}`} flexDirection="column" marginBottom={1} paddingLeft={1}>
        <Text color={message.role === "user" ? "yellow" : message.role === "system" ? "gray" : "green"} bold>
          {message.role === "user" ? "> " : message.role === "assistant" ? "│ " : "· "}{message.role === "assistant" ? "EVIDRA  " : ""}
        </Text>
        <Text color={message.role === "user" ? "yellow" : message.role === "system" ? "gray" : "green"}>{message.text}</Text>
      </Box>)}
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
    <Box borderStyle="round" borderColor={busy ? "gray" : "yellow"} paddingX={1} paddingY={0} marginTop={1}>
      <Text color="yellow">› </Text>
      <TextInput key={inputMount} focus={!picker} showCursor={!picker} value={input} onChange={setInput} onSubmit={submit} placeholder="Ask Evidra to inspect, hypothesize, or run an experiment..." />
    </Box>
    <Box marginLeft={2} marginTop={0}>
      <Text color="white" bold>{config.provider.toUpperCase()} · {config.model} · THINKING: {config.reasoningEffort.toUpperCase()} · MODE: {config.mode.toUpperCase()} · PERMISSIONS: {config.autonomy.toUpperCase()}</Text>
    </Box>
  </Box>;
}
