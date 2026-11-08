// Builds a single-file test preview of the page (no network, sample times, simulated clock).
//   node test/build-preview.mjs <path/to/esbuild> <out.html>
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const [esbuild, out, statsFixture] = process.argv.slice(2);
const stats = statsFixture ? readFileSync(statsFixture, "utf8") : "null";

const shim = execFileSync(esbuild, [join(root, "test/preview-shim.js"), "--bundle", "--format=iife", "--platform=browser", "--target=es2020"], { encoding: "utf8" });
const css = readFileSync(join(root, "public/styles.css"), "utf8");
const html = readFileSync(join(root, "public/index.html"), "utf8");
const markup = html.split("<!--APP-->")[1].split("<!--/APP-->")[0];
const app = readFileSync(join(root, "public/app.js"), "utf8");

const page = `<title>Season 5 Standings Test</title>
<meta name="claude:viewport-fit-sides" content="cover">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Chakra+Petch:wght@500;600;700&family=Barlow:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500;600&display=swap">
<style>
${css}
.preview-bar{background:var(--ink);color:var(--bg);padding-block:10px;padding-left:max(16px, env(safe-area-inset-left, 0px));padding-right:max(16px, env(safe-area-inset-right, 0px))}
.preview-bar .in{max-width:880px;margin:0 auto;display:flex;flex-wrap:wrap;align-items:center;gap:8px 14px;font-size:13px}
.preview-bar b{font-family:var(--mono);font-size:11px;letter-spacing:.08em;text-transform:uppercase;background:var(--accent);color:#fff;padding:2px 7px;border-radius:3px}
.preview-bar .note{flex:1 1 220px;min-width:0;opacity:.85}
.preview-bar .seg{display:flex;flex-wrap:wrap;gap:4px}
.preview-bar button{font:600 12px var(--body);color:var(--bg);background:transparent;border:1px solid color-mix(in srgb, var(--bg) 35%, transparent);border-radius:4px;padding:5px 10px;cursor:pointer}
.preview-bar button[aria-pressed="true"]{background:var(--bg);color:var(--ink);border-color:var(--bg)}
.preview-bar button:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
</style>

<div class="preview-bar" role="region" aria-label="Test preview controls">
  <div class="in">
    <b>Test preview</b>
    <span class="note">Sample Track 1 times from Nov 2. Not connected to the live site. Pick a moment in the week to see how the page looks then:</span>
    <span class="seg" id="scenarios"></span>
    <span class="note" id="scenarioNote" style="flex-basis:100%"></span>
  </div>
</div>
<div id="app"></div>

<script>window.STATS_FIXTURE = ${stats};</script>
<script>${shim}</script>
<script>
(() => {
  const MARKUP = ${JSON.stringify(markup)};
  const APP = ${JSON.stringify(app)};
  const P = window.STANDINGS_PREVIEW;
  const bar = document.getElementById("scenarios");
  let current = "live";
  function paintBar() {
    bar.innerHTML = Object.entries(P.scenarios).map(([k, s]) =>
      '<button type="button" data-k="' + k + '" aria-pressed="' + (k === current) + '">' + s.label + '</button>').join("");
  }
  async function boot(name) {
    current = name; paintBar();
    if (window.__standingsStop) window.__standingsStop();
    await P.setup(name);
    document.getElementById("app").innerHTML = MARKUP;
    try { history.replaceState(null, "", location.pathname + location.search); } catch (e) {}
    new Function(APP)();
    const sc = P.scenarios[name];
    document.getElementById("scenarioNote").textContent = sc.note || "";
    if (sc.view === "races") setTimeout(() => document.getElementById("viewRacesBtn")?.click(), 300);
    if (sc.view === "stats") setTimeout(() => document.getElementById("viewStatsBtn")?.click(), 300);
  }
  bar.addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) boot(b.dataset.k); });
  boot(${statsFixture ? '"stats"' : '"live"'});
})();
</script>
`;
writeFileSync(out, page);
console.log("wrote", out, (page.length / 1024).toFixed(1) + " KB");
