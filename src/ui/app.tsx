import React, { useEffect, useRef, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import TextInput from "ink-text-input";
import Spinner from "ink-spinner";
import { join } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { ResearchStore } from "../core/store.js";
import { runProcess } from "../core/process.js";
import { createExperimentManifest, manifestSummary } from "../core/experiment-manifest.js";
import { materializeResearchDecision } from "../core/research-graph.js";
import { whestbenchConfig } from "../competitions/whestbench.js";
import { checkProvider, codexLoginStatus, listCodexModels, listLocalModels, loginCodex, runWithLocalFallback, type AgentProvider, type AvailableModel } from "../agents/codex-exec.js";
import { formatResearchDecision, runResearchDirector } from "../agents/research-director.js";

type Message = { role: "user" | "assistant" | "system"; text: string };
type WorkbenchMode = "research" | "challenge";
type AutonomyLevel = "safe" | "fast" | "yolo";
type SessionConfig = { provider: AgentProvider; model: string; reasoningEffort: string; mode: WorkbenchMode; autonomy: AutonomyLevel };

const defaultConfig: SessionConfig = { provider: "codex", model: "default", reasoningEffort: "medium", mode: "research", autonomy: "safe" };
const COMMANDS = [
  ["/help", "Show commands"],
  ["/workbench", "Show or switch Research/Challenge mode"],
  ["/mode", "Show or switch active mode"],
  ["/project", "Manage the Evidra project"],
  ["/challenge", "Inspect and run the active challenge"],
  ["/hero", "Run the zero-to-hero challenge bootstrap"],
  ["/provider", "Select codex or local provider"],
  ["/model", "Select the active model"],
  ["/thinking", "Select model thinking effort"],
  ["/login codex", "Sign in with ChatGPT subscription (device code)"],
  ["/login status", "Check Codex authentication"],
  ["/status", "Show project state"],
  ["/inspect", "Show competition configuration"],
  ["/research", "Plan the next falsifiable research decision"],
  ["/sources", "Manage research sources"],
  ["/memory", "Search research memory"],
  ["/hypotheses", "Manage the hypothesis graph"],
  ["/graph", "Show research graph"],
  ["/agents", "Inspect research agent lanes"],
  ["/data", "Run data audits"],
  ["/validation", "Manage validation policy"],
  ["/experiments", "List and inspect experiments"],
  ["/experiment", "Propose, audit, or run one immutable experiment"],
  ["/runs", "Inspect active runs"],
  ["/compute", "Inspect compute and budgets"],
  ["/evidence", "Inspect accepted evidence"],
  ["/ensemble", "Analyze OOF diversity and blends"],
  ["/submission", "Prepare and record submissions"],
  ["/report", "Generate research reports"],
  ["/autonomy", "Select safe, fast, or YOLO policy"],
  ["/pause", "Pause autonomous scheduling"],
  ["/resume", "Resume autonomous scheduling"],
  ["/loop", "Run or inspect the autonomous research loop"],
  ["/scheduler", "Control the experiment scheduler"],
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
  "/loop": [["/loop status", "Show loop state"], ["/loop once", "Run one research cycle"], ["/loop start", "Start autonomous loop"], ["/loop pause", "Pause loop"], ["/loop stop", "Stop loop"]],
  "/scheduler": [["/scheduler start", "Start scheduling"], ["/scheduler pause", "Pause scheduling"], ["/scheduler drain", "Finish active work only"]],
  "/thinking": REASONING_LEVELS.map((level) => [`/thinking ${level}`, `Thinking effort: ${level}`] as const),
  "/provider": [["/provider codex", "Use authenticated Codex"], ["/provider local", "Use local Ollama"]],
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
    "/workbench [research|challenge] Show or switch workbench mode",
    "/mode [research|challenge]   Show or switch active mode",
    "/project status              Show project state",
    "/challenge inspect           Show active challenge",
    "/hero [start|status|stop]     Zero-to-hero baseline and research workflow",
    "/provider [codex|local]      Select ChatGPT Codex or local Ollama",
    "/model [name]                Show or select the model (use default for Codex)",
    "/thinking [level]            Select model thinking effort",
    "/login codex                 Sign in with ChatGPT subscription (device code)",
    "/login codex browser          Use browser login via localhost callback",
    "/login status                Show Codex login status",
    "/status                      Show Evidra project state",
    "/inspect                     Show competition configuration",
    "/research [objective]        Plan the next falsifiable research decision",
    "/sources [query]             Search cached research sources",
    "/hypotheses [list|rank]      Inspect the hypothesis graph",
    "/experiments                 List experiments",
    "/experiment propose [hyp]    Create an immutable experiment manifest",
    "/experiment show <id>        Show an experiment manifest",
    "/compute                     Show compute and budget state",
    "/autonomy [safe|fast|yolo]   Set autonomous execution policy",
    "/pause                       Pause autonomous scheduling",
    "/resume                      Resume autonomous scheduling",
    "/loop [status|once|start|pause|stop] Run the autonomous research loop",
    "/scheduler [start|pause|drain] Control experiment scheduling",
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
  const [picker, setPicker] = useState<"model" | "reasoning" | null>(null);
  const [pickerIndex, setPickerIndex] = useState(0);
  const [suggestionIndex, setSuggestionIndex] = useState(0);
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
      const choices = picker === "model" ? availableModels : reasoningChoices;
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
        } else {
          const effort = reasoningChoices[pickerIndex];
          setConfig((current) => ({ ...current, reasoningEffort: effort }));
          append("assistant", `Thinking effort selected: ${effort}`);
          setPicker(null);
        }
      }
      return;
    }
    if (!suggestions.length) return;
    if (key.tab) {
      setInput(suggestions[suggestionIndex][0]);
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

  const runResearchCycle = async (objective: string): Promise<string> => {
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
      constraints: { no_submission: true, no_file_edits: true },
    }, { provider: config.provider, model: config.model, reasoningEffort: config.reasoningEffort, cwd: root, fallbackLocalModel: "qwen3.6:27b" }, setProgress);
    const decisionStore = new ResearchStore(join(root, ".sota", "database.sqlite"));
    materializeResearchDecision(decisionStore, decision);
    decisionStore.close();
    return formatResearchDecision(decision);
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
      append("assistant", result);
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
    if (request === "/mode" || request === "/workbench") {
      const store = new ResearchStore(join(root, ".sota", "database.sqlite"));
      const counts = store.counts();
      const recent = store.recentEvents(5).map((event) => `${event.type} · ${event.createdAt}`).join("\n") || "No events yet.";
      store.close();
      append("assistant", `Evidra Workbench\nMode: ${config.mode}\nAutonomy: ${config.autonomy}\n\nResearch graph\n  hypotheses  ${counts.hypotheses}\n  claims      ${counts.claims}\n  edges       ${counts.edges}\n  sources     ${counts.sources}\n  decisions   ${counts.decisions}\n\nChallenge execution\n  experiments ${counts.experiments}\n  runs        ${counts.runs}\n  artifacts   ${counts.artifacts}\n\nRecent events\n${recent}\n\nSwitch with /workbench research or /workbench challenge.`);
      return;
    }
    if (request === "/thinking" || request.startsWith("/thinking ")) {
      const level = request.split(/\s+/)[1];
      if (!level) append("assistant", `Thinking effort: ${config.reasoningEffort}\nUse /thinking ${reasoningChoices.join(", ")}.`);
      else if (!reasoningChoices.some((value) => value === level)) append("assistant", `Unsupported effort for ${config.model}. Choose: ${reasoningChoices.join(", ")}.`);
      else { setConfig((current) => ({ ...current, reasoningEffort: level })); append("assistant", `Thinking effort selected: ${level}`); }
      return;
    }
    if (request === "/autonomy" || request.startsWith("/autonomy ")) {
      const level = request.split(/\s+/)[1] as AutonomyLevel | undefined;
      if (!level) append("assistant", `Autonomy: ${config.autonomy}\nUse /autonomy safe, /autonomy fast, or /autonomy yolo.`);
      else if (!["safe", "fast", "yolo"].includes(level)) append("assistant", "Choose safe, fast, or yolo.");
      else { setConfig((current) => ({ ...current, autonomy: level })); append("assistant", `Autonomy policy selected: ${level}`); }
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
        append("assistant", await runResearchCycle("Starting from the verified baseline, identify the first highest-information experiment for WhestBench. Include a falsification test, leakage risks, compute estimate, and replication plan."));
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
      setBusy(true); setProgress("Building research decision...");
      const store = new ResearchStore(join(root, ".sota", "database.sqlite"));
      const project = store.project();
      const recentEvents = store.recentEvents(20);
      store.close();
      try {
        await checkProvider({ provider: config.provider, model: config.model, cwd: root });
        const decision = await runResearchDirector(objective, {
          project,
          competition: whestbenchConfig,
          recentEvents,
          constraints: { no_submission: true, no_file_edits: true },
        }, { provider: config.provider, model: config.model, reasoningEffort: config.reasoningEffort, cwd: root, fallbackLocalModel: "qwen3.6:27b" }, setProgress);
        const decisionStore = new ResearchStore(join(root, ".sota", "database.sqlite"));
        materializeResearchDecision(decisionStore, decision);
        decisionStore.close();
        append("assistant", formatResearchDecision(decision));
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
        const store = new ResearchStore(join(root, ".sota", "database.sqlite"));
        const project = store.project();
        const recentEvents = store.recentEvents(20);
        store.close();
        const decision = await runResearchDirector(request, {
          mode: config.mode,
          project,
          competition: whestbenchConfig,
          recentEvents,
          constraints: { no_submission: true, no_file_edits: true },
        }, { provider: config.provider, model: config.model, reasoningEffort: config.reasoningEffort, cwd: root, fallbackLocalModel: "qwen3.6:27b" }, setProgress);
        const decisionStore = new ResearchStore(join(root, ".sota", "database.sqlite"));
        materializeResearchDecision(decisionStore, decision);
        decisionStore.close();
        append("assistant", formatResearchDecision(decision));
      } else {
        const result = await runWithLocalFallback({ role: "challenge scientist", objective: request, context: { mode: config.mode, competition: whestbenchConfig } }, { provider: config.provider, model: config.model, cwd: root, reasoningEffort: config.reasoningEffort }, "qwen3.6:27b", setProgress);
        append("assistant", String(result.output));
      }
    } catch (error) {
      append("assistant", error instanceof Error ? error.message : String(error));
    } finally { setBusy(false); setProgress(""); }
  };

  return <Box flexDirection="column" padding={1}>
    <Box borderStyle="round" borderColor="cyan" paddingX={2} flexDirection="column">
      <Text color="cyan" bold>{LOGO}</Text>
      <Text color="gray">Evidra Workbench  ·  {config.mode.toUpperCase()}  ·  {config.provider}/{config.model}  ·  thinking:{config.reasoningEffort}</Text>
    </Box>
    <Box flexDirection="column" marginTop={1}>
      {messages.slice(-16).map((message, index) => <Box key={`${index}-${message.text}`} marginBottom={1}>
        <Text color={message.role === "user" ? "yellow" : message.role === "system" ? "gray" : "green"}>
          {message.role === "user" ? "> " : ""}{message.text}
        </Text>
      </Box>)}
    </Box>
    {busy && <Text color="magenta"><Spinner type="dots" /> {progress}</Text>}
    {picker && <Box borderStyle="round" borderColor="cyan" paddingX={2} flexDirection="column" marginTop={1}>
      <Text color="cyan" bold>{picker === "model" ? `Select ${config.provider} model` : "Select thinking effort"}</Text>
      <Text color="gray">↑/↓ navigate · Enter select · Esc cancel</Text>
      {(picker === "model" ? availableModels : reasoningChoices).slice(Math.max(0, pickerIndex - 5), pickerIndex + 7).map((entry, index) => {
        const actualIndex = Math.max(0, pickerIndex - 5) + index;
        const label = typeof entry === "string" ? entry : `${entry.displayName}  ${entry.id}${entry.isDefault ? " · default" : ""}${entry.hidden ? " · hidden" : ""}`;
        return <Text key={typeof entry === "string" ? entry : entry.id} color={actualIndex === pickerIndex ? "yellow" : "white"}>
          {actualIndex === pickerIndex ? "› " : "  "}{label}
        </Text>;
      })}
    </Box>}
    <Box borderStyle="round" borderColor={busy ? "gray" : "yellow"} paddingX={1} marginTop={1}>
      <Text color="yellow">› </Text>
      <TextInput value={input} onChange={setInput} onSubmit={submit} placeholder="Ask Evidra to inspect, hypothesize, or run an experiment..." />
    </Box>
    <Box marginLeft={2}>
      <Text color="gray">{config.provider} · {config.model} · thinking: {config.reasoningEffort}</Text>
    </Box>
    {suggestions.length > 0 && <Box flexDirection="column" marginLeft={2}>
      {suggestions.map(([command, description], index) => <Text key={command} color={index === suggestionIndex ? "cyan" : "gray"}>
        {index === suggestionIndex ? "› " : "  "}{command.padEnd(24, " ")} {description}
      </Text>)}
    </Box>}
  </Box>;
}
