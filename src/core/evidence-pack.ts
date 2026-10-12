import { createHash } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { execFileSync } from "node:child_process";
import { gzipSync } from "node:zlib";
import type { ResearchStore } from "./store.js";

/** Upload limit per evidence file is 200 MB; stay safely under it. */
const PART_BYTES = 190 * 1024 * 1024;

export interface EvidencePackResult {
  directory: string;
  files: Array<{ name: string; bytes: number; sha256: string }>;
  prompts: number;
  transcripts: number;
}

function git(args: string[], cwd: string): string {
  try { return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024 }).trim(); }
  catch { return ""; }
}

function walk(directory: string): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? walk(path) : entry.isFile() ? [path] : [];
  });
}

/** Split a file into numbered parts when it exceeds the per-file upload limit. */
function splitIfLarge(path: string): string[] {
  const size = statSync(path).size;
  if (size <= PART_BYTES) return [path];
  const parts: string[] = [];
  const handle = openSync(path, "r");
  try {
    for (let offset = 0, index = 0; offset < size; offset += PART_BYTES, index += 1) {
      const length = Math.min(PART_BYTES, size - offset);
      const buffer = Buffer.alloc(length);
      readSync(handle, buffer, 0, length, offset);
      const part = `${path}.part${String(index).padStart(2, "0")}`;
      writeFileSync(part, buffer);
      parts.push(part);
    }
  } finally {
    closeSync(handle);
  }
  rmSync(path);
  return parts;
}

/** Package a campaign's evidence for an auditing competition: the full
 * trajectory, every prompt sent to a model, and the harness that ran it. */
export function packEvidence(input: {
  store: ResearchStore;
  stateDirectory: string;
  projectRoot: string;
  evidraRoot: string;
  evidraVersion: string;
  competitionPath?: string;
  output: string;
}): EvidencePackResult {
  const out = input.output;
  rmSync(out, { recursive: true, force: true });
  const staging = join(out, ".staging");
  mkdirSync(staging, { recursive: true });

  // Trajectory: raw transcripts, bounded traces, final selection, and the full event log.
  const events: string[] = [];
  for (let cursor = 0; ;) {
    const page = input.store.eventFeed(cursor, 200);
    if (!page.length) break;
    for (const event of page) events.push(JSON.stringify(event));
    cursor = page[page.length - 1].id;
  }
  writeFileSync(join(input.stateDirectory, "events.export.jsonl"), `${events.join("\n")}\n`);
  const trajectoryParts = ["transcripts", "traces", "final", "events.export.jsonl"].filter((name) => existsSync(join(input.stateDirectory, name)));
  execFileSync("tar", ["-czf", join(out, "trajectory.tar.gz"), "-C", input.stateDirectory, ...trajectoryParts]);
  rmSync(join(input.stateDirectory, "events.export.jsonl"), { force: true });

  // Prompts: every turn's exact prompt, in order.
  const transcriptFiles = walk(join(input.stateDirectory, "transcripts")).filter((path) => path.endsWith(".jsonl")).sort();
  const prompts: string[] = [];
  for (const path of transcriptFiles) {
    const first = readFileSync(path, "utf8").split("\n", 1)[0];
    try {
      const record = JSON.parse(first) as { type?: string; ts?: string; role?: string; provider?: string; model?: string; prompt?: string };
      if (record.type === "turn.start") prompts.push(JSON.stringify({ ts: record.ts, role: record.role, provider: record.provider, model: record.model, transcript: relative(input.stateDirectory, path), prompt: record.prompt }));
    } catch { /* a truncated transcript still ships in the trajectory archive */ }
  }
  writeFileSync(join(out, "prompts.jsonl.gz"), gzipSync(`${prompts.join("\n")}\n`));

  // Harness: the exact Evidra and project code that ran, plus a lock record.
  const harness = join(staging, "harness");
  mkdirSync(harness, { recursive: true });
  const archive = (repo: string, name: string): void => {
    const head = git(["rev-parse", "HEAD"], repo);
    if (!head) return;
    execFileSync("git", ["-C", repo, "archive", "--format=tar.gz", "-o", join(harness, `${name}.tar.gz`), "HEAD"]);
    const diff = git(["diff", "HEAD"], repo);
    if (diff) writeFileSync(join(harness, `${name}.uncommitted.diff`), diff);
  };
  archive(input.evidraRoot, "evidra");
  archive(input.projectRoot, "project");
  const competition = input.competitionPath && existsSync(input.competitionPath) ? readFileSync(input.competitionPath) : undefined;
  const campaign = input.store.campaign() ?? null;
  writeFileSync(join(harness, "lock.json"), `${JSON.stringify({
    evidraVersion: input.evidraVersion,
    evidraCommit: git(["rev-parse", "HEAD"], input.evidraRoot) || null,
    evidraDirty: Boolean(git(["status", "--porcelain"], input.evidraRoot)),
    projectCommit: git(["rev-parse", "HEAD"], input.projectRoot) || null,
    projectDirty: Boolean(git(["status", "--porcelain", "--untracked-files=no"], input.projectRoot)),
    competitionSha256: competition ? createHash("sha256").update(competition).digest("hex") : null,
    campaignRuntime: campaign,
    packedAt: new Date().toISOString(),
  }, null, 2)}\n`);
  if (competition) writeFileSync(join(harness, "competition.json"), competition);
  execFileSync("tar", ["-czf", join(out, "harness.tar.gz"), "-C", staging, "harness"]);
  rmSync(staging, { recursive: true, force: true });

  const files: EvidencePackResult["files"] = [];
  for (const name of ["trajectory.tar.gz", "prompts.jsonl.gz", "harness.tar.gz"]) {
    for (const part of splitIfLarge(join(out, name))) {
      const bytes = readFileSync(part);
      files.push({ name: relative(out, part), bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
    }
  }
  const kind = (name: string): string => name.startsWith("trajectory") ? "trajectory" : name.startsWith("prompts") ? "prompts" : "harness";
  const lines = [
    "# Evidence package",
    "",
    "| File | Kind | Bytes | SHA-256 |",
    "|---|---|---|---|",
    ...files.map((file) => `| ${file.name} | ${kind(file.name)} | ${file.bytes} | ${file.sha256} |`),
    "",
    `Transcripts: ${transcriptFiles.length}. Prompts: ${prompts.length}. Split parts (.partNN) concatenate in order to restore the original archive.`,
  ];
  writeFileSync(join(out, "MANIFEST.md"), `${lines.join("\n")}\n`);
  return { directory: out, files, prompts: prompts.length, transcripts: transcriptFiles.length };
}
