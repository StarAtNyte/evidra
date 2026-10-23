/** Declared designs guide exploration; only executed comparisons establish merit. */
export interface ResearchDesign {
  representation: string;
  predictionMechanism: string;
  learningObjective: string;
  generalizationAssumption: string;
}

export interface ArchitectureChange {
  baseline: ResearchDesign;
  proposed: ResearchDesign;
}

const AXES = ["representation", "predictionMechanism", "learningObjective", "generalizationAssumption"] as const;

function normalize(value: string): string {
  // Scalar settings and formatting do not establish another model family.
  return value.toLowerCase().replace(/[-+]?\d+(?:\.\d+)?(?:e[-+]?\d+)?/g, "#").replace(/\s+/g, " ").trim();
}

export function architectureDifferences(change?: ArchitectureChange): Array<keyof ResearchDesign> {
  if (!change) return [];
  return AXES.filter(axis => normalize(change.baseline[axis]) !== normalize(change.proposed[axis]));
}

export function architectureNovelty(change?: ArchitectureChange): number {
  return architectureDifferences(change).length / AXES.length;
}

export const ARCHITECTURE_SEARCH_GUIDANCE = "When progress calls for an architectural pivot, propose competing implementation-ready model families. For each, declare architectureChange against the actual comparator: representation, prediction mechanism, learning objective and generalization assumption. Describe classes and mechanisms, not scalar settings. Include a discriminating prediction and matched rejection test in falsificationTest. A renamed family or a new reference cohort is not by itself a new architecture. Declared design differences guide exploration only; source inspection, bounded execution, attribution and fresh validation must establish what was implemented and whether it helped. Keep at least one ambitious alternative whose mechanism addresses the measured failure, rather than only local parameter or data variations. Use null when architectureChange is inapplicable or unknown; never fabricate a baseline design.";
