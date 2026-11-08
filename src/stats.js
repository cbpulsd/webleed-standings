// Stats for one track, from its hourly history (team totals, rostered pilots' times)
// and its events (every first time and new personal best).

import { ALIASES } from "./config.js";
import { norm } from "./standings.js";

const round3 = (n) => Math.round(n * 1000) / 1000;

export function computeStats(track, history, events, teams) {
  history = [...(history || [])].sort((a, b) => a.at.localeCompare(b.at));
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
    const carry = inTier
      .map((p) => { const b = byPilot.get(p.pilot); return b && b.first != null && p.time != null ? { pilot: p.pilot, team: p.team, first: b.first, best: p.time, gained: round3(b.first - p.time) } : null; })
      .filter((p) => p && p.gained > 0)
      .sort((a, b) => b.gained - a.gained)
      .slice(0, 3);
    return { tier, fastest, carry };
  });

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
    // Every rostered pilot's first time or new best, for the activity heatmap.
    activity: league.map((e) => [e.at, e.kind === "pb" ? 1 : 0]),
  };
}
