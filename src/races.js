// Race-day results for one track.
//
// Saved in KV under "races:<trackId>" (nothing writes it yet):
//   {
//     updatedAt,
//     lineup:  { "<sponsor>": { tiers: { "1": "<pilot>", ... }, sitting: "<pilot>" } },
//     results: { "<tier>": { "<race>": { "<sponsor>": <finishing position> } } }
//   }
// Finishing positions are stored, not points, so a change to the points table
// re-scores every race.

import { RACES } from "./config.js";

const int = (v) => (Number.isInteger(v) && v > 0 ? v : null);

export function computeRaces(track, saved, teams, cfg = RACES) {
  saved = saved || {};
  const lineup = saved.lineup || {};
  const results = saved.results || {};
  const tierIds = Array.from({ length: cfg.tiers }, (_, i) => i + 1);
  const raceIds = Array.from({ length: cfg.racesPerTier }, (_, i) => i + 1);
  const pointsFor = (pos) => (pos == null ? null : cfg.points[pos - 1] ?? 0);
  const order = new Map(teams.map((t, i) => [t.sponsor, i]));
  const rank = (list, key) => {
    const any = list.some((e) => e[key] != null);
    list.sort((a, b) => (any ? (b[key] ?? -Infinity) - (a[key] ?? -Infinity) : 0) || order.get(a.sponsor) - order.get(b.sponsor));
    list.forEach((e, i) => (e.place = any && e[key] != null ? i + 1 : null));
    return list;
  };

  const tiers = tierIds.map((tier) => {
    const entries = teams.map((t) => {
      const positions = raceIds.map((r) => int(results[tier]?.[r]?.[t.sponsor]));
      const points = positions.map(pointsFor);
      const scored = points.filter((p) => p != null);
      return {
        sponsor: t.sponsor,
        pilot: lineup[t.sponsor]?.tiers?.[tier] ?? null,
        positions,
        points,
        total: scored.length ? scored.reduce((a, b) => a + b, 0) : null,
      };
    });
    const racesRun = raceIds.filter((r) => teams.some((t) => int(results[tier]?.[r]?.[t.sponsor]) != null)).length;
    return { tier, racesRun, entries: rank(entries, "total") };
  });

  const teamTotals = rank(
    teams.map((t) => {
      const byTier = Object.fromEntries(tiers.map((ti) => [ti.tier, ti.entries.find((e) => e.sponsor === t.sponsor).total]));
      const vals = Object.values(byTier).filter((v) => v != null);
      return {
        sponsor: t.sponsor,
        captain: t.captain,
        byTier,
        total: vals.length ? vals.reduce((a, b) => a + b, 0) : null,
        sitting: lineup[t.sponsor]?.sitting ?? null,
      };
    }),
    "total"
  );

  return {
    raceDay: track.raceDay || null,
    tiers: cfg.tiers,
    racesPerTier: cfg.racesPerTier,
    points: cfg.points,
    updatedAt: saved.updatedAt || null,
    teams: teamTotals,
    tierResults: tiers,
  };
}
