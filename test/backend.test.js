// Run with: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseLeaderboard } from "../src/leaderboard.js";
import { computeStandings } from "../src/standings.js";
import { lockTrack, runSchedule, syncTrack } from "../src/sync.js";
import { route } from "../src/index.js";
import { ALIASES, TEAMS, TRACKS } from "../src/config.js";

const T1 = TRACKS[0];
const LOCK = Date.parse(T1.locksAt);
const HOUR = 3_600_000;

class MemoryKV {
  constructor() { this.data = new Map(); this.writes = 0; }
  async get(k, type) { const v = this.data.get(k); return v == null ? null : type === "json" ? JSON.parse(v) : v; }
  async put(k, v) { this.writes++; this.data.set(k, v); }
}

const pageWith = (rows) =>
  `<table><tr><th>#</th><th>Time</th><th>Player</th></tr>` +
  rows.map(([rank, time, name]) => `<tr class="x">\n<td class="p-2">${rank}</td>\n<td class="p-2">${time}</td>\n<td class="p-2">\n  ${name}\n</td><td>Canada</td></tr>`).join("") +
  `</table>`;

// A fake Velocidrone whose board can change between calls.
function fakeSite(rows) {
  const site = { rows, calls: 0, fail: false };
  site.fetch = async () => {
    site.calls++;
    if (site.fail) return new Response("down", { status: 503 });
    return new Response(pageWith(site.rows), { status: 200 });
  };
  return site;
}

const ctx = () => { const jobs = []; return { jobs, waitUntil: (p) => jobs.push(p) }; };
const get = (env, path, now, deps) => route(new Request("https://x.dev" + path), new URL("https://x.dev" + path), env, ctx(), now, deps).then((r) => r.json());

test("parser handles invisible marks, beta tags and m:ss times", () => {
  const rows = parseLeaderboard(pageWith([[1, "65.120", "neonfpv"], [2, "1:05.282", "Raimon Shaigne (Beta Tester)"], [3, "176.908", "xer ‎"], [4, "90.000", "Zip&lrm;"]]));
  assert.equal(rows.length, 4);
  assert.equal(rows[1].time, 65.282);
  assert.equal(rows[3].name, "Zip");
  const s = computeStandings(rows, TEAMS, ALIASES);
  const wrekd = s.teams.find((t) => t.sponsor === "WREKD");
  assert.equal(wrekd.pilots.find((p) => p.name === "xer").time, 176.908);
  assert.equal(s.teams.find((t) => t.sponsor === "EMAX USA").pilots.find((p) => p.captain).time, 65.282);
});

test("missing pilots count 999.99 and positions are 1..n", () => {
  const s = computeStandings([], TEAMS, ALIASES);
  assert.equal(s.teams.length, 10);
  assert.deepEqual(s.teams.map((t) => t.position), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.ok(s.teams.every((t) => Math.abs(t.total - 4999.95) < 1e-9));
});

test("hourly runs refresh, then lock exactly at the deadline, then never fetch again", async () => {
  const env = { STANDINGS: new MemoryKV() };
  const site = fakeSite([[1, "70.000", "TMAD"]]);
  const deps = { fetchImpl: site.fetch, retryDelayMs: 0 };

  let r = await runSchedule(env, LOCK - 2 * HOUR, deps);
  assert.equal(r[0].action, "refreshed");
  site.rows = [[1, "68.000", "TMAD"]];
  r = await runSchedule(env, LOCK - HOUR, deps);
  assert.equal(r[0].action, "refreshed");

  site.rows = [[1, "66.000", "TMAD"]]; // last time before the deadline
  r = await runSchedule(env, LOCK + 5_000, deps); // the timer fires a few seconds after the lock time
  assert.equal(r[0].action, "locked");
  assert.equal(r[0].record.lockMethod, "final-fetch");

  const callsAtLock = site.calls;
  site.rows = [[1, "60.000", "TMAD"]]; // posted after the deadline
  r = await runSchedule(env, LOCK + HOUR, deps);
  assert.equal(r[0].action, "skip-locked");
  assert.equal(site.calls, callsAtLock, "a locked track is never fetched");

  const body = await get(env, "/api/tracks/1", LOCK + 2 * HOUR, deps);
  assert.equal(body.track.status, "locked");
  const tmad = body.standings.teams.find((t) => t.sponsor === "Velocidrone").pilots.find((p) => p.captain);
  assert.equal(tmad.time, 66, "final standings keep the pre-deadline time");
  assert.equal(body.nextUpdateAt, null);

  const hist = await get(env, "/api/tracks/1/history", LOCK + 2 * HOUR, deps);
  assert.equal(hist.entries.length, 3);
  assert.equal(hist.entries.at(-1).final, true);
});

test("a late lock uses the last times saved before the deadline", async () => {
  const env = { STANDINGS: new MemoryKV() };
  const site = fakeSite([[1, "70.000", "TMAD"]]);
  const deps = { fetchImpl: site.fetch, retryDelayMs: 0 };
  await runSchedule(env, LOCK - HOUR, deps);
  site.rows = [[1, "50.000", "TMAD"]]; // posted after the deadline

  // Timer missed; the first visitor shows up 3 hours late.
  const body = await get(env, "/api/tracks/1", LOCK + 3 * HOUR, deps);
  assert.equal(body.track.status, "locked");
  assert.equal(body.lockMethod, "last-before-deadline");
  assert.equal(body.standings.teams.find((t) => t.sponsor === "Velocidrone").pilots.find((p) => p.captain).time, 70);
});

test("if the final fetch fails, the lock falls back to the last saved times", async () => {
  const env = { STANDINGS: new MemoryKV() };
  const site = fakeSite([[1, "70.000", "TMAD"]]);
  const deps = { fetchImpl: site.fetch, retryDelayMs: 0 };
  await runSchedule(env, LOCK - HOUR, deps);
  site.fail = true;
  const r = await runSchedule(env, LOCK, deps);
  assert.equal(r[0].action, "locked");
  assert.match(r[0].record.lockMethod, /final fetch failed/);
});

test("live track: roster fixes apply right away; stale data refreshes in the background", async () => {
  const env = { STANDINGS: new MemoryKV() };
  const site = fakeSite([[1, "70.000", "TMAD"]]);
  const deps = { fetchImpl: site.fetch, retryDelayMs: 0 };
  const now = LOCK - 30 * HOUR;

  const first = await get(env, "/api/tracks/1", now, deps); // nothing saved yet -> fetches once
  assert.equal(first.track.status, "live");
  assert.equal(site.calls, 1);
  assert.ok(first.nextUpdateAt);

  await get(env, "/api/tracks/1", now + 30 * 60_000, deps);
  assert.equal(site.calls, 1, "fresh data is served without fetching");

  const c = ctx();
  await route(new Request("https://x.dev/api/tracks/1"), new URL("https://x.dev/api/tracks/1"), env, c, now + 2 * HOUR, deps);
  await Promise.all(c.jobs);
  assert.equal(site.calls, 2, "stale data triggers one background refresh");
});

test("tabs list: track 1 live, tracks 2-6 upcoming", async () => {
  const env = { STANDINGS: new MemoryKV() };
  const body = await get(env, "/api/tracks", LOCK - HOUR, {});
  assert.deepEqual(body.tracks.map((t) => t.status), ["live", "upcoming", "upcoming", "upcoming", "upcoming", "upcoming"]);
  const up = await get(env, "/api/tracks/4", LOCK - HOUR, {});
  assert.equal(up.track.status, "upcoming");
  assert.equal(up.standings, null);
});

test("admin routes need the token", async () => {
  const env = { STANDINGS: new MemoryKV(), ADMIN_TOKEN: "s3cret" };
  const site = fakeSite([[1, "70.000", "TMAD"]]);
  const deps = { fetchImpl: site.fetch, retryDelayMs: 0 };
  const call = (auth) => route(new Request("https://x.dev/api/admin/tracks/1/refresh", { method: "POST", headers: auth ? { authorization: auth } : {} }), new URL("https://x.dev/api/admin/tracks/1/refresh"), env, ctx(), LOCK - HOUR, deps);
  assert.equal((await call()).status, 403);
  assert.equal((await call("Bearer nope")).status, 403);
  const ok = await call("Bearer s3cret");
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).action, "refreshed");
});

test("a week of hourly runs stays far under the free plan's 1,000 writes a day", async () => {
  const env = { STANDINGS: new MemoryKV() };
  const site = fakeSite([[1, "70.000", "TMAD"]]);
  for (let h = 24; h > 0; h--) await runSchedule(env, LOCK - h * HOUR, { fetchImpl: site.fetch, retryDelayMs: 0 });
  assert.equal(env.STANDINGS.writes, 48); // record + history, once an hour
});
