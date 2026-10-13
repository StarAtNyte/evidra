import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Proxy-transfer calibration.
 *
 * A campaign optimises a local proxy because the real evaluator is scarce (a daily-limited
 * leaderboard, a hidden test set, a lab assay). Proxies drift: a component can improve locally
 * while the real score does not move, or the reverse. Each time a real evaluation is observed
 * alongside the proxy breakdown that produced it, record the pair; from those pairs estimate,
 * per component, how much of a proxy gain over the floor shows up in the real score.
 *
 * The estimate is a ratio through the floor, shrunk toward a neutral prior so one observation
 * cannot zero out a component: beta = (sum p*e + k*prior*s^2) / (sum p^2 + k*s^2), where p and e
 * are proxy and real gains over the floor. It is deliberately simple and conservative: it decides
 * which proxy gains to trust and how to rank finalists, not what the method should be.
 */

export interface ProxyTransferComponent {
  /** Proxy metric name as emitted by the evaluator (e.g. board_P_T1). */
  proxy: string;
  /** External score name as reported by the real evaluator (e.g. T1:val). */
  external: string;
  /** Score both sides take for the floor model; gains are measured from it. */
  floor: number;
  /** Contribution of this component to the external total. */
  weight: number;
}

export interface ProxyTransferObservation {
  at: string;
  label?: string;
  proxy: Record<string, number>;
  external: Record<string, number>;
}

export interface ComponentTransfer {
  proxy: string;
  external: string;
  observations: number;
  beta: number;
  trusted: boolean;
}

export interface ProxyTransferCalibration {
  schemaVersion: 1;
  observations: number;
  components: ComponentTransfer[];
}

const PRIOR_BETA = 0.5;
const PRIOR_STRENGTH = 1;
/** Typical size of a proxy gain over the floor, in score points; sets the prior's weight. */
const GAIN_SCALE = 5;
const TRUST_THRESHOLD = 0.35;

export function calibrateProxyTransfer(components: ProxyTransferComponent[], observations: ProxyTransferObservation[]): ProxyTransferCalibration {
  const rows = components.map((component) => {
    let cross = 0;
    let square = 0;
    let count = 0;
    for (const observation of observations) {
      const proxy = observation.proxy[component.proxy];
      const external = observation.external[component.external];
      if (!Number.isFinite(proxy) || !Number.isFinite(external)) continue;
      const p = proxy - component.floor;
      const e = external - component.floor;
      cross += p * e;
      square += p * p;
      count += 1;
    }
    const prior = PRIOR_STRENGTH * GAIN_SCALE * GAIN_SCALE;
    const beta = Math.max(-0.5, Math.min(2, (cross + prior * PRIOR_BETA) / (square + prior)));
    return { proxy: component.proxy, external: component.external, observations: count, beta: Number(beta.toFixed(3)), trusted: beta >= TRUST_THRESHOLD };
  });
  return { schemaVersion: 1, observations: observations.length, components: rows };
}

/** Expected external total for a proxy breakdown under the calibration; undefined if a component is missing. */
export function expectedExternalScore(components: ProxyTransferComponent[], calibration: ProxyTransferCalibration, metrics: Record<string, unknown>): number | undefined {
  let total = 0;
  for (const component of components) {
    const value = Number(metrics[component.proxy]);
    if (!Number.isFinite(value)) return undefined;
    const beta = calibration.components.find((row) => row.proxy === component.proxy)?.beta ?? PRIOR_BETA;
    total += component.weight * (component.floor + beta * (value - component.floor));
  }
  return Number(total.toFixed(3));
}

export function readTransferObservations(path: string): ProxyTransferObservation[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter((line) => line.trim()).flatMap((line) => {
    try {
      const value = JSON.parse(line) as ProxyTransferObservation;
      return value && typeof value.proxy === "object" && typeof value.external === "object" ? [value] : [];
    } catch {
      return [];
    }
  });
}

export function appendTransferObservation(path: string, observation: ProxyTransferObservation): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(observation)}\n`);
}

/** Director-facing summary: which proxy components transfer, and how to judge candidates. */
export function proxyTransferGuidance(calibration: ProxyTransferCalibration, incumbentExpected?: number): string {
  if (!calibration.observations) return "";
  const lines = calibration.components.map((row) => `- ${row.proxy} -> ${row.external}: transfer ${row.beta} from ${row.observations} observation(s)${row.trusted ? "" : " (UNTRUSTED: proxy gains here have not shown up in the real score)"}`);
  return [
    `PROXY TRANSFER (calibrated from ${calibration.observations} real evaluation(s) of earlier candidates; 1 means a proxy gain transfers fully, 0 not at all):`,
    ...lines,
    incumbentExpected !== undefined ? `Transfer-adjusted expected real total of the current best candidate: ${incumbentExpected}.` : "",
    "Judge candidates by the transfer-adjusted expected real score, not the raw proxy. Before counting a gain on an untrusted component, ask whether the proxy rewards the goal or a shortcut, and back it with an independent check (an alternative proxy split, a leave-one-out diagnostic, or the public evidence for that component).",
  ].filter(Boolean).join("\n");
}
