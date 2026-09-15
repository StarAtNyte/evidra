import type { CompetitionConfig } from "../core/types.js";

export const whestbenchConfig: CompetitionConfig = {
  id: "arc-whestbench-2026",
  name: "ARC White-Box Estimation Challenge 2026",
  taskType: "white_box_estimation",
  datasetRevision: "v2-phase2",
  metric: { name: "final_layer_mse", direction: "minimize" },
  secondaryMetrics: [],
  evaluator: {
    command: ["uv", "run", "whest", "run", "--estimator", "estimator.py", "--split", "mini", "--runner", "subprocess"],
    estimatorPath: "estimator.py",
  },
  researchSources: [
    "https://www.aicrowd.com/challenges/arc-white-box-estimation-challenge-2026",
    "https://www.aicrowd.com/challenges/arc-white-box-estimation-challenge-2026/discussion",
    "https://www.aicrowd.com/challenges/arc-white-box-estimation-challenge-2026/leaderboards",
    "https://github.com/AIcrowd/whest-starterkit",
    "https://github.com/AIcrowd/whestbench",
  ],
  evaluatorTimeoutMinutes: 60,
  submission: {
    platform: "command",
    source: "workspace",
    workingDirectory: "competitions/whestbench/starterkit",
    submitCommand: ["uv", "run", "whest", "submit", "--estimator", "estimator.py", "--watch"],
  },
};
