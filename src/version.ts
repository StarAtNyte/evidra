import { readFileSync } from "node:fs";

/** Resolve the shipped package version in both tsx source and compiled dist layouts. */
export function evidraVersion(): string {
  try {
    const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version?: unknown };
    if (typeof packageJson.version === "string" && /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(packageJson.version)) return packageJson.version;
  } catch { /* fall through for unusual embedding environments */ }
  return "0.0.0-unknown";
}
