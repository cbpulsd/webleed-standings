// Test-preview only: runs the real backend in the browser against sample times,
// with a simulated clock, so the page can be reviewed without touching anything live.
import { route } from "../src/index.js";
import { runSchedule } from "../src/sync.js";
import { RACES, TEAMS, TRACKS } from "../src/config.js";
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
  race: { label: "Race day example", at: () => LOCK + 15 * HOUR, view: "races", note: "Made-up lineups and results, to show how the Races tab fills in." },
};

// Made-up race day: every tier has a lineup; tiers 1-3 finished all races, tier 4 is mid-way.
function sampleRaces() {
  let seed = 7;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const shuffle = (a) => { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
  const lineup = {};
  for (const t of TEAMS) {
    const five = [t.captain, ...t.pilots];
    lineup[t.sponsor] = { tiers: { 1: five[0], 2: five[1], 3: five[2], 4: five[4] }, sitting: five[3] };
  }
  const results = {};
  for (let tier = 1; tier <= RACES.tiers; tier++) {
    results[tier] = {};
    const run = tier === 4 ? 5 : RACES.racesPerTier;
    for (let race = 1; race <= run; race++) {
      results[tier][race] = Object.fromEntries(shuffle(TEAMS.map((t) => t.sponsor)).map((s, i) => [s, i + 1]));
    }
  }
  return { updatedAt: new Date(LOCK + 15 * HOUR).toISOString(), lineup, results };
}

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
  if (name === "race") await env.STANDINGS.put("races:1", JSON.stringify(sampleRaces()));
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
