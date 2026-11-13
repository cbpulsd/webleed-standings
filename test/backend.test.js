// Run with: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseLeaderboard } from "../src/leaderboard.js";
import { computeStandings } from "../src/standings.js";
import { lockTrack, runSchedule, syncTrack } from "../src/sync.js";
import { route } from "../src/index.js";
import { ALIASES, TEAMS, TRACKS } from "../src/config.js";
import { decrypt, encrypt } from "../src/gameapi.js";
import { RaceRoom } from "../src/raceroom.js";
import { parseRaceTime, positionsFor } from "../src/races.js";
import { diffEvents } from "../src/standings.js";
import seed1 from "../src/seed/track1.js";

const T1 = TRACKS[0];
const LOCK = Date.parse(T1.locksAt);
const HOUR = 3_600_000;

class MemoryKV {
  constructor() { this.data = new Map(); this.writes = 0; }
  async get(k, type) { const v = this.data.get(k); return v == null ? null : type === "json" ? JSON.parse(v) : v; }
  async put(k, v) { this.writes++; this.data.set(k, v); }
}

// rows: [rank, time, name, model?]
const pageWith = (rows) =>
  `<table><tr><th>#</th><th>Time</th><th>Player</th></tr>` +
  rows.map(([rank, time, name, model = "Hummingbird RS"]) => `<tr class="x">\n<td class="p-2">${rank}</td>\n<td class="p-2">${time}</td>\n<td class="p-2">\n  ${name}\n</td><td>Canada</td><td>1000</td><td>${model}</td><td>02/11/2026</td></tr>`).join("") +
  `</table>`;

// A fake Velocidrone whose board can change between calls.
// site.game = true makes the game endpoint answer; otherwise it fails and the page is used.
function fakeSite(rows) {
  // byTrack counts every request per Velocidrone track id (page and game endpoint alike).
  const site = { rows, calls: 0, gameCalls: 0, byTrack: {}, fail: false, game: false };
  const count = (id) => { site.byTrack[id] = (site.byTrack[id] || 0) + 1; };
  site.fetch = async (url, init) => {
    if (String(url).includes("getLeaderBoard")) {
      site.gameCalls++;
      const body = decodeURIComponent(String(init?.body || "").replace(/^post_data=/, ""));
      count((await decrypt(body).catch(() => "")).match(/track_id=(\d+)/)?.[1]);
      if (site.fail || !site.game) return new Response("<html>nope</html>", { status: 419 });
      const tracktimes = site.rows.map(([, time, name, model = "Hummingbird RS"], i) => ({
        playername: name, lap_time: String(time), model_id: model === "Hummingbird RS" ? 121 : 48, user_id: 1000 + i, country: "US",
      }));
      return new Response(await encrypt(JSON.stringify({ success: true, tracktimes })), { status: 200 });
    }
    site.calls++;
    count(String(url).match(/\/leaderboard\/\d+\/(\d+)\//)?.[1]);
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

  let r = await runSchedule(env, LOCK - 2 * HOUR + 60_000, deps); // 10:00 PM: on the hour, so history too
  assert.equal(r[0].action, "refreshed");
  site.rows = [[1, "68.000", "TMAD"]];
  r = await runSchedule(env, LOCK - HOUR + 60_000, deps); // 11:00 PM
  assert.equal(r[0].action, "refreshed");

  site.rows = [[1, "66.000", "TMAD"]]; // last time before the deadline
  r = await runSchedule(env, LOCK + 5_000, deps); // the timer fires a few seconds after the lock time
  assert.equal(r[0].action, "locked");
  assert.equal(r[0].record.lockMethod, "final-fetch");

  const callsAtLock = site.byTrack["2207"];
  site.rows = [[1, "60.000", "TMAD"]]; // posted after the deadline
  r = await runSchedule(env, LOCK + HOUR, deps);
  assert.equal(r[0].action, "skip-locked");
  assert.equal(site.byTrack["2207"], callsAtLock, "a locked track is never fetched");
  assert.equal(r[1].action, "refreshed", "Track 2 opens once Track 1 has locked");

  const body = await get(env, "/api/tracks/1", LOCK + 2 * HOUR, deps);
  assert.equal(body.track.status, "locked");
  const tmad = body.standings.teams.find((t) => t.sponsor === "Velocidrone").pilots.find((p) => p.captain);
  assert.equal(tmad.time, 66, "final standings keep the pre-deadline time");
  assert.equal(body.nextUpdateAt, null);

  const hist = await get(env, "/api/tracks/1/history", LOCK + 2 * HOUR, deps);
  assert.equal(hist.entries.length, 3);
  assert.equal(hist.entries.at(-1).final, true);
});

test("after the deadline, visits never fetch; a missed lock run is covered from saved data", async () => {
  const env = { STANDINGS: new MemoryKV() };
  const site = fakeSite([[1, "70.000", "TMAD"]]);
  const deps = { fetchImpl: site.fetch, retryDelayMs: 0 };
  await runSchedule(env, LOCK - HOUR, deps);
  site.rows = [[1, "50.000", "TMAD"]]; // posted after the deadline
  const calls = site.calls;
  const gameCalls = site.gameCalls;

  // 2 minutes past the deadline, before the lock is saved: saved times, no fetch, not locked yet.
  const early = await get(env, "/api/tracks/1", LOCK + 2 * 60_000, deps);
  assert.equal(early.track.status, "locking");
  assert.equal(early.standings.teams.find((t) => t.sponsor === "Velocidrone").pilots.find((p) => p.captain).time, 70);
  assert.equal(site.calls, calls, "no fetch after the deadline from a visit");

  // The lock timer never ran; first visit 3 hours later locks from saved data.
  const body = await get(env, "/api/tracks/1", LOCK + 3 * HOUR, deps);
  assert.equal(body.track.status, "locked");
  assert.equal(body.lockMethod, "last-before-deadline");
  assert.equal(body.standings.teams.find((t) => t.sponsor === "Velocidrone").pilots.find((p) => p.captain).time, 70);
  assert.equal(site.calls, calls, "still no fetch");
  assert.equal(site.gameCalls, gameCalls, "not even the game endpoint");
});

test("a lock run more than 60 seconds late doesn't fetch", async () => {
  const env = { STANDINGS: new MemoryKV() };
  const site = fakeSite([[1, "70.000", "TMAD"]]);
  const deps = { fetchImpl: site.fetch, retryDelayMs: 0 };
  await runSchedule(env, LOCK - 9 * 60_000, deps); // the 11:50 PM refresh
  site.rows = [[1, "50.000", "TMAD"]];
  const calls = site.byTrack["2207"];
  const r = await runSchedule(env, LOCK + 61_000, deps); // e.g. the midnight hourly run
  assert.equal(r[0].action, "locked");
  assert.equal(r[0].record.lockMethod, "last-before-deadline");
  assert.equal(site.byTrack["2207"], calls);
});

test("a refresh that finishes after the lock can't overwrite it", async () => {
  const env = { STANDINGS: new MemoryKV() };
  const site = fakeSite([[1, "70.000", "TMAD"]]);
  await runSchedule(env, LOCK - HOUR, { fetchImpl: site.fetch, retryDelayMs: 0 });
  // A slow refresh starts before the deadline; the lock lands while it's fetching.
  let release;
  const gate = new Promise((res) => { release = res; });
  const slowFetch = async (...a) => { await gate; return site.fetch(...a); };
  const pending = syncTrack(env, T1, LOCK - 30_000, { force: true, fetchImpl: slowFetch });
  await new Promise((r) => setTimeout(r, 0));
  await runSchedule(env, LOCK + 1000, { fetchImpl: site.fetch, retryDelayMs: 0 });
  release();
  const result = await pending;
  assert.equal(result.action, "skip-locked");
  assert.equal((await env.STANDINGS.get("track:1", "json")).status, "locked");
});

test("visits don't start a refresh in the last 5 minutes before the lock", async () => {
  const env = { STANDINGS: new MemoryKV() };
  const site = fakeSite([[1, "70.000", "TMAD"]]);
  const deps = { fetchImpl: site.fetch, retryDelayMs: 0 };
  await runSchedule(env, LOCK - 2 * HOUR, deps);
  const c = ctx();
  await route(new Request("https://x.dev/api/tracks/1"), new URL("https://x.dev/api/tracks/1"), env, c, LOCK - 2 * 60_000, deps);
  assert.equal(c.jobs.length, 0);
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

  await get(env, "/api/tracks/1", now + 5 * 60_000, deps);
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

test("a day of 5-minute refreshes stays well under the free plan's 1,000 writes a day", async () => {
  const env = { STANDINGS: new MemoryKV() };
  const site = fakeSite([[1, "70.000", "TMAD"]]);
  const dayStart = LOCK - 29 * HOUR + 60_000; // midnight UTC the day before the lock
  for (let m = 0; m < 24 * 60; m += 5) await runSchedule(env, dayStart + m * 60_000, { fetchImpl: site.fetch, retryDelayMs: 0 });
  assert.equal(site.calls, 288, "288 refreshes");
  assert.equal(env.STANDINGS.writes, 288 + 24, "record every 5 minutes, history once an hour");
  assert.equal((await env.STANDINGS.get("history:1", "json")).length, 24);
});

test("the page is told the next refresh is within 5 minutes, and never past the lock", async () => {
  const env = { STANDINGS: new MemoryKV() };
  const site = fakeSite([[1, "70.000", "TMAD"]]);
  const t = LOCK - 3 * HOUR + 60_000 + 7 * 60_000; // 9:07 PM
  await runSchedule(env, t - 2 * 60_000, { fetchImpl: site.fetch, retryDelayMs: 0 });
  const body = await get(env, "/api/tracks/1", t, {});
  assert.equal(Date.parse(body.nextUpdateAt) - t, 3 * 60_000, "9:10 PM");
  const late = await get(env, "/api/tracks/1", LOCK - 2 * 60_000, {}); // 11:57 PM
  assert.equal(body.track.locksAt, late.track.locksAt);
  assert.equal(Date.parse(late.nextUpdateAt), LOCK, "11:59 PM, not midnight");
});

test("old page's /data route still answers from saved times", async () => {
  const env = { STANDINGS: new MemoryKV() };
  const r0 = await route(new Request("https://x.dev/data"), new URL("https://x.dev/data"), env, ctx(), LOCK - HOUR, {});
  assert.equal(r0.status, 503);
  const site = fakeSite([[1, "70.000", "TMAD"]]);
  await runSchedule(env, LOCK - HOUR, { fetchImpl: site.fetch, retryDelayMs: 0 });
  const r = await route(new Request("https://x.dev/data"), new URL("https://x.dev/data"), env, ctx(), LOCK - HOUR, {});
  const body = await r.json();
  assert.equal(body.rows[0].name, "TMAD");
  assert.ok(body.fetchedAt);
});

test("timers use cron syntax Cloudflare accepts and land on each lock time", async () => {
  const { readFileSync } = await import("node:fs");
  const cfg = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8").replace(/^\s*\/\/.*$/gm, "");
  const crons = JSON.parse(cfg).triggers.crons;
  const DAYS = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
  const parsed = crons.map((c) => {
    const f = c.split(/\s+/);
    assert.equal(f.length, 5, `${c}: five fields`);
    // Cloudflare weekdays: 1-7 (Sunday = 1) or names; 0 is rejected.
    for (const part of f[4].split(/[,-]/)) {
      if (part === "*" || part === "?") continue;
      assert.ok(DAYS.includes(part.toUpperCase().replace(/L$|#\d$/, "")) || /^[1-7]$/.test(part), `${c}: weekday "${part}" isn't valid on Cloudflare`);
    }
    return f;
  });
  const fires = (f, t) => {
    const d = new Date(t);
    const ok = (field, v) => field === "*" || field.split(",").some((x) => +x === v);
    const dow = f[4] === "*" || f[4].split(",").some((x) => (DAYS.indexOf(x.toUpperCase()) >= 0 ? DAYS.indexOf(x.toUpperCase()) : +x - 1) === d.getUTCDay());
    return ok(f[0], d.getUTCMinutes()) && ok(f[1], d.getUTCHours()) && dow;
  };
  for (const t of TRACKS.filter((x) => x.locksAt)) {
    assert.ok(parsed.some((f) => fires(f, Date.parse(t.locksAt))), `no timer fires at ${t.name}'s lock time ${t.locksAt}`);
  }
});


test("game endpoint is used first; times carry pilot IDs and models", async () => {
  const env = { STANDINGS: new MemoryKV() };
  const site = fakeSite([[1, "70.000", "TMAD"], [2, "75.000", "xer \u200e"]]);
  site.game = true;
  const r = await runSchedule(env, LOCK - HOUR, { fetchImpl: site.fetch, retryDelayMs: 0 });
  assert.equal(r[0].record.source, "game");
  assert.equal(site.calls, 0, "page not loaded when the game endpoint works");
  assert.equal(r[0].record.rows[0].userId, 1055, "game IDs are 55 low; stored corrected");
  assert.equal(r[0].record.rows[0].model, "Hummingbird RS");
  const body = await get(env, "/api/tracks/1", LOCK - HOUR + 60_000, {});
  assert.equal(body.source, "game");
  assert.equal(body.standings.teams.find((t) => t.sponsor === "WREKD").pilots.find((p) => p.name === "xer").time, 75);
});

test("if the game endpoint fails, the page is read instead and the reason is kept", async () => {
  const env = { STANDINGS: new MemoryKV() };
  const site = fakeSite([[1, "70.000", "TMAD"]]);
  const r = await runSchedule(env, LOCK - HOUR, { fetchImpl: site.fetch, retryDelayMs: 0 });
  assert.equal(r[0].record.source, "page");
  assert.match(r[0].record.sourceError, /419/);
  assert.equal(r[0].record.rows[0].model, "Hummingbird RS");
});

test("only times on the track's required quad count", async () => {
  for (const game of [true, false]) {
    const env = { STANDINGS: new MemoryKV() };
    const site = fakeSite([[1, "60.000", "TMAD", "Tiny Hawk"], [2, "70.000", "BenDaOctopus"]]);
    site.game = game;
    await runSchedule(env, LOCK - HOUR, { fetchImpl: site.fetch, retryDelayMs: 0 });
    const body = await get(env, "/api/tracks/1", LOCK - HOUR + 60_000, {});
    const tmad = body.standings.teams.find((t) => t.sponsor === "Velocidrone").pilots.find((p) => p.captain);
    assert.equal(tmad.posted, false, `Tiny Hawk time excluded (${game ? "game" : "page"})`);
    assert.equal(tmad.time, 999.99);
    assert.equal(body.standings.teams.find((t) => t.sponsor === "RadioMaster").pilots.find((p) => p.captain).time, 70);
    assert.equal(body.quad, "Hummingbird RS");
  }
});

test("times saved before models were collected still count", async () => {
  const s = computeStandings([{ rank: 1, time: 70, name: "TMAD" }], TEAMS, ALIASES, TRACKS[0].quad);
  assert.equal(s.teams.find((t) => t.sponsor === "Velocidrone").pilots.find((p) => p.captain).time, 70);
});

test("source check link reports the game endpoint without saving anything", async () => {
  const env = { STANDINGS: new MemoryKV() };
  const site = fakeSite([[1, "70.000", "TMAD"], [2, "71.000", "Senko", "Tiny Hawk"]]);
  site.game = true;
  const ok = await get(env, "/api/health/source/1", LOCK - HOUR, { fetchImpl: site.fetch });
  assert.equal(ok.ok, true);
  assert.equal(ok.count, 2);
  assert.equal(ok.withUserIds, 2);
  assert.equal(ok.rosterPosted, 1, "Senko's Tiny Hawk time doesn't count");
  assert.equal(ok.rosterMissing.length, 49);
  assert.equal(env.STANDINGS.writes, 0);
  site.game = false;
  const bad = await get(env, "/api/health/source/1", LOCK - HOUR, { fetchImpl: site.fetch });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /419/);
});


test("standings record each pilot's Velocidrone name, pilot ID and model ID", async () => {
  const env = { STANDINGS: new MemoryKV() };
  const site = fakeSite([[1, "70.000", "TMAD"], [2, "75.000", "xer \u200e"]]);
  site.game = true;
  await runSchedule(env, LOCK - HOUR, { fetchImpl: site.fetch, retryDelayMs: 0 });
  const body = await get(env, "/api/tracks/1", LOCK - HOUR + 60_000, {});
  const xer = body.standings.teams.find((t) => t.sponsor === "WREKD").pilots.find((p) => p.name === "xer");
  assert.equal(xer.userId, 1056);
  assert.equal(xer.modelId, 121);
  assert.equal(xer.model, "Hummingbird RS");
  assert.equal(xer.velocidroneName, "xer \u200e");
  // ...and they're kept in the frozen copy at the lock, and in the hourly history.
  await runSchedule(env, LOCK + 1000, { fetchImpl: site.fetch, retryDelayMs: 0 });
  const locked = await env.STANDINGS.get("track:1", "json");
  assert.equal(locked.standings.teams.find((t) => t.sponsor === "WREKD").pilots.find((p) => p.name === "xer").userId, 1056);
  const hist = await env.STANDINGS.get("history:1", "json");
  assert.equal(hist.at(-1).ids.xer, 1056);
});

test("check link can inspect another Velocidrone track and one pilot's name match", async () => {
  const env = { STANDINGS: new MemoryKV() };
  const site = fakeSite([[1, "70.000", "TMAD"], [2, "176.908", "xer \u200e"]]);
  site.game = true;
  let asked = null;
  const spy = async (url, init) => { if (String(url).includes("getLeaderBoard")) asked = init.body; return site.fetch(url, init); };
  const r = await get(env, "/api/health/source/1?velocidroneTrack=2174&pilot=xer", LOCK - HOUR, { fetchImpl: spy });
  assert.equal(r.velocidroneTrack, "2174");
  assert.ok(asked, "game endpoint called");
  assert.equal(r.pilot.velocidroneRows[0].name, "xer \u200e");
  assert.deepEqual(r.pilot.velocidroneRows[0].nameCodes, ["78", "65", "72", "20", "200e"]);
  assert.equal(r.pilot.inStandings.posted, true);
  assert.equal(r.pilot.inStandings.time, 176.908);
});


test("overall table lists every team and week, with empty points for now", async () => {
  const env = { STANDINGS: new MemoryKV() };
  const body = await get(env, "/api/overall", LOCK - HOUR, {});
  assert.equal(body.weeks.length, 6);
  assert.deepEqual(body.weeks.map((w) => w.label), ["Week 1", "Week 2", "Week 3", "Week 4", "Week 5", "Week 6"]);
  assert.equal(body.teams.length, 10);
  assert.deepEqual(body.teams.map((t) => t.sponsor), TEAMS.map((t) => t.sponsor), "draft order until points exist");
  assert.ok(body.teams.every((t) => t.total === null && t.position === null));
  assert.deepEqual(body.teams[0].weeks[1], { smash: null, race: null, raceBonus: null });
});

test("overall table ranks by total once points are saved", async () => {
  const env = { STANDINGS: new MemoryKV() };
  await env.STANDINGS.put("overall", JSON.stringify({ updatedAt: "2026-11-08T05:00:00Z", points: {
    WREKD: { 1: { smash: 10, race: 8 } }, "EMAX USA": { 1: { smash: 6, race: "x" } },
  } }));
  const body = await get(env, "/api/overall", LOCK + HOUR, {});
  assert.equal(body.teams[0].sponsor, "WREKD");
  assert.equal(body.teams[0].total, 18);
  assert.equal(body.teams[0].position, 1);
  assert.equal(body.teams[1].sponsor, "EMAX USA");
  assert.deepEqual(body.teams[1].weeks[1], { smash: 6, race: null, raceBonus: null }, "bad values are ignored");
  assert.equal(body.teams[2].position, null);
});


test("races: 4 tiers x 8 races per team, blank until race day", async () => {
  const env = { STANDINGS: new MemoryKV() };
  const body = await get(env, "/api/tracks/1/races", LOCK - HOUR, {});
  assert.equal(body.raceDay, "2026-11-08");
  assert.equal(body.tierResults.length, 4);
  assert.equal(body.racesPerTier, 8);
  assert.deepEqual(body.points, [10, 9, 8, 7, 6, 5, 4, 3, 2, 1]);
  for (const tier of body.tierResults) {
    assert.equal(tier.entries.length, 10);
    assert.equal(tier.racesRun, 0);
    assert.ok(tier.entries.every((e) => e.pilot === null && e.total === null && e.points.length === 8 && e.points.every((p) => p === null)));
  }
  assert.deepEqual(body.teams.map((t) => t.sponsor), TEAMS.map((t) => t.sponsor));
  assert.ok(body.teams.every((t) => t.total === null && t.sitting === null && t.place === null));
});

const PW = "webleedadmin";
const req = (env, method, path, headers, body, now = LOCK + HOUR) =>
  route(new Request("https://x.dev" + path, { method, headers: { "content-type": "application/json", ...headers }, body: body ? JSON.stringify(body) : undefined }),
    new URL("https://x.dev" + path), env, ctx(), now, {});
const login = async (env, pw = PW, now = LOCK + HOUR) => (await (await req(env, "POST", "/api/admin/login", { "x-admin-password": pw }, null, now)).json()).session;
// Signed-in call: signs in with the password once, then sends the session pass.
const sessions = new WeakMap();
const call = async (env, method, path, body, now = LOCK + HOUR) => {
  if (!sessions.has(env)) sessions.set(env, await login(env));
  return req(env, method, path, { "x-admin-session": sessions.get(env) }, body, now);
};

// The real RaceRoom class behind a stand-in for Cloudflare's Durable Object plumbing.
function fakeRaceRooms() {
  const rooms = new Map();
  const ns = {
    rooms,
    idFromName: (name) => name,
    get(id) {
      if (!rooms.has(id)) {
        const data = new Map();
        const sockets = [];
        const state = {
          storage: { get: async (k) => (data.has(k) ? structuredClone(data.get(k)) : undefined), put: async (k, v) => void data.set(k, structuredClone(v)) },
          acceptWebSocket: (ws) => sockets.push(ws),
          getWebSockets: () => sockets,
        };
        const room = new RaceRoom(state, {});
        rooms.set(id, { room, sockets, fetch: (input, init) => room.fetch(input instanceof Request ? input : new Request(input, init)) });
      }
      return rooms.get(id);
    },
  };
  return ns;
}
const STORES = [
  ["Durable Object", () => ({ STANDINGS: new MemoryKV(), RACES_DO: fakeRaceRooms() })],
  ["KV fallback", () => ({ STANDINGS: new MemoryKV() })],
];

test("race times rank into positions: fastest 1st, ties share, DNF 0, blanks ignored", () => {
  assert.deepEqual(positionsFor([45.1, 44.9, "dnf", null, 45.1, 50]), [2, 1, 0, null, 2, 4]);
  assert.equal(parseRaceTime("45.123"), 45.123);
  assert.equal(parseRaceTime("1:05.4"), 65.4);
  assert.equal(parseRaceTime(" DNF "), "dnf");
  assert.equal(parseRaceTime(""), null);
  assert.equal(parseRaceTime("fast"), undefined);
  assert.equal(parseRaceTime("-3"), undefined);
});

test("race director: password signs in once; the 24-hour pass is checked on every request", async () => {
  const env = { STANDINGS: new MemoryKV() };
  const wrong = await req(env, "POST", "/api/admin/login", { "x-admin-password": "nope" });
  assert.equal(wrong.status, 403);
  assert.equal((await req(env, "POST", "/api/admin/login", {})).status, 403);

  const ok = await (await req(env, "POST", "/api/admin/login", { "x-admin-password": PW })).json();
  assert.match(ok.session, /^\d+\.[0-9a-f]{64}$/);
  assert.equal(Date.parse(ok.expiresAt) - (LOCK + HOUR), 24 * HOUR);
  assert.ok(!ok.session.includes(PW));

  const edit = (session, now) => req(env, "PATCH", "/api/admin/tracks/1/races/lineup", session ? { "x-admin-session": session } : {}, { sitting: { WREKD: "xer" } }, now);
  assert.equal((await edit(ok.session)).status, 200, "the pass works");
  assert.equal((await edit(ok.session, LOCK + HOUR + 24 * HOUR - 1000)).status, 200, "still good just before 24 hours");
  assert.equal((await edit(ok.session, LOCK + HOUR + 24 * HOUR + 1)).status, 403, "expired after 24 hours");
  const writes = env.STANDINGS.writes;
  assert.equal((await edit(null)).status, 403);
  assert.equal((await req(env, "PATCH", "/api/admin/tracks/1/races/lineup", { "x-admin-password": PW }, { sitting: { WREKD: "xer" } })).status, 403, "edits need the pass, not the password");
  const [exp, sig] = ok.session.split(".");
  assert.equal((await edit(`${Number(exp) + HOUR}.${sig}`)).status, 403, "a longer expiry can't be forged");
  assert.equal((await edit(`${exp}.${"0".repeat(64)}`)).status, 403);
  assert.equal((await req(env, "GET", "/api/admin/tracks/1/races", {})).status, 403);
  assert.equal(env.STANDINGS.writes, writes);

  // A Worker ADMIN_PASSWORD secret replaces the password and signs old passes out.
  const env2 = { STANDINGS: new MemoryKV(), ADMIN_PASSWORD: "other" };
  assert.equal((await req(env2, "POST", "/api/admin/login", { "x-admin-password": PW })).status, 403);
  assert.equal((await req(env2, "PATCH", "/api/admin/tracks/1/races/lineup", { "x-admin-session": ok.session }, { sitting: {} })).status, 403);
  const s2 = await login(env2, "other");
  assert.equal((await req(env2, "PATCH", "/api/admin/tracks/1/races/lineup", { "x-admin-session": s2 }, { sitting: {} })).status, 200);
});

for (const [label, makeEnv] of STORES) {
  test(`race director (${label}): picking who sits slots the other four into tiers by Smash order`, async () => {
    const env = makeEnv();
    const site = fakeSite([[1, "70.000", "Britchot"], [2, "72.000", "Blastaa"], [3, "75.000", "SpookyV9"], [4, "80.000", "Mgescapades"]]);
    await runSchedule(env, LOCK - HOUR, { fetchImpl: site.fetch, retryDelayMs: 0 });
    await runSchedule(env, LOCK + 1000, { fetchImpl: site.fetch, retryDelayMs: 0 }); // locked, like on race day

    const res = await call(env, "PATCH", "/api/admin/tracks/1/races/lineup", { sitting: { WREKD: "Blastaa" } });
    assert.equal(res.status, 200);
    const body = await res.json();
    const wrekd = (tier) => body.tierResults[tier - 1].entries.find((e) => e.sponsor === "WREKD").pilot;
    assert.deepEqual([1, 2, 3, 4].map(wrekd), ["Britchot", "SpookyV9", "Mgescapades", "xer"], "xer has no time, so he's last");
    assert.equal(body.teams.find((t) => t.sponsor === "WREKD").sitting, "Blastaa");
    assert.equal(body.tierResults[0].entries.find((e) => e.sponsor === "EMAX USA").pilot, null, "no sit-out picked yet");

    const pub = await get(env, "/api/tracks/1/races", LOCK + HOUR, {});
    assert.equal(pub.tierResults[3].entries.find((e) => e.sponsor === "WREKD").pilot, "xer");

    assert.equal((await call(env, "PATCH", "/api/admin/tracks/1/races/lineup", { sitting: { WREKD: "TMAD" } })).status, 400);
    const cleared = await (await call(env, "PATCH", "/api/admin/tracks/1/races/lineup", { sitting: { WREKD: null } })).json();
    assert.equal(cleared.tierResults[0].entries.find((e) => e.sponsor === "WREKD").pilot, null);
  });

  test(`race director (${label}): times become positions and points; edits merge; bad input saves nothing`, async () => {
    const env = makeEnv();
    await call(env, "PATCH", "/api/admin/tracks/1/races/tiers/1", { results: { 1: { WREKD: "44.100" } } });
    await call(env, "PATCH", "/api/admin/tracks/1/races/tiers/1", { results: { 1: { "EMAX USA": "44.900" } } }); // a second director, same race
    await call(env, "PATCH", "/api/admin/tracks/1/races/tiers/1", { results: { 2: { WREKD: "46.000", "EMAX USA": "45.000" } } });
    await call(env, "PATCH", "/api/admin/tracks/1/races/tiers/2", { results: { 1: { WREKD: "DNF" } } });
    const body = await get(env, "/api/tracks/1/races", LOCK + HOUR, {});
    const t1 = body.tierResults[0];
    assert.equal(t1.racesRun, 2);
    const emax = t1.entries.find((e) => e.sponsor === "EMAX USA"), wrekd = t1.entries.find((e) => e.sponsor === "WREKD");
    assert.deepEqual(wrekd.times.slice(0, 2), [44.1, 46]);
    assert.deepEqual(wrekd.positions.slice(0, 2), [1, 2]);
    assert.deepEqual(wrekd.points.slice(0, 3), [10, 9, null]);
    assert.equal(emax.total, 19);
    assert.equal(wrekd.total, 19);
    const dnf = body.tierResults[1].entries.find((e) => e.sponsor === "WREKD");
    assert.deepEqual([dnf.times[0], dnf.positions[0], dnf.points[0]], ["dnf", 0, 0]);
    assert.equal(body.teams.find((t) => t.sponsor === "WREKD").byTier[1], 19);

    await call(env, "PATCH", "/api/admin/tracks/1/races/tiers/1", { results: { 2: { WREKD: "" } } });
    const after = await get(env, "/api/tracks/1/races", LOCK + HOUR, {});
    const e2 = after.tierResults[0].entries;
    assert.equal(e2.find((e) => e.sponsor === "WREKD").total, 10);
    assert.equal(e2.find((e) => e.sponsor === "EMAX USA").points[1], 10, "EMAX is now alone in race 2");

    const before = JSON.stringify((await get(env, "/api/tracks/1/races", LOCK + HOUR, {})).tierResults);
    for (const bad of [{ 9: { WREKD: "40.1" } }, { 1: { Nobody: "40.1" } }, { 1: { WREKD: "fast" } }, { 1: { WREKD: -2 } }]) {
      assert.equal((await call(env, "PATCH", "/api/admin/tracks/1/races/tiers/1", { results: bad })).status, 400, JSON.stringify(bad));
    }
    assert.equal((await call(env, "PATCH", "/api/admin/tracks/1/races/tiers/5", { results: {} })).status, 404);
    assert.equal(JSON.stringify((await get(env, "/api/tracks/1/races", LOCK + HOUR, {})).tierResults), before);
  });

  test(`race director (${label}): shows who each team sat out in other weeks`, async () => {
    const env = makeEnv();
    await call(env, "PATCH", "/api/admin/tracks/2/races/lineup", { sitting: { WREKD: "xer" } });
    const body = await (await call(env, "GET", "/api/admin/tracks/1/races")).json();
    assert.deepEqual(body.satBefore, { WREKD: { xer: [2] } });
  });
}

test("every edit is pushed to open pages right away", async () => {
  const env = { STANDINGS: new MemoryKV(), RACES_DO: fakeRaceRooms() };
  const got = [];
  const viewer = { send: (m) => got.push(JSON.parse(m)) };
  env.RACES_DO.get("track-1").sockets.push(viewer);
  await call(env, "PATCH", "/api/admin/tracks/1/races/tiers/3", { results: { 4: { WREKD: "50.5" } } });
  await call(env, "PATCH", "/api/admin/tracks/1/races/lineup", { sitting: { WREKD: "xer" } });
  assert.deepEqual(got.map((m) => [m.type, m.kind, m.tier, m.version]), [["update", "tier", 3, 1], ["update", "lineup", null, 2]]);
  const pub = await get(env, "/api/tracks/1/races", LOCK + HOUR, {});
  assert.equal(pub.live, true);
  assert.equal(pub.version, 2);
  // a rejected edit isn't announced
  await call(env, "PATCH", "/api/admin/tracks/1/races/tiers/3", { results: { 4: { WREKD: "nope" } } });
  assert.equal(got.length, 2);
  // without the Durable Object, the live link says so instead of hanging
  const kv = await route(new Request("https://x.dev/api/tracks/1/races/live"), new URL("https://x.dev/api/tracks/1/races/live"), { STANDINGS: new MemoryKV() }, ctx(), LOCK, {});
  assert.equal(kv.status, 501);
});


test("a lock run up to 60 s late still fetches; later, it uses the 11:58 PM refresh", async () => {
  for (const [lateBy, expectTime, method] of [[44_000, 60, "final-fetch"], [90_000, 65, "last-before-deadline"]]) {
    const env = { STANDINGS: new MemoryKV() };
    const site = fakeSite([[1, "70.000", "TMAD"]]);
    await runSchedule(env, LOCK - 4 * 60_000, { fetchImpl: site.fetch, retryDelayMs: 0 }); // 11:55
    site.rows = [[1, "65.000", "TMAD"]];
    await runSchedule(env, LOCK - 60_000 + 30_000, { fetchImpl: site.fetch, retryDelayMs: 0 }); // 11:58 run, 30 s late
    site.rows = [[1, "60.000", "TMAD"]]; // posted around the deadline
    const r = await runSchedule(env, LOCK + lateBy, { fetchImpl: site.fetch, retryDelayMs: 0 });
    assert.equal(r[0].action, "locked");
    assert.equal(r[0].record.lockMethod, method);
    const tmad = r[0].record.standings.teams.find((t) => t.sponsor === "Velocidrone").pilots.find((p) => p.captain);
    assert.equal(tmad.time, expectTime);
  }
});


test("each refresh records first times and new personal bests on the required quad", async () => {
  const env = { STANDINGS: new MemoryKV() };
  const site = fakeSite([[1, "70.000", "TMAD"], [2, "80.000", "Senko"]]);
  const deps = { fetchImpl: site.fetch, retryDelayMs: 0 };
  await runSchedule(env, LOCK - 3 * HOUR, deps); // first save: nothing to compare with yet
  site.rows = [[1, "68.500", "TMAD"], [2, "80.000", "Senko"], [3, "90.000", "xer"], [4, "50.000", "Blastaa", "Tiny Hawk"]];
  await runSchedule(env, LOCK - 3 * HOUR + 5 * 60_000, deps);
  await runSchedule(env, LOCK - 3 * HOUR + 10 * 60_000, deps); // no change: nothing written
  const ev = await env.STANDINGS.get("events:1", "json");
  assert.deepEqual(ev.map((e) => [e.name, e.kind, e.prev, e.time]), [["TMAD", "pb", 70, 68.5], ["xer", "debut", null, 90]], "Tiny Hawk time ignored");
  site.rows = [[1, "68.000", "TMAD"], [2, "80.000", "Senko"], [3, "90.000", "xer"]];
  await runSchedule(env, LOCK + 10_000, deps); // the lock's final fetch counts too
  assert.equal((await env.STANDINGS.get("events:1", "json")).at(-1).time, 68);
  assert.deepEqual(diffEvents([{ name: "A", time: 50, rank: 1 }], [{ name: "A", time: 50.0004, rank: 1 }], "t"), [], "no event without a faster time");
});

test("stats: team totals over time, new bests, biggest grinders", async () => {
  const env = { STANDINGS: new MemoryKV(), STATS_SEEDS: {} };
  const site = fakeSite([]);
  const five = (team) => [team.captain, ...team.pilots];
  const [emax, wrekd] = [TEAMS[0], TEAMS[7]];
  const board = (emaxT, wrekdT) => [...five(emax).map((n, i) => [i + 1, (emaxT + i).toFixed(3), n]), ...five(wrekd).map((n, i) => [i + 10, (wrekdT + i).toFixed(3), n])];
  site.rows = board(80, 70);
  await runSchedule(env, LOCK - 3 * HOUR + 60_000, { fetchImpl: site.fetch, retryDelayMs: 0 }); // 9 PM
  site.rows = board(60, 70);
  await runSchedule(env, LOCK - 2 * HOUR + 60_000, { fetchImpl: site.fetch, retryDelayMs: 0 }); // 10 PM
  const st = await get(env, "/api/tracks/1/stats", LOCK - HOUR, {});
  const e = st.teams.find((t) => t.sponsor === "EMAX USA");
  assert.equal(st.teams.length, TEAMS.length, "every team has a line");
  assert.deepEqual(e.series.map((p) => p[1]), [410, 310]);
  assert.equal(e.finalTotal, 310);
  assert.equal(st.summary.newBests, 5);
  assert.equal(st.grinders.length, 5);
  assert.equal(st.grinders[0].team, "EMAX USA");
  assert.equal(st.grinders[0].pbs, 1);
  assert.equal(st.activity.length, 5, "the first save has nothing to compare with, so only the 10 PM bests count");
});

test("seed merge: Discord posts plus the site's own records, each new best once, one first time per pilot", async () => {
  const ev = (at, name, kind, prev, time) => ({ at, name, kind, prev, time, prevRank: null, rank: 1, userId: null });
  const env = {
    STANDINGS: new MemoryKV(),
    STATS_SEEDS: { 1: { history: [], events: [ev("2026-11-08T02:00:00.000Z", "-Crimson-", "debut", null, 150), ev("2026-11-08T02:30:00.000Z", "-Crimson-", "pb", 150, 140), ev("2026-11-08T03:00:00.000Z", "-Crimson-", "pb", 140, 130)] } },
  };
  await env.STANDINGS.put("events:1", JSON.stringify([
    ev("2026-11-08T07:00:00.000Z", "_-Crimson-_", "debut", null, 130), // when the site first saw them: dropped
    ev("2026-11-08T09:00:00.000Z", "_-Crimson-_", "pb", 130, 125), // new: kept
    ev("2026-11-08T03:05:00.000Z", "_-Crimson-_", "pb", 140, 130.0), // the bot already has it: counted once
  ]));
  const st = await get(env, "/api/tracks/1/stats", LOCK - HOUR, {});
  const g = st.grinders.find((p) => p.pilot === "_-Crimson-_");
  assert.equal(g.pbs, 3);
  assert.deepEqual(st.activity.map((a) => a[1]), [0, 1, 1, 1], "one first time plus three new bests");
});

test("stats include the repo-kept Track 1 data from before our history began, without double counting", async () => {
  const env = { STANDINGS: new MemoryKV() };
  const seedEvent = seed1.events.find((e) => e.kind === "pb");
  await env.STANDINGS.put("history:1", JSON.stringify([{ at: "2026-11-03T22:22:29.151Z", teams: [["WREKD", 400, 5]], pilots: {} }]));
  await env.STANDINGS.put("events:1", JSON.stringify([seedEvent])); // same new best recorded here too
  const st = await get(env, "/api/tracks/1/stats", LOCK + HOUR, {});
  assert.equal(st.from, "2026-11-02T00:00:00.000Z");
  assert.equal(st.teams.find((t) => t.sponsor === "WREKD").series.length, seed1.history.length + 1);
  assert.equal(st.summary.newBests, 549, "Discord posts plus the hourly saves");
  assert.ok(seed1.history.every((h) => h.at < "2026-11-03T22:22:29.151Z"));
  assert.equal((await route(new Request("https://x/api/admin/tracks/1/backfill", { method: "POST" }), new URL("https://x/api/admin/tracks/1/backfill"), env, { waitUntil() {} }, LOCK + HOUR)).status >= 400, true, "no import route");
});

test("stats: tiers within each team and draft spot vs this week", async () => {
  const { computeStats } = await import("../src/stats.js");
  const st = computeStats(TRACKS[0], seed1.history, seed1.events, TEAMS);
  assert.equal(st.tiers.length, 5);
  assert.ok(st.depth.every((t) => t.pilots.map((p) => p.tier).join() === "1,2,3,4,5"));
  assert.ok(st.tiers[0].fastest[0].time <= st.tiers[0].fastest[1].time);
  assert.equal(st.leaguePilots, 50);
  assert.ok(st.sandbaggers.length && st.sandbaggers.every((m, i, a) => m.moved > 0 && (i === 0 || a[i - 1].moved >= m.moved)));
  assert.ok(st.dropoffs.length && st.dropoffs.every((m, i, a) => m.moved < 0 && (i === 0 || a[i - 1].moved <= m.moved)));
  assert.ok(st.sandbaggers.every((m) => m.moved === m.draftPlace - m.weekPlace));
  assert.equal(st.draftBoard.length, 50);
  assert.deepEqual(st.draftBoard.slice(0, 2).map((d) => d.pilot), ["Raimon Shaigne", "MonsterDuke"], "captains first, best captain #1");
  assert.deepEqual([st.draftBoard[10].pilot, st.draftBoard[10].pos, st.draftBoard[10].pick], ["asiy", 11, 1], "pick 1 is #11");
  assert.equal(st.draftBoard[49].pilot, "Lord_Lanny");
  assert.ok(st.draftBoard.every((d) => d.lb == null || d.moved === d.pos - d.lb));
  assert.ok(st.pickSandbaggers.length <= 10 && st.pickSandbaggers.every((m, i, a) => m.moved > 0 && (i === 0 || a[i - 1].moved >= m.moved)));
  assert.ok(st.pickDropoffs.length <= 10 && st.pickDropoffs.every((m, i, a) => m.moved < 0 && (i === 0 || a[i - 1].moved <= m.moved)));
});

test("league-set times replace Velocidrone's slower listing (none are set right now)", async () => {
  const { applyOverrides, overrideSnapshot, computeStandings } = await import("../src/standings.js");
  const { ALIASES, TIME_OVERRIDES: LIVE } = await import("../src/config.js");
  assert.deepEqual(LIVE, {}, "AyyyKayyy's 72.980 override was withdrawn on Nov 8");
  const TIME_OVERRIDES = { 1: { AyyyKayyy: { time: 72.98, since: "2026-11-03T21:00:00Z", note: "test" } } };
  const fractal = TEAMS.find((t) => t.captain === "AyyyKayyy");
  const rows = [fractal.captain, ...fractal.pilots].map((n, i) => ({ rank: i + 1, name: n, time: n === "AyyyKayyy" ? 76.095 : 80 + i, model: "Hummingbird RS" }));
  const raw = computeStandings(rows, [fractal], ALIASES, TRACKS[0].quad);
  const fixed = applyOverrides(raw, TIME_OVERRIDES[1]);
  const ak = fixed.teams[0].pilots.find((p) => p.name === "AyyyKayyy");
  assert.equal(ak.time, 72.98);
  assert.equal(ak.override.listed, 76.095);
  assert.equal(ak.lb, null);
  assert.equal(fixed.teams[0].pilots[0].name, "AyyyKayyy", "fastest on the team again");
  assert.equal(fixed.teams[0].total, Math.round((raw.teams[0].total - 3.115) * 1000) / 1000);
  assert.deepEqual(applyOverrides(fixed, TIME_OVERRIDES[1]), fixed, "applying twice changes nothing");
  // A faster real time would win over the override.
  const faster = applyOverrides(computeStandings(rows.map((r) => (r.name === "AyyyKayyy" ? { ...r, time: 71 } : r)), [fractal], ALIASES, null), TIME_OVERRIDES[1]);
  assert.equal(faster.teams[0].pilots[0].time, 71);
  // Hourly saves from `since` on.
  const o = { AyyyKayyy: { ...TIME_OVERRIDES[1].AyyyKayyy, team: "Fractal Engineering" } };
  const snap = { at: "2026-11-08T03:00:00Z", teams: [["Fractal Engineering", 453.03, 5], ["WREKD", 400, 5]], pilots: { AyyyKayyy: 76.095 } };
  assert.deepEqual(overrideSnapshot(snap, o).teams, [["Fractal Engineering", 449.915, 5], ["WREKD", 400, 5]]);
  assert.equal(overrideSnapshot({ ...snap, at: "2026-11-03T20:00:00Z" }, o).pilots.AyyyKayyy, 76.095, "not before since");
});

test("bonus round: Week 1 top four, semis, final and 3rd place, 3/2/1/0 added to race points", async () => {
  const { computeRaces, applyBonusPatch, applyResultsPatch, applySittingPatch } = await import("../src/races.js");
  const { readFileSync } = await import("node:fs");
  const w = JSON.parse(readFileSync(new URL("./fixtures/week1-races.json", import.meta.url), "utf8"));
  const standings = { teams: TEAMS.map((t) => ({ sponsor: t.sponsor, pilots: w.order[t.sponsor].map((name) => ({ name })) })) };
  const docs = { lineup: applySittingPatch(null, w.sitting, TEAMS), tiers: {}, bonus: {} };
  for (const n of [1, 2, 3, 4]) docs.tiers[n] = applyResultsPatch(null, w.tiers[n], TEAMS);

  // Before any bonus heats: seeds only.
  let r = computeRaces(TRACKS[0], docs, TEAMS, standings);
  assert.deepEqual(r.bonus.seeds, ["DamagD", "Happymodel", "MEPSKING", "EMAX USA"]);
  assert.deepEqual(r.bonus.matches.map((m) => m.teams), [["DamagD", "EMAX USA"], ["Happymodel", "MEPSKING"], [null, null], [null, null]]);
  assert.equal(r.teams[0].total, 222);

  docs.bonus = applyBonusPatch(null, w.bonus, TEAMS);
  r = computeRaces(TRACKS[0], docs, TEAMS, standings);
  const m = Object.fromEntries(r.bonus.matches.map((x) => [x.id, x]));
  // 8 points for 1st down to 1 for 8th in each bonus heat.
  assert.deepEqual(m.semi1.totals, { DamagD: 56, "EMAX USA": 52 });
  assert.deepEqual(m.semi2.totals, { Happymodel: 59, MEPSKING: 49 });
  assert.deepEqual(m.final.totals, { DamagD: 59, Happymodel: 49 });
  assert.deepEqual(m.third.totals, { MEPSKING: 57, "EMAX USA": 51 });
  assert.deepEqual(m.final.heats.map((h) => h.score.DamagD), [19, 21, 19], "heat 2 is 21-15 by the times");
  assert.deepEqual(r.bonus.places.map((p) => [p.place, p.sponsor, p.points]), [[1, "DamagD", 3], [2, "Happymodel", 2], [3, "MEPSKING", 1], [4, "EMAX USA", 0]]);
  // The race-day total stays tier races only; the bonus is added on the season table.
  assert.deepEqual(r.teams.slice(0, 5).map((t) => [t.sponsor, t.raceTotal, t.bonus, t.total]), [
    ["DamagD", 222, 3, 222], ["Happymodel", 219, 2, 219], ["MEPSKING", 208, 1, 208], ["EMAX USA", 206, 0, 206], ["Fractal Engineering", 200, null, 200],
  ]);
  // Every bonus heat: 8 pilots scoring 8 down to 1.
  for (const x of r.bonus.matches) for (const h of x.heats) assert.deepEqual(h.entries.map((e) => e.points).sort((a, b) => b - a), [8, 7, 6, 5, 4, 3, 2, 1]);
  // Clearing a time and bad input.
  const cleared = applyBonusPatch(docs.bonus, { final: { 1: { DamagD: { 1: null } } } }, TEAMS);
  assert.equal(cleared.results.final[1].DamagD[1], undefined);
  assert.equal(computeRaces(TRACKS[0], { ...docs, bonus: cleared }, TEAMS, standings).bonus.places.length, 2, "final incomplete: only 3rd/4th placed");
  assert.throws(() => applyBonusPatch(null, { semi3: {} }, TEAMS), /no bonus match/);
  assert.throws(() => applyBonusPatch(null, { semi1: { 4: {} } }, TEAMS), /no bonus heat/);
  assert.throws(() => applyBonusPatch(null, { semi1: { 1: { DamagD: { 1: "fast" } } } }, TEAMS), /isn't a race time/);
});

for (const [store, makeEnv] of [["KV", () => ({ STANDINGS: new MemoryKV() })], ["Durable Object", () => ({ STANDINGS: new MemoryKV(), RACES_DO: fakeRaceRooms() })]])
test(`bonus round edits go through the director route (${store})`, async () => {
  const env = makeEnv();
  const res = await call(env, "PATCH", "/api/admin/tracks/1/races/bonus", { results: { semi1: { 1: { DamagD: { 1: "74.792" } } } } });
  assert.equal(res.status, 200);
  const { raceStore } = await import("../src/racestore.js");
  assert.deepEqual((await raceStore(env, 1).docs()).bonus.results, { semi1: { 1: { DamagD: { 1: 74.792 } } } });
  assert.equal((await req(env, "PATCH", "/api/admin/tracks/1/races/bonus", {}, { results: {} })).status, 403);
});

test("overall: Week 1 points worked out from the locked Smash standings and the full race day", async () => {
  const { readFileSync } = await import("node:fs");
  const w = JSON.parse(readFileSync(new URL("./fixtures/week1-races.json", import.meta.url), "utf8"));
  const smashTotals = { Happymodel: 414.844, MEPSKING: 416.569, DamagD: 416.642, "EMAX USA": 421.694, NewBeeDrone: 437.795, WREKD: 439.481, "Fractal Engineering": 452.078, Velocidrone: 455.88, BETAFPV: 465.56, RadioMaster: 466.413 };
  const standings = { teams: Object.entries(smashTotals).map(([sponsor, total], i) => ({ sponsor, total, position: i + 1, pilots: w.order[sponsor].map((name) => ({ name, posted: true, time: 80 })) })) };
  const env = { STANDINGS: new MemoryKV() };
  await env.STANDINGS.put("track:1", JSON.stringify({ status: "locked", lockedAt: TRACKS[0].locksAt, fetchedAt: TRACKS[0].locksAt, rows: [], standings, teams: TEAMS }));
  const at = "2026-11-09T01:00:00Z";
  await env.STANDINGS.put("races:1:lineup", JSON.stringify({ sitting: w.sitting, updatedAt: at }));
  for (const [n, results] of Object.entries(w.tiers)) await env.STANDINGS.put(`races:1:tier:${n}`, JSON.stringify({ results, updatedAt: at }));

  // Races done but the bonus round isn't: no Race points yet, Smash points are in.
  let body = await get(env, "/api/overall", LOCK + 30 * HOUR, {});
  const wk = (b, sp) => b.teams.find((t) => t.sponsor === sp).weeks[1];
  assert.deepEqual(wk(body, "Happymodel"), { smash: 10, race: null, raceBonus: null });
  assert.equal(wk(body, "RadioMaster").smash, 1);

  await env.STANDINGS.put("races:1:bonus", JSON.stringify({ results: w.bonus, updatedAt: at }));
  body = await get(env, "/api/overall", LOCK + 30 * HOUR, {});
  const table = Object.fromEntries(body.teams.map((t) => [t.sponsor, [t.weeks[1].smash, t.weeks[1].race, t.weeks[1].raceBonus, t.total, t.position]]));
  assert.deepEqual(table, {
    DamagD: [8, 23, 3, 31, 1], Happymodel: [10, 20, 2, 30, 2], MEPSKING: [9, 17, 1, 26, 3], "EMAX USA": [7, 14, 0, 21, 4],
    NewBeeDrone: [6, 10, null, 16, 5], "Fractal Engineering": [4, 12, null, 16, 5], WREKD: [5, 8, null, 13, 7],
    RadioMaster: [1, 6, null, 7, 8], BETAFPV: [2, 4, null, 6, 9], Velocidrone: [3, 2, null, 5, 10],
  });
  assert.deepEqual(body.teams.slice(0, 2).map((t) => t.sponsor), ["DamagD", "Happymodel"], "Race points: 20 for 1st down to 2 for 10th");
});

test("export: one JSON file with teams, draft, season table and Week 1 races", async () => {
  const { readFileSync } = await import("node:fs");
  const w = JSON.parse(readFileSync(new URL("./fixtures/week1-races.json", import.meta.url), "utf8"));
  const smashTotals = { Happymodel: 414.844, MEPSKING: 416.569, DamagD: 416.642, "EMAX USA": 421.694, NewBeeDrone: 437.795, WREKD: 439.481, "Fractal Engineering": 452.078, Velocidrone: 455.88, BETAFPV: 465.56, RadioMaster: 466.413 };
  const standings = { teams: Object.entries(smashTotals).map(([sponsor, total], i) => ({ sponsor, total, position: i + 1, posted: 5, size: 5, pilots: w.order[sponsor].map((name, j) => ({ name, posted: true, time: 70 + i + j, lb: 100 + i })) })) };
  const env = { STANDINGS: new MemoryKV() };
  await env.STANDINGS.put("track:1", JSON.stringify({ status: "locked", lockedAt: TRACKS[0].locksAt, fetchedAt: TRACKS[0].locksAt, rows: [], standings, teams: TEAMS }));
  const at = "2026-11-09T01:00:00Z";
  await env.STANDINGS.put("races:1:lineup", JSON.stringify({ sitting: w.sitting, updatedAt: at }));
  for (const [n, results] of Object.entries(w.tiers)) await env.STANDINGS.put(`races:1:tier:${n}`, JSON.stringify({ results, updatedAt: at }));
  await env.STANDINGS.put("races:1:bonus", JSON.stringify({ results: w.bonus, updatedAt: at }));
  const res = await route(new Request("https://x.dev/api/export"), new URL("https://x.dev/api/export"), env, ctx(), LOCK + 30 * HOUR, {});
  assert.match(res.headers.get("content-disposition"), /attachment; filename="webleed-s5-data-2026-11-09\.json"/);
  const body = await res.json();
  assert.equal(body.teams.length, 10);
  assert.equal(body.teams.find((t) => t.team === "RadioMaster").teamName, "Zeeb team 5");
  assert.equal(body.draft.length, 50);
  assert.equal(body.tracks.length, 6);
  const t1 = body.tracks[0];
  assert.equal(t1.smash[0].teamName, "Loch & Load");
  assert.equal(t1.smash[0].pilots[0].leagueLb, 1);
  assert.equal(t1.races.tiers.length, 4);
  assert.ok(t1.races.tiers.every((t) => t.heats.length === 8 && t.heats.every((h) => h.results.length === 10)));
  assert.deepEqual(t1.races.teams.slice(0, 2).map((t) => [t.team, t.raceTotal]), [["DamagD", 222], ["Happymodel", 219]]);
  assert.deepEqual(t1.races.bonus.places.map((p) => p.teamName), ["Emotional DamageD", "Loch & Load", "Five Crowns", "BaguetteMax"]);
  assert.equal(t1.races.bonus.matches.find((m) => m.match.toLowerCase().includes("3rd")).winner, "Five Crowns");
  assert.ok(t1.newBests.length > 500 && t1.newBests.every((e) => e.pilot && e.team));
  assert.ok(t1.hourly.length > 0);
  assert.equal(body.seasonTable.teams[0].sponsor, "DamagD");
  assert.equal(body.tracks[2].smash, null, "tracks that haven't opened are listed with no data");
});

test("Track 2: opens after Track 1 locks, counts only Cetus PRO times, locks Sat Nov 14 11:59 PM ET", async () => {
  const { trackStatus } = await import("../src/sync.js");
  const t2 = TRACKS.find((t) => t.id === 2);
  assert.equal(trackStatus(t2, null, Date.parse("2026-11-08T04:00:00Z")), "upcoming");
  assert.equal(trackStatus(t2, null, Date.parse("2026-11-09T06:00:00Z")), "live");
  assert.equal(t2.locksAt, "2026-11-15T04:59:00Z");
  assert.equal(new Date(t2.locksAt).toLocaleString("en-US", { timeZone: "America/New_York", weekday: "short", hour: "numeric", minute: "2-digit" }), "Sat 11:59 PM");
  const rows = [{ rank: 1, name: "Blastaa (Beta Tester)", time: 115.3, model: "Cetus PRO" }, { rank: 2, name: "caleb.", time: 110, model: "Tiny Hawk" }];
  const s = computeStandings(rows, TEAMS, ALIASES, t2.quad);
  const pilots = s.teams.flatMap((t) => t.pilots);
  assert.equal(pilots.find((p) => p.name === "Blastaa").time, 115.3, "(Beta Tester) tag still matches");
  assert.equal(pilots.find((p) => p.name === "caleb.").posted, false, "a Tiny Hawk time doesn't count");
});

test("a quad the game feed only gives by id is learned once from the public page", async () => {
  const env = { STANDINGS: new MemoryKV() };
  const t2 = TRACKS.find((t) => t.id === 2);
  const site = fakeSite([[1, "115.300", "Blastaa", "Cetus PRO"], [2, "110.000", "caleb.", "Tiny Hawk"]]);
  site.game = true; // the fake game endpoint sends model id 48 for anything that isn't a Hummingbird RS
  const now = Date.parse("2026-11-09T06:00:00Z");
  let r = await syncTrack(env, t2, now, { force: true, fetchImpl: site.fetch });
  assert.equal(r.record.source, "game");
  assert.deepEqual(await env.STANDINGS.get("models", "json"), { 48: "Cetus PRO" }, "learned from Blastaa's row on the page");
  const pilots = (await get(env, "/api/tracks/2", now + 60_000, { fetchImpl: site.fetch })).standings.teams.flatMap((t) => t.pilots);
  assert.equal(pilots.find((p) => p.name === "Blastaa").time, 115.3);
  // Once known, the page isn't read again.
  const pageCalls = site.calls;
  r = await syncTrack(env, t2, now + 5 * 60_000, { force: true, fetchImpl: site.fetch });
  assert.equal(site.calls, pageCalls);
  assert.equal(r.record.rows.find((x) => x.name === "Blastaa").model, "Cetus PRO");
});
