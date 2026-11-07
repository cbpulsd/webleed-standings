// Race day for one track.
//
// Saved by the race director page (in the RaceRoom Durable Object, or KV as a fallback):
//   lineup     { updatedAt, sitting: { "<sponsor>": "<pilot>" } }
//   tier <n>   { updatedAt, results: { "<race>": { "<sponsor>": <seconds> | "dnf" } } }
// Race times are stored. Within each race the fastest time finishes 1st, and so on;
// a DNF finishes with no points. Points come from config RACES.points by position.
//
// Lineups aren't stored: once a team's sit-out pilot is picked, its other four pilots
// fill tiers 1-4 in the team's Smash order for this track (fastest first).

import { RACES } from "./config.js";

export const lineupKey = (trackId) => `races:${trackId}:lineup`;
export const tierKey = (trackId, tier) => `races:${trackId}:tier:${tier}`;

const raceTime = (v) => (v === "dnf" ? "dnf" : typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null);

// Finishing positions for one race from its times: fastest = 1, equal times share
// a position, DNF = 0, no time = null.
export function positionsFor(times) {
  const done = times.filter((t) => typeof t === "number");
  return times.map((t) => (t === "dnf" ? 0 : typeof t === "number" ? 1 + done.filter((x) => x < t).length : null));
}

export async function loadRaceDocs(env, trackId, cfg = RACES) {
  const tiers = Array.from({ length: cfg.tiers }, (_, i) => i + 1);
  const [lineup, ...tierDocs] = await Promise.all([
    env.STANDINGS.get(lineupKey(trackId), "json"),
    ...tiers.map((t) => env.STANDINGS.get(tierKey(trackId, t), "json")),
  ]);
  return { lineup: lineup || {}, tiers: Object.fromEntries(tiers.map((t, i) => [t, tierDocs[i] || {}])) };
}

// Each team's pilots, fastest Smash time first (from the track's standings), else roster order.
export function smashOrder(teams, standings) {
  const byTeam = new Map((standings?.teams || []).map((t) => [t.sponsor, t.pilots.map((p) => p.name)]));
  return Object.fromEntries(teams.map((t) => [t.sponsor, byTeam.get(t.sponsor) || [t.captain, ...t.pilots]]));
}

export function lineupFor(order, sitting, tiers) {
  if (!sitting || !order.includes(sitting)) return null;
  const racing = order.filter((p) => p !== sitting).slice(0, tiers);
  return Object.fromEntries(racing.map((p, i) => [i + 1, p]));
}

export function computeRaces(track, docs, teams, standings, cfg = RACES) {
  const sitting = docs?.lineup?.sitting || {};
  const tierIds = Array.from({ length: cfg.tiers }, (_, i) => i + 1);
  const raceIds = Array.from({ length: cfg.racesPerTier }, (_, i) => i + 1);
  const pointsFor = (pos) => (pos == null ? null : pos === 0 ? 0 : cfg.points[pos - 1] ?? 0);
  const order = smashOrder(teams, standings);
  const lineups = Object.fromEntries(teams.map((t) => [t.sponsor, lineupFor(order[t.sponsor], sitting[t.sponsor], cfg.tiers)]));
  const teamOrder = new Map(teams.map((t, i) => [t.sponsor, i]));
  const rank = (list, key) => {
    const any = list.some((e) => e[key] != null);
    list.sort((a, b) => (any ? (b[key] ?? -Infinity) - (a[key] ?? -Infinity) : 0) || teamOrder.get(a.sponsor) - teamOrder.get(b.sponsor));
    list.forEach((e, i) => (e.place = any && e[key] != null ? i + 1 : null));
    return list;
  };
  const updated = [docs?.lineup?.updatedAt, ...tierIds.map((t) => docs?.tiers?.[t]?.updatedAt)].filter(Boolean).sort().pop() || null;

  const tierResults = tierIds.map((tier) => {
    const results = docs?.tiers?.[tier]?.results || {};
    const timesByRace = raceIds.map((r) => teams.map((t) => raceTime(results[r]?.[t.sponsor])));
    const positionsByRace = timesByRace.map(positionsFor);
    const entries = teams.map((t, ti) => {
      const times = raceIds.map((_, ri) => timesByRace[ri][ti]);
      const positions = raceIds.map((_, ri) => positionsByRace[ri][ti]);
      const points = positions.map(pointsFor);
      const scored = points.filter((p) => p != null);
      return {
        sponsor: t.sponsor,
        draft: teamOrder.get(t.sponsor),
        pilot: lineups[t.sponsor]?.[tier] ?? null,
        times,
        positions,
        points,
        total: scored.length ? scored.reduce((a, b) => a + b, 0) : null,
      };
    });
    const racesRun = timesByRace.filter((race) => race.some((t) => t != null)).length;
    return { tier, racesRun, entries: rank(entries, "total") };
  });

  const teamTotals = rank(
    teams.map((t) => {
      const byTier = Object.fromEntries(tierResults.map((ti) => [ti.tier, ti.entries.find((e) => e.sponsor === t.sponsor).total]));
      const vals = Object.values(byTier).filter((v) => v != null);
      return {
        sponsor: t.sponsor,
        captain: t.captain,
        draft: teamOrder.get(t.sponsor),
        lineup: lineups[t.sponsor],
        byTier,
        total: vals.length ? vals.reduce((a, b) => a + b, 0) : null,
        sitting: sitting[t.sponsor] ?? null,
        smashOrder: order[t.sponsor],
      };
    }),
    "total"
  );

  return {
    raceDay: track.raceDay || null,
    tiers: cfg.tiers,
    racesPerTier: cfg.racesPerTier,
    points: cfg.points,
    updatedAt: updated,
    teams: teamTotals,
    tierResults,
  };
}

// Admin edits arrive as patches and are merged into what's saved, so directors
// editing different cells (or tiers) don't overwrite each other.
export function applySittingPatch(doc, patch, teams) {
  const valid = new Map(teams.map((t) => [t.sponsor, new Set([t.captain, ...t.pilots])]));
  const sitting = { ...(doc?.sitting || {}) };
  for (const [sponsor, pilot] of Object.entries(patch || {})) {
    if (!valid.has(sponsor)) throw new Error(`unknown team: ${sponsor}`);
    if (pilot == null || pilot === "") delete sitting[sponsor];
    else if (valid.get(sponsor).has(pilot)) sitting[sponsor] = pilot;
    else throw new Error(`${pilot} isn't on Team ${sponsor}`);
  }
  return { sitting };
}

// "45.123", "1:05.432", 45.123 -> seconds; "dnf" -> "dnf"; "" or null -> null (clear).
export function parseRaceTime(v) {
  if (v == null || v === "") return null;
  if (typeof v === "number") return Number.isFinite(v) && v > 0 && v < 3600 ? Math.round(v * 1000) / 1000 : undefined;
  const s = String(v).trim().toLowerCase();
  if (s === "") return null;
  if (s === "dnf") return "dnf";
  const m = s.match(/^(?:(\d{1,2}):)?(\d{1,4}(?:\.\d{1,3})?)$/);
  if (!m) return undefined;
  const secs = (m[1] ? +m[1] * 60 : 0) + parseFloat(m[2]);
  return secs > 0 && secs < 3600 ? Math.round(secs * 1000) / 1000 : undefined;
}

export function applyResultsPatch(doc, patch, teams, cfg = RACES) {
  const sponsors = new Set(teams.map((t) => t.sponsor));
  const results = JSON.parse(JSON.stringify(doc?.results || {}));
  for (const [race, cells] of Object.entries(patch || {})) {
    const r = Number(race);
    if (!Number.isInteger(r) || r < 1 || r > cfg.racesPerTier) throw new Error(`no race ${race}`);
    for (const [sponsor, pos] of Object.entries(cells || {})) {
      if (!sponsors.has(sponsor)) throw new Error(`unknown team: ${sponsor}`);
      const t = parseRaceTime(pos);
      if (t === undefined) throw new Error(`"${pos}" isn't a race time (use seconds like 45.123, or DNF)`);
      if (t === null) {
        if (results[r]) delete results[r][sponsor];
      } else (results[r] ||= {})[sponsor] = t;
    }
    if (results[r] && !Object.keys(results[r]).length) delete results[r];
  }
  return { results };
}
