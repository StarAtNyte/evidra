import { mkdirSync, writeFileSync } from "node:fs";

const out = "assets/demo/evidra-first-use-frames";
mkdirSync(out, { recursive: true });

const slides = [
  {
    title: "01  /  ORIENT",
    prompt: "/research",
    lines: [
      "Can open-vocabulary vision detect unseen defects with 1% labels?",
      "Dataset: public industrial anomaly benchmark",
      "Metric: image AUROC + pixel AUPRO",
      "Holdout: defect categories hidden until evaluation",
    ],
    status: ["GOAL RECEIVED", "TASK  anomaly detection", "LEAKAGE  guarded", "BUDGET  bounded + resumable"],
  },
  {
    title: "02  /  DISCOVER",
    prompt: "Phase 02 · Evidence",
    lines: [
      "Researching open-vocabulary and self-supervised vision",
      "Comparing DINOv2 features, CLIP prompts, and anomaly scoring",
      "Checking methods against the held-out-category protocol",
      "Forming a falsifiable hybrid-method hypothesis",
    ],
    status: ["SOURCES  14", "CLAIMS   23", "METHODS  04", "LANES ACTIVE 04"],
  },
  {
    title: "03  /  VALIDATE",
    prompt: "Phase 03 · Experiment + replication",
    lines: [
      "Baseline: supervised CNN with 1% labeled training data",
      "Candidate: frozen DINOv2 features + fixed defect prompts",
      "Three seeds · unseen categories · fixed protocol",
      "Failed prompt-tuning route recorded as negative evidence",
    ],
    status: ["BASELINE  AUROC 0.781", "CANDIDATE AUROC 0.836", "REPLICATION  PASSED", "DECISION  RETAIN"],
  },
];

const esc = (value) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
const textLines = (lines, x, y, color = "#f6f2e8", size = 23, gap = 38) => lines.map((line, index) => `<text x="${x}" y="${y + index * gap}" fill="${color}" font-size="${size}">${esc(line)}</text>`).join("");

slides.forEach((slide, index) => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720">
  <rect width="1280" height="720" fill="#090c18"/>
  <rect x="42" y="34" width="1196" height="652" rx="18" fill="#0f1425" stroke="#2b3150" stroke-width="2"/>
  <circle cx="75" cy="70" r="7" fill="#ff6b6b"/><circle cx="101" cy="70" r="7" fill="#ffc857"/><circle cx="127" cy="70" r="7" fill="#c7ff4a"/>
  <text x="165" y="78" fill="#858ba8" font-family="DejaVu Sans Mono" font-size="18">EVIDRA  /  RESEARCH WORKBENCH</text>
  <line x1="70" y1="110" x2="1210" y2="110" stroke="#2b3150"/>
  <text x="82" y="165" fill="#858ba8" font-family="DejaVu Sans Mono" font-size="16">${esc(slide.title)}</text>
  <text x="82" y="215" fill="#c7ff4a" font-family="DejaVu Sans Mono" font-size="25">› ${esc(slide.prompt)}</text>
  ${textLines(slide.lines, 112, 278)}
  <rect x="760" y="164" width="407" height="350" rx="12" fill="#141b31" stroke="#3b4164"/>
  <text x="792" y="211" fill="#8b6cff" font-family="DejaVu Sans Mono" font-size="16">LIVE CAMPAIGN STATE</text>
  ${textLines(slide.status, 792, 270, "#c7ff4a", 19, 55)}
  <rect x="82" y="605" width="1085" height="42" rx="8" fill="#151b30"/>
  <text x="105" y="632" fill="#858ba8" font-family="DejaVu Sans Mono" font-size="16">research · experiment · validate · resume</text>
  <text x="1075" y="632" fill="#8b6cff" font-family="DejaVu Sans Mono" font-size="16">${String(index + 1).padStart(2, "0")} / ${String(slides.length).padStart(2, "0")}</text>
  </svg>`;
  writeFileSync(`${out}/frame-${String(index + 1).padStart(2, "0")}.svg`, svg);
});
