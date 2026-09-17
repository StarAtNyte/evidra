import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import puppeteer from "/home/at-office/.npm/_npx/668c188756b835f3/node_modules/puppeteer/lib/esm/puppeteer/puppeteer.js";

const root = process.cwd();
const frames = mkdtempSync("/tmp/evidra-demo-frames-");
const outputDir = join(root, "assets", "product-hunt");
const output = join(outputDir, "evidra-product-demo.mp4");
mkdirSync(outputDir, { recursive: true });

const html = `<!doctype html><html><head><style>
:root{--ink:#080a14;--panel:#101426;--rule:#2b3150;--paper:#f6f2e8;--muted:#858ba8;--purple:#8b6cff;--lime:#c7ff4a;--amber:#ffc857}
*{box-sizing:border-box}body{margin:0;background:var(--ink);color:var(--paper);font:15px 'DM Mono',monospace;overflow:hidden}main{width:100vw;height:100vh;display:grid;place-items:center;position:relative;background:radial-gradient(circle at 70% 40%,#17164066,transparent 45%)}
.grain{position:absolute;inset:0;opacity:.05;background-image:radial-gradient(#fff 1px,transparent 1px);background-size:5px 5px}.scene{width:1080px;min-height:560px;position:relative}.brand{color:var(--lime);font-weight:500;letter-spacing:.25em;font-size:14px;margin-bottom:32px}.brand span{color:var(--muted);letter-spacing:.08em;margin-left:20px}.headline{font:600 68px/1.02 'Space Grotesk',sans-serif;letter-spacing:-.06em;max-width:850px;margin:0 0 18px}.headline em{font-style:normal;color:var(--purple)}.sub{color:var(--muted);font-size:16px;line-height:1.7;max-width:630px;margin-bottom:36px}.terminal{border:1px solid #51547b;background:#0c0f1e;box-shadow:20px 24px 70px #0008}.bar{height:42px;border-bottom:1px solid var(--rule);display:flex;align-items:center;justify-content:space-between;padding:0 18px;color:var(--muted);font-size:11px}.dots{display:flex;gap:6px}.dots i{width:7px;height:7px;border-radius:50%;background:#565b73}.connected{color:var(--lime)}.body{padding:25px 28px;min-height:255px;font-size:14px;line-height:2}.muted{color:#5e6584}.prompt{color:var(--paper)}.purple{color:var(--purple)}.lime{color:var(--lime)}.amber{color:var(--amber)}.hidden{visibility:hidden}.cursor{display:inline-block;width:8px;height:16px;background:var(--lime);vertical-align:-3px;margin-left:4px;animation:blink 1s steps(2) infinite}@keyframes blink{50%{opacity:0}}
.badge{position:absolute;right:0;top:38px;border:1px solid var(--rule);padding:12px 15px;color:var(--muted);font-size:11px}.badge strong{color:var(--lime);font-weight:400}.caption{position:absolute;bottom:5px;left:0;color:var(--muted);font-size:11px;letter-spacing:.12em}.caption b{color:var(--purple);font-weight:400}.titlecard{display:none;text-align:center;position:absolute;inset:0;place-items:center}.titlecard .big{font:700 110px 'Space Grotesk',sans-serif;letter-spacing:-.08em;color:var(--paper)}.titlecard .big i{font-style:normal;color:var(--purple)}.titlecard p{color:var(--lime);font-size:13px;letter-spacing:.3em;margin-top:20px}.phase{display:none}.phase.active{display:block}
</style><link href="https://fonts.googleapis.com/css2?family=DM+Mono:wght@400;500&family=Space+Grotesk:wght@500;600;700&display=swap" rel="stylesheet"></head><body><main><div class="grain"></div><section class="titlecard" id="opening"><div><div class="big">EVIDRA</div><p>THE RESEARCH HARNESS</p></div></section><section class="scene" id="campaign"><div class="brand">EVIDRA<span>RESEARCH HARNESS</span></div><div class="badge">STATUS <strong>● ALPHA</strong></div><h1 class="headline">Research that <em>keeps going.</em></h1><p class="sub">A durable loop for evidence, experiments, and decisions.</p><div class="terminal"><div class="bar"><span class="dots"><i></i><i></i><i></i></span><span>evidra / campaign</span><span class="connected">● connected</span></div><div class="body"><div class="muted">$ evidra</div><div class="lime">EVIDRA <span class="muted">RESEARCH DIRECTOR</span></div><div class="prompt">› /research start</div><div class="phase" data-start="5" data-end="8"><span class="purple">◆</span> Inspecting workspace <span class="lime">complete</span></div><div class="phase" data-start="8" data-end="11"><span class="purple">◆</span> Gathering evidence <span class="lime">12 sources</span></div><div class="phase" data-start="11" data-end="14"><span class="purple">◆</span> Allocating independent lanes <span class="lime">3 active</span></div><div class="phase" data-start="14" data-end="17"><span class="amber">◌</span> Running experiment_004 <span class="amber">working</span></div><div class="phase" data-start="17" data-end="20"><span class="amber">×</span> Hypothesis rejected <span class="muted">negative evidence saved</span></div><div class="phase" data-start="20" data-end="23"><span class="purple">↗</span> Route changed <span class="lime">new test allocated</span></div><div class="phase" data-start="23" data-end="26"><span class="lime">✓</span> Replication complete <span class="lime">result promoted</span></div><div class="phase" data-start="26" data-end="29"><span class="purple">›</span> /research resume <span class="lime">campaign restored</span></div><div class="prompt">› <span class="cursor"></span></div></div></div><div class="caption"><b>GOAL</b> → EVIDENCE → HYPOTHESIS → EXPERIMENT → REPLICATION</div></section></main></body></html>`;

const browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox"] });
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 720, deviceScaleFactor: 1 });
await page.setContent(html, { waitUntil: "networkidle0" });
await page.evaluate(() => document.fonts.ready);
const fps = 24;
const duration = 29;
for (let frame = 0; frame < fps * duration; frame += 1) {
  const seconds = frame / fps;
  await page.evaluate((time) => {
    document.querySelector("#opening").style.display = time < 3 ? "grid" : "none";
    document.querySelector("#campaign").style.opacity = time < 3 ? "0" : "1";
    for (const phase of document.querySelectorAll(".phase")) {
      const start = Number(phase.dataset.start); const end = Number(phase.dataset.end);
      phase.classList.toggle("active", time >= start && time < end);
    }
  }, seconds);
  await page.screenshot({ path: join(frames, `frame-${String(frame).padStart(4, "0")}.jpg`), type: "jpeg", quality: 90 });
}
await browser.close();
execFileSync("ffmpeg", ["-y", "-framerate", String(fps), "-i", join(frames, "frame-%04d.jpg"), "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p", "-movflags", "+faststart", output], { stdio: "inherit" });
rmSync(frames, { recursive: true, force: true });
console.log(`Saved ${output}`);
