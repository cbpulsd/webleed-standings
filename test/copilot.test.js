// Race-day import from Copilot, replayed heat by heat from Copilot's real Week 1 and 2 data
// (test/fixtures/copilot-weeks.json) through a fake Copilot server.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { TEAMS, TRACKS } from "../src/config.js";
import { copilotTick, readRaw, sittingFrom, tieWinner, planWrites } from "../src/copilot.js";
import { computeRaces } from "../src/races.js";
import { raceStore } from "../src/racestore.js";
import { copilotSchedule, route } from "../src/index.js";

const fx = JSON.parse(readFileSync(new URL("./fixtures/copilot-weeks.json", import.meta.url), "utf8"));
const week1 = JSON.parse(readFileSync(new URL("./fixtures/week1-races.json", import.meta.url), "utf8"));

class KV {
  constructor() { this.d = new Map(); }
  async get(k, type) { const v = this.d.get(k); return v == null ? null : type === "json" ? JSON.parse(v) : v; }
  async put(k, v) { this.d.set(k, v); }
  async delete(k) { this.d.delete(k); }
}

// Each team's Smash order on the locked track (fastest first), which sets the tiers.
const ORDER = {
  1: week1.order,
  2: { MEPSKING: ["MonsterDuke", "wolfgoat", "Dinglez", "Sir Tarzan", "OmegaZenon"], DamagD: ["AnnihilationRobo", "Senko", "JAMUSXIII", "SteadyTrekker", "paszkevi4"], Happymodel: ["Fife Flyer", "Cha Cha", ".MrE.", "LOUNDS", "Royden99"], WREKD: ["Blastaa", "SpookyV9", "Mgescapades", "xer", "Britchot"], "EMAX USA": ["Raimon Shaigne", "burnerXIII", "FPVRossco", "FakeitFPV", "BallHawk"], NewBeeDrone: ["caleb.", "_-Crimson-_", "Doomburgerfpv", "Perc.FPV", "redeux"], "Fractal Engineering": ["AyyyKayyy", "NightwingFPV", "Skittles", "Hypnos FPV", "BACONFEATURES"], RadioMaster: ["BenDaOctopus", "asiy", "ZEBRA_THREE", "ZAR", "Lord_Lanny"], Velocidrone: ["TMAD", "Wheelman", "Blockfpv", "FPV_Cam", "BrokenParts"], BETAFPV: ["PacoFPV", "FulcrumFPV", "Fastodon", "-Zip-", "ZOETEK"] },
};

async function setup(trackId, { event, raceDay, locked = true } = {}) {
  const base = TRACKS.find((t) => t.id === trackId);
  const track = { ...base, id: trackId === 1 || trackId === 2 ? trackId : base.id, raceDay: raceDay || (trackId === 1 ? "2026-11-08" : "2026-11-15"), copilot: event ? { event } : undefined };
  const env = { STANDINGS: new KV() };
  const standings = { teams: Object.entries(ORDER[trackId]).map(([sponsor, names]) => ({ sponsor, pilots: names.map((name) => ({ name, posted: true })) })) };
  await env.STANDINGS.put(`track:${track.id}`, JSON.stringify({ status: locked ? "locked" : "live", lockedAt: track.locksAt, standings, teams: TEAMS }));
  return { env, track, store: raceStore(env, track.id) };
}

// Race-day order: tier 4 heats 1-8 (round 1), then tiers 3, 2, 1, then bonus heats 9-14.
const slotOf = (tier, heat) => (heat <= 8 ? (4 - tier) * 8 + (heat - 1) : 32 + (heat - 9));
const LAST_SLOT = 37;

function fakeCopilot(week, { step = LAST_SLOT, selected, date, overrides, tweak, extraPilot, down = false } = {}) {
  const src = fx[week];
  const pilots = src.pilots.map(([name, tier, times]) => {
    const t = times.split(",");
    const row = { pilot_name: name, weed_tier: tier, event_date: date || src.date };
    for (let h = 1; h <= 14; h++) row[`heat${h}_time`] = tier != null && t[h - 1] && slotOf(tier, h) <= step ? t[h - 1] : "";
    return row;
  });
  if (extraPilot) pilots.push(extraPilot);
  const results = { success: true, rounds: {} };
  for (const tier of [4, 3, 2, 1]) {
    const r = (results.rounds[5 - tier] = { round_number: 5 - tier, tier, heats: {} });
    for (let h = 1; h <= 8; h++) {
      r.heats[h] = { heat_number: h, pilots: pilots.filter((p) => p.weed_tier === tier && p[`heat${h}_time`]).map((p) => ({ pilot_name: p.pilot_name, raw_time: p[`heat${h}_time`] })) };
    }
  }
  if (tweak) tweak(results);
  const heatResults = (h) => ({ pilots: pilots.filter((p) => p[`heat${h}_time`]).map((p) => ({ pilot_name: p.pilot_name, raw_time: p[`heat${h}_time`] })) });
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (down) throw new Error("connect ECONNREFUSED");
    const path = new URL(url).pathname;
    const ok = (body) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    if (path === "/api/settings/selected-event") return ok({ selected_event: selected ?? week });
    let m = path.match(/^\/api\/public\/event\/(.+)$/);
    if (m) return ok({ event_name: decodeURIComponent(m[1]), pilots, count: pilots.length });
    m = path.match(/^\/api\/public\/weed\/[^/]+\/(results|heat-results\/(\d+)|overrides|standings)$/);
    if (m && m[1] === "results") return ok(results);
    if (m && m[2]) return ok(heatResults(Number(m[2])));
    if (m && m[1] === "overrides") return ok(overrides ?? fx.overrides[week] ?? { overrides: [] });
    if (m && m[1] === "standings") return ok({ success: true, standings: [] });
    return new Response("not found", { status: 404 });
  };
  return { fetchImpl, calls };
}

const NOW2 = Date.parse("2026-11-15T21:00:00Z");
const NOW1 = Date.parse("2026-11-08T23:00:00Z");

async function racesOf(env, track) {
  const docs = await raceStore(env, track.id).docs();
  const rec = await env.STANDINGS.get(`track:${track.id}`, "json");
  return computeRaces(track, docs, TEAMS, rec.standings);
}

test("Week 2 replayed heat by heat: sit-outs, every tier race, the bonus round, then the final check passes", async () => {
  const { env, track, store } = await setup(2);
  // Before the first heat: Copilot already has tiers, so sit-outs fill in; nothing else.
  let r = await copilotTick(env, track, NOW2, { store, fetchImpl: fakeCopilot("WB-S5-R2", { step: -1 }).fetchImpl });
  assert.equal(r.state.phase, "waiting");
  assert.equal(r.again, true);
  let races = await racesOf(env, track);
  assert.deepEqual(Object.fromEntries(races.teams.map((t) => [t.sponsor, t.sitting])), { MEPSKING: "OmegaZenon", Happymodel: ".MrE.", RadioMaster: "ZAR", NewBeeDrone: "Doomburgerfpv", DamagD: "Senko", "EMAX USA": "BallHawk", Velocidrone: "BrokenParts", WREKD: "Mgescapades", "Fractal Engineering": "NightwingFPV", BETAFPV: "Fastodon" });

  // Each minute a heat or two more comes in.
  for (let step = 0; step <= LAST_SLOT; step += 3) {
    r = await copilotTick(env, track, NOW2 + step * 60_000, { store, fetchImpl: fakeCopilot("WB-S5-R2", { step }).fetchImpl });
    if (step < LAST_SLOT) assert.equal(r.state.phase, "racing", `step ${step}`);
  }
  r = await copilotTick(env, track, NOW2 + 60 * 60_000, { store, fetchImpl: fakeCopilot("WB-S5-R2").fetchImpl });
  assert.equal(r.state.phase, "verified", JSON.stringify(r.state.flags));
  assert.equal(r.again, false, "stops checking once verified");
  assert.equal(r.state.check.checked, 416);
  assert.equal(r.state.check.differences, 0);
  assert.ok(!r.state.flags.some((f) => f.level !== "info"), JSON.stringify(r.state.flags));

  races = await racesOf(env, track);
  assert.deepEqual(races.teams.map((t) => [t.sponsor, t.raceTotal]).slice(0, 4), [["MEPSKING", 245], ["Happymodel", 229], ["RadioMaster", 210], ["NewBeeDrone", 186]]);
  assert.deepEqual(races.bonus.places.map((p) => p.sponsor), ["MEPSKING", "Happymodel", "NewBeeDrone", "RadioMaster"]);
});

test("Week 1 through Copilot gives the same race day as the one entered by hand", async () => {
  const { env, track, store } = await setup(1);
  const r = await copilotTick(env, track, NOW1, { store, fetchImpl: fakeCopilot("WB-S5-R1").fetchImpl });
  assert.equal(r.state.phase, "verified", JSON.stringify(r.state.flags));
  const races = await racesOf(env, track);
  for (const [n, results] of Object.entries(week1.tiers)) {
    for (const [race, row] of Object.entries(results)) {
      const doc = (await store.docs()).tiers[n].results[race];
      for (const [sp, t] of Object.entries(row)) assert.equal(doc[sp], t, `tier ${n} race ${race} ${sp}`);
    }
  }
  assert.deepEqual(races.bonus.places.map((p) => p.sponsor), ["DamagD", "Happymodel", "MEPSKING", "EMAX USA"]);
});

test("a tied bonus match with no winner in Copilot or the league is flagged, and checks keep running", async () => {
  // Track 2's real tie, but on a track with no league decision and no Copilot override.
  const { env, track, store } = await setup(2, { event: "WB-S5-R2" });
  const trackNoDecision = { ...track, id: 9 };
  await env.STANDINGS.put("track:9", await env.STANDINGS.get("track:2"));
  const st = raceStore(env, 9);
  const r = await copilotTick(env, trackNoDecision, NOW2, { store: st, fetchImpl: fakeCopilot("WB-S5-R2", { overrides: { overrides: [] } }).fetchImpl });
  const tie = r.state.flags.find((f) => f.code === "tie-third");
  assert.equal(tie?.level, "error");
  assert.match(tie.message, /tied 54–54/);
  assert.equal(r.again, true);
  assert.notEqual(r.state.phase, "verified");
});

test("a tie Copilot does settle (an override) is used, with a note", async () => {
  const { env, track } = await setup(2, { event: "WB-S5-R2" });
  await env.STANDINGS.put("track:9", await env.STANDINGS.get("track:2"));
  const st = raceStore(env, 9);
  const r = await copilotTick(env, { ...track, id: 9 }, NOW2, { store: st, fetchImpl: fakeCopilot("WB-S5-R2").fetchImpl });
  assert.equal(r.state.phase, "verified", JSON.stringify(r.state.flags));
  assert.equal(r.state.decisions.third.winner, "NewBeeDrone");
  assert.match(r.state.flags.find((f) => f.code === "tie-third").message, /override/);
  assert.deepEqual(tieWinner({ id: "third", teams: ["NewBeeDrone", "RadioMaster"] }, { overrides: { overrides: [{ field: "bonus", entity_name: "Zeeb team 5", value: 0 }] } }).winner, "NewBeeDrone", "a 0 for one side means the other won");
});

test("times typed in by hand are never overwritten, and a difference is flagged", async () => {
  const { env, track, store } = await setup(2);
  await store.patch("tier", 4, { 1: { Velocidrone: "126.000" } }, TEAMS, "x");
  const r = await copilotTick(env, track, NOW2, { store, fetchImpl: fakeCopilot("WB-S5-R2").fetchImpl });
  assert.equal((await store.docs()).tiers[4].results[1].Velocidrone, 126);
  const codes = r.state.flags.map((f) => f.code);
  assert.ok(codes.includes("not-empty"), "starts without a clean slate");
  assert.ok(codes.includes("hand-edits"));
  assert.ok(codes.includes("verify"), "and the end check catches it");
  assert.equal(r.state.phase, "checking");

  // Clearing the hand edit lets Copilot's time in on the next check.
  await store.patch("tier", 4, { 1: { Velocidrone: null } }, TEAMS, "x");
  const again = await copilotTick(env, track, NOW2 + 60_000, { store, fetchImpl: fakeCopilot("WB-S5-R2").fetchImpl });
  assert.equal((await store.docs()).tiers[4].results[1].Velocidrone, 127.077);
  assert.equal(again.state.phase, "verified", JSON.stringify(again.state.flags));
});

test("a correction in Copilot replaces the time it had imported", async () => {
  const { env, track, store } = await setup(2);
  await copilotTick(env, track, NOW2, { store, fetchImpl: fakeCopilot("WB-S5-R2", { step: 0 }).fetchImpl });
  assert.equal((await store.docs()).tiers[4].results[1].Velocidrone, 127.077);
  const fix = fakeCopilot("WB-S5-R2", { step: 0 });
  const orig = fix.fetchImpl;
  const fetchImpl = async (url) => {
    const res = await orig(url);
    if (!url.includes("/api/public/event/")) return res;
    const body = await res.json();
    body.pilots.find((p) => p.pilot_name === "FPV_Cam").heat1_time = "126.500";
    return new Response(JSON.stringify(body));
  };
  const r = await copilotTick(env, track, NOW2 + 60_000, { store, fetchImpl });
  assert.equal((await store.docs()).tiers[4].results[1].Velocidrone, 126.5);
  assert.ok(!r.state.flags.some((f) => f.code === "hand-edits"));
});

test("checks before racing: the selected event, an old event, pilots who aren't on a team", async () => {
  let { env, track, store } = await setup(2);
  let r = await copilotTick(env, track, NOW2, { store, fetchImpl: fakeCopilot("WB-S5-R2", { step: -1, selected: "WB-S5-R1" }).fetchImpl });
  assert.equal(r.state.flags.find((f) => f.code === "selected").level, "info");
  r = await copilotTick(env, track, NOW2, { store, fetchImpl: fakeCopilot("WB-S5-R2", { step: 3, selected: "WB-S5-R1" }).fetchImpl });
  assert.equal(r.state.flags.find((f) => f.code === "selected").level, "warn", "racing into an event that isn't selected");

  ({ env, track, store } = await setup(2));
  r = await copilotTick(env, track, NOW2, { store, fetchImpl: fakeCopilot("WB-S5-R2", { date: "2026-11-08T22:00:00Z" }).fetchImpl });
  assert.equal(r.state.phase, "blocked");
  assert.equal(r.state.flags.find((f) => f.code === "stale-event").level, "error");
  assert.equal(Object.keys((await store.docs()).tiers[1].results || {}).length, 0, "nothing imported from an old event");

  ({ env, track, store } = await setup(2));
  r = await copilotTick(env, track, NOW2, { store, fetchImpl: fakeCopilot("WB-S5-R2", { step: 3, extraPilot: { pilot_name: "RandomGuest", weed_tier: 4, heat1_time: "130.000" } }).fetchImpl });
  assert.equal(r.state.flags.find((f) => f.code === "unknown-pilots").level, "error");
});

test("a track that isn't locked, Copilot being down, and the race-day window", async () => {
  let { env, track, store } = await setup(2, { locked: false });
  let r = await copilotTick(env, track, NOW2, { store, fetchImpl: fakeCopilot("WB-S5-R2").fetchImpl });
  assert.equal(r.state.phase, "blocked");
  assert.equal(r.state.flags[0].code, "not-locked");

  ({ env, track, store } = await setup(2));
  const down = fakeCopilot("WB-S5-R2", { down: true }).fetchImpl;
  for (let i = 0; i < 3; i++) r = await copilotTick(env, track, NOW2 + i * 60_000, { store, fetchImpl: down });
  assert.equal(r.state.flags.find((f) => f.code === "unreachable").level, "warn", "flagged after 3 failed checks in a row");
  assert.equal(r.again, true);
  r = await copilotTick(env, track, NOW2 + 5 * 60_000, { store, fetchImpl: fakeCopilot("WB-S5-R2").fetchImpl });
  assert.ok(!r.state.flags.some((f) => f.code === "unreachable"));

  // Not before race day; still checking past midnight until it's all in.
  ({ env, track, store } = await setup(2));
  const fake = fakeCopilot("WB-S5-R2", { step: 10 });
  r = await copilotTick(env, track, Date.parse("2026-11-14T12:00:00Z"), { store, fetchImpl: fake.fetchImpl });
  assert.equal(r.state.phase, "scheduled");
  assert.equal(fake.calls.length, 0);
  r = await copilotTick(env, track, Date.parse("2026-11-16T06:30:00Z"), { store, fetchImpl: fake.fetchImpl });
  assert.equal(r.state.phase, "racing");
  assert.equal(r.again, true);
});

test("auto-import is on by default; the director can turn it off and check now; the Races page shows the notices", async () => {
  const { env, track } = await setup(2);
  const { fetchImpl } = fakeCopilot("WB-S5-R2", { selected: "WB-S5-R1", step: 5 });
  // The 5-minute schedule starts it on race day.
  const sched = await copilotSchedule(env, NOW2, { fetchImpl });
  assert.equal(sched.find((s) => s.id === 2)?.state?.phase, "racing");

  const races = await route(new Request("https://x.dev/api/tracks/2/races"), new URL("https://x.dev/api/tracks/2/races"), env, { waitUntil() {} }, NOW2, {});
  const body = await races.json();
  assert.equal(body.import.enabled, true);
  assert.equal(body.import.phase, "racing");
  assert.ok(body.import.flags.some((f) => f.code === "selected" && f.level === "warn"));
  assert.equal(body.import.cells, undefined, "no bookkeeping in the public view");

  // Director: off, then on again with a check.
  const admin = async (payload) => {
    const login = await route(new Request("https://x.dev/api/admin/login", { method: "POST", headers: { "x-admin-password": "pw" } }), new URL("https://x.dev/api/admin/login"), { ...env, ADMIN_PASSWORD: "pw", ADMIN_SECRET: "s" }, {}, NOW2, {});
    const { session } = await login.json();
    const u = "https://x.dev/api/admin/tracks/2/races/copilot";
    const res = await route(new Request(u, { method: "POST", headers: { "x-admin-session": session }, body: JSON.stringify(payload) }), new URL(u), { ...env, ADMIN_PASSWORD: "pw", ADMIN_SECRET: "s" }, {}, NOW2, { fetchImpl });
    return res.json();
  };
  let out = await admin({ enabled: false });
  assert.equal(out.import.enabled, false);
  assert.equal(out.import.phase, "off");
  out = await admin({ enabled: true, run: true });
  assert.equal(out.import.enabled, true);
  assert.equal(out.import.phase, "racing");
});

test("Check now before race day only reports: Copilot reachable, nothing flagged on the Races page", async () => {
  const { env, track, store } = await setup(2, { locked: false });
  const fake = fakeCopilot("WB-S5-R2", { step: -1, selected: "WB-S5-R2" });
  const r = await copilotTick(env, track, Date.parse("2026-11-12T20:00:00Z"), { store, fetchImpl: fake.fetchImpl, force: true });
  assert.equal(r.state.phase, "scheduled");
  assert.equal(r.again, false);
  assert.ok(fake.calls.length >= 2, "it does contact Copilot");
  assert.deepEqual(r.state.flags.map((f) => [f.level, f.code]), [["info", "reachable"]]);
  assert.equal(Object.keys((await store.docs()).lineup.sitting || {}).length, 0, "nothing imported before race day");
});

test("sit-outs and tiers read from Copilot's raw feed", () => {
  const raw = { pilots: fx["WB-S5-R1"].pilots.map(([n, t, times]) => ({ pilot_name: n, weed_tier: t, ...Object.fromEntries(times.split(",").map((v, i) => [`heat${i + 1}_time`, v])) })) };
  const read = readRaw(raw, TEAMS);
  assert.equal(read.unknown.length, 0, "every Copilot name maps to a roster pilot (Wheelman1, TheSkittles, _ZAR_, Lounds...)");
  assert.deepEqual(sittingFrom(read, TEAMS), week1.sitting);
  assert.deepEqual(planWrites({ a: 1, b: 2 }, { a: 1, b: 3 }, { b: 9 }).kept.map((k) => k.key), ["b"]);
});
