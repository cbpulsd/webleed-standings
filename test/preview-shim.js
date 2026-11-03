// Test-preview only: runs the real backend in the browser against sample times,
// with a simulated clock, so the page can be reviewed without touching anything live.
import { route } from "../src/index.js";
import { runSchedule } from "../src/sync.js";
import { TRACKS } from "../src/config.js";
import sample from "./fixtures/sample-leaderboard.json";

const HOUR = 3_600_000;
const LOCK = Date.parse(TRACKS[0].locksAt);

class MemoryKV {
  constructor() { this.data = new Map(); }
  async get(k, type) { const v = this.data.get(k); return v == null ? null : type === "json" ? JSON.parse(v) : v; }
  async put(k, v) { this.data.set(k, v); }
}

const page = (rows) =>
  "<table>" + rows.map((r) => `<tr><td>${r.rank}</td><td>${r.time.toFixed(3)}</td><td>${r.name}</td></tr>`).join("") + "</table>";

// Each scenario replays the hourly timer up to a moment in the week.
const SCENARIOS = {
  live: { label: "Live now", at: () => Math.min(Date.now(), LOCK - 30 * HOUR - 17 * 60_000) },
  closing: { label: "Sat 11:20 PM, just before lock", at: () => LOCK - 39 * 60_000 },
  final: { label: "After the lock (final)", at: () => LOCK + 26 * HOUR },
};

let clockOffset = 0;
let env = null;

async function setup(name) {
  const target = SCENARIOS[name].at();
  env = { STANDINGS: new MemoryKV() };
  const fetchImpl = async () => new Response(page(sample.rows), { status: 200 });
  // Two hourly runs before the target moment.
  const lastHour = Math.floor(target / HOUR) * HOUR;
  for (const t of [lastHour - HOUR, lastHour]) await runSchedule(env, t, { fetchImpl, retryDelayMs: 0 });
  if (target >= LOCK) await runSchedule(env, LOCK + 3000, { fetchImpl, retryDelayMs: 0 });
  clockOffset = target - Date.now();
  window.STANDINGS_DEPS = { fetchImpl, retryDelayMs: 0 };
}

window.STANDINGS_NOW = () => Date.now() + clockOffset;
window.STANDINGS_FETCH = async (path) => {
  const url = new URL(path, "https://preview.local");
  const ctx = { waitUntil: () => {} };
  return route(new Request(url), url, env, ctx, window.STANDINGS_NOW(), window.STANDINGS_DEPS);
};

window.STANDINGS_PREVIEW = { scenarios: SCENARIOS, setup };
