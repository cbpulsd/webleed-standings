// Race day for one track.
//
// Saved by the race director page (in the RaceRoom Durable Object, or KV as a fallback):
//   lineup     { updatedAt, sitting: { "<sponsor>": "<pilot>" } }
//   tier <n>   { updatedAt, results: { "<race>": { "<sponsor>": <seconds> | "dnf" } } }
//   bonus      { updatedAt, results: { "<match>": { "<heat>": { "<sponsor>": { "<tier>": <seconds> | "dnf" } } } } }
//              match: semi1 (#1 v #4), semi2 (#2 v #3), final (semi winners), third (semi losers)
// Race times are stored. Within each race the fastest time finishes 1st, and so on;
// a DNF finishes with no points. Points come from config RACES.points by position.
//
// Lineups aren't stored: once a team's sit-out pilot is picked, its other four pilots
// fill tiers 1-4 in the team's Smash order for this track (fastest first).

import { RACES } from "./config.js";

export const lineupKey = (trackId) => `races:${trackId}:lineup`;
export const tierKey = (trackId, tier) => `races:${trackId}:tier:${tier}`;
export const bonusKey = (trackId) => `races:${trackId}:bonus`;
export const BONUS_MATCHES = ["semi1", "semi2", "final", "third"];

const raceTime = (v) => (v === "dnf" ? "dnf" : typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null);

// Finishing positions for one race from its times: fastest = 1, equal times share
// a position, DNF = 0, no time = null.
export function positionsFor(times) {
  const done = times.filter((t) => typeof t === "number");
  return times.map((t) => (t === "dnf" ? 0 : typeof t === "number" ? 1 + done.filter((x) => x < t).length : null));
}

export async function loadRaceDocs(env, trackId, cfg = RACES) {
  const tiers = Array.from({ length: cfg.tiers }, (_, i) => i + 1);
  const [lineup, bonus, ...tierDocs] = await Promise.all([
    env.STANDINGS.get(lineupKey(trackId), "json"),
    env.STANDINGS.get(bonusKey(trackId), "json"),
    ...tiers.map((t) => env.STANDINGS.get(tierKey(trackId, t), "json")),
  ]);
  return { lineup: lineup || {}, bonus: bonus || {}, tiers: Object.fromEntries(tiers.map((t, i) => [t, tierDocs[i] || {}])) };
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
  const updated = [docs?.lineup?.updatedAt, docs?.bonus?.updatedAt, ...tierIds.map((t) => docs?.tiers?.[t]?.updatedAt)].filter(Boolean).sort().pop() || null;

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

  const regular = rank(
    teams.map((t) => {
      const byTier = Object.fromEntries(tierResults.map((ti) => [ti.tier, ti.entries.find((e) => e.sponsor === t.sponsor).total]));
      const vals = Object.values(byTier).filter((v) => v != null);
      return {
        sponsor: t.sponsor,
        captain: t.captain,
        draft: teamOrder.get(t.sponsor),
        lineup: lineups[t.sponsor],
        byTier,
        raceTotal: vals.length ? vals.reduce((a, b) => a + b, 0) : null,
        sitting: sitting[t.sponsor] ?? null,
        smashOrder: order[t.sponsor],
      };
    }),
    "raceTotal"
  );
  const regularDone = tierResults.every((t) => t.racesRun === cfg.racesPerTier);
  const bonus = cfg.bonus ? computeBonus(regular, lineups, docs?.bonus?.results || {}, cfg, regularDone) : null;
  const bonusOf = new Map((bonus?.places || []).map((p) => [p.sponsor, p]));
  const teamTotals = rank(
    regular.map((t) => {
      const b = bonusOf.get(t.sponsor);
      const seed = bonus?.seeds.indexOf(t.sponsor);
      return {
        ...t,
        seed: seed != null && seed >= 0 ? seed + 1 : null,
        bonusPlace: b?.place ?? null,
        bonus: b ? b.points : null,
        total: t.raceTotal == null ? null : t.raceTotal + (b?.points || 0),
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
    bonus,
  };
}

// The bonus round, from the regular race points (ranked) and its saved heat times.
export function computeBonus(ranked, lineups, results, cfg = RACES, regularDone = true) {
  const { teams: size, heats: heatCount, points: placePoints } = cfg.bonus;
  const seeds = ranked.filter((t) => t.raceTotal != null).slice(0, size).map((t) => t.sponsor);
  const tierIds = Array.from({ length: cfg.tiers }, (_, i) => i + 1);
  const heatIds = Array.from({ length: heatCount }, (_, i) => i + 1);
  const heatPoints = cfg.bonus.heatPoints || cfg.points;
  const pointsFor = (pos) => (pos == null ? null : pos === 0 ? 0 : heatPoints[pos - 1] ?? 0);

  function play(id, label, a, b) {
    const sides = [a, b];
    if (!a || !b) return { id, label, teams: sides, heats: [], totals: null, winner: null, loser: null, complete: false, tied: false };
    const heats = heatIds.map((h) => {
      const cells = sides.flatMap((sp) => tierIds.map((tier) => ({ sponsor: sp, tier, pilot: lineups[sp]?.[tier] ?? null, time: raceTime(results[id]?.[h]?.[sp]?.[tier]) })));
      const pos = positionsFor(cells.map((c) => c.time));
      const entries = cells.map((c, i) => ({ ...c, position: pos[i], points: pointsFor(pos[i]) }));
      const score = Object.fromEntries(sides.map((sp) => [sp, entries.filter((e) => e.sponsor === sp && e.points != null).reduce((s, e) => s + e.points, 0)]));
      return { heat: h, entries, score, run: entries.some((e) => e.time != null), complete: entries.every((e) => e.time != null) };
    });
    const totals = Object.fromEntries(sides.map((sp) => [sp, heats.reduce((s, h) => s + h.score[sp], 0)]));
    const complete = heats.every((h) => h.complete);
    const tied = complete && totals[a] === totals[b];
    const winner = complete && !tied ? (totals[a] > totals[b] ? a : b) : null;
    return { id, label, teams: sides, heats, totals, winner, loser: winner ? (winner === a ? b : a) : null, complete, tied };
  }

  const ready = seeds.length === size;
  const semi1 = play("semi1", "Semifinal 1", ready ? seeds[0] : null, ready ? seeds[3] : null);
  const semi2 = play("semi2", "Semifinal 2", ready ? seeds[1] : null, ready ? seeds[2] : null);
  const final = play("final", "Final", semi1.winner, semi2.winner);
  const third = play("third", "3rd place", semi1.loser, semi2.loser);
  const places = [];
  if (final.winner) places.push({ place: 1, sponsor: final.winner }, { place: 2, sponsor: final.loser });
  if (third.winner) places.push({ place: 3, sponsor: third.winner }, { place: 4, sponsor: third.loser });
  places.forEach((p) => (p.points = placePoints[p.place - 1] ?? 0));
  return { seeds: ready ? seeds : [], provisional: !regularDone, heats: heatCount, heatPoints, placePoints, matches: [semi1, semi2, final, third], places };
}

// Bonus heat times: { "<match>": { "<heat>": { "<sponsor>": { "<tier>": time } } } }
export function applyBonusPatch(doc, patch, teams, cfg = RACES) {
  const sponsors = new Set(teams.map((t) => t.sponsor));
  const results = JSON.parse(JSON.stringify(doc?.results || {}));
  for (const [match, heats] of Object.entries(patch || {})) {
    if (!BONUS_MATCHES.includes(match)) throw new Error(`no bonus match ${match}`);
    for (const [heat, bySponsor] of Object.entries(heats || {})) {
      const h = Number(heat);
      if (!Number.isInteger(h) || h < 1 || h > cfg.bonus.heats) throw new Error(`no bonus heat ${heat}`);
      for (const [sponsor, byTier] of Object.entries(bySponsor || {})) {
        if (!sponsors.has(sponsor)) throw new Error(`unknown team: ${sponsor}`);
        for (const [tier, v] of Object.entries(byTier || {})) {
          const t = Number(tier);
          if (!Number.isInteger(t) || t < 1 || t > cfg.tiers) throw new Error(`no tier ${tier}`);
          const time = parseRaceTime(v);
          if (time === undefined) throw new Error(`"${v}" isn't a race time (use seconds like 45.123, or DNF)`);
          const slot = ((results[match] ||= {})[h] ||= {});
          if (time === null) { if (slot[sponsor]) delete slot[sponsor][t]; }
          else (slot[sponsor] ||= {})[t] = time;
          if (slot[sponsor] && !Object.keys(slot[sponsor]).length) delete slot[sponsor];
        }
      }
      if (results[match][h] && !Object.keys(results[match][h]).length) delete results[match][h];
    }
    if (results[match] && !Object.keys(results[match]).length) delete results[match];
  }
  return { results };
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
