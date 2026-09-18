export interface ResearchStarterBrief {
  title: string;
  question: string;
  goal: string;
  answer: string;
}

/** Domain examples for onboarding; the controller remains domain-agnostic. */
export const RESEARCH_STARTER_BRIEFS: readonly ResearchStarterBrief[] = [
  {
    title: "Memory under video shift",
    question: "Can a compact, retrieval-backed visual memory improve long-video event search when camera motion, lighting, and frame rate change at deployment?",
    goal: "Compare a frozen baseline, temporal memory, and retrieval-gated memory without allowing test footage or future labels into the index.",
    answer: "Report retrieval mAP, recall at fixed latency, calibration, memory cost, and worst-shift performance on clean, synthetic-shift, and held-out real-shift splits. Accept only a replicated gain with no protected-slice regression.",
  },
  {
    title: "Open-world 3D perception",
    question: "Can uncertainty-aware pseudo-label selection make open-vocabulary 3D segmentation useful when new objects appear and annotations are scarce?",
    goal: "Separate vocabulary expansion, pseudo-label selection, and geometry changes into controlled ablations rather than treating a larger model as one intervention.",
    answer: "Measure mIoU, rare-class and novel-class IoU, calibration, abstention risk, annotation-hours saved, and performance under geographic or sensor shift. Require a held-out scene replication plus an error and leakage audit.",
  },
  {
    title: "Budgeted multimodal agents",
    question: "When should a vision-language agent look again, crop an image, call a tool, or answer immediately under a strict latency and energy budget?",
    goal: "Learn a confidence- and information-gain-based action policy while keeping the base model, task mix, and evaluator fixed.",
    answer: "Track task score, calibration, latency, image views, tool calls, tokens, energy or GPU-hours, and abstention quality across seeds and difficulty slices. Accept only a Pareto improvement confirmed by an independent policy run.",
  },
];

export function formatResearchStarterBriefs(): string {
  return RESEARCH_STARTER_BRIEFS.map((brief, index) => `${String(index + 1).padStart(2, "0")} · ${brief.title}\n   Question: ${brief.question}\n   Goal: ${brief.goal}\n   Answer: ${brief.answer}`).join("\n\n");
}
