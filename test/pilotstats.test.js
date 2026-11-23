import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { computePilotStats } from "../src/pilotstats.js";
import { TEAMS } from "../src/config.js";
import { DRAFT_ORDER, DRAFT_RANKS } from "../src/draft.js";
import { fixtureWeeks } from "./pilot-fixture.js";

const fx = JSON.parse(readFileSync(new URL("./fixtures/pilot-weeks.json", import.meta.url), "utf8"));
const stats = computePilotStats({ weeks: fixtureWeeks(fx), teams: TEAMS, draft: { ranks: DRAFT_RANKS, order: DRAFT_ORDER } });
const P = (name) => stats.pilots.find((p) => p.name === name);

test("covers all 50 pilots and three raced weeks", () => {
  assert.equal(stats.pilots.length, 50);
  assert.deepEqual(stats.weeks.map((w) => [w.id, w.races, w.bonus]), [[1, true, true], [2, true, true], [3, true, true]]);
  for (const id of [1, 2, 3]) {
    const raced = stats.pilots.filter((p) => p.weeks[id].race && !p.weeks[id].race.sat).length;
    const sat = stats.pilots.filter((p) => p.weeks[id].race?.sat).length;
    assert.deepEqual([raced, sat], [40, 10], `week ${id}`);
  }
});

test("Week 3 race numbers match the consistency board", () => {
  const b = P("Blastaa").weeks[3].race;
  assert.deepEqual([b.tier, b.points, b.wins, b.spread, b.range, b.avgTime], [2, 80, 8, 1.397, 2.247, 79.277]);
  assert.equal(P("Senko").weeks[3].race.spread, 10.353);
  assert.equal(P("NightwingFPV").weeks[3].race.spread, 1.284);
  assert.equal(P("Raimon Shaigne").weeks[3].race.bestHeatRank, 1, "71.265 was the fastest heat of the day");
  assert.equal(P("Blastaa").season.perfectWeeks, 1);
});

test("999 placeholders count as last place but not as times", () => {
  const n = P("NightwingFPV").weeks[1].race;
  assert.deepEqual([n.tier, n.points, n.timedHeats, n.spread, n.best, n.bestHeatRank], [1, 8, 0, null, null, null]);
  assert.ok(stats.battles.close.every((b) => b.a.time < 900 && b.b.time < 900));
});

test("smash places, new bests and season totals", () => {
  const md = P("MonsterDuke");
  assert.deepEqual([md.weeks[2].smash.rank, md.weeks[2].smash.pctOff], [1, 0]);
  assert.equal(md.weeks[1].smash.pbs, 15, "16 entries: first time + 15 new bests");
  assert.equal(md.season.smashTotal, Math.round((65.993 + 111.87 + 71.192) * 1000) / 1000);
  assert.equal(P("Raimon Shaigne").weeks[1].smash.rank, 1);
  // every pilot sat out once in three weeks, at most twice
  for (const p of stats.pilots) assert.equal(p.season.weeksRaced + p.season.weeksSat, 3, p.name);
});

test("bonus heats and battles", () => {
  const w3 = P("Blastaa").weeks[3].bonus;
  assert.equal(w3.heats.length, 6, "semi + final");
  const closest = stats.battles.close.filter((b) => b.week === 3)[0];
  assert.ok(closest.gap <= stats.battles.close.filter((b) => b.week === 3).at(-1).gap);
  assert.ok(stats.battles.wins.every((b) => b.pos === 1));
});
