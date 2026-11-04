// Run with: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseLeaderboard } from "../src/leaderboard.js";
import { computeStandings } from "../src/standings.js";
import { lockTrack, runSchedule, syncTrack } from "../src/sync.js";
import { route } from "../src/index.js";
import { ALIASES, TEAMS, TRACKS } from "../src/config.js";
import { encrypt } from "../src/gameapi.js";

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
  const site = { rows, calls: 0, gameCalls: 0, fail: false, game: false };
  site.fetch = async (url) => {
    if (String(url).includes("getLeaderBoard")) {
      site.gameCalls++;
      if (site.fail || !site.game) return new Response("<html>nope</html>", { status: 419 });
      const tracktimes = site.rows.map(([, time, name, model = "Hummingbird RS"], i) => ({
        playername: name, lap_time: String(time), model_id: model === "Hummingbird RS" ? 121 : 48, user_id: 1000 + i, country: "US",
      }));
      return new Response(await encrypt(JSON.stringify({ success: true, tracktimes })), { status: 200 });
    }
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

  const callsAtLock = site.calls + site.gameCalls;
  site.rows = [[1, "60.000", "TMAD"]]; // posted after the deadline
  r = await runSchedule(env, LOCK + HOUR, deps);
  assert.equal(r[0].action, "skip-locked");
  assert.equal(site.calls + site.gameCalls, callsAtLock, "a locked track is never fetched");

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
  const calls = site.calls;
  const r = await runSchedule(env, LOCK + 61_000, deps); // e.g. the midnight hourly run
  assert.equal(r[0].action, "locked");
  assert.equal(r[0].record.lockMethod, "last-before-deadline");
  assert.equal(site.calls, calls);
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
  assert.equal(r[0].record.rows[0].userId, 1000);
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
  assert.equal(xer.userId, 1001);
  assert.equal(xer.modelId, 121);
  assert.equal(xer.model, "Hummingbird RS");
  assert.equal(xer.velocidroneName, "xer \u200e");
  // ...and they're kept in the frozen copy at the lock, and in the hourly history.
  await runSchedule(env, LOCK + 1000, { fetchImpl: site.fetch, retryDelayMs: 0 });
  const locked = await env.STANDINGS.get("track:1", "json");
  assert.equal(locked.standings.teams.find((t) => t.sponsor === "WREKD").pilots.find((p) => p.name === "xer").userId, 1001);
  const hist = await env.STANDINGS.get("history:1", "json");
  assert.equal(hist.at(-1).ids.xer, 1001);
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
  assert.deepEqual(body.teams[0].weeks[1], { smash: null, race: null });
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
  assert.deepEqual(body.teams[1].weeks[1], { smash: 6, race: null }, "bad values are ignored");
  assert.equal(body.teams[2].position, null);
});
