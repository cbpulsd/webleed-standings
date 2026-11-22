// Race-day import from Copilot (the league's timing site).
//
// Source of truth: Copilot's raw times, GET {base}/api/public/event/{event}: one row per pilot
// with heat1_time ... heat14_time as the sim uploads them, and weed_tier (null = sitting out).
// We map each pilot to a team through our own rosters and do all scoring ourselves:
//   heats 1-8   -> the pilot's tier races 1-8
//   heats 9-11  -> the semifinal their team is in (bonus heats 1-3)
//   heats 12-14 -> the final or 3rd place match their team is in (both run at once)
//
// Checks, kept as flags shown on the Races page (warn/error) and the Race Director page (all):
//   before:  Copilot's selected event is ours, the event is from race day (not a stale one),
//            our race data starts empty, every Copilot pilot is on a roster, tiers agree
//   during:  hand-entered times always win over the import (and are flagged if they differ)
//   after:   only once every tier heat and bonus match is in (no fixed end time), every time
//            is compared with Copilot's own /results and /heat-results/9..14; a tied bonus
//            match without a clear winner in Copilot (or a league decision) is flagged

import { ALIASES, BONUS_DECISIONS, COPILOT, RACES, TEAM_NAMES } from "./config.js";
import { computeRaces, parseRaceTime } from "./races.js";
import { norm } from "./standings.js";
import { getRecord } from "./store.js";
import { overridesFor, teamsFor } from "./sync.js";
import { applyOverrides } from "./standings.js";

const TIER_HEATS = RACES.racesPerTier; // 8
const SEMI_HEATS = [9, 10, 11];
const LAST_HEATS = [12, 13, 14];
const MAX_HEAT = 14;

export const copilotEvents = (track) => (track.copilot?.event ? [track.copilot.event] : COPILOT.events(track));
export const copilotEvent = (track) => copilotEvents(track)[0];
const heatTimesIn = (raw) => (raw?.pilots || []).some((p) => Object.keys(p).some((k) => /^heat\d+_time$/.test(k) && p[k]));
// Which of the possible event names to read: the one with race times in it, else the one
// Copilot has selected, else one with pilots in it, else the first name.
export function pickEvent(names, raws, selected) {
  const sel = String(selected || "").toLowerCase();
  const i = [
    raws.findIndex(heatTimesIn),
    names.findIndex((n) => n.toLowerCase() === sel),
    raws.findIndex((r) => (r?.pilots || []).length > 0),
  ].find((x) => x >= 0) ?? 0;
  return { event: names[i], raw: raws[i] };
}
// Races are on Sundays in November/December: Eastern Standard Time (UTC-5).
// Checking starts at COPILOT.startEastern on race day (half an hour before the 5 PM start).
export const raceStart = (track) => {
  const [h, m] = (track.copilot?.startEastern || COPILOT.startEastern).split(":").map(Number);
  return Date.parse(`${track.raceDay}T00:00:00Z`) + ((h + 5) * 60 + m) * 60_000;
};
export const raceWindow = (track) => ({ start: raceStart(track), end: raceStart(track) + COPILOT.windowHours * 3_600_000 });
const etDate = (ms) => new Date(ms - 5 * 3_600_000).toISOString().slice(0, 10);
const clock = (ms) => new Date(ms - 5 * 3_600_000).toISOString().slice(11, 16) + " ET";
const sameTime = (a, b) => (a === b) || (typeof a === "number" && typeof b === "number" && Math.abs(a - b) < 0.0005);

// Roster lookup by any spelling we know (roster name or Velocidrone name).
export function rosterIndex(teams) {
  const idx = new Map();
  for (const t of teams) for (const p of [t.captain, ...t.pilots]) {
    const entry = { sponsor: t.sponsor, pilot: p };
    idx.set(norm(p), entry);
    if (ALIASES[norm(p)]) idx.set(ALIASES[norm(p)], entry);
  }
  return { get: (name) => idx.get(norm(name)) || null };
}

// Copilot team name -> our sponsor (their names match ours apart from capitals).
const teamIndex = new Map(Object.entries(TEAM_NAMES).map(([sponsor, t]) => [norm(t.name), sponsor]));
export const sponsorForTeam = (name) => teamIndex.get(norm(name || "")) || null;

// Raw Copilot event -> who raced where, plus anything that doesn't fit our rosters.
export function readRaw(raw, teams) {
  const roster = rosterIndex(teams);
  const pilots = [];
  const unknown = [];
  for (const p of raw?.pilots || []) {
    const who = roster.get(p.pilot_name);
    const times = {};
    for (let h = 1; h <= MAX_HEAT; h++) {
      const v = p[`heat${h}_time`];
      if (v == null || v === "") continue;
      const t = parseRaceTime(v);
      if (t !== undefined && t !== null) times[h] = t;
    }
    const tier = Number.isInteger(p.weed_tier) ? p.weed_tier : null;
    if (!who) { unknown.push({ name: p.pilot_name, hasTimes: Object.keys(times).length > 0 }); continue; }
    pilots.push({ ...who, name: p.pilot_name, tier, times, eventDate: p.event_date || null });
  }
  const hasTimes = pilots.some((p) => Object.keys(p.times).length) || unknown.some((u) => u.hasTimes);
  return { pilots, unknown, hasTimes };
}

// Who sits out for each team, as Copilot has it: the one rostered pilot without a tier
// once the other four have tiers 1-4, or (once racing) the one without any tier-heat time.
export function sittingFrom(read, teams) {
  const out = {};
  for (const t of teams) {
    const mine = read.pilots.filter((p) => p.sponsor === t.sponsor);
    const tiered = mine.filter((p) => p.tier != null);
    if (mine.length === 5 && tiered.length === 4 && new Set(tiered.map((p) => p.tier)).size === 4) {
      out[t.sponsor] = mine.find((p) => p.tier == null).pilot;
      continue;
    }
    const flew = mine.filter((p) => Object.keys(p.times).some((h) => h <= TIER_HEATS));
    if (mine.length === 5 && flew.length === 4) out[t.sponsor] = mine.find((p) => !flew.includes(p)).pilot;
  }
  return out;
}

// Every saved cell, keyed so the import can tell its own writes from hand edits.
//   s|<sponsor>                        sitting pilot
//   t|<tier>|<race>|<sponsor>          tier race time
//   b|<match>|<heat>|<sponsor>|<tier>  bonus heat time
export function cellsOf(docs) {
  const cells = {};
  for (const [sponsor, pilot] of Object.entries(docs?.lineup?.sitting || {})) cells[`s|${sponsor}`] = pilot;
  for (const [tier, doc] of Object.entries(docs?.tiers || {}))
    for (const [race, row] of Object.entries(doc?.results || {}))
      for (const [sponsor, v] of Object.entries(row)) cells[`t|${tier}|${race}|${sponsor}`] = v;
  for (const [match, heats] of Object.entries(docs?.bonus?.results || {}))
    for (const [heat, bySponsor] of Object.entries(heats))
      for (const [sponsor, byTier] of Object.entries(bySponsor))
        for (const [tier, v] of Object.entries(byTier)) cells[`b|${match}|${heat}|${sponsor}|${tier}`] = v;
  return cells;
}

// Turn wanted cells into patches, leaving hand edits alone.
// `imported` is what the import wrote last time (key -> value).
export function planWrites(wanted, current, imported) {
  const writes = {}; // key -> value (null clears)
  const next = { ...imported };
  const kept = []; // hand edits that differ from Copilot
  for (const [key, value] of Object.entries(wanted)) {
    const cur = current[key];
    if (sameTime(cur, value)) { next[key] = value; continue; }
    if (cur == null || (key in imported && sameTime(cur, imported[key]))) { writes[key] = value; next[key] = value; continue; }
    kept.push({ key, ours: cur, copilot: value });
  }
  // Copilot removed a time the import had written (and nobody changed it since): clear it.
  for (const [key, value] of Object.entries(imported)) {
    if (key in wanted) continue;
    if (sameTime(current[key], value)) writes[key] = null;
    delete next[key];
  }
  return { writes, next, kept };
}

export function patchesFrom(writes) {
  const lineup = {};
  const tiers = {};
  const bonus = {};
  for (const [key, value] of Object.entries(writes)) {
    const [kind, a, b, c, d] = key.split("|");
    const v = value === "dnf" ? "DNF" : value;
    if (kind === "s") lineup[a] = v;
    else if (kind === "t") ((tiers[a] ||= {})[b] ||= {})[c] = v;
    else if (kind === "b") (((bonus[a] ||= {})[b] ||= {})[c] ||= {})[d] = v;
  }
  return { lineup, tiers, bonus };
}

// Tier race cells wanted from Copilot (each pilot in the tier Copilot raced them in).
export function tierCells(read) {
  const cells = {};
  for (const p of read.pilots) {
    if (p.tier == null) continue;
    for (let h = 1; h <= TIER_HEATS; h++) if (p.times[h] != null) cells[`t|${p.tier}|${h}|${p.sponsor}`] = p.times[h];
  }
  return cells;
}

// Bonus cells, given which teams are in which match (from our own bonus round).
export function bonusCells(read, matches) {
  const cells = {};
  const problems = [];
  const matchOf = (ids, sponsor) => ids.find((id) => matches[id]?.includes(sponsor)) || null;
  for (const p of read.pilots) {
    for (const h of [...SEMI_HEATS, ...LAST_HEATS]) {
      if (p.times[h] == null) continue;
      const semi = h <= 11;
      const id = matchOf(semi ? ["semi1", "semi2"] : ["final", "third"], p.sponsor);
      const heat = semi ? h - 8 : h - 11;
      if (!id) { problems.push({ heat: h, pilot: p.pilot, sponsor: p.sponsor }); continue; }
      if (p.tier == null) { problems.push({ heat: h, pilot: p.pilot, sponsor: p.sponsor, tier: null }); continue; }
      cells[`b|${id}|${heat}|${p.sponsor}|${p.tier}`] = p.times[h];
    }
  }
  return { cells, problems };
}

// Is every tier race and every bonus match fully timed?
export function raceDone(races) {
  const tiersDone = races.tierResults.every((t) => t.entries.every((e) => e.times.every((v) => v != null)));
  const bonusDone = !races.bonus || races.bonus.matches.every((m) => m.complete);
  return { tiersDone, bonusDone, done: tiersDone && bonusDone };
}

// A tied bonus match: does Copilot clearly say who won? Sources in order: an override
// a Copilot admin set (overrides), then bonus points on its standings (results).
// Copilot's computed positions aren't used for ties: they pick a side on their own.
export function tieWinner(match, { overrides, standings } = {}) {
  const [a, b] = match.teams;
  // Bonus points a place earns: final 1st/2nd, 3rd place match 3rd/4th. Semis earn none,
  // so Copilot can't show a semifinal tie-break this way.
  const [winPts, losePts] = match.id === "final" ? [RACES.bonus.points[0], RACES.bonus.points[1]] : match.id === "third" ? [RACES.bonus.points[2], RACES.bonus.points[3]] : [null, null];
  if (winPts == null) return { winner: null };
  const decide = (vals, source) => {
    const va = vals[a], vb = vals[b];
    if (va != null && vb != null) return va === vb ? null : { winner: va > vb ? a : b, source };
    const [one, v] = va != null ? [a, va] : vb != null ? [b, vb] : [null, null];
    if (one == null) return null;
    if (v === winPts) return { winner: one, source };
    if (v === losePts) return { winner: one === a ? b : a, source };
    return null;
  };
  const fromOverrides = {};
  for (const o of overrides?.overrides || []) {
    const sp = o.field === "bonus" ? sponsorForTeam(o.entity_name) : null;
    if (sp === a || sp === b) fromOverrides[sp] = Number(o.value);
  }
  const fromStandings = {};
  for (const s of standings?.standings || []) {
    const sp = sponsorForTeam(s.team_name);
    if ((sp === a || sp === b) && s.bonus_points != null && Number(s.bonus_points) > 0) fromStandings[sp] = Number(s.bonus_points);
  }
  const found = [decide(fromOverrides, "a Copilot override"), decide(fromStandings, "Copilot's standings")].filter(Boolean);
  if (!found.length) return { winner: null };
  if (new Set(found.map((f) => f.winner)).size > 1) return { winner: null, conflict: found };
  return found[0];
}

// End of day: compare every saved time with Copilot's own results.
export function verify(docs, results, heatResults, read) {
  const ours = cellsOf(docs);
  const tierOf = new Map(read.pilots.map((p) => [norm(p.name), p]));
  const theirs = {};
  for (const r of Object.values(results?.rounds || {})) {
    for (const h of Object.values(r.heats || {})) {
      for (const p of h.pilots || []) {
        const who = tierOf.get(norm(p.pilot_name));
        if (!who) continue;
        theirs[`t|${r.tier}|${h.heat_number}|${who.sponsor}`] = parseRaceTime(p.raw_time ?? p.time);
      }
    }
  }
  const matchFor = {};
  for (const key of Object.keys(ours)) if (key.startsWith("b|")) { const [, m, , sp] = key.split("|"); matchFor[sp + (["semi1", "semi2"].includes(m) ? "|semi" : "|last")] = m; }
  for (const [n, body] of Object.entries(heatResults || {})) {
    const h = Number(n);
    for (const p of body?.pilots || []) {
      const who = tierOf.get(norm(p.pilot_name));
      if (!who || who.tier == null) continue;
      const m = matchFor[who.sponsor + (h <= 11 ? "|semi" : "|last")];
      if (!m) { theirs[`b|?|${h}|${who.sponsor}|${who.tier}`] = parseRaceTime(p.raw_time); continue; }
      theirs[`b|${m}|${h <= 11 ? h - 8 : h - 11}|${who.sponsor}|${who.tier}`] = parseRaceTime(p.raw_time);
    }
  }
  const diffs = [];
  let checked = 0;
  for (const [key, v] of Object.entries(ours)) {
    if (key.startsWith("s|")) continue;
    checked++;
    if (!(key in theirs)) diffs.push({ key, ours: v, copilot: null });
    else if (!sameTime(v, theirs[key])) diffs.push({ key, ours: v, copilot: theirs[key] });
  }
  for (const [key, v] of Object.entries(theirs)) if (!(key in ours) && v != null) diffs.push({ key, ours: null, copilot: v });
  return { checked, diffs };
}

const describe = (key) => {
  const [kind, a, b, c, d] = key.split("|");
  if (kind === "t") return `Tier ${a} race ${b}, ${TEAM_NAMES[c]?.name || c}`;
  if (kind === "b") return `${{ semi1: "Semifinal 1", semi2: "Semifinal 2", final: "Final", third: "3rd place" }[a] || "Bonus"} heat ${b}, ${TEAM_NAMES[c]?.name || c} tier ${d}`;
  if (kind === "s") return `${TEAM_NAMES[a]?.name || a} sit-out`;
  return key;
};
const fmt = (v) => (v == null ? "nothing" : v === "dnf" ? "DNF" : typeof v === "number" ? v.toFixed(3) : String(v));
const list = (items, n = 4) => items.slice(0, n).join("; ") + (items.length > n ? `; and ${items.length - n} more` : "");

async function getJson(fetchImpl, path) {
  const res = await fetchImpl(COPILOT.base + path, { headers: { accept: "application/json" }, signal: AbortSignal.timeout?.(COPILOT.timeoutMs) });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`${path} returned ${res.status}`);
  return res.json();
}

// What everyone sees (no cell bookkeeping).
export function publicImport(state) {
  if (!state) return { enabled: true, phase: "idle", flags: [] };
  const { cells, ...rest } = state;
  return { ...rest, imported: Object.keys(cells || {}).length };
}

// One check. `store` is the race store for this track: { docs, patch, getImport, setImport }.
// Returns { state, again } where `again` says whether to check again in a minute.
export async function copilotTick(env, track, now, { store, fetchImpl = fetch, force = false } = {}) {
  const prev = (await store.getImport()) || {};
  const names = copilotEvents(track);
  const state = { enabled: true, cells: {}, decisions: {}, failures: 0, ...prev, event: prev.event && names.includes(prev.event) ? prev.event : names[0] };
  const flags = [];
  const flag = (level, code, message) => flags.push({ level, code, message });
  const save = async (again, extra = {}) => {
    Object.assign(state, extra, { flags, lastPollAt: new Date(now).toISOString() });
    await store.setImport(state);
    return { state, again };
  };

  if (!track.raceDay) return save(false, { phase: "none" });
  if (!state.enabled) { flag("info", "off", "Auto-import from Copilot is off for this track."); return save(false, { phase: "off" }); }
  const { start, end } = raceWindow(track);
  if (now < start && !force) return save(false, { phase: "scheduled" });
  if (state.phase === "verified" && !force) { flags.push(...(prev.flags || [])); return save(false); }
  if (now > end && !force) {
    flags.push(...(prev.flags || []).filter((f) => f.code !== "expired"));
    flag("warn", "expired", `Race day ended (${COPILOT.windowHours} hours after it began) before every heat and bonus match was recorded, so Copilot isn't being checked any more.`);
    return save(false, { phase: "expired" });
  }

  // Their side.
  let selected, raw;
  try {
    let raws;
    [selected, ...raws] = await Promise.all([getJson(fetchImpl, "/api/settings/selected-event"), ...names.map((n) => getJson(fetchImpl, `/api/public/event/${encodeURIComponent(n)}`))]);
    ({ event: state.event, raw } = pickEvent(names, raws, selected?.selected_event));
  } catch (err) {
    state.failures = (prev.failures || 0) + 1;
    state.failingSince ||= new Date(now).toISOString();
    flags.push(...(prev.flags || []).filter((f) => f.code !== "unreachable"));
    const level = state.failures >= COPILOT.failuresBeforeFlag ? "warn" : "info";
    flag(level, "unreachable", `Can't reach Copilot since ${clock(Date.parse(state.failingSince))} (${String(err?.message || err)}). Times entered by hand still work.`);
    return save(true);
  }
  state.failures = 0;
  delete state.failingSince;
  state.selected = selected?.selected_event ?? null;

  // Our side: the locked Smash standings set the tiers.
  const record = await getRecord(env, track.id);
  const teams = record?.teams || teamsFor(track);
  const early = now < start; // a "Check now" before race day: report, don't import
  if (record?.status !== "locked") {
    if (early) {
      flag("info", "reachable", `Copilot is reachable (selected event ${state.selected || "none"}; ${raw ? `${state.event} exists` : `no ${state.event} yet`}). Tiers are set when ${track.name} locks, and importing starts on race day.`);
      return save(false, { phase: "scheduled" });
    }
    flag("error", "not-locked", `${track.name} isn't locked yet, so tiers aren't set. Nothing imported.`);
    return save(true, { phase: "blocked" });
  }
  const standings = applyOverrides(record.standings, overridesFor(track));
  if (early) {
    flag("info", "reachable", `Copilot is reachable (selected event ${state.selected || "none"}; ${raw ? `${state.event} exists` : `no ${state.event} yet`}). Importing starts on race day.`);
    return save(false, { phase: "scheduled" });
  }

  const read = readRaw(raw, teams);
  const docs = await store.docs();
  const current = cellsOf(docs);

  // Before racing: right event, a clean slate, rosters that line up.
  if (!raw) flag("info", "no-event", `Copilot has no event called ${state.event} yet.`);
  if (state.selected && state.selected !== state.event)
    flag(read.hasTimes ? "warn" : "info", "selected", read.hasTimes
      ? `Copilot's selected event is ${state.selected}, but race times are coming into ${state.event}. Importing from ${state.event}.`
      : `Waiting for race day: Copilot's selected event is still ${state.selected} (expecting ${state.event}).`);
  if (!state.startedAt) {
    const hand = Object.keys(current).filter((k) => !k.startsWith("s|") && !(k in (state.cells || {})));
    if (hand.length) flag("warn", "not-empty", `The Races page already had ${hand.length} race time${hand.length === 1 ? "" : "s"} before Copilot's times started. They count as hand-entered, and Copilot won't overwrite them.`);
  }
  const strangers = read.unknown.map((u) => u.name);
  if (strangers.length) flag(read.unknown.some((u) => u.hasTimes) ? "error" : "warn", "unknown-pilots", `Copilot's ${state.event} has pilots who aren't on a team here: ${list(strangers, 6)}. Their times aren't imported.`);
  if (read.hasTimes) {
    const dates = read.pilots.map((p) => p.eventDate).filter(Boolean).map((d) => Date.parse(d)).filter(Number.isFinite);
    const day = dates.length ? etDate(Math.min(...dates)) : null;
    const ok = [track.raceDay, etDate(start - 86_400_000), etDate(start + 86_400_000)];
    if (day && !ok.includes(day)) {
      flag("error", "stale-event", `Copilot's ${state.event} is dated ${day}, not race day (${track.raceDay}). It may be an old event, so nothing was imported.`);
      return save(true, { phase: "blocked" });
    }
  }
  if (!read.hasTimes && !Object.keys(sittingFrom(read, teams)).length) {
    return save(true, { phase: "waiting" });
  }

  // Sit-outs and tier races.
  const sitting = sittingFrom(read, teams);
  const wanted = { ...Object.fromEntries(Object.entries(sitting).map(([sp, p]) => [`s|${sp}`, p])), ...tierCells(read) };
  let plan = planWrites(wanted, current, pick(state.cells, (k) => !k.startsWith("b|")));
  await writeAll(store, plan.writes, teams, now);
  let written = Object.keys(plan.writes).length;
  const keptTier = plan.kept;
  let cells = { ...pick(state.cells, (k) => k.startsWith("b|")), ...plan.next };

  // Tiers: Copilot vs our lineup (Smash order minus the sit-out).
  let docs2 = Object.keys(plan.writes).length ? await store.docs() : docs;
  const decisions = { ...(state.decisions || {}) };
  let races = computeRaces(track, withDecisions(docs2, decisions), teams, standings);
  const mismatch = [];
  for (const t of races.teams) {
    for (const [tier, pilot] of Object.entries(t.lineup || {})) {
      const theirs = read.pilots.find((p) => p.pilot === pilot);
      if (theirs && theirs.tier != null && theirs.tier !== Number(tier)) mismatch.push(`${pilot} (${TEAM_NAMES[t.sponsor]?.name || t.sponsor}) is tier ${theirs.tier} in Copilot, tier ${tier} here`);
    }
  }
  if (mismatch.length) flag("warn", "tiers", `Tiers don't match Copilot: ${list(mismatch)}. Times were imported to the tier Copilot raced them in.`);

  // Bonus round, once teams are known. Semis first: the final and 3rd place teams come
  // from the semi results, so place what we can, save, and look again.
  let bonusWanted = { cells: {}, problems: [] };
  let bonusKept = [];
  let importedBonus = pick(state.cells, (k) => k.startsWith("b|"));
  for (let pass = 0; pass < 3; pass++) {
    const matches = Object.fromEntries((races.bonus?.matches || []).map((m) => [m.id, m.teams.filter(Boolean)]));
    bonusWanted = bonusCells(read, matches);
    plan = planWrites(bonusWanted.cells, cellsOf(docs2), importedBonus);
    await writeAll(store, plan.writes, teams, now);
    written += Object.keys(plan.writes).length;
    importedBonus = plan.next;
    bonusKept = plan.kept;
    if (!Object.keys(plan.writes).length) break;
    docs2 = await store.docs();
    races = computeRaces(track, withDecisions(docs2, decisions), teams, standings);
  }
  if (bonusWanted.problems.length) {
    const early = !races.bonus?.seeds?.length || races.bonus?.provisional;
    flag("error", "bonus-unplaced", early
      ? `Bonus heats started in Copilot before every tier race was recorded here, so ${bonusWanted.problems.length} bonus time${bonusWanted.problems.length === 1 ? " isn't" : "s aren't"} placed yet.`
      : `${bonusWanted.problems.length} bonus time${bonusWanted.problems.length === 1 ? "" : "s"} couldn't be placed in a match (is a semifinal tie undecided?).`);
  }
  cells = { ...pick(cells, (k) => !k.startsWith("b|")), ...importedBonus };
  const kept = [...keptTier, ...bonusKept];
  if (kept.length) flag("warn", "hand-edits", `${kept.length} time${kept.length === 1 ? " was" : "s were"} typed in by hand and ${kept.length === 1 ? "differs" : "differ"} from Copilot, so the hand-entered ${kept.length === 1 ? "one was" : "ones were"} kept: ${list(kept.map((k) => `${describe(k.key)} (here ${fmt(k.ours)}, Copilot ${fmt(k.copilot)})`))}.`);

  if (read.hasTimes) state.startedAt ||= new Date(now).toISOString();
  if (written) state.lastChangeAt = new Date(now).toISOString();
  state.cells = cells;

  docs2 = await store.docs();
  races = computeRaces(track, withDecisions(docs2, decisions), teams, standings);
  const { done } = raceDone(races);

  // Ties in finished bonus matches.
  let extra = null;
  const ties = (races.bonus?.matches || []).filter((m) => m.complete && m.tied && !m.winner);
  if (ties.length) {
    extra ||= await fetchExtra(fetchImpl, state.event);
    for (const m of ties) {
      const r = tieWinner(m, extra);
      const names = m.teams.map((s) => TEAM_NAMES[s]?.name || s);
      const score = `${m.totals[m.teams[0]]}–${m.totals[m.teams[1]]}`;
      if (r.winner) {
        decisions[m.id] = { winner: r.winner, note: `tied ${score}, ${TEAM_NAMES[r.winner]?.name || r.winner} per ${r.source}` };
        flag("info", `tie-${m.id}`, `${m.label} was tied ${score}; ${TEAM_NAMES[r.winner]?.name || r.winner} given the win per ${r.source}.`);
      } else {
        flag("error", `tie-${m.id}`, `${m.label} is tied ${score} (${names.join(" v ")}) and Copilot doesn't show a clear winner${r.conflict ? " (its sources disagree)" : ""}. It needs a league decision before the bonus places count.`);
      }
    }
    state.decisions = decisions;
    races = computeRaces(track, withDecisions(await store.docs(), decisions), teams, standings);
  }
  for (const m of races.bonus?.matches || []) if (m.decision && !flags.some((f) => f.code === `tie-${m.id}`)) flag("info", `tie-${m.id}`, `${m.label} was ${m.decision}.`);

  if (!done) return save(true, { phase: read.hasTimes ? "racing" : "waiting" });

  // Every heat is in: check it all against Copilot's own results.
  let check;
  try {
    const [results, ...heats] = await Promise.all([getJson(fetchImpl, `/api/public/weed/${encodeURIComponent(state.event)}/results`), ...[...SEMI_HEATS, ...LAST_HEATS].map((h) => getJson(fetchImpl, `/api/public/weed/${encodeURIComponent(state.event)}/heat-results/${h}`))]);
    check = verify(docs2, results, Object.fromEntries([...SEMI_HEATS, ...LAST_HEATS].map((h, i) => [h, heats[i]])), read);
  } catch (err) {
    flag("warn", "verify-failed", `All heats are in, but Copilot's results couldn't be fetched for the final check (${String(err?.message || err)}). Trying again in a minute.`);
    return save(true, { phase: "checking" });
  }
  state.check = { at: new Date(now).toISOString(), checked: check.checked, differences: check.diffs.length };
  if (check.diffs.length) {
    flag("error", "verify", `Final check: ${check.diffs.length} of ${check.checked} times differ from Copilot's results: ${list(check.diffs.map((d) => `${describe(d.key)} (here ${fmt(d.ours)}, Copilot ${fmt(d.copilot)})`))}.`);
    return save(true, { phase: "checking" });
  }
  const unresolved = flags.some((f) => f.level === "error");
  flag("info", "verify", `Final check: all ${check.checked} race times match Copilot's results.`);
  return save(unresolved, { phase: unresolved ? "checking" : "verified", verifiedAt: unresolved ? null : new Date(now).toISOString() });
}

async function fetchExtra(fetchImpl, event) {
  const e = encodeURIComponent(event);
  const [overrides, standings] = await Promise.all([
    getJson(fetchImpl, `/api/public/weed/${e}/overrides`).catch(() => null),
    getJson(fetchImpl, `/api/public/weed/${e}/standings`).catch(() => null),
  ]);
  return { overrides, standings };
}

const pick = (obj, keep) => Object.fromEntries(Object.entries(obj || {}).filter(([k]) => keep(k)));

// League decisions (config) win over ties broken from Copilot.
export const withDecisions = (docs, decisions) => ({ ...docs, copilot: { ...(docs.copilot || {}), decisions } });
export const decisionsFor = (track, docs) => ({ ...(docs?.copilot?.decisions || {}), ...(BONUS_DECISIONS[track.id] || {}) });

async function writeAll(store, writes, teams, now) {
  if (!Object.keys(writes).length) return;
  const { lineup, tiers, bonus } = patchesFrom(writes);
  const at = new Date(now).toISOString();
  if (Object.keys(lineup).length) await store.patch("lineup", null, lineup, teams, at);
  for (const [tier, patch] of Object.entries(tiers)) await store.patch("tier", Number(tier), patch, teams, at);
  if (Object.keys(bonus).length) await store.patch("bonus", null, bonus, teams, at);
}
