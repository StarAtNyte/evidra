import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

export interface ProjectGuidance {
  paths: string[];
  text: string;
  contentHash: string;
  truncated: boolean;
}

const GUIDANCE_FILES = ["EVIDRA.md", ".evidra/instructions.md"] as const;
const MAX_GUIDANCE_BYTES = 16_000;

function sharedSkillFiles(workspace: string, skillAllowlist?: readonly string[]): string[] {
  const directory = join(workspace, ".evidra", "skills");
  if (!existsSync(directory)) return [];
  try {
    const allowed = skillAllowlist === undefined ? undefined : new Set(skillAllowlist.map((skill) => skill.toLowerCase()));
    return readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".md"))
      .filter((entry) => allowed === undefined || allowed.has(entry.name.toLowerCase()))
      .map((entry) => `.evidra/skills/${entry.name}`)
      .sort((left, right) => left.localeCompare(right));
  } catch {
    return [];
  }
}

/** Load explicit operator guidance without confusing it with observed evidence. */
export function loadProjectGuidance(root: string, role?: string, skillAllowlist?: readonly string[]): ProjectGuidance | undefined {
  const workspace = resolve(root);
  const parts: string[] = [];
  const paths: string[] = [];
  let truncated = false;
  const roleSlug = role?.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const guidanceFiles = [...GUIDANCE_FILES, ...sharedSkillFiles(workspace, skillAllowlist), ...(roleSlug ? [`.evidra/roles/${roleSlug}.md`] : [])];
  for (const relativePath of guidanceFiles) {
    const path = join(workspace, relativePath);
    if (!existsSync(path) || !lstatSync(path).isFile()) continue;
    const content = readFileSync(path, "utf8");
    const remaining = Math.max(0, MAX_GUIDANCE_BYTES - parts.join("\n\n").length);
    if (remaining === 0) { truncated = true; break; }
    const bounded = content.slice(0, remaining);
    if (bounded.length < content.length) truncated = true;
    parts.push(`### ${relativePath}\n${bounded}`);
    paths.push(relativePath);
  }
  if (!parts.length) return undefined;
  const text = parts.join("\n\n");
  return { paths, text, contentHash: createHash("sha256").update(text).digest("hex"), truncated };
}
