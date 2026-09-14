import { Agent } from "@earendil-works/pi-agent-core";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import type { AgentResult, AgentTask, ResearchAgent } from "../core/types.js";

function textFromMessage(message: unknown): string {
  if (!message || typeof message !== "object" || !("content" in message)) return "";
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part): part is { type: "text"; text: string } =>
      typeof part === "object" && part !== null && (part as { type?: string }).type === "text")
    .map((part) => part.text)
    .join("\n");
}

export class PiResearchAgent implements ResearchAgent {
  private readonly models = builtinModels();
  private readonly provider: string;
  private readonly modelId: string;

  constructor(options: { provider?: string; model?: string } = {}) {
    const [major, minor] = process.versions.node.split(".").map(Number);
    if (major < 22 || (major === 22 && minor < 19)) {
      throw new Error(`Pi runtime requires Node.js >= 22.19.0; found ${process.versions.node}.`);
    }
    this.provider = options.provider ?? process.env.EVIDRA_PI_PROVIDER ?? "openai-codex";
    this.modelId = options.model ?? process.env.EVIDRA_PI_MODEL ?? "gpt-5.4-mini";
  }

  async run(task: AgentTask): Promise<AgentResult> {
    const model = this.models.getModel(this.provider, this.modelId);
    if (!model) {
      throw new Error(`Pi model not found: ${this.provider}/${this.modelId}`);
    }

    const agent = new Agent({
      initialState: {
        model,
        systemPrompt: `You are the ${task.role} for Evidra, an autonomous ML research system.\n\n` +
          "You must propose falsifiable work, respect experiment boundaries, and return concise evidence-oriented output.",
        thinkingLevel: "medium",
      },
      streamFn: this.models.streamSimple.bind(this.models),
    });

    let finalText = "";
    agent.subscribe((event) => {
      if (event.type === "message_end" && "role" in event.message && event.message.role === "assistant") {
        finalText = textFromMessage(event.message);
      }
    });

    await agent.prompt(`${task.objective}\n\nResearch context:\n${JSON.stringify(task.context, null, 2)}\n\n` +
      "Return a structured answer. Do not edit files or run experiments in this planning call.");

    if (!finalText) {
      throw new Error(agent.state.errorMessage ?? "Pi agent returned no response. Check provider configuration.");
    }

    return {
      provider: `pi:${this.provider}`,
      output: finalText,
    };
  }
}
