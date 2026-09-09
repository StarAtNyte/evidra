import type { CompetitionConfig } from "../core/types.js";

export const whestbenchConfig: CompetitionConfig = {
  id: "arc-whestbench-2026",
  name: "ARC White-Box Estimation Challenge 2026",
  taskType: "white_box_estimation",
  datasetRevision: "v2-phase2",
  metric: { name: "final_layer_mse", direction: "minimize" },
  evaluator: {
    command: ["uv", "run", "whest", "run", "--estimator", "estimator.py", "--split", "mini", "--runner", "subprocess"],
    estimatorPath: "estimator.py",
  },
  submission: {
    platform: "command",
    source: "workspace",
    workingDirectory: "competitions/whestbench/starterkit",
    submitCommand: ["uv", "run", "whest", "submit", "--estimator", "estimator.py", "--watch"],
  },
};
