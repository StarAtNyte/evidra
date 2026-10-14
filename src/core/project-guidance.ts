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
// A research brief for a hard problem (scorer notes, prior-run feedback, ranked directions) is
// routinely 15-25 KB; a lower cap silently dropped its tail and every role file after it.
const MAX_GUIDANCE_BYTES = 48_000;
/** Space kept for the role's own file so a long shared brief cannot crowd it out. */
const ROLE_RESERVE_BYTES = 8_000;

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

/** Lessons distilled from earlier campaigns (`evidra lessons distil`), newest first, at most two. */
function lessonFiles(workspace: string): string[] {
  const directory = join(workspace, ".evidra", "lessons");
  if (!existsSync(directory)) return [];
  try {
    return readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".md"))
      .map((entry) => ({ name: entry.name, mtime: lstatSync(join(directory, entry.name)).mtimeMs }))
      .sort((left, right) => right.mtime - left.mtime || right.name.localeCompare(left.name))
      .slice(0, 2)
      .map((entry) => `.evidra/lessons/${entry.name}`);
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
  const rolePath = roleSlug ? `.evidra/roles/${roleSlug}.md` : undefined;
  const roleFile = rolePath ? join(workspace, rolePath) : undefined;
  const roleReserve = roleFile && existsSync(roleFile) && lstatSync(roleFile).isFile() ? Math.min(ROLE_RESERVE_BYTES, readFileSync(roleFile, "utf8").length + 64) : 0;
  const guidanceFiles = [...GUIDANCE_FILES, ...lessonFiles(workspace), ...sharedSkillFiles(workspace, skillAllowlist), ...(rolePath ? [rolePath] : [])];
  for (const relativePath of guidanceFiles) {
    const path = join(workspace, relativePath);
    if (!existsSync(path) || !lstatSync(path).isFile()) continue;
    const content = readFileSync(path, "utf8");
    const limit = relativePath === rolePath ? MAX_GUIDANCE_BYTES : MAX_GUIDANCE_BYTES - roleReserve;
    const remaining = Math.max(0, limit - parts.join("\n\n").length);
    if (remaining === 0) { truncated = true; continue; }
    const bounded = content.slice(0, remaining);
    if (bounded.length < content.length) truncated = true;
    parts.push(`### ${relativePath}\n${bounded}`);
    paths.push(relativePath);
  }
  if (!parts.length) return undefined;
  const text = parts.join("\n\n");
  return { paths, text, contentHash: createHash("sha256").update(text).digest("hex"), truncated };
}
