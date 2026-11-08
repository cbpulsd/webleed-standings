// Stats for one track, from its hourly history (team totals, rostered pilots' times)
// and its events (every first time and new personal best).

import { ALIASES, TIME_OVERRIDES } from "./config.js";
import { DRAFT_RANKS } from "./draft.js";
import { norm, overrideSnapshot } from "./standings.js";

const round3 = (n) => Math.round(n * 1000) / 1000;

export function computeStats(track, history, events, teams) {
  // League-set times (TIME_OVERRIDES) apply to the hourly saves too.
  const overrides = Object.fromEntries(
    Object.entries(TIME_OVERRIDES[track.id] || {}).map(([name, o]) => [name, { ...o, team: teams.find((t) => t.captain === name || t.pilots.includes(name))?.sponsor }])
  );
  history = [...(history || [])].sort((a, b) => a.at.localeCompare(b.at)).map((h) => overrideSnapshot(h, overrides));
  events = events || [];

  // Rostered pilots: Velocidrone name (matching form) -> { pilot, team }
  const roster = new Map();
  for (const t of teams) {
    for (const p of [t.captain, ...t.pilots]) {
      const k = norm(p);
      roster.set(k, { pilot: p, team: t.sponsor });
      if (ALIASES[k]) roster.set(ALIASES[k], { pilot: p, team: t.sponsor });
    }
  }
  const league = events.map((e) => ({ ...e, who: roster.get(norm(e.name)) })).filter((e) => e.who);

  // Team totals over time. A point counts as "complete" once all five pilots have a time.
  const sizeOf = new Map(teams.map((t) => [t.sponsor, 1 + t.pilots.length]));
  const series = new Map(teams.map((t) => [t.sponsor, []]));
  for (const h of history) {
    for (const [sponsor, total, posted] of h.teams || []) {
      if (series.has(sponsor)) series.get(sponsor).push([h.at, total, posted]);
    }
  }

  const teamStats = teams.map((t) => {
    const pts = series.get(t.sponsor);
    const last = pts[pts.length - 1] || null;
    return { sponsor: t.sponsor, size: sizeOf.get(t.sponsor), series: pts, finalTotal: last ? last[1] : null };
  });

  // Biggest grinders: rostered pilots by number of new personal bests.
  const byPilot = new Map();
  for (const e of league) {
    const k = e.who.pilot;
    if (!byPilot.has(k)) byPilot.set(k, { pilot: k, team: e.who.team, pbs: 0, first: null, best: null });
    const p = byPilot.get(k);
    if (e.kind === "debut" && p.first == null) p.first = e.time;
    if (e.kind === "pb") { p.pbs++; if (p.first == null) p.first = e.prev; }
    p.best = p.best == null ? e.time : Math.min(p.best, e.time);
  }
  const grinders = [...byPilot.values()].filter((p) => p.pbs > 0).sort((a, b) => b.pbs - a.pbs || a.best - b.best);

  // Depth and tiers from the latest save (the final one once a track locks). A pilot's
  // tier is their place within their own team by time: fastest = Tier 1.
  const latest = history[history.length - 1] || null;
  const tierCount = Math.max(0, ...teams.map((t) => 1 + t.pilots.length));
  const placed = latest
    ? teams.map((t) => {
        const pilots = [t.captain, ...t.pilots]
          .map((p) => ({ pilot: p, time: latest.pilots?.[p] ?? null }))
          .sort((a, b) => (a.time ?? Infinity) - (b.time ?? Infinity) || a.pilot.localeCompare(b.pilot))
          .map((p, i) => ({ ...p, tier: i + 1 }));
        const times = pilots.map((p) => p.time).filter((v) => v != null);
        const row = (latest.teams || []).find((r) => r[0] === t.sponsor);
        return {
          sponsor: t.sponsor,
          total: row ? row[1] : null,
          posted: times.length,
          size: pilots.length,
          spread: times.length > 1 ? round3(Math.max(...times) - Math.min(...times)) : null,
          pilots,
        };
      })
    : [];
  const depth = [...placed].sort((a, b) => (a.total ?? Infinity) - (b.total ?? Infinity));
  const tierStats = Array.from({ length: placed.length ? tierCount : 0 }, (_, i) => {
    const tier = i + 1;
    const inTier = placed.map((t) => ({ ...t.pilots[i], team: t.sponsor })).filter((p) => p && p.pilot);
    const fastest = inTier.filter((p) => p.time != null).sort((a, b) => a.time - b.time).slice(0, 3);
    return { tier, fastest };
  });

  // Draft spot vs this week: both are places among the league's own pilots, so the
  // draft's tryout ranks (#1 to #97, with gaps) line up with this week's times.
  // Pilots without a time this week aren't placed.
  const allPilots = placed.flatMap((t) => t.pilots.map((p) => ({ ...p, team: t.sponsor })));
  const drafted = allPilots.filter((p) => DRAFT_RANKS[p.pilot] != null).sort((a, b) => DRAFT_RANKS[a.pilot] - DRAFT_RANKS[b.pilot]);
  const draftPlace = new Map(drafted.map((p, i) => [p.pilot, i + 1]));
  const timed = drafted.filter((p) => p.time != null).sort((a, b) => a.time - b.time);
  const moves = timed.map((p, i) => ({ pilot: p.pilot, team: p.team, draftRank: DRAFT_RANKS[p.pilot], draftPlace: draftPlace.get(p.pilot), weekPlace: i + 1, time: p.time, moved: draftPlace.get(p.pilot) - (i + 1) }));
  const sandbaggers = moves.filter((m) => m.moved > 0).sort((a, b) => b.moved - a.moved || a.weekPlace - b.weekPlace).slice(0, 10);
  const dropoffs = moves.filter((m) => m.moved < 0).sort((a, b) => a.moved - b.moved || a.weekPlace - b.weekPlace).slice(0, 10);

  return {
    track: track.id,
    from: history[0]?.at || events[0]?.at || null,
    to: history[history.length - 1]?.at || null,
    summary: { newBests: league.filter((e) => e.kind === "pb").length },
    teams: teamStats,
    grinders: grinders.slice(0, 15),
    tiersAt: latest?.at || null,
    depth,
    tiers: tierStats,
    leaguePilots: drafted.length,
    sandbaggers,
    dropoffs,
    // Every rostered pilot's first time or new best, for the activity heatmap.
    activity: league.map((e) => [e.at, e.kind === "pb" ? 1 : 0]),
  };
}
