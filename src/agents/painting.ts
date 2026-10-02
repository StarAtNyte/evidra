import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CodexExecAgent, progressLine, type AgentProvider } from "./codex-exec.js";
import { ResearchStore } from "../core/store.js";
import { runProcess } from "../core/process.js";
import type { AgentTask } from "../core/types.js";

const MAX_REFERENCE_BYTES = 8 * 1024 * 1024;
const PAINTING_TIMEOUT_MS = 45 * 60_000;
const moduleDirectory = dirname(fileURLToPath(import.meta.url));

function findPaintingRepository(workspace: string): string {
  const candidates = [
    process.env.EVIDRA_PAINT_REPOSITORY,
    resolve(moduleDirectory, "../../vendor/claude-paint"),
    resolve(workspace, "claude-paint"),
    resolve(moduleDirectory, "../../claude-paint"),
    resolve(moduleDirectory, "../../../claude-paint"),
    resolve(process.cwd(), "claude-paint"),
  ].filter((value): value is string => Boolean(value));
  let cursor = resolve(workspace);
  while (true) {
    candidates.push(join(cursor, "claude-paint"));
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const path = resolve(candidate);
    if (seen.has(path)) continue;
    seen.add(path);
    if (existsSync(join(path, "Cargo.toml")) && existsSync(join(path, "notes", "easel_guide.md"))) return path;
  }
  throw new Error(`Could not find claude-paint with Cargo.toml and notes/easel_guide.md. Checked: ${[...seen].join(", ")}`);
}

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
  // Keep the simulator's Unix socket below the platform's path length limit.
  const jobDirectory = resolve(workspace, ".sota", "paintings", id.replaceAll("-", "").slice(0, 16));
  const studio = join(jobDirectory, "studio");
  mkdirSync(join(studio, "bin"), { recursive: true });
  mkdirSync(join(studio, "notes"), { recursive: true });
  mkdirSync(join(studio, "paintings", "lua"), { recursive: true });
  mkdirSync(join(studio, "out", "easel", "painting"), { recursive: true });
  // The developer/replay easel discovers its workspace root by finding this
  // manifest above its current directory. A copied binary otherwise falls
  // back to the claude-paint checkout it was built from.
  mkdirSync(join(studio, "crates", "easel"), { recursive: true });
  writeFileSync(join(studio, "crates", "easel", "Cargo.toml"), "[package]\nname = \"painting-studio-root\"\n", { mode: 0o600, flag: "wx" });

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
  const jobsRoot = resolve(workspace, ".sota", "paintings");
  const jobDirectory = resolve(dirname(manifestPath));
  if (relative(jobsRoot, jobDirectory).startsWith("..") || studio !== resolve(jobDirectory, "studio")) throw new Error("Painting studio is outside its workspace.");
  const progress = (message: string): void => {
    onProgress?.(message);
    try { storeEvent(statePath, "painting.progress", { id: job.id, message: progressLine(message, 240) }); }
    catch { /* preserve the painting if a progress event cannot be recorded */ }
  };
  let previewTimer: ReturnType<typeof setInterval> | undefined;
  try {
    const paintRepository = findPaintingRepository(workspace);
    const easelSource = join(paintRepository, "target", "release", "easel");
    const easelGuide = join(paintRepository, "notes", "easel_guide.md");
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

    const opened = await runProcess(["./bin/easel", "open", "painting"], studio, 60_000);
    if (opened.exitCode !== 0) throw new Error(`Unable to open the easel: ${progressLine(opened.stderr || opened.stdout, 500)}`);
    const frames = await runProcess(["./bin/easel", "frames", "on"], studio, 30_000);
    if (frames.exitCode !== 0) throw new Error(`Unable to enable live canvas frames: ${progressLine(frames.stderr || frames.stdout, 500)}`);
    const framesDirectory = join(studio, "out", "easel", "painting", "frames");
    const previewPath = join(studio, "out", "painting-preview.png");
    let latestFrame = "";
    const syncPreview = (): void => {
      try {
        const frame = readdirSync(framesDirectory).filter((name) => /^\d+\.png$/.test(name)).sort((a, b) => Number(a.slice(0, -4)) - Number(b.slice(0, -4))).at(-1);
        if (!frame || frame === latestFrame) return;
        const framePath = join(framesDirectory, frame);
        const signature = readFileSync(framePath).subarray(0, 8);
        if (signature.toString("hex") !== "89504e470d0a1a0a") return;
        copyFileSync(framePath, previewPath);
        latestFrame = frame;
        storeEvent(statePath, "painting.preview", {
          id: job.id,
          frame: Number(frame.slice(0, -4)),
          previewPath: relative(workspace, previewPath),
          message: `Canvas update · frame ${Number(frame.slice(0, -4))}`,
        });
      } catch { /* a chunk may still be writing its next frame */ }
    };
    previewTimer = setInterval(syncPreview, 600);
    previewTimer.unref();

    progress("The easel is ready. The artist is planning the composition…");
    const task: AgentTask = {
      role: "painting artist",
      objective: [
        "This is an execution task. Use the shell tools to create the painting artifacts; do not return only a plan or claim success without producing them.",
        "Read BRIEF.md and notes/easel_guide.md, and run `./bin/easel tubes --markdown` to inspect the available pigments. Paint an original finished work with the physical simulator bundled at ./bin/easel.",
        "If a reference image is listed, inspect it before painting and use its composition, palette and mood as guidance. Create an original painting rather than tracing or copying it.",
        "Run `./bin/easel open painting`, then paint in purposeful Lua chunks with `./bin/easel do`. Inspect the live canvas with `./bin/easel look` and revise it based on what you see. Use the physical brushes, pigment tubes, and wet paint; do not draw a flat vector or substitute another renderer.",
        "Write the complete, replayable log to paintings/lua/painting.lua. It must start with a valid `canvas{...}` chunk and include all later marks. Finish by running `./bin/easel run paintings/lua/painting.lua --out out/painting.png`, then verify both files exist and the PNG opens as an image.",
        "Keep all changes inside this painting studio. Do not use network access, install packages, submit anything, or modify files outside this folder. Do not claim the work is complete unless the simulator wrote both the PNG and painting log.",
        "When done, reply with the painting's title, a short description, and the relative paths of the PNG and replayable log.",
      ].join("\n\n"),
      context: {
        briefPath: "BRIEF.md",
        studioPath: ".",
        subject: job.subject,
        styleOrArtistInfluence: job.style || null,
        referenceImage: job.referencePath ? relative(studio, job.referencePath) : null,
        easelGuide: readFileSync(easelGuide, "utf8"),
        simulator: "claude-paint Rust easel; physical oil paint; isolated per-painting studio",
      },
    };
    const result = await new CodexExecAgent({
      provider: job.provider,
      model: job.model,
      cwd: studio,
      // The host cannot create Codex's workspace-write bwrap namespace. Each
      // painting already runs in a fresh, dedicated studio under .sota; use
      // full access there so the simulator can run, while keeping all output
      // visible to the live frame watcher.
      sandbox: "danger-full-access",
      allowUnisolatedDangerSandbox: true,
      networkAccessEnabled: false,
      webSearchMode: "disabled",
      reasoningEffort: "high",
      limitPolicy: "stop",
      timeoutMs: PAINTING_TIMEOUT_MS,
      maxRepeatedCommands: 5,
      maxFailedCommands: 5,
      onActivity: (_source, activity) => progress(activity),
    }).run(task, progress);
    clearInterval(previewTimer);
    syncPreview();
    const outputPath = join(studio, "out", "painting.png");
    const logPath = join(studio, "paintings", "lua", "painting.lua");
    if (!existsSync(outputPath) || !existsSync(logPath)) {
      throw new Error(`The artist's session ended without both the finished painting PNG and replayable Lua log. Agent reply: ${cleanText(typeof result.output === "string" ? result.output : "(no final reply)", 900)}`);
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
  } finally {
    if (previewTimer) clearInterval(previewTimer);
    try { await runProcess(["./bin/easel", "close"], studio, 30_000); } catch { /* the live session may not have started */ }
  }
}
