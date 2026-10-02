import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CodexExecAgent, progressLine, type AgentProvider } from "./codex-exec.js";
import { ResearchStore } from "../core/store.js";
import { runProcess } from "../core/process.js";
import type { AgentTask } from "../core/types.js";

const MAX_REFERENCE_BYTES = 8 * 1024 * 1024;
const PAINTING_TIMEOUT_MS = 45 * 60_000;
const paintRepository = resolve(dirname(fileURLToPath(import.meta.url)), "../../claude-paint");

export interface PaintingJobInput {
  subject: string;
  style?: string;
  provider: AgentProvider;
  model: string;
  reference?: { mimeType: string; data: string };
}

interface PaintingJob {
  id: string;
  subject: string;
  style: string;
  provider: AgentProvider;
  model: string;
  createdAt: string;
  workspace: string;
  studio: string;
  referencePath?: string;
}

function storeEvent(statePath: string, type: string, payload: Record<string, unknown>): void {
  const store = new ResearchStore(statePath);
  try { store.appendEvent(type, payload); }
  finally { store.close(); }
}

function cleanText(value: string, max: number): string {
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ").trim().slice(0, max);
}

function imageExtension(mimeType: string): string {
  if (mimeType === "image/png") return ".png";
  if (mimeType === "image/jpeg") return ".jpg";
  if (mimeType === "image/webp") return ".webp";
  throw new Error("Reference images must be PNG, JPEG, or WebP.");
}

export function createPaintingJob(workspace: string, statePath: string, input: PaintingJobInput): { id: string; title: string; manifestPath: string } {
  const subject = cleanText(input.subject, 4_000);
  const style = cleanText(input.style ?? "", 1_000);
  const model = cleanText(input.model, 200);
  if (subject.length < 5) throw new Error("Describe the subject in at least five characters.");
  if (!model) throw new Error("Choose a model before starting a painting.");
  if (input.provider !== "codex") throw new Error("Painting currently needs the Codex provider so the artist can work with the simulator and inspect the canvas. Select Codex, then try again.");

  const id = randomUUID();
  const createdAt = new Date().toISOString();
  const jobDirectory = resolve(workspace, ".sota", "paintings", id);
  const studio = join(jobDirectory, "studio");
  mkdirSync(join(studio, "bin"), { recursive: true });
  mkdirSync(join(studio, "notes"), { recursive: true });
  mkdirSync(join(studio, "paintings", "lua"), { recursive: true });
  mkdirSync(join(studio, "out", "easel", "painting"), { recursive: true });

  let referencePath: string | undefined;
  if (input.reference) {
    const extension = imageExtension(input.reference.mimeType);
    if (!/^[a-zA-Z0-9+/]*={0,2}$/.test(input.reference.data) || input.reference.data.length > Math.ceil(MAX_REFERENCE_BYTES * 4 / 3) + 8) {
      throw new Error("Reference image data is invalid or larger than 8 MB.");
    }
    const bytes = Buffer.from(input.reference.data, "base64");
    if (!bytes.length || bytes.byteLength > MAX_REFERENCE_BYTES) throw new Error("Reference image must be between 1 byte and 8 MB.");
    referencePath = join(studio, `reference${extension}`);
    writeFileSync(referencePath, bytes, { mode: 0o600, flag: "wx" });
  }

  const brief = [
    "# Painting brief",
    "",
    `Subject: ${subject}`,
    style ? `Style or artist influence: ${style}` : "Style or artist influence: choose a visual approach that serves the subject.",
    referencePath ? `Reference image: ${relative(studio, referencePath)}` : "Reference image: none supplied.",
    "",
    "Paint an original oil painting with the physical easel simulator. Treat the reference as guidance for composition, color relationships, and mood; create a new painting rather than tracing it.",
    "Save the replayable log to paintings/lua/painting.lua and the finished 2400px image to out/painting.png.",
    "",
  ].join("\n");
  writeFileSync(join(studio, "BRIEF.md"), brief, { mode: 0o600, flag: "wx" });
  const job: PaintingJob = {
    id, subject, style, provider: input.provider, model, createdAt,
    workspace: resolve(workspace), studio,
    ...(referencePath ? { referencePath } : {}),
  };
  const manifestPath = join(jobDirectory, "job.json");
  writeFileSync(manifestPath, `${JSON.stringify(job, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  storeEvent(statePath, "painting.started", {
    id, title: subject.slice(0, 72), subject, style, provider: input.provider, model,
    outputPath: relative(workspace, join(studio, "out", "painting.png")),
  });
  return { id, title: subject.slice(0, 72), manifestPath };
}

export async function runPaintingJob(manifestPath: string, statePath: string, onProgress?: (message: string) => void): Promise<void> {
  const job = JSON.parse(readFileSync(manifestPath, "utf8")) as PaintingJob;
  const workspace = resolve(job.workspace);
  const studio = resolve(job.studio);
  if (!studio.startsWith(`${resolve(workspace)}/.sota/paintings/${job.id}/studio`)) throw new Error("Painting studio is outside its workspace.");
  const easelSource = join(paintRepository, "target", "release", "easel");
  const easelGuide = join(paintRepository, "notes", "easel_guide.md");
  const progress = (message: string): void => {
    onProgress?.(message);
    try { storeEvent(statePath, "painting.progress", { id: job.id, message: progressLine(message, 240) }); }
    catch { /* preserve the painting if a progress event cannot be recorded */ }
  };
  try {
    if (!existsSync(join(paintRepository, "Cargo.toml")) || !existsSync(easelGuide)) throw new Error("The claude-paint checkout or easel guide is missing. Clone it beside Evidra and retry.");
    if (!existsSync(easelSource)) {
      progress("Building the oil-paint simulator…");
      const build = await runProcess(["cargo", "build", "--release", "-p", "easel"], paintRepository, 60 * 60_000, (_stream, chunk) => {
        const compact = progressLine(chunk, 180);
        if (/Compiling|Finished|error:/i.test(compact)) progress(compact);
      });
      if (build.exitCode !== 0) throw new Error(`The easel build failed: ${progressLine(build.stderr || build.stdout, 700)}`);
    }
    if (!existsSync(easelSource)) throw new Error("The easel build finished without producing its executable.");
    const easel = join(studio, "bin", "easel");
    copyFileSync(easelSource, easel);
    chmodSync(easel, 0o755);
    copyFileSync(easelGuide, join(studio, "notes", "easel_guide.md"));

    progress("The easel is ready. The artist is planning the composition…");
    const task: AgentTask = {
      role: "painting artist",
      objective: [
        "Read BRIEF.md and notes/easel_guide.md. Paint an original, finished work with the physical oil simulator bundled at ./bin/easel.",
        "If a reference image is listed, inspect it with the image viewing tool before painting. Use it to understand composition, palette and mood; do not trace or copy the image.",
        "Use the easel's physical brushes, pigment tubes and wet paint. Start with `./bin/easel open`, make useful successive `./bin/easel do` calls, inspect the canvas with `./bin/easel look`, and use the image viewing tool on the saved look to guide revisions. Keep each Lua chunk purposeful and small enough to recover from errors.",
        "Write the complete, replayable painting log to paintings/lua/painting.lua. Include the required first `canvas{...}` chunk and mark later chunks as the guide specifies. Finish by replaying it with `./bin/easel run paintings/lua/painting.lua --out out/painting.png` and confirm the PNG exists.",
        "Keep all changes inside this painting studio. Do not use network access, install packages, submit anything, or modify files outside this folder. Do not claim the work is complete unless the simulator wrote both the PNG and painting log.",
        "When done, reply with the painting's title, a short description, and the relative paths of the PNG and replayable log.",
      ].join("\n\n"),
      context: {
        briefPath: "BRIEF.md",
        studioPath: ".",
        subject: job.subject,
        styleOrArtistInfluence: job.style || null,
        referenceImage: job.referencePath ? relative(studio, job.referencePath) : null,
        simulator: "claude-paint Rust easel; physical oil paint; isolated per-painting studio",
      },
    };
    const result = await new CodexExecAgent({
      provider: job.provider,
      model: job.model,
      cwd: studio,
      sandbox: "workspace-write",
      networkAccessEnabled: false,
      webSearchMode: "disabled",
      reasoningEffort: "high",
      limitPolicy: "stop",
      timeoutMs: PAINTING_TIMEOUT_MS,
      maxRepeatedCommands: 5,
      maxFailedCommands: 5,
      onActivity: (_source, activity) => progress(activity),
    }).run(task, progress);
    const outputPath = join(studio, "out", "painting.png");
    const logPath = join(studio, "paintings", "lua", "painting.lua");
    if (!existsSync(outputPath) || !existsSync(logPath)) {
      throw new Error("The artist's session ended without both the finished painting PNG and replayable Lua log.");
    }
    const outputStats = statSync(outputPath);
    if (!outputStats.isFile() || outputStats.size < 100 || outputStats.size > 100 * 1024 * 1024) throw new Error("The simulator produced an invalid or oversized image.");
    if (readFileSync(outputPath).subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") throw new Error("The simulator output is not a PNG image.");
    storeEvent(statePath, "painting.completed", {
      id: job.id, title: job.subject.slice(0, 72), subject: job.subject, style: job.style,
      provider: result.provider, model: result.model ?? job.model,
      outputPath: relative(workspace, outputPath), logPath: relative(workspace, logPath),
      summary: typeof result.output === "string" ? cleanText(result.output, 1_000) : "Painting completed.",
      imageBytes: outputStats.size,
    });
  } catch (error) {
    const message = cleanText(error instanceof Error ? error.message : String(error), 800);
    storeEvent(statePath, "painting.failed", { id: job.id, subject: job.subject, style: job.style, provider: job.provider, model: job.model, message });
    throw error;
  }
}
