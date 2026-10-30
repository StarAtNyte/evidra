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

