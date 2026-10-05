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
  if (/planning|composition|easel is ready/i.test(message)) return "composing";
  if (/thinking|looking over|reviewing the canvas|stepping back/i.test(message)) return "refining";
  if (/repair|refin/i.test(message)) return "refining";
  if (/painting canvas|paint layer|applying paint/i.test(message)) return "painting";
  if (/replay|rendering|^chunk \d|wrote out/i.test(message)) return "rendering";
  return "painting";
}

function friendlyProgress(message: string): string {
  const value = cleanText(message, 240);
  if (/^Compiling\s/i.test(value) || /Building the oil-paint simulator/i.test(value)) return "Preparing the oil paint simulator…";
  if (/^Finished .*release profile/i.test(value)) return "Oil paint simulator ready.";
  if (/^Tool (?:started|completed):/i.test(value)) return "Planning the next painting step…";
  if (/looking over|reviewing the canvas|stepping back/i.test(value)) return "Stepping back to review the canvas…";
  if (/^Thinking\.\.\.$/i.test(value)) return "Thinking through the next paint passage…";
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

    const maxPassages = 18;
    const minimumPassagesBeforeFinish = 5;
    const paintingDeadline = Date.now() + PAINTING_TIMEOUT_MS;
    const turnSchema = JSON.stringify({
      type: "object", additionalProperties: false, required: ["action", "title", "summary", "lua"],
      properties: {
        action: { type: "string", enum: ["paint", "finish"] },
        title: { type: "string", minLength: 3, maxLength: 120 },
        summary: { type: "string", minLength: 10, maxLength: 800 },
        lua: { type: "string", maxLength: 64_000 },
      },
    });
    let threadId: string | undefined;
    let title = job.subject.slice(0, 120);
    let summary = "";
    let completedChunks = 0;
    let totalTurns = 0;
    let repairNote = "";
    let earlyFinishAttempts = 0;
    let artistFinished = false;
    progress("The easel is ready. The artist is planning the composition…");

    while (completedChunks < maxPassages && totalTurns < maxPassages + 6 && Date.now() < paintingDeadline) {
      totalTurns += 1;
      const firstPassage = completedChunks === 0;
      const mustContinue = Boolean(repairNote) || completedChunks < minimumPassagesBeforeFinish;
      const objective = firstPassage
        ? [
          "Read BRIEF.md and notes/easel_guide.md. You are painting at a live easel, one passage at a time.",
          "Plan the whole composition privately, but return only the first executable Lua chunk: establish canvas{...} and paint the first purposeful passage. Do not return a batch or plan of later chunks. Every mark must come from the physical paint simulator DSL.",
          "Return one JSON object with action=paint, title, a short evolving summary, and lua containing exactly one chunk. Do not use shell commands or operating-system access.",
        ].join("\n\n")
        : [
          "Continue the same painting at the live easel. The attached image is the latest whole-canvas look, after your last successful passage. Study it before deciding what to do next.",
          mustContinue
            ? `Add one purposeful passage now. ${repairNote || `You need at least ${minimumPassagesBeforeFinish} successful passages before you may finish.`}`
            : "Choose the most useful next action by looking at the canvas: strengthen a focal form, improve depth or color, add particular detail, correct a weakness, or finish if the painting feels resolved. Do not add detail just to fill space.",
          "Return one JSON object with action=paint or finish, title, an updated short summary, and lua containing exactly one Lua chunk when painting. If finishing, set lua to an empty string. Do not reset the canvas or return a batch of future chunks.",
        ].join("\n\n");
      if (!firstPassage && !repairNote) progress("The artist is looking over the canvas and choosing the next passage…");
      else if (repairNote) progress(`Refining passage ${completedChunks + 1}…`);

      const task: AgentTask = {
        role: "painting artist",
        objective,
        context: {
          briefPath: "BRIEF.md",
          studioPath: ".",
          subject: job.subject,
          styleOrArtistInfluence: job.style || null,
          referenceImage: job.referencePath ? relative(studio, job.referencePath) : null,
          ...(firstPassage ? { easelGuide: readFileSync(easelGuide, "utf8") } : {}),
          simulator: "claude-paint Rust easel; persistent live session; physical oil paint",
          passage: completedChunks + 1,
          successfulPassages: completedChunks,
          canvasImage: firstPassage ? "The original reference, if provided, is attached." : "The latest live easel look is attached. Inspect it and respond to what is actually on the canvas.",
        },
        outputSchema: turnSchema,
      };
      const images = firstPassage
        ? job.referencePath ? [job.referencePath] : undefined
        : [previewPath];
      const result = await new CodexExecAgent({
        provider: job.provider,
        model: job.model,
        cwd: studio,
        ...(threadId ? { threadId } : {}),
        sandbox: "read-only",
        disableMcpServers: true,
        images,
        networkAccessEnabled: false,
        webSearchMode: "disabled",
        reasoningEffort: "high",
        limitPolicy: "stop",
        timeoutMs: Math.min(8 * 60_000, Math.max(1_000, paintingDeadline - Date.now())),
        onActivity: (_source, activity) => progress(activity),
      }).run(task, progress);
      threadId = result.threadId ?? threadId;

      let turn: { action?: unknown; title?: unknown; summary?: unknown; lua?: unknown };
      try {
        turn = JSON.parse(typeof result.output === "string" ? result.output : JSON.stringify(result.output)) as typeof turn;
      } catch {
        throw new Error("The painting model did not return a valid easel action.");
      }
      if ((turn.action !== "paint" && turn.action !== "finish") || typeof turn.title !== "string" || typeof turn.summary !== "string" || typeof turn.lua !== "string") {
        throw new Error("The painting model returned an incomplete easel action.");
      }
      title = cleanText(turn.title, 120) || title;
      summary = cleanText(turn.summary, 800) || summary;
      repairNote = "";

      if (turn.action === "finish") {
        if (completedChunks < minimumPassagesBeforeFinish) {
          earlyFinishAttempts += 1;
          if (earlyFinishAttempts >= 2) throw new Error("The artist tried to finish before establishing the painting.");
          repairNote = `Do not finish yet: only ${completedChunks} passages have been painted. Add one useful passage to the live canvas. Return action=paint.`;
          continue;
        }
        artistFinished = true;
        break;
      }
      earlyFinishAttempts = 0;
      const chunk = turn.lua;
      if (chunk.length < 8 || chunk.length > 64_000) throw new Error(`Painting passage ${completedChunks + 1} is empty or too long.`);
      if (completedChunks === 0 && !/^\s*canvas\s*\{/i.test(chunk)) throw new Error("The first painting passage must start with canvas{...}.");
      if (completedChunks > 0 && /^\s*canvas\s*\{/i.test(chunk)) throw new Error("Only the first painting passage may initialize the canvas.");
      if (/\b(?:os|io|package|debug)\s*[.:]/.test(chunk)) throw new Error(`Painting passage ${completedChunks + 1} uses a forbidden Lua library.`);

      const chunkPath = join(studio, `.chunk-${String(completedChunks + 1).padStart(2, "0")}.lua`);
      writeFileSync(chunkPath, chunk, { mode: 0o600 });
      progress(`Painting canvas · passage ${completedChunks + 1}`);
      const applied = await runProcess(["./bin/easel", "do", "-f", relative(studio, chunkPath)], studio, 10 * 60_000);
      if (applied.exitCode !== 0) {
        repairNote = `Your last Lua passage failed and changed nothing. Correct the issue and try one replacement passage. Easel error: ${progressLine(applied.stderr || applied.stdout, 1_500)}`;
        continue;
      }
      completedChunks += 1;
      const frameDeadline = Date.now() + 15_000;
      while (Number(latestFrame.slice(0, -4)) !== completedChunks && Date.now() < frameDeadline) {
        syncPreview();
        if (Number(latestFrame.slice(0, -4)) !== completedChunks) await new Promise((resolveDelay) => setTimeout(resolveDelay, 150));
      }
      if (Number(latestFrame.slice(0, -4)) !== completedChunks || !existsSync(previewPath)) throw new Error(`The easel did not produce the live canvas look for passage ${completedChunks}.`);
    }
    if (completedChunks < minimumPassagesBeforeFinish) throw new Error("The artist did not complete enough passages to establish the painting.");
    if (!artistFinished && completedChunks < maxPassages && totalTurns >= maxPassages + 6) progress("The artist reached the repair limit. Rendering the current painting…");
    if (!artistFinished && completedChunks >= maxPassages) {
      progress("The easel has reached its passage limit. Rendering the painting so far…");
      summary = summary || `The painting was completed in ${completedChunks} passages.`;
    } else if (!artistFinished && Date.now() >= paintingDeadline) {
      throw new Error("The painting session ran out of time before the artist finished.");
    }
    progress(`Replaying ${completedChunks} paint passages at final resolution…`);

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
      throw new Error(`The artist's session ended without both the finished painting PNG and replayable Lua log. Artist summary: ${cleanText(summary || "(no summary)", 900)}`);
    }
    const outputStats = statSync(outputPath);
    if (!outputStats.isFile() || outputStats.size < 100 || outputStats.size > 100 * 1024 * 1024) throw new Error("The simulator produced an invalid or oversized image.");
    if (readFileSync(outputPath).subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") throw new Error("The simulator output is not a PNG image.");
    storeEvent(statePath, "painting.completed", {
      id: job.id, title: title.slice(0, 120), subject: job.subject, style: job.style,
      provider: job.provider, model: job.model,
      outputPath: relative(workspace, outputPath), logPath: relative(workspace, logPath),
      summary: cleanText(summary || "Painting completed.", 1_000),
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
