export interface CodeHealthFile {
  path: string;
  content: string;
}

export interface CodeHealthSnapshot {
  sourceFiles: number;
  sourceLines: number;
  testFiles: number;
  testLines: number;
  todoCount: number;
  files: string[];
}

export interface CodeHealthAssessment {
  status: "pass" | "warn" | "fail";
  sourceLineDelta: number;
  testLineDelta: number;
  todoDelta: number;
  removedTestFiles: number;
  reasons: string[];
}

export interface CodeHealthTrend {
  samples: number;
  cumulativeSourceLineDelta: number;
  cumulativeTestLineDelta: number;
  cumulativeTodoDelta: number;
  untestedGrowthStreak: number;
  status: "pass" | "warn" | "fail";
  reasons: string[];
}

const TEST_PATH = /(^|\/)(test|tests|spec|specs)(\/|$)|(?:^|[._-])(test|spec)\.[^.]+$/i;

/** Build a small structural snapshot without parsing a language-specific AST. */
export function snapshotCodeHealth(files: CodeHealthFile[]): CodeHealthSnapshot {
  const valid = files.filter((file) => file.path.trim().length > 0);
  const source = valid.filter((file) => !TEST_PATH.test(file.path));
  const tests = valid.filter((file) => TEST_PATH.test(file.path));
  const countLines = (items: CodeHealthFile[]): number => items.reduce((sum, file) => sum + (file.content.match(/\r?\n/g)?.length ?? 0) + (file.content.length ? 1 : 0), 0);
  const todoCount = valid.reduce((sum, file) => sum + (file.content.match(/\b(?:TODO|FIXME|HACK)\b/gi)?.length ?? 0), 0);
  return { sourceFiles: source.length, sourceLines: countLines(source), testFiles: tests.length, testLines: countLines(tests), todoCount, files: valid.map((file) => file.path).sort() };
}

/**
 * Detect structural erosion between an experiment's pre-edit and post-edit
 * worktree. This is a warning signal by default; only clear test deletion or
 * extreme untested growth blocks evaluation.
 */
export function assessCodeHealth(before: CodeHealthSnapshot, after: CodeHealthSnapshot): CodeHealthAssessment {
  const sourceLineDelta = after.sourceLines - before.sourceLines;
  const testLineDelta = after.testLines - before.testLines;
  const todoDelta = after.todoCount - before.todoCount;
  const beforeTests = new Set(before.files.filter((path) => TEST_PATH.test(path)));
  const afterTests = new Set(after.files.filter((path) => TEST_PATH.test(path)));
  const removedTestFiles = [...beforeTests].filter((path) => !afterTests.has(path)).length;
  const reasons: string[] = [];
  if (removedTestFiles > 0) reasons.push(`${removedTestFiles} test file(s) were removed`);
  if (todoDelta > 0) reasons.push(`TODO/FIXME/HACK markers increased by ${todoDelta}`);
  const largeUntestedGrowth = sourceLineDelta >= 200 && testLineDelta <= 0 && sourceLineDelta >= Math.max(200, before.sourceLines * 0.5);
  if (largeUntestedGrowth) reasons.push(`source grew by ${sourceLineDelta} line(s) without test growth`);
  const status: CodeHealthAssessment["status"] = removedTestFiles > 0 || (largeUntestedGrowth && sourceLineDelta >= 500) ? "fail" : reasons.length ? "warn" : "pass";
  return { status, sourceLineDelta, testLineDelta, todoDelta, removedTestFiles, reasons };
}

/** Assess accumulated drift across recent autonomous edits, not only one edit. */
export function assessCodeHealthTrend(assessments: CodeHealthAssessment[]): CodeHealthTrend {
  const recent = assessments.slice(-12);
  const cumulativeSourceLineDelta = recent.reduce((sum, item) => sum + item.sourceLineDelta, 0);
  const cumulativeTestLineDelta = recent.reduce((sum, item) => sum + item.testLineDelta, 0);
  const cumulativeTodoDelta = recent.reduce((sum, item) => sum + item.todoDelta, 0);
  let untestedGrowthStreak = 0;
  for (const item of recent.slice().reverse()) {
    if (item.sourceLineDelta > 0 && item.testLineDelta <= 0) untestedGrowthStreak++;
    else break;
  }
  const reasons: string[] = [];
  if (untestedGrowthStreak >= 3) reasons.push(untestedGrowthStreak + " consecutive edits grew source without growing tests");
  if (cumulativeTodoDelta > 0) reasons.push("recent edits accumulated " + cumulativeTodoDelta + " TODO/FIXME/HACK marker(s)");
  const severe = recent.some((item) => item.status === "fail") || (untestedGrowthStreak >= 4 && cumulativeSourceLineDelta >= 500) || cumulativeTodoDelta >= 25;
  const status: CodeHealthTrend["status"] = severe ? "fail" : reasons.length ? "warn" : "pass";
  return { samples: recent.length, cumulativeSourceLineDelta, cumulativeTestLineDelta, cumulativeTodoDelta, untestedGrowthStreak, status, reasons };
}
