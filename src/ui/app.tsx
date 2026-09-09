import React, { useEffect, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import TextInput from "ink-text-input";
import Spinner from "ink-spinner";
import { join } from "node:path";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { ResearchStore } from "../core/store.js";
import { whestbenchConfig } from "../competitions/whestbench.js";
import { checkProvider, codexLoginStatus, listCodexModels, listLocalModels, loginCodex, runWithLocalFallback, type AgentProvider, type AvailableModel } from "../agents/codex-exec.js";
import { formatResearchDecision, runResearchDirector } from "../agents/research-director.js";

type Message = { role: "user" | "assistant" | "system"; text: string };
type SessionConfig = { provider: AgentProvider; model: string; reasoningEffort: string };

const defaultConfig: SessionConfig = { provider: "codex", model: "default", reasoningEffort: "medium" };
const COMMANDS = [
  ["/help", "Show commands"],
  ["/provider", "Select codex or local provider"],
  ["/model", "Select the active model"],
  ["/login codex", "Sign in with ChatGPT subscription (device code)"],
  ["/login status", "Check Codex authentication"],
  ["/status", "Show project state"],
  ["/inspect", "Show competition configuration"],
  ["/research", "Plan the next falsifiable research decision"],
  ["/workbench", "Show the research graph and execution state"],
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

function loadConfig(path: string): SessionConfig {
  try {
    const config = { ...defaultConfig, ...JSON.parse(readFileSync(path, "utf8")) } as SessionConfig;
    // Older Evidra sessions used a model name that ChatGPT-account Codex does not accept.
    if (config.provider === "codex" && config.model === "gpt-5.3-codex") config.model = "default";
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
    "/provider [codex|local]      Select ChatGPT Codex or local Ollama",
    "/model [name]                Show or select the model (use default for Codex)",
    "/login codex                 Sign in with ChatGPT subscription (device code)",
    "/login codex browser          Use browser login via localhost callback",
    "/login status                Show Codex login status",
    "/status                      Show Evidra project state",
    "/inspect                     Show competition configuration",
    "/research [objective]        Plan the next falsifiable research decision",
    "/workbench                   Show research graph and execution state",
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
  const suggestions: readonly (readonly [string, string])[] = input.startsWith("/ ") ? [] : input.startsWith("/provider ")
    ? [["/provider codex", "Use ChatGPT Codex"], ["/provider local", "Use Ollama/Qwen"]]
    : input.startsWith("/model ")
      ? availableModels
        .filter((model) => model.id.toLowerCase().includes(input.slice("/model ".length).toLowerCase()))
        .slice(0, 12)
        .map((model) => [`/model ${model.id}`, `${model.displayName}${model.isDefault ? " · default" : ""}${model.hidden ? " · hidden" : ""}`] as const)
      : input.startsWith("/")
        ? COMMANDS.filter(([command]) => command.startsWith(input.split(/\s/)[0])).slice(0, 6)
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
          setPickerIndex(Math.max(0, reasoningChoices.findIndex((effort) => effort === config.reasoningEffort)));
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
    if (request.startsWith("/provider")) {
      const provider = request.split(/\s+/)[1] as AgentProvider | undefined;
      if (!provider) append("assistant", `Provider: ${config.provider}\nModel: ${config.model}\nUse /provider codex or /provider local.`);
      else if (provider !== "codex" && provider !== "local") append("assistant", "Choose codex or local.");
      else {
        setConfig((current) => ({
          provider,
          reasoningEffort: current.reasoningEffort,
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
    if (request === "/status") {
      const store = new ResearchStore(join(root, ".sota", "database.sqlite"));
      const project = store.project();
      append("assistant", project ? `Project: ${project.name}\nCompetition: ${project.competitionId}\nEvents: ${store.eventCount()}` : "No Evidra project initialized.");
      store.close();
      return;
    }
    if (request === "/inspect") { append("assistant", JSON.stringify(whestbenchConfig, null, 2)); return; }
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
        append("assistant", formatResearchDecision(decision));
      } catch (error) {
        append("assistant", error instanceof Error ? error.message : String(error));
      } finally { setBusy(false); setProgress(""); }
      return;
    }
    if (request === "/workbench") {
      const store = new ResearchStore(join(root, ".sota", "database.sqlite"));
      const counts = store.counts();
      const recent = store.recentEvents(5).map((event) => `${event.type} · ${event.createdAt}`).join("\n") || "No events yet.";
      store.close();
      append("assistant", `Evidra Workbench\n\nResearch graph\n  hypotheses  ${counts.hypotheses}\n  experiments ${counts.experiments}\n  runs        ${counts.runs}\n  artifacts   ${counts.artifacts}\n  decisions   ${counts.decisions}\n\nRecent events\n${recent}`);
      return;
    }
    if (request.startsWith("/")) { append("assistant", `Unknown command: ${request}\n\n${help()}`); return; }

    setBusy(true); setProgress(`Using ${config.provider}/${config.model}`);
    try {
      await checkProvider({ provider: config.provider, model: config.model, cwd: root });
      const result = await runWithLocalFallback({ role: "research director", objective: request, context: { competition: whestbenchConfig } }, { provider: config.provider, model: config.model, cwd: root, reasoningEffort: config.reasoningEffort }, "qwen3.6:27b", setProgress);
      append("assistant", String(result.output));
    } catch (error) {
      append("assistant", error instanceof Error ? error.message : String(error));
    } finally { setBusy(false); setProgress(""); }
  };

  return <Box flexDirection="column" padding={1}>
    <Box borderStyle="round" borderColor="cyan" paddingX={2} flexDirection="column">
      <Text color="cyan" bold>{LOGO}</Text>
      <Text color="gray">Autonomous research laboratory  ·  {config.provider}/{config.model}</Text>
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
