// Turns leaderboard rows into team standings.

import { NO_TIME } from "./config.js";

// Matching form: lowercase letters and digits only, "(Beta Tester)" removed.
// This also strips invisible marks some Velocidrone names carry.
export const norm = (s) => String(s).toLowerCase().replace(/\(beta tester\)/g, "").replace(/[^a-z0-9]/g, "");

// Whether a time counts for a track's required quad. Rows saved before model
// data was collected carry no model and are kept.
export function quadAllowed(row, quad) {
  if (!quad) return true;
  if (row.model == null && row.modelId == null) return true;
  if (row.modelId != null && (quad.ids || []).includes(row.modelId)) return true;
  return row.model != null && norm(row.model) === norm(quad.name);
}

export function computeStandings(rows, teams, aliases = {}, quad = null) {
  const best = new Map();
  for (const r of rows) {
    if (!quadAllowed(r, quad)) continue;
    const k = norm(r.name);
    if (k && (!best.has(k) || best.get(k).time > r.time)) best.set(k, r);
  }
  const find = (name) => {
    const k = norm(name);
    return best.get(k) || best.get(aliases[k]) || null;
  };

  const ranked = teams
    .map((t) => {
      const pilots = [t.captain, ...t.pilots]
        .map((name, i) => {
          const hit = find(name);
          return {
            name,
            captain: i === 0,
            posted: !!hit,
            time: hit ? hit.time : NO_TIME,
            lb: hit ? hit.rank : null,
            // As recorded on Velocidrone; null when unknown (page source has no IDs).
            velocidroneName: hit ? hit.name : null,
            userId: hit?.userId ?? null,
            model: hit?.model ?? null,
            modelId: hit?.modelId ?? null,
          };
        })
        .sort((a, b) => a.time - b.time || a.name.localeCompare(b.name));
      const total = round3(pilots.reduce((s, p) => s + p.time, 0));
      return { sponsor: t.sponsor, captain: t.captain, total, posted: pilots.filter((p) => p.posted).length, size: pilots.length, pilots };
    })
    .sort((a, b) => a.total - b.total || b.posted - a.posted || a.sponsor.localeCompare(b.sponsor));

  const lead = ranked.length ? ranked[0].total : 0;
  ranked.forEach((t, i) => {
    t.position = i + 1;
    t.gap = round3(t.total - lead);
  });
  return { teams: ranked };
}

// Small per-hour record of where everyone stood, for charts later.
export function compactSnapshot(standings, at) {
  return {
    at,
    teams: standings.teams.map((t) => [t.sponsor, t.total, t.posted]),
    pilots: Object.fromEntries(standings.teams.flatMap((t) => t.pilots.filter((p) => p.posted).map((p) => [p.name, p.time]))),
    ids: Object.fromEntries(standings.teams.flatMap((t) => t.pilots.filter((p) => p.userId != null).map((p) => [p.name, p.userId]))),
  };
}

const round3 = (n) => Math.round(n * 1000) / 1000;
