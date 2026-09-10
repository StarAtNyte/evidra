export interface RouteObservation {
  route: string;
  outcome: "success" | "partial" | "failure";
  quality?: string;
}

export interface RouteDrift {
  route: string;
  baselineScore: number;
  recentScore: number;
  delta: number;
  baselineSamples: number;
  recentSamples: number;
  reason: string;
}

export interface DriftReport {
  drifted: boolean;
  routes: RouteDrift[];
  threshold: number;
  window: number;
}

function score(observation: RouteObservation): number {
  if (observation.outcome === "success" || observation.quality === "PASS") return 1;
  if (observation.outcome === "partial" || observation.quality === "WARN") return 0.5;
  return 0;
}

/**
 * Detect non-stationary provider/model routes using two adjacent windows.
 * Requiring complete windows avoids reacting to one transient outage; the
 * result is a routing signal, not a claim that the underlying model changed.
 */
export function detectRouteDrift(observations: RouteObservation[], options: { window?: number; threshold?: number } = {}): DriftReport {
  const window = Math.max(2, options.window ?? 3);
  const threshold = Math.max(0.1, options.threshold ?? 0.35);
  const byRoute = new Map<string, RouteObservation[]>();
  for (const observation of observations) byRoute.set(observation.route, [...(byRoute.get(observation.route) ?? []), observation]);
  const routes: RouteDrift[] = [];
  for (const [route, entries] of byRoute) {
    if (entries.length < window * 2) continue;
    const baseline = entries.slice(-(window * 2), -window);
    const recent = entries.slice(-window);
    const baselineScore = baseline.reduce((sum, item) => sum + score(item), 0) / baseline.length;
    const recentScore = recent.reduce((sum, item) => sum + score(item), 0) / recent.length;
    const delta = recentScore - baselineScore;
    if (delta <= -threshold) routes.push({ route, baselineScore, recentScore, delta, baselineSamples: baseline.length, recentSamples: recent.length, reason: `route quality fell ${(Math.abs(delta) * 100).toFixed(0)} points across adjacent ${window}-outcome windows` });
  }
  return { drifted: routes.length > 0, routes: routes.sort((left, right) => left.delta - right.delta), threshold, window };
}
