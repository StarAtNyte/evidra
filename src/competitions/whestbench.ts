import type { CompetitionConfig } from "../core/types.js";

export const whestbenchConfig: CompetitionConfig = {
  id: "arc-whestbench-2026",
  name: "ARC White-Box Estimation Challenge 2026",
  taskType: "white_box_estimation",
  datasetRevision: "v2-phase2",
  metric: { name: "adjusted_final_layer_score", direction: "minimize" },
  secondaryMetrics: [{ name: "final_layer_mse", direction: "minimize", minimumDelta: 0, maximumRegression: 0 }],
  evaluator: {
    // Keep one persistent official worker for the whole split: estimator state,
    // warm-up, memory use, and failures must follow the grader's true lifecycle.
    command: ["uv", "run", "python", "evaluate_batched.py", "--estimator", "estimator.py", "--dataset", ".whest-data", "--split", "mini"],
    estimatorPath: "estimator.py",
  },
  researchSources: [
    "https://www.aicrowd.com/challenges/arc-white-box-estimation-challenge-2026",
    "https://www.aicrowd.com/challenges/arc-white-box-estimation-challenge-2026/discussion",
    "https://www.aicrowd.com/challenges/arc-white-box-estimation-challenge-2026/leaderboards",
    "https://github.com/AIcrowd/whest-starterkit",
    "https://github.com/AIcrowd/whestbench",
  ],
  researchChannels: [
    // Rules and deadline information are mutable competition state. Refresh them
    // on a bounded cadence instead of trusting launch announcements or memory.
    { kind: "rules", url: "https://www.aicrowd.com/challenges/arc-white-box-estimation-challenge-2026", refreshMinutes: 60 },
    { kind: "other", url: "https://www.aicrowd.com/participants/mohanty", refreshMinutes: 60 },
    { kind: "discussion", url: "https://www.aicrowd.com/challenges/arc-white-box-estimation-challenge-2026/discussion", refreshMinutes: 30 },
    { kind: "leaderboard", url: "https://www.aicrowd.com/challenges/arc-white-box-estimation-challenge-2026/leaderboards", refreshMinutes: 15 },
    { kind: "repository", url: "https://github.com/AIcrowd/whest-starterkit" },
    { kind: "repository", url: "https://github.com/AIcrowd/whestbench" },
  ],
  // The full persistent mini gate has 100 MLPs. The official per-MLP wall cap
  // is 120 seconds, so a valid complete run can exceed one hour on a local
  // CPU; leave headroom for runner startup and slower hardware.
  evaluatorTimeoutMinutes: 240,
  baselineCommand: ["uv", "run", "whest", "run", "--estimator", "examples/02_mean_propagation.py", "--dataset", ".whest-data", "--split", "mini", "--runner", "subprocess", "--max-threads", "2"],
  experimentCommand: ["uv", "run", "python", "evaluate_batched.py", "--estimator", "estimator.py", "--dataset", ".whest-data", "--split", "mini"],
  execution: {
    matrixRequired: false,
    // The generic Evidra successive-halving stage invokes this command via
    // `experiment run --reduced-only`, then promotes survivors to the full
    // 100-row command above. The prefix still uses the official persistent
    // subprocess runner through evaluate_batched.py.
    reducedValidationCommand: ["uv", "run", "python", "evaluate_batched.py", "--estimator", "estimator.py", "--dataset", ".whest-data", "--split", "mini", "--limit", "4"],
    environment: {
      // Match the packaged K3 estimator's grade-time default. Lowering this
      // locally made the persistent-worker gate evaluate a different artifact.
      V26_STRASSEN: "5",
      OPENBLAS_NUM_THREADS: "2",
      OMP_NUM_THREADS: "2",
      MKL_NUM_THREADS: "2",
      VECLIB_MAXIMUM_THREADS: "2",
      NUMEXPR_NUM_THREADS: "2",
    },
    requiredArtifacts: [],
    dataPaths: [".whest-data/metadata.json", ".whest-data/data"],
    supportFiles: ["evaluate_batched.py"],
  },
  submission: {
    platform: "command",
    source: "workspace",
    workingDirectory: "competitions/whestbench/starterkit",
    artifactPaths: ["submission.tar.gz"],
    submitCommand: ["uv", "run", "whest", "submit", "{artifact:submission.tar.gz}", "--yes", "--watch"],
  },
  // AIcrowd allows ten entries per day for this account. Keep submissions
  // approval-gated and enforce the known daily ceiling in the CLI.
  submissionPolicy: {
    requireHumanApproval: true,
    minimumInformationValue: 0,
    minimumLocalConfidence: 0,
    rejectIfLeakageFlagged: true,
    reserveForFinalEnsemble: 0,
    minimumHoursBetweenSubmissions: 0,
    dailyLimit: 10,
  },
};
