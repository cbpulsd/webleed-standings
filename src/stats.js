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
    const size = sizeOf.get(t.sponsor);
    const complete = pts.filter((p) => p[2] >= size);
    const first = complete[0] || null;
    const last = pts[pts.length - 1] || null;
    let bestHour = null;
    for (let i = 1; i < complete.length; i++) {
      const drop = round3(complete[i - 1][1] - complete[i][1]);
      if (drop > 0.0005 && (!bestHour || drop > bestHour.drop)) bestHour = { at: complete[i][0], drop };
    }
    return {
      sponsor: t.sponsor,
      size,
      series: pts,
      completeAt: first ? first[0] : null,
      startTotal: first ? first[1] : null,
      finalTotal: last ? last[1] : null,
      cut: first && last && last[2] >= size ? round3(first[1] - last[1]) : null,
      bestHour,
      pbs: league.filter((e) => e.who.team === t.sponsor && e.kind === "pb").length,
    };
  });

  // Who led the team standings, hour by hour. Only counted once the leading team
  // has all five pilots posted, so early hours full of 999.99 placeholders don't count.
  const leadChanges = [];
  let leader = null;
  for (const h of history) {
    const top = [...(h.teams || [])].sort((a, b) => a[1] - b[1])[0];
    if (!top || top[2] < (sizeOf.get(top[0]) || 5)) continue;
    if (leader && top[0] !== leader) leadChanges.push({ at: h.at, from: leader, to: top[0], total: top[1] });
    leader = top[0];
  }

  // Rostered pilots who improved: number of new bests and seconds gained.
  const byPilot = new Map();
  for (const e of league) {
    const k = e.who.pilot;
    if (!byPilot.has(k)) byPilot.set(k, { pilot: k, team: e.who.team, pbs: 0, gained: 0, first: null, best: null });
    const p = byPilot.get(k);
    if (e.kind === "debut" && p.first == null) p.first = e.time;
    if (e.kind === "pb") { p.pbs++; p.gained = round3(p.gained + (e.prev - e.time)); if (p.first == null) p.first = e.prev; }
    p.best = p.best == null ? e.time : Math.min(p.best, e.time);
  }
  const improved = [...byPilot.values()].filter((p) => p.pbs > 0).sort((a, b) => b.gained - a.gained || b.pbs - a.pbs);

  const drops = league
    .filter((e) => e.kind === "pb")
    .map((e) => ({ at: e.at, pilot: e.who.pilot, team: e.who.team, prev: e.prev, time: e.time, drop: round3(e.prev - e.time) }))
    .sort((a, b) => b.drop - a.drop)
    .slice(0, 10);

  return {
    track: track.id,
    from: history[0]?.at || events[0]?.at || null,
    to: history[history.length - 1]?.at || null,
    summary: {
      newBests: league.filter((e) => e.kind === "pb").length,
      firstTimes: league.filter((e) => e.kind === "debut").length,
      pilotsImproved: improved.length,
      teamLeadChanges: leadChanges.length,
      secondsCut: round3(teamStats.reduce((s, t) => s + (t.cut || 0), 0)),
    },
    teams: teamStats,
    leadChanges,
    improved: improved.slice(0, 12),
    drops,
    // Every rostered pilot's first time or new best, for the activity heatmap.
    activity: league.map((e) => [e.at, e.kind === "pb" ? 1 : 0]),
  };
}
