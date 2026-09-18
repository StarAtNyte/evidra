export interface ResearchStarterBrief {
  title: string;
  goal: string;
  answer: string;
}

/** Domain examples for onboarding; the controller remains domain-agnostic. */
export const RESEARCH_STARTER_BRIEFS: readonly ResearchStarterBrief[] = [
  {
    title: "Robust video understanding",
    goal: "Improve long-video event retrieval when camera motion, lighting, and frame rate shift between training and deployment.",
    answer: "Measure retrieval mAP, calibration, latency, and worst-group performance across clean and shifted splits; stop after a replicated gain with no subgroup regression.",
  },
  {
    title: "Open-vocabulary segmentation",
    goal: "Test whether uncertainty-aware pseudo-label selection improves open-vocabulary segmentation with limited annotations.",
    answer: "Compare against a frozen baseline on mIoU, rare-class IoU, abstention quality, and label budget; require a held-out replication and an error audit.",
  },
  {
    title: "Efficient multimodal reasoning",
    goal: "Find a cheaper image-text inference strategy that preserves answer quality under a fixed compute budget.",
    answer: "Track task score, joules or GPU-hours, tokens, and failure modes across multiple seeds; accept only a Pareto improvement confirmed by an independent run.",
  },
];

export function formatResearchStarterBriefs(): string {
  return RESEARCH_STARTER_BRIEFS.map((brief, index) => `${String(index + 1).padStart(2, "0")} · ${brief.title}\n   Goal: ${brief.goal}\n   Answer: ${brief.answer}`).join("\n\n");
}
