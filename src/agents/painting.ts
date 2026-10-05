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

function paintingStage(message: string): string {
  if (/compil|building the oil-paint simulator/i.test(message)) return "preparing";
  if (/planning|composition|thinking|easel is ready/i.test(message)) return "composing";
  if (/repair|refin/i.test(message)) return "refining";
  if (/painting canvas|paint layer|applying paint/i.test(message)) return "painting";
  if (/replay|rendering final|^chunk \d|wrote out/i.test(message)) return "rendering";
  return "painting";
}

function friendlyProgress(message: string): string {
  const value = cleanText(message, 240);
  if (/^Compiling\s/i.test(value) || /Building the oil-paint simulator/i.test(value)) return "Preparing the oil paint simulator…";
  if (/^Finished .*release profile/i.test(value)) return "Oil paint simulator ready.";
  if (/^Thinking\.\.\.$/i.test(value)) return "Planning the composition from your brief…";
  if (/^Completed\.$/i.test(value)) return "Composition planned. Getting the canvas ready…";
  if (/^Running:|^Finished:|^Command failed:/i.test(value)) {
    if (/easel.*\blook\b/i.test(value)) return "Taking a closer look at the canvas…";
    if (/easel.*\bdo\b/i.test(value)) return "Applying paint to the canvas…";
    return "Preparing the next paint layer…";
  }
  return value;
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
    const readable = friendlyProgress(message);
    onProgress?.(readable);
    try { storeEvent(statePath, "painting.progress", { id: job.id, message: readable, stage: paintingStage(readable) }); }
    catch { /* preserve the painting if a progress event cannot be recorded */ }
  };
  let previewTimer: ReturnType<typeof setInterval> | undefined;
  try {
    const paintRepository = findPaintingRepository(workspace);
    const easelSource = join(paintRepository, "target", "release", "easel");
    const easelGuide = join(paintRepository, "notes", "easel_guide.md");
    if (!existsSync(easelSource)) {
      progress("Building the oil-paint simulator…");
      let reportedReady = false;
      const build = await runProcess(["cargo", "build", "--release", "-p", "easel"], paintRepository, 60 * 60_000, (_stream, chunk) => {
        const compact = progressLine(chunk, 180);
        if (/error:/i.test(compact)) progress(`Simulator setup error: ${compact}`);
        else if (/Finished .*release profile/i.test(compact) && !reportedReady) { reportedReady = true; progress("Oil paint simulator ready."); }
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
        "Design an original oil painting for the subject and style in the brief. Use the attached reference image, if any, for composition, palette, light, and mood without tracing it.",
        "Return JSON matching the schema: title, a concise summary, and 5 to 20 Lua chunks. The first chunk must start with canvas{...}. Each later chunk is executed in the same persistent easel session, so globals defined in earlier chunks remain available.",
        "Use only the painting simulator's Lua DSL described in the guide. Use physical pigment piles, brushes, shapes, work(), and blending. Use a restrained hierarchy of mark sizes: short, fine strokes for edges and features; short-to-medium strokes for forms; use broad strokes only for a small number of underpainting passages. Do not use broad strokes to texture or fill the whole sky or ground. Use body, detail, and hatch handling for most passages; keep individual visible marks mostly under 35 canvas units, and reserve 80+ unit marks for occasional block-in only. Cover the intended masks evenly so the linen ground does not show through as accidental confetti or large holes. Build the scene in layers: a continuous underpainting, clearly separated silhouettes and forms, then smaller directional accents. Favor an asymmetrical, carefully composed scene with readable focal point, atmospheric depth, controlled palette, and specific details. Avoid repeated generic shapes, oversized stars, empty flat bands, and marks that obscure the subject. Use varied but deliberate brushwork, with detail and contrast concentrated near the focal point, and keep each chunk purposeful and bounded for the 2400px replay.",
        "Return Lua only inside the JSON strings. Do not include shell commands, Markdown fences, explanations, or code that accesses files, processes, networking, or operating-system APIs.",
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
      outputSchema: JSON.stringify({
        type: "object", additionalProperties: false, required: ["title", "summary", "chunks"],
        properties: {
          title: { type: "string", minLength: 3, maxLength: 120 },
          summary: { type: "string", minLength: 10, maxLength: 800 },
          chunks: { type: "array", minItems: 5, maxItems: 20, items: { type: "string", minLength: 8, maxLength: 64000 } },
        },
      }),
    };
    const result = await new CodexExecAgent({
      provider: job.provider,
      model: job.model,
      cwd: studio,
      sandbox: "read-only",
      images: job.referencePath ? [job.referencePath] : undefined,
      networkAccessEnabled: false,
      webSearchMode: "disabled",
      reasoningEffort: "high",
      limitPolicy: "stop",
      timeoutMs: PAINTING_TIMEOUT_MS,
      onActivity: (_source, activity) => progress(activity),
    }).run(task, progress);
    let plan: { title?: unknown; summary?: unknown; chunks?: unknown };
    try { plan = JSON.parse(typeof result.output === "string" ? result.output : JSON.stringify(result.output)) as typeof plan; }
    catch { throw new Error("The painting model did not return valid structured Lua instructions."); }
    if (typeof plan.title !== "string" || typeof plan.summary !== "string" || !Array.isArray(plan.chunks) || plan.chunks.length < 5 || plan.chunks.length > 20 || plan.chunks.some((chunk) => typeof chunk !== "string")) {
      throw new Error("The painting model returned an incomplete canvas plan.");
    }
    const chunks = plan.chunks as string[];
    if (!/^\s*canvas\s*\{/i.test(chunks[0])) throw new Error("The first painting chunk must start with canvas{...}.");
    if (chunks.some((chunk) => chunk.length > 64_000) || chunks.reduce((total, chunk) => total + Buffer.byteLength(chunk), 0) > 512_000) throw new Error("The painting plan is larger than the studio's Lua limit.");
    for (const [index, initialChunk] of chunks.entries()) {
      let chunk = initialChunk;
      let applied = { exitCode: 1, stderr: "The chunk was not executed.", stdout: "" };
      let repairs = 0;
      while (true) {
        if (/\b(?:os|io|package|debug)\s*[.:]/.test(chunk)) throw new Error(`Painting chunk ${index + 1} uses a forbidden Lua library.`);
        const chunkPath = join(studio, `.chunk-${String(index + 1).padStart(2, "0")}.lua`);
        writeFileSync(chunkPath, chunk, { mode: 0o600 });
        progress(`Painting canvas · ${index + 1} of ${chunks.length}${repairs > 0 ? ` · repair ${repairs}` : ""}`);
        applied = await runProcess(["./bin/easel", "do", "-f", relative(studio, chunkPath)], studio, 10 * 60_000);
        if (applied.exitCode === 0) break;
        const errorText = applied.stderr || applied.stdout;
        if (/rebuilding from the log|retry after it finishes/i.test(errorText)) {
          progress(`The easel is rebuilding its canvas · waiting before layer ${index + 1}…`);
          const deadline = Date.now() + 5 * 60_000;
          let ready = false;
          while (Date.now() < deadline) {
            const status = await runProcess(["./bin/easel", "status"], studio, 30_000);
            if (status.exitCode === 0 && !/rebuilding/i.test(status.stdout)) { ready = true; break; }
            await new Promise((resolveDelay) => setTimeout(resolveDelay, 1_000));
          }
          if (!ready) throw new Error(`The easel did not finish rebuilding before layer ${index + 1}.`);
          continue;
        }
        if (repairs >= 2) break;
        repairs += 1;
        progress(`Repairing paint layer ${index + 1}…`);
        const repair = await new CodexExecAgent({
          provider: job.provider, model: job.model, cwd: studio, threadId: result.threadId,
          sandbox: "read-only", networkAccessEnabled: false, webSearchMode: "disabled",
          reasoningEffort: "high", limitPolicy: "stop", timeoutMs: 5 * 60_000,
        }).run({
          role: "painting artist",
          objective: "Replace the failed Lua chunk with a valid chunk for the same painting. The easel error is authoritative. Preserve the visual intent and use only operations, shapes, pigments, and edge values documented in the easel guide. Return only a JSON object with one string field named chunk. Do not use Markdown or shell commands.",
          context: {
            chunkNumber: index + 1, subject: job.subject, style: job.style,
            failedChunk: chunk, easelError: progressLine(applied.stderr || applied.stdout, 1_500),
            canvasState: "The failed chunk changed nothing; prior chunks remain committed in this same live easel session.",
            easelGuide: readFileSync(easelGuide, "utf8"),
          },
          outputSchema: JSON.stringify({ type: "object", additionalProperties: false, required: ["chunk"], properties: { chunk: { type: "string", minLength: 8, maxLength: 64000 } } }),
        }, progress);
        try {
          const corrected = JSON.parse(typeof repair.output === "string" ? repair.output : JSON.stringify(repair.output)) as { chunk?: unknown };
          if (typeof corrected.chunk !== "string" || corrected.chunk.length > 64_000) throw new Error("Replacement Lua is missing or too long.");
          chunk = corrected.chunk;
        } catch (error) {
          throw new Error(`The painting model could not repair chunk ${index + 1}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      if (applied.exitCode !== 0) throw new Error(`Painting chunk ${index + 1} failed after repair: ${progressLine(applied.stderr || applied.stdout, 600)}`);
      chunks[index] = chunk;
    }
    progress(`Replaying ${chunks.length} paint layers at final resolution…`);
    const replay = await runProcess(["./bin/easel", "run", "paintings/lua/painting.lua", "--out", "out/painting.png"], studio, 30 * 60_000, (_stream, chunk) => {
      const compact = progressLine(chunk, 180);
      if (/chunk|wrote/i.test(compact)) progress(compact);
    });
    if (replay.exitCode !== 0) throw new Error(`The final painting replay failed: ${progressLine(replay.stderr || replay.stdout, 700)}`);
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
