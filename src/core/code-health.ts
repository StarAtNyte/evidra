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
